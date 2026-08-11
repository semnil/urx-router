// @vitest-environment jsdom

// The app entry, booted whole against the real index.html markup.
//
// main.ts exports nothing and runs entirely as top-level side effects, so it can
// only be driven by importing it — which means one boot per test file and
// `vi.resetModules()` between the tests that need different seeded storage. The
// four globals below are the ones jsdom does not provide and main.ts calls
// unguarded; nothing else is stubbed, and in particular `window.__TAURI_INTERNALS__`
// is deliberately left undefined so `isTauri()` stays false and no IPC is attempted.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("./core/storage", async (importOriginal) => {
  const real = await importOriginal<typeof import("./core/storage")>();
  return {
    ...real,
    openTextDocument: vi.fn(async () => null),
    saveTextDocument: vi.fn(async () => ({ saved: true, path: "/tmp/plan.json" })),
    readTextByPath: vi.fn(async () => null),
    downloadText: vi.fn(),
    exportSvgToPng: vi.fn(async () => ({ saved: true, path: "/tmp/board.png" })),
    exportSvgToPdf: vi.fn(async () => ({ saved: true, path: "/tmp/board.pdf" })),
  };
});

import { openTextDocument, saveTextDocument } from "./core/storage";

// The app's real markup, so every getElementById in main.ts resolves the element
// it does in the browser rather than one this file invented.
const BODY = readFileSync(resolve(process.cwd(), "index.html"), "utf8")
  .replace(/^[\s\S]*?<body[^>]*>/, "")
  .replace(/<\/body>[\s\S]*$/, "");

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const status = (): string => $("statusbar").textContent ?? "";

/** Install the markup and the globals, then run the module top to bottom. */
async function boot(seed: Record<string, string> = {}): Promise<void> {
  document.body.innerHTML = BODY; // innerHTML does not execute the <script type=module>
  localStorage.clear();
  localStorage.setItem("urx-lang", "en");
  localStorage.setItem("urx-model", "URX44V");
  for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);

  vi.resetModules();
  await import("./main");
  // `void boot()` and `void loadPlanFromUrl()` are both fired without being awaited.
  await vi.waitFor(() => expect(status()).not.toBe(""));
}

beforeEach(() => {
  // Graph's buildScaffold constructs one unconditionally; jsdom has none.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  // main.ts both reads .matches and subscribes to "change" on it.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }));
  // platform.confirmDialog / errorDialog fall back to these off Tauri, and jsdom's
  // own versions only log "not implemented".
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  vi.stubGlobal("alert", vi.fn());
  document.elementFromPoint = (() => null) as typeof document.elementFromPoint;
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  localStorage.clear();
});

describe("boot", () => {
  it("paints the board, the inspector and the status line", async () => {
    await boot();
    expect(status()).toContain("URX44V");
    expect($("graph-host").querySelector("svg")).not.toBeNull();
    expect($("graph-host").querySelectorAll("g.node[data-id]").length).toBeGreaterThan(5);
    expect($("inspector").childElementCount).toBeGreaterThan(0);
  });

  it("offers every model and the remembered one", async () => {
    await boot();
    const picker = $<HTMLSelectElement>("model-picker");
    expect(picker.options.length).toBeGreaterThan(1);
    expect(picker.value).toBe("URX44V");
  });

  it("restores the remembered model", async () => {
    await boot({ "urx-model": "URX22" });
    expect($<HTMLSelectElement>("model-picker").value).toBe("URX22");
    expect(status()).toContain("URX22");
  });

  it("falls back to the default model when the remembered one is not a model", async () => {
    await boot({ "urx-model": "URX99" });
    expect($<HTMLSelectElement>("model-picker").value).toBe("URX44V");
  });

  it("restores the remembered sample rate", async () => {
    await boot({ "urx-rate": "96000" });
    expect($<HTMLSelectElement>("rate-picker").value).toBe("96000");
  });

  // The badge exists to warn that the rate picker will not stick. Before any device
  // has been read the state is unknown, which is its own thing — never "off", which
  // is the state in which the picker IS trusted.
  it("draws the Follow USB badge as unknown until a device is read", async () => {
    await boot();
    const badge = $("follow-usb");
    expect(badge.dataset.state).toBe("unknown");
    expect(badge.getAttribute("aria-pressed")).toBe("mixed");
  });
});

describe("view state", () => {
  it("switches to CONSOLE and back, remembering the choice", async () => {
    await boot();
    $("btn-view-console").click();
    expect($("graph-host").hidden).toBe(true);
    expect($("console-host").hidden).toBe(false);
    expect(localStorage.getItem("urx-view")).toBe("console");

    $("btn-view-graph").click();
    expect($("graph-host").hidden).toBe(false);
    expect(localStorage.getItem("urx-view")).toBe("graph");
  });

  it("restores the remembered view", async () => {
    await boot({ "urx-view": "console" });
    expect($("console-host").hidden).toBe(false);
    expect($("graph-host").hidden).toBe(true);
  });

  it("remembers the label source", async () => {
    await boot();
    const btn = $("btn-labels");
    const before = btn.getAttribute("aria-pressed");
    btn.click();
    expect(btn.getAttribute("aria-pressed")).not.toBe(before);
    expect(localStorage.getItem("urx-labels")).not.toBeNull();
  });

  it("remembers the off-send declutter", async () => {
    await boot();
    const btn = $("btn-hide-off");
    btn.click();
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("urx-hide-off")).not.toBeNull();
  });

  it("restores the remembered declutter", async () => {
    await boot({ "urx-hide-off": "1" });
    expect($("btn-hide-off").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("the ?reset entry", () => {
  // Cleared synchronously before anything below reads localStorage, and the flag is
  // stripped so a later manual reload does not clear again.
  it("clears storage and strips the flag from the URL", async () => {
    history.replaceState(null, "", "/?reset");
    localStorage.setItem("urx-view", "console");
    await boot({ "urx-view": "console" });
    expect(location.search).not.toContain("reset");
    // The seeded view did not survive, so the board is on screen rather than the console.
    expect($("graph-host").hidden).toBe(false);
    history.replaceState(null, "", "/");
  });
});

describe("model and rate pickers", () => {
  it("switches the model and remembers it", async () => {
    await boot();
    const picker = $<HTMLSelectElement>("model-picker");
    picker.value = "URX22";
    picker.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(localStorage.getItem("urx-model")).toBe("URX22"));
    expect(status()).toContain("URX22");
  });

  it("switches the rate and remembers it", async () => {
    await boot();
    const rate = $<HTMLSelectElement>("rate-picker");
    const other = [...rate.options].find((o) => o.value !== rate.value)!;
    rate.value = other.value;
    rate.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(localStorage.getItem("urx-rate")).toBe(other.value));
  });
});

describe("file flow", () => {
  it("does nothing when the open dialog is dismissed", async () => {
    await boot();
    const before = status();
    $("btn-open").click();
    await vi.waitFor(() => expect(openTextDocument).toHaveBeenCalled());
    expect(status()).toBe(before);
  });

  it("loads a plan document the dialog returns", async () => {
    await boot();
    const { serialize } = await import("./core/plan");
    const { defaultPlan } = await import("./models/initial-state");
    vi.mocked(openTextDocument).mockResolvedValueOnce({
      text: serialize(defaultPlan("URX22")),
      path: "/x/loaded.json",
    });
    $("btn-open").click();
    await vi.waitFor(() => expect(status()).toContain("loaded"));
    expect($<HTMLSelectElement>("model-picker").value).toBe("URX22");
  });

  // A decode failure surfaces the copyable report instead of loading, leaving the
  // plan on screen.
  it("reports an unreadable document without replacing the board", async () => {
    await boot();
    const nodes = $("graph-host").querySelectorAll("g.node[data-id]").length;
    vi.mocked(openTextDocument).mockResolvedValueOnce({ text: "{", path: "/x/bad.json" });
    $("btn-open").click();
    await vi.waitFor(() => expect(vi.mocked(openTextDocument)).toHaveBeenCalled());
    expect($("graph-host").querySelectorAll("g.node[data-id]").length).toBe(nodes);
  });

  it("saves through the shell and reports where it landed", async () => {
    await boot();
    $("btn-save").click();
    await vi.waitFor(() => expect(saveTextDocument).toHaveBeenCalled());
    expect(status()).toContain("plan.json");
  });

  it("starts a new plan", async () => {
    await boot();
    $("btn-new").click();
    await vi.waitFor(() => expect($("graph-host").querySelector("svg")).not.toBeNull());
    expect($("graph-host").querySelectorAll("g.node[data-id]").length).toBeGreaterThan(5);
  });
});

describe("menus", () => {
  it("opens a menu, focuses its first item and closes on Escape", async () => {
    await boot();
    const trigger = $("btn-file");
    trigger.click();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect($("file-menu").hidden).toBe(false);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect($("file-menu").hidden).toBe(true);
  });

  it("walks the items with the arrow keys", async () => {
    await boot();
    $("btn-file").click();
    const first = document.activeElement;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).not.toBe(first);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe(first);
  });

  it("closes on a press outside it", async () => {
    await boot();
    $("btn-file").click();
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect($("file-menu").hidden).toBe(true);
  });
});

describe("keyboard", () => {
  it("clears the graph selection on Escape", async () => {
    await boot();
    const wire = $("graph-host").querySelector(".wire-hit")!;
    wire.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, bubbles: true }));
    wire.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect($("inspector").childElementCount).toBeGreaterThan(0);
  });

  // Deletion acts on the graph's selection, so it must not fire from the CONSOLE
  // view — the console renders no deletable kinds.
  it("does not delete from the CONSOLE view", async () => {
    await boot();
    $("btn-view-console").click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    $("btn-view-graph").click();
    expect($("graph-host").querySelectorAll(".wire-hit").length).toBeGreaterThan(0);
  });
});

describe("localization", () => {
  it("boots into the remembered language", async () => {
    await boot({ "urx-lang": "ja" });
    expect(document.documentElement.lang).toBe("ja");
    expect($("btn-file").textContent).not.toBe("");
  });
});
