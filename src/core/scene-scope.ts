// The URX scene boundary, expressed on plan state. A device scene (SCENE > Store /
// Recall) stores the mixer state but leaves the device-wide settings alone: monitor
// / phones, the microSD record assigns and Track Count, the streaming delay's frame
// rate, the oscillator, and the sample rate. Since System firmware V1.5 a scene also
// keeps the Output Patch (the analog and USB outputs) and the STREAMING channel's
// source, delay switch and time, and colour; before it, those were device-wide too.
// This module names that boundary in plan terms so the scene-scoped features
// share one definition: scene-scoped plan save strips it, a scene-scoped load
// or device fetch keeps the current values (the recall semantic), and the
// write-side mirror is the `sceneExternal` flag in control/params.ts (the two
// representations are cross-checked by scene-scope.test.ts). Deliberately free
// of control-layer imports so the demo bundle can use the save/load half.

import type { DelayParams, NodeParams, Plan, PlanConnection } from "./plan";
import { nodeParamContestPath, walkParamLeaves } from "./plan-history";

// Nodes whose params are scene-external in full (monitor strips carry only
// monitor state, bus.osc only oscillator state).
const FULL_NODE_IDS = ["bus.mon1", "bus.mon2", "bus.osc"] as const;

// Nodes where only named fields are scene-external: the STREAMING delay's frame
// rate, and the microSD recorder's Track Count.
const STREAM_NODE = "bus.stream";
const SDREC_NODE = "out.sdrec";

/** Which boundary a scene-scoped value was cut along.
 *
 *  `2` is the unit's own since System firmware V1.5, and what every operation here
 *  uses. `1` is the boundary before it, where the output patches and the STREAMING
 *  channel's source, whole delay block and colour were outside the scene as well. It
 *  is kept for one reader: a scene-scoped plan document of version 5 or earlier was
 *  saved under it and carries none of those, so opening it under `2` would read their
 *  absence as "no output patch" and the next write would unpatch the unit. Read under
 *  `1`, the document keeps the current plan's values for them, as it did when it was
 *  saved. */
export type SceneBoundary = 1 | 2;
export const SCENE_BOUNDARY: SceneBoundary = 2;

/** True for a wire the device keeps outside scenes: the microSD record assigns, the
 *  monitor source selects, and the oscillator bus assigns — and, under boundary 1,
 *  every output patch (analog / USB) and the streaming source select. */
export function isSceneExternalConnection(conn: PlanConnection, boundary: SceneBoundary = SCENE_BOUNDARY): boolean {
  if (conn.kind === "record") return true;
  if (conn.kind === "patch") return boundary === 1;
  if (conn.kind === "source") {
    const to = conn.to.split(":")[0];
    return to === "bus.mon1" || to === "bus.mon2" || (boundary === 1 && to === STREAM_NODE);
  }
  if (conn.kind === "sendSwitch") return conn.from.split(":")[0] === "bus.osc";
  return false;
}

/** The node-parameter keys a scene-scoped operation leaves alone, named the way the differ
 *  names them.
 *
 *  Derived from the same three constants {@link captureSceneExternal} reads rather than listed
 *  again, so the two cannot answer differently. What it is FOR is a scene-scoped LOAD: the
 *  device-wide values are copied off the plan on screen rather than written by the incoming
 *  document, so their provenance is that plan's — read as the document's, they would be exempt
 *  from the write confirm's warning, and the monitor, phones and oscillator are what that
 *  exempts.
 */
export function sceneExternalParamNames(plan: Plan, boundary: SceneBoundary = SCENE_BOUNDARY): Set<string> {
  const names = new Set<string>();
  const add = (nodeId: string, value: unknown, prefix = ""): void =>
    walkParamLeaves(value, (path) => names.add(nodeParamContestPath(nodeId, prefix + path)));
  for (const id of FULL_NODE_IDS) add(id, plan.nodeParams[id]);
  const delay = plan.nodeParams[STREAM_NODE]?.delay;
  if (boundary === 1) add(STREAM_NODE, delay, "delay.");
  else if (delay?.frameRate !== undefined) names.add(nodeParamContestPath(STREAM_NODE, "delay.frameRate"));
  if (plan.nodeParams[SDREC_NODE]?.sdRecTrackCount !== undefined) {
    names.add(nodeParamContestPath(SDREC_NODE, "sdRecTrackCount"));
  }
  return names;
}

/** Snapshot of a plan's scene-external state, for keep-across-replace flows. It
 *  carries the boundary it was taken along, so the apply cuts along the same one. */
export interface SceneExternalState {
  boundary: SceneBoundary;
  sampleRate: number;
  fullNodes: Partial<Record<(typeof FULL_NODE_IDS)[number], NodeParams | undefined>>;
  /** Boundary 2: the STREAMING delay's frame rate, the one field of the block outside the scene. */
  streamFrameRate: number | undefined;
  /** Boundary 1 only: the whole STREAMING delay block, and the STREAMING colour. */
  streamDelay: DelayParams | undefined;
  streamColor: string | undefined;
  sdRecTrackCount: number | undefined;
  connections: PlanConnection[];
}

export function captureSceneExternal(plan: Plan, boundary: SceneBoundary = SCENE_BOUNDARY): SceneExternalState {
  const fullNodes: SceneExternalState["fullNodes"] = {};
  for (const id of FULL_NODE_IDS) fullNodes[id] = structuredClone(plan.nodeParams[id]);
  const delay = plan.nodeParams[STREAM_NODE]?.delay;
  return {
    boundary,
    sampleRate: plan.sampleRate,
    fullNodes,
    streamFrameRate: delay?.frameRate,
    streamDelay: boundary === 1 ? structuredClone(delay) : undefined,
    streamColor: boundary === 1 ? plan.nodeColors[STREAM_NODE] : undefined,
    sdRecTrackCount: plan.nodeParams[SDREC_NODE]?.sdRecTrackCount,
    connections: structuredClone(plan.connections.filter((c) => isSceneExternalConnection(c, boundary))),
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
  if (state.boundary === 1) {
    setNodeField(plan, STREAM_NODE, "delay", structuredClone(state.streamDelay));
    if (state.streamColor === undefined) delete plan.nodeColors[STREAM_NODE];
    else plan.nodeColors[STREAM_NODE] = state.streamColor;
  } else {
    setStreamFrameRate(plan, state.streamFrameRate);
  }
  setNodeField(plan, SDREC_NODE, "sdRecTrackCount", state.sdRecTrackCount);
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
    if (!isSceneExternalConnection(c, state.boundary)) {
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
      if (id === STREAM_NODE) {
        if (copy.delay) {
          const delay = { ...copy.delay };
          delete delay.frameRate;
          if (Object.keys(delay).length) copy.delay = delay;
          else delete copy.delay;
        }
      } else delete copy.sdRecTrackCount;
      if (Object.keys(copy).length) nodeParams[id] = copy;
      continue;
    }
    nodeParams[id] = np;
  }
  return {
    ...plan,
    nodeParams,
    connections: plan.connections.filter((c) => !isSceneExternalConnection(c)),
  };
}

// Assign or delete the STREAMING delay's frame rate, creating the delay block when the
// field arrives and dropping the block (and the node entry) when it empties.
function setStreamFrameRate(plan: Plan, frameRate: number | undefined): void {
  const np = plan.nodeParams[STREAM_NODE];
  const delay = { ...(np?.delay ?? {}) };
  if (frameRate === undefined) delete delay.frameRate;
  else delay.frameRate = frameRate;
  setNodeField(plan, STREAM_NODE, "delay", Object.keys(delay).length ? delay : undefined);
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
