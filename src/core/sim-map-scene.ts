// The LCD simulator's scene pointers over the unit's own: the scene the unit recalled and the row
// its SCENE LIST cursor stands on (control/params.ts CURRENT_SCENE / SCENE_CURSOR), which the unit
// holds outside the plan. No scene title is given: the glass shows the unit's scenes by number.
import type { SimValue } from "./sim-map-base";

/** The glass's paths for SCENE LIST's cursor and the tab it stands on: the simulator keeps them as
 *  its own (`GLASS_OWN` in ui/sim-view.ts) until the unit's cursor moves. */
export const SCENE_CURSOR_PATHS = ["scene.selected", "scene.bank"] as const;

/** The simulator numbers a preset Pn past this base, P01 being 101. */
const SIM_PRESET_BASE = 100;
/** The unit's presets, P01 to P03. */
const PRESETS = 3;
/** The unit's user scenes, 01 to 63. */
const USER_SCENES = 63;
/** The unit's flag on a factory scene: 00 Initial Data and the presets. */
const FACTORY = 0x8000;

/** The simulator's scene number for a pointer the unit reports, or null for a value outside the
 *  encoding: a user scene n reads n - 1, 00 Initial Data 0x8000, a preset Pn 0x8000 + n. */
export function simSceneNumber(raw: number): number | null {
  if (!Number.isInteger(raw) || raw < 0) return null;
  if (raw >= FACTORY) {
    const n = raw - FACTORY;
    if (n === 0) return 0;
    return n <= PRESETS ? SIM_PRESET_BASE + n : null;
  }
  return raw < USER_SCENES ? raw + 1 : null;
}

/** What the glass shows for the unit's scene pointers: the scene recalled, SCENE LIST's cursor,
 *  and the tab that lists the cursor's row where only one of the two lists it (00 on Standard, a
 *  preset on Simple). A pointer outside the encoding is left to the glass. */
export function sceneGlassValues(current: number | null, cursor: number | null): Map<string, SimValue> {
  const out = new Map<string, SimValue>();
  const recalled = current === null ? null : simSceneNumber(current);
  if (recalled !== null) out.set("scene.current", recalled);
  const picked = cursor === null ? null : simSceneNumber(cursor);
  if (picked !== null) {
    out.set("scene.selected", picked);
    if (picked === 0) out.set("scene.bank", "Standard");
    else if (picked > SIM_PRESET_BASE) out.set("scene.bank", "Simple");
  }
  return out;
}
