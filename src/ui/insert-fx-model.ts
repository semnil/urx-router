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
  PITCH_KEY_SLOT,
  PITCH_NOTE_SLOTS,
  PITCH_SCALE_OFFSETS,
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

/**
 * The engine patch a Pitch Fix scale selection writes: the scale slot, and the twelve
 * notes the preset turns on AT THIS KEY.
 *
 * The mask slots are absolute semitones and the unit derives them from the Scale enum and
 * the Key. Authoring them from the same offsets is what keeps a plan written offline
 * agreeing with what the unit would have derived — a mask rooted at C, written at any
 * other Key, is a different scale.
 *
 * Custom carries no pattern: it names whatever mask is already there, so the patch is the
 * enum alone.
 */
export function pitchScalePatch(scale: number, key: number): Record<number, number> {
  const patch: Record<number, number> = { [PITCH_SCALE_SLOT]: scale };
  const offsets = PITCH_SCALE_OFFSETS[scale];
  if (!offsets) return patch;
  const on = new Set(offsets.map((o) => (o + key) % 12));
  PITCH_NOTE_SLOTS.forEach((s, i) => (patch[s] = on.has(i) ? 1 : 0));
  return patch;
}

/** The mask a Key change re-roots to, keeping the scale it is currently spelling. The unit
 *  re-derives on a Key write of its own, so this is what an offline plan needs to match. */
export function pitchKeyPatch(scale: number, key: number): Record<number, number> {
  return { [PITCH_KEY_SLOT]: key, ...pitchScalePatch(scale, key) };
}

/**
 * MIDI Control's three-way, folded from its two engine bits: enable off = Off, enable on
 * with realtime off = Setting, both on = Real Time.
 *
 * There is no writer, deliberately. Switching the enable bit on erases a twelve-note mask
 * that is FULL and takes the Scale enum to Custom with it — measured — and the notes it
 * listens for arrive on a USB-MIDI port of the unit's own, which is not the port this app
 * reads external control from. The app shows the mode and leaves the setting to the unit.
 */
export function pitchMidiMode(enable: number, realtime: number): 0 | 1 | 2 {
  return enable === 0 ? 0 : realtime === 0 ? 1 : 2;
}
