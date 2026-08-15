// The 4-band PEQ's frequency response, as the unit actually implements it.
//
// Measured on a URX44V (V1.3.1.0, 2026-07-30) by driving the oscillator into MIX 1 and
// reading the difference between the two meters that bracket the EQ (PRE EQ 105:0 →
// PRE FADER 122:0), then repeated on the STEREO master block and, with the host's USB
// output as the source, on a stereo channel — 19 datasets / 108 points, worst case
// 1.3 dB, which is the resolution of a difference between two 1 dB-quantized peak
// meters. The filters are RBJ cookbook biquads with three corrections that only came
// out of measuring, and each one was drawing a visibly wrong curve before it did:
//
//   peaking   The unit's Q is TWICE the biquad Q. A "Q 1.00" bell measured
//             +12/+10/+7/+3 dB at 1k/700/500/300 Hz with a +12 dB setting, which is a
//             biquad Q of 0.5. Taking the number at face value drew every bell half as
//             wide as the device's.
//   HPF/LPF   Fixed 2nd-order Butterworth: -3.0 dB exactly at the nominal frequency and
//             12 dB/octave beyond (-13/-25/-40 dB at 1/2/3.3 octaves). **The band's Q
//             slot is ignored** — Q 0.71 and Q 4.00 measured identical, with no
//             resonant peak at the corner.
//   shelving  The S = 1 shape, but the unit's nominal frequency is the point 3 dB
//             below the plateau, not the midpoint: a +18 dB shelf at 1 kHz measured
//             +15 dB at 1 kHz and reached +18 dB only by 4 kHz. So the design
//             frequency is solved for, and the search direction flips with the gain's
//             sign — reusing the boost direction for a cut was 4.2 dB out.
//
// Two further measurements bound what this model is worth: bands sum in dB (a LOW
// shelf +12 and a HIGH-MID peaking -9 measured together matched the sum of the two
// measured separately to within the meters' own ±2 dB), and the sample rate moves a
// high bell by at most 2 dB across 44.1 … 176.4 kHz — so the drawing is computed at 48
// kHz whatever the plan's rate, and says so rather than pretending otherwise.
//
// The SSMCS strip's own 3-band EQ is at the foot of this file. It is a different DSP
// block reached by switching the channel's COMP/EQ type, so it shares the shelf
// convention and nothing else: its peaking Q is its own, and the two must not be
// carried across.

import { EQ_TYPE_PASS, EQ_TYPE_SHELVING } from "./control/params";

/** The rate the response is drawn at. Rate dependence is ≤2 dB across the device's
 *  whole range (measured), which is inside the measurement's own resolution. */
export const EQ_RESPONSE_FS = 48000;

/** One band as the response model needs it. `index` decides which pass filter the
 *  PASS type means — LOW is a high-pass, HIGH is a low-pass — and the two mid bands
 *  cannot be typed at all (the device rejects the write). */
export interface EqBandState {
  index: number;
  on: boolean;
  type: number;
  freq: number;
  q: number;
  gain: number;
}

/** Biquad coefficients, normalised by a0 on evaluation. */
interface Coefs {
  b0: number;
  b1: number;
  b2: number;
  a0: number;
  a1: number;
  a2: number;
}

/** |H(f)| in dB for a biquad at one frequency. */
function magDb(c: Coefs, hz: number, fs: number): number {
  const w = (2 * Math.PI * hz) / fs;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  const nRe = c.b0 + c.b1 * cw + c.b2 * c2;
  const nIm = -(c.b1 * sw + c.b2 * s2);
  const dRe = c.a0 + c.a1 * cw + c.a2 * c2;
  const dIm = -(c.a1 * sw + c.a2 * s2);
  // The squared magnitudes, not `hypot`: their ratio carries the same dB (verified to
  // 7e-15 dB over 220 filter settings across 20 Hz … 20 kHz) and the largest coefficient
  // part here is ~59, so hypot's overflow guard buys nothing. Measured 1.45x faster in V8,
  // more in JSC — which is the engine the macOS build renders in.
  const num = nRe * nRe + nIm * nIm;
  const den = dRe * dRe + dIm * dIm;
  if (den === 0 || num === 0) return 0;
  return 10 * Math.log10(num / den);
}

/** Displayed Q → biquad Q, per DSP block. Each is measured on its own block and neither
 *  may be used for the other: the 4-band PEQ's bell is half the width its number says,
 *  the SSMCS strip's is very nearly the width its number says. Kept adjacent so the two
 *  are read together — carrying the 4-band factor into SSMCS draws every bell at 0.5. */
const PEQ_Q_TO_BIQUAD = 0.5;
const SSMCS_Q_TO_BIQUAD = 0.82;

/** `q` is the BIQUAD Q, already converted from the displayed one by the caller. */
function peakingCoefs(hz: number, q: number, gainDb: number, fs: number): Coefs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * hz) / fs;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  return {
    b0: 1 + alpha * A,
    b1: -2 * cw,
    b2: 1 - alpha * A,
    a0: 1 + alpha / A,
    a1: -2 * cw,
    a2: 1 - alpha / A,
  };
}

function passCoefs(hz: number, high: boolean, fs: number): Coefs {
  const w0 = (2 * Math.PI * hz) / fs;
  const cw = Math.cos(w0);
  // Fixed Butterworth: the band's Q slot has no effect on a pass filter (measured).
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a = { a0: 1 + alpha, a1: -2 * cw, a2: 1 - alpha };
  return high
    ? { b0: (1 + cw) / 2, b1: -(1 + cw), b2: (1 + cw) / 2, ...a }
    : { b0: (1 - cw) / 2, b1: 1 - cw, b2: (1 - cw) / 2, ...a };
}

function shelfCoefs(hz: number, gainDb: number, high: boolean, fs: number): Coefs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * hz) / fs;
  const cw = Math.cos(w0);
  // S = 1 (the shape the unit draws); the RBJ alpha collapses to sin(w0)/2 · √2.
  const alpha = (Math.sin(w0) / 2) * Math.SQRT2;
  const tsa = 2 * Math.sqrt(A) * alpha;
  if (high) {
    return {
      b0: A * (A + 1 + (A - 1) * cw + tsa),
      b1: -2 * A * (A - 1 + (A + 1) * cw),
      b2: A * (A + 1 + (A - 1) * cw - tsa),
      a0: A + 1 - (A - 1) * cw + tsa,
      a1: 2 * (A - 1 - (A + 1) * cw),
      a2: A + 1 - (A - 1) * cw - tsa,
    };
  }
  return {
    b0: A * (A + 1 - (A - 1) * cw + tsa),
    b1: 2 * A * (A - 1 - (A + 1) * cw),
    b2: A * (A + 1 - (A - 1) * cw - tsa),
    a0: A + 1 + (A - 1) * cw + tsa,
    a1: -2 * (A - 1 + (A + 1) * cw),
    a2: A + 1 + (A - 1) * cw - tsa,
  };
}

/**
 * The design frequency whose S = 1 shelf passes |gain| - 3 dB at the nominal one — the
 * unit's own convention (measured). Bisected on a log frequency axis; the direction the
 * magnitude moves in is read off the function rather than assumed, because it flips
 * with the gain's sign, and the result is clamped so solving can only ever move the
 * transition outward (a high shelf's design frequency below its nominal, a low shelf's
 * above), never widen it the wrong way.
 */
export function shelfDesignFreq(nominal: number, gainDb: number, high: boolean, fs = EQ_RESPONSE_FS): number {
  const target = Math.abs(gainDb) - 3;
  if (target <= 0) return nominal;
  const at = (f: number): number => Math.abs(magDb(shelfCoefs(f, gainDb, high, fs), nominal, fs));
  let lo = nominal / 20;
  // Kept under Nyquist. `shelfCoefs` past fs/2 aliases (w0 wraps mod 2π), and where
  // nominal × 20 lands near a multiple of fs the aliased shelf degenerates to a flat
  // full-gain plateau — `rising` then compares two near-equal values and the bisection
  // walks the wrong bracket. Measured over the inspector's own 1001-value frequency
  // grid × 8 gains × 2 shelf directions: 71 of 16016 settings drew more than the
  // model's 2 dB tolerance off at their own nominal frequency, and a HIGH shelf at
  // 11996 Hz / +12 dB read 6.0 dB where the measured convention requires 9.
  let hi = Math.min(nominal * 20, fs / 2 - 1);
  const rising = at(hi) > at(lo);
  for (let i = 0; i < 40; i++) {
    const mid = Math.sqrt(lo * hi);
    if (rising ? at(mid) < target : at(mid) > target) lo = mid;
    else hi = mid;
  }
  const solved = Math.sqrt(lo * hi);
  return high ? Math.min(solved, nominal) : Math.max(solved, nominal);
}

/** Shared "contributes nothing" response, so an untouched band can be filtered out of the
 *  sum rather than called once per pixel column to return zero. */
const FLAT = (): number => 0;

/** One band's response, as a function of frequency in dB. The coefficients (and a
 *  shelf's solved design frequency) are built once here rather than per sample point:
 *  the plot evaluates this once per pixel column of the plot's width. */
export function bandResponse(b: EqBandState, fs = EQ_RESPONSE_FS): (hz: number) => number {
  if (!b.on) return FLAT;
  const high = b.index === 3;
  // LOW-MID and HIGH-MID are fixed peaking on the unit: it rejects a type write there
  // (response_code 400, measured), and the emit never sends one. A hand-authored plan
  // can still park a type on one — the load funnel passes any finite numeric leaf — and
  // the plot used to honour it, drawing a 2nd-order high-pass for a band the device is
  // running as a bell. The curve then contradicts the hardware by up to the band's full
  // gain, which is the one thing this drawing exists to not do.
  const typed = b.index === 0 || b.index === 3;
  if (typed && b.type === EQ_TYPE_PASS) {
    const c = passCoefs(b.freq, !high, fs);
    return (hz) => magDb(c, hz, fs);
  }
  if (typed && b.type === EQ_TYPE_SHELVING) {
    if (b.gain === 0) return FLAT;
    const c = shelfCoefs(shelfDesignFreq(b.freq, b.gain, high, fs), b.gain, high, fs);
    return (hz) => magDb(c, hz, fs);
  }
  if (b.gain === 0) return FLAT;
  const c = peakingCoefs(b.freq, b.q * PEQ_Q_TO_BIQUAD, b.gain, fs);
  return (hz) => magDb(c, hz, fs);
}

/** The whole EQ's response: the bands summed in dB (measured to hold within the
 *  meters' resolution). */
export function eqResponse(bands: readonly EqBandState[], fs = EQ_RESPONSE_FS): (hz: number) => number {
  return sumDb(bands.map((b) => bandResponse(b, fs)));
}

/** Sum the bands that contribute, or answer flat when none does. */
function sumDb(parts: ((hz: number) => number)[]): (hz: number) => number {
  const live = parts.filter((p) => p !== FLAT);
  if (!live.length) return FLAT;
  return (hz) => {
    let sum = 0;
    for (const p of live) sum += p(hz);
    return sum;
  };
}

// ---------------------------------------------------------------- SSMCS 3-band
//
// The morphing strip's EQ, in plan units (Hz / Q / dB — the descriptor converts the raw
// broker integers). Three fixed bands: LOW shelving, MID peaking, HIGH shelving. There
// is no type to read and no pass filter, which is why this is a function of its own
// rather than four bands with two of them switched off.
//
// What it shares with the 4-band model above is the shelf convention — the nominal
// frequency is the point 3 dB below the plateau — and nothing else.

/** One SSMCS band. `kind` decides the filter outright; the device has no type slot. */
export interface SsmcsBandState {
  kind: "low" | "mid" | "high";
  on: boolean;
  freq: number;
  /** Displayed Q. Read for MID only — the two shelves have no Q parameter. */
  q: number;
  gain: number;
}

/** One SSMCS band's response in dB, or flat where it contributes nothing. */
function ssmcsBandResponse(b: SsmcsBandState, fs: number): (hz: number) => number {
  if (!b.on || b.gain === 0) return FLAT;
  if (b.kind === "mid") {
    const c = peakingCoefs(b.freq, b.q * SSMCS_Q_TO_BIQUAD, b.gain, fs);
    return (hz) => magDb(c, hz, fs);
  }
  const high = b.kind === "high";
  const c = shelfCoefs(shelfDesignFreq(b.freq, b.gain, high, fs), b.gain, high, fs);
  return (hz) => magDb(c, hz, fs);
}

/** The SSMCS strip's EQ response: its three bands summed in dB. */
export function ssmcsEqResponse(bands: readonly SsmcsBandState[], fs = EQ_RESPONSE_FS): (hz: number) => number {
  return sumDb(bands.map((b) => ssmcsBandResponse(b, fs)));
}
