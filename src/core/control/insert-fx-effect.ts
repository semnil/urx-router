// Insert-FX effect catalog: the per-effect parameter layout for the channel /
// output INSERT effects (Guitar Amp Classics, Pitch Fix, Compander-H/S,
// Multi-Band Compressor). Like the FX-channel effects (see fx-effect.ts), these
// do NOT live at fixed param_ids — the device packs each effect's parameters into
// ONE "engine" array param addressed by a SLOT on the y axis, and a pointer param
// names which engine the selected effect was bound to. This module isolates that
// addressing plus the raw↔display encodings (all established by live LCD
// calibration on a factory URX44V; see reference/.local/.../insert-fx-calib).
//
// Plan storage keeps RAW broker integers keyed by engine SLOT (insertFxParams on
// the node), so a captured plan round-trips and the inspector edits raw with a
// display-only formatter. The selector binds the engine and populates per-type
// defaults; urx-router only writes the slots the plan explicitly carries.

// Engine array param_id each effect family binds (confirmed by the live pointer
// read; the selector/enable/pointer params themselves live in params.ts).
export const ENGINE_GUITAR = 697;
export const ENGINE_PITCH = 701;
export const ENGINE_COMPANDER_INPUT = 689;
export const ENGINE_OUTPUT = 693; // MBC + output compander share this engine

// ---- effect families ----

export type InsertFxFamily =
  "guitar-clean" | "guitar-crunch" | "guitar-lead" | "guitar-drive" | "pitch" | "compander" | "mbc";

/** Map an insert-FX selector enum value to its effect family (engine resolved by
 *  insertFxEngine, since the compander binds a different engine on input vs output). */
export function insertFxFamilyOf(selectorValue: number): { family: InsertFxFamily } | null {
  switch (selectorValue) {
    case 256:
      return { family: "guitar-clean" };
    case 257:
      return { family: "guitar-crunch" };
    case 258:
      return { family: "guitar-lead" };
    case 259:
      return { family: "guitar-drive" };
    case 512:
      return { family: "pitch" };
    case 1793:
    case 1794:
      return { family: "compander" };
    case 1792:
      return { family: "mbc" };
    default:
      return null;
  }
}

/** Engine array param_id the family binds. The compander uses a different engine
 *  on an output bus (693) than on an input channel (689); guitar/pitch are input
 *  only, MBC output only. */
export function insertFxEngine(family: InsertFxFamily, isOutput: boolean): number {
  switch (family) {
    case "guitar-clean":
    case "guitar-crunch":
    case "guitar-lead":
    case "guitar-drive":
      return ENGINE_GUITAR;
    case "pitch":
      return ENGINE_PITCH;
    case "mbc":
      return ENGINE_OUTPUT;
    case "compander":
      return isOutput ? ENGINE_OUTPUT : ENGINE_COMPANDER_INPUT;
  }
}

// ---- raw → display encodings (live-calibrated) ----

/** 0..10 knob stored ×10 (raw 0..100): Treble/Bass/Volume/Gain/Blend/etc. */
const tenthDisplay = (raw: number): string => (raw / 10).toFixed(1);
/** MBC band Threshold: raw = dB + 127 (range -54..-6 dB → raw 73..121). */
const mbcThresholdDb = (raw: number): number => raw - 127;
// MBC band Gain taper (live-read): raw 0 = -∞, raw 1 = -60 dB, then a steep
// segment up to raw 20 = -17 dB, above which it is linear dB = raw - 37
// (confirmed raw 20/-17, 39/+2, 47/+10, 55/+18). raw 1..19 is the deep-
// attenuation region (sparse anchors → linear approximation).
function mbcGainDb(raw: number): number {
  if (raw <= 0) return -Infinity;
  if (raw >= 20) return raw - 37;
  return -60 + ((raw - 1) * (-17 - -60)) / (20 - 1);
}
/** MBC band Gain display ("-∞ dB" / "+2 dB"). */
function mbcGainLabel(raw: number): string {
  const db = mbcGainDb(raw);
  return db === -Infinity ? "-∞ dB" : `${Math.round(db)} dB`;
}
// MBC crossover frequency table: the ISO/IEC R40 (Renard) preferred-number
// series, shared by L-M and M-H XOVER (they differ only in valid raw range). Full
// L-M sweep read on the device confirmed the exact rounded values (125 not the
// 127 a pure 1/12-oct formula gives). raw is the R40 sequence index with raw 0 =
// 15 Hz, raw 6 = 21.2 Hz; freq = R40[(raw+47) mod 40] × 10^floor((raw+47)/40).
const R40_MANTISSA = [
  1.0, 1.06, 1.12, 1.18, 1.25, 1.32, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0, 2.12, 2.24, 2.36, 2.5, 2.65, 2.8, 3.0, 3.15,
  3.35, 3.55, 3.75, 4.0, 4.25, 4.5, 4.75, 5.0, 5.3, 5.6, 6.0, 6.3, 6.7, 7.1, 7.5, 8.0, 8.5, 9.0, 9.5,
];
/** MBC crossover raw → Hz (exact R40 table; raw 0 = 15 Hz). */
export function mbcXoverHz(raw: number): number {
  const g = raw + 47;
  return R40_MANTISSA[((g % 40) + 40) % 40] * Math.pow(10, Math.floor(g / 40));
}
/** MBC crossover display matching the device ("21.2 Hz" / "125 Hz" / "3.35 kHz"). */
export function mbcXoverLabel(raw: number): string {
  const f = mbcXoverHz(raw);
  if (f >= 1000) return `${(f / 1000).toFixed(2)} kHz`;
  return Number.isInteger(f) ? `${f} Hz` : `${f.toFixed(1)} Hz`;
}
/** Valid raw range per crossover (R40 indices): L-M 21.2 Hz..4 kHz, M-H 42.5 Hz..8 kHz. */
export const MBC_XOVER_LM_RANGE = { min: 6, max: 97 } as const;
export const MBC_XOVER_MH_RANGE = { min: 18, max: 109 } as const;

// Guitar Amp Output level (slot 14, 128-step taper, raw 0 = -∞ … raw 127 = 0 dB).
// Live-read anchors; piecewise-linear between them (the device taper is smooth).
const GUITAR_OUTPUT_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [8, -48.0],
  [20, -32.1],
  [40, -20.1],
  [64, -11.9],
  [96, -4.9],
  [127, 0],
];
/** Guitar Amp Output raw → dB (-∞ at raw 0). */
function guitarOutputDb(raw: number): number {
  if (raw <= 0) return -Infinity;
  const a = GUITAR_OUTPUT_ANCHORS;
  const seg = (x0: number, y0: number, x1: number, y1: number) => y0 + ((y1 - y0) / (x1 - x0)) * (raw - x0);
  if (raw <= a[0][0]) return seg(a[0][0], a[0][1], a[1][0], a[1][1]); // extrapolate below the lowest anchor
  for (let i = 1; i < a.length; i++) if (raw <= a[i][0]) return seg(a[i - 1][0], a[i - 1][1], a[i][0], a[i][1]);
  return a[a.length - 1][1];
}
/** Guitar Amp Output display ("-∞ dB" / "-4.9 dB"). */
function guitarOutputLabel(raw: number): string {
  const db = guitarOutputDb(raw);
  return db === -Infinity ? "-∞ dB" : `${db.toFixed(1)} dB`;
}

// MBC index tables (raw = 0-based index into the list). Live-read full sweeps.
const MBC_RATIO_STEPS = [1.0, 1.5, 2.0, 3.0, 5.0, 7.0, 10.0, 20.0];
const MBC_ATTACK_MS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 23, 26, 30, 35, 40, 50, 60, 70, 80, 100, 120, 140, 160, 180, 200,
];
export const MBC_RELEASE_MS = [
  10, 15, 25, 35, 45, 55, 65, 75, 85, 100, 115, 140, 170, 230, 340, 680, 850, 1000, 1200, 1500, 1700, 2000, 2400, 3000,
];

// Twelve semitone names, the single source for the Key select, Pitch note row,
// and MIDI note naming.
export const SEMITONE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** MIDI note number → name (C-2..G8, Yamaha numbering: C-2 = 0, C3 = 60). */
export function midiNoteName(note: number): string {
  return `${SEMITONE_NAMES[note % 12]}${Math.floor(note / 12) - 2}`;
}

// Guitar Amp SP TYPE (cabinet). raw is 1-BASED (raw 0 is invalid); the list order
// matches the device dropdown / block-diagram order.
const GUITAR_SP_TYPES = [
  { value: 1, label: "BS 4x12" },
  { value: 2, label: "AC 2x12" },
  { value: 3, label: "AC 1x12" },
  { value: 4, label: "AC 4x10" },
  { value: 5, label: "BC 2x12" },
  { value: 6, label: "AM 4x12" },
  { value: 7, label: "YC 4x12" },
  { value: 8, label: "JC 2x12" },
];
/** Guitar Amp Drive "Amp Type" (slot 6, Drive only). */
const GUITAR_AMP_TYPES = [
  { value: 0, label: "Raw1" },
  { value: 1, label: "Raw2" },
  { value: 2, label: "Vintage1" },
  { value: 3, label: "Vintage2" },
  { value: 4, label: "Modern1" },
  { value: 5, label: "Modern2" },
];
const GUITAR_MIC_POSITION = [
  { value: 0, label: "Center" },
  { value: 1, label: "Edge" },
];
const GUITAR_CLEAN_MOD = [
  { value: 0, label: "Cho" },
  { value: 1, label: "Off" },
  { value: 2, label: "Vib" },
];
const GUITAR_CRUNCH_CHAR = [
  { value: 0, label: "Normal" },
  { value: 1, label: "Bright" },
];
const GUITAR_LEAD_CHAR = [
  { value: 0, label: "High" },
  { value: 1, label: "Low" },
];

// Pitch Fix slots. Key (15) is a semitone; Scale (16) is a preset label, with the
// 12 note on/off toggles (22..33) the editable ground truth (Chromatic = all on;
// editing any note shows "Custom"). MIDI Control packs two bits across 34/35:
// Off (0,0) / Setting (1,0) / Real Time (1,1).
const PITCH_KEYS = SEMITONE_NAMES.map((label, value) => ({ value, label }));
export const PITCH_SCALE_SLOT = 16;
export const PITCH_SCALE_CUSTOM = 0;
export const PITCH_SCALE_MAJOR = 2;
export const PITCH_SCALE_CHROMATIC = 7;
/** Note-keyboard array slots (12 semitones from the Key root). */
export const PITCH_NOTE_SLOTS = [22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33];
/** MIDI Control: enable bit (slot 34) + realtime bit (slot 35). */
export const PITCH_MIDI_ENABLE_SLOT = 34;
export const PITCH_MIDI_REALTIME_SLOT = 35;

// ---- per-effect parameter descriptors ----

export interface InsertFxParamDesc {
  /** Engine array slot. Some params mirror onto a second slot (see `mirror`). */
  slot: number;
  /** Optional second slot written with the same raw (Pitch Coarse/Fine/Formant). */
  mirror?: number;
  /** i18n label key, resolved by the inspector. */
  label: string;
  control: "slider" | "toggle" | "select";
  rawMin?: number;
  rawMax?: number;
  rawStep?: number;
  /** Factory default raw — the inspector's absent-value fallback for display. */
  def: number;
  /** Display formatter for a raw value (slider/select). */
  format?: (raw: number) => string;
  /** Option list for a select control (value = raw). */
  options?: { value: number; label: string }[];
}

// Compander-H / Compander-S (engine 689 input / 693 output). Encodings match the
// dedicated COMP path (centi-dB / ratio×100 / attack µs / release ms×10).
const COMPANDER_PARAMS: InsertFxParamDesc[] = [
  {
    slot: 6,
    label: "threshold",
    control: "slider",
    rawMin: -5400,
    rawMax: 0,
    rawStep: 10,
    def: -1000,
    format: (r) => `${(r / 100).toFixed(1)} dB`,
  },
  {
    slot: 7,
    label: "ratio",
    control: "slider",
    rawMin: 100,
    rawMax: 2000,
    rawStep: 10,
    def: 350,
    format: (r) => `${(r / 100).toFixed(1)}:1`,
  },
  {
    slot: 8,
    label: "attack",
    control: "slider",
    rawMin: 0,
    rawMax: 120000,
    rawStep: 1000,
    def: 1000,
    format: (r) => `${Math.round(r / 1000)} ms`,
  },
  {
    slot: 9,
    label: "release",
    control: "slider",
    rawMin: 50,
    rawMax: 423000,
    rawStep: 10,
    def: 2290,
    format: (r) => (r >= 10000 ? `${(r / 10000).toFixed(2)} s` : `${Math.round(r / 10)} ms`),
  },
  {
    slot: 10,
    label: "outGain",
    control: "slider",
    rawMin: -1800,
    rawMax: 0,
    rawStep: 10,
    def: 0,
    format: (r) => `${(r / 100).toFixed(1)} dB`,
  },
  {
    slot: 11,
    label: "width",
    control: "slider",
    rawMin: 100,
    rawMax: 9000,
    rawStep: 10,
    def: 600,
    format: (r) => `${Math.round(r / 100)} dB`,
  },
];

// Multi-Band Compressor (engine 693, output only). Per-band Attack/Threshold/
// Ratio/Gain at stride 5 (LOW 8-11, MID 13-16, HIGH 18-21); Bypass/Release/Out
// Gain/XOVER/1-knob are global single slots. Attack/Ratio/Release are index
// tables; Threshold/Gain/Out Gain are linear dB offsets.
export type MbcBandKey = "attack" | "threshold" | "ratio" | "gain";
export const MBC_BANDS: Array<{ band: "low" | "mid" | "high" } & Record<MbcBandKey, number>> = [
  { band: "low", attack: 8, threshold: 9, ratio: 10, gain: 11 },
  { band: "mid", attack: 13, threshold: 14, ratio: 15, gain: 16 },
  { band: "high", attack: 18, threshold: 19, ratio: 20, gain: 21 },
];
export const MBC_GLOBAL = {
  oneKnobOn: 6, // bool
  oneKnobLevel: 7, // raw 0..48
  bypass: 17, // bool
  xoverLowMid: 23, // freq table
  xoverMidHigh: 24, // freq table
  release: 25, // MBC_RELEASE_MS index
  outGain: 26, // raw = dB + 64
} as const;
/** Per-band raw bounds + formatters (shared by all three bands). */
export const MBC_BAND_PARAM: Record<
  MbcBandKey,
  { rawMin: number; rawMax: number; def: number; format: (r: number) => string }
> = {
  attack: { rawMin: 0, rawMax: MBC_ATTACK_MS.length - 1, def: 17, format: (r) => `${MBC_ATTACK_MS[r] ?? "?"} ms` },
  threshold: { rawMin: 73, rawMax: 121, def: 107, format: (r) => `${mbcThresholdDb(r)} dB` },
  ratio: {
    rawMin: 0,
    rawMax: MBC_RATIO_STEPS.length - 1,
    def: 2,
    format: (r) => `${(MBC_RATIO_STEPS[r] ?? 0).toFixed(1)}:1`,
  },
  gain: { rawMin: 0, rawMax: 55, def: 39, format: mbcGainLabel },
};
/** MBC Out Gain raw → display ("+4 dB"). raw = dB + 64. */
export const mbcOutGainLabel = (raw: number): string => `${raw - 64} dB`;

// Pitch Fix (engine 701).
const PITCH_PARAMS: InsertFxParamDesc[] = [
  {
    slot: 6,
    mirror: 9,
    label: "coarse",
    control: "slider",
    rawMin: -12,
    rawMax: 12,
    rawStep: 1,
    def: 0,
    format: (r) => `${r > 0 ? "+" : ""}${r}`,
  },
  {
    slot: 7,
    mirror: 10,
    label: "fine",
    control: "slider",
    rawMin: -50,
    rawMax: 50,
    rawStep: 1,
    def: 0,
    format: (r) => `${r > 0 ? "+" : ""}${r}`,
  },
  {
    slot: 8,
    mirror: 11,
    label: "formant",
    control: "slider",
    rawMin: 2,
    rawMax: 126,
    rawStep: 1,
    def: 64,
    format: (r) => `${r - 64 > 0 ? "+" : ""}${r - 64}`,
  },
  { slot: 13, label: "correction", control: "toggle", def: 1 },
  { slot: 14, label: "mix", control: "slider", rawMin: 0, rawMax: 126, rawStep: 1, def: 126, format: (r) => String(r) },
  { slot: 15, label: "key", control: "select", def: 0, options: PITCH_KEYS },
  {
    slot: 18,
    label: "speed",
    control: "slider",
    rawMin: 0,
    rawMax: 100,
    rawStep: 1,
    def: 100,
    format: (r) => String(r),
  },
  {
    slot: 19,
    label: "tolerance",
    control: "slider",
    rawMin: 0,
    rawMax: 100,
    rawStep: 1,
    def: 50,
    format: (r) => String(r),
  },
  { slot: 20, label: "noteLow", control: "slider", rawMin: 0, rawMax: 127, rawStep: 1, def: 0, format: midiNoteName },
  {
    slot: 21,
    label: "noteHigh",
    control: "slider",
    rawMin: 0,
    rawMax: 127,
    rawStep: 1,
    def: 127,
    format: midiNoteName,
  },
];

// Guitar Amp Classics (engine 697). Common params shared by all four types, plus
// the type-specific slot 6 and the per-type extras.
const GUITAR_COMMON_PARAMS: InsertFxParamDesc[] = [
  { slot: 7, label: "gain", control: "slider", rawMin: 0, rawMax: 100, rawStep: 1, def: 50, format: tenthDisplay },
  { slot: 9, label: "bass", control: "slider", rawMin: 0, rawMax: 100, rawStep: 1, def: 50, format: tenthDisplay },
  { slot: 10, label: "middle", control: "slider", rawMin: 0, rawMax: 100, rawStep: 1, def: 50, format: tenthDisplay },
  { slot: 11, label: "treble", control: "slider", rawMin: 0, rawMax: 100, rawStep: 1, def: 50, format: tenthDisplay },
  { slot: 12, label: "presence", control: "slider", rawMin: 0, rawMax: 100, rawStep: 1, def: 50, format: tenthDisplay },
  {
    slot: 14,
    label: "output",
    control: "slider",
    rawMin: 0,
    rawMax: 127,
    rawStep: 1,
    def: 64,
    format: guitarOutputLabel,
  },
  { slot: 16, label: "spType", control: "select", def: 1, options: GUITAR_SP_TYPES },
  { slot: 18, label: "micPosition", control: "select", def: 0, options: GUITAR_MIC_POSITION },
  { slot: 24, label: "gate", control: "toggle", def: 0 },
  {
    slot: 25,
    label: "gateLevel",
    control: "slider",
    rawMin: 0,
    rawMax: 100,
    rawStep: 1,
    def: 20,
    format: tenthDisplay,
  },
];
/** Type-specific descriptors. slot 6 differs per type; Clean/Lead/Drive add more. */
function guitarTypeParams(family: InsertFxFamily): InsertFxParamDesc[] {
  switch (family) {
    case "guitar-clean":
      return [
        {
          slot: 6,
          label: "blend",
          control: "slider",
          rawMin: 0,
          rawMax: 100,
          rawStep: 1,
          def: 50,
          format: tenthDisplay,
        },
        {
          slot: 8,
          label: "distortion",
          control: "slider",
          rawMin: 0,
          rawMax: 100,
          rawStep: 1,
          def: 0,
          format: tenthDisplay,
        },
        { slot: 19, label: "mod", control: "select", def: 1, options: GUITAR_CLEAN_MOD },
        {
          slot: 20,
          label: "modSpeed",
          control: "slider",
          rawMin: 0,
          rawMax: 100,
          rawStep: 1,
          def: 50,
          format: tenthDisplay,
        },
        {
          slot: 21,
          label: "modDepth",
          control: "slider",
          rawMin: 0,
          rawMax: 100,
          rawStep: 1,
          def: 50,
          format: tenthDisplay,
        },
      ];
    case "guitar-crunch":
      return [{ slot: 6, label: "character", control: "select", def: 1, options: GUITAR_CRUNCH_CHAR }];
    case "guitar-lead":
      return [
        { slot: 6, label: "character", control: "select", def: 0, options: GUITAR_LEAD_CHAR },
        {
          slot: 13,
          label: "master",
          control: "slider",
          rawMin: 0,
          rawMax: 100,
          rawStep: 1,
          def: 50,
          format: tenthDisplay,
        },
      ];
    case "guitar-drive":
      return [
        { slot: 6, label: "ampType", control: "select", def: 3, options: GUITAR_AMP_TYPES },
        {
          slot: 13,
          label: "master",
          control: "slider",
          rawMin: 0,
          rawMax: 100,
          rawStep: 1,
          def: 50,
          format: tenthDisplay,
        },
      ];
    default:
      return [];
  }
}

// The descriptor / writable-slot lists are static per family, so memoize them: the
// per-node loop in planToCommands (every live-sync tick) and readback both ask for
// them repeatedly.
const PARAMS_CACHE = new Map<InsertFxFamily, InsertFxParamDesc[]>();
const SLOTS_CACHE = new Map<InsertFxFamily, InsertFxSlotSpec[]>();

/** Flat descriptor list for a family (guitar / compander / pitch). MBC uses the
 *  structured MBC_BANDS + MBC_GLOBAL layout instead. */
export function insertFxParams(family: InsertFxFamily): InsertFxParamDesc[] {
  let cached = PARAMS_CACHE.get(family);
  if (!cached) {
    cached =
      family === "compander"
        ? COMPANDER_PARAMS
        : family === "pitch"
          ? PITCH_PARAMS
          : family === "mbc"
            ? []
            : [...GUITAR_COMMON_PARAMS, ...guitarTypeParams(family)];
    PARAMS_CACHE.set(family, cached);
  }
  return cached;
}

// ---- writable-slot enumeration (translate / readback) ----
//
// Every engine array slot urx-router writes for a family, plus any mirror slot.
// Plan storage is a slot→raw map; translate only emits the slots the plan carries
// (absent slots keep the device's per-type default), and readback reads them all.
// slot0 (type) / slot1 (on) / slot2 (mix) are device-managed by the selector.

export interface InsertFxSlotSpec {
  slot: number;
  /** Second slot written with the same raw (Pitch Coarse/Fine/Formant). */
  mirror?: number;
}

export function insertFxWritableSlots(family: InsertFxFamily): InsertFxSlotSpec[] {
  let cached = SLOTS_CACHE.get(family);
  if (cached) return cached;
  if (family === "mbc") {
    const out: InsertFxSlotSpec[] = [];
    for (const b of MBC_BANDS) out.push({ slot: b.attack }, { slot: b.threshold }, { slot: b.ratio }, { slot: b.gain });
    for (const slot of Object.values(MBC_GLOBAL)) out.push({ slot });
    cached = out;
  } else {
    const out: InsertFxSlotSpec[] = insertFxParams(family).map((d) => ({ slot: d.slot, mirror: d.mirror }));
    if (family === "pitch") {
      out.push({ slot: PITCH_SCALE_SLOT });
      for (const slot of PITCH_NOTE_SLOTS) out.push({ slot });
      out.push({ slot: PITCH_MIDI_ENABLE_SLOT }, { slot: PITCH_MIDI_REALTIME_SLOT });
    }
    cached = out;
  }
  SLOTS_CACHE.set(family, cached);
  return cached;
}
