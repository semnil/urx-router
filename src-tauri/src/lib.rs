// Tauri application entry. The routing planner UI is pure frontend; the Rust
// shell hosts the webview, registers the dialog plugin (native open/save panels),
// and exposes file IO as app commands. These are used only when the UI runs
// inside Tauri; a plain browser falls back to <a download> / <input type=file>.
// The vd module adds live hardware control over the Device Center broker.

use std::fs;
use tauri::State;

mod keepawake;
mod midi;
mod midiwin;
mod vd;

// Every error a command returns is a stable kebab-case code, optionally followed
// by ": " and a technical detail (an OS message, a path, an address). The frontend
// localizes the code and shows the detail as-is (src/i18n error.shell) — a raw
// message would reach a Japanese dialog in English. Codes here: file-not-found,
// file-denied, file-io, file-bad-extension; vd.rs and midi.rs carry their own.
// menu-absent / menu-io are the exception: the Edit menu is a nicety, so its caller
// logs them and they are deliberately absent from the localized set.

// The catch-all file IO code, carrying whatever the failure could say for itself.
// Every site that cannot name a cause goes through this, so the prefix is written
// once rather than at each `map_err`.
fn file_io(e: impl std::fmt::Display) -> String {
    format!("file-io: {e}")
}

// Classify a file IO failure so the frontend can name the cause. Only the two
// kinds worth their own wording are separated; everything else keeps the OS text
// as the detail, which is the only information it carries.
fn io_error(e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound => "file-not-found".to_string(),
        std::io::ErrorKind::PermissionDenied => "file-denied".to_string(),
        _ => file_io(e),
    }
}

// Reject a path whose extension (case-insensitive) is outside the command's
// allowlist, so each file IO command only touches the file kinds its native
// dialog offers.
fn check_extension(path: &str, allowed: &[&str]) -> Result<(), String> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    match ext {
        Some(e) if allowed.contains(&e.as_str()) => Ok(()),
        _ => Err(format!("file-bad-extension: {}", allowed.join(", "))),
    }
}

// File IO runs on a worker thread (spawn_blocking), like the vd commands below:
// a synchronous command would run on the main thread and stall the webview while
// the disk IO completes.
#[tauri::command]
async fn read_text_file(path: String) -> Result<String, String> {
    check_extension(&path, &["json"])?;
    tauri::async_runtime::spawn_blocking(move || {
        fs::read_to_string(&path).map_err(|e| io_error(&e))
    })
    .await
    .map_err(file_io)?
}

// Read a URX microSD settings file (.urxf). The bytes travel back as the raw IPC
// response body — a JSON result would serialize the whole file byte-by-byte as a
// number array. Read-only: the app never writes a settings file back.
#[tauri::command]
async fn read_binary_file(path: String) -> Result<tauri::ipc::Response, String> {
    check_extension(&path, &["urxf"])?;
    let bytes =
        tauri::async_runtime::spawn_blocking(move || fs::read(&path).map_err(|e| io_error(&e)))
            .await
            .map_err(file_io)??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Write a file by filling a sibling temp file and renaming it into place, so a
/// failure part-way leaves the previous contents intact. A bare `fs::write`
/// truncates first: a full disk (or a pulled drive) then destroys the only copy
/// on disk before the error is raised, and the app aborting cleanly afterwards
/// no longer helps — there is nothing left to abort back to. The rename is
/// atomic on the same filesystem, which a sibling temp guarantees.
fn write_atomic(path: &str, bytes: &[u8]) -> Result<(), String> {
    let tmp = format!("{path}.tmp");
    if let Err(e) = fs::write(&tmp, bytes) {
        // A partial write can still leave a stray temp file behind (a full disk
        // truncates mid-write); remove it so the failure strands nothing.
        let _ = fs::remove_file(&tmp);
        return Err(io_error(&e));
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(io_error(&e));
    }
    Ok(())
}

#[tauri::command]
async fn write_text_file(path: String, contents: String) -> Result<(), String> {
    check_extension(&path, &["json", "md"])?;
    tauri::async_runtime::spawn_blocking(move || write_atomic(&path, contents.as_bytes()))
        .await
        .map_err(file_io)?
}

// Image export (PNG / PDF). The payload travels as the raw IPC request body — a
// JSON argument would serialize a multi-MB image byte-by-byte as a number array —
// and the destination path rides in the percent-encoded x-file-path header.
#[tauri::command]
async fn write_binary_file(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("file-io: expected a raw request body".to_string());
    };
    // The frontend sends the path encodeURIComponent-ed, because raw header
    // values must stay ASCII while paths can hold non-ASCII characters.
    let path = percent_encoding::percent_decode_str(
        request
            .headers()
            .get("x-file-path")
            .ok_or("file-io: missing x-file-path header")?
            .to_str()
            .map_err(file_io)?,
    )
    .decode_utf8()
    .map_err(file_io)?
    .into_owned();
    check_extension(&path, &["png", "pdf"])?;
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || write_atomic(&path, &bytes))
        .await
        .map_err(file_io)?
}

// Which build is running, for the ledger's own lines. A session's numbers mean
// different things depending on which build produced them, and `tauri dev` and the
// installed app write to the SAME file (the path is derived from the bundle identifier,
// which does not vary by profile) — so without this, a diagnostic run and ordinary use
// interleave with nothing to tell them apart.
//
// Only this half crosses IPC. The version is a compile-time constant the frontend
// already imports from package.json (which `tauri.conf.json` reads too, so the two
// cannot disagree); asking Rust for it would make a value that can never be unavailable
// arrive over a fallible round trip. `debug_assertions` is not derivable that way: it
// describes the binary that opened the broker socket, not the frontend bundle.
#[tauri::command]
fn app_build_kind() -> &'static str {
    if cfg!(debug_assertions) {
        "dev"
    } else {
        "release"
    }
}

/// Rotate the ledger at this size, keeping one previous generation, so the whole
/// record is bounded at roughly twice it.
///
/// 2 MiB is around ten thousand lines at the shape these records have — over a hundred
/// hours of continuous session, so the run before a force quit is still in the file —
/// while staying small enough to attach to a report. The alternative shapes were an age
/// cap (needs every line parsed) and truncate-from-the-front (rewrites the file on every
/// append); one rotation is the cheapest thing that bounds it.
const LINK_LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// Move the ledger aside when it has grown past `max`, replacing the previous
/// generation. Returns whether it rotated (for the test — nothing else asks).
///
/// Both steps are best-effort: a rotation that cannot happen must not cost the caller
/// its line. `remove_file` before `rename` because Windows refuses a rename onto an
/// existing path, where Unix would replace it silently — the same call has to mean the
/// same thing on both.
fn rotate_link_log(path: &std::path::Path, prev: &std::path::Path, max: u64) -> bool {
    if fs::metadata(path).map(|m| m.len()).unwrap_or(0) < max {
        return false;
    }
    let _ = fs::remove_file(prev);
    fs::rename(path, prev).is_ok()
}

// Append one line to the link ledger in the app's log directory, and answer with the
// file's path so the UI can name where it went.
//
// Append rather than the atomic whole-file write the plan/image exports use: this is
// a record ACROSS sessions — the symptom it exists for (Device Center needing a force
// quit) shows up after the app is gone, so a session that rewrote the file would erase
// the evidence of the one before it. It is also why the path is fixed rather than
// chosen: nothing about it is a document the operator saves.
#[tauri::command]
async fn append_link_log(app: tauri::AppHandle, line: String) -> Result<String, String> {
    use std::io::Write;
    use tauri::Manager;
    let dir = app.path().app_log_dir().map_err(file_io)?;
    let path = dir.join("link-ledger.jsonl");
    let prev = dir.join("link-ledger.1.jsonl");
    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&dir).map_err(|e| io_error(&e))?;
        rotate_link_log(&path, &prev, LINK_LOG_MAX_BYTES);
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| io_error(&e))?;
        writeln!(f, "{line}").map_err(|e| io_error(&e))?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(file_io)?
}

// True when the app was launched with the --experimental flag. Device writes and
// Live sync are always on (covered by the first-launch consent gate); the flag
// only gates the round-trip diagnostics (self-test), the .urxf settings-file
// import, and the read-only "Compare with device". Read straight from the process
// args so no CLI plugin is needed.
#[tauri::command]
fn experimental_enabled() -> bool {
    std::env::args().any(|a| a == "--experimental")
}

// A launch flag that names a one-shot ACTION rather than a capability, consumed by
// the first caller. The frontend asks on every page load, and a webview reload is a
// page load — in `tauri dev` an HMR edit is one — so reading argv each time re-armed
// the action. Measured: nine reloads during an editing session started nine device
// self-tests on the connected unit, each abandoning the previous run's Rust callbacks
// mid-flight, and the last one was still sweeping when the process was killed, so it
// never reached its restore and left the unit holding a perturbed (silent) state in
// place of the operator's settings. `experimental_enabled` is deliberately NOT one of
// these: it gates what the UI offers, which every page load has to ask about again.
fn take_launch_action(taken: &std::sync::atomic::AtomicBool, arg: &str) -> bool {
    std::env::args().any(|a| a == arg) && !taken.swap(true, std::sync::atomic::Ordering::SeqCst)
}

// True when launched with --self-test: the frontend runs the device self-test
// once on startup, headless, so it can be driven without the UI.
#[tauri::command]
fn self_test_requested() -> bool {
    static TAKEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    take_launch_action(&TAKEN, "--self-test")
}

// True when launched with --prepare-modified: the frontend writes a distinctive,
// silent, modified state to the device once on startup and leaves it (no restore),
// so a scene SAVE/RECALL audit can save and diff it. Experimental / headless only.
#[tauri::command]
fn prepare_modified_requested() -> bool {
    static TAKEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    take_launch_action(&TAKEN, "--prepare-modified")
}

// True when launched with --reset-storage: the frontend clears its localStorage
// (theme / model / meter points / consent gate / …) once on startup before reading
// any of it, then boots clean. The browser dev app uses the ?reset URL instead.
#[tauri::command]
fn reset_storage_requested() -> bool {
    static TAKEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    take_launch_action(&TAKEN, "--reset-storage")
}

// The third-party license notice bundled as an app resource (cargo-about output;
// release.yml generates it before packaging). A small read of a bundled file, so
// it stays synchronous.
#[tauri::command]
fn third_party_licenses(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let path = app
        .path()
        .resolve(
            "THIRD_PARTY_LICENSES.html",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(file_io)?;
    fs::read_to_string(&path).map_err(|e| io_error(&e))
}

// Live control: connect to / set parameters on / disconnect from the URX via the
// Device Center broker. The device GUID stays in Rust; the frontend addresses
// parameters by (param_id, x, y) and an absolute integer value.
//
// Every call blocks on a broker round-trip, so the commands are async and run
// the blocking work on a worker thread (spawn_blocking). A synchronous command
// would run on the main thread and freeze the webview for each round-trip — with
// live sync mirroring every edit, that stalls the UI continuously.
#[tauri::command]
async fn vd_connect(
    webview: tauri::Webview,
    state: State<'_, vd::VdState>,
) -> Result<vd::Connection, String> {
    let (tx, device, counters) = tauri::async_runtime::spawn_blocking(vd::open)
        .await
        .map_err(|_| vd::CONTROL_WORKER_GONE.to_string())??;
    // The epoch identifies this connection: the frontend hands it back to
    // vd_disconnect so a delayed teardown of an earlier session cannot close it.
    // The label identifies its OWNER, which is what decides whether a later page
    // load may tear it down (see the on_page_load hook in `run`).
    let epoch = state.install(tx, counters, webview.label());
    Ok(vd::Connection { device, epoch })
}

// This connection's ledger — what the app has asked of the broker, and what the
// broker failed to answer (see vd::LinkCounters). Synchronous and lock-free by
// design: it reads atomics rather than queueing a command, so a reading taken while
// an ~800 command sweep is running reports now instead of reporting the sweep's
// start. Zeroed when nothing is connected.
#[tauri::command]
fn vd_link_stats(state: State<vd::VdState>) -> vd::LinkStats {
    vd::stats(&state)
}

#[tauri::command]
async fn vd_set(
    state: State<'_, vd::VdState>,
    param_id: u32,
    x: i64,
    y: i64,
    value: i64,
) -> Result<(), String> {
    let tx = vd::sender(&state)?;
    tauri::async_runtime::spawn_blocking(move || vd::set(tx, param_id, x, y, value))
        .await
        .map_err(|_| vd::CONTROL_WORKER_GONE.to_string())?
}

#[tauri::command]
async fn vd_get(
    state: State<'_, vd::VdState>,
    param_id: u32,
    x: i64,
    y: i64,
) -> Result<i64, String> {
    let tx = vd::sender(&state)?;
    tauri::async_runtime::spawn_blocking(move || vd::get(tx, param_id, x, y))
        .await
        .map_err(|_| vd::CONTROL_WORKER_GONE.to_string())?
}

// String-valued parameters (e.g. CH SETTING names) the numeric vd_set/vd_get
// cannot carry: the broker stores their current_value as a JSON string.
#[tauri::command]
async fn vd_set_str(
    state: State<'_, vd::VdState>,
    param_id: u32,
    x: i64,
    y: i64,
    value: String,
) -> Result<(), String> {
    let tx = vd::sender(&state)?;
    tauri::async_runtime::spawn_blocking(move || vd::set_str(tx, param_id, x, y, value))
        .await
        .map_err(|_| vd::CONTROL_WORKER_GONE.to_string())?
}

#[tauri::command]
async fn vd_get_str(
    state: State<'_, vd::VdState>,
    param_id: u32,
    x: i64,
    y: i64,
) -> Result<String, String> {
    let tx = vd::sender(&state)?;
    tauri::async_runtime::spawn_blocking(move || vd::get_str(tx, param_id, x, y))
        .await
        .map_err(|_| vd::CONTROL_WORKER_GONE.to_string())?
}

// Subscribe to live level meters: the worker registers each (meter_id, x) with
// the broker and streams readings through the channel. Replaces any prior
// subscription. Registration is per-address, so this waits on the worker like
// set/get do — the reply tells the caller whether the stream actually started.
#[tauri::command]
async fn vd_meters_subscribe(
    state: State<'_, vd::VdState>,
    addrs: Vec<(u32, i64)>,
    channel: tauri::ipc::Channel<Vec<vd::MeterUpdate>>,
) -> Result<(), String> {
    let tx = vd::sender(&state)?;
    tauri::async_runtime::spawn_blocking(move || vd::meters_subscribe(tx, addrs, channel))
        .await
        .map_err(|_| vd::CONTROL_WORKER_GONE.to_string())?
}

#[tauri::command]
fn vd_meters_unsubscribe(state: State<vd::VdState>) -> Result<(), String> {
    let tx = vd::sender(&state)?;
    vd::meters_unsubscribe(tx)
}

// Subscribe to device-side parameter changes: the worker registers each
// (param_id, x, y) with the broker and streams `notify` frames through the
// channel, so edits made on the device follow into the UI. Replaces any prior
// subscription. Waits on the worker, like the meter subscription.
#[tauri::command]
async fn vd_params_subscribe(
    state: State<'_, vd::VdState>,
    addrs: Vec<(u32, i64, i64)>,
    channel: tauri::ipc::Channel<Vec<vd::ParamUpdate>>,
) -> Result<(), String> {
    let tx = vd::sender(&state)?;
    tauri::async_runtime::spawn_blocking(move || vd::params_subscribe(tx, addrs, channel))
        .await
        .map_err(|_| vd::CONTROL_WORKER_GONE.to_string())?
}

#[tauri::command]
fn vd_params_unsubscribe(state: State<vd::VdState>) -> Result<(), String> {
    let tx = vd::sender(&state)?;
    vd::params_unsubscribe(tx)
}

// Watch the held-open live connection: the worker pushes a single LinkEvent
// through the channel if the broker link drops while idle, so the UI can drop a
// live session instead of silently freezing. Fire-and-forget, like the
// subscriptions; the channel dies with the worker on disconnect.
#[tauri::command]
fn vd_watch_link(
    state: State<vd::VdState>,
    channel: tauri::ipc::Channel<vd::LinkEvent>,
) -> Result<(), String> {
    let tx = vd::sender(&state)?;
    vd::watch_link(tx, channel)
}

// Disconnect only signals the worker to shut down (no reply wait), so it stays
// synchronous.
#[tauri::command]
fn vd_disconnect(state: State<vd::VdState>, epoch: u64) {
    vd::disconnect(&state, epoch);
}

// External MIDI control: the frontend maps incoming MIDI messages onto console
// controls and sends feedback back to the controller. All calls are local OS-API
// round-trips (no broker / network), so they stay synchronous — see midi.rs.
#[tauri::command]
fn midi_list_inputs() -> Result<Vec<String>, String> {
    midi::list_inputs()
}

#[tauri::command]
fn midi_list_outputs() -> Result<Vec<String>, String> {
    midi::list_outputs()
}

/// Which ports are open right now (input, output) — what the frontend checks its
/// own idea of the chosen ports against on every refresh.
#[tauri::command]
fn midi_open_ports(state: State<midi::MidiState>) -> (Option<String>, Option<String>) {
    midi::open_ports(&state)
}

#[tauri::command]
fn midi_open_input(
    webview: tauri::Webview,
    state: State<midi::MidiState>,
    port: String,
    channel: tauri::ipc::Channel<Vec<midi::MidiMessage>>,
) -> Result<(), String> {
    midi::open_input(&state, webview.label(), port, channel)
}

#[tauri::command]
fn midi_close_input(state: State<midi::MidiState>) {
    midi::close_input(&state);
}

#[tauri::command]
fn midi_open_output(
    webview: tauri::Webview,
    state: State<midi::MidiState>,
    port: String,
) -> Result<(), String> {
    midi::open_output(&state, webview.label(), port)
}

#[tauri::command]
fn midi_close_output(state: State<midi::MidiState>) {
    midi::close_output(&state);
}

#[tauri::command]
fn midi_send(state: State<midi::MidiState>, bytes: Vec<u8>) -> Result<(), String> {
    midi::send(&state, bytes)
}

// Take or release the idle-sleep hold (Preferences > Computer sleep). A local OS
// call with no round-trip, so it stays synchronous like the MIDI bridge.
#[tauri::command]
fn set_keep_awake(
    webview: tauri::Webview,
    state: State<keepawake::KeepAwakeState>,
    on: bool,
) -> Result<(), String> {
    keepawake::set(&state, webview.label(), on)
}

// The macOS Edit menu's Undo / Redo, owned by the app instead of AppKit.
//
// Tauri installs a default macOS menu whenever the app sets none, and its Edit submenu
// carries PredefinedMenuItem::undo / ::redo. Those send the AppKit `undo:` selector,
// which never reaches the page: a click ran WebKit's own text-field undo — on the last
// edited field, even after focus had left it — while the plan's undo did nothing, and
// nothing was reported. Predefined items also cannot be enabled or disabled at runtime.
// So the pair is replaced by app-owned items: a click arrives as a menu event the
// frontend routes (ui/edit-menu.ts), and their enabled state and labels are pushed from
// there. macOS only — no other platform installs a menu.
#[cfg(target_os = "macos")]
struct EditMenu {
    undo: tauri::menu::MenuItem<tauri::Wry>,
    redo: tauri::menu::MenuItem<tauri::Wry>,
}

// The catch-all code for a menu update that the platform refused, written once here for
// the same reason file_io is (see the header).
#[cfg(target_os = "macos")]
fn menu_io(e: impl std::fmt::Display) -> String {
    format!("menu-io: {e}")
}

// Apply an update to both Edit menu items, or report that there is no menu to update.
// The two commands below differ only in the setter, so the state they share — the
// lookup, the error mapping, and the non-macOS no-op — lives here.
#[cfg(target_os = "macos")]
fn with_edit_menu<T>(
    app: &tauri::AppHandle,
    values: (T, T),
    set: impl Fn(&tauri::menu::MenuItem<tauri::Wry>, T) -> tauri::Result<()>,
) -> Result<(), String> {
    use tauri::Manager;
    let menu = app.try_state::<EditMenu>().ok_or("menu-absent")?;
    set(&menu.undo, values.0).map_err(menu_io)?;
    set(&menu.redo, values.1).map_err(menu_io)
}

/// Reflect the undo / redo depth onto the application menu. A no-op where there is no
/// menu (every platform but macOS), so the frontend calls it unconditionally.
#[tauri::command]
fn set_edit_menu_state(
    app: tauri::AppHandle,
    can_undo: bool,
    can_redo: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return with_edit_menu(&app, (can_undo, can_redo), |item, on| item.set_enabled(on));
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, can_undo, can_redo);
        Ok(())
    }
}

/// Set the menu items' labels. The menu is built before the frontend loads, so the
/// initial text is English like the rest of the default bar; this is how a language
/// switch reaches it.
#[tauri::command]
fn set_edit_menu_labels(app: tauri::AppHandle, undo: String, redo: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return with_edit_menu(&app, (undo, redo), |item, text| item.set_text(text));
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, undo, redo);
        Ok(())
    }
}

// Swap the default Edit submenu's predefined Undo / Redo for app-owned items, keeping
// everything else in the bar. Located by the predefined items' own text rather than by
// position, so a Tauri upgrade that reorders the submenu is a miss rather than a
// mis-removal. A miss leaves the default menu untouched and says so: the app is still
// usable, with the divergence this replaces.
#[cfg(target_os = "macos")]
fn build_menu(handle: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::Manager;

    let menu = Menu::default(handle)?;
    let Some(edit) = menu
        .items()?
        .iter()
        .filter_map(|kind| kind.as_submenu().cloned())
        .find(|sub| sub.text().map(|t| t == "Edit").unwrap_or(false))
    else {
        eprintln!("edit menu: no Edit submenu in the default menu; leaving it as built");
        return Ok(menu);
    };
    let items = edit.items()?;
    let position = items.iter().position(|kind| {
        kind.as_predefined_menuitem()
            .and_then(|item| item.text().ok())
            .map(|t| t == "Undo")
            .unwrap_or(false)
    });
    let Some(at) = position else {
        eprintln!("edit menu: no predefined Undo to replace; leaving it as built");
        return Ok(menu);
    };
    let redo_follows = items
        .get(at + 1)
        .and_then(|kind| kind.as_predefined_menuitem())
        .and_then(|item| item.text().ok())
        .map(|t| t == "Redo")
        .unwrap_or(false);
    if !redo_follows {
        eprintln!("edit menu: predefined Redo does not follow Undo; leaving it as built");
        return Ok(menu);
    }
    edit.remove_at(at)?;
    edit.remove_at(at)?;
    // The accelerators are shown, not claimed: measured on this stack, the page
    // receives the chord and the menu's key equivalent never fires. They are set so the
    // menu prints the shortcut the operator actually uses.
    let undo = MenuItem::with_id(handle, EDIT_UNDO_ID, "Undo", false, Some("CmdOrCtrl+Z"))?;
    let redo = MenuItem::with_id(
        handle,
        EDIT_REDO_ID,
        "Redo",
        false,
        Some("Shift+CmdOrCtrl+Z"),
    )?;
    edit.insert(&undo, at)?;
    edit.insert(&redo, at + 1)?;
    handle.manage(EditMenu { undo, redo });
    Ok(menu)
}

// Shared with the frontend through the emitted event's payload.
#[cfg(target_os = "macos")]
const EDIT_UNDO_ID: &str = "edit-undo";
#[cfg(target_os = "macos")]
const EDIT_REDO_ID: &str = "edit-redo";
/// The event an Edit menu click is delivered on; the payload is the item id.
#[cfg(target_os = "macos")]
const EDIT_MENU_EVENT: &str = "menu://edit";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(vd::VdState::default())
        .manage(midi::MidiState::default())
        .manage(midiwin::MidiUiState::default())
        .manage(keepawake::KeepAwakeState::default())
        // The MIDI window is a second view of the main window's state, not a second
        // app: it goes away with the main window, and its own closing has to reach
        // the main window so learn mode does not stay armed with nothing to show it.
        .on_window_event(|window, event| {
            use tauri::Manager;
            if !matches!(event, tauri::WindowEvent::Destroyed) {
                return;
            }
            let app = window.app_handle();
            if window.label() == midiwin::MIDI_WINDOW {
                midiwin::notify_closed(app);
            } else if let Some(midi) = app.get_webview_window(midiwin::MIDI_WINDOW) {
                let _ = midi.close();
            }
        });

    // The updater/process plugins exist on desktop only; the frontend checks for
    // updates at startup and restarts the app once a new bundle is installed.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    // The page that owned a device session is being replaced — a dev-server reload, a
    // webview recovering from a crash, the `--reset-storage` reload. Everything the
    // frontend holds is gone with it, INCLUDING the connection epoch that
    // `vd_disconnect` needs, so the session can never be named again from the page
    // side: it would outlive its owner as an open broker socket and an open MIDI port.
    //
    // Measured before this existed, after one dev reload: the connect handshake still
    // succeeded (device list, sync_status, firmware) and then the broker answered NOT
    // ONE parameter read — the app sent a `requestVD` GET every 3 s and received zero
    // bytes back for as long as it was left running. The MIDI port restore failed the
    // same way, with "that port is no longer available".
    //
    // Native-side rather than a `pagehide` handler in the page: the IPC a dying page
    // posts is not guaranteed to leave before navigation tears the webview down, and a
    // teardown that only usually happens is the failure mode this exists to remove.
    // `Started` also fires for the first load of all, where both calls are no-ops.
    #[cfg(desktop)]
    let builder = builder.on_page_load(|webview, payload| {
        use tauri::webview::PageLoadEvent;
        use tauri::Manager;
        if payload.event() != PageLoadEvent::Started {
            return;
        }
        // Only what THIS page holds. Each hold records the webview that took it, so the
        // question "is this mine to end" is answered by the hold rather than by a rule
        // about which windows exist — the app has two, and it had already been bitten
        // once by the second one's load ending the first one's session and closing the
        // MIDI input it had restored. A third window inherits the right behaviour with
        // nothing to remember.
        let app = webview.app_handle();
        let label = webview.label();
        vd::shutdown_owned_by(&app.state::<vd::VdState>(), label);
        midi::close_owned_by(&app.state::<midi::MidiState>(), label);
        // The idle-sleep hold belongs here for the same reason and is the least visible of
        // the three: the frontend takes it only while Live sync is up, so a reload during a
        // session would otherwise leave the machine awake for as long as the app runs, with
        // no page that knows the assertion exists. Nothing to salvage from a page that is
        // gone, and nothing to report to it.
        keepawake::release_owned_by(&app.state::<keepawake::KeepAwakeState>(), label);
    });

    // App-owned Edit > Undo / Redo (see build_menu). The click is forwarded to the
    // frontend, which is the only side that knows what an undo means here.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(build_menu).on_menu_event(|app, event| {
        use tauri::Emitter;
        let id = event.id().0.as_str();
        if id != EDIT_UNDO_ID && id != EDIT_REDO_ID {
            return;
        }
        // Addressed to the main window, not broadcast: the menu is application-wide,
        // but the plan and its history live in one window, and the MIDI window
        // listens on the same `Any` target — an undo delivered there would find no
        // history and, worse, would be one the operator could not see happen.
        //
        // The menu is a nicety, not a device operation: a failed emit leaves the
        // click undone, and there is nothing further to salvage.
        if let Err(e) = app.emit_to("main", EDIT_MENU_EVENT, id) {
            eprintln!("edit menu: could not deliver {id}: {e}");
        }
    });

    builder
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            read_binary_file,
            write_text_file,
            write_binary_file,
            experimental_enabled,
            self_test_requested,
            prepare_modified_requested,
            reset_storage_requested,
            third_party_licenses,
            vd_connect,
            vd_set,
            vd_get,
            vd_set_str,
            vd_get_str,
            vd_meters_subscribe,
            vd_meters_unsubscribe,
            vd_params_subscribe,
            vd_params_unsubscribe,
            vd_watch_link,
            vd_disconnect,
            vd_link_stats,
            append_link_log,
            app_build_kind,
            midi_list_inputs,
            midi_list_outputs,
            midi_open_ports,
            midi_open_input,
            midi_close_input,
            midi_open_output,
            midi_close_output,
            midi_send,
            midiwin::open_midi_window,
            midiwin::close_midi_window,
            midiwin::focus_midi_window,
            midiwin::midi_window_geometry,
            midiwin::midi_ui_attach_main,
            midiwin::midi_ui_attach_window,
            midiwin::midi_ui_to_main,
            midiwin::midi_ui_to_window,
            set_keep_awake,
            set_edit_menu_state,
            set_edit_menu_labels
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        // Built and run in two steps for one reason: the broker session has to be
        // closed while the process is still alive. `on_page_load` covers a page being
        // replaced, but nothing covered the app itself going away — quitting with Live
        // sync up abandoned the session rather than closing it, leaving ~800
        // registrations installed and the socket dropped without a close handshake.
        // `shutdown_blocking` waits (bounded) for the unregisters and the close to
        // actually reach the wire, because "told to close" and "closed" are the same
        // thing only when something outlives the telling.
        .run(|app, event| {
            use tauri::Manager;
            if matches!(event, tauri::RunEvent::Exit) {
                // The broker session ALONE, unlike the page-load teardown above, which
                // also drops the MIDI ports and the sleep hold. Those two are reclaimed
                // by the OS when the process ends; this one is not — the unregisters and
                // the close handshake are in-band frames that have to reach the broker
                // while there is still a process to send them.
                vd::shutdown_blocking(&app.state::<vd::VdState>());
            }
        });
}

#[cfg(test)]
mod tests {
    // A one-shot launch action must survive a page reload without firing again. The
    // frontend asks on every page load; before this latch, `--self-test` re-ran a
    // destructive device sweep on each one, which in `tauri dev` means on each HMR
    // edit. argv[0] stands in for a flag that is actually present, so the test needs
    // no control over how the test binary was launched.
    use super::take_launch_action;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn a_launch_action_is_consumed_by_its_first_caller() {
        let present = std::env::args().next().expect("argv[0]");
        static TAKEN: AtomicBool = AtomicBool::new(false);
        assert!(
            take_launch_action(&TAKEN, &present),
            "the first caller takes the action"
        );
        assert!(
            !take_launch_action(&TAKEN, &present),
            "a page reload does not re-arm it"
        );
    }

    // The ledger is appended to for the life of the install, so its size is bounded by
    // rotation rather than by anyone remembering to clear it. Pinned because both
    // halves are easy to lose: a rotation that fires early throws away the history the
    // file exists for, and one that never fires is an unbounded file.
    #[test]
    fn the_ledger_rotates_only_once_it_is_full() {
        use super::rotate_link_log;
        let dir = std::env::temp_dir().join(format!(
            "urx-link-log-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("link-ledger.jsonl");
        let prev = dir.join("link-ledger.1.jsonl");

        std::fs::write(&path, b"first\n").expect("write");
        assert!(
            !rotate_link_log(&path, &prev, 64),
            "a file under the cap stays where it is"
        );
        assert!(!prev.exists(), "and no generation is made for it");

        assert!(rotate_link_log(&path, &prev, 6), "at the cap it rotates");
        assert!(
            !path.exists(),
            "the live file is gone, so the next append starts one"
        );
        assert_eq!(std::fs::read(&prev).expect("previous"), b"first\n");

        // A second rotation replaces the generation rather than accumulating them:
        // two files is the bound, whatever the install's age.
        std::fs::write(&path, b"second\n").expect("write");
        assert!(rotate_link_log(&path, &prev, 6));
        assert_eq!(std::fs::read(&prev).expect("previous"), b"second\n");
        assert_eq!(
            std::fs::read_dir(&dir).expect("dir").count(),
            1,
            "one live file and one generation, never a third"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_absent_flag_leaves_the_latch_alone() {
        static TAKEN: AtomicBool = AtomicBool::new(false);
        assert!(!take_launch_action(
            &TAKEN,
            "--not-a-flag-this-binary-was-given"
        ));
        assert!(
            !TAKEN.load(Ordering::SeqCst),
            "an unasked action stays available"
        );
    }
}
