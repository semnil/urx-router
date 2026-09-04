import { describe, expect, it } from "vitest";
import { nodeParamContestPath } from "../core/plan-history";
import { sceneExternalParamNames } from "../core/scene-scope";
import type { Plan } from "../core/plan";
import { filledPlan } from "./filled-plan.test-util";
import { getModel } from "../models";
import { markParamSource, markPlanFromDevice, sentParamNames } from "./param-source";

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

  // The exception is per KEY, not per node. What the write path hands in is `sentParamNames`
  // (below), and the scene boundary is the shape that separates two halves of ONE node — so
  // it is what this asks with: a node-granular exception would answer for both halves at once.
  it("leaves the keys its caller says were not sent", () => {
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

  // …and it takes a node-granular exception too, since a caller may have nothing finer to say.
  it("leaves a whole node its caller names", () => {
    const plan = filledPlan();
    markPlanFromDevice(plan, (nodeId) => nodeId === "ch2");
    expect(sourcesOf(plan, "ch2")).toEqual(new Set(["default"]));
    expect(sourcesOf(plan, "ch1")).toEqual(new Set(["device"]));
  });
});

// What a write actually puts on the wire, which is not "every key in the plan". The emit
// skips a key for reasons the scene boundary knows nothing about, and a key marked as the
// unit's on the strength of a write that skipped it makes the next confirm name a value the
// operator set themselves.
describe("sentParamNames", () => {
  const MODEL = getModel("URX44V");

  it("leaves out a group the channel's mode does not send", () => {
    const plan = filledPlan();
    // SSMCS rides the other COMP/EQ order, and the factory value is COMP-first, so none of
    // those leaves reaches the device on this plan.
    const ssmcs = [...plan.paramSource!.keys()].filter((k) => k.includes("ssmcs"));
    expect(ssmcs.length, "the premise: the factory carries an SSMCS section").toBeGreaterThan(0);
    const sent = sentParamNames(MODEL, plan, "all");
    expect(ssmcs.filter((k) => sent.has(k))).toEqual([]);
    // The positive control: an ordinary key of the same channel IS sent, so the emptiness
    // above is the mode rather than the join answering nothing.
    expect(sent.has(nodeParamContestPath("ch1", "gain"))).toBe(true);
  });

  it("leaves out what a scene-scoped write does not reach", () => {
    const plan = filledPlan();
    const scene = sentParamNames(MODEL, plan, "scene");
    const all = sentParamNames(MODEL, plan, "all");
    expect(scene.size).toBeLessThan(all.size);
    for (const name of sceneExternalParamNames(plan)) {
      if (all.has(name)) expect(scene.has(name), name).toBe(false);
    }
  });
});
