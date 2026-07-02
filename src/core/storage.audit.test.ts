// QA audit (core/storage.ts): the localStorage-backed helpers and the pure path
// utility. These run in the node env with an in-memory localStorage stub (the
// module only touches storage inside functions, never at import), pinning the
// defensive contract — every storage write swallows disabled/quota errors,
// rememberRecent included (it now routes through saveJson). Comments tagged "AUDIT"
// flag a divergence from the ideal contract (see the QA report).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { baseName, loadJson, saveJson, loadRecent, rememberRecent, type RecentEntry } from "./storage";

// Minimal spec-shaped localStorage over a Map. `throwOnWrite` simulates a browser
// in private mode / at quota where setItem raises (the real failure mode the
// guarded helpers are meant to absorb).
class MemoryStorage {
  private map = new Map<string, string>();
  throwOnWrite = false;
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    if (this.throwOnWrite) throw new DOMException("quota", "QuotaExceededError");
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

let store: MemoryStorage;
const g = globalThis as { localStorage?: Storage };

beforeEach(() => {
  store = new MemoryStorage();
  g.localStorage = store as unknown as Storage;
});

afterEach(() => {
  delete g.localStorage;
});

describe("baseName (path tail, POSIX + Windows separators)", () => {
  it("takes the final segment regardless of separator style", () => {
    expect(baseName("/Users/x/plans/set.urxplan")).toBe("set.urxplan");
    expect(baseName("C:\\Users\\x\\plans\\set.urxplan")).toBe("set.urxplan");
    expect(baseName("mixed/path\\file.json")).toBe("file.json");
  });

  it("returns the whole string when there is no separator", () => {
    expect(baseName("set.urxplan")).toBe("set.urxplan");
  });

  it("edge inputs: empty string and a bare trailing separator", () => {
    // AUDIT: a path ending in a separator has an empty final segment, so the
    // `|| path` fallback returns the full input rather than the parent segment.
    expect(baseName("")).toBe("");
    expect(baseName("a/b/")).toBe("a/b/");
  });
});

describe("loadJson / saveJson round-trip and fallbacks", () => {
  it("round-trips a value through storage", () => {
    saveJson("k", { a: 1, b: [2, 3] });
    expect(loadJson("k", null)).toEqual({ a: 1, b: [2, 3] });
  });

  it("returns the fallback on a missing key", () => {
    expect(loadJson("absent", { def: true })).toEqual({ def: true });
  });

  it("returns the fallback on a corrupt (non-JSON) stored value", () => {
    store.setItem("k", "{ not json");
    expect(loadJson("k", 42)).toBe(42);
  });

  it("saveJson swallows a throwing storage (disabled / quota) instead of surfacing it", () => {
    store.throwOnWrite = true;
    expect(() => saveJson("k", { a: 1 })).not.toThrow();
  });
});

describe("loadRecent entry validation", () => {
  it("drops malformed entries, keeping only well-typed ones", () => {
    const good: RecentEntry = { path: "/p/a.urxplan", name: "a", modelId: "URX44" };
    store.setItem(
      "urx-recent",
      JSON.stringify([
        good,
        null,
        { path: 1, name: "b", modelId: "URX44" }, // path not a string
        { path: "/p/c", name: "c" }, // missing modelId
        "nope",
      ]),
    );
    expect(loadRecent()).toEqual([good]);
  });

  it("returns [] when the stored value is not an array or is corrupt", () => {
    store.setItem("urx-recent", JSON.stringify({ not: "an array" }));
    expect(loadRecent()).toEqual([]);
    store.setItem("urx-recent", "{ broken");
    expect(loadRecent()).toEqual([]);
  });
});

describe("rememberRecent de-dup, order and cap", () => {
  const entry = (n: number): RecentEntry => ({ path: `/p/${n}.urxplan`, name: `p${n}`, modelId: "URX44" });

  it("prepends the newest and de-duplicates by path", () => {
    rememberRecent(entry(1));
    rememberRecent(entry(2));
    const list = rememberRecent(entry(1)); // re-open #1 -> moves to front, no dup
    expect(list.map((e) => e.path)).toEqual(["/p/1.urxplan", "/p/2.urxplan"]);
  });

  it("caps the list at RECENT_MAX (8) most-recent entries", () => {
    let list: RecentEntry[] = [];
    for (let i = 1; i <= 12; i++) list = rememberRecent(entry(i));
    expect(list).toHaveLength(8);
    // Newest first, oldest four (1..4) evicted.
    expect(list[0].path).toBe("/p/12.urxplan");
    expect(list.some((e) => e.path === "/p/4.urxplan")).toBe(false);
  });

  it("swallows a failing storage.setItem like every other write helper", () => {
    // rememberRecent now routes its write through saveJson, so a disabled-storage /
    // quota failure is absorbed instead of surfacing as an unhandled throw (matching
    // saveJson / loadJson / loadRecent). It still returns the computed in-memory
    // list; only the persistence is skipped.
    store.throwOnWrite = true;
    let list: RecentEntry[] = [];
    expect(() => {
      list = rememberRecent(entry(1));
    }).not.toThrow();
    expect(list.map((e) => e.path)).toEqual(["/p/1.urxplan"]);
  });
});
