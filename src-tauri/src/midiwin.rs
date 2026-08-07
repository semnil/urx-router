// The MIDI control window and the relay between it and the main window.
//
// The MIDI window is a view and nothing more: it holds no plan and opens no MIDI
// port. A port's received bursts are delivered to the window that opened it, so a
// window with no plan must never open one — everything it shows comes from the main
// window, and everything it does goes back there as an intent.
//
// The two sides each register a Channel and this module forwards between them. That
// keeps the traffic inside `invoke` (like the meter, param and MIDI-input streams)
// rather than the event plugin, so the second window needs no capability of its own.
// The payloads are opaque JSON strings: the shape belongs to the two frontends, and
// Rust is the wire, not a participant.

use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

/// The MIDI window's label, shared with the window-event routing in lib.rs.
pub const MIDI_WINDOW: &str = "midi";

#[derive(Default)]
pub struct MidiUiState {
    /// Set while the MIDI window is up; the main window's state pushes land here.
    to_window: Mutex<Option<Channel<String>>>,
    /// Set for the main window's lifetime; the MIDI window's intents land here.
    to_main: Mutex<Option<Channel<String>>>,
}

// A relay send that finds no receiver is not an error: the MIDI window may have just
// closed, and the main window re-sends its whole state on the next attach. Reporting
// it would make every close print a failure the operator cannot act on.
fn forward(slot: &Mutex<Option<Channel<String>>>, payload: String) {
    let held = slot.lock().ok().and_then(|s| s.clone());
    if let Some(channel) = held {
        if let Err(e) = channel.send(payload) {
            eprintln!("midi ui relay: {e}");
        }
    }
}

fn store(slot: &Mutex<Option<Channel<String>>>, channel: Option<Channel<String>>) {
    if let Ok(mut s) = slot.lock() {
        *s = channel;
    }
}

/// The MIDI window registers its receiver (called once, on that window's boot).
#[tauri::command]
pub fn midi_ui_attach_window(state: State<MidiUiState>, channel: Channel<String>) {
    store(&state.to_window, Some(channel));
}

/// The main window registers its receiver (called once, at startup).
#[tauri::command]
pub fn midi_ui_attach_main(state: State<MidiUiState>, channel: Channel<String>) {
    store(&state.to_main, Some(channel));
}

/// Main → MIDI window: the state it renders.
#[tauri::command]
pub fn midi_ui_to_window(state: State<MidiUiState>, payload: String) {
    forward(&state.to_window, payload);
}

/// MIDI window → main: an intent (learn, remove, port choice).
#[tauri::command]
pub fn midi_ui_to_main(state: State<MidiUiState>, payload: String) {
    forward(&state.to_main, payload);
}

/// Tell the main window the MIDI window went away, so it can drop learn mode. Sent
/// from the window-event handler as well as from the window's own unload.
pub fn notify_closed(app: &AppHandle) {
    if let Some(state) = app.try_state::<MidiUiState>() {
        store(&state.to_window, None);
        forward(&state.to_main, "{\"type\":\"closed\"}".to_string());
    }
}

/// Open the MIDI control window, or raise it when it is already up. Only the
/// title comes from the frontend, because it is localized; where the window sits
/// does not — the window-state plugin restores that from the last session and
/// `winfit` keeps the answer on a display.
///
/// `async` on purpose: building a webview from a blocking command deadlocks on
/// Windows.
#[tauri::command]
pub async fn open_midi_window(app: AppHandle, title: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(MIDI_WINDOW) {
        return win.set_focus().map_err(|e| format!("midi-window: {e}"));
    }
    let win = WebviewWindowBuilder::new(&app, MIDI_WINDOW, WebviewUrl::App("midi.html".into()))
        .title(title)
        .inner_size(440.0, 620.0)
        .min_inner_size(360.0, 320.0)
        .resizable(true)
        .build()
        .map_err(|e| format!("midi-window: {e}"))?;
    // AFTER `build()` on purpose, and it is the only place this can go. The plugin
    // restores the window from its own `on_window_ready`, and the move that restore
    // issues has not landed while that hook is running — measured, by trying to do
    // this from a hook of our own registered behind it and reading the position the
    // window was born at. By the time `build()` returns, it has landed. A window
    // that cannot be measured is not worth failing an open for: the panel is up and
    // usable either way.
    if let Err(e) = crate::winfit::fit_window(&win.as_ref().window()) {
        eprintln!("midi-window fit: {e}");
    }
    Ok(())
}

/// Close the MIDI control window. A window that is already gone is not an error —
/// the operator may have closed it from its own chrome a moment earlier.
#[tauri::command]
pub fn close_midi_window(app: AppHandle) -> Result<(), String> {
    match app.get_webview_window(MIDI_WINDOW) {
        Some(win) => win.close().map_err(|e| format!("midi-window: {e}")),
        None => Ok(()),
    }
}

/// Raise the MIDI window to the front. Called when learn turns on and when a binding
/// lands, so a window that drifted behind the app comes back for the one moment its
/// contents matter. Deliberately not "always on top": that would cover the app for
/// the whole session to solve a problem that lasts a gesture.
#[tauri::command]
pub fn focus_midi_window(app: AppHandle) -> Result<(), String> {
    match app.get_webview_window(MIDI_WINDOW) {
        Some(win) => win.set_focus().map_err(|e| format!("midi-window: {e}")),
        None => Ok(()),
    }
}

/// Whether the MIDI control window exists. The main window asks once at startup:
/// the window OUTLIVES a reload of the main page (a dev HMR reload is one), and it
/// announces itself with "ready" on its own boot, so nothing would make it speak
/// again — the shell is the only side that knows it is there.
#[tauri::command]
pub fn midi_window_open(app: AppHandle) -> bool {
    app.get_webview_window(MIDI_WINDOW).is_some()
}
