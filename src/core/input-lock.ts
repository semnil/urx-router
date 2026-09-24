// +48V and HI-Z on one channel, and the A.Gain range HI-Z narrows. The app never turns one of
// the two on while the other is on, and holds A.Gain to -8..+40 dB while HI-Z is on; a device
// read that finds both on is taken as it is (docs/{en,ja}/known-issues.md). The Inspector, the
// CONSOLE, the MIDI controls and the device-read status note read the rule from here, and so do
// the two paths that reach the plan without being an edit at all: applying a history entry and
// writing the whole plan, which ask `phantomHiZNewlyBothOn` about the state they would create.
// A device read asks it where it lands (`readRefusedSwitches`, and in a live session
// `unsentRefusedSwitches`, applied by readback.ts `readIntoPlan`), and the live flush asks it
// per command (`onExcludedBy` and `carrierOf`, live.ts), since
// an ON taken while a read is in flight was taken from a plan that had not heard what the unit
// holds. Whether HI-Z applies to a
// channel is `hiZOn`: the +48V refusal, the A.Gain range, the both-on list and the load repair
// (`paramRangeProblems` in plan-validate.ts, which applies the same two bounds on its own) ask it.

import type { DeviceModel } from "../models/types";
import type { NodeParams, Plan } from "./plan";
import { nodeParamContestKey } from "./plan-history";
import { addrKey, channelControl, hasHiZInput } from "./control/translate";
import type { VdCommand } from "./control/translate";
import { PARAMS } from "./control/params";
import type { ParamName } from "./control/params";
import { HI_Z_A_GAIN_MAX_DB, gainToVd } from "./control/vd";

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

// What an edit turning a switch on writes besides the switch, on the same channel — HI-Z's
// lowers A.Gain to +40 dB (`hiZPatch`) — named once for both vocabularies: the node param a read
// takes back with a refused ON (`carriedByOn`), and the command and encoded value a live flush
// holds with a held ON (`carrierOf`).
const CARRIED: ReadonlyArray<{
  on: InputSwitch;
  key: string;
  switchCommand: ParamName;
  command: ParamName;
  value: number;
}> = [{ on: "hiZ", key: "gain", switchCommand: "HI_Z", command: "HA_GAIN", value: gainToVd(HI_Z_A_GAIN_MAX_DB) }];

/** The node params an edit turning `key` on can write besides the switch, on the same node:
 *  HI-Z's carries A.Gain when `hiZPatch` lowered it. A refused ON takes these back with it
 *  when the same edit wrote them. */
export function carriedByOn(key: InputSwitch): readonly string[] {
  return CARRIED.filter((c) => c.on === key).map((c) => c.key);
}

/**
 * For a command sending the value an edit turning a switch on carries with it, that switch's
 * command on the same channel; null for every other command and value. A.Gain at +40 dB is
 * HI-Z's: a live flush that holds a HI-Z ON (`onExcludedBy`) holds that A.Gain with it, so a
 * press the read then refuses has moved nothing on the unit, while an A.Gain the operator set
 * to any other value goes out. Matched on the param as well as the name, since a stereo
 * channel's D.Gain goes out under the same name at instance indexes a mono channel also uses.
 */
export function carrierOf(
  c: Pick<VdCommand, "name" | "paramId" | "x" | "y">,
  value: number,
): Pick<VdCommand, "name" | "paramId" | "x" | "y"> | null {
  const row = CARRIED.find((r) => r.command === c.name && PARAMS[r.command].id === c.paramId && r.value === value);
  return row ? { name: row.switchCommand, paramId: PARAMS[row.switchCommand].id, x: c.x, y: c.y } : null;
}

/** What a live session knows about a channel's +48V and HI-Z beyond what a device read finds. */
export interface SwitchSession {
  /** The unit holds `key` on as far as the session knows: an ON its flush sent after a read
   *  had sampled the address is on the unit, whatever that read found. */
  holdsOn(nodeId: string, key: InputSwitch): boolean;
  /** The session last left `key` on at the unit: it sent that ON, or a read found it there. An
   *  ON the plan holds that this does not name has not reached the unit. */
  sentOn(nodeId: string, key: InputSwitch): boolean;
}

/** The address of a channel's +48V or HI-Z switch; null where the channel carries none. */
export function switchAddr(
  model: DeviceModel,
  nodeId: string,
  key: InputSwitch,
): Pick<VdCommand, "paramId" | "x" | "y"> | null {
  const cc = channelControl(model, nodeId);
  if (!cc || !(key === "hiZ" ? cc.hasHiZ : cc.hasMicStrip)) return null;
  return { paramId: PARAMS[key === "hiZ" ? "HI_Z" : "PHANTOM"].id, x: 0, y: cc.y };
}

/**
 * The switches a device read takes back as it lands: on each channel where `plan` holds +48V
 * and HI-Z both on and `unit` — the values the read found on the unit — does not, every one
 * of the two the plan holds ON and the unit holds OFF.
 *
 * An ON like that reached the plan while the read was in flight, from a plan that had not
 * heard the other switch was on, and the merge leaves an edit made during a read standing.
 * It is refused as `inputOnRefused` refuses it on a plan that knows: the plan takes the
 * unit's OFF for it, and the unit's own switch stays as the read found it. A channel the unit
 * itself holds both on is not named — that state is taken as it is.
 *
 * `alsoOn` names the switches the caller knows the unit holds on beyond what the read found:
 * an ON a live flush sent after the read had sampled the address is on the unit, and a panel
 * that turned the other one on behind it leaves the unit holding both.
 */
export function readRefusedSwitches(
  unit: Plan,
  plan: Plan,
  alsoOn?: (nodeId: string, key: InputSwitch) => boolean,
): Array<{ nodeId: string; key: InputSwitch }> {
  const out: Array<{ nodeId: string; key: InputSwitch }> = [];
  for (const [nodeId, np] of Object.entries(plan.nodeParams)) {
    if (!bothOn(plan.modelId, nodeId, np)) continue;
    const read = unit.nodeParams[nodeId];
    const held = {
      ...read,
      phantom: Boolean(read?.phantom) || Boolean(alsoOn?.(nodeId, "phantom")),
      hiZ: Boolean(read?.hiZ) || Boolean(alsoOn?.(nodeId, "hiZ")),
    };
    if (bothOn(unit.modelId, nodeId, held)) continue;
    for (const key of ["phantom", "hiZ"] as const) if (np?.[key] && !held[key]) out.push({ nodeId, key });
  }
  return out;
}

/**
 * The ONs a device read took back itself, which `readRefusedSwitches` cannot see: an ON the plan
 * held when the read was issued (`before`) and the session never put on the unit — the live
 * flush held it back, or had not run yet — on a channel where the unit holds the other switch
 * on. The merge wrote the unit's OFF over it (`plan` holds it off), as it writes a read's value
 * over any key nobody edited while the read ran, so the plan already holds what the unit holds;
 * these are reported as refused all the same, so the status line says why and the edit leaves
 * the undo stack. An OFF edited while the read ran (`authored`, contest spelling) is the
 * operator's own, and a switch the session did put on was turned off at the unit, so neither
 * is named.
 */
export function unsentRefusedSwitches(
  before: Plan,
  unit: Plan,
  plan: Plan,
  session: SwitchSession,
  authored: ReadonlySet<string>,
): Array<{ nodeId: string; key: InputSwitch }> {
  const out: Array<{ nodeId: string; key: InputSwitch }> = [];
  for (const [nodeId, was] of Object.entries(before.nodeParams)) {
    if (!hasHiZInput(before.modelId, nodeId)) continue;
    const read = unit.nodeParams[nodeId];
    for (const key of ["phantom", "hiZ"] as const) {
      const other = key === "phantom" ? "hiZ" : "phantom";
      if (!was?.[key] || plan.nodeParams[nodeId]?.[key] || authored.has(nodeParamContestKey(nodeId, key))) continue;
      if (session.sentOn(nodeId, key) || session.holdsOn(nodeId, key)) continue;
      if (read?.[other] || session.holdsOn(nodeId, other)) out.push({ nodeId, key });
    }
  }
  return out;
}

/**
 * For a command that sends +48V or HI-Z ON, the address (`addrKey`) of the other switch on
 * the same channel, which the unit must not be holding ON when the command goes out; null for
 * an OFF and for every other command. The live flush asks it per command against its own view
 * of the unit, because that view can move while an ON waits in the plan: the unit turns the
 * other switch on at its own panel, and says so, before a follow read has brought it into the
 * plan.
 */
export function onExcludedBy(c: Pick<VdCommand, "name" | "x" | "y">, value: number): number | null {
  if (!value) return null;
  if (c.name === "PHANTOM") return addrKey(PARAMS.HI_Z.id, c.x, c.y);
  if (c.name === "HI_Z") return addrKey(PARAMS.PHANTOM.id, c.x, c.y);
  return null;
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
  return model.nodes.filter((n) => bothOn(model.id, n.id, plan.nodeParams[n.id])).map((n) => n.id);
}

function bothOn(modelId: string, nodeId: string, np: NodeParams | undefined): boolean {
  return hiZOn(modelId, nodeId, np) && Boolean(np?.phantom);
}
