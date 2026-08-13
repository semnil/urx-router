// The device's level_gain fader scale: the discrete dB values the URX hardware
// actually lets you set on a fader / send level (empirically confirmed on the
// device — coarser than the broker level_gain resolution, with index 0 = -∞ off
// represented separately by LEVEL_OFF_DB). The grid is non-uniform — wide steps
// in the tail, finer near 0 dB — so a uniform UI step would offer values the
// device cannot store (e.g. -15.0). The faders space the detents evenly so
// adjustment near 0 dB is not cramped.
//
// EVERY LEVEL THE APP AUTHORS is snapped to this grid — the inspector through
// `snappedSlider`, the CONSOLE through `posToLevel`/`stepLevel`, external MIDI
// through `posToLevel`; fine mode does not reach a fader at all, so nothing in the
// UI can produce an off-grid one. A level the app RECEIVES is not snapped, and
// deliberately so: `vdToLevel` divides the raw device value by 100 and clamps,
// and a JSON / `?plan=` / `.urxf` load checks only that the number is finite. The
// plan then says what the unit or the file actually holds rather than the nearest
// thing this grid can name — which is what a device readout has to say, and what
// the race harness reads back (`e2e/race/ui.ts` deviceLevelText).
//
// The unit RETAINS a non-detent level_gain rather than rounding it — measured
// 2026-08-11 on a URX44V, 6/6 across two level params (CH_FADER 139 and
// SEND_LEVEL 146), each written value read back unchanged and announced by its
// own notify. So the receiving half above is not a theoretical branch: an
// off-grid value really can be sitting on the hardware, and snapping it on the
// way in would replace the unit's actual state with the nearest name this grid
// has for it. Do not "tidy" vdToLevel into posToLevel(levelToPos(...)) — beyond
// losing that, follow.ts hands noteDirect the RAW value while the flush diffs
// against levelToVd(planLevel), so a snapped plan value makes the next unrelated
// edit emit an unrequested write back over what the unit holds.

import { LEVEL_MIN_DB, LEVEL_OFF_DB } from "./plan";

export const LEVEL_STEPS_DB: readonly number[] = [
  -96, -80, -72, -64, -56, -48, -40, -36, -32, -30, -28, -25.6, -24, -22.4, -20, -18, -16, -14, -12, -10, -8.8, -7.2,
  -6, -5, -4, -3.2, -2, -1.2, -0.4, 0, 0.4, 1.2, 2, 3.2, 4, 5, 6, 7.2, 8.8, 10,
];

// Slider positions: 0 = off (-∞), 1..LEVEL_STEPS_DB.length map to the grid. An
// index-based slider over [0, LEVEL_POS_MAX] only ever lands on real detents.
export const LEVEL_POS_MAX = LEVEL_STEPS_DB.length;

/** Slider position (0 = off, 1..N = grid index + 1) → plan dB. */
export function posToLevel(pos: number): number {
  // Round to a real detent (a fractional slider value would index the grid out of
  // band) and treat NaN as off, so the return is always a finite grid dB.
  const p = Number.isNaN(pos) ? 0 : Math.round(pos);
  if (p <= 0) return LEVEL_OFF_DB;
  return LEVEL_STEPS_DB[Math.min(p, LEVEL_POS_MAX) - 1];
}

/** Plan dB → nearest slider position. Below the lowest real value reads as off. */
export function levelToPos(db: number): number {
  // A non-finite level cannot enter the nearest-neighbor scan (every |step - db| is
  // NaN/Infinity): +Infinity snaps to the loudest detent, NaN / -Infinity to off.
  if (!Number.isFinite(db)) return db > 0 ? LEVEL_POS_MAX : 0;
  if (db < LEVEL_MIN_DB) return 0;
  let best = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < LEVEL_STEPS_DB.length; i++) {
    const delta = Math.abs(LEVEL_STEPS_DB[i] - db);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = i;
    }
  }
  return best + 1;
}

/**
 * Step a level by `delta` grid detents (negative past the floor lands on off).
 *
 * Snapped in the direction of travel, not to the nearest detent. Off-grid levels are
 * real here — the unit retains its own level_gain (measured 6/6) and a received level
 * is deliberately not snapped — and from one of them the nearest detent can lie on the
 * travel side, so `nearest + delta` overshoots the adjacent detent by one. From -14.5
 * one ArrowUp used to land on -12, skipping -14; from -15.5 one ArrowDown gave -18,
 * skipping -16. One keypress, two detents, silently.
 */
export function stepLevel(db: number, delta: number): number {
  const pos = levelToPos(db);
  const at = posToLevel(pos);
  // Already on the grid (or already off), or moving away from the value: the nearest
  // detent IS the one to step from. Only a snap that jumped PAST the level in the
  // direction of travel has to be walked back one.
  const overshot = delta > 0 ? at > db : at < db;
  return posToLevel(pos + (overshot ? Math.sign(delta) * -1 : 0) + delta);
}
