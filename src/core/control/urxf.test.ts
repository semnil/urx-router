// .urxf reader. The fixtures are built rather than checked in, and the builder lives in
// `urxf.test-util.ts` — shared with the app entry's settings-import cases, and independent
// of `urxf.ts` on purpose (its header says why). The byte offsets this file pokes at are
// the layout that builder writes.

import { describe, expect, it } from "vitest";
import { parseUrxf, paramSourceOf, UrxfError } from "./urxf";
import { sampleUrxf as sample } from "./urxf.test-util";

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
    expect(() => parseUrxf(bytes.subarray(0, bytes.length - 200))).toThrow(UrxfError);
  });

  // Σ(elemSize × count) == D length is the only integrity check the format offers,
  // so a descriptor that no longer matches its values must stop the parse — every
  // parameter after it would decode at the wrong offset.
  it("rejects a descriptor table that does not match the values block", () => {
    const bytes = sample();
    const view = new DataView(bytes.buffer);
    // The first descriptor's elemSize (BE u16) sits 4 bytes into the F payload.
    const fPayload = 72 + 104 + 32;
    view.setUint16(fPayload + 4, 8, false);
    expect(() => parseUrxf(bytes)).toThrow(expect.objectContaining({ code: "lengthMismatch" }));
  });

  it("rejects a block whose magic is wrong", () => {
    const bytes = sample();
    new DataView(bytes.buffer).setUint32(72 + 104 + 24, 1, true);
    expect(() => parseUrxf(bytes)).toThrow(expect.objectContaining({ code: "badBlock" }));
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
