// The exact strings the inspector's readouts print. They are not cosmetic: glyph.ts
// splits them on the infinity glyph to style it, the E2E specs assert several of them
// verbatim, and the SSMCS precision tiers are a claim about what the unit displays.

import { describe, expect, it } from "vitest";
import {
  EQ_FREQ_POS_MAX,
  eqFreqToPos,
  eqPosToHz,
  fmtSsmcsMs,
  fmtSsmcsQ,
  fmtSsmcsRatio,
  formatDb,
  formatGainDb,
  formatPan,
} from "./inspector-format";
import { LEVEL_MIN_DB } from "../core/plan";
import { EQ_FREQ_MAX_HZ, EQ_FREQ_MIN_HZ } from "../core/control/vd";
import { COMP_RATIO_INF } from "../core/control/comp-ratio";
import { formatDyn } from "../core/control/translate";

describe("formatDb", () => {
  it("prints one decimal and a leading + above zero", () => {
    expect(formatDb(0)).toBe("0.0 dB");
    expect(formatDb(-20)).toBe("-20.0 dB");
    expect(formatDb(10)).toBe("+10.0 dB");
    expect(formatDb(-0.5)).toBe("-0.5 dB");
  });

  // The lowest real value the grid holds is LEVEL_MIN_DB; anything under it is the
  // off position, which prints as the infinity glyph glyph.ts styles.
  it("prints the off position as -∞ only below the grid's floor", () => {
    expect(formatDb(LEVEL_MIN_DB)).toBe("-96.0 dB");
    expect(formatDb(LEVEL_MIN_DB - 0.1)).toBe("-∞ dB");
    expect(formatDb(-Infinity)).toBe("-∞ dB");
  });
});

describe("formatPan", () => {
  it("names the centre and gives each side its letter", () => {
    expect(formatPan(0)).toBe("C");
    expect(formatPan(-1)).toBe("L 1");
    expect(formatPan(-63)).toBe("L 63");
    expect(formatPan(63)).toBe("R 63");
  });
});

describe("formatGainDb", () => {
  it("prints a whole dB with a leading + above zero", () => {
    expect(formatGainDb(0)).toBe("0 dB");
    expect(formatGainDb(-8)).toBe("-8 dB");
    expect(formatGainDb(24)).toBe("+24 dB");
  });
});

describe("fmtSsmcsMs", () => {
  // Three tiers, matching the precision the unit itself varies as the value grows.
  it("gives three decimals under 10 ms, two under 100, one above", () => {
    expect(fmtSsmcsMs(0.092)).toBe("0.092 ms");
    expect(fmtSsmcsMs(9.999)).toBe("9.999 ms");
    expect(fmtSsmcsMs(10)).toBe("10.00 ms");
    expect(fmtSsmcsMs(99.99)).toBe("99.99 ms");
    expect(fmtSsmcsMs(100)).toBe("100.0 ms");
    expect(fmtSsmcsMs(1500)).toBe("1500.0 ms");
  });
});

describe("fmtSsmcsRatio", () => {
  // The strip's own field, which fits three figures: two decimals below 10:1, one from
  // there, and no decimal at all from 100:1 up, where the channel COMP keeps one.
  it("prints a ratio the way the strip's screen does", () => {
    expect(fmtSsmcsRatio(1)).toBe("1.00:1");
    expect(fmtSsmcsRatio(3.5)).toBe("3.50:1");
    expect(fmtSsmcsRatio(9.5)).toBe("9.50:1");
    expect(fmtSsmcsRatio(10)).toBe("10.0:1");
    expect(fmtSsmcsRatio(65)).toBe("65.0:1");
    expect(fmtSsmcsRatio(100)).toBe("100:1");
    expect(fmtSsmcsRatio(500)).toBe("500:1");
  });

  it("prints the top of the range the way the unit names it", () => {
    expect(fmtSsmcsRatio(Infinity)).toBe("INF:1");
  });
});

describe("the channel COMP's ratio", () => {
  // The other bank, whose field is a number a plan can hold rather than Infinity: the value
  // standing for the unit's INF:1 has to print as INF:1 and not as the number it is.
  it("prints its top stop as the unit names it, and everything else as a ratio", () => {
    expect(formatDyn(COMP_RATIO_INF, "ratio")).toBe("INF:1");
    expect(formatDyn(1, "ratio")).toBe("1.00:1");
    expect(formatDyn(9.5, "ratio")).toBe("9.50:1");
    expect(formatDyn(20, "ratio")).toBe("20.0:1");
    // Where the two banks differ: this one keeps the decimal from 100:1 up.
    expect(formatDyn(100, "ratio")).toBe("100.0:1");
    expect(formatDyn(500, "ratio")).toBe("500.0:1");
  });
});

describe("fmtSsmcsQ", () => {
  it("prints two decimals", () => {
    expect(fmtSsmcsQ(0)).toMatch(/^\d+\.\d{2}$/);
  });
});

describe("EQ band frequency mapping", () => {
  it("puts the ends of the range at the ends of the slider", () => {
    expect(eqFreqToPos(EQ_FREQ_MIN_HZ)).toBe(0);
    expect(eqFreqToPos(EQ_FREQ_MAX_HZ)).toBe(EQ_FREQ_POS_MAX);
    expect(eqPosToHz(0)).toBe(EQ_FREQ_MIN_HZ);
    expect(eqPosToHz(EQ_FREQ_POS_MAX)).toBe(EQ_FREQ_MAX_HZ);
  });

  // Log, so each octave gets equal width: doubling the frequency moves the slider
  // by the same number of positions wherever it starts.
  it("gives every octave the same width", () => {
    const octave = eqFreqToPos(200) - eqFreqToPos(100);
    expect(Math.abs(eqFreqToPos(2000) - eqFreqToPos(1000) - octave)).toBeLessThanOrEqual(1);
    expect(Math.abs(eqFreqToPos(8000) - eqFreqToPos(4000) - octave)).toBeLessThanOrEqual(1);
  });

  // The stored value is Hz, so that is the round trip that has to be exact: a
  // reported frequency must come back to the same slider position and out again as
  // the same number, or a panel re-render would walk the value.
  it("round-trips a reported frequency exactly", () => {
    for (let pos = 0; pos <= EQ_FREQ_POS_MAX; pos++) {
      const hz = eqPosToHz(pos);
      expect(eqPosToHz(eqFreqToPos(hz))).toBe(hz);
    }
  });

  // The position round trip is NOT exact at the bottom: one stop there is a
  // fraction of a Hz, so several positions collapse onto 20 Hz and come back as the
  // lowest of them. It is a fixed point after one pass, which is what stops a
  // slider creeping under repeated reads.
  it("settles after one pass, with the coarsest error at the bottom of the range", () => {
    let worst = 0;
    for (let pos = 0; pos <= EQ_FREQ_POS_MAX; pos++) {
      const back = eqFreqToPos(eqPosToHz(pos));
      worst = Math.max(worst, Math.abs(back - pos));
      expect(eqFreqToPos(eqPosToHz(back))).toBe(back);
    }
    expect(worst).toBe(3);
    expect(eqFreqToPos(eqPosToHz(500)) - 500).toBe(0);
  });

  it("reports every stop as a whole Hz inside the range", () => {
    for (let pos = 0; pos <= EQ_FREQ_POS_MAX; pos += 53) {
      const hz = eqPosToHz(pos);
      expect(Number.isInteger(hz)).toBe(true);
      expect(hz).toBeGreaterThanOrEqual(EQ_FREQ_MIN_HZ);
      expect(hz).toBeLessThanOrEqual(EQ_FREQ_MAX_HZ);
    }
  });
});
