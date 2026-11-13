# Decisions: window geometry

> 日本語版: [../../ja/decisions/window-geometry.md](../../ja/decisions/window-geometry.md)

Closed decisions about where the app's windows are placed, kept and restored. The rules are in
[architecture.md](../architecture.md), "Window geometry"; the pull requests are
[#274](https://github.com/semnil/urx-router/pull/274),
[#291](https://github.com/semnil/urx-router/pull/291) and
[#293](https://github.com/semnil/urx-router/pull/293). This document holds what was chosen over what.
"The operator" below is the person who directs this project's work and decides for it.

## Where a window sits

**Decisions (2026-08-07, #274).** The operator asked for three things — never off screen, the MIDI
CONTROL window always in front of the main one, and the last position and size restored — and chose
among the options for each.

- **The geometry is saved by the window-state plugin.** Writing it by hand, and keeping it in
  `localStorage`, were turned down. With that came the instruction to remove the MIDI window's own
  `localStorage` memory, so that there is one store.
- **A window is fitted whole inside the work area.** "Part of it visible is enough" was turned down.
- **Staying in front is done with a parent and child window.** `always_on_top` was turned down.
- **The maximized state is restored as well.**
- **`--reset-storage` also deletes the geometry file.** That was not asked for; without it a reset
  would leave the position behind.

**What changed later.** On macOS the parent and child relation was dropped
([#345](https://github.com/semnil/urx-router/pull/345)): the MIDI window is an independent window
there and is kept in front only while a learn is armed. The relation remains on Windows.

**Where the code for that store is (2026-11-12).** What reads the plugin's file, keeps the scale file
beside it (#291) and registers the two plugins that save and clear both is one module,
`src-tauri/src/winstate.rs`. The operator decided to separate it; it was moved out of `lib.rs` as it
stood, with no change in behaviour.

## The two restores are not unified

**Decision.** The main window and the MIDI window are corrected in two places, in two ways, and they
stay that way.

- The main window: the app reads the saved file itself, corrects the numbers, and applies them once
  (`restore_main_window`). The code assumes that a window cannot be read back at start-up — a position
  set from the setup hook is queued, and reading the window still gives the position it was created
  at.
- The MIDI window: it is built from a command while the event loop is running, so it can be read
  back, and the correction sits at the end of `open_midi_window`.

**Tried once and dropped.** Registering a plugin of the app's own behind the window-state plugin and
correcting every window when it is ready. Inside that hook a window still reports its creation
position even though the plugin has just restored it, so there is nothing to correct against. The
position lands when the build returns.

**Why it looks like duplication.** The asymmetry above is the whole reason the same work appears
twice. The plugin's own guard is not a substitute: the code assumes it restores a position as long as
one corner of the saved rectangle touches a monitor, and that it never shrinks a window that does not
fit.

## One coordinate space, named

**Decisions (2026-08-09, #291).** The fix for monitors of different scale factors.

- **The coordinate space has a name, and the platforms part in one place.** In `winfit` it is the
  *desk*: points on macOS, physical pixels on Windows, reached only through `physical_per_desk`. An
  earlier comment argued for staying in physical pixels because monitors and windows are both
  reported in them. That is not the same as being reported in one space: on macOS each rectangle is
  scaled by its own object's factor, so two work areas can overlap where they share no pixel.
- **Turned down: a phantom type** such as `Rect<Desk>` to make the compiler keep the spaces apart. The
  boundary is four functions.
- **`desk_per_logical` is derived from `physical_per_desk`**, and a test pins the identity between
  them. It is not listed as a second fact about the platform.
- **One `cfg!()` branch, not a pair of `#[cfg]` functions.** With a pair, the doc comment sits on one
  arm only and does not reach the reader of the other. That had happened in three pairs.

**What went wrong.** The path that applies the geometry on Windows was left to be checked on Windows
(#293), and the condition written for "settled" was wrong. It was built around the scale-change
event, and the main window never receives that event although it is rescaled, because it is placed
from the setup hook. What has to be looked at is the final rectangle, not an event on the way.
