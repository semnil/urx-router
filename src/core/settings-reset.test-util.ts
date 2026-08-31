// Shared test pin: a file whose cases write user preferences has to start each case from
// the defaults, and the two lines that arrange it — `localStorage.clear()` and
// `resetSettingsCache()` — cannot be seen from inside the hook that runs them. Dropping
// either one leaves a suite green until some later case happens to depend on a default,
// which is a property of the order the cases were written in rather than of the hook.
//
// This declares the one arrangement that does see them: a case leaves a non-default
// behind, and the case after it asserts both halves of the reset undid that. The two are
// adjacent and ordered on purpose — vitest runs a file's cases in declaration order, and
// the ordering IS the pin. The halves are asserted separately because they fail
// separately: the cache reset alone reloads the record from storage and reads the value
// the case before it wrote.
//
// Call it at the top level of the file, ahead of any case that clears storage itself: a
// later clear hides a missing one in the hook from every case after it.

import { expect, it } from "vitest";
import { getSettings, SETTINGS_DEFAULTS, updateSettings } from "./settings";

/** The key the pin writes. Not one any suite calling this reads for its own reasons. */
const KEY = "warnDucker";

export function pinSettingsReset(): void {
  it("leaves a stored, non-default preference behind for the case below", () => {
    expect(SETTINGS_DEFAULTS[KEY]).toBe(true); // or the case below asserts nothing
    updateSettings({ [KEY]: false });
    expect(getSettings()[KEY]).toBe(false);
    expect(localStorage.getItem("urx-settings")).not.toBeNull();
  });

  it("starts from the defaults again — storage cleared and the cache dropped", () => {
    expect(localStorage.getItem("urx-settings")).toBeNull();
    expect(getSettings()[KEY]).toBe(SETTINGS_DEFAULTS[KEY]);
  });
}
