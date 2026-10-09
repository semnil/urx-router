// Where each of a plan's parameter values came from, lifted out of the entry so it is
// drivable without booting the app.
//
// The plan is dense — the loader completes a document from the model's factory values — so
// "what the plan holds" no longer answers "what someone chose". This is the second half of
// that trade: the fill records `load` / `default` as it goes, an edit records `manual` — except
// the engine slots an effect selection seeds with the type's defaults, which are `default` like
// the load's — and the device paths record `device`. `app/unauthored-writes.ts` is what reads it.
//
// Transient, and never serialized (core/plan.ts, `paramSource`): the document holds state,
// not a record of how it was operated.
//
// There is deliberately no "the write landed, so the plan is the unit's now" pass. Under the
// reading `app/unauthored-writes.ts` applies — the operator chose a value when it is `load` or
// `manual`, and nothing else — relabelling a filled key as the unit's changes no answer, while
// relabelling one the DOCUMENT wrote makes the next confirm name a value they did write. What
// silences a landed value is the diff: it stops differing from the unit.

import type { ParamSource, Plan } from "../core/plan";
import { nodeParamContestPath } from "../core/plan-history";

/** Record where a set of parameter values came from. A key nobody has named keeps whatever
 *  the load put there, which for a completed document is "default". */
export function markParamSource(plan: Plan, names: Iterable<string>, source: ParamSource): void {
  const map = (plan.paramSource ??= new Map<string, ParamSource>());
  for (const name of names) map.set(name, source);
}

/** A value an edit put in as a type's default rather than as anything the operator chose — an
 *  effect selection's seeded engine slot — and what it was put in at. */
export interface SeededDefault {
  nodeId: string;
  /** The dotted path inside the node's params. */
  path: string;
  value: unknown;
}

/** The value at a dotted path inside a node's params. */
function valueAt(params: unknown, path: string): unknown {
  let at = params;
  for (const key of path.split(".")) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

/** Hold each (node, path) an edit seeded with a default, under its contest name, at the value
 *  the plan now holds there. */
export function noteSeededDefaults(
  plan: Plan,
  seeded: Map<string, SeededDefault>,
  entries: Iterable<readonly [string, string]>,
): void {
  for (const [nodeId, path] of entries) {
    seeded.set(nodeParamContestPath(nodeId, path), { nodeId, path, value: valueAt(plan.nodeParams[nodeId], path) });
  }
}

/** Record the names an edit carried: as the fill's where `seeded` holds the name and the plan
 *  still holds the value it was seeded at, as the operator's otherwise — an edit that moved a
 *  seeded value before the entry closed chose it. Every seeded entry a name reaches is spent. */
export function markAuthored(plan: Plan, names: Iterable<string>, seeded: Map<string, SeededDefault>): void {
  const defaults: string[] = [];
  const manual: string[] = [];
  for (const name of names) {
    const seed = seeded.get(name);
    seeded.delete(name);
    const kept = seed !== undefined && valueAt(plan.nodeParams[seed.nodeId], seed.path) === seed.value;
    (kept ? defaults : manual).push(name);
  }
  markParamSource(plan, manual, "manual");
  markParamSource(plan, defaults, "default");
}
