// QA audit (core/levels.ts): the level_gain grid maps arbitrary dB <-> slider
// positions. levels.test.ts covers the in-range / grid-value / sub-floor cases;
// these pin the behavior at the non-finite and non-integer edges the UI never hits
// with a well-formed slider, so the robustness the audit hardened is locked in and
// any future regression is caught. The gaps the audit flagged were fixed at the
// source (non-finite guard on levelToPos, round + NaN floor on posToLevel).

import { describe, it, expect } from "vitest";
import { posToLevel, levelToPos, stepLevel, LEVEL_POS_MAX, LEVEL_STEPS_DB } from "./levels";
import { LEVEL_OFF_DB, LEVEL_MIN_DB, LEVEL_MAX_DB } from "./plan";

describe("levelToPos non-finite inputs", () => {
  it("maps -Infinity to off (correct: it is below the floor)", () => {
    // The floor guard `db < LEVEL_MIN_DB` catches -Infinity, so an absurdly quiet
    // value reads as off — the intended direction.
    expect(levelToPos(-Infinity)).toBe(0);
    expect(posToLevel(levelToPos(-Infinity))).toBe(LEVEL_OFF_DB);
  });

  it("maps +Infinity to the ceiling (+10 dB), like a large finite level", () => {
    // A large FINITE level snaps to the loudest detent...
    expect(posToLevel(levelToPos(1e9))).toBe(LEVEL_MAX_DB);
    // ...and the non-finite guard now sends +Infinity to the same top detent, rather
    // than inverting to the quietest one (the old strict-`<` nearest-neighbor scan
    // never beat its Infinity seed for a non-finite db, leaving best at pos 1).
    expect(levelToPos(Infinity)).toBe(LEVEL_POS_MAX);
    expect(posToLevel(levelToPos(Infinity))).toBe(LEVEL_MAX_DB);
  });

  it("maps NaN to off rather than the floor detent or an error", () => {
    // The guard routes NaN (and -Infinity) to pos 0 = off, instead of the old scan
    // silently landing on the lowest real detent.
    expect(levelToPos(NaN)).toBe(0);
    expect(posToLevel(levelToPos(NaN))).toBe(LEVEL_OFF_DB);
  });
});

describe("posToLevel non-integer / non-finite positions", () => {
  it("rounds a fractional position to the nearest detent (always a real number)", () => {
    // posToLevel now rounds before indexing, so a fractional position lands on a
    // real grid dB instead of running off the array end into undefined.
    expect(posToLevel(1.5)).toBe(LEVEL_STEPS_DB[1]); // round(1.5) = 2 -> grid[1]
    expect(posToLevel(2.999)).toBe(LEVEL_STEPS_DB[2]); // round(2.999) = 3 -> grid[2]
  });

  it("maps a NaN position to off", () => {
    // NaN is coerced to pos 0, so it reads as off rather than yielding undefined.
    expect(posToLevel(NaN)).toBe(LEVEL_OFF_DB);
  });

  it("still clamps a large or negative integer position to the ends (unchanged)", () => {
    expect(posToLevel(0)).toBe(LEVEL_OFF_DB);
    expect(posToLevel(-5)).toBe(LEVEL_OFF_DB);
    expect(posToLevel(LEVEL_POS_MAX)).toBe(LEVEL_MAX_DB);
    expect(posToLevel(LEVEL_POS_MAX + 100)).toBe(LEVEL_MAX_DB);
  });
});

describe("stepLevel handles the non-finite edges", () => {
  it("a NaN delta resolves to off rather than undefined", () => {
    // levelToPos(10) = LEVEL_POS_MAX; + NaN = NaN; posToLevel(NaN) now returns off.
    expect(stepLevel(LEVEL_MAX_DB, NaN)).toBe(LEVEL_OFF_DB);
  });

  it("a NaN start steps up from off onto the floor detent", () => {
    // levelToPos(NaN) = 0 (off), so stepping up one detent lands on the first grid
    // value rather than the second.
    expect(stepLevel(NaN, 1)).toBe(LEVEL_STEPS_DB[0]);
  });

  it("bottoms out at off and tops out at the ceiling for finite steps (unchanged)", () => {
    expect(stepLevel(LEVEL_MIN_DB, -1)).toBe(LEVEL_OFF_DB);
    expect(stepLevel(LEVEL_MAX_DB, 1)).toBe(LEVEL_MAX_DB);
  });
});
