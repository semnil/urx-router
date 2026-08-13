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

import { COMP_EQ_SSMCS, REC_POINT_PRE_COMP, REC_POINT_PRE_EQ } from "./core/control/params";
import { downloadText, exportSvgToPdf, exportSvgToPng, saveTextDocument } from "./core/storage";
import { t } from "./i18n";
import { $, bootApp, installAppGlobals, restoreAppGlobals, statusText } from "./main.test-util";
import { faceplate } from "./ui/graph.test-util";

const nodes = (): number => $("graph-host").querySelectorAll("g.node[data-id]").length;

// The boot fixture is `main.test-util.ts`, shared with the other two entry suites.
// `tauri: false`: the desktop half is `main.device.test.ts`'s, and with no shell
// `isTauri()` stays false, which is what keeps this file from asserting against a
// shell that is not there.
const boot = (seed: Record<string, string> = {}): Promise<unknown> => bootApp({ seed, tauri: false });
const status = statusText;

/** Press a chord on the document, the way the app's own key handler receives one. */
const chord = (key: string, init: KeyboardEventInit = {}): void =>
  void document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));

/** Select a node on the board. The graph selects on `pointerdown` and resolves the node
 *  with `closest(".node")`, so the gesture has to be dispatched — `.click()` reaches no
 *  handler at all. The target comes from the graph suite's own locator rather than a
 *  second copy of the selector; its header carries why the faceplate rect and not the
 *  group is what a press must land on. */
const selectNode = (id: string): void => {
  const face = faceplate($("graph-host"), id)!;
  face.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, bubbles: true }));
  face.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
};

/** The inspector row a label names. Addressed by the `data-param-label` the panel
 *  stamps, and with the label read out of the catalog: an index would move whenever a
 *  lock removed a control above it, and a typed-in label would fail in Japanese. */
const row = (label: string): HTMLElement => {
  const found = $("inspector").querySelector<HTMLElement>(`.param[data-param-label="${label}"]`);
  expect(found, `the inspector shows a "${label}" row`).not.toBeNull();
  return found!;
};

/**
 * Replace the shared `matchMedia` stub with one whose colour-scheme answer can be
 * flipped and announced, and return the flipper. Must be called BEFORE the boot: the
 * app attaches its listener while the module runs.
 *
 * The shared stub cannot do this: it answers a fixed "light" and its addEventListener is a
 * no-op, which leaves auto mode with no way to be told the OS moved. Every query except the
 * colour-scheme one keeps answering false, so nothing else that consults matchMedia changes
 * behaviour because this is installed.
 */
function installFlippableColorScheme(): (dark: boolean) => void {
  let dark = false;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches(): boolean {
      return query.includes("dark") ? dark : false;
    },
    media: query,
    onchange: null,
    addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }));
  return (next: boolean) => {
    dark = next;
    for (const fn of listeners) fn();
  };
}

beforeEach(() => {
  installAppGlobals();
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

afterEach(restoreAppGlobals);

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
  // The model id alone is not evidence that the link carried a plan: it is one field,
  // and a codec that dropped the connections, the node parameters or the shelf would
  // still land the picker on URX22. So the plan encoded here is moved away from the
  // default in four independent places, and each is read back off the surface that
  // shows it.
  it("loads everything the URL carries, not just the model", async () => {
    const { encodePlanParam } = await import("./core/plan");
    const { defaultPlan } = await import("./models/initial-state");
    const plan = defaultPlan("URX22");
    plan.sampleRate = 96000;
    plan.hidden = ["bus.mon2"];
    plan.nodeNames = { ...plan.nodeNames, ch1: "PROBE" };
    const send = plan.connections.find((c) => c.from === "ch1:out" && c.to === "bus.stereo:in")!;
    send.params = { ...send.params, level: -20 };

    const param = await encodePlanParam(plan, {});
    history.replaceState(null, "", `/?plan=${encodeURIComponent(param)}`);
    await boot();
    await vi.waitFor(() => expect($<HTMLSelectElement>("model-picker").value).toBe("URX22"));

    // The rate, off its default.
    expect($<HTMLSelectElement>("rate-picker").value).toBe("96000");
    // The shelf: the hidden node left the board and a chip stands for it.
    expect($("graph-host").querySelector('g.node[data-id="bus.mon2"]')).toBeNull();
    expect([...$("graph-host").querySelectorAll(".shelf-chips .chip")].map((c) => c.textContent)).toHaveLength(1);
    // A per-node value the model does not supply. `.con-fader` by name rather than the
    // first `[role="slider"]`: a strip carries seven of those and the main fader is the
    // LAST — two head knobs and four send columns come first, so the loose selector
    // reads the channel gain and the level never gets checked at all.
    $("btn-view-console").click();
    const strip = [...$("console-host").querySelectorAll<HTMLElement>(".con-strip")][0];
    expect(strip.textContent).toContain("PROBE");
    expect(strip.querySelector(".con-fader")!.getAttribute("aria-valuenow")).toBe("-20");
  });

  // A broken link has two shapes and they surface differently — measured, because they
  // read the same from the outside and a single case would have covered only one.
  //
  // Neither case may assert on the board or the picker as its observable: both exist
  // before the decode is even attempted, so a silently swallowed error passes. Waiting
  // on the report is also what synchronizes with the async decode.
  it("reports a link the codec cannot decode, in the load report", async () => {
    // A `z` link (the compressed form) whose payload is not base64: the decode itself
    // throws, so it never reaches the plan loader.
    history.replaceState(null, "", "/?plan=z%40%40%40");
    await boot();

    await vi.waitFor(() => expect($("load-report").hidden).toBe(false));
    expect($("load-report-body").textContent).toBe(t().error.badPlanUrl);
    // …and only then is "the board is untouched" worth asserting.
    expect(nodes()).toBeGreaterThan(5);
    expect($<HTMLSelectElement>("model-picker").value).toBe("URX44V");
    expect(vi.mocked(alert)).not.toHaveBeenCalled();
  });

  it("reports a link that decodes into something that is not a plan, as a load error", async () => {
    // An uncompressed link whose base64 is valid but whose bytes are not a document:
    // the decode succeeds and the PLAN loader is the one that refuses, which is the
    // error dialog rather than the report modal.
    history.replaceState(null, "", "/?plan=not-a-plan");
    await boot();

    await vi.waitFor(() => expect(vi.mocked(alert)).toHaveBeenCalled());
    expect($("load-report").hidden).toBe(true);
    expect(nodes()).toBeGreaterThan(5);
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
  // The device half is desktop-only and the buttons are still in the DOM. Measured off
  // the shell, each one reports — through one of TWO channels, and which one is the
  // fact worth pinning: three raise the error dialog, while the MIDI window opener
  // frames its failure onto the status line instead. What must not happen is a throw
  // out of a click handler, which leaves the app with no dialog, no status and a
  // toolbar that looks like it did nothing.
  //
  // Two things make a loose version of this case pass for nothing. `status()` is
  // already the boot line, so "the status is non-empty" is true before any click; and
  // `btn-write` ships DISABLED in index.html — `syncDeviceActionUi` enables it at boot
  // (measured), but an optional-chained click on a button that had stayed disabled
  // would assert nothing at all. Hence: the element is required to exist and to be
  // enabled, and each channel is counted per button.
  const CHANNELS = [
    { id: "btn-fetch", channel: "dialog" },
    { id: "btn-write", channel: "dialog" },
    { id: "btn-midi", channel: "status" },
    { id: "btn-device-setup", channel: "dialog" },
  ] as const;

  for (const { id, channel } of CHANNELS) {
    it(`${id} reports through the ${channel} rather than throwing`, async () => {
      await boot();
      const el = document.getElementById(id) as HTMLButtonElement | null;
      expect(el, `#${id} is in the markup`).not.toBeNull();
      expect(el!.disabled, `#${id} is enabled with no device link held`).toBe(false);

      const dialogsBefore = vi.mocked(alert).mock.calls.length;
      const statusBefore = status();
      expect(() => el!.click()).not.toThrow();

      if (channel === "dialog") {
        await vi.waitFor(() => expect(vi.mocked(alert).mock.calls.length).toBe(dialogsBefore + 1));
      } else {
        // The frame is read out of the catalog rather than typed in, so a Japanese run
        // asserts the same thing. An empty reason yields the frame directly, so no
        // sentinel is needed — an earlier version used a NUL for that, which turned
        // this file into something `file` calls data and `rg` refuses to search.
        const frame = t().midi.windowError("");
        // `startsWith("")` is true of everything, so an entry that stopped framing its
        // reason would make the next line pass for nothing.
        expect(frame).not.toBe("");
        await vi.waitFor(() => expect(status()).not.toBe(statusBefore));
        expect(status().startsWith(frame)).toBe(true);
        expect(status().length).toBeGreaterThan(frame.length); // the reason is named
        expect(vi.mocked(alert).mock.calls.length).toBe(dialogsBefore);
      }
    });
  }
});

describe("saving a plan", () => {
  // A dismissed save dialog is a routine outcome, not a failure — the status line, and
  // nothing else. The distinction that matters is against the case below: both leave the
  // plan unsaved, and only one of them is worth a modal.
  it("reports a dismissed save dialog on the status line", async () => {
    await boot();
    vi.mocked(saveTextDocument).mockResolvedValueOnce({ saved: false });
    $("btn-save").click();
    await vi.waitFor(() => expect(status()).toBe(t().status.canceled));
    expect(vi.mocked(alert)).not.toHaveBeenCalled();
  });

  // A write that FAILED must surface as a modal and keep the plan dirty: a silent
  // rejection would read as a successful save, which is the one misreport that loses work.
  it("raises a modal for a save that failed, and leaves the plan unsaved", async () => {
    await boot();
    // Edited first, because `confirmDiscard` returns early on a clean plan: without this
    // the closing assertion would be absent whether or not the failed save cleared the flag.
    selectNode("ch1");
    const field = row(t().inspector.name).querySelector<HTMLInputElement>('input[type="text"]')!;
    field.value = "PROBE";
    field.dispatchEvent(new Event("input", { bubbles: true }));

    vi.mocked(saveTextDocument).mockRejectedValueOnce(new Error("disk-full"));
    $("btn-save").click();
    await vi.waitFor(() => expect(vi.mocked(alert)).toHaveBeenCalled());
    // The modal carries the CAUSE, not just the fact. "Reached a dialog but lost why" is
    // its own failure, and a generic frame reads to the operator as a save that failed for
    // no stated reason.
    expect(String(vi.mocked(alert).mock.calls.at(-1)![0])).toBe(t().status.saveError("disk-full"));
    // showError clears the status line first, so a stale progress message cannot linger
    // behind the dialog and read as the outcome.
    expect(status()).toBe("");

    // The half no dialog can show. `dirty = false` runs on the success path only, so File >
    // New still has to ask before discarding; a failed save that cleared the flag would drop
    // the work with no prompt, which is the loss this case is named for.
    vi.mocked(confirm).mockClear();
    $("btn-new").click();
    expect(vi.mocked(confirm)).toHaveBeenCalled();
  });

  // A save that landed somewhere unnamed: the browser download path returns no path, and
  // there is nothing to put on the recent list. The two save messages are separate keys
  // precisely because one of them can name the file and the other cannot.
  it("reports a save that reports no path", async () => {
    await boot();
    vi.mocked(saveTextDocument).mockResolvedValueOnce({ saved: true });
    $("btn-save").click();
    await vi.waitFor(() => expect(status()).toBe(t().status.planSaved));
  });
});

describe("what the share link does when the codec will not run", () => {
  // A webview without the deflate-raw codec is a browser limitation rather than a broken
  // plan, and the codec says so with a typed error the app translates as such. Anything
  // else is framed as a share failure. Both arms are here because they surface through the
  // same modal and only the TEXT tells them apart — the whole point of the typed error.
  it("names the browser floor when the compressor cannot be constructed", async () => {
    vi.stubGlobal(
      "CompressionStream",
      class {
        constructor() {
          throw new Error("deflate-raw unsupported");
        }
      },
    );
    await boot();
    $("btn-share").click();
    await vi.waitFor(() => expect(vi.mocked(alert)).toHaveBeenCalledWith(t().error.planUrlUnsupported));
    expect(location.search).not.toContain("plan="); // nothing was put in the bar either
  });

  it("frames any other encoding failure as a share failure", async () => {
    await boot();
    // The codec constructs, then the pipe it feeds fails. `Blob.stream` is what the
    // encoder pipes from (see plan.ts pipeBytes) and jsdom does not ship it — the suite's
    // own beforeEach adds it — so removing it again is the platform failing rather than a
    // mock of one.
    const stream = Blob.prototype.stream;
    delete (Blob.prototype as { stream?: unknown }).stream;
    try {
      $("btn-share").click();
      await vi.waitFor(() => expect(vi.mocked(alert)).toHaveBeenCalled());
      const [message] = vi.mocked(alert).mock.calls.at(-1)!;
      expect(String(message)).not.toBe(t().error.planUrlUnsupported);
      expect(String(message).startsWith(t().status.shareUrlError(""))).toBe(true);
    } finally {
      Blob.prototype.stream = stream;
    }
  });
});

describe("the theme", () => {
  /** Pick a theme mode through the Preferences row that owns it. */
  const pickTheme = (mode: string): void => {
    $("btn-prefs").click();
    const sel = $<HTMLSelectElement>("prefs-theme");
    sel.value = mode;
    sel.dispatchEvent(new Event("change"));
  };

  it("applies and announces an explicit choice", async () => {
    await boot();
    pickTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(status()).toBe(t().status.themeDark);
    expect(localStorage.getItem("urx-theme")).toBe("dark");

    pickTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(status()).toBe(t().status.themeLight);
  });

  // Auto says "follow the OS", so its message names the mode rather than the resolved
  // theme — the resolved one can change afterwards with no press at all, which is the
  // case below.
  it("announces auto as auto rather than as the theme it resolved to", async () => {
    await boot();
    pickTheme("dark");
    pickTheme("auto");
    expect(status()).toBe(t().status.themeAuto);
    expect(document.documentElement.dataset.theme).toBe("light"); // the stub's OS is light
  });

  // The OS scheme moving under an open app has to repaint the surfaces CSS variables
  // cannot repaint on their own (the SVG board, a tuning screen's canvas). Unreachable
  // through the shared globals — their matchMedia takes a listener and never calls it —
  // so this case installs one that can be told the OS moved.
  it("follows the OS scheme while in auto, and stops following once a choice is made", async () => {
    const setOsDark = installFlippableColorScheme();
    await boot();
    expect(document.documentElement.dataset.theme).toBe("light");

    setOsDark(true);
    expect(document.documentElement.dataset.theme).toBe("dark");

    // An explicit choice takes over: the OS moving back must not undo it.
    pickTheme("dark");
    setOsDark(false);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

describe("switching language at runtime", () => {
  // The language row lives inside Preferences, so the switch happens with that modal open
  // and it has to be rebuilt in the new language — along with the toolbar labels, the
  // inspector and the board's chrome.
  //
  // The frames are read from the app's OWN i18n module rather than from this file's import
  // of it. `bootApp` resets the module registry, so the two are different instances: the
  // one this file bound at its top is still on English after the app has switched, and
  // asserting against it compares a Japanese status line with an English frame. Imported
  // after the boot, the registry hands back the instance `main.ts` is using.
  it("relabels the app and says which language it is now in", async () => {
    await boot();
    const { t: appT, LANG_NAMES } = await import("./i18n");
    const modelLabel = $("lbl-model").textContent;
    $("btn-prefs").click();
    const sel = $<HTMLSelectElement>("prefs-lang");
    sel.value = "ja";
    sel.dispatchEvent(new Event("change"));

    await vi.waitFor(() => expect(document.documentElement.lang).toBe("ja"));
    expect($("lbl-model").textContent).not.toBe(modelLabel);
    expect(status()).toBe(appT().status.language(LANG_NAMES.ja));
    // The modal was rebuilt rather than left showing the language that just left, so its
    // own row label is the Japanese one and the select is still on screen.
    expect($("prefs-lang").isConnected).toBe(true);
    expect($("prefs-modal").textContent).toContain(appT().prefs.language);
  });
});

// The edit funnel every inspector control writes through: which repaint an edit earns,
// and the device behaviours the app mirrors offline so the plan never holds a value the
// unit would have reset.
describe("editing a node through the inspector", () => {
  const nodeText = (id: string): string => $("graph-host").querySelector(`g.node[data-id="${id}"]`)?.textContent ?? "";

  // Renaming mutates in place and repaints only the node's label, so the field keeps
  // focus while typing — which is the reason it is not a re-render, and the half a
  // board-only assertion would miss.
  it("renames a node without rebuilding the panel, and clears the override on empty", async () => {
    // Booted on the DEVICE label source, which is what draws the plan's own names on the
    // board. The default is the model's fixed labels, and against those a rename repaints
    // a label that cannot show it — measured: the node kept reading "CH 1" while the plan
    // held the new name, so the case passed for nothing on the clear half and failed on
    // the set half for a reason that was not the funnel.
    await boot({ "urx-labels": "device" });
    selectNode("ch1");
    const field = row(t().inspector.name).querySelector<HTMLInputElement>('input[type="text"]')!;
    const fallback = field.placeholder; // the model's own label, shown as the placeholder
    expect(fallback).not.toBe("");

    field.focus();
    field.value = "PROBE";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    expect(nodeText("ch1")).toContain("PROBE");
    expect(document.activeElement).toBe(field); // the panel was not rebuilt under the cursor

    // Whitespace is empty: the override is CLEARED rather than the node being named "   ".
    //
    // Read off the saved document, because the board cannot tell the two apart: the graph
    // trims the name it draws (`deviceName` is `nodeNames?.[id]?.trim() || undefined`), so
    // a guard regressing from `name.trim()` to `name` would store "   " and repaint the
    // model's label exactly as clearing does — byte for byte. Every DOM assertion here,
    // including the fallback coming back, passes under that regression. What it changes is
    // what leaves the app: the plan file, the `?plan=` link and the device write would all
    // carry a channel named "   ".
    field.value = "   ";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    expect(nodeText("ch1")).not.toContain("PROBE");
    expect(nodeText("ch1")).toContain(fallback);

    // Waited on THIS call, by count. The module mock outlives `vi.resetModules()` (mocked
    // module ids are exempt from it) and three earlier cases in this file press Save, so
    // `toHaveBeenCalled()` is already true on entry — `waitFor` would return without
    // waiting and `.at(-1)` would read whichever document ran last. That is a clean plan
    // with no `nodeNames.ch1`, which is exactly what this asserts.
    const saves = vi.mocked(saveTextDocument).mock.calls.length;
    $("btn-save").click();
    await vi.waitFor(() => expect(vi.mocked(saveTextDocument).mock.calls.length).toBe(saves + 1));
    const saved = JSON.parse(vi.mocked(saveTextDocument).mock.calls.at(-1)![1]) as {
      nodeNames?: Record<string, string>;
    };
    expect(saved.nodeNames?.ch1).toBeUndefined();
  });

  // Recolor DOES re-render — the active swatch ring has to move — so every read below goes
  // through the rebuilt row rather than through the elements captured before the click.
  //
  // Which swatch starts selected is not assumed: the factory seed already colours the
  // input channels, so a case written from "nothing is picked yet" was asserting about a
  // plan this app does not start with.
  it("recolors a node and clears the override again", async () => {
    await boot();
    selectNode("ch1");
    const swatches = (): HTMLButtonElement[] => [
      ...row(t().inspector.color).querySelectorAll<HTMLButtonElement>("button.swatch"),
    ];
    const none = (): HTMLButtonElement => swatches().find((s) => s.classList.contains("swatch-none"))!;
    const pickedAt = (): number => swatches().findIndex((s) => s.classList.contains("sel"));
    const before = pickedAt();
    expect(before).toBeGreaterThan(-1); // some ring is on, whichever it is
    expect(swatches().filter((s) => s.classList.contains("sel"))).toHaveLength(1); // and only one

    const other = swatches().findIndex((s, i) => i !== before && !s.classList.contains("swatch-none"));
    swatches()[other].click();
    await vi.waitFor(() => expect(pickedAt()).toBe(other));

    // null clears the override, which is a different write from picking a colour and has
    // to leave the node with no colour rather than with the first one on the strip.
    none().click();
    await vi.waitFor(() => expect(none().classList.contains("sel")).toBe(true));
    expect(pickedAt()).toBe(swatches().indexOf(none()));
  });

  // Why the app mirrors the unit's own reset when the type changes is `resetCompEqBank`'s
  // rule, stated where it is implemented; this pins what that rule looks like from outside.
  //
  // The Rec Point is what makes the mirror observable from outside: SSMCS has no discrete
  // EQ stage, so the device drops PRE EQ from the list and moves a selected PRE EQ tap to
  // PRE COMP. Every read re-queries — the type change re-renders the panel, and the
  // elements captured before it belong to a panel that is gone.
  it("moves a PRE EQ rec point to PRE COMP when the channel enters SSMCS", async () => {
    await boot();
    selectNode("ch1");
    const recPoint = (): HTMLSelectElement => row(t().inspector.recPoint).querySelector<HTMLSelectElement>("select")!;
    recPoint().value = String(REC_POINT_PRE_EQ);
    recPoint().dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(recPoint().value).toBe(String(REC_POINT_PRE_EQ)));

    const type = row(t().inspector.compEqType).querySelector<HTMLSelectElement>("select")!;
    type.value = String(COMP_EQ_SSMCS);
    type.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(recPoint().value).toBe(String(REC_POINT_PRE_COMP)));
    // …and the stage that no longer exists is off the list, so it cannot be chosen again.
    expect([...recPoint().options].map((o) => o.value)).not.toContain(String(REC_POINT_PRE_EQ));
  });
});

describe("menu keyboard navigation", () => {
  // The same selector the entry's own key handler applies, so this addresses the list the
  // app navigates rather than a wider one of its own. The File menu already carries a
  // hidden entry — the experimental settings import — which sits between two visible ones,
  // so today the two lists happen to share a first and a last item; an entry added at
  // either end would separate them, and only this file would still be asserting on the
  // wrong one.
  const items = (): HTMLButtonElement[] => [
    ...$("file-menu").querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled]):not([hidden])'),
  ];

  // What this does NOT establish: that End lands somewhere the operator can see. jsdom
  // focuses a non-rendered button happily where a real engine refuses, so a build-time
  // hide this selector does not filter would pass here and strand focus in the app — which
  // is what the File menu's last entry, the desktop-only Licenses, did while
  // `data-control-hide` set `style.display` rather than the `hidden` attribute. The hides
  // are on the attribute now (`main.ts`), and the half only an engine can answer is pinned
  // in `e2e/licenses.spec.ts`.
  it("jumps to the first and last item with Home and End", async () => {
    await boot();
    $("btn-file").click();
    const list = items();
    expect(list.length).toBeGreaterThan(1);

    chord("End");
    expect(document.activeElement).toBe(list[list.length - 1]);
    chord("Home");
    expect(document.activeElement).toBe(list[0]);
  });

  // The trigger opens from the keyboard as well as from a press, and each of the three
  // keys is its own arm — a version of this that only pressed Enter would leave the other
  // two able to scroll the page instead.
  for (const key of ["ArrowDown", "Enter", " "]) {
    it(`opens the menu on ${key === " " ? "Space" : key} and focuses its first item`, async () => {
      await boot();
      const trigger = $("btn-file");
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      trigger.dispatchEvent(event);
      expect($("file-menu").hidden).toBe(false);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(items()[0]);
      // The key must not also reach the page's own default action (Space scrolls).
      expect(event.defaultPrevented).toBe(true);
    });
  }
});
