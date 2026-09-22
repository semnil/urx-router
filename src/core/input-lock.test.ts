import { beforeEach, describe, expect, it } from "vitest";
import { getModel } from "../models";
import { defaultPlan } from "../models/initial-state";
import type { Plan } from "./plan";
import { ensureFixedConnections } from "./plan";
import { planToCommands } from "./control/translate";
import { channelGainRange, hiZPatch, inputOnRefused, phantomHiZBothOn } from "./input-lock";
import { applyParamRange, isRefusal, needsDecision, paramRangeProblems, planProblems } from "./plan-validate";
import { bindControl } from "./midi/controls";
import type { ControlRefusal } from "./midi/controls";
import { MidiEngine } from "./midi/engine";

const model = getModel("URX44V");
let plan: Plan;

beforeEach(() => {
  plan = defaultPlan("URX44V");
  ensureFixedConnections(model, plan);
});

describe("+48V and HI-Z on one channel", () => {
  it("refuses turning one on while the other is on, and never refuses turning one off", () => {
    plan.nodeParams.ch3 = { ...plan.nodeParams.ch3, hiZ: true, phantom: false };
    expect(inputOnRefused(model.id, "ch3", plan.nodeParams.ch3, "phantom")).toBe(true);
    expect(inputOnRefused(model.id, "ch3", plan.nodeParams.ch3, "hiZ"), "the lit one").toBe(false);
    plan.nodeParams.ch3 = { ...plan.nodeParams.ch3, hiZ: false, phantom: true };
    expect(inputOnRefused(model.id, "ch3", plan.nodeParams.ch3, "hiZ")).toBe(true);
    expect(inputOnRefused(model.id, "ch3", plan.nodeParams.ch3, "phantom"), "the lit one").toBe(false);
    // Both on (a device read): either can be turned off, and neither is off to be refused.
    plan.nodeParams.ch3 = { ...plan.nodeParams.ch3, hiZ: true, phantom: true };
    expect(inputOnRefused(model.id, "ch3", plan.nodeParams.ch3, "phantom")).toBe(false);
    expect(inputOnRefused(model.id, "ch3", plan.nodeParams.ch3, "hiZ")).toBe(false);
    // A channel with no HI-Z switch is not constrained by a key it does not have.
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, hiZ: true, phantom: false };
    expect(inputOnRefused(model.id, "ch1", plan.nodeParams.ch1, "phantom")).toBe(false);
  });

  it("narrows A.Gain to -8..+40 dB while HI-Z is on", () => {
    expect(channelGainRange(model, "ch3", { hiZ: true })).toEqual({ minDb: -8, maxDb: 40 });
    expect(channelGainRange(model, "ch3", { hiZ: false })).toEqual({ minDb: -8, maxDb: 70 });
    expect(channelGainRange(model, "ch1", { hiZ: true }), "no HI-Z on CH 1").toEqual({ minDb: -8, maxDb: 70 });
    expect(channelGainRange(model, "ch_5_6", { hiZ: true }), "D.Gain").toEqual({ minDb: -24, maxDb: 24 });
  });

  it("lowers A.Gain to +40 dB in the edit that turns HI-Z on, and leaves it alone otherwise", () => {
    expect(hiZPatch({ gain: 60 }, true)).toEqual({ hiZ: true, gain: 40 });
    expect(hiZPatch({ gain: 40 }, true)).toEqual({ hiZ: true });
    expect(hiZPatch({ gain: 60 }, false)).toEqual({ hiZ: false });
    expect(hiZPatch(undefined, true)).toEqual({ hiZ: true });
  });

  it("names the channels a plan holds with both on", () => {
    plan.nodeParams.ch3 = { ...plan.nodeParams.ch3, hiZ: true, phantom: true };
    plan.nodeParams.ch4 = { ...plan.nodeParams.ch4, hiZ: true, phantom: false };
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, hiZ: true, phantom: true };
    expect(phantomHiZBothOn(model, plan)).toEqual(["ch3"]);
  });
});

describe("the write order around HI-Z", () => {
  const order = (np: Plan["nodeParams"][string]): string[] => {
    plan.nodeParams.ch3 = { ...plan.nodeParams.ch3, ...np };
    return planToCommands(model, plan)
      .filter((c) => c.y === 2 && ["HI_Z", "PHANTOM", "HA_GAIN"].includes(c.name))
      .map((c) => c.name);
  };

  it("writes HI-Z ahead of A.Gain", () => {
    const names = order({ hiZ: true, phantom: false, gain: 30 });
    expect(names.indexOf("HI_Z")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("HI_Z")).toBeLessThan(names.indexOf("HA_GAIN"));
    const off = order({ hiZ: false, phantom: false, gain: 60 });
    expect(off.indexOf("HI_Z")).toBeLessThan(off.indexOf("HA_GAIN"));
  });

  it("writes whichever of +48V / HI-Z the plan holds off first", () => {
    expect(order({ hiZ: true, phantom: false }).filter((n) => n !== "HA_GAIN")).toEqual(["PHANTOM", "HI_Z"]);
    expect(order({ hiZ: false, phantom: true }).filter((n) => n !== "HA_GAIN")).toEqual(["HI_Z", "PHANTOM"]);
  });
});

describe("opening a document with HI-Z on", () => {
  it("turns +48V off and bounds A.Gain to +40 dB, reported rather than refused", () => {
    plan.nodeParams.ch3 = { ...plan.nodeParams.ch3, hiZ: true, phantom: true, gain: 60 };
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, hiZ: true, phantom: true, gain: 70 };
    const found = paramRangeProblems(plan).filter((p) => p.where === "node");
    expect(found.map((p) => [p.node, p.key, p.action, p.bound])).toEqual([
      ["ch3", "phantom", "bound", false],
      ["ch3", "gain", "bound", 40],
    ]);
    const all = planProblems(model, plan).filter((p) => p.reason === "paramRange" && p.where === "node");
    expect(all.some(isRefusal) || all.some(needsDecision)).toBe(false);
    applyParamRange(plan, found);
    expect(plan.nodeParams.ch3).toMatchObject({ hiZ: true, phantom: false, gain: 40 });
    expect(plan.nodeParams.ch1, "no HI-Z on CH 1").toMatchObject({ hiZ: true, phantom: true, gain: 70 });
  });
});

describe("MIDI under HI-Z", () => {
  const press = (control: string, value: number): ControlRefusal[] => {
    const declined: ControlRefusal[] = [];
    const engine = new MidiEngine({
      resolve: (cid) => bindControl(model, plan, cid),
      gate: () => null,
      declined: (_c, why) => declined.push(why),
      applied: () => {},
      send: () => {},
      learned: () => {},
      learnPending: () => {},
      now: () => 0,
    });
    engine.setMappings([
      { control, addr: { type: "cc", channel: 0, controller: 9 }, mode: "absolute", button: "state" },
    ]);
    engine.onMessage([0xb0, 9, value]);
    return declined;
  };

  it("refuses turning +48V on under HI-Z and reports why, and lets it be turned off", () => {
    plan.nodeParams.ch3 = { ...plan.nodeParams.ch3, hiZ: true, phantom: false };
    expect(press("ch3/phantom", 127)).toEqual(["phantomUnderHiZ"]);
    expect(plan.nodeParams.ch3?.phantom, "nothing was edited").toBe(false);
    plan.nodeParams.ch3 = { ...plan.nodeParams.ch3, hiZ: false, phantom: true };
    expect(press("ch3/hiZ", 127)).toEqual(["hiZUnderPhantom"]);
    expect(plan.nodeParams.ch3?.hiZ).toBe(false);
    plan.nodeParams.ch3 = { ...plan.nodeParams.ch3, hiZ: true, phantom: true };
    expect(press("ch3/phantom", 0)).toEqual([]);
    expect(plan.nodeParams.ch3?.phantom).toBe(false);
  });

  it("lowers A.Gain with a HI-Z write, and maps the gain's full throw to -8..+40 dB while HI-Z is on", () => {
    plan.nodeParams.ch3 = { ...plan.nodeParams.ch3, hiZ: false, phantom: false, gain: 60 };
    expect(press("ch3/hiZ", 127)).toEqual([]);
    expect(plan.nodeParams.ch3).toMatchObject({ hiZ: true, gain: 40 });
    const gain = bindControl(model, plan, "ch3/gain")!;
    expect(gain.get(), "+40 is the top of the throw").toBe(1);
    gain.set(1);
    expect(plan.nodeParams.ch3?.gain).toBe(40);
    // Turning HI-Z off moves the same value to a different position, which is what the
    // feedback pass re-sends.
    plan.nodeParams.ch3!.hiZ = false;
    expect(gain.get()).toBeCloseTo(48 / 78, 6);
    gain.set(1);
    expect(plan.nodeParams.ch3?.gain).toBe(70);
  });
});
