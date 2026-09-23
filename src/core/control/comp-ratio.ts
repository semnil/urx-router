// The compressor Ratio ladder, in a module of its own because both of the layers that
// need it are inside an import cycle: `vd.ts` sizes the SSMCS raw range from the table
// and `translate.ts` builds the channel COMP field from it, both at module scope, and a
// binding read there is only reliable when the module it comes from imports nothing.
//
// The channel COMP (`36`) and the SSMCS strip's compressor (`98`) stop on the same
// ratios and write them differently: `98` carries the index into this table, `36`
// carries ratio×100.

// The finite stops from 4.00:1 up, which are the unit's own and follow no law.
const COMP_RATIO_ABOVE_4: readonly number[] = [
  4, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 5, 5.2, 5.4, 5.6, 5.8, 6, 6.2, 6.4, 6.6, 6.8, 7, 7.5, 8, 8.5, 9, 9.5,
  10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 45, 50, 55, 60, 65, 70, 80, 90,
  100, 150, 200, 300, 500,
];

/** Every ratio the control stops on, in order: 0.05 spacing from 1.00:1 up to 4.00:1,
 *  then `COMP_RATIO_ABOVE_4`, then INF:1. The index is the `98` raw. */
export const COMP_RATIO_STEPS: readonly number[] = [
  ...Array.from({ length: 60 }, (_, i) => Number((1 + 0.05 * i).toFixed(2))),
  ...COMP_RATIO_ABOVE_4,
  Infinity,
];

/** The finest spacing on the ladder, which is the one below 4.00:1. */
export const COMP_RATIO_FINEST_STEP = 0.05;

/** What a plan carries for the top stop on the CHANNEL COMP's ladder, where the SSMCS
 *  strip carries an index and this one carries ratio×100. The unit puts `INF:1` on `36`'s
 *  widest raw, 65535, so the plan holds that raw in the parameter's own unit and the
 *  encoders need no case of their own — the shape the GATE range's `-∞` notch already has,
 *  where a finite dB value one step below the floor stands for the device's own sentinel.
 *  A plan is JSON, which has no `Infinity` to carry instead. */
export const COMP_RATIO_INF = 655.35;

/** The stops the channel COMP offers, which are the shared ladder with its top stop written
 *  the way a plan can hold it. */
export const COMP_RATIO_CH_STEPS: readonly number[] = COMP_RATIO_STEPS.map((r) =>
  r === Infinity ? COMP_RATIO_INF : r,
);

/** The nearest stop to a value, as an index into a field's stop table. */
export function nearestStepIndex(steps: readonly number[], v: number): number {
  let best = 0;
  for (let i = 1; i < steps.length; i++) {
    if (Math.abs(steps[i] - v) < Math.abs(steps[best] - v)) best = i;
  }
  return best;
}

/** A compressor Ratio as the unit writes it: two decimals below 10:1 and one above,
 *  `INF:1` at the top of the ladder. The SSMCS strip's field fits three figures, so from
 *  100:1 up it drops the decimal place the channel COMP keeps. */
export function formatCompRatio(ratio: number, bank: "comp" | "ssmcs"): string {
  if (ratio === Infinity || ratio === COMP_RATIO_INF) return "INF:1";
  if (ratio < 10) return `${ratio.toFixed(2)}:1`;
  if (bank === "ssmcs" && ratio >= 100) return `${ratio.toFixed(0)}:1`;
  return `${ratio.toFixed(1)}:1`;
}
