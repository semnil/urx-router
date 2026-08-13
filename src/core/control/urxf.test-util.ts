// A `.urxf` settings file, built field by field.
//
// The format's two-level endianness (BE record/descriptor headers, LE block headers and
// values) is the thing `urxf.test.ts` puts under test, so this builder **writes every
// field explicitly rather than importing anything from `urxf.ts`**. That is what makes it
// an independent witness: `urxf.ts` reads and does not write, so what it would share is
// its offsets and its endianness flags, and a builder taking those from the reader would
// agree with it however wrong both were — the suite would pass on a byte layout no unit
// writes. Every offset and every endianness flag below is therefore a duplicate on
// purpose, and the format notes in the private reference repository
// (`reference/work/urxf/urxf-file-format.md`) are what they are duplicated FROM.
//
// It also builds files no unit ever writes — `buildUrxf` takes the chunk list it is
// handed, so a caller can ask for one with no CURRENT chunk. Real samples cannot supply
// that: every file the hardware writes leads with CURRENT, which is what
// `urxf.local.test.ts` asserts over the private samples in `reference/work/urxf/samples`.
// (A truncated file needs no builder support — a caller slices the bytes.)
//
// Shared rather than private to `urxf.test.ts` because the app entry's settings-import
// flow needs the same bytes: it is driven through the desktop shell, which answers a file
// read with whatever this returns. Two consequences of that sharing: the header sizes are
// exported below, because `urxf.test.ts` pokes at absolute offsets and a literal copy of
// them there would drift silently; and `CURRENT_FIELDS` is ordered, because those same
// offsets address its first record.

/** File header, up to the first chunk record. */
export const FILE_HEADER = 36 + 36;
/** Chunk record header, up to its first block. */
export const CHUNK_HEADER = 36 + 68;
/** F / D block header, up to its payload. */
export const BLOCK_HEADER = 32;

/**
 * One parameter record.
 *
 * The typecode and the values are ONE choice rather than two independent fields: the
 * reader branches on the typecode and never on the element size, so a record that
 * declared ASCII while carrying numbers would write a descriptor and a value block that
 * disagree, and the file would decode to whatever the bytes happened to say — silently,
 * and in a fixture whose whole purpose is to be the trustworthy side of the comparison.
 *
 * `values.length !== 1` makes it an array record. A single value is therefore always the
 * 6-byte scalar record, which is what the hardware writes: across the 35 device-written
 * files in the private reference repository there is no array record with a count of 1
 * (the counts that occur are 2, 4, 8, 12, 16, 32, 64 and 108). An empty list is refused
 * rather than encoded, for the same reason and from the same scan.
 *
 * The strings are checked too, one call down in `cstring`. Nothing can check them here —
 * TypeScript cannot relate a string literal's UTF-8 length to `elemSize`, which is why
 * that arm's element size stays open — so an ASCII value that does not fit is refused
 * while the file is being built rather than cut down to something a case asserts against.
 */
export type Field =
  | { readonly id: number; readonly typecode: 1 | 2; readonly elemSize: 1 | 2 | 4; readonly values: readonly number[] }
  | { readonly id: number; readonly typecode: 4; readonly elemSize: number; readonly values: readonly string[] };

/** A chunk. The name is the format's own vocabulary rather than a free string: the extra
 *  word below switches on it, and so does the app when it looks for the live settings —
 *  so a typo would build a file that parses cleanly and then refuses as "no CURRENT". */
export interface ChunkSpec {
  readonly chunk: "CURRENT" | "SCENE";
  readonly block: string;
  readonly label: string;
  readonly fields: readonly Field[];
}

/** Fixed-width text, refusing what will not fit rather than cutting it.
 *
 *  Every string in the file goes through here — a parameter's ASCII value, a scene label,
 *  a block name, the model — so this is the one place the file could have cut one down,
 *  and it does not. Cutting silently is how a fixture ends up declaring "ch 1 long name"
 *  and encoding "ch 1 long", after which the case that reads it back asserts the short
 *  form and the reader looks wrong. The width is bytes, not characters, so a multi-byte
 *  character that straddles the end would otherwise be cut mid-sequence and decode as
 *  U+FFFD. */
function cstring(text: string, width: number): Uint8Array {
  if (!Number.isInteger(width) || width < 1) throw new RangeError(`urxf fixture: width ${width} is not a size`);
  const encoded = new TextEncoder().encode(text);
  if (encoded.length > width) {
    throw new RangeError(`urxf fixture: "${text}" is ${encoded.length} bytes, past the ${width} it is written into`);
  }
  const bytes = new Uint8Array(width);
  bytes.set(encoded);
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

/**
 * What the type cannot say, checked while building.
 *
 * Every one of these is silent in the file rather than loud — the bytes stay
 * self-consistent, the length checks still balance, and the parse succeeds — so each would
 * present as a fixture that "just does not decode the way the notes say", which is the
 * reader's alibi rather than the builder's:
 *
 * - a duplicate id leaves both records in the bytes and the parse drops the earlier one;
 * - an id past u16 wraps into a different parameter;
 * - a numeric value too wide for its element is truncated to something a case then asserts
 *   against (a string too wide for its element is refused by `cstring`, one call down);
 * - an empty value list becomes an array record with a count of 0, which no unit writes:
 *   the same scan that found no count of 1 across the 35 device-written files found no
 *   count of 0 either, and the parse then answers the parameter with an empty list, which
 *   surfaces later as "no element 0" from a source read.
 */
function checkFields(fields: readonly Field[]): void {
  const seen = new Set<number>();
  for (const field of fields) {
    if (!Number.isInteger(field.id) || field.id < 0 || field.id > 0xffff) {
      throw new RangeError(`urxf fixture: id ${field.id} is not a u16`);
    }
    if (seen.has(field.id)) throw new RangeError(`urxf fixture: id ${field.id} declared twice in one chunk`);
    seen.add(field.id);
    if (field.values.length === 0) throw new RangeError(`urxf fixture: id ${field.id} carries no values`);
    if (field.typecode === 4) continue;
    const bits = field.elemSize * 8;
    const min = field.typecode === 2 ? -(2 ** (bits - 1)) : 0;
    const max = field.typecode === 2 ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
    for (const value of field.values) {
      if (!Number.isInteger(value) || value < min || value > max) {
        throw new RangeError(`urxf fixture: id ${field.id} value ${value} does not fit ${bits} bits (${min}..${max})`);
      }
    }
  }
}

/** F table (BIG-endian) + D values (LITTLE-endian), each in its own block. */
function buildChunkBody(name: string, fields: readonly Field[]): Uint8Array {
  checkFields(fields);
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

    if (field.typecode === 4) {
      for (const text of field.values) values.push(cstring(text, field.elemSize));
      continue;
    }
    // Branch on the typecode, never on the element size — the rule the reader states, and
    // the reason the two are one choice in `Field`.
    for (const value of field.values) {
      const cell = new DataView(new ArrayBuffer(field.elemSize));
      const signed = field.typecode === 2;
      if (field.elemSize === 1) signed ? cell.setInt8(0, value) : cell.setUint8(0, value);
      else if (field.elemSize === 2) signed ? cell.setInt16(0, value, true) : cell.setUint16(0, value, true);
      else signed ? cell.setInt32(0, value, true) : cell.setUint32(0, value, true);
      values.push(new Uint8Array(cell.buffer));
    }
  }
  const block = (prefix: string, payload: Uint8Array): Uint8Array => {
    const header = new Uint8Array(BLOCK_HEADER);
    header.set(cstring(prefix + name, 24));
    const view = new DataView(header.buffer);
    view.setUint32(24, 10000, true);
    view.setUint32(28, payload.length, true);
    return concat([header, payload]);
  };
  return concat([block("F_", concat(descriptors)), block("D_", concat(values))]);
}

function buildChunk(
  chunkName: ChunkSpec["chunk"],
  blockName: string,
  label: string,
  fields: readonly Field[],
): Uint8Array {
  const body = buildChunkBody(blockName, fields);
  const header = new Uint8Array(CHUNK_HEADER);
  header.set(cstring("#ChunkData", 12));
  header.set(cstring(chunkName, 12), 12);
  const view = new DataView(header.buffer);
  view.setUint32(24, 68, false);
  view.setUint32(28, body.length, false);
  view.setUint32(36, chunkName === "CURRENT" ? 64 : 1, true);
  header.set(cstring(label, 64), 40);
  return concat([header, body]);
}

/** A whole settings file. `model` is the header's model field: the file names no variant,
 *  which is why the import makes the operator vouch for the selected one — the reason is
 *  stated where the import is implemented. Every device-written sample here reads "URX",
 *  and all of them came off a URX44V. */
export function buildUrxf(chunks: readonly ChunkSpec[], model = "URX"): Uint8Array {
  const header = new Uint8Array(FILE_HEADER);
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
  return concat([...parts, end]);
}

/** The CURRENT chunk's fields: one of each decoding shape the reader has to get right —
 *  an unsigned bitmask wide enough to read negative if taken as signed, a signed level
 *  that reads as a large positive if taken as unsigned, fixed-width ASCII, a scalar
 *  record beside an array one, and two flattened per-band rows.
 *
 *  The ORDER is load-bearing beyond this file: `urxf.test.ts` reaches the first
 *  descriptor by absolute offset, so a record inserted at the head moves what that case
 *  corrupts. Append rather than prepend. */
export const CURRENT_FIELDS: readonly Field[] = [
  { id: 18, typecode: 4, elemSize: 16, values: ["ch 1", "ch 2"] }, // channel names
  { id: 22, typecode: 1, elemSize: 4, values: [2147483904] }, // bitmask: unsigned, not negative
  { id: 96, typecode: 1, elemSize: 2, values: [184] },
  { id: 139, typecode: 2, elemSize: 2, values: [-600, 0, 300] }, // signed level_gain
  { id: 545, typecode: 2, elemSize: 2, values: [10, 11] }, // x-axis band 0
  { id: 546, typecode: 2, elemSize: 2, values: [20, 21] }, // ...flattened band 1
];

export const SCENE_FIELDS: readonly Field[] = [{ id: 96, typecode: 1, elemSize: 2, values: [200] }];

/** The everyday file: a CURRENT chunk plus one stored scene, the shape a unit's SETUP >
 *  SAVE produces. */
export const sampleUrxf = (): Uint8Array =>
  buildUrxf([
    { chunk: "CURRENT", block: "CSF_BACKUP", label: "", fields: CURRENT_FIELDS },
    { chunk: "SCENE", block: "SCENE", label: "My Data 1", fields: SCENE_FIELDS },
  ]);
