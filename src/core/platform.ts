// Runtime platform bridge. Inside a Tauri window the IPC bridge is injected as
// window.__TAURI_INTERNALS__ (always present in Tauri 2) and, when withGlobalTauri
// is set, also as window.__TAURI__.core. A plain browser has neither and callers
// fall back to the download / file-input primitives in storage.ts. App-defined
// commands are not gated by Tauri capabilities, so no permission entries are
// required. Kept language-agnostic — localized dialog labels are passed in.

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

// A Tauri IPC channel: invoke serializes it into a callback id the Rust side
// streams events back through. Only onmessage is needed here.
interface TauriChannel<T> {
  onmessage: (data: T) => void;
}
type ChannelCtor = new <T>() => TauriChannel<T>;

interface TauriGlobals {
  __TAURI_INTERNALS__?: { invoke?: InvokeFn; Channel?: ChannelCtor };
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
export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const fn = resolveInvoke();
  if (!fn) return Promise.reject(new Error("not running under Tauri"));
  return fn(cmd, args ?? {}) as Promise<T>;
}

/**
 * Whether experimental features are enabled — the desktop app was launched with
 * --experimental. Always false in a plain browser / the demo, where the gated
 * features (live device write) cannot run anyway.
 */
export function experimentalEnabled(): Promise<boolean> {
  if (!isTauri()) return Promise.resolve(false);
  return invoke<boolean>("experimental_enabled");
}

/**
 * Whether the app was launched with --self-test: run the device self-test once
 * on startup, headless (no UI interaction). Always false in a plain browser.
 */
export function selfTestRequested(): Promise<boolean> {
  if (!isTauri()) return Promise.resolve(false);
  return invoke<boolean>("self_test_requested");
}

/**
 * Whether the desktop app was launched with --reset-storage. The browser dev app
 * has no process args, so there it is always false — use the ?reset URL instead
 * (see resetStorageIfRequested in main.ts).
 */
export function resetStorageRequested(): Promise<boolean> {
  if (!isTauri()) return Promise.resolve(false);
  return invoke<boolean>("reset_storage_requested");
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

export function nativeWriteText(path: string, contents: string): Promise<void> {
  return invoke<void>("write_text_file", { path, contents });
}

export function nativeWriteBinary(path: string, bytes: Uint8Array): Promise<void> {
  return invoke<void>("write_binary_file", { path, bytes: Array.from(bytes) });
}

// Live hardware control (desktop only). The Rust vd module owns the WebSocket to
// the Device Center broker and keeps the device GUID server-side; the frontend
// connects, sets parameters by (param_id, x, y, value), and disconnects. Every
// call rejects in a plain browser (not running under Tauri).

export interface DeviceSummary {
  model: string;
  label: string;
  /** The unit's System firmware version, or empty when the device reports none. */
  firmware: string;
}

/** A freshly opened connection: the device plus the generation (epoch) the Rust
 * side assigned it. Hand `epoch` back to vdDisconnect so a delayed teardown of an
 * earlier session can only close the exact connection it was opened for. */
export interface Connection extends DeviceSummary {
  epoch: number;
}

/** Connect to the URX via the broker; resolves with the connected device + epoch. */
export function vdConnect(): Promise<Connection> {
  return invoke<Connection>("vd_connect");
}

/** The currently connected device (rejects if not connected). */
export function vdInfo(): Promise<DeviceSummary> {
  return invoke<DeviceSummary>("vd_info");
}

/** Set one parameter instance to an absolute broker value. */
export function vdSet(paramId: number, x: number, y: number, value: number): Promise<void> {
  return invoke<void>("vd_set", { paramId, x, y, value });
}

/** Read one parameter instance's current absolute broker value. */
export function vdGet(paramId: number, x: number, y: number): Promise<number> {
  return invoke<number>("vd_get", { paramId, x, y });
}

/** Set one string-valued parameter instance (e.g. a CH SETTING name). */
export function vdSetStr(paramId: number, x: number, y: number, value: string): Promise<void> {
  return invoke<void>("vd_set_str", { paramId, x, y, value });
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
export function vdMetersSubscribe(
  addrs: Array<[number, number]>,
  onUpdate: (m: MeterUpdate) => void,
): () => void {
  if (!isTauri()) return () => {};
  // Rust batches each pump cycle's readings into one channel message, so the IPC
  // boundary is crossed ~30×/s instead of per reading; fan the batch back out here.
  const channel = newChannel<RawMeterUpdate[]>((batch) => {
    for (const d of batch) onUpdate({ meterId: d.meter_id, x: d.x, value: d.value });
  });
  void invoke<void>("vd_meters_subscribe", { addrs, channel });
  return () => void invoke<void>("vd_meters_unsubscribe").catch(() => {});
}

/** One device-originated parameter change: a `notify` on a registered address.
 * `value` is the same raw broker integer vdGet returns, decoded by control/vd.ts. */
export interface ParamUpdate {
  paramId: number;
  x: number;
  y: number;
  value: number;
}

// The Rust side streams ParamUpdate with snake_case fields (serde default).
interface RawParamUpdate {
  param_id: number;
  x: number;
  y: number;
  value: number;
}

/**
 * Subscribe to device-side parameter changes; notifies stream through onUpdate
 * as the device's own controls (LCD / physical) are moved. `addrs` is a list of
 * [paramId, x, y] triples. Replaces any prior subscription. Returns an
 * unsubscribe function. No-op (returns a noop) outside Tauri.
 */
export function vdParamsSubscribe(
  addrs: Array<[number, number, number]>,
  onUpdate: (p: ParamUpdate) => void,
): () => void {
  if (!isTauri()) return () => {};
  // Batched per pump cycle on the Rust side (a device-side sweep arrives as one
  // message), so fan the batch back out into per-notify callbacks here.
  const channel = newChannel<RawParamUpdate[]>((batch) => {
    for (const d of batch) onUpdate({ paramId: d.param_id, x: d.x, y: d.y, value: d.value });
  });
  void invoke<void>("vd_params_subscribe", { addrs, channel });
  return () => void invoke<void>("vd_params_unsubscribe").catch(() => {});
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
export function vdWatchLink(onDrop: (reason: string) => void): void {
  if (!isTauri()) return;
  const channel = newChannel<RawLinkEvent>((d) => onDrop(d.reason));
  void invoke<void>("vd_watch_link", { channel });
}

/** Close the connection opened with generation `epoch` (no-op if a newer connect
 * already replaced it, or none is connected). */
export function vdDisconnect(epoch: number): Promise<void> {
  return invoke<void>("vd_disconnect", { epoch });
}

// Auto-update (desktop only, via the updater/process plugins). These mirror the
// official @tauri-apps/plugin-updater bindings but call invoke directly so the
// frontend keeps zero npm runtime dependencies, like the dialog calls above.

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

/** Ask the updater for a newer release. Returns null in a plain browser or when
 * already up to date. */
export async function checkUpdate(): Promise<UpdateInfo | null> {
  if (!isTauri()) return null;
  return invoke<UpdateInfo | null>("plugin:updater|check");
}

/** Download and install a pending update, reporting progress. The app must be
 * restarted afterwards (see restartApp) for the new bundle to take effect. */
export function installUpdate(rid: number, onProgress?: (e: DownloadEvent) => void): Promise<void> {
  const channel = newChannel<DownloadEvent>(onProgress ?? (() => {}));
  return invoke<void>("plugin:updater|download_and_install", { onEvent: channel, rid });
}

/** Restart the app (process plugin) to launch the freshly installed bundle. */
export function restartApp(): Promise<never> {
  return invoke<never>("plugin:process|restart");
}

/** Quit the app (process plugin). Used when the first-run consent is declined. */
export function exitApp(code = 0): Promise<never> {
  return invoke<never>("plugin:process|exit", { code });
}
