// Value formatters and slider-position mappings for the inspector's parameter
// rows. Split out of inspector.ts so the exact display strings — which
// setLevelText (ui/glyph.ts) splits on the infinity glyph, and which the E2E
// specs assert verbatim — can be pinned without rendering a panel.

import { LEVEL_MIN_DB } from "../core/plan";
import { formatHz } from "../core/control/fx-effect";
import { preferredNumber, R40 } from "../core/control/preferred-numbers";
import { formatDyn, formatTime } from "../core/control/translate";
import { formatCompRatio } from "../core/control/comp-ratio";
import {
  EQ_FREQ_MAX_HZ,
  EQ_FREQ_MIN_HZ,
  SSMCS_FREQ_RAW_MIN,
  ssmcsAttackMs,
  ssmcsGainDb,
  ssmcsQ,
  ssmcsReleaseMs,
} from "../core/control/vd";

// The lowest real value shown is LEVEL_MIN_DB (-96.0); formatDb prints -∞ below it.
export const LEVEL_MIN = LEVEL_MIN_DB;

export function formatDb(v: number): string {
  if (v < LEVEL_MIN) return "-∞ dB";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
}

export function formatPan(v: number): string {
  if (v === 0) return "C";
  return v < 0 ? `L ${-v}` : `R ${v}`;
}

export function formatGainDb(v: number): string {
  return `${v > 0 ? "+" : ""}${v} dB`;
}

// SSMCS raw-value display formatters: the comp times (the channel Attack / Release stops, in
// those controls' own readouts) and ratio (the strip's own three-figure field). Hz and dB reuse
// formatHz / formatDyn.
export const fmtSsmcsAttack = (raw: number): string => formatTime(ssmcsAttackMs(raw), "attack");
export const fmtSsmcsRelease = (raw: number): string => formatTime(ssmcsReleaseMs(raw), "release");
export function fmtSsmcsRatio(r: number): string {
  return formatCompRatio(r, "ssmcs");
}
/** An SSMCS band frequency prints as the R40 grade the raw names (raw 4 = 20.0 Hz, one grade per
 *  raw: 22.4 Hz, 265 Hz, 12.5 kHz), which the continuous `ssmcsFreqHz` the response curves are
 *  drawn from lands near but not on. */
export const fmtSsmcsHz = (raw: number): string => formatHz(preferredNumber(R40, raw - SSMCS_FREQ_RAW_MIN + 52));
export const fmtSsmcsGain = (raw: number): string => formatDyn(ssmcsGainDb(raw), "db");
export const fmtSsmcsQ = (raw: number): string => ssmcsQ(raw).toFixed(2);

// EQ band frequency on a log scale (20 Hz … 20 kHz) over EQ_FREQ_POS_MAX slider
// positions, so each octave gets equal width and every stop is a whole Hz.
export const EQ_FREQ_POS_MAX = 1000;
const EQ_FREQ_RATIO = Math.log(EQ_FREQ_MAX_HZ / EQ_FREQ_MIN_HZ);

export function eqFreqToPos(hz: number): number {
  return Math.round((EQ_FREQ_POS_MAX * Math.log(hz / EQ_FREQ_MIN_HZ)) / EQ_FREQ_RATIO);
}

export function eqPosToHz(pos: number): number {
  return Math.round(EQ_FREQ_MIN_HZ * Math.exp((EQ_FREQ_RATIO * pos) / EQ_FREQ_POS_MAX));
}
