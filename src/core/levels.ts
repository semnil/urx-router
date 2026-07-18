// The device's level_gain fader scale: the discrete dB values the URX hardware
// actually lets you set on a fader / send level (empirically confirmed on the
// device — coarser than the broker level_gain resolution, with index 0 = -∞ off
// represented separately by LEVEL_OFF_DB). The grid is non-uniform — wide steps
// in the tail, finer near 0 dB — so a uniform UI step would offer values the
// device cannot store (e.g. -15.0). Every level is snapped to this grid before it
// reaches the plan, and the faders space the detents evenly so adjustment near 0
// dB is not cramped.

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

/** Step a level by `delta` grid detents (negative past the floor lands on off). */
export function stepLevel(db: number, delta: number): number {
  return posToLevel(levelToPos(db) + delta);
}
