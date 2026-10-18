// The LCD simulator's scene pointers over the unit's own: the unit's current scene and the row
// its SCENE LIST cursor stands on (control/params.ts CURRENT_SCENE / SCENE_CURSOR), which the unit
// holds outside the plan. No scene title is given: the glass shows the unit's scenes by number.
import type { SimValue } from "./sim-map-base";

/** The glass's path for SCENE LIST's cursor, and for the tab it stands on: the simulator keeps both
 *  as its own (`GLASS_OWN` in ui/sim-view.ts), the cursor until the unit's cursor moves and the tab
 *  until it moves onto a row one tab alone lists. */
export const SCENE_CURSOR_PATH = "scene.selected";
export const SCENE_TAB_PATH = "scene.bank";

/** SCENE LIST's two tabs, as the simulator names them. */
export type SceneTab = "Standard" | "Simple";

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

/** The tab a cursor at `raw` stands on where only one of the two lists its row: 00 on Standard, a
 *  preset on Simple. Null for a user scene, which both list, and for a value outside the encoding. */
export function sceneTab(raw: number): SceneTab | null {
  const no = simSceneNumber(raw);
  if (no === 0) return "Standard";
  return no !== null && no > SIM_PRESET_BASE ? "Simple" : null;
}

/** What the glass shows for the unit's scene pointers: the current scene, SCENE LIST's cursor and
 *  the tab `tab` it stands on. A pointer outside the encoding is left to the glass. */
export function sceneGlassValues(
  current: number | null,
  cursor: number | null,
  tab: SceneTab | null,
): Map<string, SimValue> {
  const out = new Map<string, SimValue>();
  const now = current === null ? null : simSceneNumber(current);
  if (now !== null) out.set("scene.current", now);
  const picked = cursor === null ? null : simSceneNumber(cursor);
  if (picked !== null) out.set(SCENE_CURSOR_PATH, picked);
  if (tab !== null) out.set(SCENE_TAB_PATH, tab);
  return out;
}
