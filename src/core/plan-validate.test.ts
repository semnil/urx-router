import { describe, it, expect } from "vitest";
import { insertFxSlotProblems, planProblems } from "./plan-validate";
import { validatePlan } from "./routing";
import { emptyPlan } from "./plan";
import { getModel } from "../models";
import { INSERT_FX_NONE, INSERT_FX_OPTIONS, OUTPUT_INSERT_FX_OPTIONS } from "./control/params";
import type { InsertFxOption, InsertFxSlot } from "./control/params";

// The slot facts come off the catalog rather than being listed here, so a family
// added to INSERT_FX_OPTIONS with a new slot joins these cases without an edit.
const bySlot = (options: InsertFxOption[]): Map<InsertFxSlot, InsertFxOption[]> => {
  const map = new Map<InsertFxSlot, InsertFxOption[]>();
  for (const o of options) if (o.slot) map.set(o.slot, [...(map.get(o.slot) ?? []), o]);
  return map;
};
const INPUT_SLOTS = bySlot(INSERT_FX_OPTIONS);

describe("insertFxSlotProblems", () => {
  const u44v = getModel("URX44V");

  it("reports nothing for a plan with at most one holder per slot", () => {
    const plan = emptyPlan("URX44V");
    let ch = 1;
    for (const [, options] of INPUT_SLOTS) plan.nodeParams[`ch${ch++}`] = { insertFx: options[0].value };
    plan.nodeParams["bus.stereo"] = { insertFx: OUTPUT_INSERT_FX_OPTIONS.find((o) => o.slot === "out-dyn")!.value };
    expect(insertFxSlotProblems(u44v, plan)).toEqual([]);
    expect(planProblems(u44v, plan)).toEqual([]);
  });

  it("names the contended slot and every node claiming it", () => {
    for (const [slot, options] of INPUT_SLOTS) {
      const plan = emptyPlan("URX44V");
      plan.nodeParams["ch1"] = { insertFx: options[0].value };
      plan.nodeParams["ch3"] = { insertFx: options[options.length - 1].value };
      const problems = insertFxSlotProblems(u44v, plan);
      expect(problems).toHaveLength(1);
      expect(problems[0].reason).toBe("insertFxSlot");
      expect(problems[0].slot).toBe(slot);
      expect([...problems[0].nodes].sort()).toEqual(["ch1", "ch3"]);
      // The wire validator knows nothing about slots; the loader composes the two.
      expect(validatePlan(u44v, plan)).toEqual([]);
      expect(planProblems(u44v, plan)).toEqual(problems);
    }
  });

  it("reports the output buses sharing their one slot", () => {
    const plan = emptyPlan("URX44V");
    const [a, b] = OUTPUT_INSERT_FX_OPTIONS.filter((o) => o.slot === "out-dyn");
    plan.nodeParams["bus.stereo"] = { insertFx: a.value };
    plan.nodeParams["bus.mix1"] = { insertFx: b.value };
    const problems = insertFxSlotProblems(u44v, plan);
    expect(problems).toHaveLength(1);
    expect(problems[0].slot).toBe("out-dyn");
    expect([...problems[0].nodes].sort()).toEqual(["bus.mix1", "bus.stereo"]);
  });

  it("ignores No Effect and an unset selection", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["ch1"] = { insertFx: INSERT_FX_NONE };
    plan.nodeParams["ch2"] = { insertFx: INSERT_FX_NONE };
    plan.nodeParams["ch3"] = {};
    expect(insertFxSlotProblems(u44v, plan)).toEqual([]);
  });
});
