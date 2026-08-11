// @vitest-environment jsdom

// The MIDI window's relay contract, driven without a window: what it asks for on
// boot, what a pushed state does to it, what a malformed payload does NOT do to it,
// and what a teardown reports.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  receiver: undefined as ((payload: string) => void) | undefined,
  attach: vi.fn(),
  toMain: vi.fn<(payload: string) => Promise<void>>(),
}));

vi.mock("../core/platform", () => ({
  midiUiAttachWindow: (onState: (payload: string) => void): Promise<void> => {
    mocks.receiver = onState;
    return mocks.attach(onState);
  },
  midiUiToMain: (payload: string): Promise<void> => mocks.toMain(payload),
}));

import { initialMidiUiState, startMidiWindow } from "./midi-window-app";
import type { MidiUiIntent, MidiUiState } from "./midi-protocol";
import { recordWindowListeners } from "./listener-scope.test-util";
import { getLang, setLang, t } from "../i18n";

const sentIntents = (): MidiUiIntent[] => mocks.toMain.mock.calls.map(([p]) => JSON.parse(p) as MidiUiIntent);

const stateWith = (over: Partial<MidiUiState> = {}): MidiUiState => ({ ...initialMidiUiState(), ...over });

// Everything the starts in one test registered on `window`, released between
// tests. jsdom's window outlives the file, and `mocks.toMain` is shared by every
// window ever started, so without this a stale `pagehide` listener reports
// alongside the live one — measured at eleven `closed` intents for one dispatch.
const windowScopes: Array<() => void> = [];

function start(): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const scope = recordWindowListeners();
  // Queued before the call, not after it. `startMidiWindow` registers the pagehide
  // listener and only THEN paints, so a paint that throws leaves a live listener
  // behind — and a queue entry added after the call is exactly what a throw skips.
  windowScopes.push(scope.release);
  try {
    startMidiWindow(host);
  } finally {
    scope.stop();
  }
  return host;
}

afterEach(() => {
  for (const release of windowScopes.splice(0)) release();
});

beforeEach(() => {
  mocks.receiver = undefined;
  mocks.attach.mockReset().mockResolvedValue(undefined);
  mocks.toMain.mockReset().mockResolvedValue(undefined);
  document.body.replaceChildren();
  setLang("en");
});

describe("startMidiWindow — boot", () => {
  it("paints the empty state and asks the main window for the real one", () => {
    const host = start();
    expect(sentIntents()).toEqual([{ type: "ready" }]);
    expect(host.querySelector(".mw-empty")!.textContent).toBe(t().midi.noMappings);
    expect(host.querySelector(".mw-in")).not.toBeNull();
  });

  it("starts with no ports, no assignments and learn off", () => {
    expect(initialMidiUiState()).toEqual({
      inputs: [],
      outputs: [],
      input: null,
      output: null,
      rows: [],
      learnOn: false,
      armed: null,
      status: "",
      lang: "en",
      theme: "dark",
    });
  });

  // Reassigning the module-level state used to make two windows share one object;
  // a fresh copy per start is what keeps a second window from inheriting leftovers.
  it("hands each start its own state object", () => {
    const first = initialMidiUiState();
    first.rows.push({ control: "x", label: "X", kind: "toggle", mode: "absolute", linked: false });
    expect(initialMidiUiState().rows).toEqual([]);
  });

  it("subscribes to the relay exactly once", () => {
    start();
    expect(mocks.attach).toHaveBeenCalledTimes(1);
  });
});

describe("startMidiWindow — state pushes", () => {
  it("repaints from a pushed state", () => {
    const host = start();
    mocks.receiver!(
      JSON.stringify(
        stateWith({
          inputs: ["A In"],
          input: "A In",
          learnOn: true,
          status: "listening",
          rows: [
            {
              control: "ch1/level@bus.mix1",
              label: "CH 1 · Level",
              addr: "CC 7 ch 1",
              kind: "continuous",
              option: "mode",
              mode: "absolute",
              linked: false,
            },
          ],
        }),
      ),
    );
    expect(host.querySelector(".mw-empty")).toBeNull();
    expect((host.querySelector(".mw-in") as HTMLSelectElement).value).toBe("A In");
    expect(host.querySelector(".mw-dot")!.className).toBe("mw-dot on");
    expect(host.querySelector(".mw-status")!.textContent).toBe("listening");
    expect(host.querySelector("tbody tr")).not.toBeNull();
  });

  // Every push carries the language, which is what makes a switch in the main
  // window reach this one — the window has no language control of its own.
  it("adopts the language the push carries before painting", () => {
    const host = start();
    mocks.receiver!(JSON.stringify(stateWith({ lang: "ja" })));
    expect(getLang()).toBe("ja");
    expect(host.querySelector(".mw-title")!.textContent).toBe(t().midi.title);
  });

  it("adopts the theme the push carries", () => {
    start();
    mocks.receiver!(JSON.stringify(stateWith({ theme: "light" })));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  // The relay carries opaque strings, and a window that reloads mid-flight can be
  // handed a message from the previous session.
  it("ignores a payload that is not the shape this side expects", () => {
    const host = start();
    mocks.receiver!(JSON.stringify(stateWith({ status: "kept" })));
    for (const bad of ["not json", "null", "true", "42", '"a string"']) {
      mocks.receiver!(bad);
    }
    expect(host.querySelector(".mw-status")!.textContent).toBe("kept");
  });

  // `lang` crosses the relay as opaque JSON, so it is a claim rather than a Lang.
  // An unregistered one would leave the catalog lookup undefined and every later
  // paint would throw — the window would blank for good.
  it("keeps the current language when a push names one it does not have", () => {
    const host = start();
    setLang("ja");
    mocks.receiver!(JSON.stringify({ ...stateWith({ status: "shown" }), lang: "de" }));
    expect(getLang()).toBe("ja");
    expect(host.querySelector(".mw-status")!.textContent).toBe("shown");
    expect(host.querySelector(".mw-title")!.textContent).toBe(t().midi.title);
  });

  it("keeps painting later pushes after a malformed one", () => {
    const host = start();
    mocks.receiver!("{");
    mocks.receiver!(JSON.stringify(stateWith({ status: "after" })));
    expect(host.querySelector(".mw-status")!.textContent).toBe("after");
  });
});

describe("startMidiWindow — intents", () => {
  it("relays a gesture from the painted DOM as JSON", () => {
    const host = start();
    (host.querySelector(".mw-learnbtn") as HTMLButtonElement).click();
    expect(sentIntents()).toEqual([{ type: "ready" }, { type: "learn", on: true }]);
  });

  it("relays gestures from the repainted DOM, not a stale closure", () => {
    const host = start();
    mocks.receiver!(JSON.stringify(stateWith({ learnOn: true })));
    (host.querySelector(".mw-learnbtn") as HTMLButtonElement).click();
    expect(sentIntents().at(-1)).toEqual({ type: "learn", on: false });
  });

  // Learn mode stays armed against a control the operator can no longer see, so a
  // teardown the Rust side never sees (a reload, a crashed webview) still reports.
  it("reports itself closed on pagehide", () => {
    start();
    window.dispatchEvent(new Event("pagehide"));
    // Exactly one, not "the last one was closed": every window this file has
    // started shares `mocks.toMain`, so a count is what distinguishes THIS window
    // reporting from a leaked listener reporting for it.
    expect(sentIntents().filter((i) => i.type === "closed")).toEqual([{ type: "closed" }]);
  });

  // The listener is the window's, not the document's: two windows are two reports,
  // and one that was torn down is none.
  it("reports once per window that is still up", () => {
    start();
    start();
    window.dispatchEvent(new Event("pagehide"));
    expect(sentIntents().filter((i) => i.type === "closed")).toHaveLength(2);
  });

  // The far side of the relay is a window that may already be gone; there is
  // nothing this view could do about it, and it must not surface as an unhandled
  // rejection.
  it("swallows a relay failure", async () => {
    mocks.toMain.mockRejectedValue(new Error("window gone"));
    expect(() => start()).not.toThrow();
    await Promise.resolve();
    expect(mocks.toMain).toHaveBeenCalled();
  });
});
