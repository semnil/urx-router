// +48V and HI-Z on one jack, and the A.Gain range HI-Z narrows. The input stage is kept per
// MIC/LINE jack on the input nodes (`phantomL` / `hiZR` …), so the rule is a jack's. The app
// never turns one of the two on while the other is on, and holds a jack's A.Gain to -8..+40 dB
// while its HI-Z is on; a device read that finds both on is taken as it is
// (docs/{en,ja}/known-issues.md). The Inspector, the CONSOLE, the MIDI controls and the
// device-read status note read the rule from here, and so do the two paths that reach the plan
// without being an edit at all: applying a history entry and writing the whole plan, which ask
// `phantomHiZNewlyBothOn` about the state they would create. A device read asks it where it
// lands (`readRefusedSwitches`, and in a live session `unsentRefusedSwitches`, applied by
// readback.ts `readIntoPlan`), and the live flush and every converge round ask it per command
// (`onExcludedBy` and `carrierOf`, live.ts and client.ts), since an ON taken while a read is in
// flight was taken from a plan that had not heard what the unit holds. Whether HI-Z applies to a
// jack is `hiZOn`: the +48V refusal, the A.Gain range, the both-on list and the load repair
// (`paramRangeProblems` in plan-validate.ts, which turns +48V off there and bounds the gain to
// `jackGainRange` through translate.ts `nodeLeafRules`) ask it.

import type { DeviceModel } from "../models/types";
import { jackKey } from "./plan";
import type { JackSide, NodeParams, Plan } from "./plan";
import { nodeParamContestKey } from "./plan-history";
import { addrKey, inputStageReaders } from "./control/translate";
import { sideLabel } from "../models";
import type { VdCommand } from "./control/translate";
import { HI_Z_JACKS, MIC_LINE_JACK_BASE, PARAMS } from "./control/params";
import type { ParamName } from "./control/params";
import { A_GAIN_MAX_DB, A_GAIN_MIN_DB, HI_Z_A_GAIN_MAX_DB, gainToVd } from "./control/vd";

export type InputSwitch = "phantom" | "hiZ";

/** One jack of a MIC/LINE input node: the node and which of its two jacks. */
export interface Jack {
  node: string;
  side: JackSide;
}

const SIDES: readonly JackSide[] = ["L", "R"];

/** The jack index (the y of the analog input-stage params) of a jack; null off a MIC/LINE node. */
export function jackIndex(jack: Jack): number | null {
  const base = MIC_LINE_JACK_BASE[jack.node];
  return base === undefined ? null : base + (jack.side === "R" ? 1 : 0);
}

/** Every jack the model carries, in model order. */
export function modelJacks(model: DeviceModel): Jack[] {
  return model.nodes
    .filter((n) => MIC_LINE_JACK_BASE[n.id] !== undefined)
    .flatMap((n) => SIDES.map((side) => ({ node: n.id, side })));
}

/** Whether a jack carries the HI-Z switch on this model. */
export function jackHasHiZ(modelId: string, jack: Jack): boolean {
  const j = jackIndex(jack);
  return j !== null && (HI_Z_JACKS[modelId] ?? []).includes(j);
}

/** Whether HI-Z is on for a jack: the jack carries the switch and its node holds it on. */
export function hiZOn(modelId: string, jack: Jack, np: NodeParams | undefined): boolean {
  return jackHasHiZ(modelId, jack) && Boolean(np?.[jackKey("hiZ", jack.side)]);
}

/** Whether turning `key` ON at a jack is refused: +48V while `hiZOn`, HI-Z on a jack that
 *  carries it while +48V is on — each only while it is off itself. Turning either one off is
 *  never refused. */
export function inputOnRefused(modelId: string, jack: Jack, np: NodeParams | undefined, key: InputSwitch): boolean {
  const phantom = Boolean(np?.[jackKey("phantom", jack.side)]);
  if (key === "phantom") return hiZOn(modelId, jack, np) && !phantom;
  return jackHasHiZ(modelId, jack) && phantom && !np?.[jackKey("hiZ", jack.side)];
}

/** A jack's A.Gain range: it stops at +40 dB while the jack's HI-Z is on. Null off a MIC/LINE
 *  node. */
export function jackGainRange(
  modelId: string,
  jack: Jack,
  np: NodeParams | undefined,
): { minDb: number; maxDb: number } | null {
  if (jackIndex(jack) === null) return null;
  return { minDb: A_GAIN_MIN_DB, maxDb: hiZOn(modelId, jack, np) ? HI_Z_A_GAIN_MAX_DB : A_GAIN_MAX_DB };
}

/** The patch that sets a jack's HI-Z. Turning it on with A.Gain above +40 dB lowers the gain
 *  to +40 in the same patch, so one edit (and one undo entry) carries both. */
export function hiZPatch(np: NodeParams | undefined, side: JackSide, on: boolean): NodeParams {
  const gainKey = jackKey("gain", side);
  const gain = np?.[gainKey];
  return on && typeof gain === "number" && gain > HI_Z_A_GAIN_MAX_DB
    ? { [jackKey("hiZ", side)]: true, [gainKey]: HI_Z_A_GAIN_MAX_DB }
    : { [jackKey("hiZ", side)]: on };
}

// What an edit turning a switch on writes besides the switch, on the same jack — HI-Z's lowers
// A.Gain to +40 dB (`hiZPatch`) — named once for both vocabularies: the node param a read
// takes back with a refused ON (`carriedByOn`), and the command and encoded value a live flush
// holds with a held ON (`carrierOf`).
const CARRIED: ReadonlyArray<{
  on: InputSwitch;
  field: "gain";
  switchCommand: ParamName;
  command: ParamName;
  value: number;
}> = [{ on: "hiZ", field: "gain", switchCommand: "HI_Z", command: "HA_GAIN", value: gainToVd(HI_Z_A_GAIN_MAX_DB) }];

/** The switch and side a node-param key names (`phantomL` → phantom / L); null for any
 *  other key. */
export function switchOfKey(key: string): { on: InputSwitch; side: JackSide } | null {
  const m = /^(phantom|hiZ)([LR])$/.exec(key);
  return m ? { on: m[1] as InputSwitch, side: m[2] as JackSide } : null;
}

/** The node params an edit turning the switch `key` (`hiZL` …) on can write besides the
 *  switch, on the same jack: HI-Z's carries that jack's A.Gain when `hiZPatch` lowered it. A
 *  refused ON takes these back with it when the same edit wrote them. */
export function carriedByOn(key: string): readonly string[] {
  const sw = switchOfKey(key);
  if (!sw) return [];
  return CARRIED.filter((c) => c.on === sw.on).map((c) => jackKey(c.field, sw.side));
}

/**
 * For a command sending the value an edit turning a switch on carries with it, that switch's
 * command on the same jack; null for every other command and value. A.Gain at +40 dB is
 * HI-Z's: a live flush that holds a HI-Z ON (`onExcludedBy`) holds that A.Gain with it, so a
 * press the read then refuses has moved nothing on the unit, while an A.Gain the operator set
 * to any other value goes out. Matched on the param as well as the name, since a D.Gain goes
 * out under the same encoding at instance indexes a jack also uses.
 */
export function carrierOf(
  c: Pick<VdCommand, "name" | "paramId" | "x" | "y">,
  value: number,
): Pick<VdCommand, "name" | "paramId" | "x" | "y"> | null {
  const row = CARRIED.find((r) => r.command === c.name && PARAMS[r.command].id === c.paramId && r.value === value);
  return row ? { name: row.switchCommand, paramId: PARAMS[row.switchCommand].id, x: c.x, y: c.y } : null;
}

/** What a live session knows about a jack's +48V and HI-Z beyond what a device read finds.
 *  `key` is the switch's node-param key on the MIC/LINE node (`phantomL` …). */
export interface SwitchSession {
  /** The unit holds `key` on as far as the session knows: an ON its flush sent after a read
   *  had sampled the address is on the unit, whatever that read found. */
  holdsOn(nodeId: string, key: string): boolean;
  /** The session last left `key` on at the unit: it sent that ON, or a read found it there. An
   *  ON the plan holds that this does not name has not reached the unit. */
  sentOn(nodeId: string, key: string): boolean;
}

/** The address of a jack's +48V or HI-Z switch, named by its node-param key on the MIC/LINE
 *  node; null where the jack carries no such switch. */
export function switchAddr(
  model: DeviceModel,
  nodeId: string,
  key: string,
): Pick<VdCommand, "paramId" | "x" | "y"> | null {
  const sw = switchOfKey(key);
  if (!sw) return null;
  const jack = { node: nodeId, side: sw.side };
  const y = jackIndex(jack);
  if (y === null || !model.nodes.some((n) => n.id === nodeId)) return null;
  if (sw.on === "hiZ" && !jackHasHiZ(model.id, jack)) return null;
  return { paramId: PARAMS[sw.on === "hiZ" ? "HI_Z" : "PHANTOM"].id, x: 0, y };
}

/**
 * The switches a device read takes back as it lands: on each jack where `plan` holds +48V and
 * HI-Z both on and `unit` — the values the read found on the unit — does not, every one of the
 * two the plan holds ON and the unit holds OFF, named by its node-param key.
 *
 * An ON like that reached the plan while the read was in flight, from a plan that had not
 * heard the other switch was on, and the merge leaves an edit made during a read standing.
 * It is refused as `inputOnRefused` refuses it on a plan that knows: the plan takes the
 * unit's OFF for it, and the unit's own switch stays as the read found it. A jack the unit
 * itself holds both on is not named — that state is taken as it is.
 *
 * `alsoOn` names the switches the caller knows the unit holds on beyond what the read found:
 * an ON a live flush sent after the read had sampled the address is on the unit, and a panel
 * that turned the other one on behind it leaves the unit holding both.
 */
export function readRefusedSwitches(
  unit: Plan,
  plan: Plan,
  alsoOn?: (nodeId: string, key: string) => boolean,
): Array<{ nodeId: string; key: string }> {
  const out: Array<{ nodeId: string; key: string }> = [];
  for (const [nodeId, np] of Object.entries(plan.nodeParams)) {
    if (MIC_LINE_JACK_BASE[nodeId] === undefined) continue;
    for (const side of SIDES) {
      const jack = { node: nodeId, side };
      if (!bothOn(plan.modelId, jack, np)) continue;
      const read = unit.nodeParams[nodeId];
      const keys = { phantom: jackKey("phantom", side), hiZ: jackKey("hiZ", side) };
      const held: NodeParams = {
        [keys.phantom]: Boolean(read?.[keys.phantom]) || Boolean(alsoOn?.(nodeId, keys.phantom)),
        [keys.hiZ]: Boolean(read?.[keys.hiZ]) || Boolean(alsoOn?.(nodeId, keys.hiZ)),
      };
      if (bothOn(unit.modelId, jack, held)) continue;
      for (const key of [keys.phantom, keys.hiZ]) if (np?.[key] && !held[key]) out.push({ nodeId, key });
    }
  }
  return out;
}

/**
 * The ONs a device read took back itself, which `readRefusedSwitches` cannot see: an ON the plan
 * held when the read was issued (`before`) and the session never put on the unit — the live
 * flush held it back, or had not run yet — on a jack where the unit holds the other switch on.
 * The merge wrote the unit's OFF over it (`plan` holds it off), as it writes a read's value
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
): Array<{ nodeId: string; key: string }> {
  const out: Array<{ nodeId: string; key: string }> = [];
  for (const [nodeId, was] of Object.entries(before.nodeParams)) {
    if (MIC_LINE_JACK_BASE[nodeId] === undefined) continue;
    const read = unit.nodeParams[nodeId];
    for (const side of SIDES) {
      if (!jackHasHiZ(before.modelId, { node: nodeId, side })) continue;
      for (const field of ["phantom", "hiZ"] as const) {
        const key = jackKey(field, side);
        const other = jackKey(field === "phantom" ? "hiZ" : "phantom", side);
        if (!was?.[key] || plan.nodeParams[nodeId]?.[key] || authored.has(nodeParamContestKey(nodeId, key))) continue;
        if (session.sentOn(nodeId, key) || session.holdsOn(nodeId, key)) continue;
        if (read?.[other] || session.holdsOn(nodeId, other)) out.push({ nodeId, key });
      }
    }
  }
  return out;
}

/**
 * For a command that sends +48V or HI-Z ON, the address (`addrKey`) of the other switch on
 * the same jack, which the unit must not be holding ON when the command goes out; null for
 * an OFF and for every other command. The live flush asks it per command against its own view
 * of the unit, because that view can move while an ON waits in the plan: the unit turns the
 * other switch on at its own panel, and says so, before a follow read has brought it into the
 * plan. A converge round asks it against what its own read found.
 */
export function onExcludedBy(c: Pick<VdCommand, "name" | "x" | "y">, value: number): number | null {
  if (!value) return null;
  const other = otherSwitchId(c);
  return other === null ? null : addrKey(other, c.x, c.y);
}

/** For a +48V or HI-Z command, the param id of the other switch, which sits at the same x / y;
 *  null for every other command. */
export function otherSwitchId(c: Pick<VdCommand, "name">): number | null {
  if (c.name === "PHANTOM") return PARAMS.HI_Z.id;
  if (c.name === "HI_Z") return PARAMS.PHANTOM.id;
  return null;
}

/**
 * The jacks a change would leave with +48V and HI-Z both on and that do not hold both on
 * already, in model order.
 *
 * What the app must never do is TURN one of the two on while the other is on, which is not
 * the same as the plan holding both: a device read that finds both on is taken as it is, and
 * the jacks it named stay as they are through every later change that leaves them alone.
 * So the question is asked of the two states rather than of the one being moved to — which
 * is what lets the paths that apply a whole plan (a history entry, a device write) ask it
 * without knowing which key an edit touched.
 */
export function phantomHiZNewlyBothOn(model: DeviceModel, before: Plan, after: Plan): Jack[] {
  const held = new Set(phantomHiZBothOn(model, before).map((j) => `${j.node}:${j.side}`));
  return phantomHiZBothOn(model, after).filter((j) => !held.has(`${j.node}:${j.side}`));
}

/** The jacks holding +48V and HI-Z both on, in model order. */
export function phantomHiZBothOn(model: DeviceModel, plan: Plan): Jack[] {
  return modelJacks(model).filter((j) => bothOn(model.id, j, plan.nodeParams[j.node]));
}

function bothOn(modelId: string, jack: Jack, np: NodeParams | undefined): boolean {
  return hiZOn(modelId, jack, np) && Boolean(np?.[jackKey("phantom", jack.side)]);
}

/** A jack named for a status line: the channels that read it (`labelOf` names a channel the
 *  way the board does; a stereo channel by the side it reads), or the jack's own name when no
 *  channel reads it. */
export function jackName(model: DeviceModel, plan: Plan, jack: Jack, labelOf: (id: string) => string): string {
  const readers = inputStageReaders(model, plan, jack.node, jack.side);
  if (!readers.length) return sideLabel(model, jack.node, jack.side);
  return readers.map((r) => (r.side ? sideLabel(model, r.channel, r.side) : labelOf(r.channel))).join(", ");
}
