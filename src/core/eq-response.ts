// The 4-band PEQ's frequency response, as the unit actually implements it.
//
// The model holds on a mix bus, the STEREO master block and a stereo channel, to within
// the resolution of a difference between the two 1 dB-quantized peak meters that bracket
// the EQ (PRE EQ 105:0 → PRE FADER 122:0 on MIX 1). The filters are RBJ cookbook biquads
// with three corrections, and each one draws a visibly wrong curve without it:
//
//   peaking   The unit's Q is TWICE the biquad Q: a "Q 1.00" bell has the width of a
//             biquad Q of 0.5. Taking the number at face value draws every bell half
//             as wide as the device's.
//   HPF/LPF   Fixed 2nd-order Butterworth: -3.0 dB exactly at the nominal frequency and
//             12 dB/octave beyond. **The band's Q slot is ignored**, and there is no
//             resonant peak at the corner.
//   shelving  The S = 1 shape, but the unit's nominal frequency is the point 3 dB
//             below the plateau, not the midpoint: a +18 dB shelf at 1 kHz is at
//             +15 dB there and reaches +18 dB only well above it. So the design
//             frequency is solved for, and the search direction flips with the gain's
//             sign — reusing the boost direction for a cut misplaces it by several dB.
//             Under 6 dB of gain the solved frequency would sit inside the nominal
//             one; the unit designs such a shelf at its nominal frequency instead.
//
// Two further properties bound what this model is worth: bands sum in dB, to within the
// meters' own resolution, and the sample rate moves a high bell by at most 2 dB across
// 44.1 … 176.4 kHz — so the drawing is computed at 48 kHz whatever the plan's rate, and
// says so rather than pretending otherwise.
//
// The SSMCS strip's own 3-band EQ is at the foot of this file. It is a different DSP
// block reached by switching the channel's COMP/EQ type, and it shares no filter with
// this one: its shelves and its peaking Q are its own, and neither must be carried
// across.

import { EQ_TYPE_PASS, EQ_TYPE_SHELVING } from "./control/params";

/** The rate the response is drawn at. Rate dependence is ≤2 dB across the device's
 *  whole range, which is inside the meters' own resolution. */
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
  // The squared magnitudes, not `hypot`: their ratio carries the same dB and the largest
  // coefficient part here is ~59, so hypot's overflow guard buys nothing and only costs
  // time — in JSC as in V8, and JSC is the engine the macOS build renders in.
  const num = nRe * nRe + nIm * nIm;
  const den = dRe * dRe + dIm * dIm;
  if (den === 0 || num === 0) return 0;
  return 10 * Math.log10(num / den);
}

/** Displayed Q → biquad Q, per DSP block. Each belongs to its own block and neither
 *  may be used for the other: the 4-band PEQ's bell is half the width its number says.
 *  Kept adjacent to the SSMCS law below so the two are read together — carrying the
 *  4-band factor into SSMCS draws every bell at 0.5. */
const PEQ_Q_TO_BIQUAD = 0.5;

/**
 * The SSMCS strip's bell — ONE law for both of the places the strip puts one: the 3-band
 * EQ's MID band and the compressor's side-chain filter. They are the same filter, so a
 * second law here would be two answers to one question.
 *
 * The unit's Q is NOT the biquad Q times a constant — the bell narrows as the gain set on
 * it grows: the ratio of the biquad Q to the displayed one rises with the gain, symmetric
 * in the gain's sign, and independent of both the Q set (0.50 … 16.0) and the centre
 * frequency. One law in the gain covers every setting as closely as fitting each gain on
 * its own does.
 *
 * A sweep of the two meters alone can see the gain dependence but not prove it: both
 * meters quantize to 1 dB, and a 6 dB bell carries six steps of shape, so the quantizer's
 * phase alone moves the width such a sweep returns.
 *
 * A constant ratio taken from the width between the points 3 dB below the PEAK draws
 * every MID bell too narrow: a biquad's Q is the width at HALF THE GAIN, and for an 18 dB
 * bell the two differ by a factor of 2.78.
 */
const ssmcsBellQ = (displayedQ: number, gainDb: number): number =>
  0.238 * displayedQ * Math.pow(10, (Math.abs(gainDb) / 40) * 0.39);

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
  // Fixed Butterworth: the band's Q slot has no effect on a pass filter.
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
 * unit's own convention. Bisected on a log frequency axis; the direction the
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
  // walks the wrong bracket, which draws a shelf near such a multiple far outside the
  // model's 2 dB tolerance at its own nominal frequency.
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
  // (response_code 400), and the emit never sends one. The load drops a type a
  // document parks on one, and the plot ignores one a plan holds there anyway: honouring it
  // draws a 2nd-order high-pass for a band the device is running as a bell, which
  // contradicts the hardware by up to the band's full gain — the one thing this drawing
  // exists to not do.
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

/** The whole EQ's response: the bands summed in dB (which holds within the meters'
 *  resolution). */
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
// It shares no filter with the 4-band model above. Its shelves are first-order, with the
// half-gain point placed from the nominal frequency by a factor that depends on the gain,
// where the 4-band shelves are S = 1; its peaking Q is its own.

/** The factor an SSMCS shelf's half-gain point is placed by, in the bilinear transform's
 *  prewarped frequency: `scale · 10^(−exp · |gain| / 40)`, so it narrows as the gain grows. */
const SSMCS_SHELF_K_SCALE = 0.506;
const SSMCS_SHELF_K_GAIN_EXP = 0.335;

/** An SSMCS shelf's half-gain point as the bilinear transform's `K`: the nominal
 *  frequency's prewarped `tan(π f / fs)`, multiplied by the factor for HIGH and divided by
 *  it for LOW. */
function ssmcsShelfK(nominal: number, gainDb: number, high: boolean, fs: number): number {
  const factor = SSMCS_SHELF_K_SCALE * Math.pow(10, (-SSMCS_SHELF_K_GAIN_EXP * Math.abs(gainDb)) / 40);
  const k = Math.tan((Math.PI * nominal) / fs);
  return high ? k * factor : k / factor;
}

/** A first-order shelf through the bilinear transform, passing half its gain in dB where
 *  the prewarped frequency is `K`, and symmetric about it on a log axis — a cut is the
 *  exact inverse of a boost. */
function firstOrderShelfCoefs(K: number, gainDb: number, high: boolean): Coefs {
  const A = Math.pow(10, gainDb / 40);
  if (high) return { b0: A * (A + K), b1: A * (K - A), b2: 0, a0: 1 + A * K, a1: A * K - 1, a2: 0 };
  return { b0: A * (1 + A * K), b1: A * (A * K - 1), b2: 0, a0: A + K, a1: K - A, a2: 0 };
}

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
    const c = peakingCoefs(b.freq, ssmcsBellQ(b.q, b.gain), b.gain, fs);
    return (hz) => magDb(c, hz, fs);
  }
  const high = b.kind === "high";
  const c = firstOrderShelfCoefs(ssmcsShelfK(b.freq, b.gain, high, fs), b.gain, high);
  return (hz) => magDb(c, hz, fs);
}

/**
 * The SSMCS strip's EQ response: its three bands summed in dB.
 *
 * Out Gain is NOT here, and that is a decision rather than an omission. The unit applies
 * it after this block — stepping `117` between +18 and -18 dB moves tap `112` one-for-one
 * and leaves `108` and `111` alone, so the strip runs
 * `108 → compressor → 111 → 3-band EQ → Out Gain → 112` — but this plot's gain axis IS the
 * band gain range, so an offset of up to 18 dB pushes the response off the frame and takes
 * the shape the operator came for with it. It is drawn on the compressor's transfer curve
 * instead (`dyn-ssmcs.ts`), whose output axis has the room and where a lifted baseline is
 * what a strip output gain looks like.
 */
export function ssmcsEqResponse(bands: readonly SsmcsBandState[], fs = EQ_RESPONSE_FS): (hz: number) => number {
  return sumDb(bands.map((b) => ssmcsBandResponse(b, fs)));
}

// ---------------------------------------------------------------- SSMCS side chain
//
// The filter in front of the morphing strip's compressor — the one that decides what the
// compressor LISTENS to. It never touches the audio, which is why the screen that draws
// it says so rather than looking like another EQ.
//
// It is the same bell as the strip's MID band, in a different instance; meter `109`
// carries the filter's output.

/** The side-chain filter in plan units — Hz / displayed Q / dB, as the descriptor
 *  converts the broker's raw integers. One band, no type: the device offers a bell. */
export interface SsmcsScState {
  on: boolean;
  freq: number;
  q: number;
  gain: number;
}

/**
 * The side-chain filter's response in dB.
 *
 * Flat is a real state here and it arrives two ways: the filter switched out (`102` = 0),
 * and the filter engaged at 0 dB, which is an EXACT bypass. The screen tells the two apart
 * with its marker rather than with the curve, since neither has a curve to tell them apart
 * by.
 */
export function ssmcsScResponse(sc: SsmcsScState, fs = EQ_RESPONSE_FS): (hz: number) => number {
  // Through the BAND path rather than beside it: the two are the same filter, and a second
  // call to `peakingCoefs` here would let a correction made at coefficient time reach one
  // of them and not the other — silently, since the two are never drawn on one screen.
  return ssmcsBandResponse({ ...sc, kind: "mid" }, fs);
}
