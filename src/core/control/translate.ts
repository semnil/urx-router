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
import type { Plan } from "../plan";
import { isFixedConnection } from "../routing";
import type { ParamName, ParamSpec } from "./params";
import { D_GAIN_PARAM, PARAMS, STEREO_FADER, STEREO_ON, STEREO_PAN } from "./params";
import {
  A_GAIN_MIN_DB,
  A_GAIN_MAX_DB,
  boolToVd,
  D_GAIN_MIN_DB,
  D_GAIN_MAX_DB,
  freqToVd,
  gainToVd,
  levelToVd,
  monitorLevelToVd,
  panToVd,
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

/** A CH → MIX send: the params for its level/pan/on (L/R-linked) and PRE/POST tap. */
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

/** Send params for a CH → MIX-bus pair, or null if it is not such a send. */
export function sendControl(model: DeviceModel, channelId: string, busId: string): SendControl | null {
  const mixIndex = MIX_SEND_BUS_INDEX[busId];
  if (mixIndex === undefined) return null;
  const cc = channelControl(model, channelId);
  if (!cc) return null;
  const base = (isStereoChannel(channelId) ? MIX_SEND_BASE_STEREO : MIX_SEND_BASE_MONO) + MIX_SEND_STRIDE * mixIndex;
  return {
    y: cc.y,
    level: [base, base + 6],
    pan: [base + 1, base + 7],
    on: [base + 2, base + 8],
    tap: base + 5,
  };
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

  // CH → MIX bus sends. The wire's presence means the send is on; its params
  // carry level / pan / PRE-POST tap. Level/pan/on are written to both L/R
  // instances (the device keeps them linked); the tap is a single param.
  for (const conn of plan.connections) {
    const sc = sendControl(model, parseRef(conn.from).nodeId, parseRef(conn.to).nodeId);
    if (!sc) continue;
    for (const p of sc.level) out.push(rawCommand("MIX_SEND_LEVEL", p, "level", sc.y, conn.params?.level ?? 0));
    for (const p of sc.pan) out.push(rawCommand("MIX_SEND_PAN", p, "pan", sc.y, conn.params?.pan ?? 0));
    for (const p of sc.on) out.push(rawCommand("MIX_SEND_ON", p, "bool", sc.y, 1));
    out.push(rawCommand("MIX_SEND_TAP", sc.tap, "bool", sc.y, conn.params?.tap === "pre" ? 1 : 0));
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
