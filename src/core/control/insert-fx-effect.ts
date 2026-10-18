// Insert-FX effect catalog: the per-effect parameter layout for the channel /
// output INSERT effects (Guitar Amp Classics, Pitch Fix, Compander-H/S,
// Multi-Band Compressor). Like the FX-channel effects (see fx-effect.ts), these
// do NOT live at fixed param_ids — the device packs each effect's parameters into
// ONE "engine" array param addressed by a SLOT on the y axis, and a pointer param
// names which engine the selected effect was bound to. This module isolates that
// addressing plus the raw↔display encodings (all established by live LCD
// calibration on a factory URX44V; see reference/work/device-tests/insert-fx-calib).
//
// Plan storage keeps RAW broker integers keyed by engine SLOT (insertFxParams on
// the node), so a captured plan round-trips and the inspector edits raw with a
// display-only formatter. The selector binds the engine and populates per-type
// defaults on the transition INTO a type; urx-router writes the slots the plan
// carries, and a selection and a load put every writable slot of the selected type
// in the plan at that type's default (`seedInsertFxParams`), so the plan holds what
// the screen shows.
//
// A SELECTOR WRITE IS NOT REVERSIBLE. Writing the selector makes the device fill
// the bound engine array with that type's defaults, and selecting the ORIGINAL type
// back only fills it with the original type's defaults — the values that were there
// are gone. Confirmed on a URX44V by round-tripping CH1 Compander-S -> H -> S, which
// left five slots (threshold / ratio / attack / gain / width) at the defaults.
// The same holds for the FX-channel effect type in fx-effect.ts.
//
// The engine array is a shared WORKING AREA, not storage: it is addressed by slot
// with no channel axis, and it still held the previous effect's values while the
// channel's selector read No Effect. So a selector write can overwrite settings
// belonging to whatever else uses the same engine.
//
// The user guide's Effect list gives each effect a "Number of simultaneous uses", and
// the compander's reads "MONO IN channels: 1 slot; output channels: 1 slot", with the
// Supported-channels row adding that it "cannot be inserted into two mono channels".
// That is the grounding for the 1-of slot rule in params.ts (InsertFxSlot) — it is a
// documented device constraint, not an app policy. Cited by section rather than page:
// the list moved from p.180 to p.184 between the C0 and D0 revisions. The control link
// does not enforce it: a second channel selecting the compander while another holds it
// is accepted, and both then point at the one array. What keeps the shared area
// consistent is the app's side — the 1-of menu (insertFxMenu), and collapseSharedAddrs
// in translate.ts, which sends one value per address whatever put two owners in a plan.
//
// planToCommands is safe here because it emits the selector and then immediately
// overwrites the array with the plan's own values, so the device ends up matching
// the plan either way. What is unsafe is writing a selector ALONE — a hand-issued
// vd_set or a diagnostic probe. Anything doing that must snapshot every slot first
// and write them all back explicitly; re-selecting the old type does not restore.

import { preferredNumber, R40 } from "./preferred-numbers";
import { boundRaw } from "./vd";

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
export function insertFxFamilyOf(selectorValue: number): InsertFxFamily | null {
  switch (selectorValue) {
    case 256:
      return "guitar-clean";
    case 257:
      return "guitar-crunch";
    case 258:
      return "guitar-lead";
    case 259:
      return "guitar-drive";
    case 512:
      return "pitch";
    case 1793:
    case 1794:
      return "compander";
    case 1792:
      return "mbc";
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
// MBC band Gain: raw 0 = -∞, then 3 dB per step from raw 1 = -60 dB to raw 13 = -24 dB,
// and 1 dB per step above it (dB = raw - 37, raw 55 = +18 dB). The two laws meet at raw 13.
function mbcGainDb(raw: number): number {
  if (raw <= 0) return -Infinity;
  if (raw >= 13) return raw - 37;
  return 3 * raw - 63;
}
/** MBC band Gain display ("-∞ dB" / "+2 dB"). */
function mbcGainLabel(raw: number): string {
  const db = mbcGainDb(raw);
  return db === -Infinity ? "-∞ dB" : `${Math.round(db)} dB`;
}
// MBC crossover frequency table: the same ISO 3 R40 series the FX channel filters step in,
// at the same offset, shared by L-M and M-H XOVER (they differ only in valid raw range). Full
// L-M sweep read on the device confirmed the exact rounded values (125 not the 127 a pure
// 1/12-oct formula gives). raw is the R40 sequence index with raw 0 = 15 Hz, raw 6 = 21.2 Hz.
//
// The grades come from `preferred-numbers.ts` rather than a second copy: this module used to
// hold its own 1.0-based mantissa table, which multiplied up to 112.00000000000001 where the
// grade is 112 — and the label below, which prints an integer grade as an integer, then read
// "112.0 Hz" for a frequency the unit shows as "112". Two raws of the crossover's windows
// landed on such a product; the rest of the mantissas scale exactly.
/** MBC crossover raw → Hz (exact R40 table; raw 0 = 15 Hz). */
export function mbcXoverHz(raw: number): number {
  return preferredNumber(R40, raw + 47);
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

// Guitar Amp Output level (slot 14, raw 0..127): a square-law gain, (raw/127)², so
// dB = 40·log10(raw/127) — raw 0 = -∞, raw 127 = 0 dB. The unit prints it rounded to 0.1.
/** Guitar Amp Output raw → dB (-∞ at raw 0). */
function guitarOutputDb(raw: number): number {
  if (raw <= 0) return -Infinity;
  return 40 * Math.log10(raw / 127);
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
/** Guitar Amp Crunch "Type" (slot 6, Crunch only). */
const GUITAR_CRUNCH_TYPES = [
  { value: 0, label: "Normal" },
  { value: 1, label: "Bright" },
];
/** Guitar Amp Lead "Type" (slot 6, Lead only). */
const GUITAR_LEAD_TYPES = [
  { value: 0, label: "High" },
  { value: 1, label: "Low" },
];

// Pitch Fix slots. Key (15) is a semitone; Scale (16) is a preset label, with the
// 12 note on/off toggles (22..33) the editable ground truth (Chromatic = all on;
// editing any note shows "Custom"). The full Scale enum is LCD-confirmed
// (sentinel writes, values 0..7). MIDI Control packs two bits across 34/35:
// Off (0,0) / Setting (1,0) / Real Time (1,1).
export const PITCH_KEYS = SEMITONE_NAMES.map((label, value) => ({ value, label }));
export const PITCH_SCALE_SLOT = 16;
export const PITCH_SCALE_CUSTOM = 0;
export const PITCH_SCALE_SINGLE = 1;
export const PITCH_SCALE_MAJOR = 2;
export const PITCH_SCALE_NATURAL_MINOR = 3;
export const PITCH_SCALE_HARMONIC_MINOR = 4;
export const PITCH_SCALE_MELODIC_MINOR = 5;
export const PITCH_SCALE_PENTATONIC = 6;
export const PITCH_SCALE_CHROMATIC = 7;
/**
 * Note-keyboard array slots. The twelve are ABSOLUTE semitones — slot 22 is C whatever the
 * Key is — so a mask authored here is written from C and not from the Key.
 */
export const PITCH_NOTE_SLOTS = [22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33];

/**
 * Which semitones each Scale preset turns on, as offsets from the Key.
 *
 * The unit derives the twelve-note mask itself from the Scale enum and the Key, for every
 * preset and at every key — read off a URX44V at Key = C and Key = G, where the offsets
 * came back identical while the absolute bits moved. So the app can author any of them
 * rather than only the two it could spell, and the mask it writes agrees with what the
 * unit would have derived instead of overwriting it with a C-rooted one.
 *
 * Custom is null: it is not a pattern. Selecting it leaves the mask exactly as it is, which
 * is also what the unit does to the enum when a note is edited — it sets Custom on its own.
 */
export const PITCH_SCALE_OFFSETS: Readonly<Record<number, readonly number[] | null>> = {
  [PITCH_SCALE_CUSTOM]: null,
  [PITCH_SCALE_SINGLE]: [0],
  [PITCH_SCALE_MAJOR]: [0, 2, 4, 5, 7, 9, 11],
  [PITCH_SCALE_NATURAL_MINOR]: [0, 2, 3, 5, 7, 8, 10],
  [PITCH_SCALE_HARMONIC_MINOR]: [0, 2, 3, 5, 7, 8, 11],
  [PITCH_SCALE_MELODIC_MINOR]: [0, 2, 3, 5, 7, 9, 11],
  [PITCH_SCALE_PENTATONIC]: [0, 2, 4, 7, 9],
  [PITCH_SCALE_CHROMATIC]: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

/** The Key the mask is derived against (engine slot 15, raw 0..11 = C..B). */
export const PITCH_KEY_SLOT = 15;
/** MIDI Control: enable bit (slot 34) + realtime bit (slot 35). */
export const PITCH_MIDI_ENABLE_SLOT = 34;
export const PITCH_MIDI_REALTIME_SLOT = 35;

// ---- per-effect parameter descriptors ----

interface InsertFxParamFields {
  /** Engine array slot. Some params mirror onto a second slot (see `mirror`). */
  slot: number;
  /** Optional second slot written with the same raw (Pitch Coarse/Fine/Formant). */
  mirror?: number;
  /** i18n label key, resolved by the inspector. */
  label: string;
  /** Which band of a multi-band effect this row belongs to. The multi-band compressor
   *  repeats one set of four parameters three times, so `label` alone names three
   *  different slots and a surface that has to tell them apart reads this. Absent on
   *  every effect whose parameters occur once. */
  band?: "low" | "mid" | "high";
  rawMin?: number;
  rawMax?: number;
  rawStep?: number;
  /** How far one arrow press or wheel notch moves the value, where the unit's own encoder
   *  moves it further than the `rawStep` the value is held to. The finer part of a value
   *  the operator turns is kept. Absent = the turn is one `rawStep`. */
  rawTurnStep?: number;
  /** The values the unit's own knob stops on, ascending, where they are neither `rawStep`'s
   *  grid nor a fixed turn. The slider and a MIDI mapping move through this table, a position
   *  being an index into it; `rawStep` is then the grid a value written into the plan is held
   *  to. Absent = the slider carries the value itself. */
  rawStops?: readonly number[];
  /** Factory default raw — the inspector's absent-value fallback for display. */
  def: number;
  /** Display formatter for a raw value (slider/select). */
  format?: (raw: number) => string;
}

/** A select carries the options it offers (value = raw); a slider or a toggle carries none. */
export type InsertFxParamDesc = InsertFxParamFields &
  (
    | { control: "slider"; options?: undefined }
    | { control: "toggle"; options?: undefined }
    | { control: "select"; options: { value: number; label: string }[] }
  );

/** Compander Release raw (ms×10) → the label the unit prints: three significant figures, to
 *  no finer than the 0.1 ms the value holds (5.0 ms, 65.4 ms, 999 ms, 1.23 s, 42.3 s). */
function companderReleaseLabel(raw: number): string {
  const ms = raw / 10;
  if (ms >= 1000) return `${(ms / 1000).toPrecision(3)} s`;
  return `${ms < 100 ? ms.toFixed(1) : Math.round(ms)} ms`;
}

// The stops a Compander Release (slot 9, ms×10) turns through on the unit's own knob, one per
// click: 5.33 ms apart for the first 32, then twice as far apart every 16 stops after that.
const COMPANDER_RELEASE_STOPS: readonly number[] = [
  50, 110, 160, 210, 270, 320, 370, 430, 480, 530, 590, 640, 690, 750, 800, 850, 910, 960, 1010, 1070, 1120, 1170, 1230,
  1280, 1330, 1390, 1440, 1490, 1550, 1600, 1650, 1710, 1760, 1870, 1970, 2080, 2190, 2290, 2400, 2510, 2610, 2720,
  2830, 2930, 3040, 3150, 3250, 3360, 3470, 3680, 3890, 4110, 4320, 4530, 4750, 4960, 5170, 5390, 5600, 5810, 6030,
  6240, 6450, 6670, 6880, 7300, 7730, 8160, 8580, 9010, 9440, 9860, 10300, 10700, 11100, 11600, 12000, 12400, 12900,
  13300, 13700, 14600, 15400, 16300, 17100, 18000, 18800, 19700, 20500, 21400, 22200, 23100, 23900, 24800, 25700, 26500,
  27400, 29100, 30800, 32500, 34200, 35900, 37600, 39300, 41000, 42700, 44400, 46100, 47800, 49500, 51200, 53000, 54700,
  58100, 61500, 64900, 68300, 71700, 75100, 78500, 82000, 85400, 88800, 92200, 95600, 99000, 102000, 106000, 109000,
  116000, 123000, 130000, 137000, 143000, 150000, 157000, 164000, 171000, 178000, 184000, 191000, 198000, 205000,
  212000, 218000, 232000, 246000, 259000, 273000, 287000, 300000, 314000, 328000, 341000, 355000, 369000, 382000,
  396000, 410000, 423000,
];

// Compander-H / Compander-S (engine 689 input / 693 output). Encodings match the
// dedicated COMP path (centi-dB / ratio×100 / attack µs / release ms×10).
const COMPANDER_PARAMS: InsertFxParamDesc[] = [
  {
    slot: 6,
    label: "threshold",
    control: "slider",
    rawMin: -5400,
    rawMax: 0,
    // Held to 0.1 dB, the finest value the link writes and the unit keeps; a turn moves it a
    // whole dB, the unit's encoder click, keeping the tenths. The unit prints the whole-dB
    // part, toward zero, which is what the readout below does.
    rawStep: 10,
    rawTurnStep: 100,
    def: -1000,
    format: (r) => `${Math.trunc(r / 100)} dB`,
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
    // The slider and a MIDI mapping move through the unit's knob stops. A written raw comes
    // back unchanged anywhere in the range, so a value the plan holds between two stops stays
    // as it is until the control moves it; 1 ms is the grid a written value is held to.
    rawStep: 10,
    rawStops: COMPANDER_RELEASE_STOPS,
    def: 2290,
    format: companderReleaseLabel,
  },
  {
    slot: 10,
    label: "gain",
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
    // Whole dB, which is what the effect guide's range states (1-90 dB) and what the
    // readout below prints. At a tenth of one, ten steps of the slider moved the value and
    // printed no change.
    rawStep: 100,
    def: 600,
    format: (r) => `${Math.round(r / 100)} dB`,
  },
];

// Multi-Band Compressor (engine 693, output only). Per-band Attack/Threshold/
// Ratio/Gain/Bypass at stride 5 (LOW 8-12, MID 13-17, HIGH 18-22); Release/Out
// Gain/XOVER/1-knob are global single slots. Attack/Ratio/Release are index
// tables; Threshold/Gain/Out Gain are linear dB offsets.
export type MbcBandKey = "attack" | "threshold" | "ratio" | "gain";
export const MBC_BANDS: Array<{ band: "low" | "mid" | "high"; bypass: number } & Record<MbcBandKey, number>> = [
  { band: "low", attack: 8, threshold: 9, ratio: 10, gain: 11, bypass: 12 },
  { band: "mid", attack: 13, threshold: 14, ratio: 15, gain: 16, bypass: 17 },
  { band: "high", attack: 18, threshold: 19, ratio: 20, gain: 21, bypass: 22 },
];
/** Attack is the one band value the unit does NOT give all three bands alike. Threshold,
 *  Ratio and Gain come up at 107 / 2 / 39 in every band; Attack comes up faster the higher
 *  the band goes. Carried here rather than in `MBC_BAND_PARAM`, which is per PARAMETER and
 *  has no band to vary by — one number there showed 17 ms on all three. */
const MBC_BAND_ATTACK_DEF: Record<"low" | "mid" | "high", number> = { low: 17, mid: 19, high: 9 };
export const MBC_GLOBAL = {
  oneKnobOn: 6, // bool
  oneKnobLevel: 7, // raw 0..48
  xoverLowMid: 23, // freq table
  xoverMidHigh: 24, // freq table
  release: 25, // MBC_RELEASE_MS index
  outGain: 26, // raw = dB + 64
} as const;
/** MBC 1-knob level raw range (0..48). */
export const MBC_ONE_KNOB_LEVEL_MAX = 48;
/** MBC Out Gain raw range (raw = dB + 64; ±12 dB → 52..76). */
export const MBC_OUT_GAIN_RAW_MIN = 52;
export const MBC_OUT_GAIN_RAW_MAX = 76;

/** MBC Release raw → display. An index outside the table prints the floor rather than
 *  "undefined ms": the raw is bounded on the way to the device, and a plan loaded from
 *  elsewhere can still carry one this list does not have. */
export const mbcReleaseLabel = (index: number): string => {
  const ms = MBC_RELEASE_MS[index] ?? 0;
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`;
};
/** MBC Out Gain raw → dB. raw = dB + 64. */
export const mbcOutGainDb = (raw: number): number => raw - 64;
/** MBC Out Gain raw → display ("+4 dB"). */
export const mbcOutGainLabel = (raw: number): string => `${mbcOutGainDb(raw)} dB`;

/**
 * One band's compressor in the plot's own units, from the three raws that shape it.
 *
 * The encodings stay in this file — a screen that decoded them itself would be a second
 * copy of three device laws — and what crosses the boundary is the dB and the ratio the
 * curve is drawn from. Out Gain is not in it: that one is applied to the SUM of the three
 * bands, so a curve carrying it would say each band is trimmed on its own.
 */
export function mbcBandCurve(o: { threshold: number; ratio: number; gain: number }): {
  thresholdDb: number;
  ratio: number;
  gainDb: number;
} {
  return {
    thresholdDb: mbcThresholdDb(o.threshold),
    ratio: Math.max(1, MBC_RATIO_STEPS[o.ratio] ?? 1),
    gainDb: mbcGainDb(o.gain),
  };
}

/** The MBC values that are one per effect rather than one per band, with the bounds,
 *  defaults and formatters the descriptors below are built from. The two 1-knob slots are
 *  NOT here: they are the control rather than a value it sets (see `MBC_ONE_KNOB`). */
const MBC_GLOBAL_PARAM: Record<
  "xoverLowMid" | "xoverMidHigh" | "release" | "outGain",
  { rawMin: number; rawMax: number; def: number; format: (r: number) => string }
> = {
  xoverLowMid: { rawMin: MBC_XOVER_LM_RANGE.min, rawMax: MBC_XOVER_LM_RANGE.max, def: 37, format: mbcXoverLabel },
  xoverMidHigh: { rawMin: MBC_XOVER_MH_RANGE.min, rawMax: MBC_XOVER_MH_RANGE.max, def: 94, format: mbcXoverLabel },
  release: { rawMin: 0, rawMax: MBC_RELEASE_MS.length - 1, def: 7, format: mbcReleaseLabel },
  outGain: { rawMin: MBC_OUT_GAIN_RAW_MIN, rawMax: MBC_OUT_GAIN_RAW_MAX, def: 68, format: mbcOutGainLabel },
};

/**
 * The 1-knob pair — an operator control, like the COMP and EQ knobs it is the third of.
 *
 * Switching it on sets the Level to 0, recomputes the three bands' Threshold, Ratio and Gain
 * from it, and sets the Attacks, the Bypasses, the Release, both crossovers and the Out Gain to
 * the type's own values (`MBC_ONE_KNOB_FIXED`). Every Level change afterwards recomputes the
 * first nine again and pins all but the Out Gain back to theirs; the unit's own
 * screen turns none of them, nor the Out Gain, while the knob is on. The app therefore writes
 * the knob, takes the fixed values into the plan at the switch (`mbcOneKnobSwitch`), and stops
 * emitting every slot the knob holds (`mbcDeviceDriven`).
 *
 * The readings behind this are in docs/{en,ja}/channel-tuning.md.
 */
export const MBC_ONE_KNOB = {
  on: { slot: MBC_GLOBAL.oneKnobOn, rawMin: 0, rawMax: 1 },
  level: { slot: MBC_GLOBAL.oneKnobLevel, rawMin: 0, rawMax: MBC_ONE_KNOB_LEVEL_MAX },
} as const;
/** Per-band raw bounds + formatters (shared by all three bands). Iterate the
 *  bands' parameters via MBC_BAND_KEYS so every consumer sees the same set. */
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
/** The band parameters, derived from the catalog so a new one cannot be missed by
 *  a hand-written list. Declaration order — a surface that wants them in another order
 *  states that order itself. */
export const MBC_BAND_KEYS = Object.keys(MBC_BAND_PARAM) as MbcBandKey[];

/**
 * The multi-band compressor's descriptors: four parameters in each of three bands, then
 * the four that are one per effect.
 *
 * Built from the tables above rather than written out, so a slot number stays in one
 * place and a band gained or a parameter added reaches every consumer at once. The band
 * rows carry `band` because their labels repeat — three slots called Threshold — and a
 * face that has to name one of them has nothing else to name it by.
 */
const MBC_PARAMS: InsertFxParamDesc[] = [
  ...MBC_BANDS.flatMap((b) => [
    ...MBC_BAND_KEYS.map((key) => ({
      slot: b[key],
      band: b.band,
      label: key,
      control: "slider" as const,
      ...MBC_BAND_PARAM[key],
      ...(key === "attack" ? { def: MBC_BAND_ATTACK_DEF[b.band] } : {}),
    })),
    // The band's own Bypass, last in its block of five. A toggle, so it is outside
    // `MBC_BAND_PARAM`, which is the four sliders' bounds and formatters.
    { slot: b.bypass, band: b.band, label: "bypass", control: "toggle" as const, def: 0 },
  ]),
  ...(Object.keys(MBC_GLOBAL_PARAM) as (keyof typeof MBC_GLOBAL_PARAM)[]).map((key) => ({
    slot: MBC_GLOBAL[key],
    label: key,
    control: "slider" as const,
    ...MBC_GLOBAL_PARAM[key],
  })),
  // The knob itself. Last in the catalogue and first on the screen: it decides whose the
  // rows above it are, which is where the EQ's own 1-knob section sits for the same reason.
  { slot: MBC_GLOBAL.oneKnobOn, label: "oneKnobOn", control: "toggle", def: 0 },
  {
    slot: MBC_GLOBAL.oneKnobLevel,
    label: "oneKnobLevel",
    control: "slider",
    rawMin: 0,
    rawMax: MBC_ONE_KNOB_LEVEL_MAX,
    def: 0,
    format: String,
  },
];

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
    // Semitones, and Fine's cents below, print as the bare number the unit's screen shows.
    format: (r) => String(r),
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
    format: (r) => String(r),
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
    format: (r) => `${r - 64}`,
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
  { slot: 20, label: "limitLow", control: "slider", rawMin: 0, rawMax: 127, rawStep: 1, def: 0, format: midiNoteName },
  {
    slot: 21,
    label: "limitHigh",
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
  // Slot 7 is Volume on Clean and Gain on the other three — the label the unit prints,
  // confirmed on the hardware and listed that way by the effect guide (Volume under
  // CLEAN Only, Gain repeated under each of the other three). The slot, the encoding and
  // the range are one thing across all four, so it stays here and only its label is
  // swapped, which keeps the read order the emit path walks.
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
/** Type-specific descriptors. slot 6 differs per type; Clean/Lead/Drive add more. The
 *  measured defaults for these reach them through `guitarTyped` below, so a value appears
 *  once whichever half of the pair its slot lives in. */
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
      return [{ slot: 6, label: "type", control: "select", def: 1, options: GUITAR_CRUNCH_TYPES }];
    case "guitar-lead":
      return [
        { slot: 6, label: "type", control: "select", def: 0, options: GUITAR_LEAD_TYPES },
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

/**
 * What each amp type's slots come up at on a factory-initialised unit.
 *
 * The four amps share the slot layout and NOT the values — each is a voicing, and the
 * shared table above can only carry one number per slot. It carried mid-scale ones (every
 * tone control 50, Output 64, SP Type 1), which is a shape no measurement produces: those
 * were placeholders, and the screen printed them wherever a device read had not filled the
 * plan yet. These are the unit's own; how they were read is in docs/{en,ja}/channel-tuning.md.
 *
 * Only the slots that differ from the shared descriptor are listed. A slot absent here
 * keeps the table's value, which is then the measurement for all four (Gate 0, Gate Level
 * 20, Mic Position 0, and Clean's modulation trio 1 / 50 / 50).
 */
const GUITAR_TYPE_DEFS: Record<string, Readonly<Record<number, number>>> = {
  "guitar-clean": { 6: 50, 7: 19, 9: 61, 10: 50, 11: 40, 12: 30, 14: 64, 16: 8 },
  "guitar-crunch": { 6: 1, 7: 46, 9: 47, 10: 70, 11: 53, 12: 28, 14: 47, 16: 4 },
  "guitar-lead": { 6: 0, 7: 100, 9: 66, 10: 80, 11: 30, 12: 29, 13: 49, 14: 42, 16: 1 },
  "guitar-drive": { 6: 3, 7: 75, 9: 40, 10: 50, 11: 80, 12: 90, 13: 40, 14: 43, 16: 6 },
};

/** Overlay a slot→default table onto a descriptor list, sharing the rows it does not name.
 *  One place applies a measured default, so a rule about which one wins cannot be stated
 *  twice and disagree with itself. */
function withDefs(descs: InsertFxParamDesc[], defs: Readonly<Record<number, number>>): InsertFxParamDesc[] {
  return descs.map((d) => (defs[d.slot] === undefined || d.def === defs[d.slot] ? d : { ...d, def: defs[d.slot] }));
}

/** One amp type's whole descriptor list, with the measured defaults applied to both halves
 *  — the shared rows and the type's own — from the one table. */
function guitarTyped(family: InsertFxFamily): InsertFxParamDesc[] {
  return withDefs([...guitarCommon(family), ...guitarTypeParams(family)], GUITAR_TYPE_DEFS[family] ?? {});
}

/** The shared guitar rows for one amp type: slot 7 reads Volume on Clean. The defaults are
 *  NOT applied here — `guitarTyped` covers both halves in one pass. */
function guitarCommon(family: InsertFxFamily): InsertFxParamDesc[] {
  if (family !== "guitar-clean") return GUITAR_COMMON_PARAMS;
  return GUITAR_COMMON_PARAMS.map((d) => (d.slot === 7 ? { ...d, label: "volume" } : d));
}

/**
 * The two companders' own defaults. They are ONE family — same slots, same ranges, same
 * screen — and the only thing that separates them is what they come up at, which is all
 * five of their values. The catalogue carried H's, so choosing Compander-S showed H's
 * numbers until a device read replaced them.
 *
 * A family of their own would have duplicated the engine map, the menu and the screen to
 * vary one field, so the family stays one and the DEFAULT is asked of the selector.
 */
export const COMPANDER_H = 1793;
export const COMPANDER_S = 1794;
const COMPANDER_TYPE_DEFS: Record<number, Readonly<Record<number, number>>> = {
  [COMPANDER_H]: { 6: -1000, 7: 350, 8: 1000, 9: 2290, 11: 600 },
  [COMPANDER_S]: { 6: -800, 7: 400, 8: 25000, 9: 1650, 11: 2400 },
};

// The descriptor / writable-slot lists are static per family, so memoize them: the
// per-node loop in planToCommands (every live-sync tick) and readback both ask for
// them repeatedly. Keyed by family AND selector, since the compander's defaults are the
// selector's — every other family is one type and answers the same list either way.
const PARAMS_CACHE = new Map<string, InsertFxParamDesc[]>();
const SLOTS_CACHE = new Map<InsertFxFamily, InsertFxSlotSpec[]>();

/**
 * Flat descriptor list for a family.
 *
 * `selector` is the value the node holds. It changes nothing but the compander's `def`,
 * and omitting it there answers with Compander-H — which is what every caller that does
 * not display a default wants, and what a caller that does must not take.
 */
export function insertFxParams(family: InsertFxFamily, selector?: number): InsertFxParamDesc[] {
  const key = family === "compander" ? `compander:${selector ?? ""}` : family;
  let cached = PARAMS_CACHE.get(key);
  if (!cached) {
    cached =
      family === "compander"
        ? companderTyped(selector)
        : family === "pitch"
          ? PITCH_PARAMS
          : family === "mbc"
            ? MBC_PARAMS
            : guitarTyped(family);
    PARAMS_CACHE.set(key, cached);
  }
  return cached;
}

/** The compander rows with the selected type's defaults, or Compander-H's where the caller
 *  named no type. */
function companderTyped(selector: number | undefined): InsertFxParamDesc[] {
  return withDefs(COMPANDER_PARAMS, COMPANDER_TYPE_DEFS[selector ?? COMPANDER_H] ?? COMPANDER_TYPE_DEFS[COMPANDER_H]);
}

// ---- writable-slot enumeration (translate / readback) ----
//
// Every engine array slot urx-router writes for a family, plus any mirror slot.
// Plan storage is a slot→raw map; translate emits the slots the plan carries, a
// selection and a load fill the ones it does not (`seedInsertFxParams`), and readback
// reads them all. slot0 (type) / slot1 (on) / slot2 (mix) are device-managed by the
// selector.

export interface InsertFxSlotSpec {
  slot: number;
  /** Second slot written with the same raw (Pitch Coarse/Fine/Formant). */
  mirror?: number;
  /** Calibrated raw bounds, carried from the catalog so the emit path can bound a
   *  hand-edited plan to the same range the inspector enforces. Every slot states
   *  them: an absent bound is an opt-out of that firewall (vd.ts boundRaw
   *  passes the raw through), which is silent at the catalog and audible at the
   *  device. */
  rawMin: number;
  rawMax: number;
}

/** Raw bounds for a descriptor. A slider states them; a toggle is the bool range
 *  and a select its option span, both of which the catalog spells as a control
 *  kind rather than as rawMin/rawMax. */
function descBounds(d: InsertFxParamDesc): { rawMin: number; rawMax: number } {
  if (d.control === "select") {
    const values = d.options.map((o) => o.value);
    return { rawMin: Math.min(...values), rawMax: Math.max(...values) };
  }
  if (d.control === "toggle") return { rawMin: 0, rawMax: 1 };
  return { rawMin: d.rawMin as number, rawMax: d.rawMax as number };
}

/**
 * Slots the app READS from the unit but never writes.
 *
 * There are none. Both rows that used to be here — Pitch Fix's MIDI Control and the
 * multi-band compressor's 1-knob — are settings the operator changes on purpose, and what
 * each does to its neighbours is what the unit does when they change it on the front panel
 * too. Refusing the write there was the app second-guessing a gesture, and it made these
 * two the odd ones out among 1-knob-shaped controls: the COMP and EQ knobs are written and
 * have exactly the same property.
 *
 * What replaced the refusal is a DRIVEN set per family (`pitchDeviceDriven`,
 * `mbcDeviceDriven`): the app writes the control and stops emitting the values the unit
 * then takes over, which is the treatment `COMP_ONE_KNOB_DRIVEN` already had.
 *
 * The list stays because the distinction is real — the writable list decides both halves,
 * `translate` emitting from it and `readback` filling the plan from it, so a slot dropped
 * from it to stop a write also stops being read and its row then shows a default instead of
 * what the unit holds.
 */
/** Every slot a device read fills the plan from. No family holds a read-only one today —
 *  the two that did are written now, with a driven set deciding what the writer skips — so
 *  this is the writable list. It keeps its own name because the two questions are not the
 *  same one: dropping a slot from the WRITABLE list to stop a write would stop the read as
 *  well, and the row would then show a default instead of what the unit holds. */
export function insertFxReadableSlots(family: InsertFxFamily): InsertFxSlotSpec[] {
  return insertFxWritableSlots(family);
}

export function insertFxWritableSlots(family: InsertFxFamily): InsertFxSlotSpec[] {
  let cached = SLOTS_CACHE.get(family);
  if (cached) return cached;
  const out: InsertFxSlotSpec[] = insertFxParams(family).map((d) => ({
    slot: d.slot,
    mirror: d.mirror,
    ...descBounds(d),
  }));
  if (family === "pitch") {
    // MIDI Control's two bits come FIRST, so a flush that turns the mode on does its erase
    // before the Scale and the mask would be written — and while it is on the mask is the
    // unit's (`pitchDeviceDriven`) and is not written at all.
    out.push({ slot: PITCH_MIDI_ENABLE_SLOT, rawMin: 0, rawMax: 1 });
    out.push({ slot: PITCH_MIDI_REALTIME_SLOT, rawMin: 0, rawMax: 1 });
    out.push({ slot: PITCH_SCALE_SLOT, rawMin: PITCH_SCALE_CUSTOM, rawMax: PITCH_SCALE_CHROMATIC });
    // The note keyboard is bools.
    for (const slot of PITCH_NOTE_SLOTS) out.push({ slot, rawMin: 0, rawMax: 1 });
  }
  cached = out;
  SLOTS_CACHE.set(family, cached);
  return cached;
}

/**
 * The MBC slots the unit itself holds while 1-knob is on: the three bands' Threshold,
 * Ratio and Gain, which a Level change recomputes, the three Attacks and Bypasses, the
 * Release and the two crossovers, which the same change pins back to fixed values whatever
 * was written over them, and the Out Gain the switch set, which the unit's own screen turns
 * no more while the knob is on.
 *
 * One list for two consumers, so the writer and the screen cannot disagree about who owns
 * a row: `translate` stops emitting these — re-sending the plan's copy of a value the unit
 * is recomputing would put the pre-knob number back on it — and the screen locks and tags
 * exactly the rows the writer stopped sending.
 */
/**
 * The slots the unit itself drives for a family, given what the plan holds.
 *
 * Two consumers ask it and they must not answer differently: `translate` stops emitting
 * these, and the screen locks exactly the rows the writer stopped sending. A family with no
 * such control answers the empty set, so neither caller carries a list of which families to
 * ask — that list was written out twice and would have had to grow twice.
 */
/**
 * One stored engine value, read the way the plan actually stores them.
 *
 * TWO namespaces answer for a slot: the family-qualified key an edit writes, and the bare
 * slot number a device readback writes (`readback.ts`). A reader that knows only the first
 * falls through to the catalogue default on a plan filled from the unit — which is a
 * factory number standing where the unit's own value is.
 *
 * It lives here, beside `insertFxParamKey`, because both consumers can reach it: the
 * screens through `insert-fx-model`, and the MIDI catalogue in `core/midi`, which cannot
 * import from `src/ui` at all.
 */
export function insertFxSlotVal(
  params: Record<string, number> | undefined,
  fam: InsertFxFamily,
  slot: number,
  def: number,
): number {
  return params?.[insertFxParamKey(fam, slot)] ?? params?.[String(slot)] ?? def;
}

/** Apply `patch` (slot → raw) to a stored engine map under `fam`'s own keys, dropping the
 *  bare slot each patched value came from so the two namespaces cannot both answer for one
 *  slot. Returns a new map. Beside the reader above, and for the same reason: the screens
 *  and the MIDI catalogue both write here and only one of them can reach `src/ui`. */
export function reKeyInsertFxParams(
  params: Record<string, number>,
  fam: InsertFxFamily,
  patch: Record<number, number>,
): Record<string, number> {
  const next = { ...params };
  for (const [slot, raw] of Object.entries(patch)) {
    next[insertFxParamKey(fam, Number(slot))] = raw;
    delete next[slot];
  }
  return next;
}

/** Pitch Fix's slots no descriptor row carries, at what the unit comes up at: MIDI Control
 *  off (both bits), Scale Chromatic, and every note of the mask on. */
const PITCH_UNLISTED_DEFS: Readonly<Record<number, number>> = {
  [PITCH_MIDI_ENABLE_SLOT]: 0,
  [PITCH_MIDI_REALTIME_SLOT]: 0,
  [PITCH_SCALE_SLOT]: PITCH_SCALE_CHROMATIC,
  ...Object.fromEntries(PITCH_NOTE_SLOTS.map((slot) => [slot, 1])),
};

/** Every writable slot of `family` at the default its type comes up at, keyed by slot — what
 *  the screen shows for a slot the plan does not hold, and what a selection or a load puts in
 *  the plan there. `selector` matters to the compander alone, as in `insertFxParams`. */
export function insertFxDefaults(family: InsertFxFamily, selector?: number): Readonly<Record<number, number>> {
  const out: Record<number, number> = {};
  for (const d of insertFxParams(family, selector)) out[d.slot] = d.def;
  if (family === "pitch") Object.assign(out, PITCH_UNLISTED_DEFS);
  return out;
}

/**
 * `params` with every writable slot of the effect `selector` names that it does not hold —
 * under the family's own key or the bare slot number — set to that type's default under the
 * family's key, and the keys it set. The unit fills the engine with those defaults on the
 * transition into a type and not on a same-value write, so a plan that leaves a slot out is
 * one whose write sends nothing there while the screen prints the default. A value the map
 * holds is never replaced, and a selector naming no family (No Effect, an unknown value)
 * seeds nothing.
 */
export function seedInsertFxParams(
  params: Record<string, number> | undefined,
  selector: number,
): { params: Record<string, number> | undefined; seeded: string[] } {
  const family = insertFxFamilyOf(selector);
  if (!family) return { params, seeded: [] };
  const defaults = insertFxDefaults(family, selector);
  const next = { ...params };
  const seeded: string[] = [];
  for (const { slot } of insertFxWritableSlots(family)) {
    const key = insertFxParamKey(family, slot);
    if (next[key] !== undefined || next[String(slot)] !== undefined) continue;
    next[key] = defaults[slot];
    seeded.push(key);
  }
  return { params: seeded.length > 0 ? next : params, seeded };
}

/** The raw the emit sends for a stored engine-slot value: a finite number, rounded and bounded
 *  to the slot's window. Undefined for anything else, which the emit does not send. */
export function insertFxSlotRaw(v: unknown, spec: Pick<InsertFxSlotSpec, "rawMin" | "rawMax">): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? boundRaw(v, spec.rawMin, spec.rawMax) : undefined;
}

const SWITCH_WINDOW = { rawMin: 0, rawMax: 1 } as const;

/** Whether a 0..1 switch slot holding `v` is on: the raw the emit sends there is not 0. A
 *  value the emit does not send (a boolean, a string) counts as off. */
export function insertFxSwitchOn(v: unknown): boolean {
  return (insertFxSlotRaw(v, SWITCH_WINDOW) ?? 0) !== 0;
}

/**
 * Whether a driver slot — the multi-band compressor's 1-knob On, Pitch Fix's MIDI Control
 * bits — is on, answered from the raw the emit sends there (`insertFxSwitchOn`). The driven
 * sets the writer skips, the locks the screen and the MIDI catalogue draw, and the screen's
 * own switch and mode all ask this one question, so none of them can call a value on that
 * the write sends as off, or the other way round.
 */
export function insertFxDriverOn(
  params: Record<string, number> | undefined,
  family: InsertFxFamily,
  slot: number,
): boolean {
  return insertFxSwitchOn(insertFxSlotVal(params, family, slot, 0));
}

export function insertFxDeviceDriven(
  family: InsertFxFamily,
  params: Record<string, number> | undefined,
): ReadonlySet<number> {
  return family === "mbc" ? mbcDeviceDriven(params) : family === "pitch" ? pitchDeviceDriven(params) : EMPTY_SLOTS;
}

export function mbcDeviceDriven(params: Record<string, number> | undefined): ReadonlySet<number> {
  return insertFxDriverOn(params, "mbc", MBC_ONE_KNOB.on.slot) ? MBC_ONE_KNOB_HELD : EMPTY_SLOTS;
}
const MBC_ONE_KNOB_HELD: ReadonlySet<number> = new Set([
  // EVERY per-band slot, read off the descriptors rather than named here: that is the rule
  // the run measured, and a band parameter added later is in it without anyone remembering.
  ...MBC_PARAMS.filter((d) => d.band !== undefined).map((d) => d.slot),
  MBC_GLOBAL.release,
  MBC_GLOBAL.xoverLowMid,
  MBC_GLOBAL.xoverMidHigh,
  MBC_GLOBAL.outGain,
]);

/** The M.B.Comp slots the 1-knob sets to the type's own values when it is switched on, and
 *  which hold those values while it stays on: each band's Attack and Bypass, the Release, both
 *  crossovers and the Out Gain. */
export const MBC_ONE_KNOB_FIXED: readonly number[] = [
  ...MBC_BANDS.map((b) => b.attack),
  ...MBC_BANDS.map((b) => b.bypass),
  MBC_GLOBAL.release,
  MBC_GLOBAL.xoverLowMid,
  MBC_GLOBAL.xoverMidHigh,
  MBC_GLOBAL.outGain,
];

/** What setting the M.B.Comp 1-knob to `on` writes, slot by slot: switched on from off, the
 *  Level goes to 0 and `MBC_ONE_KNOB_FIXED` to the type's own values, as the unit does;
 *  otherwise only the switch moves. */
export function mbcOneKnobSwitch(params: Record<string, number> | undefined, on: boolean): Record<number, number> {
  const out: Record<number, number> = { [MBC_ONE_KNOB.on.slot]: on ? 1 : 0 };
  if (!on || insertFxDriverOn(params, "mbc", MBC_ONE_KNOB.on.slot)) return out;
  const defs = insertFxDefaults("mbc");
  out[MBC_ONE_KNOB.level.slot] = 0;
  for (const slot of MBC_ONE_KNOB_FIXED) out[slot] = defs[slot];
  return out;
}

/**
 * The Pitch Fix slots the unit itself drives while MIDI Control is not Off: the Scale enum
 * and the twelve-note mask.
 *
 * Switching the mode on clears the mask and takes the Scale to Custom — the unit does that
 * itself, and it is what the operator asked for by switching it — and the notes it corrects
 * to then come from a USB-MIDI port of the unit's own. Re-sending the plan's copy of either
 * would put the pre-change mask back over what the unit did, which is the defect the COMP
 * knob's own driven set exists for.
 */
/**
 * The engine slots that DRIVE the rest of the array rather than sitting in it: whichever
 * of them this family has. Writing one makes the unit recompute the slots
 * `insertFxDeviceDriven` names, so a command carrying one is the one that has to be
 * followed by a read (`INSERT_FX_DRIVER` in params.ts).
 */
export function insertFxDriverSlots(family: InsertFxFamily): ReadonlySet<number> {
  return family === "mbc" ? MBC_DRIVER_SLOTS : family === "pitch" ? PITCH_DRIVER_SLOTS : EMPTY_SLOTS;
}
const MBC_DRIVER_SLOTS: ReadonlySet<number> = new Set([MBC_ONE_KNOB.on.slot, MBC_ONE_KNOB.level.slot]);
const PITCH_DRIVER_SLOTS: ReadonlySet<number> = new Set([PITCH_MIDI_ENABLE_SLOT, PITCH_MIDI_REALTIME_SLOT]);

/** Clean's modulation trio: the setting, the value that makes the other two heard, and the
 *  two it decides for. The unit runs Speed and Depth on the vibrato alone and takes a write
 *  to either of them whatever the setting reads. */
export const GUITAR_MOD = { slot: 19, vib: 2, speed: 20, depth: 21 } as const;

/** The slots whose value is not in the signal right now, though the unit stores them and
 *  takes a write to them: Clean's Speed and Depth while its modulation is not the vibrato.
 *
 *  Separate from `insertFxLockedSlots` because the two answer different questions — this
 *  one earns a row a TAG saying when its value applies, and that one refuses the write.
 *  Answered together, a row nobody may write and a row whose value is simply not heard
 *  looked the same, and the second was drawn as the first. */
export function insertFxInactiveSlots(
  family: InsertFxFamily,
  params: Record<string, number> | undefined,
): ReadonlySet<number> {
  if (family !== "guitar-clean") return EMPTY_SLOTS;
  const mod = insertFxParams(family).find((d) => d.slot === GUITAR_MOD.slot);
  if (!mod) return EMPTY_SLOTS;
  return insertFxSlotVal(params, family, GUITAR_MOD.slot, mod.def) === GUITAR_MOD.vib ? EMPTY_SLOTS : MOD_GATED;
}

/**
 * Every slot a surface must refuse to write, for this family holding these values.
 *
 * ONE seat for two consumers. The tuning screen draws these rows locked; a MIDI mapping
 * made before the lock applied reaches the same slots and has to refuse them there too.
 * Split across the two, a mapping writes what the screen will not — and for the slots the
 * unit is driving, the write lands in the plan while the writer is suppressing it, so the
 * plan and the unit part company silently and the plan's copy is sent the moment the unit
 * gives the slots back.
 *
 * Two rules, and each is a rule about what the UNIT is doing rather than about the panel:
 * the multi-band compressor's 1-knob owns the values it recomputes and its Level owns
 * nothing while the knob is off, and Pitch Fix's MIDI Control owns the mask.
 *
 * Clean's modulation is NOT one of them. Speed and Depth are heard on the vibrato alone,
 * but the unit stores them and takes a write to either whatever the setting reads, so
 * refusing it here would be the app forbidding a gesture the unit allows — the row carries
 * the tag `insertFxInactiveSlots` earns it instead.
 */
export function insertFxLockedSlots(
  family: InsertFxFamily,
  params: Record<string, number> | undefined,
): ReadonlySet<number> {
  if (family === "mbc") {
    return insertFxDriverOn(params, family, MBC_ONE_KNOB.on.slot) ? mbcDeviceDriven(params) : ONE_KNOB_LEVEL_ONLY;
  }
  if (family === "pitch") return pitchDeviceDriven(params);
  return EMPTY_SLOTS;
}
const ONE_KNOB_LEVEL_ONLY: ReadonlySet<number> = new Set([MBC_ONE_KNOB.level.slot]);
const MOD_GATED: ReadonlySet<number> = new Set([GUITAR_MOD.speed, GUITAR_MOD.depth]);

export function pitchDeviceDriven(params: Record<string, number> | undefined): ReadonlySet<number> {
  return insertFxDriverOn(params, "pitch", PITCH_MIDI_ENABLE_SLOT) ? PITCH_MIDI_DRIVEN : EMPTY_SLOTS;
}
const PITCH_MIDI_DRIVEN: ReadonlySet<number> = new Set(PITCH_NOTE_SLOTS);

/**
 * The engine patch a Pitch Fix scale selection writes: the scale slot, and the twelve
 * notes the preset turns on AT THIS KEY.
 *
 * The mask slots are absolute semitones and the unit derives them from the Scale enum and
 * the Key. Authoring them from the same offsets is what keeps a plan written offline
 * agreeing with what the unit would have derived — a mask rooted at C, written at any
 * other Key, is a different scale.
 *
 * Custom carries no pattern: it names whatever mask is already there, so the patch is the
 * enum alone.
 */
export function pitchScalePatch(scale: number, key: number): Record<number, number> {
  const patch: Record<number, number> = { [PITCH_SCALE_SLOT]: scale };
  const offsets = PITCH_SCALE_OFFSETS[scale];
  if (!offsets) return patch;
  const on = new Set(offsets.map((o) => (o + key) % 12));
  PITCH_NOTE_SLOTS.forEach((s, i) => (patch[s] = on.has(i) ? 1 : 0));
  return patch;
}

/** The mask a Key change re-roots to, keeping the scale it is currently spelling. The unit
 *  re-derives on a Key write of its own, so this is what an offline plan needs to match. */
export function pitchKeyPatch(scale: number, key: number): Record<number, number> {
  return { [PITCH_KEY_SLOT]: key, ...pitchScalePatch(scale, key) };
}

/**
 * MIDI Control's three-way, folded from its two engine bits: enable off = Off, enable on
 * with realtime off = Setting, both on = Real Time.
 *
 * It is written, through `pitchMidiModeChange` below. While it is on, the twelve-note mask is
 * the unit's (`pitchDeviceDriven`): the screen locks it and the writer stops emitting it. The
 * Scale stays the operator's, from the list the mode offers (`pitchScalesOffered`).
 */
export function pitchMidiMode(enable: unknown, realtime: unknown): 0 | 1 | 2 {
  return !insertFxSwitchOn(enable) ? 0 : !insertFxSwitchOn(realtime) ? 1 : 2;
}

/**
 * …and the inverse, as the slot patch a write speaks. Two bits for three modes, so a write
 * names BOTH: setting the enable bit alone would leave whichever real-time bit was there
 * and land on a mode nobody chose.
 */
export function pitchMidiPatch(mode: number): Record<number, number> {
  return { [PITCH_MIDI_ENABLE_SLOT]: mode === 0 ? 0 : 1, [PITCH_MIDI_REALTIME_SLOT]: mode === 2 ? 1 : 0 };
}

/** The scales MIDI Control lets the Scale list offer: all of them under Off, all but Chromatic
 *  under Setting, Custom and Single under Real Time. */
export function pitchScalesOffered(mode: number): (scale: number) => boolean {
  if (mode === 2) return (scale) => scale === PITCH_SCALE_CUSTOM || scale === PITCH_SCALE_SINGLE;
  if (mode === 1) return (scale) => scale !== PITCH_SCALE_CHROMATIC;
  return () => true;
}

/** The engine patch a Scale choice writes under MIDI Control `mode`: under Real Time the mask
 *  stays empty, so the choice is the enum alone. */
export function pitchScaleChoice(mode: number, scale: number, key: number): Record<number, number> {
  return mode === 2 ? { [PITCH_SCALE_SLOT]: scale } : pitchScalePatch(scale, key);
}

/** The engine patch a Key choice writes under MIDI Control `mode`: under Real Time the mask
 *  stays empty, so the choice is the Key alone. */
export function pitchKeyChoice(mode: number, scale: number, key: number): Record<number, number> {
  return mode === 2 ? { [PITCH_KEY_SLOT]: key } : pitchKeyPatch(scale, key);
}

/**
 * The engine patch a MIDI Control change writes, from mode `was` to `mode`: the two bits, and
 * what the unit does to the Scale and the mask on the same change.
 * - Onto Real Time the mask empties, and a scale other than Single turns Custom.
 * - From Real Time onto Setting or Off, a named scale fills the mask in again at the Key.
 * - From Off onto Setting, a Custom or Chromatic scale empties the mask onto Custom.
 */
export function pitchMidiModeChange(was: number, mode: number, scale: number, key: number): Record<number, number> {
  const patch = pitchMidiPatch(mode);
  if (mode === was) return patch;
  const empty = (): void => PITCH_NOTE_SLOTS.forEach((s) => (patch[s] = 0));
  if (mode === 2) {
    if (scale !== PITCH_SCALE_SINGLE) patch[PITCH_SCALE_SLOT] = PITCH_SCALE_CUSTOM;
    empty();
  } else if (was === 2) {
    if (PITCH_SCALE_OFFSETS[scale]) Object.assign(patch, pitchScalePatch(scale, key));
  } else if (mode === 1 && (scale === PITCH_SCALE_CUSTOM || scale === PITCH_SCALE_CHROMATIC)) {
    patch[PITCH_SCALE_SLOT] = PITCH_SCALE_CUSTOM;
    empty();
  }
  return patch;
}
const EMPTY_SLOTS: ReadonlySet<number> = new Set();

// ---- plan storage keys ----
//
// The plan keeps ONE engine-slot map per node (NodeParams.insertFxParams). A bare
// slot number says nothing about which effect wrote it, so switching the selector
// to another family hands the stored raws to that family's parameters — the same
// slot under a different law (Compander-H Threshold -3000 is MBC's 1-knob switch,
// its ratio, its band width) and emitted as absolute state on the next flush.
// Qualifying the key by family is what keeps the two apart, and lets the plan
// remember each family's values across a switch.
//
// A BARE key is still read, as the family the node's selector currently names:
// that is the shape a device readback writes (it reads the selector and the engine
// together, so its map is by construction the selected family's), and the shape
// every document written before the qualification carries.

/** Plan storage key for an engine slot under the family that owns it. */
export function insertFxParamKey(family: InsertFxFamily, slot: number): string {
  return `${family}:${slot}`;
}

/** True for a key in the bare (device-shaped) namespace — a slot number alone. */
function isBareInsertFxSlot(key: string): boolean {
  return /^\d+$/.test(key);
}

/** Re-key a node's bare slot entries onto `family`, returning a new map. Run when a
 *  plan enters the app (core/plan.ts) and when the selector is about to name a
 *  different family (ui/inspector.ts), so the bare namespace never outlives the
 *  family it was written for. An entry the family already holds under its own key
 *  wins — that one was authored, the bare one only read back.
 *
 *  A null family — No Effect, or a selector value this build does not know — drops
 *  the bare entries instead. Nothing can address them then (the emit path needs a
 *  family to pick the slot layout), and leaving them is what lets the NEXT effect
 *  selected read values another one wrote. routing.ts does the same with the whole
 *  map where a Signal Type transition clears the selector. Entries already under a
 *  family's own key are kept either way. */
/**
 * What a node's stored engine values become after a READ of the effect it currently holds.
 *
 * The map is one namespace per family on purpose — a node that has held three effects
 * carries all three, so switching back finds the values the operator left. A read answers
 * for ONE of them, and replacing the whole map with its answer is what deletes the other
 * two: with live sync up, a 1-knob write is enough to trigger it, and the loss shows only
 * when the operator selects the old effect again and finds it at the factory.
 *
 * Three things have to happen at once, which is why this is one function rather than a
 * step in the reader:
 *
 * - the bare slots already in the plan are parked under the family that WROTE them
 *   (`prev`), or a read of another family would adopt them;
 * - the current family's own stored values are dropped, because a qualified key beats a
 *   bare one when the value is read (`insertFxSlotVal`) and the unit's answer would sit
 *   underneath the plan's older copy of it;
 * - every other family's qualified values are kept untouched.
 *
 * With no family — No Effect, or a selector this build does not know — there is nothing to
 * read and nothing to attribute, so the qualified values stay and the bare ones go.
 */
export function mergeReadInsertFxParams(
  prev: Record<string, number> | undefined,
  prevFamily: InsertFxFamily | null,
  family: InsertFxFamily | null,
  read: Record<number, number>,
): Record<string, number> {
  const parked = qualifyInsertFxParams(prev ?? {}, prevFamily);
  const out: Record<string, number> = {};
  const mine = family === null ? null : `${family}:`;
  for (const [key, raw] of Object.entries(parked)) if (mine === null || !key.startsWith(mine)) out[key] = raw;
  if (family !== null) for (const [slot, raw] of Object.entries(read)) out[String(slot)] = raw;
  return out;
}

/** Park the outgoing effect's engine values under its own family before the
 *  selector names another one: a bare slot number left behind would be read as the
 *  new family's, whose slot means a different parameter under a different law, and
 *  emitted as absolute state on the next flush. Null when the node carries no
 *  engine values to park. */
export function parkOutgoingInsertFxParams(
  prev: { insertFx?: number; insertFxParams?: Record<string, number> } | undefined,
): Record<string, number> | null {
  if (!prev?.insertFxParams) return null;
  const prevFam = prev.insertFx === undefined ? null : insertFxFamilyOf(prev.insertFx);
  return qualifyInsertFxParams(prev.insertFxParams, prevFam);
}

export function qualifyInsertFxParams(
  params: Record<string, number>,
  family: InsertFxFamily | null,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(params)) if (!isBareInsertFxSlot(key)) out[key] = raw;
  if (!family) return out;
  for (const [key, raw] of Object.entries(params)) {
    if (!isBareInsertFxSlot(key)) continue;
    const qualified = insertFxParamKey(family, Number(key));
    if (!(qualified in out)) out[qualified] = raw;
  }
  return out;
}
