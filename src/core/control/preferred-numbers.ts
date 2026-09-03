// ISO 3 preferred numbers (the Renard series), which is what the unit's frequency tables
// step in — for the FX channel filters and for the multi-band compressor's crossover alike.
// One seat, because the two catalogues were carrying the same forty grades and the same
// offset separately and had already drifted apart in float: the copy built from a 1.0-based
// mantissa answered 112.00000000000001 for the grade the other answered 112 for, and its
// screen printed "112.0 Hz" where the unit prints "112".
//
// A geometric law looks like one of these and is not: R40's ratio is 10^(1/40) = 1.0593
// against 2^(1/12) = 1.0595, and R20's is 10^(1/20) = 1.122 against 2^(1/6) = 1.122. What
// separates them is that a series is ROUNDED to its grade's own values, so its steps land on
// the numbers a filter is labelled with (315, 5k, 8k, 16k) while a formula lands beside them
// (320.4, 5125.8, 8136.7, 16273.4).
//
// The grades are written out rather than computed, since a grade carries roundings a formula
// does not reproduce — R40 holds 31.5 where 10 × 10^(20/40) = 31.62.

/** R40: one decade in forty grades. */
export const R40 = [
  10.0, 10.6, 11.2, 11.8, 12.5, 13.2, 14.0, 15.0, 16.0, 17.0, 18.0, 19.0, 20.0, 21.2, 22.4, 23.6, 25.0, 26.5, 28.0,
  30.0, 31.5, 33.5, 35.5, 37.5, 40.0, 42.5, 45.0, 47.5, 50.0, 53.0, 56.0, 60.0, 63.0, 67.0, 71.0, 75.0, 80.0, 85.0,
  90.0, 95.0,
];
/** R20 is R40's every other grade — one decade in twenty. */
export const R20 = R40.filter((_, i) => i % 2 === 0);

/** The grade `offset` places above the series' 1.0 decade, so offset 0 is 1.0 and offset
 *  `series.length` is 10. A non-integer offset names no grade and is taken to the nearest
 *  one: a fractional raw reaches this from a hand-edited plan, and the readout it feeds has
 *  to print a frequency rather than NaN. */
export function preferredNumber(series: readonly number[], offset: number): number {
  const n = series.length;
  const k = Math.round(offset);
  const i = ((k % n) + n) % n;
  return series[i]! * Math.pow(10, Math.floor(k / n) - 1);
}
