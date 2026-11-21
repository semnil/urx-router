// SCENE > [Recall Safe] (System firmware V1.5): what a scene recall leaves as it stands, row by row
// of the Input and Output tabs. Each row is a [Safe] and a selection of parameters
// (translate.ts `recallSafeRows`), state of the unit outside the plan that the live session reads,
// follows and shows on the SIM view's RECALL SAFE screen. The session writes a selection chosen on
// the glass and never a [Safe], which the unit takes from its own panel alone. Incoming Sends and
// the Others tab have no address of the link the app has found, and stay the glass's own.
//
// The glass names a row by its strip (urx-lcd-sim's `safe.<strip>.on` and `safe.<strip>.<key>`) and
// each parameter as a flag of its own; on the unit a parameter is a bit field of the row's
// selection, laid out by the kind of row.

import type { DeviceModel } from "../../models/types";
import { vdGet, vdSet } from "../platform";
import { simStripId } from "../sim-map-base";
import { addrKey, recallSafeRows, type RecallSafeKind, type RecallSafeRow } from "./translate";
import { writeSettle } from "./settle";

/** A parameter column of the RECALL SAFE screen, by urx-lcd-sim's name. */
export type SafeKey =
  "name" | "source" | "ha" | "processing" | "recPoint" | "toMix" | "toFx" | "chOn" | "chLevel" | "toSt";

const CHANNEL_BITS = {
  chLevel: 0x1,
  chOn: 0x2,
  toSt: 0xc,
  toMix: 0xff0,
  toFx: 0x3000,
  source: 0x10000,
  ha: 0x60000,
  name: 0x100000,
  recPoint: 0x8000000,
} as const satisfies Partial<Record<SafeKey, number>>;

/** The bits each column selects, by the kind of row. A column the row has no button for is absent. */
const BITS: Record<RecallSafeKind, Partial<Record<SafeKey, number>>> = {
  mono: { ...CHANNEL_BITS, processing: 0x7e00000 },
  stereoCh: { ...CHANNEL_BITS, processing: 0x12000000 },
  fx: { chLevel: 0x1, chOn: 0x2, toSt: 0xc, toMix: 0xff0, name: 0x100000 },
  mix: { chLevel: 0x1, chOn: 0x2, toSt: 0xc, name: 0x100000, processing: 0x2400000 },
  stereo: { chLevel: 0x1, chOn: 0x2, toSt: 0x4, name: 0x100000, processing: 0x2400000 },
  streaming: { source: 0x10000, name: 0x100000, processing: 0x20000000 },
};

/** The columns a kind of row has a button for, with their bits. */
export function safeColumnBits(kind: RecallSafeKind): ReadonlyArray<[SafeKey, number]> {
  return Object.entries(BITS[kind]) as Array<[SafeKey, number]>;
}

/** What the session holds of one row. `select` keeps every bit the unit answered, the ones no
 *  column names included, so a write changes only the columns chosen. */
export interface SafeRowState {
  safe: boolean;
  select: number;
}

/** What the session holds of RECALL SAFE, by the row's node id. */
export type RecallSafeState = ReadonlyMap<string, SafeRowState>;

/** Read every row's [Safe] and selection. The caller must have connected first. */
export async function readRecallSafe(
  model: DeviceModel,
  get: (paramId: number, x: number, y: number) => Promise<number> = vdGet,
): Promise<Map<string, SafeRowState>> {
  const out = new Map<string, SafeRowState>();
  for (const r of recallSafeRows(model)) {
    const safe = (await get(r.safe, 0, r.y)) !== 0;
    const select = (await get(r.select, 0, r.y)) >>> 0;
    out.set(r.node, { safe, select });
  }
  return out;
}

/** The addresses a session registers for notifies: each row's [Safe] and selection. */
export function recallSafeNotifyAddrs(model: DeviceModel): Array<[number, number, number]> {
  return recallSafeRows(model).flatMap((r): Array<[number, number, number]> => [
    [r.safe, 0, r.y],
    [r.select, 0, r.y],
  ]);
}

/** Which row a notify address is, and which of its two values, or undefined for any other. */
export function recallSafeAt(
  model: DeviceModel,
  paramId: number,
  x: number,
  y: number,
): { row: RecallSafeRow; part: "safe" | "select" } | undefined {
  if (x !== 0) return undefined;
  for (const row of recallSafeRows(model)) {
    if (row.y !== y) continue;
    if (row.safe === paramId) return { row, part: "safe" };
    if (row.select === paramId) return { row, part: "select" };
  }
  return undefined;
}

/** `state` with one notify of a row taken in. A row the session has not read is left out: the read
 *  that brings it in is the newer. */
export function withRecallSafeNotify(
  state: RecallSafeState,
  at: { row: RecallSafeRow; part: "safe" | "select" },
  value: number,
): Map<string, SafeRowState> {
  const out = new Map(state);
  const held = out.get(at.row.node);
  if (held)
    out.set(at.row.node, at.part === "safe" ? { ...held, safe: value !== 0 } : { ...held, select: value >>> 0 });
  return out;
}

/** The key a change to one of a row's two values is counted under (`mergeRecallSafeRead`). */
export const safePartKey = (node: string, part: "safe" | "select"): string => `${node}:${part}`;

/** `read` taken over `held` value by value, keeping each one `moved` names (`safePartKey`): it changed
 *  while the read was out, and the change is newer than the read's answer. The other value of the
 *  same row is the read's. */
export function mergeRecallSafeRead(
  held: RecallSafeState | null,
  read: RecallSafeState,
  moved: ReadonlySet<string>,
): Map<string, SafeRowState> {
  const out = new Map(read);
  if (!held) return out;
  for (const [node, answer] of read) {
    const kept = held.get(node);
    if (!kept) continue;
    out.set(node, {
      safe: moved.has(safePartKey(node, "safe")) ? kept.safe : answer.safe,
      select: moved.has(safePartKey(node, "select")) ? kept.select : answer.select,
    });
  }
  return out;
}

/** What the LCD chose on a row that has not been written yet: the bits to set and the bits to clear,
 *  laid over the unit's selection when the row is written and while it is shown. */
export interface SafePending {
  set: number;
  clear: number;
}

/** `pending` with one column selected (`on`) or cleared: the column's bits move from one side to the
 *  other. */
export function withPendingEdit(pending: SafePending | undefined, bits: number, on: boolean): SafePending {
  const p = pending ?? { set: 0, clear: 0 };
  return on
    ? { set: (p.set | bits) >>> 0, clear: (p.clear & ~bits) >>> 0 }
    : { set: (p.set & ~bits) >>> 0, clear: (p.clear | bits) >>> 0 };
}

/** `select` with `pending` laid over it. */
export function withPending(select: number, pending: SafePending | undefined): number {
  return pending ? ((select & ~pending.clear) | pending.set) >>> 0 : select;
}

const glassRow = (row: RecallSafeRow): string => `safe.${simStripId(row.node)}`;

/** The glass's values `state` knows, by path, with what the LCD chose and has not written yet
 *  (`pending`) laid over it: each row's [Safe] and each column it has a button for, a column selected
 *  where every one of its bits is. */
export function recallSafeGlassValues(
  model: DeviceModel,
  state: RecallSafeState,
  pending: ReadonlyMap<string, SafePending> = new Map(),
): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const row of recallSafeRows(model)) {
    const held = state.get(row.node);
    if (!held) continue;
    const select = withPending(held.select, pending.get(row.node));
    out.set(`${glassRow(row)}.on`, held.safe);
    for (const [key, bits] of safeColumnBits(row.kind)) out.set(`${glassRow(row)}.${key}`, (select & bits) === bits);
  }
  return out;
}

/** Every glass path a session's reading answers: each row's [Safe] and each column it has. */
export function recallSafeGlassPaths(model: DeviceModel): string[] {
  return recallSafeRows(model).flatMap((row) => [
    `${glassRow(row)}.on`,
    ...safeColumnBits(row.kind).map(([key]) => `${glassRow(row)}.${key}`),
  ]);
}

/** The glass path of every row's [Safe], which the unit does not take from the link. */
export function safeOnGlassPaths(model: DeviceModel): string[] {
  return recallSafeRows(model).map((row) => `${glassRow(row)}.on`);
}

/** The row and the column a glass path names, or null for a path no row of the unit answers —
 *  Incoming Sends and the Others tab included. */
function glassTarget(model: DeviceModel, path: string): { row: RecallSafeRow; key: SafeKey | "on" } | null {
  const m = /^safe\.(.+)\.([^.]+)$/.exec(path);
  if (!m) return null;
  const row = recallSafeRows(model).find((r) => simStripId(r.node) === m[1]);
  if (!row) return null;
  const key = m[2]!;
  if (key === "on") return { row, key };
  return key in BITS[row.kind] ? { row, key: key as SafeKey } : null;
}

/** Whether `path` is one of the unit's while a session holds its reading. */
export function isRecallSafeUnitPath(model: DeviceModel, path: string): boolean {
  return glassTarget(model, path) !== null;
}

/** The row an edit of `path` on the glass writes and the column's bits there, "refused" for a [Safe]
 *  or a row the session has not read, and null for a path no row of the unit answers. */
export function recallSafeGlassEdit(
  model: DeviceModel,
  state: RecallSafeState,
  path: string,
): { row: RecallSafeRow; bits: number } | "refused" | null {
  const target = glassTarget(model, path);
  if (!target) return null;
  if (target.key === "on" || !state.has(target.row.node)) return "refused";
  return { row: target.row, bits: BITS[target.row.kind][target.key]! };
}

/** Write one row's selection, resolving true once the unit has announced that value, and false once
 *  the settle window has passed without it — a write of the selection the unit already holds, or one
 *  it did not take; the caller reads the row back then (`readRecallSafeSelect`). A selection the unit
 *  announces in between, pressed on its panel, does not end the wait, so the next write to the row is
 *  made from what the unit holds after this one. The caller must have connected first. */
export async function writeRecallSafeSelect(row: RecallSafeRow, raw: number): Promise<boolean> {
  const mark = writeSettle.mark();
  await vdSet(row.select, 0, row.y, raw);
  return writeSettle.announcement(addrKey(row.select, 0, row.y), mark, raw);
}

/** Read one row's selection from the unit. The caller must have connected first. */
export function readRecallSafeSelect(
  row: RecallSafeRow,
  get: (paramId: number, x: number, y: number) => Promise<number> = vdGet,
): Promise<number> {
  return get(row.select, 0, row.y);
}
