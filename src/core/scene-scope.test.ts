import { describe, it, expect } from "vitest";
import {
  SCENE_BOUNDARY,
  applySceneExternal,
  captureSceneExternal,
  isSceneExternalConnection,
  sceneExternalParamNames,
  stripSceneExternal,
} from "./scene-scope";
import { PLAN_VERSION, deserializeDocument, serialize } from "./plan";
import type { NodeParams, Plan } from "./plan";
import { nodeParamContestPath } from "./plan-history";
import { defaultPlan } from "../models/initial-state";
import { getModel } from "../models";
import { COLOR_PALETTE, PARAMS } from "./control/params";
import type { ParamSpec } from "./control/params";
import { cmdAddr, planToCommands } from "./control/translate";

// The scene boundary, in two groups so a reader can tell what is hardware-measured
// from what is asserted. Together they are the contract: params.ts flags (the
// write-side boundary) and scene-scope.ts (the plan-side boundary) must both track
// them, so the two cannot drift apart silently.
//
// The catalog names a scene recall leaves alone, plus OSC_ON, which the .urxf format
// carries no descriptor for and which a recall leaves alone as well.
const AUDITED_SCENE_EXTERNAL = [
  "MONITOR_SRC_L",
  "MONITOR_SRC_R",
  "MONITOR_CUE_INTERRUPT",
  "MONITOR_MONO",
  "MONITOR_ON",
  "MONITOR_LEVEL",
  "PHONES_LEVEL",
  "SD_REC_SOURCE",
  "SD_REC_TRACK_COUNT",
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

// What System firmware V1.5 moved INTO the scene: a Store takes these and a Recall brings
// them back, where the firmware before it left them alone. They carry no flag, and a
// scene-scoped write sends them.
const IN_SCENE_SINCE_V15 = [
  "OUT_PATCH_MAIN",
  "OUT_PATCH_LINE",
  "USB_OUT_SRC_A",
  "USB_OUT_SRC_B",
  "USB_OUT_SRC_C",
  "USB_OUT_SRC_SUB",
  "STREAM_COLOR",
  "STREAM_SRC_L",
  "STREAM_SRC_R",
  "STREAM_DELAY_ON",
  "STREAM_DELAY_TIME",
];

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
  "POST_FADER_SEND_FX1",
  "POST_FADER_SEND_FX2",
].sort();

// The unit's LCD selection and HOME's [Sends] destination: UI state the settings file carries
// outside every scene, and which a scene recall leaves where it was.
const UI_STATE_SCENE_EXTERNAL = ["LCD_SELECTION", "SENDS_TARGET"];

// The [CUE] flags: the unit clears them at power-off and no scene or settings file carries
// them, so a recall cannot move them back to a stored value.
const CUE_SCENE_EXTERNAL = ["CUE_MONO", "CUE_STEREO_CH", "CUE_FX", "CUE_STEREO", "CUE_MIX", "CUE_STREAMING"];

// [CUE Mode], System 1.5: the settings file carries it for the unit as a whole and in no scene —
// a scene stored on that firmware does not hold it.
const CUE_MODE_SCENE_EXTERNAL = ["CUE_MODE"];

// [Console Lock], System 1.5: no chunk of the settings file carries it, a scene included, and the
// unit comes up unlocked after a power cycle.
const CONSOLE_LOCK_SCENE_EXTERNAL = ["CONSOLE_LOCK"];

const SCENE_EXTERNAL_NAMES = [
  ...AUDITED_SCENE_EXTERNAL,
  ...SETUP_SCENE_EXTERNAL,
  ...UI_STATE_SCENE_EXTERNAL,
  ...CUE_SCENE_EXTERNAL,
  ...CUE_MODE_SCENE_EXTERNAL,
  ...CONSOLE_LOCK_SCENE_EXTERNAL,
].sort();

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

  it("the scene write scope sends what V1.5 moved into the scene, every one of them", () => {
    const model = getModel("URX44V");
    const plan = defaultPlan("URX44V");
    plan.nodeParams["bus.stream"] = { ...plan.nodeParams["bus.stream"], delay: { on: true, time: 250, frameRate: 3 } };
    plan.nodeColors["bus.stream"] = COLOR_PALETTE[1].hex;
    const scene = new Set(planToCommands(model, plan, "scene").map((c) => c.name));
    for (const name of IN_SCENE_SINCE_V15) {
      expect((PARAMS as Record<string, ParamSpec>)[name].sceneExternal, name).toBeUndefined();
      expect(scene.has(name as never), name).toBe(true);
    }
    // The frame rate sits in the same delay block and stays outside.
    expect(scene.has("STREAM_DELAY_FRAME_RATE")).toBe(false);
  });

  it("classifies the factory plan's wires: records / monitor sources / OSC assigns outside, patches and the stream source inside", () => {
    const plan = defaultPlan("URX44V");
    const external = plan.connections.filter((c) => isSceneExternalConnection(c));
    expect(external.some((c) => c.kind === "record")).toBe(true);
    expect(external.some((c) => c.kind === "source" && c.to.startsWith("bus.mon1"))).toBe(true);
    expect(external.some((c) => c.kind === "sendSwitch" && c.from.startsWith("bus.osc"))).toBe(true);
    expect(
      plan.connections.some((c) => c.kind === "patch"),
      "the premise",
    ).toBe(true);
    expect(
      plan.connections.some((c) => c.kind === "source" && c.to.startsWith("bus.stream")),
      "the premise",
    ).toBe(true);
    expect(external.some((c) => c.kind === "patch")).toBe(false);
    expect(external.some((c) => c.kind === "source" && c.to.startsWith("bus.stream"))).toBe(false);
    // A channel input-source wire and a plain bus send stay scene-internal.
    expect(external.some((c) => c.kind === "send")).toBe(false);
  });

  it("the boundary before V1.5 also names every patch and the stream source, and nothing the current one does not", () => {
    const plan = defaultPlan("URX44V");
    const now = plan.connections.filter((c) => isSceneExternalConnection(c, SCENE_BOUNDARY));
    const before = plan.connections.filter((c) => isSceneExternalConnection(c, 1));
    for (const c of now) expect(before).toContain(c);
    const added = before.filter((c) => !now.includes(c));
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((c) => c.kind === "patch" || (c.kind === "source" && c.to.startsWith("bus.stream")))).toBe(true);
    expect(added.filter((c) => c.kind === "patch").length).toBe(
      plan.connections.filter((c) => c.kind === "patch").length,
    );
  });
});

describe("captureSceneExternal / applySceneExternal", () => {
  it("carries the device-wide settings across a plan replacement", () => {
    const current = defaultPlan("URX44V");
    current.sampleRate = 96000;
    current.nodeParams["bus.mon1"] = { level: -12, mono: true };
    current.nodeParams["bus.stream"] = { delay: { on: true, time: 250, frameRate: 3 } };
    current.nodeParams["out.sdrec"] = { sdRecTrackCount: 5 };
    current.nodeColors["bus.stream"] = "#123456";
    const keep = captureSceneExternal(current);

    const next = defaultPlan("URX44V");
    next.nodeParams["bus.stream"] = { delay: { on: false, time: 40, frameRate: 6 } };
    next.nodeColors["bus.stream"] = "#abcdef";
    const patches = next.connections.filter((c) => c.kind === "patch");
    next.connections = next.connections.filter((c) => c !== patches[0]);
    applySceneExternal(next, keep);
    expect(next.sampleRate).toBe(96000);
    expect(next.nodeParams["bus.mon1"]).toEqual({ level: -12, mono: true });
    expect(next.nodeParams["out.sdrec"]?.sdRecTrackCount).toBe(5);
    // Of the delay block only the frame rate crosses; the switch, the time and the colour are
    // the receiving plan's, since a scene keeps them.
    expect(next.nodeParams["bus.stream"]?.delay).toEqual({ on: false, time: 40, frameRate: 3 });
    expect(next.nodeColors["bus.stream"]).toBe("#abcdef");
    // …and so are the patches: the one the receiving plan lacks is not put back.
    expect(next.connections.filter((c) => c.kind === "patch")).toEqual(patches.slice(1));
    // The wire set matches the source plan's scene-external wires exactly.
    expect(next.connections.filter((c) => isSceneExternalConnection(c))).toEqual(
      current.connections.filter((c) => isSceneExternalConnection(c)),
    );
  });

  it("along the boundary before V1.5, the patches and the whole STREAMING block cross too", () => {
    const current = defaultPlan("URX44V");
    current.nodeParams["bus.stream"] = { delay: { on: true, time: 250, frameRate: 3 } };
    current.nodeColors["bus.stream"] = "#123456";
    const keep = captureSceneExternal(current, 1);

    const next = defaultPlan("URX44V");
    next.nodeParams["bus.stream"] = { delay: { on: false, time: 40, frameRate: 6 }, on: false };
    next.nodeColors["bus.stream"] = "#abcdef";
    next.connections = next.connections.filter(
      (c) => c.kind !== "patch" && !(c.kind === "source" && c.to.startsWith("bus.stream")),
    );
    applySceneExternal(next, keep);
    expect(next.nodeParams["bus.stream"]).toEqual({ delay: { on: true, time: 250, frameRate: 3 }, on: false });
    expect(next.nodeColors["bus.stream"]).toBe("#123456");
    const key = (c: { from: string; to: string }): string => `${c.from} ${c.to}`;
    expect(
      next.connections
        .filter((c) => c.kind === "patch")
        .map(key)
        .sort(),
    ).toEqual(
      current.connections
        .filter((c) => c.kind === "patch")
        .map(key)
        .sort(),
    );
    expect(next.connections.some((c) => c.kind === "source" && c.to.startsWith("bus.stream"))).toBe(true);
  });

  it("the frame rate arrives on a plan that holds no STREAMING params, and its absence creates none", () => {
    const current = defaultPlan("URX44V");
    current.nodeParams["bus.stream"] = { delay: { on: true, time: 250, frameRate: 3 } };
    const next = defaultPlan("URX44V");
    delete next.nodeParams["bus.stream"];
    applySceneExternal(next, captureSceneExternal(current));
    expect(next.nodeParams["bus.stream"]).toEqual({ delay: { frameRate: 3 } });

    const bare = defaultPlan("URX44V");
    delete bare.nodeParams["bus.stream"];
    const empty = defaultPlan("URX44V");
    delete empty.nodeParams["bus.stream"];
    applySceneExternal(empty, captureSceneExternal(bare));
    expect(empty.nodeParams["bus.stream"]).toBeUndefined();

    // A node that holds something else keeps it when the frame rate, and the block with it, goes.
    const other = defaultPlan("URX44V");
    other.nodeParams["bus.stream"] = { delay: { frameRate: 6 }, on: true };
    applySceneExternal(other, captureSceneExternal(bare));
    expect(other.nodeParams["bus.stream"]).toEqual({ on: true });
  });

  it("the frame rate's absence crosses as an absence, without emptying the rest of the block", () => {
    const bare = defaultPlan("URX44V");
    bare.nodeParams["bus.stream"] = { delay: { on: true, time: 250 } };
    const next = defaultPlan("URX44V");
    next.nodeParams["bus.stream"] = { delay: { on: false, time: 40, frameRate: 6 } };
    applySceneExternal(next, captureSceneExternal(bare));
    expect(next.nodeParams["bus.stream"]?.delay).toEqual({ on: false, time: 40 });

    // A block that held the frame rate alone goes with it.
    const only = defaultPlan("URX44V");
    only.nodeParams["bus.stream"] = { delay: { frameRate: 6 } };
    applySceneExternal(only, captureSceneExternal(bare));
    expect(only.nodeParams["bus.stream"]).toBeUndefined();
  });

  it("clears fields the captured plan did not have (absence round-trips too)", () => {
    const bare = defaultPlan("URX44V");
    delete bare.nodeParams["bus.mon1"];
    delete bare.nodeColors["bus.stream"];

    const next = defaultPlan("URX44V");
    next.nodeParams["bus.mon1"] = { level: 5 };
    next.nodeColors["bus.stream"] = "#ff0000";
    applySceneExternal(next, captureSceneExternal(bare));
    expect(next.nodeParams["bus.mon1"]).toBeUndefined();
    // The colour is the scene's now, so its absence in the captured plan clears nothing…
    expect(next.nodeColors["bus.stream"]).toBe("#ff0000");
    // …and along the boundary before V1.5 it still does.
    applySceneExternal(next, captureSceneExternal(bare, 1));
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
    expect(next.connections.some((c) => isSceneExternalConnection(c))).toBe(true);

    applySceneExternal(next, captureSceneExternal(current));
    expect(next.connections.map((c) => `${c.from} ${c.to}`)).toEqual(before);

    // One the receiving plan does not have goes to the end, which is where a wire the
    // operator has never seen belongs.
    const captured = captureSceneExternal(current);
    const dropped = next.connections.findIndex((c) => isSceneExternalConnection(c));
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
    expect(doc.version).toBe(PLAN_VERSION);
    expect("sampleRate" in doc).toBe(false);
    const conns = doc.connections as Array<{ kind: string; to: string }>;
    expect(conns.some((c) => c.kind === "record")).toBe(false);
    expect(conns.some((c) => c.kind === "source" && c.to.startsWith("bus.mon"))).toBe(false);
    // The output patches and the STREAMING source are the scene's, and stay in the file.
    expect(conns.filter((c) => c.kind === "patch").length).toBe(
      plan.connections.filter((c) => c.kind === "patch").length,
    );
    expect(conns.some((c) => c.kind === "source" && c.to.startsWith("bus.stream"))).toBe(true);
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

  it("stripSceneExternal drops the stream delay's frame rate and keeps the rest of the node", () => {
    const plan = defaultPlan("URX44V");
    plan.nodeParams["bus.stream"] = { delay: { on: true, time: 10, frameRate: 4 }, on: true };
    plan.nodeColors["bus.stream"] = "#123456";
    const stripped = stripSceneExternal(plan);
    expect(stripped.nodeParams["bus.stream"]).toEqual({ delay: { on: true, time: 10 }, on: true });
    expect(stripped.nodeColors["bus.stream"]).toBe("#123456");
    // The source plan is untouched (strip returns a copy).
    expect(plan.nodeParams["bus.stream"]?.delay).toEqual({ on: true, time: 10, frameRate: 4 });
    // A delay block holding the frame rate alone goes with it, and the node entry with the block.
    plan.nodeParams["bus.stream"] = { delay: { frameRate: 4 } };
    expect(stripSceneExternal(plan).nodeParams["bus.stream"]).toBeUndefined();
    // …and a node with no delay block at all passes through as it is.
    plan.nodeParams["bus.stream"] = { on: false };
    expect(stripSceneExternal(plan).nodeParams["bus.stream"]).toEqual({ on: false });
  });

  it("deserializeDocument reports the marker and a load merge keeps current values", () => {
    const saved = defaultPlan("URX44V");
    const doc = deserializeDocument(serialize(saved, { sceneOnly: true }));
    expect(doc.sceneScoped).toBe(true);
    expect(doc.sceneBoundary).toBe(SCENE_BOUNDARY);
    expect(deserializeDocument(serialize(saved)).sceneScoped).toBe(false);

    // The loader's merge: current values win for everything outside the scene.
    const current = defaultPlan("URX44V");
    current.sampleRate = 176400;
    current.nodeParams["bus.osc"] = { osc: { on: true, level: -20 } };
    applySceneExternal(doc.plan, captureSceneExternal(current));
    expect(doc.plan.sampleRate).toBe(176400);
    expect(doc.plan.nodeParams["bus.osc"]).toEqual({ osc: { on: true, level: -20 } });
  });

  // A scene-scoped file written before the boundary moved carries no output patch and no
  // STREAMING source, delay or colour, and is tagged version 5 or lower. Opened along today's
  // boundary their absence would be the document's own statement — "no output is patched" —
  // and the next write would unpatch the unit.
  it("a scene-scoped document of version 5 is read along the boundary before V1.5", () => {
    const saved = defaultPlan("URX44V");
    const old = JSON.parse(serialize(saved, { sceneOnly: true })) as Record<string, unknown>;
    old.version = 5;
    old.connections = (old.connections as Array<{ kind: string; to: string }>).filter(
      (c) => c.kind !== "patch" && !(c.kind === "source" && c.to.startsWith("bus.stream")),
    );
    const nodeParams = old.nodeParams as Record<string, Record<string, unknown>>;
    delete nodeParams["bus.stream"]?.delay;
    delete (old.nodeColors as Record<string, string>)["bus.stream"];
    const doc = deserializeDocument(JSON.stringify(old));
    expect(doc.sceneScoped).toBe(true);
    expect(doc.sceneBoundary).toBe(1);
    expect(
      doc.plan.connections.some((c) => c.kind === "patch"),
      "the premise",
    ).toBe(false);

    const current = defaultPlan("URX44V");
    current.nodeParams["bus.stream"] = {
      ...current.nodeParams["bus.stream"],
      delay: { on: true, time: 120, frameRate: 2 },
    };
    current.nodeColors["bus.stream"] = "#123456";
    const main = current.connections.find((c) => c.kind === "patch" && c.to.startsWith("out.main"));
    expect(main, "the premise").toBeDefined();
    applySceneExternal(doc.plan, captureSceneExternal(current, doc.sceneBoundary));
    const key = (c: { from: string; to: string }): string => `${c.from} ${c.to}`;
    expect(
      doc.plan.connections
        .filter((c) => c.kind === "patch")
        .map(key)
        .sort(),
    ).toEqual(
      current.connections
        .filter((c) => c.kind === "patch")
        .map(key)
        .sort(),
    );
    expect(doc.plan.connections.some((c) => c.kind === "source" && c.to.startsWith("bus.stream"))).toBe(true);
    expect(doc.plan.nodeParams["bus.stream"]?.delay).toEqual({ on: true, time: 120, frameRate: 2 });
    expect(doc.plan.nodeColors["bus.stream"]).toBe("#123456");
  });

  it("a document cut along today's boundary brings its own patches, and the current plan's do not replace them", () => {
    const saved = defaultPlan("URX44V");
    const dropped = saved.connections.find((c) => c.kind === "patch" && c.to.startsWith("out.main"));
    expect(dropped, "the premise").toBeDefined();
    saved.connections = saved.connections.filter((c) => c !== dropped);
    saved.nodeParams["bus.stream"] = {
      ...saved.nodeParams["bus.stream"],
      delay: { on: true, time: 300, frameRate: 1 },
    };
    const doc = deserializeDocument(serialize(saved, { sceneOnly: true }));
    expect(doc.sceneBoundary).toBe(SCENE_BOUNDARY);

    const current = defaultPlan("URX44V");
    current.nodeParams["bus.stream"] = {
      ...current.nodeParams["bus.stream"],
      delay: { on: false, time: 10, frameRate: 5 },
    };
    applySceneExternal(doc.plan, captureSceneExternal(current, doc.sceneBoundary));
    expect(doc.plan.connections.some((c) => c.from === dropped!.from && c.to === dropped!.to)).toBe(false);
    // The switch and the time are the document's; the frame rate, which it did not carry, is the current plan's.
    expect(doc.plan.nodeParams["bus.stream"]?.delay).toEqual({ on: true, time: 300, frameRate: 5 });
  });

  it("the document's version decides the boundary: 6 and an unnamed one today's, 5 and below the earlier", () => {
    const text = serialize(defaultPlan("URX44V"), { sceneOnly: true });
    expect(PLAN_VERSION, "the premise: this build writes the first version of today's boundary").toBe(6);
    const boundaryAt = (version: unknown): number => {
      const doc = JSON.parse(text) as Record<string, unknown>;
      if (version === undefined) delete doc.version;
      else doc.version = version;
      return deserializeDocument(JSON.stringify(doc)).sceneBoundary;
    };
    for (const version of [1, 2, 3, 4, 5]) expect(boundaryAt(version), String(version)).toBe(1);
    expect(boundaryAt(6)).toBe(SCENE_BOUNDARY);
    // A hand-authored document with no version, or one that is not a number, is the current format.
    expect(boundaryAt(undefined)).toBe(SCENE_BOUNDARY);
    expect(boundaryAt("5")).toBe(SCENE_BOUNDARY);
    // The field an earlier draft of this change wrote decides nothing.
    const doc = JSON.parse(text) as Record<string, unknown>;
    doc.version = 5;
    doc.sceneBoundary = 2;
    expect(deserializeDocument(JSON.stringify(doc)).sceneBoundary).toBe(1);
  });
});

// The third encoding of the same boundary, and the one a scene-scoped LOAD rests on: the
// device-wide values it carries over came off the plan on screen rather than out of the
// document, so their provenance is that plan's. Asked differentially against the emit rather
// than compared to a list, since a list would agree with itself however wrong both halves were.
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

  it("names keys a scene-scoped operation leaves alone, and only those", () => {
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

    // Of the STREAMING delay block only the frame rate is named, and only where the plan holds
    // one; along the boundary before V1.5 the whole block is.
    const frameRate = nodeParamContestPath("bus.stream", "delay.frameRate");
    const delayOn = nodeParamContestPath("bus.stream", "delay.on");
    const withDelay = (delay: NodeParams["delay"]): Plan => ({
      ...plan,
      nodeParams: { ...plan.nodeParams, "bus.stream": { ...plan.nodeParams["bus.stream"], delay } },
    });
    const full = withDelay({ on: true, time: 250, frameRate: 3 });
    expect(sceneExternalParamNames(full).has(frameRate)).toBe(true);
    expect(sceneExternalParamNames(full).has(delayOn)).toBe(false);
    expect(sceneExternalParamNames(withDelay({ on: true, time: 250 })).has(frameRate)).toBe(false);
    expect(sceneExternalParamNames(full, 1).has(delayOn)).toBe(true);
    expect(sceneExternalParamNames(full, 1).has(frameRate)).toBe(true);

    // …and the reverse, on keys it does not name: a jack's A.Gain and a source's D.Gain are sent
    // under both scopes, so the set is a boundary rather than everything it happened to walk.
    for (const [node, key] of [
      ["in.micline_1_2", "gainL"],
      ["in.aux", "dGain"],
    ] as const) {
      const gain = without(plan, node, key);
      expect(names.has(nodeParamContestPath(node, key)), `${node}.${key}`).toBe(false);
      expect(emit(gain, "all").size, `${node}.${key}`).toBeLessThan(allBase.size);
      expect(emit(gain, "scene").size, `${node}.${key}`).toBeLessThan(sceneBase.size);
    }
  });
});
