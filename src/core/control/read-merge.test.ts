import { describe, expect, it } from "vitest";
import { getModel } from "../../models";
import { emptyPlan, ensureFixedConnections, type Plan } from "../plan";
import { readIntoPlan, type ReadbackResult } from "./readback";
import { applyPatchInContext, clonePlanState, diffPlans } from "../plan-history";

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
});
