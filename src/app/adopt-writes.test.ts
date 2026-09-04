import { describe, expect, it } from "vitest";
import { confirmedAdoptions } from "./adopt-writes";
import { emptyPlan, type Plan } from "../core/plan";
import { getModel } from "../models";
import { cmdAddr, planToCommands } from "../core/control/translate";
import { fxParams } from "../core/control/fx-effect";

const model = getModel("URX44V");
const lpf = fxParams(1024).find((d) => d.key === "delayLpf")!;
const diffusion = fxParams(768).find((d) => d.key === "revr3Diffusion")!;

/** FX2 on `type`, with `params` as written. */
const fx2 = (type: number, params: Record<string, number>): Plan => {
  const plan = emptyPlan("URX44V");
  plan.nodeParams["bus.fx2"] = { fxEffect: { type, params } };
  return plan;
};
/** The address the emit sends one of `bus.fx2`'s slots to. */
const addrOf = (plan: Plan, slot: number): number =>
  cmdAddr(
    planToCommands(model, plan).find((c) => c.node === "bus.fx2" && c.name === "FX_EFFECT_PARAM" && c.y === slot)!,
  );

describe("confirmedAdoptions", () => {
  it("takes a value the confirmed set carries", () => {
    const sent = fx2(1024, { delayLpf: lpf.rawMin! - 1 });
    const taken = confirmedAdoptions(model, sent, sent, new Set([addrOf(sent, lpf.slot)]));
    expect(taken.map((p) => [p.key, p.bound])).toEqual([["delayLpf", lpf.rawMin]]);
  });

  it("takes nothing when the address is not in the confirmed set", () => {
    const sent = fx2(1024, { delayLpf: lpf.rawMin! - 1 });
    expect(confirmedAdoptions(model, sent, sent, new Set([addrOf(sent, lpf.slot) + 1]))).toEqual([]);
    expect(confirmedAdoptions(model, sent, sent, new Set())).toEqual([]);
  });

  // The two plans are the same object on the write path and different on the live one, which
  // clones before its own await. Slot 10 is the delay LPF and Rev.R3's Diffusion — ONE address,
  // two keys — so resolving the join against the live plan answers with whatever type is
  // selected by the time the answer is used, which is a key the converge never sent.
  it("resolves the address against the plan the converge sent, not the live one", () => {
    expect(lpf.slot, "the case rests on the two keys sharing a slot").toBe(diffusion.slot);
    const sent = fx2(1024, { delayLpf: lpf.rawMin! - 1, revr3Diffusion: diffusion.rawMax! + 1 });
    const confirmed = new Set([addrOf(sent, lpf.slot)]);
    // The operator switched the type during the converge. The live plan carries both keys still.
    const live = fx2(768, { delayLpf: lpf.rawMin! - 1, revr3Diffusion: diffusion.rawMax! + 1 });

    expect(confirmedAdoptions(model, sent, live, confirmed).map((p) => p.key)).toEqual(["delayLpf"]);
    // Resolved against `live` instead, the same address answers with the other key — the one
    // nothing wrote — and the one that WAS written is dropped.
    expect(confirmedAdoptions(model, live, live, confirmed).map((p) => p.key)).toEqual(["revr3Diffusion"]);
  });

  // The two plans can disagree about the value as well as the type. A key that moved after the
  // write went out is one the device's confirmation is no longer about.
  it("takes nothing for a key the live plan no longer holds the sent value for", () => {
    const sent = fx2(1024, { delayLpf: lpf.rawMin! - 1 });
    const confirmed = new Set([addrOf(sent, lpf.slot)]);
    // Moved by an edit or a notify while the converge was in flight.
    expect(confirmedAdoptions(model, sent, fx2(1024, { delayLpf: lpf.rawMin! - 2 }), confirmed)).toEqual([]);
    // …including moved to a value that is inside the window, where there is no problem at all.
    expect(confirmedAdoptions(model, sent, fx2(1024, { delayLpf: lpf.rawMin! }), confirmed)).toEqual([]);
    // The positive control: unmoved, it is taken.
    expect(confirmedAdoptions(model, sent, fx2(1024, { delayLpf: lpf.rawMin! - 1 }), confirmed)).toHaveLength(1);
  });

  it("takes a drop no more than an absent key", () => {
    // A boolean under a numeric key is what the loader drops rather than bounds.
    const sent = fx2(1024, { delayLpf: false as unknown as number });
    const confirmed = new Set([addrOf(sent, lpf.slot)]);
    expect(confirmedAdoptions(model, sent, sent, confirmed)).toEqual([]);
  });

  it("takes every confirmed key, across keys and across channels", () => {
    const hpf = fxParams(1024).find((d) => d.key === "delayHpf")!;
    const revxLpf = fxParams(0).find((d) => d.key === "revxLpf")!;
    const sent = fx2(1024, { delayLpf: lpf.rawMin! - 1, delayHpf: hpf.rawMin! - 1 });
    sent.nodeParams["bus.fx1"] = { fxEffect: { type: 0, params: { revxLpf: revxLpf.rawMin! - 1 } } };
    const fx1Addr = cmdAddr(
      planToCommands(model, sent).find(
        (c) => c.node === "bus.fx1" && c.name === "FX_EFFECT_PARAM" && c.y === revxLpf.slot,
      )!,
    );
    const confirmed = new Set([addrOf(sent, lpf.slot), addrOf(sent, hpf.slot), fx1Addr]);
    expect(
      confirmedAdoptions(model, sent, sent, confirmed)
        .map((p) => `${p.node}/${p.key}`)
        .sort(),
    ).toEqual(["bus.fx1/revxLpf", "bus.fx2/delayHpf", "bus.fx2/delayLpf"]);
  });
});
