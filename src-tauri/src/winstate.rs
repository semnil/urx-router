// What is remembered about each window between launches, as it sits on disk.
//
// Two files in the app's config directory: the window-state plugin's own, which holds
// each window's rectangle and is read here as data, and `.window-scale.json` beside
// it, which holds the display scale each of those rectangles belongs to. Reading
// them, writing the second, and the two plugins that save and clear them are here;
// deciding where a window goes from what was read is `restore_window` in `lib.rs`
// and `winfit`.

#[cfg(desktop)]
use crate::{io_error, midiwin, write_atomic, MAIN_WINDOW, RESET_STORAGE_FLAG};
#[cfg(desktop)]
use std::fs;

/// One window's entry in the window-state plugin's file, as this side needs it.
/// Read as data rather than asked for, because the plugin's cache and its
/// `WindowState` are both crate-private: the only public way to reach a saved
/// rectangle is the restore this window cannot use. The field names are therefore
/// a dependency's ON-DISK SCHEMA, not an API — read against
/// tauri-plugin-window-state 2.5.0, and a bump that renames one is what
/// `parse_saved_window`'s test exists to catch.
#[cfg(desktop)]
#[derive(serde::Deserialize)]
pub(crate) struct SavedWindow {
    x: i32,
    y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
    // A maximized window is saved with the rectangle it had BEFORE it was
    // maximized, which is what un-maximizing goes back to. Defaulted rather than
    // required: an entry saved before the flag existed is still usable.
    #[serde(default)]
    prev_x: i32,
    #[serde(default)]
    prev_y: i32,
    #[serde(default)]
    pub(crate) maximized: bool,
}

#[cfg(desktop)]
impl SavedWindow {
    /// The outer position to place the window at.
    pub(crate) fn position(&self) -> (i32, i32) {
        if self.maximized {
            (self.prev_x, self.prev_y)
        } else {
            (self.x, self.y)
        }
    }
}

/// Pull one label's entry out of the state file's text. Pure so it can be tested
/// without an app, a window or a display — the same reason `winfit`'s arithmetic
/// is a pure function.
#[cfg(desktop)]
fn parse_saved_window(text: &str, label: &str) -> Option<SavedWindow> {
    let all: serde_json::Value = serde_json::from_str(text).ok()?;
    serde_json::from_value(all.get(label)?.clone()).ok()
}

#[cfg(desktop)]
pub(crate) fn saved_window_state(app: &tauri::AppHandle, label: &str) -> Option<SavedWindow> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().ok()?;
    // No file is the ordinary first launch and says nothing. A file that exists
    // and holds no usable entry for this label is a different thing — the schema
    // moved under us — and it is the one case worth a line, since the symptom
    // otherwise is only "the app quietly stopped remembering where it was".
    let text = fs::read_to_string(dir.join(tauri_plugin_window_state::DEFAULT_FILENAME)).ok()?;
    let saved = parse_saved_window(&text, label);
    if saved.is_none() {
        eprintln!("window state: no usable entry for {label}");
    }
    saved
}

// The display scale each remembered rectangle was measured at, kept beside the
// window-state plugin's file rather than in it.
//
// `.window-state.json` holds a rectangle in physical pixels and records NOTHING about
// the display it came from, so the numbers cannot be interpreted at the next launch.
// That is not a shortcoming of the plugin so much as of physical pixels: on macOS a
// rectangle's physical value is its points times the scale factor of whatever it
// belongs to (`winfit`'s header has the measurement), so 1234x813 saved on a 1.0
// display and 617x407 saved on a 2.0 one are the same numbers to a reader that does
// not know which it is looking at. The plugin's schema belongs to the dependency and
// is read here as data, so the missing field is added as a file of our own.
//
// Written at the two moments the plugin captures a rectangle — a window closing, and
// the app exiting — so that the pair cannot drift. Both are re-reads of the live
// window (the plugin's `update_state` does the same), and the event loop cannot move
// a window between our read and its own.
#[cfg(desktop)]
const WINDOW_SCALE_FILENAME: &str = ".window-scale.json";

/// What the window-state plugin saves, named once. The plugin is registered with it
/// and the flush below writes with it, and a pair that has to agree is a pair that
/// can disagree.
#[cfg(desktop)]
pub(crate) const WINDOW_STATE_FLAGS: tauri_plugin_window_state::StateFlags =
    tauri_plugin_window_state::StateFlags::POSITION
        .union(tauri_plugin_window_state::StateFlags::SIZE)
        .union(tauri_plugin_window_state::StateFlags::MAXIMIZED);

/// The scale factors a session has captured for windows that have since closed. The
/// plugin next door keeps its rectangles the same way — an in-memory cache updated at
/// each close and written once at exit (`WindowStateCache`) — and matching it is what
/// makes the two files describe the same moment.
#[cfg(desktop)]
#[derive(Default)]
pub(crate) struct ClosedWindowScales(std::sync::Mutex<std::collections::HashMap<String, f64>>);

/// Pull one label's scale out of the scale file's text. Pure for the same reason
/// `parse_saved_window` is: it is the only part of this that can be tested without an
/// app, a window or a display.
#[cfg(desktop)]
fn parse_window_scale(text: &str, label: &str) -> Option<f64> {
    let all: serde_json::Value = serde_json::from_str(text).ok()?;
    let scale = all.get(label)?.as_f64()?;
    // A scale factor of zero or worse would poison every conversion downstream, and
    // an absent entry is already handled, so a nonsense one is treated as absent.
    (scale.is_finite() && scale > 0.0).then_some(scale)
}

/// The scale factor recorded for `label`, if this app has written the file at all.
/// A rectangle from an older version simply has no entry and is derived instead.
#[cfg(desktop)]
pub(crate) fn saved_window_scale(app: &tauri::AppHandle, label: &str) -> Option<f64> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().ok()?;
    parse_window_scale(
        &fs::read_to_string(dir.join(WINDOW_SCALE_FILENAME)).ok()?,
        label,
    )
}

/// Capture one window's scale factor into the cache, at the moment the plugin captures
/// its rectangle. No disk touched: the plugin does not write here either, and a write
/// on the close path is a write during the close animation.
#[cfg(desktop)]
pub(crate) fn capture_window_scale(win: &tauri::Window) {
    use tauri::Manager;
    let Ok(scale) = win.scale_factor() else {
        return;
    };
    if let Some(state) = win.try_state::<ClosedWindowScales>() {
        if let Ok(mut held) = state.0.lock() {
            held.insert(win.label().to_string(), scale);
        }
    }
}

/// Write the scale of every window still open, over the ones captured as they closed,
/// over whatever a previous session left on disk. Three layers because each knows
/// something the next does not: a label this session never opened has to survive, and
/// a window that closed an hour ago is no longer there to ask.
#[cfg(desktop)]
pub(crate) fn save_window_scales(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let path = dir.join(WINDOW_SCALE_FILENAME);
    let mut all = fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&t).ok())
        .unwrap_or_default();
    if let Some(held) = app
        .try_state::<ClosedWindowScales>()
        .and_then(|s| s.0.lock().ok().map(|h| h.clone()))
    {
        for (label, scale) in held {
            all.insert(label, scale.into());
        }
    }
    for (label, win) in app.webview_windows() {
        if let Ok(scale) = win.scale_factor() {
            all.insert(label, scale.into());
        }
    }
    // Serialized before anything is written, and written through the rename: a file
    // truncated by a failed write would be read next launch as "no scale recorded",
    // which sends every restore back to deriving one. Keeping the previous answer is
    // strictly better than replacing it with nothing.
    let Ok(body) = serde_json::to_vec_pretty(&all) else {
        eprintln!("window scale save: cannot serialize {all:?}");
        return;
    };
    // The directory is the plugin's too, and it creates it at its own save; doing it
    // here as well means the order of the two saves cannot decide whether this file
    // can be written.
    if let Err(e) = fs::create_dir_all(&dir)
        .map_err(|e| io_error(&e))
        .and_then(|()| write_atomic(&path.to_string_lossy(), &body, &["json"]))
    {
        eprintln!("window scale save: {e}");
    }
}

// What is remembered per window: a position, a size and the maximized flag,
// written out when a window closes and when the app exits.
//
// VISIBLE is deliberately outside the set: it would restore a window that was
// hidden when the app quit as hidden, which is an app with no window and no way to
// ask for one. FULLSCREEN likewise — that is a mode entered for a session, not a
// place a window sits.
//
// BOTH windows opt out of the plugin's restore and keep its saving: it applies a
// remembered rectangle as physical pixels, which is not a rectangle any more once the
// display it was measured on and the one the window is born on disagree about scale
// (`restore_window` says why, `winfit`'s header has the measurement). What is left of
// the plugin here is the half that works — the saving, which re-reads the live window
// at each capture and is therefore always self-consistent.
#[cfg(desktop)]
pub(crate) fn window_state_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_window_state::Builder::new()
        .with_state_flags(WINDOW_STATE_FLAGS)
        .skip_initial_state(MAIN_WINDOW)
        .skip_initial_state(midiwin::MIDI_WINDOW)
        .build()
}

// --reset-storage clears what the frontend keeps in localStorage; the window
// geometry is the one piece of remembered state that lives outside it, in a file
// the window-state plugin reads during its own setup. The delete has to happen
// before that read, which is why this is a plugin of its own registered ahead of
// it rather than a line in the app's setup hook — plugin setups run in
// registration order, and the app's own runs after all of them.
//
// Not routed through `take_launch_action`: that latch exists so a one-shot action
// cannot re-fire on a page reload, and this one is not reachable from a page at
// all. It runs once, before the first window exists.
#[cfg(desktop)]
pub(crate) fn reset_window_state_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("urx-reset-window-state")
        .setup(|app, _api| {
            use tauri::Manager;
            if !std::env::args().any(|a| a == RESET_STORAGE_FLAG) {
                return Ok(());
            }
            // A missing file is the ordinary first-launch case, and nothing
            // downstream depends on the delete having happened: with no file the
            // plugin starts from an empty cache either way. The scale file goes with
            // it — a scale left behind for a rectangle that no longer exists would be
            // read against the next rectangle written under that label.
            if let Ok(dir) = app.path().app_config_dir() {
                for name in [
                    tauri_plugin_window_state::DEFAULT_FILENAME,
                    WINDOW_SCALE_FILENAME,
                ] {
                    match fs::remove_file(dir.join(name)) {
                        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                            eprintln!("reset window state: {e}");
                        }
                        _ => {}
                    }
                }
            }
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    // The window-state plugin's file is a schema, not an API (see SavedWindow), so
    // the shape it is read against is pinned here rather than left to be discovered
    // at the next Dependabot bump — with a real entry, maximized case included.
    #[test]
    fn a_saved_window_is_read_at_the_rectangle_it_goes_back_to() {
        let text = r#"{
          "main": { "width": 1280, "height": 800, "x": 2392, "y": -110,
                    "prev_x": 0, "prev_y": 0, "maximized": false,
                    "visible": true, "decorated": true, "fullscreen": false },
          "midi": { "width": 440, "height": 620, "x": 900, "y": 40,
                    "prev_x": 120, "prev_y": 60, "maximized": true,
                    "visible": true, "decorated": true, "fullscreen": false }
        }"#;
        let main = super::parse_saved_window(text, "main").unwrap();
        assert_eq!(
            (main.position(), main.width, main.height),
            ((2392, -110), 1280, 800)
        );
        // Maximized: the position is the one un-maximizing goes back to, not the
        // maximized frame's own origin.
        let midi = super::parse_saved_window(text, "midi").unwrap();
        assert_eq!(midi.position(), (120, 60));
        // An absent label, a label whose entry is missing a required field, and text
        // that is not JSON all read as "nothing saved" rather than as a default.
        assert!(super::parse_saved_window(text, "absent").is_none());
        assert!(super::parse_saved_window(r#"{"main":{"x":1,"y":2}}"#, "main").is_none());
        assert!(super::parse_saved_window("not json", "main").is_none());
    }

    // The scale file is this app's own schema, unlike the one above, and it is the
    // thing that makes a remembered rectangle interpretable at all — so a value that
    // cannot be used has to read as "nothing recorded" (the restore then derives one)
    // rather than as a number that divides every coordinate by itself.
    #[test]
    fn a_scale_that_cannot_be_used_reads_as_nothing_recorded() {
        let text = r#"{ "main": 2.0, "midi": 1, "zero": 0, "neg": -1.5, "text": "2.0" }"#;
        assert_eq!(super::parse_window_scale(text, "main"), Some(2.0));
        // An integer is a scale factor too — nothing writes one, but nothing forbids it.
        assert_eq!(super::parse_window_scale(text, "midi"), Some(1.0));
        for label in ["zero", "neg", "text", "absent"] {
            assert_eq!(super::parse_window_scale(text, label), None, "{label}");
        }
        assert_eq!(super::parse_window_scale("not json", "main"), None);
        // A truncated file — what a failed write used to be able to leave behind, and
        // the reason this one goes through `write_atomic`.
        assert_eq!(super::parse_window_scale("", "main"), None);
    }
}
