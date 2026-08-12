// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tauri: true,
  receiver: undefined as ((payload: string) => void) | undefined,
  inputReceiver: undefined as ((bytes: number[]) => void) | undefined,
  closeInput: vi.fn(),
  closeMidiWindow: vi.fn(async () => {}),
  focusMidiWindow: vi.fn(async () => {}),
  pinMidiWindow: vi.fn(async () => {}),
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
  pinMidiWindow: mocks.pinMidiWindow,
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
import type { MidiUiIntent, MidiUiState } from "./midi-protocol";
import { MidiControl, type MidiHooks } from "./midi";

const MAPPING = {
  control: "ch1/level",
  addr: { type: "cc", channel: 0, controller: 7 },
  mode: "absolute",
} as const;

function seedMappings(): void {
  localStorage.setItem("urx-midi", JSON.stringify({ models: { URX44V: [MAPPING] } }));
}

function dispatch(intent: MidiUiIntent): void {
  if (!mocks.receiver) throw new Error("MIDI relay is not attached");
  mocks.receiver(JSON.stringify(intent));
}

function lastState(): MidiUiState {
  const payload = mocks.midiUiToWindow.mock.calls.at(-1)?.[0];
  if (typeof payload !== "string") throw new Error("MIDI state was not pushed");
  return JSON.parse(payload) as MidiUiState;
}

async function attached(): Promise<void> {
  await vi.waitFor(() => expect(mocks.receiver).toBeDefined());
  await vi.waitFor(() => expect(mocks.midiWindowOpen).toHaveBeenCalled());
  await Promise.resolve();
}

function install() {
  const model = getModel("URX44V");
  // `let`, so a case can hand the hooks a different document mid-session the way a
  // cancelled Fetch does. Every other case keeps the object this returns.
  let plan = defaultPlan("URX44V");
  ensureFixedConnections(model, plan);
  let blocked: string | null = null;
  const hooks: MidiHooks = {
    getModel: () => model,
    getPlan: () => plan,
    onApplied: vi.fn(),
    blocked: () => blocked,
    onLearnChanged: vi.fn(),
    onStatus: vi.fn(),
  };
  const control = new MidiControl(hooks);
  return {
    control,
    hooks,
    plan,
    model,
    setBlocked: (next: string | null) => void (blocked = next),
    swapPlan: (next: typeof plan) => void (plan = next),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tauri = true;
  mocks.receiver = undefined;
  mocks.inputReceiver = undefined;
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
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

describe("MidiControl", () => {
  it("restores mappings and pushes a fully resolved state when the window is ready", async () => {
    seedMappings();
    const { control } = install();
    await attached();

    expect(control.isMapped("ch1/level")).toBe(true);
    expect(control.addrOf("ch1/level")).toBe("CH 1 CC 7");
    expect(control.addrOf("ch2/level")).toBeNull();
    control.arm("not/a/control");
    expect(control.armedId()).toBeNull();

    dispatch({ type: "ready" });
    await vi.waitFor(() => expect(lastState().inputs).toEqual(["Controller In"]));
    expect(lastState()).toMatchObject({
      inputs: ["Controller In"],
      outputs: ["Controller Out"],
      input: null,
      output: null,
      learnOn: false,
      armed: null,
      theme: "dark",
    });
    expect(lastState().rows).toEqual([
      expect.objectContaining({
        control: "ch1/level",
        addr: "CH 1 CC 7",
        kind: "continuous",
        option: "mode",
        mode: "absolute",
        linked: false,
      }),
    ]);

    document.documentElement.setAttribute("data-theme", "light");
    control.relocalize();
    expect(lastState().theme).toBe("light");
    control.toggleWindow();
    expect(mocks.closeMidiWindow).toHaveBeenCalledOnce();

    dispatch({ type: "closed" });
    control.toggleWindow();
    expect(mocks.openMidiWindow).toHaveBeenCalledOnce();
  });

  it("drives learn, mapping patch and removal intents through one persisted state", async () => {
    seedMappings();
    const { control, hooks } = install();
    await attached();
    dispatch({ type: "ready" });
    dispatch({ type: "learn", on: true });
    expect(control.learnActive()).toBe(true);
    expect(mocks.focusMidiWindow).toHaveBeenCalledOnce();
    // And pinned for as long as the arming lasts — the click that follows is in
    // the main window, which is what used to bury the panel.
    expect(mocks.pinMidiWindow).toHaveBeenCalledWith(true);

    control.arm("ch1/level");
    expect(control.armedId()).toBe("ch1/level");
    expect(lastState().armed).toContain("CH 1");

    dispatch({ type: "mode", control: "ch1/level", mode: "pickup" });
    expect(JSON.parse(localStorage.getItem("urx-midi")!).models.URX44V[0].mode).toBe("pickup");

    dispatch({ type: "remove", control: "ch1/level" });
    expect(control.isMapped("ch1/level")).toBe(false);
    expect(JSON.parse(localStorage.getItem("urx-midi")!).models.URX44V).toEqual([]);

    dispatch({ type: "closed" });
    expect(control.learnActive()).toBe(false);
    expect(control.armedId()).toBeNull();
    expect(hooks.onLearnChanged).toHaveBeenCalled();
  });

  it("opens, reconciles and closes ports while persisting only live selections", async () => {
    const { hooks } = install();
    await attached();
    dispatch({ type: "ready" });
    await vi.waitFor(() => expect(lastState().inputs).toEqual(["Controller In"]));

    dispatch({ type: "port", dir: "in", name: "Controller In" });
    await vi.waitFor(() => expect(mocks.midiOpenInput).toHaveBeenCalledWith("Controller In", expect.any(Function)));
    await vi.waitFor(() => expect(lastState().input).toBe("Controller In"));
    expect(JSON.parse(localStorage.getItem("urx-midi")!).input).toBe("Controller In");

    dispatch({ type: "port", dir: "out", name: "Controller Out" });
    await vi.waitFor(() => expect(lastState().output).toBe("Controller Out"));
    expect(JSON.parse(localStorage.getItem("urx-midi")!).output).toBe("Controller Out");

    dispatch({ type: "port", dir: "in", name: null });
    await vi.waitFor(() => expect(mocks.closeInput).toHaveBeenCalledOnce());
    expect(lastState().input).toBeNull();
    dispatch({ type: "port", dir: "out", name: null });
    await vi.waitFor(() => expect(mocks.midiCloseOutput).toHaveBeenCalledOnce());
    expect(lastState().output).toBeNull();

    mocks.midiOpenInput.mockRejectedValueOnce(new Error("midi-port-not-found"));
    dispatch({ type: "port", dir: "in", name: "Missing" });
    await vi.waitFor(() => expect(hooks.onStatus).toHaveBeenCalled());
    expect(lastState().input).toBeNull();
  });

  it("applies incoming mapped MIDI and reports a gated sweep", async () => {
    seedMappings();
    const { hooks, plan, setBlocked } = install();
    await attached();
    dispatch({ type: "ready" });
    dispatch({ type: "port", dir: "in", name: "Controller In" });
    await vi.waitFor(() => expect(mocks.inputReceiver).toBeDefined());

    mocks.inputReceiver!([0xb0, 7, 127]);
    expect(hooks.onApplied).toHaveBeenCalledOnce();
    expect(
      plan.connections.find((connection) => connection.from === "ch1:out" && connection.to === "bus.stereo:in")?.params
        ?.level,
    ).toBe(10);

    setBlocked("busy");
    mocks.inputReceiver!([0xb0, 7, 0]);
    expect(hooks.onApplied).toHaveBeenCalledOnce();
    expect(hooks.onStatus).toHaveBeenCalledWith("busy");
  });

  // The bound-control memo is the one holder of a plan reference here — every other
  // view resolves through getPlan() per use — and one path replaces the document
  // without going through loadPlan: a cancelled Fetch restores its pre-read clone
  // (main.ts), so onModelChanged never runs for it. If the memo did not notice, the
  // controller would go on writing into a document nothing is showing: the fader on
  // screen would sit still while the unit moved.
  //
  // `e2e/race/t3b-undo.spec.ts` skips its variant of this because driving it needs
  // the learn helpers that live in t4-midi.spec.ts; this is the same subject asked of
  // the memo directly, and it runs on every pull request.
  const levelOf = (p: { connections: Array<{ from: string; to: string; params?: { level?: number } }> }): number =>
    p.connections.find((c) => c.from === "ch1:out" && c.to === "bus.stereo:in")!.params!.level!;

  it("re-points the bound cache when the document is replaced under it", async () => {
    seedMappings();
    const { hooks, plan, model, swapPlan } = install();
    await attached();
    dispatch({ type: "ready" });
    dispatch({ type: "port", dir: "in", name: "Controller In" });
    await vi.waitFor(() => expect(mocks.inputReceiver).toBeDefined());

    mocks.inputReceiver!([0xb0, 7, 127]);
    expect(levelOf(plan)).toBe(10);

    // The shape of a cancelled Fetch: a different Plan object, same model, restored
    // outside every path that would announce it.
    const restored = defaultPlan("URX44V");
    ensureFixedConnections(model, restored);
    const restoredBefore = levelOf(restored);
    swapPlan(restored);

    mocks.inputReceiver!([0xb0, 7, 64]);
    expect(hooks.onApplied).toHaveBeenCalledTimes(2);
    expect(levelOf(restored)).not.toBe(restoredBefore);
    // …and the document that is gone was not written to a second time.
    expect(levelOf(plan)).toBe(10);
  });
});
