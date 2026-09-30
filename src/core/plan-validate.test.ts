import { describe, it, expect } from "vitest";
import {
  applyBooleanParams,
  applyLinkedSendPans,
  applyLoadRepairs,
  applyParamRange,
  applyRequiredSources,
  booleanParamProblems,
  insertFxPairProblems,
  insertFxSlotProblems,
  isRefusal,
  linkedSendPanProblems,
  needsDecision,
  paramRangeProblems,
  planProblems,
  prepareLoadedPlan,
  requiredSourceProblems,
} from "./plan-validate";
import { trackCountAtRate } from "./constraints";
import { fxEffectTypes, fxParams } from "./control/fx-effect";
import { planToCommands } from "./control/translate";
import { sendPansToSources, validatePlan } from "./routing";
import { deserialize, emptyPlan, ensureFixedConnections, fixedConnection, PLAN_VERSION, serialize } from "./plan";
import type { Plan, PlanConnection } from "./plan";
import { getModel, MODEL_IDS } from "../models";
import { defaultPlan } from "../models/initial-state";
import { ref } from "../models/types";
import {
  BUS_TYPE_FIXED,
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

  // A linked pair holds ONE insert effect between its two channels. A document that gives
  // the two members different values describes no state the unit can be in — it keeps one
  // selector, one bypass and one engine for the pair — and nothing downstream repairs it:
  // `translate` emits each channel from its own params. So it is refused, not warned about.
  describe("a STEREO-linked pair that disagrees with itself", () => {
    const linked = (ch1: Record<string, unknown>, ch2: Record<string, unknown>): Plan => {
      const plan = emptyPlan("URX44V");
      plan.nodeParams["ch1"] = { stereoLink: true, ...ch1 };
      plan.nodeParams["ch2"] = { ...ch2 };
      return plan;
    };
    const AMP = INSERT_FX_OPTIONS.find((o) => o.label === "Clean")!.value;
    const COMP_H = INSERT_FX_OPTIONS.find((o) => o.label === "Compander-H")!.value;
    const COMP_S = INSERT_FX_OPTIONS.find((o) => o.label === "Compander-S")!.value;

    it.each([
      ["the selector", { insertFx: COMP_H }, { insertFx: COMP_S }, ["insertFx"]],
      ["the bypass", { insertFx: COMP_H, insertFxOn: true }, { insertFx: COMP_H, insertFxOn: false }, ["insertFxOn"]],
      [
        // Slot 6 is the compander's Threshold — a slot the write SENDS. Slot 0 is the
        // engine's own type id and never goes out, so a pair differing only there is
        // covered below as a state the unit can satisfy.
        "the engine values",
        { insertFx: COMP_H, insertFxParams: { "6": -1200 } },
        { insertFx: COMP_H, insertFxParams: { "6": -1300 } },
        ["insertFxParams"],
      ],
      // The member the document leaves out is filled with the factory value, so omitting
      // one side is a disagreement too — and the report has to say so, since "I only set
      // it on one channel" is the likeliest way to author this by hand.
      ["one side omitted", { insertFx: COMP_H, insertFxOn: true }, {}, ["insertFx", "insertFxOn"]],
      // Several at once: every disagreeing key is named, not just the first.
      [
        "all three",
        { insertFx: AMP, insertFxOn: true, insertFxParams: { "6": 1 } },
        { insertFx: COMP_H },
        ["insertFx", "insertFxOn", "insertFxParams"],
      ],
    ])("refuses the document when %s disagrees", (_name, ch1, ch2, keys) => {
      const problems = insertFxPairProblems(u44v, linked(ch1, ch2));
      expect(problems).toHaveLength(1);
      expect(problems[0].nodes).toEqual(["ch1", "ch2"]);
      expect(problems[0].keys).toEqual(keys);
      // A refusal, not a decision: there is no state of the unit that satisfies it.
      expect(isRefusal(problems[0])).toBe(true);
      expect(needsDecision(problems[0])).toBe(false);
      expect(planProblems(u44v, linked(ch1, ch2))).toContainEqual(problems[0]);
    });

    it.each([
      ["both members agree", { insertFx: COMP_H, insertFxOn: true }, { insertFx: COMP_H, insertFxOn: true }],
      // Both omitted: the fill gives each the same factory value, so there is nothing to
      // disagree about — the everyday plan that simply says nothing about insert FX.
      ["neither member names one", {}, {}],
      // One side omitted and the other holds exactly what the fill would supply.
      ["the named side matches the factory value", { insertFx: INSERT_FX_NONE, insertFxOn: false }, {}],
      [
        "the engine values match",
        { insertFx: COMP_H, insertFxParams: { "0": 12 } },
        { insertFx: COMP_H, insertFxParams: { "0": 12 } },
      ],
    ])("says nothing when %s", (_name, ch1, ch2) => {
      expect(insertFxPairProblems(u44v, linked(ch1, ch2))).toEqual([]);
    });

    // Documents that LOOK different and reach the unit as ONE state. Each is a refusal the
    // stored-value comparison this replaced would have made, and each would have been a load
    // the operator could not explain.
    it.each([
      // An off-menu selector is No Effect on the wire, which is what the partner holds.
      ["an off-menu selector beside No Effect", { insertFx: 4242 }, { insertFx: INSERT_FX_NONE }],
      // The bypass goes out as `? 1 : 0`, so every truthy value is one bypass.
      ["a boolean bypass beside a number", { insertFx: COMP_H, insertFxOn: true }, { insertFx: COMP_H, insertFxOn: 1 }],
      // With No Effect selected the unit ignores the switch and the write does not send it.
      [
        "two bypasses under No Effect",
        { insertFx: INSERT_FX_NONE, insertFxOn: true },
        { insertFx: INSERT_FX_NONE, insertFxOn: false },
      ],
      // Slot 0 is the engine's type id; the write skips it.
      [
        "an engine value the write skips",
        { insertFx: COMP_H, insertFxParams: { "0": 12 } },
        { insertFx: COMP_H, insertFxParams: { "0": 13 } },
      ],
      // …and a value under a family the selector does not name is not sent either.
      [
        "an engine value of another family",
        { insertFx: COMP_H, insertFxParams: { "amp:6": 12 } },
        { insertFx: COMP_H, insertFxParams: { "amp:6": 99 } },
      ],
    ])("says nothing about %s", (_name, ch1, ch2) => {
      expect(insertFxPairProblems(u44v, linked(ch1, ch2))).toEqual([]);
    });

    // The control for every case above: an UNLINKED pair holding two different effects is
    // two independent channels. Without it a check that fired on any pair would pass them.
    it("says nothing about a pair that is not linked", () => {
      const plan = emptyPlan("URX44V");
      plan.nodeParams["ch1"] = { insertFx: COMP_H, insertFxOn: true };
      plan.nodeParams["ch2"] = { insertFx: COMP_S, insertFxOn: false };
      expect(insertFxPairProblems(u44v, plan)).toEqual([]);
    });

    // …and the OTHER pair of the same model is judged on its own flag.
    it("judges each pair by its own Signal Type", () => {
      const plan = emptyPlan("URX44V");
      plan.nodeParams["ch3"] = { stereoLink: true, insertFx: COMP_H };
      plan.nodeParams["ch4"] = { insertFx: COMP_S };
      const problems = insertFxPairProblems(u44v, plan);
      expect(problems).toHaveLength(1);
      expect(problems[0].nodes).toEqual(["ch3", "ch4"]);
    });

    it("covers every model that has a pair", () => {
      for (const id of MODEL_IDS) {
        const model = getModel(id);
        const [a, b] = model.channelPairs[0];
        const plan = emptyPlan(id);
        plan.nodeParams[a] = { stereoLink: true, insertFx: COMP_H };
        plan.nodeParams[b] = { insertFx: COMP_S };
        expect(
          insertFxPairProblems(model, plan).map((p) => p.nodes),
          id,
        ).toEqual([[a, b]]);
      }
    });
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
          for (const stored of [
            -9999,
            9999,
            0.6,
            1.6,
            14.6,
            // Far enough outside that every option is the same distance from it, which is
            // where a nearest-of search stops discriminating at all.
            Number.MAX_VALUE,
            -Number.MAX_VALUE,
            ((d.rawMin ?? 0) + (d.rawMax ?? 0)) / 2 + 0.6,
          ]) {
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

  // Array slots 1 and 2 leave a document at the LOAD, at every version. The app neither reads
  // nor writes either, so a value there addresses nothing — and left in place it would survive
  // the load unreported (no window checks it), be written back into every later save, and then
  // be dropped without a word by the first device read, which rebuilds the section from what it
  // read. Asked of the whole funnel rather than of the migration alone, since what has to hold
  // is that a document loses it, and asked with the siblings as the control: the drop is that
  // key and not the section.
  // …and what a build that still carries a field would do with the result. A version-2 writer
  // sends the catalogue's 100 to slot 2 for an ABSENT level, and a version-3 writer sends 1 to
  // slot 1 for an absent on, so a file written here and tagged lower would load in such a build
  // and move a unit holding anything else at those addresses. The version is what stops it:
  // that build refuses a document tagged higher than its own.
  it("writes a version this change's own removal is safe under", () => {
    expect(PLAN_VERSION).toBe(4);
    const doc = JSON.parse(serialize(defaultPlan("URX44V"))) as {
      version: number;
      nodeParams: Record<string, { fxEffect?: Record<string, unknown> }>;
    };
    expect(doc.version, "a fresh save carries it").toBe(PLAN_VERSION);
    // …and neither FX section it writes carries either key, which is what makes the tag the
    // only signal an older reader gets. Read per section rather than over the whole document:
    // `level` and `on` are live keys elsewhere — every bus fader and channel ON, the oscillator,
    // each 1-knob EQ.
    for (const node of ["bus.fx1", "bus.fx2"]) {
      const fx = doc.nodeParams[node]?.fxEffect;
      expect(fx, `the premise: ${node} carries a section`).toBeTypeOf("object");
      expect(fx, node).not.toHaveProperty("level");
      expect(fx, node).not.toHaveProperty("on");
    }
  });

  it.each([
    ["slot 1", "on", false],
    ["slot 2", "level", 100],
  ] as const)("drops the effect array's %s from a loaded document, and nothing beside it", (_slot, key, value) => {
    for (let version = 1; version <= PLAN_VERSION; version++) {
      const doc = JSON.stringify({
        format: "urx-router-plan",
        version,
        modelId: "URX44V",
        connections: [],
        nodeParams: { "bus.fx1": { fxEffect: { type: 0, [key]: value, params: { revxHpf: 9 } } } },
      });
      const fx = deserialize(doc).nodeParams["bus.fx1"]?.fxEffect as Record<string, unknown> | undefined;
      expect(fx, `the premise: the section survives a version-${version} load`).toBeTypeOf("object");
      expect(fx, `version ${version}`).not.toHaveProperty(key);
      // The control: the keys beside it are untouched, so the drop is that key rather than the
      // section being rebuilt or emptied.
      expect(fx, `version ${version}`).toEqual({ type: 0, params: { revxHpf: 9 } });
      // …and no problem is reported for it, because there is nothing to report: the value
      // addressed nothing and the document is not being repaired, it is being read.
      expect(paramRangeProblems(deserialize(doc)), `version ${version}`).toEqual([]);
    }
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
  // raws, or that channel's whole address set, with the load saying nothing. Each is measured
  // against the SAME document with the key simply left out: the repair has to land on the plan
  // that says what this one turned out to say.
  //
  // One of them moves the wire of the plan compared here, which is built without the load's
  // factory fill: an unreadable effect object that happens to be TRUTHY reaches the emit as that
  // channel's factory defaults, and dropped it emits nothing for the channel. The other three land
  // on the same wire they were already on. Through a real load the dropped key is completed from
  // the model's factory values like any other omission, so the write sends the channel's factory
  // effect and its confirm names the strip (main.device.test.ts).
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
      ["the parameter map", { type: 0, on: false, params: false }, { type: 0, on: false }, "params", false],
      ["the type", { type: 999, on: false }, { on: false }, "type", false],
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

// STREAMING's list on the unit has no None, so a document that gives it no wire is completed
// with the STEREO a new plan carries, and the load says so. Any wire into it counts, whatever
// kind it was written under — the install restates the kind — and a wire the sanitiser drops
// does not.
describe("requiredSourceProblems", () => {
  const STEREO_TO_STREAM = { from: "bus.stereo:out", to: "bus.stream:in", kind: "source" };
  const doc = (connections: unknown): Plan =>
    deserialize(JSON.stringify({ format: "urx-router-plan", version: PLAN_VERSION, modelId: "URX44V", connections }));
  const u44v = getModel("URX44V");

  it.each(MODEL_IDS)("%s: completes a document with no STREAMING wire with STEREO, and says so", (id) => {
    const m = getModel(id);
    const plan: Plan = { ...emptyPlan(id), connections: [] };
    const problems = requiredSourceProblems(m, plan);
    expect(problems).toEqual([{ reason: "requiredSource", from: "bus.stereo:out", to: "bus.stream:in" }]);
    expect(planProblems(m, plan)).toEqual(problems);
    applyRequiredSources(m, plan, problems);
    expect(plan.connections).toEqual([STEREO_TO_STREAM]);
    expect(requiredSourceProblems(m, plan)).toEqual([]);
    // What the write then sends is that source, and never NONE.
    const sent = planToCommands(m, plan).filter((c) => c.name === "STREAM_SRC_L" || c.name === "STREAM_SRC_R");
    expect(sent.map((c) => c.vdValue)).toEqual([(0x80000000 | 256) >>> 0, (0x80000000 | 257) >>> 0]);
  });

  it("leaves a document that names a STREAMING source alone, whichever it names", () => {
    for (const from of ["bus.stereo:out", "bus.mix1:out", "bus.mix2:out"]) {
      expect(requiredSourceProblems(u44v, doc([{ from, to: "bus.stream:in", kind: "source" }])), from).toEqual([]);
    }
  });

  it("counts a wire written under the wrong kind, which the install restates", () => {
    expect(requiredSourceProblems(u44v, doc([{ from: "bus.mix1:out", to: "bus.stream:in", kind: "send" }]))).toEqual(
      [],
    );
  });

  it("does not count a wire the sanitiser drops", () => {
    const plan = doc([{ from: "bus.mix1:out", to: "bus.stream:in", kind: "source", params: "x" }]);
    expect(plan.connections).toEqual([]);
    expect(requiredSourceProblems(u44v, plan).map((p) => p.to)).toEqual(["bus.stream:in"]);
  });

  it("finds nothing in a new plan or the factory plan", () => {
    for (const id of MODEL_IDS) {
      expect(requiredSourceProblems(getModel(id), emptyPlan(id)), id).toEqual([]);
      expect(requiredSourceProblems(getModel(id), defaultPlan(id)), id).toEqual([]);
    }
  });

  it("neither refuses the document nor asks the operator about it", () => {
    const [problem] = requiredSourceProblems(u44v, doc([]));
    expect(problem).toBeDefined();
    expect(isRefusal(problem)).toBe(false);
    expect(needsDecision(problem)).toBe(false);
  });
});

// While a MIX bus's Pan Link is on, the unit holds every send pan into it at its source's own pan /
// balance and the write sends none of them, so a document carrying another value is set to the
// source's on load — the value `sendPansToSources` sets when the link turns on — and the load says
// so. An absent pan, send or main path counts as 0, the way every reader counts it.
describe("linkedSendPanProblems", () => {
  const u44v = getModel("URX44V");
  const conn = (from: string, to: string, pan?: number): PlanConnection => ({
    from,
    to,
    kind: "send",
    ...(pan === undefined ? {} : { params: { pan } }),
  });
  const main = (src: string, pan?: number) => conn(ref(src, "out"), ref("bus.stereo", "in"), pan);
  const send = (src: string, bus: string, pan?: number) => conn(ref(src, "out"), ref(bus, "in"), pan);
  const doc = (connections: PlanConnection[], nodeParams: Plan["nodeParams"] = { "bus.mix1": { panLink: true } }) => ({
    ...emptyPlan("URX44V"),
    connections,
    nodeParams,
  });
  const found = (plan: Plan) => linkedSendPanProblems(u44v, plan).map((p) => `${p.from} ${p.stored} -> ${p.pan}`);

  it("sets a mono, a stereo and an FX channel's send to its source's own pan, and nothing else", () => {
    const plan = doc(
      [
        main("ch1", -20),
        send("ch1", "bus.mix1", 40),
        main("ch_5_6", 25),
        send("ch_5_6", "bus.mix1", -10),
        main("bus.fx1", -30),
        send("bus.fx1", "bus.mix1", 0),
        // The same source into the MIX that is not linked keeps what it has.
        send("ch1", "bus.mix2", 40),
      ],
      { "bus.mix1": { panLink: true } },
    );
    const problems = linkedSendPanProblems(u44v, plan);
    expect(problems).toEqual([
      { reason: "linkedSendPan", from: "ch1:out", to: "bus.mix1:in", stored: 40, pan: -20 },
      { reason: "linkedSendPan", from: "ch_5_6:out", to: "bus.mix1:in", stored: -10, pan: 25 },
      { reason: "linkedSendPan", from: "bus.fx1:out", to: "bus.mix1:in", stored: 0, pan: -30 },
    ]);
    expect(planProblems(u44v, plan).filter((p) => p.reason === "linkedSendPan")).toEqual(problems);
    applyLinkedSendPans(u44v, plan, problems);
    const pans = (bus: string) =>
      Object.fromEntries(plan.connections.filter((c) => c.to === ref(bus, "in")).map((c) => [c.from, c.params?.pan]));
    expect(pans("bus.mix1")).toEqual({ "ch1:out": -20, "ch_5_6:out": 25, "bus.fx1:out": -30 });
    expect(pans("bus.mix2")).toEqual({ "ch1:out": 40 });
    expect(linkedSendPanProblems(u44v, plan)).toEqual([]);
  });

  // Each member takes the pan on its own main path, which is its own position in PAN mode and
  // the pair's one balance in BAL.
  it.each([
    ["PAN", PAN_BAL_PAN, -63, 63],
    ["BAL", PAN_BAL_BAL, -25, -25],
  ])("sets each member of a STEREO-linked pair in %s to its own main path's pan", (_mode, panBal, a, b) => {
    const plan = doc([main("ch1", a), main("ch2", b), send("ch1", "bus.mix1", 40), send("ch2", "bus.mix1", 40)], {
      ch1: { stereoLink: true, panBal },
      "bus.mix1": { panLink: true },
    });
    applyLinkedSendPans(u44v, plan, linkedSendPanProblems(u44v, plan));
    expect(plan.connections.find((c) => c.from === "ch1:out" && c.to === "bus.mix1:in")?.params?.pan).toBe(a);
    expect(plan.connections.find((c) => c.from === "ch2:out" && c.to === "bus.mix1:in")?.params?.pan).toBe(b);
  });

  it("counts a FIXED MIX whose Pan Link is on", () => {
    const plan = doc([main("ch1", 15), send("ch1", "bus.mix2", -5)], {
      "bus.mix2": { panLink: true, busType: BUS_TYPE_FIXED },
    });
    expect(found(plan)).toEqual(["ch1:out -5 -> 15"]);
  });

  it("reads an absent pan, send or main path as 0", () => {
    expect(found(doc([main("ch1", 30), send("ch1", "bus.mix1")]))).toEqual(["ch1:out undefined -> 30"]);
    expect(found(doc([main("ch1"), send("ch1", "bus.mix1", 20)]))).toEqual(["ch1:out 20 -> 0"]);
    expect(found(doc([send("ch1", "bus.mix1", 20)]))).toEqual(["ch1:out 20 -> 0"]);
    // …and a pair at 0 on both sides is nothing to set, however either is spelled.
    expect(found(doc([main("ch1"), send("ch1", "bus.mix1")]))).toEqual([]);
    expect(found(doc([main("ch1", 0), send("ch1", "bus.mix1")]))).toEqual([]);
    expect(found(doc([send("ch1", "bus.mix1", 0)]))).toEqual([]);
  });

  // The load adds every fixed send a document omits; one into a linked MIX is added carrying the
  // pan, with everything else the fixed seed gives it.
  it("adds a send the document omits, carrying the source's pan", () => {
    const plan = doc([main("ch1", 30)]);
    const problems = linkedSendPanProblems(u44v, plan);
    expect(problems).toEqual([{ reason: "linkedSendPan", from: "ch1:out", to: "bus.mix1:in", pan: 30 }]);
    applyLinkedSendPans(u44v, plan, problems);
    const rule = u44v.rules.find((r) => r.from === "ch1:out" && r.to === "bus.mix1:in")!;
    const seeded = fixedConnection(u44v, rule);
    expect(plan.connections.filter((c) => c.to === "bus.mix1:in")).toEqual([
      { ...seeded, params: { ...seeded.params, pan: 30 } },
    ]);
    // …and the load's own completion then adds nothing in its place.
    const before = plan.connections.length;
    ensureFixedConnections(u44v, plan);
    expect(plan.connections.filter((c) => c.from === "ch1:out" && c.to === "bus.mix1:in")).toHaveLength(1);
    expect(plan.connections.length).toBeGreaterThan(before);
  });

  it("finds nothing for a MIX whose Pan Link is off, absent or not written as true", () => {
    const wires = [main("ch1", -20), send("ch1", "bus.mix1", 40)];
    expect(found(doc(wires, {}))).toEqual([]);
    expect(found(doc(wires, { "bus.mix1": { panLink: false } }))).toEqual([]);
    expect(found(doc(wires, { "bus.mix1": { panLink: 1 as unknown as boolean } }))).toEqual([]);
    // The positive control: the same wires under the link are found.
    expect(found(doc(wires))).toEqual(["ch1:out 40 -> -20"]);
  });

  it("finds nothing in a new plan or the factory plan", () => {
    for (const id of MODEL_IDS) {
      expect(linkedSendPanProblems(getModel(id), emptyPlan(id)), id).toEqual([]);
      expect(linkedSendPanProblems(getModel(id), defaultPlan(id)), id).toEqual([]);
    }
  });

  // The value is the one the link's own edge sets, on every model: the repaired document and the
  // same document with `sendPansToSources` run on each linked MIX hold the same send pans.
  it.each(MODEL_IDS)("%s: sets the value sendPansToSources sets", (id) => {
    const m = getModel(id);
    const base = defaultPlan(id);
    base.nodeParams["bus.mix1"] = { ...base.nodeParams["bus.mix1"], panLink: true };
    base.nodeParams["bus.mix2"] = { ...base.nodeParams["bus.mix2"], panLink: true, busType: BUS_TYPE_FIXED };
    let n = 0;
    for (const c of base.connections) {
      if (c.kind !== "send") continue;
      n += 7;
      c.params = { ...c.params, pan: (n % 127) - 63 };
    }
    const repaired = structuredClone(base);
    const problems = linkedSendPanProblems(m, repaired);
    expect(problems.length, "the premise: the document disagrees with the unit").toBeGreaterThan(0);
    applyLinkedSendPans(m, repaired, problems);
    const edged = structuredClone(base);
    for (const bus of ["bus.mix1", "bus.mix2"]) sendPansToSources(edged, bus);
    const pans = (p: Plan) => p.connections.map((c) => `${c.from} ${c.to} ${c.params?.pan ?? 0}`);
    expect(pans(repaired)).toEqual(pans(edged));
  });

  it("neither refuses the document nor asks the operator about it", () => {
    const [problem] = linkedSendPanProblems(u44v, doc([main("ch1", 30)]));
    expect(problem).toBeDefined();
    expect(isRefusal(problem)).toBe(false);
    expect(needsDecision(problem)).toBe(false);
  });
});

// A number written where the factory values hold an on/off is sent as on unless it is 0, and the
// load converts it to that on/off so every reader of the plan holds a boolean there.
describe("booleanParamProblems", () => {
  /** Every on/off leaf of `value`, dotted, an array element by its index. */
  const booleanLeaves = (value: unknown, path: string[] = [], out: string[] = []): string[] => {
    if (typeof value === "boolean") out.push(path.join("."));
    else if (Array.isArray(value)) value.forEach((v, i) => booleanLeaves(v, [...path, String(i)], out));
    else if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value)) booleanLeaves(v, [...path, k], out);
    return out;
  };
  const at = (np: unknown, path: string): unknown =>
    path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], np);
  /** Every on/off leaf of the plan written as the next of 1, 0, 2, -1, 0.5, in place. */
  const numbersEverywhere = (plan: Plan): { node: string; path: string; n: number }[] => {
    const written: { node: string; path: string; n: number }[] = [];
    const cycle = [1, 0, 2, -1, 0.5];
    for (const [node, np] of Object.entries(plan.nodeParams))
      for (const path of booleanLeaves(np)) {
        const keys = path.split(".");
        const holder = (keys.length > 1 ? at(np, keys.slice(0, -1).join(".")) : np) as Record<string, unknown>;
        const n = cycle[written.length % cycle.length];
        holder[keys[keys.length - 1]] = n;
        written.push({ node, path, n });
      }
    return written;
  };

  // The set is read off the factory values, so it follows a new on/off the day the factory
  // carries one. Spelled out here so the change shows in a diff and is looked at: these are the
  // NodeParams on/off fields, an array element's written once.
  it("reads its on/off leaves off the factory values: the NodeParams on/off fields", () => {
    const patterns = new Set<string>();
    for (const id of MODEL_IDS)
      for (const np of Object.values(defaultPlan(id).nodeParams))
        for (const path of booleanLeaves(np)) patterns.add(path.replace(/\.\d+(?=\.|$)/g, "[]"));
    expect([...patterns].sort()).toEqual(
      [
        "on",
        "hpf",
        "insertFxOn",
        "stereoLink",
        "panLink",
        "eqOn",
        "eqOneKnob.on",
        "eqBands[].on",
        "comp.autoMakeup",
        "comp.oneKnob",
        "ssmcs.on",
        "ssmcs.sc.on",
        "ssmcs.eq.low.on",
        "ssmcs.eq.mid.on",
        "ssmcs.eq.high.on",
        "duckerOn",
        "gateOn",
        "compOn",
        "phantom",
        "phase",
        "phaseL",
        "phaseR",
        "clipSafe",
        "hiZ",
        "osc.on",
        "cueInterrupt",
        "mono",
        "delay.on",
      ].sort(),
    );
  });

  it.each(MODEL_IDS)("%s: converts every on/off leaf written as a number, 0 to off and anything else to on", (id) => {
    const m = getModel(id);
    const plan = deserialize(serialize(defaultPlan(id)));
    const written = numbersEverywhere(plan);
    expect(written.length, "the premise: the factory carries on/off leaves").toBeGreaterThan(0);
    const problems = booleanParamProblems(m, plan);
    expect(problems.map((p) => [p.node, p.path, p.stored, p.value])).toEqual(
      written.map((w) => [w.node, w.path, w.n, w.n !== 0]),
    );
    applyBooleanParams(plan, problems);
    for (const w of written) expect(at(plan.nodeParams[w.node], w.path), `${w.node}.${w.path}`).toBe(w.n !== 0);
    expect(booleanParamProblems(m, plan)).toEqual([]);
  });

  it("leaves a boolean, a number where the factory holds no on/off, and a leaf it does not carry alone", () => {
    const u44v = getModel("URX44V");
    const plan = defaultPlan("URX44V");
    expect(booleanParamProblems(u44v, plan)).toEqual([]);
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, gain: 1 };
    // ch2 is the pair's secondary, which carries no Signal Type of its own.
    plan.nodeParams.ch2 = { ...plan.nodeParams.ch2, stereoLink: 1 as unknown as boolean };
    // An EQ band past the four the factory carries.
    plan.nodeParams.ch3 = { ...plan.nodeParams.ch3, eqBands: [...plan.nodeParams.ch3!.eqBands!, { on: 1 } as never] };
    expect(booleanParamProblems(u44v, plan)).toEqual([]);
    // The positive control: the same number at an on/off the factory carries is found.
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, hpf: 1 as unknown as boolean };
    expect(booleanParamProblems(u44v, plan)).toEqual([
      { reason: "booleanParam", node: "ch1", path: "hpf", stored: 1, value: true },
    ]);
  });

  // The other checks read the document the way the load leaves it: a link or a pair written as 1
  // is linked to them, as it is to the write.
  it("hands the other checks the document converted", () => {
    const u44v = getModel("URX44V");
    const linked = defaultPlan("URX44V");
    linked.nodeParams["bus.mix1"] = { ...linked.nodeParams["bus.mix1"], panLink: 1 as unknown as boolean };
    linked.connections.find((c) => c.from === "ch1:out" && c.to === "bus.stereo:in")!.params = { pan: -20 };
    linked.connections.find((c) => c.from === "ch1:out" && c.to === "bus.mix1:in")!.params = { pan: 40 };
    expect(linkedSendPanProblems(u44v, linked), "the premise: the check reads 1 as unlinked").toEqual([]);
    expect(planProblems(u44v, linked).filter((p) => p.reason === "linkedSendPan")).toHaveLength(1);

    const [compander] = INPUT_SLOTS.get("compander")!;
    const pair = defaultPlan("URX44V");
    pair.nodeParams.ch1 = { ...pair.nodeParams.ch1, stereoLink: 1 as unknown as boolean, insertFx: compander.value };
    expect(insertFxPairProblems(u44v, pair), "the premise: the check reads 1 as unlinked").toEqual([]);
    expect(planProblems(u44v, pair).filter((p) => p.reason === "insertFxPair")).toHaveLength(1);
    // …and the document itself is not converted by being asked about.
    expect(pair.nodeParams.ch1!.stereoLink).toBe(1);
  });

  it("neither refuses the document nor asks the operator about it", () => {
    const plan = defaultPlan("URX44V");
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, on: 0 as unknown as boolean };
    const [problem] = booleanParamProblems(getModel("URX44V"), plan);
    expect(problem).toBeDefined();
    expect(isRefusal(problem)).toBe(false);
    expect(needsDecision(problem)).toBe(false);
  });
});

// The loader's order, in the one function it calls: the repairs, on/off conversion first, then
// the completion from the factory values, then the rate rule.
describe("prepareLoadedPlan", () => {
  const u44v = getModel("URX44V");
  const load = (plan: Plan) => prepareLoadedPlan(u44v, plan, planProblems(u44v, plan));

  it("converts an on/off before the HI-Z rule bounds it", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams.ch3 = { hiZ: 1 as unknown as boolean, phantom: 1 as unknown as boolean };
    const repairs = load(plan);
    expect(repairs.booleans.map((p) => p.path).sort()).toEqual(["hiZ", "phantom"]);
    expect(repairs.ranged.map((p) => [p.key, p.action])).toEqual([["phantom", "bound"]]);
    expect(plan.nodeParams.ch3!.hiZ).toBe(true);
    expect(plan.nodeParams.ch3!.phantom).toBe(false);
  });

  it("completes a value a repair dropped from the factory values, where the repairs alone leave it absent", () => {
    const factoryType = defaultPlan("URX44V").nodeParams["bus.fx1"]?.fxEffect?.type;
    expect(factoryType, "the premise: the factory selects an effect").toBeDefined();
    const doc = (): Plan => {
      const plan = emptyPlan("URX44V");
      plan.nodeParams["bus.fx1"] = { fxEffect: { type: 999, on: false } } as never;
      return plan;
    };
    const repaired = doc();
    applyLoadRepairs(u44v, repaired, planProblems(u44v, repaired));
    expect(repaired.nodeParams["bus.fx1"]?.fxEffect?.type).toBeUndefined();
    const loaded = doc();
    load(loaded);
    expect(loaded.nodeParams["bus.fx1"]?.fxEffect?.type).toBe(factoryType);
  });

  it("puts a Track Count the completion supplies back through the rate rule", () => {
    const factory = defaultPlan("URX44V").nodeParams["out.sdrec"]?.sdRecTrackCount;
    const atRate = trackCountAtRate(factory, 96000);
    expect(atRate, "the premise: the factory count does not fit the rate").not.toBe(factory);
    const plan = { ...emptyPlan("URX44V"), sampleRate: 96000 };
    delete plan.nodeParams["out.sdrec"];
    load(plan);
    expect(plan.nodeParams["out.sdrec"]?.sdRecTrackCount).toBe(atRate);
  });

  it("applies and returns each kind of repair the funnel reported, and leaves a refusal alone", () => {
    const plan: Plan = {
      ...emptyPlan("URX44V"),
      connections: [
        { from: "ch1:out", to: "bus.stereo:in", kind: "send", params: { pan: -20 } },
        { from: "ch1:out", to: "bus.mix1:in", kind: "send", params: { pan: 40 } },
        { from: "nope:out", to: "ch1:in", kind: "send" },
      ],
      nodeParams: { "bus.mix1": { panLink: 1 as unknown as boolean } },
    };
    const problems = planProblems(u44v, plan);
    expect(problems.filter(isRefusal), "the premise: the funnel reports a refusal").toHaveLength(1);
    const repairs = prepareLoadedPlan(u44v, plan, problems);
    expect(repairs.booleans.map((p) => `${p.node}.${p.path}`)).toEqual(["bus.mix1.panLink"]);
    expect(repairs.ranged).toEqual([]);
    expect(repairs.supplied.map((p) => `${p.from} -> ${p.to}`)).toEqual(["bus.stereo:out -> bus.stream:in"]);
    expect(repairs.linkedPans.map((p) => `${p.from} ${p.stored} -> ${p.pan}`)).toEqual(["ch1:out 40 -> -20"]);
    expect(plan.nodeParams["bus.mix1"]!.panLink).toBe(true);
    expect(plan.connections.find((c) => c.from === "ch1:out" && c.to === "bus.mix1:in")?.params?.pan).toBe(-20);
    expect(plan.connections.some((c) => c.to === "bus.stream:in")).toBe(true);
    expect(plan.connections.some((c) => c.from === "nope:out")).toBe(true);
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

  // A USB output's mono pair is two wires into one single-input receiver, and a document
  // holding it opens; any other second wire into a USB output is refused, every wire named.
  it("opens a document holding a USB output's mono pair, and refuses every other second wire there", () => {
    const into = (...froms: string[]) => {
      const plan = emptyPlan("URX44V");
      for (const f of froms)
        plan.connections.push({ from: ref(f, "out"), to: ref("out.usbmain_b", "in"), kind: "patch" });
      return refused(plan).map((p) => `${p.reason} ${"from" in p ? p.from : ""}`);
    };
    expect(into("ch3", "ch4")).toEqual([]);
    expect(into("ch4", "ch3")).toEqual([]);
    expect(into("ch2", "ch3")).toEqual(["monoPairOnly ch2:out", "monoPairOnly ch3:out"]);
    expect(into("ch1", "ch2", "ch3")).toEqual(["monoPairOnly ch1:out", "monoPairOnly ch2:out", "monoPairOnly ch3:out"]);
    expect(into("bus.mix1", "ch4")).toEqual(["monoPairOnly bus.mix1:out", "monoPairOnly ch4:out"]);
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
