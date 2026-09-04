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

import { nodeParamContestPath, walkParamLeaves } from "../core/plan-history";
import type { ParamSource, Plan } from "../core/plan";

/** Record where a set of parameter values came from. A key nobody has named keeps whatever
 *  the load put there, which for a completed document is "default". */
export function markParamSource(plan: Plan, names: Iterable<string>, source: ParamSource): void {
  const map = (plan.paramSource ??= new Map<string, ParamSource>());
  for (const name of names) map.set(name, source);
}

/** Record that the whole plan now holds the unit's values, skipping the keys `except` names.
 *
 *  Both callers reach a state where the two agree everywhere they met: a read that answered,
 *  and a write that landed in full. What `except` carries is where they did NOT meet — the
 *  nodes a read could not answer for, and the keys a scene-scoped write never sent. */
export function markPlanFromDevice(plan: Plan, except: (nodeId: string, name: string) => boolean): void {
  for (const [nodeId, params] of Object.entries(plan.nodeParams)) {
    walkParamLeaves(params, (path) => {
      const name = nodeParamContestPath(nodeId, path);
      if (!except(nodeId, name)) markParamSource(plan, [name], "device");
    });
  }
}
