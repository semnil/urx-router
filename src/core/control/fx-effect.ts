// FX-channel effect catalog: EFFECT TYPE selection and the per-effect parameter
// set for the two FX channels (FX1 = Rev-X reverbs + delays, FX2 = Rev.R3 reverbs
// + delays). Unlike every other control parameter, the effect parameters do NOT
// live at a fixed param_id indexed by instance — they are packed into ONE array
// param per FX channel (681 for FX1, 685 for FX2), addressed by a SLOT on the y
// axis, and the slot's meaning depends on the selected effect type. This module
// isolates that addressing oddity plus the raw↔display encodings (all established
// by live LCD calibration; see reference/work/vd/vd-params.md "FX channel EFFECT").
//
// Plan storage mirrors SSMCS: raw broker integers are kept in the plan and turned
// into the device's display units here, so a captured plan round-trips exactly and
// the inspector sliders edit raw with a display-only formatter.

import { preferredNumber, R20, R40 } from "./preferred-numbers";

/** EFFECT TYPE selector param_id per FX channel index (FX1 = 0, FX2 = 1). Note the
 *  selector is per CHANNEL, not a y index on one param — FX2 is 683, not 679:0:1.
 *
 *  Writing it is NOT reversible: the device refills the effect array with the new
 *  type's defaults, and selecting the original type back only refills it with that
 *  type's defaults. See the header of insert-fx-effect.ts, where the same rule is
 *  spelled out in full — it was measured there. */
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
const FX1_EFFECT_TYPES: FxEffectTypeOption[] = [
  { value: 0, label: "Rev-X Hall", family: "revx" },
  { value: 1, label: "Rev-X Room", family: "revx" },
  { value: 2, label: "Rev-X Plate", family: "revx" },
  { value: 1024, label: "Mono Delay", family: "delay" },
  { value: 1025, label: "Ping Pong", family: "delay" },
];
const FX2_EFFECT_TYPES: FxEffectTypeOption[] = [
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

/** FX channel index per plan node id (FX1 = 0, FX2 = 1). */
export const FX_CHANNEL_NODE_INDEX: Record<string, number> = { "bus.fx1": 0, "bus.fx2": 1 };

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

/** The EFFECT TYPE an FX channel will actually be set to: the plan's value when
 *  that CHANNEL's own menu offers it, the channel's factory type otherwise. The
 *  two menus are not the same list (FX1 reverbs are Rev-X, FX2's are Rev.R3), so
 *  a value real on the other channel is still off-menu here — writing it would
 *  hand the selector a reverb it does not have. Every site that has to decide what
 *  an off-menu type means asks this one: the emit firewall, the load migration and
 *  the inspector's selector, which would otherwise disagree about which effect a
 *  hand-edited / `?plan=` document names. */
export function resolveFxEffectType(fxIndex: number, typeValue: number | undefined): number {
  const fallback = FX_EFFECT_TYPE_DEFAULT[fxIndex];
  if (typeValue === undefined) return fallback;
  return fxEffectTypes(fxIndex).some((o) => o.value === typeValue) ? typeValue : fallback;
}

// ---- raw → display encodings (calibrated; raw is the broker array value) ----

/* Both filter tables are ISO 3 preferred-number series, and the offsets below are the only
 * part of them this module owns: the grades themselves are shared with the multi-band
 * compressor crossover, which steps in the same R40. */
/** REV-X frequency table (HPF / LPF / Low Freq): R20, with raw 0 at 20 Hz. */
export function revxFreqHz(raw: number): number {
  return preferredNumber(R20, raw + 26);
}
/** Rev.R3 / delay frequency table (HPF / LPF): R40, with raw 6 at its 21.2 Hz floor. */
export function fx2FreqHz(raw: number): number {
  return preferredNumber(R40, raw + 47);
}
/** Initial Delay / ER-Reverb Delay (REV-X + Rev.R3): linear ms = raw × 200/127. */
export function initDelayMs(raw: number): number {
  return (raw * 200) / 127;
}
/** Delay time for BOTH delay types: linear ms = raw / 10. The two differ in the
 *  RANGE they accept, not in how a raw reads. */
export function delayMs(raw: number): number {
  return raw / 10;
}
/** The Ping Pong spelling of the same law, kept so a descriptor names the type it
 *  belongs to rather than borrowing the other one's function. */
export function pingPongDelayMs(raw: number): number {
  return delayMs(raw);
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
/** How much longer than Hall a REV-X type runs at the same Reverb-Time raw. The unit's
 *  own maxima are the ratio: at Room Size 0 and raw 69 the LCD reads 10.3 s on Hall,
 *  15.2 s on Room and 17.6 s on Plate, and multiplying each by the Room Size scale of 3
 *  lands on the guide's per-type ceilings (31.0 / 45.3 / 52.0 s). The Room Size scale
 *  itself is type-independent. */
const REVX_TYPE_SCALE: Record<number, number> = { 0: 1, 1: 15.2 / 10.3, 2: 17.6 / 10.3 };

/** REV-X Reverb Time seconds for a Reverb-Time raw, the channel's Room Size raw and the
 *  selected type. Without the type this reads Hall's seconds for all three, which is
 *  short by a factor of 1.7 on Plate. */
export function revxTimeSec(raw: number, roomSizeRaw: number, type = 0): number {
  const scale = REVX_TYPE_SCALE[type] ?? 1;
  return REVX_TIME_UNIT * scale * revxTimeBaseUnits(raw) * Math.pow(3, roomSizeRaw / 31);
}

// Tempo-sync Note values (raw 0..14, short → long; 0 = off). Standard Yamaha list.
const FX_NOTE_OPTIONS = [
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

/** Hz value → "560 Hz" / "3.55 kHz". Shared with the inspector's SSMCS readouts and the
 *  channel EQ, so it is the app's own default rather than any one control's rule. */
export function formatHz(hz: number): string {
  if (hz >= 1000) return `${(hz / 1000).toFixed(2)} kHz`;
  return `${Math.round(hz)} Hz`;
}

/* The two FX filter families are printed to DIFFERENT precisions, and the app follows each
 * rather than the default above, because these rows name a setting the unit also displays.
 *
 *  band        FX1 (REV-X, R20)     FX2 (Rev.R3 / delay, R40)
 *  < 1 kHz     integer  22, 250     3 significant figures  21.2, 50.0, 315
 *  >= 1 kHz    3 s.f.   1.12k       3 s.f.                 8.00k, 16.0k
 *
 * The difference is the Hz band alone: FX1 drops the decimal that FX2 keeps. R20's grades
 * stay distinct as integers there (20 / 22 / 25 / 28 / 32 / 36) while R40's do not — 10.6 and
 * 11.2 would both read 11 — which is the shape of the two tables rather than a display quirk.
 *
 * `toPrecision(3)` is the three-figure half: it keeps the trailing zeros the unit shows
 * (50.0, 8.00k, 16.0k) that a fixed decimal count cannot give across bands. */
const threeFigures = (v: number): string => v.toPrecision(3);
/** REV-X filter frequency → the label the unit prints for it. */
export function formatFx1Hz(hz: number): string {
  return hz >= 1000 ? `${threeFigures(hz / 1000)} kHz` : `${Math.round(hz)} Hz`;
}
/** Rev.R3 / delay filter frequency → the label the unit prints for it. */
export function formatFx2Hz(hz: number): string {
  return hz >= 1000 ? `${threeFigures(hz / 1000)} kHz` : `${threeFigures(hz)} Hz`;
}
function formatSec(s: number): string {
  return `${s < 10 ? s.toFixed(2) : s.toFixed(1)} s`;
}
/** The FX2 / delay filters read THRU rather than a frequency at the ends of their
 *  windows — the HPF's bottom six raws and the LPF's top one. The official ranges
 *  spell that out and put the word on the end it belongs to: the HPF's is written
 *  "Thru, 21.2 Hz–8 kHz" and the LPF's "50 Hz–16 kHz, Thru". */
const FX2_HPF_THRU_TOP = 5;
const FX2_LPF_THRU = 122;
function fx2HpfLabel(raw: number): string {
  return raw <= FX2_HPF_THRU_TOP ? "THRU" : formatFx2Hz(fx2FreqHz(raw));
}
function fx2LpfLabel(raw: number): string {
  return raw >= FX2_LPF_THRU ? "THRU" : formatFx2Hz(fx2FreqHz(raw));
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

// An FX channel's families share ONE plan params map (nodeParams[id].fxEffect.params,
// keyed by `key`), so a key two families both use is one storage slot: switching the
// effect type hands whatever is stored there to the family that is now selected. Where
// the two families address different device slots — or the same slot under a different
// law (REV-X's HPF/LPF index the R20 preferred-number series, the delay family's the R40
// one, at different offsets) — a shared key therefore writes one family's value into
// the other's parameter, so those keys carry the family name. `reverbTime` is slot 7 in
// both reverb families, one device parameter, and stays shared. `label` is what the UI
// and i18n resolve, and is bare regardless.

// REV-X (FX1 reverbs). Slots from live calibration. Reverb Time display needs the
// Room Size sibling raw. Frequencies use the R20 table; ratios are raw/10.
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
    key: "revxInitialDelay",
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
    key: "revxDiffusion",
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
    key: "revxHpf",
    slot: 10,
    label: "hpf",
    control: "slider",
    rawMin: 0,
    rawMax: 52,
    rawStep: 1,
    def: 4,
    format: (r) => formatFx1Hz(revxFreqHz(r)),
  },
  {
    key: "revxLpf",
    slot: 11,
    label: "lpf",
    control: "slider",
    rawMin: 34,
    rawMax: 60,
    rawStep: 1,
    def: 50,
    format: (r) => formatFx1Hz(revxFreqHz(r)),
  },
  {
    key: "revxHiRatio",
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
    format: (r) => formatFx1Hz(revxFreqHz(r)),
  },
];

// Rev.R3 (FX2 reverbs). Frequencies use the R40 table; Feedback is signed raw.
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
    key: "revr3InitialDelay",
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
    key: "revr3HiRatio",
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
    key: "revr3Diffusion",
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
    key: "revr3Feedback",
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
    key: "revr3Hpf",
    slot: 15,
    label: "hpf",
    control: "slider",
    rawMin: 0,
    rawMax: 109,
    rawStep: 1,
    def: 29,
    format: (r) => fx2HpfLabel(r),
  },
  {
    key: "revr3Lpf",
    slot: 16,
    label: "lpf",
    control: "slider",
    rawMin: 21,
    rawMax: 122,
    rawStep: 1,
    def: 99,
    format: (r) => fx2LpfLabel(r),
  },
];

// Mono / Ping Pong Delay (both FX channels). The two encode the delay time the same
// way and differ in the RANGE they take — Mono 0.1–2700 ms, Ping Pong 1.0–1350 ms —
// so the delay-time slot is overridden for Ping Pong (see PINGPONG_DELAY_PARAMS).
// Note is only meaningful when Sync is on, and while Sync is on the UNIT owns the
// delay-time slot: it recomputes it from BPM and the note value and announces the
// result on the array address.
const DELAY_RAW_MAX_MONO = 27000; // 2700 ms × 10
const DELAY_RAW_MAX_PINGPONG = 13500; // 1350 ms × 10
const DELAY_RAW_MIN_PINGPONG = 10; // 1.0 ms × 10
/** Plan storage key for each delay type's time slot. Both types are family "delay"
 *  and both put the time on slot 6, so the family name does not separate them —
 *  only the type does, and it has to: the two accept different RANGES, so a Mono
 *  time above 1350 ms handed to a Ping Pong descriptor is clamped at the device
 *  while the plan goes on showing the value it was set to. Mono keeps the bare name
 *  (one type uses it); Ping Pong names itself. */
export const MONO_DELAY_KEY = "delay";
export const PINGPONG_DELAY_KEY = "pingPongDelay";
export const DELAY_PARAMS: FxParamDesc[] = [
  {
    key: MONO_DELAY_KEY,
    slot: 6,
    label: "delayTime",
    control: "slider",
    rawMin: 1,
    rawMax: DELAY_RAW_MAX_MONO,
    // The only step that puts both official ends and the factory default on the slider's
    // grid: 26999 and 4999 share no divisor above 1.
    rawStep: 1,
    def: 5000,
    format: (r) => formatMs(delayMs(r)),
  },
  {
    key: "delayFeedback",
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
    key: "delayHiRatio",
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
    key: "delayHpf",
    slot: 9,
    label: "hpf",
    control: "slider",
    rawMin: 0,
    rawMax: 109,
    rawStep: 1,
    def: 40,
    format: (r) => fx2HpfLabel(r),
  },
  {
    key: "delayLpf",
    slot: 10,
    label: "lpf",
    control: "slider",
    rawMin: 21,
    rawMax: 122,
    rawStep: 1,
    def: 110,
    format: (r) => fx2LpfLabel(r),
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

// Ping Pong shares the delay layout but its delay-time slot has its own law, range
// and storage key (see pingPongDelayMs); every other slot is identical to Mono Delay.
const PINGPONG_DELAY_PARAMS: FxParamDesc[] = DELAY_PARAMS.map((d) =>
  d.key === MONO_DELAY_KEY
    ? {
        ...d, // Mono delay slot (def 5000 = 500 ms here) with the Ping Pong law and range.
        key: PINGPONG_DELAY_KEY,
        rawMin: DELAY_RAW_MIN_PINGPONG,
        rawMax: DELAY_RAW_MAX_PINGPONG,
        rawStep: 10,
        format: (r) => formatMs(pingPongDelayMs(r)),
      }
    : d,
);

/** EFFECT TYPE value for Ping Pong Delay (shared by both FX channels). */
const PINGPONG_TYPE = 1025;

/**
 * The unit's own factory value for every descriptor slot, per EFFECT TYPE.
 *
 * The device keeps these PER TYPE, not per family: selecting a type refills the array
 * with that type's values. A family-wide table therefore shows one type's defaults on
 * all of them — and because `translate` writes a descriptor's `def` for any slot the
 * plan does not carry, it would also WRITE them, so a plan that had only ever selected
 * Ping Pong sent Mono Delay's four filter and feedback values to the hardware.
 *
 * Captured off a factory unit by cycling the selector through all five types per FX
 * channel; `reference/work/device-tests/fx-cycle-capture.json` is the capture and this
 * is its transcription. Keyed by SLOT so a row reads against that file directly.
 *
 * The same shape the insert-FX catalogue already takes for the two companders, whose
 * defaults are likewise all that separate them.
 */
export const FX_TYPE_DEFAULTS: Record<number, Record<number, number>> = {
  // FX1 — Rev-X. Slots 16/17 are internal and not in the descriptor list.
  0: { 7: 23, 8: 10, 9: 2, 10: 4, 11: 50, 12: 29, 13: 8, 14: 12, 15: 27, 18: 32 },
  1: { 7: 6, 8: 8, 9: 2, 10: 6, 11: 47, 12: 15, 13: 7, 14: 11, 15: 5, 18: 32 },
  2: { 7: 21, 8: 8, 9: 2, 10: 12, 11: 52, 12: 18, 13: 9, 14: 10, 15: 5, 18: 32 },
  // FX2 — Rev.R3.
  768: { 7: 15, 8: 25, 9: 7, 10: 7, 11: 3, 12: 0, 13: 1, 14: 55, 15: 29, 16: 99 },
  769: { 7: 13, 8: 2, 9: 4, 10: 7, 11: 1, 12: 0, 13: 2, 14: 48, 15: 39, 16: 111 },
  770: { 7: 17, 8: 12, 9: 9, 10: 6, 11: 2, 12: 0, 13: 0, 14: 63, 15: 41, 16: 111 },
  // Both FX channels — the two delays.
  1024: { 3: 120, 4: 0, 6: 5000, 7: 20, 8: 7, 9: 40, 10: 110, 11: 9 },
  1025: { 3: 120, 4: 0, 6: 5000, 7: 14, 8: 4, 9: 0, 10: 120, 11: 9 },
};

/** Parameter descriptors for an EFFECT TYPE: the family's shape, carrying that TYPE's
 *  own factory defaults — and, for REV-X, its own Reverb Time scale. Memoized because
 *  every emit, every readback and every inspector render asks for it. */
const FX_PARAMS_BY_TYPE = new Map<number, FxParamDesc[]>();
export function fxParams(type: number): FxParamDesc[] {
  const memo = FX_PARAMS_BY_TYPE.get(type);
  if (memo) return memo;
  const family = fxFamilyOf(type);
  const base =
    family === "revx"
      ? REVX_PARAMS
      : family === "revr3"
        ? REVR3_PARAMS
        : type === PINGPONG_TYPE
          ? PINGPONG_DELAY_PARAMS
          : DELAY_PARAMS;
  const defs = FX_TYPE_DEFAULTS[type];
  const out = base.map((d) => {
    const def = defs?.[d.slot] ?? d.def;
    // Reverb Time is the one display that cannot be written without knowing the type.
    const format =
      family === "revx" && d.key === "reverbTime"
        ? (r: number, c: Record<string, number>) => formatSec(revxTimeSec(r, c.roomSize ?? 31, type))
        : d.format;
    return def === d.def && format === d.format ? d : { ...d, def, format };
  });
  FX_PARAMS_BY_TYPE.set(type, out);
  return out;
}

/** The FX effect LEVEL's own bounds and default, which the emit spells as literals because no
 *  descriptor describes that slot. */
export const FX_LEVEL_MIN = 0;
export const FX_LEVEL_MAX = 100;
export const FX_LEVEL_DEFAULT = 100;

/** The raw the write path sends for one FX value: a leaf that is not a finite NUMBER takes the
 *  catalogue default, then the window bounds it.
 *
 *  `Number.isFinite` is the load-bearing half, and specifically NOT the global `isFinite`,
 *  which coerces: a plan may hold a boolean under a numeric key — the document sanitiser keeps
 *  booleans, since node params have toggles — and plain arithmetic reads `false` as 0, so a
 *  bound computed without this lands on the window's floor where the emit substitutes the
 *  default — for an FX level that is the difference between 0 and 100, which is the effect
 *  going silent. The `typeof` in front of it narrows `unknown` for the compiler and decides
 *  nothing at run time.
 *
 *  ONE seat, because the loader repairs a document to exactly what the emit would send, and two
 *  spellings of that rule are two answers to the same question. */
export function fxRawToSend(stored: unknown, def: number, lo?: number, hi?: number): number {
  const v = typeof stored === "number" && Number.isFinite(stored) ? stored : def;
  return Math.min(Math.max(v, lo ?? v), hi ?? v);
}

/** The keys that were shared across families before they carried a family name. */
const LEGACY_FX_PARAM_KEYS = ["initialDelay", "diffusion", "hpf", "lpf", "hiRatio", "feedback"] as const;

/** Re-key an FX channel's stored parameters onto the names the build that reads them
 *  addresses, in place. Run on load from core/plan.ts sanitizeNodeParams, which owns
 *  the document version; `fxIndex` is the node's FX channel (FX_CHANNEL_NODE_INDEX).
 *
 *  A plan saved before a key was qualified holds one value under the shared name and
 *  does not record which effect wrote it. Assigning it to the SAVED type reproduces
 *  exactly what the previous build emitted for that saved state, and differs only
 *  after a type switch. There is no information in the file to do better, and dropping
 *  the value is worse — the next flush would write a factory default over it.
 *
 *  A document with no `type` is not un-attributable: the channel's selector still has
 *  a value, the factory one (the pre-range builds wrote `params` alone whenever the
 *  operator changed a parameter without touching the EFFECT TYPE menu). It resolves
 *  through resolveFxEffectType like every other site, so a type the channel's own menu
 *  does not offer is read as that channel's factory type here and written as that type
 *  by translate.ts. A key the resolved type does not have is left as it is.
 *
 *  Two re-keyings, both under ONE gate — `< 2`:
 *   - the bare names several families shared (hpf / lpf / hiRatio …);
 *   - the delay time, when the saved type is Ping Pong.
 *
 *  One gate rather than two because both landed before any build that writes either
 *  shipped: the released app is version 1, so no document exists that needs them told
 *  apart. The boundary is the safety property, not a formality — from 2 on, a `delay`
 *  key beside a Ping Pong type is the MONO value parked under its own name, and a
 *  wider gate would re-key it onto a descriptor whose range stops at 13500, so a time
 *  the operator set above 1350 ms would be clamped at the device while the plan went
 *  on showing it, and translate would write the clamped value to the hardware. */
export function migrateFxEffectParams(
  fx: { type?: number; params?: Record<string, number> },
  fxIndex: number,
  version: number,
): void {
  const params = fx.params;
  if (!params) return;
  const type = resolveFxEffectType(fxIndex, fx.type);
  const owned = new Set(fxParams(type).map((d) => d.key));
  const rename = (from: string, to: string): void => {
    if (!(from in params) || !owned.has(to)) return;
    // The old key goes either way. It addresses nothing once the type owns another
    // name for that parameter, so leaving it would carry a value no build reads into
    // every later save of the plan.
    if (!(to in params)) params[to] = params[from];
    delete params[from];
  };
  if (version < 2) {
    const prefix: string = fxFamilyOf(type);
    for (const legacy of LEGACY_FX_PARAM_KEYS) {
      rename(legacy, prefix + legacy[0].toUpperCase() + legacy.slice(1));
    }
    // Both re-keyings ride the same version, because both landed before any build that
    // writes one shipped: the released app is version 1. From 2 on, a `delay` key beside
    // a Ping Pong type is the MONO value parked under its own name, so re-keying it then
    // would be the re-interpretation the split exists to prevent.
    rename(MONO_DELAY_KEY, PINGPONG_DELAY_KEY);
  }
}
