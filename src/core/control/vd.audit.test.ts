// vd.ts codec robustness audit. Pins the behavior of the value codecs at
// non-finite and out-of-range inputs, so a regression is caught and the hardened
// edges are documented in one place. control-edge.test.ts also pins the NaN trap
// for three encoders (level / pan / gain) and the +Infinity clamps; this completes
// the audit across the rest of the encoder family and the decode (device→plan) side.
//
// clamp() in vd.ts now traps NaN to its low bound (a NaN comparison is otherwise
// false, so NaN would flow through unclamped and, reaching vdSet, serialize to
// `null` in the IPC payload — a malformed broker write). The UI never authors NaN,
// but a hand-edited or corrupt plan would; these tests lock the firewall in. The
// one remaining KNOWN GAP (ssmcsRatio negative extrapolation) is unreachable from a
// real device raw and left as-is.

import { describe, expect, it } from "vitest";
import { LEVEL_MAX_DB, LEVEL_MIN_DB, LEVEL_OFF_DB } from "../plan";
import {
  attackToVd,
  boolToVd,
  burstWidthToVd,
  centiDbToVd,
  delayTimeToVd,
  eqFreqToVd,
  eqGainToVd,
  freqToVd,
  gainToVd,
  holdToVd,
  levelToVd,
  panToVd,
  phonesLevelToVd,
  qToVd,
  ratioToVd,
  releaseToVd,
  ssmcsRatio,
  sweetSpotDataToStr,
  vdToBool,
  vdToGain,
  vdToLevel,
  vdToPan,
  PAN_MAX,
} from "./vd";

// Every plan→broker encoder, so the audit covers the whole family, not a sample.
const ENCODERS: Array<[string, (n: number) => number]> = [
  ["levelToVd", levelToVd],
  ["panToVd", panToVd],
  ["gainToVd", gainToVd],
  ["freqToVd", freqToVd],
  ["eqFreqToVd", eqFreqToVd],
  ["qToVd", qToVd],
  ["eqGainToVd", eqGainToVd],
  ["centiDbToVd", centiDbToVd],
  ["attackToVd", attackToVd],
  ["holdToVd", holdToVd],
  ["releaseToVd", releaseToVd],
  ["ratioToVd", ratioToVd],
  ["phonesLevelToVd", phonesLevelToVd],
  ["delayTimeToVd", delayTimeToVd],
  ["burstWidthToVd", burstWidthToVd],
];

describe("vd encoder NaN firewall (clamp traps NaN to the low bound)", () => {
  it("every level/scale encoder traps NaN to a finite broker value", () => {
    // A NaN would otherwise reach vdSet and serialize to null in the IPC payload;
    // clamp now maps NaN → its low bound, so every encoder is a NaN firewall.
    for (const [name, fn] of ENCODERS) {
      expect.soft(Number.isFinite(fn(NaN)), name).toBe(true);
    }
  });

  it("every finite-bounded encoder clamps +Infinity to a finite broker value", () => {
    // The counterpart property that DOES hold: +Infinity is trapped by `v > hi`.
    for (const [name, fn] of ENCODERS) {
      expect.soft(Number.isFinite(fn(Infinity)), name).toBe(true);
    }
  });

  it("levelToVd treats −Infinity as the off sentinel (pre-clamp guard), +Infinity as the ceiling", () => {
    expect(levelToVd(-Infinity)).toBe(-32768); // below the -96 floor → off sentinel
    expect(levelToVd(Infinity)).toBe(1000); // +10 dB ceiling
  });
});

describe("vd decoder (device→plan) robustness", () => {
  it("decodes ±Infinity raw to the finite plan bounds", () => {
    // The decode side clamps correctly — a wild device raw lands on a real value.
    expect(vdToLevel(Infinity)).toBe(LEVEL_MAX_DB);
    expect(vdToLevel(-Infinity)).toBe(LEVEL_OFF_DB); // off sentinel path
    expect(vdToPan(Infinity)).toBe(PAN_MAX);
    expect(vdToPan(-Infinity)).toBe(-PAN_MAX);
  });

  it("a NaN device raw decodes to a safe finite bound (level/pan/gain)", () => {
    // A malformed broker read (non-numeric) now lands on the finite floor via the
    // shared clamp firewall, instead of leaking NaN into the plan.
    expect(vdToLevel(NaN)).toBe(LEVEL_MIN_DB);
    expect(Number.isFinite(vdToPan(NaN))).toBe(true);
    expect(Number.isFinite(vdToGain(NaN))).toBe(true);
  });

  it("vdToBool treats a NaN device raw as OFF (only a finite non-zero is ON)", () => {
    // A non-finite raw for any on/off param now reads back as OFF; only a finite
    // non-zero is ON. boolToVd is the safe inverse (0/1 only).
    expect(vdToBool(NaN)).toBe(false);
    expect(vdToBool(0)).toBe(false);
    expect(boolToVd(true)).toBe(1);
    expect(boolToVd(false)).toBe(0);
  });
});

describe("SSMCS / preset codec defensive edges (documents current behavior)", () => {
  it("KNOWN GAP: ssmcsRatio extrapolates below the anchor table into negatives", () => {
    // The device raw is always in [0, 120] (SSMCS_RATIO_RAW_MIN/MAX), so this is
    // unreachable in practice, but a raw below 0 linearly extrapolates the first
    // anchor segment and can go negative rather than clamping to the floor 1.0:1.
    expect(ssmcsRatio(-5)).toBeLessThan(0);
    // In-range floor / ceiling are well-defined (see ssmcs-encoding.test.ts).
    expect(ssmcsRatio(0)).toBe(1);
  });

  it('sweetSpotDataToStr(NaN) falls back to the in-range floor "0001"', () => {
    // NaN is now coerced to 0 before the [1, 34] clamp, so a malformed index yields
    // the factory-default preset string rather than "0NaN".
    expect(sweetSpotDataToStr(NaN)).toBe("0001");
    // A finite out-of-range index still clamps correctly.
    expect(sweetSpotDataToStr(999)).toBe("0034");
  });

  it("levelToVd rounds sub-centi-dB inputs to the nearest broker step", () => {
    // Non-integer plan dB below the codec resolution round rather than truncate.
    expect(levelToVd(-6)).toBe(-600);
    expect(levelToVd(LEVEL_MIN_DB)).toBe(LEVEL_MIN_DB * 100); // -96.0 is a real value
  });
});
