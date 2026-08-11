// @vitest-environment jsdom

// The persisted UI state. Every reader here has to survive a hostile store — a
// value from an older build, one from a newer build, and a localStorage that
// throws — because a throw out of module init takes the whole app with it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectHideOffSends,
  detectLabelSource,
  detectModel,
  detectRate,
  detectThemeMode,
  detectView,
  loadHidden,
  rememberHideOffSends,
  rememberHidden,
  rememberLabelSource,
  rememberModel,
  rememberRate,
  rememberThemeMode,
  rememberView,
  resetStorageFromUrl,
  resolveTheme,
  seedEmptyRequested,
  systemDark,
} from "./view-state";
import { SAMPLE_RATES } from "../core/constraints";

/** A store that throws on every access — private mode, disabled, sandboxed iframe. */
function withBrokenStorage(run: () => void): void {
  const real = Object.getOwnPropertyDescriptor(window, "localStorage");
  const thrower = new Proxy(
    {},
    {
      get() {
        throw new Error("storage unavailable");
      },
      set() {
        throw new Error("storage unavailable");
      },
    },
  );
  Object.defineProperty(window, "localStorage", { configurable: true, get: () => thrower });
  try {
    run();
  } finally {
    if (real) Object.defineProperty(window, "localStorage", real);
  }
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("theme mode", () => {
  it("defaults a fresh install to auto", () => {
    expect(detectThemeMode()).toBe("auto");
  });

  // An explicit choice saved before `auto` existed is still honoured.
  it("keeps an explicit choice", () => {
    for (const mode of ["light", "dark", "auto"] as const) {
      rememberThemeMode(mode);
      expect(detectThemeMode()).toBe(mode);
    }
  });

  it("falls back to auto for a value it does not know", () => {
    localStorage.setItem("urx-theme", "sepia");
    expect(detectThemeMode()).toBe("auto");
  });

  it("resolves auto from the OS and an explicit choice from itself", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    expect(systemDark()).toBe(true);
    expect(resolveTheme("auto")).toBe("dark");
    expect(resolveTheme("light")).toBe("light");

    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    expect(resolveTheme("auto")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });
});

describe("model", () => {
  it("defaults to the top-of-range model", () => {
    expect(detectModel()).toBe("URX44V");
  });

  it("restores a model it knows", () => {
    rememberModel("URX22");
    expect(detectModel()).toBe("URX22");
  });

  it("falls back for a model this build does not have", () => {
    localStorage.setItem("urx-model", "URX99");
    expect(detectModel()).toBe("URX44V");
  });
});

describe("sample rate", () => {
  it("falls back to the plan's own rate with nothing stored", () => {
    expect(detectRate(48000)).toBe(48000);
  });

  it("restores every rate the app offers", () => {
    for (const rate of SAMPLE_RATES) {
      rememberRate(rate);
      expect(detectRate(48000)).toBe(rate);
    }
  });

  it("falls back for a rate the app does not offer", () => {
    const unsupported = 22050;
    expect(SAMPLE_RATES).not.toContain(unsupported);
    localStorage.setItem("urx-rate", String(unsupported));
    expect(detectRate(96000)).toBe(96000);
  });

  it("falls back for a value that is not a number", () => {
    localStorage.setItem("urx-rate", "fast");
    expect(detectRate(48000)).toBe(48000);
  });
});

describe("view, labels and declutter", () => {
  it("defaults to the graph, the model labels and no declutter", () => {
    expect(detectView()).toBe("graph");
    expect(detectLabelSource()).toBe("model");
    expect(detectHideOffSends()).toBe(false);
  });

  it("round-trips each choice", () => {
    rememberView("console");
    expect(detectView()).toBe("console");
    rememberView("graph");
    expect(detectView()).toBe("graph");

    rememberLabelSource("device");
    expect(detectLabelSource()).toBe("device");
    rememberLabelSource("model");
    expect(detectLabelSource()).toBe("model");

    rememberHideOffSends(true);
    expect(detectHideOffSends()).toBe(true);
    rememberHideOffSends(false);
    expect(detectHideOffSends()).toBe(false);
  });

  it("reads anything unrecognized as the default", () => {
    localStorage.setItem("urx-view", "spreadsheet");
    localStorage.setItem("urx-labels", "custom");
    localStorage.setItem("urx-hide-off", "yes");
    expect(detectView()).toBe("graph");
    expect(detectLabelSource()).toBe("model");
    expect(detectHideOffSends()).toBe(false);
  });
});

describe("the empty-seed flag", () => {
  it("is off unless the flag says exactly empty", () => {
    expect(seedEmptyRequested()).toBe(false);
    localStorage.setItem("urx-seed", "");
    expect(seedEmptyRequested()).toBe(false);
    localStorage.setItem("urx-seed", "empty");
    expect(seedEmptyRequested()).toBe(true);
  });
});

describe("shelved nodes", () => {
  // The id set is model-specific, so one key holds a per-model map.
  it("keeps each model's shelf separate", () => {
    rememberHidden("URX44V", ["bus.mix2"]);
    rememberHidden("URX22", ["bus.fx"]);
    expect(loadHidden("URX44V")).toEqual(["bus.mix2"]);
    expect(loadHidden("URX22")).toEqual(["bus.fx"]);
  });

  it("reports an empty shelf for a model with nothing stored", () => {
    expect(loadHidden("URX44")).toEqual([]);
  });

  it("reads a stored value that is not a list as an empty shelf", () => {
    localStorage.setItem("urx-hidden", JSON.stringify({ URX44V: "bus.mix2" }));
    expect(loadHidden("URX44V")).toEqual([]);
  });

  it("replaces a model's shelf rather than merging into it", () => {
    rememberHidden("URX44V", ["a", "b"]);
    rememberHidden("URX44V", ["c"]);
    expect(loadHidden("URX44V")).toEqual(["c"]);
  });
});

// A throw out of module init takes the app with it, so every reader has to answer
// its default instead — and every writer has to swallow.
describe("a storage that throws", () => {
  it("answers every default without throwing", () => {
    withBrokenStorage(() => {
      expect(detectThemeMode()).toBe("auto");
      expect(detectModel()).toBe("URX44V");
      expect(detectRate(48000)).toBe(48000);
      expect(detectView()).toBe("graph");
      expect(detectLabelSource()).toBe("model");
      expect(detectHideOffSends()).toBe(false);
      expect(seedEmptyRequested()).toBe(false);
    });
  });

  it("swallows every write without throwing", () => {
    withBrokenStorage(() => {
      expect(() => {
        rememberThemeMode("dark");
        rememberModel("URX22");
        rememberRate(96000);
        rememberView("console");
        rememberLabelSource("device");
        rememberHideOffSends(true);
      }).not.toThrow();
    });
  });
});

describe("resetStorageFromUrl", () => {
  afterEach(() => history.replaceState(null, "", "/"));

  it("does nothing without the flag", () => {
    history.replaceState(null, "", "/");
    localStorage.setItem("urx-model", "URX22");
    resetStorageFromUrl();
    expect(localStorage.getItem("urx-model")).toBe("URX22");
  });

  // Stripped so a later manual reload does not clear again.
  it("clears the store and strips the query flag", () => {
    history.replaceState(null, "", "/?reset");
    localStorage.setItem("urx-model", "URX22");
    resetStorageFromUrl();
    expect(localStorage.getItem("urx-model")).toBeNull();
    expect(location.search).toBe("");
  });

  it("takes the hash form too", () => {
    history.replaceState(null, "", "/#reset");
    localStorage.setItem("urx-model", "URX22");
    resetStorageFromUrl();
    expect(localStorage.getItem("urx-model")).toBeNull();
    expect(location.hash).toBe("");
  });

  it("does not throw when storage is unavailable", () => {
    history.replaceState(null, "", "/?reset");
    withBrokenStorage(() => expect(() => resetStorageFromUrl()).not.toThrow());
  });
});
