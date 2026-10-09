// A document that named nothing, completed the way the loader completes one — the fixture the
// provenance suites share.
//
// It answers with a plan whose every value is the model's factory value AND whose every leaf
// — a wire's params and the node colours included — is recorded as `default`, which is the state both `unauthoredWriteNodes` and
// `markPlanFromDevice` are about. Built by emptying `defaultPlan`'s node params and running
// the real fill rather than by hand: a fixture that wrote the values itself would agree with
// the factory data however far the two had drifted, and the whole subject is what the fill
// supplies for a document that supplied nothing.

import type { ModelId } from "../models/types";
import { defaultPlan, fillFactoryParams } from "../models/initial-state";
import type { Plan } from "../core/plan";
import { connParamContestKey, nodeColorContestKey } from "../core/plan-history";

export function filledPlan(modelId: ModelId = "URX44V"): Plan {
  const plan = defaultPlan(modelId);
  plan.nodeParams = {};
  fillFactoryParams(modelId, plan);
  // The wires are the new plan's, and so are the params they carry and the node colours:
  // recorded as the fill's like every node leaf, so a case re-marking "every key" reaches the
  // sends and the colours as well.
  for (const c of plan.connections) {
    for (const key of Object.keys(c.params ?? {})) {
      plan.paramSource!.set(connParamContestKey(c.from, c.to, key), "default");
    }
  }
  for (const id of Object.keys(plan.nodeColors)) plan.paramSource!.set(nodeColorContestKey(id), "default");
  return plan;
}
