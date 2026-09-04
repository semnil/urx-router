import { describe, expect, it } from "vitest";
import { cmdAddr, planToCommands } from "../core/control/translate";
import { nodeParamContestPath } from "../core/plan-history";
import type { ParamSource, Plan } from "../core/plan";
import { getModel } from "../models";
import { defaultPlan, fillFactoryParams } from "../models/initial-state";
import { unauthoredWriteNodes } from "./unauthored-writes";

const MODEL = getModel("URX44V");

/** A document that named nothing, completed the way the loader completes one. */
function filledPlan(): Plan {
  const plan = defaultPlan("URX44V");
  plan.nodeParams = {};
  fillFactoryParams("URX44V", plan);
  return plan;
}

const everyAddr = (plan: Plan): Set<number> => new Set(planToCommands(MODEL, plan, "all").map(cmdAddr));

/** Re-mark every key of one node, the way an edit or a device read would. */
function markNode(plan: Plan, nodeId: string, source: ParamSource): number {
  const prefix = nodeParamContestPath(nodeId, "");
  let n = 0;
  for (const key of plan.paramSource!.keys()) {
    if (key.startsWith(prefix)) {
      plan.paramSource!.set(key, source);
      n++;
    }
  }
  return n;
}

describe("unauthoredWriteNodes", () => {
  // A plan nobody has marked is one this cannot answer for. Reporting every key instead
  // would put the warning on every write the app has ever made.
  it("says nothing about a plan that carries no provenance", () => {
    const plan = defaultPlan("URX44V");
    expect(plan.paramSource).toBeUndefined();
    expect(unauthoredWriteNodes(MODEL, plan, "all", everyAddr(plan))).toEqual([]);
  });

  // The positive control for everything below: a document that described nothing is
  // factory-filled throughout, so every strip the write moves is one nobody chose.
  it("names every strip of a document that described nothing", () => {
    const plan = filledPlan();
    const nodes = unauthoredWriteNodes(MODEL, plan, "all", everyAddr(plan));
    expect(nodes.length).toBeGreaterThan(1);
    expect(nodes).toContain("ch1");
    expect(nodes).toContain("bus.fx1");
  });

  // The distinction the whole feature rests on: the operator's own keys, and the document's,
  // are values someone chose. Only the fill and the unit's own readings are not.
  it.each<[ParamSource, boolean]>([
    ["manual", false],
    ["load", false],
    ["default", true],
    ["device", true],
  ])("reports a strip whose keys came from %s: %s", (source, reported) => {
    const plan = filledPlan();
    expect(markNode(plan, "ch1", source)).toBeGreaterThan(0);
    expect(unauthoredWriteNodes(MODEL, plan, "all", everyAddr(plan)).includes("ch1")).toBe(reported);
  });

  // What it is warning ABOUT is the write, not the fill: a factory-filled key the unit already
  // agrees with moves nothing, so naming its strip would send the operator to look at a value
  // that is not going to change.
  it("says nothing when the addresses do not differ from the device", () => {
    const plan = filledPlan();
    expect(unauthoredWriteNodes(MODEL, plan, "all", new Set())).toEqual([]);
  });

  // …and the same plan reports only the strips whose addresses are in that set.
  it("names only the strips the write actually moves", () => {
    const plan = filledPlan();
    const ch2 = new Set(
      planToCommands(MODEL, plan, "all")
        .filter((c) => c.node === "ch2")
        .map(cmdAddr),
    );
    expect(ch2.size).toBeGreaterThan(0);
    expect(unauthoredWriteNodes(MODEL, plan, "all", ch2)).toEqual(["ch2"]);
  });

  // A scene-scoped write sends less, so it warns about less: the device-wide strips are not
  // in its emit at all and cannot be changed by it.
  it("leaves the scene-external strips out of a scene-scoped write", () => {
    const plan = filledPlan();
    const all = everyAddr(plan);
    expect(unauthoredWriteNodes(MODEL, plan, "all", all)).toContain("bus.mon1");
    expect(unauthoredWriteNodes(MODEL, plan, "scene", all)).not.toContain("bus.mon1");
  });
});
