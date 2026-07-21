// Reader for the URX's microSD settings file (.urxf) — the file the unit itself
// writes from SETUP > SAVE. It carries the same parameter space as the vd broker,
// so a parsed chunk can drive the existing device→plan inverse in readback.ts
// verbatim (see paramSourceOf below).
//
// Two traps the format layers on top of each other:
//   - Endianness alternates by level. Record headers and the F descriptor records
//     are BIG-endian; block headers and every value in D are LITTLE-endian.
//   - D is a frameless concatenation. It can only be walked with its own F table,
//     and one wrong elemSize destroys everything after it — hence the two length
//     assertions below, which are the file's only integrity check.
//
// Read-only by design: writing a settings file back is not implemented (a file
// with fewer scene chunks may or may not erase the unit's scene memory, which is
// untested on hardware).

import type { ParamSource } from "./readback";

const DECODER = new TextDecoder();

const FILE_TAG = "#YAMAHA MBDFProjectFile";
const CHUNK_TAG = "#ChunkData";
const END_TAG = "#END";
const RECORD_HEADER = 36;
const BLOCK_HEADER = 32;
const BLOCK_MAGIC = 10000;
/** Padding between records is NUL bytes up to the next alignment boundary. */
const MAX_PADDING = 4;

/** Descriptor typecodes (F record +3). */
const TC_UNSIGNED = 1;
const TC_SIGNED = 2;
const TC_ASCII = 4;

export type UrxfErrorCode = "notUrxf" | "truncated" | "badBlock" | "badDescriptor" | "lengthMismatch" | "noCurrent";

/** A refusal to parse. `code` selects the localized message; `detail` carries the
 *  offset / lengths that identify where the file stopped making sense. */
export class UrxfError extends Error {
  constructor(
    readonly code: UrxfErrorCode,
    readonly detail = "",
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "UrxfError";
  }
}

/** One parameter's stored values: one entry per y index (ASCII params hold strings). */
export type UrxfValues = number[] | string[];

export interface UrxfChunk {
  /** "CURRENT" (the unit's live settings) or "SCENE" (a stored scene). */
  name: string;
  /** Scene label. It lives in the file scaffolding only — no parameter holds it,
   *  so it cannot survive into a plan. Empty for CURRENT. */
  label: string;
  /** param id → values. x-axis parameters are stored flattened onto consecutive
   *  ids (id + band), which paramSourceOf folds back into an (id, x) address. */
  params: Map<number, UrxfValues>;
}

export interface UrxfFile {
  /** The header's model string. It reads "URX" for every unit — the file does not
   *  distinguish URX22 / URX44 / URX44V, so an import cannot pick the model. */
  model: string;
  chunks: UrxfChunk[];
}

/** Parse a settings file. Throws UrxfError on anything it cannot account for —
 *  a partly-decoded file would land silently wrong values on the plan. */
export function parseUrxf(bytes: Uint8Array): UrxfFile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Too short to even hold a record header: report it as the wrong kind of file
  // rather than as a truncated settings file, which is what a stray drop is.
  if (bytes.length < RECORD_HEADER) throw new UrxfError("notUrxf", `${bytes.length} bytes`);
  const header = readRecordHeader(view, bytes, 0);
  if (header.tag !== FILE_TAG) throw new UrxfError("notUrxf", header.tag);
  // The file header's extra block holds the model string and a per-save id; the
  // chunks are siblings that follow it, not its children (dataLen is 0).
  const model = readCString(bytes, RECORD_HEADER, 16);
  const chunks: UrxfChunk[] = [];

  let at = RECORD_HEADER + header.extraLen + header.dataLen;
  while (at < bytes.length) {
    const rec = readRecordHeader(view, bytes, at);
    if (rec.tag === END_TAG) break;
    if (rec.tag !== CHUNK_TAG) throw new UrxfError("truncated", `record "${rec.tag}" at ${at}`);
    const body = at + RECORD_HEADER + rec.extraLen;
    require(bytes, body, rec.dataLen, at);
    chunks.push({
      name: readCString(bytes, at + 12, 12),
      label: readCString(bytes, at + RECORD_HEADER + 4, 64),
      params: readChunkBody(view, bytes, body, rec.dataLen),
    });
    at = skipPadding(bytes, body + rec.dataLen);
  }
  if (chunks.length === 0) throw new UrxfError("truncated", "no chunks");
  return { model, chunks };
}

// Parameters the format itself has no descriptor for — an absence of the file
// kind, not of one file (checked against the four shipped example plans, where
// this is the only one). The unit does not persist the oscillator's ON state and
// loads with it off, so the source supplies off (0) rather than failing on a
// parameter no settings file can carry: a structural gap the device fills the same
// way every load is not a read failure. Anything absent and *not* listed here is a
// genuine gap and still surfaces.
const ABSENT_FROM_FORMAT = new Map<number, { name: string; onLoad: number }>([
  [710, { name: "oscillator ON", onLoad: 0 }],
]);

/**
 * A readback parameter source backed by one chunk. Addresses arrive as the broker
 * addresses readback.ts already uses; the file stores an x axis by flattening it
 * onto consecutive ids, so x folds back into the id here.
 *
 * A parameter the file does not carry throws rather than falling back to the
 * plan's current value: a readback group that silently keeps its old value would
 * report the plan as imported while part of it still shows what was there before.
 */
export function paramSourceOf(chunk: UrxfChunk): ParamSource {
  const at = (paramId: number, x: number, y: number): number | string => {
    const values = chunk.params.get(paramId + x);
    if (!values) {
      const known = ABSENT_FROM_FORMAT.get(paramId + x);
      if (known) return known.onLoad;
      throw new Error(`settings file has no parameter ${paramId + x}`);
    }
    const value = values[y];
    if (value === undefined) throw new Error(`parameter ${paramId + x} has no element ${y}`);
    return value;
  };
  // Async so a miss arrives as a rejection, exactly as it would from the device
  // reads these stand in for — a synchronous throw would escape a caller that only
  // guards the promise.
  return {
    get: async (paramId, x, y) => {
      const value = at(paramId, x, y);
      if (typeof value !== "number") throw new Error(`parameter ${paramId + x} is a string`);
      return value;
    },
    getStr: async (paramId, x, y) => {
      const value = at(paramId, x, y);
      if (typeof value !== "string") throw new Error(`parameter ${paramId + x} is a number`);
      return value;
    },
  };
}

interface RecordHeader {
  tag: string;
  extraLen: number;
  dataLen: number;
}

/** Record header: 24-byte tag then three BIG-endian u32 (the third is reserved). */
function readRecordHeader(view: DataView, bytes: Uint8Array, at: number): RecordHeader {
  require(bytes, at, RECORD_HEADER);
  return {
    tag: readCString(bytes, at, 24),
    extraLen: view.getUint32(at + 24, false),
    dataLen: view.getUint32(at + 28, false),
  };
}

/** A chunk body is exactly two blocks: the F descriptor table then the D values. */
function readChunkBody(view: DataView, bytes: Uint8Array, at: number, len: number): Map<number, UrxfValues> {
  const f = readBlockHeader(view, bytes, at, "F_");
  const d = readBlockHeader(view, bytes, f.payload + f.length, "D_");
  const end = d.payload + d.length;
  if (end !== at + len) throw new UrxfError("badBlock", `blocks end at ${end}, chunk at ${at + len}`);
  const table = readDescriptors(view, bytes, f.payload, f.length);
  return readValues(view, bytes, d.payload, d.length, table);
}

interface BlockHeader {
  payload: number;
  length: number;
}

/** Block header: 24-byte name then two LITTLE-endian u32 (magic, payload length). */
function readBlockHeader(view: DataView, bytes: Uint8Array, at: number, prefix: string): BlockHeader {
  require(bytes, at, BLOCK_HEADER);
  const name = readCString(bytes, at, 24);
  if (!name.startsWith(prefix)) throw new UrxfError("badBlock", `expected ${prefix}* at ${at}, got "${name}"`);
  if (view.getUint32(at + 24, true) !== BLOCK_MAGIC) throw new UrxfError("badBlock", `bad magic at ${at}`);
  const length = view.getUint32(at + 28, true);
  const payload = at + BLOCK_HEADER;
  require(bytes, payload, length, at);
  return { payload, length };
}

interface Descriptor {
  id: number;
  typecode: number;
  elemSize: number;
  count: number;
}

/** F records, BIG-endian: u16 id / u8 flag / u8 typecode / u16 elemSize, plus a
 *  u16 count only when flag says array (a scalar record is 6 bytes, not 8). */
function readDescriptors(view: DataView, bytes: Uint8Array, at: number, len: number): Descriptor[] {
  const table: Descriptor[] = [];
  const end = at + len;
  let cursor = at;
  while (cursor < end) {
    require(bytes, cursor, 6);
    const flag = view.getUint8(cursor + 2);
    if (flag !== 0x00 && flag !== 0x40) throw new UrxfError("badDescriptor", `flag ${flag} at ${cursor}`);
    const array = flag === 0x40;
    if (array) require(bytes, cursor, 8);
    table.push({
      id: view.getUint16(cursor, false),
      typecode: view.getUint8(cursor + 3),
      elemSize: view.getUint16(cursor + 4, false),
      count: array ? view.getUint16(cursor + 6, false) : 1,
    });
    cursor += array ? 8 : 6;
  }
  // The record stream must land exactly on the block end: a stray byte means the
  // table was misread, and every value decoded from it would be misaligned.
  if (cursor !== end) throw new UrxfError("lengthMismatch", `descriptors end at ${cursor}, block at ${end}`);
  return table;
}

/** D is a frameless concatenation in F order. Branch on typecode, never on
 *  elemSize: a 4-byte bitmask and a 4-byte ASCII field are the same width. */
function readValues(
  view: DataView,
  bytes: Uint8Array,
  at: number,
  len: number,
  table: Descriptor[],
): Map<number, UrxfValues> {
  const params = new Map<number, UrxfValues>();
  let cursor = at;
  for (const desc of table) {
    const span = desc.elemSize * desc.count;
    if (cursor + span > at + len) throw new UrxfError("lengthMismatch", `parameter ${desc.id} overruns D`);
    if (desc.typecode === TC_ASCII) {
      const values: string[] = [];
      for (let i = 0; i < desc.count; i++) values.push(readCString(bytes, cursor + i * desc.elemSize, desc.elemSize));
      params.set(desc.id, values);
    } else {
      const signed = desc.typecode === TC_SIGNED;
      if (!signed && desc.typecode !== TC_UNSIGNED) {
        throw new UrxfError("badDescriptor", `typecode ${desc.typecode} on parameter ${desc.id}`);
      }
      const values: number[] = [];
      for (let i = 0; i < desc.count; i++)
        values.push(readNumber(view, cursor + i * desc.elemSize, desc.elemSize, signed));
      params.set(desc.id, values);
    }
    cursor += span;
  }
  // Σ(elemSize × count) == D length is the file's best (and only) corruption check.
  if (cursor !== at + len) throw new UrxfError("lengthMismatch", `values end at ${cursor}, block at ${at + len}`);
  return params;
}

function readNumber(view: DataView, at: number, size: number, signed: boolean): number {
  switch (size) {
    case 1:
      return signed ? view.getInt8(at) : view.getUint8(at);
    case 2:
      return signed ? view.getInt16(at, true) : view.getUint16(at, true);
    case 4:
      return signed ? view.getInt32(at, true) : view.getUint32(at, true);
    default:
      throw new UrxfError("badDescriptor", `element size ${size}`);
  }
}

/** Fixed-width field cut at its first NUL. */
function readCString(bytes: Uint8Array, at: number, width: number): string {
  require(bytes, at, width);
  let end = at;
  while (end < at + width && bytes[end] !== 0) end++;
  return DECODER.decode(bytes.subarray(at, end));
}

/** Skip the NUL padding that aligns the next record. */
function skipPadding(bytes: Uint8Array, at: number): number {
  let next = at;
  while (next < bytes.length && next - at < MAX_PADDING && bytes[next] === 0) next++;
  return next;
}

function require(bytes: Uint8Array, at: number, len: number, context = at): void {
  if (at < 0 || len < 0 || at + len > bytes.length) {
    throw new UrxfError("truncated", `need ${len} bytes at ${at} (record ${context})`);
  }
}
