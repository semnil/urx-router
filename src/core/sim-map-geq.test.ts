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

/** The edit one press makes, writing each path in the order given, as the view hands them over. */
function press(plan: Plan, values: [string, number | string | boolean][], live = false) {
  const group = bindings.get(values[0]![0])!.together!;
  return group.write(plan, new Map(values), live);
}
function pressed(plan: Plan, values: [string, number | string | boolean][], live = false): Plan {
  const edit = press(plan, values, live);
  if (isRefusal(edit)) throw new Error(edit.refused);
  const node = edit as Extract<SimEdit, { kind: "node" }>;
  return { ...plan, nodeParams: { ...plan.nodeParams, [node.id]: { ...plan.nodeParams[node.id], ...node.patch } } };
}
const side = (plan: Plan, base: string, s: "l" | "r") =>
  Array.from({ length: 31 }, (_, x) => read(plan, `${base}.geq.${s}.band.${x}`));
const bandsOf = (base: string, s: "l" | "r", gains: number[]): [string, number][] =>
  gains.map((g, x) => [`${base}.geq.${s}.band.${x}`, g]);

describe("a press that writes many GEQ paths at once", () => {
  // MIX 1 L with 20 Hz to 250 Hz at +3 dB, MIX 2 L with 315 Hz to 4 kHz at -4 dB: twelve bands
  // each, and none in common.
  const low = Array.from({ length: 31 }, (_, x) => (x < 12 ? 3 : 0));
  const mid = Array.from({ length: 31 }, (_, x) => (x >= 12 && x < 24 ? -4 : 0));
  const seeded = () => {
    let plan = write(defaultPlan("URX44V"), "ch.bus.mix1.eqType", "Flex12GEQ");
    plan = write(plan, "ch.bus.mix2.eqType", "Flex12GEQ");
    plan = pressed(plan, bandsOf("ch.bus.mix1", "l", low));
    return pressed(plan, bandsOf("ch.bus.mix2", "l", mid));
  };

  it("pastes a side's bands whole, though band by band the twelve-band rule would refuse them midway", () => {
    const plan = seeded();
    expect([side(plan, "ch.bus.mix1", "l"), side(plan, "ch.bus.mix2", "l")]).toEqual([low, mid]);
    // Each way round, as Compare swaps them.
    expect(side(pressed(plan, bandsOf("ch.bus.mix2", "l", low)), "ch.bus.mix2", "l")).toEqual(low);
    expect(side(pressed(plan, bandsOf("ch.bus.mix1", "l", mid)), "ch.bus.mix1", "l")).toEqual(mid);
  });

  it("still keeps a single band from becoming the thirteenth away from 0 dB", () => {
    const plan = seeded();
    expect(press(plan, [["ch.bus.mix1.geq.l.band.20", 2]])).toEqual({ refused: "full" });
    expect(
      press(
        plan,
        bandsOf(
          "ch.bus.mix1",
          "l",
          low.map((g, x) => (x === 20 ? 2 : g)),
        ),
      ),
    ).toEqual({
      refused: "full",
    });
  });

  it("refuses the whole of a STEREO reset during Live sync, and makes it otherwise", () => {
    let plan = write(defaultPlan("URX44V"), "ch.bus.stereo.eqType", "Flex12GEQ");
    plan = pressed(plan, bandsOf("ch.bus.stereo", "l", low));
    const flat = bandsOf("ch.bus.stereo", "l", Array(31).fill(0));
    expect(press(plan, flat, true)).toEqual({ refused: "unwritable" });
    expect(side(pressed(plan, flat), "ch.bus.stereo", "l")).toEqual(Array(31).fill(0));
    // 20 Hz alone, and what the Link and the Limit move, go during Live sync too.
    expect(read(pressed(plan, [["ch.bus.stereo.geq.l.band.0", 0]], true), "ch.bus.stereo.geq.l.band.0")).toBe(0);
    const linked = pressed(plan, [["ch.bus.stereo.geq.link", "L>R"]], true);
    expect(side(linked, "ch.bus.stereo", "r")).toEqual(low);
    expect(read(pressed(plan, [["ch.bus.stereo.geq.l.limit", "±6dB"]], true), "ch.bus.stereo.geq.l.band.1")).toBe(3);
  });

  it("takes the Link before what it carries, whatever order the press wrote them in", () => {
    // A side's limit and bands written while the target is linked, with the link going off last.
    let plan = write(defaultPlan("URX44V"), "ch.bus.mix1.geq.link", "L>R");
    plan = pressed(plan, [
      ["ch.bus.mix1.geq.r.limit", "±6dB"],
      ["ch.bus.mix1.geq.l.limit", "±12dB"],
      ...bandsOf("ch.bus.mix1", "l", low),
      ["ch.bus.mix1.geq.link", "Off"],
    ]);
    expect([read(plan, "ch.bus.mix1.geq.l.limit"), read(plan, "ch.bus.mix1.geq.r.limit")]).toEqual(["±12dB", "±6dB"]);
    expect(side(plan, "ch.bus.mix1", "r")).toEqual(Array(31).fill(0));
  });
});
