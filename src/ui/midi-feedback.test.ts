// @vitest-environment jsdom

// The half of `MidiControl` that talks OUTWARD: the feedback passes that keep a
// controller's motor faders and LEDs in step with the plan, the port restore at boot,
// and what learning a binding does. `midi.test.ts` owns the inbound half (relay
// intents, incoming messages, the gate).
//
// Two silences matter here and neither is an error: a send with no output port open,
// and a feedback pass that returned early. Both are the shapes that read as "nothing
// happened" in every log the app keeps, so each has a case rather than an assumption.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tauri: true,
  receiver: undefined as ((payload: string) => void) | undefined,
  inputReceiver: undefined as ((bytes: number[]) => void) | undefined,
  closeInput: vi.fn(),
  closeMidiWindow: vi.fn(async () => {}),
  focusMidiWindow: vi.fn(async () => {}),
  midiCloseOutput: vi.fn(async () => {}),
  midiListInputs: vi.fn(async () => ["Controller In"]),
  midiListOutputs: vi.fn(async () => ["Controller Out"]),
  midiOpenInput: vi.fn(async (_port: string, onMessage: (bytes: number[]) => void) => {
    mocks.inputReceiver = onMessage;
    return mocks.closeInput;
  }),
  midiOpenOutput: vi.fn(async () => {}),
  midiOpenPorts: vi.fn(async (): Promise<[string | null, string | null]> => [null, null]),
  midiSend: vi.fn(async () => {}),
  midiUiAttachMain: vi.fn(async (receiver: (payload: string) => void) => void (mocks.receiver = receiver)),
  midiUiToWindow: vi.fn<(payload: string) => Promise<void>>(async () => {}),
  midiWindowOpen: vi.fn(async () => false),
  openMidiWindow: vi.fn(async () => {}),
}));

vi.mock("../core/platform", () => ({
  closeMidiWindow: mocks.closeMidiWindow,
  focusMidiWindow: mocks.focusMidiWindow,
  isTauri: () => mocks.tauri,
  midiCloseOutput: mocks.midiCloseOutput,
  midiListInputs: mocks.midiListInputs,
  midiListOutputs: mocks.midiListOutputs,
  midiOpenInput: mocks.midiOpenInput,
  midiOpenOutput: mocks.midiOpenOutput,
  midiOpenPorts: mocks.midiOpenPorts,
  midiSend: mocks.midiSend,
  midiUiAttachMain: mocks.midiUiAttachMain,
  midiUiToWindow: mocks.midiUiToWindow,
  midiWindowOpen: mocks.midiWindowOpen,
  openMidiWindow: mocks.openMidiWindow,
}));
vi.mock("./midi-probe", () => ({ midiProbe: null }));

import { ensureFixedConnections } from "../core/plan";
import { getModel } from "../models";
import { defaultPlan } from "../models/initial-state";
import type { MidiUiIntent } from "./midi-protocol";
import { MidiControl, type MidiHooks } from "./midi";
import { t } from "../i18n";

const MAPPING = {
  control: "ch1/level",
  addr: { type: "cc", channel: 0, controller: 7 },
  mode: "absolute",
} as const;

const seedMappings = (): void => localStorage.setItem("urx-midi", JSON.stringify({ models: { URX44V: [MAPPING] } }));

function dispatch(intent: MidiUiIntent): void {
  if (!mocks.receiver) throw new Error("MIDI relay is not attached");
  mocks.receiver(JSON.stringify(intent));
}

function install(): { control: MidiControl; hooks: MidiHooks } {
  const model = getModel("URX44V");
  const plan = defaultPlan("URX44V");
  ensureFixedConnections(model, plan);
  const hooks: MidiHooks = {
    getModel: () => model,
    getPlan: () => plan,
    onApplied: vi.fn(),
    blocked: () => null,
    onLearnChanged: vi.fn(),
    onStatus: vi.fn(),
  };
  return { control: new MidiControl(hooks), hooks };
}

/** Wait for the relay attach the constructor kicks off. */
async function attached(): Promise<void> {
  await vi.waitFor(() => expect(mocks.receiver).toBeDefined());
  await vi.waitFor(() => expect(mocks.midiWindowOpen).toHaveBeenCalled());
  await Promise.resolve();
}

/** Open the output port through the window's own intent, which is the only route. */
async function openOutput(): Promise<void> {
  dispatch({ type: "port", dir: "out", name: "Controller Out" });
  await vi.waitFor(() => expect(mocks.midiOpenOutput).toHaveBeenCalled());
  await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  mocks.tauri = true;
  mocks.receiver = undefined;
  mocks.inputReceiver = undefined;
  localStorage.clear();
  mocks.midiListInputs.mockResolvedValue(["Controller In"]);
  mocks.midiListOutputs.mockResolvedValue(["Controller Out"]);
  mocks.midiOpenPorts.mockResolvedValue([null, null]);
  mocks.midiOpenInput.mockImplementation(async (_port: string, onMessage: (bytes: number[]) => void) => {
    mocks.inputReceiver = onMessage;
    return mocks.closeInput;
  });
  mocks.midiOpenOutput.mockResolvedValue();
  mocks.midiSend.mockResolvedValue();
  mocks.midiUiAttachMain.mockImplementation(async (receiver: (payload: string) => void) => {
    mocks.receiver = receiver;
  });
  mocks.midiUiToWindow.mockResolvedValue();
  mocks.midiWindowOpen.mockResolvedValue(false);
  mocks.openMidiWindow.mockResolvedValue();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("feedback to the controller", () => {
  // Opening the output port is one of the two moments nothing may be assumed about
  // what the controller holds — it may have been replugged or moved to another bank —
  // so the port opening sends every mapped value at once rather than waiting for a
  // change.
  it("sends every mapped value the moment the output port opens", async () => {
    seedMappings();
    install();
    await attached();
    await openOutput();
    expect(mocks.midiSend).toHaveBeenCalled();
  });

  it("stays silent with no output port open", async () => {
    seedMappings();
    const { control } = install();
    await attached();
    control.resyncFeedback();
    control.scheduleFeedback();
    await Promise.resolve();
    expect(mocks.midiSend).not.toHaveBeenCalled();
  });

  // The debounced pass carries only what CHANGED, so a second edit inside the window
  // must not open a second timer.
  it("debounces a plan edit into one pass", async () => {
    seedMappings();
    const { control, hooks } = install();
    await attached();
    await openOutput();
    mocks.midiSend.mockClear();

    vi.useFakeTimers();
    // Move the plan so the pass has something to carry.
    const conn = hooks.getPlan().connections.find((c) => c.from === "ch1:out" && c.to === "bus.stereo:in")!;
    conn.params = { ...conn.params, level: -20 };
    control.scheduleFeedback();
    control.scheduleFeedback();
    control.scheduleFeedback();
    expect(mocks.midiSend).not.toHaveBeenCalled(); // still inside the debounce
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.midiSend).toHaveBeenCalledTimes(1);
  });

  // The resync forgets what the controller was last told, so it re-sends a value the
  // debounced pass would have skipped as unchanged.
  it("re-sends an unchanged value on a resync but not on a debounced pass", async () => {
    seedMappings();
    const { control } = install();
    await attached();
    await openOutput();
    mocks.midiSend.mockClear();

    vi.useFakeTimers();
    control.scheduleFeedback();
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.midiSend).not.toHaveBeenCalled(); // nothing changed

    control.resyncFeedback();
    await Promise.resolve();
    expect(mocks.midiSend).toHaveBeenCalled();
  });

  // A failed send means the controller never got the value, so what the engine thinks
  // it has been told is dropped and another pass is scheduled. A dead port keeps
  // failing harmlessly; a one-off failure self-heals.
  it("forgets and re-sends after a failed send", async () => {
    seedMappings();
    const { control } = install();
    await attached();
    await openOutput();

    vi.useFakeTimers();
    mocks.midiSend.mockClear();
    mocks.midiSend.mockRejectedValueOnce(new Error("port gone"));
    control.resyncFeedback();
    await vi.advanceTimersByTimeAsync(0);
    const afterFailure = mocks.midiSend.mock.calls.length;

    await vi.advanceTimersByTimeAsync(200); // the re-scheduled pass
    expect(mocks.midiSend.mock.calls.length).toBeGreaterThan(afterFailure);
  });
});

describe("the output port", () => {
  it("reports a failure to open and keeps the port unset", async () => {
    const { hooks } = install();
    await attached();
    mocks.midiOpenOutput.mockRejectedValueOnce(new Error("midi-open-failed"));
    dispatch({ type: "port", dir: "out", name: "Controller Out" });
    await vi.waitFor(() => expect(hooks.onStatus).toHaveBeenCalled());
    // Not persisted: a port that could not be opened must not come back at next boot.
    expect(JSON.parse(localStorage.getItem("urx-midi") ?? "{}").output ?? null).toBeNull();
  });

  // A missing port names a state the operator can act on, so it replaces the frame
  // rather than filling it.
  it("names a missing port instead of wrapping the raw error", async () => {
    const { hooks } = install();
    await attached();
    mocks.midiOpenOutput.mockRejectedValueOnce(new Error("midi-port-not-found"));
    dispatch({ type: "port", dir: "out", name: "Ghost" });
    await vi.waitFor(() => expect(hooks.onStatus).toHaveBeenCalledWith(t().error.shell.midiPortNotFound));
  });
});

describe("the port restore at boot", () => {
  // Best-effort: a saved port may be unplugged right now, and a boot that surfaced an
  // error for it would put a dialog in front of an operator who is not using MIDI.
  it("reopens the saved ports", async () => {
    localStorage.setItem("urx-midi", JSON.stringify({ input: "Controller In", output: "Controller Out" }));
    install();
    await vi.waitFor(() => expect(mocks.midiOpenInput).toHaveBeenCalledWith("Controller In", expect.any(Function)));
    await vi.waitFor(() => expect(mocks.midiOpenOutput).toHaveBeenCalledWith("Controller Out"));
  });

  it("survives a saved port that is gone", async () => {
    localStorage.setItem("urx-midi", JSON.stringify({ input: "Unplugged" }));
    mocks.midiOpenInput.mockRejectedValue(new Error("midi-port-not-found"));
    const { control } = install();
    await vi.waitFor(() => expect(mocks.midiOpenInput).toHaveBeenCalled());
    expect(control.learnActive()).toBe(false); // still usable
  });

  it("opens nothing outside the desktop shell", async () => {
    mocks.tauri = false;
    localStorage.setItem("urx-midi", JSON.stringify({ input: "Controller In" }));
    install();
    await Promise.resolve();
    expect(mocks.midiOpenInput).not.toHaveBeenCalled();
    expect(mocks.midiUiAttachMain).not.toHaveBeenCalled();
  });
});

describe("learning a binding", () => {
  const learnTo = async (control: MidiControl, id: string, bytes: number[]): Promise<void> => {
    dispatch({ type: "port", dir: "in", name: "Controller In" });
    await vi.waitFor(() => expect(mocks.inputReceiver).toBeDefined());
    dispatch({ type: "learn", on: true });
    control.arm(id);
    mocks.inputReceiver!(bytes);
  };

  // The engine waits before settling an address — a controller that sends a burst
  // would otherwise bind to the first byte of a sweep rather than to the control.
  it("binds the armed control once the incoming burst settles", async () => {
    const { control, hooks } = install();
    await attached();
    vi.useFakeTimers();
    await learnTo(control, "ch1/level", [0xb0, 21, 64]);

    await vi.advanceTimersByTimeAsync(600); // past the learn flush
    expect(control.isMapped("ch1/level")).toBe(true);
    expect(control.addrOf("ch1/level")).toContain("21");
    expect(hooks.onStatus).toHaveBeenCalled();
    expect(control.armedId()).toBeNull(); // disarmed by the binding
  });

  it("persists the binding under the model it was made on", async () => {
    const { control } = install();
    await attached();
    vi.useFakeTimers();
    await learnTo(control, "ch1/level", [0xb0, 21, 64]);
    await vi.advanceTimersByTimeAsync(600);

    const stored = JSON.parse(localStorage.getItem("urx-midi")!) as { models: Record<string, unknown[]> };
    expect(stored.models.URX44V).toHaveLength(1);
  });

  // One binding per control: learning the same control again replaces rather than
  // stacks, or the control would answer to two addresses with no way to see it.
  it("replaces a control's previous binding", async () => {
    seedMappings();
    const { control } = install();
    await attached();
    vi.useFakeTimers();
    await learnTo(control, "ch1/level", [0xb0, 21, 64]);
    await vi.advanceTimersByTimeAsync(600);

    const stored = JSON.parse(localStorage.getItem("urx-midi")!) as { models: Record<string, unknown[]> };
    expect(stored.models.URX44V).toHaveLength(1);
    expect(control.addrOf("ch1/level")).toContain("21");
  });

  // Turning learn off mid-flight has to cancel the pending settle as well, or a burst
  // that arrived just before would bind a control nobody armed.
  it("cancels a pending settle when learn is switched off", async () => {
    const { control } = install();
    await attached();
    vi.useFakeTimers();
    await learnTo(control, "ch1/level", [0xb0, 21, 64]);
    dispatch({ type: "learn", on: false });

    await vi.advanceTimersByTimeAsync(600);
    expect(control.isMapped("ch1/level")).toBe(false);
    expect(control.armedId()).toBeNull();
  });

  it("does nothing when a burst arrives with nothing armed", async () => {
    const { control } = install();
    await attached();
    vi.useFakeTimers();
    dispatch({ type: "port", dir: "in", name: "Controller In" });
    await vi.waitFor(() => expect(mocks.inputReceiver).toBeDefined());
    dispatch({ type: "learn", on: true });
    mocks.inputReceiver!([0xb0, 21, 64]);
    await vi.advanceTimersByTimeAsync(600);
    expect(control.isMapped("ch1/level")).toBe(false);
  });
});

describe("the gate", () => {
  // The gate closes while a device sweep holds the plan. Releasing it is what lets the
  // engine take the controller's current positions again.
  it("takes a release without an open session", async () => {
    const { control } = install();
    await attached();
    expect(() => control.gateReleased()).not.toThrow();
  });
});

describe("the window", () => {
  it("reports a window that would not open, and keeps believing there is none", async () => {
    const { control, hooks } = install();
    await attached();
    mocks.openMidiWindow.mockRejectedValueOnce(new Error("boom"));
    control.toggleWindow();
    await vi.waitFor(() => expect(hooks.onStatus).toHaveBeenCalled());
    // Still "no window": a failed open must not leave this side pushing state at one.
    control.toggleWindow();
    expect(mocks.openMidiWindow).toHaveBeenCalledTimes(2);
    expect(mocks.closeMidiWindow).not.toHaveBeenCalled();
  });

  // The window can outlive this side — a reload of the main window leaves it up with a
  // fresh receiver and nothing to make it speak again, since "ready" is sent on its
  // boot and not on ours.
  it("pushes state at a window that was already open when this side booted", async () => {
    mocks.midiWindowOpen.mockResolvedValue(true);
    seedMappings();
    install();
    await attached();
    await vi.waitFor(() => expect(mocks.midiUiToWindow).toHaveBeenCalled());
  });
});

describe("the trace flag", () => {
  // A dev diagnostic behind localStorage, which throws where storage is blocked. The
  // flag failing to read means "off", not a boot that fails.
  it("survives a localStorage that throws", () => {
    const real = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      expect(() => install()).not.toThrow();
    } finally {
      Object.defineProperty(window, "localStorage", real);
    }
  });
});
