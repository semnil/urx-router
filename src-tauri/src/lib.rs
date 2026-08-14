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
mod winfit;

/// The main window's label, shared with the Edit menu's delivery target and with
/// the MIDI window's parent lookup. It is also what `capabilities/default.json`
/// names, so the string exists in two places that cannot be merged — one more is
/// one too many.
pub const MAIN_WINDOW: &str = "main";

/// The launch flag that clears remembered state. Spelled once because it is now
/// answered in two halves — the frontend's localStorage and the geometry file —
/// and a rename that reached only one would leave a half-reset that nothing fails
/// on.
#[cfg(desktop)]
const RESET_STORAGE_FLAG: &str = "--reset-storage";

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
    // A unique sibling, created exclusively. `{path}.tmp` is a name two writers to the
    // same destination both open — a double-fired save, or a dev build and an installed
    // one exporting to the same file — and the second `write` truncates under the first,
    // so whichever `rename` lands last can install a mixed body over the target: exactly
    // the corruption an atomic write exists to prevent. It also destroyed a pre-existing
    // operator file that happened to be named `plan.json.tmp`.
    let mut tmp = String::new();
    let mut file = None;
    for n in 0..64u32 {
        let candidate = format!("{path}.{}.{n}.tmp", std::process::id());
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(f) => {
                tmp = candidate;
                file = Some(f);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(io_error(&e)),
        }
    }
    let Some(mut file) = file else {
        return Err("io-error: could not create a temporary file".into());
    };
    {
        use std::io::Write;
        if let Err(e) = file.write_all(bytes).and_then(|()| file.flush()) {
            drop(file);
            let _ = fs::remove_file(&tmp);
            return Err(io_error(&e));
        }
    }
    drop(file);
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
/// Whether `line` is ONE ledger line. Named rather than inlined so it can be tested:
/// the command around it needs an AppHandle and a real log directory.
fn link_log_line_ok(line: &str) -> bool {
    !line.chars().any(char::is_control)
}

#[tauri::command]
async fn append_link_log(app: tauri::AppHandle, line: String) -> Result<String, String> {
    use std::io::Write;
    use tauri::Manager;
    // One line means one line. The ledger reads an ABSENT session-end record as
    // "nothing closed this session", so a `line` carrying a newline — a serializer bug,
    // or any caller that is not the one this was written for — writes several records
    // in one call and can forge or split exactly the evidence the file exists to keep.
    // Other control characters go with it: they cannot appear in the JSON this emits and
    // they make a ledger line unreadable in a terminal.
    if !link_log_line_ok(&line) {
        return Err("bad-request: link log line carries a control character".into());
    }
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
// The window geometry is the one remembered thing that is not in localStorage;
// `reset_window_state_plugin` clears that half, before any window is created.
#[tauri::command]
fn reset_storage_requested() -> bool {
    static TAKEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    take_launch_action(&TAKEN, RESET_STORAGE_FLAG)
}

// Put the main window back where it was, inside a display.
//
// The window cannot be read back at startup, so this corrects the NUMBERS and then
// places the window once. Measured, after assuming the opposite: a `set_position`
// issued from the setup hook is queued, and both the hook and `RunEvent::Ready`
// still report the position the window was BORN at — the move only lands once the
// event loop has run. A read-then-correct at either point therefore reads a
// rectangle that is about to be replaced, which is worse than doing nothing: it
// reports the window as fine and then the restore moves it off the display.
//
// So the plugin's own restore is skipped for this window (`skip_initial_state`)
// and its saved rectangle is read here, corrected, and applied. Nothing is read
// back, so nothing can be stale.
//
// A plugin hook was tried instead, so that any future window would inherit the
// correction with nothing to remember: an `on_window_ready` registered after the
// window-state plugin's. **Measured, and it does not work** — inside that hook the
// MIDI window still reports the position it was BORN at even when the plugin has
// just restored it, because a `set_position` issued from a `window_created` hook
// is queued the same way one issued at startup is. It only lands before `build()`
// returns, which is why `open_midi_window` corrects the window there and not here.
#[cfg(desktop)]
fn restore_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(win) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    restore_window(
        &win.as_ref().window(),
        configured_min_inner(app, MAIN_WINDOW),
        // The main window answers to nothing: its remembered position is its own.
        None,
    );
}

// Put one window back where it was, inside a display. Both windows come through
// here: the plugin's own restore is skipped for both (`skip_initial_state`), because
// it applies a remembered rectangle as PHYSICAL pixels and nothing then knows what
// scale those pixels were measured at — on macOS that halves a rectangle remembered
// on a 1.0 display whenever the window is born on a 2.0 one, before any correction
// of ours gets a look at it.
#[cfg(desktop)]
pub(crate) fn restore_window(
    win: &tauri::Window,
    min_inner: (f64, f64),
    host_of: Option<&tauri::Window>,
) {
    use tauri::Manager;
    let app = win.app_handle();
    // The window's own label rather than one passed in: both call sites would be
    // repeating what the window already knows, and a pair that has to agree is a pair
    // that can disagree.
    let label = win.label();
    let placed = match saved_window_state(app, label) {
        Some(s) => {
            let position = tauri::PhysicalPosition::from(s.position());
            let size = tauri::PhysicalSize::new(s.width, s.height);
            // What scale the remembered rectangle was measured at. Recorded beside
            // it since this change; derived by trial for a file written before that,
            // and only then falling back to the window's own scale factor, which is
            // what every restore used to assume.
            let saved_scale = saved_window_scale(app, label)
                .or_else(|| winfit::saved_rect_scale(win, position, size));
            winfit::place_saved(win, position, size, saved_scale, min_inner, host_of).and_then(
                |()| {
                    if s.maximized {
                        win.maximize()?;
                    }
                    Ok(())
                },
            )
        }
        // Nothing saved is a first launch. The platform placed the window and
        // nothing has moved it, so its own reported rectangle is the truth — the
        // ordinary read-then-correct applies. It is still worth doing: the
        // configured size can be taller than a small display's work area.
        None => winfit::fit_window(win, min_inner),
    };
    if let Err(e) = placed {
        eprintln!("window place {label}: {e}");
    }
}

/// A window's configured minimum INNER size, in LOGICAL pixels, as `winfit` wants
/// it. Read from the running configuration rather than repeated here, so that
/// changing `minWidth` / `minHeight` in `tauri.conf.json` cannot leave a second
/// number behind. Zeroes when the window declares no minimum, which raises
/// nothing.
#[cfg(desktop)]
fn configured_min_inner(app: &tauri::AppHandle, label: &str) -> (f64, f64) {
    let Some(cfg) = app.config().app.windows.iter().find(|w| w.label == label) else {
        return (0.0, 0.0);
    };
    (cfg.min_width.unwrap_or(0.0), cfg.min_height.unwrap_or(0.0))
}

/// One window's entry in the window-state plugin's file, as this side needs it.
/// Read as data rather than asked for, because the plugin's cache and its
/// `WindowState` are both crate-private: the only public way to reach a saved
/// rectangle is the restore this window cannot use. The field names are therefore
/// a dependency's ON-DISK SCHEMA, not an API — read against
/// tauri-plugin-window-state 2.4.1, and a bump that renames one is what
/// `parse_saved_window`'s test exists to catch.
#[cfg(desktop)]
#[derive(serde::Deserialize)]
struct SavedWindow {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    // A maximized window is saved with the rectangle it had BEFORE it was
    // maximized, which is what un-maximizing goes back to. Defaulted rather than
    // required: an entry saved before the flag existed is still usable.
    #[serde(default)]
    prev_x: i32,
    #[serde(default)]
    prev_y: i32,
    #[serde(default)]
    maximized: bool,
}

#[cfg(desktop)]
impl SavedWindow {
    /// The outer position to place the window at.
    fn position(&self) -> (i32, i32) {
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
fn saved_window_state(app: &tauri::AppHandle, label: &str) -> Option<SavedWindow> {
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
const WINDOW_STATE_FLAGS: tauri_plugin_window_state::StateFlags =
    tauri_plugin_window_state::StateFlags::POSITION
        .union(tauri_plugin_window_state::StateFlags::SIZE)
        .union(tauri_plugin_window_state::StateFlags::MAXIMIZED);

/// The scale factors a session has captured for windows that have since closed. The
/// plugin next door keeps its rectangles the same way — an in-memory cache updated at
/// each close and written once at exit (`WindowStateCache`) — and matching it is what
/// makes the two files describe the same moment.
#[cfg(desktop)]
#[derive(Default)]
struct ClosedWindowScales(std::sync::Mutex<std::collections::HashMap<String, f64>>);

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
fn saved_window_scale(app: &tauri::AppHandle, label: &str) -> Option<f64> {
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
fn capture_window_scale(win: &tauri::Window) {
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
fn save_window_scales(app: &tauri::AppHandle) {
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
        .and_then(|()| write_atomic(&path.to_string_lossy(), &body))
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
fn window_state_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
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
fn reset_window_state_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
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
    // Taken BEFORE the handshake, which runs up to ~9 s. A page load inside that window
    // is a teardown for a page that no longer exists, and it cannot cancel this connect
    // — it finds nothing installed yet — so without the generation the session installed
    // under the same label afterwards, orphaned under the page that replaced it.
    let gen = state.page_gen(webview.label());
    let (tx, device, counters) = tauri::async_runtime::spawn_blocking(vd::open)
        .await
        .map_err(|_| vd::CONTROL_WORKER_GONE.to_string())??;
    // The epoch identifies this connection: the frontend hands it back to
    // vd_disconnect so a delayed teardown of an earlier session cannot close it.
    // The label identifies its OWNER, which is what decides whether a later page
    // load may tear it down (see the on_page_load hook in `run`).
    let epoch = state
        .install_for_page(tx, counters, webview.label(), gen)
        .ok_or_else(|| {
            "vd-page-gone: the page that asked for this connection reloaded".to_string()
        })?;
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
fn midi_close_input(webview: tauri::Webview, state: State<midi::MidiState>) {
    midi::close_input(&state, webview.label());
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
fn midi_close_output(webview: tauri::Webview, state: State<midi::MidiState>) {
    midi::close_output(&state, webview.label());
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

// No mobile entry point: this crate is desktop-only and cannot be built for one. `mod
// vd` and `mod midi` are unconditional while their contents are not — `vd::open` reaches
// `imp::worker`, which is `#[cfg(desktop)]`, and `midi.rs` uses `midir`, which is
// target-gated in Cargo.toml — so an android/ios build fails on unresolved names. The
// attribute promised a build that has never existed; gating the two modules instead
// would mean carrying a mobile arm nothing compiles or runs.
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
            // The moment the window-state plugin captures this window's rectangle is
            // also the moment to capture the scale it was measured at — the window is
            // still alive here, which by `Destroyed` it is not.
            #[cfg(desktop)]
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                capture_window_scale(window);
                // And put both on disk now. The plugin writes its file at
                // `RunEvent::Exit` and nowhere else, so anything that ends the process
                // without getting there loses every move since the last launch —
                // measured: across a dozen `tauri dev` rebuild-restarts the file's
                // mtime never moved, and the MIDI window came back to where it had
                // been hours earlier. `save_window_state` re-reads the live windows
                // before writing, so this does not depend on running after the
                // plugin's own handler for the same event.
                let app = window.app_handle();
                use tauri_plugin_window_state::AppHandleExt;
                let _ = app.save_window_state(WINDOW_STATE_FLAGS);
                save_window_scales(app);
            }
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

    // Where the operator left each window. Three plugins in a deliberate order —
    // `PluginStore` runs setups and window hooks in registration order, which is
    // the whole mechanism: clear the file before it is read, restore from it, then
    // correct what the restore produced.
    #[cfg(desktop)]
    let builder = builder
        .manage(ClosedWindowScales::default())
        .plugin(reset_window_state_plugin())
        .plugin(window_state_plugin())
        .setup(|app| {
            restore_main_window(app.handle());
            Ok(())
        });

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
        // Bumped first: a connect still in flight for the page being replaced is torn
        // down by its own install refusing, since this teardown has nothing to find.
        app.state::<vd::VdState>().note_page_load(label);
        vd::shutdown_owned_by(&app.state::<vd::VdState>(), label);
        midi::close_owned_by(&app.state::<midi::MidiState>(), label);
        // The idle-sleep hold belongs here for the same reason and is the least visible of
        // the three: the frontend takes it only while Live sync is up, so a reload during a
        // session would otherwise leave the machine awake for as long as the app runs, with
        // no page that knows the assertion exists. Nothing to salvage from a page that is
        // gone, and nothing to report to it.
        keepawake::release_owned_by(&app.state::<keepawake::KeepAwakeState>(), label);
        // And the MIDI window's always-on-top pin, which the main page takes while a
        // learn is armed. The window OUTLIVES this page, and the page that comes back
        // starts with learn off — so it never calls the release, and the panel stays
        // floating above every application for the rest of the run. Cleared from the
        // shell rather than from the new page for the same reason the three holds above
        // are: a page that is gone cannot release anything, and a page that never boots
        // (a crash, a failed reload) would not either.
        #[cfg(desktop)]
        if label == MAIN_WINDOW {
            let _ = midiwin::pin_midi_window(app.clone(), false);
        }
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
        if let Err(e) = app.emit_to(MAIN_WINDOW, EDIT_MENU_EVENT, id) {
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
            midiwin::pin_midi_window,
            midiwin::midi_window_open,
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
                // The one write of the scale file, beside the one write of the
                // rectangles the plugin makes on this same event. Both re-read the live
                // windows, so which of the two runs first cannot matter.
                #[cfg(desktop)]
                save_window_scales(app);
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
    // The main window's label is declared in tauri.conf.json and named again by the
    // capability file and by MAIN_WINDOW; nothing at runtime notices when one of the
    // three moves, because a capability that matches no window simply grants nothing
    // and a mismatched constant simply finds no window. A comment saying "keep these
    // in sync" would not fail a pull request; this does, and `cargo test` runs on one.
    #[test]
    fn the_main_windows_label_is_the_one_the_config_and_the_capability_name() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            conf["app"]["windows"][0]["label"].as_str(),
            Some(super::MAIN_WINDOW)
        );
        let cap: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert!(cap["windows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w.as_str() == Some(super::MAIN_WINDOW)));
    }

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

    // `{path}.tmp` was a name two writers to one destination both opened — a
    // double-fired save, or a dev build and an installed one exporting to the same
    // file — so the second truncated under the first and the later rename installed a
    // mixed body. It also destroyed a pre-existing operator file of that name.
    #[test]
    fn an_atomic_write_leaves_a_sibling_named_tmp_alone() {
        let dir = std::env::temp_dir().join(format!("urx-atomic-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("plan.json");
        let decoy = dir.join("plan.json.tmp");
        std::fs::write(&decoy, b"the operator's own file").unwrap();

        super::write_atomic(target.to_str().unwrap(), b"{}").unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"{}");
        assert_eq!(
            std::fs::read(&decoy).unwrap(),
            b"the operator's own file",
            "the fixed temp name destroyed this; a unique one cannot"
        );
        // …and nothing of ours is left behind.
        let strays: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n != "plan.json" && n != "plan.json.tmp")
            .collect();
        assert!(strays.is_empty(), "left behind: {strays:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // The ledger reads an ABSENT session-end record as "nothing closed this session",
    // so a line carrying a newline writes several records in one call and can forge or
    // split exactly the evidence the file exists to keep.
    #[test]
    fn a_link_log_line_carrying_a_control_character_is_refused() {
        assert!(super::link_log_line_ok("{\"ok\":true}"));
        assert!(!super::link_log_line_ok("{\"a\":1}\n{\"end\":true}"));
        assert!(!super::link_log_line_ok("{\"a\":\"\u{7}\"}"));
    }

    // The app's ACL is three hand-kept lists — build.rs's command set, the handler in
    // `run`, and the capability files — and nothing at runtime notices when one moves:
    // a capability naming a command that does not exist grants nothing, and a command
    // absent from build.rs simply has no permission to be denied by. Which is how the
    // MIDI window came to reach every app command while its own capability said it
    // reached none.
    #[test]
    fn every_app_command_is_declared_and_granted_to_the_window_that_may_call_it() {
        let build = include_str!("../build.rs");
        let lib = include_str!("lib.rs");
        let handler = lib
            .split("generate_handler![")
            .nth(1)
            .and_then(|s| s.split(']').next())
            .expect("the invoke handler list");
        let commands: Vec<String> = handler
            .split(',')
            .map(|s| s.trim().trim_start_matches("midiwin::").to_string())
            .filter(|s| !s.is_empty())
            .collect();
        assert!(commands.len() > 30, "read {} commands", commands.len());

        let main: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let granted: Vec<&str> = main["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        for cmd in &commands {
            assert!(
                build.contains(&format!("\"{cmd}\"")),
                "{cmd} is in the handler but not declared in build.rs, so no permission exists for it"
            );
            let perm = format!("allow-{}", cmd.replace('_', "-"));
            assert!(
                granted.contains(&perm.as_str()),
                "the main window is not granted {perm}"
            );
        }

        // …and the MIDI window is granted the relay pair and nothing else. Its whole
        // description rests on this: it is a view of the main window's state.
        let midi: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/midi-window.json")).unwrap();
        let mut midi_perms: Vec<&str> = midi["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .filter(|p| p.starts_with("allow-"))
            .collect();
        midi_perms.sort_unstable();
        assert_eq!(
            midi_perms,
            vec!["allow-midi-ui-attach-window", "allow-midi-ui-to-main"]
        );
    }
}
