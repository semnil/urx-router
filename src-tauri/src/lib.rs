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

// True when the app was launched with the --experimental flag. Device writes and
// Live sync are always on (covered by the first-launch consent gate); the flag
// only gates the round-trip diagnostics (self-test), the .urxf settings-file
// import, and the read-only "Compare with device". Read straight from the process
// args so no CLI plugin is needed.
#[tauri::command]
fn experimental_enabled() -> bool {
    std::env::args().any(|a| a == "--experimental")
}

// True when launched with --self-test: the frontend runs the device self-test
// once on startup, headless, so it can be driven without the UI.
#[tauri::command]
fn self_test_requested() -> bool {
    std::env::args().any(|a| a == "--self-test")
}

// True when launched with --prepare-modified: the frontend writes a distinctive,
// silent, modified state to the device once on startup and leaves it (no restore),
// so a scene SAVE/RECALL audit can save and diff it. Experimental / headless only.
#[tauri::command]
fn prepare_modified_requested() -> bool {
    std::env::args().any(|a| a == "--prepare-modified")
}

// True when launched with --reset-storage: the frontend clears its localStorage
// (theme / model / meter points / consent gate / …) once on startup before reading
// any of it, then boots clean. The browser dev app uses the ?reset URL instead.
#[tauri::command]
fn reset_storage_requested() -> bool {
    std::env::args().any(|a| a == "--reset-storage")
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
async fn vd_connect(state: State<'_, vd::VdState>) -> Result<vd::Connection, String> {
    let (tx, device) = tauri::async_runtime::spawn_blocking(vd::open)
        .await
        .map_err(|_| vd::CONTROL_WORKER_GONE.to_string())??;
    // The epoch identifies this connection: the frontend hands it back to
    // vd_disconnect so a delayed teardown of an earlier session cannot close it.
    let epoch = state.install(tx);
    Ok(vd::Connection { device, epoch })
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

#[tauri::command]
fn midi_open_input(
    state: State<midi::MidiState>,
    port: String,
    channel: tauri::ipc::Channel<Vec<midi::MidiMessage>>,
) -> Result<(), String> {
    midi::open_input(&state, port, channel)
}

#[tauri::command]
fn midi_close_input(state: State<midi::MidiState>) {
    midi::close_input(&state);
}

#[tauri::command]
fn midi_open_output(state: State<midi::MidiState>, port: String) -> Result<(), String> {
    midi::open_output(&state, port)
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
fn set_keep_awake(state: State<keepawake::KeepAwakeState>, on: bool) -> Result<(), String> {
    keepawake::set(&state, on)
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
            midi_list_inputs,
            midi_list_outputs,
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
