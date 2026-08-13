import { describe, it, expect } from "vitest";
import { LEVEL_OFF_DB } from "./plan";
import { LEVEL_POS_MAX, LEVEL_STEPS_DB, levelToPos, posToLevel, stepLevel } from "./levels";

// The slider path snaps an arbitrary dB to a settable detent by round-tripping
// through the position space; mirror it here.
const snap = (db: number): number => posToLevel(levelToPos(db));

describe("level_gain grid", () => {
  it("is strictly ascending up to +10 dB", () => {
    for (let i = 1; i < LEVEL_STEPS_DB.length; i++) {
      expect(LEVEL_STEPS_DB[i]).toBeGreaterThan(LEVEL_STEPS_DB[i - 1]);
    }
    expect(LEVEL_STEPS_DB[0]).toBe(-96);
    expect(LEVEL_STEPS_DB[LEVEL_STEPS_DB.length - 1]).toBe(10);
  });

  it("snaps values the device cannot store to the nearest detent", () => {
    // -15.0 dB does not exist on the device; the grid jumps -16 / -14.
    expect(LEVEL_STEPS_DB).not.toContain(-15);
    expect(snap(-15.4)).toBe(-16);
    expect(snap(-14.9)).toBe(-14);
    expect(snap(3.1)).toBe(3.2);
    expect(snap(0.1)).toBe(0);
  });

  it("maps every grid value to itself round-trip", () => {
    for (const db of LEVEL_STEPS_DB) {
      expect(posToLevel(levelToPos(db))).toBe(db);
    }
  });

  it("reads sub-floor levels as off and clamps positions", () => {
    expect(levelToPos(-200)).toBe(0);
    expect(posToLevel(0)).toBe(LEVEL_OFF_DB);
    expect(snap(-200)).toBe(LEVEL_OFF_DB);
    expect(posToLevel(LEVEL_POS_MAX + 5)).toBe(10);
  });

  it("steps one detent at a time and bottoms out at off", () => {
    expect(stepLevel(0, 1)).toBe(0.4);
    expect(stepLevel(0, -1)).toBe(-0.4);
    expect(stepLevel(-96, -1)).toBe(LEVEL_OFF_DB);
    expect(stepLevel(10, 1)).toBe(10);
  });

  // Off-grid levels are real: the unit retains its own level_gain (measured 6/6) and a
  // received level is deliberately not snapped, so a fader focused on a device-held
  // value steps from between two detents. Snapping to the NEAREST first put the start
  // point on the travel side half the time, and the step then jumped the adjacent
  // detent — one keypress moving two detents' distance, with nothing to show it.
  it("steps to the adjacent detent from a value between two of them", () => {
    // -14.5 sits between -16 and -14, nearest -14: up must give -14, not -12.
    expect(stepLevel(-14.5, 1)).toBe(-14);
    expect(stepLevel(-14.5, -1)).toBe(-16);
    // …and the mirror, where the nearest detent lies below.
    expect(stepLevel(-15.5, -1)).toBe(-16);
    expect(stepLevel(-15.5, 1)).toBe(-14);
    // A value already on the grid is unaffected — the correction is for the snap
    // having moved past the value, and there it has not moved at all.
    expect(stepLevel(-16, 1)).toBe(-14);
    expect(stepLevel(-14, -1)).toBe(-16);
    // Multi-detent steps keep counting from the same neighbour.
    expect(stepLevel(-14.5, 2)).toBe(-12);
    expect(stepLevel(-14.5, -2)).toBe(-18);
  });

  it("steps back up from off onto the floor detent (off is one notch below -96)", () => {
    // levelToPos(LEVEL_OFF_DB) is 0 (off), so a single step up lands on the lowest
    // real value, mirroring stepLevel(-96, -1) === off in the other direction.
    expect(stepLevel(LEVEL_OFF_DB, 1)).toBe(-96);
  });

  it("resolves an exact midpoint deterministically to the lower (quieter) detent", () => {
    // -15 sits exactly between the -16 and -14 detents; the nearest-neighbor scan
    // uses strict < over an ascending grid, so the first (lower-index = quieter)
    // detent wins the tie. Pin the direction so a rounding change is caught.
    expect(snap(-15)).toBe(-16); // midpoint of -16 / -14
    expect(snap(-0.2)).toBe(-0.4); // midpoint of -0.4 / 0
    expect(snap(0.2)).toBe(0); // midpoint of 0 / 0.4
    expect(snap(-60)).toBe(-64); // midpoint of -64 / -56 in the coarse tail
  });
});
