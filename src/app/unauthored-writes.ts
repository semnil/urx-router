// Which of a write's changes the operator never chose, lifted out of the entry so it is
// drivable without booting the app.
//
// The plan is dense: `fillFactoryParams` gives every key the unit has a value, so a document
// that named four of them still writes the whole model. That is what makes a write predictable
// — every key it sends is a key the operator can see in the Inspector — and it is also what
// puts values on the wire that nobody chose. `Plan.paramSource` records where each key came
// from, and this reports the ones that would MOVE the unit without the operator having asked.
//
// `load` and `manual` are the two the operator chose: the document named the value, or an edit
// funnel wrote it. Everything else is not — `default` is the factory fill, `device` is a value
// read off the unit, and a key NOBODY recorded is one no funnel claims. The classification is
// total and falls toward warning, since a leaf that reached the plan unrecorded is exactly the
// kind this cannot vouch for.

import { cmdAddr, planToCommands, type WriteScope } from "../core/control/translate";
import { walkParamLeaves, nodeParamContestPath } from "../core/plan-history";
import { isPlainRecord, type NodeParams, type Plan } from "../core/plan";
import type { DeviceModel } from "../models/types";

/** A deep copy of `value` with every leaf `drop` names blanked to undefined.
 *
 *  Blanked rather than deleted: an array index is part of a key's identity (the second EQ
 *  band's gain), so removing an element renames every band after it. */
function blankLeaves(value: unknown, drop: (path: string) => boolean, path: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((v, i) => blankLeaves(v, drop, [...path, String(i)]));
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key] = blankLeaves(v, drop, [...path, key]);
    return out;
  }
  return path.length && drop(path.join(".")) ? undefined : value;
}

/** The addresses `plan` no longer produces once one node's single leaf is blanked.
 *
 *  Asked one leaf at a time rather than of the whole unauthored set at once, because blanking
 *  is not additive: `insertFx` GATES its node's whole insert-FX block (translate.ts skips the
 *  block outright when the selector is absent), so blanking it takes the engine array with it.
 *  Subtracting a set therefore attributes an authored parameter's address to the absent
 *  selector, and the strip is named for a value the operator set themselves. */
function addrsOfLeaf(model: DeviceModel, plan: Plan, scope: WriteScope, nodeId: string, leaf: string): Set<number> {
  const cut = blankLeaves(plan.nodeParams[nodeId], (path) => path === leaf) as NodeParams;
  const kept = new Set(
    planToCommands(model, { ...plan, nodeParams: { ...plan.nodeParams, [nodeId]: cut } }, scope).map(cmdAddr),
  );
  return kept;
}

/**
 * The owner nodes a write would change at addresses the operator never authored.
 *
 * `changing` is the addresses the diff says differ from the device — the write's own set, so
 * a factory-filled key the unit already agrees with says nothing. An address of that set is
 * reported when NO authored leaf asks for it: a key the operator set is a key they chose to
 * send, whoever else also names the same address.
 *
 * Returns node ids in the model's own order, so a caller naming strips lists them the way the
 * board does.
 */
export function unauthoredWriteNodes(
  model: DeviceModel,
  plan: Plan,
  scope: WriteScope,
  changing: ReadonlySet<number>,
): string[] {
  if (!changing.size) return [];
  const source = plan.paramSource;
  const authoredLeaf = (name: string): boolean => {
    const from = source?.get(name);
    return from === "load" || from === "manual";
  };

  // Split each node's leaves, and keep only the nodes that have something to answer for:
  // one the operator authored throughout has no unauthored address to report.
  const leaves = new Map<string, { authored: string[]; unauthored: number }>();
  for (const [nodeId, params] of Object.entries(plan.nodeParams)) {
    const authored: string[] = [];
    let unauthored = 0;
    walkParamLeaves(params, (leaf) => {
      if (authoredLeaf(nodeParamContestPath(nodeId, leaf))) authored.push(leaf);
      else unauthored++;
    });
    if (unauthored) leaves.set(nodeId, { authored, unauthored });
  }
  if (!leaves.size) return [];

  const full = planToCommands(model, plan, scope);
  const nodesOf = new Map<string, number[]>();
  for (const c of full) {
    const addr = cmdAddr(c);
    if (c.node !== undefined && changing.has(addr)) nodesOf.set(c.node, [...(nodesOf.get(c.node) ?? []), addr]);
  }

  // What the operator's own keys ask for. Taken only from the nodes that have a changing
  // address AND an unauthored leaf — a node with neither cannot produce a finding, and the
  // emit per authored leaf is what this costs.
  const authoredAddrs = new Set<number>();
  const fullAddrs = new Set(full.map(cmdAddr));
  for (const [nodeId, split] of leaves) {
    if (!nodesOf.has(nodeId)) continue;
    for (const leaf of split.authored) {
      const kept = addrsOfLeaf(model, plan, scope, nodeId, leaf);
      for (const addr of fullAddrs) if (!kept.has(addr)) authoredAddrs.add(addr);
    }
  }

  const named = new Set<string>();
  for (const [nodeId, addrs] of nodesOf) {
    if (!leaves.has(nodeId)) continue;
    if (addrs.some((a) => !authoredAddrs.has(a))) named.add(nodeId);
  }
  return model.nodes.filter((n) => named.has(n.id)).map((n) => n.id);
}
