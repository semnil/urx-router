import { describe, expect, it } from "vitest";
import { nodeParamContestPath } from "../core/plan-history";
import type { Plan } from "../core/plan";
import { filledPlan } from "./filled-plan.test-util";
import { defaultPlan } from "../models/initial-state";
import {
  inheritSceneExternalRecords,
  markAuthored,
  markParamSource,
  noteSeededDefaults,
  type SeededDefault,
} from "./param-source";

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
    const gain = nodeParamContestPath("in.micline_1_2", "gainL");
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

// An effect selection puts the type's defaults in the plan for the slots it does not hold. Those
// are the fill's, not the operator's: the edit's own keys are recorded as theirs when its entry
// closes, and the seeded ones as the fill's — unless an edit inside the same entry moved one.
describe("markAuthored", () => {
  const key = (slot: number) => nodeParamContestPath("ch1", `insertFxParams.compander:${slot}`);
  const selected = (): { plan: Plan; seeded: Map<string, SeededDefault> } => {
    const plan = filledPlan();
    plan.nodeParams.ch1 = {
      ...plan.nodeParams.ch1,
      insertFx: 1793,
      insertFxParams: { "compander:6": -1000, "compander:7": 350 },
    };
    const seeded = new Map<string, SeededDefault>();
    noteSeededDefaults(plan, seeded, [
      ["ch1", "insertFxParams.compander:6"],
      ["ch1", "insertFxParams.compander:7"],
    ]);
    return { plan, seeded };
  };

  it("records the seeded values as the fill's and the rest of the edit as the operator's", () => {
    const { plan, seeded } = selected();
    const selector = nodeParamContestPath("ch1", "insertFx");
    markAuthored(plan, [selector, key(6), key(7)], seeded);
    expect(plan.paramSource!.get(selector)).toBe("manual");
    expect([plan.paramSource!.get(key(6)), plan.paramSource!.get(key(7))]).toEqual(["default", "default"]);
    expect(seeded.size, "every entry the names reached is spent").toBe(0);
  });

  it("records a seeded value an edit moved before the entry closed as the operator's", () => {
    const { plan, seeded } = selected();
    plan.nodeParams.ch1!.insertFxParams!["compander:6"] = -2000;
    markAuthored(plan, [key(6), key(7)], seeded);
    expect([plan.paramSource!.get(key(6)), plan.paramSource!.get(key(7))]).toEqual(["manual", "default"]);
  });

  // The control: with nothing seeded, every name is the operator's, as before.
  it("records every name as the operator's where nothing was seeded", () => {
    const { plan } = selected();
    markAuthored(plan, [key(6)], new Map());
    expect(plan.paramSource!.get(key(6))).toBe("manual");
  });
});

describe("inheritSceneExternalRecords", () => {
  // The STREAMING delay's frame rate is outside the scene under the current boundary: a scene-scoped
  // document does not carry it, and the load copies it off the plan on screen.
  const FRAME_RATE = nodeParamContestPath("bus.stream", "delay.frameRate");
  const plans = (): { next: Plan; current: Plan } => {
    const current = filledPlan();
    current.paramSource!.set(FRAME_RATE, "load");
    const next = filledPlan();
    next.paramSource!.set(FRAME_RATE, "default");
    expect(next.nodeParams["bus.stream"]?.delay?.frameRate, "the premise: the plan carries a frame rate").toBeDefined();
    return { next, current };
  };

  it("gives a value the document did not carry the record of the plan it was copied off", () => {
    const { next, current } = plans();
    inheritSceneExternalRecords(next, current, 2, []);
    expect(next.paramSource!.get(FRAME_RATE)).toBe("load");
  });

  it("keeps the record the load gave a value it repaired", () => {
    const { next, current } = plans();
    inheritSceneExternalRecords(next, current, 2, [FRAME_RATE]);
    expect(next.paramSource!.get(FRAME_RATE)).toBe("default");
  });
});
