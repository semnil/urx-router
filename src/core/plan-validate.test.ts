import { describe, it, expect } from "vitest";
import {
  applyParamRange,
  insertFxSlotProblems,
  isRefusal,
  needsDecision,
  paramRangeProblems,
  planProblems,
} from "./plan-validate";
import { fxEffectTypes, fxParams } from "./control/fx-effect";
import { planToCommands } from "./control/translate";
import { validatePlan } from "./routing";
import { emptyPlan } from "./plan";
import type { Plan } from "./plan";
import { getModel, MODEL_IDS } from "../models";
import { defaultPlan } from "../models/initial-state";
import { ref } from "../models/types";
import {
  INSERT_FX_NONE,
  INSERT_FX_OPTIONS,
  OUTPUT_INSERT_FX_OPTIONS,
  PAN_BAL_BAL,
  PAN_BAL_PAN,
} from "./control/params";
import type { InsertFxOption, InsertFxSlot } from "./control/params";

// The slot facts come off the catalog rather than being listed here, so a family
// added to INSERT_FX_OPTIONS with a new slot joins these cases without an edit.
const bySlot = (options: InsertFxOption[]): Map<InsertFxSlot, InsertFxOption[]> => {
  const map = new Map<InsertFxSlot, InsertFxOption[]>();
  for (const o of options) if (o.slot) map.set(o.slot, [...(map.get(o.slot) ?? []), o]);
  return map;
};
const INPUT_SLOTS = bySlot(INSERT_FX_OPTIONS);

describe("insertFxSlotProblems", () => {
  const u44v = getModel("URX44V");

  it("reports nothing for a plan with at most one holder per slot", () => {
    const plan = emptyPlan("URX44V");
    let ch = 1;
    for (const [, options] of INPUT_SLOTS) plan.nodeParams[`ch${ch++}`] = { insertFx: options[0].value };
    plan.nodeParams["bus.stereo"] = { insertFx: OUTPUT_INSERT_FX_OPTIONS.find((o) => o.slot === "out-dyn")!.value };
    expect(insertFxSlotProblems(u44v, plan)).toEqual([]);
    expect(planProblems(u44v, plan)).toEqual([]);
  });

  it("names the contended slot and every node claiming it", () => {
    for (const [slot, options] of INPUT_SLOTS) {
      const plan = emptyPlan("URX44V");
      plan.nodeParams["ch1"] = { insertFx: options[0].value };
      plan.nodeParams["ch3"] = { insertFx: options[options.length - 1].value };
      const problems = insertFxSlotProblems(u44v, plan);
      expect(problems).toHaveLength(1);
      expect(problems[0].reason).toBe("insertFxSlot");
      expect(problems[0].slot).toBe(slot);
      expect([...problems[0].nodes].sort()).toEqual(["ch1", "ch3"]);
      // The wire validator knows nothing about slots; the loader composes the two.
      expect(validatePlan(u44v, plan)).toEqual([]);
      expect(planProblems(u44v, plan)).toEqual(problems);
    }
  });

  it("reports the output buses sharing their one slot", () => {
    const plan = emptyPlan("URX44V");
    const [a, b] = OUTPUT_INSERT_FX_OPTIONS.filter((o) => o.slot === "out-dyn");
    plan.nodeParams["bus.stereo"] = { insertFx: a.value };
    plan.nodeParams["bus.mix1"] = { insertFx: b.value };
    const problems = insertFxSlotProblems(u44v, plan);
    expect(problems).toHaveLength(1);
    expect(problems[0].slot).toBe("out-dyn");
    expect([...problems[0].nodes].sort()).toEqual(["bus.mix1", "bus.stereo"]);
  });

  // A STEREO-linked pair is one holder (the app mirrors the selection onto both members,
  // as the unit does in PAN and BAL alike), so reopening a file the app itself saved must
  // not read as a collision — while a third node claiming the same slot still does.
  it("counts a linked pair once in either PAN/BAL mode, and still reports a third node", () => {
    for (const panBal of [PAN_BAL_BAL, PAN_BAL_PAN]) {
      for (const [slot, options] of INPUT_SLOTS) {
        const plan = emptyPlan("URX44V");
        plan.nodeParams["ch1"] = { stereoLink: true, panBal, insertFx: options[0].value };
        plan.nodeParams["ch2"] = { insertFx: options[0].value };
        expect(planProblems(u44v, plan)).toEqual([]);
        plan.nodeParams["ch3"] = { insertFx: options[options.length - 1].value };
        const problems = insertFxSlotProblems(u44v, plan);
        expect(problems).toHaveLength(1);
        expect(problems[0].slot).toBe(slot);
        expect([...problems[0].nodes].sort()).toEqual(["ch1", "ch3"]);
      }
    }
  });

  it("ignores No Effect and an unset selection", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["ch1"] = { insertFx: INSERT_FX_NONE };
    plan.nodeParams["ch2"] = { insertFx: INSERT_FX_NONE };
    plan.nodeParams["ch3"] = {};
    expect(insertFxSlotProblems(u44v, plan)).toEqual([]);
  });
});

// The two classes the loader splits on, asked of the composed function the loader
// actually calls. `routing.test.ts` pins that validatePlan finds a ruleless wire;
// what is here is that the finding survives composition with the slot census and
// lands on the refusing side of the split — which is what makes a wire pointing at
// something the model cannot resolve unreachable rather than a hole in an adopted
// plan (`e2e/race/t2b-shape-change.spec.ts` skips its silent-hole case for exactly
// this reason, and `e2e/race/skip-ledger.json` names this test as what keeps that
// reason true).
// A stored value outside its own control's range means one thing on screen and another on
// the wire: the panel shows what the plan holds and translate.ts bounds what it sends. The
// app cannot author one — the sliders stop at the window — so it arrives from a file an
// older build saved, a hand edit or a ?plan= payload, and the loader repairs it.
describe("paramRangeProblems", () => {
  const lpf = fxParams(1024).find((d) => d.key === "delayLpf")!;
  const fx2 = (params: Record<string, number>) => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["bus.fx2"] = { fxEffect: { type: 1024, params } };
    return plan;
  };

  it("names the value, what it would be sent as, and nothing else", () => {
    // v1.11.0 shipped this slider starting at raw 0, so a plan it saved can hold one below
    // the window; the unit's own encoder stops at the window, so nothing else can.
    expect(paramRangeProblems(fx2({ delayLpf: lpf.rawMin! - 1 }))).toEqual([
      {
        reason: "paramRange",
        node: "bus.fx2",
        where: "params",
        key: "delayLpf",
        stored: lpf.rawMin! - 1,
        action: "bound",
        bound: lpf.rawMin,
      },
    ]);
  });

  it("reports nothing for a value the window admits — including both of its ends", () => {
    for (const raw of [lpf.rawMin!, lpf.rawMax!, Math.round((lpf.rawMin! + lpf.rawMax!) / 2)]) {
      expect(paramRangeProblems(fx2({ delayLpf: raw })), String(raw)).toEqual([]);
    }
  });

  // The end the ends-are-admitted case cannot reach: it walks rawMax as a value the window
  // TAKES, which pins the ceiling only from inside. A shipped document can sit outside it —
  // 6b252e5 on this branch's own base moved the Mono delay ceiling from raw 40436 to 27000,
  // and v1.11.0 predates that commit, so a plan it saved can hold a delay time above what
  // this build writes.
  it("reports a value ABOVE the window as well as one below it", () => {
    const delay = fxParams(1024).find((d) => d.key === "delay")!;
    expect(paramRangeProblems(fx2({ delay: delay.rawMax! + 1 }))).toEqual([
      {
        reason: "paramRange",
        node: "bus.fx2",
        where: "params",
        key: "delay",
        stored: delay.rawMax! + 1,
        action: "bound",
        bound: delay.rawMax,
      },
    ]);
  });

  // The two descriptors that declare no window are the two that are not sliders, and a window
  // is a slider's answer alone: a toggle admits 0 and 1, a select admits its option values.
  // This case used to assert the opposite — that a value outside them is "left alone", which
  // is what `?? stored` does when there are no bounds to apply — and 9999 therefore reached
  // the unit on a two-state control and on a menu of fifteen.
  it("normalises a toggle and a select to their own admitted values, having no window", () => {
    const model = getModel("URX44V");
    const sync = fxParams(1024).find((x) => x.key === "sync")!;
    const note = fxParams(1024).find((x) => x.key === "note")!;
    expect([sync.rawMin, sync.rawMax, note.rawMin, note.rawMax]).toEqual([undefined, undefined, undefined, undefined]);
    expect(note.options!.at(-1)!.value, "the menu's last value is what 15 is past").toBe(14);

    for (const [key, stored, want] of [
      // Fractional, and rounding alone lands outside the control: 1.6 -> 2 is not a state a
      // toggle has, and 14.6 -> 15 is one past the menu's end.
      ["sync", 1.6, 1],
      ["note", 14.6, 14],
      // …and an integer already outside, which no rounding touches.
      ["sync", 9999, 1],
      ["note", 9999, 14],
      ["sync", -3, 0],
      ["note", -3, 0],
    ] as const) {
      const plan = fx2({ [key]: stored });
      expect(
        paramRangeProblems(plan).map((p) => [p.key, p.action, p.bound]),
        `${key} ${stored}`,
      ).toEqual([[key, "bound", want]]);
      applyParamRange(plan, paramRangeProblems(plan));
      expect(plan.nodeParams["bus.fx2"]?.fxEffect?.params?.[key], `${key} ${stored}`).toBe(want);
      const slot = key === "sync" ? sync.slot : note.slot;
      expect(planToCommands(model, plan).find((c) => c.paramId === 685 && c.y === slot)?.vdValue).toBe(want);
    }
    // The values they DO admit are untouched.
    for (const [key, ok] of [
      ["sync", 0],
      ["sync", 1],
      ["note", 0],
      ["note", 14],
    ] as const) {
      expect(paramRangeProblems(fx2({ [key]: ok })), `${key} ${ok}`).toEqual([]);
    }
  });

  // Whatever a control is, what the repair writes has to be a value that control admits — the
  // sweep below asserts the repair does not move the wire, which a repair to an inadmissible
  // value satisfies just as well when the emit is wrong in the same way.
  it("repairs every parameter of every type to a value its own control admits", () => {
    const offenders: string[] = [];
    for (const [node, fxIndex] of [
      ["bus.fx1", 0],
      ["bus.fx2", 1],
    ] as const) {
      for (const t of fxEffectTypes(fxIndex)) {
        for (const d of fxParams(t.value)) {
          for (const stored of [-9999, 9999, 0.6, 1.6, 14.6, ((d.rawMin ?? 0) + (d.rawMax ?? 0)) / 2 + 0.6]) {
            const plan = emptyPlan("URX44V");
            plan.nodeParams[node] = { fxEffect: { type: t.value, params: { [d.key]: stored } } };
            applyParamRange(plan, paramRangeProblems(plan));
            const v = plan.nodeParams[node]!.fxEffect!.params![d.key]!;
            const admits =
              d.control === "toggle"
                ? v === 0 || v === 1
                : d.control === "select"
                  ? d.options!.some((o) => o.value === v)
                  : Number.isInteger(v) && v >= (d.rawMin ?? v) && v <= (d.rawMax ?? v);
            if (!admits) offenders.push(`${node} type ${t.value} ${d.key} (${d.control}) ${stored} -> ${v}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // The effect level is a field of its own, bounded two lines above the parameter loop and
  // by a literal rather than by a descriptor — so a walk over descriptors alone misses it
  // while the file's own sentence claims every FX slot.
  it("covers the effect level, which no descriptor describes", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["bus.fx2"] = { fxEffect: { type: 1024, level: 500 } };
    expect(paramRangeProblems(plan)).toEqual([
      { reason: "paramRange", node: "bus.fx2", where: "field", key: "level", stored: 500, action: "bound", bound: 100 },
    ]);
    applyParamRange(plan, paramRangeProblems(plan));
    expect(plan.nodeParams["bus.fx2"]?.fxEffect?.level).toBe(100);
  });

  // A key the SELECTED type does not own. The migration leaves it exactly where it is, so a
  // walk over the selected type's descriptors alone never sees it — and selecting that type
  // later brings the unwritable raw back, with the load already past.
  it("reports a key the selected type does not own, so selecting it later cannot revive it", () => {
    const plan = emptyPlan("URX44V");
    // FX2 on Rev.R3 Hall, carrying a delay-family key from a document saved under a delay.
    plan.nodeParams["bus.fx2"] = { fxEffect: { type: 768, params: { delayLpf: 0 } } };
    expect(paramRangeProblems(plan).map((p) => [p.key, p.bound])).toEqual([["delayLpf", lpf.rawMin]]);
  });

  // Two at once, on both channels: the plural half of the message and the per-node walk are
  // each satisfied by a single-value plan, so neither is pinned by one.
  it("reports both channels in one pass", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["bus.fx1"] = { fxEffect: { type: 0, params: { revxLpf: 0 } } };
    plan.nodeParams["bus.fx2"] = { fxEffect: { type: 1024, params: { delayLpf: 0 } } };
    expect(paramRangeProblems(plan).map((p) => p.node)).toEqual(["bus.fx1", "bus.fx2"]);
    applyParamRange(plan, paramRangeProblems(plan));
    expect(paramRangeProblems(plan)).toEqual([]);
  });

  it("asks the window of the type the write path will resolve to, not the one stored", () => {
    // 768 is Rev.R3 Hall, which FX2 offers and FX1 does not; on FX1 the write path coerces
    // it to that channel's factory type, so its window is the one that decides — and the
    // stored type is itself reported, since the document says one effect and the unit gets
    // another.
    const plan = emptyPlan("URX44V");
    plan.nodeParams["bus.fx1"] = { fxEffect: { type: 768, params: { revxLpf: 0 } } };
    // Rev-X's own LPF starts at 34, so a stored 0 is out of range under the resolved type.
    expect(paramRangeProblems(plan).map((p) => p.key)).toEqual(["type", "revxLpf"]);
    applyParamRange(plan, paramRangeProblems(plan));
    // Dropped, not corrected: a menu has no nearest member, and the emit already answers the
    // channel's own default for an absent type.
    expect(plan.nodeParams["bus.fx1"]?.fxEffect?.type).toBeUndefined();
  });

  it("repairs the plan to exactly what it reported, and only that", () => {
    const plan = fx2({ delayLpf: 0, delayHpf: 40 });
    const problems = paramRangeProblems(plan);
    applyParamRange(plan, problems);
    expect(plan.nodeParams["bus.fx2"]?.fxEffect?.params).toEqual({ delayLpf: lpf.rawMin, delayHpf: 40 });
    // Idempotent: a repaired plan reports nothing, so a re-load cannot report it twice.
    expect(paramRangeProblems(plan)).toEqual([]);
  });

  // The property the repair exists to have, and the one that says the loader and the emit
  // are one rule rather than two: repairing a document must not change what the write path
  // sends. It failed on a boolean — the sanitiser keeps one and arithmetic reads `false` as
  // 0, so the level was repaired to the window's floor while the emit substituted 100, which
  // is the effect going silent.
  it("never changes what the write path would send", () => {
    const sent = (p: ReturnType<typeof emptyPlan>): (number | undefined)[] =>
      planToCommands(getModel("URX44V"), p)
        .filter((c) => c.paramId === 685)
        .map((c) => c.vdValue);
    for (const [name, params, level] of [
      ["a boolean under numeric keys", { delayLpf: false, note: false }, false],
      ["a value below the window", { delayLpf: 0 }, undefined],
      ["a value above the window", { delay: fxParams(1024).find((d) => d.key === "delay")!.rawMax! + 1 }, undefined],
      ["a value the window admits", { delayLpf: 110 }, 50],
    ] as const) {
      const plan = emptyPlan("URX44V");
      plan.nodeParams["bus.fx2"] = {
        fxEffect: { type: 1024, ...(level === undefined ? {} : { level }), params: { ...params } },
      } as never;
      const before = sent(plan);
      applyParamRange(plan, paramRangeProblems(plan));
      expect(sent(plan), name).toEqual(before);
      // …and afterwards the document holds what it sends, so a second load reports nothing.
      expect(paramRangeProblems(plan), name).toEqual([]);
    }
  });

  // The plan every model ships with. One out-of-window value here would be repaired on every
  // load of a new document — and, once the write path takes the same rule, authored back into
  // the plan by every flush that reaches the device.
  it("finds nothing in any model's shipped default plan", () => {
    for (const id of MODEL_IDS) expect(paramRangeProblems(defaultPlan(id)), id).toEqual([]);
  });

  // The review's own sweep, kept. The repair must not change what the write path sends for
  // ANY key of ANY type either channel offers, in all three shapes a document can be wrong in.
  // Walking one type hid the defect this replaced: the window is shared across a channel's
  // types but the DEFAULT is not, so repairing a non-numeric leaf to "the first type that
  // names this key" changed the value for every type that was not first — 41 combinations.
  it("never changes what the write path sends, for any key of any type", () => {
    const model = getModel("URX44V");
    const offenders: string[] = [];
    for (const [node, arrId, fxIndex] of [
      ["bus.fx1", 681, 0],
      ["bus.fx2", 685, 1],
    ] as const) {
      for (const t of fxEffectTypes(fxIndex)) {
        for (const d of fxParams(t.value)) {
          for (const [shape, stored] of [
            ["not a number", false],
            ["below", (d.rawMin ?? 0) - 1],
            ["above", (d.rawMax ?? 0) + 1],
            // Inside the window and not a raw the unit has. It joins this invariant because
            // the emit rounds as well: what the repair writes down is what was already going
            // out, which is the whole claim of the repair.
            ["fractional", ((d.rawMin ?? 0) + (d.rawMax ?? 0)) / 2 + 0.6],
          ] as const) {
            const plan = emptyPlan("URX44V");
            plan.nodeParams[node] = { fxEffect: { type: t.value, params: { [d.key]: stored } } } as never;
            const sent = (): number | undefined =>
              planToCommands(model, plan).find((c) => c.paramId === arrId && c.y === d.slot)?.vdValue;
            const before = sent();
            applyParamRange(plan, paramRangeProblems(plan));
            const where = `${node} type ${t.value} ${d.key} (${shape})`;
            if (sent() !== before) offenders.push(`${where}: ${before} -> ${sent()}`);
            // …and the repair settles: a second load finds nothing left to do.
            if (paramRangeProblems(plan).length) offenders.push(`${where}: still reported after repair`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // The half a same-type sweep cannot see: a key stored under one type and read under another.
  // Dropping a non-numeric leaf rather than writing one type's default is what makes the later
  // selection land on ITS default instead of the one that happened to be repaired in.
  it("leaves a later type selection on its own default", () => {
    const model = getModel("URX44V");
    const plan = emptyPlan("URX44V");
    // Saved under Rev-X Hall, whose reverbTime default is not Room's.
    plan.nodeParams["bus.fx1"] = { fxEffect: { type: 0, params: { reverbTime: false } } } as never;
    applyParamRange(plan, paramRangeProblems(plan));
    plan.nodeParams["bus.fx1"]!.fxEffect!.type = 1; // Rev-X Room
    const slot = fxParams(1).find((d) => d.key === "reverbTime")!;
    expect(planToCommands(model, plan).find((c) => c.paramId === 681 && c.y === slot.slot)?.vdValue).toBe(slot.def);
  });

  // The three shapes no descriptor describes: the effect object itself, its parameter map, and
  // its type. The sanitiser keeps a boolean and a non-empty object or array under any key —
  // node params legitimately carry toggles and groups — and every reader below then treats the
  // effect, or its whole parameter map, as absent. So a document can lose a channel's worth of
  // raws, or all thirteen of its addresses, with the load saying nothing. Each is measured
  // against the SAME document with the key simply left out: the repair has to land on the plan
  // that says what this one turned out to say.
  //
  // One of them moves the wire, in the safe direction: an unreadable effect object that happens
  // to be TRUTHY reaches the emit and writes thirteen factory defaults over whatever the unit
  // holds, from a value that says nothing. Dropping it leaves the channel alone, which is what
  // the plan format's silence means. The other three land on the same wire they were already on.
  it("reports an unreadable effect, parameter map or type, and repairs to the plan without it", () => {
    const model = getModel("URX44V");
    const wire = (plan: Plan): string =>
      planToCommands(model, plan)
        .map((c) => `${c.paramId}/${c.x}/${c.y}=${c.vdValue}`)
        .join("\n");
    const control = (fx: unknown): Plan => {
      const plan = emptyPlan("URX44V");
      if (fx !== undefined) plan.nodeParams["bus.fx1"] = { fxEffect: fx } as never;
      return plan;
    };
    const cases: [string, unknown, unknown, string, boolean][] = [
      ["a falsy effect object", false, undefined, "fxEffect", false],
      ["a truthy effect object", [{}], undefined, "fxEffect", true],
      ["the parameter map", { type: 0, level: 50, params: false }, { type: 0, level: 50 }, "params", false],
      ["the type", { type: 999, level: 50 }, { level: 50 }, "type", false],
    ];
    for (const [name, bad, good, key, movesWire] of cases) {
      const plan = control(bad);
      const before = wire(plan);
      expect(
        paramRangeProblems(plan).map((p) => [p.key, p.action]),
        name,
      ).toEqual([[key, "drop"]]);
      applyParamRange(plan, paramRangeProblems(plan));
      expect(wire(plan), name).toBe(wire(control(good)));
      expect(wire(plan) !== before, name).toBe(movesWire);
      // …and it settles: a second load finds nothing left to do.
      expect(paramRangeProblems(plan), name).toEqual([]);
    }
  });

  // A FRACTIONAL raw sits inside the window, so the window alone passes it through — while a
  // raw is a broker integer and every one of these controls steps by one, so 35.6 names no
  // setting the unit has. It is ROUNDED, not dropped: unlike a boolean it has a numeric
  // neighbour, and dropping it hands the key to the type's own default instead.
  //
  // The value is chosen so the two answers differ. `delayLpf` rounds to 36 and defaults to
  // 110, which is 118 Hz against 8.50 kHz — a case whose default happens to equal its rounded
  // value (revxHpf 3.5, def 4) cannot tell a drop from a bound, and one written that way is
  // why this reads as it does now.
  it("rounds a fractional raw rather than handing the key to the type's default", () => {
    const model = getModel("URX44V");
    const lpf = fxParams(1024).find((d) => d.key === "delayLpf")!;
    expect(lpf.def, "the case needs a default that is not the rounded value").not.toBe(36);

    const plan = emptyPlan("URX44V");
    plan.nodeParams["bus.fx2"] = { fxEffect: { type: 1024, params: { delayLpf: 35.6 } } };
    expect(paramRangeProblems(plan).map((p) => [p.key, p.action, p.bound])).toEqual([["delayLpf", "bound", 36]]);
    applyParamRange(plan, paramRangeProblems(plan));
    expect(plan.nodeParams["bus.fx2"]?.fxEffect?.params?.delayLpf).toBe(36);
    // …and the row reads the rounded raw rather than the default the drop would have left.
    expect(lpf.format!(36, {})).not.toBe(lpf.format!(lpf.def, {}));
    // The wire agrees with both, before the repair as well as after: the emit rounds too, so
    // the repair moves no value — it only writes down what was already being sent.
    const sent = (p: typeof plan): number | undefined =>
      planToCommands(model, p).find((c) => c.paramId === 685 && c.y === lpf.slot)?.vdValue;
    expect(sent(plan)).toBe(36);
    const raw = emptyPlan("URX44V");
    raw.nodeParams["bus.fx2"] = { fxEffect: { type: 1024, params: { delayLpf: 35.6 } } };
    expect(sent(raw)).toBe(36);
    // …and the integer beside it is untouched, so this is the fraction and not the window.
    const kept = emptyPlan("URX44V");
    kept.nodeParams["bus.fx2"] = { fxEffect: { type: 1024, params: { delayLpf: 36 } } };
    expect(paramRangeProblems(kept)).toEqual([]);
  });

  // An effect object that IS an object is left alone however little it carries: an empty one
  // says every value is the effect's own default, which is a document this app writes itself.
  it("leaves an empty effect object alone", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["bus.fx1"] = { fxEffect: {} };
    expect(paramRangeProblems(plan)).toEqual([]);
  });

  it("neither refuses the document nor asks the operator about it", () => {
    const [problem] = paramRangeProblems(fx2({ delayLpf: 0 }));
    expect(isRefusal(problem)).toBe(false);
    expect(needsDecision(problem)).toBe(false);
  });

  it("reaches the loader, which reads the one funnel rather than each check", () => {
    // planProblems is the single seat every load path takes; a check outside it is one a
    // load path can pick up half of, which is what the funnel exists to prevent.
    expect(planProblems(getModel("URX44V"), fx2({ delayLpf: 0 })).map((p) => p.reason)).toEqual(["paramRange"]);
  });
});

describe("planProblems", () => {
  const u44v = getModel("URX44V");
  const refused = (plan: ReturnType<typeof emptyPlan>) => planProblems(u44v, plan).filter(isRefusal);

  it("refuses a wire whose source resolves to no rule at all", () => {
    const plan = emptyPlan("URX44V");
    const from = ref("nope", "out");
    const to = ref("ch1", "in");
    plan.connections.push({ from, to, kind: "source" });
    expect(refused(plan)).toEqual([{ from, to, reason: "noRule" }]);
  });

  it("keeps a slot collision on the warning side, with no refusal to hide behind", () => {
    const plan = emptyPlan("URX44V");
    const [options] = [...INPUT_SLOTS.values()];
    plan.nodeParams["ch1"] = { insertFx: options[0].value };
    plan.nodeParams["ch3"] = { insertFx: options[0].value };
    expect(refused(plan)).toEqual([]);
    expect(planProblems(u44v, plan).map((p) => p.reason)).toEqual(["insertFxSlot"]);
  });
});
