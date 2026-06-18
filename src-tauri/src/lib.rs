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

// Live control: connect to / set parameters on / disconnect from the URX via the
// Device Center broker. The device GUID stays in Rust; the frontend addresses
// parameters by (param_id, x, y) and an absolute integer value.
#[tauri::command]
fn vd_connect(state: State<vd::VdState>) -> Result<vd::DeviceSummary, String> {
    vd::connect(&state)
}

#[tauri::command]
fn vd_info(state: State<vd::VdState>) -> Result<vd::DeviceSummary, String> {
    vd::info(&state)
}

#[tauri::command]
fn vd_set(state: State<vd::VdState>, param_id: u32, x: i64, y: i64, value: i64) -> Result<(), String> {
    vd::set(&state, param_id, x, y, value)
}

#[tauri::command]
fn vd_get(state: State<vd::VdState>, param_id: u32, x: i64, y: i64) -> Result<i64, String> {
    vd::get(&state, param_id, x, y)
}

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
            vd_connect,
            vd_info,
            vd_set,
            vd_get,
            vd_disconnect
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
