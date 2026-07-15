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
