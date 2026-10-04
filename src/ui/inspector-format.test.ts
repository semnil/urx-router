// The exact strings the inspector's readouts print. They are not cosmetic: glyph.ts
// splits them on the infinity glyph to style it, the E2E specs assert several of them
// verbatim, and the time readouts are a claim about what the unit's own screens display.

import { describe, expect, it } from "vitest";
import {
  EQ_FREQ_POS_MAX,
  eqFreqToPos,
  eqPosToHz,
  fmtSsmcsAttack,
  fmtSsmcsQ,
  fmtSsmcsRatio,
  fmtSsmcsRelease,
  formatDb,
  formatGainDb,
  formatPan,
} from "./inspector-format";
import { LEVEL_MIN_DB } from "../core/plan";
import { EQ_FREQ_MAX_HZ, EQ_FREQ_MIN_HZ } from "../core/control/vd";
import { COMP_RATIO_INF } from "../core/control/comp-ratio";
import { formatDyn, formatTime } from "../core/control/translate";
import type { TimeReadout } from "../core/control/translate";
import {
  DUCKER_DECAY_STOPS_MS,
  DYN_ATTACK_STOPS_MS,
  DYN_HOLD_STOPS_MS,
  DYN_RELEASE_STOPS_MS,
} from "../core/control/dyn-time-stops";

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

describe("the time readouts", () => {
  // Each string is one the unit's own screen showed for that value: COMP and GATE screens,
  // the SSMCS COMP screen and the DUCKER graph's A / D labels.
  it("prints each control's time the way the unit's screen does", () => {
    const shown: ReadonlyArray<[number, TimeReadout, string]> = [
      [9.826, "attack", "9.826 ms"],
      [10.12, "attack", "10.12 ms"],
      [80, "attack", "80.00 ms"],
      [9.7, "release", "9.7 ms"],
      [98.4, "release", "98.4 ms"],
      [100.1, "release", "100.1 ms"],
      [999, "release", "999.0 ms"],
      [9.75, "hold", "9.75 ms"],
      [10.4, "hold", "10.4 ms"],
      [106, "hold", "106.0 ms"],
      [978, "hold", "978.0 ms"],
      [1020, "hold", "1.02 s"],
      [1960, "hold", "1.96 s"],
      [1.3, "duckerDecay", "1.3 ms"],
      [64, "duckerDecay", "64.0 ms"],
      [1000, "duckerDecay", "1.0 s"],
      [5000, "duckerDecay", "5.0 s"],
    ];
    expect(shown.map(([ms, readout]) => formatTime(ms, readout))).toEqual(shown.map(([, , text]) => text));
  });

  // The GATE / COMP / DUCKER time rows stop on the unit's tables, whose neighbouring stops
  // are closer than one decimal between 1 and 10 ms (attack 1.008 / 1.039, hold 1.06 / 1.10).
  // Every stop prints as itself in its control's readout, so no two neighbours read alike.
  it("prints every stop of the time tables as itself", () => {
    const tables: ReadonlyArray<[readonly number[], TimeReadout]> = [
      [DYN_ATTACK_STOPS_MS, "attack"],
      [DYN_HOLD_STOPS_MS, "hold"],
      [DYN_RELEASE_STOPS_MS, "release"],
      [DUCKER_DECAY_STOPS_MS, "duckerDecay"],
    ];
    const misread: string[] = [];
    for (const [stops, readout] of tables) {
      for (const v of stops) {
        const text = formatDyn(v, readout);
        const [n, unit] = text.split(" ");
        const ms = unit === "s" ? Number(n) * 1000 : Number(n);
        if (Math.abs(ms - v) > 1e-9 * Math.max(1, v)) misread.push(`${v} as ${text}`);
      }
    }
    expect(misread).toEqual([]);
  });
});

describe("fmtSsmcsAttack / fmtSsmcsRelease", () => {
  // The strip's Attack raw 57 + i and Release raw 24 + i are the channel tables' stop i, read at
  // raws where those stops and a logarithmic law between the ends print differently.
  it("prints the channel stop the raw names, in the channel readout", () => {
    expect(fmtSsmcsAttack(57)).toBe("0.092 ms");
    expect(fmtSsmcsAttack(59)).toBe("0.097 ms");
    expect(fmtSsmcsAttack(214)).toBe("10.12 ms");
    expect(fmtSsmcsAttack(283)).toBe("80.00 ms");
    expect(fmtSsmcsRelease(24)).toBe("9.3 ms");
    expect(fmtSsmcsRelease(26)).toBe("9.7 ms");
    expect(fmtSsmcsRelease(164)).toBe("100.1 ms");
    expect(fmtSsmcsRelease(300)).toBe("999.0 ms");
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
