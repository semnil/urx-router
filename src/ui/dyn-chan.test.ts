// @vitest-environment jsdom

// What a channel tuning screen's level lanes read on a MONO IN pair whose Signal Type is
// STEREO. The unit meters such a pair as one channel — input and output are two bars each,
// the reduction is one, and either member opens the same screen — so every level lane on
// every one of those screens has to carry both members' addresses while every reduction
// lane carries one. The rule lives in `pairTap`; these drive the real descriptors, because
// a lane that resolves correctly in isolation is not the same as a screen that asks it.

import { beforeEach, describe, expect, it } from "vitest";

import { COMP_DYN } from "./dyn-comp";
import { EQ_DYN } from "./dyn-eq";
import { GATE_DYN } from "./dyn-gate";
import { INSFX_DYN } from "./insert-fx-screen";
import { SC_SEL, SSMCS_COMP_DYN, SSMCS_DYN, SSMCS_EQ_DYN } from "./dyn-ssmcs";
import { DUCKER_DYN } from "./dyn-ducker";
import { getModel } from "../models";
import { ref } from "../models/types";
import { defaultPlan } from "../models/initial-state";
import { setLang, t } from "../i18n";
import { COMP_EQ_SSMCS, PAN_BAL_BAL, PAN_BAL_PAN } from "../core/control/params";
import type { Plan } from "../core/plan";
import type { DynCtx, DynLane, DynProcessor } from "./dyn-screen";

const ctxFor = (nodeId: string, plan: Plan, sel = 0): DynCtx => ({
  model: getModel("URX44V"),
  plan,
  nodeId,
  sel,
  m: t(),
});

/** A plan whose CH1/2 pair is Signal Type STEREO. The flag lives on the primary. */
function linkedPlan(panBal: number = PAN_BAL_BAL): Plan {
  const plan = defaultPlan("URX44V");
  plan.nodeParams["ch1"] = { ...plan.nodeParams["ch1"], stereoLink: true, panBal };
  return plan;
}

const ssmcs = (plan: Plan): Plan => {
  for (const id of ["ch1", "ch2"]) plan.nodeParams[id] = { ...plan.nodeParams[id], compEqType: COMP_EQ_SSMCS };
  return plan;
};

const withInsertFx = (plan: Plan): Plan => {
  for (const id of ["ch1", "ch2"]) plan.nodeParams[id] = { ...plan.nodeParams[id], insertFx: 256, insertFxOn: true };
  return plan;
};

const laneOf = (proc: DynProcessor, ctx: DynCtx, key: string): DynLane => {
  const lane = proc.bind(ctx)?.lanes.find((l) => l.key === key);
  if (!lane) throw new Error(`${proc.key} has no lane "${key}"`);
  return lane;
};

/** The addresses a lane draws bars from — one entry per bar. */
const sides = (lane: DynLane): Array<readonly [number, number]> =>
  lane.tap ? (lane.tap.r ? [lane.tap.l, lane.tap.r] : [lane.tap.l]) : [];

beforeEach(() => {
  setLang("en");
});

describe("an unlinked MONO IN channel", () => {
  it("draws one bar per level lane", () => {
    const plan = defaultPlan("URX44V");
    expect(sides(laneOf(GATE_DYN, ctxFor("ch1", plan), "in"))).toEqual([[106, 0]]);
    expect(sides(laneOf(GATE_DYN, ctxFor("ch1", plan), "out"))).toEqual([[108, 0]]);
    expect(sides(laneOf(GATE_DYN, ctxFor("ch2", plan), "in"))).toEqual([[106, 1]]);
  });
});

describe("a MONO IN pair whose Signal Type is STEREO", () => {
  it("draws both members on the GATE screen's level lanes", () => {
    const ctx = ctxFor("ch1", linkedPlan());
    expect(sides(laneOf(GATE_DYN, ctx, "in"))).toEqual([
      [106, 0],
      [106, 1],
    ]);
    expect(sides(laneOf(GATE_DYN, ctx, "out"))).toEqual([
      [108, 0],
      [108, 1],
    ]);
  });

  it("draws both members on the COMP screen's level lanes", () => {
    const ctx = ctxFor("ch1", linkedPlan());
    expect(sides(laneOf(COMP_DYN, ctx, "in"))).toEqual([
      [108, 0],
      [108, 1],
    ]);
    expect(sides(laneOf(COMP_DYN, ctx, "out"))).toEqual([
      [111, 0],
      [111, 1],
    ]);
  });

  it("draws both members on the EQ screen's level lanes", () => {
    const ctx = ctxFor("ch1", linkedPlan());
    expect(sides(laneOf(EQ_DYN, ctx, "in"))).toEqual([
      [111, 0],
      [111, 1],
    ]);
    expect(sides(laneOf(EQ_DYN, ctx, "out"))).toEqual([
      [112, 0],
      [112, 1],
    ]);
  });

  it("draws both members on the SSMCS bank's level lanes", () => {
    const plan = ssmcs(linkedPlan());
    for (const proc of [SSMCS_DYN, SSMCS_COMP_DYN, SSMCS_EQ_DYN]) {
      const ctx = ctxFor("ch1", plan);
      expect(sides(laneOf(proc, ctx, "in"))).toHaveLength(2);
      expect(sides(laneOf(proc, ctx, "out"))).toHaveLength(2);
    }
  });

  it("keeps the SSMCS side-chain lane at one bar, on the member the screen was opened on", () => {
    // The unit draws one bar there while the lanes around it carry two, and that bar is the
    // member the screen was opened on: with signal on the partner alone, the unit's own
    // column stays at the floor. Its two addresses hold each member's own filter output.
    const plan = ssmcs(linkedPlan());
    expect(sides(laneOf(SSMCS_COMP_DYN, ctxFor("ch1", plan, SC_SEL), "sc"))).toEqual([[109, 0]]);
    expect(sides(laneOf(SSMCS_COMP_DYN, ctxFor("ch2", plan, SC_SEL), "sc"))).toEqual([[109, 1]]);
  });

  it("draws both members on the SSMCS MAIN face's third level lane", () => {
    const plan = ssmcs(linkedPlan());
    expect(sides(laneOf(SSMCS_DYN, ctxFor("ch1", plan), "post"))).toEqual([
      [112, 0],
      [112, 1],
    ]);
  });

  it("draws both members on the INS FX screen's level lanes", () => {
    const ctx = ctxFor("ch1", withInsertFx(linkedPlan()));
    expect(sides(laneOf(INSFX_DYN, ctx, "in"))).toEqual([
      [112, 0],
      [112, 1],
    ]);
    expect(sides(laneOf(INSFX_DYN, ctx, "out"))).toEqual([
      [113, 0],
      [113, 1],
    ]);
  });

  it("reads the pair in the same order from either member", () => {
    const plan = linkedPlan();
    for (const key of ["in", "out"]) {
      expect(sides(laneOf(GATE_DYN, ctxFor("ch2", plan), key))).toEqual(
        sides(laneOf(GATE_DYN, ctxFor("ch1", plan), key)),
      );
    }
  });

  it("keeps the reduction lane at one bar, on the member the screen was opened on", () => {
    // The bar count is not the whole claim: a lane moved onto the primary's address would
    // still carry no tap and still draw one bar, so the ADDRESS is what this asks for.
    for (const [proc, meterId] of [
      [GATE_DYN, 107],
      [COMP_DYN, 110],
    ] as const) {
      for (const [id, x] of [
        ["ch1", 0],
        ["ch2", 1],
      ] as const) {
        const gr = laneOf(proc, ctxFor(id, linkedPlan()), "gr");
        expect(gr.kind).toBe("gr");
        // A reduction lane carries no tap at all, which is what holds it to one bar however
        // the level lanes beside it are drawn.
        expect(gr.tap).toBeUndefined();
        expect(gr.gr).toEqual([meterId, x]);
      }
    }
  });

  it("reads the pair in PAN mode as well as in BAL", () => {
    for (const panBal of [PAN_BAL_BAL, PAN_BAL_PAN]) {
      expect(sides(laneOf(GATE_DYN, ctxFor("ch1", linkedPlan(panBal)), "in"))).toEqual([
        [106, 0],
        [106, 1],
      ]);
    }
  });

  it("takes the second pair's own members, not the first's", () => {
    const plan = defaultPlan("URX44V");
    plan.nodeParams["ch3"] = { ...plan.nodeParams["ch3"], stereoLink: true, panBal: PAN_BAL_BAL };
    expect(sides(laneOf(GATE_DYN, ctxFor("ch3", plan), "in"))).toEqual([
      [106, 2],
      [106, 3],
    ]);
  });
});

describe("models other than the one the rule was measured on", () => {
  it("takes URX22's own pair and its own addresses", () => {
    // URX22 carries two MONO IN channels and one pair, and its tap table is its own — a
    // rule gated on the model would pass every URX44V case and reach nothing here.
    const plan = defaultPlan("URX22");
    plan.nodeParams["ch1"] = { ...plan.nodeParams["ch1"], stereoLink: true, panBal: PAN_BAL_BAL };
    const ctx: DynCtx = { model: getModel("URX22"), plan, nodeId: "ch2", sel: 0, m: t() };
    expect(sides(laneOf(GATE_DYN, ctx, "in"))).toEqual([
      [106, 0],
      [106, 1],
    ]);
  });
});

describe("the nodes a screen declares it draws", () => {
  it("names the pair, so a change on either member reaches the screen", () => {
    const plan = linkedPlan();
    for (const proc of [GATE_DYN, COMP_DYN, EQ_DYN]) {
      expect(new Set(proc.ownNodes!(ctxFor("ch2", plan)))).toEqual(new Set(["ch1", "ch2"]));
    }
  });

  it("names only itself off a pair", () => {
    expect(GATE_DYN.ownNodes!(ctxFor("ch2", defaultPlan("URX44V")))).toEqual(["ch2"]);
  });
});

describe("the DUCKER's key lane", () => {
  it("stays on the key source member, which the unit keys off alone", () => {
    // The pair's own detectors are shared, but a ducker keyed off one member fires on that
    // member's signal and not on its partner's, so this lane is not widened with the rest.
    const plan = linkedPlan();
    const conn = plan.connections.find((c) => c.kind === "key" && c.to === ref("out.ducker1", "in"))!;
    conn.from = ref("ch2", "out");
    const key = laneOf(DUCKER_DYN, ctxFor("out.ducker1", plan), "key");
    expect(sides(key)).toHaveLength(1);
    expect(key.tap!.l[1]).toBe(1);
  });
});

describe("nodes outside a MONO IN pair", () => {
  it("leaves a stereo channel's already-two-sided tap alone", () => {
    const plan = linkedPlan();
    expect(sides(laneOf(EQ_DYN, ctxFor("ch_5_6", plan), "in"))).toEqual([
      [101, 0],
      [101, 1],
    ]);
  });

  it("leaves an output bus alone", () => {
    const plan = linkedPlan();
    expect(sides(laneOf(EQ_DYN, ctxFor("bus.stereo", plan), "in"))).toEqual([
      [104, 0],
      [104, 1],
    ]);
  });
});
