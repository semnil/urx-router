import { describe, expect, it } from "vitest";
import { bandResponse, eqResponse, shelfDesignFreq, ssmcsEqResponse } from "./eq-response";
import type { SsmcsBandState } from "./eq-response";
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

/** Worst absolute deviation between a modelled response and a measured sweep. Takes the
 *  response rather than a band, so the two blocks in this file — the 4-band PEQ and the
 *  SSMCS strip — measure their own filters through one function. */
function worstOf(
  f: (hz: number) => number,
  measured: Record<number, number>,
): { hz: number; want: number; got: number; err: number } {
  let out = { hz: 0, want: 0, got: 0, err: -1 };
  for (const [hzText, want] of Object.entries(measured)) {
    const hz = Number(hzText);
    const got = f(hz);
    const err = Math.abs(got - want);
    if (err > out.err) out = { hz, want, got, err };
  }
  return out;
}

const worst = (b: EqBandState, measured: Record<number, number>): ReturnType<typeof worstOf> =>
  worstOf(bandResponse(b), measured);

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

// The mid bands are fixed peaking on the unit — it rejects a type write there
// (response_code 400) and the emit never sends one — so a type parked on one by a
// hand-authored plan or a `?plan=` link describes nothing the hardware is running.
// The plot used to honour it anyway, drawing a high-pass or a shelf for a band the
// device runs as a bell, and contradicting the unit by up to the band's full gain.
describe("a mid band is drawn as the peaking filter the device runs", () => {
  it("ignores a PASS or SHELVING type on LOW-MID and HIGH-MID", () => {
    for (const index of [1, 2]) {
      const bell = bandResponse(band({ index, gain: 12, q: 1 }));
      for (const type of [EQ_TYPE_PASS, EQ_TYPE_SHELVING]) {
        const typed = bandResponse(band({ index, gain: 12, q: 1, type }));
        for (const hz of [100, 500, 1000, 4000]) expect(typed(hz)).toBeCloseTo(bell(hz), 6);
      }
    }
  });

  it("still honours the type on LOW and HIGH, which the device does take", () => {
    const lowPass = bandResponse(band({ index: 0, type: EQ_TYPE_PASS, freq: 1000 }));
    expect(lowPass(100)).toBeLessThan(-20);
    const highShelf = bandResponse(band({ index: 3, type: EQ_TYPE_SHELVING, freq: 1000, gain: 12, q: 0.71 }));
    expect(highShelf(4000)).toBeGreaterThan(10);
  });
});

// The morphing strip's EQ is a different DSP block: three bands, LOW and HIGH fixed
// shelving, MID fixed peaking, and no type slot at all. Its shelves executed in no test
// at all until this block — every band in the factory capture ships at 0 dB, which
// short-circuits to FLAT before a filter is ever designed, so the branch was reachable
// only from a plan somebody had edited.
describe("the SSMCS strip's three-band EQ", () => {
  const band = (over: Partial<SsmcsBandState> & { kind: SsmcsBandState["kind"] }): SsmcsBandState => ({
    on: true,
    freq: 1000,
    q: 1,
    gain: 0,
    ...over,
  });
  const only = (b: SsmcsBandState): ((hz: number) => number) => ssmcsEqResponse([b]);

  it("shelves LOW below its frequency and HIGH above it", () => {
    const low = only(band({ kind: "low", freq: 200, gain: 12 }));
    expect(low(20)).toBeCloseTo(12, 0); // the plateau
    expect(low(200)).toBeCloseTo(9, 0); // the nominal, 3 dB below it
    expect(low(20000)).toBeCloseTo(0, 1); // nothing left at the far end

    const high = only(band({ kind: "high", freq: 4000, gain: -9 }));
    expect(high(20000)).toBeCloseTo(-9, 0);
    expect(high(4000)).toBeCloseTo(-6, 0);
    expect(high(20)).toBeCloseTo(0, 1);
  });

  // The shelves have no Q parameter on the device, so a value parked on one by a
  // hand-authored plan must not reach the filter.
  it("ignores the Q on a shelf, and reads it on the bell", () => {
    const shelf = (q: number) => only(band({ kind: "low", freq: 200, gain: 12, q }));
    for (const hz of [50, 200, 800]) expect(shelf(6)(hz)).toBeCloseTo(shelf(0.5)(hz), 6);
    const bell = (q: number) => only(band({ kind: "mid", freq: 1000, gain: 12, q }));
    expect(bell(6)(700)).toBeLessThan(bell(0.5)(700) - 1);
  });

  /**
   * The bell IS the sweep, at every point of it.
   *
   * Three states of the MID band at 1002 Hz, read on a URX44V as `112` − `111`: every other
   * frequency of the sweep's grid from 100 Hz to 10 kHz, so the two skirts are covered as
   * well as the peak. Both meters quantize to 1 dB, so a point can be half a step out on
   * each; 1.5 dB is that floor with a little room, and it is the whole tolerance — no
   * per-point exceptions.
   *
   * The three are what separate the LAW from a constant. +18 and +6 differ only in gain, so
   * together they pin the gain dependence a constant ratio cannot carry; Q 2.83 against
   * Q 1.00 pins that the ratio does NOT move with Q.
   *
   * Asserted point by point rather than as a summary: an RMS passes with one point 5 dB out
   * if the rest are close, and one point 5 dB out is exactly what a wrong Q law looks like
   * on a skirt.
   *
   * Keyed by frequency like every other sweep in this file, rather than by position against
   * a shared grid: a table paired by index re-pairs silently the moment either list is
   * reordered or gains a point.
   */
  const MID_SWEEP: readonly { label: string; gain: number; q: number; db: Record<number, number> }[] = [
    {
      label: "+18 dB / Q 1.00",
      gain: 18,
      q: 1,
      // prettier-ignore
      db: {
        100.2: 2, 126.2: 3, 158.9: 4, 200: 5, 251.8: 7, 317: 8, 399.1: 10, 502.4: 13, 632.5: 15, 796.2: 17,
        1002.4: 18, 1261.9: 17, 1588.7: 15, 2000: 13, 2517.9: 10, 3169.8: 8, 3990.5: 6, 5023.8: 5, 6324.6: 3,
        7962.1: 2, 10023.7: 1,
      },
    },
    {
      label: "+6 dB / Q 1.00",
      gain: 6,
      q: 1,
      // prettier-ignore
      db: {
        100.2: 0, 126.2: 1, 158.9: 1, 200: 2, 251.8: 3, 317: 3, 399.1: 4, 502.4: 5, 632.5: 5, 796.2: 5,
        1002.4: 6, 1261.9: 5, 1588.7: 5, 2000: 5, 2517.9: 4, 3169.8: 3, 3990.5: 2, 5023.8: 2, 6324.6: 1,
        7962.1: 1, 10023.7: 0,
      },
    },
    {
      label: "+18 dB / Q 2.83",
      gain: 18,
      q: 2.83,
      // prettier-ignore
      db: {
        100.2: 0, 126.2: 0, 158.9: 0, 200: 1, 251.8: 1, 317: 2, 399.1: 4, 502.4: 6, 632.5: 9, 796.2: 13,
        1002.4: 18, 1261.9: 13, 1588.7: 9, 2000: 6, 2517.9: 4, 3169.8: 2, 3990.5: 1, 5023.8: 1, 6324.6: 0,
        7962.1: 0, 10023.7: 0,
      },
    },
  ];

  it.each(MID_SWEEP)("draws the MID bell where the unit measured it ($label)", ({ gain, q, db }) => {
    const w = worstOf(only(band({ kind: "mid", freq: 1002.4, gain, q })), db);
    expect(w.err, `${w.hz} Hz: drew ${w.got.toFixed(1)}, unit read ${w.want}`).toBeLessThan(1.5);
  });

  it("sums the three bands and drops the ones switched off", () => {
    const low = band({ kind: "low", freq: 200, gain: 12 });
    const mid = band({ kind: "mid", freq: 1000, gain: 6, q: 1 });
    const both = ssmcsEqResponse([low, mid]);
    expect(both(20)).toBeCloseTo(only(low)(20) + only(mid)(20), 6);
    expect(ssmcsEqResponse([{ ...low, on: false }, mid])(20)).toBeCloseTo(only(mid)(20), 6);
    // A band at 0 dB contributes nothing whether it is on or off.
    expect(ssmcsEqResponse([{ ...low, gain: 0 }])(20)).toBe(0);
  });
});
