// @vitest-environment jsdom

// The platform bridge is the wire contract between the TypeScript app and the
// Tauri shell. These tests exercise both browser fallbacks and the exact IPC
// command/argument/channel shapes; a wrapper that silently renames a field is as
// broken as the Rust command itself even though it still type-checks locally.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as platform from "./platform";

type InvokeArgs = Record<string, unknown> | Uint8Array;
type InvokeOptions = { headers: Record<string, string> };

class FakeChannel<T> {
  onmessage = (_data: T): void => {};
}

interface Harness {
  invoke: ReturnType<typeof vi.fn<(cmd: string, args?: InvokeArgs, options?: InvokeOptions) => Promise<unknown>>>;
  callbacks: Array<(payload: unknown) => void>;
}

function setWindowProperty(name: string, value: unknown): void {
  Object.defineProperty(window, name, { configurable: true, writable: true, value });
}

function installInternals(responses: Record<string, unknown> = {}): Harness {
  const callbacks: Array<(payload: unknown) => void> = [];
  const invoke = vi.fn(
    async (cmd: string, _args?: InvokeArgs, _options?: InvokeOptions): Promise<unknown> => responses[cmd],
  );
  const transformCallback = vi.fn((callback: (payload: unknown) => void): number => {
    callbacks.push(callback);
    return callbacks.length;
  });
  setWindowProperty("__TAURI_INTERNALS__", { invoke, Channel: FakeChannel, transformCallback });
  return { invoke, callbacks };
}

/** A notification channel's message as the shell numbers it (vd.rs `Delivery`). */
interface Delivery<T> {
  session: number;
  seq: number;
  updates: T[];
}

const delivery = <T>(seq: number, updates: T[], session = 0): Delivery<T> => ({ session, seq, updates });

function channelFrom<T>(harness: Harness, command: string): FakeChannel<T> {
  const call = harness.invoke.mock.calls.find(([cmd]) => cmd === command);
  expect(call, `missing ${command} IPC call`).toBeDefined();
  return (call?.[1] as { channel: FakeChannel<T> }).channel;
}

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  Reflect.deleteProperty(window, "__TAURI__");
  vi.restoreAllMocks();
});

describe("plain-browser fallbacks", () => {
  it("keeps desktop-only operations inert and uses browser dialogs", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});

    expect(platform.isTauri()).toBe(false);
    await expect(platform.invoke("desktop_only")).rejects.toThrow("not running under Tauri");
    await expect(
      Promise.all([
        platform.experimentalEnabled(),
        platform.selfTestRequested(),
        platform.prepareModifiedRequested(),
        platform.resetStorageRequested(),
      ]),
    ).resolves.toEqual([false, false, false, false]);

    await expect(platform.confirmDialog("continue?")).resolves.toBe(true);
    await platform.errorDialog("failed");
    expect(confirm).toHaveBeenCalledWith("continue?");
    expect(alert).toHaveBeenCalledWith("failed");
    await expect(platform.nativeSavePath("plan.json", { ext: "json", label: "Plan" })).resolves.toBeNull();
    await expect(platform.nativeOpenPath({ ext: "json", label: "Plan" })).resolves.toBeNull();

    const meterUnsubscribe = await platform.vdMetersSubscribe([], vi.fn());
    const paramUnsubscribe = await platform.vdParamsSubscribe([], vi.fn());
    await platform.vdWatchLink(vi.fn());
    meterUnsubscribe();
    paramUnsubscribe();
    await expect(platform.vdLinkStats()).resolves.toBeNull();
    await expect(platform.midiListInputs()).resolves.toEqual([]);
    await expect(platform.midiListOutputs()).resolves.toEqual([]);
    await expect(platform.midiOpenPorts()).resolves.toEqual([null, null]);
    const closeInput = await platform.midiOpenInput("missing", vi.fn());
    closeInput();
    await expect(platform.midiCloseOutput()).resolves.toBeUndefined();
    await expect(platform.checkUpdate()).resolves.toBeNull();
  });
});

describe("invoke resolution and file/dialog primitives", () => {
  it("falls back to the global Tauri core and prefers internals when both exist", async () => {
    const globalInvoke = vi.fn(async (): Promise<unknown> => "global");
    setWindowProperty("__TAURI__", { core: { invoke: globalInvoke, Channel: FakeChannel } });

    await expect(platform.invoke("global_command")).resolves.toBe("global");
    expect(globalInvoke).toHaveBeenCalledWith("global_command", {}, undefined);

    const harness = installInternals({ internal_command: "internal" });
    await expect(platform.invoke("internal_command")).resolves.toBe("internal");
    expect(harness.invoke).toHaveBeenCalledWith("internal_command", {}, undefined);
    expect(globalInvoke).toHaveBeenCalledTimes(1);
  });

  it("maps native dialogs, binary IO and event payloads exactly", async () => {
    const bytes = Uint8Array.of(1, 2, 255);
    const harness = installInternals();
    harness.invoke.mockImplementation(async (cmd): Promise<unknown> => {
      if (cmd === "plugin:dialog|message") return "Ok";
      if (cmd === "plugin:dialog|save") return "/tmp/plan.json";
      if (cmd === "plugin:dialog|open") return "/tmp/open.json";
      if (cmd === "read_binary_file") return bytes.buffer;
      return undefined;
    });

    await expect(platform.confirmDialog("continue?")).resolves.toBe(true);
    await platform.errorDialog("failed");
    await expect(platform.nativeSavePath("plan.json", { ext: "json", label: "Plan" })).resolves.toBe("/tmp/plan.json");
    await expect(platform.nativeOpenPath({ ext: "json", label: "Plan" })).resolves.toBe("/tmp/open.json");
    await expect(platform.nativeReadBinary("/tmp/raw.bin")).resolves.toEqual(bytes);

    await platform.nativeWriteBinary("/tmp/日本語.bin", bytes);
    expect(harness.invoke).toHaveBeenCalledWith("write_binary_file", bytes, {
      headers: { "x-file-path": encodeURIComponent("/tmp/日本語.bin") },
    });

    const seen: number[] = [];
    await platform.listenEvent<number>("app://event", (payload) => seen.push(payload));
    expect(harness.invoke).toHaveBeenCalledWith(
      "plugin:event|listen",
      { event: "app://event", target: { kind: "Any" }, handler: 1 },
      undefined,
    );
    harness.callbacks[0]({ payload: 42 });
    expect(seen).toEqual([42]);
  });

  // A window-scoped subscription names the page's own window, as the shell labels it, so an
  // event the shell raises for another window does not reach it; the default stays every
  // emitter, which is what the Edit menu's subscription relies on.
  it("aims a window-scoped event subscription at the page's own window", async () => {
    const harness = installInternals();
    setWindowProperty("__TAURI_INTERNALS__", {
      ...(window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__,
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    });
    await platform.listenEvent("tauri://drag-drop", vi.fn(), "window");
    await platform.listenEvent("menu://edit", vi.fn());
    expect(harness.invoke.mock.calls.map(([, args]) => (args as { target: unknown }).target)).toEqual([
      { kind: "WebviewWindow", label: "main" },
      { kind: "Any" },
    ]);
  });

  // Without the label there is no window to aim at, and widening to every emitter is the
  // subscription the scope exists to refuse: it rejects, registers nothing and keeps no
  // callback.
  it("refuses a window-scoped subscription when the page's window label is missing", async () => {
    const harness = installInternals();
    await expect(platform.listenEvent("tauri://drag-drop", vi.fn(), "window")).rejects.toThrow(
      "window label is unknown",
    );
    expect(harness.invoke).not.toHaveBeenCalled();
    expect(harness.callbacks).toEqual([]);
  });

  it("normalizes cancellation and unavailable event support", async () => {
    const harness = installInternals();
    harness.invoke.mockResolvedValueOnce("Cancel");
    await expect(platform.confirmDialog("continue?")).resolves.toBe(false);
    harness.invoke.mockResolvedValueOnce(["/tmp/multiple.json"]);
    await expect(platform.nativeOpenPath({ ext: "json", label: "Plan" })).resolves.toBeNull();
    harness.invoke.mockResolvedValueOnce({ path: "/tmp/not-a-string" });
    await expect(platform.nativeSavePath("plan.json", { ext: "json", label: "Plan" })).resolves.toBeNull();

    setWindowProperty("__TAURI_INTERNALS__", { invoke: harness.invoke, Channel: FakeChannel });
    harness.invoke.mockClear();
    await platform.listenEvent("ignored", vi.fn());
    expect(harness.invoke).not.toHaveBeenCalled();
  });
});

describe("streaming channel adapters", () => {
  it("fans meter, parameter, link and MIDI batches back into frontend records", async () => {
    const harness = installInternals();
    const meters: platform.MeterUpdate[] = [];
    const params: platform.ParamUpdate[] = [];
    const drops: string[] = [];
    const midi: number[][] = [];

    const stopMeters = await platform.vdMetersSubscribe(
      [
        [101, 0],
        [101, 1],
      ],
      (update) => meters.push(update),
    );
    channelFrom<Delivery<{ meter_id: number; x: number; value: number }>>(harness, "vd_meters_subscribe").onmessage(
      delivery(0, [
        { meter_id: 101, x: 0, value: -120 },
        { meter_id: 101, x: 1, value: -90 },
      ]),
    );

    const stopParams = await platform.vdParamsSubscribe([[12, 3, 4]], (update) => params.push(update));
    channelFrom<Delivery<{ param_id: number; x: number; y: number; value: number; value_str?: string }>>(
      harness,
      "vd_params_subscribe",
    ).onmessage(
      delivery(0, [
        { param_id: 12, x: 3, y: 4, value: 7 },
        { param_id: 13, x: 5, y: 6, value: 0, value_str: "Vocal" },
      ]),
    );

    const watched: platform.ParamUpdate[] = [];
    await platform.vdProbeSubscribe([[838, 0, 0]], (update) => watched.push(update));
    channelFrom<Delivery<{ param_id: number; x: number; y: number; value: number }>>(
      harness,
      "vd_probe_subscribe",
    ).onmessage(delivery(0, [{ param_id: 838, x: 0, y: 0, value: 2 }]));
    expect(watched).toEqual([{ paramId: 838, x: 0, y: 0, value: 2, valueStr: undefined }]);

    await platform.vdWatchLink((reason) => drops.push(reason));
    channelFrom<{ reason: string }>(harness, "vd_watch_link").onmessage({ reason: "deadline" });

    const closeInput = await platform.midiOpenInput("Controller", (bytes) => midi.push(bytes));
    channelFrom<Array<{ bytes: number[] }>>(harness, "midi_open_input").onmessage([
      { bytes: [0x90, 60, 127] },
      { bytes: [0x80, 60, 0] },
    ]);

    expect(meters).toEqual([
      { meterId: 101, x: 0, value: -120 },
      { meterId: 101, x: 1, value: -90 },
    ]);
    expect(params).toEqual([
      { paramId: 12, x: 3, y: 4, value: 7, valueStr: undefined },
      { paramId: 13, x: 5, y: 6, value: 0, valueStr: "Vocal" },
    ]);
    expect(drops).toEqual(["deadline"]);
    expect(midi).toEqual([
      [0x90, 60, 127],
      [0x80, 60, 0],
    ]);

    stopMeters();
    stopParams();
    closeInput();
    await Promise.resolve();
    expect(harness.invoke.mock.calls.map(([cmd]) => cmd)).toEqual(
      expect.arrayContaining(["vd_meters_unsubscribe", "vd_params_unsubscribe", "midi_close_input"]),
    );
  });

  it("relays MIDI-window channels and requires a Channel constructor", async () => {
    const harness = installInternals();
    const intents: string[] = [];
    const states: string[] = [];
    await platform.midiUiAttachMain((payload) => intents.push(payload));
    await platform.midiUiAttachWindow((payload) => states.push(payload));
    channelFrom<string>(harness, "midi_ui_attach_main").onmessage("intent");
    channelFrom<string>(harness, "midi_ui_attach_window").onmessage("state");
    expect(intents).toEqual(["intent"]);
    expect(states).toEqual(["state"]);

    setWindowProperty("__TAURI_INTERNALS__", { invoke: harness.invoke });
    expect(() => platform.installUpdate(1)).toThrow("Tauri Channel unavailable");
  });

  it("swallows teardown races after an established subscription", async () => {
    const harness = installInternals();
    const stopMeters = await platform.vdMetersSubscribe([], vi.fn());
    const closeInput = await platform.midiOpenInput("Controller", vi.fn());
    harness.invoke.mockRejectedValue(new Error("already closed"));
    expect(() => stopMeters()).not.toThrow();
    expect(() => closeInput()).not.toThrow();
    await expect(platform.midiCloseOutput()).resolves.toBeUndefined();
    await Promise.resolve();
  });
});

// The shell numbers a kind's messages across every channel the session gave it, and the
// bridge hands them on in that order: Tauri orders one channel's messages and not two's.
describe("notification order", () => {
  type RawParam = { param_id: number; x: number; y: number; value: number };
  const param = (value: number): RawParam => ({ param_id: 1, x: 0, y: 0, value });
  const channelsOf = <T>(harness: Harness, command: string): Array<FakeChannel<T>> =>
    harness.invoke.mock.calls
      .filter(([cmd]) => cmd === command)
      .map(([, args]) => (args as { channel: FakeChannel<T> }).channel);

  async function connected(session: number): Promise<Harness> {
    const harness = installInternals({
      vd_connect: { model: "URX44V", label: "URX44V", firmware: "1.5.0", epoch: 1, session },
    });
    await platform.vdConnect("URX44V");
    return harness;
  }

  afterEach(async () => {
    // The bridge's own state goes with the connection it followed.
    if (!Reflect.has(window, "__TAURI_INTERNALS__")) installInternals();
    await platform.vdDisconnect(1);
    vi.useRealTimers();
  });

  it("hands a kind's messages to their own channels' handlers in the shell's order", async () => {
    const harness = await connected(3);
    const seen: string[] = [];
    await platform.vdParamsSubscribe([[1, 0, 0]], (p) => seen.push(`old ${p.value}`));
    await platform.vdParamsSubscribe([[1, 0, 0]], (p) => seen.push(`new ${p.value}`));
    const [older, newer] = channelsOf<Delivery<RawParam>>(harness, "vd_params_subscribe");
    newer.onmessage(delivery(1, [param(20)], 3));
    expect(seen, "held until the message before it arrives").toEqual([]);
    older.onmessage(delivery(0, [param(10)], 3));
    expect(seen).toEqual(["old 10", "new 20"]);
    older.onmessage(delivery(3, [param(40)], 3));
    newer.onmessage(delivery(2, [param(30)], 3));
    expect(seen).toEqual(["old 10", "new 20", "new 30", "old 40"]);
    // The meters count on their own.
    const meters: number[] = [];
    await platform.vdMetersSubscribe([[101, 0]], (m) => meters.push(m.value));
    channelsOf<Delivery<{ meter_id: number; x: number; value: number }>>(harness, "vd_meters_subscribe")[0].onmessage(
      delivery(0, [{ meter_id: 101, x: 0, value: -120 }], 3),
    );
    expect(meters).toEqual([-120]);
  });

  it("sets aside a message of a session other than the one its connect named", async () => {
    const harness = await connected(3);
    const seen: number[] = [];
    await platform.vdParamsSubscribe([[1, 0, 0]], (p) => seen.push(p.value));
    const [channel] = channelsOf<Delivery<RawParam>>(harness, "vd_params_subscribe");
    channel.onmessage(delivery(0, [param(1)], 2));
    channel.onmessage(delivery(0, [param(2)], 3));
    expect(seen).toEqual([2]);
  });

  it("ends the session through the link watch when a message is still missing after the wait", async () => {
    vi.useFakeTimers();
    const harness = await connected(3);
    const seen: number[] = [];
    const drops: string[] = [];
    await platform.vdParamsSubscribe([[1, 0, 0]], (p) => seen.push(p.value));
    await platform.vdWatchLink((reason) => drops.push(reason));
    const [channel] = channelsOf<Delivery<RawParam>>(harness, "vd_params_subscribe");
    channel.onmessage(delivery(1, [param(20)], 3));
    vi.advanceTimersByTime(platform.DELIVERY_GAP_MS - 1);
    expect(drops).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(drops).toEqual([platform.NOTIFICATION_GAP]);
    // Nothing of that session is put in order any more: what follows a gap has no order.
    channel.onmessage(delivery(0, [param(10)], 3));
    channel.onmessage(delivery(2, [param(30)], 3));
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(platform.DELIVERY_GAP_MS);
    expect(drops, "reported once").toEqual([platform.NOTIFICATION_GAP]);
  });

  it("ends nothing when the missing message arrives within the wait, and times each gap from its own start", async () => {
    vi.useFakeTimers();
    const harness = await connected(3);
    const seen: number[] = [];
    const drops: string[] = [];
    await platform.vdParamsSubscribe([[1, 0, 0]], (p) => seen.push(p.value));
    await platform.vdWatchLink((reason) => drops.push(reason));
    const [channel] = channelsOf<Delivery<RawParam>>(harness, "vd_params_subscribe");
    channel.onmessage(delivery(1, [param(20)], 3));
    vi.advanceTimersByTime(platform.DELIVERY_GAP_MS - 1);
    channel.onmessage(delivery(0, [param(10)], 3));
    expect(seen).toEqual([10, 20]);
    channel.onmessage(delivery(3, [param(40)], 3));
    vi.advanceTimersByTime(platform.DELIVERY_GAP_MS - 1);
    expect(drops, "the second gap waits its own full time").toEqual([]);
    channel.onmessage(delivery(2, [param(30)], 3));
    vi.advanceTimersByTime(platform.DELIVERY_GAP_MS);
    expect(seen).toEqual([10, 20, 30, 40]);
    expect(drops).toEqual([]);
  });

  it("hands on every ready message when an earlier one's handler throws, and passes the failure on", async () => {
    const harness = await connected(3);
    const seen: number[] = [];
    await platform.vdParamsSubscribe([[1, 0, 0]], (p) => {
      if (p.value === 10) throw new Error("handler");
      seen.push(p.value);
    });
    const [channel] = channelsOf<Delivery<RawParam>>(harness, "vd_params_subscribe");
    channel.onmessage(delivery(1, [param(20)], 3));
    expect(() => channel.onmessage(delivery(0, [param(10)], 3))).toThrow("handler");
    expect(seen).toEqual([20]);
  });

  it("forgets the connection it followed at that connection's disconnect, not an older one's", async () => {
    const harness = await connected(3);
    const seen: number[] = [];
    await platform.vdParamsSubscribe([[1, 0, 0]], (p) => seen.push(p.value));
    const [channel] = channelsOf<Delivery<RawParam>>(harness, "vd_params_subscribe");
    channel.onmessage(delivery(0, [param(1)], 3));
    await platform.vdDisconnect(0);
    channel.onmessage(delivery(1, [param(2)], 3));
    expect(seen, "a disconnect of an older epoch leaves the order alone").toEqual([1, 2]);
    await platform.vdDisconnect(1);
    channel.onmessage(delivery(2, [param(3)], 3));
    expect(seen, "after its own disconnect the session is no longer followed").toEqual([1, 2]);
  });
});

describe("command wrappers", () => {
  it("preserves command names and camelCase argument keys", async () => {
    // A connect is answered with a connection, as the shell always answers one.
    const harness = installInternals({
      vd_connect: { model: "URX44V", label: "URX44V", firmware: "1.5.0", epoch: 1, session: 0 },
    });
    const cases: Array<{ run: () => Promise<unknown>; cmd: string; args: InvokeArgs }> = [
      { run: platform.experimentalEnabled, cmd: "experimental_enabled", args: {} },
      { run: platform.selfTestRequested, cmd: "self_test_requested", args: {} },
      { run: platform.prepareModifiedRequested, cmd: "prepare_modified_requested", args: {} },
      { run: platform.resetStorageRequested, cmd: "reset_storage_requested", args: {} },
      { run: platform.thirdPartyLicenses, cmd: "third_party_licenses", args: {} },
      {
        run: () => platform.setEditMenuState(true, false),
        cmd: "set_edit_menu_state",
        args: { canUndo: true, canRedo: false },
      },
      {
        run: () => platform.setEditMenuLabels("Undo", "Redo"),
        cmd: "set_edit_menu_labels",
        args: { undo: "Undo", redo: "Redo" },
      },
      { run: () => platform.nativeReadText("/tmp/a"), cmd: "read_text_file", args: { path: "/tmp/a" } },
      {
        run: () => platform.nativeWriteText("/tmp/a", "text"),
        cmd: "write_text_file",
        args: { path: "/tmp/a", contents: "text" },
      },
      { run: () => platform.vdConnect("URX22"), cmd: "vd_connect", args: { model: "URX22" } },
      { run: () => platform.vdSet(1, 2, 3, 4), cmd: "vd_set", args: { paramId: 1, x: 2, y: 3, value: 4 } },
      { run: () => platform.vdGet(1, 2, 3), cmd: "vd_get", args: { paramId: 1, x: 2, y: 3 } },
      {
        run: () => platform.vdSetStr(1, 2, 3, "name"),
        cmd: "vd_set_str",
        args: { paramId: 1, x: 2, y: 3, value: "name" },
      },
      { run: () => platform.vdGetStr(1, 2, 3), cmd: "vd_get_str", args: { paramId: 1, x: 2, y: 3 } },
      { run: () => platform.vdDisconnect(9), cmd: "vd_disconnect", args: { epoch: 9 } },
      { run: () => platform.appendLinkLog("line"), cmd: "append_link_log", args: { line: "line" } },
      { run: () => platform.appendMidiLog(["a", "b"]), cmd: "append_midi_log", args: { lines: ["a", "b"] } },
      { run: () => platform.appendWatchLog(["a"]), cmd: "append_watch_log", args: { lines: ["a"] } },
      { run: platform.appBuildKind, cmd: "app_build_kind", args: {} },
      { run: () => platform.openMidiWindow("MIDI"), cmd: "open_midi_window", args: { title: "MIDI" } },
      { run: platform.closeMidiWindow, cmd: "close_midi_window", args: {} },
      { run: platform.focusMidiWindow, cmd: "focus_midi_window", args: {} },
      { run: platform.midiWindowOpen, cmd: "midi_window_open", args: {} },
      { run: () => platform.midiUiToWindow("state"), cmd: "midi_ui_to_window", args: { payload: "state" } },
      { run: () => platform.midiUiToMain("intent"), cmd: "midi_ui_to_main", args: { payload: "intent" } },
      { run: () => platform.midiOpenOutput("Controller"), cmd: "midi_open_output", args: { port: "Controller" } },
      { run: () => platform.midiSend([0xb0, 1, 2]), cmd: "midi_send", args: { bytes: [0xb0, 1, 2] } },
      { run: () => platform.setKeepAwake(true), cmd: "set_keep_awake", args: { on: true } },
      { run: platform.restartApp, cmd: "plugin:process|restart", args: {} },
      { run: () => platform.exitApp(7), cmd: "plugin:process|exit", args: { code: 7 } },
    ];

    for (const testCase of cases) {
      harness.invoke.mockClear();
      await testCase.run();
      expect(harness.invoke).toHaveBeenCalledOnce();
      expect(harness.invoke).toHaveBeenCalledWith(testCase.cmd, testCase.args, undefined);
    }
  });

  it("normalizes link stats and desktop MIDI queries", async () => {
    const harness = installInternals();
    harness.invoke.mockImplementation(async (cmd): Promise<unknown> => {
      if (cmd === "vd_link_stats")
        return {
          sets: 1,
          gets: 2,
          param_subscribes: 3,
          meter_subscribes: 4,
          regist_frames: 5,
          unregist_frames: 6,
          deadlines: 7,
          stalled: 8,
        };
      if (cmd === "midi_list_inputs") return ["Input"];
      if (cmd === "midi_list_outputs") return ["Output"];
      if (cmd === "midi_open_ports") return ["Input", "Output"];
      return undefined;
    });

    await expect(platform.vdLinkStats()).resolves.toEqual({
      sets: 1,
      gets: 2,
      paramSubscribes: 3,
      meterSubscribes: 4,
      registFrames: 5,
      unregistFrames: 6,
      deadlines: 7,
      stalled: 8,
    });
    await expect(platform.midiListInputs()).resolves.toEqual(["Input"]);
    await expect(platform.midiListOutputs()).resolves.toEqual(["Output"]);
    await expect(platform.midiOpenPorts()).resolves.toEqual(["Input", "Output"]);
  });

  it("passes updater timeout, resource id and progress events", async () => {
    const harness = installInternals({
      "plugin:updater|check": { rid: 4, version: "2.0.0", currentVersion: "1.0.0" },
    });
    await expect(platform.checkUpdate()).resolves.toEqual({ rid: 4, version: "2.0.0", currentVersion: "1.0.0" });
    expect(harness.invoke).toHaveBeenCalledWith("plugin:updater|check", { timeout: 10_000 }, undefined);

    const events: platform.DownloadEvent[] = [];
    await platform.installUpdate(4, (event) => events.push(event));
    const progressArgs = harness.invoke.mock.calls.find(
      ([cmd]) => cmd === "plugin:updater|download_and_install",
    )?.[1] as {
      onEvent: FakeChannel<platform.DownloadEvent>;
    };
    progressArgs.onEvent.onmessage({
      event: "Progress",
      data: { chunkLength: 256 },
    });
    expect(events).toEqual([{ event: "Progress", data: { chunkLength: 256 } }]);

    harness.invoke.mockClear();
    await platform.installUpdate(5);
    const defaultArgs = harness.invoke.mock.calls[0][1] as { onEvent: FakeChannel<platform.DownloadEvent> };
    defaultArgs.onEvent.onmessage({ event: "Finished" });
    expect(harness.invoke).toHaveBeenCalledWith(
      "plugin:updater|download_and_install",
      { onEvent: expect.any(FakeChannel), rid: 5, timeout: 600_000 },
      undefined,
    );
  });
});
