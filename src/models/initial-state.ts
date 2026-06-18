// A new document starts from the device's factory initial state where one was
// captured. Today only URX44V has a capture (Standard mode); URX22 / URX44 start
// from an empty plan and fall back to the inspector's per-field defaults.

import { emptyPlan, type Plan } from "../core/plan";
import { URX44V_CONNECTIONS, URX44V_NODE_PARAMS } from "./initial-urx44v";
import type { ModelId } from "./types";

const INITIAL: Partial<Record<ModelId, Pick<Plan, "nodeParams" | "connections">>> = {
  URX44V: { nodeParams: URX44V_NODE_PARAMS, connections: URX44V_CONNECTIONS },
};

// Build the starting plan for a new document: an empty plan seeded with the
// model's captured initial node parameters and routing, deep-cloned so edits do
// not mutate the shared defaults. Models without a capture return as emptyPlan.
export function defaultPlan(modelId: ModelId): Plan {
  const plan = emptyPlan(modelId);
  const initial = INITIAL[modelId];
  if (initial) {
    plan.nodeParams = structuredClone(initial.nodeParams);
    plan.connections = structuredClone(initial.connections);
  }
  return plan;
}
