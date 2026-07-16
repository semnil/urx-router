import { describe, expect, it } from "vitest";
import { colorControl, planToCommands } from "../core/control/translate";
import { PORT_REF_NONE } from "../core/control/vd";
import { deserialize, serialize } from "../core/plan";
import { validatePlan } from "../core/routing";
import { MODELS } from "./index";
import { defaultPlan } from "./initial-state";
import { URX22_CONNECTIONS, URX22_NODE_PARAMS } from "./initial-urx22";
import { URX44V_CONNECTIONS, URX44V_NODE_NAMES, URX44V_NODE_PARAMS } from "./initial-urx44v";
import { parseRef } from "./types";

describe("defaultPlan", () => {
  it("seeds URX44V with its captured factory node params and routing", () => {
    const plan = defaultPlan("URX44V");
    expect(plan.modelId).toBe("URX44V");
    expect(plan.nodeParams).toEqual(URX44V_NODE_PARAMS);
    expect(plan.connections).toEqual(URX44V_CONNECTIONS);
    expect(plan.nodeNames).toEqual(URX44V_NODE_NAMES);
  });

  it("reuses the URX44V capture for URX44 (identical node set bar the HDMI input)", () => {
    const plan = defaultPlan("URX44");
    expect(plan.nodeParams).toEqual(URX44V_NODE_PARAMS);
    expect(plan.connections).toEqual(URX44V_CONNECTIONS);
  });

  it("seeds URX22 with its inferred factory node params and routing", () => {
    const plan = defaultPlan("URX22");
    expect(plan.nodeParams).toEqual(URX22_NODE_PARAMS);
    expect(plan.connections).toEqual(URX22_CONNECTIONS);
  });

  // The URX22 seed is inferred, not captured: its header documents that stereo
  // defaults are copied by POSITION from the URX44V capture (CH3/4 <- CH5/6,
  // CH5/6 <- CH7/8, CH7/8 <- CH9/10, CH9/10 <- CH11/12). The stereo channel
  // shape is identical across the two files today, so pin the whole object —
  // this catches a URX44V capture correction that misses the URX22 mirror.
  it("URX22 stereo channel seeds mirror the URX44V capture by position", () => {
    const pairs: [string, string][] = [
      ["ch_3_4", "ch_5_6"],
      ["ch_5_6", "ch_7_8"],
      ["ch_7_8", "ch_9_10"],
      ["ch_9_10", "ch_11_12"],
    ];
    for (const [urx22, urx44v] of pairs) {
      expect(URX22_NODE_PARAMS[urx22], `${urx22} <- ${urx44v}`).toEqual(URX44V_NODE_PARAMS[urx44v]);
    }
  });

  it("deep-clones the seed so edits never mutate the shared defaults", () => {
    const plan = defaultPlan("URX44V");
    plan.nodeParams.ch1.gain = 99;
    plan.connections.push({ from: "x:out", to: "y:in", kind: "send" });
    expect(URX44V_NODE_PARAMS.ch1.gain).toBe(-8);
    expect(URX44V_CONNECTIONS.some((c) => c.from === "x:out")).toBe(false);
  });

  // Each seeded default must only reference nodes the model actually has, and
  // wires must land on ports that exist, so a new plan is never born invalid.
  it.each(["URX22", "URX44", "URX44V"] as const)("%s seed only references real ports", (id) => {
    const plan = defaultPlan(id);
    const model = MODELS[id];
    const port = (ref: string): boolean => {
      const { nodeId, portId } = parseRef(ref);
      const node = model.nodes.find((n) => n.id === nodeId);
      return !!node && node.ports.some((p) => p.id === portId);
    };
    const real = (nodeId: string): boolean => model.nodes.some((n) => n.id === nodeId);
    for (const key of [
      ...Object.keys(plan.nodeParams),
      ...Object.keys(plan.nodeColors),
      ...Object.keys(plan.nodeNames),
    ]) {
      expect(real(key), `${id}: ${key}`).toBe(true);
    }
    for (const c of plan.connections) {
      expect(port(c.from), `${id}: ${c.from}`).toBe(true);
      expect(port(c.to), `${id}: ${c.to}`).toBe(true);
    }
  });

  // The microSD Rec seed must reproduce the device's factory track assignment, so a
  // fresh plan written to a factory-reset URX44V is a no-op: tracks 1-12 = CH1-12
  // (port refs 0..11), tracks 13/14 = none, tracks 15/16 = STEREO (256/257).
  it("URX44V SD Rec seed emits the confirmed factory track assignment (param 736)", () => {
    const cmds = planToCommands(MODELS.URX44V, defaultPlan("URX44V")).filter((c) => c.name === "SD_REC_SOURCE");
    const byTrack = new Map(cmds.map((c) => [c.y, c.vdValue]));
    const factory = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, PORT_REF_NONE, PORT_REF_NONE, 256, 257];
    expect(cmds).toHaveLength(16);
    factory.forEach((v, y) => expect(byTrack.get(y), `track ${y}`).toBe(v));
    // Track Count is read-only, so it is seeded for the UI but never emitted.
    expect(defaultPlan("URX44V").nodeParams["out.sdrec"]?.sdRecTrackCount).toBe(16);
  });

  // A fresh document must be routing-legal for every model: no wire without a
  // matching rule, and no single-input receiver carrying two wires. Guards the
  // captured factory routing against the model's own connection rules.
  it.each(["URX22", "URX44", "URX44V"] as const)("%s seed passes routing validation", (id) => {
    expect(validatePlan(MODELS[id], defaultPlan(id))).toEqual([]);
  });

  // The factory seed is the input format future hardware reflection reuses, so it
  // must survive the JSON document round-trip byte-for-byte (deserialize drops no
  // captured connection/param and re-serializes identically).
  it.each(["URX22", "URX44", "URX44V"] as const)("%s seed round-trips through serialize/deserialize", (id) => {
    const text = serialize(defaultPlan(id));
    expect(serialize(deserialize(text))).toBe(text);
  });

  // The color picker shows exactly for device-colorable nodes, so every such node
  // must seed an initial color and no other node may carry one — otherwise a node
  // would offer a settable color with no factory value (or vice versa).
  it.each(["URX22", "URX44", "URX44V"] as const)("%s seeds a color for exactly the colorable nodes", (id) => {
    const model = MODELS[id];
    const colorable = model.nodes.filter((n) => colorControl(model, n.id)).map((n) => n.id).sort();
    const seeded = Object.keys(defaultPlan(id).nodeColors).sort();
    expect(seeded).toEqual(colorable);
  });
});
