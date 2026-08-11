// The insert-FX editor's value model: which stored raw an engine slot reads, how
// an edit re-keys it, and what has to happen to the outgoing effect's values
// before the selector names another family. Split out of inspector.ts because a
// rendered-DOM assertion passes over exactly the step that matters — the bare
// slot key — without checking it.

import type { NodeParams, Plan } from "../core/plan";
import {
  insertFxFamilyOf,
  insertFxParamKey,
  qualifyInsertFxParams,
  PITCH_MIDI_ENABLE_SLOT,
  PITCH_MIDI_REALTIME_SLOT,
  PITCH_NOTE_SLOTS,
  PITCH_SCALE_CHROMATIC,
  PITCH_SCALE_MAJOR,
  PITCH_SCALE_SLOT,
  type InsertFxFamily,
} from "../core/control/insert-fx-effect";

// The engine-slot map is keyed by family + slot, so a value stored by one effect is
// never read by the next one the selector names (insert-fx-effect.ts). A bare slot
// number is the device-shaped namespace a readback writes, read as the selected
// family's and replaced by the qualified key on the first edit.
export function insertFxVal(plan: Plan, nodeId: string, fam: InsertFxFamily, slot: number, def: number): number {
  const params = plan.nodeParams[nodeId]?.insertFxParams;
  return params?.[insertFxParamKey(fam, slot)] ?? params?.[String(slot)] ?? def;
}

/** Apply `patch` (slot → raw) to a node's stored engine values under `fam`'s own
 *  keys, dropping the bare slot each patched value came from so the two namespaces
 *  cannot both answer for one slot. Returns a new map. */
export function reKeyInsertFxParams(
  params: Record<string, number>,
  fam: InsertFxFamily,
  patch: Record<number, number>,
): Record<string, number> {
  const next = { ...params };
  for (const [slot, raw] of Object.entries(patch)) {
    next[insertFxParamKey(fam, Number(slot))] = raw;
    delete next[slot];
  }
  return next;
}

/** Park the outgoing effect's engine values under its own family before the
 *  selector names another one: a bare slot number left behind would be read as the
 *  new family's, whose slot means a different parameter under a different law, and
 *  emitted as absolute state on the next flush. Null when the node carries no
 *  engine values to park. */
export function parkOutgoingInsertFxParams(prev: NodeParams | undefined): Record<string, number> | null {
  if (!prev?.insertFxParams) return null;
  const prevFam = prev.insertFx === undefined ? null : insertFxFamilyOf(prev.insertFx);
  return qualifyInsertFxParams(prev.insertFxParams, prevFam);
}

// Standard C-major scale (semitone offsets on = major; the rest off). Used by the
// Pitch Fix scale preset buttons; calibration confirmed Major clears slots
// 23/25/28/30/32 (the non-major semitones).
export const PITCH_MAJOR_ON = new Set([0, 2, 4, 5, 7, 9, 11]);

/** The engine patch a Pitch Fix scale selection writes: the scale slot always, plus
 *  the 12 note slots for the two presets the app authors (Chromatic = all on, Major
 *  = the major mask). Every other preset is a device value the app only displays,
 *  so it sets the scale slot alone and leaves the note pattern as read back. */
export function pitchScalePatch(scale: number): Record<number, number> {
  const patch: Record<number, number> = { [PITCH_SCALE_SLOT]: scale };
  if (scale === PITCH_SCALE_CHROMATIC) PITCH_NOTE_SLOTS.forEach((s) => (patch[s] = 1));
  else if (scale === PITCH_SCALE_MAJOR) PITCH_NOTE_SLOTS.forEach((s, i) => (patch[s] = PITCH_MAJOR_ON.has(i) ? 1 : 0));
  return patch;
}

/** MIDI Control's three-way, folded from its two engine bits: enable off = Off,
 *  enable on with realtime off = Setting, both on = Real Time. */
export function pitchMidiMode(enable: number, realtime: number): 0 | 1 | 2 {
  return enable === 0 ? 0 : realtime === 0 ? 1 : 2;
}

/** The two engine bits a MIDI Control mode selection writes. */
export function pitchMidiPatch(mode: number): Record<number, number> {
  return { [PITCH_MIDI_ENABLE_SLOT]: mode === 0 ? 0 : 1, [PITCH_MIDI_REALTIME_SLOT]: mode === 2 ? 1 : 0 };
}
