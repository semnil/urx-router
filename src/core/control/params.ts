// Catalog of confirmed URX44V control parameters. Each entry binds a semantic
// name to the broker's numeric param_id and the value encoding (see vd.ts). Only
// parameters validated against the broker dump (reference/work/vd/vd-params.md)
// are listed here; inferred-but-unconfirmed ids are deliberately omitted so live
// control never writes a guessed address to hardware.

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
  | "gateRange"
  | "delayTime"
  | "phonesLevel"
  | "burstWidth"
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
  encoding: ParamEncoding;
  /**
   * Writing this param makes the device change other params as a side effect, so a
   * single write does not leave the snapshot equal to the device. Which repair is
   * needed depends on who owns the values the device just moved:
   *
   *   "converge" — the device reset values the PLAN authors (changing the COMP/EQ type
   *     clears the channel-strip toggles), so they have to be pushed back. The live
   *     sync runs a converge round over the write scope.
   *   "refetch"  — the device wrote values the plan only MIRRORS (the EQ 1-knob
   *     recomputes all four bands). Pushing would fight the device; the owner node is
   *     read back instead, so the plan — and the curve drawn from it — follows what the
   *     unit computed. A device-side change of the same parameter already takes this
   *     path through follow.ts; this is the same repair for our own write.
   */
  sideEffect?: "converge" | "refetch";
  /**
   * For a `"refetch"` head: the commands whose values the device recomputes from it, so a
   * converge sharing the same flush can be told to leave them alone.
   *
   * Needed because the two repairs collide. Both can land in one flush, the converge runs
   * first, and it makes the unit match the plan across the whole write scope — so an address
   * the plan still emits and the unit has just recomputed goes back at its pre-write value,
   * and the refetch that follows reads what the converge left. What remains is a unit holding
   * a morph position whose values belong to a different position, with nothing on screen to
   * say so.
   *
   * A refetch head needs this only where the plan AUTHORS the values it drives. Where the
   * plan merely mirrors them, the addresses leave the emit entirely while the head is engaged
   * (the EQ 1-knob's bands, `COMP_ONE_KNOB_DRIVEN`), which settles it earlier and better: an
   * address the plan never sends cannot be pushed back by anything. `SSMCS_MORPHING` cannot
   * take that route, because the inspector edits the strip's values directly.
   *
   * Scoped to the flush that wrote the head, and to that head's own node.
   */
  drives?: readonly string[];
  /**
   * Device-follow application strategy. "direct" marks a node-local scalar whose
   * incoming notify value can be decoded and written straight into the plan with
   * no read-back (fixed placement, no mode coupling, no dependent reset). Absent =
   * the safe default: a settled change re-reads the owner node (scoped readback),
   * so mode-gated, structural, and sideEffect params stay correct. See follow.ts.
   */
  follow?: "direct";
  /**
   * The device keeps this param as a device-wide setting, outside any scene
   * (SETUP > SAVE/RECALL leaves it as-is; measured via the scene recall audit,
   * Standard Mode). planToCommands drops these under the "scene" write scope;
   * the plan-level mirror of the same boundary is core/scene-scope.ts, and the
   * two are cross-checked by scene-scope.test.ts. OSC_ON has no .urxf
   * descriptor at all, so it was invisible to the file-diff audit; a one-item
   * recall measurement (URX44V, 2026-07-24: an OSC left ON survived recalling
   * an OSC-off scene) confirmed it is scene-external too.
   */
  sceneExternal?: true;
  /**
   * The parameter is not part of the plan at all: `planToCommands` never emits it
   * and no `readback.ts` group reads it, so `sceneExternal`'s write-scope filter is
   * inert for it. Its whole surface is a direct read/write pair — Follow USB in
   * `client.ts`, the SETUP > GENERAL settings in `device-setup.ts`. The flag is what
   * `device-setup.test.ts` derives its "never emitted" guarantee from, instead of a
   * hand-copied list that fails nothing when someone forgets to extend it.
   *
   * Every plan-external param is also scene-external (the device holds it outside
   * any scene), but not the reverse: SAMPLE_RATE is scene-external and emitted.
   */
  planExternal?: true;
}

// Confirmed anchors. Validated: their ids match both the original sniff and the
// /vd/parameters descriptor (table_id + min/max/default).
/**
 * The SSMCS strip values the device recomputes for you: every CONTINUOUS value in the
 * block, and none of the five ON switches (SC, EQ, and the three bands), which it leaves to
 * the operator. Measured address by address on a URX44V (2026-08-15).
 *
 * One list because TWO heads drive it — the Morphing position and the Sweet Spot Data preset
 * — and they were measured to drive the same seventeen. A second copy is the thing that
 * would rot: whichever head was edited last would be the one the converge believes.
 */
const SSMCS_STRIP_DRIVEN = [
  "SSMCS_COMP_ATTACK",
  "SSMCS_COMP_RELEASE",
  "SSMCS_COMP_RATIO",
  "SSMCS_COMP_KNEE",
  "SSMCS_COMP_THRESHOLD",
  "SSMCS_COMP_MAKEUP",
  "SSMCS_SC_Q",
  "SSMCS_SC_FREQ",
  "SSMCS_SC_GAIN",
  "SSMCS_EQ_LOW_FREQ",
  "SSMCS_EQ_LOW_GAIN",
  "SSMCS_EQ_MID_Q",
  "SSMCS_EQ_MID_FREQ",
  "SSMCS_EQ_MID_GAIN",
  "SSMCS_EQ_HIGH_FREQ",
  "SSMCS_EQ_HIGH_GAIN",
  "SSMCS_OUT_GAIN",
] as const;

export const PARAMS = {
  /** Input channel main fader → STEREO (level_gain, default 0 dB). */
  CH_FADER: { id: 139, encoding: "level", follow: "direct" },
  /** Input channel ON / mute (default ON). */
  CH_ON: { id: 140, encoding: "bool", follow: "direct" },
  /** Input channel → STEREO bus assign ON, post-fader (default ON). Independent of
   *  CH_ON (the channel master): this only gates the send into the STEREO main mix.
   *  Mono id 142; stereo channels use 269, FX channels 340 — all emitted under this
   *  one name (the id comes from channelControl / FX_STEREO_ASSIGN_ON). Added by
   *  firmware V1.3 (SEND TO STEREO [ON]); confirmed on URX44V (2026-06-30, LCD toggle
   *  → 142/269/340 track 1↔0; max=1 def=1, software write lands). */
  STEREO_ASSIGN_ON: { id: 142, encoding: "bool", follow: "direct" },
  /** Input channel PAN/BAL (±63). */
  CH_PAN: { id: 141, encoding: "pan", follow: "direct" },
  /** Input channel HPF ON. */
  HPF_ON: { id: 25, encoding: "bool" },
  /** Input channel HPF cutoff frequency (40 … 120 Hz). Confirmed by live scan. */
  HPF_FREQ: { id: 26, encoding: "freq" },
  /** Input channel COMP/EQ type: COMP->EQ vs SSMCS (MONO IN channels only). */
  COMP_EQ_TYPE: { id: 21, encoding: "enum", sideEffect: "converge" },
  // Channel-strip section ON toggles. GATE is MONO IN only and type-independent;
  // COMP/EQ are MONO IN only and SWAP param banks with the COMP/EQ type (the SSMCS
  // bank uses different ids and inverted polarity). EQ also exists on every stereo
  // channel. Polarity is mixed (verified by live scan), so the resolver carries
  // each toggle's onValue. (channelSections() picks the bank from the type.)
  /** MONO IN gate ON (1 = on; type-independent). */
  GATE_ON: { id: 28, encoding: "bool" },
  /** MONO IN compressor ON, COMP->EQ bank (1 = on). */
  COMP_ON: { id: 34, encoding: "bool" },
  /** MONO IN EQ ON, COMP->EQ bank (1 = on). */
  EQ_ON: { id: 44, encoding: "bool" },
  /** MONO IN compressor ON, SSMCS bank (0 = on, inverted). */
  SSMCS_COMP_ON: { id: 94, encoding: "bool" },
  /** MONO IN EQ ON, SSMCS bank (0 = on, inverted). */
  SSMCS_EQ_ON: { id: 106, encoding: "bool" },
  /** Stereo channel EQ ON (1 = on), indexed by stereo position. */
  STEREO_CH_EQ_ON: { id: 213, encoding: "bool" },
  // SSMCS (Sweet Spot Morphing Channel Strip) bank, MONO IN only — active when
  // COMP_EQ_TYPE = SSMCS. Confirmed + calibrated by live LCD readback. The comp/EQ
  // section ON toggles reuse SSMCS_COMP_ON (94, inverted) / SSMCS_EQ_ON (106,
  // inverted) above. All continuous values are RAW broker integers (the device
  // curves are non-linear; vd.ts holds the display formatters). Sweet Spot Data
  // (param 91, SWEET_SPOT_DATA below) is a string preset index the numeric IPC
  // cannot carry, so it has a catalog entry but rides the string-write path
  // (planToNameWrites / vd_set_str), not the numeric VdCommand path.
  /** SSMCS section ON (1 = on). */
  SSMCS_ON: { id: 89, encoding: "bool" },
  /** SSMCS Comp Drive (raw 0..200; display = raw/20). NOT a sideEffect: it changes what the
   *  compressor does with the threshold, and leaves every strip value where it is. Measured
   *  the same way as the morph below and in the same run (2026-08-15, URX44V): a 60-step
   *  write announced nothing beside its own echo and moved no address in the block. */
  SSMCS_COMP_DRIVE: { id: 95, encoding: "raw" },
  /** SSMCS Morphing position (raw 0..120). A "refetch", for the same reason the EQ
   *  1-knob is one and measured the same way (2026-08-14, URX44V): writing it makes the
   *  unit recompute the strip's runtime values and announce them 21 ms later — seventeen
   *  addresses across 96…117, block-wise rather than by delta, three of them carrying
   *  values that did not change. Those are the plan's to mirror rather than to author, so
   *  pushing back would undo the morph; two of them are the comp's ratio and knee, which
   *  a converge would send in their pre-morph state with nothing on screen to say so.
   *
   *  `drives` is that measured set, re-taken address by address (2026-08-15): every
   *  CONTINUOUS value in the strip, and none of the five ON switches (SC, EQ, and the three
   *  bands), which the morph leaves to the operator. The plan authors these as well — the
   *  inspector edits them — so the emit gate the two 1-knobs use is not available here and
   *  the converge has to be told instead. */
  SSMCS_MORPHING: {
    id: 93,
    encoding: "raw",
    sideEffect: "refetch",
    drives: SSMCS_STRIP_DRIVEN,
  },
  /** SSMCS Out Gain (raw 0..360; 180 = 0 dB). */
  SSMCS_OUT_GAIN: { id: 117, encoding: "raw" },
  /** SSMCS comp attack (raw 57..283; logarithmic 0.092..80 ms). */
  SSMCS_COMP_ATTACK: { id: 96, encoding: "raw" },
  /** SSMCS comp release (raw 24..300; logarithmic 9.3..999 ms). */
  SSMCS_COMP_RELEASE: { id: 97, encoding: "raw" },
  /** SSMCS comp ratio (raw 0..120; non-linear 1.0..∞:1). */
  SSMCS_COMP_RATIO: { id: 98, encoding: "raw" },
  /** SSMCS comp knee (0 = Soft / 1 = Medium / 2 = Hard). */
  SSMCS_COMP_KNEE: { id: 99, encoding: "enum" },
  /** SSMCS comp threshold (raw 0..200; device-internal, not on the LCD). */
  SSMCS_COMP_THRESHOLD: { id: 100, encoding: "raw" },
  /** SSMCS comp makeup (raw 0..200; device-internal, not on the LCD). */
  SSMCS_COMP_MAKEUP: { id: 101, encoding: "raw" },
  /** SSMCS comp side-chain ON (1 = on). */
  SSMCS_SC_ON: { id: 102, encoding: "bool" },
  /** SSMCS comp side-chain Q (raw 0..60). */
  SSMCS_SC_Q: { id: 103, encoding: "raw" },
  /** SSMCS comp side-chain frequency (raw 4..124). */
  SSMCS_SC_FREQ: { id: 104, encoding: "raw" },
  /** SSMCS comp side-chain gain (raw 0..360; 180 = 0 dB). */
  SSMCS_SC_GAIN: { id: 105, encoding: "raw" },
  /** SSMCS EQ Low band: ON / freq / gain (Low is shelving, no Q). */
  SSMCS_EQ_LOW_ON: { id: 107, encoding: "bool" },
  SSMCS_EQ_LOW_FREQ: { id: 108, encoding: "raw" },
  SSMCS_EQ_LOW_GAIN: { id: 109, encoding: "raw" },
  /** SSMCS EQ Mid band: ON / Q / freq / gain (Mid is peaking). */
  SSMCS_EQ_MID_ON: { id: 110, encoding: "bool" },
  SSMCS_EQ_MID_Q: { id: 111, encoding: "raw" },
  SSMCS_EQ_MID_FREQ: { id: 112, encoding: "raw" },
  SSMCS_EQ_MID_GAIN: { id: 113, encoding: "raw" },
  /** SSMCS EQ High band: ON / freq / gain (High is shelving, no Q). */
  SSMCS_EQ_HIGH_ON: { id: 114, encoding: "bool" },
  SSMCS_EQ_HIGH_FREQ: { id: 115, encoding: "raw" },
  SSMCS_EQ_HIGH_GAIN: { id: 116, encoding: "raw" },
  // Input GATE / COMP detail values (MONO IN channels; COMP is the COMP->EQ bank,
  // type-independent GATE). Verified by live scan (research §12.26).
  /** GATE threshold (dB). */
  GATE_THRESHOLD: { id: 29, encoding: "centiDb" },
  /** GATE range / attenuation depth (dB). */
  GATE_RANGE: { id: 30, encoding: "gateRange" },
  /** GATE attack time (ms). */
  GATE_ATTACK: { id: 31, encoding: "attackTime" },
  /** GATE hold time (ms). */
  GATE_HOLD: { id: 32, encoding: "holdTime" },
  /** GATE decay time (ms). */
  GATE_DECAY: { id: 33, encoding: "releaseTime" },
  /** COMP threshold (dB). */
  COMP_THRESHOLD: { id: 35, encoding: "centiDb" },
  /** COMP ratio (N:1). */
  COMP_RATIO: { id: 36, encoding: "ratio" },
  /** COMP knee (0 = Soft / 1 = Medium / 2 = Hard). */
  COMP_KNEE: { id: 37, encoding: "enum" },
  /** COMP makeup gain (dB). */
  COMP_GAIN: { id: 38, encoding: "centiDb" },
  /** COMP attack time (ms). */
  COMP_ATTACK: { id: 39, encoding: "attackTime" },
  /** COMP release time (ms). */
  COMP_RELEASE: { id: 40, encoding: "releaseTime" },
  /** COMP Auto Makeup ON (auto-drives the makeup gain). */
  COMP_AUTO_MAKEUP: { id: 41, encoding: "bool" },
  // The COMP 1-knob drives the values in COMP_ONE_KNOB_DRIVEN below, and the unit announces
  // the recomputation: measured on a URX44V (2026-08), turning it ON moved 35 / 36 / 37 / 38
  // and a level change afterwards moved 35 / 36 / 38 again, every one of them within 0.13 ms
  // of the written address's own notify and none ahead of it. So both are a "refetch" for
  // the same reason the EQ 1-knob is — the plan mirrors those values while the knob is on,
  // and pushing them back would fight the device.
  /** COMP 1-knob ON (drives all comp params from the 1-knob level). */
  COMP_ONE_KNOB: { id: 42, encoding: "bool", sideEffect: "refetch" },
  /** COMP 1-knob level (0 … 100, raw). */
  COMP_ONE_KNOB_LEVEL: { id: 43, encoding: "enum", sideEffect: "refetch" },
  /** Ducker ON (sidechain; one per stereo channel, indexed by stereo position). */
  DUCKER_ON: { id: 258, encoding: "bool" },
  /** Ducker threshold (dB). */
  DUCKER_THRESHOLD: { id: 260, encoding: "centiDb" },
  /** Ducker range / attenuation depth (dB). */
  DUCKER_RANGE: { id: 261, encoding: "centiDb" },
  /** Ducker attack time (ms). */
  DUCKER_ATTACK: { id: 262, encoding: "attackTime" },
  /** Ducker decay time (ms). */
  DUCKER_DECAY: { id: 263, encoding: "releaseTime" },
  /** Input channel insert FX (MONO IN channels only). Enum from input_insert_fx.
   *  sideEffect: selecting an effect (re)binds + repopulates its engine parameter
   *  array on the device, so live must converge (re-read then re-apply the plan's
   *  effect params). See control/insert-fx-effect.ts. */
  INSERT_FX: { id: 135, encoding: "insertFx", sideEffect: "converge" },
  /** Input channel insert FX ON/OFF (bypass) — independent of the selector (135).
   *  The device auto-engages it whenever an effect is (re)selected, so translate
   *  emits it after the selector and after the engine values it applies to, to
   *  enforce the plan's state. Confirmed by notify
   *  reverse-lookup (LCD INS FX button). */
  INSERT_FX_ON: { id: 134, encoding: "bool" },
  /** Input channel Rec Point: the signal-path tap fed to the recording / direct
   *  out (enum 0..4, PRE GATE..PRE FADER). Confirmed by live snapshot-diff
   *  (MONO CH1 4 → 0). MONO IN channels, on the input slot y. */
  REC_POINT: { id: 137, encoding: "enum" },
  /** Stereo channel Rec Point (same enum as 137), indexed by stereo position —
   *  part of the 264-268 block parallel to mono 137-141. Confirmed by notify
   *  reverse-lookup (LCD CH5/6 PRE FADER → PRE EQ fired 264:0:0 = 4 ↔ 2). */
  REC_POINT_STEREO: { id: 264, encoding: "enum" },
  /** STEREO master insert FX (single). Enum from output_insert_fx. sideEffect:
   *  rebinds + repopulates the output engine array (see INSERT_FX). */
  OUTPUT_INSERT_FX_STEREO: { id: 578, encoding: "insertFx", sideEffect: "converge" },
  /** STEREO master insert FX ON/OFF (single; bypass, auto-engaged on selection — see INSERT_FX_ON). */
  OUTPUT_INSERT_FX_ON_STEREO: { id: 577, encoding: "bool" },
  /** MIX bus insert FX (L/R-linked). Enum from output_insert_fx. sideEffect: as above. */
  OUTPUT_INSERT_FX_MIX: { id: 671, encoding: "insertFx", sideEffect: "converge" },
  /** MIX bus insert FX ON/OFF (L/R-linked; bypass, auto-engaged on selection — see INSERT_FX_ON). */
  OUTPUT_INSERT_FX_ON_MIX: { id: 670, encoding: "bool" },
  // Analog mic-strip toggles (CH1-4 only). Confirmed by live scan.
  /** Input channel +48V phantom power. */
  PHANTOM: { id: 0, encoding: "bool" },
  /** Input channel phase / polarity invert (Ø), mono mic channels. */
  PHASE: { id: 24, encoding: "bool" },
  // Stereo channels invert L/R independently, indexed by stereo position.
  /** Stereo channel L-side polarity invert. */
  PHASE_L: { id: 211, encoding: "bool" },
  /** Stereo channel R-side polarity invert. */
  PHASE_R: { id: 212, encoding: "bool" },
  /** Input channel Clip Safe (auto head-amp clip protection). */
  CLIP_SAFE: { id: 5, encoding: "bool" },
  /** Input channel Hi-Z (high-impedance instrument input; CH3/CH4 only). */
  HI_Z: { id: 6, encoding: "bool" },
  /** Input channel head-amp (HA) gain (-8 … +70 dB). */
  HA_GAIN: { id: 1, encoding: "gain", follow: "direct" },
  /** Output (mix) fader level. */
  OUT_FADER: { id: 674, encoding: "level", follow: "direct" },
  /** MIX bus master balance (676, fader+2, parallel to STEREO_MASTER_BAL 583). The
   *  bus output's L/R balance; ±63, default 0. L/R-linked per stereo MIX (MIX1 [0,1]
   *  / MIX2 [2,3]). Confirmed live (snapshot-diff: MIX1 balance → 676:0:0/0:1, and
   *  the device keeps the BALANCE label even under Pan Link). */
  OUT_MASTER_BAL: { id: 676, encoding: "pan", follow: "direct" },
  /** MIX bus BUS Type: 0 = VARI (variable per-send level) / 1 = FIXED. L/R-linked
   *  (written to both out instances). Confirmed by live snapshot-diff (MIX1 0 → 1). */
  BUS_TYPE: { id: 587, encoding: "enum" },
  /** MIX bus master ON (675, fader+1, parallel to STEREO_MASTER_ON 582). L/R-linked
   *  per stereo MIX (MIX1 [0,1] / MIX2 [2,3]); default 1. Independent of the MIX →
   *  STEREO "TO ST" send. Confirmed by live readback (device-side MIX2 OFF → 675). */
  OUT_MASTER_ON: { id: 675, encoding: "bool", follow: "direct" },
  /** MIX 1/2 → STEREO "TO ST" send ON/OFF. Per stereo MIX, addressed at the bus's
   *  L instance (MIX1 = 0, MIX2 = 2); not L/R-linked. Default 0 (off). Confirmed by
   *  live param-notify (device-side MIX1 OFF → ON fired 677:0:0 = 1, MIX2 → 677:0:2).
   *  Held in the MIX → STEREO connection's params.on, not a node param. */
  TO_ST: { id: 677, encoding: "bool", follow: "direct" },
  /** MIX bus Pan Link (VARI only): each send's pan follows the source channel PAN.
   *  Per stereo MIX, at the bus's L instance (MIX1 = 0, MIX2 = 2). Default 0 (off).
   *  Confirmed by live param-notify (MIX1 OFF → ON fired 589:0:0 = 1, MIX2 → 589:0:2). */
  PAN_LINK: { id: 589, encoding: "bool", follow: "direct" },
  /** Signal Type stereo link for a MONO IN pair (1 = STEREO, 0 = MONO x2). Written
   *  to BOTH channels of the pair at their input indices. Enabling it resets the
   *  secondary channel's whole state on the device (it is copied from the primary),
   *  so live must converge. Confirmed by live param-notify (CH1 MONO x2 ↔ STEREO
   *  fired 23:0:0 and 23:0:1 together). */
  SIGNAL_TYPE: { id: 23, encoding: "bool", sideEffect: "converge" },
  /** PAN / BAL mode for a STEREO-linked MONO IN pair (0 = PAN, 1 = BAL), at the
   *  pair's primary channel input index. Switching mode rewrites the pair's pan
   *  values on the device, so live must converge. Confirmed by live param-notify
   *  (CH1/CH2 pair BAL → PAN fired 891:0:0 = 0).
   *  translate.ts emits this ahead of CH_PAN and the send pans, so the same flush
   *  already re-sends every pan the switch slammed: the converge is now a net for a
   *  side effect reaching further than measured, not the repair the pans rely on. It
   *  stays until the PAN-ward side effect is measured exhaustively. */
  PAN_BAL: { id: 891, encoding: "enum", sideEffect: "converge" },
  /** SSMCS Sweet Spot Data preset index (MONO IN, SSMCS mode), at the channel input
   *  index. A 4-digit zero-padded STRING ("0001".."0034"; "0035"+ clamps to "0001"), so it
   *  rides the string-write path (vd_set_str / vd_get_str) rather than the numeric one.
   *  Confirmed by live read (91:0:0 = "0001").
   *
   *  A `"refetch"` head, and the first one on the string path. Selecting a preset recomputes
   *  the strip: measured on a URX44V (2026-08-15), a preset write announces the seventeen
   *  addresses `drives` names below, and its own address IS announced FIRST — 0.319 ms ahead
   *  of them with none in between — so the settle boundary every other refetch head ends on
   *  works here unchanged.
   *
   *  `drives` is the same seventeen `SSMCS_MORPHING` drives and NOT `93`. The announcement is
   *  block-wise, so `93` arrives with the burst whatever it holds; with Morphing parked at 62
   *  before the write it was announced as 62 and read back as 62, so a preset does not move
   *  it. (Two earlier runs called it a reset from an announcement taken while Morphing was
   *  already 0 — the same mistake the COMP knee produced, in the same block.)
   *
   *  Without the declaration the plan is not left unrepaired — device-follow takes the changed
   *  dependents and reconciles (follow.ts) — but a converge running before that reconcile
   *  reads a plan still holding pre-preset values and writes them back, undoing the preset.
   *  That race is what the declaration closes, the same way `SSMCS_MORPHING`'s does. */
  SWEET_SPOT_DATA: {
    id: 91,
    encoding: "raw",
    sideEffect: "refetch",
    drives: SSMCS_STRIP_DRIVEN,
  },
  // CH → MIX/FX bus send. The actual ids are computed per channel/bus in
  // translate.ts; these anchors are the MIX1 mono slot and only name the command
  // + encoding.
  /** CH → bus send level. */
  SEND_LEVEL: { id: 146, encoding: "level" },
  /** CH → bus send pan (MIX only). */
  SEND_PAN: { id: 147, encoding: "pan" },
  /** CH → bus send ON. */
  SEND_ON: { id: 148, encoding: "bool" },
  /** CH → MIX send PRE/POST tap (single; 1 = PRE). */
  SEND_TAP: { id: 151, encoding: "bool" },
  /** Output (mix) EQ ON. */
  OUT_EQ_ON: { id: 591, encoding: "bool" },
  /** STEREO master EQ ON (single). */
  STEREO_EQ_ON: { id: 498, encoding: "bool" },
  // Output 4-band PEQ band values. The per-band/per-bus ids are computed in
  // translate.ts (outputEq); these anchors are the STEREO LOW band and only name
  // the command + encoding.
  /** Output PEQ band ON. */
  EQ_BAND_ON: { id: 503, encoding: "bool" },
  /** Output PEQ band filter type (LOW / HIGH bands only). Not a sideEffect: measured
   *  on all four EQ instances (mono CH 44, stereo CH 213, MIX 591, STEREO 498), on both
   *  bands that own a type slot, cycling all three values over a curve authored to be
   *  distinctive in every slot — nothing but the type param itself ever moved. It was
   *  flagged on the assumption that retyping a band resets its other slots. */
  EQ_BAND_TYPE: { id: 504, encoding: "enum" },
  /** Output PEQ band Q. */
  EQ_BAND_Q: { id: 505, encoding: "q" },
  /** Output PEQ band frequency. */
  EQ_BAND_FREQ: { id: 506, encoding: "eqFreq" },
  /** Output PEQ band gain. */
  EQ_BAND_GAIN: { id: 507, encoding: "eqGain" },
  // EQ 1-knob: ON / TYPE / LEVEL sit 2 / 3 / 4 params after each EQ-ON anchor
  // (mono 44, stereo 213, output STEREO 498, output MIX 591); the per-instance ids
  // are computed in translate.ts (eqOneKnob). These mono anchors only name the
  // command + encoding. Confirmed by live snapshot-diff.
  // All three recompute the 4-band PEQ on the device. That is a "refetch", not a
  // "converge": the plan does not author those band values while 1-knob is on (translate
  // skips them), so there is nothing to push back — what is needed is to read what the
  // unit computed, or the response curve drawn from the plan stays on the manual curve
  // the operator last authored. The band addresses are not in the notify registration
  // either (the plan stops emitting them), so nothing announces the recomputation.
  /** EQ 1-knob ON (1 = on). */
  EQ_ONE_KNOB_ON: { id: 46, encoding: "bool", sideEffect: "refetch" },
  /** EQ 1-knob preset type (0 Intensity / 1 Vocal / 2 Loudness). */
  EQ_ONE_KNOB_TYPE: { id: 47, encoding: "enum", sideEffect: "refetch" },
  /** EQ 1-knob effect depth (0 … 100 %, raw). */
  EQ_ONE_KNOB_LEVEL: { id: 48, encoding: "raw", sideEffect: "refetch" },
  /** Monitor output ON (y = monitor 0..3). Confirmed by live snapshot-diff: the
   *  MONITOR screen [ON] button toggles 723 on the touched monitor's slot only. */
  MONITOR_ON: { id: 723, encoding: "bool", follow: "direct", sceneExternal: true },
  /** Monitor level (y = monitor 0..3). Wider -96 dB floor than the fader. */
  MONITOR_LEVEL: { id: 724, encoding: "level", follow: "direct", sceneExternal: true },
  /** PHONES output level (y0 = PHONES 1, y1 = PHONES 2): the unit-less 0.0..10.0
   *  scale of the Phones menu (NOT dB). Confirmed by live snapshot-diff. */
  PHONES_LEVEL: { id: 725, encoding: "phonesLevel", follow: "direct", sceneExternal: true },
  /** STEREO master fader (y = 0, level down to -∞). */
  STEREO_MASTER_FADER: { id: 581, encoding: "level", follow: "direct" },
  /** STEREO master ON (y = 0). */
  STEREO_MASTER_ON: { id: 582, encoding: "bool", follow: "direct" },
  /** STEREO master balance (y = 0): the STEREO output's L/R balance, ±63, default 0.
   *  Parallel to the fader (581) / ON (582) block. Confirmed live (snapshot-diff:
   *  STEREO balance → 583:0:0, positive = R). */
  STEREO_MASTER_BAL: { id: 583, encoding: "pan", follow: "direct" },
  /** FX channel ON (y = FX1 0 / FX2 1). The FX channel reuses the input
   *  channel-strip layout one block earlier (139 fader / 140 ON / 141 pan ↔
   *  337 / 338 / 339); confirmed by live read (FX1/FX2 hold independent states). */
  FX_CHANNEL_ON: { id: 338, encoding: "bool", follow: "direct" },
  /** FX channel master fader = the fixed FX channel → STEREO send level (the FX
   *  channel's main path, mirroring CH_FADER for channels). y = FX1 0 / FX2 1. */
  FX_CHANNEL_FADER: { id: 337, encoding: "level", follow: "direct" },
  /** FX channel balance = the fixed FX channel → STEREO send pan. y = FX1 0 / FX2 1. */
  FX_CHANNEL_BAL: { id: 339, encoding: "pan", follow: "direct" },
  /** FX channel EFFECT TYPE selector (anchor = FX1 679; FX2 683). Writing it makes
   *  the device repopulate the effect parameter array with that effect's defaults,
   *  so it is a sideEffect (live converges + re-reads). Per-FX id resolved in
   *  translate.ts; values are the fx1_insert_fx / fx2_insert_fx enums. */
  FX_EFFECT_TYPE: { id: 679, encoding: "enum", sideEffect: "converge" },
  /** FX channel effect parameter array (anchor = FX1 681; FX2 685). Addressed by
   *  SLOT on the y axis (not an instance); slot meaning depends on the effect type.
   *  Raw broker integers (see control/fx-effect.ts). Per-FX id + slot resolved in
   *  translate.ts. */
  FX_EFFECT_PARAM: { id: 681, encoding: "raw" },
  /** Insert-FX effect parameter array (anchor = Guitar engine 697; the actual
   *  engine 689/693/697/701 is resolved per effect family in translate.ts).
   *  Addressed by SLOT on the y axis; raw broker integers (see
   *  control/insert-fx-effect.ts). Calibrated on a factory URX44V. */
  INSERT_FX_EFFECT: { id: 697, encoding: "raw" },
  /**
   * The two engine slots that are CONTROLS over the rest of the array rather than values
   * in it — the multi-band compressor's 1-Knob (its switch and its level) and Pitch Fix's
   * MIDI Control. Same array and same encoding as INSERT_FX_EFFECT; a separate name
   * because a name is what carries the side effect.
   *
   * `refetch` rather than `converge`: writing either makes the UNIT recompute slots the
   * plan only mirrors — eighteen of them for the 1-Knob, the scale and the twelve-note mask
   * for MIDI Control — so the owner node is read back instead of being pushed. Pushing
   * would put the pre-change values over what the unit just derived, and the writer
   * suppresses those slots for exactly that reason; without the read, the plan keeps its
   * stale copy, shows it on the screen and sends it the moment the control is switched off.
   * This is the treatment COMP_ONE_KNOB already has, for the same shape of control.
   *
   * The id is the guitar engine, as the anchor above: the engine a command carries is
   * resolved per family and passed explicitly.
   */
  INSERT_FX_DRIVER: { id: 697, encoding: "raw", sideEffect: "refetch" },
  /** Input source select for MONO CH1-4 (y = physical input slot 0..3). Raw input
   *  port ref. Param 22 only covers the mono slots; the device returns NONE for
   *  slots 4..11, so stereo channels use the separate 209/210 pair below. */
  INPUT_SOURCE: { id: 22, encoding: "portRef" },
  /** Stereo channel input source L / R (y = stereo pair index 0..3). Raw input
   *  port ref in the same physical-input namespace as param 22. Confirmed on
   *  URX44V by live snapshot (CH5/6 = AUX 256/257, CH7/8 = USB MAIN A 512/513,
   *  CH9/10 = USB MAIN B 514/515, CH11/12 = USB MAIN C 516/517). */
  STEREO_INPUT_SOURCE_L: { id: 209, encoding: "portRef" },
  STEREO_INPUT_SOURCE_R: { id: 210, encoding: "portRef" },
  /** Ducker key source (y = stereo index). Raw port ref: channel slot or bus. */
  DUCKER_SRC: { id: 259, encoding: "portRef" },
  /** Monitor source select L/R (y = monitor 0..1). Raw bus port ref. */
  MONITOR_SRC_L: { id: 719, encoding: "portRef", sceneExternal: true },
  MONITOR_SRC_R: { id: 720, encoding: "portRef", sceneExternal: true },
  /** Monitor CUE interrupt (default on) / MONO (default off), y = monitor 0..1. */
  MONITOR_CUE_INTERRUPT: { id: 721, encoding: "bool", sceneExternal: true },
  MONITOR_MONO: { id: 722, encoding: "bool", sceneExternal: true },
  /** Analog output patch source L/R (y = 0/1). Raw bus port ref. */
  OUT_PATCH_MAIN: { id: 730, encoding: "portRef", sceneExternal: true },
  OUT_PATCH_LINE: { id: 731, encoding: "portRef", sceneExternal: true },
  /** Streaming source select L/R (y = 0). Tagged port ref (0x80000000 | port). */
  STREAM_SRC_L: { id: 705, encoding: "portRefTagged", sceneExternal: true },
  STREAM_SRC_R: { id: 706, encoding: "portRefTagged", sceneExternal: true },
  /** USB output source select (y = 0 and 1, the L/R pair). Raw port ref: one bus
   *  or channel per out. The device allocates 2 slots per selector and both are
   *  written (ROUTING_SELECTORS in translate.ts). */
  USB_OUT_SRC_A: { id: 732, encoding: "portRef", sceneExternal: true },
  USB_OUT_SRC_B: { id: 733, encoding: "portRef", sceneExternal: true },
  USB_OUT_SRC_C: { id: 734, encoding: "portRef", sceneExternal: true },
  USB_OUT_SRC_SUB: { id: 735, encoding: "portRef", sceneExternal: true },
  /** Oscillator generator (global). Level is centi-dB (-96..0); freq is Hz×10. */
  OSC_ON: { id: 710, encoding: "bool", follow: "direct", sceneExternal: true },
  OSC_LEVEL: { id: 711, encoding: "centiDb", follow: "direct", sceneExternal: true },
  OSC_MODE: { id: 712, encoding: "enum", sceneExternal: true },
  OSC_FREQ: { id: 713, encoding: "eqFreq", sceneExternal: true },
  /** Oscillator Burst Noise width (length of noise; Burst mode only). Plan holds
   *  seconds 0.1..10, broker raw is ms (= seconds ×1000, 100..10000). Confirmed by
   *  live snapshot-diff (0.1 s → 0.2 s = 100 → 200). */
  OSC_BURST_WIDTH: { id: 714, encoding: "burstWidth", sceneExternal: true },
  /** Oscillator Burst Noise interval (noise cycle, seconds; Burst mode only). Raw
   *  1..30, no scaling. Confirmed by live snapshot-diff (1 → 2). */
  OSC_BURST_INTERVAL: { id: 715, encoding: "raw", sceneExternal: true },
  /** Oscillator → bus assign on/off (per output channel). STEREO 716[L0,R1],
   *  MIX 717[MIX1 L0/R1, MIX2 L2/R3], FX 718[FX1 0, FX2 1]. */
  OSC_ASSIGN_STEREO: { id: 716, encoding: "bool", sceneExternal: true },
  OSC_ASSIGN_MIX: { id: 717, encoding: "bool", sceneExternal: true },
  OSC_ASSIGN_FX: { id: 718, encoding: "bool", sceneExternal: true },
  // CH SETTING color (the node's top accent cap). The broker stores a palette
  // index (see COLOR_PALETTE), mirrored across separate params per node kind
  // (confirmed by live snapshot-diff). Input channels use param 20 at the input
  // slot index; the MIX/STEREO buses their own params at the fixed instances in
  // translate.ts (colorControl). raw = pass the palette index straight through.
  /** Mono input channel color (palette index), y = physical input slot 0..3. */
  CH_COLOR: { id: 20, encoding: "raw" },
  /** Stereo input channel color (palette index), y = stereo index 0..3. Stereo
   *  channels carry their CH SETTING on the stereo block, not the input slot. */
  STEREO_CH_COLOR: { id: 208, encoding: "raw" },
  /** MIX bus color (palette index), y = L/R-linked out instances. */
  MIX_COLOR: { id: 586, encoding: "raw" },
  /** STEREO master color (palette index), y = 0. */
  STEREO_COLOR: { id: 496, encoding: "raw" },
  /** FX bus color (palette index): FX1 = y0, FX2 = y1 (mono, no L/R mirror). */
  FX_COLOR: { id: 335, encoding: "raw" },
  /** STREAMING bus color (palette index). The device allocates 8 slots and mirrors
   *  the value across all of them; the app writes the L/R pair 0/1. */
  STREAM_COLOR: { id: 704, encoding: "raw", sceneExternal: true },
  /** STREAMING DELAY (the bus.stream node, y = 0): on/off, time (ms×100,
   *  1.00..1000.00 ms), frame rate (enum 0..7). Confirmed by live snapshot-diff. */
  STREAM_DELAY_ON: { id: 707, encoding: "bool", sceneExternal: true },
  STREAM_DELAY_TIME: { id: 708, encoding: "delayTime", sceneExternal: true },
  STREAM_DELAY_FRAME_RATE: { id: 830, encoding: "enum", sceneExternal: true },
  /** Mixer DSP / USB streaming sample rate (global, y0): raw Hz. Writing it
   *  re-clocks the hardware (confirmed by live write + host coreaudio + LCD).
   *  843 mirrors it read-only and auto-follows, so only 766 is written. Not in
   *  /vd/synchronize|device|setup — a /vd/parameters value. Re-clocking
   *  re-negotiates the USB audio stream (audio glitches), so this is an explicit
   *  edit, never perturbed by self-test (plan.sampleRate is a top-level scalar,
   *  outside the perturb walk over nodeParams/connections). */
  SAMPLE_RATE: { id: 766, encoding: "raw", sceneExternal: true },
  /** SETUP > Follow USB (global, y0): when ON the device slaves its clock to the
   *  USB host, so a 766 write is accepted and re-clocks but is dragged back to the
   *  host's rate ~0.4 s later (measured on URX44V; the LCD shows the switch, then
   *  the rate reverts). Factory default ON. Readable and writable in both
   *  directions. Deliberately NOT part of the plan or planToCommands: it is a
   *  device-side clock policy, not a routing choice, and emitting it would make
   *  every Live-sync flush re-assert it. The write path reads it as a pre-check and
   *  the badge writes it with a single vdSet. */
  FOLLOW_USB: { id: 848, encoding: "bool", sceneExternal: true, planExternal: true },
  /** microSD Rec per-track record-source assign (y = track 0..15). Raw port ref in
   *  the bus/channel namespace (CH n = its input slot, STEREO = 256/257, MIX1 =
   *  288/289, MIX2 = 290/291, none = the uint32 sentinel). Writable + readable.
   *  Each stereo pair fills two adjacent tracks (L then R). Confirmed by live
   *  snapshot-diff on URX44V. */
  SD_REC_SOURCE: { id: 736, encoding: "portRef", sceneExternal: true },
  /** microSD Rec Track Count (y = 0): how many tracks record, raw = tracks / 2
   *  (raw 1..8 = 2..16). Read back, never emitted — not because the write is
   *  ignored (it is not: raw 0 reaches the unit and leaves its Track Count screen
   *  with nothing selected) but because of the range. The dump mislabels it
   *  onoff / min 0 / max 1 while the live value goes to 8, and the broker
   *  enforces that wrong max: raw 2, 4 and 8 are refused with 400. The only
   *  reachable settings are raw 1 (two tracks) and the meaningless raw 0, so a
   *  write could only ever lower the unit to two tracks and could not raise it
   *  again — the front panel would have to. */
  SD_REC_TRACK_COUNT: { id: 839, encoding: "raw", sceneExternal: true },

  // ---- SETUP > GENERAL: device-wide utility settings -----------------------
  // These are catalogued here because PARAMS is the one place an address may be
  // written down, but NONE of them is emitted by planToCommands or read by
  // readback. They belong to the unit, not to a routing plan: a plan travels
  // between units as a file, a recent-files entry and a share URL, and writing
  // one absolutely would push the author's screen brightness, menu language,
  // power-off timer and knob assignments onto someone else's hardware. They also
  // sit outside the self-test's perturbation walk, which nudges scalars by +1 —
  // brightness 10 and the auto-power-off timer are exactly the values that must
  // not be nudged. core/control/device-setup.ts owns reading and writing them,
  // through the Follow USB (848) shape: bare vdGet / vdSet, no diff engine.
  /** SETUP > Brightness > Screen (global, y0): raw 1..10, 1:1 with the readout.
   *  The dump's min is 0, which the unit's own range never offers; the app clamps
   *  to 1 rather than testing what a 0 does to a screen it cannot un-blank. */
  BRIGHTNESS: { id: 758, encoding: "raw", sceneExternal: true, planExternal: true },
  /** SETUP > Power Management > Auto Power Off [Enable] (global, y0). Factory ON;
   *  the dump's default_value 0 is wrong (measured against a factory-init file). */
  AUTO_POWER_OFF: { id: 760, encoding: "bool", sceneExternal: true, planExternal: true },
  /** Auto Power Off [Time] (global, y0): raw minutes, 2..20, default 20. The dump's
   *  max is 255, which the unit's own knob never reaches. */
  AUTO_POWER_OFF_TIME: { id: 761, encoding: "raw", sceneExternal: true, planExternal: true },
  /** SETUP > Peripheral > HDMI > HDCP [Enable] (global, y0). URX44V only. */
  HDMI_HDCP: { id: 767, encoding: "bool", sceneExternal: true, planExternal: true },
  /** SETUP > Peripheral > HDMI > [Input Audio Channels] (global, y0):
   *  0 = 2 Channels (48 kHz ceiling), 1 = Multi Channels (up to 192 kHz / 8 ch,
   *  down-mixed to stereo inside the mixer). URX44V only. This setting — not the
   *  incoming signal — is what moves the HDMI rate ceiling. */
  HDMI_INPUT_CHANNELS: { id: 768, encoding: "enum", sceneExternal: true, planExternal: true },
  /** SETUP > User Defined Knobs (y = bank 0..3 × knob A..D, i.e. 0..15): the
   *  Function / Parameter 1 / Parameter 2 triple, as strings. The device performs
   *  no validation — it stores whatever is written, verbatim — so the writer owns
   *  the exact user-guide spelling, and the three are always written together. */
  UDK_FUNCTION: { id: 770, encoding: "raw", sceneExternal: true, planExternal: true },
  UDK_PARAM1: { id: 771, encoding: "raw", sceneExternal: true, planExternal: true },
  UDK_PARAM2: { id: 772, encoding: "raw", sceneExternal: true, planExternal: true },
  /** SETUP > Date/Time > [Display Format] Date (global, y0): 0 = MM/DD/YYYY,
   *  1 = DD/MM/YYYY, 2 = YYYY/MM/DD. URX44V and URX44 (the URX22 has no
   *  Date/Time menu — it has no microSD recorder for the clock to stamp). */
  DATE_FORMAT: { id: 787, encoding: "enum", sceneExternal: true, planExternal: true },
  /** [Display Format] Time (global, y0): 0 = 24h, 1 = 12h. */
  TIME_FORMAT: { id: 788, encoding: "enum", sceneExternal: true, planExternal: true },
  /** SETUP > Date/Time > [Time Zone] (global, y0): an index into the unit's city
   *  list (see control/timezones.ts). The broker stores an out-of-range index
   *  verbatim instead of clamping, so the app is what keeps the value in range.
   *  785 holds the city name for the panel but is a display mirror the panel alone
   *  updates — never write it, and never read it back to confirm a write. */
  TIME_ZONE: { id: 831, encoding: "raw", sceneExternal: true, planExternal: true },
  /** SETUP > Language (global, y0): 0 = English, 1 = Japanese, 2 = Chinese
   *  (Simplified). The value sticks immediately, but the unit's own screen may not
   *  repaint in the new language until Language is touched on the panel once. */
  DEVICE_LANGUAGE: { id: 795, encoding: "enum", sceneExternal: true, planExternal: true },
  /** SETUP > Peripheral > USB Main > [Generic Driver Audio Channel Suppression]
   *  (global, y0): 0 = None, 1 = 2 Channels (limits a generic-driver host such as
   *  an iPad to 2 in / 2 out). */
  USB_SUPPRESSION: { id: 812, encoding: "enum", sceneExternal: true, planExternal: true },
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
/** The catalog names the unit announces an insert-FX change on — every route's selector
 *  and bypass, plus the Signal Type whose transition clears both members of a pair. The
 *  set exists because two clearings are indistinguishable in a read's own values and are
 *  not indistinguishable in the notify stream: measured on a URX44V, a Signal Type
 *  transition announces the selector and the bypass on both members, while a sample-rate
 *  excursion past an effect's ceiling announces the rate and nothing else. A route the
 *  unit announced therefore had a cause of its own. */
export const INSERT_FX_ANNOUNCED: ReadonlySet<ParamName> = new Set<ParamName>([
  "INSERT_FX",
  "INSERT_FX_ON",
  "OUTPUT_INSERT_FX_STEREO",
  "OUTPUT_INSERT_FX_ON_STEREO",
  "OUTPUT_INSERT_FX_MIX",
  "OUTPUT_INSERT_FX_ON_MIX",
  "SIGNAL_TYPE",
]);

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
// Per-effect sample-rate ceilings (user guide, Appendix > Effect list): the guitar amps
// and companders run up to 96 kHz, Pitch Fix only up to 48 kHz, No Effect always. The
// same table's "Number of simultaneous uses" row is what `slot` encodes. Cited by
// section rather than page: the list moved from p.180 to p.184 between C0 and D0.
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
// Listed in the order the unit offers them, which is the two companders and then the
// multi-band compressor.
export const OUTPUT_INSERT_FX_OPTIONS: InsertFxOption[] = [
  { value: INSERT_FX_NONE, label: "No Effect" },
  { value: 1793, label: "Compander-H", maxRate: 96000, slot: "out-dyn" },
  { value: 1794, label: "Compander-S", maxRate: 96000, slot: "out-dyn" },
  { value: 1792, label: "M.B.Comp", maxRate: 96000, slot: "out-dyn" },
];

/** True when the insert-FX option is selectable at the given sample rate. */
export function insertFxAvailable(option: InsertFxOption, sampleRate: number): boolean {
  return option.maxRate === undefined || sampleRate <= option.maxRate;
}

/** True when a node has an insert effect selected (whatever the bypass switch).
 *  The ON/OFF switch only applies while one is — see insertFxEngaged. */
export function insertFxSelected(np: { insertFx?: number } | undefined): boolean {
  return np?.insertFx != null && np.insertFx !== INSERT_FX_NONE;
}

/** True when a node's insert effect is selected and not bypassed (absent
 *  `insertFxOn` = engaged, matching the device's auto-engage on selection). */
export function insertFxEngaged(np: { insertFx?: number; insertFxOn?: boolean } | undefined): boolean {
  return insertFxSelected(np) && np?.insertFxOn !== false;
}

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
// as the zero-padded string "0001".."0034" — via the string-write path, not the
// numeric write catalog (see SWEET_SPOT_DATA in PARAMS).
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

// A CH SETTING name is bounded by what the unit lets anyone type into it: its own
// text-input screen takes at most **8 characters** (`ch 1xxxx`). Nothing else in the
// stack enforces that. Measured on a URX44V (2026-08-14): the broker accepts and
// stores a 20-character name and a 4-character Japanese one, and reads both back
// unchanged; their descriptors publish no bound at all (empty min/max); and the
// unit's settings file holds the name in a 64-byte NUL-padded ASCII element, which
// is the container, not the limit. Reading the container as the limit is the mistake
// this constant replaces — a 63-character name is writable, and it drew a node label
// that ran across its neighbours on the canvas.
//
// Counted in code points, so a name stays within what the unit's own screen could
// have produced whatever the script. 8 of any script fits the 64-byte element.
export const NODE_NAME_MAX_CHARS = 8;

// Rec Point: the per-channel signal-path tap fed to the channel's recording /
// direct out (block diagram: "Rec Point" selector -> CH OUT). Labels are the
// device CH SETTING strings (confirmed on device by user). MONO IN exposes all
// five stages; ST IN has only EQ, so it offers the two `stereo` options. Default
// PRE FADER on every channel. In SSMCS mode the device drops PRE EQ from the
// list (the morphing strip has no discrete EQ stage) and moves a selected PRE EQ
// tap to PRE COMP on the switch (confirmed on device). Control addresses: MONO IN
// = param 137 (in axis, live snapshot-diff), stereo channels = the parallel
// param 264 at the stereo index (notify reverse-lookup) — see REC_POINT /
// REC_POINT_STEREO in PARAMS.
export const REC_POINT_DEFAULT = 4;
export const REC_POINT_PRE_COMP = 1;
export const REC_POINT_PRE_EQ = 2;
export const REC_POINT_OPTIONS = [
  { value: 0, label: "PRE GATE", stereo: false },
  { value: REC_POINT_PRE_COMP, label: "PRE COMP", stereo: false },
  { value: REC_POINT_PRE_EQ, label: "PRE EQ", stereo: true },
  { value: 3, label: "PRE INS FX", stereo: false },
  { value: 4, label: "PRE FADER", stereo: true },
];

// BUS Type for MIX 1 / MIX 2 (CH SETTING): VARI = variable per-send level (the
// default, what the tool models), FIXED = a fixed send level (sends carry no
// adjustable level). Labels are the device strings. Control address = param 587
// (out axis, L/R-linked), confirmed by live snapshot-diff (see BUS_TYPE in PARAMS).
export const BUS_TYPE_VARI = 0;
export const BUS_TYPE_FIXED = 1;
export const BUS_TYPE_OPTIONS = [
  { value: BUS_TYPE_VARI, label: "VARI" },
  { value: BUS_TYPE_FIXED, label: "FIXED" },
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
/** Band defaults, shown before a fetch and used wherever a slot is unset. In the catalog
 *  because they are the device's, and because `eqBandFields` (translate.ts) builds the
 *  band's field table from them beside the GATE/COMP/DUCKER tables. */
export const EQ_BAND_DEFAULT_FREQ_HZ = [125, 1000, 4000, 10000];
export const EQ_Q_DEFAULT = 0.71;

// EQ 1-knob preset type (param at EQ-ON+3): a shared enum across every EQ instance,
// and every instance offers all three. This was previously recorded as a per-screen
// subset (mono = Intensity/Vocal, stereo and output = Intensity/Loudness); that was
// wrong. The unit's own mono EQ screen lists all three, confirmed on a URX44V with
// the current value at Intensity so the list was not merely showing an out-of-menu
// value, and the user guide's mono EQ page says as much ("changing the 1-knob type to
// [Vocal] or [Loudness]"). The claim came from misreading a level reset: writing any
// TYPE forces LEVEL to that type's neutral point (Intensity 50 = unity, the presets
// 0 = flat), which an earlier probe read as the device refusing the preset.
export const EQ_ONE_KNOB_TYPE_DEFAULT = 0;
export const EQ_ONE_KNOB_TYPE_OPTIONS = [
  { value: 0, label: "Intensity" },
  { value: 1, label: "Vocal" },
  { value: 2, label: "Loudness" },
];
/** Alias kept for the emit path's enum validation, which reads as "every legal
 *  value" at its call site. */
export const EQ_ONE_KNOB_TYPE_ALL_OPTIONS = EQ_ONE_KNOB_TYPE_OPTIONS;
/** EQ 1-knob LEVEL raw range (%). */
export const EQ_ONE_KNOB_LEVEL_MIN = 0;
export const EQ_ONE_KNOB_LEVEL_MAX = 100;

// COMP knee selector (device labels per user; 0 = Soft verified, default Medium).
export const COMP_KNEE_DEFAULT = 1;
export const COMP_KNEE_OPTIONS = [
  { value: 0, label: "Soft" },
  { value: 1, label: "Medium" },
  { value: 2, label: "Hard" },
];

/**
 * The COMP values the device's 1-knob owns while it is on, by their `NodeParams.comp` key.
 *
 * One list with two consumers, which must not be allowed to disagree: `translate.ts` stops
 * EMITTING these (a value the plan re-sends after the knob computed it puts the operator's
 * pre-knob copy back on the unit), and the COMP tuning screen locks and tags the same rows.
 * A screen that says "the device owns this" over a writer that keeps sending it is the
 * defect either copy drifting produces.
 *
 * Confirmed on a URX44V (2026-08): switching the knob on moved all four (the knee Soft ->
 * Medium); moving the level afterwards moved the first three and left the knee where the
 * knob had put it. Attack, release and Auto Makeup did not move and stay plan-authored.
 */
export const COMP_ONE_KNOB_DRIVEN: ReadonlySet<string> = new Set(["threshold", "ratio", "gain", "knee"]);

// Oscillator mode (param 712). Frequency control applies to Sine Wave; Burst
// Noise adds width (param 714) / interval (param 715), both confirmed by live
// snapshot-diff and in the write catalog above.
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
// stereo channel has its own dedicated param, written to both L/R instances
// (y = 0 and 1) which the device keeps linked. The block is the consecutive ids
// 9..17 (all ±2400 centi-dB = ±24 dB range); URX44V occupies {9,13,14,15},
// confirmed by a live broker probe (per-id sentinel write → on-device D.Gain
// readout: CH5/6=9, CH7/8=13, CH9/10=14, CH11/12=15). URX44 shares that map.
//
// Keyed by MODEL because the broker indexes stereo channels by pair POSITION, not
// by displayed label. The URX22 meter verification on real hardware (PR #173)
// showed the stereo meter address is the pair position (URX22's CH5/6 is position
// 1, NOT the same slot as URX44V's CH5/6 = position 0), and the stereo fader/ON/pan
// (266/267/268) and source (209/210) blocks are already position-indexed. So the
// D.Gain block is very likely positional too: URX22's four stereo pairs (CH3/4,
// CH5/6, CH7/8, CH9/10 = positions 0..3) reuse the SAME confirmed ids {9,13,14,15}
// BY POSITION — CH3/4 = 9, retiring the old free-slot guess (11). This is the
// leading, meter-corroborated hypothesis but is NOT yet confirmed on a real URX22:
// tracked in UNVERIFIED_MAPPINGS ("dgain-urx22") and settled by one sentinel write.
const D_GAIN_URX44V: Record<string, number> = {
  ch_5_6: 9,
  ch_7_8: 13,
  ch_9_10: 14,
  ch_11_12: 15,
};
const D_GAIN_URX22: Record<string, number> = {
  ch_3_4: 9,
  ch_5_6: 13,
  ch_7_8: 14,
  ch_9_10: 15,
};
/** D.Gain param id for a stereo channel on a model, or undefined when the node has
 *  none. URX44 shares the URX44V label map; URX22 uses the positional map (above). */
export const dGainParam = (modelId: string, nodeId: string): number | undefined =>
  (modelId === "URX22" ? D_GAIN_URX22 : D_GAIN_URX44V)[nodeId];

/** Every id either map uses, for the announcement rule below. Derived rather than
 *  listed: a model whose map moves must not leave a stale copy here. */
const D_GAIN_IDS: ReadonlySet<number> = new Set([...Object.values(D_GAIN_URX44V), ...Object.values(D_GAIN_URX22)]);

/** The shared engine arrays behind the insert-FX and FX editors, by the names their
 *  VALUE writes carry. The selectors and the type heads are not here: those announce,
 *  and they carry a sideEffect of their own. */
const SILENT_WRITE_NAMES: ReadonlySet<string> = new Set(["INSERT_FX_EFFECT", "FX_EFFECT_PARAM"]);

/**
 * Whether a write to this address is one the unit ANNOUNCES. False for two families the
 * device is recorded as never announcing: D.Gain, and the shared engine arrays. A write
 * to either is confirmed by reading it back, never by waiting for a notify.
 *
 * This is what a caller asks before treating a silence as a write that went nowhere. The
 * test is by ADDRESS and not by name alone, because D.Gain rides the `HA_GAIN` name at
 * its own ids while the analog gain (id 1) keeps that name and does announce.
 */
export const announcesWrites = (name: string, paramId: number): boolean =>
  !D_GAIN_IDS.has(paramId) && !SILENT_WRITE_NAMES.has(name);

// microSD Rec Track Count (RECORDER menu): how many tracks record, an even 2..16.
// The plan stores the actual count (readback = device raw × 2). Planned here but
// never pushed: the broker refuses every value above two tracks (see
// SD_REC_TRACK_COUNT). Default 8 (the factory value).
export const SD_REC_TRACK_COUNT_DEFAULT = 8;
export const SD_REC_TRACK_COUNT_OPTIONS = [2, 4, 6, 8, 10, 12, 14, 16].map((n) => ({ value: n, label: String(n) }));

// Stereo channels use a SEPARATE device block from mono channels: a single
// fader / ON / pan param indexed by stereo-channel position (0..N), not the mono
// params 139/140/141. Encodings match (level_gain / onoff / ±63). The index is
// the channel's position among the model's stereo channels (so it shifts with
// the mono count — e.g. URX22's first stereo channel is index 0). HPF does not
// exist on these channels. Confirmed on URX44V (research §12.9); URX44/URX22 inferred.
export const STEREO_FADER = 266;
export const STEREO_ON = 267;
export const STEREO_PAN = 268;
/** Stereo channel → STEREO bus assign ON (parallel to mono STEREO_ASSIGN_ON 142,
 *  at +3 from the stereo fader block). Emitted under the STEREO_ASSIGN_ON name. */
export const STEREO_ASSIGN_ON_STEREO = 269;
/** FX channel → STEREO bus assign ON (parallel block, +3 from FX_CHANNEL_FADER 337).
 *  Emitted under the STEREO_ASSIGN_ON name. */
export const FX_STEREO_ASSIGN_ON = 340;

/** Reverse lookup of the confirmed catalog: the param that owns a param id, if
 *  any. The self-test's collision audit uses it to tell a guessed id apart from
 *  an id a confirmed param already claims. */
const ID_TO_NAME: ReadonlyMap<number, ParamName> = new Map(
  (Object.entries(PARAMS) as [ParamName, ParamSpec][]).map(([name, spec]) => [spec.id, name]),
);
export function paramNameForId(id: number): ParamName | undefined {
  return ID_TO_NAME.get(id);
}
