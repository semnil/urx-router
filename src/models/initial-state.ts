// A new document starts from the device's factory initial state. Only URX44V is
// captured from real hardware (Standard mode); URX44 reuses that capture verbatim
// (the two differ only by URX44V's HDMI input, which no default routes), and
// URX22 is an inferred remap of it (see initial-urx22.ts).

import { emptyPlan, isPlainRecord, type NodeParams, type ParamSource, type Plan } from "../core/plan";
import { nodeParamContestPath, walkParamLeaves } from "../core/plan-history";
import { URX22_CONNECTIONS, URX22_NODE_COLORS, URX22_NODE_NAMES, URX22_NODE_PARAMS } from "./initial-urx22";
import { URX44V_CONNECTIONS, URX44V_NODE_COLORS, URX44V_NODE_NAMES, URX44V_NODE_PARAMS } from "./initial-urx44v";
import type { ModelId } from "./types";

const INITIAL: Record<ModelId, Pick<Plan, "nodeParams" | "connections" | "nodeColors" | "nodeNames">> = {
  URX22: {
    nodeParams: URX22_NODE_PARAMS,
    connections: URX22_CONNECTIONS,
    nodeColors: URX22_NODE_COLORS,
    nodeNames: URX22_NODE_NAMES,
  },
  // URX44 has the same node set as URX44V minus the HDMI input source, which the
  // factory defaults never route, so its initial state is identical.
  URX44: {
    nodeParams: URX44V_NODE_PARAMS,
    connections: URX44V_CONNECTIONS,
    nodeColors: URX44V_NODE_COLORS,
    nodeNames: URX44V_NODE_NAMES,
  },
  URX44V: {
    nodeParams: URX44V_NODE_PARAMS,
    connections: URX44V_CONNECTIONS,
    nodeColors: URX44V_NODE_COLORS,
    nodeNames: URX44V_NODE_NAMES,
  },
};

// Build the starting plan for a new document: an empty plan seeded with the
// model's captured initial node parameters and routing, deep-cloned so edits do
// not mutate the shared defaults.
export function defaultPlan(modelId: ModelId): Plan {
  const plan = emptyPlan(modelId);
  const initial = INITIAL[modelId];
  plan.nodeParams = structuredClone(initial.nodeParams);
  plan.connections = structuredClone(initial.connections);
  plan.nodeColors = structuredClone(initial.nodeColors);
  plan.nodeNames = structuredClone(initial.nodeNames);
  return plan;
}

/**
 * Fill a loaded document's node parameters from the model's factory values.
 *
 * A document carries only what someone wrote in it. Every key it omits used to reach the
 * write path as `undefined`, where the emit skips it — while the Inspector drew a default
 * for the same key. The two read as the same channel and are not one: a plan carrying no
 * parameters at all shows a fully specified strip and writes a third of what that strip
 * says. Filling makes the plan hold what the panel shows and what a write would send.
 *
 * The document wins at every key; the factory supplies only what the document did not
 * write. Objects recurse and arrays merge by index, so a group written in part is
 * completed rather than replaced — a document naming one EQ band keeps the other three,
 * and keeps the rest of that band's own values. An entry beyond what the factory carries
 * is left alone rather than dropped: this fills, and removing is the load funnel's job.
 *
 * Not for a plan the DEVICE authored. A fetch starts from an empty plan and fills it from
 * the unit; a node the read could not reach stays absent and is flagged (`unreadNodes`),
 * and a factory value there would be written back to a unit nobody managed to read.
 */
export function fillFactoryParams(modelId: ModelId, plan: Plan): void {
  const source = (plan.paramSource ??= new Map<string, ParamSource>());
  // The document's own leaves first: everything already here was written by whoever wrote
  // the document. Done as its own walk rather than inside the merge, since a key the
  // factory does not carry is never visited by it.
  for (const [nodeId, carried] of Object.entries(plan.nodeParams)) {
    walkParamLeaves(carried, (path) => {
      // Only where nothing has recorded it. A second fill over the same plan would otherwise
      // read its own completions as the document's, and the write confirm — which asks
      // exactly this question — would fall silent about every one of them.
      const name = nodeParamContestPath(nodeId, path);
      if (!source.has(name)) source.set(name, "load");
    });
  }
  for (const [nodeId, factory] of Object.entries(INITIAL[modelId].nodeParams)) {
    plan.nodeParams[nodeId] = mergeUnder(plan.nodeParams[nodeId], factory, (path) =>
      source.set(nodeParamContestPath(nodeId, path), "default"),
    ) as NodeParams;
  }
}

function mergeUnder(carried: unknown, factory: unknown, filled: (path: string) => void, path: string[] = []): unknown {
  if (carried === undefined) {
    walkParamLeaves(factory, filled, path);
    return structuredClone(factory);
  }
  if (Array.isArray(factory) && Array.isArray(carried)) {
    const out = factory.map((v, i) => mergeUnder(carried[i], v, filled, [...path, String(i)]));
    return [...out, ...carried.slice(factory.length)];
  }
  if (isPlainRecord(factory) && isPlainRecord(carried)) {
    const out: Record<string, unknown> = { ...carried };
    for (const [key, value] of Object.entries(factory)) {
      out[key] = mergeUnder(carried[key], value, filled, [...path, key]);
    }
    return out;
  }
  // A scalar where the factory holds a group is not an occupied group: the load-time
  // sanitiser passes it (it drops a non-finite LEAF, not a leaf standing where a record
  // belongs), and leaving it there keeps the whole group absent from the emit — the panel
  // drawing defaults for a block the write does not send, which is what this fill removes.
  if (isPlainRecord(factory) || Array.isArray(factory)) {
    walkParamLeaves(factory, (leaf) => filled(path.length ? [...path, leaf].join(".") : leaf));
    return structuredClone(factory);
  }
  return carried;
}
