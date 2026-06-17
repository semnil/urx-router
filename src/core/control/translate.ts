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
import { PARAMS } from "./params";
import { boolToVd, gainToVd, levelToVd, panToVd, vdSet } from "./vd";
import type { VdSetRequest } from "./vd";

/**
 * Input-channel y index for a channel node, or null if it is not an input
 * channel. Mono channels "ch{n}" map to y = n-1; a stereo channel "ch_{a}_{b}"
 * maps to the L index of its pair (y = a-1). Matches the broker's input axis 0..11.
 */
export function channelInputIndex(nodeId: string): number | null {
  const mono = /^ch(\d+)$/.exec(nodeId);
  if (mono) return Number(mono[1]) - 1;
  const stereo = /^ch_(\d+)_\d+$/.exec(nodeId);
  if (stereo) return Number(stereo[1]) - 1;
  return null;
}

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

function encode(spec: ParamSpec, planValue: number): number {
  switch (spec.encoding) {
    case "level":
      return levelToVd(planValue);
    case "gain":
      return gainToVd(planValue);
    case "pan":
      return panToVd(planValue);
    case "bool":
      return boolToVd(planValue !== 0);
  }
}

function command(name: ParamName, y: number, planValue: number): VdCommand {
  const spec = PARAMS[name];
  const vdValue = encode(spec, planValue);
  const x = 0;
  return { name, paramId: spec.id, x, y, planValue, vdValue, request: vdSet(spec.id, y, vdValue, x) };
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
      const y = channelInputIndex(parseRef(conn.from).nodeId);
      if (y === null) continue;
      out.push(command("CH_FADER", y, conn.params?.level ?? 0));
      out.push(command("CH_PAN", y, conn.params?.pan ?? 0));
    }
  }

  // Channel node parameters: CH_ON / HPF_ON, set per input channel when present.
  for (const node of model.nodes) {
    if (node.kind !== "channel") continue;
    const np = plan.nodeParams[node.id];
    if (!np) continue;
    const y = channelInputIndex(node.id);
    if (y === null) continue;
    if (np.on !== undefined) out.push(command("CH_ON", y, np.on ? 1 : 0));
    if (np.hpf !== undefined) out.push(command("HPF_ON", y, np.hpf ? 1 : 0));
    if (np.gain !== undefined) out.push(command("HA_GAIN", y, np.gain));
  }

  // STEREO bus master ON/OFF (global, y = 0).
  const stereo = plan.nodeParams["bus.stereo"];
  if (stereo?.on !== undefined) out.push(command("STEREO_MASTER_ON", 0, stereo.on ? 1 : 0));
  return out;
}
