// Read the device's current settings back into the plan: the reverse of
// translate.ts. For each confirmed parameter we can both read and show in the
// UI, fetch the live value, decode it to plan units, and write it onto the plan.
// Today that is each channel's main fader / pan (CH_FADER / CH_PAN), reflected
// onto its fixed STEREO send so the inspector shows the on-device level and pan.

import type { DeviceModel } from "../../models/types";
import { ref } from "../../models/types";
import type { NodeParams, Plan } from "../plan";
import { ensureFixedConnections } from "../plan";
import { vdGet } from "../platform";
import { PARAMS } from "./params";
import { busFader, channelControl } from "./translate";
import { vdToBool, vdToFreq, vdToGain, vdToLevel, vdToMonitorLevel, vdToPan } from "./vd";

export interface ReadbackResult {
  /** Channels whose level/pan were updated from the device. */
  applied: number;
  /** Per-channel read failures (e.g. timeout), if any. */
  errors: string[];
}

/**
 * Pull the connected device's channel levels and pans into the plan, mutating it
 * in place. The caller must have connected first (platform.vdConnect) and should
 * re-render afterwards. Read failures are collected, not thrown, so one bad
 * channel does not abort the rest.
 */
export async function applyDeviceState(model: DeviceModel, plan: Plan): Promise<ReadbackResult> {
  ensureFixedConnections(model, plan);
  const errors: string[] = [];
  let applied = 0;

  for (const node of model.nodes) {
    if (node.kind !== "channel") continue;
    // Mono → 139/140/141 at input index; stereo → 266/267/268 at stereo index.
    const cc = channelControl(model, node.id);
    if (!cc) continue;
    const conn = plan.connections.find(
      (c) => c.from === ref(node.id, "out") && c.to === ref("bus.stereo", "in"),
    );
    if (!conn) continue;
    try {
      const level = vdToLevel(await vdGet(cc.fader, 0, cc.y));
      const pan = vdToPan(await vdGet(cc.pan, 0, cc.y));
      const on = vdToBool(await vdGet(cc.on, 0, cc.y));
      const update: NodeParams = { on };
      // Gain: A.Gain (mono) / D.Gain (stereo, linked L/R — read the first instance).
      if (cc.gain) update.gain = vdToGain(await vdGet(cc.gain.param, 0, cc.gain.instances[0]));
      if (cc.hasHpf) {
        update.hpf = vdToBool(await vdGet(PARAMS.HPF_ON.id, 0, cc.y));
        update.hpfFreq = vdToFreq(await vdGet(PARAMS.HPF_FREQ.id, 0, cc.y));
      }
      if (cc.hasPhantom) update.phantom = vdToBool(await vdGet(PARAMS.PHANTOM.id, 0, cc.y));
      conn.params = { ...conn.params, level, pan };
      plan.nodeParams[node.id] = { ...plan.nodeParams[node.id], ...update };
      applied++;
    } catch (e) {
      errors.push(`${node.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Bus output faders: STEREO master (581) and MIX (674); read the first instance.
  for (const node of model.nodes) {
    if (node.kind !== "bus") continue;
    const bf = busFader(node.id);
    if (!bf) continue;
    try {
      const level = vdToLevel(await vdGet(bf.param, 0, bf.instances[0]));
      plan.nodeParams[node.id] = { ...plan.nodeParams[node.id], level };
    } catch (e) {
      errors.push(`${node.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // STEREO bus master ON/OFF — a single global parameter, read once.
  try {
    const masterOn = vdToBool(await vdGet(PARAMS.STEREO_MASTER_ON.id, 0, 0));
    plan.nodeParams["bus.stereo"] = { ...plan.nodeParams["bus.stereo"], on: masterOn };
  } catch (e) {
    errors.push(`STEREO: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Monitor bus levels: bus.mon1 → y0, bus.mon2 → y1.
  for (const [id, y] of [["bus.mon1", 0], ["bus.mon2", 1]] as const) {
    try {
      const level = vdToMonitorLevel(await vdGet(PARAMS.MONITOR_LEVEL.id, 0, y));
      plan.nodeParams[id] = { ...plan.nodeParams[id], level };
    } catch (e) {
      errors.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { applied, errors };
}
