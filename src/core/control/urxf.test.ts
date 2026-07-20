// .urxf reader. The fixtures are built here rather than checked in: the format's
// two-level endianness (BE record/descriptor headers, LE block headers and values)
// is the thing under test, so the builder writes each field explicitly instead of
// echoing whatever the reader does.

import { describe, expect, it } from "vitest";
import { parseUrxf, paramSourceOf, UrxfError } from "./urxf";

interface Field {
  id: number;
  typecode: number;
  elemSize: number;
  /** Numbers for typecode 1/2, strings for typecode 4. */
  values: number[] | string[];
}

function cstring(text: string, width: number): Uint8Array {
  const bytes = new Uint8Array(width);
  bytes.set(new TextEncoder().encode(text).subarray(0, width));
  return bytes;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** F table (BIG-endian) + D values (LITTLE-endian), each in its own block. */
function buildChunkBody(name: string, fields: Field[]): Uint8Array {
  const descriptors: Uint8Array[] = [];
  const values: Uint8Array[] = [];
  for (const field of fields) {
    const array = field.values.length !== 1;
    const record = new DataView(new ArrayBuffer(array ? 8 : 6));
    record.setUint16(0, field.id, false);
    record.setUint8(2, array ? 0x40 : 0x00);
    record.setUint8(3, field.typecode);
    record.setUint16(4, field.elemSize, false);
    if (array) record.setUint16(6, field.values.length, false);
    descriptors.push(new Uint8Array(record.buffer));

    for (const value of field.values) {
      if (typeof value === "string") {
        values.push(cstring(value, field.elemSize));
        continue;
      }
      const cell = new DataView(new ArrayBuffer(field.elemSize));
      const signed = field.typecode === 2;
      if (field.elemSize === 1) signed ? cell.setInt8(0, value) : cell.setUint8(0, value);
      else if (field.elemSize === 2) signed ? cell.setInt16(0, value, true) : cell.setUint16(0, value, true);
      else signed ? cell.setInt32(0, value, true) : cell.setUint32(0, value, true);
      values.push(new Uint8Array(cell.buffer));
    }
  }
  const block = (prefix: string, payload: Uint8Array): Uint8Array => {
    const header = new Uint8Array(32);
    header.set(cstring(prefix + name, 24));
    const view = new DataView(header.buffer);
    view.setUint32(24, 10000, true);
    view.setUint32(28, payload.length, true);
    return concat([header, payload]);
  };
  return concat([block("F_", concat(descriptors)), block("D_", concat(values))]);
}

function buildChunk(chunkName: string, blockName: string, label: string, fields: Field[]): Uint8Array {
  const body = buildChunkBody(blockName, fields);
  const header = new Uint8Array(36 + 68);
  header.set(cstring("#ChunkData", 12));
  header.set(cstring(chunkName, 12), 12);
  const view = new DataView(header.buffer);
  view.setUint32(24, 68, false);
  view.setUint32(28, body.length, false);
  view.setUint32(36, chunkName === "CURRENT" ? 64 : 1, true);
  header.set(cstring(label, 64), 40);
  return concat([header, body]);
}

interface ChunkSpec {
  chunk: string;
  block: string;
  label: string;
  fields: Field[];
}

function buildUrxf(chunks: ChunkSpec[], model = "URX"): Uint8Array {
  const header = new Uint8Array(36 + 36);
  header.set(cstring("#YAMAHA MBDFProjectFile", 24));
  const view = new DataView(header.buffer);
  view.setUint32(24, 36, false); // extraLen
  view.setUint32(28, 0, false); // dataLen — chunks are siblings
  header.set(cstring(model, 16), 36);

  const parts: Uint8Array[] = [header];
  for (const spec of chunks) {
    const record = buildChunk(spec.chunk, spec.block, spec.label, spec.fields);
    parts.push(record);
    // Records are NUL-padded up to the next 4-byte boundary.
    const pad = (4 - (record.length % 4)) % 4;
    if (pad) parts.push(new Uint8Array(pad));
  }
  const end = new Uint8Array(36);
  end.set(cstring("#END", 24));
  parts.push(end);
  return concat(parts);
}

const CURRENT_FIELDS: Field[] = [
  { id: 18, typecode: 4, elemSize: 16, values: ["ch 1", "ch 2"] }, // channel names
  { id: 22, typecode: 1, elemSize: 4, values: [2147483904] }, // bitmask: unsigned, not negative
  { id: 96, typecode: 1, elemSize: 2, values: [184] },
  { id: 139, typecode: 2, elemSize: 2, values: [-600, 0, 300] }, // signed level_gain
  { id: 545, typecode: 2, elemSize: 2, values: [10, 11] }, // x-axis band 0
  { id: 546, typecode: 2, elemSize: 2, values: [20, 21] }, // ...flattened band 1
];

const SCENE_FIELDS: Field[] = [{ id: 96, typecode: 1, elemSize: 2, values: [200] }];

const sample = (): Uint8Array =>
  buildUrxf([
    { chunk: "CURRENT", block: "CSF_BACKUP", label: "", fields: CURRENT_FIELDS },
    { chunk: "SCENE", block: "SCENE", label: "My Data 1", fields: SCENE_FIELDS },
  ]);

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
    bytes.set(new TextEncoder().encode("PK"));
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
