// Tauri application entry. The routing planner UI is pure frontend; the Rust
// shell hosts the webview, registers the dialog plugin (native open/save panels),
// and exposes file IO as app commands. These are used only when the UI runs
// inside Tauri; a plain browser falls back to <a download> / <input type=file>.
// The vd module adds live hardware control over the Device Center broker.

use std::fs;
use tauri::State;

mod vd;

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_binary_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
    fs::write(&path, bytes).map_err(|e| e.to_string())
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

// Live control: connect to / set parameters on / disconnect from the URX via the
// Device Center broker. The device GUID stays in Rust; the frontend addresses
// parameters by (param_id, x, y) and an absolute integer value.
//
// Every call blocks on a broker round-trip, so the commands are async and run
// the blocking work on a worker thread (spawn_blocking). A synchronous command
// would run on the main thread and freeze the webview for each round-trip — with
// live sync mirroring every edit, that stalls the UI continuously.
#[tauri::command]
async fn vd_connect(state: State<'_, vd::VdState>) -> Result<vd::DeviceSummary, String> {
    let (tx, summary) = tauri::async_runtime::spawn_blocking(vd::open)
        .await
        .map_err(|e| e.to_string())??;
    state.install(tx);
    Ok(summary)
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
async fn vd_get(state: State<'_, vd::VdState>, param_id: u32, x: i64, y: i64) -> Result<i64, String> {
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

// Disconnect only signals the worker to shut down (no reply wait), so it stays
// synchronous.
#[tauri::command]
fn vd_disconnect(state: State<vd::VdState>) {
    vd::disconnect(&state);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(vd::VdState::default());

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
            vd_connect,
            vd_info,
            vd_set,
            vd_get,
            vd_set_str,
            vd_get_str,
            vd_disconnect
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
