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
  /** What each command answers: a value, or a function of the call's arguments. */
  answers: Record<string, unknown>;
}

function setWindowProperty(name: string, value: unknown): void {
  Object.defineProperty(window, name, { configurable: true, writable: true, value });
}

function installInternals(responses: Record<string, unknown> = {}): Harness {
  const callbacks: Array<(payload: unknown) => void> = [];
  // A connection's notifications are over at the first fetch unless a test hands them out (`FakeOutbox`).
  const answers: Record<string, unknown> = { vd_notifications: null, ...responses };
  const invoke = vi.fn(async (cmd: string, args?: InvokeArgs, _options?: InvokeOptions): Promise<unknown> => {
    const answer = answers[cmd];
    return typeof answer === "function" ? (answer as (args?: InvokeArgs) => unknown)(args) : answer;
  });
  const transformCallback = vi.fn((callback: (payload: unknown) => void): number => {
    callbacks.push(callback);
    return callbacks.length;
  });
  setWindowProperty("__TAURI_INTERNALS__", { invoke, Channel: FakeChannel, transformCallback });
  return { invoke, callbacks, answers };
}

/** One run as the shell routes it (vd.rs `Run`): one subscription's updates. */
interface Run<T = unknown> {
  kind: "meters" | "params" | "probe";
  handler: number;
  updates: T[];
}

/**
 * The shell's side of `vd_notifications` (vd.rs `Outbox`): a fetch takes every run routed so far,
 * or waits for the next; once the connection is over and nothing is left, it answers null.
 */
class FakeOutbox {
  readonly fetches: InvokeArgs[] = [];
  outstanding = 0;
  mostOutstanding = 0;
  private queued: Run[] = [];
  private waiter: { resolve: (runs: Run[] | null) => void; reject: (error: Error) => void } | null = null;
  private over = false;

  readonly fetch = (args?: InvokeArgs): Promise<Run[] | null> => {
    this.fetches.push(args ?? {});
    this.outstanding += 1;
    this.mostOutstanding = Math.max(this.mostOutstanding, this.outstanding);
    return new Promise<Run[] | null>((resolve, reject) => {
      this.waiter = { resolve, reject };
      this.answer();
    });
  };

  put(...runs: Run[]): void {
    this.queued.push(...runs);
    this.answer();
  }

  /** The shell's wait running out with nothing routed: an empty answer. */
  idle(): void {
    this.settle()?.resolve([]);
  }

  /** The connection is over. */
  end(): void {
    this.over = true;
    this.answer();
  }

  /** The outstanding fetch fails, as an IPC call that does not come back does. */
  fail(): void {
    const waiter = this.settle();
    expect(waiter, "a fetch is outstanding").not.toBeNull();
    waiter?.reject(new Error("ipc"));
  }

  private answer(): void {
    if (this.waiter === null) return;
    if (this.queued.length > 0) {
      const runs = this.queued;
      this.queued = [];
      this.settle()?.resolve(runs);
    } else if (this.over) this.settle()?.resolve(null);
  }

  private settle(): { resolve: (runs: Run[] | null) => void; reject: (error: Error) => void } | null {
    const waiter = this.waiter;
    if (waiter !== null) {
      this.waiter = null;
      this.outstanding -= 1;
    }
    return waiter;
  }
}

/** Lets the fetch loop take what was put and come round to its next fetch. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The handler each call of a subscribe command named, in call order. */
function handlersOf(harness: Harness, command: string): number[] {
  return harness.invoke.mock.calls
    .filter(([cmd]) => cmd === command)
    .map(([, args]) => (args as { handler: number }).handler);
}

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
    // Notifications are fetched for the connection, so a connect comes first.
    const outbox = new FakeOutbox();
    const harness = installInternals({
      vd_connect: { model: "URX44V", label: "URX44V", firmware: "1.5.0", epoch: 1 },
      vd_notifications: outbox.fetch,
    });
    await platform.vdConnect("URX44V");
    const meters: platform.MeterUpdate[] = [];
    const params: platform.ParamUpdate[] = [];
    const watched: platform.ParamUpdate[] = [];
    const drops: string[] = [];
    const midi: number[][] = [];

    const meterAddrs: Array<[number, number]> = [
      [101, 0],
      [101, 1],
    ];
    const stopMeters = await platform.vdMetersSubscribe(meterAddrs, (update) => meters.push(update));
    const stopParams = await platform.vdParamsSubscribe([[12, 3, 4]], (update) => params.push(update));
    await platform.vdProbeSubscribe([[838, 0, 0]], (update) => watched.push(update));
    const [meterHandler] = handlersOf(harness, "vd_meters_subscribe");
    const [paramHandler] = handlersOf(harness, "vd_params_subscribe");
    const [probeHandler] = handlersOf(harness, "vd_probe_subscribe");
    expect(harness.invoke).toHaveBeenCalledWith(
      "vd_meters_subscribe",
      { addrs: meterAddrs, handler: meterHandler },
      undefined,
    );
    expect(harness.invoke).toHaveBeenCalledWith(
      "vd_params_subscribe",
      { addrs: [[12, 3, 4]], handler: paramHandler },
      undefined,
    );
    expect(harness.invoke).toHaveBeenCalledWith(
      "vd_probe_subscribe",
      { addrs: [[838, 0, 0]], handler: probeHandler },
      undefined,
    );
    expect(new Set([meterHandler, paramHandler, probeHandler]).size, "a handler per subscription").toBe(3);
    outbox.put(
      {
        kind: "meters",
        handler: meterHandler,
        updates: [
          { meter_id: 101, x: 0, value: -120 },
          { meter_id: 101, x: 1, value: -90 },
        ],
      },
      {
        kind: "params",
        handler: paramHandler,
        updates: [
          { param_id: 12, x: 3, y: 4, value: 7 },
          { param_id: 13, x: 5, y: 6, value: 0, value_str: "Vocal" },
        ],
      },
      { kind: "probe", handler: probeHandler, updates: [{ param_id: 838, x: 0, y: 0, value: 2 }] },
    );
    await settle();
    expect(outbox.fetches[0]).toEqual({ epoch: 1, seq: 0 });

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
    expect(watched).toEqual([{ paramId: 838, x: 0, y: 0, value: 2, valueStr: undefined }]);
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
    await platform.vdDisconnect(1);
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

// The page fetches the connection's notifications one request at a time (vd.rs `Outbox`), so each
// run reaches its handler in the order the shell received it, and a fetch that fails is seen.
describe("notification fetch", () => {
  type RawParam = { param_id: number; x: number; y: number; value: number };
  const params = (handler: number, ...values: number[]): Run<RawParam> => ({
    kind: "params",
    handler,
    updates: values.map((value) => ({ param_id: 1, x: 0, y: 0, value })),
  });
  const meter = (handler: number, value: number): Run => ({
    kind: "meters",
    handler,
    updates: [{ meter_id: 101, x: 0, value }],
  });

  async function connected(): Promise<{ harness: Harness; outbox: FakeOutbox }> {
    const outbox = new FakeOutbox();
    const harness = installInternals({
      vd_connect: { model: "URX44V", label: "URX44V", firmware: "1.5.0", epoch: 1 },
      vd_notifications: outbox.fetch,
    });
    await platform.vdConnect("URX44V");
    return { harness, outbox };
  }

  afterEach(async () => {
    // The bridge's own state goes with the connection it followed.
    if (!Reflect.has(window, "__TAURI_INTERNALS__")) installInternals();
    await platform.vdDisconnect(1);
  });

  it("hands each run to its own subscription's handler in the order the shell received them", async () => {
    const { harness, outbox } = await connected();
    const seen: string[] = [];
    await platform.vdParamsSubscribe([[1, 0, 0]], (p) => seen.push(`old ${p.value}`));
    await platform.vdParamsSubscribe([[1, 0, 0]], (p) => seen.push(`new ${p.value}`));
    await platform.vdMetersSubscribe([[101, 0]], (m) => seen.push(`meter ${m.value}`));
    const [older, newer] = handlersOf(harness, "vd_params_subscribe");
    const [meters] = handlersOf(harness, "vd_meters_subscribe");
    outbox.put(params(newer, 20), params(older, 10), meter(meters, -120));
    await settle();
    outbox.put(params(older, 30), params(newer, 40, 41));
    await settle();
    expect(seen).toEqual(["new 20", "old 10", "meter -120", "old 30", "new 40", "new 41"]);
  });

  it("keeps one fetch outstanding for the connection, and fetches again after each answer", async () => {
    const { outbox } = await connected();
    await platform.vdParamsSubscribe([[1, 0, 0]], vi.fn());
    await platform.vdMetersSubscribe([[101, 0]], vi.fn());
    await platform.vdProbeSubscribe([[838, 0, 0]], vi.fn());
    await settle();
    expect(outbox.fetches, "the subscriptions share one fetch").toEqual([{ epoch: 1, seq: 0 }]);
    outbox.idle();
    await settle();
    expect(outbox.fetches, "an empty answer is fetched past, numbered after it").toEqual([
      { epoch: 1, seq: 0 },
      { epoch: 1, seq: 1 },
    ]);
    expect(outbox.mostOutstanding).toBe(1);
  });

  it("ends the session through the link watch when a fetch fails, and fetches no more", async () => {
    const { outbox } = await connected();
    const drops: string[] = [];
    await platform.vdParamsSubscribe([[1, 0, 0]], vi.fn());
    await platform.vdWatchLink((reason) => drops.push(reason));
    await settle();
    outbox.fail();
    await settle();
    expect(drops).toEqual([platform.NOTIFICATIONS_LOST]);
    expect(outbox.fetches).toHaveLength(1);
  });

  it("stops fetching without a report when the shell answers that the connection is over", async () => {
    const { harness, outbox } = await connected();
    const seen: number[] = [];
    const drops: string[] = [];
    await platform.vdParamsSubscribe([[1, 0, 0]], (p) => seen.push(p.value));
    await platform.vdWatchLink((reason) => drops.push(reason));
    const [handler] = handlersOf(harness, "vd_params_subscribe");
    await settle();
    outbox.put(params(handler, 1));
    await settle();
    outbox.end();
    await settle();
    expect(seen).toEqual([1]);
    expect(outbox.fetches).toHaveLength(2);
    expect(outbox.outstanding, "the answer null ends the loop").toBe(0);
    expect(drops, "the link watch reports the end itself").toEqual([]);
  });

  it("hands on the other runs when one handler throws, and goes on fetching", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { harness, outbox } = await connected();
    const seen: number[] = [];
    await platform.vdParamsSubscribe([[1, 0, 0]], (p) => {
      if (p.value === 10) throw new Error("handler");
      seen.push(p.value);
    });
    const [handler] = handlersOf(harness, "vd_params_subscribe");
    outbox.put(params(handler, 10), params(handler, 20));
    await settle();
    outbox.put(params(handler, 30));
    await settle();
    expect(seen).toEqual([20, 30]);
    expect(error).toHaveBeenCalledWith(new Error("handler"));
  });

  it("forgets a kind's handlers at its unsubscribe, and keeps a replaced subscription's until then", async () => {
    const { harness, outbox } = await connected();
    const seen: string[] = [];
    await platform.vdParamsSubscribe([[1, 0, 0]], (p) => seen.push(`old ${p.value}`));
    const stop = await platform.vdParamsSubscribe([[1, 0, 0]], (p) => seen.push(`new ${p.value}`));
    await platform.vdMetersSubscribe([[101, 0]], (m) => seen.push(`meter ${m.value}`));
    const [older, newer] = handlersOf(harness, "vd_params_subscribe");
    const [meters] = handlersOf(harness, "vd_meters_subscribe");
    outbox.put(params(older, 1));
    await settle();
    stop();
    outbox.put(params(older, 2), params(newer, 3), meter(meters, -120));
    await settle();
    expect(seen).toEqual(["old 1", "meter -120"]);
  });

  /** Closes the connection `connected` opened and opens epoch 2 on `next`, with a params subscription. */
  async function reconnect(harness: Harness, next: FakeOutbox, onUpdate: (p: platform.ParamUpdate) => void) {
    await platform.vdDisconnect(1);
    harness.answers.vd_connect = { model: "URX44V", label: "URX44V", firmware: "1.5.0", epoch: 2 };
    harness.answers.vd_notifications = next.fetch;
    await platform.vdConnect("URX44V");
    await platform.vdParamsSubscribe([[1, 0, 0]], onUpdate);
  }

  it("sets aside what a fetch answers after its connection's disconnect, and fetches for the next one", async () => {
    const { harness, outbox } = await connected();
    const seen: number[] = [];
    await platform.vdParamsSubscribe([[1, 0, 0]], (p) => seen.push(p.value));
    await settle();
    const next = new FakeOutbox();
    await reconnect(harness, next, (p) => seen.push(p.value));
    const [closed, current] = handlersOf(harness, "vd_params_subscribe");
    await settle();
    outbox.put(params(closed, 1));
    next.put(params(closed, 2), params(current, 3));
    await settle();
    expect(seen, "the next connection's own handlers only").toEqual([3]);
    expect(outbox.fetches, "a closed connection is fetched no more").toHaveLength(1);
    expect(next.fetches[0], "numbered from 0 again on the next connection").toEqual({ epoch: 2, seq: 0 });
    await platform.vdDisconnect(2);
  });

  it.each([
    ["fails", (outbox: FakeOutbox) => outbox.fail()],
    ["answers that its connection is over", (outbox: FakeOutbox) => outbox.end()],
  ])("ends nothing and leaves the next connection fetching when a closed connection's fetch %s", async (_, answer) => {
    const { harness, outbox } = await connected();
    const drops: string[] = [];
    await platform.vdParamsSubscribe([[1, 0, 0]], vi.fn());
    await settle();
    const next = new FakeOutbox();
    await reconnect(harness, next, vi.fn());
    await platform.vdWatchLink((reason) => drops.push(reason));
    await settle();
    answer(outbox);
    await settle();
    expect(drops).toEqual([]);
    next.idle();
    await settle();
    expect(next.fetches, "the next connection goes on fetching").toHaveLength(2);
    await platform.vdDisconnect(2);
  });

  it("numbers each fetch after the answer before it", async () => {
    const { harness, outbox } = await connected();
    await platform.vdParamsSubscribe([[1, 0, 0]], vi.fn());
    const [handler] = handlersOf(harness, "vd_params_subscribe");
    await settle();
    outbox.put(params(handler, 1));
    await settle();
    outbox.idle();
    await settle();
    outbox.put(params(handler, 2));
    await settle();
    expect(outbox.fetches.map((args) => (args as { seq: number }).seq)).toEqual([0, 1, 2, 3]);
  });

  it("loses the connection's notifications when a fetch outlasts its deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { harness, outbox } = await connected();
      const seen: number[] = [];
      const drops: string[] = [];
      await platform.vdParamsSubscribe([[1, 0, 0]], (p) => seen.push(p.value));
      await platform.vdWatchLink((reason) => drops.push(reason));
      const [handler] = handlersOf(harness, "vd_params_subscribe");
      await vi.advanceTimersByTimeAsync(platform.NOTIFICATION_FETCH_DEADLINE_MS - 1);
      expect(drops).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(drops).toEqual([platform.NOTIFICATIONS_LOST]);
      outbox.put(params(handler, 1));
      await vi.advanceTimersByTimeAsync(0);
      expect(seen, "a late answer is not taken").toEqual([]);
      expect(outbox.fetches).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses every write on a connection whose notifications were lost, and writes on the next", async () => {
    const { harness, outbox } = await connected();
    await platform.vdParamsSubscribe([[1, 0, 0]], vi.fn());
    await settle();
    outbox.fail();
    await settle();
    harness.invoke.mockClear();
    await expect(platform.vdSet(1, 0, 0, 5)).rejects.toThrow(`${platform.NOTIFICATIONS_LOST}:`);
    await expect(platform.vdSetStr(1, 0, 0, "name")).rejects.toThrow(`${platform.NOTIFICATIONS_LOST}:`);
    await platform.vdParamsSubscribe([[1, 0, 0]], vi.fn());
    await settle();
    expect(outbox.fetches, "nor is it fetched again, whatever subscribes").toHaveLength(1);
    expect(
      harness.invoke.mock.calls.map(([cmd]) => cmd),
      "nothing was written",
    ).not.toContain("vd_set");
    await reconnect(harness, new FakeOutbox(), vi.fn());
    await expect(platform.vdSet(1, 0, 0, 5)).resolves.toBeUndefined();
    expect(harness.invoke).toHaveBeenCalledWith("vd_set", { paramId: 1, x: 0, y: 0, value: 5 }, undefined);
    await platform.vdDisconnect(2);
  });

  // The shell says when the transport never sent a write (vd.rs `NOT_SENT`): the page takes the
  // prefix off, so the message reads as it did, and marks the error as a write that did not leave.
  it("marks a write the transport never sent, with the shell's prefix taken off", async () => {
    const { harness } = await connected();
    harness.answers.vd_set = () => {
      throw new Error(`${platform.NOT_SENT}: device-lost: the unit went offline`);
    };
    harness.answers.vd_set_str = () => {
      throw new Error("device-lost: the unit went offline");
    };
    const unsent = await platform.vdSet(1, 0, 0, 5).catch((error: unknown) => error);
    expect((unsent as Error).message).toBe("device-lost: the unit went offline");
    expect(platform.refusedBeforeSending(unsent)).toBe(true);
    const maybeSent = await platform.vdSetStr(1, 0, 0, "name").catch((error: unknown) => error);
    expect((maybeSent as Error).message).toBe("device-lost: the unit went offline");
    expect(platform.refusedBeforeSending(maybeSent), "without the prefix it may have landed").toBe(false);
    expect(platform.refusedBeforeSending(new Error("writes-held: locked"))).toBe(true);
    await platform.vdDisconnect(1);
  });

  it("reports a loss to a link watch registered after it", async () => {
    const { outbox } = await connected();
    const drops: string[] = [];
    await platform.vdParamsSubscribe([[1, 0, 0]], vi.fn());
    await settle();
    outbox.fail();
    await settle();
    await platform.vdWatchLink((reason) => drops.push(reason));
    await settle();
    expect(drops).toEqual([platform.NOTIFICATIONS_LOST]);
  });

  it("passes a write the shell held for a lock on its way on once a later fetch has been handed on", async () => {
    const { harness, outbox } = await connected();
    const seen: number[] = [];
    await platform.vdParamsSubscribe([[895, 0, 0]], (p) => seen.push(p.value));
    const [handler] = handlersOf(harness, "vd_params_subscribe");
    await settle();
    harness.answers.vd_set = () => {
      throw new Error(
        `${platform.WRITES_HELD}: the unit announced Console Lock, which the app has not taken yet (fetch 0)`,
      );
    };
    let settled: unknown;
    void platform.vdSet(1, 0, 0, 5).then(
      () => (settled = "written"),
      (error: unknown) => (settled = error),
    );
    await settle();
    expect(settled, "held while the announcement has not been handed on").toBeUndefined();
    outbox.put({ kind: "params", handler, updates: [{ param_id: 895, x: 0, y: 0, value: 1 }] });
    await settle();
    expect(String(settled), "passed on as soon as the fetch it named is handed on").toContain(
      `${platform.WRITES_HELD}:`,
    );
    expect(seen, "the announcement was handed on first").toEqual([1]);
    expect(outbox.fetches, "passed on as the fetch it named was handed on").toHaveLength(2);
  });

  // The fetch a refusal names is one of the connection the write went out on: once the page follows
  // another, that connection's fetches carry nothing of it, and the refusal is passed on at once.
  it("passes a write the shell held on at once once its connection is no longer the one followed", async () => {
    const { harness } = await connected();
    await platform.vdParamsSubscribe([[895, 0, 0]], vi.fn());
    await settle();
    let refuse: (error: Error) => void = () => {};
    harness.answers.vd_set = () => new Promise((_, reject) => (refuse = reject));
    let settled: unknown;
    void platform.vdSet(1, 0, 0, 5).then(
      () => (settled = "written"),
      (error: unknown) => (settled = error),
    );
    await settle();
    // Another connection, fetching, before the shell's refusal comes back.
    harness.answers.vd_connect = { model: "URX44V", label: "URX44V", firmware: "1.5.0", epoch: 2 };
    await platform.vdConnect("URX44V");
    await platform.vdParamsSubscribe([[895, 0, 0]], vi.fn());
    await settle();
    refuse(new Error(`${platform.WRITES_HELD}: the unit announced Console Lock (fetch 2)`));
    await settle();
    expect(String(settled), "its connection's fetch 2 is not the other one's").toContain(`${platform.WRITES_HELD}:`);
  });

  it("passes a write the shell held on at once when nothing fetches", async () => {
    const harness = installInternals({
      vd_connect: { model: "URX44V", label: "URX44V", firmware: "1.5.0", epoch: 1 },
      vd_set: () => {
        throw new Error(`${platform.WRITES_HELD}: the unit announced Console Lock, which the app has not taken yet`);
      },
    });
    await platform.vdConnect("URX44V");
    await expect(platform.vdSetStr(1, 0, 0, "name")).resolves.toBeUndefined();
    harness.answers.vd_set_str = harness.answers.vd_set;
    await expect(platform.vdSetStr(1, 0, 0, "name")).rejects.toThrow(`${platform.WRITES_HELD}:`);
  });

  it("passes a write the shell held on at once when the fetch it names was already handed on", async () => {
    const { harness, outbox } = await connected();
    await platform.vdParamsSubscribe([[895, 0, 0]], vi.fn());
    const [handler] = handlersOf(harness, "vd_params_subscribe");
    outbox.put({ kind: "params", handler, updates: [{ param_id: 895, x: 0, y: 0, value: 1 }] });
    await settle();
    harness.answers.vd_set = () => {
      throw new Error(`${platform.WRITES_HELD}: the unit announced Console Lock (fetch 0)`);
    };
    let settled: unknown;
    void platform.vdSet(1, 0, 0, 5).then(
      () => (settled = "written"),
      (error: unknown) => (settled = error),
    );
    await settle();
    expect(String(settled)).toContain(`${platform.WRITES_HELD}:`);
  });

  it("tells every operation that asked when the connection's notifications are lost, and forgets them on the next", async () => {
    const { harness, outbox } = await connected();
    const told: string[] = [];
    const forget = platform.onNotificationsLost(() => told.push("forgotten"));
    forget();
    platform.onNotificationsLost(() => told.push("write"));
    platform.onNotificationsLost(() => told.push("self-test"));
    await platform.vdParamsSubscribe([[1, 0, 0]], vi.fn());
    await settle();
    outbox.fail();
    await settle();
    expect(told).toEqual(["write", "self-test"]);
    platform.onNotificationsLost(() => told.push("late"));
    await settle();
    expect(told, "one that asks after the loss is told at once").toEqual(["write", "self-test", "late"]);
    const stop = platform.notificationsLostAbort();
    expect(stop.name).toBe("AbortError");
    expect(platform.stoppedByNotificationsLost(stop)).toBe(true);
    const controller = new AbortController();
    controller.abort(stop);
    expect(platform.stoppedByNotificationsLost(controller.signal)).toBe(true);
    expect(platform.stoppedByNotificationsLost(new Error("writes-held: locked"))).toBe(false);

    await reconnect(harness, new FakeOutbox(), vi.fn());
    platform.onNotificationsLost(() => told.push("next"));
    await settle();
    expect(told, "the next connection has lost nothing").toHaveLength(3);
    await platform.vdDisconnect(2);
  });

  it("leaves the followed connection alone at an older connection's disconnect", async () => {
    const { harness, outbox } = await connected();
    const seen: number[] = [];
    await platform.vdParamsSubscribe([[1, 0, 0]], (p) => seen.push(p.value));
    const [handler] = handlersOf(harness, "vd_params_subscribe");
    await platform.vdDisconnect(0);
    outbox.put(params(handler, 1));
    await settle();
    expect(seen).toEqual([1]);
  });
});

describe("command wrappers", () => {
  it("preserves command names and camelCase argument keys", async () => {
    // A connect is answered with a connection, as the shell always answers one.
    const harness = installInternals({
      // The epoch the case list disconnects, so no connection is left followed after it.
      vd_connect: { model: "URX44V", label: "URX44V", firmware: "1.5.0", epoch: 9 },
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
