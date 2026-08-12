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

/// The panel's smallest useful INNER size, in logical pixels. Named once because
/// it is used twice — building the window, and correcting a restored one, which
/// can come back under it after a display-scale change (`winfit::at_least`).
const MIN_INNER: (f64, f64) = (360.0, 320.0);

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
/// Built as a CHILD of the main window, which is what keeps it in front of it: on
/// Windows an owned window is always above its owner in the z-order, and on macOS
/// `addChildWindow` orders it above the parent within the app. Deliberately not
/// "always on top" — that would put the panel above every other application for
/// the whole session, which is a far larger promise than the one being made here.
///
/// `async` on purpose: building a webview from a blocking command deadlocks on
/// Windows.
#[tauri::command]
pub async fn open_midi_window(app: AppHandle, title: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(MIDI_WINDOW) {
        return win.set_focus().map_err(|e| format!("midi-window: {e}"));
    }
    let main = app
        .get_webview_window(crate::MAIN_WINDOW)
        .ok_or_else(|| "midi-window: no main window".to_string())?;
    #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
    let mut builder =
        WebviewWindowBuilder::new(&app, MIDI_WINDOW, WebviewUrl::App("midi.html".into()))
            .title(title)
            .inner_size(440.0, 620.0)
            .min_inner_size(MIN_INNER.0, MIN_INNER.1)
            .resizable(true);
    // NOT a child of the main window on macOS, though it was until this was measured.
    // An AppKit child is only composited on its PARENT's display: put on any other one
    // it stays listed on-screen at layer 0 with alpha 1.0 and draws nothing. Observed
    // both ways on a two-display desk — parent external / child built-in, and parent
    // built-in / child external — so it is the relationship and not an arrangement. It
    // is also translated with the parent one point for one, which is how a remembered
    // position ends up off the desk entirely.
    //
    // On Windows the same call means something else — a Win32 OWNER, which keeps this
    // window above the main one and minimizes with it — and none of the above was
    // measured there. Dropping it everywhere would have traded a defect nobody has seen
    // on that platform for one nobody asked for, so the relationship stays where the
    // evidence does not reach. `reference/work/windows-verify` item 2 carries what would
    // settle whether macOS's finding applies there too.
    //
    // What the parent bought on macOS — that it cannot fall behind the main window — is
    // paid for by pinning it while a learn is armed (`pin_midi_window`).
    #[cfg(target_os = "windows")]
    {
        builder = builder
            .parent(&main)
            .map_err(|e| format!("midi-window: {e}"))?;
    }
    let win = builder.build().map_err(|e| format!("midi-window: {e}"))?;
    // AFTER `build()` on purpose, and it is the only place this can go. A hook of our
    // own registered behind the window-state plugin's was tried and measured not to
    // work: inside a `window_created` hook the window still reports the position it
    // was born at, because a move issued from one is queued exactly like one issued at
    // startup. By the time `build()` returns, it has landed.
    //
    // This is the window's whole restore, not a correction of the plugin's — the
    // plugin skips both windows now (`window_state_plugin` in lib.rs says why), so
    // there is nothing here to correct and the remembered rectangle is applied once,
    // from numbers, exactly as the main window's is. A window that cannot be placed is
    // not worth failing an open for: the panel is up and usable either way.
    //
    // The parent decides which DISPLAY, and it has to: this is an AppKit child
    // window, so it is translated with its parent one for one, and its remembered
    // absolute position is therefore out of date by every move the parent has made
    // since. Measured — a parent dragged from x=2344 to x=172 took this window from
    // x=536 to x=-1636, off every display, where the window server still reported it
    // on-screen and opaque and nothing was drawn. The remembered SIZE is still used.
    #[cfg(desktop)]
    crate::restore_window(
        &win.as_ref().window(),
        MIN_INNER,
        Some(&main.as_ref().window()),
    );
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

/// Raise the MIDI window to the front. Called when learn turns on, so the panel
/// comes forward for the one moment its contents matter. Being a child of the main
/// window puts it in front of THAT already; what this still does is bring the app
/// itself forward when another application is covering both.
#[tauri::command]
pub fn focus_midi_window(app: AppHandle) -> Result<(), String> {
    match app.get_webview_window(MIDI_WINDOW) {
        Some(win) => win.set_focus().map_err(|e| format!("midi-window: {e}")),
        None => Ok(()),
    }
}

/// Keep the MIDI control window above everything, or stop. Set while learn is armed
/// and cleared when it disarms — the narrowest scope that answers the complaint.
///
/// Always-on-top rather than a raise on the main window's focus. That was tried and
/// measured not to work: `set_always_on_top(true)` immediately followed by `(false)`
/// leaves the window where it was, because on macOS it is a window LEVEL and putting
/// the level back puts the order back, and Tauri exposes no order-front that keeps
/// keystrokes where they are (`set_focus` is `makeKeyAndOrderFront:`). What this
/// costs is that the panel floats above OTHER applications too — accepted for the
/// seconds a learn is armed, which is why it is not left on.
#[tauri::command]
pub fn pin_midi_window(app: AppHandle, on: bool) -> Result<(), String> {
    match app.get_webview_window(MIDI_WINDOW) {
        Some(win) => win
            .set_always_on_top(on)
            .map_err(|e| format!("midi-window: {e}")),
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
