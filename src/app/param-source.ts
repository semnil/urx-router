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
//
// There is deliberately no "the write landed, so the plan is the unit's now" pass. Under the
// reading `app/unauthored-writes.ts` applies — the operator chose a value when it is `load` or
// `manual`, and nothing else — relabelling a filled key as the unit's changes no answer, while
// relabelling one the DOCUMENT wrote makes the next confirm name a value they did write. What
// silences a landed value is the diff: it stops differing from the unit.

import type { ParamSource, Plan } from "../core/plan";

/** Record where a set of parameter values came from. A key nobody has named keeps whatever
 *  the load put there, which for a completed document is "default". */
export function markParamSource(plan: Plan, names: Iterable<string>, source: ParamSource): void {
  const map = (plan.paramSource ??= new Map<string, ParamSource>());
  for (const name of names) map.set(name, source);
}
