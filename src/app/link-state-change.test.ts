import { describe, expect, it } from "vitest";
import { changesLinkState } from "./link-state-change";
import { clonePlanState, diffPlans } from "../core/plan-history";
import { defaultPlan } from "../models/initial-state";
import type { Plan } from "../core/plan";

/** The patch a device read produces for one edit, taken with the differ the read itself
 *  hands to `absorb` — a hand-written patch would agree with this predicate however far the
 *  two had drifted. */
const patchFor = (edit: (plan: Plan) => void) => {
  const plan = defaultPlan("URX44V");
  const before = clonePlanState(plan);
  edit(plan);
  return diffPlans(before, plan);
};

describe("changesLinkState", () => {
  it("sees a link turning on", () => {
    expect(
      changesLinkState(patchFor((p) => (p.nodeParams["ch1"] = { ...p.nodeParams["ch1"], stereoLink: true }))),
    ).toBe(true);
  });

  // The unlink direction reads the same key from the other side, and it is the one an
  // "after only" test would miss.
  it("sees a link turning off", () => {
    const plan = defaultPlan("URX44V");
    plan.nodeParams["ch1"] = { ...plan.nodeParams["ch1"], stereoLink: true };
    const before = clonePlanState(plan);
    const { stereoLink: _dropped, ...rest } = plan.nodeParams["ch1"];
    plan.nodeParams["ch1"] = rest;
    expect(changesLinkState(diffPlans(before, plan))).toBe(true);
  });

  it("does not see another node parameter moving", () => {
    expect(changesLinkState(patchFor((p) => (p.nodeParams["ch1"] = { ...p.nodeParams["ch1"], hpf: true })))).toBe(
      false,
    );
  });

  // The snap's own write is a position, and a position alone must not ask for the full
  // reflect — that is the seat's other condition, not this one.
  it("does not see a position moving", () => {
    expect(changesLinkState(patchFor((p) => (p.positions["ch2"] = { x: 900, y: 620 })))).toBe(false);
  });

  it("sees nothing in an empty patch", () => {
    expect(changesLinkState([])).toBe(false);
  });
});
