import { describe, expect, it } from "vitest";
import { nodeParamContestPath } from "../core/plan-history";
import type { Plan } from "../core/plan";
import { filledPlan } from "./filled-plan.test-util";
import { defaultPlan } from "../models/initial-state";
import { markParamSource } from "./param-source";

const sourcesOf = (plan: Plan, nodeId: string): Set<string> => {
  const prefix = nodeParamContestPath(nodeId, "");
  const seen = new Set<string>();
  for (const [key, from] of plan.paramSource!) if (key.startsWith(prefix)) seen.add(from);
  return seen;
};

describe("markParamSource", () => {
  // The map is created on first use, so a plan nothing has recorded carries none — which
  // `app/unauthored-writes.ts` reads as "no funnel claims these values" rather than as an
  // absence it cannot answer for.
  it("creates the record on the first key and keeps what is already there", () => {
    const plan = filledPlan();
    const gain = nodeParamContestPath("ch1", "gain");
    expect(plan.paramSource!.get(gain), "the premise: the fill recorded it").toBe("default");
    markParamSource(plan, [gain], "manual");
    expect(plan.paramSource!.get(gain)).toBe("manual");
    expect(sourcesOf(plan, "ch2"), "and left the rest alone").toEqual(new Set(["default"]));
  });

  it("records into a plan that has no map yet", () => {
    const plan = defaultPlan("URX44V");
    expect(plan.paramSource).toBeUndefined();
    markParamSource(plan, [nodeParamContestPath("ch1", "gain")], "manual");
    expect(plan.paramSource!.get(nodeParamContestPath("ch1", "gain"))).toBe("manual");
    expect(plan.paramSource!.size, "and claims nothing else").toBe(1);
  });
});
