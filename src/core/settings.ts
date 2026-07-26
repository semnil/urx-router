// User preferences (the Preferences modal): one localStorage key holding a flat,
// validated record. Loaded lazily so the ?reset / --reset-storage clear in
// main.ts runs before the first read, and re-validated on every load because
// localStorage may hold anything. Every field applies immediately at its point
// of use (no apply/cancel), so consumers read through getSettings() at use time.

import { loadJson, saveJson } from "./storage";

/** Device fetch / write / Live-sync scope. One bidirectional setting: splitting
 *  read from write would let out-of-scope params enter the live snapshot at plan
 *  defaults and be written back over the device on the next converge. */
export type DeviceScope = "all" | "scene";

/** Plan-file (and share-URL) save scope. */
export type SaveScope = "full" | "scene";

export interface AppSettings {
  deviceScope: DeviceScope;
  saveScope: SaveScope;
  /** Check for updates at launch (desktop only). */
  updateCheck: boolean;
  /** Warn before device actions on untested System firmware (desktop only). */
  warnFirmware: boolean;
  /** Show the sample-rate feature-limit warning cards (locks stay regardless). */
  warnRate: boolean;
  /** Show the Ducker-bypass warning cards. */
  warnDucker: boolean;
  /** Grid steps per wheel notch on faders / knobs / sliders. */
  wheelSteps: number;
  /** Fine-tuning modifier: false = hold Shift, true = Shift latches. */
  fineLatch: boolean;
  /** Hold off the computer's idle sleep (system + display) while the app is open
   *  (desktop only). Stored only once the OS took the hold. */
  preventSleep: boolean;
  /** PNG / PDF raster scale, as a multiple of the graph's 1:1 size. */
  exportScale: number;
  /** PNG / PDF background + palette: the active theme or a fixed one. */
  exportTheme: "active" | "dark" | "light";
  /** Recent-plans list length (desktop only). */
  recentMax: number;
}

export const SETTINGS_DEFAULTS: AppSettings = {
  deviceScope: "all",
  saveScope: "full",
  updateCheck: true,
  warnFirmware: true,
  warnRate: true,
  warnDucker: true,
  wheelSteps: 1,
  fineLatch: false,
  preventSleep: false,
  exportScale: 2,
  exportTheme: "active",
  recentMax: 8,
};

export const WHEEL_STEP_CHOICES = [1, 2, 4];
export const EXPORT_SCALE_CHOICES = [1, 2, 3];
export const RECENT_MAX_CHOICES = [4, 8, 12, 16];

const SETTINGS_KEY = "urx-settings";

// Field-by-field validation: a stored value survives only when it is one of the
// legal choices, so a hand-edited or stale record degrades to the default per
// field rather than wholesale.
function sanitize(raw: unknown): AppSettings {
  const r = (raw ?? {}) as Record<string, unknown>;
  const pick = <T>(value: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(value as T) ? (value as T) : fallback;
  const bool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);
  const d = SETTINGS_DEFAULTS;
  return {
    deviceScope: pick(r.deviceScope, ["all", "scene"], d.deviceScope),
    saveScope: pick(r.saveScope, ["full", "scene"], d.saveScope),
    updateCheck: bool(r.updateCheck, d.updateCheck),
    warnFirmware: bool(r.warnFirmware, d.warnFirmware),
    warnRate: bool(r.warnRate, d.warnRate),
    warnDucker: bool(r.warnDucker, d.warnDucker),
    wheelSteps: pick(r.wheelSteps, WHEEL_STEP_CHOICES, d.wheelSteps),
    fineLatch: bool(r.fineLatch, d.fineLatch),
    preventSleep: bool(r.preventSleep, d.preventSleep),
    exportScale: pick(r.exportScale, EXPORT_SCALE_CHOICES, d.exportScale),
    exportTheme: pick(r.exportTheme, ["active", "dark", "light"], d.exportTheme),
    recentMax: pick(r.recentMax, RECENT_MAX_CHOICES, d.recentMax),
  };
}

let current: AppSettings | null = null;

export function getSettings(): AppSettings {
  current ??= sanitize(loadJson<unknown>(SETTINGS_KEY, null));
  return current;
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  current = sanitize({ ...getSettings(), ...patch });
  saveJson(SETTINGS_KEY, current);
  return current;
}

/** Test hook: drop the cached record so the next read re-loads from storage. */
export function resetSettingsCache(): void {
  current = null;
}
