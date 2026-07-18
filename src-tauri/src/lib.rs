// Tauri application entry. The routing planner UI is pure frontend; the Rust
// shell hosts the webview, registers the dialog plugin (native open/save panels),
// and exposes file IO as app commands. These are used only when the UI runs
// inside Tauri; a plain browser falls back to <a download> / <input type=file>.
// The vd module adds live hardware control over the Device Center broker.

use std::fs;
use tauri::State;

mod midi;
mod vd;

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
        _ => Err(format!(
            "unexpected file extension (allowed: {})",
            allowed.join(", ")
        )),
    }
}

// File IO runs on a worker thread (spawn_blocking), like the vd commands below:
// a synchronous command would run on the main thread and stall the webview while
// the disk IO completes.
#[tauri::command]
async fn read_text_file(path: String) -> Result<String, String> {
    check_extension(&path, &["json"])?;
    tauri::async_runtime::spawn_blocking(move || {
        fs::read_to_string(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn write_text_file(path: String, contents: String) -> Result<(), String> {
    check_extension(&path, &["json", "md"])?;
    tauri::async_runtime::spawn_blocking(move || {
        fs::write(&path, contents).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Image export (PNG / PDF). The payload travels as the raw IPC request body — a
// JSON argument would serialize a multi-MB image byte-by-byte as a number array —
// and the destination path rides in the percent-encoded x-file-path header.
#[tauri::command]
async fn write_binary_file(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected a raw request body".to_string());
    };
    // The frontend sends the path encodeURIComponent-ed, because raw header
    // values must stay ASCII while paths can hold non-ASCII characters.
    let path = percent_encoding::percent_decode_str(
        request
            .headers()
            .get("x-file-path")
            .ok_or("missing x-file-path header")?
            .to_str()
            .map_err(|e| e.to_string())?,
    )
    .decode_utf8()
    .map_err(|e| e.to_string())?
    .into_owned();
    check_extension(&path, &["png", "pdf"])?;
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || fs::write(&path, bytes).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

// True when the app was launched with the --experimental flag, gating
// not-yet-stable features (currently live device write) behind an explicit
// opt-in. Read straight from the process args so no CLI plugin is needed.
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
        .map_err(|e| e.to_string())?;
    fs::read_to_string(&path).map_err(|e| e.to_string())
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
        .map_err(|e| e.to_string())??;
    // The epoch identifies this connection: the frontend hands it back to
    // vd_disconnect so a delayed teardown of an earlier session cannot close it.
    let epoch = state.install(tx);
    Ok(vd::Connection { device, epoch })
}

#[tauri::command]
async fn vd_info(state: State<'_, vd::VdState>) -> Result<vd::DeviceSummary, String> {
    let tx = vd::sender(&state)?;
    tauri::async_runtime::spawn_blocking(move || vd::info(tx))
        .await
        .map_err(|e| e.to_string())?
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
        .map_err(|e| e.to_string())?
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
        .map_err(|e| e.to_string())?
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
        .map_err(|e| e.to_string())?
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
        .map_err(|e| e.to_string())?
}

// Subscribe to live level meters: the worker registers each (meter_id, x) with
// the broker and streams readings through the channel. Replaces any prior
// subscription. Fire-and-forget, so no blocking round-trip / spawn_blocking.
#[tauri::command]
fn vd_meters_subscribe(
    state: State<vd::VdState>,
    addrs: Vec<(u32, i64)>,
    channel: tauri::ipc::Channel<Vec<vd::MeterUpdate>>,
) -> Result<(), String> {
    let tx = vd::sender(&state)?;
    vd::meters_subscribe(tx, addrs, channel)
}

#[tauri::command]
fn vd_meters_unsubscribe(state: State<vd::VdState>) -> Result<(), String> {
    let tx = vd::sender(&state)?;
    vd::meters_unsubscribe(tx)
}

// Subscribe to device-side parameter changes: the worker registers each
// (param_id, x, y) with the broker and streams `notify` frames through the
// channel, so edits made on the device follow into the UI. Replaces any prior
// subscription. Fire-and-forget, like the meter subscription.
#[tauri::command]
fn vd_params_subscribe(
    state: State<vd::VdState>,
    addrs: Vec<(u32, i64, i64)>,
    channel: tauri::ipc::Channel<Vec<vd::ParamUpdate>>,
) -> Result<(), String> {
    let tx = vd::sender(&state)?;
    vd::params_subscribe(tx, addrs, channel)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(vd::VdState::default())
        .manage(midi::MidiState::default());

    // The updater/process plugins exist on desktop only; the frontend checks for
    // updates at startup and restarts the app once a new bundle is installed.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            write_text_file,
            write_binary_file,
            experimental_enabled,
            self_test_requested,
            reset_storage_requested,
            third_party_licenses,
            vd_connect,
            vd_info,
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
            midi_send
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
