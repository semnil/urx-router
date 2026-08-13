// .urxf reader. The fixtures are built rather than checked in, and the builder lives in
// `urxf.test-util.ts` — shared with the app entry's settings-import cases, and independent
// of `urxf.ts` on purpose (its header says why). The byte offsets this file pokes at are
// the layout that builder writes.

import { describe, expect, it } from "vitest";
import { parseUrxf, paramSourceOf } from "./urxf";
import { BLOCK_HEADER, buildUrxf, CHUNK_HEADER, FILE_HEADER, sampleUrxf as sample } from "./urxf.test-util";

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

  it("rejects a block whose magic is wrong", () => {
    const bytes = sample();
    // 24 bytes into the F block header, which is the magic. Note the neighbouring field
    // (the payload length, 4 bytes further on) also refuses as `badBlock`, so this offset
    // has to be right rather than merely close.
    new DataView(bytes.buffer).setUint32(FILE_HEADER + CHUNK_HEADER + 24, 1, true);
    expect(() => parseUrxf(bytes)).toThrow(expect.objectContaining({ code: "badBlock" }));
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
