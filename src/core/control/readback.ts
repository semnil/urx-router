// Read the device's current settings back into the plan: the reverse of
// translate.ts. For each confirmed parameter we can both read and show in the
// UI, fetch the live value, decode it to plan units, and write it onto the plan.
// Today that is each channel's main fader / pan (CH_FADER / CH_PAN), reflected
// onto its fixed STEREO send so the inspector shows the on-device level and pan.

import type { DeviceModel } from "../../models/types";
import { ref } from "../../models/types";
import type { Plan } from "../plan";
import { ensureFixedConnections } from "../plan";
import { vdGet } from "../platform";
import { PARAMS } from "./params";
import { channelInputIndex } from "./translate";
import { vdToBool, vdToGain, vdToLevel, vdToPan } from "./vd";

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
    const y = channelInputIndex(node.id);
    if (y === null) continue;
    const conn = plan.connections.find(
      (c) => c.from === ref(node.id, "out") && c.to === ref("bus.stereo", "in"),
    );
    if (!conn) continue;
    try {
      const level = vdToLevel(await vdGet(PARAMS.CH_FADER.id, 0, y));
      const pan = vdToPan(await vdGet(PARAMS.CH_PAN.id, 0, y));
      const on = vdToBool(await vdGet(PARAMS.CH_ON.id, 0, y));
      const hpf = vdToBool(await vdGet(PARAMS.HPF_ON.id, 0, y));
      const gain = vdToGain(await vdGet(PARAMS.HA_GAIN.id, 0, y));
      conn.params = { ...conn.params, level, pan };
      plan.nodeParams[node.id] = { ...plan.nodeParams[node.id], on, hpf, gain };
      applied++;
    } catch (e) {
      errors.push(`${node.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { applied, errors };
}
