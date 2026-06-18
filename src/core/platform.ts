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
}

/** Connect to the URX via the broker; resolves with the connected device. */
export function vdConnect(): Promise<DeviceSummary> {
  return invoke<DeviceSummary>("vd_connect");
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

/** Close the live connection (no-op if not connected). */
export function vdDisconnect(): Promise<void> {
  return invoke<void>("vd_disconnect");
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
