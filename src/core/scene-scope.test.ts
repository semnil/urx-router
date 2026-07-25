import { describe, it, expect } from "vitest";
import { applySceneExternal, captureSceneExternal, isSceneExternalConnection, stripSceneExternal } from "./scene-scope";
import { deserializeDocument, serialize } from "./plan";
import { defaultPlan } from "../models/initial-state";
import { getModel } from "../models";
import { PARAMS } from "./control/params";
import type { ParamSpec } from "./control/params";
import { planToCommands } from "./control/translate";

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
