// The insert-FX editor's value model: which stored raw an engine slot reads, how
// an edit re-keys it, and what has to happen to the outgoing effect's values
// before the selector names another family. Split out of inspector.ts because a
// rendered-DOM assertion passes over exactly the step that matters — the bare
// slot key — without checking it.

import type { Plan } from "../core/plan";
import { insertFxSlotVal, type InsertFxFamily } from "../core/control/insert-fx-effect";

// The engine-slot map is keyed by family + slot, so a value stored by one effect is
// never read by the next one the selector names (insert-fx-effect.ts). A bare slot
// number is the device-shaped namespace a readback writes, read as the selected
// family's and replaced by the qualified key on the first edit.
export function insertFxVal(plan: Plan, nodeId: string, fam: InsertFxFamily, slot: number, def: number): number {
  return insertFxSlotVal(plan.nodeParams[nodeId]?.insertFxParams, fam, slot, def);
}

// The re-key rule belongs with the catalogue that defines the namespace: a slot is keyed by
// family, and the bare number a readback writes is the device's own shape. So does the seed a
// selection takes, which the load applies too. Both are re-exported here so the editor's
// modules take the whole value model from one import.
export { parkOutgoingInsertFxParams, reKeyInsertFxParams, seedInsertFxParams } from "../core/control/insert-fx-effect";
// So do Pitch Fix's patches, which the SIM view's rows write through as well.
export {
  pitchKeyChoice,
  pitchKeyPatch,
  pitchMidiMode,
  pitchMidiModeChange,
  pitchMidiPatch,
  pitchScaleChoice,
  pitchScalePatch,
  pitchScalesOffered,
} from "../core/control/insert-fx-effect";
