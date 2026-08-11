// @vitest-environment jsdom

// The app entry's browser-side flows: the toolbar actions that need no device, the
// deep link, the modals, and the undo boundary. `main.boot.test.ts` owns the boot
// itself, the pickers, the file flow and the menus; the desktop half (device session,
// live sync, MIDI) is unreachable here on purpose — `window.__TAURI_INTERNALS__` is
// left undefined so `isTauri()` stays false and no IPC is attempted, which is what
// keeps this file from asserting against a shell that is not there.
//
// One boot per test, with `vi.resetModules()` between them: main.ts exports nothing
// and runs entirely as top-level side effects.

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

import { downloadText, exportSvgToPdf, exportSvgToPng } from "./core/storage";
import { t } from "./i18n";

const BODY = readFileSync(resolve(process.cwd(), "index.html"), "utf8")
  .replace(/^[\s\S]*?<body[^>]*>/, "")
  .replace(/<\/body>[\s\S]*$/, "");

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const status = (): string => $("statusbar").textContent ?? "";
const nodes = (): number => $("graph-host").querySelectorAll("g.node[data-id]").length;

async function boot(seed: Record<string, string> = {}): Promise<void> {
  document.body.innerHTML = BODY;
  localStorage.clear();
  localStorage.setItem("urx-lang", "en");
  localStorage.setItem("urx-model", "URX44V");
  for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);

  vi.resetModules();
  await import("./main");
  // The board rather than the status line: a boot that lands on an error (a malformed
  // `?plan=`, say) never writes the "Loaded …" line, and waiting for it would time out
  // on exactly the case that wants testing.
  await vi.waitFor(() => expect($("graph-host").querySelector("svg")).not.toBeNull());
}

/** Press a chord on the document, the way the app's own key handler receives one. */
const chord = (key: string, init: KeyboardEventInit = {}): void =>
  void document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
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
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  vi.stubGlobal("alert", vi.fn());
  document.elementFromPoint = (() => null) as typeof document.elementFromPoint;
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  // jsdom's Blob has no `stream()` — measured — while `CompressionStream` is there.
  // The `?plan=` codec pipes one into the other, so without this the whole deep-link
  // half of this file would be testing a platform failure rather than the codec, and
  // the share button would report an error for a reason no browser has.
  if (!Blob.prototype.stream) {
    Blob.prototype.stream = function (this: Blob): ReadableStream<Uint8Array<ArrayBuffer>> {
      return new ReadableStream<Uint8Array<ArrayBuffer>>({
        start: async (c) => {
          c.enqueue(new Uint8Array(await this.arrayBuffer()));
          c.close();
        },
      });
    };
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  localStorage.clear();
  history.replaceState(null, "", "/");
});

describe("the share link", () => {
  // The `?plan=` codec compresses through the platform's own CompressionStream. Node
  // has one, so this is the real round trip rather than a stub of it.
  it("puts a decodable plan on the clipboard", async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (s: string) => void written.push(s) },
    });
    await boot();
    $("btn-share").click();
    await vi.waitFor(() => expect(written).toHaveLength(1));

    const param = new URL(written[0]).searchParams.get("plan");
    expect(param).toBeTruthy();
    const { decodePlanParam } = await import("./core/plan");
    await expect(decodePlanParam(param!)).resolves.toBeTruthy();
  });

  // A clipboard the browser refuses (no permission, no secure context) is not an
  // error here: the link goes into the ADDRESS BAR first, precisely so it stays
  // copyable by hand, and the status line says so instead of reporting a failure.
  // Measured — an earlier version of this case asserted a dialog and was wrong about
  // which of the two the app does.
  it("leaves the link in the address bar when the clipboard refuses", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    });
    await boot();
    $("btn-share").click();
    await vi.waitFor(() => expect(location.search).toContain("plan="));
    await vi.waitFor(() => expect(status()).toBe(t().status.shareUrlInBar));
    expect(vi.mocked(alert)).not.toHaveBeenCalled();
  });
});

describe("the deep link", () => {
  it("loads a plan the URL carries and strips nothing else from it", async () => {
    const { encodePlanParam } = await import("./core/plan");
    const { defaultPlan } = await import("./models/initial-state");
    const param = await encodePlanParam(defaultPlan("URX22"), {});
    history.replaceState(null, "", `/?plan=${encodeURIComponent(param)}`);

    await boot();
    await vi.waitFor(() => expect($<HTMLSelectElement>("model-picker").value).toBe("URX22"));
  });

  // A truncated or hand-edited link is the ordinary failure here, and it must leave
  // the board that is already on screen alone.
  it("reports a malformed link without replacing the board", async () => {
    history.replaceState(null, "", "/?plan=not-a-plan");
    await boot();
    await vi.waitFor(() => expect(nodes()).toBeGreaterThan(5));
    expect($<HTMLSelectElement>("model-picker").value).toBe("URX44V");
  });
});

describe("image export", () => {
  it("exports the board as PNG and says where it landed", async () => {
    await boot();
    $("btn-export").click();
    await vi.waitFor(() => expect(exportSvgToPng).toHaveBeenCalled());
    expect(status()).toContain("board.png");
  });

  it("exports the board as PDF", async () => {
    await boot();
    $("btn-export-pdf").click();
    await vi.waitFor(() => expect(exportSvgToPdf).toHaveBeenCalled());
    expect(status()).toContain("board.pdf");
  });

  // The export runs against the live SVG, so a failure has to surface rather than
  // leave the operator with a status line that never changed.
  it("reports an export that failed", async () => {
    await boot();
    vi.mocked(exportSvgToPng).mockRejectedValueOnce(new Error("canvas-unavailable"));
    $("btn-export").click();
    await vi.waitFor(() => expect(vi.mocked(alert)).toHaveBeenCalled());
  });

  it("downloads the plan as JSON", async () => {
    await boot();
    $("btn-download").click();
    await vi.waitFor(() => expect(downloadText).toHaveBeenCalled());
    const [name, text] = vi.mocked(downloadText).mock.calls.at(-1)!;
    expect(String(name)).toBe("URX44V-plan.json");
    // The claim the demo rests on: what this writes is what a desktop save writes, so
    // File > Open on the desktop app loads it as-is.
    const { deserializeDocument } = await import("./core/plan");
    const doc = deserializeDocument(String(text));
    expect(doc.plan.connections.length).toBeGreaterThan(0);
    expect(doc.sceneScoped).toBe(false);
  });
});

describe("the board's own actions", () => {
  it("arranges the nodes without changing how many there are", async () => {
    await boot();
    const before = nodes();
    $("btn-auto").click();
    expect(nodes()).toBe(before);
  });

  // Hiding the unused nodes is a shelf operation: they leave the board and the shelf
  // gains chips for them, so the count has to fall and be restorable.
  it("shelves the unused nodes and hands them back", async () => {
    await boot();
    const before = nodes();
    $("btn-hide-unused").click();
    const hidden = nodes();
    expect(hidden).toBeLessThan(before);
    expect(localStorage.getItem("urx-hidden")).not.toBeNull();

    // The shelf's own chips put them back one at a time.
    const chip = $("graph-host").querySelector<HTMLButtonElement>(".shelf-chips .chip");
    expect(chip).not.toBeNull();
    chip!.click();
    await vi.waitFor(() => expect(nodes()).toBeGreaterThan(hidden));
  });
});

describe("the modals", () => {
  it("opens and closes Preferences", async () => {
    await boot();
    $("btn-prefs").click();
    const scrim = document.querySelector<HTMLElement>(".prefs-scrim, #prefs-modal");
    expect(scrim).not.toBeNull();
    expect(scrim!.hidden).toBe(false);
    chord("Escape");
    await vi.waitFor(() => expect(scrim!.hidden).toBe(true));
  });

  // The notice is a bundled resource fetched at click time, and jsdom serves no
  // files — so what this reaches is the failure arm. Worth a case of its own: the
  // arm is a `.catch` rather than a rejection handler precisely so a notice that
  // fetches but will not parse lands in the same dialog, and neither shape may pass
  // silently with an empty modal on screen.
  it("reports a licence notice it cannot read, rather than opening an empty modal", async () => {
    await boot();
    $("btn-licenses").click();
    await vi.waitFor(() => expect(vi.mocked(alert)).toHaveBeenCalled());
    expect($("licenses-modal").hidden).toBe(true);
  });
});

describe("undo and redo", () => {
  // The boundary: a plan edit is one entry, and the chord walks it. Driven through
  // the CONSOLE, whose fader writes through the same change funnel the graph does.
  it("undoes and redoes a console edit", async () => {
    await boot();
    $("btn-view-console").click();
    const fader = $("console-host").querySelector<HTMLElement>('.con-strip [role="slider"]')!;
    const before = fader.getAttribute("aria-valuenow");

    fader.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    const edited = $("console-host").querySelector('.con-strip [role="slider"]')!.getAttribute("aria-valuenow");

    chord("z", { ctrlKey: true });
    await vi.waitFor(() =>
      expect($("console-host").querySelector('.con-strip [role="slider"]')!.getAttribute("aria-valuenow")).toBe(before),
    );

    chord("z", { ctrlKey: true, shiftKey: true });
    await vi.waitFor(() =>
      expect($("console-host").querySelector('.con-strip [role="slider"]')!.getAttribute("aria-valuenow")).toBe(edited),
    );
  });

  // Nothing to undo is not an error, and it must not clear the board.
  it("does nothing on an empty history", async () => {
    await boot();
    const before = nodes();
    chord("z", { ctrlKey: true });
    chord("z", { ctrlKey: true, shiftKey: true });
    expect(nodes()).toBe(before);
  });
});

describe("what the browser build does not offer", () => {
  // The device half is desktop-only, and the buttons are still in the DOM. Measured:
  // they do NOT all sit inert — the MIDI window opener reaches its platform call and
  // reports the failure on the status line. Which is the right behaviour; what must
  // not happen is a throw out of a click handler, since that leaves the app with no
  // status, no dialog, and a toolbar that looks like it did nothing.
  it("reports rather than throwing when a device action is pressed off the shell", async () => {
    await boot();
    for (const id of ["btn-fetch", "btn-write", "btn-midi", "btn-device-setup"]) {
      const el = document.getElementById(id);
      expect(() => el?.click()).not.toThrow();
    }
    await vi.waitFor(() => expect(status()).not.toBe(""));
  });
});
