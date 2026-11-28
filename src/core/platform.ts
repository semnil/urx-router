// Runtime platform bridge. Inside a Tauri window the IPC bridge is injected as
// window.__TAURI_INTERNALS__ (always present in Tauri 2) and, when withGlobalTauri
// is set, also as window.__TAURI__.core. A plain browser has neither and callers
// fall back to the download / file-input primitives in storage.ts. App-defined
// commands are not gated by Tauri capabilities, so no permission entries are
// required. Kept language-agnostic — localized dialog labels are passed in.

// A Uint8Array payload is sent as the raw IPC request body (no JSON encoding);
// options.headers then carries the string arguments (see nativeWriteBinary).
type InvokeFn = (
  cmd: string,
  args?: Record<string, unknown> | Uint8Array,
  options?: { headers: Record<string, string> },
) => Promise<unknown>;

// A Tauri IPC channel: invoke serializes it into a callback id the Rust side
// streams events back through. Only onmessage is needed here.
interface TauriChannel<T> {
  onmessage: (data: T) => void;
}
type ChannelCtor = new <T>() => TauriChannel<T>;

// Registers a JS callback and returns the numeric id the Rust side calls it by.
// Only the event plugin needs it — commands take their callbacks as Channels.
type TransformCallback = (callback: (payload: unknown) => void, once?: boolean) => number;

// The labels of the window and webview the page runs in, which the shell writes
// before any page script runs.
interface TauriMetadata {
  currentWindow?: { label?: string };
}

interface TauriGlobals {
  __TAURI_INTERNALS__?: {
    invoke?: InvokeFn;
    Channel?: ChannelCtor;
    transformCallback?: TransformCallback;
    metadata?: TauriMetadata;
  };
  __TAURI__?: { core?: { invoke?: InvokeFn; Channel?: ChannelCtor } };
}

function resolveInvoke(): InvokeFn | null {
  const w = window as unknown as TauriGlobals;
  const fn = w.__TAURI_INTERNALS__?.invoke ?? w.__TAURI__?.core?.invoke;
  return fn ?? null;
}

function newChannel<T>(onMessage: (data: T) => void): TauriChannel<T> {
  const w = window as unknown as TauriGlobals;
  const Ctor = w.__TAURI_INTERNALS__?.Channel ?? w.__TAURI__?.core?.Channel;
  if (!Ctor) throw new Error("Tauri Channel unavailable");
  const ch = new Ctor<T>();
  ch.onmessage = onMessage;
  return ch;
}

export function isTauri(): boolean {
  return resolveInvoke() !== null;
}

/** Invoke an app command; rejects when not running under Tauri. */
export function invoke<T>(
  cmd: string,
  args?: Record<string, unknown> | Uint8Array,
  options?: { headers: Record<string, string> },
): Promise<T> {
  const fn = resolveInvoke();
  if (!fn) return Promise.reject(new Error("not running under Tauri"));
  return fn(cmd, args ?? {}, options) as Promise<T>;
}

// Read a boolean launch-flag command. Always false in a plain browser / the demo,
// which has no process args to read the flag from.
function launchFlag(cmd: string): Promise<boolean> {
  if (!isTauri()) return Promise.resolve(false);
  return invoke<boolean>(cmd);
}

/**
 * Whether experimental features are enabled — the desktop app was launched with
 * --experimental. Always false in a plain browser / the demo, where the gated
 * features (live device write) cannot run anyway.
 */
export function experimentalEnabled(): Promise<boolean> {
  return launchFlag("experimental_enabled");
}

/**
 * Whether the app was launched with --self-test: run the device self-test once
 * on startup, headless (no UI interaction). Always false in a plain browser.
 */
export function selfTestRequested(): Promise<boolean> {
  return launchFlag("self_test_requested");
}

/**
 * Whether the app was launched with --prepare-modified: write a distinctive,
 * silent, modified state to the device once on startup and leave it (no restore),
 * for a scene SAVE/RECALL audit. Always false in a plain browser.
 */
export function prepareModifiedRequested(): Promise<boolean> {
  return launchFlag("prepare_modified_requested");
}

/**
 * Whether the desktop app was launched with --reset-storage. The browser dev app
 * has no process args, so there it is always false — use the ?reset URL instead
 * (see resetStorageIfRequested in main.ts).
 */
export function resetStorageRequested(): Promise<boolean> {
  return launchFlag("reset_storage_requested");
}

/**
 * The bundled third-party license notice (cargo-about HTML). Desktop only —
 * the menu entry that calls this is hidden in a plain browser.
 */
export function thirdPartyLicenses(): Promise<string> {
  return invoke<string>("third_party_licenses");
}

export interface FileFilter {
  ext: string;
  label: string;
}

/**
 * Confirm dialog that works in both environments. A Tauri webview blocks the
 * native window.confirm (and makes it async), so there we drive the dialog
 * plugin's message command (OK / Cancel, permitted by dialog:default); a plain
 * browser keeps the synchronous window.confirm, which the e2e suite relies on.
 */
export async function confirmDialog(message: string): Promise<boolean> {
  if (!isTauri()) return window.confirm(message);
  const result = await invoke<string>("plugin:dialog|message", { message, buttons: "OkCancel" });
  return result === "Ok";
}

/**
 * Error alert that works in both environments — the modal surface for an action
 * that did not complete (routine/info messages go to the in-app status line
 * instead). In a Tauri webview, drive the dialog plugin's message command (a
 * single OK button, error kind); a plain browser / demo uses window.alert.
 */
export async function errorDialog(message: string): Promise<void> {
  if (!isTauri()) {
    window.alert(message);
    return;
  }
  await invoke("plugin:dialog|message", { message, kind: "error", buttons: "Ok" });
}

/** Native save dialog (dialog plugin) → chosen path, or null if canceled / not in Tauri. */
export async function nativeSavePath(defaultName: string, filter: FileFilter): Promise<string | null> {
  if (!isTauri()) return null;
  const path = await invoke<string | null>("plugin:dialog|save", {
    options: {
      defaultPath: defaultName,
      filters: [{ name: filter.label, extensions: [filter.ext] }],
    },
  });
  return typeof path === "string" ? path : null;
}

/** Native open dialog (dialog plugin) → chosen path, or null if canceled / not in Tauri. */
export async function nativeOpenPath(filter: FileFilter): Promise<string | null> {
  if (!isTauri()) return null;
  const res = await invoke<string | string[] | null>("plugin:dialog|open", {
    options: {
      multiple: false,
      directory: false,
      filters: [{ name: filter.label, extensions: [filter.ext] }],
    },
  });
  return typeof res === "string" ? res : null;
}

export function nativeReadText(path: string): Promise<string> {
  return invoke<string>("read_text_file", { path });
}

/** Read a binary file by path (Tauri only). The bytes come back as the raw IPC
 *  response body, not a JSON number array. */
export async function nativeReadBinary(path: string): Promise<Uint8Array> {
  const buffer = await invoke<ArrayBuffer>("read_binary_file", { path });
  return new Uint8Array(buffer);
}

/**
 * Which emits an event subscription hears. `"any"` takes the event from every
 * window and from the app. `"window"` takes only what the shell aims at the window
 * this page runs in: an event the shell raises for another window (a file dragged
 * onto the MIDI control window) does not reach it.
 */
export type EventScope = "any" | "window";

/**
 * Subscribe to a Tauri webview event (the drag & drop events; commands use
 * Channels instead). Driving the event plugin directly keeps the frontend free of
 * third-party npm runtime dependencies, like the dialog and updater calls above. No-op outside
 * Tauri, where the webview delivers DOM drag & drop events instead. A `"window"`
 * subscription in a page whose window label is missing is refused rather than
 * widened to every window.
 */
export async function listenEvent<T>(
  event: string,
  handler: (payload: T) => void,
  scope: EventScope = "any",
): Promise<void> {
  const internals = (window as unknown as TauriGlobals).__TAURI_INTERNALS__;
  const transformCallback = internals?.transformCallback;
  if (!transformCallback) return;
  let target: { kind: "Any" } | { kind: "WebviewWindow"; label: string } = { kind: "Any" };
  if (scope === "window") {
    const label = internals?.metadata?.currentWindow?.label;
    if (typeof label !== "string" || label === "") throw new Error("event: the page's window label is unknown");
    target = { kind: "WebviewWindow", label };
  }
  const id = transformCallback((message) => handler((message as { payload: T }).payload));
  await invoke<number>("plugin:event|listen", { event, target, handler: id });
}

/** The event a macOS Edit menu click arrives on; the payload is the item id. */
export const EDIT_MENU_EVENT = "menu://edit";
export const EDIT_UNDO_ID = "edit-undo";
export const EDIT_REDO_ID = "edit-redo";

/** Reflect the undo / redo depth onto the application menu's Undo / Redo items. A
 *  no-op where there is no menu (every platform but macOS). */
export function setEditMenuState(canUndo: boolean, canRedo: boolean): Promise<void> {
  return invoke<void>("set_edit_menu_state", { canUndo, canRedo });
}

/** Label those items, so they follow the app's language like the rest of the UI. */
export function setEditMenuLabels(undo: string, redo: string): Promise<void> {
  return invoke<void>("set_edit_menu_labels", { undo, redo });
}

export function nativeWriteText(path: string, contents: string): Promise<void> {
  return invoke<void>("write_text_file", { path, contents });
}

export function nativeWriteBinary(path: string, bytes: Uint8Array): Promise<void> {
  // The bytes travel as the raw IPC request body — a JSON argument would
  // serialize a multi-MB image byte-by-byte as a number array. The destination
  // path rides in a header, percent-encoded because raw header values must stay
  // ASCII while paths can hold non-ASCII characters.
  return invoke<void>("write_binary_file", bytes, {
    headers: { "x-file-path": encodeURIComponent(path) },
  });
}

// Live hardware control (desktop only). The Rust vd module owns the WebSocket to
// the Device Center broker and keeps the device GUID server-side; the frontend
// connects, sets parameters by (param_id, x, y, value), and disconnects. Every
// call rejects in a plain browser (not running under Tauri).

export interface DeviceSummary {
  model: string;
  label: string;
  /** The unit's System firmware version. Empty when the device answered but
   *  reports none (the mismatch check is then skipped by design); null when the
   *  read itself did not land, so the version is unknown rather than absent and
   *  the caller must not proceed on a gate it could not evaluate. */
  firmware: string | null;
}

/** A freshly opened connection: the device plus the generation (epoch) the Rust
 * side assigned it. Hand `epoch` back to vdDisconnect so a delayed teardown of an
 * earlier session can only close the exact connection it was opened for. */
export interface Connection extends DeviceSummary {
  epoch: number;
}

/** Connect to the URX via the broker; resolves with the connected device + epoch.
 *  `model` is the model selected in the app: with more than one unit online it picks
 *  the one to connect to, and a choice it cannot make rejects with
 *  `multiple-devices`. */
export function vdConnect(model: string): Promise<Connection> {
  return invoke<Connection>("vd_connect", { model }).then((connection) => {
    beginConnection(connection.epoch);
    return connection;
  });
}

/** One run the shell routed (vd.rs `Run`): one subscription's updates, in the order it received them. */
type RawRun =
  | { kind: "meters"; handler: number; updates: RawMeterUpdate[] }
  | { kind: "params" | "probe"; handler: number; updates: RawParamUpdate[] };

type RunKind = RawRun["kind"];

/** The code a live session ends with, and every later write on the connection is refused with, when
 *  the page could not fetch its notifications: a change the unit announced — a Console Lock among
 *  them — may not have reached the app, so what follows it can no longer be followed. */
export const NOTIFICATIONS_LOST = "notifications-lost";

/** How long a fetch of the notifications may take before the connection counts them as lost: the
 *  shell answers within its one-second wait, so one this late is not coming. */
export const NOTIFICATION_FETCH_DEADLINE_MS = 5_000;

// The connection whose notifications the page fetches, by its epoch; null while none is connected.
let connectionEpoch: number | null = null;
// Each subscription's handler, by the number the page gave it. Kept until its kind is unsubscribed or
// the connection ends: the shell goes on routing what a replaced subscription had queued (vd.rs `Route`).
const handlers = new Map<number, { readonly kind: RunKind; readonly deliver: (updates: unknown[]) => void }>();
let nextHandler = 1;
// The epoch the fetch loop is running for, if one is.
let fetching: number | null = null;
// The connection whose notifications could not be fetched: nothing more is written on it, and the
// loop does not start again for it.
let lostEpoch: number | null = null;
// The number of the fetch the loop has outstanding, and who waits for a later one to be handed on
// (`handedOn`).
let fetchInFlight = 0;
// The number of the last fetch the loop handed on, on the current connection.
let handedOnSeq = -1;
const handOnWaiters: Array<{ readonly after: number; readonly resolve: () => void }> = [];

/** Lets go every hand-on waiter whose fetch has been handed on — all of them once the loop stops. */
function releaseHandOns(handedOn: number): void {
  if (Number.isFinite(handedOn)) handedOnSeq = handedOn;
  for (let i = handOnWaiters.length - 1; i >= 0; i--) {
    const waiter = handOnWaiters[i];
    if (waiter.after <= handedOn) {
      handOnWaiters.splice(i, 1);
      waiter.resolve();
    }
  }
}

/** Settles once the fetch numbered `fetch` of the connection of generation `epoch` has been handed on
 *  to its handlers — at once if it already has, and without a number once one that starts after this
 *  call has — and at once when no loop is fetching, or when that connection is not the one followed:
 *  another connection's fetches carry nothing of it. And when the loop stops. */
function handedOn(fetch: number | undefined, epoch: number | null): Promise<void> {
  if (epoch !== connectionEpoch || fetching === null || (fetch !== undefined && fetch <= handedOnSeq)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => handOnWaiters.push({ after: fetch ?? fetchInFlight + 1, resolve }));
}
// The current session's link watch: a fetch that fails ends the session through it, as the shell's
// report of a link that ended does. Cleared with the connection.
let linkDropped: ((reason: string) => void) | null = null;

function beginConnection(epoch: number): void {
  connectionEpoch = epoch;
  handedOnSeq = -1;
  lossListeners.clear();
  handlers.clear();
  fetching = null;
  lostEpoch = null;
  linkDropped = null;
  releaseHandOns(Infinity);
}

/** A handler for a subscription of `kind`, with the fetch loop running for the connection. */
function register(kind: RunKind, deliver: (updates: unknown[]) => void): number {
  const handler = nextHandler;
  nextHandler += 1;
  handlers.set(handler, { kind, deliver });
  startFetching();
  return handler;
}

function forget(kind: RunKind): void {
  for (const [handler, entry] of handlers) if (entry.kind === kind) handlers.delete(handler);
}

// Who stops when the current connection loses its notifications (`onNotificationsLost`).
const lossListeners = new Set<() => void>();

/** The connection lost its notifications: nothing more is written on it, its session ends, and every
 *  operation that asked (`onNotificationsLost`) is told. */
function notificationsLost(epoch: number): void {
  fetching = null;
  lostEpoch = epoch;
  releaseHandOns(Infinity);
  linkDropped?.(NOTIFICATIONS_LOST);
  const told = [...lossListeners];
  lossListeners.clear();
  for (const listener of told) listener();
}

/**
 * Tell `listener` when the current connection loses its notifications — at once (on a later
 * microtask) if it already has — so an operation running on it stops with that cause, as the link
 * watch ends a live session. Returns the removal; the next connection forgets every listener.
 */
export function onNotificationsLost(listener: () => void): () => void {
  if (writesLost()) {
    queueMicrotask(listener);
    return () => {};
  }
  lossListeners.add(listener);
  return () => void lossListeners.delete(listener);
}

/** The stop an operation is aborted with when its connection lost its notifications: an
 *  `AbortError`, so every abort path takes it, that `stoppedByNotificationsLost` tells apart. */
export function notificationsLostAbort(): Error {
  const err = new Error(`${NOTIFICATIONS_LOST}: the changes the unit announced could not be fetched`);
  err.name = "AbortError";
  return err;
}

/** Whether `cause` — an error, its message, or an aborted signal's reason — is the loss of the
 *  connection's notifications. */
export function stoppedByNotificationsLost(cause: unknown): boolean {
  if (cause instanceof AbortSignal) return cause.aborted && stoppedByNotificationsLost(cause.reason);
  const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return message.startsWith(`${NOTIFICATIONS_LOST}:`);
}

/** The prefix the shell puts on the failure of a write the transport never sent (vd.rs
 *  `NOT_SENT`). `vdSet` and `vdSetStr` take it off and mark the error (`notSent`), so the message
 *  reads as it did. */
export const NOT_SENT = "not-sent";

/** Whether `cause` — a write's error or its message — is a write that did not reach the unit: one
 *  the transport never sent (marked `notSent`), or one the page or the shell refused before sending
 *  it, for the unit's Console Lock (`WRITES_HELD`) or the connection's lost notifications
 *  (`NOTIFICATIONS_LOST`). */
export function refusedBeforeSending(cause: unknown): boolean {
  if (cause instanceof Error && (cause as { notSent?: unknown }).notSent === true) return true;
  const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return message.startsWith(`${WRITES_HELD}:`) || message.startsWith(`${NOTIFICATIONS_LOST}:`);
}

/** A write's failure with the shell's `NOT_SENT` taken off its message and marked `notSent`. */
function markUnsent<T>(write: Promise<T>): Promise<T> {
  return write.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith(`${NOT_SENT}: `)) throw error;
    throw Object.assign(new Error(message.slice(NOT_SENT.length + 2)), { notSent: true });
  });
}

/** Rejects with `NOTIFICATIONS_LOST` once `NOTIFICATION_FETCH_DEADLINE_MS` has passed. */
function fetchDeadline(): { readonly passed: Promise<never>; clear(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const passed = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(NOTIFICATIONS_LOST)), NOTIFICATION_FETCH_DEADLINE_MS);
  });
  return { passed, clear: () => clearTimeout(timer) };
}

/**
 * Fetches the connection's notifications with one request outstanding at a time and hands each run to
 * its subscription's handler, so they arrive in the order the shell received them and once each — where
 * notifications pushed over Tauri channels could arrive out of order across channels, and one lost
 * inside a channel held back every one after it unseen. The fetches are numbered from 0 on each
 * connection: asking for the next number acknowledges the last answer, and the shell answers a resend
 * of a number (Tauri's, when its custom protocol fails over to `postMessage`) with that number's answer.
 * A fetch that fails, or takes longer than `NOTIFICATION_FETCH_DEADLINE_MS`, loses the connection's
 * notifications (`notificationsLost`); the shell answering null means the connection is over.
 */
function startFetching(): void {
  const epoch = connectionEpoch;
  if (epoch === null || fetching === epoch || lostEpoch === epoch) return;
  fetching = epoch;
  void (async () => {
    let seq = 0;
    while (fetching === epoch) {
      fetchInFlight = seq;
      let runs: RawRun[] | null;
      const deadline = fetchDeadline();
      try {
        runs = await Promise.race([invoke<RawRun[] | null>("vd_notifications", { epoch, seq }), deadline.passed]);
      } catch {
        if (fetching === epoch) notificationsLost(epoch);
        return;
      } finally {
        deadline.clear();
      }
      if (fetching !== epoch) return;
      if (runs === null) {
        fetching = null;
        releaseHandOns(Infinity);
        return;
      }
      for (const run of runs) {
        // One handler that throws does not stop the others, nor the loop.
        try {
          handlers.get(run.handler)?.deliver(run.updates);
        } catch (error) {
          console.error(error);
        }
      }
      releaseHandOns(seq);
      seq += 1;
    }
  })();
}

/** The code a write refused by `holdDeviceWrites` rejects with. A prefix, as the shell's own
 *  codes are, so a reader of an error message tells it apart without holding the error. */
export const WRITES_HELD = "writes-held";

// Whether every write is refused before it reaches the link: set while the app knows the unit is
// under Console Lock (core/control/console-lock.ts). The one place every write passes, so a
// writer the lock handling does not name still sends nothing.
let writesHeld = false;

/** Refuse every vdSet / vdSetStr from here (true) or let them through again (false). */
export function holdDeviceWrites(held: boolean): void {
  writesHeld = held;
}

/** Whether writes are being refused (`holdDeviceWrites`). */
export function deviceWritesHeld(): boolean {
  return writesHeld;
}

const heldWrite = (): Promise<never> =>
  Promise.reject(new Error(`${WRITES_HELD}: the unit is under Console Lock, so the app sends it nothing`));

/** Whether the current connection lost its notifications, so that nothing more may be written on it. */
const writesLost = (): boolean => lostEpoch !== null && lostEpoch === connectionEpoch;

const lostWrite = (): Promise<never> =>
  Promise.reject(
    new Error(`${NOTIFICATIONS_LOST}: a change the unit announced may not have reached the app, so nothing is written`),
  );

/**
 * A write the shell refused because the unit announced Console Lock (vd.rs `Outbox::lock_hold`),
 * which it does until the unit announces the lock off: the refusal is passed on once the page has
 * handed on the fetch the shell names as the one carrying the announcement — at once when it already
 * has, and when the shell names none, once a fetch that starts after the refusal has been — so
 * whoever handles the refusal finds the lock already taken, as it does with the page's own refusal
 * (`heldWrite`).
 */
function shellHeld<T>(write: Promise<T>): Promise<T> {
  // The connection the write goes out on: the fetch the refusal names is one of its own.
  const epoch = connectionEpoch;
  return write.catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith(`${WRITES_HELD}:`)) {
      const fetch = /\(fetch (\d+)\)$/.exec(message)?.[1];
      await handedOn(fetch === undefined ? undefined : Number(fetch), epoch);
    }
    throw error;
  });
}

/** The connection the page follows, by its generation, or null while none is (`vdConnect`). */
export function connectedEpoch(): number | null {
  return connectionEpoch;
}

/**
 * Whether the page refuses every write before it reaches the link (`vdSet`'s own holds): the
 * connection lost its notifications, or the app knows the unit is under Console Lock. The control
 * package's transport refuses its writes on the same holds (`package-transport.ts`).
 */
export function deviceWritesRefused(): boolean {
  return writesLost() || writesHeld;
}

/**
 * Settles once the page has handed on the fetch numbered `fetch` of the connection of generation
 * `epoch` (`handedOn`): what a write the shell held for Console Lock waits for before its refusal is
 * passed on (`shellHeld`), so whoever handles it finds the lock already taken. With no number, once a
 * fetch that starts after this call has been handed on; at once once that connection is not the one
 * followed.
 */
export function untilHandedOn(fetch: number | undefined, epoch: number): Promise<void> {
  return handedOn(fetch, epoch);
}

/** Set one parameter instance to an absolute broker value. */
export function vdSet(paramId: number, x: number, y: number, value: number): Promise<void> {
  if (writesLost()) return lostWrite();
  if (writesHeld) return heldWrite();
  return shellHeld(markUnsent(invoke<void>("vd_set", { paramId, x, y, value })));
}

/** Read one parameter instance's current absolute broker value. */
export function vdGet(paramId: number, x: number, y: number): Promise<number> {
  return invoke<number>("vd_get", { paramId, x, y });
}

/** Set one string-valued parameter instance (e.g. a CH SETTING name). */
export function vdSetStr(paramId: number, x: number, y: number, value: string): Promise<void> {
  if (writesLost()) return lostWrite();
  if (writesHeld) return heldWrite();
  return shellHeld(markUnsent(invoke<void>("vd_set_str", { paramId, x, y, value })));
}

/** Read one string-valued parameter instance (empty when it holds no string). */
export function vdGetStr(paramId: number, x: number, y: number): Promise<string> {
  return invoke<string>("vd_get_str", { paramId, x, y });
}

/** One live level-meter reading from the device. `value` is the broker's raw
 * meter value (deci-dBFS; 32767 = OVER), decoded by core/meters.ts. */
export interface MeterUpdate {
  meterId: number;
  x: number;
  value: number;
}

// The Rust side streams MeterUpdate with snake_case fields (serde default).
interface RawMeterUpdate {
  meter_id: number;
  x: number;
  value: number;
}

/**
 * Subscribe to live level meters; readings stream through onUpdate at ~10 Hz.
 * `addrs` is a list of [meterId, x] pairs. Replaces any prior subscription.
 * Returns an unsubscribe function. No-op (returns a noop) outside Tauri.
 */
export async function vdMetersSubscribe(
  addrs: Array<[number, number]>,
  onUpdate: (m: MeterUpdate) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  // A run carries a delivered batch's readings for this subscription; fan it back out here.
  const handler = register("meters", (batch) => {
    for (const d of batch as RawMeterUpdate[]) onUpdate({ meterId: d.meter_id, x: d.x, value: d.value });
  });
  // Awaited: bars stuck on the floor read as "no signal" and send the operator
  // chasing gain that was never the problem, so a failed registration is surfaced
  // rather than left to look like silence.
  await invoke<void>("vd_meters_subscribe", { addrs, handler });
  return () => {
    forget("meters");
    void invoke<void>("vd_meters_unsubscribe").catch(() => {});
  };
}

/** One device-originated parameter change: a `notify` on a registered address.
 * `value` is the same raw broker integer vdGet returns, decoded by control/vd.ts. */
export interface ParamUpdate {
  paramId: number;
  x: number;
  y: number;
  value: number;
  /** Present only for a STRING notify — the name parameters, whose `current_value`
   *  is text. Numeric notifies omit it (the Rust side skips the field), so a reader
   *  that only understands numbers is unaffected. */
  valueStr?: string;
}

// The Rust side streams ParamUpdate with snake_case fields (serde default).
interface RawParamUpdate {
  param_id: number;
  x: number;
  y: number;
  value: number;
  /** Snake_case like its neighbours: the Rust struct deliberately carries NO blanket
   *  camelCase rename, because one would also rename `param_id` and break the numeric
   *  path in a way no test that skips serde could see. */
  value_str?: string;
}

/**
 * Subscribe to device-side parameter changes; notifies stream through onUpdate
 * as the device's own controls (LCD / physical) are moved. `addrs` is a list of
 * [paramId, x, y] triples. Replaces any prior subscription. Returns an
 * unsubscribe function. No-op (returns a noop) outside Tauri.
 */
export async function vdParamsSubscribe(
  addrs: Array<[number, number, number]>,
  onUpdate: (p: ParamUpdate) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const handler = register("params", paramHandler(onUpdate));
  // Awaited, not fire-and-forget: a failed registration leaves the app blind to
  // device-side edits, and the next converge would then write the plan's stale
  // values back over them. The caller stops rather than running half-deaf.
  await invoke<void>("vd_params_subscribe", { addrs, handler });
  return () => {
    forget("params");
    void invoke<void>("vd_params_unsubscribe").catch(() => {});
  };
}

// A run carries a delivered batch's notifies for one subscription (a device-side sweep
// arrives as one), so fan it back out into per-notify callbacks here.
function paramHandler(onUpdate: (p: ParamUpdate) => void) {
  return (batch: unknown[]): void => {
    for (const d of batch as RawParamUpdate[]) {
      onUpdate({ paramId: d.param_id, x: d.x, y: d.y, value: d.value, valueStr: d.value_str });
    }
  };
}

/**
 * Register the dev build's parameter watch (`ui/param-watch.ts`) on the held-open
 * connection: a subscription of its own beside `vdParamsSubscribe`'s, so the addresses
 * it names never reach the follow layer. Lasts until the connection closes — there is
 * no unsubscribe. Rejects in a release binary, which refuses the command.
 */
export async function vdProbeSubscribe(
  addrs: Array<[number, number, number]>,
  onUpdate: (p: ParamUpdate) => void,
): Promise<void> {
  await invoke<void>("vd_probe_subscribe", { addrs, handler: register("probe", paramHandler(onUpdate)) });
}

// The Rust side streams LinkEvent with snake_case fields (serde default).
interface RawLinkEvent {
  reason: string;
}

/**
 * Watch the held-open live connection for an idle drop: `onDrop` fires once if
 * the worker loses the broker link while no command is in flight, so a live
 * session does not silently freeze. The channel dies with the worker on
 * disconnect, so no explicit unwatch is needed. No-op outside Tauri.
 */
export async function vdWatchLink(onDrop: (reason: string) => void): Promise<void> {
  if (!isTauri()) return;
  const channel = newChannel<RawLinkEvent>((d) => onDrop(d.reason));
  // A fetch of the notifications that fails ends the session the same way — one that failed before
  // this watch was registered as well.
  linkDropped = onDrop;
  if (writesLost()) queueMicrotask(() => onDrop(NOTIFICATIONS_LOST));
  // Awaited: without this watch an idle link drop surfaces as a frozen session
  // (tally lit, meters stopped) instead of a teardown, so a failure here has to
  // stop the session rather than start one that cannot notice its own death.
  await invoke<void>("vd_watch_link", { channel });
}

/** Close the connection opened with generation `epoch` (no-op if a newer connect
 * already replaced it, or none is connected). */
export function vdDisconnect(epoch: number): Promise<void> {
  // Only the connection being followed: a late disconnect of an older one leaves it alone.
  if (epoch === connectionEpoch) {
    connectionEpoch = null;
    fetching = null;
    lostEpoch = null;
    handlers.clear();
    linkDropped = null;
    lossListeners.clear();
    releaseHandOns(Infinity);
  }
  return invoke<void>("vd_disconnect", { epoch });
}

/** What the current connection has asked of the broker, and what the broker failed
 *  to answer. Counts, over one connection; all zero when nothing is connected. */
export interface LinkStats {
  sets: number;
  gets: number;
  paramSubscribes: number;
  meterSubscribes: number;
  registFrames: number;
  unregistFrames: number;
  deadlines: number;
  /** The CURRENT consecutive-deadline run, not a total — the distance to the stall
   *  that ends the session, back to zero as soon as the broker answers anything. */
  stalled: number;
}

// The Rust side serializes LinkStats with snake_case fields (serde default).
interface RawLinkStats {
  sets: number;
  gets: number;
  param_subscribes: number;
  meter_subscribes: number;
  regist_frames: number;
  unregist_frames: number;
  deadlines: number;
  stalled: number;
}

/**
 * Read the link ledger. Resolves with null outside Tauri, where there is no link to
 * have a ledger. Cheap by construction on the Rust side (atomics, no command queue),
 * so a caller may poll it — but it is still an IPC round trip, so not per frame.
 */
export async function vdLinkStats(): Promise<LinkStats | null> {
  if (!isTauri()) return null;
  const s = await invoke<RawLinkStats>("vd_link_stats");
  return {
    sets: s.sets,
    gets: s.gets,
    paramSubscribes: s.param_subscribes,
    meterSubscribes: s.meter_subscribes,
    registFrames: s.regist_frames,
    unregistFrames: s.unregist_frames,
    deadlines: s.deadlines,
    stalled: s.stalled,
  };
}

/**
 * Append one line to the link ledger log in the app's log directory; resolves with
 * the file's path. Rejects outside Tauri (the browser build never calls it).
 */
export function appendLinkLog(line: string): Promise<string> {
  return invoke<string>("append_link_log", { line });
}

/**
 * Append a batch of MIDI trace records to the dev build's trace log; resolves with the
 * file's path. A batch rather than a line because these arrive per MIDI message.
 *
 * Rejects outside Tauri (like `appendLinkLog`, through `invoke`'s own refusal), and
 * rejects in a release binary — the shell gates the command on `debug_assertions`, which
 * is what makes "the dev app only" true of the SHELL and not just of the bundle.
 */
export function appendMidiLog(lines: string[]): Promise<string> {
  return invoke<string>("append_midi_log", { lines });
}

/**
 * Append a batch of parameter-watch records to the dev build's `param-watch.jsonl`;
 * resolves with the file's path. Rejects outside Tauri and in a release binary, like
 * `appendMidiLog`.
 */
export function appendWatchLog(lines: string[]): Promise<string> {
  return invoke<string>("append_watch_log", { lines });
}

/** Which build is running, for a record that outlives it. `tauri dev` and the
 *  installed app write to the same ledger — the path comes from the bundle
 *  identifier, which does not vary by profile — so the lines have to say.
 *
 *  Only the build kind crosses IPC; the version is a compile-time import. */
export function appBuildKind(): Promise<"dev" | "release"> {
  return invoke<"dev" | "release">("app_build_kind");
}

// External MIDI control (desktop only). The Rust midi module owns the open
// input/output connections; the frontend opens a port by name, receives raw
// message bytes through a channel, and sends feedback bytes back out.

// The Rust side streams MidiMessage batches (one per burst — see midi.rs).
interface RawMidiMessage {
  bytes: number[];
}

/** Names of the attached MIDI input ports (re-enumerated per call; the name is
 * the port id passed to midiOpenInput). Empty outside Tauri. */
export function midiListInputs(): Promise<string[]> {
  if (!isTauri()) return Promise.resolve([]);
  return invoke<string[]>("midi_list_inputs");
}

/** Names of the attached MIDI output ports. Empty outside Tauri. */
export function midiListOutputs(): Promise<string[]> {
  if (!isTauri()) return Promise.resolve([]);
  return invoke<string[]>("midi_list_outputs");
}

/**
 * The ports the shell actually has open, `[input, output]`. The frontend's own
 * record of the chosen ports is a claim it cannot check from the page — a
 * connection closed natively (the page-load teardown in lib.rs) leaves it naming
 * a port nothing is listening on — and this is what makes that claim falsifiable.
 * Both null outside Tauri.
 */
export function midiOpenPorts(): Promise<[string | null, string | null]> {
  if (!isTauri()) return Promise.resolve([null, null]);
  return invoke<[string | null, string | null]>("midi_open_ports");
}

/**
 * Open a MIDI input port and stream each raw message through onMessage.
 * Replaces any previously open input. Rejects when the port is gone. Returns a
 * close function, settled once the shell has answered the close. No-op (resolved
 * noop) outside Tauri.
 */
export async function midiOpenInput(port: string, onMessage: (bytes: number[]) => void): Promise<() => Promise<void>> {
  if (!isTauri()) return () => Promise.resolve();
  // Rust batches a controller burst into one channel message; fan it back out.
  const channel = newChannel<RawMidiMessage[]>((batch) => {
    for (const m of batch) onMessage(m.bytes);
  });
  await invoke<void>("midi_open_input", { port, channel });
  return midiCloseInput;
}

/** Close whatever input the shell holds, with no closer in hand.
 *
 *  `midi_close_input` takes no argument — it closes the held slot — so holding a
 *  closer function buys nothing, and CONDITIONING the close on holding one is a real
 *  gap: after `reconcileOpenPorts` adopts a port the shell already had, there is no
 *  closer, and the operator's next "None" then closed nothing at all. The select said
 *  None while the shell kept delivering into the engine.
 *
 *  Settles once the shell has answered, and never rejects: what waits on it is the next
 *  command, which must not reach the shell before this one has been taken. */
export function midiCloseInput(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return invoke<void>("midi_close_input").catch(() => {});
}

// ---- MIDI control window -------------------------------------------------
// The MIDI panel is a window of its own, and a view: it holds no plan and opens no
// port, so everything crosses this relay. Both directions are Channels rather than
// events — that keeps the traffic inside `invoke`, so the second window needs no
// capability beyond core, and it matches how the meter / param / MIDI-input streams
// already reach the frontend. The payload is JSON both frontends encode themselves;
// the Rust side is the wire, not a participant.

/** Open the MIDI control window, or raise it when it is already up. Only the title
 *  crosses: it is localized, and where the window sits is the shell's to remember. */
export function openMidiWindow(title: string): Promise<void> {
  return invoke<void>("open_midi_window", { title });
}

export function closeMidiWindow(): Promise<void> {
  return invoke<void>("close_midi_window");
}

/** Raise the MIDI window: called when learn turns on, so the panel comes forward
 *  for the moment it matters even if another application is covering the app. */
export function focusMidiWindow(): Promise<void> {
  return invoke<void>("focus_midi_window");
}

/** Keep the MIDI window above everything while learn is armed, and stop when it
 *  disarms. Narrow on purpose: it floats above other applications too, which is
 *  acceptable for the seconds an arming lasts and not as a standing state. The
 *  alternative — raising it whenever the main window is focused — was implemented
 *  and did not work (midiwin.rs `pin_midi_window` says why). */
export function pinMidiWindow(on: boolean): Promise<void> {
  return invoke<void>("pin_midi_window", { on });
}

/** Whether the MIDI window is up. The shell is the only side that knows: the window
 *  outlives a reload of this page and announces itself only on its own boot. */
export function midiWindowOpen(): Promise<boolean> {
  return invoke<boolean>("midi_window_open");
}

/** Register the main window's receiver for the MIDI window's intents. */
export function midiUiAttachMain(onIntent: (payload: string) => void): Promise<void> {
  return invoke<void>("midi_ui_attach_main", { channel: newChannel<string>(onIntent) });
}

/** Register the MIDI window's receiver for the main window's state. */
export function midiUiAttachWindow(onState: (payload: string) => void): Promise<void> {
  return invoke<void>("midi_ui_attach_window", { channel: newChannel<string>(onState) });
}

/** Main → MIDI window. A send with no window listening is a no-op, not an error:
 *  the window may have just closed, and the next attach re-sends the whole state. */
export function midiUiToWindow(payload: string): Promise<void> {
  return invoke<void>("midi_ui_to_window", { payload });
}

/** MIDI window → main. */
export function midiUiToMain(payload: string): Promise<void> {
  return invoke<void>("midi_ui_to_main", { payload });
}

/** Open a MIDI output port for controller feedback (motor faders / LEDs).
 * Replaces any previously open output. Rejects when the port is gone. */
export function midiOpenOutput(port: string): Promise<void> {
  return invoke<void>("midi_open_output", { port });
}

/** Close the feedback output port, if one is open. */
export function midiCloseOutput(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return invoke<void>("midi_close_output").catch(() => {});
}

/** Send one raw message out of the open feedback port. */
export function midiSend(bytes: number[]): Promise<void> {
  return invoke<void>("midi_send", { bytes });
}

/** Hold off (or release) the computer's idle sleep — system and display. Rejects
 * when the OS refuses, and outside Tauri, so the caller can keep the stored
 * preference and the actual hold in step. */
export function setKeepAwake(on: boolean): Promise<void> {
  return invoke<void>("set_keep_awake", { on });
}

// Auto-update (desktop only, via the updater/process plugins). These mirror the
// official @tauri-apps/plugin-updater bindings but call invoke directly so the
// frontend keeps zero third-party npm runtime dependencies, like the dialog calls above.

export interface UpdateInfo {
  /** Resource id of the pending update, passed back to download_and_install. */
  rid: number;
  version: string;
  currentVersion: string;
  date?: string;
  body?: string;
}

export type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

/** How long an update check may take before it fails. The updater plugin sets
 *  no default request timeout, and a check whose response is lost on the
 *  network then never settles — which would leave any await on it, and the UI
 *  state behind it, pending permanently. */
const UPDATE_CHECK_TIMEOUT_MS = 10_000;

/** Ask the updater for a newer release. Returns null in a plain browser or when
 * already up to date; rejects (within the timeout) instead of hanging. */
export async function checkUpdate(): Promise<UpdateInfo | null> {
  if (!isTauri()) return null;
  return invoke<UpdateInfo | null>("plugin:updater|check", { timeout: UPDATE_CHECK_TIMEOUT_MS });
}

/** The whole download's deadline, from the request starting to the last byte of the bundle:
 *  the updater plugin's request timeout is a total one, and the update a check returns carries
 *  none of its own, so a download whose response stalls is otherwise never settled. A deadline
 *  rather than an idle bound, so it is set for a slow link carrying the whole bundle. */
const UPDATE_DOWNLOAD_TIMEOUT_MS = 600_000;

/** Download and install a pending update, reporting progress. The app must be
 * restarted afterwards (see restartApp) for the new bundle to take effect. Rejects
 * when the download outlives UPDATE_DOWNLOAD_TIMEOUT_MS. */
export function installUpdate(rid: number, onProgress?: (e: DownloadEvent) => void): Promise<void> {
  const channel = newChannel<DownloadEvent>(onProgress ?? (() => {}));
  return invoke<void>("plugin:updater|download_and_install", {
    onEvent: channel,
    rid,
    timeout: UPDATE_DOWNLOAD_TIMEOUT_MS,
  });
}

/** What the app's own exit puts on disk and closes, done ahead of an install: the window
 *  geometry and its scales are saved, and the broker session is closed. On Windows the
 *  updater ends the process from inside the install, past the shell's own exit handler. */
export function prepareForExit(): Promise<void> {
  return invoke<void>("prepare_for_exit");
}

/** Restart the app (process plugin) to launch the freshly installed bundle. */
export function restartApp(): Promise<never> {
  return invoke<never>("plugin:process|restart");
}

/** Quit the app (process plugin). Used when the first-run consent is declined. */
export function exitApp(code = 0): Promise<never> {
  return invoke<never>("plugin:process|exit", { code });
}
