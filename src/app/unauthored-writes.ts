// Which of a write's changes the operator never authored, lifted out of the entry so it is
// drivable without booting the app.
//
// The plan is dense: `fillFactoryParams` gives every key the unit has a value, so a document
// that named four of them still writes the whole model. That is what makes a write predictable
// — every key it sends is a key the operator can see in the Inspector — and it is also what
// puts values on the wire that nobody chose. `Plan.paramSource` records where each key came
// from, and this reports the ones that would MOVE the unit without the operator having asked.
//
// `load` counts as authored: the document named the value, so writing it is the plan being
// applied. `default` and `device` do not — the first is the factory fill and the second is a
// value read off the unit, which differing means the unit has since moved on its own.

import { cmdAddr, planToCommands, type WriteScope } from "../core/control/translate";
import { walkParamLeaves, nodeParamContestPath } from "../core/plan-history";
import { isPlainRecord, type NodeParams, type Plan } from "../core/plan";
import type { DeviceModel } from "../models/types";

/** A deep copy of `value` with every leaf `drop` names blanked to undefined.
 *
 *  Blanked rather than deleted: an array index is part of a key's identity (the second EQ
 *  band's gain), so removing an element renames every band after it. Every emit site guards
 *  on `!== undefined`, which is the same shape a sparse document arrives in. */
function blankLeaves(value: unknown, drop: (path: string) => boolean, path: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((v, i) => blankLeaves(v, drop, [...path, String(i)]));
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key] = blankLeaves(v, drop, [...path, key]);
    return out;
  }
  return path.length && drop(path.join(".")) ? undefined : value;
}

/**
 * The owner nodes a write would change at addresses the operator never authored.
 *
 * `changing` is the addresses the diff says differ from the device — the write's own set, so
 * a factory-filled key the unit already agrees with says nothing. What is subtracted from it
 * is the plan re-emitted with the unauthored keys blanked: an address that survives that emit
 * is one an authored key asks for, whoever else also asks for it.
 *
 * Returns node ids in the model's own order, so a caller naming strips lists them the way the
 * board does. Empty when the plan carries no provenance at all — a plan nobody has marked is
 * one this cannot answer for, and inventing a warning from that would flag every key.
 */
export function unauthoredWriteNodes(
  model: DeviceModel,
  plan: Plan,
  scope: WriteScope,
  changing: ReadonlySet<number>,
): string[] {
  const source = plan.paramSource;
  if (!source || !changing.size) return [];
  const unauthored = new Set<string>();
  for (const [nodeId, params] of Object.entries(plan.nodeParams)) {
    walkParamLeaves(params, (leaf) => {
      const name = nodeParamContestPath(nodeId, leaf);
      const from = source.get(name);
      if (from === "default" || from === "device") unauthored.add(name);
    });
  }
  if (!unauthored.size) return [];
  const authoredParams: Record<string, NodeParams> = {};
  for (const [nodeId, params] of Object.entries(plan.nodeParams)) {
    authoredParams[nodeId] = blankLeaves(params, (leaf) =>
      unauthored.has(nodeParamContestPath(nodeId, leaf)),
    ) as NodeParams;
  }
  const authoredAddrs = new Set(planToCommands(model, { ...plan, nodeParams: authoredParams }, scope).map(cmdAddr));
  const nodes = new Set<string>();
  for (const c of planToCommands(model, plan, scope)) {
    const addr = cmdAddr(c);
    if (c.node !== undefined && changing.has(addr) && !authoredAddrs.has(addr)) nodes.add(c.node);
  }
  return model.nodes.filter((n) => nodes.has(n.id)).map((n) => n.id);
}
