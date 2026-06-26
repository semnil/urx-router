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
import type { CompParams, EqBand, EqOneKnobParams, FxEffectParams, GateParams, Plan, SsmcsBand, SsmcsParams } from "../plan";
import { incomingConnection } from "../plan";
import {
  FX_EFFECT_ARRAY_PARAM,
  FX_EFFECT_TYPE_DEFAULT,
  FX_EFFECT_TYPE_PARAM,
  FX_SLOT_LEVEL,
  FX_SLOT_ON,
  fxFamilyOf,
  fxParams,
} from "./fx-effect";
import { isFixedConnection, sendTapWritable } from "../routing";
import type { InsertFxOption, ParamName, ParamSpec } from "./params";
import {
  COMP_EQ_COMP_FIRST,
  COMP_EQ_SSMCS,
  D_GAIN_PARAM,
  denormalizeInsertFx,
  hexToColorIndex,
  INSERT_FX_OPTIONS,
  OUTPUT_INSERT_FX_OPTIONS,
  paramNameForId,
  PARAMS,
  STEREO_FADER,
  STEREO_ON,
  STEREO_PAN,
} from "./params";
import {
  A_GAIN_MIN_DB,
  A_GAIN_MAX_DB,
  attackToVd,
  boolToVd,
  burstWidthToVd,
  centiDbToVd,
  delayTimeToVd,
  phonesLevelToVd,
  D_GAIN_MIN_DB,
  D_GAIN_MAX_DB,
  DUCKER_DECAY_MAX_MS,
  DUCKER_DECAY_MIN_MS,
  DYN_ATTACK_MAX_MS,
  DYN_ATTACK_MIN_MS,
  DYN_HOLD_MAX_MS,
  DYN_HOLD_MIN_MS,
  DYN_RATIO_MIN,
  DYN_RELEASE_MAX_MS,
  DYN_RELEASE_MIN_MS,
  eqFreqToVd,
  eqGainToVd,
  freqToVd,
  gainToVd,
  holdToVd,
  levelToVd,
  panToVd,
  PORT_REF_NONE,
  qToVd,
  ratioToVd,
  releaseToVd,
  tagPortRef,
  vdSet,
} from "./vd";
import type { VdSetRequest } from "./vd";

export interface VdCommand {
  /** Catalog parameter this command sets. */
  name: ParamName;
  /** Broker param_id (address first field). */
  paramId: number;
  /** Address x field (0 outside EQ bands). */
  x: number;
  /** Instance index (the address y field). */
  y: number;
  /** Plan-domain value before encoding (dB, pan -100..100, or 0/1). */
  planValue: number;
  /** Encoded broker value. */
  vdValue: number;
  request: VdSetRequest;
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
  return { name, paramId, x: 0, y, planValue, vdValue, request: vdSet(paramId, y, vdValue) };
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
  pan: number;
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
    const dParam = D_GAIN_PARAM[nodeId];
    return {
      fader: STEREO_FADER,
      on: STEREO_ON,
      pan: STEREO_PAN,
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
    pan: PARAMS.CH_PAN.id,
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
const FX_SEND_BUS_INDEX: Record<string, number> = { "bus.fx1": 0, "bus.fx2": 1 };

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

const EQ_BAND_NAMES = ["low", "lowMid", "highMid", "high"] as const;
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
    const hasType = i === 0 || i === 3;
    return { index: i, name, on: b, type: hasType ? b + 1 : null, q: b + 2, freq: b + 3, gain: b + 4 };
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

/** One slider value of the GATE/COMP detail: its catalog name + plan-domain range. */
export interface DynField {
  /** The GateParams / CompParams sub-field this controls. */
  key: keyof GateParams | keyof CompParams;
  name: ParamName;
  min: number;
  max: number;
  step: number;
  /** Device default in plan units, shown before a fetch. */
  def: number;
  unit: "db" | "ms" | "ratio";
}

// GATE detail (29-33) and COMP detail (35-40, the COMP->EQ comp bank). Ranges and
// defaults in plan units (dB / ms / N:1); the broker bounds come from the encoders.
// The COMP knee (37) is a separate enum dropdown, not a slider, so it is not here.
const GATE_FIELDS: DynField[] = [
  { key: "threshold", name: "GATE_THRESHOLD", min: -72, max: 0, step: 1, def: -50, unit: "db" },
  { key: "range", name: "GATE_RANGE", min: -72, max: 0, step: 1, def: -56, unit: "db" },
  { key: "attack", name: "GATE_ATTACK", min: DYN_ATTACK_MIN_MS, max: DYN_ATTACK_MAX_MS, step: 0.1, def: 20.17, unit: "ms" },
  { key: "hold", name: "GATE_HOLD", min: DYN_HOLD_MIN_MS, max: DYN_HOLD_MAX_MS, step: 1, def: 15.3, unit: "ms" },
  { key: "decay", name: "GATE_DECAY", min: DYN_RELEASE_MIN_MS, max: DYN_RELEASE_MAX_MS, step: 1, def: 150.2, unit: "ms" },
];
const COMP_FIELDS: DynField[] = [
  { key: "threshold", name: "COMP_THRESHOLD", min: -54, max: 0, step: 1, def: -18, unit: "db" },
  { key: "ratio", name: "COMP_RATIO", min: DYN_RATIO_MIN, max: 20, step: 0.1, def: 3, unit: "ratio" },
  { key: "gain", name: "COMP_GAIN", min: 0, max: 18, step: 0.5, def: 2, unit: "db" },
  { key: "attack", name: "COMP_ATTACK", min: DYN_ATTACK_MIN_MS, max: DYN_ATTACK_MAX_MS, step: 0.1, def: 34.58, unit: "ms" },
  { key: "release", name: "COMP_RELEASE", min: DYN_RELEASE_MIN_MS, max: DYN_RELEASE_MAX_MS, step: 1, def: 218, unit: "ms" },
];
// Ducker detail (260-263, stereo channel sidechain). Same shapes as GATE but no
// hold; decay shares the ×10 release scale with a wider range. Ordered as the
// device DUCKER screen reads them (Range / Attack / Decay graph handles, then the
// Threshold box); each field carries its own param name, so order is display-only.
export const DUCKER_FIELDS: DynField[] = [
  { key: "range", name: "DUCKER_RANGE", min: -60, max: 0, step: 1, def: -56, unit: "db" },
  { key: "attack", name: "DUCKER_ATTACK", min: DYN_ATTACK_MIN_MS, max: DYN_ATTACK_MAX_MS, step: 0.1, def: 20.17, unit: "ms" },
  { key: "decay", name: "DUCKER_DECAY", min: DUCKER_DECAY_MIN_MS, max: DUCKER_DECAY_MAX_MS, step: 1, def: 1000, unit: "ms" },
  { key: "threshold", name: "DUCKER_THRESHOLD", min: -60, max: 0, step: 1, def: -40, unit: "db" },
];

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
function pushDynCommands(out: VdCommand[], fields: DynField[], y: number, vals: Record<string, number | undefined>): void {
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
): void {
  if (!b) return;
  if (b.on !== undefined) out.push(command(onName, y, b.on ? 1 : 0));
  if (qName && b.q !== undefined) out.push(command(qName, y, b.q));
  if (b.freq !== undefined) out.push(command(freqName, y, b.freq));
  if (b.gain !== undefined) out.push(command(gainName, y, b.gain));
}

// FX-channel effect: the EFFECT TYPE selector (679/683 at y0) plus the effect
// parameter array (681/685, addressed by slot). Emitted as absolute state for the
// effect's family; raw values pass straight through (the plan stores raw). The
// type is a sideEffect (writing it repopulates the array on the device), so live
// converges + re-reads. fxIndex = 0 (FX1) / 1 (FX2).
function pushFxEffectCommands(out: VdCommand[], fxIndex: number, fx: FxEffectParams): void {
  const typeId = FX_EFFECT_TYPE_PARAM[fxIndex];
  const arrId = FX_EFFECT_ARRAY_PARAM[fxIndex];
  const type = fx.type ?? FX_EFFECT_TYPE_DEFAULT[fxIndex];
  out.push(rawCommand("FX_EFFECT_TYPE", typeId, "enum", 0, type));
  out.push(rawCommand("FX_EFFECT_PARAM", arrId, "raw", FX_SLOT_ON, (fx.on ?? true) ? 1 : 0));
  out.push(rawCommand("FX_EFFECT_PARAM", arrId, "raw", FX_SLOT_LEVEL, fx.level ?? 100));
  for (const desc of fxParams(fxFamilyOf(type))) {
    out.push(rawCommand("FX_EFFECT_PARAM", arrId, "raw", desc.slot, fx.params?.[desc.key] ?? desc.def));
  }
}

function pushSsmcsCommands(out: VdCommand[], y: number, s: SsmcsParams | undefined): void {
  if (!s) return;
  if (s.on !== undefined) out.push(command("SSMCS_ON", y, s.on ? 1 : 0));
  if (s.compDrive !== undefined) out.push(command("SSMCS_COMP_DRIVE", y, s.compDrive));
  if (s.morphing !== undefined) out.push(command("SSMCS_MORPHING", y, s.morphing));
  if (s.outGain !== undefined) out.push(command("SSMCS_OUT_GAIN", y, s.outGain));
  const c = s.comp;
  if (c) {
    if (c.attack !== undefined) out.push(command("SSMCS_COMP_ATTACK", y, c.attack));
    if (c.release !== undefined) out.push(command("SSMCS_COMP_RELEASE", y, c.release));
    if (c.ratio !== undefined) out.push(command("SSMCS_COMP_RATIO", y, c.ratio));
    if (c.knee !== undefined) out.push(command("SSMCS_COMP_KNEE", y, c.knee));
    if (c.threshold !== undefined) out.push(command("SSMCS_COMP_THRESHOLD", y, c.threshold));
    if (c.makeup !== undefined) out.push(command("SSMCS_COMP_MAKEUP", y, c.makeup));
  }
  const sc = s.sc;
  if (sc) {
    if (sc.on !== undefined) out.push(command("SSMCS_SC_ON", y, sc.on ? 1 : 0));
    if (sc.q !== undefined) out.push(command("SSMCS_SC_Q", y, sc.q));
    if (sc.freq !== undefined) out.push(command("SSMCS_SC_FREQ", y, sc.freq));
    if (sc.gain !== undefined) out.push(command("SSMCS_SC_GAIN", y, sc.gain));
  }
  const eq = s.eq;
  if (eq) {
    pushSsmcsBand(out, y, eq.low, "SSMCS_EQ_LOW_ON", null, "SSMCS_EQ_LOW_FREQ", "SSMCS_EQ_LOW_GAIN");
    pushSsmcsBand(out, y, eq.mid, "SSMCS_EQ_MID_ON", "SSMCS_EQ_MID_Q", "SSMCS_EQ_MID_FREQ", "SSMCS_EQ_MID_GAIN");
    pushSsmcsBand(out, y, eq.high, "SSMCS_EQ_HIGH_ON", null, "SSMCS_EQ_HIGH_FREQ", "SSMCS_EQ_HIGH_GAIN");
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
      if (v.type !== undefined && band.type !== null)
        out.push(rawCommand("EQ_BAND_TYPE", band.type, "enum", inst, v.type));
      if (v.q !== undefined) out.push(rawCommand("EQ_BAND_Q", band.q, "q", inst, v.q));
      if (v.freq !== undefined) out.push(rawCommand("EQ_BAND_FREQ", band.freq, "eqFreq", inst, v.freq));
      if (v.gain !== undefined) out.push(rawCommand("EQ_BAND_GAIN", band.gain, "eqGain", inst, v.gain));
    }
  }
}

// Push the EQ 1-knob commands (ON / TYPE / LEVEL) for one node's EQ, on every
// linked instance. When 1-knob is on the device drives the 4-band PEQ, so the
// caller skips the band commands — the bands are device-driven, not authored.
function pushEqOneKnobCommands(out: VdCommand[], ctrl: EqOneKnobControl, ok: EqOneKnobParams): void {
  for (const inst of ctrl.instances) {
    if (ok.on !== undefined) out.push(rawCommand("EQ_ONE_KNOB_ON", ctrl.on, "bool", inst, ok.on ? 1 : 0));
    if (ok.type !== undefined) out.push(rawCommand("EQ_ONE_KNOB_TYPE", ctrl.type, "enum", inst, ok.type));
    if (ok.level !== undefined) out.push(rawCommand("EQ_ONE_KNOB_LEVEL", ctrl.level, "raw", inst, ok.level));
  }
}

/**
 * Resolve a ducker node's instance index (its parent stereo channel's stereo
 * position, via attachTo), or null if it is not a ducker. The ducker's enable
 * (258) and detail (260-263) all address this y. Confirmed on CH5/6 (research §12.27).
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
export function sourcePorts(model: DeviceModel, nodeId: string): { l: number; r: number } | null {
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
export function recordSourcePorts(model: DeviceModel, nodeId: string): { l: number; r: number } | null {
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
// to a bus/channel port: [destNode, kind, paramL, paramR (null = L only), yL, yR].
// `sourcePorts` maps the wire's source to its L/R port; the param's own encoding
// applies the tag (streaming) or not. Drives both emit and readback so the two
// directions cannot drift. (Input source and ducker key are bespoke — different
// namespace / per-instance shape — and stay separate below.)
export const ROUTING_SELECTORS: [string, ConnectionKind, ParamName, ParamName | null, number, number][] = [
  ["bus.stream", "source", "STREAM_SRC_L", "STREAM_SRC_R", 0, 0],
  ["out.usbmain_a", "patch", "USB_OUT_SRC_A", null, 0, 0],
  ["out.usbmain_b", "patch", "USB_OUT_SRC_B", null, 0, 0],
  ["out.usbmain_c", "patch", "USB_OUT_SRC_C", null, 0, 0],
  ["out.usbsub", "patch", "USB_OUT_SRC_SUB", null, 0, 0],
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
    return { param: PARAMS.OUTPUT_INSERT_FX_STEREO.id, instances: [0], options: OUTPUT_INSERT_FX_OPTIONS };
  }
  const mix = MIX_INSERT_FX_INSTANCES[nodeId];
  if (mix) return { param: PARAMS.OUTPUT_INSERT_FX_MIX.id, instances: mix, options: OUTPUT_INSERT_FX_OPTIONS };
  const cc = channelControl(model, nodeId);
  if (cc && !isStereoChannel(nodeId)) {
    return { param: PARAMS.INSERT_FX.id, instances: [cc.y], options: INSERT_FX_OPTIONS };
  }
  return null;
}

/**
 * Translate a plan into the list of vd value-set commands it currently implies.
 * Deterministic and side-effect free; the same plan always yields the same list,
 * so callers can diff it for a confirm-before-send preview.
 */
export function planToCommands(model: DeviceModel, plan: Plan): VdCommand[] {
  const out: VdCommand[] = [];
  for (const conn of plan.connections) {
    // Fixed main path into STEREO: the channel's CH_FADER / CH_PAN, or the FX
    // channel's FX_CHANNEL_FADER / FX_CHANNEL_BAL — the source's main level / pan.
    if (parseRef(conn.to).nodeId !== "bus.stereo" || !isFixedConnection(model, conn.from, conn.to)) continue;
    const fromId = parseRef(conn.from).nodeId;
    const cc = channelControl(model, fromId);
    if (cc) {
      out.push(rawCommand("CH_FADER", cc.fader, "level", cc.y, conn.params?.level ?? 0));
      out.push(rawCommand("CH_PAN", cc.pan, "pan", cc.y, conn.params?.pan ?? 0));
      continue;
    }
    const fxY = fxChannelIndex(fromId);
    if (fxY !== null) {
      out.push(rawCommand("FX_CHANNEL_FADER", PARAMS.FX_CHANNEL_FADER.id, "level", fxY, conn.params?.level ?? 0));
      out.push(rawCommand("FX_CHANNEL_BAL", PARAMS.FX_CHANNEL_BAL.id, "pan", fxY, conn.params?.pan ?? 0));
    }
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
  }

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
    if (cc.hasMicStrip && np.compEqType !== undefined) out.push(command("COMP_EQ_TYPE", cc.y, np.compEqType));
    // Rec Point: per-channel record / direct-out tap (param 137 on the input slot
    // y). MONO IN only — stereo channels' Rec Point address is unconfirmed.
    if (cc.hasMicStrip && np.recPoint !== undefined) out.push(command("REC_POINT", cc.y, np.recPoint));
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
    if (ieq && np.eqBands && !np.eqOneKnob?.on) pushEqBandCommands(out, ieq, np.eqBands);
    // Input GATE / COMP detail values (MONO IN channels; COMP only in COMP->EQ).
    const dyn = channelDynamics(model, node.id, np.compEqType ?? COMP_EQ_COMP_FIRST);
    if (dyn) {
      if (np.gate) pushDynCommands(out, dyn.gate, dyn.y, np.gate as Record<string, number | undefined>);
      if (dyn.comp && np.comp) {
        pushDynCommands(out, dyn.comp, dyn.y, np.comp as Record<string, number | undefined>);
        if (np.comp.knee !== undefined) out.push(command("COMP_KNEE", dyn.y, np.comp.knee));
        if (np.comp.autoMakeup !== undefined) out.push(command("COMP_AUTO_MAKEUP", dyn.y, np.comp.autoMakeup ? 1 : 0));
        if (np.comp.oneKnob !== undefined) out.push(command("COMP_ONE_KNOB", dyn.y, np.comp.oneKnob ? 1 : 0));
        if (np.comp.oneKnobLevel !== undefined) out.push(command("COMP_ONE_KNOB_LEVEL", dyn.y, np.comp.oneKnobLevel));
      }
      // SSMCS detail (MONO IN, SSMCS mode). Comp/EQ section ON are emitted above
      // via channelSections (compOn/eqOn). Sweet Spot Data is plan/UI-only (string
      // param, outside the numeric catalog). All values raw.
      if (!dyn.comp && cc.hasMicStrip && (np.compEqType ?? COMP_EQ_COMP_FIRST) === COMP_EQ_SSMCS) {
        pushSsmcsCommands(out, dyn.y, np.ssmcs);
      }
    }
    if (cc.gain && np.gain !== undefined) {
      // A.Gain (mono) is one instance; D.Gain (stereo) writes both linked L/R.
      for (const yi of cc.gain.instances) out.push(rawCommand("HA_GAIN", cc.gain.param, "gain", yi, np.gain));
    }
  }

  // Bus output faders: STEREO master (581, single) and MIX (674, L/R-linked).
  for (const node of model.nodes) {
    if (node.kind !== "bus") continue;
    const bf = busFader(node.id);
    const np = plan.nodeParams[node.id];
    if (!bf || np?.level === undefined) continue;
    for (const yi of bf.instances) out.push(rawCommand(bf.name, bf.param, "level", yi, np.level));
  }

  // FX-channel effects: EFFECT TYPE + parameter array for each FX channel present
  // in the plan (emitted as absolute state once the plan carries an fxEffect).
  for (const node of model.nodes) {
    const fxY = fxChannelIndex(node.id);
    if (fxY === null) continue;
    const fx = plan.nodeParams[node.id]?.fxEffect;
    if (fx) pushFxEffectCommands(out, fxY, fx);
  }

  // Insert FX (enum): mono input channels (135) and output buses (578 / 671).
  for (const node of model.nodes) {
    const ifx = insertFxControl(model, node.id);
    const v = plan.nodeParams[node.id]?.insertFx;
    if (!ifx || v === undefined) continue;
    for (const inst of ifx.instances) out.push(rawCommand("INSERT_FX", ifx.param, "insertFx", inst, v));
  }

  // Output bus EQ ON: STEREO (498, single) and MIX (591, L/R-linked).
  for (const node of model.nodes) {
    if (node.kind !== "bus") continue;
    const eq = busEqOn(node.id);
    const np = plan.nodeParams[node.id];
    if (!eq || np?.eqOn === undefined) continue;
    for (const inst of eq.instances) out.push(rawCommand(eq.name, eq.param, "bool", inst, np.eqOn ? 1 : 0));
  }

  // Output bus EQ 1-knob (STEREO / MIX). When on, the device drives the bands.
  for (const node of model.nodes) {
    if (node.kind !== "bus") continue;
    const ok = plan.nodeParams[node.id]?.eqOneKnob;
    const ctrl = eqOneKnob(model, node.id, COMP_EQ_COMP_FIRST);
    if (ctrl && ok) pushEqOneKnobCommands(out, ctrl, ok);
  }

  // Output bus 4-band PEQ band values: STEREO (single) and MIX (L/R-linked).
  // Skipped when 1-knob is on (the device computes the bands).
  for (const node of model.nodes) {
    if (node.kind !== "bus") continue;
    const np = plan.nodeParams[node.id];
    const oeq = outputEq(node.id);
    if (oeq && np?.eqBands && !np.eqOneKnob?.on) pushEqBandCommands(out, oeq, np.eqBands);
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
    if (pr) out.push(command(pr, yr, p ? p.r : PORT_REF_NONE));
  }

  // microSD Rec per-track source assign (param 736) — absolute over every track-pair
  // slot. A record wire picks one source (channel pair / STEREO / MIX); its L/R port
  // refs go to the pair's two tracks. No wire writes the NONE sentinel to both,
  // matching readback (NONE = no record wire). Track Count (839) is read-only, never
  // emitted. Absent on models without a recorder (recordSlots is then empty).
  for (const slot of recordSlots(model)) {
    const conn = incomingConnection(plan, ref(slot.id, "in"), "record");
    const p = conn ? recordSourcePorts(model, parseRef(conn.from).nodeId) : null;
    // A wire to a source that does not resolve to a port is left untouched.
    if (conn && !p) continue;
    out.push(command("SD_REC_SOURCE", slot.trackL, p ? p.l : PORT_REF_NONE));
    out.push(command("SD_REC_SOURCE", slot.trackR, p ? p.r : PORT_REF_NONE));
  }

  // Bus master ON/OFF: STEREO master (582, y = 0), MIX buses (675, L/R-linked per
  // MIX) and the FX channels (338, one instance per FX).
  for (const node of model.nodes) {
    if (node.kind !== "bus") continue;
    const bm = busMasterOn(node.id);
    const np = plan.nodeParams[node.id];
    if (!bm || np?.on === undefined) continue;
    for (const inst of bm.instances) out.push(rawCommand(bm.name, bm.param, "bool", inst, np.on ? 1 : 0));
  }

  // BUS Type for MIX buses (587, L/R-linked): VARI / FIXED. A MIX-only attribute,
  // written to both out instances.
  for (const node of model.nodes) {
    if (node.kind !== "bus") continue;
    const mix = MIX_FADER_INSTANCES[node.id];
    const bt = plan.nodeParams[node.id]?.busType;
    if (!mix || bt === undefined) continue;
    for (const inst of mix) out.push(command("BUS_TYPE", inst, bt));
  }

  // Monitor bus ON / level / CUE interrupt / MONO: bus.mon1 → y0, bus.mon2 → y1.
  for (const [id, y] of [["bus.mon1", 0], ["bus.mon2", 1]] as const) {
    const np = plan.nodeParams[id];
    if (np?.on !== undefined) out.push(command("MONITOR_ON", y, np.on ? 1 : 0));
    if (np?.level !== undefined) out.push(command("MONITOR_LEVEL", y, np.level));
    if (np?.cueInterrupt !== undefined) out.push(command("MONITOR_CUE_INTERRUPT", y, np.cueInterrupt ? 1 : 0));
    if (np?.mono !== undefined) out.push(command("MONITOR_MONO", y, np.mono ? 1 : 0));
    // PHONES level shares the monitor's y axis (PHONES 1 ↔ mon1 = y0, PHONES 2 ↔ mon2 = y1).
    if (np?.phonesLevel !== undefined) out.push(command("PHONES_LEVEL", y, np.phonesLevel));
  }

  // Oscillator generator (bus.osc node): on / level / mode / frequency.
  const osc = plan.nodeParams["bus.osc"]?.osc;
  if (osc?.on !== undefined) out.push(command("OSC_ON", 0, osc.on ? 1 : 0));
  if (osc?.level !== undefined) out.push(command("OSC_LEVEL", 0, osc.level));
  if (osc?.mode !== undefined) out.push(command("OSC_MODE", 0, osc.mode));
  if (osc?.freq !== undefined) out.push(command("OSC_FREQ", 0, osc.freq));
  // Burst Noise width (seconds → ms ×1000) / interval (seconds, raw). Burst mode
  // only on the device, but emitted whenever present (like freq for Sine).
  if (osc?.width !== undefined) out.push(command("OSC_BURST_WIDTH", 0, osc.width));
  if (osc?.interval !== undefined) out.push(command("OSC_BURST_INTERVAL", 0, osc.interval));

  // STREAMING DELAY (bus.stream node, global y = 0): on / time / frame rate.
  // Emitted only when the plan carries delay settings, leaving the device's
  // delay untouched otherwise (like the oscillator generator above).
  const delay = plan.nodeParams["bus.stream"]?.delay;
  if (delay?.on !== undefined) out.push(command("STREAM_DELAY_ON", 0, delay.on ? 1 : 0));
  if (delay?.time !== undefined) out.push(command("STREAM_DELAY_TIME", 0, delay.time));
  if (delay?.frameRate !== undefined) out.push(command("STREAM_DELAY_FRAME_RATE", 0, delay.frameRate));

  // Sample rate (global y0, raw Hz). A top-level plan scalar (always set), so it
  // is emitted unconditionally as absolute state. Writing it re-clocks the
  // hardware; only 766 is sent (843 auto-follows). See params.ts SAMPLE_RATE.
  out.push(command("SAMPLE_RATE", 0, plan.sampleRate));

  // OSC → bus assign — absolute over every OSC-assignable bus. A wire turns the
  // destination's L/R channels on (oscL/oscR; absent = on); no wire turns both
  // off, matching readback (both off = no wire). FX buses are mono (R skipped).
  for (const busId of OSC_ASSIGN_BUSES) {
    const a = oscAssign(busId);
    if (!a) continue;
    const conn = plan.connections.find((c) => c.from === ref("bus.osc", "out") && c.to === ref(busId, "in"));
    out.push(command(a.name, a.l, conn && conn.params?.oscL !== false ? 1 : 0));
    if (a.r !== null) out.push(command(a.name, a.r, conn && conn.params?.oscR !== false ? 1 : 0));
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
  }
  return out;
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
 */
export function planToNameWrites(model: DeviceModel, plan: Plan): NameWrite[] {
  const out: NameWrite[] = [];
  for (const node of model.nodes) {
    const name = plan.nodeNames[node.id];
    if (!name) continue;
    const nc = nameControl(model, node.id);
    if (!nc) continue;
    for (const y of nc.instances) out.push({ param: nc.param, y, value: name });
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
    key: "dgain-ch_3_4",
    label: "URX22 ch_3_4 digital input gain (D.Gain) param id",
    models: ["URX22"],
    guessedIds: [D_GAIN_PARAM.ch_3_4],
    addresses: (model) =>
      stereoIndexMap(model).has("ch_3_4")
        ? [[D_GAIN_PARAM.ch_3_4, 0], [D_GAIN_PARAM.ch_3_4, 1]]
        : [],
    suppress: (plan) => {
      if (plan.nodeParams["ch_3_4"]) delete plan.nodeParams["ch_3_4"].gain;
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
      model.nodes.flatMap(
        (node) => (channelInputSlots(model, node.id) ?? []).map((s) => [PARAMS.INPUT_SOURCE.id, s] as GuessAddress),
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
