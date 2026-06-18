import { describe, expect, it } from "vitest";
import { emptyPlan } from "../core/plan";
import { defaultPlan } from "./initial-state";
import { URX44V_CONNECTIONS, URX44V_NODE_PARAMS } from "./initial-urx44v";

describe("defaultPlan", () => {
  it("seeds URX44V with its captured factory node params and routing", () => {
    const plan = defaultPlan("URX44V");
    expect(plan.modelId).toBe("URX44V");
    expect(plan.nodeParams).toEqual(URX44V_NODE_PARAMS);
    expect(plan.connections).toEqual(URX44V_CONNECTIONS);
  });

  it("deep-clones the seed so edits never mutate the shared defaults", () => {
    const plan = defaultPlan("URX44V");
    plan.nodeParams.ch1.gain = 99;
    plan.connections.push({ from: "x:out", to: "y:in", kind: "send" });
    expect(URX44V_NODE_PARAMS.ch1.gain).toBe(-8);
    expect(URX44V_CONNECTIONS.some((c) => c.from === "x:out")).toBe(false);
  });

  it("falls back to an empty plan for models without a capture", () => {
    for (const id of ["URX22", "URX44"] as const) {
      expect(defaultPlan(id)).toEqual(emptyPlan(id));
    }
  });
});
