// Plan → live-control command translation. Turns the editable parameters a plan
// already holds into concrete vd value-set requests, so the result doubles as a
// dry-run preview (what would be written to hardware) and the payload list for
// the eventual transport. Pure and language-agnostic.
//
// Scope: only mappings whose param_id is confirmed against the broker dump are
// emitted, so a dry-run never proposes a guessed hardware write. Today that is
// each channel's main fader / pan (its fixed send into STEREO → CH_FADER / CH_PAN).
// Bus sends and channel-strip processing land here as their ids are confirmed.

import type { DeviceModel } from "../../models/types";
import { parseRef } from "../../models/types";
import type { CompParams, EqBand, GateParams, Plan } from "../plan";
import { isFixedConnection } from "../routing";
import type { InsertFxOption, ParamName, ParamSpec } from "./params";
import {
  COMP_EQ_COMP_FIRST,
  COMP_EQ_SSMCS,
  D_GAIN_PARAM,
  INSERT_FX_OPTIONS,
  OUTPUT_INSERT_FX_OPTIONS,
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
  centiDbToVd,
  D_GAIN_MIN_DB,
  D_GAIN_MAX_DB,
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
  monitorLevelToVd,
  panToVd,
  qToVd,
  ratioToVd,
  releaseToVd,
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
    case "monitor":
      return monitorLevelToVd(planValue);
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
    case "attackTime":
      return attackToVd(planValue);
    case "holdTime":
      return holdToVd(planValue);
    case "releaseTime":
      return releaseToVd(planValue);
    case "ratio":
      return ratioToVd(planValue);
    case "bool":
      return boolToVd(planValue !== 0);
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
function stereoIndexMap(model: DeviceModel): Map<string, number> {
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

/** Send params for a CH → MIX/FX-bus pair, or null if it is not such a send. */
export function sendControl(model: DeviceModel, channelId: string, busId: string): SendControl | null {
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
const MIX_FADER_INSTANCES: Record<string, number[]> = {
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

/** EQ-ON param/instances for an output bus: STEREO (498) or MIX (591, L/R-linked). */
export function busEqOn(nodeId: string): { name: ParamName; param: number; instances: number[] } | null {
  if (nodeId === "bus.stereo") {
    return { name: "STEREO_EQ_ON", param: PARAMS.STEREO_EQ_ON.id, instances: [0] };
  }
  const mix = MIX_FADER_INSTANCES[nodeId];
  return mix ? { name: "OUT_EQ_ON", param: PARAMS.OUT_EQ_ON.id, instances: mix } : null;
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
function pushDynCommands(out: VdCommand[], fields: DynField[], y: number, vals: Record<string, number | undefined>): void {
  for (const f of fields) {
    const v = vals[f.key];
    if (v !== undefined) out.push(command(f.name, y, v));
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
    // Channel main fader / pan: the fixed CH → STEREO send carries the channel's
    // level and pan, which are the CH_FADER / CH_PAN device parameters.
    if (parseRef(conn.to).nodeId === "bus.stereo" && isFixedConnection(model, conn.from, conn.to)) {
      const cc = channelControl(model, parseRef(conn.from).nodeId);
      if (!cc) continue;
      out.push(rawCommand("CH_FADER", cc.fader, "level", cc.y, conn.params?.level ?? 0));
      out.push(rawCommand("CH_PAN", cc.pan, "pan", cc.y, conn.params?.pan ?? 0));
    }
  }

  // CH → MIX/FX bus sends. The wire's presence means the send is on; its params
  // carry level / pan / PRE-POST tap. MIX writes both linked L/R instances; FX is
  // a single mono send with no pan.
  for (const conn of plan.connections) {
    const sc = sendControl(model, parseRef(conn.from).nodeId, parseRef(conn.to).nodeId);
    if (!sc) continue;
    for (const p of sc.level) out.push(rawCommand("SEND_LEVEL", p, "level", sc.y, conn.params?.level ?? 0));
    for (const p of sc.pan) out.push(rawCommand("SEND_PAN", p, "pan", sc.y, conn.params?.pan ?? 0));
    for (const p of sc.on) out.push(rawCommand("SEND_ON", p, "bool", sc.y, 1));
    out.push(rawCommand("SEND_TAP", sc.tap, "bool", sc.y, conn.params?.tap === "pre" ? 1 : 0));
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
    // Channel-strip section ON (GATE/COMP/EQ). The active COMP/EQ bank follows the
    // type; polarity per toggle. Stereo channels expose only EQ.
    for (const sec of channelSections(model, node.id, np.compEqType ?? COMP_EQ_COMP_FIRST)) {
      const v = np[sec.key];
      if (v !== undefined) out.push(rawCommand(sec.name, sec.param, "bool", sec.y, v ? sec.onValue : 1 - sec.onValue));
    }
    // Input 4-band PEQ band values (mono COMP->EQ mode / stereo channels).
    const ieq = inputEq(model, node.id, np.compEqType ?? COMP_EQ_COMP_FIRST);
    if (ieq && np.eqBands) pushEqBandCommands(out, ieq, np.eqBands);
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

  // Insert FX (enum): mono input channels (135) and output buses (578 / 671).
  for (const node of model.nodes) {
    const ifx = insertFxControl(model, node.id);
    const v = plan.nodeParams[node.id]?.insertFx;
    if (!ifx || v === undefined) continue;
    for (const inst of ifx.instances) out.push(rawCommand("INSERT_FX", ifx.param, "enum", inst, v));
  }

  // Output bus EQ ON: STEREO (498, single) and MIX (591, L/R-linked).
  for (const node of model.nodes) {
    if (node.kind !== "bus") continue;
    const eq = busEqOn(node.id);
    const np = plan.nodeParams[node.id];
    if (!eq || np?.eqOn === undefined) continue;
    for (const inst of eq.instances) out.push(rawCommand(eq.name, eq.param, "bool", inst, np.eqOn ? 1 : 0));
  }

  // Output bus 4-band PEQ band values: STEREO (single) and MIX (L/R-linked).
  for (const node of model.nodes) {
    if (node.kind !== "bus") continue;
    const oeq = outputEq(node.id);
    const bands = plan.nodeParams[node.id]?.eqBands;
    if (oeq && bands) pushEqBandCommands(out, oeq, bands);
  }

  // STEREO bus master ON/OFF (global, y = 0).
  const stereo = plan.nodeParams["bus.stereo"];
  if (stereo?.on !== undefined) out.push(command("STEREO_MASTER_ON", 0, stereo.on ? 1 : 0));

  // Monitor bus levels: bus.mon1 → y0, bus.mon2 → y1.
  for (const [id, y] of [["bus.mon1", 0], ["bus.mon2", 1]] as const) {
    const np = plan.nodeParams[id];
    if (np?.level !== undefined) out.push(command("MONITOR_LEVEL", y, np.level));
  }
  return out;
}
