// vd protocol value layer: address building and value encoding for the URX
// Device Center broker. This is the pure, device-independent backbone of live
// control — it turns plan-domain values (dB, pan -100..+100, on/off) into the
// integers the broker expects, and back. Transport (the WebSocket client) and
// the plan→command translation build on top of this. Language-agnostic.
//
// Encodings were established by reverse-engineering the broker's /vd/parameters
// and /vd/table responses (see reference/.local/vd-protocol.md):
//   level: signed int16 centi-dB (dB×100); -32768 is the -∞ (off) sentinel; max +1000 (+10 dB).
//   pan:   signed ±63 (L63 … C=0 … R63).
//   bool:  0 / 1.
// Parameter addresses are "{param_id}:{x}:{y}" where x is 0 except for EQ bands
// and y is the instance index (input ch 0..11, output 0..7, or a fixed slot).

import { LEVEL_MAX_DB, LEVEL_MIN_DB, LEVEL_OFF_DB } from "../plan";

/** The broker's -∞ / off sentinel for level (centi-dB) parameters. */
export const VD_LEVEL_OFF = -32768;
/** Highest level the device accepts: +10.00 dB. */
export const VD_LEVEL_MAX = 1000;
/** Pan extent on the device: ±63 (full L … full R). */
export const VD_PAN_MAX = 63;

// HA gain is one param (id 1) but its usable range depends on the input type:
// analog preamp channels (A.Gain) run -8 … +70 dB, digital channels (D.Gain)
// -24 … +24 dB. Encoded as centi-dB like level but with no -∞ sentinel.
export const A_GAIN_MIN_DB = -8;
export const A_GAIN_MAX_DB = 70;
export const D_GAIN_MIN_DB = -24;
export const D_GAIN_MAX_DB = 24;

/** Plan pan range, matching the inspector slider and the device scale L63 – C –
 *  R63 (1:1 with the broker ±63). */
export const PAN_MIN = -63;
export const PAN_MAX = 63;

// HPF cutoff frequency (param 26): broker value is Hz×10 (the 0.1 Hz unit shared
// with EQ frequency). Range 40 … 120 Hz, default 80 Hz, 20 Hz steps — i.e. the
// five detents 40/60/80/100/120 Hz (confirmed by live scan: broker 400 … 1200).
export const HPF_FREQ_MIN_HZ = 40;
export const HPF_FREQ_MAX_HZ = 120;
export const HPF_FREQ_STEP_HZ = 20;
export const HPF_FREQ_DEFAULT_HZ = 80;

// Output 4-band parametric EQ band values (verified on STEREO/MIX by live scan):
//   freq: Hz×10 (the 0.1 Hz unit), 20 Hz … 20 kHz (broker 200 … 200000).
//   Q:    ×100, 0.50 … 16.00 (broker 50 … 1600).
//   gain: centi-dB, -18 … +18 dB (broker -1800 … 1800).
export const EQ_FREQ_MIN_HZ = 20;
export const EQ_FREQ_MAX_HZ = 20000;
export const EQ_Q_MIN = 0.5;
export const EQ_Q_MAX = 16;
export const EQ_GAIN_MIN_DB = -18;
export const EQ_GAIN_MAX_DB = 18;

// Input GATE / COMP detail values (mono, COMP->EQ comp bank; verified by live
// scan). Plan units → broker units:
//   centi-dB  (threshold / range / makeup gain): dB×100.
//   attack    : ms×1000 (µs), broker 92 … 80000  → 0.092 … 80 ms.
//   hold      : ms×100,        broker 2  … 196000 → 0.02 … 1960 ms.
//   release   : ms×10,         broker 93 … 9990   → 9.3 … 999 ms (gate decay too).
//   ratio     : ratio×100,     broker 100 … 65535 → 1.0 … 655.35 : 1.
export const DYN_ATTACK_MIN_MS = 0.092;
export const DYN_ATTACK_MAX_MS = 80;
export const DYN_HOLD_MIN_MS = 0.02;
export const DYN_HOLD_MAX_MS = 1960;
export const DYN_RELEASE_MIN_MS = 9.3;
export const DYN_RELEASE_MAX_MS = 999;
export const DYN_RATIO_MIN = 1;
export const DYN_RATIO_MAX = 655.35;
// Ducker decay shares the ×10 release scale but with a wider range than gate/comp.
export const DUCKER_DECAY_MIN_MS = 1.3;
export const DUCKER_DECAY_MAX_MS = 5000;

// STREAMING DELAY time (param 708): broker value is ms×100 (centi-ms). Range
// 100 … 100000 = 1.00 … 1000.00 ms, default 100 (= 1.00 ms), 0.01 ms resolution
// (confirmed by live snapshot-diff: ms 100.0 on the LCD reads back as 10000).
export const DELAY_TIME_MIN_MS = 1;
export const DELAY_TIME_MAX_MS = 1000;

// PHONES output level (param 725, y0 = PHONES 1, y1 = PHONES 2). The device shows
// a unit-less 0.0 … 10.0 volume scale (NOT dB — distinct from the monitor fader);
// broker value is that scale ×10 (raw 0 … 100), default 20 (= 2.0). Confirmed by
// live snapshot-diff: 10.0 on the LCD reads back as 100, 0.0 as 0.
export const PHONES_LEVEL_MIN = 0;
export const PHONES_LEVEL_MAX = 10;
export const PHONES_LEVEL_DEFAULT = 2;

function clamp(v: number, lo: number, hi: number): number {
  // NaN comparisons are all false, so trap it explicitly to the low bound — a NaN
  // reaching vdSet would serialize to null (a malformed broker write).
  if (Number.isNaN(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/** Plan PHONES level (0.0 … 10.0 scale) → broker raw (×10). */
export function phonesLevelToVd(value: number): number {
  return clamp(Math.round(value * 10), PHONES_LEVEL_MIN * 10, PHONES_LEVEL_MAX * 10);
}

/** Broker raw (0 … 100) → plan PHONES level (0.0 … 10.0). */
export function vdToPhonesLevel(value: number): number {
  return clamp(value / 10, PHONES_LEVEL_MIN, PHONES_LEVEL_MAX);
}

/** Plan OSC Burst width (seconds 0.1 … 10) → broker raw ms (= seconds ×1000). */
export function burstWidthToVd(sec: number): number {
  return clamp(Math.round(sec * 1000), 100, 10000);
}

/** Broker raw ms (100 … 10000) → plan OSC Burst width (seconds 0.1 … 10). */
export function vdToBurstWidth(raw: number): number {
  return clamp(raw / 1000, 0.1, 10);
}

/** Plan delay time (ms) → broker ms×100. */
export function delayTimeToVd(ms: number): number {
  return clamp(Math.round(ms * 100), DELAY_TIME_MIN_MS * 100, DELAY_TIME_MAX_MS * 100);
}

/** Broker ms×100 → plan delay time (ms). */
export function vdToDelayTime(value: number): number {
  return clamp(value / 100, DELAY_TIME_MIN_MS, DELAY_TIME_MAX_MS);
}

// SSMCS (Sweet Spot Morphing Channel Strip) RAW broker ranges and display curves.
// Values are stored raw in the plan; these turn a raw integer into the human unit
// the device LCD shows. Curves were established by live LCD calibration (anchor
// points in reference/.local/ssmcs-spec.md). The shared EQ/SC curves:
//   freq: 20 × 10^((raw-4)/40)  (= 20 × 2^((raw-4)/12), 1/12-oct, 4=20 Hz..124=20 kHz)
//   Q:    0.5 × 32^(raw/60)     (0=0.50 .. 60=16.0, logarithmic)
//   gain: (raw-180)/10 dB       (0..360, 180 = 0 dB, ±18 dB)
export const SSMCS_COMP_DRIVE_MIN = 0;
export const SSMCS_COMP_DRIVE_MAX = 200;
export const SSMCS_MORPHING_MIN = 0;
export const SSMCS_MORPHING_MAX = 120;
export const SSMCS_GAIN_MIN = 0; // raw; 180 = 0 dB
export const SSMCS_GAIN_MAX = 360;
export const SSMCS_ATTACK_RAW_MIN = 57;
export const SSMCS_ATTACK_RAW_MAX = 283;
export const SSMCS_RELEASE_RAW_MIN = 24;
export const SSMCS_RELEASE_RAW_MAX = 300;
export const SSMCS_RATIO_RAW_MIN = 0;
export const SSMCS_RATIO_RAW_MAX = 120;
export const SSMCS_Q_RAW_MIN = 0;
export const SSMCS_Q_RAW_MAX = 60;
export const SSMCS_FREQ_RAW_MIN = 4;
export const SSMCS_FREQ_RAW_MAX = 124;
// Comp threshold/makeup are device-internal raw values (not shown on the LCD).
export const SSMCS_COMP_INTERNAL_MIN = 0;
export const SSMCS_COMP_INTERNAL_MAX = 200;
// Per-band frequency sub-ranges (Low caps low, High floors high; Mid spans all).
export const SSMCS_EQ_LOW_FREQ_RAW_MAX = 72;
export const SSMCS_EQ_HIGH_FREQ_RAW_MIN = 60;

/** SSMCS Sweet Spot Data preset count (6 generic + 28 artist). */
export const SWEET_SPOT_DATA_MAX = 34;
/** SSMCS Sweet Spot Data preset index (1 … 34) → the device's 4-digit zero-padded
 *  string ("0001" … "0034"). Out-of-range clamps into [1, 34] (the device clamps
 *  "0035"+ to "0001"; we instead keep a valid in-range index). */
export function sweetSpotDataToStr(index: number): string {
  // Math.round(NaN) survives the min/max clamp as NaN → "0NaN"; coerce it to 0 so
  // the [1, 34] clamp still yields a valid four-digit preset string.
  const raw = Number.isNaN(index) ? 0 : Math.round(index);
  const n = Math.min(SWEET_SPOT_DATA_MAX, Math.max(1, raw));
  return String(n).padStart(4, "0");
}
/** Device Sweet Spot Data string ("0001" …) → preset index (1 … 34). A blank or
 *  unparseable value falls back to 1 ("01 Basic", the factory default). */
export function strToSweetSpotData(value: string): number {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(SWEET_SPOT_DATA_MAX, n);
}

/** SSMCS Comp Drive raw → display (0.00 … 10.00). */
export function ssmcsCompDrive(raw: number): number {
  return raw / 20;
}
/** SSMCS comp attack raw → ms (logarithmic 0.092 … 80 ms). */
export function ssmcsAttackMs(raw: number): number {
  return 0.092 * Math.pow(80 / 0.092, (raw - SSMCS_ATTACK_RAW_MIN) / 226);
}
/** SSMCS comp release raw → ms (logarithmic 9.3 … 999 ms). */
export function ssmcsReleaseMs(raw: number): number {
  return 9.3 * Math.pow(999 / 9.3, (raw - SSMCS_RELEASE_RAW_MIN) / 276);
}
/** SSMCS EQ/SC Q raw → value (logarithmic 0.50 … 16.0). */
export function ssmcsQ(raw: number): number {
  return 0.5 * Math.pow(32, raw / 60);
}
/** SSMCS EQ/SC frequency raw → Hz (1/12-oct, 20 Hz … 20 kHz). */
export function ssmcsFreqHz(raw: number): number {
  return 20 * Math.pow(10, (raw - SSMCS_FREQ_RAW_MIN) / 40);
}
/** SSMCS EQ/SC/Out gain raw → dB (±18, 180 = 0 dB). */
export function ssmcsGainDb(raw: number): number {
  return (raw - 180) / 10;
}
// Ratio is a non-linear table (no closed form). Linear-interpolate between the
// calibrated anchors; the top detent is ∞:1.
const SSMCS_RATIO_ANCHORS: [number, number][] = [
  [0, 1.0],
  [30, 2.5],
  [60, 4.0],
  [75, 6.0],
  [90, 14.0],
  [105, 38.0],
];
/** SSMCS comp ratio raw → N:1 (Infinity at the top of the range). */
export function ssmcsRatio(raw: number): number {
  if (raw >= SSMCS_RATIO_RAW_MAX) return Infinity;
  let lo = SSMCS_RATIO_ANCHORS[0];
  let hi = SSMCS_RATIO_ANCHORS[SSMCS_RATIO_ANCHORS.length - 1];
  for (let i = 0; i < SSMCS_RATIO_ANCHORS.length - 1; i++) {
    if (raw >= SSMCS_RATIO_ANCHORS[i][0] && raw <= SSMCS_RATIO_ANCHORS[i + 1][0]) {
      lo = SSMCS_RATIO_ANCHORS[i];
      hi = SSMCS_RATIO_ANCHORS[i + 1];
      break;
    }
  }
  if (raw > hi[0]) return hi[1]; // between last anchor (105) and 120
  const span = hi[0] - lo[0];
  return span === 0 ? lo[1] : lo[1] + ((raw - lo[0]) * (hi[1] - lo[1])) / span;
}

/**
 * Plan dB → broker centi-dB. Below the lowest real value (LEVEL_MIN_DB, -96) the
 * UI reads -∞ and maps to the device's off sentinel; everything else is dB×100,
 * clamped to the device floor / ceiling.
 */
export function levelToVd(db: number): number {
  if (db < LEVEL_MIN_DB) return VD_LEVEL_OFF;
  return clamp(Math.round(db * 100), LEVEL_MIN_DB * 100, VD_LEVEL_MAX);
}

/** Broker centi-dB → plan dB. The off sentinel maps back to the -∞ slider notch. */
export function vdToLevel(value: number): number {
  if (value <= VD_LEVEL_OFF) return LEVEL_OFF_DB;
  return clamp(value / 100, LEVEL_MIN_DB, LEVEL_MAX_DB);
}

/** Plan pan (±63, L63 – C – R63) → broker ±63 — a 1:1 mapping, clamped. */
export function panToVd(pan: number): number {
  return clamp(Math.round(pan), -VD_PAN_MAX, VD_PAN_MAX);
}

/** Broker ±63 → plan pan (±63). */
export function vdToPan(value: number): number {
  return clamp(Math.round(value), PAN_MIN, PAN_MAX);
}

// HA gain converters clamp to the union of the analog/digital ranges; the UI
// slider enforces the tighter per-type bounds.
const GAIN_MIN_DB = D_GAIN_MIN_DB; // -24, the lower of the two
const GAIN_MAX_DB = A_GAIN_MAX_DB; // +70, the higher of the two

/** Plan HA gain dB → broker centi-dB (no -∞). */
export function gainToVd(db: number): number {
  return clamp(Math.round(db * 100), GAIN_MIN_DB * 100, GAIN_MAX_DB * 100);
}

// Broker centi-dB → plan HA gain dB. The round is a no-op for every value the
// device actually produces: a hardware readback (A.Gain / D.Gain across all
// channels) returned only whole-dB raws (multiples of 100), so the device's
// native gain resolution is whole dB and the round-trip is already a fixed point.
// It stays as defensive clamping of the broker's finer centi-dB unit to the plan
// grain, never observed to discard a real device value.
export function vdToGain(value: number): number {
  return clamp(Math.round(value / 100), GAIN_MIN_DB, GAIN_MAX_DB);
}

/** Plan HPF frequency (Hz) → broker 0.1 Hz units. */
export function freqToVd(hz: number): number {
  return clamp(Math.round(hz * 10), HPF_FREQ_MIN_HZ * 10, HPF_FREQ_MAX_HZ * 10);
}

// Broker 0.1 Hz units → plan HPF frequency (Hz). Like vdToGain/vdToEqFreq, the
// round is a no-op for real device values: hardware readback returned only
// whole-Hz raws (multiples of 10), so the device's native frequency resolution is
// whole Hz despite the broker's 0.1 Hz unit. Defensive, never observed to lose a value.
export function vdToFreq(value: number): number {
  return clamp(Math.round(value / 10), HPF_FREQ_MIN_HZ, HPF_FREQ_MAX_HZ);
}

/** Plan EQ band frequency (Hz) → broker 0.1 Hz units (20 Hz … 20 kHz). */
export function eqFreqToVd(hz: number): number {
  return clamp(Math.round(hz * 10), EQ_FREQ_MIN_HZ * 10, EQ_FREQ_MAX_HZ * 10);
}

// Broker 0.1 Hz units → plan EQ band frequency (Hz). The round is a no-op for
// real device values: a hardware readback of every EQ band (including fine grid
// points like 112 / 1180 / 2360 Hz) returned only whole-Hz raws (multiples of
// 10), so the device's native EQ-frequency resolution is whole Hz and the
// round-trip is already a fixed point. Defensive clamping of the broker's finer
// 0.1 Hz unit, never observed to discard a real device value.
export function vdToEqFreq(value: number): number {
  return clamp(Math.round(value / 10), EQ_FREQ_MIN_HZ, EQ_FREQ_MAX_HZ);
}

/** Plan EQ Q (0.50 … 16.00) → broker ×100. */
export function qToVd(q: number): number {
  return clamp(Math.round(q * 100), EQ_Q_MIN * 100, EQ_Q_MAX * 100);
}

/** Broker ×100 → plan EQ Q (0.50 … 16.00). */
export function vdToQ(value: number): number {
  return clamp(value / 100, EQ_Q_MIN, EQ_Q_MAX);
}

/** Plan EQ band gain (dB, ±18) → broker centi-dB. */
export function eqGainToVd(db: number): number {
  return clamp(Math.round(db * 100), EQ_GAIN_MIN_DB * 100, EQ_GAIN_MAX_DB * 100);
}

/** Broker centi-dB → plan EQ band gain (dB, ±18). */
export function vdToEqGain(value: number): number {
  return clamp(value / 100, EQ_GAIN_MIN_DB, EQ_GAIN_MAX_DB);
}

/** Plan dB → broker centi-dB (GATE/COMP threshold, range, makeup gain). */
export function centiDbToVd(db: number): number {
  return clamp(Math.round(db * 100), -32768, 32767);
}

/** Broker centi-dB → plan dB. */
export function vdToCentiDb(value: number): number {
  return value / 100;
}

/**
 * GATE range (param 30). Unlike the other centi-dB dynamics fields, the broker's
 * `range` display table has a -INF step below its -72 dB floor, encoded as the
 * same int16 -∞ sentinel as level params. `GATE_RANGE_OFF_DB` is the plan-domain
 * notch one step below the -72 dB floor that stands for that -∞.
 */
export const GATE_RANGE_OFF_DB = -73;

/** Plan dB → broker centi-dB for GATE range: the -∞ notch maps to the off sentinel. */
export function gateRangeToVd(db: number): number {
  if (db <= GATE_RANGE_OFF_DB) return VD_LEVEL_OFF;
  return clamp(Math.round(db * 100), -7200, 0);
}

/** Broker centi-dB → plan dB for GATE range: anything below the -72 dB floor is -∞. */
export function vdToGateRange(value: number): number {
  if (value < -7200) return GATE_RANGE_OFF_DB;
  return clamp(value / 100, -72, 0);
}

/** Plan attack time (ms) → broker µs (×1000). */
export function attackToVd(ms: number): number {
  return clamp(Math.round(ms * 1000), DYN_ATTACK_MIN_MS * 1000, DYN_ATTACK_MAX_MS * 1000);
}

/** Broker µs → plan attack time (ms). */
export function vdToAttack(value: number): number {
  return value / 1000;
}

/** Plan hold time (ms) → broker ×100. */
export function holdToVd(ms: number): number {
  return clamp(Math.round(ms * 100), DYN_HOLD_MIN_MS * 100, DYN_HOLD_MAX_MS * 100);
}

/** Broker ×100 → plan hold time (ms). */
export function vdToHold(value: number): number {
  return value / 100;
}

/**
 * Plan release/decay time (ms) → broker ×10. Clamped to the widest consumer of
 * this scale (the ducker decay); gate/comp get their tighter plan ranges
 * (DYN_RELEASE_MIN/MAX_MS) clamped upstream in pushDynCommands via their DynField
 * bounds before reaching this encoder.
 */
export function releaseToVd(ms: number): number {
  return clamp(Math.round(ms * 10), DUCKER_DECAY_MIN_MS * 10, DUCKER_DECAY_MAX_MS * 10);
}

/** Broker ×10 → plan release/decay time (ms). */
export function vdToRelease(value: number): number {
  return value / 10;
}

/** Plan compressor ratio (N:1) → broker ×100. */
export function ratioToVd(ratio: number): number {
  return clamp(Math.round(ratio * 100), DYN_RATIO_MIN * 100, DYN_RATIO_MAX * 100);
}

/** Broker ×100 → plan compressor ratio (N:1). */
export function vdToRatio(value: number): number {
  return value / 100;
}

/** On/off → broker 0/1. */
export function boolToVd(on: boolean): number {
  return on ? 1 : 0;
}

/** Broker value → on/off (a finite non-zero is on; a non-finite raw reads off). */
export function vdToBool(value: number): boolean {
  return Number.isFinite(value) && value !== 0;
}

// Routing-source port refs. The streaming-source selector stores the port with a
// high tag bit set (0x80000000 | port); the USB-output selectors store it raw.
// `NONE` is the uint32 sentinel used when nothing is selected.
const PORT_REF_TAG = 0x80000000;
/** uint32 sentinel a selector holds when nothing is selected. Tagging it (high
 *  bit) leaves it unchanged, so emitting it clears either a raw or tagged selector. */
export const PORT_REF_NONE = 0xffffffff;

/** Port id → tagged broker value (high bit set). */
export function tagPortRef(port: number): number {
  return (PORT_REF_TAG | port) >>> 0;
}

/** Broker value → port id, stripping the tag bit if present. null = nothing selected. */
export function vdToPortRef(value: number): number | null {
  if (value === PORT_REF_NONE) return null;
  return value & PORT_REF_TAG ? value & 0x7fffffff : value;
}

/** Build a parameter address "{param_id}:{x}:{y}". x is 0 outside EQ bands. */
export function vdAddr(paramId: number, y: number, x = 0): string {
  return `${paramId}:${x}:${y}`;
}

/** A single value-set request: the broker REST-style uri plus its payload. */
export interface VdSetRequest {
  uri: string;
  data: { current_value: number };
}

/** Build a value-set request for a parameter instance. */
export function vdSet(paramId: number, y: number, value: number, x = 0): VdSetRequest {
  return {
    uri: `/vd/parameters/${vdAddr(paramId, y, x)}?operation=value`,
    data: { current_value: value },
  };
}
