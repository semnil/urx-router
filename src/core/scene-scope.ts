// The URX scene boundary, expressed on plan state. A device scene (SETUP >
// SAVE/RECALL) stores the mixer state but leaves the device-wide settings alone:
// monitor / phones, output and USB / SD patches, streaming source + delay +
// color, the oscillator, and the sample rate (measured in Standard Mode; the UG
// notes Simple Mode saves the Output Patch and Monitor settings into scenes).
// This module names that boundary in plan terms so the scene-scoped features
// share one definition: scene-scoped plan save strips it, a scene-scoped load
// or device fetch keeps the current values (the recall semantic), and the
// write-side mirror is the `sceneExternal` flag in control/params.ts (the two
// representations are cross-checked by scene-scope.test.ts). Deliberately free
// of control-layer imports so the demo bundle can use the save/load half.

import type { DelayParams, NodeParams, Plan, PlanConnection } from "./plan";

// Nodes whose params are scene-external in full (monitor strips carry only
// monitor state, bus.osc only oscillator state).
const FULL_NODE_IDS = ["bus.mon1", "bus.mon2", "bus.osc"] as const;

// Nodes where only named fields are scene-external (bus.stream also carries
// scene-internal state such as its name; the delay block and the color are not
// stored in a scene).
const STREAM_NODE = "bus.stream";
const SDREC_NODE = "out.sdrec";

/** True for a wire the device keeps outside scenes: every output patch (analog /
 *  USB), the microSD record assigns, the monitor / streaming source selects, and
 *  the oscillator bus assigns. */
export function isSceneExternalConnection(conn: PlanConnection): boolean {
  if (conn.kind === "patch" || conn.kind === "record") return true;
  if (conn.kind === "source") {
    const to = conn.to.split(":")[0];
    return to === "bus.mon1" || to === "bus.mon2" || to === STREAM_NODE;
  }
  if (conn.kind === "sendSwitch") return conn.from.split(":")[0] === "bus.osc";
  return false;
}

/** Snapshot of a plan's scene-external state, for keep-across-replace flows. */
export interface SceneExternalState {
  sampleRate: number;
  fullNodes: Partial<Record<(typeof FULL_NODE_IDS)[number], NodeParams | undefined>>;
  streamDelay: DelayParams | undefined;
  sdRecTrackCount: number | undefined;
  streamColor: string | undefined;
  connections: PlanConnection[];
}

export function captureSceneExternal(plan: Plan): SceneExternalState {
  const fullNodes: SceneExternalState["fullNodes"] = {};
  for (const id of FULL_NODE_IDS) fullNodes[id] = structuredClone(plan.nodeParams[id]);
  return {
    sampleRate: plan.sampleRate,
    fullNodes,
    streamDelay: structuredClone(plan.nodeParams[STREAM_NODE]?.delay),
    sdRecTrackCount: plan.nodeParams[SDREC_NODE]?.sdRecTrackCount,
    streamColor: plan.nodeColors[STREAM_NODE],
    connections: structuredClone(plan.connections.filter(isSceneExternalConnection)),
  };
}

/** Write a captured scene-external state back onto `plan` (mutating it), so the
 *  rest of the plan can change hands — a scene-scoped file load, or a scene-scoped
 *  device fetch — while the device-wide settings keep their current values. */
export function applySceneExternal(plan: Plan, state: SceneExternalState): void {
  plan.sampleRate = state.sampleRate;
  for (const id of FULL_NODE_IDS) {
    const np = state.fullNodes[id];
    if (np === undefined) delete plan.nodeParams[id];
    else plan.nodeParams[id] = structuredClone(np);
  }
  setNodeField(plan, STREAM_NODE, "delay", structuredClone(state.streamDelay));
  setNodeField(plan, SDREC_NODE, "sdRecTrackCount", state.sdRecTrackCount);
  if (state.streamColor === undefined) delete plan.nodeColors[STREAM_NODE];
  else plan.nodeColors[STREAM_NODE] = state.streamColor;
  // Replaced where they sit, and only the genuinely new ones appended. Filter-then-
  // append moved every scene-external wire to the tail of the array — which is the
  // wires' SVG draw order and the order a save serializes in — on every fetch, live
  // start and full reconcile while the device scope is "scene". The keyed differ
  // ignores an index move by design, so nothing recorded it: no undo entry, no
  // witness, and the next save simply diffed against the previous file for an edit
  // the operator never made.
  const incoming = structuredClone(state.connections);
  const kept: PlanConnection[] = [];
  for (const c of plan.connections) {
    if (!isSceneExternalConnection(c)) {
      kept.push(c);
      continue;
    }
    const at = incoming.findIndex((n) => n.from === c.from && n.to === c.to);
    if (at >= 0) kept.push(incoming.splice(at, 1)[0]);
  }
  plan.connections = [...kept, ...incoming];
}

/** A copy of `plan` with every scene-external value removed — what a scene-scoped
 *  save serializes. The caller still owns dropping the top-level sampleRate. */
export function stripSceneExternal(plan: Plan): Plan {
  const nodeParams: Record<string, NodeParams> = {};
  for (const [id, np] of Object.entries(plan.nodeParams)) {
    if ((FULL_NODE_IDS as readonly string[]).includes(id)) continue;
    if (id === STREAM_NODE || id === SDREC_NODE) {
      const copy = { ...np };
      if (id === STREAM_NODE) delete copy.delay;
      else delete copy.sdRecTrackCount;
      if (Object.keys(copy).length) nodeParams[id] = copy;
      continue;
    }
    nodeParams[id] = np;
  }
  const nodeColors = { ...plan.nodeColors };
  delete nodeColors[STREAM_NODE];
  return {
    ...plan,
    nodeParams,
    nodeColors,
    connections: plan.connections.filter((c) => !isSceneExternalConnection(c)),
  };
}

// Assign or delete one scene-external field on a node's params, creating the
// node entry when the field arrives and dropping it when it empties.
function setNodeField<K extends "delay" | "sdRecTrackCount">(
  plan: Plan,
  nodeId: string,
  field: K,
  value: NodeParams[K],
): void {
  const np = plan.nodeParams[nodeId];
  if (value === undefined) {
    if (!np) return;
    delete np[field];
    if (!Object.keys(np).length) delete plan.nodeParams[nodeId];
    return;
  }
  plan.nodeParams[nodeId] = { ...(np ?? {}), [field]: value };
}
