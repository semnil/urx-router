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
  midiCloseInput: vi.fn(() => {}),
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
  midiCloseInput: mocks.midiCloseInput,
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
// The production shape of the module: both halves fold away together, so a mock that
// returned only one would let this suite exercise a combination no build produces.
vi.mock("./midi-probe", () => ({ midiProbe: null, startMidiTrace: null }));

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
  // view resolves through getPlan() per use. If it did not notice a replacement, the
  // controller would go on writing into a document nothing is showing: the fader on
  // screen would sit still while the unit moved.
  //
  // ⚠️ This pins a BACKSTOP, not a live path. The replacement it was written for — a
  // cancelled Fetch restoring a pre-read clone outside loadPlan — no longer happens
  // (main.ts: the read runs against a private copy and the module plan object is never
  // replaced), and loadPlan, the one replacement left, announces itself. So this case
  // passing says the memo would survive a future silent replacement; it does not say
  // one exists. `e2e/race/t3b-undo.spec.ts`'s variant is titled after the path that is
  // gone, which is why the ledger does not name this as its guard.
  const levelOf = (p: { connections: Array<{ from: string; to: string; params?: { level?: number } }> }): number =>
    p.connections.find((c) => c.from === "ch1:out" && c.to === "bus.stereo:in")!.params!.level!;

  it("writes the document that is loaded now, not the one a control was bound against", async () => {
    seedMappings();
    const { hooks, plan, model, swapPlan } = install();
    await attached();
    dispatch({ type: "ready" });
    dispatch({ type: "port", dir: "in", name: "Controller In" });
    await vi.waitFor(() => expect(mocks.inputReceiver).toBeDefined());

    mocks.inputReceiver!([0xb0, 7, 127]);
    expect(levelOf(plan)).toBe(10);

    // The shape of a cancelled Fetch: a different Plan object, same model, restored
    // outside every path that would announce it. Nothing here is about a cache — that is
    // the point: whatever resolve() does internally, the write has to land on the document
    // the app is showing, and this fails against any memo that outlives it.
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

describe("MidiControl, the races and vocabularies around a port", () => {
  // Completion order used to decide instead of selection order. A slow open is exactly
  // what a wedged port gives you — and exactly when the operator is re-picking — so the
  // open landed after their "None" and installed itself over it: the select read None
  // while the port stayed open on the shell, delivering into the engine and editing the
  // plan, and it was saved and restored at the next boot.
  it("lets the operator's later choice win over an open still in flight", async () => {
    const { control } = install();
    void control;
    await attached();
    dispatch({ type: "ready" });
    await vi.waitFor(() => expect(lastState().inputs).toEqual(["Controller In"]));

    let land!: () => void;
    const stalled = new Promise<void>((r) => (land = r));
    mocks.midiOpenInput.mockImplementationOnce(async (_port: string, onMessage: (bytes: number[]) => void) => {
      mocks.inputReceiver = onMessage;
      await stalled;
      return mocks.closeInput;
    });

    dispatch({ type: "port", dir: "in", name: "Controller In" });
    await vi.waitFor(() => expect(mocks.midiOpenInput).toHaveBeenCalled());
    dispatch({ type: "port", dir: "in", name: null });
    await vi.waitFor(() => expect(lastState().input).toBeNull());

    land();
    await vi.waitFor(() => expect(mocks.closeInput).toHaveBeenCalled());
    // The stalled open closed ITSELF rather than taking the slot the operator cleared.
    expect(lastState().input).toBeNull();
    expect(JSON.parse(localStorage.getItem("urx-midi")!).input).toBeUndefined();
  });

  // The A -> B case, which is the one a per-completion guard cannot fix: the shell's
  // open REPLACES whatever is held and its close closes whatever is held, neither
  // taking a port — so with two opens in flight the slot ends up holding whichever
  // finished last, and a stale continuation "cleaning up after itself" closes the port
  // that superseded it. The intents are run one at a time instead.
  it("opens the port chosen last, not the open that finished last", async () => {
    mocks.midiListInputs.mockResolvedValue(["A", "B"]);
    const { control } = install();
    void control;
    await attached();
    dispatch({ type: "ready" });
    await vi.waitFor(() => expect(lastState().inputs).toEqual(["A", "B"]));

    const opened: string[] = [];
    let land!: () => void;
    const stalled = new Promise<void>((r) => (land = r));
    mocks.midiOpenInput.mockImplementation(async (port: string, onMessage: (bytes: number[]) => void) => {
      mocks.inputReceiver = onMessage;
      if (port === "A") await stalled;
      opened.push(port);
      return mocks.closeInput;
    });

    dispatch({ type: "port", dir: "in", name: "A" });
    // A is genuinely in flight before B is chosen — the shape a per-completion guard
    // cannot fix, since by then the shell already holds A.
    await vi.waitFor(() => expect(mocks.midiOpenInput).toHaveBeenCalledWith("A", expect.any(Function)));
    dispatch({ type: "port", dir: "in", name: "B" });
    land();
    await vi.waitFor(() => expect(lastState().input).toBe("B"));
    // B's open ran AFTER A's finished, so the shell's slot ends on B. Racing them left
    // it on whichever resolved last.
    expect(opened).toEqual(["A", "B"]);
    expect(JSON.parse(localStorage.getItem("urx-midi")!).input).toBe("B");
  });

  // The boot restore is the third writer of the port slots, after the two intents, and
  // the window is usable while it is still in flight — a saved port that opens slowly is
  // exactly the wedged one the operator is re-picking away from. Outside the queue it
  // completed after their choice and installed itself over it: the shell held A, the
  // select said B, and A went back into the store for the next boot.
  it("lets a choice made during the boot restore win over the port being restored", async () => {
    localStorage.setItem("urx-midi", JSON.stringify({ input: "A" }));
    mocks.midiListInputs.mockResolvedValue(["A", "B"]);

    const opened: string[] = [];
    let land!: () => void;
    const stalled = new Promise<void>((r) => (land = r));
    mocks.midiOpenInput.mockImplementation(async (port: string, onMessage: (bytes: number[]) => void) => {
      mocks.inputReceiver = onMessage;
      if (port === "A") await stalled;
      opened.push(port);
      return mocks.closeInput;
    });

    install();
    await attached();
    dispatch({ type: "ready" });
    await vi.waitFor(() => expect(mocks.midiOpenInput).toHaveBeenCalledWith("A", expect.any(Function)));

    // The operator picks B while the restore of A is still in flight.
    dispatch({ type: "port", dir: "in", name: "B" });
    land();

    await vi.waitFor(() => expect(lastState().input).toBe("B"));
    expect(opened).toEqual(["A", "B"]); // B's open ran after A's, so the shell ends on B
    expect(JSON.parse(localStorage.getItem("urx-midi")!).input).toBe("B");
  });

  // …and "None" during the restore means none, rather than the saved port coming back.
  it("lets None during the boot restore stand", async () => {
    localStorage.setItem("urx-midi", JSON.stringify({ input: "A" }));
    mocks.midiListInputs.mockResolvedValue(["A", "B"]);

    let land!: () => void;
    const stalled = new Promise<void>((r) => (land = r));
    mocks.midiOpenInput.mockImplementation(async (port: string, onMessage: (bytes: number[]) => void) => {
      mocks.inputReceiver = onMessage;
      if (port === "A") await stalled;
      return mocks.closeInput;
    });

    install();
    await attached();
    dispatch({ type: "ready" });
    await vi.waitFor(() => expect(mocks.midiOpenInput).toHaveBeenCalledWith("A", expect.any(Function)));

    dispatch({ type: "port", dir: "in", name: null });
    land();

    await vi.waitFor(() => expect(mocks.closeInput).toHaveBeenCalled());
    expect(lastState().input).toBeNull();
    expect(JSON.parse(localStorage.getItem("urx-midi")!).input).toBeUndefined();
  });

  // `midi_close_input` closes whatever the shell holds and takes no argument, so
  // holding a closer buys nothing — and conditioning the close on holding one is a
  // gap: after a reconcile adopts a port the shell already had, there is no closer.
  it("closes the shell's input even with no closer of its own in hand", async () => {
    mocks.midiOpenPorts.mockResolvedValueOnce(["Controller In", null]);
    const { control } = install();
    await attached();
    dispatch({ type: "ready" });
    await vi.waitFor(() => expect(lastState().input).toBe("Controller In"));
    void control;

    dispatch({ type: "port", dir: "in", name: null });
    await vi.waitFor(() => expect(mocks.midiCloseInput).toHaveBeenCalled());
    expect(lastState().input).toBeNull();
  });

  // The relay's own header says it can deliver a previous session's messages, and
  // `parseRelay` checks the envelope rather than the field vocabulary. The engine reads
  // any non-"pickup" mode as absolute, so an unknown value looked fine for the session
  // and then `sanitizeMappings` dropped the WHOLE binding at the next boot, silently.
  it("refuses a mode or button value this build does not have", async () => {
    seedMappings();
    const { control } = install();
    await attached();
    dispatch({ type: "ready" });

    dispatch({ type: "mode", control: "ch1/level", mode: "relative" } as unknown as MidiUiIntent);
    expect(JSON.parse(localStorage.getItem("urx-midi")!).models.URX44V[0].mode).toBe("absolute");
    dispatch({ type: "button", control: "ch1/level", button: "latch" } as unknown as MidiUiIntent);
    expect(JSON.parse(localStorage.getItem("urx-midi")!).models.URX44V[0].button).toBeUndefined();
    expect(control.isMapped("ch1/level")).toBe(true);
  });

  // Pickup state is owned by the address head, and only the head ever creates it — so a
  // member set to Pickup behind an Absolute head reads `engaged = false` for ever and
  // never moves, with nothing on screen to say why. The mode is a property of the
  // physical control, so setting it sets it for everything on that address.
  it("gives every binding on one address the same take-in mode", async () => {
    localStorage.setItem(
      "urx-midi",
      JSON.stringify({
        models: {
          URX44V: [
            { control: "ch1/level", addr: { type: "cc", channel: 0, controller: 7 }, mode: "absolute" },
            { control: "ch2/level", addr: { type: "cc", channel: 0, controller: 7 }, mode: "absolute" },
            { control: "ch3/level", addr: { type: "cc", channel: 0, controller: 9 }, mode: "absolute" },
          ],
        },
      }),
    );
    install();
    await attached();
    dispatch({ type: "ready" });

    dispatch({ type: "mode", control: "ch2/level", mode: "pickup" });
    const stored = JSON.parse(localStorage.getItem("urx-midi")!).models.URX44V as Array<{
      control: string;
      mode: string;
    }>;
    expect(stored.find((m) => m.control === "ch1/level")!.mode).toBe("pickup");
    expect(stored.find((m) => m.control === "ch2/level")!.mode).toBe("pickup");
    // …and only that address: a binding on another controller is untouched.
    expect(stored.find((m) => m.control === "ch3/level")!.mode).toBe("absolute");
  });
});

// On a reflecting transport our own feedback comes straight back, and the learn branch
// in `onMessage` runs BEFORE the receive-side echo guard — so the engine took that echo
// as the operator's gesture and bound the armed control to whatever address the
// feedback used. A plan edit from anywhere is enough to start it (device follow, undo,
// a graph-inspector edit), and on a note the bind is instant with no quiet gap.
describe("MidiControl learn and feedback", () => {
  it("sends no feedback while a learn is armed, and resyncs when it ends", async () => {
    seedMappings();
    const { control, plan } = install();
    await attached();
    dispatch({ type: "ready" });
    await vi.waitFor(() => expect(lastState().outputs).toEqual(["Controller Out"]));
    dispatch({ type: "port", dir: "out", name: "Controller Out" });
    await vi.waitFor(() => expect(lastState().output).toBe("Controller Out"));
    // Before the clear: the output side stays shut until a readback settles, and this
    // case is about the learn suspension — with it left shut, the silence below would
    // be the other rule's and the arming could stop working unnoticed.
    control.liveReadSettled();
    mocks.midiSend.mockClear();

    // A plan edit from anywhere — this stands for a device-follow apply, an undo, or a
    // graph-inspector drag. Without one the pass has nothing to send and the case would
    // pass whether or not the suspension exists.
    const send = plan.connections.find((c) => c.from === "ch1:out" && c.to === "bus.stereo:in")!;
    send.params = { ...send.params, level: -12 };

    dispatch({ type: "learn", on: true });
    control.arm("ch2/level");
    control.scheduleFeedback();
    await new Promise((r) => setTimeout(r, 300));
    expect(mocks.midiSend).not.toHaveBeenCalled();

    // Ending the arming brings the controller back into agreement, which is what makes
    // the suspension free: nothing is lost, only deferred.
    dispatch({ type: "learn", on: false });
    await vi.waitFor(() => expect(mocks.midiSend).toHaveBeenCalled());
  });
});

describe("MidiControl against a control the plan has stopped carrying", () => {
  // A bound control closes over the insert-FX family, the processor and the send it was
  // built for, and a plan is edited IN PLACE. So a resolve that answered once must not keep
  // answering after the node has stopped holding that effect: the write would land on a
  // slot nothing sends and reappear the moment the operator selected it again, and feedback
  // would keep reporting the same stale value to the controller.
  const INSFX = {
    control: "ch1/insfx@insfx.guitar-clean.7",
    addr: { type: "cc", channel: 0, controller: 21 },
    mode: "absolute",
  } as const;

  it("stops applying and stops reporting once the node holds another effect, and resumes", async () => {
    localStorage.setItem("urx-midi", JSON.stringify({ models: { URX44V: [INSFX] } }));
    const { control, plan } = install();
    await attached();
    dispatch({ type: "ready" });
    await vi.waitFor(() => expect(lastState().outputs).toEqual(["Controller Out"]));
    dispatch({ type: "port", dir: "in", name: "Controller In" });
    dispatch({ type: "port", dir: "out", name: "Controller Out" });
    await vi.waitFor(() => expect(lastState().output).toBe("Controller Out"));
    control.liveReadSettled();
    const send = (v: number): void => {
      if (!mocks.inputReceiver) throw new Error("no MIDI input");
      mocks.inputReceiver([0xb0, 21, v]);
    };
    const slot = (): number | undefined => plan.nodeParams.ch1?.insertFxParams?.["guitar-clean:7"];

    // The node holds the amp: the mapping applies, and that is what warms the resolve.
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, insertFx: 256 };
    send(100);
    await vi.waitFor(() => expect(slot()).toBeDefined());
    const applied = slot();

    // The same plan OBJECT, now holding a different effect. Nothing announces this to the
    // MIDI surface — it is an ordinary in-place edit.
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, insertFx: 512 };
    mocks.midiSend.mockClear();
    send(20);
    await new Promise((r) => setTimeout(r, 150));
    expect(slot(), "the amp's slot is not written while the node holds Pitch Fix").toBe(applied);
    control.scheduleFeedback();
    await new Promise((r) => setTimeout(r, 300));
    expect(mocks.midiSend, "and nothing is reported for it either").not.toHaveBeenCalled();

    // …and the mapping is not lost: selecting the amp again brings it back, which is what
    // separates this from a control that stopped working.
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, insertFx: 256 };
    send(20);
    await vi.waitFor(() => expect(slot()).not.toBe(applied));
  });
});
