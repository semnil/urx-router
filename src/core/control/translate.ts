// Plan → live-control command translation. Turns the editable parameters a plan
// already holds into concrete vd value-set requests, so the result doubles as a
// dry-run preview (what would be written to hardware) and the payload list for
// the eventual transport. Pure and language-agnostic.
//
// Scope: only mappings whose param_id is confirmed against the broker dump are
// emitted, so a dry-run never proposes a guessed hardware write. Today that is
// each channel's main fader / pan (its fixed send into STEREO → CH_FADER / CH_PAN).
// Bus sends and channel-strip processing land here as their ids are confirmed.

import type { ConnectionKind, DeviceModel, ModelId } from "../../models/types";
import { parseRef, ref } from "../../models/types";
import type {
  CompParams,
  EqBand,
  EqOneKnobParams,
  FxEffectParams,
  GateParams,
  Plan,
  SsmcsBand,
  SsmcsParams,
} from "../plan";
import { incomingConnection, normalizeNodeName } from "../plan";
import {
  FX_CHANNEL_NODE_INDEX,
  FX_EFFECT_ARRAY_PARAM,
  FX_EFFECT_TYPE_PARAM,
  FX_SLOT_LEVEL,
  FX_SLOT_ON,
  resolveFxEffectType,
  fxParams,
  formatHz,
} from "./fx-effect";
import { insertFxEngine, insertFxFamilyOf, insertFxParamKey, insertFxWritableSlots } from "./insert-fx-effect";
import { isFixedConnection, sendTapWritable } from "../routing";
import type { InsertFxOption, ParamName, ParamSpec } from "./params";
import {
  BUS_TYPE_OPTIONS,
  BUS_TYPE_VARI,
  COMP_EQ_COMP_FIRST,
  COMP_EQ_OPTIONS,
  COMP_EQ_SSMCS,
  COMP_KNEE_DEFAULT,
  COMP_KNEE_OPTIONS,
  DELAY_FRAME_RATE_DEFAULT,
  DELAY_FRAME_RATE_OPTIONS,
  denormalizeInsertFx,
  dGainParam,
  EQ_BAND_DEFAULT_FREQ_HZ,
  EQ_ONE_KNOB_LEVEL_MAX,
  EQ_ONE_KNOB_LEVEL_MIN,
  EQ_ONE_KNOB_TYPE_ALL_OPTIONS,
  EQ_ONE_KNOB_TYPE_DEFAULT,
  EQ_Q_DEFAULT,
  EQ_TYPE_HIGH_OPTIONS,
  EQ_TYPE_LOW_OPTIONS,
  EQ_TYPE_SHELVING,
  FX_STEREO_ASSIGN_ON,
  hexToColorIndex,
  INSERT_FX_NONE,
  INSERT_FX_OPTIONS,
  OSC_MODE_OPTIONS,
  OSC_MODE_SINE,
  OUTPUT_INSERT_FX_OPTIONS,
  PAN_BAL_OPTIONS,
  PAN_BAL_PAN,
  paramNameForId,
  PARAMS,
  REC_POINT_DEFAULT,
  REC_POINT_OPTIONS,
  STEREO_ASSIGN_ON_STEREO,
  STEREO_FADER,
  STEREO_ON,
  STEREO_PAN,
} from "./params";
import {
  A_GAIN_MAX_DB,
  A_GAIN_MIN_DB,
  attackToVd,
  boolToVd,
  burstWidthToVd,
  centiDbToVd,
  D_GAIN_MAX_DB,
  D_GAIN_MIN_DB,
  delayTimeToVd,
  DUCKER_DECAY_MAX_MS,
  DUCKER_DECAY_MIN_MS,
  DYN_ATTACK_MAX_MS,
  DYN_ATTACK_MIN_MS,
  DYN_HOLD_MAX_MS,
  DYN_HOLD_MIN_MS,
  DYN_RATIO_MIN,
  DYN_RELEASE_MAX_MS,
  DYN_RELEASE_MIN_MS,
  EQ_FREQ_MAX_HZ,
  EQ_FREQ_MIN_HZ,
  EQ_GAIN_MAX_DB,
  EQ_GAIN_MIN_DB,
  EQ_Q_MAX,
  EQ_Q_MIN,
  eqFreqToVd,
  eqGainToVd,
  freqToVd,
  gainToVd,
  GATE_RANGE_OFF_DB,
  gateRangeToVd,
  holdToVd,
  levelToVd,
  panToVd,
  phonesLevelToVd,
  PORT_REF_NONE,
  qToVd,
  ratioToVd,
  releaseToVd,
  SSMCS_ATTACK_RAW_MAX,
  SSMCS_ATTACK_RAW_MIN,
  SSMCS_COMP_DRIVE_MAX,
  SSMCS_COMP_DRIVE_MIN,
  SSMCS_COMP_INTERNAL_MAX,
  SSMCS_COMP_INTERNAL_MIN,
  SSMCS_EQ_HIGH_FREQ_RAW_MIN,
  SSMCS_EQ_LOW_FREQ_RAW_MAX,
  SSMCS_FREQ_RAW_MAX,
  SSMCS_FREQ_RAW_MIN,
  SSMCS_GAIN_MAX,
  SSMCS_GAIN_MIN,
  SSMCS_MORPHING_MAX,
  SSMCS_MORPHING_MIN,
  SSMCS_Q_RAW_MAX,
  SSMCS_Q_RAW_MIN,
  SSMCS_RATIO_RAW_MAX,
  SSMCS_RATIO_RAW_MIN,
  SSMCS_RELEASE_RAW_MAX,
  SSMCS_RELEASE_RAW_MIN,
  sweetSpotDataToStr,
  tagPortRef,
} from "./vd";

export interface VdCommand {
  /** Catalog parameter this command sets. */
  name: ParamName;
  /** Broker param_id (address first field). */
  paramId: number;
  /** Address x field (0 outside EQ bands). */
  x: number;
  /** Instance index (the address y field). */
  y: number;
  /** Plan-domain value before encoding (dB, pan ±63, or 0/1). */
  planValue: number;
  /** Encoded broker value. */
  vdValue: number;
  /**
   * Owner node id this command's address belongs to (the node a scoped readback
   * would re-read, or whose plan slot a direct-apply writes). Stamped by
   * planToCommands; used to build the device-follow address→node index. Undefined
   * for global, non-node addresses (e.g. sample rate).
   */
  node?: string;
  /**
   * Owner nodes whose command for this SAME address carried a DIFFERENT value and
   * was dropped in favour of this one (the last-wins collapse in
   * collapseSharedAddrs). Absent on every command of a plan with no shared
   * address, which is every plan the screens can author.
   */
  shadowed?: string[];
  /**
   * Commands that must be re-sent TOGETHER, in emit order, whenever any one of
   * them differs — because writing an earlier member resets the later ones on the
   * device. Order alone is enough for a full send; it is not enough for the
   * converge loop, which re-sends only what still differs and would otherwise
   * re-arm the reset it is trying to settle (see sendConverging).
   */
  group?: string;
}

function encodeValue(encoding: ParamSpec["encoding"], planValue: number): number {
  switch (encoding) {
    case "level":
      return levelToVd(planValue);
    case "gain":
      return gainToVd(planValue);
    case "pan":
      return panToVd(planValue);
    case "freq":
      return freqToVd(planValue);
    case "enum":
      return planValue;
    case "eqFreq":
      return eqFreqToVd(planValue);
    case "q":
      return qToVd(planValue);
    case "eqGain":
      return eqGainToVd(planValue);
    case "centiDb":
      return centiDbToVd(planValue);
    case "gateRange":
      return gateRangeToVd(planValue);
    case "delayTime":
      return delayTimeToVd(planValue);
    case "phonesLevel":
      return phonesLevelToVd(planValue);
    case "burstWidth":
      return burstWidthToVd(planValue);
    case "attackTime":
      return attackToVd(planValue);
    case "holdTime":
      return holdToVd(planValue);
    case "releaseTime":
      return releaseToVd(planValue);
    case "ratio":
      return ratioToVd(planValue);
    case "portRef":
      return planValue;
    case "portRefTagged":
      return tagPortRef(planValue);
    case "insertFx":
      return denormalizeInsertFx(planValue);
    case "bool":
      return boolToVd(planValue !== 0);
    case "raw":
      return planValue;
  }
}

// Build a command for an explicit param id (used where the id is not a fixed
// registry entry: the stereo-channel block and the per-channel D.Gain).
function rawCommand(
  name: ParamName,
  paramId: number,
  encoding: ParamSpec["encoding"],
  y: number,
  planValue: number,
): VdCommand {
  const vdValue = encodeValue(encoding, planValue);
  return { name, paramId, x: 0, y, planValue, vdValue };
}

function command(name: ParamName, y: number, planValue: number): VdCommand {
  const spec = PARAMS[name];
  return rawCommand(name, spec.id, spec.encoding, y, planValue);
}

/** True for a stereo mixer-channel node id (e.g. "ch_5_6"). */
export function isStereoChannel(nodeId: string): boolean {
  return /^ch_\d+_\d+$/.test(nodeId);
}

// Hi-Z (instrument) input is on specific mono channels per model: CH3/CH4 on
// URX44/44V (verified on 44V), CH2 on URX22 (extrapolated, unverified).
const HI_Z_CHANNELS: Record<string, string[]> = {
  URX44V: ["ch3", "ch4"],
  URX44: ["ch3", "ch4"],
  URX22: ["ch2"],
};

/** Input gain for a channel: which param, the linked instances, range, and whether it is the analog A.Gain. */
export interface ChannelGain {
  param: number;
  instances: number[];
  minDb: number;
  maxDb: number;
  analog: boolean;
}

/**
 * One polarity-invert (Ø) toggle. Mono channels have a single one; a stereo
 * channel has two independent ones (its L and R sides).
 */
export interface PhaseToggle {
  name: ParamName;
  /** The NodeParams field this toggle reads/writes. */
  key: "phase" | "phaseL" | "phaseR";
  param: number;
  y: number;
  /** "" for a mono channel; "L" / "R" for the two sides of a stereo channel. */
  side: "" | "L" | "R";
}

/**
 * One channel-strip section ON toggle (GATE / COMP / EQ). The broker polarity is
 * mixed, so `onValue` is the raw value that means ON (OFF is its complement).
 */
export interface SectionToggle {
  name: ParamName;
  /** The NodeParams field this toggle reads/writes. */
  key: "gateOn" | "compOn" | "eqOn";
  param: number;
  /** Instance index (the address y field). */
  y: number;
  /** Raw broker value that means ON (the SSMCS comp/eq bank is inverted, so 0). */
  onValue: 0 | 1;
}

export interface ChannelControl {
  fader: number;
  on: number;
  /** → STEREO bus assign ON (post-fader). Distinct from `on` (the channel master). */
  stereoOn: number;
  pan: number;
  /** Rec Point (record / direct-out tap): mono param 137 (input axis), stereo 264. */
  recPoint: number;
  y: number;
  hasHpf: boolean;
  /** The analog mic-strip toggles (+48V / Clip Safe) exist only on the mono mic channels. */
  hasMicStrip: boolean;
  /** Hi-Z (instrument input) exists only on CH3/CH4. */
  hasHiZ: boolean;
  /** Polarity invert: one toggle on a mono channel, two (L/R) on a stereo one. */
  phases: PhaseToggle[];
  gain: ChannelGain | null;
}

// Stereo channels are indexed by their position among the model's stereo
// channels (which shifts with the mono count). The map is built once per model.
const stereoIndexCache = new WeakMap<DeviceModel, Map<string, number>>();
export function stereoIndexMap(model: DeviceModel): Map<string, number> {
  let map = stereoIndexCache.get(model);
  if (!map) {
    map = new Map();
    let i = 0;
    for (const n of model.nodes) if (n.kind === "channel" && isStereoChannel(n.id)) map.set(n.id, i++);
    stereoIndexCache.set(model, map);
  }
  return map;
}

/**
 * Resolve everything live control needs for a channel node, in one place:
 * fader / ON / pan device params + instance index, whether it has an HPF, and
 * its gain (param, linked instances, range, A.Gain vs D.Gain). Mono channels use
 * 139/140/141/25 at the input index with the analog A.Gain (param 1), the
 * mic-strip toggles (+48V/Clip Safe) and a single phase (24); stereo channels
 * use the separate 266/267/268 block at the stereo index, the digital D.Gain
 * written to both L/R instances, independent L/R phase (211/212), and no HPF or
 * mic strip. Null for non-channels.
 */
export function channelControl(model: DeviceModel, nodeId: string): ChannelControl | null {
  if (isStereoChannel(nodeId)) {
    const si = stereoIndexMap(model).get(nodeId);
    if (si === undefined) return null;
    const dParam = dGainParam(model.id, nodeId);
    return {
      fader: STEREO_FADER,
      on: STEREO_ON,
      stereoOn: STEREO_ASSIGN_ON_STEREO,
      pan: STEREO_PAN,
      recPoint: PARAMS.REC_POINT_STEREO.id,
      y: si,
      hasHpf: false,
      hasMicStrip: false,
      hasHiZ: false,
      // Stereo channels invert L and R independently (params 211 / 212).
      phases: [
        { name: "PHASE_L", key: "phaseL", param: PARAMS.PHASE_L.id, y: si, side: "L" },
        { name: "PHASE_R", key: "phaseR", param: PARAMS.PHASE_R.id, y: si, side: "R" },
      ],
      gain:
        dParam === undefined
          ? null
          : { param: dParam, instances: [0, 1], minDb: D_GAIN_MIN_DB, maxDb: D_GAIN_MAX_DB, analog: false },
    };
  }
  const mono = /^ch(\d+)$/.exec(nodeId);
  if (!mono) return null;
  const y = Number(mono[1]) - 1;
  return {
    fader: PARAMS.CH_FADER.id,
    on: PARAMS.CH_ON.id,
    stereoOn: PARAMS.STEREO_ASSIGN_ON.id,
    pan: PARAMS.CH_PAN.id,
    recPoint: PARAMS.REC_POINT.id,
    y,
    hasHpf: true,
    hasMicStrip: true,
    hasHiZ: (HI_Z_CHANNELS[model.id] ?? []).includes(nodeId),
    phases: [{ name: "PHASE", key: "phase", param: PARAMS.PHASE.id, y, side: "" }],
    gain: { param: PARAMS.HA_GAIN.id, instances: [y], minDb: A_GAIN_MIN_DB, maxDb: A_GAIN_MAX_DB, analog: true },
  };
}

/**
 * Channel-strip section ON toggles (GATE / COMP / EQ) for a channel. MONO IN
 * channels have all three; GATE is type-independent (param 28) but COMP and EQ
 * swap param banks with the COMP/EQ type — COMP->EQ uses 34/44 (1 = on), SSMCS
 * uses 94/106 (0 = on). Stereo channels have only EQ (213). Empty for non-channels.
 */
export function channelSections(model: DeviceModel, nodeId: string, compEqType: number): SectionToggle[] {
  const cc = channelControl(model, nodeId);
  if (!cc) return [];
  if (isStereoChannel(nodeId)) {
    return [{ name: "STEREO_CH_EQ_ON", key: "eqOn", param: PARAMS.STEREO_CH_EQ_ON.id, y: cc.y, onValue: 1 }];
  }
  const ssmcs = compEqType === COMP_EQ_SSMCS;
  return [
    { name: "GATE_ON", key: "gateOn", param: PARAMS.GATE_ON.id, y: cc.y, onValue: 1 },
    ssmcs
      ? { name: "SSMCS_COMP_ON", key: "compOn", param: PARAMS.SSMCS_COMP_ON.id, y: cc.y, onValue: 0 }
      : { name: "COMP_ON", key: "compOn", param: PARAMS.COMP_ON.id, y: cc.y, onValue: 1 },
    ssmcs
      ? { name: "SSMCS_EQ_ON", key: "eqOn", param: PARAMS.SSMCS_EQ_ON.id, y: cc.y, onValue: 0 }
      : { name: "EQ_ON", key: "eqOn", param: PARAMS.EQ_ON.id, y: cc.y, onValue: 1 },
  ];
}

/**
 * A CH → bus send. `level`/`pan`/`on` are instance lists (MIX writes both linked
 * L/R; FX writes a single mono send and has no pan). `tap` is the PRE/POST param.
 */
export interface SendControl {
  y: number;
  level: number[];
  pan: number[];
  on: number[];
  /** PRE/POST tap param (single L slot; the device links R). Every send has one. */
  tap: number;
}

// CH → MIX sends are laid out as 12-param stereo-bus blocks (L slot + R slot, 6
// params each: level/pan/on at offsets 0/1/2, PRE/POST at offset 5 in the L slot
// only). Mono channels use a block based at 146 (y = input index); stereo
// channels a parallel block at 273 (y = stereo index). Confirmed by live scan.
const MIX_SEND_BASE_MONO = 146;
const MIX_SEND_BASE_STEREO = 273;
const MIX_SEND_STRIDE = 12;
const MIX_SEND_BUS_INDEX: Record<string, number> = { "bus.mix1": 0, "bus.mix2": 1 };

// CH → FX sends are 4-param mono blocks: PRE/POST tap at +0, level at +1, on at
// +3 (no pan). Mono channels base at 193 (y = input index); stereo channels at
// 320 (y = stereo index). Confirmed by live scan.
const FX_SEND_BASE_MONO = 193;
const FX_SEND_BASE_STEREO = 320;
const FX_SEND_STRIDE = 4;
const FX_SEND_BUS_INDEX = FX_CHANNEL_NODE_INDEX;

// FX channel → MIX sends. Each MIX is a 10-param block (L slot + R slot, 5 params
// each: PRE/POST tap / level / BAL / on at offsets 0/1/2/3, +4 unused). y = FX
// channel index (the FX bus index, fx1 = 0 / fx2 = 1). L/R are device-linked
// (writing the L slot propagates to R), so the tap is written once on the L slot;
// level/BAL/on write both for parity with CH → MIX. Live snapshot-diff confirmed.
const FXCH_MIX_SEND_BASE = 342;
const FXCH_MIX_SEND_STRIDE = 10; // per MIX bus
const FXCH_MIX_SLOT_STRIDE = 5; // L slot → R slot

/** FX channel instance index (y) for its master fader / BAL / MIX sends, or null
 *  if the node is not an FX channel. FX channels are send sources whose MIX sends
 *  and STEREO main path live outside channelControl (they are buses, not channels);
 *  their instance index is the FX bus index. */
export function fxChannelIndex(nodeId: string): number | null {
  const y = FX_SEND_BUS_INDEX[nodeId];
  return y === undefined ? null : y;
}

/** Send params for a CH/FX-channel → MIX/FX-bus pair, or null if not such a send. */
export function sendControl(model: DeviceModel, channelId: string, busId: string): SendControl | null {
  // FX channel → MIX sends (the FX channels are buses, not channels). The send
  // to STEREO is the fixed main path (FX_CHANNEL_FADER), handled separately.
  const fxY = fxChannelIndex(channelId);
  if (fxY !== null) {
    const mixIndex = MIX_SEND_BUS_INDEX[busId];
    if (mixIndex === undefined) return null;
    const l = FXCH_MIX_SEND_BASE + FXCH_MIX_SEND_STRIDE * mixIndex;
    const r = l + FXCH_MIX_SLOT_STRIDE;
    return { y: fxY, level: [l + 1, r + 1], pan: [l + 2, r + 2], on: [l + 3, r + 3], tap: l };
  }
  const cc = channelControl(model, channelId);
  if (!cc) return null;
  const stereo = isStereoChannel(channelId);
  const mixIndex = MIX_SEND_BUS_INDEX[busId];
  if (mixIndex !== undefined) {
    const base = (stereo ? MIX_SEND_BASE_STEREO : MIX_SEND_BASE_MONO) + MIX_SEND_STRIDE * mixIndex;
    return { y: cc.y, level: [base, base + 6], pan: [base + 1, base + 7], on: [base + 2, base + 8], tap: base + 5 };
  }
  const fxIndex = FX_SEND_BUS_INDEX[busId];
  if (fxIndex !== undefined) {
    const base = (stereo ? FX_SEND_BASE_STEREO : FX_SEND_BASE_MONO) + FX_SEND_STRIDE * fxIndex;
    // PRE/POST tap at base+0 (single mono send, no pan). Live-confirmed writable.
    return { y: cc.y, level: [base + 1], pan: [], on: [base + 3], tap: base };
  }
  return null;
}

/** A bus output fader: which param and the linked instances it writes. */
export interface BusFader {
  name: ParamName;
  param: number;
  instances: number[];
}

// MIX bus output faders share param 674 (level_gain, out axis); each stereo MIX
// occupies an L/R instance pair the device keeps linked. STEREO has its own
// single master fader (581).
export const MIX_FADER_INSTANCES: Record<string, number[]> = {
  "bus.mix1": [0, 1],
  "bus.mix2": [2, 3],
};

/** Output fader for a bus node (STEREO master / MIX), or null if it has none. */
export function busFader(nodeId: string): BusFader | null {
  if (nodeId === "bus.stereo") {
    return { name: "STEREO_MASTER_FADER", param: PARAMS.STEREO_MASTER_FADER.id, instances: [0] };
  }
  const mix = MIX_FADER_INSTANCES[nodeId];
  return mix ? { name: "OUT_FADER", param: PARAMS.OUT_FADER.id, instances: mix } : null;
}

/** Output master balance / pan for a bus node: STEREO master (583, single) or a
 *  MIX bus (676, L/R-linked per MIX), mirroring the fader's instances. Null for
 *  buses with no master balance (FX / monitor / stream / osc). */
export function busBalance(nodeId: string): BusFader | null {
  if (nodeId === "bus.stereo") {
    return { name: "STEREO_MASTER_BAL", param: PARAMS.STEREO_MASTER_BAL.id, instances: [0] };
  }
  const mix = MIX_FADER_INSTANCES[nodeId];
  return mix ? { name: "OUT_MASTER_BAL", param: PARAMS.OUT_MASTER_BAL.id, instances: mix } : null;
}

/** Master ON param/instances for a bus channel: STEREO master (582), a MIX bus
 *  (OUT_MASTER_ON 675, L/R-linked per MIX), or an FX return (FX_CHANNEL_ON, one
 *  instance per FX; the canonical FX-bus ordering), or null for buses with none. */
export function busMasterOn(nodeId: string): { name: ParamName; param: number; instances: number[] } | null {
  if (nodeId === "bus.stereo") {
    return { name: "STEREO_MASTER_ON", param: PARAMS.STEREO_MASTER_ON.id, instances: [0] };
  }
  const mix = MIX_FADER_INSTANCES[nodeId];
  if (mix) return { name: "OUT_MASTER_ON", param: PARAMS.OUT_MASTER_ON.id, instances: mix };
  const fx = FX_SEND_BUS_INDEX[nodeId];
  return fx === undefined ? null : { name: "FX_CHANNEL_ON", param: PARAMS.FX_CHANNEL_ON.id, instances: [fx] };
}

/** EQ-ON param/instances for an output bus: STEREO (498) or MIX (591, L/R-linked). */
export function busEqOn(nodeId: string): { name: ParamName; param: number; instances: number[] } | null {
  if (nodeId === "bus.stereo") {
    return { name: "STEREO_EQ_ON", param: PARAMS.STEREO_EQ_ON.id, instances: [0] };
  }
  const mix = MIX_FADER_INSTANCES[nodeId];
  return mix ? { name: "OUT_EQ_ON", param: PARAMS.OUT_EQ_ON.id, instances: mix } : null;
}

// CH SETTING per-node identity (color + name) shares one addressing scheme: the
// same node kinds carry it on the same instances, only the param id differs by
// attribute. `nodeIdentity` resolves a node to its kind + instances once; color
// and name then pick their param from that kind. Nodes the device does not give
// a CH SETTING (monitor / OSC) resolve to null, so neither attribute is ever
// written to a guessed address.
// Mono and stereo input channels carry their CH SETTING on different blocks: a
// mono channel on the input slot (params 18/20), a stereo channel on the stereo
// index (params 206/208) — the same split the fader/pan block uses (139.. vs
// 266..). So they resolve to distinct identity kinds with different instances.
type IdentityKind = "stereo" | "stream" | "fx" | "mix" | "monoChannel" | "stereoChannel";
function nodeIdentity(model: DeviceModel, nodeId: string): { kind: IdentityKind; instances: number[] } | null {
  if (nodeId === "bus.stereo") return { kind: "stereo", instances: [0] };
  if (nodeId === "bus.stream") return { kind: "stream", instances: [0, 1] };
  // FX is one instance per FX (FX1 = y0, FX2 = y1), reusing the canonical FX-bus
  // ordering rather than a second copy of it.
  const fx = FX_SEND_BUS_INDEX[nodeId];
  if (fx !== undefined) return { kind: "fx", instances: [fx] };
  const mix = MIX_FADER_INSTANCES[nodeId];
  if (mix) return { kind: "mix", instances: mix };
  if (isStereoChannel(nodeId)) {
    const si = stereoIndexMap(model).get(nodeId);
    return si === undefined ? null : { kind: "stereoChannel", instances: [si] };
  }
  const slots = channelInputSlots(model, nodeId);
  return slots ? { kind: "monoChannel", instances: slots } : null;
}

const COLOR_PARAM: Record<IdentityKind, { name: ParamName; param: number }> = {
  stereo: { name: "STEREO_COLOR", param: PARAMS.STEREO_COLOR.id },
  stream: { name: "STREAM_COLOR", param: PARAMS.STREAM_COLOR.id },
  fx: { name: "FX_COLOR", param: PARAMS.FX_COLOR.id },
  mix: { name: "MIX_COLOR", param: PARAMS.MIX_COLOR.id },
  monoChannel: { name: "CH_COLOR", param: PARAMS.CH_COLOR.id },
  stereoChannel: { name: "STEREO_CH_COLOR", param: PARAMS.STEREO_CH_COLOR.id },
};
// Name param ids per kind. These are string-valued (the broker stores them as a
// JSON string), so they live outside the numeric PARAMS catalog and are written
// via the string IPC (vdSetStr) rather than as VdCommands.
const NAME_PARAM: Record<IdentityKind, number> = {
  stereo: 494,
  stream: 702,
  fx: 333,
  mix: 584,
  monoChannel: 18,
  stereoChannel: 206,
};

/** CH SETTING color param/instances for a colorable node (input channels +
 *  STEREO / MIX / FX / STREAMING buses), or null when the device has none. */
export function colorControl(
  model: DeviceModel,
  nodeId: string,
): { name: ParamName; param: number; instances: number[] } | null {
  const id = nodeIdentity(model, nodeId);
  return id ? { ...COLOR_PARAM[id.kind], instances: id.instances } : null;
}

/** CH SETTING name param/instances for a nameable node (same node set as color);
 *  null when the device has no name for it. The value is a string (vdSetStr). */
export function nameControl(model: DeviceModel, nodeId: string): { param: number; instances: number[] } | null {
  const id = nodeIdentity(model, nodeId);
  return id ? { param: NAME_PARAM[id.kind], instances: id.instances } : null;
}

/** One band of a 4-band PEQ: the param ids for each of its values. */
export interface EqBandControl {
  /** 0..3 (LOW / LOW-MID / HIGH-MID / HIGH). */
  index: number;
  name: "low" | "lowMid" | "highMid" | "high";
  on: number;
  /** Filter-type param, or null for the fixed-peaking mid bands. */
  type: number | null;
  q: number;
  freq: number;
  gain: number;
}

/** A 4-band PEQ (input channel or output bus): its bands and the instances each value writes. */
export interface EqControl {
  bands: EqBandControl[];
  instances: number[];
}

/** The four bands, in device order. Exported because every surface that shows a band needs
 *  the same names and the same "which of them carry a filter type" rule. */
export const EQ_BAND_NAMES = ["low", "lowMid", "highMid", "high"] as const;
/** Only LOW and HIGH carry a selectable filter type; the two mid bands are fixed peaking
 *  and the device rejects a type write to them (measured, response_code 400). */
export const eqBandHasType = (index: number): boolean => index === 0 || index === 3;
// Each PEQ band is a 5-param block (on / type / Q / freq / gain) and the first
// band sits 5 params after the EQ-ON anchor. Only the LOW and HIGH bands carry a
// selectable filter type; the two mid bands are fixed peaking.
const EQ_BAND_BASE_OFFSET = 5;
const EQ_BAND_STRIDE = 5;

// Build the four bands from the EQ-ON anchor param (band1 sits 5 params later).
function eqBandsFrom(eqOnParam: number, instances: number[]): EqControl {
  const base = eqOnParam + EQ_BAND_BASE_OFFSET;
  const bands = EQ_BAND_NAMES.map((name, i): EqBandControl => {
    const b = base + EQ_BAND_STRIDE * i;
    return { index: i, name, on: b, type: eqBandHasType(i) ? b + 1 : null, q: b + 2, freq: b + 3, gain: b + 4 };
  });
  return { bands, instances };
}

/**
 * Resolve an output bus 4-band PEQ, or null if the node has none. Reuses the
 * EQ-ON anchor (busEqOn): the band block starts 5 params later and writes the
 * same instances — STEREO a single slot (498→503), MIX the L/R-linked out pair
 * (591→596). Confirmed on STEREO and MIX by live scan (research §12.24).
 */
export function outputEq(nodeId: string): EqControl | null {
  const eq = busEqOn(nodeId);
  return eq ? eqBandsFrom(eq.param, eq.instances) : null;
}

/**
 * Resolve an input channel 4-band PEQ, or null if it has none. Shares the
 * output structure (band block 5 params after the EQ-ON anchor): mono COMP->EQ
 * mode anchors at EQ_ON 44 (→49), stereo channels at STEREO_CH_EQ_ON 213 (→218).
 * SSMCS mode has no 4-band PEQ (the morphing strip replaces it), so it returns
 * null. Confirmed on a mono channel by live scan (research §12.25).
 */
export function inputEq(model: DeviceModel, nodeId: string, compEqType: number): EqControl | null {
  // A mono channel in SSMCS mode has no 4-band PEQ (the morphing strip replaces
  // it); stereo channels always do. Take the EQ-ON anchor from channelSections.
  if (compEqType === COMP_EQ_SSMCS && !isStereoChannel(nodeId)) return null;
  const eqSec = channelSections(model, nodeId, compEqType).find((s) => s.key === "eqOn");
  return eqSec ? eqBandsFrom(eqSec.param, [eqSec.y]) : null;
}

/** Whether this node has a 4-band PEQ at all. Distinct from the CONSOLE's `hasEq`, which is
 *  also true for a mono channel in SSMCS mode — that EQ is the morphing strip's, not this
 *  one. `inputEq`/`outputEq` already answer per node kind; this is the pair of them. */
export function hasEq(model: DeviceModel, nodeId: string, compEqType: number): boolean {
  return (inputEq(model, nodeId, compEqType) ?? outputEq(nodeId)) !== null;
}

/** EQ 1-knob params for an EQ (input channel or output bus): ON / TYPE / LEVEL sit
 *  2 / 3 / 4 params after the EQ-ON anchor. */
export interface EqOneKnobControl {
  on: number;
  type: number;
  level: number;
  instances: number[];
}

function eqOneKnobFrom(eqOnParam: number, instances: number[]): EqOneKnobControl {
  const b = eqOnParam + 2;
  return { on: b, type: b + 1, level: b + 2, instances };
}

/** Resolve the EQ 1-knob for a node, or null if it has no EQ (e.g. a mono channel
 *  in SSMCS mode). Reuses the same EQ-ON anchor as inputEq/outputEq. */
export function eqOneKnob(model: DeviceModel, nodeId: string, compEqType: number): EqOneKnobControl | null {
  const out = busEqOn(nodeId);
  if (out) return eqOneKnobFrom(out.param, out.instances);
  if (compEqType === COMP_EQ_SSMCS && !isStereoChannel(nodeId)) return null;
  const eqSec = channelSections(model, nodeId, compEqType).find((s) => s.key === "eqOn");
  return eqSec ? eqOneKnobFrom(eqSec.param, [eqSec.y]) : null;
}

/** One slider value of a tuning screen's parameters: its catalog name + plan-domain
 *  range. GATE/COMP/DUCKER details and the 4-band PEQ's per-band values all take this
 *  shape, so the screens render them the same way. */
export interface DynField {
  /** The GateParams / CompParams / EqBand sub-field this controls. */
  key: keyof GateParams | keyof CompParams | keyof EqBand;
  name: ParamName;
  min: number;
  max: number;
  step: number;
  /** Device default in plan units, shown before a fetch. */
  def: number;
  unit: "db" | "ms" | "ratio" | "hz" | "q";
  /** Slider positions for a value the device sweeps logarithmically (an EQ band
   *  frequency spans three decades, which a linear slider cannot resolve at the
   *  bottom). Absent = the slider carries the value itself. */
  logSteps?: number;
  /** Step the device's push-and-turn fine mode uses for this value, when it has
   *  one. Confirmed for exactly one dynamics parameter (see the COMP gain row);
   *  every other GATE/COMP/DUCKER value is a measured negative, so this is not a
   *  class rule and must not be inferred from the unit. */
  fineStep?: number;
}

// GATE detail (29-33) and COMP detail (35-40, the COMP->EQ comp bank). Ranges and
// defaults in plan units (dB / ms / N:1); the broker bounds come from the encoders.
// The COMP knee (37) is a separate enum dropdown, not a slider, so it is not here.
const GATE_FIELDS: DynField[] = [
  { key: "threshold", name: "GATE_THRESHOLD", min: -72, max: 0, step: 1, def: -50, unit: "db" },
  { key: "range", name: "GATE_RANGE", min: GATE_RANGE_OFF_DB, max: 0, step: 1, def: -56, unit: "db" },
  {
    key: "attack",
    name: "GATE_ATTACK",
    min: DYN_ATTACK_MIN_MS,
    max: DYN_ATTACK_MAX_MS,
    step: 0.1,
    def: 20.17,
    unit: "ms",
  },
  { key: "hold", name: "GATE_HOLD", min: DYN_HOLD_MIN_MS, max: DYN_HOLD_MAX_MS, step: 1, def: 15.3, unit: "ms" },
  {
    key: "decay",
    name: "GATE_DECAY",
    min: DYN_RELEASE_MIN_MS,
    max: DYN_RELEASE_MAX_MS,
    step: 1,
    def: 150.2,
    unit: "ms",
  },
];
const COMP_FIELDS: DynField[] = [
  { key: "threshold", name: "COMP_THRESHOLD", min: -54, max: 0, step: 1, def: -18, unit: "db" },
  { key: "ratio", name: "COMP_RATIO", min: DYN_RATIO_MIN, max: 20, step: 0.1, def: 3, unit: "ratio" },
  { key: "gain", name: "COMP_GAIN", min: 0, max: 18, step: 0.5, def: 2, unit: "db", fineStep: 0.1 },
  {
    key: "attack",
    name: "COMP_ATTACK",
    min: DYN_ATTACK_MIN_MS,
    max: DYN_ATTACK_MAX_MS,
    step: 0.1,
    def: 34.58,
    unit: "ms",
  },
  {
    key: "release",
    name: "COMP_RELEASE",
    min: DYN_RELEASE_MIN_MS,
    max: DYN_RELEASE_MAX_MS,
    step: 1,
    def: 218,
    unit: "ms",
  },
];
// Ducker detail (260-263, stereo channel sidechain). Same shapes as GATE but no
// hold; decay shares the ×10 release scale with a wider range. Ordered as the
/**
 * One band of the 4-band PEQ, in the order the unit's own screen reads it (Q, Freq, Gain).
 * The set depends on the filter type only in which of them the device reads — a pass filter
 * reads neither Q nor gain (measured: Q 0.71 and Q 4.00 draw an identical high-pass) and a
 * shelf reads no Q — so every band offers all three and the screen locks the rest. The gain
 * carries the 0.1 dB push-and-turn fine grid, one of the two values on the unit confirmed to
 * have one.
 */
export function eqBandFields(index: number): DynField[] {
  return [
    { key: "q", name: "EQ_BAND_Q", min: EQ_Q_MIN, max: EQ_Q_MAX, step: 0.1, def: EQ_Q_DEFAULT, unit: "q" },
    {
      key: "freq",
      name: "EQ_BAND_FREQ",
      min: EQ_FREQ_MIN_HZ,
      max: EQ_FREQ_MAX_HZ,
      step: 1,
      def: EQ_BAND_DEFAULT_FREQ_HZ[index],
      unit: "hz",
      // Three decades: a linear slider resolves nothing at the bottom of them.
      logSteps: 1000,
    },
    {
      key: "gain",
      name: "EQ_BAND_GAIN",
      min: EQ_GAIN_MIN_DB,
      max: EQ_GAIN_MAX_DB,
      step: 0.5,
      def: 0,
      unit: "db",
      fineStep: 0.1,
    },
  ];
}

// device DUCKER screen reads them (Range / Attack / Decay graph handles, then the
// Threshold box); each field carries its own param name, so order is display-only.
export const DUCKER_FIELDS: DynField[] = [
  { key: "range", name: "DUCKER_RANGE", min: -70, max: 0, step: 1, def: -56, unit: "db" },
  {
    key: "attack",
    name: "DUCKER_ATTACK",
    min: DYN_ATTACK_MIN_MS,
    max: DYN_ATTACK_MAX_MS,
    step: 0.1,
    def: 20.17,
    unit: "ms",
  },
  {
    key: "decay",
    name: "DUCKER_DECAY",
    min: DUCKER_DECAY_MIN_MS,
    max: DUCKER_DECAY_MAX_MS,
    step: 1,
    def: 1000,
    unit: "ms",
  },
  { key: "threshold", name: "DUCKER_THRESHOLD", min: -60, max: 0, step: 1, def: -40, unit: "db" },
];

/**
 * Value → slider position, and back. Identity for a linear field; for a logarithmic
 * one (an EQ band frequency spans three decades, which a linear slider cannot resolve
 * at the bottom) the position is an index into `logSteps` even divisions of the log
 * range. It lives beside the field table rather than in the screen that draws the
 * slider, because the MIDI catalog has to land on the same values: a normalized MIDI
 * value and a dragged slider both resolve to a position, so the two cannot drift.
 */
export function dynToPos(f: DynField, v: number): number {
  if (f.logSteps === undefined) return v;
  return Math.round((f.logSteps * Math.log(v / f.min)) / Math.log(f.max / f.min));
}
export function dynFromPos(f: DynField, pos: number): number {
  if (f.logSteps === undefined) return pos;
  return Math.round(f.min * Math.exp((Math.log(f.max / f.min) * pos) / f.logSteps));
}

/** Format one dynamics value for display, by its unit. The single source for the
 *  inspector, the gate screen and anything else that prints a DynField. */
export function formatDyn(v: number, unit: DynField["unit"]): string {
  if (unit === "db") return `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
  if (unit === "ratio") return `${v.toFixed(1)}:1`;
  if (unit === "hz") return formatHz(v);
  if (unit === "q") return v.toFixed(2);
  return v < 1 ? `${v.toFixed(3)} ms` : `${v.toFixed(1)} ms`;
}

/** The display text for a field's current value, including GATE range's -∞ notch
 *  (one step below its -72 dB floor = fully closed). Keyed off the field itself so
 *  the two surfaces that print it cannot disagree on which field owns the notch —
 *  they previously tested `name === "GATE_RANGE"` and `key === "range"`. */
export function dynValueText(f: DynField, v: number): string {
  if (f.name === "GATE_RANGE" && v <= GATE_RANGE_OFF_DB) return "-∞ dB";
  return formatDyn(v, f.unit);
}

/** GATE/COMP detail controls for a channel: the slider fields and the instance index. */
export interface ChannelDynamics {
  y: number;
  gate: DynField[];
  /** COMP slider fields, or null in SSMCS mode (the morphing strip replaces COMP). */
  comp: DynField[] | null;
}

/**
 * Resolve a channel's GATE/COMP detail controls, or null if it has none. GATE and
 * COMP are MONO IN-channel features (user guide); COMP additionally exists only in
 * COMP->EQ mode (SSMCS replaces it with the morphing strip). Confirmed on a mono
 * channel by live scan (research §12.26).
 */
export function channelDynamics(model: DeviceModel, nodeId: string, compEqType: number): ChannelDynamics | null {
  const cc = channelControl(model, nodeId);
  if (!cc || !cc.hasMicStrip) return null;
  return { y: cc.y, gate: GATE_FIELDS, comp: compEqType === COMP_EQ_SSMCS ? null : COMP_FIELDS };
}

// Push the value-set commands for a GATE/COMP detail section the plan has set.
// Each value is clamped to its DynField plan-domain range before encoding, since
// the shared encoders (e.g. centiDbToVd / releaseToVd) only clamp to the broker's
// raw int/scale bounds, not the per-field dB/ms limits the UI enforces.
function pushDynCommands(
  out: VdCommand[],
  fields: DynField[],
  y: number,
  vals: Record<string, number | undefined>,
): void {
  for (const f of fields) {
    const v = vals[f.key];
    if (v !== undefined) out.push(command(f.name, y, v < f.min ? f.min : v > f.max ? f.max : v));
  }
}

// Push the SSMCS detail value-set commands for one MONO IN channel. Values are
// raw broker integers; the inspector formats them. Only fields the plan set are
// emitted (readback populates them all, keeping emit∘readback a fixed point).
function pushSsmcsBand(
  out: VdCommand[],
  y: number,
  b: SsmcsBand | undefined,
  onName: ParamName,
  qName: ParamName | null,
  freqName: ParamName,
  gainName: ParamName,
  freqMin: number,
  freqMax: number,
): void {
  if (!b) return;
  if (b.on !== undefined) out.push(command(onName, y, b.on ? 1 : 0));
  if (qName && b.q !== undefined) out.push(command(qName, y, boundRaw(b.q, SSMCS_Q_RAW_MIN, SSMCS_Q_RAW_MAX)));
  if (b.freq !== undefined) out.push(command(freqName, y, boundRaw(b.freq, freqMin, freqMax)));
  if (b.gain !== undefined) out.push(command(gainName, y, boundRaw(b.gain, SSMCS_GAIN_MIN, SSMCS_GAIN_MAX)));
}

// FX-channel effect: the EFFECT TYPE selector (679/683 at y0) plus the effect
// parameter array (681/685, addressed by slot). Emitted as absolute state for the
// effect's family; raw values pass straight through (the plan stores raw). The
// type is a sideEffect (writing it repopulates the array on the device), so live
// converges + re-reads. fxIndex = 0 (FX1) / 1 (FX2).
// Bound a RAW / enum value to its catalog range — the last line before an
// out-of-range value reaches the device, since encodeValue's "raw" and "enum"
// cases are pure passthroughs (every numeric encoder in vd.ts clamps internally,
// these two cannot: their range lives in the effect / option catalogs, not in the
// encoder). The inspector already constrains the same bounds, so this only bites
// on a hand-edited or `?plan=` payload. Range only — callers state their own
// policy for a non-finite value, which differs by whether a catalog default
// exists to fall back on.
function boundRaw(raw: number, lo?: number, hi?: number): number {
  if (lo !== undefined && raw < lo) return lo;
  if (hi !== undefined && raw > hi) return hi;
  return raw;
}

// A plan-sourced raw with a catalog default: a non-finite value takes the default
// (plan.ts strips those on load, so this covers hand-built plans only).
function planRaw(v: number | undefined, def: number): number {
  return Number.isFinite(v) ? (v as number) : def;
}

// Coerce an enum to its menu — the same firewall as boundRaw, for the other
// passthrough encoding. An off-menu value would otherwise be written verbatim and
// select something the plan never named.
function boundEnum(v: number, options: readonly { value: number }[], def: number): number {
  return options.some((o) => o.value === v) ? v : def;
}

function pushFxEffectCommands(out: VdCommand[], fxIndex: number, fx: FxEffectParams): void {
  const typeId = FX_EFFECT_TYPE_PARAM[fxIndex];
  const arrId = FX_EFFECT_ARRAY_PARAM[fxIndex];
  // A type this CHANNEL's menu does not offer (hand-edited / ?plan= payload) falls
  // back to the channel's factory type rather than being written verbatim: the
  // device would take an unknown selector value, and fxFamilyOf would emit
  // delay-family slots with it.
  const type = resolveFxEffectType(fxIndex, fx.type);
  out.push(rawCommand("FX_EFFECT_TYPE", typeId, "enum", 0, type));
  out.push(rawCommand("FX_EFFECT_PARAM", arrId, "raw", FX_SLOT_ON, (fx.on ?? true) ? 1 : 0));
  out.push(rawCommand("FX_EFFECT_PARAM", arrId, "raw", FX_SLOT_LEVEL, boundRaw(planRaw(fx.level, 100), 0, 100)));
  for (const desc of fxParams(type)) {
    const raw = boundRaw(planRaw(fx.params?.[desc.key], desc.def), desc.rawMin, desc.rawMax);
    out.push(rawCommand("FX_EFFECT_PARAM", arrId, "raw", desc.slot, raw));
  }
}

// Insert-FX effect: the engine parameter array for the selected effect family
// (guitar 697 / pitch 701 / compander 689 / output 693). Slots + defaults from
// the calibrated catalog; mirror slots (Pitch Coarse/Fine/Formant) get the same
// raw. The selector (emitted by the caller) binds the engine first.
// Only slots the plan explicitly carries are written; absent slots are left to
// the device's per-type defaults populated by the selector (guitar-amp common
// params differ per type, so a single catalog default would clobber them). A
// plan read back from the device carries every slot, so it still round-trips in
// full.
// A slot is read under the selected family's own key, then under the bare slot
// number — the device-shaped namespace a readback writes, which is by construction
// the family the selector named at the time. Anything the plan stored for ANOTHER
// family stays behind its own key and is never emitted here: those raws mean a
// different parameter under a different law.
function pushInsertFxEffectCommands(
  out: VdCommand[],
  engine: number,
  family: import("./insert-fx-effect").InsertFxFamily,
  params: Record<string, number> | undefined,
): void {
  if (!params) return;
  for (const s of insertFxWritableSlots(family)) {
    const v = params[insertFxParamKey(family, s.slot)] ?? params[String(s.slot)];
    // No catalog default to fall back on here (an absent slot is left to the
    // device's per-type default), so a non-finite raw is dropped, not substituted.
    if (!Number.isFinite(v)) continue;
    const raw = boundRaw(v, s.rawMin, s.rawMax);
    out.push(rawCommand("INSERT_FX_EFFECT", engine, "raw", s.slot, raw));
    if (s.mirror !== undefined) out.push(rawCommand("INSERT_FX_EFFECT", engine, "raw", s.mirror, raw));
  }
}

function pushSsmcsCommands(out: VdCommand[], y: number, s: SsmcsParams | undefined): void {
  if (!s) return;
  // Every continuous value is a passthrough "raw" (or the knee "enum"), so it
  // carries the same firewall as the FX / DynFields paths: a hand-edited / ?plan=
  // raw is bounded to the calibrated vd.ts range before it reaches the device.
  if (s.on !== undefined) out.push(command("SSMCS_ON", y, s.on ? 1 : 0));
  if (s.compDrive !== undefined)
    out.push(command("SSMCS_COMP_DRIVE", y, boundRaw(s.compDrive, SSMCS_COMP_DRIVE_MIN, SSMCS_COMP_DRIVE_MAX)));
  if (s.morphing !== undefined)
    out.push(command("SSMCS_MORPHING", y, boundRaw(s.morphing, SSMCS_MORPHING_MIN, SSMCS_MORPHING_MAX)));
  if (s.outGain !== undefined)
    out.push(command("SSMCS_OUT_GAIN", y, boundRaw(s.outGain, SSMCS_GAIN_MIN, SSMCS_GAIN_MAX)));
  const c = s.comp;
  if (c) {
    if (c.attack !== undefined)
      out.push(command("SSMCS_COMP_ATTACK", y, boundRaw(c.attack, SSMCS_ATTACK_RAW_MIN, SSMCS_ATTACK_RAW_MAX)));
    if (c.release !== undefined)
      out.push(command("SSMCS_COMP_RELEASE", y, boundRaw(c.release, SSMCS_RELEASE_RAW_MIN, SSMCS_RELEASE_RAW_MAX)));
    if (c.ratio !== undefined)
      out.push(command("SSMCS_COMP_RATIO", y, boundRaw(c.ratio, SSMCS_RATIO_RAW_MIN, SSMCS_RATIO_RAW_MAX)));
    if (c.knee !== undefined)
      out.push(command("SSMCS_COMP_KNEE", y, boundEnum(c.knee, COMP_KNEE_OPTIONS, COMP_KNEE_DEFAULT)));
    if (c.threshold !== undefined)
      out.push(
        command("SSMCS_COMP_THRESHOLD", y, boundRaw(c.threshold, SSMCS_COMP_INTERNAL_MIN, SSMCS_COMP_INTERNAL_MAX)),
      );
    if (c.makeup !== undefined)
      out.push(command("SSMCS_COMP_MAKEUP", y, boundRaw(c.makeup, SSMCS_COMP_INTERNAL_MIN, SSMCS_COMP_INTERNAL_MAX)));
  }
  const sc = s.sc;
  if (sc) {
    if (sc.on !== undefined) out.push(command("SSMCS_SC_ON", y, sc.on ? 1 : 0));
    if (sc.q !== undefined) out.push(command("SSMCS_SC_Q", y, boundRaw(sc.q, SSMCS_Q_RAW_MIN, SSMCS_Q_RAW_MAX)));
    if (sc.freq !== undefined)
      out.push(command("SSMCS_SC_FREQ", y, boundRaw(sc.freq, SSMCS_FREQ_RAW_MIN, SSMCS_FREQ_RAW_MAX)));
    if (sc.gain !== undefined) out.push(command("SSMCS_SC_GAIN", y, boundRaw(sc.gain, SSMCS_GAIN_MIN, SSMCS_GAIN_MAX)));
  }
  const eq = s.eq;
  if (eq) {
    // Per-band freq sub-ranges: Low caps low, High floors high, Mid spans all.
    pushSsmcsBand(
      out,
      y,
      eq.low,
      "SSMCS_EQ_LOW_ON",
      null,
      "SSMCS_EQ_LOW_FREQ",
      "SSMCS_EQ_LOW_GAIN",
      SSMCS_FREQ_RAW_MIN,
      SSMCS_EQ_LOW_FREQ_RAW_MAX,
    );
    pushSsmcsBand(
      out,
      y,
      eq.mid,
      "SSMCS_EQ_MID_ON",
      "SSMCS_EQ_MID_Q",
      "SSMCS_EQ_MID_FREQ",
      "SSMCS_EQ_MID_GAIN",
      SSMCS_FREQ_RAW_MIN,
      SSMCS_FREQ_RAW_MAX,
    );
    pushSsmcsBand(
      out,
      y,
      eq.high,
      "SSMCS_EQ_HIGH_ON",
      null,
      "SSMCS_EQ_HIGH_FREQ",
      "SSMCS_EQ_HIGH_GAIN",
      SSMCS_EQ_HIGH_FREQ_RAW_MIN,
      SSMCS_FREQ_RAW_MAX,
    );
  }
}

// Push the value-set commands for one node's PEQ bands (input or output). Each
// band emits only the fields the plan set; a fixed-peaking mid band (type null)
// never writes a filter type. A linked control (MIX) writes both L/R instances.
function pushEqBandCommands(out: VdCommand[], ctrl: EqControl, bands: EqBand[]): void {
  for (const band of ctrl.bands) {
    const v = bands[band.index];
    if (!v) continue;
    for (const inst of ctrl.instances) {
      if (v.on !== undefined) out.push(rawCommand("EQ_BAND_ON", band.on, "bool", inst, v.on ? 1 : 0));
      if (v.type !== undefined && band.type !== null) {
        const opts = band.name === "low" ? EQ_TYPE_LOW_OPTIONS : EQ_TYPE_HIGH_OPTIONS;
        out.push(rawCommand("EQ_BAND_TYPE", band.type, "enum", inst, boundEnum(v.type, opts, EQ_TYPE_SHELVING)));
      }
      if (v.q !== undefined) out.push(rawCommand("EQ_BAND_Q", band.q, "q", inst, v.q));
      if (v.freq !== undefined) out.push(rawCommand("EQ_BAND_FREQ", band.freq, "eqFreq", inst, v.freq));
      if (v.gain !== undefined) out.push(rawCommand("EQ_BAND_GAIN", band.gain, "eqGain", inst, v.gain));
    }
  }
}

// Push the EQ 1-knob commands (ON / TYPE / LEVEL) for one node's EQ, on every
// linked instance. When 1-knob is on the device drives the 4-band PEQ, so the
// caller skips the band commands — the bands are device-driven, not authored.
// ON / TYPE / LEVEL is a reset chain, measured on a URX44V: an OFF->ON transition
// discards the type back to Intensity, and any type write discards the level to that
// type's neutral point (Intensity 50, the presets 0). Sending them in this order lands
// all three — but only if all three go out, which is why they carry a `group`: a
// converge round re-sending ON alone would leave the type behind, the next round would
// re-send the type and leave the level behind, and the loop alternates until it runs
// out of rounds. Three links is what makes this one reach a residual; the shorter
// chains behind the other sideEffect params are pinned in translate.test.ts.
function pushEqOneKnobCommands(out: VdCommand[], ctrl: EqOneKnobControl, ok: EqOneKnobParams): void {
  for (const inst of ctrl.instances) {
    const chain: VdCommand[] = [];
    if (ok.on !== undefined) chain.push(rawCommand("EQ_ONE_KNOB_ON", ctrl.on, "bool", inst, ok.on ? 1 : 0));
    // The preset enum is shared across every EQ instance; each screen exposes only
    // its applicable subset, so the menu here is the union of both subsets.
    if (ok.type !== undefined) {
      const type = boundEnum(ok.type, EQ_ONE_KNOB_TYPE_ALL_OPTIONS, EQ_ONE_KNOB_TYPE_DEFAULT);
      chain.push(rawCommand("EQ_ONE_KNOB_TYPE", ctrl.type, "enum", inst, type));
    }
    if (ok.level !== undefined) {
      const level = boundRaw(planRaw(ok.level, EQ_ONE_KNOB_LEVEL_MIN), EQ_ONE_KNOB_LEVEL_MIN, EQ_ONE_KNOB_LEVEL_MAX);
      chain.push(rawCommand("EQ_ONE_KNOB_LEVEL", ctrl.level, "raw", inst, level));
    }
    // Named after the chain's own head address, so there is one spelling of it. Only a
    // chain of two or more can be broken by a partial re-send.
    if (chain.length > 1) for (const c of chain) c.group = `eq1knob:${cmdAddr(chain[0])}`;
    out.push(...chain);
  }
}

/**
 * Resolve a ducker node's instance index (its parent stereo channel's stereo
 * position, via attachTo), or null if it is not a ducker. The ducker's enable
 * (258) and detail (260-263) all address this y.
 *
 * All four positions were confirmed on a URX44V by sentinel write and LCD read-back
 * (y 0..3 = CH5/6, CH7/8, CH9/10, CH11/12). Pair 0 is a different channel on a URX22
 * (`ch_3_4`), which no URX22 has been read to check; the operator accepted that half
 * on 2026-08-13 from the corroboration recorded in the private ledger's D-1, so it is
 * no longer reported as a guess. Getting it wrong would be quiet — the write and the
 * GR meter move together, since meters.ts keys 119 on the ducker node too — so a
 * URX22 that ever reaches this desk is worth one sentinel write and one LCD read.
 */
export function duckerControl(model: DeviceModel, nodeId: string): { y: number } | null {
  const node = model.nodes.find((n) => n.id === nodeId);
  if (!node || node.kind !== "ducker" || !node.attachTo) return null;
  const y = stereoIndexMap(model).get(node.attachTo);
  return y === undefined ? null : { y };
}

// Device routing-source port-ref namespace. Stereo buses occupy 0x100+ as an
// L/R pair; input channels occupy their flat physical input slot (mono CH1-4 =
// 0-3, then each stereo pair takes two — same axis as the input-source param 22).
// The streaming-source (705/706), USB-output (732-735), monitor-source (719/720),
// output-patch (730/731) and ducker-source (259) selectors all store one of these
// ids. (Verified on URX44V: USB out / ducker source of CH9/10 = slot 8, not the
// node index 6.)
const BUS_PORTS: Record<string, { l: number; r: number }> = {
  "bus.stereo": { l: 256, r: 257 },
  "bus.stream": { l: 258, r: 259 },
  "bus.mix1": { l: 288, r: 289 },
  "bus.mix2": { l: 290, r: 291 },
  "bus.mon1": { l: 336, r: 337 },
  "bus.mon2": { l: 338, r: 339 },
};

/** Resolve a routing source node to its port ids (a channel uses its input slots). */
function sourcePorts(model: DeviceModel, nodeId: string): { l: number; r: number } | null {
  const bus = BUS_PORTS[nodeId];
  if (bus) return bus;
  const slots = channelInputSlots(model, nodeId);
  return slots ? { l: slots[0], r: slots[slots.length - 1] } : null;
}

/** Reverse: which source node owns a port id. Buses match their L/R; the rest are channel slots. */
export function nodeForPort(model: DeviceModel, port: number): string | null {
  for (const [id, p] of Object.entries(BUS_PORTS)) if (p.l === port || p.r === port) return id;
  for (const n of model.nodes) {
    if (n.kind !== "channel") continue;
    const slots = channelInputSlots(model, n.id);
    if (slots && slots.includes(port)) return n.id;
  }
  return null;
}

/** microSD Rec track-pair slot nodes (out.sdrec.t1 …) in track order, with the
 *  two device track indices (y on param 736) each pair fills. Empty on models
 *  without a recorder. */
export function recordSlots(model: DeviceModel): { id: string; trackL: number; trackR: number }[] {
  const out: { id: string; trackL: number; trackR: number }[] = [];
  for (const n of model.nodes) {
    const m = /^out\.sdrec\.t(\d+)$/.exec(n.id);
    if (!m) continue;
    const k = Number(m[1]) - 1;
    out.push({ id: n.id, trackL: 2 * k, trackR: 2 * k + 1 });
  }
  return out;
}

/** Record-source port refs (L/R) for a node feeding an SD Rec track pair: a
 *  STEREO/MIX bus, a stereo channel (its two input slots), or a mono channel pair
 *  (its primary's slot L, the partner's slot R = L+1). Null if not a record source. */
function recordSourcePorts(model: DeviceModel, nodeId: string): { l: number; r: number } | null {
  const bus = BUS_PORTS[nodeId];
  if (bus) return bus;
  const slots = channelInputSlots(model, nodeId);
  if (!slots) return null;
  return slots.length === 2 ? { l: slots[0], r: slots[1] } : { l: slots[0], r: slots[0] + 1 };
}

// Physical input port-ref namespace (distinct from the bus/output one above):
// each selectable input source occupies an L/R mono-port pair. Analog mics are
// 0-3; the 0x100+ blocks are stereo sources. The "All Input" / "All USB DAW"
// menu entries are bulk-set actions, not sources, so they are not listed here.
// (Ports verified on URX44V; URX22/44 assumed to share the scheme.)
const INPUT_PORTS: Record<string, [number, number]> = {
  "in.micline_1_2": [0, 1],
  "in.micline_3_4": [2, 3],
  "in.aux": [256, 257],
  "in.usbmain_a": [512, 513],
  "in.usbmain_b": [514, 515],
  "in.usbmain_c": [516, 517],
  "in.usbdaw_1_2": [544, 545],
  "in.usbdaw_3_4": [546, 547],
  "in.usbdaw_5_6": [548, 549],
  "in.usbdaw_7_8": [550, 551],
  "in.usbdaw_9_10": [552, 553],
  "in.usbdaw_11_12": [554, 555],
  "in.usbsub": [576, 577],
  "in.sdplay": [608, 609],
  "in.hdmi": [624, 625],
};

// Param 22's y axis is the flat physical input slot (0-11): mono CH1-4 take one
// slot each, then each stereo pair takes two (L then R). A channel node maps to
// its slot(s) — one for a mono node, an adjacent L/R pair for a stereo node.
export function channelInputSlots(model: DeviceModel, nodeId: string): number[] | null {
  let slot = 0;
  for (const n of model.nodes) {
    if (n.kind !== "channel") continue;
    const span = isStereoChannel(n.id) ? 2 : 1;
    if (n.id === nodeId) return span === 2 ? [slot, slot + 1] : [slot];
    slot += span;
  }
  return null;
}

/** Input ports for a source node, or null if it is not a selectable input. */
export function inputPorts(nodeId: string): [number, number] | null {
  return INPUT_PORTS[nodeId] ?? null;
}

/** Reverse: which input node owns a port id (matches either its L or R). */
export function inputNodeForPort(port: number): string | null {
  for (const [id, [l, r]] of Object.entries(INPUT_PORTS)) if (l === port || r === port) return id;
  return null;
}

// Exclusive routing selectors driven by one incoming wire whose source resolves
// to a bus/channel port: [destNode, kind, paramL, paramR, yL, yR]. Every selector
// has both an L and an R slot (some reuse one param id at two y instances).
// `sourcePorts` maps the wire's source to its L/R port; the param's own encoding
// applies the tag (streaming) or not. Drives both emit and readback so the two
// directions cannot drift. (Input source and ducker key are bespoke — different
// namespace / per-instance shape — and stay separate below.)
export const ROUTING_SELECTORS: [string, ConnectionKind, ParamName, ParamName, number, number][] = [
  ["bus.stream", "source", "STREAM_SRC_L", "STREAM_SRC_R", 0, 0],
  ["out.usbmain_a", "patch", "USB_OUT_SRC_A", "USB_OUT_SRC_A", 0, 1],
  ["out.usbmain_b", "patch", "USB_OUT_SRC_B", "USB_OUT_SRC_B", 0, 1],
  ["out.usbmain_c", "patch", "USB_OUT_SRC_C", "USB_OUT_SRC_C", 0, 1],
  ["out.usbsub", "patch", "USB_OUT_SRC_SUB", "USB_OUT_SRC_SUB", 0, 1],
  ["bus.mon1", "source", "MONITOR_SRC_L", "MONITOR_SRC_R", 0, 0],
  ["bus.mon2", "source", "MONITOR_SRC_L", "MONITOR_SRC_R", 1, 1],
  ["out.main", "patch", "OUT_PATCH_MAIN", "OUT_PATCH_MAIN", 0, 1],
  ["out.line", "patch", "OUT_PATCH_LINE", "OUT_PATCH_LINE", 0, 1],
];

// OSC → bus assign on/off per output channel: which param + L/R instance (FX is
// mono, r = null). The oscillator can feed several buses, each independently.
export interface OscAssign {
  name: ParamName;
  l: number;
  r: number | null;
}
const OSC_ASSIGN: Record<string, OscAssign> = {
  "bus.stereo": { name: "OSC_ASSIGN_STEREO", l: 0, r: 1 },
  "bus.mix1": { name: "OSC_ASSIGN_MIX", l: 0, r: 1 },
  "bus.mix2": { name: "OSC_ASSIGN_MIX", l: 2, r: 3 },
  "bus.fx1": { name: "OSC_ASSIGN_FX", l: 0, r: null },
  "bus.fx2": { name: "OSC_ASSIGN_FX", l: 1, r: null },
};

/** OSC assign target for a bus, or null if the bus is not an OSC destination. */
export function oscAssign(busId: string): OscAssign | null {
  return OSC_ASSIGN[busId] ?? null;
}

/** Bus ids the oscillator can be assigned to, in display order. */
export const OSC_ASSIGN_BUSES = Object.keys(OSC_ASSIGN);

/** Insert FX for a node: which param, the instance(s) it writes, and its options. */
export interface InsertFxControl {
  param: number;
  /** The matching insert FX ON/OFF (bypass) param — 134 / 577 / 670. */
  onParam: number;
  /** Output bus (STEREO / MIX) rather than an input channel — the two use
   *  different option menus and different engine arrays. */
  isOutput: boolean;
  instances: number[];
  options: InsertFxOption[];
}

// MIX bus insert FX shares param 671 (output axis); each stereo MIX occupies the
// same L/R instance pair as its fader.
const MIX_INSERT_FX_INSTANCES: Record<string, number[]> = {
  "bus.mix1": [0, 1],
  "bus.mix2": [2, 3],
};

/**
 * Insert FX for a node, or null if it has none. The MONO IN channels (mono CH1-4)
 * carry the input effects (param 135); the STEREO master (578) and MIX buses
 * (671, L/R-linked) carry the output effects. Stereo input channels have none.
 */
export function insertFxControl(model: DeviceModel, nodeId: string): InsertFxControl | null {
  if (nodeId === "bus.stereo") {
    return {
      param: PARAMS.OUTPUT_INSERT_FX_STEREO.id,
      onParam: PARAMS.OUTPUT_INSERT_FX_ON_STEREO.id,
      isOutput: true,
      instances: [0],
      options: OUTPUT_INSERT_FX_OPTIONS,
    };
  }
  const mix = MIX_INSERT_FX_INSTANCES[nodeId];
  if (mix) {
    return {
      param: PARAMS.OUTPUT_INSERT_FX_MIX.id,
      onParam: PARAMS.OUTPUT_INSERT_FX_ON_MIX.id,
      isOutput: true,
      instances: mix,
      options: OUTPUT_INSERT_FX_OPTIONS,
    };
  }
  const cc = channelControl(model, nodeId);
  if (cc && !isStereoChannel(nodeId)) {
    return {
      param: PARAMS.INSERT_FX.id,
      onParam: PARAMS.INSERT_FX_ON.id,
      isOutput: false,
      instances: [cc.y],
      options: INSERT_FX_OPTIONS,
    };
  }
  return null;
}

/** Which parameters a device write / diff covers: everything the plan implies,
 *  or only what the device stores in a scene ("scene" drops the sceneExternal
 *  catalog entries — see params.ts and core/scene-scope.ts). Diagnostics
 *  (compare / self-test / prepare) always run "all". */
export type WriteScope = "all" | "scene";

/** Bit layout of a packed address key: y in the low ADDR_SHIFT bits, x above it,
 *  paramId above that. The widths hold every address the app can emit with an order
 *  of magnitude to spare (measured over the whole PARAMS catalog and all three
 *  models' default plans: paramId <= 891, x == 0, y <= 18) and keep the key a
 *  non-negative int32, which is what makes the Map lookup cheap. An address outside
 *  them would fold onto another one and silently drop that command's write, so
 *  translate.test.ts pins both the ranges and the injectivity. */
const ADDR_SHIFT = 10;
const ADDR_MASK = (1 << ADDR_SHIFT) - 1;

/**
 * A device address as a map key. Shared with live.ts, whose snapshot and follow
 * index key on it: this decides WHICH COMMANDS COLLAPSE and that decides WHAT THE
 * SNAPSHOT KEYS ON, so a second spelling would let a collapsed command miss its
 * snapshot entry.
 *
 * Packed into one integer rather than a "paramId:x:y" string: measured, the string
 * keying was the collapse's entire cost — +49 µs on a 101 µs buildCommands (782
 * commands), where the packed key builds the same map 4.7x faster. The string form
 * survives as the published one (LiveSync.snapshotEntries, read by the trace probe
 * and the race harness), rendered by formatAddrKey off the cold path.
 */
export const addrKey = (paramId: number, x: number, y: number): number =>
  (paramId << (ADDR_SHIFT * 2)) | (x << ADDR_SHIFT) | y;

export const cmdAddr = (c: VdCommand): number => addrKey(c.paramId, c.x, c.y);

/** A packed key back as "paramId:x:y" — the form the trace probe and the race
 *  harness read off LiveSync.snapshotEntries(). Probe-only, so it stays out of
 *  every hot path that builds or looks up a key. */
export const formatAddrKey = (key: number): string =>
  `${key >>> (ADDR_SHIFT * 2)}:${(key >>> ADDR_SHIFT) & ADDR_MASK}:${key & ADDR_MASK}`;

/**
 * Collapse a repeated device address down to ONE command, keeping the LAST.
 *
 * An insert effect's parameters live in one engine array per effect FAMILY,
 * addressed `engine:0:slot` with no channel axis (see insert-fx-effect.ts), so
 * two nodes holding the same family emit the same addresses carrying their own
 * values. Last-wins matches what the device ends up holding either way: an
 * ordered sendCommands (client.ts) applies the commands in list order, so the
 * last one is the value left standing on the unit.
 *
 * The survivor stays at its OWN index rather than being hoisted to the first
 * occurrence's: a type selector repopulates the engine array it binds with that
 * type's defaults (insert-fx-effect.ts), so a hoisted survivor would be written
 * before the later owner's selector and erased by it, leaving the unit holding
 * neither owner's value.
 *
 * A dropped command whose value the survivor already carries is no loss (the
 * state every device readback produces), so only differing ones are stamped onto
 * the survivor as `shadowed` — what the surfaces report.
 */
export function collapseSharedAddrs(commands: VdCommand[]): VdCommand[] {
  const keys = new Int32Array(commands.length);
  const lastIndex = new Map<number, number>();
  let repeated = false;
  for (let i = 0; i < commands.length; i++) {
    const key = cmdAddr(commands[i]);
    keys[i] = key;
    if (lastIndex.has(key)) repeated = true;
    lastIndex.set(key, i);
  }
  if (!repeated) return commands;
  const shadowed = new Map<number, string[]>();
  const out: VdCommand[] = [];
  // One forward pass: lastIndex holds the LAST index of an address, so every
  // shadowed owner sits before its survivor and its list is complete by the time
  // the survivor is reached.
  for (let i = 0; i < commands.length; i++) {
    const keep = lastIndex.get(keys[i])!;
    if (keep !== i) {
      if (commands[i].vdValue !== commands[keep].vdValue) {
        // Emission order, duplicates kept as-is: a group whose owner repeats stays
        // visible rather than being filtered into silence.
        const owner = commands[i].node ?? "?";
        const list = shadowed.get(keep);
        if (list) list.push(owner);
        else shadowed.set(keep, [owner]);
      }
      continue;
    }
    const dropped = shadowed.get(i);
    out.push(dropped ? { ...commands[i], shadowed: dropped } : commands[i]);
  }
  return out;
}

/** One address's set of plan owners: the one whose value reaches the device, and
 *  the ones whose differing values the collapse dropped. */
export interface SharedOwners {
  /** Owner node whose command survived (undefined for a global address). */
  kept?: string;
  /** Owner nodes whose commands were dropped, in emission order. */
  dropped: string[];
}

/** Identity of one owner set. The grouping below and the report latch (collisionKey)
 *  spell it here rather than each for itself: two spellings that drift make live.ts
 *  group by one rule and compare by another, so a standing collision either
 *  re-reports every flush or a new one is swallowed. */
const ownerKey = (kept: string | undefined, dropped: readonly string[]): string => `${kept ?? ""}<${dropped.join("+")}`;

/** The owner sets a collapsed command list reports, grouped so the several slots
 *  one shared engine array carries read as ONE collision, in emission order.
 *  A survivor with no owner node is a global address: nothing global collides
 *  today, and one that did would want a message of its own rather than this
 *  node-names-two-nodes one, so it is skipped instead of naming an empty node. */
export function collisionOwners(commands: readonly VdCommand[]): SharedOwners[] {
  const groups: SharedOwners[] = [];
  const seen = new Set<string>();
  for (const c of commands) {
    if (!c.shadowed?.length || !c.node) continue;
    const key = ownerKey(c.node, c.shadowed);
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push({ kept: c.node, dropped: [...c.shadowed] });
  }
  return groups;
}

/** Language-independent identity of an owner set — what a report latches on.
 *  Values are deliberately excluded, so a drag does not re-report while a change
 *  of contenders does. Empty string when nothing collided. */
export function collisionKey(owners: readonly SharedOwners[]): string {
  return owners.map((o) => ownerKey(o.kept, o.dropped)).join(";");
}

/**
 * Translate a plan into the list of vd value-set commands it currently implies.
 * Deterministic and side-effect free; the same plan always yields the same list,
 * so callers can diff it for a confirm-before-send preview. `scope` filters the
 * finished list by ParamName, so the scene boundary cannot drift from the
 * catalog flags — and the same filter scopes every consumer (write diff, live
 * snapshot / flush, follow notify registration) at this one chokepoint.
 *
 * One device address yields exactly one command: a repeated address is collapsed
 * to its last (collapseSharedAddrs), before the scope filter so the scene subset
 * stays the full list filtered by ParamName. What that dropped is reported by the
 * live status line, the write confirm and the compare report.
 */
export interface EmitOptions {
  /**
   * Also emit the values the **device** drives, which this function otherwise leaves
   * alone — today the 4-band PEQ while EQ 1-knob is on. Not authoring them is the
   * right default and stays it: the app must not model what the unit computes.
   *
   * The self-test's restore is the one caller that needs them, and for a different
   * reason than mirroring. Putting a unit back exactly as it was found is not the same
   * act as writing a plan onto it: a unit found with 1-knob ON has its bands written by
   * every sweep pass (the sweep flips 1-knob off) and emitted by no restore, so its
   * VISIBLE EQ ends changed under a verdict that says it was restored.
   *
   * Measured on a URX44V before relying on it (2026-08-10): a band gain written while
   * 1-knob is on is accepted (response_code 200) and still holds 1.5 s later — the unit
   * does not re-derive over it. Ordering is what matters instead: writing the 1-knob
   * LEVEL while it is on makes the unit recompute base x level/50, so the bands must go
   * out AFTER the 1-knob chain — which is the order below, and which a probe that got
   * it backwards demonstrated by leaving a band at a fifth of its value.
   */
  includeDeviceDriven?: boolean;
}

export function planToCommands(
  model: DeviceModel,
  plan: Plan,
  scope: WriteScope = "all",
  emit: EmitOptions = {},
): VdCommand[] {
  const commands = collapseSharedAddrs(buildCommands(model, plan, emit));
  if (scope === "all") return commands;
  return commands.filter((c) => (PARAMS[c.name] as ParamSpec).sceneExternal !== true);
}

/**
 * The commands a plan implies BEFORE the collapse — the only view in which a shared
 * address is visible AS a repeat. Exported for the contract test that pins which
 * families share one: asked of planToCommands, "no address repeats" and "one ParamName
 * per address" are true by construction of the collapse and pin nothing.
 *
 * Nothing that talks to a device may use this: a repeated address sends the losing
 * owner's value and then overwrites it, which is the defect the collapse removes.
 */
export function planToCommandsUncollapsed(model: DeviceModel, plan: Plan): VdCommand[] {
  return buildCommands(model, plan);
}

function buildCommands(model: DeviceModel, plan: Plan, emit: EmitOptions = {}): VdCommand[] {
  const out: VdCommand[] = [];
  // Owner-node stamping for the device-follow index: own(id) attributes every
  // command pushed since the last own() call to `id`. `mark` auto-advances, so a
  // single own(id) at the end of each per-node block (or iteration) covers that
  // node's commands — including those pushed by the push* helpers. Any block that
  // can push then `continue` must call own(id) before the continue so its commands
  // are not mis-attributed to the next iteration's node.
  let mark = 0;
  const own = (id: string | undefined): void => {
    for (let i = mark; i < out.length; i++) if (out[i].node === undefined) out[i].node = id;
    mark = out.length;
  };
  // Sample rate (global y0, raw Hz). A top-level plan scalar (always set), so it is
  // emitted unconditionally as absolute state. Writing it re-clocks the hardware;
  // only 766 is sent (843 auto-follows). See params.ts SAMPLE_RATE.
  //
  // Emitted FIRST so the rest of the write lands on a device already clocked the way
  // the plan says. Re-clocking is the largest single thing a write can do to the
  // hardware, and everything after it is a value meant to hold under that clock.
  // Confirmed on a URX44V: a rate-changing write completes, with the commands that
  // follow the re-clock all reaching the device.
  out.push(command("SAMPLE_RATE", 0, plan.sampleRate));
  own(undefined);

  // Channel node parameters: ON / HPF / gain.
  for (const node of model.nodes) {
    if (node.kind !== "channel") continue;
    const np = plan.nodeParams[node.id];
    if (!np) continue;
    const cc = channelControl(model, node.id);
    if (!cc) continue;
    if (np.on !== undefined) out.push(rawCommand("CH_ON", cc.on, "bool", cc.y, np.on ? 1 : 0));
    if (cc.hasHpf && np.hpf !== undefined) out.push(command("HPF_ON", cc.y, np.hpf ? 1 : 0));
    if (cc.hasHpf && np.hpfFreq !== undefined) out.push(command("HPF_FREQ", cc.y, np.hpfFreq));
    if (cc.hasMicStrip && np.phantom !== undefined) out.push(command("PHANTOM", cc.y, np.phantom ? 1 : 0));
    if (cc.hasMicStrip && np.clipSafe !== undefined) out.push(command("CLIP_SAFE", cc.y, np.clipSafe ? 1 : 0));
    // Polarity invert: one toggle (mono) or two independent L/R (stereo).
    for (const ph of cc.phases) {
      const v = np[ph.key];
      if (v !== undefined) out.push(rawCommand(ph.name, ph.param, "bool", ph.y, v ? 1 : 0));
    }
    if (cc.hasHiZ && np.hiZ !== undefined) out.push(command("HI_Z", cc.y, np.hiZ ? 1 : 0));
    // COMP/EQ type (COMP->EQ vs SSMCS) is a MONO IN channel feature (= mic strip).
    if (cc.hasMicStrip && np.compEqType !== undefined)
      out.push(command("COMP_EQ_TYPE", cc.y, boundEnum(np.compEqType, COMP_EQ_OPTIONS, COMP_EQ_COMP_FIRST)));
    // Rec Point: per-channel record / direct-out tap (cc.recPoint = mono 137 /
    // stereo 264, resolved by channelControl like fader/on/pan).
    if (np.recPoint !== undefined)
      out.push(
        rawCommand(
          "REC_POINT",
          cc.recPoint,
          "enum",
          cc.y,
          boundEnum(np.recPoint, REC_POINT_OPTIONS, REC_POINT_DEFAULT),
        ),
      );
    // Channel-strip section ON (GATE/COMP/EQ). The active COMP/EQ bank follows the
    // type; polarity per toggle. Stereo channels expose only EQ.
    for (const sec of channelSections(model, node.id, np.compEqType ?? COMP_EQ_COMP_FIRST)) {
      const v = np[sec.key];
      if (v !== undefined) out.push(rawCommand(sec.name, sec.param, "bool", sec.y, v ? sec.onValue : 1 - sec.onValue));
    }
    // Input EQ 1-knob (mono COMP->EQ / stereo channels). When on, the device
    // drives the bands, so the band commands below are skipped.
    const iok = eqOneKnob(model, node.id, np.compEqType ?? COMP_EQ_COMP_FIRST);
    if (iok && np.eqOneKnob) pushEqOneKnobCommands(out, iok, np.eqOneKnob);
    // Input 4-band PEQ band values (mono COMP->EQ mode / stereo channels).
    const ieq = inputEq(model, node.id, np.compEqType ?? COMP_EQ_COMP_FIRST);
    if (ieq && np.eqBands && (emit.includeDeviceDriven || !np.eqOneKnob?.on)) pushEqBandCommands(out, ieq, np.eqBands);
    // Input GATE / COMP detail values (MONO IN channels; COMP only in COMP->EQ).
    const dyn = channelDynamics(model, node.id, np.compEqType ?? COMP_EQ_COMP_FIRST);
    if (dyn) {
      if (np.gate) pushDynCommands(out, dyn.gate, dyn.y, np.gate as Record<string, number | undefined>);
      if (dyn.comp && np.comp) {
        pushDynCommands(out, dyn.comp, dyn.y, np.comp as Record<string, number | undefined>);
        if (np.comp.knee !== undefined)
          out.push(command("COMP_KNEE", dyn.y, boundEnum(np.comp.knee, COMP_KNEE_OPTIONS, COMP_KNEE_DEFAULT)));
        if (np.comp.autoMakeup !== undefined) out.push(command("COMP_AUTO_MAKEUP", dyn.y, np.comp.autoMakeup ? 1 : 0));
        if (np.comp.oneKnob !== undefined) out.push(command("COMP_ONE_KNOB", dyn.y, np.comp.oneKnob ? 1 : 0));
        // COMP 1-knob level is a passthrough 0..100 raw (enum encoding), bounded here.
        if (np.comp.oneKnobLevel !== undefined)
          out.push(command("COMP_ONE_KNOB_LEVEL", dyn.y, boundRaw(np.comp.oneKnobLevel, 0, 100)));
      }
      // SSMCS detail (MONO IN, SSMCS mode). Comp/EQ section ON are emitted above
      // via channelSections (compOn/eqOn). Sweet Spot Data is a string param, so it
      // rides the string-write path (collectSsmcsPresetWrites), not this numeric
      // catalog. All values here raw.
      if (!dyn.comp && cc.hasMicStrip && (np.compEqType ?? COMP_EQ_COMP_FIRST) === COMP_EQ_SSMCS) {
        pushSsmcsCommands(out, dyn.y, np.ssmcs);
      }
    }
    if (cc.gain && np.gain !== undefined) {
      // A.Gain (mono) is one instance; D.Gain (stereo) writes both linked L/R.
      for (const yi of cc.gain.instances) out.push(rawCommand("HA_GAIN", cc.gain.param, "gain", yi, np.gain));
    }
    own(node.id);
  }

  // MONO IN pair-level CH SETTING: Signal Type (stereo link) and PAN/BAL mode, both
  // held on the pair's primary (odd) channel. Signal Type (23) writes BOTH channels'
  // input indices (1 = STEREO link / 0 = MONO x2); PAN/BAL (891) writes the primary's
  // index only (0 = PAN / 1 = BAL). Both reset dependent device state, so live must
  // converge. Commands are attributed to the primary node.
  //
  // Emitted BEFORE the two connection blocks below: switching either selector makes
  // the unit slam the pair's CH_PAN and every bus send's pan (measured — BAL→PAN hard-
  // pans to ±63, PAN→BAL and unlinking centre), so a pan written ahead of the selector
  // is discarded by the device. The selector leads and the plan's pans land on top.
  for (const [primary, secondary] of model.channelPairs) {
    const np = plan.nodeParams[primary];
    if (!np) continue;
    const py = channelControl(model, primary)?.y;
    const sy = channelControl(model, secondary)?.y;
    if (py === undefined) continue;
    if (np.stereoLink !== undefined && sy !== undefined) {
      out.push(command("SIGNAL_TYPE", py, np.stereoLink ? 1 : 0));
      out.push(command("SIGNAL_TYPE", sy, np.stereoLink ? 1 : 0));
    }
    if (np.panBal !== undefined) out.push(command("PAN_BAL", py, boundEnum(np.panBal, PAN_BAL_OPTIONS, PAN_BAL_PAN)));
    own(primary);
  }

  for (const conn of plan.connections) {
    // Fixed main path into STEREO: the channel's CH_FADER / CH_PAN, or the FX
    // channel's FX_CHANNEL_FADER / FX_CHANNEL_BAL — the source's main level / pan.
    if (parseRef(conn.to).nodeId !== "bus.stereo" || !isFixedConnection(model, conn.from, conn.to)) continue;
    const fromId = parseRef(conn.from).nodeId;
    const cc = channelControl(model, fromId);
    if (cc) {
      out.push(rawCommand("CH_FADER", cc.fader, "level", cc.y, conn.params?.level ?? 0));
      out.push(rawCommand("CH_PAN", cc.pan, "pan", cc.y, conn.params?.pan ?? 0));
      // → STEREO bus assign ON (post-fader, firmware V1.3). Ships ON; distinct from
      // the channel master CH_ON (emitted above from np.on).
      out.push(rawCommand("STEREO_ASSIGN_ON", cc.stereoOn, "bool", cc.y, (conn.params?.on ?? true) ? 1 : 0));
    } else {
      const fxY = fxChannelIndex(fromId);
      const mixL = MIX_FADER_INSTANCES[fromId]?.[0];
      if (fxY !== null) {
        out.push(rawCommand("FX_CHANNEL_FADER", PARAMS.FX_CHANNEL_FADER.id, "level", fxY, conn.params?.level ?? 0));
        out.push(rawCommand("FX_CHANNEL_BAL", PARAMS.FX_CHANNEL_BAL.id, "pan", fxY, conn.params?.pan ?? 0));
        out.push(rawCommand("STEREO_ASSIGN_ON", FX_STEREO_ASSIGN_ON, "bool", fxY, (conn.params?.on ?? true) ? 1 : 0));
      } else if (mixL !== undefined) {
        // MIX 1/2 → STEREO "TO ST": an ON/OFF switch at the MIX's L instance (off
        // by default, factory). No level/pan — the send is fixed routing.
        out.push(command("TO_ST", mixL, (conn.params?.on ?? false) ? 1 : 0));
      }
    }
    own(fromId);
  }

  // CH / FX-channel → MIX/FX bus sends — written as absolute state over every
  // send-capable pair. Every send is fixed (always wired), so its routing is a
  // constant and its on/off lives in conn.params.on (SEND_ON = params.on ?? true);
  // a pair the plan is missing a wire for (an old plan loaded without the fixed
  // seed) is treated as off. Params: level / pan(BAL) / PRE-POST tap; MIX writes
  // both linked L/R instances.
  for (const node of model.nodes) {
    if (node.kind !== "channel" && fxChannelIndex(node.id) === null) continue;
    for (const bus of model.nodes) {
      if (bus.kind !== "bus") continue;
      const sc = sendControl(model, node.id, bus.id);
      if (!sc) continue;
      const conn = plan.connections.find((c) => c.from === ref(node.id, "out") && c.to === ref(bus.id, "in"));
      if (!conn) {
        for (const p of sc.on) out.push(rawCommand("SEND_ON", p, "bool", sc.y, 0));
        continue;
      }
      const on = (conn.params?.on ?? true) ? 1 : 0;
      for (const p of sc.level) out.push(rawCommand("SEND_LEVEL", p, "level", sc.y, conn.params?.level ?? 0));
      for (const p of sc.pan) out.push(rawCommand("SEND_PAN", p, "pan", sc.y, conn.params?.pan ?? 0));
      for (const p of sc.on) out.push(rawCommand("SEND_ON", p, "bool", sc.y, on));
      // CH -> FX taps are read-only (broker max_value=0 rejects a PRE write); they
      // are read back but never written. Other taps are settable. See sendTapWritable.
      if (sendTapWritable(model, conn.from, conn.to))
        out.push(rawCommand("SEND_TAP", sc.tap, "bool", sc.y, conn.params?.tap === "pre" ? 1 : 0));
    }
    own(node.id);
  }

  // Bus output faders: STEREO master (581, single) and MIX (674, L/R-linked).
  for (const node of model.nodes) {
    if (node.kind !== "bus") continue;
    const bf = busFader(node.id);
    const np = plan.nodeParams[node.id];
    if (!bf || np?.level === undefined) continue;
    for (const yi of bf.instances) out.push(rawCommand(bf.name, bf.param, "level", yi, np.level));
    own(node.id);
  }

  // Bus master balance / pan: STEREO master (583, single) and MIX (676, L/R-linked).
  for (const node of model.nodes) {
    if (node.kind !== "bus") continue;
    const bb = busBalance(node.id);
    const np = plan.nodeParams[node.id];
    if (!bb || np?.pan === undefined) continue;
    for (const yi of bb.instances) out.push(rawCommand(bb.name, bb.param, "pan", yi, np.pan));
    own(node.id);
  }

  // FX-channel effects: EFFECT TYPE + parameter array for each FX channel present
  // in the plan (emitted as absolute state once the plan carries an fxEffect).
  for (const node of model.nodes) {
    const fxY = fxChannelIndex(node.id);
    if (fxY === null) continue;
    const fx = plan.nodeParams[node.id]?.fxEffect;
    if (fx) pushFxEffectCommands(out, fxY, fx);
    own(node.id);
  }

  // Insert FX (enum): mono input channels (135) and output buses (578 / 671).
  // When the selected effect has editable parameters (guitar amp / pitch fix /
  // compander / multi-band comp), also emit its engine parameter array. The
  // selector binds + populates the engine; the array writes override with the
  // plan's values (absolute state, like the FX-channel effects). The ON/OFF
  // (bypass) switch is emitted after the selector: the device auto-engages it on
  // every (re)selection, so the plan's state must land last to stick. With No
  // Effect selected the device ignores the switch, so it is not written then.
  for (const node of model.nodes) {
    const ifx = insertFxControl(model, node.id);
    const np = plan.nodeParams[node.id] ?? {};
    if (!ifx || np.insertFx === undefined) continue;
    // An off-menu selector value is coerced to No Effect rather than written: the
    // device would take it verbatim and could bind an effect the plan never named.
    const v = ifx.options.some((o) => o.value === np.insertFx) ? np.insertFx : INSERT_FX_NONE;
    for (const inst of ifx.instances) out.push(rawCommand("INSERT_FX", ifx.param, "insertFx", inst, v));
    if (np.insertFxOn !== undefined && v !== INSERT_FX_NONE) {
      for (const inst of ifx.instances) {
        out.push(rawCommand("INSERT_FX_ON", ifx.onParam, "bool", inst, np.insertFxOn ? 1 : 0));
      }
    }
    const fam = insertFxFamilyOf(v);
    if (fam) pushInsertFxEffectCommands(out, insertFxEngine(fam, ifx.isOutput), fam, np.insertFxParams);
    own(node.id);
  }

  // Output bus EQ ON: STEREO (498, single) and MIX (591, L/R-linked).
  for (const node of model.nodes) {
    if (node.kind !== "bus") continue;
    const eq = busEqOn(node.id);
    const np = plan.nodeParams[node.id];
    if (!eq || np?.eqOn === undefined) continue;
    for (const inst of eq.instances) out.push(rawCommand(eq.name, eq.param, "bool", inst, np.eqOn ? 1 : 0));
    own(node.id);
  }

  // Output bus EQ 1-knob (STEREO / MIX). When on, the device drives the bands.
  for (const node of model.nodes) {
    if (node.kind !== "bus") continue;
    const ok = plan.nodeParams[node.id]?.eqOneKnob;
    const ctrl = eqOneKnob(model, node.id, COMP_EQ_COMP_FIRST);
    if (ctrl && ok) pushEqOneKnobCommands(out, ctrl, ok);
    own(node.id);
  }

  // Output bus 4-band PEQ band values: STEREO (single) and MIX (L/R-linked).
  // Skipped when 1-knob is on (the device computes the bands).
  for (const node of model.nodes) {
    if (node.kind !== "bus") continue;
    const np = plan.nodeParams[node.id];
    const oeq = outputEq(node.id);
    if (oeq && np?.eqBands && (emit.includeDeviceDriven || !np.eqOneKnob?.on)) pushEqBandCommands(out, oeq, np.eqBands);
    own(node.id);
  }

  // Ducker on/off + detail (threshold/range/attack/decay): one per stereo channel,
  // stored on the ducker node and addressed at its parent channel's stereo index.
  for (const node of model.nodes) {
    if (node.kind !== "ducker") continue;
    const dc = duckerControl(model, node.id);
    const np = plan.nodeParams[node.id];
    if (!dc) continue;
    if (np?.duckerOn !== undefined) out.push(command("DUCKER_ON", dc.y, np.duckerOn ? 1 : 0));
    if (np?.ducker) pushDynCommands(out, DUCKER_FIELDS, dc.y, np.ducker as Record<string, number | undefined>);
    // Ducker key source (259): the incoming key wire picks a channel or bus; emit
    // its port (a channel uses its L input slot, a bus its L port). No key wire
    // emits the NONE sentinel so a write clears the device's key selection.
    const key = incomingConnection(plan, ref(node.id, "in"), "key");
    if (key) {
      const p = sourcePorts(model, parseRef(key.from).nodeId);
      if (p) out.push(command("DUCKER_SRC", dc.y, p.l));
    } else {
      out.push(command("DUCKER_SRC", dc.y, PORT_REF_NONE));
    }
    own(node.id);
  }

  // Input source select — absolute. A source wire picks a physical input, encoded
  // as a raw port ref; no wire emits the NONE sentinel so a write clears the
  // device's selection, matching readback (NONE = no source wire). MONO CH1-4 use
  // param 22 indexed by physical input slot (a mono node fills one slot, even = L /
  // odd = R). Stereo channels use the separate 209/210 (L/R) pair indexed by stereo
  // pair index — param 22 only covers the mono slots (confirmed on URX44V).
  const srcStereoIdx = stereoIndexMap(model);
  for (const node of model.nodes) {
    if (node.kind !== "channel") continue;
    const conn = incomingConnection(plan, ref(node.id, "in"), "source");
    const ports = conn ? inputPorts(parseRef(conn.from).nodeId) : null;
    // A wire to a source not in the input namespace is left untouched.
    if (conn && !ports) continue;
    if (isStereoChannel(node.id)) {
      const si = srcStereoIdx.get(node.id);
      if (si === undefined) continue;
      out.push(command("STEREO_INPUT_SOURCE_L", si, ports ? ports[0] : PORT_REF_NONE));
      out.push(command("STEREO_INPUT_SOURCE_R", si, ports ? ports[1] : PORT_REF_NONE));
    } else {
      const slots = channelInputSlots(model, node.id);
      if (!slots) continue;
      for (const s of slots) out.push(command("INPUT_SOURCE", s, ports ? ports[s & 1] : PORT_REF_NONE));
    }
    own(node.id);
  }

  // Streaming / USB-out / monitor / analog-patch selects — absolute. One incoming
  // wire → source port(s); no wire emits the NONE sentinel so a write clears the
  // selection. Skips selectors whose destination node is absent on this model.
  // See ROUTING_SELECTORS; readback consumes the same table.
  for (const [to, kind, pl, pr, yl, yr] of ROUTING_SELECTORS) {
    if (!model.nodes.some((n) => n.id === to)) continue;
    const conn = incomingConnection(plan, ref(to, "in"), kind);
    const p = conn ? sourcePorts(model, parseRef(conn.from).nodeId) : null;
    // A wire to a source that does not resolve to a port is left untouched.
    if (conn && !p) continue;
    out.push(command(pl, yl, p ? p.l : PORT_REF_NONE));
    out.push(command(pr, yr, p ? p.r : PORT_REF_NONE));
    own(to);
  }

  // microSD Rec per-track source assign (param 736) — absolute over every track-pair
  // slot. A record wire picks one source (channel pair / STEREO / MIX); its L/R port
  // refs go to the pair's two tracks. No wire writes the NONE sentinel to both,
  // matching readback (NONE = no record wire). Track Count (839) is never emitted —
  // the broker refuses every value above two tracks (see PARAMS.SD_REC_TRACK_COUNT).
  // Absent on models without a recorder (recordSlots is then empty).
  for (const slot of recordSlots(model)) {
    const conn = incomingConnection(plan, ref(slot.id, "in"), "record");
    const p = conn ? recordSourcePorts(model, parseRef(conn.from).nodeId) : null;
    // A wire to a source that does not resolve to a port is left untouched.
    if (conn && !p) continue;
    out.push(command("SD_REC_SOURCE", slot.trackL, p ? p.l : PORT_REF_NONE));
    out.push(command("SD_REC_SOURCE", slot.trackR, p ? p.r : PORT_REF_NONE));
    own(slot.id);
  }

  // Bus master ON/OFF: STEREO master (582, y = 0), MIX buses (675, L/R-linked per
  // MIX) and the FX channels (338, one instance per FX).
  for (const node of model.nodes) {
    if (node.kind !== "bus") continue;
    const bm = busMasterOn(node.id);
    const np = plan.nodeParams[node.id];
    if (!bm || np?.on === undefined) continue;
    for (const inst of bm.instances) out.push(rawCommand(bm.name, bm.param, "bool", inst, np.on ? 1 : 0));
    own(node.id);
  }

  // BUS Type for MIX buses (587, L/R-linked): VARI / FIXED. A MIX-only attribute,
  // written to both out instances. Pan Link (589, VARI only) rides the same loop —
  // a single switch at the MIX's L instance (sends' pan follows the source PAN).
  for (const node of model.nodes) {
    if (node.kind !== "bus") continue;
    const mix = MIX_FADER_INSTANCES[node.id];
    if (!mix) continue;
    const np = plan.nodeParams[node.id];
    if (np?.busType !== undefined)
      for (const inst of mix)
        out.push(command("BUS_TYPE", inst, boundEnum(np.busType, BUS_TYPE_OPTIONS, BUS_TYPE_VARI)));
    if (np?.panLink !== undefined) out.push(command("PAN_LINK", mix[0], np.panLink ? 1 : 0));
    own(node.id);
  }

  // Monitor bus ON / level / CUE interrupt / MONO: bus.mon1 → y0, bus.mon2 → y1.
  for (const [id, y] of [
    ["bus.mon1", 0],
    ["bus.mon2", 1],
  ] as const) {
    const np = plan.nodeParams[id];
    if (np?.on !== undefined) out.push(command("MONITOR_ON", y, np.on ? 1 : 0));
    if (np?.level !== undefined) out.push(command("MONITOR_LEVEL", y, np.level));
    if (np?.cueInterrupt !== undefined) out.push(command("MONITOR_CUE_INTERRUPT", y, np.cueInterrupt ? 1 : 0));
    if (np?.mono !== undefined) out.push(command("MONITOR_MONO", y, np.mono ? 1 : 0));
    // PHONES level shares the monitor's y axis (PHONES 1 ↔ mon1 = y0, PHONES 2 ↔ mon2 = y1).
    if (np?.phonesLevel !== undefined) out.push(command("PHONES_LEVEL", y, np.phonesLevel));
    own(id);
  }

  // Oscillator generator (bus.osc node): on / level / mode / frequency.
  const osc = plan.nodeParams["bus.osc"]?.osc;
  if (osc?.on !== undefined) out.push(command("OSC_ON", 0, osc.on ? 1 : 0));
  if (osc?.level !== undefined) out.push(command("OSC_LEVEL", 0, osc.level));
  if (osc?.mode !== undefined) out.push(command("OSC_MODE", 0, boundEnum(osc.mode, OSC_MODE_OPTIONS, OSC_MODE_SINE)));
  if (osc?.freq !== undefined) out.push(command("OSC_FREQ", 0, osc.freq));
  // Burst Noise width (seconds → ms ×1000) / interval (seconds, raw). Burst mode
  // only on the device, but emitted whenever present (like freq for Sine). The
  // interval is a passthrough raw (1..30 s), so it carries the emit-path firewall.
  if (osc?.width !== undefined) out.push(command("OSC_BURST_WIDTH", 0, osc.width));
  if (osc?.interval !== undefined) out.push(command("OSC_BURST_INTERVAL", 0, boundRaw(osc.interval, 1, 30)));
  own("bus.osc");

  // STREAMING DELAY (bus.stream node, global y = 0): on / time / frame rate.
  // Emitted only when the plan carries delay settings, leaving the device's
  // delay untouched otherwise (like the oscillator generator above).
  const delay = plan.nodeParams["bus.stream"]?.delay;
  if (delay?.on !== undefined) out.push(command("STREAM_DELAY_ON", 0, delay.on ? 1 : 0));
  if (delay?.time !== undefined) out.push(command("STREAM_DELAY_TIME", 0, delay.time));
  if (delay?.frameRate !== undefined)
    out.push(
      command(
        "STREAM_DELAY_FRAME_RATE",
        0,
        boundEnum(delay.frameRate, DELAY_FRAME_RATE_OPTIONS, DELAY_FRAME_RATE_DEFAULT),
      ),
    );
  own("bus.stream");

  // OSC → bus assign — absolute over every OSC-assignable bus. A wire turns the
  // destination's L/R channels on (oscL/oscR; absent = on); no wire turns both
  // off, matching readback (both off = no wire). FX buses are mono (R skipped).
  for (const busId of OSC_ASSIGN_BUSES) {
    const a = oscAssign(busId);
    if (!a) continue;
    const conn = plan.connections.find((c) => c.from === ref("bus.osc", "out") && c.to === ref(busId, "in"));
    out.push(command(a.name, a.l, conn && conn.params?.oscL !== false ? 1 : 0));
    if (a.r !== null) out.push(command(a.name, a.r, conn && conn.params?.oscR !== false ? 1 : 0));
    own(busId);
  }

  // CH SETTING color (palette index): input channels (20) and MIX/STEREO buses
  // (586 / 496), written to every linked instance. Emitted only when the node
  // carries a color, so an uncolored node leaves the device's color untouched; a
  // hex outside the device palette is skipped rather than guessed.
  for (const node of model.nodes) {
    const hex = plan.nodeColors[node.id];
    if (!hex) continue;
    const cc = colorControl(model, node.id);
    if (!cc) continue;
    const index = hexToColorIndex(hex);
    if (index === null) continue;
    for (const inst of cc.instances) out.push(rawCommand(cc.name, cc.param, "raw", inst, index));
    own(node.id);
  }
  return out;
}

/** One address the app READS but never writes, for the device-follow registration. */
export interface FollowOnlyAddr {
  param: number;
  x: number;
  y: number;
  /** Catalog name, for the follow's per-control accounting. Same convention the
   *  emitted send commands use: the PARAMS entry names the command and its encoding,
   *  while the address is computed per instance. */
  name: ParamName;
  /** Owner node whose scoped read repairs it. Undefined would mean "device-wide", which
   *  routes the notify to a full read — nothing needs that today, and an address that
   *  did would also have to be readable on a scoped read to be worth indexing. */
  node: string;
}

/**
 * Addresses the unit announces, the app reads, and nothing emits — so `planToCommands`
 * does not carry them and they would be in no notify registration. Registering them is
 * what lets a front-panel change reach the plan instead of waiting for the next full
 * read. Both families were measured announcing a change on a URX44V (2026-08-11, System
 * V1.3.1.0); the addresses that genuinely stay silent (D.Gain, the FX / insert-FX engine
 * arrays) are not here, because a registration would do nothing for them.
 *
 * This lives beside `planToCommands` on purpose: the tap half is the exact complement of
 * the `sendTapWritable` test that suppresses the write there, and the two were written as
 * separate walks over the same (channel, bus) pairs long enough to disagree about which
 * sources count.
 *
 * `scope` is applied with the same `sceneExternal` predicate `planToCommands` uses, for a
 * reason stronger than symmetry: under "scene" a whole-device read RESTORES the plan's
 * scene-external values afterwards (`main.ts` applyDeviceStateScoped → scene-scope.ts), so
 * a follow that pulled one in would be the one path in the app where *Scene only* does not
 * hold — the notify-driven read and the full read would disagree about the same value
 * under the same preference. Track Count is `sceneExternal`; the send taps are not.
 */
export function planToFollowOnlyAddrs(model: DeviceModel, scope: WriteScope = "all"): FollowOnlyAddr[] {
  const out: FollowOnlyAddr[] = [];
  // CH → FX send taps: the broker publishes max_value 0 on 193/197/320/324, so PRE is
  // unwritable and the emit loop above skips SEND_TAP for them. Same source filter as
  // that loop — an FX-channel source cannot reach an unwritable tap today (its sends go
  // to MIX, whose taps are writable), and stating that through `sendTapWritable` rather
  // than by narrowing the walk is what keeps this correct if that ever changes.
  for (const node of model.nodes) {
    if (node.kind !== "channel" && fxChannelIndex(node.id) === null) continue;
    for (const bus of model.nodes) {
      if (bus.kind !== "bus") continue;
      const sc = sendControl(model, node.id, bus.id);
      if (!sc || sendTapWritable(model, ref(node.id, "out"), ref(bus.id, "in"))) continue;
      out.push({ param: sc.tap, x: 0, y: sc.y, name: "SEND_TAP", node: node.id });
    }
  }
  // microSD Rec Track Count: the broker caps it at 1, so the only values software can
  // reach are "two tracks" and one the unit has no meaning for. Read onto out.sdrec's
  // node params, which is the node whose scoped read repairs it.
  if (model.nodes.some((n) => n.id === "out.sdrec")) {
    out.push({ param: PARAMS.SD_REC_TRACK_COUNT.id, x: 0, y: 0, name: "SD_REC_TRACK_COUNT", node: "out.sdrec" });
  }
  if (scope === "all") return out;
  return out.filter((f) => (PARAMS[f.name] as ParamSpec).sceneExternal !== true);
}

/** One string write: the CH SETTING name for a node, on a single instance. */
export interface NameWrite {
  param: number;
  y: number;
  value: string;
}

/**
 * The CH SETTING name writes a plan implies. Names are strings (outside the
 * numeric VdCommand path), sent via the string IPC. Emitted only for nodes the
 * plan gives an explicit name; an unnamed node is left as the device has it
 * (mirrors how an uncolored node is not written). Each linked instance is set.
 *
 * Normalized here, which is where `boundRaw` sits for the numeric leaves — the load
 * funnel and the rename bound their own inputs, but a name also reaches the plan from
 * a device read and from the unit's own rename, and this is the one place all of them
 * pass through on the way to the wire. It is what `diffNames` compares the device's
 * value against, so a value that is not normalized here can never match one.
 */
export function planToNameWrites(model: DeviceModel, plan: Plan): NameWrite[] {
  const out: NameWrite[] = [];
  for (const node of model.nodes) {
    const name = plan.nodeNames[node.id];
    if (!name) continue;
    const nc = nameControl(model, node.id);
    if (!nc) continue;
    for (const y of nc.instances) out.push({ param: nc.param, y, value: normalizeNodeName(name) });
  }
  // SSMCS Sweet Spot Data preset (param 91): a 4-digit zero-padded string, so it
  // rides this string-write path. MONO IN channels in SSMCS mode that carry an
  // explicit preset index only; the device drives the rest of the strip from it.
  for (const node of model.nodes) {
    const np = plan.nodeParams[node.id];
    const idx = np?.ssmcs?.sweetSpotData;
    if (idx === undefined) continue;
    if ((np?.compEqType ?? COMP_EQ_COMP_FIRST) !== COMP_EQ_SSMCS) continue;
    const cc = channelControl(model, node.id);
    if (!cc?.hasMicStrip) continue;
    out.push({ param: PARAMS.SWEET_SPOT_DATA.id, y: cc.y, value: sweetSpotDataToStr(idx) });
  }
  return out;
}

// --- Unverified-mapping registry -------------------------------------------
// Device mappings confirmed only on URX44V (the captured unit) that remain
// educated guesses on the other models, pending confirmation by an owner via the
// device self-test. Each entry is self-contained: it resolves the device
// addresses it writes on a model (so the self-test can tag a finding with the
// guess it confirms or refutes), names the param ids it invents (so the static
// collision audit can vet them), and — when it invents a colliding id — knows how
// to drop its own plan field. Adding a guess is one entry here, no switch to keep
// in sync. Lives in translate.ts because address resolution needs the model
// helpers below (channelControl / stereoIndexMap / channelInputSlots).

/** One device address a guess writes: [paramId, y] (the address x field is 0). */
export type GuessAddress = [paramId: number, y: number];

export interface UnverifiedMapping {
  /** Stable key, also used to tag self-test findings. */
  key: string;
  /** Human-readable description for the self-test report. */
  label: string;
  /** Models on which it is still a guess (confirmed models omitted). */
  models: ModelId[];
  /** Device addresses this guess writes on the model (empty if absent on it). */
  addresses(model: DeviceModel): GuessAddress[];
  /** Param ids this guess INVENTS — subject to the collision audit. A guess that
   *  only reuses a confirmed param's id (value/instance guess) leaves this empty. */
  guessedIds: number[];
  /** Strip the plan field a colliding guess would misaddress (omitted = nothing). */
  suppress?(plan: Plan): void;
}

export const UNVERIFIED_MAPPINGS: UnverifiedMapping[] = [
  {
    // URX22 D.Gain channel→id map is the positional hypothesis (CH3/4, CH5/6,
    // CH7/8, CH9/10 = ids 9, 13, 14, 15 by stereo-pair position — see D_GAIN maps
    // in params.ts). It reuses URX44V-confirmed ids, so it invents none (empty
    // guessedIds); what is unverified is the assignment on a real URX22. The
    // self-test writes each channel's sentinel and reads it back to settle it.
    key: "dgain-urx22",
    label: "URX22 D.Gain channel→id map (positional: CH3/4,5/6,7/8,9/10 = 9,13,14,15)",
    models: ["URX22"],
    guessedIds: [],
    addresses: (model) =>
      [...stereoIndexMap(model).keys()].flatMap((nodeId) => {
        const id = dGainParam(model.id, nodeId);
        return id === undefined ? [] : [[id, 0] as GuessAddress, [id, 1] as GuessAddress];
      }),
    suppress: (plan) => {
      for (const nodeId of ["ch_3_4", "ch_5_6", "ch_7_8", "ch_9_10"]) {
        if (plan.nodeParams[nodeId]) delete plan.nodeParams[nodeId].gain;
      }
    },
  },
  {
    key: "hiz-channel",
    label: "URX22 Hi-Z (instrument) input channel",
    models: ["URX22"],
    guessedIds: [],
    addresses: (model) =>
      model.nodes.flatMap((node) => {
        const cc = channelControl(model, node.id);
        return cc?.hasHiZ ? [[PARAMS.HI_Z.id, cc.y] as GuessAddress] : [];
      }),
  },
  {
    // Two guesses in one, and the round trip only settles the first: whether the
    // invented ids take values at all, and WHICH stereo pair a `y` reaches. The y here
    // is stereoIndexMap's, the same map the ducker block rode, so a faithful device
    // answers CONFIRMED by writing y and reading y back whichever pair y points at.
    // Pair 0 is `ch_5_6` on a URX44/URX44V and `ch_3_4` on a URX22, and only the
    // URX44V has been read; the private ledger's D-1 carries the sentinel-write and
    // LCD-read procedure that settles the other half, for both this and the ducker
    // block it was written for.
    key: "stereo-block",
    label: "Stereo channel fader/on/pan block (266/267/268)",
    models: ["URX22", "URX44"],
    guessedIds: [STEREO_FADER, STEREO_ON, STEREO_PAN],
    addresses: (model) => {
      const ys = [...stereoIndexMap(model).values()];
      return [STEREO_FADER, STEREO_ON, STEREO_PAN].flatMap((id) => ys.map((y) => [id, y] as GuessAddress));
    },
  },
  {
    key: "input-ports",
    label: "Physical input source port map (param 22 values)",
    models: ["URX22", "URX44"],
    guessedIds: [],
    addresses: (model) =>
      model.nodes.flatMap((node) =>
        (channelInputSlots(model, node.id) ?? []).map((s) => [PARAMS.INPUT_SOURCE.id, s] as GuessAddress),
      ),
  },
];

/** A guessed param id that a confirmed catalog param already owns. */
export interface UnverifiedCollision {
  key: string;
  label: string;
  paramId: number;
  /** The confirmed param the guessed id would actually address. */
  confirmed: ParamName;
}

/**
 * Audit a model's unverified guesses statically (no device needed): a guessed id
 * that a confirmed catalog param already owns is almost certainly wrong — a write
 * meant for the guess would land on that confirmed param instead — so the
 * self-test must not exercise it. Returns one collision per offending id.
 */
export function auditUnverified(model: ModelId): UnverifiedCollision[] {
  const out: UnverifiedCollision[] = [];
  for (const mapping of UNVERIFIED_MAPPINGS) {
    if (!mapping.models.includes(model)) continue;
    for (const id of mapping.guessedIds) {
      const confirmed = paramNameForId(id);
      if (confirmed) out.push({ key: mapping.key, label: mapping.label, paramId: id, confirmed });
    }
  }
  return out;
}

/**
 * Device addresses each still-unverified mapping writes on a model, as
 * "paramId:y" → mapping key (x is always 0 for these). The self-test uses it to
 * tag a residual finding with the guess it confirms or refutes.
 */
export function unverifiedAddresses(model: DeviceModel): Map<string, string> {
  const out = new Map<string, string>();
  for (const mapping of UNVERIFIED_MAPPINGS) {
    if (!mapping.models.includes(model.id)) continue;
    for (const [paramId, y] of mapping.addresses(model)) out.set(`${paramId}:${y}`, mapping.key);
  }
  return out;
}
