import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getSettings, resetSettingsCache, SETTINGS_DEFAULTS, updateSettings } from "./settings";
import { installMemoryStorage } from "./memory-storage.test-util";

// In-memory localStorage (node env): the settings store must survive a missing,
// throwing, or garbage-holding storage — localStorage may hold anything.
const store = installMemoryStorage();

beforeEach(() => resetSettingsCache());
afterEach(() => resetSettingsCache());

describe("getSettings", () => {
  it("returns the defaults when nothing is stored", () => {
    expect(getSettings()).toEqual(SETTINGS_DEFAULTS);
  });

  it("returns the defaults when storage is unavailable", () => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
    expect(getSettings()).toEqual(SETTINGS_DEFAULTS);
  });

  it("degrades a garbage record per field, not wholesale", () => {
    store().setItem(
      "urx-settings",
      JSON.stringify({ deviceScope: "scene", wheelSteps: 3, exportScale: "big", updateCheck: "yes" }),
    );
    const s = getSettings();
    expect(s.deviceScope).toBe("scene"); // the valid field survives
    expect(s.wheelSteps).toBe(SETTINGS_DEFAULTS.wheelSteps); // 3 is not a choice
    expect(s.exportScale).toBe(SETTINGS_DEFAULTS.exportScale);
    expect(s.updateCheck).toBe(SETTINGS_DEFAULTS.updateCheck); // strings are not booleans
  });

  it("survives a non-JSON record", () => {
    store().setItem("urx-settings", "not json");
    expect(getSettings()).toEqual(SETTINGS_DEFAULTS);
  });
});

describe("updateSettings", () => {
  it("persists the patch and validates it", () => {
    updateSettings({ saveScope: "scene", recentMax: 12 });
    resetSettingsCache();
    const s = getSettings();
    expect(s.saveScope).toBe("scene");
    expect(s.recentMax).toBe(12);
  });

  it("rejects an illegal patch value back to the default", () => {
    updateSettings({ wheelSteps: 99 });
    expect(getSettings().wheelSteps).toBe(SETTINGS_DEFAULTS.wheelSteps);
  });
});
