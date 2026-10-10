// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { undoRefusal } from "./undo-refusal";
import { getModel } from "../models";
import { defaultPlan } from "../models/initial-state";
import { ref } from "../models/types";
import type { Plan } from "../core/plan";
import { clonePlanState } from "../core/plan-history";
import { t } from "../i18n";

const model = getModel("URX44V");
const MON1 = ref("bus.mon1", "in");
const STREAM = Object.keys(model.requiredSources)[0];
const label = (id: string): string => id.toUpperCase();

/** The plan an entry would leave: a copy of `plan` with `edit` applied. */
const after = (plan: Plan, edit: (p: Plan) => void): Plan => {
  const next = clonePlanState(plan);
  edit(next);
  return next;
};

describe("why an undo or redo entry is held back", () => {
  it("lets an entry apply that leaves a shape the unit holds", () => {
    const plan = defaultPlan("URX44V");
    expect(
      undoRefusal(
        model,
        plan,
        after(plan, () => {}),
        label,
      ),
    ).toBeNull();
  });

  it("names the input an entry would leave with two sources", () => {
    const plan = defaultPlan("URX44V");
    expect(
      plan.connections.filter((c) => c.to === MON1),
      "the premise: MONITOR 1 holds one source",
    ).toHaveLength(1);
    const two = after(plan, (p) => p.connections.push({ from: ref("bus.mix1", "out"), to: MON1, kind: "source" }));
    expect(undoRefusal(model, plan, two, label)).toBe(t().status.undoWireShape("BUS.MON1"));
  });

  it("names STREAMING an entry would leave with no source", () => {
    const plan = defaultPlan("URX44V");
    const none = after(plan, (p) => (p.connections = p.connections.filter((c) => c.to !== STREAM)));
    expect(undoRefusal(model, plan, none, label)).toBe(
      t().status.undoWireShape(label(STREAM.slice(0, STREAM.indexOf(":")))),
    );
  });

  it("names a channel an entry would leave with +48V and Hi-Z both on, ahead of any wiring", () => {
    const plan = defaultPlan("URX44V");
    plan.nodeParams.ch3 = { ...plan.nodeParams.ch3, hiZ: true, phantom: false };
    const both = after(plan, (p) => {
      p.nodeParams.ch3 = { ...p.nodeParams.ch3, phantom: true };
      p.connections.push({ from: ref("bus.mix1", "out"), to: MON1, kind: "source" });
    });
    expect(undoRefusal(model, plan, both, label)).toBe(t().status.undoPhantomHiZ("CH3"));
  });
});
