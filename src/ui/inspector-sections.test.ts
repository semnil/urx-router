// @vitest-environment jsdom

// The inspector's fold store. Keyed by section kind rather than per node, so a fold
// preference is consistent across nodes and survives both re-renders and reloads —
// and cached in the module, which is why the reset hook exists at all.

import { beforeEach, describe, expect, it } from "vitest";
import { clearSectionOverride, recordSectionOpen, resetSectionCache, resolveSectionOpen } from "./inspector-sections";

const STORE = "urx-inspector-sections";

beforeEach(() => {
  localStorage.clear();
  resetSectionCache();
});

describe("resolveSectionOpen", () => {
  it("takes the caller's default when nothing is stored", () => {
    expect(resolveSectionOpen("gate", true)).toBe(true);
    expect(resolveSectionOpen("gate", false)).toBe(false);
  });

  // A section with an ON-state default collapses on its own until the user folds it
  // by hand; from then on the stored override wins over that default.
  it("lets a stored override beat the default in both directions", () => {
    recordSectionOpen("gate", false);
    expect(resolveSectionOpen("gate", true)).toBe(false);
    recordSectionOpen("comp", true);
    expect(resolveSectionOpen("comp", false)).toBe(true);
  });

  it("has no override to consult for a keyless section", () => {
    recordSectionOpen("gate", false);
    expect(resolveSectionOpen(undefined, true)).toBe(true);
    expect(resolveSectionOpen(undefined, false)).toBe(false);
  });
});

describe("clearSectionOverride", () => {
  // Toggling the value drops the manual fold so the section reverts to following
  // the new on-state.
  it("puts a section back on its default", () => {
    recordSectionOpen("gate", false);
    clearSectionOverride("gate");
    expect(resolveSectionOpen("gate", true)).toBe(true);
  });

  it("does not write storage for a key that has no override", () => {
    clearSectionOverride("never-folded");
    expect(localStorage.getItem(STORE)).toBeNull();
  });

  it("leaves the other sections' overrides alone", () => {
    recordSectionOpen("gate", false);
    recordSectionOpen("comp", false);
    clearSectionOverride("gate");
    expect(resolveSectionOpen("comp", true)).toBe(false);
  });
});

describe("persistence", () => {
  it("survives a reload", () => {
    recordSectionOpen("eq", false);
    expect(JSON.parse(localStorage.getItem(STORE)!)).toEqual({ eq: false });

    resetSectionCache(); // a fresh page load
    expect(resolveSectionOpen("eq", true)).toBe(false);
  });

  // The cache is loaded once and re-persisted on every write, so clearing storage
  // WITHOUT resetting it puts the stale record straight back — which is the reason
  // the hook is exported rather than kept private.
  it("re-persists the stale record when storage is cleared without the reset", () => {
    recordSectionOpen("eq", false);
    localStorage.clear();
    recordSectionOpen("gate", false);
    expect(JSON.parse(localStorage.getItem(STORE)!)).toEqual({ eq: false, gate: false });

    localStorage.clear();
    resetSectionCache();
    recordSectionOpen("gate", false);
    expect(JSON.parse(localStorage.getItem(STORE)!)).toEqual({ gate: false });
  });

  it("ignores a stored value that is not a record", () => {
    localStorage.setItem(STORE, '"folded"');
    resetSectionCache();
    expect(resolveSectionOpen("gate", true)).toBe(true);
  });

  it("ignores unparseable storage", () => {
    localStorage.setItem(STORE, "{");
    resetSectionCache();
    expect(resolveSectionOpen("gate", true)).toBe(true);
  });
});
