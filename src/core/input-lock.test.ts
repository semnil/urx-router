import { beforeEach, describe, expect, it } from "vitest";
import { getModel } from "../models";
import { defaultPlan } from "../models/initial-state";
import type { Plan } from "./plan";
import { ensureFixedConnections, setExclusiveConnection } from "./plan";
import { addrKey, planToCommands } from "./control/translate";
import { PARAMS } from "./control/params";
import { clonePlanState, nodeParamContestKey } from "./plan-history";
import {
  carrierOf,
  hiZPatch,
  inputOnRefused,
  jackGainRange,
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
// The jacks CH 3 and CH 1 read on the factory routing: jack 3 carries HI-Z, jack 1 does not.
const J3 = { node: "in.micline_3_4", side: "L" } as const;
const J1 = { node: "in.micline_1_2", side: "L" } as const;
const set3 = (over: Record<string, unknown>): void => {
  plan.nodeParams[J3.node] = { ...plan.nodeParams[J3.node], ...over };
};
const np3 = (): Record<string, unknown> => plan.nodeParams[J3.node] as Record<string, unknown>;

beforeEach(() => {
  plan = defaultPlan("URX44V");
  ensureFixedConnections(model, plan);
});

describe("+48V and HI-Z on one jack", () => {
  it("refuses turning one on while the other is on, and never refuses turning one off", () => {
    set3({ hiZL: true, phantomL: false });
    expect(inputOnRefused(model.id, J3, np3(), "phantom")).toBe(true);
    expect(inputOnRefused(model.id, J3, np3(), "hiZ"), "the lit one").toBe(false);
    set3({ hiZL: false, phantomL: true });
    expect(inputOnRefused(model.id, J3, np3(), "hiZ")).toBe(true);
    expect(inputOnRefused(model.id, J3, np3(), "phantom"), "the lit one").toBe(false);
    // Both on (a device read): either can be turned off, and neither is off to be refused.
    set3({ hiZL: true, phantomL: true });
    expect(inputOnRefused(model.id, J3, np3(), "phantom")).toBe(false);
    expect(inputOnRefused(model.id, J3, np3(), "hiZ")).toBe(false);
    // The other jack of the same node is not constrained by this one's switches.
    expect(inputOnRefused(model.id, { ...J3, side: "R" }, np3(), "phantom")).toBe(false);
    // A jack with no HI-Z switch is not constrained by a key it does not have.
    plan.nodeParams[J1.node] = { ...plan.nodeParams[J1.node], hiZL: true, phantomL: false };
    expect(inputOnRefused(model.id, J1, plan.nodeParams[J1.node], "phantom")).toBe(false);
  });

  it("narrows a jack's A.Gain to -8..+40 dB while its HI-Z is on", () => {
    expect(jackGainRange(model.id, J3, { hiZL: true })).toEqual({ minDb: -8, maxDb: 40 });
    expect(jackGainRange(model.id, J3, { hiZL: false })).toEqual({ minDb: -8, maxDb: 70 });
    expect(jackGainRange(model.id, { ...J3, side: "R" }, { hiZL: true }), "the other jack").toEqual({
      minDb: -8,
      maxDb: 70,
    });
    expect(jackGainRange(model.id, J1, { hiZL: true }), "no HI-Z on jack 1").toEqual({ minDb: -8, maxDb: 70 });
    expect(jackGainRange(model.id, { node: "in.aux", side: "L" }, {}), "no jack on a digital source").toBeNull();
  });

  it("lowers the jack's A.Gain to +40 dB in the edit that turns its HI-Z on, and leaves it alone otherwise", () => {
    expect(hiZPatch({ gainL: 60 }, "L", true)).toEqual({ hiZL: true, gainL: 40 });
    expect(hiZPatch({ gainL: 40 }, "L", true)).toEqual({ hiZL: true });
    expect(hiZPatch({ gainL: 60 }, "L", false)).toEqual({ hiZL: false });
    expect(hiZPatch({ gainL: 60 }, "R", true), "the other jack's gain is not this one's").toEqual({ hiZR: true });
    expect(hiZPatch(undefined, "L", true)).toEqual({ hiZL: true });
  });

  it("names the jacks a change would turn the second switch on for, and no others", () => {
    const after = (over: Record<string, unknown>): Plan => {
      const next = structuredClone(plan);
      next.nodeParams[J3.node] = { ...next.nodeParams[J3.node], ...over };
      return next;
    };
    // HI-Z on, +48V going on — and the same the other way round.
    set3({ hiZL: true, phantomL: false });
    expect(phantomHiZNewlyBothOn(model, plan, after({ phantomL: true }))).toEqual([J3]);
    set3({ hiZL: false, phantomL: true });
    expect(phantomHiZNewlyBothOn(model, plan, after({ hiZL: true }))).toEqual([J3]);

    // A device read's both-on jack is not one: it holds both already, so a change that
    // leaves it alone — and one that moves something else on the same jack — is not the
    // app turning anything on.
    set3({ hiZL: true, phantomL: true });
    expect(phantomHiZNewlyBothOn(model, plan, after({}))).toEqual([]);
    expect(phantomHiZNewlyBothOn(model, plan, after({ gainL: 12 }))).toEqual([]);
    // …and turning either of the two off is never named.
    expect(phantomHiZNewlyBothOn(model, plan, after({ phantomL: false }))).toEqual([]);
    expect(phantomHiZNewlyBothOn(model, plan, after({ hiZL: false }))).toEqual([]);

    // A jack with no HI-Z switch carries the key without carrying the rule.
    plan.nodeParams[J1.node] = { ...plan.nodeParams[J1.node], hiZL: true, phantomL: false };
    const withJ1 = structuredClone(plan);
    withJ1.nodeParams[J1.node] = { ...withJ1.nodeParams[J1.node], phantomL: true };
    expect(phantomHiZNewlyBothOn(model, plan, withJ1)).toEqual([]);
  });

  it("names the jacks a plan holds with both on", () => {
    set3({ hiZL: true, phantomL: true, hiZR: true, phantomR: false });
    plan.nodeParams[J1.node] = { ...plan.nodeParams[J1.node], hiZL: true, phantomL: true };
    expect(phantomHiZBothOn(model, plan)).toEqual([J3]);
  });
});

describe("the write order around HI-Z", () => {
  const order = (np: Record<string, unknown>): string[] => {
    set3(np);
    return planToCommands(model, plan)
      .filter((c) => c.y === 2 && ["HI_Z", "PHANTOM", "HA_GAIN"].includes(c.name))
      .map((c) => c.name);
  };

  it("writes HI-Z ahead of A.Gain", () => {
    const names = order({ hiZL: true, phantomL: false, gainL: 30 });
    expect(names.indexOf("HI_Z")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("HI_Z")).toBeLessThan(names.indexOf("HA_GAIN"));
    const off = order({ hiZL: false, phantomL: false, gainL: 60 });
    expect(off.indexOf("HI_Z")).toBeLessThan(off.indexOf("HA_GAIN"));
  });

  it("writes whichever of +48V / HI-Z the plan holds off first", () => {
    expect(order({ hiZL: true, phantomL: false }).filter((n) => n !== "HA_GAIN")).toEqual(["PHANTOM", "HI_Z"]);
    expect(order({ hiZL: false, phantomL: true }).filter((n) => n !== "HA_GAIN")).toEqual(["HI_Z", "PHANTOM"]);
  });
});

describe("opening a document with HI-Z on", () => {
  it("turns that jack's +48V off and bounds its A.Gain to +40 dB, reported rather than refused", () => {
    set3({ hiZL: true, phantomL: true, gainL: 60, hiZR: false, phantomR: true, gainR: 60 });
    plan.nodeParams[J1.node] = { ...plan.nodeParams[J1.node], phantomL: true, gainL: 70 };
    const found = paramRangeProblems(plan).filter((p) => p.where === "node");
    expect(found.map((p) => [p.node, p.key, p.action, p.bound])).toEqual([
      [J3.node, "phantomL", "bound", false],
      [J3.node, "gainL", "bound", 40],
    ]);
    const all = planProblems(model, plan).filter((p) => p.reason === "paramRange" && p.where === "node");
    expect(all.some(isRefusal) || all.some(needsDecision)).toBe(false);
    applyParamRange(plan, found);
    expect(plan.nodeParams[J3.node]).toMatchObject({
      hiZL: true,
      phantomL: false,
      gainL: 40,
      phantomR: true,
      gainR: 60,
    });
    expect(plan.nodeParams[J1.node], "no HI-Z on jack 1").toMatchObject({ phantomL: true, gainL: 70 });
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
    set3({ hiZL: true, phantomL: false });
    expect(press("ch3/phantom", 127)).toEqual(["phantomUnderHiZ"]);
    expect(np3().phantomL, "nothing was edited").toBe(false);
    set3({ hiZL: false, phantomL: true });
    expect(press("ch3/hiZ", 127)).toEqual(["hiZUnderPhantom"]);
    expect(np3().hiZL).toBe(false);
    set3({ hiZL: true, phantomL: true });
    expect(press("ch3/phantom", 0)).toEqual([]);
    expect(np3().phantomL).toBe(false);
  });

  it("lowers A.Gain with a HI-Z write, and maps the gain's full throw to -8..+40 dB while HI-Z is on", () => {
    set3({ hiZL: false, phantomL: false, gainL: 60 });
    expect(press("ch3/hiZ", 127)).toEqual([]);
    expect(np3()).toMatchObject({ hiZL: true, gainL: 40 });
    const gain = bindControl(model, plan, "ch3/gain")!;
    expect(gain.get(), "+40 is the top of the throw").toBe(1);
    gain.set(1);
    expect(np3().gainL).toBe(40);
    // Turning HI-Z off moves the same value to a different position, which is what the
    // feedback pass re-sends.
    set3({ hiZL: false });
    expect(gain.get()).toBeCloseTo(48 / 78, 6);
    gain.set(1);
    expect(np3().gainL).toBe(70);
  });

  // The switch belongs to the jack, not to the channel number: CH 1 routed to MIC/LINE 3/4
  // reads jack 3 and offers its HI-Z, while CH 3 routed to MIC/LINE 1/2 offers none.
  it("follows the jack a channel reads", () => {
    for (const ch of ["ch1", "ch2"]) setExclusiveConnection(plan, "in.micline_3_4:out", `${ch}:in`, "source");
    for (const ch of ["ch3", "ch4"]) setExclusiveConnection(plan, "in.micline_1_2:out", `${ch}:in`, "source");
    expect(bindControl(model, plan, "ch1/hiZ")).not.toBeNull();
    expect(bindControl(model, plan, "ch3/hiZ")).toBeNull();
    set3({ hiZL: true, phantomL: false });
    expect(press("ch1/phantom", 127)).toEqual(["phantomUnderHiZ"]);
  });
});

// Where a device read lands and where a flush sends, the same rule is asked of what the unit
// holds rather than of what the plan held when a surface took the edit.
describe("+48V and HI-Z against what the unit holds", () => {
  const unitWith = (jack3: Record<string, unknown>): Plan => {
    const unit = clonePlanState(plan);
    unit.nodeParams[J3.node] = { ...unit.nodeParams[J3.node], ...jack3 };
    return unit;
  };
  const planWith = (jack3: Record<string, unknown>): Plan => {
    set3(jack3);
    return plan;
  };

  it("names the switch the plan turned on over the one the unit holds on", () => {
    expect(
      readRefusedSwitches(unitWith({ phantomL: false, hiZL: true }), planWith({ phantomL: true, hiZL: true })),
    ).toEqual([{ nodeId: J3.node, key: "phantomL" }]);
    expect(
      readRefusedSwitches(unitWith({ phantomL: true, hiZL: false }), planWith({ phantomL: true, hiZL: true })),
    ).toEqual([{ nodeId: J3.node, key: "hiZL" }]);
  });

  it("names nothing where the unit holds both on, or where the plan does not hold both", () => {
    expect(
      readRefusedSwitches(unitWith({ phantomL: true, hiZL: true }), planWith({ phantomL: true, hiZL: true })),
    ).toEqual([]);
    expect(
      readRefusedSwitches(unitWith({ phantomL: false, hiZL: true }), planWith({ phantomL: false, hiZL: true })),
    ).toEqual([]);
    // A jack with no HI-Z switch holds nothing the rule is about.
    plan.nodeParams[J1.node] = { ...plan.nodeParams[J1.node], phantomL: true, hiZL: true };
    expect(readRefusedSwitches(clonePlanState(defaultPlan("URX44V")), plan)).toEqual([]);
  });

  // An ON the live session sent after the read sampled the address is on the unit whatever the
  // read found there, so the unit holds both and the state is taken as it is.
  it("names nothing the unit is known to hold on beyond what the read found", () => {
    const sent = (nodeId: string, key: string): boolean => nodeId === J3.node && key === "phantomL";
    expect(
      readRefusedSwitches(unitWith({ phantomL: false, hiZL: true }), planWith({ phantomL: true, hiZL: true }), sent),
    ).toEqual([]);
    // Asked per switch: the one the session did not send is still refused.
    expect(
      readRefusedSwitches(unitWith({ phantomL: true, hiZL: false }), planWith({ phantomL: true, hiZL: true }), sent),
    ).toEqual([{ nodeId: J3.node, key: "hiZL" }]);
  });

  // The same rule from the other switch: the session sent HI-Z ON and the read found +48V on.
  it("names nothing the unit is known to hold on, whichever switch the session sent", () => {
    const sent = (nodeId: string, key: string): boolean => nodeId === J3.node && key === "hiZL";
    expect(
      readRefusedSwitches(unitWith({ phantomL: true, hiZL: false }), planWith({ phantomL: true, hiZL: true }), sent),
    ).toEqual([]);
    expect(
      readRefusedSwitches(unitWith({ phantomL: false, hiZL: true }), planWith({ phantomL: true, hiZL: true }), sent),
    ).toEqual([{ nodeId: J3.node, key: "phantomL" }]);
  });

  it("names the HI-Z command an A.Gain at +40 dB waits with, on the jack's own A.Gain only", () => {
    const y = 2;
    const gain = { name: "HA_GAIN" as const, paramId: PARAMS.HA_GAIN.id, x: 0, y };
    expect(carrierOf(gain, gainToVd(40))).toEqual({ name: "HI_Z", paramId: PARAMS.HI_Z.id, x: 0, y });
    // Any other A.Gain is the operator's own, not the one a HI-Z ON lowered it to.
    expect(carrierOf(gain, gainToVd(30))).toBeNull();
    // A source's D.Gain goes out at instance indexes a jack also uses, and carries no HI-Z.
    for (const y of [0, 1])
      expect(carrierOf({ name: "D_GAIN", paramId: PARAMS.D_GAIN.id, x: 0, y }, gainToVd(40))).toBeNull();
    expect(carrierOf({ name: "CLIP_SAFE", paramId: PARAMS.CLIP_SAFE.id, x: 0, y }, 1)).toBeNull();
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
      p.nodeParams[J3.node] = { ...p.nodeParams[J3.node], phantomL: true, hiZL: false };
      return p;
    };
    const merged = (): Plan => unitWith({ phantomL: false, hiZL: true });

    it("is named where the unit holds the other switch on", () => {
      expect(unsentRefusedSwitches(before(), merged(), merged(), session(), new Set())).toEqual([
        { nodeId: J3.node, key: "phantomL" },
      ]);
      // The other switch known on from the session alone.
      expect(
        unsentRefusedSwitches(
          before(),
          unitWith({ phantomL: false, hiZL: false }),
          merged(),
          session([], [`${J3.node}.hiZL`]),
          new Set(),
        ),
      ).toEqual([{ nodeId: J3.node, key: "phantomL" }]);
    });

    it("is not named where the session had put it on, the operator turned it off, or the other one is off", () => {
      expect(unsentRefusedSwitches(before(), merged(), merged(), session([`${J3.node}.phantomL`]), new Set())).toEqual(
        [],
      );
      expect(
        unsentRefusedSwitches(
          before(),
          merged(),
          merged(),
          session(),
          new Set([nodeParamContestKey(J3.node, "phantomL")]),
        ),
      ).toEqual([]);
      expect(
        unsentRefusedSwitches(
          before(),
          unitWith({ phantomL: false, hiZL: false }),
          unitWith({ phantomL: false, hiZL: false }),
          session(),
          new Set(),
        ),
      ).toEqual([]);
    });
  });

  it("gives the other switch's address for an ON of either, and nothing for an OFF", () => {
    const y = 2;
    const at = (name: "PHANTOM" | "HI_Z"): { name: "PHANTOM" | "HI_Z"; x: number; y: number } => ({ name, x: 0, y });
    expect(onExcludedBy(at("PHANTOM"), 1)).toBe(addrKey(PARAMS.HI_Z.id, 0, y));
    expect(onExcludedBy(at("HI_Z"), 1)).toBe(addrKey(PARAMS.PHANTOM.id, 0, y));
    expect(onExcludedBy(at("PHANTOM"), 0)).toBeNull();
    expect(onExcludedBy({ name: "CLIP_SAFE", x: 0, y }, 1)).toBeNull();
  });
});
