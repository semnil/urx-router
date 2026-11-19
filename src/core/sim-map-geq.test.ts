// The SIM table's EQ Type and Flex12GEQ part: each edit reaches the plan through the GEQ
// tuning screen's helpers, with the link's mirror, the limit's clamp and the rate's ceiling.
import { describe, expect, it } from "vitest";
import { getModel } from "../models";
import { defaultPlan } from "../models/initial-state";
import { isRefusal, simBindings, type SimEdit } from "./sim-map";
import type { Plan } from "./plan";

const model = getModel("URX44V");
const bindings = simBindings(model);

/** Apply the edit an LCD write makes, as the host's funnel would. */
function write(plan: Plan, path: string, value: number | string | boolean): Plan {
  const edit = bindings.get(path)!.write!(plan, value);
  if (isRefusal(edit)) throw new Error(edit.refused);
  const node = edit as Extract<SimEdit, { kind: "node" }>;
  return { ...plan, nodeParams: { ...plan.nodeParams, [node.id]: { ...plan.nodeParams[node.id], ...node.patch } } };
}
const read = (plan: Plan, path: string) => bindings.get(path)!.read(plan);

describe("the SIM's EQ Type and Flex12GEQ", () => {
  it("switches a MIX to Flex12GEQ with EQ ON on and the link off, as the unit does", () => {
    const plan = write(defaultPlan("URX44V"), "ch.bus.mix1.eqType", "Flex12GEQ");
    expect([read(plan, "ch.bus.mix1.eqType"), read(plan, "ch.bus.mix1.geq.link")]).toEqual(["Flex12GEQ", "Off"]);
  });

  it("refuses Flex12GEQ above 48 kHz", () => {
    const plan = { ...defaultPlan("URX44V"), sampleRate: 96000 };
    expect(isRefusal(bindings.get("ch.bus.stereo.eqType")!.write!(plan, "Flex12GEQ"))).toBe(true);
  });

  it("carries a band to the other side while linked, and pulls it into the side's limit", () => {
    let plan = write(defaultPlan("URX44V"), "ch.bus.mix1.geq.link", "L>R");
    plan = write(plan, "ch.bus.mix1.geq.l.band.3", 4.2);
    expect([read(plan, "ch.bus.mix1.geq.l.band.3"), read(plan, "ch.bus.mix1.geq.r.band.3")]).toEqual([4, 4]);
    plan = write(plan, "ch.bus.mix1.geq.l.limit", "±6dB");
    expect([read(plan, "ch.bus.mix1.geq.r.limit"), read(plan, "ch.bus.mix1.geq.l.band.3")]).toEqual(["±6dB", 4]);
    plan = write(plan, "ch.bus.mix1.geq.l.band.3", 9);
    expect(read(plan, "ch.bus.mix1.geq.l.band.3")).toBe(6);
  });

  it("switches one side's [GEQ] alone", () => {
    const plan = write(defaultPlan("URX44V"), "ch.bus.stereo.geq.r.on", false);
    expect([read(plan, "ch.bus.stereo.geq.l.on"), read(plan, "ch.bus.stereo.geq.r.on")]).toEqual([true, false]);
  });
});
