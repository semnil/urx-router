// The recent-plans list under the Preferences length / clear controls: the cap
// follows the preference at write time, trimming re-caps the stored list, and
// trimming to 0 empties it (the clear action).

import { describe, it, expect } from "vitest";
import { loadRecent, rememberRecent, removeRecent, trimRecent, type RecentEntry } from "./storage";
import { installMemoryStorage } from "./memory-storage.test-util";

installMemoryStorage();

const entry = (n: number): RecentEntry => ({ path: `/plans/p${n}.json`, name: `p${n}.json`, modelId: "URX44V" });

describe("rememberRecent with a preference cap", () => {
  it("caps at the given max", () => {
    for (let i = 0; i < 6; i++) rememberRecent(entry(i), 4);
    const list = loadRecent();
    expect(list).toHaveLength(4);
    expect(list[0].path).toBe("/plans/p5.json");
  });

  it("defaults to the historical cap of 8", () => {
    for (let i = 0; i < 10; i++) rememberRecent(entry(i));
    expect(loadRecent()).toHaveLength(8);
  });
});

describe("trimRecent", () => {
  it("re-caps the stored list when the preference shrinks", () => {
    for (let i = 0; i < 8; i++) rememberRecent(entry(i), 8);
    const trimmed = trimRecent(4);
    expect(trimmed).toHaveLength(4);
    expect(loadRecent()).toHaveLength(4);
    expect(trimmed[0].path).toBe("/plans/p7.json");
  });

  it("trimRecent(0) clears the list entirely (the Preferences clear action)", () => {
    rememberRecent(entry(1), 8);
    expect(trimRecent(0)).toEqual([]);
    expect(loadRecent()).toEqual([]);
  });
});

describe("removeRecent", () => {
  it("drops exactly the failed path and keeps the rest", () => {
    rememberRecent(entry(1), 8);
    rememberRecent(entry(2), 8);
    const next = removeRecent("/plans/p1.json");
    expect(next.map((e) => e.path)).toEqual(["/plans/p2.json"]);
    expect(loadRecent().map((e) => e.path)).toEqual(["/plans/p2.json"]);
  });

  it("is a no-op for a path not in the list", () => {
    rememberRecent(entry(1), 8);
    expect(removeRecent("/plans/other.json")).toHaveLength(1);
  });
});
