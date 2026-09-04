import { describe, expect, it } from "vitest";
import { nodeParamContestPath } from "../core/plan-history";
import { sceneExternalParamNames } from "../core/scene-scope";
import type { Plan } from "../core/plan";
import { defaultPlan, fillFactoryParams } from "../models/initial-state";
import { markParamSource, markPlanFromDevice } from "./param-source";

/** A document that named nothing, completed the way the loader completes one. */
function filledPlan(): Plan {
  const plan = defaultPlan("URX44V");
  plan.nodeParams = {};
  fillFactoryParams("URX44V", plan);
  return plan;
}

const sourcesOf = (plan: Plan, nodeId: string): Set<string> => {
  const prefix = nodeParamContestPath(nodeId, "");
  const seen = new Set<string>();
  for (const [key, from] of plan.paramSource!) if (key.startsWith(prefix)) seen.add(from);
  return seen;
};

describe("markPlanFromDevice", () => {
  // What a settled read and a completed write have in common: the plan and the unit now
  // agree, so nothing in it is a value the operator has to be warned about.
  it("takes every key as the unit's", () => {
    const plan = filledPlan();
    expect(sourcesOf(plan, "ch1")).toEqual(new Set(["default"]));
    markPlanFromDevice(plan, () => false);
    expect(sourcesOf(plan, "ch1")).toEqual(new Set(["device"]));
    expect(sourcesOf(plan, "bus.mon1")).toEqual(new Set(["device"]));
  });

  // …including over a mark the operator's own edit left, which is the point: the value they
  // set is now what the unit holds, so a later disagreement is the unit having moved.
  it("takes a key the operator authored as well", () => {
    const plan = filledPlan();
    const gain = nodeParamContestPath("ch1", "gain");
    markParamSource(plan, [gain], "manual");
    markPlanFromDevice(plan, () => false);
    expect(plan.paramSource!.get(gain)).toBe("device");
  });

  // The exception a scene-scoped write needs. A key marked as the unit's on the strength of
  // a write that skipped it would silence the very warning the mark exists to raise.
  it("leaves the keys a scene-scoped write never sent", () => {
    const plan = filledPlan();
    // The factory fill gives bus.stream its delay block alone, and the delay block is the
    // scene-external half of that node — so the scene-internal half is put here, or the case
    // cannot tell a per-key boundary from a per-node one.
    plan.nodeParams["bus.stream"]!.on = true;
    markParamSource(plan, [nodeParamContestPath("bus.stream", "on")], "default");
    const untouched = sceneExternalParamNames(plan);
    expect(untouched.size).toBeGreaterThan(0);
    markPlanFromDevice(plan, (_node, name) => untouched.has(name));
    expect(sourcesOf(plan, "bus.mon1")).toEqual(new Set(["default"]));
    expect(sourcesOf(plan, "ch1")).toEqual(new Set(["device"]));
    // The split node: its delay keys were not sent, its own ON was.
    expect(plan.paramSource!.get(nodeParamContestPath("bus.stream", "delay.on"))).toBe("default");
    expect(plan.paramSource!.get(nodeParamContestPath("bus.stream", "on"))).toBe("device");
  });

  // A read that could not answer for a node leaves that node alone, the same way.
  it("leaves the nodes a read could not answer for", () => {
    const plan = filledPlan();
    markPlanFromDevice(plan, (nodeId) => nodeId === "ch2");
    expect(sourcesOf(plan, "ch2")).toEqual(new Set(["default"]));
    expect(sourcesOf(plan, "ch1")).toEqual(new Set(["device"]));
  });
});
