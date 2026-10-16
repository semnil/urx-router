import { describe, expect, it } from "vitest";
import { getModel } from "../models";
import { defaultPlan } from "../models/initial-state";
import type { ModelId } from "../models/types";
import type { Plan } from "./plan";
import {
  insertFxParamKey,
  parkOutgoingInsertFxParams,
  reKeyInsertFxParams,
  seedInsertFxParams,
} from "./control/insert-fx-effect";
import { isRefusal, simBindings, type SimBinding, type SimEdit, type SimValue } from "./sim-map";

const MODELS: ModelId[] = ["URX22", "URX44", "URX44V"];

function binding(bindings: Map<string, SimBinding>, path: string): SimBinding {
  const b = bindings.get(path);
  if (!b) throw new Error(`no binding at ${path}`);
  return b;
}

/** The edit a write produces, failing the case on a refusal. */
function edit(b: SimBinding, plan: Plan, v: SimValue): SimEdit {
  const e = b.write!(plan, v);
  if (isRefusal(e)) throw new Error(`refused: ${e.refused}`);
  return e;
}

/** The node patch a write produces. */
function patchOf(b: SimBinding, plan: Plan, v: SimValue): Record<string, unknown> {
  const e = edit(b, plan, v);
  if (e.kind !== "node") throw new Error(`a ${e.kind} edit`);
  return e.patch as Record<string, unknown>;
}

const refusal = (b: SimBinding, plan: Plan, v: SimValue): string | null => {
  const e = b.write!(plan, v);
  return isRefusal(e) ? e.refused : null;
};

describe("SSMCS, which the plan holds as raw values", () => {
  const bindings = simBindings(getModel("URX44V"));
  const at = (path: string) => binding(bindings, `ch.ch1.ssmcs.${path}`);
  const withSsmcs = (ssmcs: object): Plan => {
    const plan = defaultPlan("URX44V");
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, ssmcs };
    return plan;
  };

  it("reads a frequency on the simulator's R40 stops, not on the app's geometric law", () => {
    const freq = at("eq.mid.freq");
    expect(freq.read(withSsmcs({ eq: { mid: { freq: 4 } } }))).toBe(20);
    expect(freq.read(withSsmcs({ eq: { mid: { freq: 30 } } }))).toBe(90);
    expect(freq.read(withSsmcs({ eq: { mid: { freq: 32 } } }))).toBe(100);
    expect(freq.read(withSsmcs({ eq: { mid: { freq: 124 } } }))).toBe(20000);
    expect(patchOf(freq, withSsmcs({}), 90)).toEqual({ ssmcs: { eq: { mid: { freq: 30 } } } });
    expect(refusal(freq, withSsmcs({}), 89.34), "the app's formula value is no stop").toBe("value");
  });

  it("keeps each shelf on its own frequency window", () => {
    const plan = withSsmcs({});
    expect(patchOf(at("eq.low.freq"), plan, 1000)).toEqual({ ssmcs: { eq: { low: { freq: 72 } } } });
    expect(refusal(at("eq.low.freq"), plan, 1060)).toBe("value");
    expect(patchOf(at("eq.high.freq"), plan, 500)).toEqual({ ssmcs: { eq: { high: { freq: 60 } } } });
    expect(refusal(at("eq.high.freq"), plan, 475)).toBe("value");
  });

  it("reads gains, drive, ratio, Q and the times at their table ends and a middle stop", () => {
    const plan = withSsmcs({
      outGain: 0,
      compDrive: 200,
      sc: { gain: 133, q: 12 },
      eq: { low: { gain: 360 }, mid: { q: 60 } },
      comp: { ratio: 120, attack: 57, release: 300 },
    });
    expect(at("outGain").read(plan)).toBe(-18);
    expect(at("eq.low.gain").read(plan)).toBe(18);
    expect(at("sc.gain").read(plan)).toBe(-4.7);
    expect(at("compDrive").read(plan)).toBe(10);
    expect(at("comp.ratio").read(plan)).toBe(Infinity);
    expect(at("sc.q").read(plan)).toBe(1);
    expect(at("eq.mid.q").read(plan)).toBe(16);
    expect(at("comp.attack").read(plan)).toBe(0.092);
    expect(at("comp.release").read(plan)).toBe(999);
    expect(at("comp.ratio").read(withSsmcs({ comp: { ratio: 0 } }))).toBe(1);
    expect(at("comp.attack").read(withSsmcs({ comp: { attack: 283 } }))).toBe(80);
    expect(at("comp.release").read(withSsmcs({ comp: { release: 24 } }))).toBe(9.3);
  });

  it("writes each of those back as the raw that reads it", () => {
    const plan = withSsmcs({ comp: { knee: 1, attack: 184 } });
    expect(patchOf(at("sc.gain"), plan, -4.7)).toMatchObject({ ssmcs: { sc: { gain: 133 } } });
    expect(patchOf(at("compDrive"), plan, 0.05)).toMatchObject({ ssmcs: { compDrive: 1 } });
    expect(patchOf(at("comp.ratio"), plan, Infinity)).toMatchObject({ ssmcs: { comp: { ratio: 120 } } });
    expect(patchOf(at("comp.ratio"), plan, 2.5)).toMatchObject({ ssmcs: { comp: { ratio: 30 } } });
    expect(patchOf(at("eq.mid.q"), plan, 0.5)).toMatchObject({ ssmcs: { eq: { mid: { q: 0 } } } });
    expect(patchOf(at("comp.attack"), plan, 80)).toEqual({ ssmcs: { comp: { knee: 1, attack: 283 } } });
    expect(patchOf(at("comp.attack"), withSsmcs({}), 0.092)).toEqual({ ssmcs: { comp: { attack: 57 } } });
    expect(patchOf(at("comp.release"), withSsmcs({}), 9.3)).toEqual({ ssmcs: { comp: { release: 24 } } });
    expect(refusal(at("comp.attack"), plan, 0.093)).toBe("value");
    expect(refusal(at("outGain"), plan, 18.1)).toBe("value");
  });

  it("names the leaf it wrote, and keeps every other value of the group", () => {
    const plan = withSsmcs({ on: true, comp: { attack: 184, release: 159 } });
    const e = edit(at("comp.release"), plan, 999);
    expect(e).toEqual({
      kind: "node",
      id: "ch1",
      patch: { ssmcs: { on: true, comp: { attack: 184, release: 300 } } },
      written: ["ssmcs.comp.release"],
    });
  });

  it("reads Sweet Spot Data by its preset index, and writes the index back", () => {
    const data = at("data");
    expect(data.read(withSsmcs({ sweetSpotData: 1 }))).toBe("01 Basic");
    expect(data.read(withSsmcs({ sweetSpotData: 7 }))).toBe("01 AK Bass");
    expect(data.read(withSsmcs({ sweetSpotData: 34 }))).toBe("28 ZK Filter");
    expect(patchOf(data, withSsmcs({}), "28 ZK Filter")).toEqual({ ssmcs: { sweetSpotData: 34 } });
    expect(patchOf(data, withSsmcs({}), "06 Lo Cut")).toEqual({ ssmcs: { sweetSpotData: 6 } });
  });
});

describe("an FX channel's effect, whose rows follow the selected type", () => {
  const bindings = simBindings(getModel("URX44V"));
  const fx = (n: 1 | 2, path: string) => binding(bindings, `ch.fx${n}.effect.${path}`);
  const withFx = (id: "bus.fx1" | "bus.fx2", fxEffect: object): Plan => {
    const plan = defaultPlan("URX44V");
    plan.nodeParams[id] = { ...plan.nodeParams[id], fxEffect };
    return plan;
  };

  it("reads a REV-X filter in hertz on the R20 grades, and writes the grade's raw", () => {
    const plan = withFx("bus.fx1", { type: 0, params: { revxHpf: 0, revxLpf: 60, lowFreq: 1 } });
    expect(fx(1, "hpf").read(plan)).toBe(20);
    expect(fx(1, "lpf").read(plan)).toBe(20000);
    expect(fx(1, "lowFreq").read(plan)).toBe(22.4);
    expect(fx(1, "hpf").read(withFx("bus.fx1", { type: 0, params: { revxHpf: 52 } }))).toBe(8000);
    expect(fx(1, "lpf").read(withFx("bus.fx1", { type: 0, params: { revxLpf: 34 } }))).toBe(1000);
    expect(patchOf(fx(1, "hpf"), plan, 31.5)).toMatchObject({ fxEffect: { params: { revxHpf: 4 } } });
    expect(refusal(fx(1, "hpf"), plan, 31.6)).toBe("value");
  });

  it("reads a REV-X ratio and Initial Delay as the simulator prints them", () => {
    const plan = withFx("bus.fx1", { type: 0, params: { revxHiRatio: 10, lowRatio: 14, revxInitialDelay: 127 } });
    expect(fx(1, "hiRatio").read(plan)).toBe(1);
    expect(fx(1, "lowRatio").read(plan)).toBe(1.4);
    expect(fx(1, "initialDelay").read(plan)).toBe(200);
    expect(fx(1, "initialDelay").read(withFx("bus.fx1", { type: 0, params: { revxInitialDelay: 2 } }))).toBe(3.2);
    expect(patchOf(fx(1, "lowRatio"), plan, 0.1)).toMatchObject({ fxEffect: { params: { lowRatio: 1 } } });
  });

  it("reads a delay filter as its place on the simulator's scale, THRU at place 0 and at the top", () => {
    const at = (params: object) => withFx("bus.fx2", { type: 1024, params });
    expect(fx(2, "hpf").read(at({ delayHpf: 0 }))).toBe(0);
    expect(fx(2, "hpf").read(at({ delayHpf: 5 }))).toBe(0);
    expect(fx(2, "hpf").read(at({ delayHpf: 6 }))).toBe(1);
    expect(fx(2, "hpf").read(at({ delayHpf: 109 }))).toBe(104);
    expect(fx(2, "lpf").read(at({ delayLpf: 21 }))).toBe(0);
    expect(fx(2, "lpf").read(at({ delayLpf: 122 }))).toBe(101);
    expect(patchOf(fx(2, "hpf"), at({ delayHpf: 3 }), 0), "THRU keeps the raw that reads it").toMatchObject({
      fxEffect: { params: { delayHpf: 3 } },
    });
    expect(patchOf(fx(2, "hpf"), at({ delayHpf: 40 }), 0)).toMatchObject({ fxEffect: { params: { delayHpf: 0 } } });
    expect(patchOf(fx(2, "lpf"), at({}), 89)).toMatchObject({ fxEffect: { params: { delayLpf: 110 } } });
  });

  it("reads the delay time in ms under each delay's own key and range", () => {
    const mono = withFx("bus.fx2", { type: 1024, params: { delay: 27000, pingPongDelay: 100 } });
    expect(fx(2, "delay").read(mono)).toBe(2700);
    expect(patchOf(fx(2, "delay"), mono, 0.1)).toMatchObject({ fxEffect: { params: { delay: 1 } } });
    const pingPong = withFx("bus.fx2", { type: 1025, params: { delay: 27000, pingPongDelay: 100 } });
    expect(fx(2, "delay").read(pingPong)).toBe(10);
    expect(patchOf(fx(2, "delay"), pingPong, 1350)).toMatchObject({ fxEffect: { params: { pingPongDelay: 13500 } } });
    expect(refusal(fx(2, "delay"), pingPong, 2700)).toBe("value");
  });

  it("takes Sync as 1 / 0, and refuses the delay time while Sync is on", () => {
    const plan = withFx("bus.fx2", { type: 1024, params: { sync: 0 } });
    expect(fx(2, "sync").read(plan)).toBe(false);
    expect(patchOf(fx(2, "sync"), plan, true)).toMatchObject({ fxEffect: { params: { sync: 1 } } });
    const synced = withFx("bus.fx2", { type: 1024, params: { sync: 1 } });
    expect(fx(2, "sync").read(synced)).toBe(true);
    expect(refusal(fx(2, "delay"), synced, 250)).toBe("computed");
  });

  it("names the note values in the simulator's spelling", () => {
    const plan = withFx("bus.fx2", { type: 1024, params: { note: 14 } });
    expect(fx(2, "note").read(plan)).toBe("whole x2");
    expect(fx(2, "note").read(withFx("bus.fx2", { type: 1024, params: { note: 0 } }))).toBe("---");
    expect(patchOf(fx(2, "note"), plan, "1/4")).toMatchObject({ fxEffect: { params: { note: 9 } } });
    expect(refusal(fx(2, "note"), plan, "whole×2")).toBe("value");
  });

  it("moves a shared row onto the selected family's key, and reads nothing for a row the family lacks", () => {
    const reverb = withFx("bus.fx2", { type: 768, params: { delayFeedback: 20, revr3Feedback: -5, revr3Hpf: 29 } });
    expect(fx(2, "feedback").read(reverb)).toBe(-5);
    expect(fx(2, "hpf").read(reverb)).toBe(24);
    expect(fx(2, "delay").read(reverb)).toBeUndefined();
    expect(refusal(fx(2, "delay"), reverb, 500)).toBe("type");
    expect(refusal(fx(2, "note"), reverb, "1/4")).toBe("type");
    const delayOnFx1 = withFx("bus.fx1", { type: 1024, params: {} });
    expect(fx(1, "hpf").read(delayOnFx1), "the delay's own default place").toBe(35);
    expect(fx(1, "roomSize").read(delayOnFx1)).toBeUndefined();
    expect(refusal(fx(1, "lowRatio"), delayOnFx1, 1)).toBe("type");
  });

  it("writes the EFFECT TYPE as the Inspector does, keeping every stored row", () => {
    const plan = withFx("bus.fx2", { type: 1024, params: { delay: 3000 } });
    expect(edit(fx(2, "type"), plan, "Ping Pong")).toEqual({
      kind: "node",
      id: "bus.fx2",
      patch: { fxEffect: { type: 1025, params: { delay: 3000 } } },
      written: ["fxEffect.type"],
    });
    expect(fx(2, "type").read(withFx("bus.fx2", { type: 5 })), "an off-menu type reads the factory one").toBe(
      "Mono Delay",
    );
    expect(refusal(fx(1, "type"), plan, "Rev.R3 Hall"), "FX 2's reverb is not on FX 1's menu").toBe("value");
  });
});

describe.each(MODELS)("a %s ducker's key source", (modelId) => {
  const model = getModel(modelId);
  const bindings = simBindings(model);
  const ducker = modelId === "URX22" ? "out.ducker2" : "out.ducker1";
  const source = binding(bindings, "ch.ch_5_6.ducker.source");

  it("is the key wire into the ducker the model hangs under that channel", () => {
    const plan = defaultPlan(modelId);
    expect(source.read(plan)).toBe("1");
    expect(edit(source, plan, "ST")).toEqual({ kind: "connect", from: "bus.stereo:out", to: `${ducker}:in` });
    expect(edit(source, plan, "MIX 2")).toEqual({ kind: "connect", from: "bus.mix2:out", to: `${ducker}:in` });
    expect(edit(source, plan, "5/6")).toEqual({ kind: "connect", from: "ch_5_6:out", to: `${ducker}:in` });
    expect(edit(source, plan, "1"), "the source it already takes is no edit").toEqual({ kind: "none" });
  });

  it("reads the source a key wire names, and nothing without one", () => {
    const plan = defaultPlan(modelId);
    const wire = plan.connections.find((c) => c.to === `${ducker}:in` && c.kind === "key")!;
    wire.from = "bus.mix1:out";
    expect(source.read(plan)).toBe("MIX 1");
    plan.connections = plan.connections.filter((c) => c !== wire);
    expect(source.read(plan)).toBeUndefined();
  });

  it("offers the channels, then ST and the two MIX buses, and nothing the model lacks", () => {
    const values = source.values!;
    expect(values.slice(0, 2)).toEqual(["1", "2"]);
    expect(values.slice(-3)).toEqual(["ST", "MIX 1", "MIX 2"]);
    expect(values.includes("11/12")).toBe(modelId !== "URX22");
    expect(refusal(source, defaultPlan(modelId), "STEREO")).toBe("value");
  });

  it("writes the ducker's own values on that ducker", () => {
    const plan = defaultPlan(modelId);
    const e = edit(binding(bindings, "ch.ch_5_6.ducker.threshold"), plan, -30);
    expect(e).toMatchObject({ kind: "node", id: ducker, patch: { ducker: { threshold: -30 } } });
    expect(edit(binding(bindings, "ch.ch_5_6.ducker.on"), plan, true)).toEqual({
      kind: "node",
      id: ducker,
      patch: { duckerOn: true },
    });
  });
});

describe("the insert FX", () => {
  const bindings = simBindings(getModel("URX44V"));
  const effect = binding(bindings, "ch.ch1.insFx.effect");
  const on = binding(bindings, "ch.ch1.insFx.on");

  it("selects an effect with the Inspector's patch and seeded defaults", () => {
    const plan = defaultPlan("URX44V");
    const e = edit(effect, plan, "Compander-H");
    const { params, seeded } = seedInsertFxParams(undefined, 1793);
    expect(seeded.length).toBeGreaterThan(0);
    expect(e).toEqual({
      kind: "node",
      id: "ch1",
      patch: { insertFx: 1793, insertFxOn: true, insertFxParams: params },
      defaults: seeded.map((key) => `insertFxParams.${key}`),
    });
  });

  it("parks the outgoing effect's values when another is selected, and leaves the switch alone on No Effect", () => {
    const plan = defaultPlan("URX44V");
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, insertFx: 1793, insertFxOn: false, insertFxParams: { "3": 12 } };
    const parked = parkOutgoingInsertFxParams(plan.nodeParams.ch1)!;
    expect(edit(effect, plan, "No Effect")).toEqual({
      kind: "node",
      id: "ch1",
      patch: { insertFx: -1, insertFxParams: parked },
      defaults: [],
    });
    const { params } = seedInsertFxParams(parked, 1794);
    expect(patchOf(effect, plan, "Compander-S")).toEqual({ insertFx: 1794, insertFxOn: true, insertFxParams: params });
    expect(edit(effect, plan, "Compander-H"), "the effect it holds is no edit").toEqual({ kind: "none" });
  });

  it("refuses an effect the menu locks", () => {
    const plan = defaultPlan("URX44V");
    plan.nodeParams.ch2 = { ...plan.nodeParams.ch2, insertFx: 1793 };
    expect(refusal(effect, plan, "Compander-S"), "one channel holds a compander").toBe("slot");
    plan.sampleRate = 192000;
    expect(refusal(effect, plan, "Clean")).toBe("rate");
    expect(refusal(effect, plan, "Phaser")).toBe("value");
  });

  it("reads the switch off under No Effect, whatever the plan holds, and takes no switch there", () => {
    const plan = defaultPlan("URX44V");
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, insertFx: -1, insertFxOn: true };
    expect(on.read(plan)).toBe(false);
    expect(refusal(on, plan, true)).toBe("noEffect");
    expect(edit(on, plan, false)).toEqual({ kind: "none" });
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, insertFx: 256, insertFxOn: undefined };
    expect(on.read(plan)).toBe(true);
    expect(patchOf(on, plan, false)).toEqual({ insertFxOn: false });
    plan.sampleRate = 192000;
    expect(refusal(on, plan, false), "above the effect's ceiling").toBe("rate");
  });

  it("names the bus menu on an output", () => {
    expect(binding(bindings, "ch.bus.stereo.insFx.effect").values).toEqual([
      "No Effect",
      "Compander-H",
      "Compander-S",
      "M.B.Comp",
    ]);
  });
});

describe("the enumerations and the fixed mid-band shape", () => {
  const bindings = simBindings(getModel("URX44V"));

  it("reads a mid band as a bell, takes a bell as no edit and refuses any other shape", () => {
    const plan = defaultPlan("URX44V");
    const shape = binding(bindings, "ch.bus.mix1.eq.lowMid.shape");
    expect(shape.read(plan)).toBe("Bell");
    expect(edit(shape, plan, "Bell")).toEqual({ kind: "none" });
    expect(refusal(shape, plan, "L.Shelf")).toBe("value");
    expect(refusal(binding(bindings, "ch.ch_5_6.eq.highMid.shape"), plan, "H.Shelf")).toBe("value");
  });

  it("writes COMP / EQ order, BUS Type and the 1-knob EQ type as their option values", () => {
    const plan = defaultPlan("URX44V");
    expect(patchOf(binding(bindings, "ch.ch1.compEqOrder"), plan, "SSMCS")).toEqual({ compEqType: 1 });
    expect(patchOf(binding(bindings, "ch.bus.mix2.busType"), plan, "FIXED")).toEqual({ busType: 1 });
    expect(edit(binding(bindings, "ch.ch_7_8.eq.oneKnob.type"), plan, "Loudness")).toEqual({
      kind: "node",
      id: "ch_7_8",
      patch: { eqOneKnob: { on: false, type: 2, level: 0 } },
      written: ["eqOneKnob.type"],
    });
    expect(refusal(binding(bindings, "ch.ch1.compEqOrder"), plan, "EQ->COMP")).toBe("value");
  });
});

describe("an insert effect's rows, which the plan holds as the engine's raws", () => {
  const bindings = simBindings(getModel("URX44V"));

  /** A plan whose `node` holds the effect `selector` at the app's own starting values. */
  function holding(node: string, selector: number): Plan {
    const plan = defaultPlan("URX44V");
    plan.nodeParams[node] = {
      ...plan.nodeParams[node],
      insertFx: selector,
      insertFxOn: true,
      insertFxParams: seedInsertFxParams(undefined, selector).params,
    };
    return plan;
  }

  /** Every insert row the SIM reads for `node`, by key, leaving out the selector and the switch. */
  function rowsRead(node: string, plan: Plan): Record<string, SimValue> {
    const base = `ch.${node}.insFx.`;
    const out: Record<string, SimValue> = {};
    for (const [path, b] of bindings) {
      if (!path.startsWith(base) || path === `${base}effect` || path === `${base}on`) continue;
      const v = b.read(plan);
      if (v !== undefined) out[path.slice(base.length)] = v;
    }
    return out;
  }

  const notesOn = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`note${i}`, true]));

  /** Each effect, where it is offered, and the values the simulator starts it at. */
  const EFFECTS: { name: string; node: string; selector: number; family: string; shipped: Record<string, SimValue> }[] =
    [
      {
        name: "Clean",
        node: "ch1",
        selector: 256,
        family: "guitar-clean",
        shipped: {
          volume: 1.9,
          distortion: 0,
          blend: 5,
          mod: "Off",
          modSpeed: 5,
          modDepth: 5,
          bass: 6.1,
          middle: 5,
          treble: 4,
          presence: 3,
          output: 64,
          gate: false,
          gateLevel: 2,
          spType: "JC 2x12",
          micPosition: "Center",
        },
      },
      {
        name: "Crunch",
        node: "ch1",
        selector: 257,
        family: "guitar-crunch",
        shipped: {
          type: 1,
          gain: 4.6,
          bass: 4.7,
          middle: 7,
          treble: 5.3,
          presence: 2.8,
          output: 47,
          gate: false,
          gateLevel: 2,
          spType: "AC 4x10",
          micPosition: "Center",
        },
      },
      {
        name: "Lead",
        node: "ch1",
        selector: 258,
        family: "guitar-lead",
        shipped: {
          type: 0,
          gain: 10,
          master: 4.9,
          bass: 6.6,
          middle: 8,
          treble: 3,
          presence: 2.9,
          output: 42,
          gate: false,
          gateLevel: 2,
          spType: "BS 4x12",
          micPosition: "Center",
        },
      },
      {
        name: "Drive",
        node: "ch1",
        selector: 259,
        family: "guitar-drive",
        shipped: {
          ampType: 3,
          gain: 7.5,
          master: 4,
          bass: 4,
          middle: 5,
          treble: 8,
          presence: 9,
          output: 43,
          gate: false,
          gateLevel: 2,
          spType: "AM 4x12",
          micPosition: "Center",
        },
      },
      {
        name: "Pitch Fix",
        node: "ch1",
        selector: 512,
        family: "pitch",
        shipped: {
          correction: true,
          coarse: 0,
          fine: 0,
          formant: 0,
          midiControl: "Off",
          key: "C",
          scale: "Chromatic",
          ...notesOn,
          mix: 126,
          limitLow: 0,
          limitHigh: 127,
          speed: 100,
          tolerance: 50,
        },
      },
      {
        name: "Compander-H",
        node: "ch1",
        selector: 1793,
        family: "compander",
        shipped: { threshold: -10, ratio: 3.5, width: 6, gain: 0, attack: 1, release: 229 },
      },
      {
        name: "Compander-S",
        node: "ch1",
        selector: 1794,
        family: "compander",
        shipped: { threshold: -8, ratio: 4, width: 24, gain: 0, attack: 25, release: 165 },
      },
      {
        name: "M.B.Comp",
        node: "bus.mix1",
        selector: 1792,
        family: "mbc",
        shipped: {
          oneKnobOn: false,
          oneKnobLevel: 0,
          xoverLowMid: 125,
          xoverMidHigh: 3350,
          release: 75,
          outGain: 4,
          lowBypass: false,
          lowThreshold: -20,
          lowRatio: 2,
          lowAttack: 30,
          lowGain: 39,
          midBypass: false,
          midThreshold: -20,
          midRatio: 2,
          midAttack: 40,
          midGain: 39,
          highBypass: false,
          highThreshold: -20,
          highRatio: 2,
          highAttack: 10,
          highGain: 39,
        },
      },
    ];

  it.each(EFFECTS)("reads $name at the app's defaults as the simulator starts it, at every row", (e) => {
    expect(rowsRead(e.node, holding(e.node, e.selector))).toEqual(e.shipped);
  });

  it.each(EFFECTS)("takes $name's starting value at every row as no edit", (e) => {
    const plan = holding(e.node, e.selector);
    for (const [key, v] of Object.entries(e.shipped))
      expect(edit(binding(bindings, `ch.${e.node}.insFx.${key}`), plan, v), key).toEqual({ kind: "none" });
  });

  /** Writes of another value, and the raws each lands on, by slot. */
  const WRITES: [string, string, SimValue, Record<number, number>][] = [
    ["Clean", "volume", 2.5, { 7: 25 }],
    ["Clean", "spType", "BS 4x12", { 16: 1 }],
    ["Clean", "mod", "Vib", { 19: 2 }],
    ["Clean", "output", 100, { 14: 100 }],
    ["Clean", "gate", true, { 24: 1 }],
    ["Crunch", "type", 0, { 6: 0 }],
    ["Crunch", "gain", 4.7, { 7: 47 }],
    ["Lead", "master", 5, { 13: 50 }],
    ["Drive", "ampType", 5, { 6: 5 }],
    ["Drive", "micPosition", "Edge", { 18: 1 }],
    ["Pitch Fix", "coarse", 3, { 6: 3, 9: 3 }],
    ["Pitch Fix", "formant", -10, { 8: 54, 11: 54 }],
    ["Pitch Fix", "midiControl", "Real Time", { 34: 1, 35: 1 }],
    ["Pitch Fix", "midiControl", "Setting", { 34: 1, 35: 0 }],
    ["Pitch Fix", "scale", "Major", { 16: 2 }],
    ["Pitch Fix", "note3", false, { 25: 0 }],
    ["Pitch Fix", "key", "G", { 15: 7 }],
    ["Pitch Fix", "correction", false, { 13: 0 }],
    ["Pitch Fix", "limitHigh", 100, { 21: 100 }],
    ["Compander-H", "threshold", -12.5, { 6: -1250 }],
    ["Compander-H", "release", 2000, { 9: 20000 }],
    ["Compander-H", "attack", 5, { 8: 5000 }],
    ["Compander-S", "ratio", 2.5, { 7: 250 }],
    ["Compander-S", "width", 10, { 11: 1000 }],
    ["Compander-S", "gain", -3, { 10: -300 }],
    ["M.B.Comp", "lowThreshold", -30, { 9: 97 }],
    ["M.B.Comp", "midAttack", 50, { 13: 20 }],
    ["M.B.Comp", "highRatio", 5, { 20: 4 }],
    ["M.B.Comp", "highBypass", true, { 22: 1 }],
    ["M.B.Comp", "lowGain", 47, { 11: 47 }],
    ["M.B.Comp", "xoverLowMid", 1000, { 23: 73 }],
    ["M.B.Comp", "release", 1000, { 25: 17 }],
    ["M.B.Comp", "outGain", -6, { 26: 58 }],
    ["M.B.Comp", "oneKnobOn", true, { 6: 1 }],
  ];

  it.each(WRITES)("writes %s %s = %j onto the family's own keys, as the tuning screen does", (name, key, v, raws) => {
    const e = EFFECTS.find((x) => x.name === name)!;
    const plan = holding(e.node, e.selector);
    const family = e.family as Parameters<typeof insertFxParamKey>[0];
    const held = plan.nodeParams[e.node].insertFxParams!;
    const b = binding(bindings, `ch.${e.node}.insFx.${key}`);
    expect(edit(b, plan, v)).toEqual({
      kind: "node",
      id: e.node,
      patch: { insertFxParams: reKeyInsertFxParams(held, family, raws) },
      written: Object.keys(raws).flatMap((slot) => [
        `insertFxParams.${insertFxParamKey(family, Number(slot))}`,
        `insertFxParams.${slot}`,
      ]),
    });
    for (const [slot, raw] of Object.entries(raws))
      expect((patchOf(b, plan, v).insertFxParams as Record<string, number>)[`${family}:${slot}`]).toBe(raw);
  });

  it("reads a value a device read left under the bare slot", () => {
    const plan = holding("ch1", 1794);
    plan.nodeParams.ch1.insertFxParams = { "6": -2000 };
    expect(binding(bindings, "ch.ch1.insFx.threshold").read(plan)).toBe(-20);
  });

  it("reads nothing at a row of another family, and takes no edit of it", () => {
    const plan = holding("ch1", 1794);
    const volume = binding(bindings, "ch.ch1.insFx.volume");
    expect(volume.read(plan)).toBeUndefined();
    expect(refusal(volume, plan, 2)).toBe("type");
    const none = defaultPlan("URX44V");
    expect(binding(bindings, "ch.ch1.insFx.threshold").read(none), "No Effect carries no row").toBeUndefined();
    expect(refusal(binding(bindings, "ch.ch1.insFx.threshold"), none, -8)).toBe("type");
  });

  it("refuses a value off the row's grid or outside its window", () => {
    const plan = holding("ch1", 1794);
    expect(refusal(binding(bindings, "ch.ch1.insFx.threshold"), plan, -8.001)).toBe("value");
    expect(refusal(binding(bindings, "ch.ch1.insFx.threshold"), plan, 3)).toBe("value");
    expect(refusal(binding(bindings, "ch.ch1.insFx.attack"), plan, "fast")).toBe("value");
  });

  it("refuses a slot the unit drives itself, and the 1-knob Level while the knob is off", () => {
    const mbc = holding("bus.mix1", 1792);
    expect(refusal(binding(bindings, "ch.bus.mix1.insFx.oneKnobLevel"), mbc, 20)).toBe("locked");
    mbc.nodeParams["bus.mix1"].insertFxParams = { ...mbc.nodeParams["bus.mix1"].insertFxParams, "mbc:6": 1 };
    expect(refusal(binding(bindings, "ch.bus.mix1.insFx.lowThreshold"), mbc, -30)).toBe("locked");
    expect(refusal(binding(bindings, "ch.bus.mix1.insFx.xoverLowMid"), mbc, 1000)).toBe("locked");
    expect(patchOf(binding(bindings, "ch.bus.mix1.insFx.outGain"), mbc, -6), "Out Gain stays the operator's").toEqual({
      insertFxParams: { ...mbc.nodeParams["bus.mix1"].insertFxParams, "mbc:26": 58 },
    });
    expect(binding(bindings, "ch.bus.mix1.insFx.oneKnobLevel").write!(mbc, 20)).not.toHaveProperty("refused");

    const pitch = holding("ch1", 512);
    pitch.nodeParams.ch1.insertFxParams = { ...pitch.nodeParams.ch1.insertFxParams, "pitch:34": 1 };
    expect(refusal(binding(bindings, "ch.ch1.insFx.scale"), pitch, "Major")).toBe("locked");
    expect(refusal(binding(bindings, "ch.ch1.insFx.note0"), pitch, false)).toBe("locked");
    expect(edit(binding(bindings, "ch.ch1.insFx.scale"), pitch, "Chromatic"), "the value it holds").toEqual({
      kind: "none",
    });
  });

  it("refuses a row of an effect the rate takes out", () => {
    const plan = holding("ch1", 1794);
    plan.sampleRate = 192000;
    expect(refusal(binding(bindings, "ch.ch1.insFx.threshold"), plan, -20)).toBe("rate");
  });

  it("carries every row of the effects each insert offers, and moves them with the effect", () => {
    const effect = binding(bindings, "ch.ch1.insFx.effect");
    expect(effect.moves).toContain("ch.ch1.insFx.volume");
    expect(effect.moves).toContain("ch.ch1.insFx.note11");
    expect(effect.moves).toContain("ch.ch1.insFx.threshold");
    expect(bindings.has("ch.ch1.insFx.lowThreshold"), "M.B.Comp is the outputs'").toBe(false);
    expect(bindings.has("ch.bus.stereo.insFx.lowThreshold")).toBe(true);
    expect(bindings.has("ch.bus.stereo.insFx.volume"), "an amp is the inputs'").toBe(false);
    expect(binding(bindings, "ch.ch1.insFx.scale").values).toContain("Natural Minor");
  });
});

describe("the 1-knob EQ's kept band gains", () => {
  const bindings = simBindings(getModel("URX44V"));

  it.each(["ch.ch1", "ch.ch_5_6", "ch.bus.mix1", "ch.bus.stereo"])(
    "read nothing on %s and take a write as no edit",
    (ch) => {
      const plan = defaultPlan("URX44V");
      for (const band of ["low", "lowMid", "highMid", "high"]) {
        const base = binding(bindings, `${ch}.eq.oneKnob.base.${band}`);
        expect(base.read(plan)).toBeUndefined();
        expect(edit(base, plan, 3.5)).toEqual({ kind: "none" });
      }
    },
  );
});
