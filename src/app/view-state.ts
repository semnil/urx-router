// The UI state that persists per browser profile rather than per plan: the model
// and rate the app reopens on, which view it shows, how it labels the board, and
// whether off sends are decluttered.
//
// Split out of main.ts so each detect/remember pair can be checked against a
// hostile store — a value from an older build, a value from a newer one, and a
// localStorage that throws (private mode, disabled, sandboxed iframe), which every
// reader here has to survive because a throw out of module init takes the app with
// it. core/settings.ts is the same shape and the precedent for the reset hook.

import { MODEL_IDS } from "../models";
import type { ModelId } from "../models/types";
import { SAMPLE_RATES } from "../core/constraints";
import { loadJson, saveJson } from "../core/storage";
import type { LabelSource, ThemeName } from "../ui/graph";
import type { ThemeMode } from "../ui/prefs";

export type ViewName = "graph" | "console";

const THEME_KEY = "urx-theme";
const SEED_KEY = "urx-seed";
const HIDDEN_KEY = "urx-hidden";
const MODEL_KEY = "urx-model";
const RATE_KEY = "urx-rate";
const VIEW_KEY = "urx-view";
const LABELS_KEY = "urx-labels";
const HIDE_OFF_KEY = "urx-hide-off";

/** Every write here is best-effort: storage may be unavailable, in which case the
 *  choice simply does not carry across reloads. */
function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable — the choice just won't persist
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Clear the persisted UI state when the browser dev app is opened with `?reset`
 * (or `#reset`), and strip the flag so a later manual reload does not clear again.
 * Must run before anything else reads storage. The desktop app uses the
 * `--reset-storage` launch flag instead.
 */
export function resetStorageFromUrl(): void {
  try {
    const url = new URL(location.href);
    if (url.searchParams.has("reset") || url.hash === "#reset") {
      localStorage.clear();
      history.replaceState(null, "", url.pathname);
    }
  } catch {
    // storage / history unavailable — nothing to reset
  }
}

export function systemDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Theme mode: auto follows the OS colour scheme. A fresh install defaults to auto;
 *  an explicit light/dark choice (including one saved before auto existed) is kept. */
export function detectThemeMode(): ThemeMode {
  const saved = read(THEME_KEY);
  return saved === "light" || saved === "dark" || saved === "auto" ? saved : "auto";
}

export function rememberThemeMode(mode: ThemeMode): void {
  remember(THEME_KEY, mode);
}

export function resolveTheme(mode: ThemeMode): ThemeName {
  return mode === "auto" ? (systemDark() ? "dark" : "light") : mode;
}

/** E2E pins an empty starting board (just the fixed wires) through this flag, so
 *  routing / hide assertions are not perturbed by the factory-seed sends. */
export function seedEmptyRequested(): boolean {
  return read(SEED_KEY) === "empty";
}

// Shelved nodes persist per model so the canvas / console layout survives a
// restart, independent of any saved plan file. The id set is model-specific, so
// one key holds a per-model map.
type HiddenMap = Partial<Record<ModelId, string[]>>;

export function loadHidden(id: ModelId): string[] {
  const list = loadJson<HiddenMap>(HIDDEN_KEY, {})[id];
  return Array.isArray(list) ? list : [];
}

export function rememberHidden(id: ModelId, hidden: string[]): void {
  const map = loadJson<HiddenMap>(HIDDEN_KEY, {});
  map[id] = hidden;
  saveJson(HIDDEN_KEY, map);
}

/** The last selected model, falling back to the top-of-range one (every feature). */
export function detectModel(): ModelId {
  const saved = read(MODEL_KEY);
  return MODEL_IDS.includes(saved as ModelId) ? (saved as ModelId) : "URX44V";
}

export function rememberModel(id: ModelId): void {
  remember(MODEL_KEY, id);
}

/** The last selected sample rate, falling back to the new plan's own. */
export function detectRate(fallback: number): number {
  const saved = Number(read(RATE_KEY));
  return SAMPLE_RATES.includes(saved) ? saved : fallback;
}

export function rememberRate(rate: number): void {
  remember(RATE_KEY, String(rate));
}

/** The last GRAPH / CONSOLE view, falling back to the graph (the HTML default). */
export function detectView(): ViewName {
  return read(VIEW_KEY) === "console" ? "console" : "graph";
}

export function rememberView(view: ViewName): void {
  remember(VIEW_KEY, view);
}

export function detectLabelSource(): LabelSource {
  return read(LABELS_KEY) === "device" ? "device" : "model";
}

export function rememberLabelSource(source: LabelSource): void {
  remember(LABELS_KEY, source);
}

export function detectHideOffSends(): boolean {
  return read(HIDE_OFF_KEY) === "1";
}

export function rememberHideOffSends(hide: boolean): void {
  remember(HIDE_OFF_KEY, hide ? "1" : "0");
}
