import { describe, expect, it } from "vitest";
import {
  EQ_TYPE_GEQ,
  EQ_TYPE_PEQ,
  flattenGeqSide,
  GEQ_BAND_COUNT,
  GEQ_LINK_L_TO_R,
  GEQ_LINK_OFF,
  GEQ_LINK_R_TO_L,
  GEQ_MAX_ACTIVE,
  geqBandMovable,
  geqClamp,
  geqFactory,
  geqLink,
  geqOffAtRate,
  geqSideState,
  setEqType,
  setGeqGain,
  setGeqLimit,
  setGeqLink,
  setGeqOn,
} from "./geq";
import type { NodeParams } from "./plan";
import { defaultPlan } from "../models/initial-state";

/** A bus holding the given gains on each side (an index → dB map), the given limits and link. */
function bus(
  nodeId: string,
  l: Record<number, number> = {},
  r: Record<number, number> = {},
  opts: { link?: number; limits?: [number, number] } = {},
): NodeParams {
  const f = geqFactory(nodeId);
  const fill = (side: number, gains: Record<number, number>) => ({
    on: true,
    limit: opts.limits?.[side] ?? 0,
    bands: Array.from({ length: GEQ_BAND_COUNT }, (_, x) => ({ gain: gains[x] ?? 0 })),
  });
  return { eqType: EQ_TYPE_GEQ, eqOn: true, geq: { link: opts.link ?? f.link, sides: [fill(0, l), fill(1, r)] } };
}
const gains = (np: NodeParams | null, side: number): number[] => geqSideState(np ?? undefined, side).gains;
const twelve = Object.fromEntries(Array.from({ length: GEQ_MAX_ACTIVE }, (_, x) => [x, -0.5]));

describe("geqClamp", () => {
  it("pulls a gain into the limit's range and onto 0.5 dB steps", () => {
    expect(geqClamp(10, 2)).toBe(6);
    expect(geqClamp(-10, 2)).toBe(-6);
    expect(geqClamp(6, 3), "-24 dB allows no boost").toBe(0);
    expect(geqClamp(-24, 3)).toBe(-24);
    expect(geqClamp(-24, 0)).toBe(-15);
    expect(geqClamp(0.3, 0)).toBe(0.5);
    expect(Object.is(geqClamp(-0.2, 0), 0), "never -0").toBe(true);
  });
});

describe("a document that names less", () => {
  it("reads a side, a link and a limit it does not carry as the unit's factory values", () => {
    expect(geqSideState(undefined, 1)).toEqual({ on: true, limit: 0, gains: Array(GEQ_BAND_COUNT).fill(0) });
    expect(geqSideState({ geq: { sides: [{ bands: [{ gain: -2 }] }] } }, 0).gains.slice(0, 2)).toEqual([-2, 0]);
    expect(geqLink(undefined, "bus.mix2")).toBe(GEQ_LINK_L_TO_R);
    expect(geqLink(undefined, "ch1"), "not a GEQ bus").toBe(GEQ_LINK_OFF);
    expect(geqClamp(20, 9), "a limit off the menu clamps as ±15 dB").toBe(15);
  });
});

describe("the factory GEQ", () => {
  it("is off on STEREO and L → R on a MIX, both sides on, ±15 dB, 31 bands at 0", () => {
    expect(geqFactory("bus.stereo").link).toBe(GEQ_LINK_OFF);
    expect(geqFactory("bus.mix1").link).toBe(GEQ_LINK_L_TO_R);
    expect(geqFactory("bus.mix2").link).toBe(GEQ_LINK_L_TO_R);
    const s = geqFactory("bus.mix1").sides!;
    expect(s.map((x) => [x.on, x.limit, x.bands!.length, x.bands!.every((b) => b.gain === 0)])).toEqual([
      [true, 0, 31, true],
      [true, 0, 31, true],
    ]);
  });

  it("is what a new plan holds on all three buses", () => {
    const p = defaultPlan("URX44V");
    for (const id of ["bus.stereo", "bus.mix1", "bus.mix2"]) {
      expect(p.nodeParams[id]?.eqType, id).toBe(EQ_TYPE_PEQ);
      expect(p.nodeParams[id]?.geq, id).toEqual(geqFactory(id));
    }
  });
});

describe("setGeqGain", () => {
  it("sets the band inside the side's limit, and leaves the other side alone while unlinked", () => {
    const np = setGeqGain(bus("bus.stereo", {}, {}, { limits: [2, 0] }), "bus.stereo", 0, 17, 10);
    expect(gains(np, 0)[17]).toBe(6);
    expect(gains(np, 1)[17]).toBe(0);
  });

  it("writes the other side too while the link is on", () => {
    const np = setGeqGain(bus("bus.mix1", {}, {}, { link: GEQ_LINK_L_TO_R }), "bus.mix1", 0, 7, -3);
    expect([gains(np, 0)[7], gains(np, 1)[7]]).toEqual([-3, -3]);
  });

  it("moves the shown side alone where the linked side has twelve away and that band at 0 dB", () => {
    const np = bus("bus.mix1", {}, twelve, { link: GEQ_LINK_L_TO_R });
    const moved = setGeqGain(np, "bus.mix1", 0, 20, -2)!;
    expect([gains(moved, 0)[20], gains(moved, 1)[20]]).toEqual([-2, 0]);
  });

  it("refuses a band at 0 dB once twelve are away from it, and lets a used band move", () => {
    const np = bus("bus.stereo", twelve);
    expect(geqBandMovable(gains(np, 0), 20)).toBe(false);
    expect(setGeqGain(np, "bus.stereo", 0, 20, 1)).toBeNull();
    expect(gains(setGeqGain(np, "bus.stereo", 0, 3, 2), 0)[3]).toBe(2);
    const freed = setGeqGain(np, "bus.stereo", 0, 3, 0)!;
    expect(geqBandMovable(gains(freed, 0), 20), "returning one to 0 dB frees a band").toBe(true);
  });
});

describe("setGeqLimit", () => {
  it("clamps that side's bands, and does not restore them when widened again", () => {
    const narrowed = setGeqLimit(bus("bus.stereo", { 7: -10, 17: 10 }), "bus.stereo", 0, 2);
    expect([gains(narrowed, 0)[7], gains(narrowed, 0)[17]]).toEqual([-6, 6]);
    const widened = setGeqLimit(narrowed, "bus.stereo", 0, 0);
    expect([gains(widened, 0)[7], gains(widened, 0)[17]]).toEqual([-6, 6]);
  });

  it("at -24 dB takes every boost to 0 and keeps the cuts", () => {
    const np = setGeqLimit(bus("bus.mix2", { 7: -6, 17: 6 }, {}, { link: GEQ_LINK_OFF }), "bus.mix2", 0, 3);
    expect([gains(np, 0)[7], gains(np, 0)[17]]).toEqual([-6, 0]);
  });

  it("moves the other side's limit too while linked", () => {
    const np = setGeqLimit(bus("bus.mix1", { 7: -15 }, { 7: -15 }, { link: GEQ_LINK_L_TO_R }), "bus.mix1", 0, 1);
    expect(geqSideState(np, 1).limit).toBe(1);
    expect([gains(np, 0)[7], gains(np, 1)[7]]).toEqual([-12, -12]);
  });
});

describe("setGeqLink", () => {
  it("copies the source side's bands and limit when it turns on", () => {
    const np = setGeqLink(bus("bus.stereo", { 7: -15 }, { 17: 3 }, { limits: [1, 0] }), "bus.stereo", GEQ_LINK_L_TO_R);
    expect(gains(np, 1)[7]).toBe(-15);
    expect(gains(np, 1)[17]).toBe(0);
    expect(geqSideState(np, 1).limit).toBe(1);
    const back = setGeqLink(bus("bus.stereo", { 7: -15 }, { 17: 3 }), "bus.stereo", GEQ_LINK_R_TO_L);
    expect([gains(back, 0)[7], gains(back, 0)[17]]).toEqual([0, 3]);
  });

  it("keeps both sides as they are when it turns off", () => {
    const np = setGeqLink(bus("bus.mix1", { 7: -12 }, { 7: -12 }, { link: GEQ_LINK_L_TO_R }), "bus.mix1", GEQ_LINK_OFF);
    expect([gains(np, 0)[7], gains(np, 1)[7], np.geq?.link]).toEqual([-12, -12, GEQ_LINK_OFF]);
  });
});

describe("the [GEQ] button and Gain Flat", () => {
  it("sets one side's button only", () => {
    const np = setGeqOn(bus("bus.mix1", {}, {}, { link: GEQ_LINK_L_TO_R }), "bus.mix1", 0, false);
    expect([geqSideState(np, 0).on, geqSideState(np, 1).on]).toEqual([false, true]);
  });

  it("zeroes the shown side, and the other one too while linked", () => {
    const unlinked = flattenGeqSide(bus("bus.stereo", { 7: -12, 17: 2 }, { 7: -12 }), "bus.stereo", 0);
    expect([gains(unlinked, 0).every((g) => g === 0), gains(unlinked, 1)[7]]).toEqual([true, -12]);
    const linked = flattenGeqSide(bus("bus.mix1", { 7: -3 }, { 7: -3 }, { link: GEQ_LINK_L_TO_R }), "bus.mix1", 0);
    expect(gains(linked, 1)[7]).toBe(0);
  });
});

describe("setEqType", () => {
  it("switching to Flex12GEQ turns EQ ON on, and on a MIX turns the link off", () => {
    const off: NodeParams = { eqType: EQ_TYPE_PEQ, eqOn: false, geq: geqFactory("bus.mix1") };
    const mix = setEqType(off, "bus.mix1", EQ_TYPE_GEQ);
    expect([mix.eqType, mix.eqOn, mix.geq?.link]).toEqual([EQ_TYPE_GEQ, true, GEQ_LINK_OFF]);
    const st = setEqType(
      { ...off, geq: { ...geqFactory("bus.stereo"), link: GEQ_LINK_R_TO_L } },
      "bus.stereo",
      EQ_TYPE_GEQ,
    );
    expect([st.eqOn, st.geq?.link], "STEREO's link is left as it was").toEqual([true, GEQ_LINK_R_TO_L]);
  });

  it("switching back to 4band PEQ changes only the type", () => {
    const np = setEqType(bus("bus.mix1", { 7: -3 }), "bus.mix1", EQ_TYPE_PEQ);
    expect([np.eqType, np.eqOn, gains(np, 0)[7]]).toEqual([EQ_TYPE_PEQ, true, -3]);
  });
});

describe("geqOffAtRate", () => {
  it("above 48 kHz puts each bus on Flex12GEQ back to 4band PEQ with every band at 0, and names it", () => {
    const p = defaultPlan("URX44V");
    p.nodeParams["bus.stereo"] = { ...p.nodeParams["bus.stereo"], ...bus("bus.stereo", { 17: 2 }, { 3: -1 }) };
    p.nodeParams["bus.mix1"] = { ...p.nodeParams["bus.mix1"], eqType: EQ_TYPE_PEQ };
    expect(geqOffAtRate(p, 88_200)).toEqual(["bus.stereo"]);
    expect(p.nodeParams["bus.stereo"]?.eqType).toBe(EQ_TYPE_PEQ);
    expect(
      [...gains(p.nodeParams["bus.stereo"]!, 0), ...gains(p.nodeParams["bus.stereo"]!, 1)].every((g) => g === 0),
    ).toBe(true);
  });

  it("changes nothing at 48 kHz", () => {
    const p = defaultPlan("URX44V");
    p.nodeParams["bus.mix2"] = { ...p.nodeParams["bus.mix2"], ...bus("bus.mix2", { 17: 2 }) };
    expect(geqOffAtRate(p, 48_000)).toEqual([]);
    expect(p.nodeParams["bus.mix2"]?.eqType).toBe(EQ_TYPE_GEQ);
  });
});
