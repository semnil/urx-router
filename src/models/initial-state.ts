// A new document starts from the device's factory initial state. Only URX44V is
// captured from real hardware (Standard mode); URX44 reuses that capture verbatim
// (the two differ only by URX44V's HDMI input, which no default routes), and
// URX22 is an inferred remap of it (see initial-urx22.ts).

import { emptyPlan, type Plan } from "../core/plan";
import { URX22_CONNECTIONS, URX22_NODE_COLORS, URX22_NODE_PARAMS } from "./initial-urx22";
import { URX44V_CONNECTIONS, URX44V_NODE_COLORS, URX44V_NODE_PARAMS } from "./initial-urx44v";
import type { ModelId } from "./types";

const INITIAL: Partial<Record<ModelId, Pick<Plan, "nodeParams" | "connections" | "nodeColors">>> = {
  URX22: { nodeParams: URX22_NODE_PARAMS, connections: URX22_CONNECTIONS, nodeColors: URX22_NODE_COLORS },
  // URX44 has the same node set as URX44V minus the HDMI input source, which the
  // factory defaults never route, so its initial state is identical.
  URX44: { nodeParams: URX44V_NODE_PARAMS, connections: URX44V_CONNECTIONS, nodeColors: URX44V_NODE_COLORS },
  URX44V: { nodeParams: URX44V_NODE_PARAMS, connections: URX44V_CONNECTIONS, nodeColors: URX44V_NODE_COLORS },
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
    plan.nodeColors = structuredClone(initial.nodeColors);
  }
  return plan;
}
