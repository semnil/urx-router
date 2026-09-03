import { describe, expect, it } from "vitest";
import { preferredNumber, R20, R40 } from "./preferred-numbers";

describe("preferred-number series", () => {
  // The forty grades, written out again. A property cannot stand in for them: the table is not
  // a rounding of its own ratio, departing from 10 x 10^(k/40) by more than a plausible
  // mistyped grade does, so no band around the ratio separates the true table from a typo.
  // Every grade a
  // consumer can reach therefore has to be named, and before this existed 26 of the 40 could
  // be changed without a test going red, two of them without the whole suite noticing.
  it("holds the R40 grades", () => {
    expect(R40).toEqual([
      10.0, 10.6, 11.2, 11.8, 12.5, 13.2, 14.0, 15.0, 16.0, 17.0, 18.0, 19.0, 20.0, 21.2, 22.4, 23.6, 25.0, 26.5, 28.0,
      30.0, 31.5, 33.5, 35.5, 37.5, 40.0, 42.5, 45.0, 47.5, 50.0, 53.0, 56.0, 60.0, 63.0, 67.0, 71.0, 75.0, 80.0, 85.0,
      90.0, 95.0,
    ]);
  });

  // The relations the standard defines between the series, which is what makes R20 a
  // derivation rather than a second table: R20 is R40's every other grade, R10 is R20's, and
  // R5 — 10 / 16 / 25 / 40 / 63 — is R10's. A table that satisfies the literal above and
  // fails these is a table that was edited without its structure in mind.
  it("nests: R20 in R40, and R5 in both", () => {
    expect(R40).toHaveLength(40);
    expect(R20).toHaveLength(20);
    expect(R20).toEqual(R40.filter((_, i) => i % 2 === 0));
    expect(R20.filter((_, i) => i % 4 === 0)).toEqual([10, 16, 25, 40, 63]);
    expect(R40.every((v, i) => i === 0 || v > R40[i - 1]!)).toBe(true);
    expect(R40[0]).toBe(10);
  });

  // Decade arithmetic: offset 0 is the 1.0 grade and one series-length is one decade up, so
  // the same grade recurs a factor of ten apart and a negative offset walks down instead of
  // falling off the front of the array.
  it("walks decades in both directions", () => {
    expect(preferredNumber(R40, 0)).toBe(1);
    expect(preferredNumber(R40, 40)).toBe(10);
    expect(preferredNumber(R40, 80)).toBe(100);
    expect(preferredNumber(R40, -40)).toBeCloseTo(0.1, 10);
    expect(preferredNumber(R20, -1)).toBeCloseTo(0.9, 10);
  });

  // A non-integer offset names no grade. It reaches here from a hand-edited or generated plan
  // — the document sanitiser keeps any finite number and the load-time repair only bounds it
  // to the control's window, so a fractional raw inside that window is stored as written —
  // and the readout it feeds has to print a frequency. Indexing on it directly read past the
  // array and made the row say "NaN Hz", where the formula it replaced said "30 Hz".
  it("takes a non-integer offset to the nearest grade rather than off the array", () => {
    expect(preferredNumber(R20, 29.5)).toBe(preferredNumber(R20, 30));
    expect(preferredNumber(R20, 29.4)).toBe(preferredNumber(R20, 29));
    for (const offset of [29.5, 0.5, -0.5, 78.25]) {
      expect(Number.isFinite(preferredNumber(R40, offset)), `${offset}`).toBe(true);
    }
  });
});
