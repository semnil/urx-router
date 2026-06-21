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
  | "pan"
  | "bool"
  | "freq"
  | "enum"
  | "eqFreq"
  | "q"
  | "eqGain"
  | "centiDb"
  | "delayTime"
  | "phonesLevel"
  | "attackTime"
  | "holdTime"
  | "releaseTime"
  | "ratio"
  | "portRef"
  | "portRefTagged"
  | "insertFx"
  | "raw";

export interface ParamSpec {
  /** Broker param_id (first field of the "{id}:{x}:{y}" address). */
  id: number;
  axis: ParamAxis;
  encoding: ParamEncoding;
  /**
   * Writing this param makes the device reset dependent params as a side effect
   * (e.g. changing the COMP/EQ type clears the channel-strip section toggles).
   * A single write does not stick; callers must converge or re-read afterwards.
   */
  sideEffect?: true;
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
  COMP_EQ_TYPE: { id: 21, axis: "input", encoding: "enum", sideEffect: true },
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
  // SSMCS (Sweet Spot Morphing Channel Strip) bank, MONO IN only — active when
  // COMP_EQ_TYPE = SSMCS. Confirmed + calibrated by live LCD readback. The comp/EQ
  // section ON toggles reuse SSMCS_COMP_ON (94, inverted) / SSMCS_EQ_ON (106,
  // inverted) above. All continuous values are RAW broker integers (the device
  // curves are non-linear; vd.ts holds the display formatters). Sweet Spot Data
  // (param 91) is a string preset index the numeric IPC cannot carry, so it is
  // modeled in the plan/UI but deliberately NOT in this write catalog.
  /** SSMCS section ON (1 = on). */
  SSMCS_ON: { id: 89, axis: "input", encoding: "bool" },
  /** SSMCS Comp Drive (raw 0..200; display = raw/20). */
  SSMCS_COMP_DRIVE: { id: 95, axis: "input", encoding: "raw" },
  /** SSMCS Morphing position (raw 0..120). */
  SSMCS_MORPHING: { id: 93, axis: "input", encoding: "raw" },
  /** SSMCS Out Gain (raw 0..360; 180 = 0 dB). */
  SSMCS_OUT_GAIN: { id: 117, axis: "input", encoding: "raw" },
  /** SSMCS comp attack (raw 57..283; logarithmic 0.092..80 ms). */
  SSMCS_COMP_ATTACK: { id: 96, axis: "input", encoding: "raw" },
  /** SSMCS comp release (raw 24..300; logarithmic 9.3..999 ms). */
  SSMCS_COMP_RELEASE: { id: 97, axis: "input", encoding: "raw" },
  /** SSMCS comp ratio (raw 0..120; non-linear 1.0..∞:1). */
  SSMCS_COMP_RATIO: { id: 98, axis: "input", encoding: "raw" },
  /** SSMCS comp knee (0 = Soft / 1 = Medium / 2 = Hard). */
  SSMCS_COMP_KNEE: { id: 99, axis: "input", encoding: "enum" },
  /** SSMCS comp threshold (raw 0..200; device-internal, not on the LCD). */
  SSMCS_COMP_THRESHOLD: { id: 100, axis: "input", encoding: "raw" },
  /** SSMCS comp makeup (raw 0..200; device-internal, not on the LCD). */
  SSMCS_COMP_MAKEUP: { id: 101, axis: "input", encoding: "raw" },
  /** SSMCS comp side-chain ON (1 = on). */
  SSMCS_SC_ON: { id: 102, axis: "input", encoding: "bool" },
  /** SSMCS comp side-chain Q (raw 0..60). */
  SSMCS_SC_Q: { id: 103, axis: "input", encoding: "raw" },
  /** SSMCS comp side-chain frequency (raw 4..124). */
  SSMCS_SC_FREQ: { id: 104, axis: "input", encoding: "raw" },
  /** SSMCS comp side-chain gain (raw 0..360; 180 = 0 dB). */
  SSMCS_SC_GAIN: { id: 105, axis: "input", encoding: "raw" },
  /** SSMCS EQ Low band: ON / freq / gain (Low is shelving, no Q). */
  SSMCS_EQ_LOW_ON: { id: 107, axis: "input", encoding: "bool" },
  SSMCS_EQ_LOW_FREQ: { id: 108, axis: "input", encoding: "raw" },
  SSMCS_EQ_LOW_GAIN: { id: 109, axis: "input", encoding: "raw" },
  /** SSMCS EQ Mid band: ON / Q / freq / gain (Mid is peaking). */
  SSMCS_EQ_MID_ON: { id: 110, axis: "input", encoding: "bool" },
  SSMCS_EQ_MID_Q: { id: 111, axis: "input", encoding: "raw" },
  SSMCS_EQ_MID_FREQ: { id: 112, axis: "input", encoding: "raw" },
  SSMCS_EQ_MID_GAIN: { id: 113, axis: "input", encoding: "raw" },
  /** SSMCS EQ High band: ON / freq / gain (High is shelving, no Q). */
  SSMCS_EQ_HIGH_ON: { id: 114, axis: "input", encoding: "bool" },
  SSMCS_EQ_HIGH_FREQ: { id: 115, axis: "input", encoding: "raw" },
  SSMCS_EQ_HIGH_GAIN: { id: 116, axis: "input", encoding: "raw" },
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
  EQ_BAND_TYPE: { id: 504, axis: "global", encoding: "enum", sideEffect: true },
  /** Output PEQ band Q. */
  EQ_BAND_Q: { id: 505, axis: "global", encoding: "q" },
  /** Output PEQ band frequency. */
  EQ_BAND_FREQ: { id: 506, axis: "global", encoding: "eqFreq" },
  /** Output PEQ band gain. */
  EQ_BAND_GAIN: { id: 507, axis: "global", encoding: "eqGain" },
  // EQ 1-knob: ON / TYPE / LEVEL sit 2 / 3 / 4 params after each EQ-ON anchor
  // (mono 44, stereo 213, output STEREO 498, output MIX 591); the per-instance ids
  // are computed in translate.ts (eqOneKnob). These mono anchors only name the
  // command + encoding. Confirmed by live snapshot-diff.
  // All three recompute the 4-band PEQ on the device, so each is a sideEffect
  // (the live sync re-reads the snapshot after sending one).
  /** EQ 1-knob ON (1 = on). */
  EQ_ONE_KNOB_ON: { id: 46, axis: "input", encoding: "bool", sideEffect: true },
  /** EQ 1-knob preset type (0 Intensity / 1 Vocal / 2 Loudness). */
  EQ_ONE_KNOB_TYPE: { id: 47, axis: "input", encoding: "enum", sideEffect: true },
  /** EQ 1-knob effect depth (0 … 100 %, raw). */
  EQ_ONE_KNOB_LEVEL: { id: 48, axis: "input", encoding: "raw", sideEffect: true },
  /** Monitor level (y = monitor 0..3). Wider -96 dB floor than the fader. */
  MONITOR_LEVEL: { id: 724, axis: "global", encoding: "level" },
  /** PHONES output level (y0 = PHONES 1, y1 = PHONES 2): the unit-less 0.0..10.0
   *  scale of the Phones menu (NOT dB). Confirmed by live snapshot-diff. */
  PHONES_LEVEL: { id: 725, axis: "global", encoding: "phonesLevel" },
  /** STEREO master fader (y = 0, level down to -∞). */
  STEREO_MASTER_FADER: { id: 581, axis: "global", encoding: "level" },
  /** STEREO master ON (y = 0). */
  STEREO_MASTER_ON: { id: 582, axis: "global", encoding: "bool" },
  /** FX return channel ON (y = FX1 0 / FX2 1). The FX return reuses the input
   *  channel-strip layout one block earlier (139 fader / 140 ON / 141 pan ↔
   *  337 / 338 / 339); confirmed by live read (FX1/FX2 hold independent states). */
  FX_CHANNEL_ON: { id: 338, axis: "global", encoding: "bool" },
  /** Input source select for MONO CH1-4 (y = physical input slot 0..3). Raw input
   *  port ref. Param 22 only covers the mono slots; the device returns NONE for
   *  slots 4..11, so stereo channels use the separate 209/210 pair below. */
  INPUT_SOURCE: { id: 22, axis: "input", encoding: "portRef" },
  /** Stereo channel input source L / R (y = stereo pair index 0..3). Raw input
   *  port ref in the same physical-input namespace as param 22. Confirmed on
   *  URX44V by live snapshot (CH5/6 = AUX 256/257, CH7/8 = USB MAIN A 512/513,
   *  CH9/10 = USB MAIN B 514/515, CH11/12 = USB MAIN C 516/517). */
  STEREO_INPUT_SOURCE_L: { id: 209, axis: "global", encoding: "portRef" },
  STEREO_INPUT_SOURCE_R: { id: 210, axis: "global", encoding: "portRef" },
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
  // CH SETTING color (the node's top accent cap). The broker stores a palette
  // index (see COLOR_PALETTE), mirrored across separate params per node kind
  // (confirmed by live snapshot-diff). Input channels use param 20 at the input
  // slot index; the MIX/STEREO buses their own params at the fixed instances in
  // translate.ts (colorControl). raw = pass the palette index straight through.
  /** Mono input channel color (palette index), y = physical input slot 0..3. */
  CH_COLOR: { id: 20, axis: "input", encoding: "raw" },
  /** Stereo input channel color (palette index), y = stereo index 0..3. Stereo
   *  channels carry their CH SETTING on the stereo block, not the input slot. */
  STEREO_CH_COLOR: { id: 208, axis: "global", encoding: "raw" },
  /** MIX bus color (palette index), y = L/R-linked out instances. */
  MIX_COLOR: { id: 586, axis: "output", encoding: "raw" },
  /** STEREO master color (palette index), y = 0. */
  STEREO_COLOR: { id: 496, axis: "global", encoding: "raw" },
  /** FX bus color (palette index): FX1 = y0, FX2 = y1 (mono, no L/R mirror). */
  FX_COLOR: { id: 335, axis: "global", encoding: "raw" },
  /** STREAMING bus color (palette index), y = L/R-mirrored slots 0/1. */
  STREAM_COLOR: { id: 704, axis: "global", encoding: "raw" },
  /** STREAMING DELAY (the bus.stream node, y = 0): on/off, time (ms×100,
   *  1.00..1000.00 ms), frame rate (enum 0..7). Confirmed by live snapshot-diff. */
  STREAM_DELAY_ON: { id: 707, axis: "global", encoding: "bool" },
  STREAM_DELAY_TIME: { id: 708, axis: "global", encoding: "delayTime" },
  STREAM_DELAY_FRAME_RATE: { id: 830, axis: "global", encoding: "enum" },
} as const satisfies Record<string, ParamSpec>;

export type ParamName = keyof typeof PARAMS;

// Device CH SETTING color palette (input_ch / pad_color step list), in the
// broker's index order — the array position IS the palette index. The broker
// stores that index; urx-router keeps the matching hex in plan.nodeColors so a
// written color reads back to the same swatch. The hex are representative values
// that read on both themes (the device exposes only the name, not an RGB), tuned
// to the node-cap palette. Index 10 = Off = no cap (one past the array).
export const COLOR_PALETTE: { name: string; hex: string }[] = [
  { name: "Blue", hex: "#4a78c0" },
  { name: "Orange", hex: "#e8913a" },
  { name: "Yellow", hex: "#d9b441" },
  { name: "Purple", hex: "#8e6fc0" },
  { name: "Cyan", hex: "#3fa6a0" },
  { name: "Magenta", hex: "#c0628f" },
  { name: "Red", hex: "#d9534f" },
  { name: "Green", hex: "#5c9e64" },
  { name: "Light Green", hex: "#8ec46a" },
  { name: "White", hex: "#d8dce0" },
];
/** Broker palette index for the device "Off" (no color) state. */
export const COLOR_OFF_INDEX = 10;

/** Palette index → swatch hex, or null for Off / an unknown index (no cap). */
export function colorIndexToHex(index: number): string | null {
  return COLOR_PALETTE[index]?.hex ?? null;
}

/** Swatch hex → palette index, or null when the hex is not a palette entry. */
export function hexToColorIndex(hex: string): number | null {
  const lower = hex.toLowerCase();
  const i = COLOR_PALETTE.findIndex((c) => c.hex.toLowerCase() === lower);
  return i === -1 ? null : i;
}

/** Ids of the port-ref selectors (raw or tagged), derived from the registry. An
 *  unread selector address defaults to the broker's NONE sentinel, not 0. */
export const PORT_REF_PARAM_IDS: ReadonlySet<number> = new Set(
  Object.values(PARAMS)
    .filter((p) => p.encoding === "portRef" || p.encoding === "portRefTagged")
    .map((p) => p.id),
);

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

// SSMCS Sweet Spot Data presets (param 91 index 1..34 → .ssd name). Enumerated
// from the device: 6 generic 1-knob morph types + 28 artist / use-case presets.
// Labels are the device strings (the ".ssd" suffix the first two carry is dropped
// for display). Default is preset 1 (Basic). The index is written to the device
// as the zero-padded string "0001".."0034" — outside the numeric write catalog
// (see PARAMS), so this drives the plan/UI only.
export const SWEET_SPOT_DATA_DEFAULT = 1;
export const SWEET_SPOT_DATA_OPTIONS = [
  { value: 1, label: "01 Basic" },
  { value: 2, label: "02 Color" },
  { value: 3, label: "03 Tone" },
  { value: 4, label: "04 Sweep - Boost" },
  { value: 5, label: "05 Sweep - Cut" },
  { value: 6, label: "06 Lo Cut" },
  { value: 7, label: "01 AK Bass" },
  { value: 8, label: "02 AK Drums" },
  { value: 9, label: "03 AK Master" },
  { value: 10, label: "04 MZ A.Guitar" },
  { value: 11, label: "05 MZ Kick" },
  { value: 12, label: "06 MZ Snare" },
  { value: 13, label: "07 MZ Master" },
  { value: 14, label: "08 MR Vocal" },
  { value: 15, label: "09 MR Drums" },
  { value: 16, label: "10 MR Master" },
  { value: 17, label: "11 SH Piano" },
  { value: 18, label: "12 SH Drums" },
  { value: 19, label: "13 SH Master" },
  { value: 20, label: "14 OK Master - Vocal" },
  { value: 21, label: "15 OK Master - Bass" },
  { value: 22, label: "16 OK Master - Vigour" },
  { value: 23, label: "17 OK Master - TV" },
  { value: 24, label: "18 IO Vocal" },
  { value: 25, label: "19 IO A.Guitar" },
  { value: 26, label: "20 IO Drums" },
  { value: 27, label: "21 TK Notch - Resonation" },
  { value: 28, label: "22 TK Programmed Kick" },
  { value: 29, label: "23 TK Pumping" },
  { value: 30, label: "24 ZK Vocal" },
  { value: 31, label: "25 ZK Bass" },
  { value: 32, label: "26 ZK Drums" },
  { value: 33, label: "27 ZK Master" },
  { value: 34, label: "28 ZK Filter" },
];

/** Format the Sweet Spot Data index as the device's zero-padded string ("0001"). */
export function sweetSpotDataAddr(index: number): string {
  return String(index).padStart(4, "0");
}

// Rec Point: the per-channel signal-path tap fed to the channel's recording /
// direct out (block diagram: "Rec Point" selector -> CH OUT). Labels are the
// device CH SETTING strings (confirmed on device by user). MONO IN exposes all
// five stages; ST IN has only EQ, so it offers the two `stereo` options. Default
// PRE FADER on every channel. No confirmed control address, so not in the write
// catalog above.
export const REC_POINT_DEFAULT = 4;
export const REC_POINT_OPTIONS = [
  { value: 0, label: "PRE GATE", stereo: false },
  { value: 1, label: "PRE COMP", stereo: false },
  { value: 2, label: "PRE EQ", stereo: true },
  { value: 3, label: "PRE INS FX", stereo: false },
  { value: 4, label: "PRE FADER", stereo: true },
];

// BUS Type for MIX 1 / MIX 2 (CH SETTING): VARI = variable per-send level (the
// default, what the tool models), FIXED = a fixed send level (sends carry no
// adjustable level). Labels are the device strings. No confirmed control
// address, so not in the write catalog above.
export const BUS_TYPE_VARI = 0;
export const BUS_TYPE_FIXED = 1;
export const BUS_TYPE_OPTIONS = [
  { value: BUS_TYPE_VARI, label: "VARI" },
  { value: BUS_TYPE_FIXED, label: "FIXED" },
];

// Post Fader Send for FX (DAW Integration menu, V1.2+): the MIX bus whose
// post-fader signal feeds FX 1 / FX 2. Per-FX-bus selection; "—" = not used (the
// default outside DAW integration). MIX labels are device strings. No confirmed
// control address, so not in the write catalog above.
export const FX_POST_SOURCE_NONE = -1;
export const FX_POST_SOURCE_OPTIONS = [
  { value: FX_POST_SOURCE_NONE, label: "—" },
  { value: 1, label: "MIX 1" },
  { value: 2, label: "MIX 2" },
];

// Signal Type for a MONO IN pair (CH SETTING): STEREO links the two adjacent
// channels, MONO x 2 keeps them independent (the default). Device labels.
export const SIGNAL_TYPE_OPTIONS = [
  { value: 0, label: "MONO x 2" },
  { value: 1, label: "STEREO" },
];

// PAN / BAL mode shown for a STEREO-linked MONO IN pair. PAN = independent pan
// per channel; BAL = a shared L/R balance. Device labels.
export const PAN_BAL_PAN = 0;
export const PAN_BAL_BAL = 1;
export const PAN_BAL_OPTIONS = [
  { value: PAN_BAL_PAN, label: "PAN" },
  { value: PAN_BAL_BAL, label: "BAL" },
];

// Initial pan magnitude for a STEREO-linked pair in PAN mode: the odd channel
// hard-left (L63 = -63), the even channel hard-right (R63 = +63). BAL mode
// initializes to centre (0). Applied to every bus send when the mode is set.
export const STEREO_PAN_DEFAULT = 63;

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

// EQ 1-knob preset type (param at EQ-ON+3). The value is a shared enum across all
// EQ instances (0 = Intensity, 1 = Vocal, 2 = Loudness, confirmed by live
// snapshot-diff), but each screen exposes only the applicable subset: mono input
// channels offer Intensity / Vocal, stereo channels and output buses offer
// Intensity / Loudness. Default Intensity (0).
export const EQ_ONE_KNOB_TYPE_DEFAULT = 0;
export const EQ_ONE_KNOB_TYPE_MONO_OPTIONS = [
  { value: 0, label: "Intensity" },
  { value: 1, label: "Vocal" },
];
export const EQ_ONE_KNOB_TYPE_WIDE_OPTIONS = [
  { value: 0, label: "Intensity" },
  { value: 2, label: "Loudness" },
];

// COMP knee selector (device labels per user; 0 = Soft verified, default Medium).
export const COMP_KNEE_DEFAULT = 1;
export const COMP_KNEE_OPTIONS = [
  { value: 0, label: "Soft" },
  { value: 1, label: "Medium" },
  { value: 2, label: "Hard" },
];

// Oscillator mode (param 712). Frequency control applies to Sine Wave; Burst
// Noise adds width/interval (modeled in the plan layer; control addresses
// unconfirmed, so not in the write catalog above).
export const OSC_MODE_OPTIONS = [
  { value: 0, label: "Sine Wave" },
  { value: 1, label: "Pink Noise" },
  { value: 2, label: "Burst Noise" },
];
export const OSC_MODE_SINE = 0;
export const OSC_MODE_BURST = 2;

// STREAMING DELAY frame rate (param 830). The value is an index into this list,
// in the device's dropdown order (confirmed by live snapshot-diff: 30 = index 5,
// 120 = index 7). Labels are the literal LCD strings (D = drop frame). The frame
// rate only changes how the delay time is shown in frames; the delay is in ms.
export const DELAY_FRAME_RATE_OPTIONS = [
  { value: 0, label: "24" },
  { value: 1, label: "25" },
  { value: 2, label: "29.97D" },
  { value: 3, label: "29.97" },
  { value: 4, label: "30D" },
  { value: 5, label: "30" },
  { value: 6, label: "60" },
  { value: 7, label: "120" },
];
export const DELAY_FRAME_RATE_DEFAULT = 5;

// Digital-channel input gain (D.Gain) is NOT param 1 (the analog A.Gain): each
// stereo channel has its own dedicated, non-sequential param, written to both
// L/R instances (y = 0 and 1) which the device keeps linked. Keyed by node id so
// each model uses its own. Confirmed on URX44V by live scan (research §12.8);
// ch_5_6..9_10 assumed identical on URX44/URX22. The block is the five odd ids
// 9/11/13/15/17; URX44V occupies {9,13,15,17}, leaving 11 the only free slot, so
// ch_3_4 (URX22's extra stereo channel, absent on URX44V) most likely takes 11.
// Still an UNVERIFIED guess pending a URX22 owner's self-test, but — unlike the
// earlier guess of 5 — it no longer collides with a confirmed param (5 = CLIP_SAFE).
export const D_GAIN_PARAM: Record<string, number> = {
  ch_3_4: 11,
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

/** Reverse lookup of the confirmed catalog: the param that owns a param id, if
 *  any. The self-test's collision audit uses it to tell a guessed id apart from
 *  an id a confirmed param already claims. */
const ID_TO_NAME: ReadonlyMap<number, ParamName> = new Map(
  (Object.entries(PARAMS) as [ParamName, ParamSpec][]).map(([name, spec]) => [spec.id, name]),
);
export function paramNameForId(id: number): ParamName | undefined {
  return ID_TO_NAME.get(id);
}
