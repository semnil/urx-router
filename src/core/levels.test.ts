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
});
