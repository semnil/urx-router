import { describe, expect, it } from "vitest";
import { MODELS } from "./index";
import { defaultPlan } from "./initial-state";
import { URX22_CONNECTIONS, URX22_NODE_PARAMS } from "./initial-urx22";
import { URX44V_CONNECTIONS, URX44V_NODE_PARAMS } from "./initial-urx44v";
import { parseRef } from "./types";

describe("defaultPlan", () => {
  it("seeds URX44V with its captured factory node params and routing", () => {
    const plan = defaultPlan("URX44V");
    expect(plan.modelId).toBe("URX44V");
    expect(plan.nodeParams).toEqual(URX44V_NODE_PARAMS);
    expect(plan.connections).toEqual(URX44V_CONNECTIONS);
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
    for (const id of Object.keys(plan.nodeParams)) {
      expect(model.nodes.some((n) => n.id === id), `${id}`).toBe(true);
    }
    for (const c of plan.connections) {
      expect(port(c.from), `${id}: ${c.from}`).toBe(true);
      expect(port(c.to), `${id}: ${c.to}`).toBe(true);
    }
  });
});
