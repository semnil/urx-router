import { describe, expect, it } from "vitest";
import { getModel } from "../../models";
import { emptyPlan, ensureFixedConnections, type Plan } from "../plan";
import { insertFxHoldKeys, readIntoPlan, type ReadbackResult } from "./readback";
import {
  applyPatchInContext,
  clonePlanState,
  diffPlans,
  nodeParamContestKey,
  nodeParamContestPath,
  PlanWriteWitness,
} from "../plan-history";

// readIntoPlan is the contest between a device read and the operator's hands: the read
// samples the unit before a gesture exists, resolves hundreds of milliseconds to tens of
// seconds later, and used to assign whole nodes over whatever had happened meanwhile.
// These pin the merge's two directions (device truth lands; an edit made during the read
// wins over it) and the two ways it can find nothing to land on.

const model = getModel("URX44V");

function basePlan(): Plan {
  const plan = emptyPlan("URX44V");
  ensureFixedConnections(model, plan);
  return plan;
}

const OK: ReadbackResult = { applied: 1, errors: [], unreadNodes: new Set() };

/** The ch1 main fader is its fixed STEREO send level — the path a fader drag takes. */
function ch1Send(plan: Plan) {
  const conn = plan.connections.find((c) => c.from === "ch1:out" && c.to === "bus.stereo:in");
  if (!conn) throw new Error("expected a ch1 STEREO send connection");
  return conn;
}
const ch1Level = (plan: Plan): number | undefined => ch1Send(plan).params?.level;

describe("readIntoPlan", () => {
  it("lands the device's values and lets an edit made during the read win over them", async () => {
    const plan = basePlan();
    ch1Send(plan).params = { ...ch1Send(plan).params, level: -10 };
    plan.nodeParams.ch2 = { ...plan.nodeParams.ch2, hpf: false };

    const merged = await readIntoPlan(
      () => plan,
      async (into) => {
        // The device answers with what it held before the gesture below, on the key the
        // operator is about to move, and with a value of its own on a key they do not.
        ch1Send(into).params = { ...ch1Send(into).params, level: -10 };
        into.nodeParams.ch2 = { ...into.nodeParams.ch2, hpf: true };
        // The operator moves the fader while the read is in flight.
        ch1Send(plan).params = { ...ch1Send(plan).params, level: 0 };
        return OK;
      },
    );

    expect(merged).not.toBeNull();
    // The contested key resolves to the operator's value…
    expect(ch1Level(plan)).toBe(0);
    // …and the uncontested one to the device's.
    expect(plan.nodeParams.ch2?.hpf).toBe(true);
    // The view is what the DEVICE holds, which is what a snapshot must measure from:
    // it must not have picked up the edit.
    expect(ch1Level(merged!.deviceView)).toBe(-10);
    expect(merged!.deviceView.nodeParams.ch2?.hpf).toBe(true);
    // Nothing was skipped: the device never authored the contested key, so this read
    // had no conflict to report — which is what makes the next case an assertion.
    expect(merged!.unplaced).toEqual([]);
  });

  it("names the keys the operator's edit kept the device from writing", async () => {
    const plan = basePlan();
    ch1Send(plan).params = { ...ch1Send(plan).params, level: -10 };
    plan.nodeParams.ch2 = { ...plan.nodeParams.ch2, hpf: false, hpfFreq: 80 };

    const merged = await readIntoPlan(
      () => plan,
      async (into) => {
        // This time the device authors values of its own on the keys the operator is
        // about to move, and on one they leave alone.
        ch1Send(into).params = { ...ch1Send(into).params, level: -20 };
        into.nodeParams.ch2 = { ...into.nodeParams.ch2, hpf: true, hpfFreq: 120 };
        ch1Send(plan).params = { ...ch1Send(plan).params, level: 0 };
        plan.nodeParams.ch2 = { ...plan.nodeParams.ch2, hpf: true };
        return OK;
      },
    );

    expect(merged).not.toBeNull();
    // The operator's values stand where the two met…
    expect(ch1Level(plan)).toBe(0);
    // …and the key they did not touch takes the device's, from the SAME patch entry:
    // an entry is narrowed to its in-context keys, not dropped whole.
    expect(plan.nodeParams.ch2?.hpfFreq).toBe(120);
    // Both conflicts are reported rather than settled in silence. Per key, so a
    // partly-applied entry names what it left alone.
    expect(merged!.unplaced.some((u) => u.startsWith("connParams") && u.endsWith(".level"))).toBe(true);
    expect(merged!.unplaced).toContain("nodeParams ch2.hpf");
    expect(merged!.unplaced.some((u) => u.endsWith(".hpfFreq"))).toBe(false);
  });

  it("does not resurrect a wire the operator removed while the read was in flight", async () => {
    const plan = basePlan();
    // Any wire will do: what is under test is the merge finding nothing to land on,
    // not which wires the UI lets go of.
    const target = plan.connections[0];
    const key = { from: target.from, to: target.to };

    const merged = await readIntoPlan(
      () => plan,
      async (into) => {
        // The device still reports the wire and its params.
        const held = into.connections.find((c) => c.from === key.from && c.to === key.to)!;
        held.params = { ...held.params, level: -6 };
        // The operator deletes it meanwhile.
        plan.connections = plan.connections.filter((c) => !(c.from === key.from && c.to === key.to));
        return OK;
      },
    );

    expect(merged).not.toBeNull();
    expect(plan.connections.some((c) => c.from === key.from && c.to === key.to)).toBe(false);
    // Reported rather than dropped in silence: the device's params for it had nowhere
    // to land.
    expect(merged!.unplaced.some((u) => u.startsWith("connParams"))).toBe(true);
  });

  it("writes nothing and returns null when the plan it read into was replaced", async () => {
    let plan = basePlan();
    const first = plan;
    const replacement = basePlan();

    const merged = await readIntoPlan(
      () => plan,
      async (into) => {
        into.nodeParams.ch2 = { ...into.nodeParams.ch2, hpf: true };
        plan = replacement; // File > New / Open landed mid-read
        return OK;
      },
    );

    expect(merged).toBeNull();
    expect(first.nodeParams.ch2?.hpf).toBeUndefined();
    expect(replacement.nodeParams.ch2?.hpf).toBeUndefined();
  });

  it("returns null on a model switch, which the differ cannot merge across", async () => {
    let plan = basePlan();
    const other = emptyPlan("URX22");

    const merged = await readIntoPlan(
      () => plan,
      async (into) => {
        into.nodeParams.ch2 = { ...into.nodeParams.ch2, hpf: true };
        plan = other;
        return OK;
      },
    );

    // Without the identity guard this would merge an empty patch (diffPlans across two
    // modelIds is empty by contract) and claim the read succeeded.
    expect(merged).toBeNull();
    expect(other.modelId).toBe("URX22");
  });

  it("leaves the plan untouched when the read throws", async () => {
    const plan = basePlan();
    const before = JSON.stringify(plan);

    await expect(
      readIntoPlan(
        () => plan,
        async (into) => {
          into.nodeParams.ch2 = { ...into.nodeParams.ch2, hpf: true };
          throw new DOMException("aborted", "AbortError");
        },
      ),
    ).rejects.toThrow();

    // "A cancel means nothing happened" — with no restore step to get it wrong.
    expect(JSON.stringify(plan)).toBe(before);
  });
});

// The value contest cannot see an edit that ended where it started. These drive the real
// witness through the funnel main.ts uses (a write, then markChanged), so what is pinned
// is authorship reaching the merge — not a set handed to it.
describe("readIntoPlan against an edit that goes there and back", () => {
  /** One edit funnel: mutate, then report to the witness the way markChanged does. */
  function edit(witness: PlanWriteWitness, mutate: () => void): void {
    mutate();
    witness.note();
  }

  it("does not enshrine the value a read sampled between two app writes", async () => {
    const plan = basePlan();
    // Live session, ch1 explicitly on, device in agreement.
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, on: true };
    const witness = new PlanWriteWitness(() => plan);

    // A full reconcile is in flight: ~800 sequential reads, seconds wide.
    const merged = await readIntoPlan(
      () => plan,
      async (into) => {
        // The operator MUTEs ch1 in the app; the flush window sends it.
        edit(witness, () => (plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, on: false }));
        // The read's sequential pass reaches CH_ON right here and samples the device
        // as it stands between the two flushes: muted.
        into.nodeParams.ch1 = { ...into.nodeParams.ch1, on: false };
        // The operator un-mutes; that window's flush lands too, so the DEVICE ends
        // un-muted and the plan is back at the value the read was issued on.
        edit(witness, () => (plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, on: true }));
        return OK;
      },
      witness,
    );

    expect(merged).not.toBeNull();
    // Value equality reads this key as untouched, so the device's mid-gesture sample
    // would apply — silently, and the next converge round would push it at the unit.
    expect(plan.nodeParams.ch1?.on).toBe(true);
    expect(merged!.unplaced).toContain("nodeParams ch1.on");
    // The same key is kept out of the patch the history baseline absorbs: absorbed but
    // not applied would put a value the app never wrote into the next undo entry.
    const absorbed = merged!.devicePatch.filter((e) => e.field === "nodeParams" && e.key === "ch1");
    expect(absorbed.some((e) => "on" in (e as { before: Record<string, unknown> }).before)).toBe(false);
  });

  it("still takes the device's value on a key no funnel touched", async () => {
    const plan = basePlan();
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, on: true, hpf: false };
    const witness = new PlanWriteWitness(() => plan);

    const merged = await readIntoPlan(
      () => plan,
      async (into) => {
        into.nodeParams.ch1 = { ...into.nodeParams.ch1, on: false, hpf: true };
        edit(witness, () => (plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, on: false }));
        edit(witness, () => (plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, on: true }));
        return OK;
      },
      witness,
    );

    // Authorship is per key, not per node: the app's own key is held, its neighbour on
    // the same node takes device truth.
    expect(plan.nodeParams.ch1?.on).toBe(true);
    expect(plan.nodeParams.ch1?.hpf).toBe(true);
    expect(merged!.unplaced).toEqual(["nodeParams ch1.on"]);
  });

  it("goes back to the value contest once the read has resolved", async () => {
    const plan = basePlan();
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, on: true };
    const witness = new PlanWriteWitness(() => plan);

    // An edit before the read is issued is not authored during it…
    edit(witness, () => (plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, on: true }));
    await readIntoPlan(
      () => plan,
      async (into) => {
        into.nodeParams.ch1 = { ...into.nodeParams.ch1, on: false };
        return OK;
      },
      witness,
    );
    expect(plan.nodeParams.ch1?.on).toBe(false);

    // …and the witness disarms with the last read, so the next one starts clean.
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, on: false };
    await readIntoPlan(
      () => plan,
      async (into) => {
        into.nodeParams.ch1 = { ...into.nodeParams.ch1, on: true };
        return OK;
      },
      witness,
    );
    expect(plan.nodeParams.ch1?.on).toBe(true);
  });
});

// A NodeParams key can be a whole group of fields (comp, gate, eqBands, …), and the two
// sides move different fields of it at the same time: the operator's hand on the unit's
// COMP RELEASE, their pointer on the app's COMP ATTACK. Contesting the group whole hands
// it to the app and the next flush reverts the device's own sibling on the unit.
describe("readIntoPlan inside a nested group", () => {
  // The witness's own names decide how much of a group a merge gives up. A funnel edits
  // a group by REBUILDING it — one field set, the rest copied — so the patch key names
  // the whole group, and a named group is dropped WHOLE. `nodeParamContestPath` is what
  // turns a caller's `"comp.attack"` into the field's own name; a helper that stopped
  // splitting would name a param called `comp.attack`, which matches nothing, and the
  // merge would then take the device's value for the field the operator was holding.
  it("gives up only the field a caller named, not the group it was rebuilt into", async () => {
    const run = async (authored: string) => {
      const plan = basePlan();
      plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, comp: { attack: 10, release: 100 } };
      const witness = new PlanWriteWitness(() => plan);
      await readIntoPlan(
        () => plan,
        async (into) => {
          // The unit moved BOTH fields while the app rebuilt the group for one of them.
          into.nodeParams.ch1 = { ...into.nodeParams.ch1, comp: { attack: 99, release: 200 } };
          plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, comp: { attack: 10, release: 100 } };
          witness.note([authored]);
          return OK;
        },
        witness,
      );
      return plan.nodeParams.ch1?.comp;
    };

    // Naming the field: the device's other field lands, the named one is the app's.
    expect(await run(nodeParamContestPath("ch1", "comp.attack"))).toEqual({ attack: 10, release: 200 });
    // Naming the group: the device's answer for BOTH fields is thrown away.
    expect(await run(nodeParamContestPath("ch1", "comp"))).toEqual({ attack: 10, release: 100 });
  });

  // …however deep it sits. `fxEffect.params` is a record inside a record, and a walk that
  // stopped at the first one made the whole map ONE contested key: the app moving a reverb
  // time and the device moving the room size were the same key, so the app won both and
  // the device's value was thrown away with it. The SSMCS bank's sections and eqBands
  // (objects inside an array) have the same shape.
  it("keeps both fields when they sit two levels down in one group", async () => {
    const plan = basePlan();
    plan.nodeParams["bus.fx1"] = {
      ...plan.nodeParams["bus.fx1"],
      fxEffect: { params: { reverbTime: 23, roomSize: 29 } },
    };
    const witness = new PlanWriteWitness(() => plan);

    const merged = await readIntoPlan(
      () => plan,
      async (into) => {
        // The unit's own room size, read back…
        into.nodeParams["bus.fx1"] = {
          ...into.nodeParams["bus.fx1"],
          fxEffect: { params: { reverbTime: 23, roomSize: 40 } },
        };
        // …while the operator drags the reverb time in the inspector.
        plan.nodeParams["bus.fx1"] = {
          ...plan.nodeParams["bus.fx1"],
          fxEffect: { params: { reverbTime: 25, roomSize: 29 } },
        };
        witness.note([nodeParamContestPath("bus.fx1", "fxEffect.params.reverbTime")]);
        return OK;
      },
      witness,
    );

    expect(merged).not.toBeNull();
    expect(plan.nodeParams["bus.fx1"]?.fxEffect).toEqual({ params: { reverbTime: 25, roomSize: 40 } });
  });

  it("keeps the field the device moved and the field the app moved", async () => {
    const plan = basePlan();
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, comp: { attack: 10, release: 100 } };
    const witness = new PlanWriteWitness(() => plan);

    const merged = await readIntoPlan(
      () => plan,
      async (into) => {
        // The operator turned COMP RELEASE on the hardware; the notify settled into a
        // scoped reconcile of ch1, and this is what it reads back.
        into.nodeParams.ch1 = { ...into.nodeParams.ch1, comp: { attack: 10, release: 200 } };
        // Meanwhile they drag COMP ATTACK in the tuning screen.
        plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, comp: { attack: 50, release: 100 } };
        witness.note();
        return OK;
      },
      witness,
    );

    expect(merged).not.toBeNull();
    expect(plan.nodeParams.ch1?.comp).toEqual({ attack: 50, release: 200 });
    // Part of the group was left to the plan, and that is still named rather than
    // salvaged in silence.
    expect(merged!.unplaced).toContain("nodeParams ch1.comp");
  });

  it("fills the bands a readback read without disturbing the one being dragged", async () => {
    const plan = basePlan();
    const bands = [] as NonNullable<Plan["nodeParams"][string]["eqBands"]>;
    bands[0] = { on: true, freq: 100, gain: 0, q: 0.71 };
    bands[3] = { on: true, freq: 8000, gain: 0, q: 0.71 };
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, eqBands: bands };
    const witness = new PlanWriteWitness(() => plan);

    await readIntoPlan(
      () => plan,
      async (into) => {
        // The device recomputed band 3 (a 1-knob move); the read fills only the bands
        // it read, so the array stays sparse.
        const read = [] as NonNullable<Plan["nodeParams"][string]["eqBands"]>;
        read[0] = { on: true, freq: 100, gain: 0, q: 0.71 };
        read[3] = { on: true, freq: 8000, gain: 6, q: 0.71 };
        into.nodeParams.ch1 = { ...into.nodeParams.ch1, eqBands: read };
        // The operator drags band 0's gain in the EQ screen at the same time.
        const moved = structuredClone(plan.nodeParams.ch1!.eqBands!);
        moved[0] = { ...moved[0], gain: -4 };
        plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, eqBands: moved };
        witness.note();
        return OK;
      },
      witness,
    );

    const after = plan.nodeParams.ch1!.eqBands!;
    expect(after[0]?.gain).toBe(-4);
    expect(after[3]?.gain).toBe(6);
    // The holes the readback left are still holes: nothing filled band 1 or 2.
    expect(1 in after).toBe(false);
    expect(2 in after).toBe(false);
  });
});

describe("MergedRead.devicePatch and the context-checked absorb", () => {
  it("names only what the read authored, and skips a key the app moved since", async () => {
    const plan = basePlan();
    ch1Send(plan).params = { ...ch1Send(plan).params, level: -20 };
    // The history baseline as it stood before the gesture began.
    const baseline = clonePlanState(plan);
    // The gesture moves the level, then a flush issues the read.
    ch1Send(plan).params = { ...ch1Send(plan).params, level: -10 };

    const merged = await readIntoPlan(
      () => plan,
      async (into) => {
        // The device echoes the level the flush just wrote, and authors a band value
        // of its own — the 1-knob shape.
        into.nodeParams.ch1 = { ...into.nodeParams.ch1, hpfFreq: 120 };
        // The pointer keeps moving while the read is in flight.
        ch1Send(plan).params = { ...ch1Send(plan).params, level: 0 };
        return OK;
      },
    );

    expect(merged).not.toBeNull();
    const fields = merged!.devicePatch.map((e) => e.field);
    expect(fields).toContain("nodeParams");

    applyPatchInContext(baseline, merged!.devicePatch);
    // The device's own key lands in the baseline, so it stays out of the next entry…
    expect(baseline.nodeParams.ch1?.hpfFreq).toBe(120);
    // …while the dragged key keeps measuring from where the press found it, which is
    // what makes the whole drag one entry rather than a tail.
    expect(ch1Level(baseline)).toBe(-20);
    expect(ch1Level(plan)).toBe(0);
    // The entry the commit would record: the gesture's full travel.
    expect(diffPlans(baseline, plan).some((e) => e.field === "connParams")).toBe(true);
  });

  // The predicate main.ts's follow reflect reads to decide whether a reconcile
  // invalidated the undo history. A read that found the device holding exactly what the
  // plan holds authored nothing, so no earlier entry describes a state it cannot return
  // to — and wiping the stacks for it is loss with nothing bought.
  it("is empty when the read agrees with the plan at every key", async () => {
    const plan = basePlan();
    ch1Send(plan).params = { ...ch1Send(plan).params, level: -20 };

    const merged = await readIntoPlan(
      () => plan,
      async () => OK, // the read writes nothing into its copy: the device agrees
    );

    expect(merged).not.toBeNull();
    expect(merged!.devicePatch).toHaveLength(0);
    expect(merged!.unplaced).toHaveLength(0);
  });
});

// A sample-rate excursion past a selected effect's ceiling clears the effect ON THE UNIT
// and announces only the rate, so the read the rate notify escalates to is what finds the
// cleared values. These pin which of those the merge adopts and which it holds — and that
// the held ones stay OUT of the device view, since that is the copy the outgoing diff
// measures against and the only thing that can send the effect back.
// A funnel asserts every member of the patch it carries, and a member that already
// holds the asserted value moves nothing for the diff to see. The funnel's own list is
// the only thing that can name it; without it a device read in flight takes the key
// back to whatever the unit held, and the operator's assertion is spent.
it("keeps a key an edit funnel asserted without moving it", async () => {
  const plan = basePlan();
  plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, hpf: true, hpfFreq: 80 };
  const witness = new PlanWriteWitness(() => plan);

  const merged = await readIntoPlan(
    () => plan,
    async (into) => {
      // The unit holds something else on both.
      into.nodeParams.ch1 = { ...into.nodeParams.ch1, hpf: false, hpfFreq: 120 };
      // The operator's patch moves one member and asserts the other where it already is.
      plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, hpfFreq: 200, hpf: true };
      witness.note([nodeParamContestKey("ch1", "hpfFreq"), nodeParamContestKey("ch1", "hpf")]);
      return OK;
    },
    witness,
  );

  expect(plan.nodeParams.ch1?.hpfFreq).toBe(200);
  expect(plan.nodeParams.ch1?.hpf).toBe(true);
  // The device view still says what the unit answered, so the next outgoing diff is what
  // settles the unit on the operator's value.
  expect(merged!.deviceView.nodeParams.ch1?.hpf).toBe(false);
});

describe("insertFxHoldKeys", () => {
  const hold = (ctx: Parameters<typeof insertFxHoldKeys>[1]) => insertFxHoldKeys(model, ctx);
  const PITCH_FIX = 512; // input route, 48 kHz ceiling
  const COMPANDER_H = 1793; // input route, 96 kHz ceiling
  const MBAND_COMP = 1792; // OUTPUT routes only, 96 kHz ceiling
  const selected = (plan: Plan) => ({
    ...plan.nodeParams.ch1,
    insertFx: PITCH_FIX,
    insertFxOn: true,
    insertFxParams: { "18": 37 },
  });
  /** The unit answering "no effect here" on ch1, at `rate`, on a read that established
   *  that rate — a full one. `sibling` is anything else the same read found, so a case
   *  can show the device's own keys landing beside the held ones. */
  const cleared = (into: Plan, rate: number, sibling: Record<string, unknown> = {}): ReadbackResult => {
    into.nodeParams.ch1 = {
      ...into.nodeParams.ch1,
      insertFx: -1,
      insertFxOn: false,
      insertFxParams: undefined,
      ...sibling,
    };
    into.sampleRate = rate;
    return { ...OK, deviceSampleRate: rate };
  };
  /** The same answer from a read that established NO rate — every scoped one, and a full
   *  one whose 766 failed. Spelled as its own helper rather than an `undefined` argument:
   *  a default parameter takes effect for `undefined`, so passing it would have handed
   *  the predicate the very rate the case exists to withhold (measured — the case passed
   *  a rate it believed it had suppressed). */
  const clearedNoRate = (into: Plan, planRate: number): ReadbackResult => {
    const result = cleared(into, planRate);
    return { ...result, deviceSampleRate: undefined };
  };

  // The read is not a snapshot. A Signal Type transition landing inside one is caught on
  // the addresses read after it and missed on those read before, and the pair's Signal
  // Type is read BEFORE the selector — so a transition in that gap leaves this predicate
  // comparing two equal, stale values and holding a clearing the unit made for a reason
  // of its own. Measured on the code before `announced` existed: three keys held, which
  // the outgoing diff then re-sent. What separates the two causes is the notify stream:
  // measured on a URX44V, the transition announces the selector and the bypass on both
  // members, the rate excursion announces the rate and nothing else.
  it("leaves a route alone when the unit announced the change itself", () => {
    const before = basePlan();
    before.nodeParams.ch1 = selected(before);
    const deviceView = clonePlanState(before);
    deviceView.nodeParams.ch1 = { ...deviceView.nodeParams.ch1, insertFx: -1, insertFxOn: false };
    const ctx = { before, deviceView, deviceSampleRate: 96000, authored: new Set<string>() };

    // Without the announcement the values alone read as the silent clearing…
    expect(hold(ctx).size).toBe(3);
    // …and with it, the route is the announcement's to explain.
    expect(hold({ ...ctx, announced: new Set(["ch1"]) }).size).toBe(0);
    // A different route's announcement says nothing about this one.
    expect(hold({ ...ctx, announced: new Set(["ch3"]) }).size).toBe(3);
  });

  it("keeps an effect the unit cleared for a rate that cannot run it, and still reports the unit's own value", async () => {
    const plan = basePlan();
    plan.nodeParams.ch1 = selected(plan);

    const merged = await readIntoPlan(
      () => plan,
      async (into) => cleared(into, 96000),
      undefined,
      hold,
    );

    expect(merged).not.toBeNull();
    // The plan keeps the intent, whole: a selector without its engine values would be
    // re-applied against whatever defaults the device refilled the engine with.
    expect(plan.nodeParams.ch1?.insertFx).toBe(PITCH_FIX);
    expect(plan.nodeParams.ch1?.insertFxOn).toBe(true);
    expect(plan.nodeParams.ch1?.insertFxParams).toEqual({ "18": 37 });
    // The rate itself is not held — that change IS the operator's.
    expect(plan.sampleRate).toBe(96000);
    // The device view keeps what the unit answered. This is the half a hold must not
    // touch: the live snapshot re-bases from it, and an agreeing view would leave the
    // app holding an effect with no divergence left to send it back.
    expect(merged!.deviceView.nodeParams.ch1?.insertFx).toBe(-1);
    expect(merged!.held.sort()).toEqual([
      "nodeParams ch1.insertFx",
      "nodeParams ch1.insertFxOn",
      "nodeParams ch1.insertFxParams",
    ]);
  });

  // 48000 IS Pitch Fix's ceiling, so this is the boundary of `sampleRate <= maxRate` and
  // not merely a rate below it.
  it("adopts a No Effect at the effect's own ceiling rate, because that one is the operator's own", async () => {
    const plan = basePlan();
    plan.nodeParams.ch1 = selected(plan);

    const merged = await readIntoPlan(
      () => plan,
      async (into) => cleared(into, 48000),
      undefined,
      hold,
    );

    expect(plan.nodeParams.ch1?.insertFx).toBe(-1);
    expect(plan.nodeParams.ch1?.insertFxOn).toBe(false);
    expect(merged!.held).toEqual([]);
  });

  // …unless the unit had said otherwise on the way here. The excursion can be over before
  // the rate address is asked: 48 → 96 → 48 leaves the read holding 48, at which the
  // effect runs, so its own values are the operator's-No-Effect case exactly. The rate
  // notify that escalated to the read carries the one that did it.
  it("keeps an effect a rate the unit announced could not run, even when the read found a rate that can", () => {
    const before = basePlan();
    before.nodeParams.ch1 = selected(before);
    const deviceView = clonePlanState(before);
    deviceView.nodeParams.ch1 = { ...deviceView.nodeParams.ch1, insertFx: -1, insertFxOn: false };
    const ctx = { before, deviceView, deviceSampleRate: 48000, authored: new Set<string>() };

    // The read's own rate runs the effect, so on that alone the clearing is adopted…
    expect(hold(ctx).size).toBe(0);
    // …and the rate the unit announced on the way is what says otherwise.
    expect(hold({ ...ctx, ratesSeen: [96000, 48000] }).size).toBe(3);
    // A rate the effect runs at says nothing.
    expect(hold({ ...ctx, ratesSeen: [44100, 48000] }).size).toBe(0);
  });

  // A SCOPED read has no rate of its own, and is not therefore blind: it reads a node's
  // insert FX like any other body value, so one already running when the unit clears an
  // effect is the FIRST to see the cleared selector — ahead of the full read the rate
  // notify escalates to, which then finds nothing left to hold. Measured before the
  // announced rate could decide on its own: nothing held, and the effect was gone.
  it("holds on a rate the unit announced even when the read established none of its own", () => {
    const before = basePlan();
    before.nodeParams.ch1 = selected(before);
    const deviceView = clonePlanState(before);
    deviceView.nodeParams.ch1 = { ...deviceView.nodeParams.ch1, insertFx: -1, insertFxOn: false };
    const ctx = { before, deviceView, authored: new Set<string>() };

    expect(hold({ ...ctx, ratesSeen: [96000] }).size).toBe(3);
    // A rate the effect runs at still says nothing…
    expect(hold({ ...ctx, ratesSeen: [48000] }).size).toBe(0);
    // …and a read with no evidence at all decides nothing, as before.
    expect(hold(ctx).size).toBe(0);
  });

  // The rate the PLAN holds is not the rate to decide from, and the two really do come
  // apart: a scoped read never asks for the address, and under the "Scene only" device
  // scope a full read's answer is discarded from the plan again. Deciding from the plan's
  // copy would overwrite an operator who cleared the effect on the unit by hand.
  it("holds nothing when the read established no rate of its own, whatever the plan says", async () => {
    const plan = basePlan();
    plan.nodeParams.ch1 = selected(plan);

    const merged = await readIntoPlan(
      () => plan,
      // The plan's own rate says the effect cannot run — and it is still not the input.
      async (into) => clearedNoRate(into, 96000),
      undefined,
      hold,
    );

    expect(merged!.held).toEqual([]);
    expect(plan.nodeParams.ch1?.insertFx).toBe(-1);
  });

  it("holds nothing for a route whose selector the operator moved while the read ran", async () => {
    const plan = basePlan();
    plan.nodeParams.ch1 = selected(plan);
    const witness = new PlanWriteWitness(() => plan);

    const merged = await readIntoPlan(
      () => plan,
      async (into) => {
        const result = cleared(into, 96000);
        // The operator picks a different effect in the app, mid-read. The funnel writes
        // BOTH keys and names both — `insertFxOn` was already true, so its value does not
        // move and only the funnel's own list can name it.
        plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, insertFx: COMPANDER_H, insertFxOn: true };
        witness.note([nodeParamContestKey("ch1", "insertFx"), nodeParamContestKey("ch1", "insertFxOn")]);
        return result;
      },
      witness,
      hold,
    );

    // The selector is the operator's, left standing by the value contest — and the other
    // two keys are NOT held beside it, which would put the old effect's bypass and engine
    // values under the new selection.
    expect(plan.nodeParams.ch1?.insertFx).toBe(COMPANDER_H);
    expect(merged!.held).toEqual([]);
    // …and it arrives ENGAGED. The bypass key never moved — it was already true — so the
    // read's own diff cannot tell it from a key nobody touched, and the device's OFF used
    // to win it: the operator's new effect landed selected and muted.
    expect(plan.nodeParams.ch1?.insertFxOn).toBe(true);
  });

  it("adopts the cleared values when no hold is passed at all", async () => {
    const plan = basePlan();
    plan.nodeParams.ch1 = selected(plan);

    const merged = await readIntoPlan(
      () => plan,
      async (into) => cleared(into, 96000),
    );

    expect(plan.nodeParams.ch1?.insertFx).toBe(-1);
    expect(merged!.held).toEqual([]);
  });

  it("holds nothing for a node whose insert-FX read failed, since its view still shows the effect", async () => {
    const plan = basePlan();
    plan.nodeParams.ch1 = selected(plan);

    // The read raised the rate and reached ch1's other groups, but its insert-FX group
    // threw — so the view carries the plan's own effect forward and there is nothing
    // cleared to hold against. The sibling key is what makes that a decision rather than
    // an empty patch: without it the node has no entry at all, and `held` would read
    // empty whatever the predicate did.
    const merged = await readIntoPlan(
      () => plan,
      async (into) => {
        into.sampleRate = 96000;
        into.nodeParams.ch1 = { ...into.nodeParams.ch1, hpf: true };
        return { applied: 1, errors: ["CH 1: read timeout"], unreadNodes: new Set(["ch1"]), deviceSampleRate: 96000 };
      },
      undefined,
      hold,
    );

    expect(merged!.held).toEqual([]);
    expect(plan.nodeParams.ch1?.insertFx).toBe(PITCH_FIX);
    expect(plan.nodeParams.ch1?.hpf).toBe(true);
  });

  // The clause that separates "the unit cleared this" from "the unit holds something
  // else": the operator picked a different effect on the unit after the excursion, and
  // theirs is one the new rate can run. Holding here would revert their choice and then
  // write the old effect back at a unit that cannot run it.
  it("adopts a different effect the unit now holds, rather than reverting to the plan's", async () => {
    const plan = basePlan();
    plan.nodeParams.ch1 = selected(plan);

    const merged = await readIntoPlan(
      () => plan,
      async (into) => {
        into.sampleRate = 96000;
        into.nodeParams.ch1 = { ...into.nodeParams.ch1, insertFx: COMPANDER_H, insertFxOn: true };
        return { ...OK, deviceSampleRate: 96000 };
      },
      undefined,
      hold,
    );

    expect(merged!.held).toEqual([]);
    expect(plan.nodeParams.ch1?.insertFx).toBe(COMPANDER_H);
  });

  // The rate is not the only thing that clears an effect. A Signal Type transition clears
  // the selector and the ON on both members, and `applyPairTransition` follows that rather
  // than resisting it — so a pair whose Signal Type moved in this same read is not the
  // hold's to keep, whatever the rate would otherwise say.
  it("adopts a clearing a Signal Type transition explains, whatever the rate says", async () => {
    const plan = basePlan();
    plan.nodeParams.ch1 = { ...selected(plan), stereoLink: false };

    const merged = await readIntoPlan(
      () => plan,
      async (into) => {
        const result = cleared(into, 96000);
        into.nodeParams.ch1 = { ...into.nodeParams.ch1, stereoLink: true };
        return result;
      },
      undefined,
      hold,
    );

    expect(merged!.held).toEqual([]);
    expect(plan.nodeParams.ch1?.insertFx).toBe(-1);
    expect(plan.nodeParams.ch1?.stereoLink).toBe(true);
  });

  // An output bus: a different option table, a node id carrying a dot, and the one route
  // kind whose selector writes two instances.
  it("holds an output bus route the same way, under its own option table", async () => {
    const plan = basePlan();
    plan.nodeParams["bus.mix1"] = {
      ...plan.nodeParams["bus.mix1"],
      insertFx: MBAND_COMP,
      insertFxOn: true,
      insertFxParams: { "9": 99 },
    };

    const merged = await readIntoPlan(
      () => plan,
      async (into) => {
        into.sampleRate = 192000;
        into.nodeParams["bus.mix1"] = {
          ...into.nodeParams["bus.mix1"],
          insertFx: -1,
          insertFxOn: false,
          insertFxParams: undefined,
        };
        return { ...OK, deviceSampleRate: 192000 };
      },
      undefined,
      hold,
    );

    expect(plan.nodeParams["bus.mix1"]?.insertFx).toBe(MBAND_COMP);
    expect(plan.nodeParams["bus.mix1"]?.insertFxParams).toEqual({ "9": 99 });
    expect(merged!.held.sort()).toEqual([
      "nodeParams bus.mix1.insertFx",
      "nodeParams bus.mix1.insertFxOn",
      "nodeParams bus.mix1.insertFxParams",
    ]);
  });

  // A selector this model's control does not offer — what a plan carried across models
  // leaves behind. Adopted, because translate will not emit it either: holding it would
  // keep a value in the plan with no way of ever reaching the unit.
  it("adopts a clearing of a selector the route does not offer", async () => {
    const plan = basePlan();
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, insertFx: MBAND_COMP, insertFxOn: true };

    const merged = await readIntoPlan(
      () => plan,
      async (into) => cleared(into, 96000),
      undefined,
      hold,
    );

    expect(merged!.held).toEqual([]);
    expect(plan.nodeParams.ch1?.insertFx).toBe(-1);
  });

  // The hold is per KEY, not per node: the device's own siblings in the same entry still
  // land. Without this, an implementation that dropped the whole node entry whenever one
  // of its keys was held would pass every case above.
  it("lets the device's own keys land in the same entry it holds three of", async () => {
    const plan = basePlan();
    plan.nodeParams.ch1 = selected(plan);

    const merged = await readIntoPlan(
      () => plan,
      async (into) => cleared(into, 96000, { hpf: true, hpfFreq: 120 }),
      undefined,
      hold,
    );

    expect(plan.nodeParams.ch1?.insertFx).toBe(PITCH_FIX);
    expect(plan.nodeParams.ch1?.hpf).toBe(true);
    expect(plan.nodeParams.ch1?.hpfFreq).toBe(120);
    expect(merged!.held).toHaveLength(3);
  });
});
