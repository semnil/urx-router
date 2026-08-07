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
// Everything is in physical pixels, which is what the monitor rectangles and the
// window's own position and size are already reported in. Converting to logical
// pixels would have to pick a scale factor, and the one case this exists for —
// a window coming back onto a different display — is exactly where the window's
// scale factor and the target monitor's disagree.

use tauri::{PhysicalPosition, PhysicalSize, Runtime, Window};

/// A rectangle in physical pixels. A window's outer bounds and a monitor's work
/// area are both one of these, which is what lets the arithmetic below be a pure
/// function with tests of its own — no window and no display needed.
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

    /// Area the two rectangles share, in pixels. Zero when they only touch.
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

/// The work area a window belongs to: the one it overlaps most, or — when it
/// overlaps none, which is what a display being unplugged looks like — the one
/// whose center is nearest.
///
/// Nearest rather than primary: with a laptop panel to the left of an external
/// display, nearest brings a window back to the side of the desk it was on, and
/// on a single display the two answers are the same anyway.
fn host_area(win: Rect, areas: &[Rect]) -> Option<Rect> {
    areas
        .iter()
        .copied()
        .max_by_key(|a| (win.overlap(a), std::cmp::Reverse(win.center_distance2(a))))
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

/// The work areas of every attached display, in the order the platform lists them.
fn work_areas<R: Runtime>(win: &Window<R>) -> tauri::Result<Vec<Rect>> {
    Ok(win
        .available_monitors()?
        .iter()
        .map(|m| {
            let a = m.work_area();
            Rect {
                x: a.position.x,
                y: a.position.y,
                width: a.size.width,
                height: a.size.height,
            }
        })
        .collect())
}

/// What the window frame adds around the content: outer size minus inner size.
/// Zero on macOS, where tao reports the content size for both. It is a pure
/// function of the two sizes so that a caller which already holds them — every
/// caller does — pays no second read, and so that the direction it is applied in
/// is decided in one place rather than added here and subtracted there.
pub fn frame_delta(outer: PhysicalSize<u32>, inner: PhysicalSize<u32>) -> (u32, u32) {
    (
        outer.width.saturating_sub(inner.width),
        outer.height.saturating_sub(inner.height),
    )
}

/// Put a window at `want` — its OUTER rectangle — corrected so that it lies
/// entirely inside a display's work area.
///
/// `want` is a rectangle about to be applied, not necessarily one the window is
/// at: at startup the window cannot be read back (see `restore_main_window` in
/// lib.rs), so the caller passes the numbers it is about to place.
///
/// A maximized, fullscreen or minimized window is left alone: its rectangle
/// belongs to the window manager, and setting a position on a maximized window is
/// how it silently stops being maximized.
pub fn place_window<R: Runtime>(win: &Window<R>, want: Rect) -> tauri::Result<()> {
    if win.is_maximized()? || win.is_minimized()? || win.is_fullscreen()? {
        return Ok(());
    }
    let areas = work_areas(win)?;
    let Some(work) = host_area(want, &areas) else {
        return Ok(());
    };
    let fitted = fit(want, work);
    // The size setter takes the INNER size, so the frame has to come off the
    // fitted outer rectangle first — handing the outer size back would grow the
    // window by the height of its own title bar at every launch. The two are the
    // same number on macOS, where tao reports the content size for both.
    //
    // A window whose minimum size is larger than the work area stays larger than
    // it: the platform clamps the shrink, and there is nothing better to do than
    // pin its top-left corner, which the move below does.
    let outer = win.outer_size()?;
    let (frame_w, frame_h) = frame_delta(outer, win.inner_size()?);
    if fitted.width != outer.width || fitted.height != outer.height {
        win.set_size(PhysicalSize {
            width: fitted.width.saturating_sub(frame_w),
            height: fitted.height.saturating_sub(frame_h),
        })?;
    }
    win.set_position(PhysicalPosition {
        x: fitted.x,
        y: fitted.y,
    })?;
    Ok(())
}

/// Correct where a window already is. Only safe once the window's own reported
/// position is the truth, which at startup it is NOT — see `restore_main_window`
/// in lib.rs. Every window built while the event loop runs qualifies, which is
/// what the `window_fit_plugin` hook relies on.
pub fn fit_window<R: Runtime>(win: &Window<R>) -> tauri::Result<()> {
    let pos = win.outer_position()?;
    let size = win.outer_size()?;
    place_window(
        win,
        Rect {
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::{fit, host_area, Rect};

    // A 1920x1080 display with a 40px taskbar along the bottom, and a second one
    // of the same size to its right.
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
        let areas = [LEFT, RIGHT];
        // Straddling the seam: 960 of 1280 columns past it, then 920 short of it.
        assert_eq!(host_area(win(1600, 100, 1280, 800), &areas), Some(RIGHT));
        assert_eq!(host_area(win(1000, 100, 1280, 800), &areas), Some(LEFT));
    }

    #[test]
    fn a_window_on_a_display_that_is_gone_lands_on_the_nearest_one() {
        // Saved below both displays, so neither overlaps it and only the distance
        // between centers decides. Two candidates on purpose: with one, max_by_key
        // returns it whatever the key is, and the rule would go untested.
        let areas = [LEFT, RIGHT];
        assert_eq!(host_area(win(100, 2000, 1280, 800), &areas), Some(LEFT));
        assert_eq!(host_area(win(3000, 2000, 1280, 800), &areas), Some(RIGHT));
        // And the window it brings back is inside that one.
        assert_eq!(
            fit(win(3000, 2000, 1280, 800), RIGHT),
            win(2560, 240, 1280, 800)
        );
    }

    #[test]
    fn nothing_to_fit_to_is_not_an_answer() {
        assert_eq!(host_area(win(0, 0, 1280, 800), &[]), None);
    }
}
