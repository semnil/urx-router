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
    /// Held for the whole of `open_midi_window`, so the existence check and the build
    /// are one step. The command is async and runs as its own task, so two rapid
    /// gestures interleaved: both saw the window absent, one `build()` won and the
    /// other returned a `midi-window: …` error for a window that was up — an error
    /// dialog for a success.
    opening: tauri::async_runtime::Mutex<()>,
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
pub async fn open_midi_window(
    app: AppHandle,
    state: tauri::State<'_, MidiUiState>,
    title: String,
) -> Result<(), String> {
    open_once(
        &state.opening,
        || {
            app.get_webview_window(MIDI_WINDOW)
                .map(|win| win.set_focus().map_err(|e| format!("midi-window: {e}")))
        },
        || build_midi_window(&app, title),
    )
    .await
}

/// Look, then act — under one lock, which is the whole point of the function. Both
/// halves are closures so the ordering can be driven without a Tauri app: with a real
/// `AppHandle` the check is `get_webview_window` and the act is a webview build, and
/// neither exists in a unit test.
///
/// `Some(_)` from `focus_existing` means a window was there and carries the result of
/// raising it; `None` means there was none and the build is what happens instead. The
/// command is async and runs as its own task, so two rapid gestures interleaved: both
/// saw the window absent, one `build()` won and the other returned a `midi-window: …`
/// error for a window that was up — an error dialog for a success.
async fn open_once(
    opening: &tauri::async_runtime::Mutex<()>,
    focus_existing: impl FnOnce() -> Option<Result<(), String>>,
    build: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let _open = opening.lock().await;
    match focus_existing() {
        Some(focused) => focused,
        None => build(),
    }
}

/// Build the panel. Runs under `open_once`'s lock, so nothing else is between its
/// caller's "is it there?" and this.
///
/// Owned by the main window on WINDOWS ONLY, where that keeps it above its owner in
/// the z-order and minimizes it with the owner. On macOS the same call makes an
/// AppKit child window, which was measured to be unusable here — the builder below
/// says what was seen — so there it is an ordinary top-level window and staying in
/// front is handled where it matters, while a learn is armed. Deliberately not
/// "always on top" for the session: that would put the panel above every other
/// application throughout, which is a far larger promise than the one being made.
fn build_midi_window(app: &AppHandle, title: String) -> Result<(), String> {
    let main = app
        .get_webview_window(crate::MAIN_WINDOW)
        .ok_or_else(|| "midi-window: no main window".to_string())?;
    #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
    let mut builder =
        WebviewWindowBuilder::new(app, MIDI_WINDOW, WebviewUrl::App("midi.html".into()))
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
    // window above the main one and minimizes with it — and both halves of the macOS
    // finding were then measured there and are ABSENT: on a two-display desk this window
    // is drawn in full on the display the main window is not on, and moving the main
    // window across to the other display left it where it was, to the pixel. The
    // `#[cfg]` is therefore the measurement rather than a gap in it (architecture.md,
    // "Window geometry", carries the table, the rig and the rest of the run).
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
    // The main window is passed as the host to fall back on, and only that: it decides
    // the display for a remembered rectangle that lands on NO attached display, and
    // nothing else. A rectangle that still has a display of its own is restored where
    // it was — which is the requirement, and what an unconditional override broke.
    //
    // The fallback EARNED its place from what a window dragged by its owner ends up as.
    // Measured while this was still an AppKit child on macOS: a parent moved from
    // x=2344 to x=172 took this window from x=536 to x=-1636, off every display, where
    // the window server still reported it on-screen and opaque and nothing was drawn.
    // That drag reaches neither platform as things stand — macOS no longer has the
    // parent it took, and on Windows the owner was measured (2026-08-13, above) not to
    // move this window at all — so what the fallback still answers is the case in the
    // paragraph above, now reached by the desk changing under the rectangle rather than
    // by the window being dragged off a display.
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
/// comes forward for the one moment its contents matter. What HOLDS it in front of the
/// main window from there is the Win32 owner on Windows and `pin_midi_window` on macOS —
/// armed by the same gesture, one call after this one (`ui/midi.ts`) — so what this still
/// does is bring THIS window forward when another application is covering it.
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
///
/// On Windows this window still has an owner, and the two compose rather than one
/// standing in for the other: measured from the panel's own learn button, arming turned
/// the `WS_EX_TOPMOST` bit (0x8) on and disarming turned it back off — the extended
/// style went 0x110 -> 0x118 -> 0x110, the rest of it being whatever else that window
/// carries — with the order against the owner unchanged in both states. So nothing here
/// needs a `#[cfg]`.
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

#[cfg(test)]
mod tests {
    // Two gestures against `open_once`, with the window it is guarding standing in for
    // the webview: a flag one closure reads and the other sets. What is under test is
    // that the second gesture's LOOK cannot land between the first one's look and its
    // build — the interleaving that returned a `midi-window: …` error for a window that
    // was up.
    use super::{open_once, MidiUiState};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    /// The window, as the two closures see it.
    #[derive(Default)]
    struct Panel {
        up: AtomicBool,
        builds: AtomicUsize,
    }

    impl Panel {
        fn focus_existing(&self) -> Option<Result<(), String>> {
            self.up.load(Ordering::SeqCst).then_some(Ok(()))
        }

        fn build(&self) -> Result<(), String> {
            // The duplicate-label refusal a real second `build()` answers with.
            if self.up.swap(true, Ordering::SeqCst) {
                return Err("midi-window: a webview with label `midi` already exists".into());
            }
            self.builds.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    // Deterministic in the direction that matters: `open_once` above holds `_open`
    // across the `match focus_existing()`, so the second gesture is parked on that lock
    // and its look lands after this wait rather than inside it — the wait expires by the
    // structure of that function, not by winning a race. What the timing decides is the
    // other arm: with the lock removed, the second thread has 300 ms to reach one atomic
    // load, which is the shape of the mutation check rather than of this run.
    #[test]
    fn a_second_gesture_cannot_look_while_the_first_one_is_building() {
        let state = Arc::new(MidiUiState::default());
        let panel = Arc::new(Panel::default());
        let (building, in_build) = mpsc::channel();
        let (release, held) = mpsc::channel::<()>();
        let (looked, second_look) = mpsc::channel();

        let first = std::thread::spawn({
            let (state, panel) = (Arc::clone(&state), Arc::clone(&panel));
            move || {
                tauri::async_runtime::block_on(open_once(
                    &state.opening,
                    || panel.focus_existing(),
                    || {
                        building.send(()).unwrap();
                        held.recv().unwrap(); // park inside the build
                        panel.build()
                    },
                ))
            }
        });
        in_build.recv().unwrap(); // the first gesture is inside its build, holding the lock

        let second = std::thread::spawn({
            let (state, panel) = (Arc::clone(&state), Arc::clone(&panel));
            move || {
                tauri::async_runtime::block_on(open_once(
                    &state.opening,
                    || {
                        looked.send(()).unwrap();
                        panel.focus_existing()
                    },
                    || panel.build(),
                ))
            }
        });

        assert!(
            second_look
                .recv_timeout(Duration::from_millis(300))
                .is_err(),
            "the second gesture looked while the first still held the lock"
        );

        release.send(()).unwrap();
        assert_eq!(first.join().unwrap(), Ok(()), "the first gesture builds");
        assert_eq!(
            second.join().unwrap(),
            Ok(()),
            "and the second one raises what it found — not an error for a window that is up"
        );
        assert_eq!(
            panel.builds.load(Ordering::SeqCst),
            1,
            "one window, built once"
        );
    }

    // The ordinary second gesture, with nothing in flight: it must not build a second
    // time, and it carries back whatever raising the window answered.
    #[test]
    fn an_existing_window_is_raised_rather_than_rebuilt() {
        let state = MidiUiState::default();
        let panel = Panel::default();
        panel.up.store(true, Ordering::SeqCst);

        let r = tauri::async_runtime::block_on(open_once(
            &state.opening,
            || panel.focus_existing(),
            || panel.build(),
        ));

        assert_eq!(r, Ok(()));
        assert_eq!(panel.builds.load(Ordering::SeqCst), 0, "nothing was built");
    }

    // …and the lock does not outlive the command: a gesture that has returned leaves
    // the next one free, rather than the panel opening once per app run.
    #[test]
    fn the_lock_is_released_when_the_open_returns() {
        let state = MidiUiState::default();
        let panel = Panel::default();
        let open = || {
            tauri::async_runtime::block_on(open_once(
                &state.opening,
                || panel.focus_existing(),
                || panel.build(),
            ))
        };

        assert_eq!(open(), Ok(()));
        assert_eq!(
            open(),
            Ok(()),
            "the second gesture is not stuck on the lock"
        );
        assert_eq!(panel.builds.load(Ordering::SeqCst), 1);
    }
}
