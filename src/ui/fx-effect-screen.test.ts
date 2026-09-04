// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { FX_DYN, ORDER_FOR_TEST, fxControlLabel } from "./fx-effect-screen";
import { FX_CHANNEL_NODE_INDEX, fxEffectTypes, fxParams, fxFamilyOf } from "../core/control/fx-effect";
import { bindControl, controlId, listControls, FX_LEVEL_SCOPE, FX_ON_SCOPE, FX_SCOPE } from "../core/midi/controls";
import { ensureFixedConnections } from "../core/plan";
import { DYN_PROCESSORS } from "./dyn-registry";
import { diffPlans, nodeParamContestPath, patchContestNames } from "../core/plan-history";
import { defaultPlan } from "../models/initial-state";
import { getModel } from "../models";
import { setLang, t } from "../i18n";
import type { DynCtx } from "./dyn-screen";
import { emptyPlan } from "../core/plan";
import type { Plan } from "../core/plan";

// What the FX screen ASSERTS when it writes, against what the plan differ actually names.
//
// `patch` rebuilds the whole `fxEffect` group, so the funnel falls back to the plan's own
// diff unless `written` names the leaves — and a name spelled at the wrong depth matches
// nothing, which is invisible: the edit still lands, and only a device read arriving in the
// same window is silently taken back. Both halves are asked of the real functions here
// rather than restated.

const ctxFor = (plan: Plan, nodeId: string): DynCtx => ({
  model: getModel("URX44V"),
  plan,
  nodeId,
  sel: 0,
  m: t(),
});

describe("the FX screen's write witness", () => {
  it("names the leaf the differ names, for a parameter and for Mix", () => {
    for (const [key, value] of [
      ["fx:revxHpf", 12],
      ["fx:level", 40],
    ] as const) {
      const before = defaultPlan("URX44V");
      const ctx = ctxFor(before, "bus.fx1");
      const patch = { [key]: value };
      const names = FX_DYN.written!(ctx, patch);
      expect(names.length, key).toBe(1);

      // The plan the edit produces, diffed against the one it started from: the keys the
      // merge would contest.
      const after = structuredClone(before);
      after.nodeParams["bus.fx1"] = { ...after.nodeParams["bus.fx1"], ...FX_DYN.patch(ctx, patch) };
      const contested = patchContestNames(diffPlans(before, after));
      expect(contested, key).toContain(nodeParamContestPath("bus.fx1", names[0]));
    }
  });

  it("is registered under a kind whose launcher label resolves", () => {
    expect(DYN_PROCESSORS.fx).toBe(FX_DYN);
    expect(t().dynTuning.fx.open.length).toBeGreaterThan(0);
  });
});

// What the screen PRINTS for a stored raw. These halves came off the Inspector's own cases
// when the rows moved here; the writer's halves stayed there, and each side now asks the
// surface that owns it. Asked of `read` and `fieldText` together, which is the exact pair
// the host prints a card with.
describe("what the screen prints for a stored raw", () => {
  const shown = (plan: Plan, nodeId: string, planKey: string): string | undefined => {
    const ctx = ctxFor(plan, nodeId);
    const vals = FX_DYN.read(ctx);
    const key = `fx:${planKey}`;
    const field = FX_DYN.bind(ctx)!.fields.find((f) => f.key === key)!;
    return FX_DYN.fieldText!(field, vals[key] as number, ctx);
  };

  it("shows what the unit holds, not the bound the next write will apply", () => {
    // raw 20 is below the window and IS a state a unit can be in: v1.11.0 shipped this
    // control starting at 0, so its Live sync could put one there. The writer sends the
    // bound — `inspector.test.ts` holds that half — and the panel shows this one.
    const lpf = fxParams(1024).find((d) => d.key === "delayLpf")!;
    const plan = defaultPlan("URX44V");
    plan.nodeParams["bus.fx2"] = { fxEffect: { type: 1024, params: { delayLpf: 20 } } };
    expect(shown(plan, "bus.fx2", "delayLpf")).toBe(lpf.format!(20, {}));
    expect(shown(plan, "bus.fx2", "delayLpf")).not.toBe(lpf.format!(lpf.rawMin!, {}));
  });

  it("draws the effect's own defaults for a channel the plan does not describe", () => {
    const plan = emptyPlan("URX44V");
    expect(plan.nodeParams["bus.fx1"]?.fxEffect, "the premise: nothing describes it").toBeUndefined();
    const descs = fxParams(0);
    const ctx: Record<string, number> = {};
    for (const d of descs) ctx[d.key] = d.def;
    let compared = 0;
    for (const d of descs) {
      if (d.control !== "slider") continue;
      expect(shown(plan, "bus.fx1", d.key), d.key).toBe(d.format ? d.format(d.def, ctx) : String(d.def));
      compared += 1;
    }
    // Counted, or a filter that matched nothing would satisfy every assertion above.
    expect(compared).toBe(descs.filter((d) => d.control === "slider").length);
    expect(compared).toBeGreaterThan(4);
    // …and Mix, which has no catalogue descriptor of its own.
    expect(shown(plan, "bus.fx1", "level")).toBe("100");
  });
});

// The Mono Delay time is the one control whose own grid is finer than a 14-bit controller can
// address — 27000 settings against 16384 positions — and it is offered all the same, through a
// codec whose reading is snapped to the wire's grid. Both halves are the decision: it is
// THERE, and its round trip is exact. `controls.test.ts` sweeps every control for the second
// property; this names the one the sweep would stop covering if it were dropped from the
// catalogue, since a control that is not listed is not a control that fails.
describe("the delay time over MIDI", () => {
  const ID = controlId("bus.fx2", "fx", `${FX_SCOPE}.delay`);

  it("is offered, and its 14-bit round trip is exact", () => {
    const model = getModel("URX44V");
    const plan = defaultPlan("URX44V");
    ensureFixedConnections(model, plan);
    expect(listControls(model, plan).map((d) => d.id)).toContain(ID);

    const c = bindControl(model, plan, ID)!;
    const W = (1 << 14) - 1;
    for (let i = 0; i <= W; i += 97) {
      expect(c.set(i / W), `set ${i}`).toBe(true);
      const v = c.get();
      expect(c.set(Math.round(v * W) / W), `re-set ${i}`).toBe(true);
      expect(c.get(), `round trip at ${i}`).toBe(v);
    }
  });

  it("gives up resolution on the wire and not in the value", () => {
    const time = fxParams(1024).find((d) => d.key === "delay")!;
    // Every setting is still reachable by hand: the descriptor's own step is unchanged.
    expect(time.rawStep).toBe(1);
    expect((time.rawMax! - time.rawMin!) / time.rawStep!).toBeGreaterThan(1 << 14);
  });
});

// The face's ORDER and its one row break, for every type — including the two no other test
// opens. FX2 ships Mono Delay and FX1 has no Rev.R3 in its menu, so Rev.R3 and Ping Pong are
// reachable only by seeding a type; without this, three of the five types' row lists, both
// of their `ORDER` tables and two of the three `BREAK_AT` entries were never read at all.
describe("the row order and the break", () => {
  const planHolding = (nodeId: string, type: number): Plan => {
    const plan = defaultPlan("URX44V");
    plan.nodeParams[nodeId] = { ...plan.nodeParams[nodeId], fxEffect: { type } };
    return plan;
  };
  /** The face as the operator reads it: the knob cards in order, with the break where the
   *  host would draw one. Built from the same two calls the host makes. */
  const face = (nodeId: string, type: number): string[] => {
    const ctx = ctxFor(planHolding(nodeId, type), nodeId);
    // The row context the host supplies, reduced to what `rows` reaches: the delay families
    // build a switch and a select through it, so a bare ctx throws before the break is placed.
    const rowCtx = { ...ctx, states: new Map(), midi: (row: HTMLElement) => row, set: () => {}, setValue: () => {} };
    const before = FX_DYN.rows!(rowCtx as never).before ?? {};
    const out: string[] = [];
    for (const f of FX_DYN.bind(ctx)!.fields) {
      for (const el of before[f.key] ?? []) out.push(el.classList.contains("gt-break") ? "BREAK" : "row");
      out.push(FX_DYN.fieldLabel!(f, t(), ctx) ?? f.key);
    }
    return out;
  };

  it.each([
    ["bus.fx1", 0, "Rev-X Hall"],
    ["bus.fx1", 2, "Rev-X Plate"],
    ["bus.fx2", 768, "Rev.R3 Hall"],
    ["bus.fx2", 1024, "Mono Delay"],
    ["bus.fx1", 1025, "Ping Pong"],
  ])("puts one break between the two groups on %s type %i (%s)", (nodeId, type) => {
    const seq = face(nodeId as string, type as number);
    expect(
      seq.filter((x) => x === "BREAK"),
      `exactly one break on ${seq.join(" ")}`,
    ).toEqual(["BREAK"]);
    // Mix leads every family — the device's own array order — and the break never lands at
    // either end, which is what a mistyped BREAK_AT key or a row missing from ORDER produces.
    expect(seq[0]).toBe(t().inspector.fxEffect.level);
    expect(seq.indexOf("BREAK")).toBeGreaterThan(1);
    expect(seq.indexOf("BREAK")).toBeLessThan(seq.length - 1);
  });

  it("names every slider of every type in its family's order", () => {
    // The header on ORDER claims it. A row the catalogue gains and the list does not name
    // still appears — after the ones it does — so the claim is about the LISTS, not the face.
    for (const type of [0, 1, 2, 768, 769, 770, 1024, 1025]) {
      const order = ORDER_FOR_TEST[fxFamilyOf(type)];
      for (const d of fxParams(type)) {
        if (d.control !== "slider") continue;
        expect(order, `type ${type} / ${d.key}`).toContain(d.key);
      }
    }
  });
});

// What an assignment PRINTS. A control id's scope is built from the plan key, so the list
// read "FX 1 · fx.reverbTime · fx" — three tokens, none of them a word on any surface the
// operator sees. Driven from `listControls` rather than a written-out list of scopes, so a
// row the catalogue gains is covered the day it is added; and asked in both languages,
// because a label composed of tokens is equally unreadable in either.
describe("the words a MIDI assignment prints for an FX control", () => {
  const model = getModel("URX44V");

  /** Every FX-scoped control id the catalogue offers across every type both channels can
   *  hold — the ids an assignment list can ever be asked to name. */
  const everyFxScope = (): Set<string> => {
    const out = new Set<string>();
    for (const nodeId of ["bus.fx1", "bus.fx2"]) {
      for (const opt of fxEffectTypes(FX_CHANNEL_NODE_INDEX[nodeId])) {
        const plan = defaultPlan("URX44V");
        ensureFixedConnections(model, plan);
        plan.nodeParams[nodeId] = { ...plan.nodeParams[nodeId], fxEffect: { type: opt.value } };
        for (const c of listControls(model, plan)) {
          if (c.param === "fx" && c.scope) out.add(c.scope);
        }
      }
    }
    return out;
  };

  it.each(["en", "ja"] as const)("names every FX scope in %s, never its plan key", (lang) => {
    setLang(lang);
    const scopes = [...everyFxScope()];
    // The positive control: the catalogue really did offer the rows this is about. A run
    // that enumerated nothing would satisfy every assertion below.
    expect(scopes.length, "the catalogue offered no FX control at all").toBeGreaterThan(10);
    expect(scopes, "EFFECT ON is one of them").toContain(FX_ON_SCOPE);
    expect(scopes, "…and so is Mix").toContain(FX_LEVEL_SCOPE);
    for (const scope of scopes) {
      const label = fxControlLabel(scope, t());
      expect(label, `${scope} names nothing`).not.toBeNull();
      // The screen's own title leads, as the insert effect's does.
      expect(label, scope).toContain(t().dynTuning.fx.title);
      // …and the token the scope is built from never reaches the reader.
      expect(label, `${scope} printed its own plan key`).not.toContain(scope.slice(FX_SCOPE.length + 1));
    }
    setLang("en");
  });

  it("declines a scope that is not one of its own", () => {
    setLang("en");
    for (const scope of [undefined, "gate", "insfx.compander.6", "fxsomething.level"]) {
      expect(fxControlLabel(scope, t()), String(scope)).toBeNull();
    }
  });
});
