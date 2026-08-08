// Keeping a window inside a display.
//
// The window-state plugin restores a saved rectangle whenever ONE CORNER of it
// still touches a monitor, and it never shrinks a window that no longer fits
// (read in tauri-plugin-window-state 2.4.1; this is the module's whole reason to
// exist, so a bump that tightens it is a reason to re-read this). Both gaps show
// up on the machines this app runs on: a window last placed on a
// second display comes back with one corner on the laptop panel and the rest of
// it nowhere, and the 1280x800 default is taller than the work area of a 1366x768
// screen, so its bottom edge — the resize grip included — sits under the taskbar.
//
// The rule here is the stronger one the operator asked for: the WHOLE window ends
// up inside a display's work area (the monitor minus the menu bar / taskbar),
// moved first and shrunk only when it cannot fit.
//
// **Every rectangle below is in DESK units, and which unit that is depends on the
// platform** — see `physical_per_desk`. This module used to do its arithmetic in
// physical pixels on the grounds that monitor rectangles and window rectangles are
// both reported in them, and that converting would have to pick a scale factor.
// The second half was right and the first half was not: on macOS a "physical"
// rectangle is points times the scale factor of THE OBJECT IT BELONGS TO, so two
// displays at different scales are not measured in one space at all. Measured, on
// the machine this was written on: a 1512x982@2.0 built-in panel and a
// 2560x1440@1.0 external one report work areas of (0,66 3024x1898) and
// (1512,-458 2560x1380), which overlap by 1,294,272 px² where the displays
// themselves share nothing. The arithmetic that overlap feeds decides which
// display a window belongs to and then clamps it into that display's rectangle.

use tauri::{PhysicalPosition, PhysicalSize, Position, Runtime, Size, Window};

/// Physical pixels per desk unit on a display whose scale factor is `scale`.
///
/// The desk is the one coordinate space every monitor and every window shares, and
/// **which space that is is a property of the platform, not a choice**:
///
/// - **macOS: points.** `NSWindow`'s frame and `CGDisplayBounds` are both in points,
///   and a point spans the same desk on every display. tao multiplies each rectangle
///   by the scale factor of the object it came from — a monitor by its own
///   (`tao/platform_impl/macos/monitor.rs`), a window by its own
///   (`.../macos/window.rs`), a work area by the monitor's
///   (`tauri-runtime-wry/src/monitor/macos.rs`) — so its physical values for a
///   mixed-scale arrangement are not comparable with each other.
/// - **Windows: physical pixels.** `rcWork` comes from `GetMonitorInfoW` in
///   virtual-screen coordinates, which are real pixels laid out coherently across
///   displays for a per-monitor-DPI-aware process. Dividing per monitor would be the
///   error there.
///
/// A nonsense scale factor answers 1.0, which makes this the only place that has to
/// know what a usable one is: every conversion below divides by the result and so
/// cannot produce an infinity or a NaN, and 1.0 leaves the physical numbers alone —
/// the same answer the guards each of them used to carry arrived at.
fn physical_per_desk(scale: f64) -> f64 {
    if cfg!(target_os = "macos") && scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

/// Desk units per logical pixel on a display whose scale factor is `scale`. Needed
/// because a configured minimum is stated in logical pixels.
///
/// Derived rather than a second platform fact: logical to physical is `scale`
/// everywhere, so this is whatever is left once `physical_per_desk` is taken out.
/// The scale factor is still checked here because this MULTIPLIES by it, which a
/// sanitized divisor cannot rescue.
fn desk_per_logical(scale: f64) -> f64 {
    if scale.is_finite() && scale > 0.0 {
        scale / physical_per_desk(scale)
    } else {
        1.0
    }
}

/// A rectangle in desk units. A window's outer bounds and a monitor's work area are
/// both one of these, which is what lets the arithmetic below be a pure function
/// with tests of its own — no window and no display needed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    fn right(&self) -> i32 {
        self.x.saturating_add(self.width as i32)
    }

    fn bottom(&self) -> i32 {
        self.y.saturating_add(self.height as i32)
    }

    fn center(&self) -> (i64, i64) {
        (
            self.x as i64 + self.width as i64 / 2,
            self.y as i64 + self.height as i64 / 2,
        )
    }

    /// Area the two rectangles share, in desk units squared. Zero when they only
    /// touch.
    fn overlap(&self, other: &Rect) -> u64 {
        let w = self.right().min(other.right()) - self.x.max(other.x);
        let h = self.bottom().min(other.bottom()) - self.y.max(other.y);
        if w <= 0 || h <= 0 {
            0
        } else {
            w as u64 * h as u64
        }
    }

    /// Squared distance between the two centers. Squared because it is only ever
    /// compared with another one of these.
    fn center_distance2(&self, other: &Rect) -> u64 {
        let (ax, ay) = self.center();
        let (bx, by) = other.center();
        let dx = ax.abs_diff(bx);
        let dy = ay.abs_diff(by);
        dx * dx + dy * dy
    }
}

/// One attached display: its work area in desk units, and the scale factor a size
/// on it is measured with. The scale factor travels WITH the rectangle because the
/// only reason to know it is to convert a logical minimum or a window size against
/// that particular display, and reading it separately is how the two came apart.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Display {
    work: Rect,
    scale: f64,
}

/// A physical rectangle's four edges in desk units, unrounded. The two callers below
/// differ only in which way they round, which is the whole of what each of them says.
fn desk_edges(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    scale: f64,
) -> (f64, f64, f64, f64) {
    let k = physical_per_desk(scale);
    (
        position.x as f64 / k,
        position.y as f64 / k,
        (position.x as f64 + size.width as f64) / k,
        (position.y as f64 + size.height as f64) / k,
    )
}

fn desk_rect(left: f64, top: f64, right: f64, bottom: f64) -> Rect {
    Rect {
        x: left as i32,
        y: top as i32,
        width: (right - left).max(0.0) as u32,
        height: (bottom - top).max(0.0) as u32,
    }
}

/// A work area in desk units, rounded INWARD — the origin up and the far edge down —
/// so it can only come out smaller than the display really offers, and the fit below
/// can only be stricter than it needs to be.
fn work_to_desk(position: PhysicalPosition<i32>, size: PhysicalSize<u32>, scale: f64) -> Rect {
    let (l, t, r, b) = desk_edges(position, size, scale);
    desk_rect(l.ceil(), t.ceil(), r.floor(), b.floor())
}

/// A window's rectangle in desk units, rounded OUTWARD, so a window is never judged
/// smaller than it is — the other half of keeping the fit on the strict side.
fn window_to_desk(position: PhysicalPosition<i32>, size: PhysicalSize<u32>, scale: f64) -> Rect {
    let (l, t, r, b) = desk_edges(position, size, scale);
    desk_rect(l.floor(), t.floor(), r.ceil(), b.ceil())
}

/// The display a window belongs to: the one it overlaps most, or — when it overlaps
/// none, which is what a display being unplugged looks like — the one whose center
/// is nearest.
///
/// Nearest rather than primary: with a laptop panel to the left of an external
/// display, nearest brings a window back to the side of the desk it was on, and
/// on a single display the two answers are the same anyway.
fn host_display(win: Rect, displays: &[Display]) -> Option<Display> {
    displays.iter().copied().max_by_key(|d| {
        (
            win.overlap(&d.work),
            std::cmp::Reverse(win.center_distance2(&d.work)),
        )
    })
}

/// Move — and only if it must, shrink — `win` so that it lies entirely inside
/// `work`.
fn fit(win: Rect, work: Rect) -> Rect {
    let width = win.width.min(work.width);
    let height = win.height.min(work.height);
    Rect {
        x: win.x.clamp(work.x, work.x + (work.width - width) as i32),
        y: win.y.clamp(work.y, work.y + (work.height - height) as i32),
        width,
        height,
    }
}

/// Every attached display, in the order the platform lists them.
fn displays<R: Runtime>(win: &Window<R>) -> tauri::Result<Vec<Display>> {
    Ok(win
        .available_monitors()?
        .iter()
        .map(|m| {
            let a = m.work_area();
            let scale = m.scale_factor();
            Display {
                work: work_to_desk(a.position, a.size, scale),
                scale,
            }
        })
        .collect())
}

/// What the window frame adds around the content: outer size minus inner size.
/// Zero on macOS, where tao reports the content size for both. It is a pure
/// function of the two sizes so that a caller which already holds them — every
/// caller does — pays no second read, and so that the direction it is applied in
/// is decided in one place rather than added here and subtracted there.
///
/// The two sizes are physical and the answer is wanted in desk units, so it takes
/// the scale they were measured at. That is the scale of the display the window is
/// on NOW, which is not necessarily the one it is about to move to: on Windows the
/// frame is (16, 39) at 100% and (26, 71) at 200%, and there is no way to ask for
/// the frame at a DPI the window has not visited (`AdjustWindowRectExForDpi` is not
/// reachable through Tauri). The residual error is bounded by that difference and
/// lands on the containment test only. On macOS both numbers are zero, so it is
/// exact.
fn frame_delta(outer: PhysicalSize<u32>, inner: PhysicalSize<u32>, scale: f64) -> (u32, u32) {
    let k = physical_per_desk(scale);
    let px = outer.width.saturating_sub(inner.width) as f64;
    let py = outer.height.saturating_sub(inner.height) as f64;
    ((px / k).ceil() as u32, (py / k).ceil() as u32)
}

/// Raise an OUTER rectangle so that the window it describes is at least
/// `min_inner` — a LOGICAL size, as `tauri.conf.json` and `min_inner_size` both
/// express it — on a display where one logical pixel spans `desk_per_logical` desk
/// units.
///
/// The minimum has to be raised at all because **a programmatic size is not raised
/// to it**: Windows enforces a minimum through `WM_GETMINMAXINFO`, which a user drag
/// goes through and a `SetWindowPos` does not, and AppKit's `contentMinSize`
/// constrains a drag rather than a `setContentSize:`. Measured on Windows — a
/// remembered 1280x800 came back at 150% as an 854x534 CSS viewport against a
/// configured 960x640 minimum.
fn at_least(win: Rect, min_inner: (f64, f64), factor: f64, frame: (u32, u32)) -> Rect {
    let px = |v: f64| {
        let v = v * factor;
        if v.is_finite() && v > 0.0 {
            v.round() as u32
        } else {
            0
        }
    };
    Rect {
        width: win.width.max(px(min_inner.0).saturating_add(frame.0)),
        height: win.height.max(px(min_inner.1).saturating_add(frame.1)),
        ..win
    }
}

/// A desk position, in the flavour the platform's setters take: logical on macOS,
/// where the desk is in points, and physical on Windows, where it is in pixels.
/// Passing the desk numbers through the OTHER flavour is the bug this module was
/// rewritten for — tao divides a physical position by the window's own scale factor
/// (`macos/window.rs`), which sends a rectangle remembered on a 1.0 display to half
/// its coordinates when the window happens to be born on a 2.0 one.
///
/// `cfg!` rather than a `#[cfg]` pair so that this paragraph — and the one on
/// `desk_size` — is attached to the function on BOTH platforms. A pair documents only
/// the arm it is written above, and the arm that needs no explanation is the one whose
/// reader has none.
fn desk_position(x: i32, y: i32) -> Position {
    if cfg!(target_os = "macos") {
        tauri::LogicalPosition::new(x as f64, y as f64).into()
    } else {
        PhysicalPosition::new(x, y).into()
    }
}

/// A desk size, in the flavour the platform's setters take. Same reasoning as
/// `desk_position`.
fn desk_size(width: u32, height: u32) -> Size {
    if cfg!(target_os = "macos") {
        tauri::LogicalSize::new(width as f64, height as f64).into()
    } else {
        PhysicalSize::new(width, height).into()
    }
}

/// Put a window at `want` — its OUTER rectangle, in desk units — corrected so that
/// it lies entirely inside a display's work area and is no smaller than `min_inner`
/// (logical, matching how the minimum is configured). `frame` is what the window
/// frame adds around the content, in desk units, from `frame_delta`.
///
/// `want` is a rectangle about to be applied, not necessarily one the window is
/// at: at startup the window cannot be read back (see `restore_window` in lib.rs),
/// so the caller passes the numbers it is about to place.
///
/// A maximized, fullscreen or minimized window is left alone: its rectangle
/// belongs to the window manager, and setting a position on a maximized window is
/// how it silently stops being maximized.
fn place_window<R: Runtime>(
    win: &Window<R>,
    want: Rect,
    min_inner: (f64, f64),
    frame: (u32, u32),
) -> tauri::Result<()> {
    if win.is_maximized()? || win.is_minimized()? || win.is_fullscreen()? {
        return Ok(());
    }
    let displays = displays(win)?;
    // The host is picked from the rectangle AS IT STANDS, before the minimum is
    // applied. It has to be, twice over: the minimum is logical and only means a
    // number of desk units once a display is chosen, and a rectangle inflated to a
    // minimum overlaps the displays differently from the window that was actually
    // there — measured, a 1400x900 window on one display was inflated to 1920x1280
    // and the inflated rectangle then named the other one as its host.
    let Some(host) = host_display(want, &displays) else {
        return Ok(());
    };
    let want = at_least(want, min_inner, desk_per_logical(host.scale), frame);
    // A window whose minimum is larger than the work area ends up smaller than
    // its minimum: fitting wins, and the platform does not raise the result. There
    // is nothing better to do than pin its top-left corner, which the move below
    // does.
    let fitted = fit(want, host.work);
    // The size setter takes the INNER size, so the frame has to come off the
    // fitted outer rectangle before it is handed back — handing the outer size
    // over would grow the window by the height of its own title bar at every
    // launch.
    //
    // **These two calls are where the open Windows item lives**, and the guarantee at
    // the head of this module is void on that path: the size lands while the window is
    // still on the display it was born on, and the move below crosses a DPI boundary,
    // at which point the OS resizes the window to preserve its LOGICAL size (tao's
    // `WM_DPICHANGED` handler). Nothing here can see that happen. The measurement that
    // would settle it, and the one-line fix it would authorize, are in
    // `reference/work/windows-verify/`; architecture.md "Window geometry" states the
    // consequence. On macOS the desk is in points, so there is no rescale to lose to.
    win.set_size(desk_size(
        fitted.width.saturating_sub(frame.0),
        fitted.height.saturating_sub(frame.1),
    ))?;
    win.set_position(desk_position(fitted.x, fitted.y))?;
    Ok(())
}

/// Put a window at a REMEMBERED rectangle: an outer position and an inner size, both
/// physical, as the window-state file holds them, measured at `saved_scale` —
/// `None` meaning nothing recorded it, which falls back to the window's own scale
/// factor, what every restore used to assume.
///
/// This exists so that the frame is added and subtracted in one module. Its caller
/// holds a rectangle and a scale; it should not also have to know that the saved size
/// is the inner one and the saved position the outer one.
pub fn place_saved<R: Runtime>(
    win: &Window<R>,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    saved_scale: Option<f64>,
    min_inner: (f64, f64),
) -> tauri::Result<()> {
    // Measured on the window as it was born, the one moment its own size is beyond
    // doubt — nothing has asked to change it yet.
    let scale = win.scale_factor()?;
    let frame = frame_delta(win.outer_size()?, win.inner_size()?, scale);
    let want = window_to_desk(position, size, saved_scale.unwrap_or(scale));
    place_window(
        win,
        Rect {
            width: want.width.saturating_add(frame.0),
            height: want.height.saturating_add(frame.1),
            ..want
        },
        min_inner,
        frame,
    )
}

/// Which display's scale factor a remembered PHYSICAL rectangle was measured at,
/// for a state file written before the scale was recorded beside it.
///
/// The trial: assume each display in turn, convert the rectangle to desk units with
/// that display's scale factor, and accept the display when the result lies inside
/// its work area. A single acceptance is the answer; none and several are both
/// "unknown", and the caller falls back to the window's own scale factor, which is
/// what this module used unconditionally before.
///
/// Measured over the two displays this was written against: 98% of the positions a
/// 1234x813 window can take are resolved uniquely, 87% for a 440x620 one, and **no
/// position is resolved to the wrong display**. The two holes are real, which is why
/// the scale is recorded going forward rather than derived: a rectangle inside the
/// region the two displays' desk rectangles both cover is ambiguous, and a rectangle
/// that is no longer on any display — the case this whole module exists for —
/// matches nothing at all.
///
/// Where a desk unit already is a physical pixel (Windows) the conversion is the
/// identity and the answer cannot matter: every hypothesis produces the same
/// rectangle. The function is still called there, and still returns something
/// harmless, rather than being a platform branch at the call site.
///
/// **It retires itself.** The first clean exit after a restore records the scale for
/// every window that is open, so a trial happens at most once per window per state
/// file — which is what makes a heuristic acceptable on this path at all. What it
/// cannot do is prove itself dead, so the code stays until the scale file has a
/// version to check.
fn recover_scale(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    displays: &[Display],
) -> Option<f64> {
    let mut found: Option<f64> = None;
    for d in displays {
        let r = window_to_desk(position, size, d.scale);
        // "Inside" said in the module's own vocabulary: a rectangle that needs no
        // fitting is a rectangle already within the work area. Spelling the four
        // comparisons out again would be a second definition of containment to keep in
        // step with `fit` by hand.
        if fit(r, d.work) != r {
            continue;
        }
        match found {
            // Two displays at the SAME scale accepting is not an ambiguity: the
            // question is the scale, not which display.
            Some(s) if s != d.scale => return None,
            _ => found = Some(d.scale),
        }
    }
    found
}

/// `recover_scale` against the displays actually attached.
pub fn saved_rect_scale<R: Runtime>(
    win: &Window<R>,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
) -> Option<f64> {
    recover_scale(position, size, &displays(win).ok()?)
}

/// Correct where a window already is. Only safe once the window's own reported
/// position is the truth, which at startup it is NOT — see `restore_window` in
/// lib.rs. Every window built while the event loop runs qualifies.
///
/// `min_inner` is the same logical minimum the window was built with. It is not
/// redundant with the builder's `min_inner_size`: what this corrects is a size
/// the window ALREADY has, and it can already be under its minimum — a restore
/// that sets a remembered physical size turns into a smaller logical one on a
/// display at a different scale.
pub fn fit_window<R: Runtime>(win: &Window<R>, min_inner: (f64, f64)) -> tauri::Result<()> {
    // The window is where it is, so its own scale factor is the right one to read
    // its rectangle with — this is the one caller for which no scale has to be
    // remembered anywhere.
    let scale = win.scale_factor()?;
    let outer = win.outer_size()?;
    let frame = frame_delta(outer, win.inner_size()?, scale);
    let want = window_to_desk(win.outer_position()?, outer, scale);
    place_window(win, want, min_inner, frame)
}

#[cfg(test)]
mod tests {
    use super::{
        at_least, desk_per_logical, desk_position, desk_size, fit, host_display, physical_per_desk,
        recover_scale, window_to_desk, work_to_desk, Display, Rect,
    };
    use tauri::{PhysicalPosition, PhysicalSize};

    // A 1920x1080 display with a 40px taskbar along the bottom, and a second one
    // of the same size to its right. Both at the same scale, so these rectangles
    // read the same in either desk unit.
    const LEFT: Rect = Rect {
        x: 0,
        y: 0,
        width: 1920,
        height: 1040,
    };
    const RIGHT: Rect = Rect {
        x: 1920,
        y: 0,
        width: 1920,
        height: 1040,
    };

    fn win(x: i32, y: i32, width: u32, height: u32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn disp(work: Rect, scale: f64) -> Display {
        Display { work, scale }
    }

    #[test]
    fn a_window_already_inside_is_untouched() {
        let w = win(100, 100, 1280, 800);
        assert_eq!(fit(w, LEFT), w);
    }

    #[test]
    fn a_window_flush_with_the_far_corner_is_untouched() {
        let w = win(640, 240, 1280, 800);
        assert_eq!(fit(w, LEFT), w);
    }

    #[test]
    fn an_overhanging_window_is_moved_back_and_keeps_its_size() {
        // Dragged off the right edge and under the taskbar.
        assert_eq!(
            fit(win(1800, 1000, 1280, 800), LEFT),
            win(640, 240, 1280, 800)
        );
    }

    #[test]
    fn a_window_off_the_top_left_is_moved_back() {
        assert_eq!(fit(win(-500, -300, 1280, 800), LEFT), win(0, 0, 1280, 800));
    }

    #[test]
    fn a_window_larger_than_the_work_area_is_shrunk_to_it() {
        let small = win(0, 0, 1366, 728);
        assert_eq!(fit(win(0, 0, 1280, 800), small), win(0, 0, 1280, 728));
        assert_eq!(fit(win(400, 50, 1920, 1080), small), win(0, 0, 1366, 728));
    }

    #[test]
    fn the_work_areas_offset_is_respected() {
        // macOS: the menu bar takes the top of the display rather than the bottom.
        let mac = win(0, 38, 1920, 1042);
        assert_eq!(fit(win(0, 0, 1280, 800), mac), win(0, 38, 1280, 800));
    }

    #[test]
    fn the_host_is_the_display_the_window_mostly_sits_on() {
        let areas = [disp(LEFT, 1.0), disp(RIGHT, 1.0)];
        // Straddling the seam: 960 of 1280 columns past it, then 920 short of it.
        assert_eq!(
            host_display(win(1600, 100, 1280, 800), &areas),
            Some(disp(RIGHT, 1.0))
        );
        assert_eq!(
            host_display(win(1000, 100, 1280, 800), &areas),
            Some(disp(LEFT, 1.0))
        );
    }

    #[test]
    fn a_window_on_a_display_that_is_gone_lands_on_the_nearest_one() {
        // Saved below both displays, so neither overlaps it and only the distance
        // between centers decides. Two candidates on purpose: with one, max_by_key
        // returns it whatever the key is, and the rule would go untested.
        let areas = [disp(LEFT, 1.0), disp(RIGHT, 1.0)];
        assert_eq!(
            host_display(win(100, 2000, 1280, 800), &areas),
            Some(disp(LEFT, 1.0))
        );
        assert_eq!(
            host_display(win(3000, 2000, 1280, 800), &areas),
            Some(disp(RIGHT, 1.0))
        );
        // And the window it brings back is inside that one.
        assert_eq!(
            fit(win(3000, 2000, 1280, 800), RIGHT),
            win(2560, 240, 1280, 800)
        );
    }

    #[test]
    fn nothing_to_fit_to_is_not_an_answer() {
        assert_eq!(host_display(win(0, 0, 1280, 800), &[]), None);
    }

    // The minimum is logical and the rectangle is in desk units, so the two only
    // agree where one logical pixel is one desk unit.
    const MIN: (f64, f64) = (960.0, 640.0);

    #[test]
    fn a_size_already_over_the_minimum_is_untouched() {
        let w = win(208, 208, 1296, 839);
        assert_eq!(at_least(w, MIN, 1.0, (16, 39)), w);
    }

    #[test]
    fn a_rectangle_under_the_minimum_is_raised_at_the_hosts_scale() {
        // The Windows case: the desk is in physical pixels, so one logical pixel is
        // 1.5 of them on a 150% display and the minimum is 1440x960 there.
        let saved = win(208, 208, 1280 + 22, 800 + 56);
        assert_eq!(
            at_least(saved, MIN, 1.5, (22, 56)),
            win(208, 208, 1440 + 22, 960 + 56)
        );
    }

    #[test]
    fn a_window_already_over_the_minimum_keeps_its_size() {
        let big = win(0, 0, 2560, 1392);
        assert_eq!(at_least(big, MIN, 1.5, (22, 56)), big);
        // And the position is never touched, at either scale.
        assert_eq!(at_least(big, MIN, 1.0, (16, 39)).x, 0);
    }

    #[test]
    fn no_configured_minimum_raises_nothing() {
        let w = win(10, 10, 400, 300);
        assert_eq!(at_least(w, (0.0, 0.0), 2.0, (26, 71)), w);
        // A nonsense factor must not produce a nonsense minimum.
        assert_eq!(at_least(w, MIN, f64::NAN, (0, 0)), w);
        assert_eq!(at_least(w, MIN, -1.0, (0, 0)), w);
    }

    #[test]
    fn logical_to_physical_is_the_scale_factor_whichever_unit_the_desk_is_in() {
        // The identity the two conversions are split along: whatever a desk unit is,
        // a logical pixel is still `scale` physical ones. This is what makes
        // `desk_per_logical` derived rather than a second platform fact to keep in
        // step by hand.
        for scale in [1.0, 1.25, 1.5, 2.0, 3.0] {
            assert!((desk_per_logical(scale) * physical_per_desk(scale) - scale).abs() < 1e-9);
        }
        // And a nonsense scale factor is absorbed rather than propagated.
        for bad in [f64::NAN, 0.0, -2.0, f64::INFINITY] {
            assert_eq!(desk_per_logical(bad), 1.0);
        }
    }

    // ---------------------------------------------------------------------------
    // Mixed DPI. Measured on the machine this fix was written on (2026-08-08,
    // Quartz + NSScreen): a built-in 1512x982 panel at 2.0 with a 33pt menu bar,
    // and a 2560x1440 external at 1.0 placed to its right and 458pt higher, with
    // the Dock along its bottom.
    //
    // In DESK units — points, on macOS — the two work areas are disjoint, which is
    // the whole point of the rewrite. In the physical numbers tao reports they
    // overlap by 1,294,272, and every case below used to come out wrong.
    // ---------------------------------------------------------------------------
    const MAC_BUILTIN: Rect = Rect {
        x: 0,
        y: 33,
        width: 1512,
        height: 949,
    };
    const MAC_EXTERNAL: Rect = Rect {
        x: 1512,
        y: -458,
        width: 2560,
        height: 1380,
    };

    fn mac_desk() -> [Display; 2] {
        [disp(MAC_BUILTIN, 2.0), disp(MAC_EXTERNAL, 1.0)]
    }

    #[test]
    fn mixed_dpi_work_areas_do_not_overlap_in_desk_units() {
        assert_eq!(MAC_BUILTIN.overlap(&MAC_EXTERNAL), 0);
    }

    #[test]
    fn a_window_on_the_low_dpi_display_stays_there_and_keeps_its_size() {
        // The operator's own saved rectangle, read out of .window-state.json:
        // x=2405 y=-29 1234x813, saved at scale 1.0. It is inside the external
        // display's work area, so nothing about it should change.
        let want = win(2405, -29, 1234, 813);
        let host = host_display(want, &mac_desk()).expect("a host");
        assert_eq!(host.work, MAC_EXTERNAL);
        let raised = at_least(want, MIN, desk_per_logical(host.scale), (0, 0));
        assert_eq!(
            raised, want,
            "1234x813 pt is already over a 960x640 minimum"
        );
        assert_eq!(fit(raised, host.work), want);
    }

    #[test]
    fn the_minimum_is_measured_on_the_display_the_window_is_on() {
        // 1000x700 on the 1.0 external is over the 960x640 minimum.
        let want = win(2000, 0, 1000, 700);
        let host = host_display(want, &mac_desk()).expect("a host");
        assert_eq!(host.scale, 1.0);
        // The factors are asserted directly rather than through
        // `desk_per_logical(host.scale)`, which is identically 1.0 wherever the desk is
        // logical — so on macOS that call cannot tell a right host from a wrong one, and
        // the assertion would hold whichever display had been picked.
        assert_eq!(at_least(want, MIN, 1.0, (0, 0)), want);
        // What the old code did: measured against the display the window was BORN on,
        // where one logical pixel is two desk units, the same rectangle reads as under
        // the minimum and is inflated past the size the operator left it at.
        assert_eq!(at_least(want, MIN, 2.0, (0, 0)), win(2000, 0, 1920, 1280));
    }

    // The desk is defined in three places — the divisor, the position flavour and the
    // size flavour — and only the first is otherwise reachable from a test. This binds
    // all three so they cannot be changed apart, which is the class of failure the
    // whole module exists to fix.
    #[test]
    fn the_setters_take_the_flavour_the_desk_is_measured_in() {
        let logical_desk = physical_per_desk(2.0) != 1.0;
        assert_eq!(
            matches!(desk_position(1, 2), tauri::Position::Logical(_)),
            logical_desk
        );
        assert_eq!(
            matches!(desk_size(3, 4), tauri::Size::Logical(_)),
            logical_desk
        );
    }

    #[test]
    fn a_window_on_the_high_dpi_display_is_not_pulled_onto_the_other_one() {
        // Bottom-right of the built-in panel. Its physical rectangle (x2) reached
        // deep into the external display's physical rectangle, which is how a
        // window on one display came to be fitted into another.
        let want = win(1000, 600, 440, 320);
        let host = host_display(want, &mac_desk()).expect("a host");
        assert_eq!(host.work, MAC_BUILTIN);
        assert_eq!(fit(want, host.work), want);
    }

    #[test]
    fn a_window_left_off_screen_comes_back_onto_the_display_it_was_on() {
        // A rectangle saved past the external display's right edge — the case the
        // module exists for. It belongs to the external display and is brought
        // inside it, not onto the built-in panel.
        let want = win(4032, 892, 1280, 800);
        let host = host_display(want, &mac_desk()).expect("a host");
        assert_eq!(host.work, MAC_EXTERNAL);
        let fitted = fit(want, host.work);
        assert_eq!(fitted, win(2792, 122, 1280, 800));
        assert!(fitted.x >= MAC_EXTERNAL.x && fitted.right() <= MAC_EXTERNAL.right());
        assert!(fitted.y >= MAC_EXTERNAL.y && fitted.bottom() <= MAC_EXTERNAL.bottom());
    }

    fn phys(x: i32, y: i32, width: u32, height: u32) -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
        (
            PhysicalPosition::new(x, y),
            PhysicalSize::new(width, height),
        )
    }

    // A physical rectangle only becomes a desk rectangle through a scale factor, and
    // on the platform where the desk is in physical pixels that step is the identity.
    // Both halves are asserted so that neither can be changed without the other being
    // read.
    #[test]
    #[cfg(target_os = "macos")]
    fn a_physical_rectangle_converts_to_points() {
        // The built-in panel's work area as tao reports it, and as it really is.
        let (p, s) = phys(0, 66, 3024, 1898);
        assert_eq!(work_to_desk(p, s, 2.0), MAC_BUILTIN);
        // The external one is at 1.0, where the numbers already are points.
        let (p, s) = phys(1512, -458, 2560, 1380);
        assert_eq!(work_to_desk(p, s, 1.0), MAC_EXTERNAL);
        // A work area rounds INWARD and a window OUTWARD, so an odd physical extent
        // can never make the fit laxer than the display really is.
        let (p, s) = phys(1, 1, 101, 101);
        assert_eq!(work_to_desk(p, s, 2.0), win(1, 1, 50, 50));
        assert_eq!(window_to_desk(p, s, 2.0), win(0, 0, 51, 51));
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn a_physical_rectangle_is_already_in_desk_units() {
        let (p, s) = phys(0, 66, 3024, 1898);
        assert_eq!(work_to_desk(p, s, 2.0), win(0, 66, 3024, 1898));
        let (p, s) = phys(1, 1, 101, 101);
        assert_eq!(window_to_desk(p, s, 2.0), win(1, 1, 101, 101));
    }

    // The fallback for a state file written before the scale was recorded beside the
    // rectangle. macOS only: where a desk unit is a physical pixel every hypothesis
    // produces the same rectangle, so there is nothing to tell apart.
    #[test]
    #[cfg(target_os = "macos")]
    fn the_scale_a_rectangle_was_saved_at_can_often_be_recovered() {
        let desk = mac_desk();
        // The operator's own saved main window. Read as points it sits inside the
        // external display; halved it would start above the built-in panel's menu bar.
        let (p, s) = phys(2405, -29, 1234, 813);
        assert_eq!(recover_scale(p, s, &desk), Some(1.0));
        // A window on the built-in panel: as points it is off the left of the external
        // display, and halved it is inside the panel.
        let (p, s) = phys(400, 200, 1200, 800);
        assert_eq!(recover_scale(p, s, &desk), Some(2.0));
        // Inside the region both displays' desk rectangles cover: consistent either
        // way, so the answer is "unknown" rather than a guess.
        let (p, s) = phys(1600, 100, 400, 300);
        assert_eq!(recover_scale(p, s, &desk), None);
        // The case this module exists for — a rectangle that is on no display any
        // more — matches nothing, which is the other way this returns None.
        let (p, s) = phys(4032, 892, 1280, 800);
        assert_eq!(recover_scale(p, s, &desk), None);
    }

    #[test]
    fn two_displays_at_one_scale_are_not_an_ambiguity() {
        // Mirrored displays: same work area, same scale. Two acceptances, but the
        // question is what scale the rectangle was measured at, and both agree.
        let mirrored = [disp(LEFT, 1.0), disp(LEFT, 1.0)];
        let (p, s) = phys(100, 100, 800, 600);
        assert_eq!(recover_scale(p, s, &mirrored), Some(1.0));
    }

    #[test]
    fn a_window_over_the_dock_is_lifted_off_it() {
        // The external display's work area stops 60pt above its bottom edge. A
        // window over the Dock used to be attributed to the built-in panel — whose
        // inflated rectangle contained it — and so was left where it was.
        let want = win(2000, 700, 800, 300);
        let host = host_display(want, &mac_desk()).expect("a host");
        assert_eq!(host.work, MAC_EXTERNAL);
        assert_eq!(fit(want, host.work), win(2000, 622, 800, 300));
    }
}
