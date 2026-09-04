import { describe, it, expect } from "vitest";
import {
  applySceneExternal,
  captureSceneExternal,
  isSceneExternalConnection,
  sceneExternalParamNames,
  stripSceneExternal,
} from "./scene-scope";
import { deserializeDocument, serialize } from "./plan";
import type { NodeParams, Plan } from "./plan";
import { nodeParamContestPath } from "./plan-history";
import { defaultPlan } from "../models/initial-state";
import { getModel } from "../models";
import { PARAMS } from "./control/params";
import type { ParamSpec } from "./control/params";
import { cmdAddr, planToCommands } from "./control/translate";

// The scene boundary, in two groups so a reader can tell what is hardware-measured
// from what is asserted. Together they are the contract: params.ts flags (the
// write-side boundary) and scene-scope.ts (the plan-side boundary) must both track
// them, so the two cannot drift apart silently.
//
// Measured by the scene recall audit (31 catalog names, URX44V, Standard Mode) plus
// OSC_ON, which the .urxf format carries no descriptor for and which a one-item
// recall measurement confirmed scene-external (URX44V, 2026-07-24).
const AUDITED_SCENE_EXTERNAL = [
  "MONITOR_SRC_L",
  "MONITOR_SRC_R",
  "MONITOR_CUE_INTERRUPT",
  "MONITOR_MONO",
  "MONITOR_ON",
  "MONITOR_LEVEL",
  "PHONES_LEVEL",
  "OUT_PATCH_MAIN",
  "OUT_PATCH_LINE",
  "USB_OUT_SRC_A",
  "USB_OUT_SRC_B",
  "USB_OUT_SRC_C",
  "USB_OUT_SRC_SUB",
  "SD_REC_SOURCE",
  "SD_REC_TRACK_COUNT",
  "STREAM_COLOR",
  "STREAM_SRC_L",
  "STREAM_SRC_R",
  "STREAM_DELAY_ON",
  "STREAM_DELAY_TIME",
  "STREAM_DELAY_FRAME_RATE",
  "OSC_ON",
  "OSC_LEVEL",
  "OSC_MODE",
  "OSC_FREQ",
  "OSC_BURST_WIDTH",
  "OSC_BURST_INTERVAL",
  "OSC_ASSIGN_STEREO",
  "OSC_ASSIGN_MIX",
  "OSC_ASSIGN_FX",
  "SAMPLE_RATE",
  "FOLLOW_USB",
].sort();

// SETUP > GENERAL, grounded on the user guide's screen-category exclusion ("Settings
// for the SETUP screen … are not saved" to a scene) rather than on the recall audit,
// and never emitted by planToCommands either — see the planExternal flag, whose own
// contract is pinned in control/device-setup.test.ts.
const SETUP_SCENE_EXTERNAL = [
  "BRIGHTNESS",
  "AUTO_POWER_OFF",
  "AUTO_POWER_OFF_TIME",
  "HDMI_HDCP",
  "HDMI_INPUT_CHANNELS",
  "UDK_FUNCTION",
  "UDK_PARAM1",
  "UDK_PARAM2",
  "DATE_FORMAT",
  "TIME_FORMAT",
  "TIME_ZONE",
  "DEVICE_LANGUAGE",
  "USB_SUPPRESSION",
].sort();

const SCENE_EXTERNAL_NAMES = [...AUDITED_SCENE_EXTERNAL, ...SETUP_SCENE_EXTERNAL].sort();

describe("scene boundary contract", () => {
  it("params.ts flags exactly the audited scene-external set", () => {
    const flagged = Object.entries(PARAMS as Record<string, ParamSpec>)
      .filter(([, spec]) => spec.sceneExternal === true)
      .map(([name]) => name)
      .sort();
    expect(flagged).toEqual(SCENE_EXTERNAL_NAMES);
  });

  it("the scene write scope drops exactly the flagged commands, keeping order", () => {
    const model = getModel("URX44V");
    const plan = defaultPlan("URX44V");
    const all = planToCommands(model, plan);
    const scene = planToCommands(model, plan, "scene");
    expect(all.some((c) => SCENE_EXTERNAL_NAMES.includes(c.name))).toBe(true);
    expect(scene.some((c) => SCENE_EXTERNAL_NAMES.includes(c.name))).toBe(false);
    expect(scene).toEqual(all.filter((c) => !SCENE_EXTERNAL_NAMES.includes(c.name)));
  });

  it("classifies the factory plan's wires: patches / records / monitor + stream sources / OSC assigns", () => {
    const plan = defaultPlan("URX44V");
    const external = plan.connections.filter(isSceneExternalConnection);
    expect(external.some((c) => c.kind === "patch")).toBe(true);
    expect(external.some((c) => c.kind === "record")).toBe(true);
    expect(external.some((c) => c.kind === "source" && c.to.startsWith("bus.mon1"))).toBe(true);
    expect(external.some((c) => c.kind === "sendSwitch" && c.from.startsWith("bus.osc"))).toBe(true);
    // A channel input-source wire and a plain bus send stay scene-internal.
    expect(external.some((c) => c.kind === "send")).toBe(false);
  });
});

describe("captureSceneExternal / applySceneExternal", () => {
  it("carries the device-wide settings across a plan replacement", () => {
    const current = defaultPlan("URX44V");
    current.sampleRate = 96000;
    current.nodeParams["bus.mon1"] = { level: -12, mono: true };
    current.nodeParams["bus.stream"] = { delay: { on: true, time: 250 } };
    current.nodeParams["out.sdrec"] = { sdRecTrackCount: 5 };
    current.nodeColors["bus.stream"] = "#123456";
    const keep = captureSceneExternal(current);

    const next = defaultPlan("URX44V");
    applySceneExternal(next, keep);
    expect(next.sampleRate).toBe(96000);
    expect(next.nodeParams["bus.mon1"]).toEqual({ level: -12, mono: true });
    expect(next.nodeParams["bus.stream"]?.delay).toEqual({ on: true, time: 250 });
    expect(next.nodeParams["out.sdrec"]?.sdRecTrackCount).toBe(5);
    expect(next.nodeColors["bus.stream"]).toBe("#123456");
    // The wire set matches the source plan's scene-external wires exactly.
    expect(next.connections.filter(isSceneExternalConnection)).toEqual(
      current.connections.filter(isSceneExternalConnection),
    );
  });

  it("clears fields the captured plan did not have (absence round-trips too)", () => {
    const bare = defaultPlan("URX44V");
    delete bare.nodeParams["bus.mon1"];
    delete bare.nodeColors["bus.stream"];
    const keep = captureSceneExternal(bare);

    const next = defaultPlan("URX44V");
    next.nodeParams["bus.mon1"] = { level: 5 };
    next.nodeColors["bus.stream"] = "#ff0000";
    applySceneExternal(next, keep);
    expect(next.nodeParams["bus.mon1"]).toBeUndefined();
    expect(next.nodeColors["bus.stream"]).toBeUndefined();
  });

  it("keeps scene-internal state of the receiving plan untouched", () => {
    const current = defaultPlan("URX44V");
    const next = defaultPlan("URX44V");
    next.nodeParams["ch1"] = { ...next.nodeParams["ch1"], on: false };
    next.notes["ch1"] = "keep me";
    applySceneExternal(next, captureSceneExternal(current));
    expect(next.nodeParams["ch1"]?.on).toBe(false);
    expect(next.notes["ch1"]).toBe("keep me");
  });

  // The wire array's order is the wires' SVG draw order and the order a saved document
  // serializes in. Filter-then-append moved every scene-external wire to the tail, on
  // every fetch, live start and full reconcile while the device scope is "scene" — and
  // the keyed differ ignores an index move by design, so nothing recorded it: no undo
  // entry, no witness, and the next save simply diffed against the previous file for an
  // edit the operator never made.
  it("leaves the wire order alone, and appends only genuinely new wires", () => {
    const current = defaultPlan("URX44V");
    const next = defaultPlan("URX44V");
    const before = next.connections.map((c) => `${c.from} ${c.to}`);
    expect(next.connections.some(isSceneExternalConnection)).toBe(true);

    applySceneExternal(next, captureSceneExternal(current));
    expect(next.connections.map((c) => `${c.from} ${c.to}`)).toEqual(before);

    // One the receiving plan does not have goes to the end, which is where a wire the
    // operator has never seen belongs.
    const captured = captureSceneExternal(current);
    const dropped = next.connections.findIndex(isSceneExternalConnection);
    const key = `${next.connections[dropped].from} ${next.connections[dropped].to}`;
    next.connections.splice(dropped, 1);
    applySceneExternal(next, captured);
    expect(next.connections.map((c) => `${c.from} ${c.to}`).at(-1)).toBe(key);
  });
});

describe("scene-scoped plan documents", () => {
  it("serialize(sceneOnly) strips the device-wide state and marks the document", () => {
    const plan = defaultPlan("URX44V");
    plan.notes["ch1"] = "note";
    const doc = JSON.parse(serialize(plan, { sceneOnly: true })) as Record<string, unknown>;
    expect(doc.scope).toBe("scene");
    expect("sampleRate" in doc).toBe(false);
    const conns = doc.connections as Array<{ kind: string }>;
    expect(conns.some((c) => c.kind === "patch" || c.kind === "record")).toBe(false);
    const nodeParams = doc.nodeParams as Record<string, unknown>;
    expect(nodeParams["bus.mon1"]).toBeUndefined();
    expect(nodeParams["bus.osc"]).toBeUndefined();
    // Editor state and scene-internal params stay in the file.
    expect((doc.notes as Record<string, string>)["ch1"]).toBe("note");
    expect(nodeParams["ch1"]).toBeDefined();
    // A full save carries no marker.
    const full = JSON.parse(serialize(plan)) as Record<string, unknown>;
    expect("scope" in full).toBe(false);
  });

  it("stripSceneExternal drops the stream delay but keeps the node's other params", () => {
    const plan = defaultPlan("URX44V");
    plan.nodeParams["bus.stream"] = { delay: { on: true, time: 10 }, on: true };
    const stripped = stripSceneExternal(plan);
    expect(stripped.nodeParams["bus.stream"]).toEqual({ on: true });
    // The source plan is untouched (strip returns a copy).
    expect(plan.nodeParams["bus.stream"]?.delay).toEqual({ on: true, time: 10 });
  });

  it("deserializeDocument reports the marker and a load merge keeps current values", () => {
    const saved = defaultPlan("URX44V");
    const doc = deserializeDocument(serialize(saved, { sceneOnly: true }));
    expect(doc.sceneScoped).toBe(true);
    expect(deserializeDocument(serialize(saved)).sceneScoped).toBe(false);

    // The loader's merge: current values win for everything outside the scene.
    const current = defaultPlan("URX44V");
    current.sampleRate = 176400;
    current.nodeParams["bus.osc"] = { osc: { on: true, level: -20 } };
    applySceneExternal(doc.plan, captureSceneExternal(current));
    expect(doc.plan.sampleRate).toBe(176400);
    expect(doc.plan.nodeParams["bus.osc"]).toEqual({ osc: { on: true, level: -20 } });
  });
});

// The third encoding of the same boundary, and the one a provenance mark rests on: after a
// write the plan's values are the unit's, EXCEPT where the write did not go. Asked
// differentially against the emit rather than compared to a list, since a list would agree
// with itself however wrong both halves were.
describe("sceneExternalParamNames", () => {
  const MODEL = getModel("URX44V");
  const emit = (plan: Plan, scope: "all" | "scene"): Set<number> =>
    new Set(planToCommands(MODEL, plan, scope).map(cmdAddr));

  /** The plan with one leaf blanked, the way a caller asking "what does this key send" needs
   *  it: blanked rather than deleted, since an array index is part of a key's identity. */
  function without(plan: Plan, nodeId: string, path: string): Plan {
    const blank = (v: unknown, at: string[]): unknown => {
      if (Array.isArray(v)) return v.map((x, i) => blank(x, [...at, String(i)]));
      if (v && typeof v === "object")
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, blank(x, [...at, k])]));
      return at.join(".") === path ? undefined : v;
    };
    return { ...plan, nodeParams: { ...plan.nodeParams, [nodeId]: blank(plan.nodeParams[nodeId], []) as NodeParams } };
  }

  it("names keys a scene-scoped write does not send, and only those", () => {
    const plan = defaultPlan("URX44V");
    const names = sceneExternalParamNames(plan);
    expect(names.size).toBeGreaterThan(0);
    const sceneBase = emit(plan, "scene");
    const allBase = emit(plan, "all");

    // Every name it gives: the key reaches the device on an unscoped write and not on a
    // scene-scoped one. A key that reached NEITHER would satisfy the second half alone.
    let checked = 0;
    for (const name of names) {
      const [, nodeId, ...rest] = name.split("\0");
      const path = rest.join(".");
      const cut = without(plan, nodeId, path);
      if (emit(cut, "all").size === allBase.size) continue; // sends nothing under either scope
      checked++;
      expect(emit(cut, "scene").size, name).toBe(sceneBase.size);
    }
    expect(checked, "the positive control: some named key does send under the full scope").toBeGreaterThan(0);

    // The one entry the differential above cannot reach: Track Count is read-only, so it
    // emits nothing under either scope and the loop skips it. It is still a key a scene
    // recall leaves alone, and it is the function's only conditional — asserted here, or
    // deleting that arm changes no test in the tree.
    const tracks = nodeParamContestPath("out.sdrec", "sdRecTrackCount");
    expect(plan.nodeParams["out.sdrec"]?.sdRecTrackCount, "the premise").toBeGreaterThan(0);
    expect(names.has(tracks)).toBe(true);
    // …and the arm's other side: a plan not carrying it does not name it.
    const noTracks = { ...plan, nodeParams: { ...plan.nodeParams, "out.sdrec": {} } };
    expect(sceneExternalParamNames(noTracks).has(tracks)).toBe(false);

    // …and the reverse, on a key it does not name: a channel's head-amp gain is sent under
    // both scopes, so the set is a boundary rather than everything it happened to walk.
    const gain = without(plan, "ch1", "gain");
    expect(names.has(nodeParamContestPath("ch1", "gain"))).toBe(false);
    expect(emit(gain, "all").size).toBeLessThan(allBase.size);
    expect(emit(gain, "scene").size).toBeLessThan(sceneBase.size);
  });
});
