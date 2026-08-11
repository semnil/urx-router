import { describe, expect, it } from "vitest";
import { getModel } from "../../models";
import { emptyPlan, ensureFixedConnections, type Plan } from "../plan";
import { readIntoPlan, type ReadbackResult } from "./readback";
import { applyPatchInContext, clonePlanState, diffPlans, PlanWriteWitness } from "../plan-history";

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
