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

/** A deep copy of `value` with every leaf `move` names shifted off its current value.
 *
 *  Shifted by ONE rather than blanked or set to something far away, and in both directions by
 *  the caller: a step lands inside the option list an enum is bounded to, where a distant value
 *  falls outside it and is replaced by that enum's own default — which for a leaf already at
 *  its default is no move at all. A leaf at one end of a range does not move in that direction
 *  and does in the other, which is why the caller asks twice. */
function shiftLeaves(
  value: unknown,
  move: (path: string) => boolean,
  by: number,
  flip: boolean,
  path: string[] = [],
): unknown {
  if (Array.isArray(value)) return value.map((v, i) => shiftLeaves(v, move, by, flip, [...path, String(i)]));
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key] = shiftLeaves(v, move, by, flip, [...path, key]);
    return out;
  }
  if (!path.length || !move(path.join("."))) return value;
  if (by === 0) return undefined;
  if (typeof value === "number") return value + by;
  if (typeof value === "boolean") return flip ? !value : value;
  if (typeof value === "string") return value + "x";
  return value;
}

/**
 * The owner nodes a write would change at addresses the operator never authored.
 *
 * `changing` is the addresses the diff says differ from the device — the write's own set, so
 * a factory-filled key the unit already agrees with says nothing.
 *
 * Which of those the operator did not choose is asked of the emit's VALUES rather than its
 * shape: the plan is re-emitted with every unauthored leaf moved off its value, and an address
 * whose command carries a different value — or stops being emitted at all — is one whose value
 * an unauthored leaf decides. Asking the shape instead (does blanking a leaf remove an address)
 * answers a different question in both directions: `insertFx` GATES its node's whole insert-FX
 * block, so removing it takes an authored engine parameter's address with it, while an
 * `fxEffect` slot is emitted with a fallback whether or not the plan carries it, so removing
 * one costs no address at all though the write sends its value.
 *
 * Two extra emits rather than one per leaf. The leaf count is the document's to choose — the
 * load-time sanitiser keeps an unknown key whose value is well formed — so a per-leaf walk is
 * a plan-sized amount of work in front of a modal.
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
  const unauthored = new Set<string>();
  for (const [nodeId, params] of Object.entries(plan.nodeParams)) {
    walkParamLeaves(params, (leaf) => {
      const name = nodeParamContestPath(nodeId, leaf);
      const from = source?.get(name);
      if (from !== "load" && from !== "manual") unauthored.add(name);
    });
  }
  if (!unauthored.size) return [];

  const base = planToCommands(model, plan, scope);
  const held = new Map(base.map((c) => [cmdAddr(c), c.vdValue]));
  const moved = new Set<number>();
  // Two passes. One steps each unauthored value and flips each unauthored switch, and reads
  // only a CHANGED value: an address the step makes disappear is one whose presence a switch
  // decides while its value is still the operator's — an EQ band under the 1-knob switch — and
  // what this feeds says the VALUE is not theirs.
  //
  // The other REMOVES them, because a step does not move every value. An enum is bounded to an
  // option list and a neighbouring integer is not on it: `insertFx` sits at -1 (No Effect), where
  // -2 and 0 both resolve back to -1, so a write that CLEARS the unit's insert effect moved
  // nothing a step could see. Without the value the emit either skips the address or falls back
  // to the descriptor's own default, and that pass reads both — a value the plan no longer
  // decides is one the plan was deciding.
  for (const [by, flip] of [
    [1, true],
    [0, true],
  ] as Array<[number, boolean]>) {
    const shifted: Record<string, NodeParams> = {};
    for (const [nodeId, params] of Object.entries(plan.nodeParams)) {
      shifted[nodeId] = shiftLeaves(
        params,
        (leaf) => unauthored.has(nodeParamContestPath(nodeId, leaf)),
        by,
        flip,
      ) as NodeParams;
    }
    const after = new Map(
      planToCommands(model, { ...plan, nodeParams: shifted }, scope).map((c) => [cmdAddr(c), c.vdValue]),
    );
    for (const [addr, value] of held) {
      // A CHANGED value in either pass, and under the removal an address that stops being
      // emitted at all — dropping the key is what takes the block away. A step that takes one
      // away is different: that is a flipped switch, and the value it removed is still the
      // operator's, while what this feeds says the VALUE is not theirs.
      if (after.has(addr) ? after.get(addr) !== value : by === 0) moved.add(addr);
    }
  }

  const named = new Set<string>();
  for (const c of base) {
    const addr = cmdAddr(c);
    if (c.node !== undefined && changing.has(addr) && moved.has(addr)) named.add(c.node);
  }
  return model.nodes.filter((n) => named.has(n.id)).map((n) => n.id);
}
