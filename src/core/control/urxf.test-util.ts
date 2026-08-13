// A `.urxf` settings file, built field by field.
//
// The format's two-level endianness (BE record/descriptor headers, LE block headers and
// values) is the thing `urxf.test.ts` puts under test, so this builder **writes every
// field explicitly rather than calling anything in `urxf.ts`**. That is what makes it an
// independent witness: a builder that shared the reader's own encoder would agree with it
// however wrong both were, and the reader's suite would pass on a byte layout no unit
// writes. Every offset and every endianness flag below is therefore a duplicate on
// purpose, and the format notes in the private reference repository are what they are
// duplicated FROM.
//
// It also produces files no unit ever writes — a chunk with no CURRENT, a truncated one —
// which is the other half of why it is not built from real samples. Those live in the
// private reference repo and drive `urxf.local.test.ts`; this one runs in a fresh clone.
//
// Shared rather than private to `urxf.test.ts` because the app entry's settings-import
// flow needs the same bytes: it is driven through the desktop shell, which answers a file
// read with whatever this returns.

/** One parameter record: `values.length !== 1` makes it an array record. */
export interface Field {
  id: number;
  typecode: number;
  elemSize: number;
  /** Numbers for typecode 1/2, strings for typecode 4. */
  values: number[] | string[];
}

export interface ChunkSpec {
  chunk: string;
  block: string;
  label: string;
  fields: Field[];
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

/** A whole settings file. `model` is the header's model field, which reads "URX" for
 *  every variant on a real unit — the file names no variant, which is why the import
 *  makes the operator vouch for the selected one. */
export function buildUrxf(chunks: ChunkSpec[], model = "URX"): Uint8Array {
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

/** The CURRENT chunk's fields: one of each decoding shape the reader has to get right —
 *  an unsigned bitmask wide enough to read negative if taken as signed, a signed level
 *  that reads as a large positive if taken as unsigned, fixed-width ASCII, a scalar
 *  record beside an array one, and two flattened per-band rows. */
export const CURRENT_FIELDS: Field[] = [
  { id: 18, typecode: 4, elemSize: 16, values: ["ch 1", "ch 2"] }, // channel names
  { id: 22, typecode: 1, elemSize: 4, values: [2147483904] }, // bitmask: unsigned, not negative
  { id: 96, typecode: 1, elemSize: 2, values: [184] },
  { id: 139, typecode: 2, elemSize: 2, values: [-600, 0, 300] }, // signed level_gain
  { id: 545, typecode: 2, elemSize: 2, values: [10, 11] }, // x-axis band 0
  { id: 546, typecode: 2, elemSize: 2, values: [20, 21] }, // ...flattened band 1
];

export const SCENE_FIELDS: Field[] = [{ id: 96, typecode: 1, elemSize: 2, values: [200] }];

/** The everyday file: a CURRENT chunk plus one stored scene, the shape a unit's SETUP >
 *  SAVE produces. */
export const sampleUrxf = (): Uint8Array =>
  buildUrxf([
    { chunk: "CURRENT", block: "CSF_BACKUP", label: "", fields: CURRENT_FIELDS },
    { chunk: "SCENE", block: "SCENE", label: "My Data 1", fields: SCENE_FIELDS },
  ]);
