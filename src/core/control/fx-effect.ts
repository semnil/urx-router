// FX-channel effect catalog: EFFECT TYPE selection and the per-effect parameter
// set for the two FX channels (FX1 = Rev-X reverbs + delays, FX2 = Rev.R3 reverbs
// + delays). Unlike every other control parameter, the effect parameters do NOT
// live at a fixed param_id indexed by instance — they are packed into ONE array
// param per FX channel (681 for FX1, 685 for FX2), addressed by a SLOT on the y
// axis, and the slot's meaning depends on the selected effect type. This module
// isolates that addressing oddity plus the raw↔display encodings (all established
// by live LCD calibration; see reference/.local/vd-params.md "FX channel EFFECT").
//
// Plan storage mirrors SSMCS: raw broker integers are kept in the plan and turned
// into the device's display units here, so a captured plan round-trips exactly and
// the inspector sliders edit raw with a display-only formatter.

/** EFFECT TYPE selector param_id per FX channel index (FX1 = 0, FX2 = 1). */
export const FX_EFFECT_TYPE_PARAM = [679, 683] as const;
/** Effect-parameter array param_id per FX channel index. Addressed by slot on y. */
export const FX_EFFECT_ARRAY_PARAM = [681, 685] as const;
/** Array slots common to every effect type. */
export const FX_SLOT_ON = 1;
export const FX_SLOT_LEVEL = 2;

/** Effect families: the three distinct parameter layouts. */
export type FxFamily = "revx" | "revr3" | "delay";

export interface FxEffectTypeOption {
  /** Broker enum value written to the TYPE selector (679 / 683). */
  value: number;
  label: string;
  family: FxFamily;
}

// Per-FX EFFECT TYPE menus (fx1_insert_fx / fx2_insert_fx tables). FX1 reverbs are
// Rev-X (up to 192 kHz), FX2 reverbs are Rev.R3 (up to 96 kHz); both share the two
// delays. Within each FX channel only one effect is active (1-of-N, the selector).
export const FX1_EFFECT_TYPES: FxEffectTypeOption[] = [
  { value: 0, label: "Rev-X Hall", family: "revx" },
  { value: 1, label: "Rev-X Room", family: "revx" },
  { value: 2, label: "Rev-X Plate", family: "revx" },
  { value: 1024, label: "Mono Delay", family: "delay" },
  { value: 1025, label: "Ping Pong", family: "delay" },
];
export const FX2_EFFECT_TYPES: FxEffectTypeOption[] = [
  { value: 768, label: "Rev.R3 Hall", family: "revr3" },
  { value: 769, label: "Rev.R3 Room", family: "revr3" },
  { value: 770, label: "Rev.R3 Plate", family: "revr3" },
  { value: 1024, label: "Mono Delay", family: "delay" },
  { value: 1025, label: "Ping Pong", family: "delay" },
];

/** Effect-type menu for an FX channel index (0 = FX1, 1 = FX2). */
export function fxEffectTypes(fxIndex: number): FxEffectTypeOption[] {
  return fxIndex === 0 ? FX1_EFFECT_TYPES : FX2_EFFECT_TYPES;
}

// type value → family, built once (the two delay values appear in both menus
// with the same family, so the merge is unambiguous).
const FAMILY_BY_TYPE: ReadonlyMap<number, FxFamily> = new Map(
  [...FX1_EFFECT_TYPES, ...FX2_EFFECT_TYPES].map((t) => [t.value, t.family]),
);
/** The family a given EFFECT TYPE value belongs to (defaults to delay). */
export function fxFamilyOf(typeValue: number): FxFamily {
  return FAMILY_BY_TYPE.get(typeValue) ?? "delay";
}

/** Factory-default EFFECT TYPE per FX channel (FX1 Rev-X Hall, FX2 Mono Delay). */
export const FX_EFFECT_TYPE_DEFAULT = [0, 1024] as const;

// ---- raw → display encodings (calibrated; raw is the broker array value) ----

/** REV-X frequency table (HPF / LPF / Low Freq): 1/6-octave from 20 Hz. */
export function revxFreqHz(raw: number): number {
  return 20 * Math.pow(2, raw / 6);
}
/** Rev.R3 / delay frequency table (HPF / LPF): 1/12-octave from 15 Hz. */
export function fx2FreqHz(raw: number): number {
  return 15 * Math.pow(2, raw / 12);
}
/** Initial Delay / ER-Reverb Delay (REV-X + Rev.R3): linear ms = raw × 200/127. */
export function initDelayMs(raw: number): number {
  return (raw * 200) / 127;
}
/** Mono / Ping Pong Delay time: linear ms = raw / 14.976. */
export function delayMs(raw: number): number {
  return raw / 14.976;
}
/** Hi / Low Ratio: display = raw / 10. */
export function ratio10(raw: number): number {
  return raw / 10;
}
/** ER/Rev Balance: center 63; display "En>R" = 63 − raw (negative → "E<Rn"). */
export function balanceLabel(raw: number): string {
  const n = 63 - raw;
  if (n > 0) return `E${n}>R`;
  if (n < 0) return `E<R${-n}`;
  return "E=R";
}

// Rev.R3 Reverb Time: piecewise table, raw 0..69 → 0.3 .. 30.0 s.
export function revR3TimeSec(raw: number): number {
  if (raw <= 47) return 0.3 + 0.1 * raw;
  if (raw <= 57) return 5.0 + 0.5 * (raw - 47);
  if (raw <= 67) return raw - 47;
  if (raw <= 68) return 25.0;
  return 30.0;
}

// REV-X Reverb Time is 2-D: seconds = base(raw) × 3^(RoomSize/31). base(raw) is a
// piecewise multiple of the unit u = 0.103/3 (the rs0 seconds), with the step
// growing 1× → 5× → 10× → 50× of the unit across the range.
const REVX_TIME_UNIT = 0.103 / 3;
function revxTimeBaseUnits(raw: number): number {
  if (raw <= 47) return raw + 3;
  if (raw <= 57) return 50 + 5 * (raw - 47);
  if (raw <= 67) return 100 + 10 * (raw - 57);
  return 200 + 50 * (raw - 67); // raw 68, 69
}
/** REV-X Reverb Time seconds for a Reverb-Time raw and the channel's Room Size raw. */
export function revxTimeSec(raw: number, roomSizeRaw: number): number {
  return REVX_TIME_UNIT * revxTimeBaseUnits(raw) * Math.pow(3, roomSizeRaw / 31);
}

// Tempo-sync Note values (raw 0..14, short → long; 0 = off). Standard Yamaha list.
export const FX_NOTE_OPTIONS = [
  { value: 0, label: "---" },
  { value: 1, label: "1/32T" },
  { value: 2, label: "1/16T" },
  { value: 3, label: "1/16" },
  { value: 4, label: "1/8T" },
  { value: 5, label: "1/16." },
  { value: 6, label: "1/8" },
  { value: 7, label: "1/4T" },
  { value: 8, label: "1/8." },
  { value: 9, label: "1/4" },
  { value: 10, label: "1/4." },
  { value: 11, label: "1/2" },
  { value: 12, label: "1/2." },
  { value: 13, label: "whole" },
  { value: 14, label: "whole×2" },
];

// ---- shared display formatters ----

/** Hz value → "560 Hz" / "3.55 kHz". Shared with the inspector's SSMCS readouts. */
export function formatHz(hz: number): string {
  if (hz >= 1000) return `${(hz / 1000).toFixed(2)} kHz`;
  return `${Math.round(hz)} Hz`;
}
function formatSec(s: number): string {
  return `${s < 10 ? s.toFixed(2) : s.toFixed(1)} s`;
}
function formatMs(ms: number): string {
  return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
}

// ---- per-effect parameter descriptors ----

/** Control kind for the inspector: a raw slider, a toggle, or an option select. */
export type FxParamControl = "slider" | "toggle" | "select";

export interface FxParamDesc {
  /** Stable semantic key, also the plan storage key under FxEffectParams.params. */
  key: string;
  /** Array slot (y) the raw value is written to / read from. */
  slot: number;
  /** i18n label key (resolved by the inspector). */
  label: string;
  control: FxParamControl;
  /** Slider raw bounds + step (slider only). */
  rawMin?: number;
  rawMax?: number;
  rawStep?: number;
  /** Factory-default raw (the inspector's absent-value fallback). */
  def: number;
  /** Display formatter for a raw value. `ctx` carries sibling raw values (e.g.
   *  Room Size for REV-X Reverb Time). Slider/select only. */
  format?: (raw: number, ctx: Record<string, number>) => string;
  /** Option list for a `select` control (value = raw). */
  options?: { value: number; label: string }[];
}

// REV-X (FX1 reverbs). Slots from live calibration. Reverb Time display needs the
// Room Size sibling raw. Frequencies use the 1/6-oct table; ratios are raw/10.
export const REVX_PARAMS: FxParamDesc[] = [
  {
    key: "reverbTime",
    slot: 7,
    label: "reverbTime",
    control: "slider",
    rawMin: 0,
    rawMax: 69,
    rawStep: 1,
    def: 23,
    format: (r, c) => formatSec(revxTimeSec(r, c.roomSize ?? 31)),
  },
  {
    key: "initialDelay",
    slot: 9,
    label: "initialDelay",
    control: "slider",
    rawMin: 0,
    rawMax: 127,
    rawStep: 1,
    def: 2,
    format: (r) => formatMs(initDelayMs(r)),
  },
  {
    key: "decay",
    slot: 15,
    label: "decay",
    control: "slider",
    rawMin: 0,
    rawMax: 63,
    rawStep: 1,
    def: 27,
    format: (r) => String(r),
  },
  {
    key: "roomSize",
    slot: 12,
    label: "roomSize",
    control: "slider",
    rawMin: 0,
    rawMax: 31,
    rawStep: 1,
    def: 29,
    format: (r) => String(r),
  },
  {
    key: "diffusion",
    slot: 8,
    label: "diffusion",
    control: "slider",
    rawMin: 0,
    rawMax: 10,
    rawStep: 1,
    def: 10,
    format: (r) => String(r),
  },
  {
    key: "hpf",
    slot: 10,
    label: "hpf",
    control: "slider",
    rawMin: 0,
    rawMax: 52,
    rawStep: 1,
    def: 4,
    format: (r) => formatHz(revxFreqHz(r)),
  },
  {
    key: "lpf",
    slot: 11,
    label: "lpf",
    control: "slider",
    rawMin: 34,
    rawMax: 60,
    rawStep: 1,
    def: 50,
    format: (r) => formatHz(revxFreqHz(r)),
  },
  {
    key: "hiRatio",
    slot: 13,
    label: "hiRatio",
    control: "slider",
    rawMin: 1,
    rawMax: 10,
    rawStep: 1,
    def: 8,
    format: (r) => ratio10(r).toFixed(1),
  },
  {
    key: "lowRatio",
    slot: 14,
    label: "lowRatio",
    control: "slider",
    rawMin: 1,
    rawMax: 14,
    rawStep: 1,
    def: 12,
    format: (r) => ratio10(r).toFixed(1),
  },
  {
    key: "lowFreq",
    slot: 18,
    label: "lowFreq",
    control: "slider",
    rawMin: 1,
    rawMax: 59,
    rawStep: 1,
    def: 32,
    format: (r) => formatHz(revxFreqHz(r)),
  },
];

// Rev.R3 (FX2 reverbs). Frequencies use the 1/12-oct table; Feedback is signed raw.
export const REVR3_PARAMS: FxParamDesc[] = [
  {
    key: "reverbTime",
    slot: 7,
    label: "reverbTime",
    control: "slider",
    rawMin: 0,
    rawMax: 69,
    rawStep: 1,
    def: 15,
    format: (r) => formatSec(revR3TimeSec(r)),
  },
  {
    key: "initialDelay",
    slot: 8,
    label: "initialDelay",
    control: "slider",
    rawMin: 0,
    rawMax: 127,
    rawStep: 1,
    def: 25,
    format: (r) => formatMs(initDelayMs(r)),
  },
  {
    key: "hiRatio",
    slot: 9,
    label: "hiRatio",
    control: "slider",
    rawMin: 1,
    rawMax: 10,
    rawStep: 1,
    def: 7,
    format: (r) => ratio10(r).toFixed(1),
  },
  {
    key: "diffusion",
    slot: 10,
    label: "diffusion",
    control: "slider",
    rawMin: 0,
    rawMax: 10,
    rawStep: 1,
    def: 7,
    format: (r) => String(r),
  },
  {
    key: "density",
    slot: 11,
    label: "density",
    control: "slider",
    rawMin: 0,
    rawMax: 4,
    rawStep: 1,
    def: 3,
    format: (r) => String(r),
  },
  {
    key: "feedback",
    slot: 12,
    label: "feedback",
    control: "slider",
    rawMin: -99,
    rawMax: 99,
    rawStep: 1,
    def: 0,
    format: (r) => `${r > 0 ? "+" : ""}${r}%`,
  },
  {
    key: "erRevDelay",
    slot: 13,
    label: "erRevDelay",
    control: "slider",
    rawMin: 0,
    rawMax: 127,
    rawStep: 1,
    def: 1,
    format: (r) => formatMs(initDelayMs(r)),
  },
  {
    key: "erRevBalance",
    slot: 14,
    label: "erRevBalance",
    control: "slider",
    rawMin: 0,
    rawMax: 126,
    rawStep: 1,
    def: 55,
    format: (r) => balanceLabel(r),
  },
  {
    key: "hpf",
    slot: 15,
    label: "hpf",
    control: "slider",
    rawMin: 0,
    rawMax: 60,
    rawStep: 1,
    def: 29,
    format: (r) => formatHz(fx2FreqHz(r)),
  },
  {
    key: "lpf",
    slot: 16,
    label: "lpf",
    control: "slider",
    rawMin: 0,
    rawMax: 120,
    rawStep: 1,
    def: 99,
    format: (r) => formatHz(fx2FreqHz(r)),
  },
];

// Mono / Ping Pong Delay (both FX channels). Delay raw range differs by type
// (Mono 2700 ms, Ping Pong 1350 ms); the wider Mono bound is used and the device
// clamps the display. Note is only meaningful when Sync is on.
const DELAY_RAW_MAX_MONO = 40436; // 2700 ms × 14.976
export const DELAY_PARAMS: FxParamDesc[] = [
  {
    key: "delay",
    slot: 6,
    label: "delayTime",
    control: "slider",
    rawMin: 1,
    rawMax: DELAY_RAW_MAX_MONO,
    rawStep: 15,
    def: 5000,
    format: (r) => formatMs(delayMs(r)),
  },
  {
    key: "feedback",
    slot: 7,
    label: "feedback",
    control: "slider",
    rawMin: -99,
    rawMax: 99,
    rawStep: 1,
    def: 20,
    format: (r) => `${r > 0 ? "+" : ""}${r}%`,
  },
  {
    key: "hiRatio",
    slot: 8,
    label: "hiRatio",
    control: "slider",
    rawMin: 1,
    rawMax: 10,
    rawStep: 1,
    def: 7,
    format: (r) => ratio10(r).toFixed(1),
  },
  {
    key: "hpf",
    slot: 9,
    label: "hpf",
    control: "slider",
    rawMin: 0,
    rawMax: 60,
    rawStep: 1,
    def: 40,
    format: (r) => formatHz(fx2FreqHz(r)),
  },
  {
    key: "lpf",
    slot: 10,
    label: "lpf",
    control: "slider",
    rawMin: 0,
    rawMax: 120,
    rawStep: 1,
    def: 110,
    format: (r) => formatHz(fx2FreqHz(r)),
  },
  { key: "sync", slot: 4, label: "sync", control: "toggle", def: 0 },
  {
    key: "bpm",
    slot: 3,
    label: "bpm",
    control: "slider",
    rawMin: 25,
    rawMax: 300,
    rawStep: 1,
    def: 120,
    format: (r) => String(r),
  },
  { key: "note", slot: 11, label: "note", control: "select", def: 9, options: FX_NOTE_OPTIONS },
];

/** Parameter descriptors for an effect family. */
export function fxParams(family: FxFamily): FxParamDesc[] {
  return family === "revx" ? REVX_PARAMS : family === "revr3" ? REVR3_PARAMS : DELAY_PARAMS;
}
