// Persisted section open/closed overrides, keyed by section kind (not per node)
// so a fold preference is consistent across nodes and survives both re-renders
// and reloads. A section with an ON-state default (gate / comp / eq / ducker)
// clears its override when the value is toggled, so it reverts to following the
// on-state (auto-collapse when off); a user fold of the disclosure persists.
//
// Split out of inspector.ts so the store can be reset between tests: the cache
// below is loaded once and re-persisted on every write, so clearing localStorage
// alone does not put a later render back at the defaults.

import { loadJson, saveJson } from "../core/storage";

const SECTION_STATE_KEY = "urx-inspector-sections";
type SectionState = Record<string, boolean>;
let sectionState: SectionState | null = null;

function sectionOverrides(): SectionState {
  if (sectionState === null) {
    const v = loadJson<unknown>(SECTION_STATE_KEY, null);
    sectionState = v && typeof v === "object" ? (v as SectionState) : {};
  }
  return sectionState;
}

function persistSectionState(): void {
  saveJson(SECTION_STATE_KEY, sectionOverrides());
}

/** The disclosure state a section opens at: a stored override wins over the
 *  caller's default, which is what lets an off section collapse on its own until
 *  the user folds it by hand. A keyless section has no override to consult. */
export function resolveSectionOpen(key: string | undefined, def: boolean): boolean {
  if (key === undefined) return def;
  const overrides = sectionOverrides();
  return key in overrides ? overrides[key] : def;
}

/** Remember a hand-folded disclosure. */
export function recordSectionOpen(key: string, open: boolean): void {
  sectionOverrides()[key] = open;
  persistSectionState();
}

export function clearSectionOverride(key: string): void {
  const s = sectionOverrides();
  if (!(key in s)) return;
  delete s[key];
  persistSectionState();
}

/** Test hook: drop the cached record so the next read re-loads from storage. */
export function resetSectionCache(): void {
  sectionState = null;
}
