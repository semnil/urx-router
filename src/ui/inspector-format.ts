// Value formatters and slider-position mappings for the inspector's parameter
// rows. Split out of inspector.ts so the exact display strings — which
// setLevelText (ui/glyph.ts) splits on the infinity glyph, and which the E2E
// specs assert verbatim — can be pinned without rendering a panel.

import { LEVEL_MIN_DB } from "../core/plan";
import { formatHz } from "../core/control/fx-effect";
import { formatDyn } from "../core/control/translate";
import { MBC_RELEASE_MS } from "../core/control/insert-fx-effect";
import { EQ_FREQ_MAX_HZ, EQ_FREQ_MIN_HZ, ssmcsFreqHz, ssmcsGainDb, ssmcsQ } from "../core/control/vd";

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

// SSMCS raw-value display formatters: ms (3-tier to match the device's variable
// precision) and ratio (∞ at the top). Hz and dB reuse formatHz / formatDyn.
export function fmtSsmcsMs(ms: number): string {
  return ms < 10 ? `${ms.toFixed(3)} ms` : ms < 100 ? `${ms.toFixed(2)} ms` : `${ms.toFixed(1)} ms`;
}
export function fmtSsmcsRatio(r: number): string {
  return r === Infinity ? "∞:1" : `${r.toFixed(2)}:1`;
}
export const fmtSsmcsHz = (raw: number): string => formatHz(ssmcsFreqHz(raw));
export const fmtSsmcsGain = (raw: number): string => formatDyn(ssmcsGainDb(raw), "db");
export const fmtSsmcsQ = (raw: number): string => ssmcsQ(raw).toFixed(2);

// MBC release: a detent index into the calibrated ms table, shown in seconds from
// 1000 ms up so the long end reads as the device prints it.
export function mbcReleaseLabel(index: number): string {
  const ms = MBC_RELEASE_MS[index] ?? 0;
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`;
}

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
