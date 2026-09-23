// +48V and HI-Z on one channel, and the A.Gain range HI-Z narrows. The app never turns one of
// the two on while the other is on, and holds A.Gain to -8..+40 dB while HI-Z is on; a device
// read that finds both on is taken as it is (docs/{en,ja}/known-issues.md). The Inspector, the
// CONSOLE, the MIDI controls and the device-read status note read the rule from here, and so do
// the two paths that reach the plan without being an edit at all: applying a history entry and
// writing the whole plan, which ask `phantomHiZNewlyBothOn` about the state they would create.
// Whether HI-Z applies to a channel is `hiZOn`: the +48V refusal, the A.Gain range, the both-on
// list and the load repair (`paramRangeProblems` in plan-validate.ts, which applies the same two
// bounds on its own) ask it.

import type { DeviceModel } from "../models/types";
import type { NodeParams, Plan } from "./plan";
import { channelControl, hasHiZInput } from "./control/translate";
import { HI_Z_A_GAIN_MAX_DB } from "./control/vd";

export type InputSwitch = "phantom" | "hiZ";

/** Whether HI-Z is on for a node: the node carries the switch on this model and its params
 *  hold it on. */
export function hiZOn(modelId: string, nodeId: string, np: NodeParams | undefined): boolean {
  return hasHiZInput(modelId, nodeId) && Boolean(np?.hiZ);
}

/** Whether turning `key` ON is refused: +48V while `hiZOn`, HI-Z on a channel that carries it
 *  while +48V is on — each only while it is off itself. Turning either one off is never
 *  refused. */
export function inputOnRefused(modelId: string, nodeId: string, np: NodeParams | undefined, key: InputSwitch): boolean {
  if (key === "phantom") return hiZOn(modelId, nodeId, np) && !np?.phantom;
  return hasHiZInput(modelId, nodeId) && Boolean(np?.phantom) && !np?.hiZ;
}

/** The channel's gain range: A.Gain stops at +40 dB while HI-Z is on, every other range is
 *  the channel's own. */
export function channelGainRange(
  model: DeviceModel,
  nodeId: string,
  np: NodeParams | undefined,
): { minDb: number; maxDb: number } | null {
  const cc = channelControl(model, nodeId);
  if (!cc?.gain) return null;
  const capped = cc.gain.analog && hiZOn(model.id, nodeId, np);
  return { minDb: cc.gain.minDb, maxDb: capped ? Math.min(cc.gain.maxDb, HI_Z_A_GAIN_MAX_DB) : cc.gain.maxDb };
}

/** The patch that sets HI-Z. Turning it on with A.Gain above +40 dB lowers the gain to +40 in
 *  the same patch, so one edit (and one undo entry) carries both. */
export function hiZPatch(np: NodeParams | undefined, on: boolean): NodeParams {
  const gain = np?.gain;
  return on && typeof gain === "number" && gain > HI_Z_A_GAIN_MAX_DB
    ? { hiZ: true, gain: HI_Z_A_GAIN_MAX_DB }
    : { hiZ: on };
}

/**
 * The channels a change would leave with +48V and HI-Z both on and that do not hold both
 * on already, in model order.
 *
 * What the app must never do is TURN one of the two on while the other is on, which is not
 * the same as the plan holding both: a device read that finds both on is taken as it is, and
 * the channels it named stay as they are through every later change that leaves them alone.
 * So the question is asked of the two states rather than of the one being moved to — which
 * is what lets the paths that apply a whole plan (a history entry, a device write) ask it
 * without knowing which key an edit touched.
 */
export function phantomHiZNewlyBothOn(model: DeviceModel, before: Plan, after: Plan): string[] {
  const held = new Set(phantomHiZBothOn(model, before));
  return phantomHiZBothOn(model, after).filter((id) => !held.has(id));
}

/** The channels holding +48V and HI-Z both on, in model order. */
export function phantomHiZBothOn(model: DeviceModel, plan: Plan): string[] {
  return model.nodes
    .filter((n) => {
      const np = plan.nodeParams[n.id];
      return hiZOn(model.id, n.id, np) && Boolean(np?.phantom);
    })
    .map((n) => n.id);
}
