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

interface TauriGlobals {
  __TAURI_INTERNALS__?: { invoke?: InvokeFn; Channel?: ChannelCtor; transformCallback?: TransformCallback };
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
 * Subscribe to a Tauri webview event (the drag & drop events; commands use
 * Channels instead). Driving the event plugin directly keeps the frontend free of
 * npm runtime dependencies, like the dialog and updater calls above. No-op outside
 * Tauri, where the webview delivers DOM drag & drop events instead.
 */
export async function listenEvent<T>(event: string, handler: (payload: T) => void): Promise<void> {
  const transformCallback = (window as unknown as TauriGlobals).__TAURI_INTERNALS__?.transformCallback;
  if (!transformCallback) return;
  const id = transformCallback((message) => handler((message as { payload: T }).payload));
  await invoke<number>("plugin:event|listen", { event, target: { kind: "Any" }, handler: id });
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

/** Connect to the URX via the broker; resolves with the connected device + epoch. */
export function vdConnect(): Promise<Connection> {
  return invoke<Connection>("vd_connect");
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
export async function vdMetersSubscribe(
  addrs: Array<[number, number]>,
  onUpdate: (m: MeterUpdate) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  // Rust batches each pump cycle's readings into one channel message, so the IPC
  // boundary is crossed ~30×/s instead of per reading; fan the batch back out here.
  const channel = newChannel<RawMeterUpdate[]>((batch) => {
    for (const d of batch) onUpdate({ meterId: d.meter_id, x: d.x, value: d.value });
  });
  // Awaited: bars stuck on the floor read as "no signal" and send the operator
  // chasing gain that was never the problem, so a failed registration is surfaced
  // rather than left to look like silence.
  await invoke<void>("vd_meters_subscribe", { addrs, channel });
  return () => void invoke<void>("vd_meters_unsubscribe").catch(() => {});
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
  // Batched per pump cycle on the Rust side (a device-side sweep arrives as one
  // message), so fan the batch back out into per-notify callbacks here.
  const channel = newChannel<RawParamUpdate[]>((batch) => {
    for (const d of batch) onUpdate({ paramId: d.param_id, x: d.x, y: d.y, value: d.value, valueStr: d.value_str });
  });
  // Awaited, not fire-and-forget: a failed registration leaves the app blind to
  // device-side edits, and the next converge would then write the plan's stale
  // values back over them. The caller stops rather than running half-deaf.
  await invoke<void>("vd_params_subscribe", { addrs, channel });
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
export async function vdWatchLink(onDrop: (reason: string) => void): Promise<void> {
  if (!isTauri()) return;
  const channel = newChannel<RawLinkEvent>((d) => onDrop(d.reason));
  // Awaited: without this watch an idle link drop surfaces as a frozen session
  // (tally lit, meters stopped) instead of a teardown, so a failure here has to
  // stop the session rather than start one that cannot notice its own death.
  await invoke<void>("vd_watch_link", { channel });
}

/** Close the connection opened with generation `epoch` (no-op if a newer connect
 * already replaced it, or none is connected). */
export function vdDisconnect(epoch: number): Promise<void> {
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
 * close function. No-op (resolved noop) outside Tauri.
 */
export async function midiOpenInput(port: string, onMessage: (bytes: number[]) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
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
 *  None while the shell kept delivering into the engine. */
export function midiCloseInput(): void {
  if (!isTauri()) return;
  void invoke<void>("midi_close_input").catch(() => {});
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
 *  and measured not to work (midiwin.rs `pin_midi_window` says why). */
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

/** How long an update check may take before it fails. The updater plugin sets
 *  no default request timeout, and a check whose response is lost on the
 *  network then never settles (measured: repeated checks against the release
 *  endpoint intermittently hang forever without this) — which would leave any
 *  await on it, and the UI state behind it, pending permanently. */
const UPDATE_CHECK_TIMEOUT_MS = 10_000;

/** Ask the updater for a newer release. Returns null in a plain browser or when
 * already up to date; rejects (within the timeout) instead of hanging. */
export async function checkUpdate(): Promise<UpdateInfo | null> {
  if (!isTauri()) return null;
  return invoke<UpdateInfo | null>("plugin:updater|check", { timeout: UPDATE_CHECK_TIMEOUT_MS });
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
