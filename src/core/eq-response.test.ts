import { describe, expect, it } from "vitest";
import { bandResponse, eqResponse, shelfDesignFreq } from "./eq-response";
import type { EqBandState } from "./eq-response";
import { EQ_TYPE_PASS, EQ_TYPE_PEAKING, EQ_TYPE_SHELVING } from "./control/params";

// The model is pinned against the device itself: every table below is a sweep measured
// on a URX44V by driving the oscillator (or, for the channel blocks, the host's USB
// output) through the EQ and taking the difference between the two meters that bracket
// it. Both meters are 1 dB-quantized peak detectors, so a difference carries about
// ±1 dB of its own; 2.0 dB is the tolerance that leaves the measurement its resolution
// while still failing every wrong model this went through — the three corrections
// checked separately below are each worth 4 dB or more where they bite.
const TOL = 2.0;

const band = (o: Partial<EqBandState> & { index: number }): EqBandState => ({
  on: true,
  type: EQ_TYPE_PEAKING,
  freq: 1000,
  q: 1,
  gain: 0,
  ...o,
});

/** Worst absolute deviation between the model and a measured sweep. */
function worst(
  b: EqBandState,
  measured: Record<number, number>,
): { hz: number; want: number; got: number; err: number } {
  const f = bandResponse(b);
  let out = { hz: 0, want: 0, got: 0, err: -1 };
  for (const [hzText, want] of Object.entries(measured)) {
    const hz = Number(hzText);
    const got = f(hz);
    const err = Math.abs(got - want);
    if (err > out.err) out = { hz, want, got, err };
  }
  return out;
}

describe("EQ response against the device", () => {
  // A boost bell, and the dataset that proved the unit's Q is twice the biquad Q: at
  // 700 Hz a +12 dB "Q 1.00" bell is still +10 dB, which a biquad Q of 1.0 draws at
  // about +6 dB.
  it("draws a peaking boost the width the device measured", () => {
    const w = worst(band({ index: 1, gain: 12 }), { 200: 2, 400: 5, 700: 10, 1000: 12, 1400: 10, 2800: 4, 5600: 1 });
    expect(w.err, `${w.hz} Hz: measured ${w.want}, model ${w.got.toFixed(1)}`).toBeLessThanOrEqual(TOL);
  });

  it("draws a peaking cut the same way", () => {
    const w = worst(band({ index: 1, gain: -12 }), {
      200: -3,
      400: -6,
      500: -8,
      700: -11,
      1000: -12,
      1400: -11,
      2000: -8,
      2800: -5,
      5600: -2,
    });
    expect(w.err, `${w.hz} Hz: measured ${w.want}, model ${w.got.toFixed(1)}`).toBeLessThanOrEqual(TOL);
  });

  it("holds at both ends of the Q range", () => {
    const wide = worst(band({ index: 1, gain: 12, q: 0.5 }), {
      200: 5,
      400: 9,
      700: 11,
      900: 11,
      1000: 12,
      1100: 11,
      1400: 11,
      2800: 8,
      5600: 4,
    });
    expect(
      wide.err,
      `Q 0.50 at ${wide.hz} Hz: measured ${wide.want}, model ${wide.got.toFixed(1)}`,
    ).toBeLessThanOrEqual(TOL);
    // Q 16 is ±10% wide: +3 dB at 900/1100 Hz and nothing an octave out.
    const sharp = worst(band({ index: 1, gain: 12, q: 16 }), {
      200: 0,
      400: 0,
      700: 0,
      900: 3,
      1000: 12,
      1100: 3,
      1400: 0,
      2800: 0,
      5600: 0,
    });
    expect(
      sharp.err,
      `Q 16.00 at ${sharp.hz} Hz: measured ${sharp.want}, model ${sharp.got.toFixed(1)}`,
    ).toBeLessThanOrEqual(TOL);
  });

  // The shelf datasets are what the "nominal frequency is the -3 dB-from-plateau point"
  // correction came from: a +18 dB shelf reads +15 dB at its own frequency.
  it("puts a shelf's nominal frequency 3 dB below its plateau", () => {
    const w = worst(band({ index: 3, type: EQ_TYPE_SHELVING, gain: 18, q: 0.71 }), {
      250: 0,
      500: 6,
      1000: 15,
      2000: 17,
      4000: 18,
    });
    expect(w.err, `${w.hz} Hz: measured ${w.want}, model ${w.got.toFixed(1)}`).toBeLessThanOrEqual(TOL);
  });

  it("solves a cut shelf in the other direction", () => {
    const high = worst(band({ index: 3, type: EQ_TYPE_SHELVING, gain: -12, q: 0.71 }), {
      250: -1,
      500: -3,
      700: -6,
      1000: -10,
      1400: -12,
      2000: -12,
      4000: -13,
    });
    expect(high.err, `HIGH at ${high.hz} Hz: measured ${high.want}, model ${high.got.toFixed(1)}`).toBeLessThanOrEqual(
      TOL,
    );
    const low = worst(band({ index: 0, type: EQ_TYPE_SHELVING, gain: -12, q: 0.71 }), {
      250: -12,
      500: -12,
      700: -12,
      1000: -9,
      1400: -7,
      2000: -3,
      4000: 0,
    });
    expect(low.err, `LOW at ${low.hz} Hz: measured ${low.want}, model ${low.got.toFixed(1)}`).toBeLessThanOrEqual(TOL);
  });

  it("draws a pass filter as a fixed Butterworth, whatever the Q slot says", () => {
    const w = worst(band({ index: 0, type: EQ_TYPE_PASS, q: 0.71 }), { 100: -40, 250: -25, 500: -13, 1000: -3 });
    expect(w.err, `${w.hz} Hz: measured ${w.want}, model ${w.got.toFixed(1)}`).toBeLessThanOrEqual(TOL);
    // Q 0.71 and Q 4.00 measured identical, with no resonant peak at the corner.
    const loose = bandResponse(band({ index: 0, type: EQ_TYPE_PASS, q: 0.71 }));
    const tight = bandResponse(band({ index: 0, type: EQ_TYPE_PASS, q: 4 }));
    for (const hz of [100, 500, 900, 1000, 1100, 2000]) expect(tight(hz)).toBeCloseTo(loose(hz), 6);
  });

  it("puts the HIGH band's pass filter at the other end", () => {
    const lpf = bandResponse(band({ index: 3, type: EQ_TYPE_PASS, freq: 1000 }));
    expect(lpf(1000)).toBeCloseTo(-3, 0);
    expect(lpf(250)).toBeGreaterThan(-1);
    expect(lpf(4000)).toBeLessThan(-20);
  });

  it("sums the bands in dB, as the device measured", () => {
    // A LOW shelf +12 at 300 Hz and a HIGH-MID peaking -9 at 3 kHz, measured alone and
    // together: the pair matched the sum of the two to within the meters' resolution.
    const low = band({ index: 0, type: EQ_TYPE_SHELVING, freq: 300, gain: 12, q: 0.71 });
    const hm = band({ index: 2, freq: 3000, gain: -9, q: 2 });
    const both = eqResponse([low, hm]);
    const w = worst(low, { 100: 11, 200: 11, 400: 6, 800: 1, 1600: 1, 3200: -1, 6400: 0 });
    expect(w.err, `LOW alone at ${w.hz} Hz`).toBeLessThanOrEqual(TOL);
    for (const [hzText, want] of Object.entries({ 100: 11, 200: 11, 400: 6, 800: 0, 1600: -3, 3200: -8, 6400: -1 })) {
      const hz = Number(hzText);
      expect(
        Math.abs(both(hz) - want),
        `both at ${hz} Hz: measured ${want}, model ${both(hz).toFixed(1)}`,
      ).toBeLessThanOrEqual(TOL);
    }
  });

  it("is flat where nothing is engaged", () => {
    const off = eqResponse([
      band({ index: 0, on: false, type: EQ_TYPE_PASS }),
      band({ index: 1, gain: 12, on: false }),
      band({ index: 2, gain: 0 }),
      band({ index: 3, type: EQ_TYPE_SHELVING, gain: 0 }),
    ]);
    for (const hz of [20, 200, 1000, 5000, 20000]) expect(off(hz)).toBe(0);
  });

  // The convention above ("the nominal frequency is |gain| - 3 dB") is a property of
  // every shelf, not of the 300-1000 Hz band the measured datasets happen to sit in.
  // It used to fail high up: the bisection bracket ran to nominal × 20, which is past
  // Nyquist for any nominal over 1200 Hz, and `shelfCoefs` aliases there (w0 wraps mod
  // 2π). Where the bracket landed near a multiple of fs the aliased shelf flattened to
  // full gain, so the "which way does the magnitude move" probe compared two near-equal
  // plateau values and the solver walked the wrong bracket. The frequencies below are
  // the app's own slider detents nearest each such multiple; at 11996 Hz / +12 dB the
  // curve read 6.0 dB where the convention requires 9.
  it("holds the shelf convention up where the bracket used to cross Nyquist", () => {
    for (const hz of [2399, 7195, 9617, 11996, 16828, 19188]) {
      for (const gain of [6, 12, 18, -6, -12, -18]) {
        for (const high of [true, false]) {
          const at = eqResponse([band({ index: high ? 3 : 0, type: EQ_TYPE_SHELVING, freq: hz, gain, q: 0.71 })])(hz);
          const want = Math.sign(gain) * (Math.abs(gain) - 3);
          expect(
            Math.abs(at - want),
            `${high ? "HIGH" : "LOW"} ${hz} Hz ${gain} dB: model ${at.toFixed(1)}`,
          ).toBeLessThanOrEqual(TOL);
        }
      }
    }
  });

  it("leaves a shelf's design frequency at the nominal when there is no plateau to find", () => {
    // |gain| ≤ 3 dB has no -3 dB point below its own plateau, so there is nothing to
    // solve and the nominal frequency is used as-is.
    expect(shelfDesignFreq(1000, 3, true)).toBe(1000);
    expect(shelfDesignFreq(1000, -2, false)).toBe(1000);
    // A high shelf's design frequency sits below its nominal, a low shelf's above.
    expect(shelfDesignFreq(1000, 18, true)).toBeLessThan(1000);
    expect(shelfDesignFreq(1000, 18, false)).toBeGreaterThan(1000);
    expect(shelfDesignFreq(1000, -18, true)).toBeLessThan(1000);
    expect(shelfDesignFreq(1000, -18, false)).toBeGreaterThan(1000);
  });
});
