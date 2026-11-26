// .urxf reader. The fixtures are built rather than checked in, and the builder lives in
// `urxf.test-util.ts` — shared with the app entry's settings-import cases, and independent
// of `urxf.ts` on purpose (its header says why). The byte offsets this file pokes at are
// the layout that builder writes.

import { describe, expect, it } from "vitest";
import { getModel } from "../../models";
import { emptyPlan } from "../plan";
import { PARAMS } from "./params";
import { applySourceState } from "./readback";
import { parseUrxf, paramSourceOf } from "./urxf";
import {
  BLOCK_HEADER,
  buildUrxf,
  CHUNK_HEADER,
  CURRENT_FIELDS,
  FILE_HEADER,
  SCENE_FIELDS,
  sampleUrxf as sample,
} from "./urxf.test-util";
import type { Field } from "./urxf.test-util";

describe("parseUrxf", () => {
  it("reads the header, both chunks, and the scene label", () => {
    const file = parseUrxf(sample());
    expect(file.model).toBe("URX");
    expect(file.chunks.map((c) => c.name)).toEqual(["CURRENT", "SCENE"]);
    expect(file.chunks[1].label).toBe("My Data 1");
  });

  it("decodes by typecode, not by element size", () => {
    const current = parseUrxf(sample()).chunks[0];
    // 4-byte unsigned bitmask: reading it as signed would give a negative number.
    expect(current.params.get(22)).toEqual([2147483904]);
    // 2-byte signed level: reading it as unsigned would give 64936.
    expect(current.params.get(139)).toEqual([-600, 0, 300]);
    // 16-byte ASCII, cut at the first NUL.
    expect(current.params.get(18)).toEqual(["ch 1", "ch 2"]);
  });

  it("keeps scalar and array records apart", () => {
    const current = parseUrxf(sample()).chunks[0];
    expect(current.params.get(96)).toEqual([184]); // 6-byte scalar record
    expect(current.params.get(139)).toHaveLength(3); // 8-byte array record
  });

  it("rejects a file that is not a settings file", () => {
    const bytes = new Uint8Array(128);
    // The ZIP magic, escaped rather than embedded: written as literal 0x03/0x04 this
    // file reads as `data` to `file`, and a control byte in a source is one step from
    // a NUL, which stops ripgrep searching it at all.
    bytes.set(new TextEncoder().encode("PK\x03\x04"));
    expect(() => parseUrxf(bytes)).toThrow(expect.objectContaining({ code: "notUrxf" }));
  });

  it("rejects a truncated file", () => {
    const bytes = sample();
    // The code, not merely the class: every refusal the PARSER raises is a UrxfError, so
    // `toThrow` alone would be satisfied by a file rejected for some other reason entirely
    // — which is what an offset that drifted would produce.
    expect(() => parseUrxf(bytes.subarray(0, bytes.length - 200))).toThrow(
      expect.objectContaining({ code: "truncated" }),
    );
  });

  // Σ(elemSize × count) == D length is the only integrity check the format offers,
  // so a descriptor that no longer matches its values must stop the parse — every
  // parameter after it would decode at the wrong offset.
  it("rejects a descriptor table that does not match the values block", () => {
    const bytes = sample();
    const view = new DataView(bytes.buffer);
    // The first descriptor's elemSize (BE u16) sits 4 bytes into the F payload. The three
    // header sizes come from the builder rather than being written out here: they are its
    // layout, and a literal copy would keep addressing an offset it had moved away from.
    const fPayload = FILE_HEADER + CHUNK_HEADER + BLOCK_HEADER;
    view.setUint16(fPayload + 4, 8, false);
    expect(() => parseUrxf(bytes)).toThrow(expect.objectContaining({ code: "lengthMismatch" }));
  });

  // A zero element size spans no bytes whatever the count says, so both length checks
  // still balance — and each 8-byte descriptor would decode into up to 65535 values.
  it("rejects a descriptor whose element size is zero", () => {
    const bytes = buildUrxf([
      {
        chunk: "CURRENT",
        block: "CSF_BACKUP",
        label: "",
        fields: [
          { id: 18, typecode: 4, elemSize: 1, values: ["", ""] },
          { id: 96, typecode: 1, elemSize: 2, values: [0] },
        ],
      },
    ]);
    const view = new DataView(bytes.buffer);
    const fPayload = FILE_HEADER + CHUNK_HEADER + BLOCK_HEADER;
    // The ASCII array record (8 bytes): elemSize 0, count 65535. The scalar record after
    // it (6 bytes) widens to 4 so the values block, 2 + 2 bytes, still balances.
    view.setUint16(fPayload + 4, 0, false);
    view.setUint16(fPayload + 6, 0xffff, false);
    view.setUint16(fPayload + 8 + 4, 4, false);
    expect(() => parseUrxf(bytes)).toThrow(expect.objectContaining({ code: "badDescriptor" }));
  });

  // The model string and a chunk's label are read at fixed offsets inside their
  // record's extra block. Bounding them against the BUFFER only says the bytes exist
  // somewhere in the file: a header declaring `extraLen: 0` parsed cleanly with `model`
  // read straight out of the next record's tag ("#ChunkData"), and a short chunk gave a
  // label cut from its own body. Both are values invented from a neighbour, which is
  // what this parser's contract says it does not produce.
  it("rejects a record whose extra block cannot hold the field read out of it", () => {
    const short = (at: number): Uint8Array => {
      const bytes = sample();
      // extraLen is a BE u32 24 bytes into a record header.
      new DataView(bytes.buffer).setUint32(at + 24, 0, false);
      return bytes;
    };
    expect(() => parseUrxf(short(0))).toThrow(expect.objectContaining({ code: "truncated" }));
    expect(() => parseUrxf(short(FILE_HEADER))).toThrow(expect.objectContaining({ code: "truncated" }));
  });

  it("rejects a block whose magic is wrong", () => {
    const bytes = sample();
    // 24 bytes into the F block header, which is the magic. Note the neighbouring field
    // (the payload length, 4 bytes further on) also refuses as `badBlock`, so this offset
    // has to be right rather than merely close.
    new DataView(bytes.buffer).setUint32(FILE_HEADER + CHUNK_HEADER + 24, 1, true);
    expect(() => parseUrxf(bytes)).toThrow(expect.objectContaining({ code: "badBlock" }));
  });

  // A unit can declare a SCENE chunk longer than its F + D pair and fill the rest with
  // leftovers: fragments of earlier block headers and descriptor tables, and record tags.
  // The parse has to read the pair and step over the rest — reading the leftovers as a
  // third block, or as the next record, refuses a file the unit wrote.
  it("reads a chunk whose declared length runs past its values block", () => {
    const enc = new TextEncoder();
    const trailing = new Uint8Array(104);
    trailing.set(enc.encode("F_SCENE"), 4);
    new DataView(trailing.buffer).setUint32(4 + 24, 10000, true);
    trailing.set(enc.encode("#ChunkData"), 72);
    const file = parseUrxf(
      buildUrxf([
        { chunk: "CURRENT", block: "CSF_BACKUP", label: "", fields: CURRENT_FIELDS },
        { chunk: "SCENE", block: "SCENE", label: "My Data 1", fields: SCENE_FIELDS, trailing },
        {
          chunk: "SCENE",
          block: "SCENE",
          label: "My Data 2",
          fields: [{ id: 96, typecode: 1, elemSize: 2, values: [201] }],
        },
      ]),
    );
    expect(file.chunks.map((c) => c.label)).toEqual(["", "My Data 1", "My Data 2"]);
    expect(file.chunks[1].params).toEqual(new Map([[96, [200]]]));
    expect(file.chunks[2].params).toEqual(new Map([[96, [201]]]));
  });

  // The other direction stays a refusal: blocks that run past the length their chunk
  // declares would read the next record's bytes as values.
  it("rejects blocks that run past their chunk", () => {
    const bytes = sample();
    const view = new DataView(bytes.buffer);
    // dataLen is a BE u32 28 bytes into the chunk record header.
    view.setUint32(FILE_HEADER + 28, view.getUint32(FILE_HEADER + 28, false) - 1, false);
    expect(() => parseUrxf(bytes)).toThrow(expect.objectContaining({ code: "badBlock" }));
  });

  // With room after D allowed, the chunk lengths no longer pin where the record chain ends,
  // so the terminator does: a file cut at a record boundary, or a last chunk whose declared
  // length swallows `#END`, reads as complete otherwise.
  it("rejects a record chain that never reaches #END", () => {
    const bytes = sample();
    expect(() => parseUrxf(bytes.subarray(0, bytes.length - 36))).toThrow(
      expect.objectContaining({ code: "truncated" }),
    );
    // The last chunk record, found by its tag rather than by adding up the builder's lengths.
    const tag = new TextEncoder().encode("#ChunkData");
    let sceneAt = bytes.length;
    while (sceneAt-- > 0 && !tag.every((b, i) => bytes[sceneAt + i] === b));
    const swallowed = bytes.slice();
    // Declared to end exactly at EOF, so every byte the record claims exists.
    new DataView(swallowed.buffer).setUint32(sceneAt + 28, bytes.length - sceneAt - CHUNK_HEADER, false);
    expect(() => parseUrxf(swallowed)).toThrow(expect.objectContaining({ code: "truncated" }));
  });

  // The terminator is the record header alone, and it is the file's last record. One that
  // declares an extra block or a body, or that bytes follow, is not the end of a whole file.
  it("takes #END only when it is empty and ends the file", () => {
    const bytes = sample();
    const end = bytes.length - 36;
    const declaring = (offset: number): Uint8Array => {
      const out = new Uint8Array(bytes.length + 4);
      out.set(bytes);
      new DataView(out.buffer).setUint32(end + offset, 4, false);
      return out;
    };
    const followedBy = (tail: Uint8Array): Uint8Array => {
      const out = new Uint8Array(bytes.length + tail.length);
      out.set(bytes);
      out.set(tail, bytes.length);
      return out;
    };
    expect(() => parseUrxf(bytes)).not.toThrow();
    for (const [label, file] of [
      ["an extra block", declaring(24)],
      ["a body", declaring(28)],
      ["zero bytes after it", followedBy(new Uint8Array(4))],
      ["a second #END", followedBy(bytes.subarray(end))],
      ["a second file", followedBy(bytes)],
    ] as const) {
      expect(() => parseUrxf(file), label).toThrow(expect.objectContaining({ code: "truncated" }));
    }
  });

  // A numeric element is 1, 2 or 4 bytes wide. The width is checked on the descriptor,
  // so an array of no elements cannot carry an illegal one past the parse.
  it("rejects an illegal numeric width even on an array of no elements", () => {
    const withEmptyArray = (typecode: number, elemSize: number): Uint8Array => {
      const bytes = buildUrxf([
        {
          chunk: "CURRENT",
          block: "CSF_BACKUP",
          label: "",
          fields: [
            { id: 18, typecode: 4, elemSize: 1, values: ["", ""] },
            { id: 96, typecode: 1, elemSize: 2, values: [0] },
          ],
        },
      ]);
      const view = new DataView(bytes.buffer);
      const fPayload = FILE_HEADER + CHUNK_HEADER + BLOCK_HEADER;
      // The ASCII array record (8 bytes) becomes a numeric array of no elements; the scalar
      // record after it (6 bytes) widens to 4 so the values block, 2 + 2 bytes, still balances.
      view.setUint8(fPayload + 3, typecode);
      view.setUint16(fPayload + 4, elemSize, false);
      view.setUint16(fPayload + 6, 0, false);
      view.setUint16(fPayload + 8 + 4, 4, false);
      return bytes;
    };
    for (const typecode of [1, 2]) {
      for (const size of [3, 5, 8]) {
        expect(() => parseUrxf(withEmptyArray(typecode, size)), `typecode ${typecode} width ${size}`).toThrow(
          expect.objectContaining({ code: "badDescriptor" }),
        );
      }
      for (const size of [1, 2, 4]) {
        expect(
          parseUrxf(withEmptyArray(typecode, size)).chunks[0]!.params.get(18),
          `typecode ${typecode} width ${size}`,
        ).toEqual([]);
      }
    }
  });
});

// The builder's own guards. Each is a mistake the FILE takes without complaint — the
// bytes stay self-consistent and the parse succeeds, or the string is quietly cut — so
// without them a fixture can state one thing and decode as another, and the reader takes
// the blame. Exercised here because a guard nobody fires cannot be told from one whose
// bounds are wrong. No count in this sentence on purpose: the last one that was here went
// stale the moment two more were added.
describe("the fixture builder refuses what the format would swallow", () => {
  const chunkOf =
    (fields: Parameters<typeof buildUrxf>[0][number]["fields"]): (() => Uint8Array) =>
    () =>
      buildUrxf([{ chunk: "CURRENT", block: "CSF_BACKUP", label: "", fields }]);

  it("refuses two records sharing one id", () => {
    // Both records reach the file and the lengths still agree; the parse keeps the last.
    expect(
      chunkOf([
        { id: 14, typecode: 1, elemSize: 2, values: [1] },
        { id: 14, typecode: 1, elemSize: 2, values: [2] },
      ]),
    ).toThrow(/id 14 declared twice/);
  });

  it("refuses an id the descriptor cannot hold", () => {
    expect(chunkOf([{ id: 70000, typecode: 1, elemSize: 2, values: [1] }])).toThrow(/not a u16/);
  });

  it("refuses a value wider than its element", () => {
    expect(chunkOf([{ id: 14, typecode: 1, elemSize: 2, values: [70000] }])).toThrow(/does not fit 16 bits/);
    // Signed and unsigned are separate ranges: -600 is fine as a signed 16-bit level and
    // would otherwise be written as 64936 under an unsigned typecode.
    expect(chunkOf([{ id: 14, typecode: 1, elemSize: 2, values: [-600] }])).toThrow(/does not fit 16 bits/);
    expect(chunkOf([{ id: 14, typecode: 2, elemSize: 2, values: [-600] }])).not.toThrow();
  });

  // The string arm reaches the same rule one call down, in `cstring`. Without it this is
  // the one typecode where over-wide is still TRUNCATION rather than a refusal: the file
  // parses, and the case reading the name back asserts the short form.
  it("refuses a name wider than its element rather than cutting it", () => {
    expect(chunkOf([{ id: 18, typecode: 4, elemSize: 4, values: ["ch 1 long name"] }])).toThrow(
      /is 14 bytes, past the 4/,
    );
    // Bytes, not characters: two of these are 3 bytes each in UTF-8, so cutting at 4 would
    // land mid-sequence and decode as U+FFFD.
    expect(chunkOf([{ id: 18, typecode: 4, elemSize: 4, values: ["ああ"] }])).toThrow(/is 6 bytes, past the 4/);
    expect(chunkOf([{ id: 18, typecode: 4, elemSize: 4, values: ["ch 1"] }])).not.toThrow();
  });

  // An array record with a count of 0 is as absent from the device-written files as a
  // count of 1 is. It builds a file that parses, and the gap only shows up later as a
  // source read failing on "no element 0".
  it("refuses a field carrying no values", () => {
    expect(chunkOf([{ id: 14, typecode: 1, elemSize: 2, values: [] }])).toThrow(/carries no values/);
  });
});

describe("paramSourceOf", () => {
  const current = () => parseUrxf(sample()).chunks[0];

  it("addresses values by y index", async () => {
    const source = paramSourceOf(current());
    await expect(source.get(139, 0, 0)).resolves.toBe(-600);
    await expect(source.get(139, 0, 2)).resolves.toBe(300);
    await expect(source.getStr(18, 0, 1)).resolves.toBe("ch 2");
  });

  // The file stores an x axis by flattening it onto consecutive ids, so a broker
  // address of (545, band 1) has to resolve to file id 546.
  it("folds the x axis back onto the flattened ids", async () => {
    const source = paramSourceOf(current());
    await expect(source.get(545, 0, 1)).resolves.toBe(11);
    await expect(source.get(545, 1, 0)).resolves.toBe(20);
  });

  // A parameter genuinely not in the file must fail the group that reads it, so the
  // import reports it rather than leaving the plan's old value looking imported.
  it("throws for a parameter or element the file does not carry", async () => {
    const source = paramSourceOf(current());
    await expect(source.get(999, 0, 0)).rejects.toThrow(/no parameter 999/);
    await expect(source.get(139, 0, 9)).rejects.toThrow(/no element 9/);
    await expect(source.get(18, 0, 0)).rejects.toThrow(/is a string/);
    await expect(source.getStr(96, 0, 0)).rejects.toThrow(/is a number/);
  });

  // The oscillator's ON state (710) has no descriptor in any settings file: the
  // unit does not persist it and loads with it off. So the source supplies off (0)
  // rather than failing every import on a gap the device fills the same way.
  it("supplies the load-time value for a parameter the format never carries", async () => {
    await expect(paramSourceOf(current()).get(710, 0, 0)).resolves.toBe(0);
  });
});

// A file a unit wrote before System firmware 1.5 carries the Flex12GEQ records of STEREO and the MIX
// buses (EQ Type, [GEQ], GEQ Link, the 31 bands) but no GEQ Limit, which that firmware did not have.
// A URX44V on 1.5 that loads it keeps the Limit it holds, so the import keeps the plan's.
// A file's sample rate becomes the plan's, and from the plan it is written to the unit. Only a
// rate the unit runs at is taken; any other is a read that failed, and the plan keeps its rate.
describe("a file's sample rate", () => {
  const sourceAt = (rate: number) =>
    paramSourceOf(
      parseUrxf(
        buildUrxf([
          {
            chunk: "CURRENT",
            block: "CSF_BACKUP",
            label: "",
            fields: [...CURRENT_FIELDS, { id: PARAMS.SAMPLE_RATE.id, typecode: 1, elemSize: 4, values: [rate] }],
          },
        ]),
      ).chunks[0]!,
    );

  it("takes a rate the unit runs at", async () => {
    const plan = emptyPlan("URX44V");
    plan.sampleRate = 48_000;
    await applySourceState(getModel("URX44V"), plan, sourceAt(96_000));
    expect(plan.sampleRate).toBe(96_000);
  });

  it.each([32_000, 0, 384_000])("keeps the plan's rate for %d Hz, which the unit does not run at", async (rate) => {
    const plan = emptyPlan("URX44V");
    plan.sampleRate = 48_000;
    const result = await applySourceState(getModel("URX44V"), plan, sourceAt(rate));
    expect(plan.sampleRate).toBe(48_000);
    expect(result.errors.filter((e) => e.startsWith("sample rate:"))).toHaveLength(1);
  });
});

describe("a file written before System 1.5", () => {
  const n = (count: number, value: number): number[] => Array.from({ length: count }, () => value);
  const bands = (from: number, count: number): Field[] =>
    Array.from({ length: 31 }, (_, x) => ({ id: from + x, typecode: 2, elemSize: 2, values: n(count, 0) }));
  const geqFields = (limits: boolean): Field[] => [
    { id: 497, typecode: 1, elemSize: 1, values: [0] },
    { id: 543, typecode: 1, elemSize: 1, values: n(2, 1) },
    { id: 544, typecode: 1, elemSize: 1, values: n(2, 0) },
    ...bands(545, 2),
    { id: 590, typecode: 1, elemSize: 1, values: n(8, 0) },
    { id: 636, typecode: 1, elemSize: 1, values: n(8, 1) },
    { id: 637, typecode: 1, elemSize: 1, values: n(8, 1) },
    ...bands(638, 8),
    ...(limits
      ? [
          { id: 893, typecode: 1, elemSize: 1, values: n(2, 3) } as const,
          { id: 894, typecode: 1, elemSize: 1, values: n(8, 3) } as const,
        ]
      : []),
  ];
  const sourceOf = (limits: boolean) =>
    paramSourceOf(
      parseUrxf(buildUrxf([{ chunk: "CURRENT", block: "CSF_BACKUP", label: "", fields: geqFields(limits) }])).chunks[0],
    );
  // STEREO and MIX 1 hold a Limit other than the factory one, a gain inside it and Flex12GEQ; MIX 2
  // holds no Limit of its own.
  const held = () => {
    const plan = emptyPlan("URX44V");
    const side = (limit: number) => ({ on: true, limit, bands: [{ gain: 600 }] });
    plan.nodeParams["bus.stereo"] = { eqType: 2, geq: { link: 0, sides: [side(2), side(2)] } };
    plan.nodeParams["bus.mix1"] = { eqType: 2, geq: { link: 1, sides: [side(1), side(1)] } };
    plan.nodeParams["bus.mix2"] = { eqType: 2, geq: { link: 1, sides: [{ on: true }, { on: true }] } };
    return plan;
  };
  const limits = (plan: ReturnType<typeof emptyPlan>, node: string) =>
    plan.nodeParams[node]?.geq?.sides?.map((s) => s.limit);

  it("reports the GEQ Limit as kept only where the file does not carry it", () => {
    expect(sourceOf(false).keeps?.(893, 0, 1)).toBe(true);
    expect(sourceOf(false).keeps?.(894, 0, 3)).toBe(true);
    expect(sourceOf(true).keeps?.(893, 0, 1)).toBe(false);
    expect(sourceOf(false).keeps?.(999, 0, 0), "any other gap still fails its read").toBe(false);
  });

  it("imports the rest of the GEQ and keeps the plan's Limit", async () => {
    const plan = held();
    const result = await applySourceState(getModel("URX44V"), plan, sourceOf(false));
    expect(result.errors.filter((e) => /no parameter (893|894)/.test(e))).toEqual([]);
    for (const node of ["bus.stereo", "bus.mix1", "bus.mix2"]) {
      expect(plan.nodeParams[node]?.eqType, node).toBe(0);
      expect(plan.nodeParams[node]?.geq?.sides?.[0]?.bands?.[0], node).toEqual({ gain: 0 });
    }
    expect(limits(plan, "bus.stereo")).toEqual([2, 2]);
    expect(limits(plan, "bus.mix1")).toEqual([1, 1]);
    expect(limits(plan, "bus.mix2")).toEqual([undefined, undefined]);
    expect(plan.nodeParams["bus.mix2"]?.geq?.sides?.[0], "an absent Limit stays absent").not.toHaveProperty("limit");
  });

  // The control: a file written on 1.5 carries the Limit, and it is read.
  it("reads the Limit from a file that carries it", async () => {
    const plan = held();
    await applySourceState(getModel("URX44V"), plan, sourceOf(true));
    expect(limits(plan, "bus.stereo")).toEqual([3, 3]);
    expect(limits(plan, "bus.mix1")).toEqual([3, 3]);
    expect(limits(plan, "bus.mix2")).toEqual([3, 3]);
  });
});
