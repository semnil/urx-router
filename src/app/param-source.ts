// Where each of a plan's parameter values came from, lifted out of the entry so it is
// drivable without booting the app.
//
// The plan is dense — the loader completes a document from the model's factory values — so
// "what the plan holds" no longer answers "what someone chose". This is the second half of
// that trade: the fill records `load` / `default` as it goes, an edit records `manual`, and
// the device paths record `device`. `app/unauthored-writes.ts` is what reads it.
//
// Transient, and never serialized (core/plan.ts, `paramSource`): the document holds state,
// not a record of how it was operated.

import { cmdAddr, planToCommands, type WriteScope } from "../core/control/translate";
import { nodeParamContestPath, walkParamLeaves } from "../core/plan-history";
import { isPlainRecord, type NodeParams, type ParamSource, type Plan } from "../core/plan";
import type { DeviceModel } from "../models/types";

/** Record where a set of parameter values came from. A key nobody has named keeps whatever
 *  the load put there, which for a completed document is "default". */
export function markParamSource(plan: Plan, names: Iterable<string>, source: ParamSource): void {
  const map = (plan.paramSource ??= new Map<string, ParamSource>());
  for (const name of names) map.set(name, source);
}

/** Record that the plan now holds the unit's values, skipping the keys `except` names.
 *
 *  The caller is a write that landed in full, and `except` is where the two did NOT meet —
 *  the keys that write never sent, which {@link sentParamNames} answers. Per KEY rather than
 *  per node, since one node can have both halves (a stream bus's delay block is outside a
 *  scene while the rest of the node is inside it). */
export function markPlanFromDevice(plan: Plan, except: (nodeId: string, name: string) => boolean): void {
  for (const [nodeId, params] of Object.entries(plan.nodeParams)) {
    walkParamLeaves(params, (path) => {
      const name = nodeParamContestPath(nodeId, path);
      if (!except(nodeId, name)) markParamSource(plan, [name], "device");
    });
  }
}

/** The node-parameter keys a write under `scope` actually puts on the wire.
 *
 *  Asked of the emit, one leaf at a time: a key is sent when blanking it costs the emit an
 *  address. Nothing else can answer it — `planToCommands` skips a leaf for reasons that have
 *  nothing to do with the scene boundary (the 4-band PEQ under EQ 1-knob, `ssmcs` outside the
 *  SSMCS comp/EQ order, the insert-FX block with no selector), and a key marked as the unit's
 *  on the strength of a write that never sent it makes the next warning name a value the
 *  operator set themselves.
 */
export function sentParamNames(model: DeviceModel, plan: Plan, scope: WriteScope): Set<string> {
  const blank = (value: unknown, target: string, path: string[] = []): unknown => {
    if (Array.isArray(value)) return value.map((v, i) => blank(v, target, [...path, String(i)]));
    if (isPlainRecord(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value)) out[key] = blank(v, target, [...path, key]);
      return out;
    }
    return path.join(".") === target ? undefined : value;
  };
  const full = planToCommands(model, plan, scope).map(cmdAddr).length;
  const sent = new Set<string>();
  for (const [nodeId, params] of Object.entries(plan.nodeParams)) {
    walkParamLeaves(params, (leaf) => {
      const cut = blank(params, leaf) as NodeParams;
      const after = planToCommands(model, { ...plan, nodeParams: { ...plan.nodeParams, [nodeId]: cut } }, scope).length;
      if (after < full) sent.add(nodeParamContestPath(nodeId, leaf));
    });
  }
  return sent;
}
