// @vitest-environment jsdom

// The frequency × gain plot's coordinate mapping, which two EQ screens share.
//
// `px` and `freqAt` are inverses of each other, written separately — one maps a frequency
// onto the canvas, the other reads a frequency back out of a pixel column so the response
// can be sampled per column. Two spellings of one mapping is exactly the pair that drifts,
// and the `x0` term is where it drifts first: it exists for the SSMCS MAIN face, which
// draws two plots on one canvas, and it is 0 on every other caller — so a version that
// forgot it in the inverse would sample the RIGHT half's curve from the LEFT half's
// frequencies and still look plausible, since both halves are plots of something.

import { describe, expect, it } from "vitest";
import { freqAt, freqGeo, onGainScale, GAIN_TICKS } from "./dyn-freq-plot";

const W = 700;
const H = 320;

describe("the frequency axis maps both ways", () => {
  it.each([0, 350])("round-trips a frequency through the pixel column, at x0 = %i", (x0) => {
    const g = freqGeo(x0 ? W / 2 : W, H, x0);
    for (const hz of [20, 100, 440, 1000, 5000, 20000]) expect(freqAt(g, g.px(hz), x0)).toBeCloseTo(hz, 6);
  });

  // The offset half really is offset — without this the case above passes on an `x0` that
  // both functions ignore, which is the same failure it exists to catch.
  it("puts the offset half's plot to the right of the plain one", () => {
    const left = freqGeo(W / 2, H, 0);
    const right = freqGeo(W / 2, H, 350);
    expect(right.px(1000) - left.px(1000)).toBeCloseTo(350, 6);
  });

  it("spaces the decades evenly, which is what a log axis is for", () => {
    const g = freqGeo(W, H, 0);
    const decade = g.px(1000) - g.px(100);
    expect(g.px(10000) - g.px(1000)).toBeCloseTo(decade, 6);
    // …and a linear axis would not: the 100 Hz decade would be a tenth of the 10 kHz one.
    expect(decade).toBeGreaterThan(50);
  });

  it("puts the gain axis' ends on the frame and reports what falls outside", () => {
    const g = freqGeo(W, H, 0);
    const top = GAIN_TICKS[0];
    const bottom = GAIN_TICKS[GAIN_TICKS.length - 1];
    expect(g.py(top)).toBeCloseTo(g.pad.t, 6);
    expect(g.py(bottom)).toBeCloseTo(H - g.pad.b, 6);
    expect(onGainScale(top)).toBe(true);
    expect(onGainScale(bottom)).toBe(true);
    expect(onGainScale(top + 0.1)).toBe(false);
    expect(onGainScale(bottom - 0.1)).toBe(false);
  });

  // A band set to the gain range's own maximum evaluates to the maximum give or take the
  // last bit of a double, and which side it lands on is arithmetic: the 4-band bell at
  // +18 dB comes out 17.999999999999986, the morphing strip's 18.000000000000004. Before
  // the tolerance the second lost its marker outright, which is a band at full boost
  // drawn with nothing pointing at it.
  it("keeps a marker whose value is the scale's own edge to within a double's last bit", () => {
    const top = GAIN_TICKS[0];
    const bottom = GAIN_TICKS[GAIN_TICKS.length - 1];
    expect(onGainScale(18.000000000000004)).toBe(true);
    expect(onGainScale(-18.000000000000004)).toBe(true);
    // And it is slop, not a widened axis: a value a reader could see is still off scale.
    expect(onGainScale(top + 0.001)).toBe(false);
    expect(onGainScale(bottom - 0.001)).toBe(false);
  });
});
