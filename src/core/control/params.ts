// Catalog of confirmed URX44V control parameters. Each entry binds a semantic
// name to the broker's numeric param_id, the instance axis its y index runs over,
// and the value encoding (see vd.ts). Only parameters validated against the
// broker dump (reference/.local/vd-params.md)
// are listed here; inferred-but-unconfirmed ids are deliberately omitted so live
// control never writes a guessed address to hardware.

/**
 * Instance dimension a parameter's y index addresses:
 *   input  — mixer input channel, y = 0..11
 *   output — mixer output, y = 0..7
 *   global — a single fixed slot or small fixed set (e.g. monitor y = 0..3)
 */
export type ParamAxis = "input" | "output" | "global";

/** Value encoding, mapping to the converters in vd.ts. */
export type ParamEncoding =
  | "level"
  | "gain"
  | "monitor"
  | "pan"
  | "bool"
  | "freq"
  | "enum"
  | "eqFreq"
  | "q"
  | "eqGain"
  | "centiDb"
  | "attackTime"
  | "holdTime"
  | "releaseTime"
  | "ratio"
  | "portRef"
  | "portRefTagged"
  | "insertFx";

export interface ParamSpec {
  /** Broker param_id (first field of the "{id}:{x}:{y}" address). */
  id: number;
  axis: ParamAxis;
  encoding: ParamEncoding;
}

// Confirmed anchors. Validated: their ids match both the original sniff and the
// /vd/parameters descriptor (table_id + min/max/default).
export const PARAMS = {
  /** Input channel main fader → STEREO (level_gain, default 0 dB). */
  CH_FADER: { id: 139, axis: "input", encoding: "level" },
  /** Input channel ON / mute (default ON). */
  CH_ON: { id: 140, axis: "input", encoding: "bool" },
  /** Input channel PAN/BAL (±63). */
  CH_PAN: { id: 141, axis: "input", encoding: "pan" },
  /** Input channel HPF ON. */
  HPF_ON: { id: 25, axis: "input", encoding: "bool" },
  /** Input channel HPF cutoff frequency (40 … 120 Hz). Confirmed by live scan. */
  HPF_FREQ: { id: 26, axis: "input", encoding: "freq" },
  /** Input channel COMP/EQ type: COMP->EQ vs SSMCS (MONO IN channels only). */
  COMP_EQ_TYPE: { id: 21, axis: "input", encoding: "enum" },
  // Channel-strip section ON toggles. GATE is MONO IN only and type-independent;
  // COMP/EQ are MONO IN only and SWAP param banks with the COMP/EQ type (the SSMCS
  // bank uses different ids and inverted polarity). EQ also exists on every stereo
  // channel. Polarity is mixed (verified by live scan), so the resolver carries
  // each toggle's onValue. (channelSections() picks the bank from the type.)
  /** MONO IN gate ON (1 = on; type-independent). */
  GATE_ON: { id: 28, axis: "input", encoding: "bool" },
  /** MONO IN compressor ON, COMP->EQ bank (1 = on). */
  COMP_ON: { id: 34, axis: "input", encoding: "bool" },
  /** MONO IN EQ ON, COMP->EQ bank (1 = on). */
  EQ_ON: { id: 44, axis: "input", encoding: "bool" },
  /** MONO IN compressor ON, SSMCS bank (0 = on, inverted). */
  SSMCS_COMP_ON: { id: 94, axis: "input", encoding: "bool" },
  /** MONO IN EQ ON, SSMCS bank (0 = on, inverted). */
  SSMCS_EQ_ON: { id: 106, axis: "input", encoding: "bool" },
  /** Stereo channel EQ ON (1 = on), indexed by stereo position. */
  STEREO_CH_EQ_ON: { id: 213, axis: "global", encoding: "bool" },
  // Input GATE / COMP detail values (MONO IN channels; COMP is the COMP->EQ bank,
  // type-independent GATE). Verified by live scan (research §12.26).
  /** GATE threshold (dB). */
  GATE_THRESHOLD: { id: 29, axis: "input", encoding: "centiDb" },
  /** GATE range / attenuation depth (dB). */
  GATE_RANGE: { id: 30, axis: "input", encoding: "centiDb" },
  /** GATE attack time (ms). */
  GATE_ATTACK: { id: 31, axis: "input", encoding: "attackTime" },
  /** GATE hold time (ms). */
  GATE_HOLD: { id: 32, axis: "input", encoding: "holdTime" },
  /** GATE decay time (ms). */
  GATE_DECAY: { id: 33, axis: "input", encoding: "releaseTime" },
  /** COMP threshold (dB). */
  COMP_THRESHOLD: { id: 35, axis: "input", encoding: "centiDb" },
  /** COMP ratio (N:1). */
  COMP_RATIO: { id: 36, axis: "input", encoding: "ratio" },
  /** COMP knee (0 = Soft / 1 = Medium / 2 = Hard). */
  COMP_KNEE: { id: 37, axis: "input", encoding: "enum" },
  /** COMP makeup gain (dB). */
  COMP_GAIN: { id: 38, axis: "input", encoding: "centiDb" },
  /** COMP attack time (ms). */
  COMP_ATTACK: { id: 39, axis: "input", encoding: "attackTime" },
  /** COMP release time (ms). */
  COMP_RELEASE: { id: 40, axis: "input", encoding: "releaseTime" },
  /** COMP Auto Makeup ON (auto-drives the makeup gain). */
  COMP_AUTO_MAKEUP: { id: 41, axis: "input", encoding: "bool" },
  /** COMP 1-knob ON (drives all comp params from the 1-knob level). */
  COMP_ONE_KNOB: { id: 42, axis: "input", encoding: "bool" },
  /** COMP 1-knob level (0 … 100, raw). */
  COMP_ONE_KNOB_LEVEL: { id: 43, axis: "input", encoding: "enum" },
  /** Ducker ON (sidechain; one per stereo channel, indexed by stereo position). */
  DUCKER_ON: { id: 258, axis: "global", encoding: "bool" },
  /** Ducker threshold (dB). */
  DUCKER_THRESHOLD: { id: 260, axis: "global", encoding: "centiDb" },
  /** Ducker range / attenuation depth (dB). */
  DUCKER_RANGE: { id: 261, axis: "global", encoding: "centiDb" },
  /** Ducker attack time (ms). */
  DUCKER_ATTACK: { id: 262, axis: "global", encoding: "attackTime" },
  /** Ducker decay time (ms). */
  DUCKER_DECAY: { id: 263, axis: "global", encoding: "releaseTime" },
  /** Input channel insert FX (MONO IN channels only). Enum from input_insert_fx. */
  INSERT_FX: { id: 135, axis: "input", encoding: "insertFx" },
  /** STEREO master insert FX (single). Enum from output_insert_fx. */
  OUTPUT_INSERT_FX_STEREO: { id: 578, axis: "global", encoding: "insertFx" },
  /** MIX bus insert FX (L/R-linked). Enum from output_insert_fx. */
  OUTPUT_INSERT_FX_MIX: { id: 671, axis: "output", encoding: "insertFx" },
  // Analog mic-strip toggles (CH1-4 only). Confirmed by live scan.
  /** Input channel +48V phantom power. */
  PHANTOM: { id: 0, axis: "input", encoding: "bool" },
  /** Input channel phase / polarity invert (Ø), mono mic channels. */
  PHASE: { id: 24, axis: "input", encoding: "bool" },
  // Stereo channels invert L/R independently, indexed by stereo position.
  /** Stereo channel L-side polarity invert. */
  PHASE_L: { id: 211, axis: "global", encoding: "bool" },
  /** Stereo channel R-side polarity invert. */
  PHASE_R: { id: 212, axis: "global", encoding: "bool" },
  /** Input channel Clip Safe (auto head-amp clip protection). */
  CLIP_SAFE: { id: 5, axis: "input", encoding: "bool" },
  /** Input channel Hi-Z (high-impedance instrument input; CH3/CH4 only). */
  HI_Z: { id: 6, axis: "input", encoding: "bool" },
  /** Input channel head-amp (HA) gain (-8 … +70 dB). */
  HA_GAIN: { id: 1, axis: "input", encoding: "gain" },
  /** Output (mix) fader level. */
  OUT_FADER: { id: 674, axis: "output", encoding: "level" },
  // CH → MIX/FX bus send. The actual ids are computed per channel/bus in
  // translate.ts; these anchors are the MIX1 mono slot and only name the command
  // + encoding.
  /** CH → bus send level. */
  SEND_LEVEL: { id: 146, axis: "input", encoding: "level" },
  /** CH → bus send pan (MIX only). */
  SEND_PAN: { id: 147, axis: "input", encoding: "pan" },
  /** CH → bus send ON. */
  SEND_ON: { id: 148, axis: "input", encoding: "bool" },
  /** CH → MIX send PRE/POST tap (single; 1 = PRE). */
  SEND_TAP: { id: 151, axis: "input", encoding: "bool" },
  /** Output (mix) EQ ON. */
  OUT_EQ_ON: { id: 591, axis: "output", encoding: "bool" },
  /** STEREO master EQ ON (single). */
  STEREO_EQ_ON: { id: 498, axis: "global", encoding: "bool" },
  // Output 4-band PEQ band values. The per-band/per-bus ids are computed in
  // translate.ts (outputEq); these anchors are the STEREO LOW band and only name
  // the command + encoding.
  /** Output PEQ band ON. */
  EQ_BAND_ON: { id: 503, axis: "global", encoding: "bool" },
  /** Output PEQ band filter type (LOW / HIGH bands only). */
  EQ_BAND_TYPE: { id: 504, axis: "global", encoding: "enum" },
  /** Output PEQ band Q. */
  EQ_BAND_Q: { id: 505, axis: "global", encoding: "q" },
  /** Output PEQ band frequency. */
  EQ_BAND_FREQ: { id: 506, axis: "global", encoding: "eqFreq" },
  /** Output PEQ band gain. */
  EQ_BAND_GAIN: { id: 507, axis: "global", encoding: "eqGain" },
  /** Monitor level (y = monitor 0..3). Wider -96 dB floor than the fader. */
  MONITOR_LEVEL: { id: 724, axis: "global", encoding: "monitor" },
  /** STEREO master fader (y = 0, level down to -∞). */
  STEREO_MASTER_FADER: { id: 581, axis: "global", encoding: "level" },
  /** STEREO master ON (y = 0). */
  STEREO_MASTER_ON: { id: 582, axis: "global", encoding: "bool" },
  /** Input source select (y = physical input slot 0..11). Raw input port ref. */
  INPUT_SOURCE: { id: 22, axis: "input", encoding: "portRef" },
  /** Ducker key source (y = stereo index). Raw port ref: channel slot or bus. */
  DUCKER_SRC: { id: 259, axis: "global", encoding: "portRef" },
  /** Monitor source select L/R (y = monitor 0..1). Raw bus port ref. */
  MONITOR_SRC_L: { id: 719, axis: "global", encoding: "portRef" },
  MONITOR_SRC_R: { id: 720, axis: "global", encoding: "portRef" },
  /** Monitor CUE interrupt (default on) / MONO (default off), y = monitor 0..1. */
  MONITOR_CUE_INTERRUPT: { id: 721, axis: "global", encoding: "bool" },
  MONITOR_MONO: { id: 722, axis: "global", encoding: "bool" },
  /** Analog output patch source L/R (y = 0/1). Raw bus port ref. */
  OUT_PATCH_MAIN: { id: 730, axis: "global", encoding: "portRef" },
  OUT_PATCH_LINE: { id: 731, axis: "global", encoding: "portRef" },
  /** Streaming source select L/R (y = 0). Tagged port ref (0x80000000 | port). */
  STREAM_SRC_L: { id: 705, axis: "global", encoding: "portRefTagged" },
  STREAM_SRC_R: { id: 706, axis: "global", encoding: "portRefTagged" },
  /** USB output source select (y = 0). Raw port ref: one bus or channel per out. */
  USB_OUT_SRC_A: { id: 732, axis: "global", encoding: "portRef" },
  USB_OUT_SRC_B: { id: 733, axis: "global", encoding: "portRef" },
  USB_OUT_SRC_C: { id: 734, axis: "global", encoding: "portRef" },
  USB_OUT_SRC_SUB: { id: 735, axis: "global", encoding: "portRef" },
  /** Oscillator generator (global). Level is centi-dB (-96..0); freq is Hz×10. */
  OSC_ON: { id: 710, axis: "global", encoding: "bool" },
  OSC_LEVEL: { id: 711, axis: "global", encoding: "centiDb" },
  OSC_MODE: { id: 712, axis: "global", encoding: "enum" },
  OSC_FREQ: { id: 713, axis: "global", encoding: "eqFreq" },
  /** Oscillator → bus assign on/off (per output channel). STEREO 716[L0,R1],
   *  MIX 717[MIX1 L0/R1, MIX2 L2/R3], FX 718[FX1 0, FX2 1]. */
  OSC_ASSIGN_STEREO: { id: 716, axis: "global", encoding: "bool" },
  OSC_ASSIGN_MIX: { id: 717, axis: "global", encoding: "bool" },
  OSC_ASSIGN_FX: { id: 718, axis: "global", encoding: "bool" },
} as const satisfies Record<string, ParamSpec>;

export type ParamName = keyof typeof PARAMS;

// Insert FX choices for MONO IN channels (input_insert_fx table). `value` is the
// broker enum value (not an index); -1 = No Effect (the "off" state). The broker
// reports "none" as the uint32 sentinel, normalized back to -1 on read.
export const INSERT_FX_NONE = -1;
const INSERT_FX_VD_NONE = 0xffffffff;
/**
 * Resource slot an insert FX consumes. Each slot is device-wide 1-of: only one
 * MONO IN channel can hold the guitar amp, Pitch Fix, or compander at a time
 * (user guide p.180: "Number of simultaneous uses: 1 slot"). No Effect = none.
 */
export type InsertFxSlot = "amp" | "pitch" | "compander" | "out-dyn";

export interface InsertFxOption {
  value: number;
  label: string;
  /** Highest sample rate (Hz) the effect supports; absent = no limit. */
  maxRate?: number;
  /** The 1-of-N device slot it occupies; absent = none (No Effect). */
  slot?: InsertFxSlot;
}
// Per-effect sample-rate ceilings (user guide p.180 Effect list): the guitar amps
// and companders run up to 96 kHz, Pitch Fix only up to 48 kHz, No Effect always.
export const INSERT_FX_OPTIONS: InsertFxOption[] = [
  { value: INSERT_FX_NONE, label: "No Effect" },
  { value: 256, label: "Clean", maxRate: 96000, slot: "amp" },
  { value: 257, label: "Crunch", maxRate: 96000, slot: "amp" },
  { value: 258, label: "Lead", maxRate: 96000, slot: "amp" },
  { value: 259, label: "Drive", maxRate: 96000, slot: "amp" },
  { value: 512, label: "Pitch Fix", maxRate: 48000, slot: "pitch" },
  { value: 1793, label: "Compander-H", maxRate: 96000, slot: "compander" },
  { value: 1794, label: "Compander-S", maxRate: 96000, slot: "compander" },
];

// Output-channel insert FX (output_insert_fx table): MULTI-BAND COMPRESSOR plus
// the two companders, all up to 96 kHz. They share ONE device-wide "out-dyn"
// slot across all output channels (MBC and the companders are mutually exclusive,
// user guide p.180), so only one MIX/STEREO output can hold one at a time.
export const OUTPUT_INSERT_FX_OPTIONS: InsertFxOption[] = [
  { value: INSERT_FX_NONE, label: "No Effect" },
  { value: 1792, label: "M.Band Comp", maxRate: 96000, slot: "out-dyn" },
  { value: 1793, label: "Compander-H", maxRate: 96000, slot: "out-dyn" },
  { value: 1794, label: "Compander-S", maxRate: 96000, slot: "out-dyn" },
];

/** Normalize a broker insert-FX value to the table's value (uint32 none → -1). */
export function normalizeInsertFx(raw: number): number {
  return raw === INSERT_FX_VD_NONE ? INSERT_FX_NONE : raw;
}

/** Encode a table insert-FX value for the broker (-1 → uint32 none sentinel), so
 *  a written value reads back identically. The inverse of normalizeInsertFx. */
export function denormalizeInsertFx(value: number): number {
  return value === INSERT_FX_NONE ? INSERT_FX_VD_NONE : value;
}

// COMP/EQ type (comp_eq_type table) for MONO IN channels: the standard COMP->EQ
// chain, or SSMCS (Sweet Spot Morphing Channel Strip, which swaps the comp/EQ
// order). Device labels match the table strings exactly.
export const COMP_EQ_COMP_FIRST = 0;
export const COMP_EQ_SSMCS = 1;
export const COMP_EQ_OPTIONS = [
  { value: COMP_EQ_COMP_FIRST, label: "COMP->EQ" },
  { value: COMP_EQ_SSMCS, label: "SSMCS" },
];

// Output 4-band PEQ filter type (LOW / HIGH bands only; the two mid bands are
// fixed Peaking). Verified by live scan: 0 = Peaking, 1 = Shelving, 2 = HPF on
// the LOW band and LPF on the HIGH band (device labels per user).
export const EQ_TYPE_PEAKING = 0;
export const EQ_TYPE_SHELVING = 1;
export const EQ_TYPE_PASS = 2;
export const EQ_TYPE_LOW_OPTIONS = [
  { value: EQ_TYPE_PEAKING, label: "Peaking" },
  { value: EQ_TYPE_SHELVING, label: "Shelving" },
  { value: EQ_TYPE_PASS, label: "HPF" },
];
export const EQ_TYPE_HIGH_OPTIONS = [
  { value: EQ_TYPE_PEAKING, label: "Peaking" },
  { value: EQ_TYPE_SHELVING, label: "Shelving" },
  { value: EQ_TYPE_PASS, label: "LPF" },
];

// COMP knee selector (device labels per user; 0 = Soft verified, default Medium).
export const COMP_KNEE_DEFAULT = 1;
export const COMP_KNEE_OPTIONS = [
  { value: 0, label: "Soft" },
  { value: 1, label: "Medium" },
  { value: 2, label: "Hard" },
];

// Oscillator mode (param 712). Frequency control applies to Sine Wave; Burst
// Noise adds width/interval (not yet modeled).
export const OSC_MODE_OPTIONS = [
  { value: 0, label: "Sine Wave" },
  { value: 1, label: "Pink Noise" },
  { value: 2, label: "Burst Noise" },
];
export const OSC_MODE_SINE = 0;

// Digital-channel input gain (D.Gain) is NOT param 1 (the analog A.Gain): each
// stereo channel has its own dedicated, non-sequential param, written to both
// L/R instances (y = 0 and 1) which the device keeps linked. Keyed by node id so
// each model uses its own. Confirmed on URX44V by live scan (research §12.8);
// ch_5_6..9_10 assumed identical on URX44/URX22, and ch_3_4 (URX22 only) is an
// UNVERIFIED guess (extrapolated -4 from ch_5_6=9).
export const D_GAIN_PARAM: Record<string, number> = {
  ch_3_4: 5,
  ch_5_6: 9,
  ch_7_8: 13,
  ch_9_10: 17,
  ch_11_12: 15,
};

// Stereo channels use a SEPARATE device block from mono channels: a single
// fader / ON / pan param indexed by stereo-channel position (0..N), not the mono
// params 139/140/141. Encodings match (level_gain / onoff / ±63). The index is
// the channel's position among the model's stereo channels (so it shifts with
// the mono count — e.g. URX22's first stereo channel is index 0). HPF does not
// exist on these channels. Confirmed on URX44V (research §12.9); URX44/URX22 inferred.
export const STEREO_FADER = 266;
export const STEREO_ON = 267;
export const STEREO_PAN = 268;
