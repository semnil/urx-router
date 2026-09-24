import { beforeEach, describe, expect, it } from "vitest";
import { getModel } from "../models";
import { defaultPlan } from "../models/initial-state";
import type { Plan } from "./plan";
import { ensureFixedConnections } from "./plan";
import { addrKey, channelControl, planToCommands } from "./control/translate";
import { PARAMS } from "./control/params";
import { clonePlanState, nodeParamContestKey } from "./plan-history";
import {
  carrierOf,
  channelGainRange,
  hiZPatch,
  inputOnRefused,
  onExcludedBy,
  phantomHiZBothOn,
  phantomHiZNewlyBothOn,
  readRefusedSwitches,
  unsentRefusedSwitches,
} from "./input-lock";
import type { SwitchSession } from "./input-lock";
import { gainToVd } from "./control/vd";
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

  it("names the channels a change would turn the second switch on for, and no others", () => {
    const after = (over: Record<string, unknown>): Plan => {
      const next = structuredClone(plan);
      next.nodeParams.ch3 = { ...next.nodeParams.ch3, ...over };
      return next;
    };
    // HI-Z on, +48V going on — and the same the other way round.
    plan.nodeParams.ch3 = { ...plan.nodeParams.ch3, hiZ: true, phantom: false };
    expect(phantomHiZNewlyBothOn(model, plan, after({ phantom: true }))).toEqual(["ch3"]);
    plan.nodeParams.ch3 = { ...plan.nodeParams.ch3, hiZ: false, phantom: true };
    expect(phantomHiZNewlyBothOn(model, plan, after({ hiZ: true }))).toEqual(["ch3"]);

    // A device read's both-on channel is not one: it holds both already, so a change that
    // leaves it alone — and one that moves something else on the same channel — is not the
    // app turning anything on.
    plan.nodeParams.ch3 = { ...plan.nodeParams.ch3, hiZ: true, phantom: true };
    expect(phantomHiZNewlyBothOn(model, plan, after({}))).toEqual([]);
    expect(phantomHiZNewlyBothOn(model, plan, after({ gain: 12 }))).toEqual([]);
    // …and turning either of the two off is never named.
    expect(phantomHiZNewlyBothOn(model, plan, after({ phantom: false }))).toEqual([]);
    expect(phantomHiZNewlyBothOn(model, plan, after({ hiZ: false }))).toEqual([]);

    // A channel with no HI-Z switch carries the key without carrying the rule.
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, hiZ: true, phantom: false };
    const withCh1 = structuredClone(plan);
    withCh1.nodeParams.ch1 = { ...withCh1.nodeParams.ch1, phantom: true };
    expect(phantomHiZNewlyBothOn(model, plan, withCh1)).toEqual([]);
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

// Where a device read lands and where a flush sends, the same rule is asked of what the unit
// holds rather than of what the plan held when a surface took the edit.
describe("+48V and HI-Z against what the unit holds", () => {
  const unitWith = (ch3: Record<string, unknown>): Plan => {
    const unit = clonePlanState(plan);
    unit.nodeParams.ch3 = { ...unit.nodeParams.ch3, ...ch3 };
    return unit;
  };
  const planWith = (ch3: Record<string, unknown>): Plan => {
    plan.nodeParams.ch3 = { ...plan.nodeParams.ch3, ...ch3 };
    return plan;
  };

  it("names the switch the plan turned on over the one the unit holds on", () => {
    expect(
      readRefusedSwitches(unitWith({ phantom: false, hiZ: true }), planWith({ phantom: true, hiZ: true })),
    ).toEqual([{ nodeId: "ch3", key: "phantom" }]);
    expect(
      readRefusedSwitches(unitWith({ phantom: true, hiZ: false }), planWith({ phantom: true, hiZ: true })),
    ).toEqual([{ nodeId: "ch3", key: "hiZ" }]);
  });

  it("names nothing where the unit holds both on, or where the plan does not hold both", () => {
    expect(readRefusedSwitches(unitWith({ phantom: true, hiZ: true }), planWith({ phantom: true, hiZ: true }))).toEqual(
      [],
    );
    expect(
      readRefusedSwitches(unitWith({ phantom: false, hiZ: true }), planWith({ phantom: false, hiZ: true })),
    ).toEqual([]);
    // A channel with no HI-Z switch holds nothing the rule is about.
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, phantom: true, hiZ: true };
    expect(readRefusedSwitches(clonePlanState(defaultPlan("URX44V")), plan)).toEqual([]);
  });

  // An ON the live session sent after the read sampled the address is on the unit whatever the
  // read found there, so the unit holds both and the state is taken as it is.
  it("names nothing the unit is known to hold on beyond what the read found", () => {
    const sent = (nodeId: string, key: string): boolean => nodeId === "ch3" && key === "phantom";
    expect(
      readRefusedSwitches(unitWith({ phantom: false, hiZ: true }), planWith({ phantom: true, hiZ: true }), sent),
    ).toEqual([]);
    // Asked per switch: the one the session did not send is still refused.
    expect(
      readRefusedSwitches(unitWith({ phantom: true, hiZ: false }), planWith({ phantom: true, hiZ: true }), sent),
    ).toEqual([{ nodeId: "ch3", key: "hiZ" }]);
  });

  it("names the HI-Z command an A.Gain at +40 dB waits with, on the channel's own A.Gain only", () => {
    const cc = channelControl(model, "ch3")!;
    const gain = { name: "HA_GAIN" as const, paramId: cc.gain!.param, x: 0, y: cc.y };
    expect(carrierOf(gain, gainToVd(40))).toEqual({ name: "HI_Z", paramId: PARAMS.HI_Z.id, x: 0, y: cc.y });
    // Any other A.Gain is the operator's own, not the one a HI-Z ON lowered it to.
    expect(carrierOf(gain, gainToVd(30))).toBeNull();
    // A stereo channel's D.Gain shares the command name and an instance index with a mono
    // channel, and carries no HI-Z.
    const stereo = channelControl(model, "ch_5_6")!;
    for (const y of stereo.gain!.instances)
      expect(carrierOf({ name: "HA_GAIN", paramId: stereo.gain!.param, x: 0, y }, gainToVd(40))).toBeNull();
    expect(carrierOf({ name: "CLIP_SAFE", paramId: PARAMS.CLIP_SAFE.id, x: 0, y: cc.y }, 1)).toBeNull();
  });

  // An ON the plan held when a read was issued, which the session never put on the unit, is one
  // the merge writes the read's OFF over like any key nobody edited. Where the unit holds the
  // other switch on, that is a refusal, and it is named so the status line can say why.
  describe("an ON the unit never received", () => {
    const session = (sent: string[] = [], holds: string[] = []): SwitchSession => ({
      sentOn: (nodeId, key) => sent.includes(`${nodeId}.${key}`),
      holdsOn: (nodeId, key) => holds.includes(`${nodeId}.${key}`),
    });
    const before = (): Plan => {
      const p = clonePlanState(plan);
      p.nodeParams.ch3 = { ...p.nodeParams.ch3, phantom: true, hiZ: false };
      return p;
    };
    const merged = (): Plan => unitWith({ phantom: false, hiZ: true });

    it("is named where the unit holds the other switch on", () => {
      expect(unsentRefusedSwitches(before(), merged(), merged(), session(), new Set())).toEqual([
        { nodeId: "ch3", key: "phantom" },
      ]);
      // The other switch known on from the session alone.
      expect(
        unsentRefusedSwitches(
          before(),
          unitWith({ phantom: false, hiZ: false }),
          merged(),
          session([], ["ch3.hiZ"]),
          new Set(),
        ),
      ).toEqual([{ nodeId: "ch3", key: "phantom" }]);
    });

    it("is not named where the session had put it on, the operator turned it off, or the other one is off", () => {
      expect(unsentRefusedSwitches(before(), merged(), merged(), session(["ch3.phantom"]), new Set())).toEqual([]);
      expect(
        unsentRefusedSwitches(
          before(),
          merged(),
          merged(),
          session(),
          new Set([nodeParamContestKey("ch3", "phantom")]),
        ),
      ).toEqual([]);
      expect(
        unsentRefusedSwitches(
          before(),
          unitWith({ phantom: false, hiZ: false }),
          unitWith({ phantom: false, hiZ: false }),
          session(),
          new Set(),
        ),
      ).toEqual([]);
    });
  });

  it("gives the other switch's address for an ON of either, and nothing for an OFF", () => {
    const y = channelControl(model, "ch3")!.y;
    const at = (name: "PHANTOM" | "HI_Z"): { name: "PHANTOM" | "HI_Z"; x: number; y: number } => ({ name, x: 0, y });
    expect(onExcludedBy(at("PHANTOM"), 1)).toBe(addrKey(PARAMS.HI_Z.id, 0, y));
    expect(onExcludedBy(at("HI_Z"), 1)).toBe(addrKey(PARAMS.PHANTOM.id, 0, y));
    expect(onExcludedBy(at("PHANTOM"), 0)).toBeNull();
    expect(onExcludedBy({ name: "CLIP_SAFE", x: 0, y }, 1)).toBeNull();
  });
});
