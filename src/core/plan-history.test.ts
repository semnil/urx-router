import { describe, expect, it } from "vitest";
import { applyPatch, clonePlanState, diffPlans, invertPatch, patchTouch, PlanHistoryStack } from "./plan-history";
import { emptyPlan } from "./plan";
import type { Plan } from "./plan";
import { defaultPlan } from "../models/initial-state";
import { MODEL_IDS } from "../models";

const seed = (): Plan => defaultPlan("URX44V");

/** Diff before -> after, apply the patch to a third copy of `before`, and assert it
 *  reaches `after`; then apply the inverse and assert it is back at `before`. This
 *  is the round-trip every field has to survive. */
function roundTrip(before: Plan, mutate: (p: Plan) => void): void {
  const after = clonePlanState(before);
  mutate(after);
  const patch = diffPlans(before, after);
  expect(patch.length, "the mutation produced no patch").toBeGreaterThan(0);
  const forward = clonePlanState(before);
  applyPatch(forward, patch);
  expect(forward).toStrictEqual(after);
  applyPatch(forward, invertPatch(patch));
  expect(forward).toStrictEqual(clonePlanState(before));
}

// Per-field round-trips live in plan-history.contract.test.ts, which drives one real
// mutation per HISTORY_FIELDS entry. What is here is the cases that table does not
// reach: a wire's params, a wire disappearing, and the set-semantics of `hidden`.
describe("diffPlans / applyPatch round-trip", () => {
  it("reports nothing for an unchanged plan", () => {
    const p = seed();
    expect(diffPlans(p, clonePlanState(p))).toEqual([]);
  });

  it("carries a send level on an existing wire", () => {
    const before = seed();
    const wire = before.connections.find((c) => c.params?.level !== undefined)!;
    roundTrip(before, (p) => {
      const c = p.connections.find((x) => x.from === wire.from && x.to === wire.to)!;
      c.params = { ...c.params, level: -12 };
    });
  });

  it("carries a wire deletion and re-creation", () => {
    const before = seed();
    const wire = before.connections[0];
    roundTrip(before, (p) => {
      p.connections = p.connections.filter((c) => !(c.from === wire.from && c.to === wire.to));
    });
  });

  it("treats a reordered hidden array as unchanged", () => {
    const before = seed();
    before.hidden = ["ch1", "ch2"];
    const after = clonePlanState(before);
    after.hidden = ["ch2", "ch1"];
    expect(diffPlans(before, after)).toEqual([]);
  });
});

describe("absence is a state of its own", () => {
  it("undoes absent -> present by deleting the key again", () => {
    const before = seed();
    delete before.nodeParams.ch1?.hpf;
    const after = clonePlanState(before);
    after.nodeParams.ch1 = { ...after.nodeParams.ch1, hpf: true };
    const patch = diffPlans(before, after);
    const p = clonePlanState(after);
    applyPatch(p, invertPatch(patch));
    expect("hpf" in (p.nodeParams.ch1 ?? {})).toBe(false);
  });

  it("undoes present -> absent by restoring the key", () => {
    const before = seed();
    before.nodeParams.ch1 = { ...before.nodeParams.ch1, hpfFreq: 100 };
    const after = clonePlanState(before);
    delete after.nodeParams.ch1!.hpfFreq;
    const patch = diffPlans(before, after);
    const p = clonePlanState(after);
    applyPatch(p, invertPatch(patch));
    expect(p.nodeParams.ch1!.hpfFreq).toBe(100);
  });

  it("creates a whole nodeParams entry and removes it again", () => {
    const before = emptyPlan("URX44V");
    const after = clonePlanState(before);
    after.nodeParams.ch1 = { hpf: true };
    const patch = diffPlans(before, after);
    const p = clonePlanState(before);
    applyPatch(p, patch);
    expect(p.nodeParams.ch1).toEqual({ hpf: true });
    applyPatch(p, invertPatch(patch));
    // Removed, not left as an empty husk: an empty record changes what a
    // scene-scoped save writes.
    expect("ch1" in p.nodeParams).toBe(false);
  });

  it("removes a whole nodeParams entry and restores it", () => {
    const before = emptyPlan("URX44V");
    before.nodeParams.ch1 = { hpf: true, hpfFreq: 80 };
    const after = clonePlanState(before);
    delete after.nodeParams.ch1;
    const patch = diffPlans(before, after);
    const p = clonePlanState(after);
    applyPatch(p, invertPatch(patch));
    expect(p.nodeParams.ch1).toEqual({ hpf: true, hpfFreq: 80 });
  });

  it("drops a connection's params record when the last key goes absent", () => {
    const before = emptyPlan("URX44V");
    before.connections = [{ from: "ch1:out", to: "bus.mix1:in", kind: "send", params: { level: -6 } }];
    const after = clonePlanState(before);
    delete after.connections[0].params!.level;
    const p = clonePlanState(before);
    applyPatch(p, diffPlans(before, after));
    expect("params" in p.connections[0]).toBe(false);
  });

  it("does not confuse an empty nodeParams husk with an absent entry", () => {
    const a = emptyPlan("URX44V");
    const b = clonePlanState(a);
    b.nodeParams.ch1 = {};
    // A husk carries nothing, so there is nothing to undo — the console creates
    // these on read (plan.nodeParams[id] ??= {}).
    expect(diffPlans(a, b)).toEqual([]);
  });
});

describe("sparse arrays", () => {
  it("keeps eqBands holes across a round-trip", () => {
    const before = emptyPlan("URX44V");
    before.nodeParams.ch1 = {};
    const after = clonePlanState(before);
    const bands = [] as NonNullable<Plan["nodeParams"][string]["eqBands"]>;
    bands[3] = { gain: 4 };
    after.nodeParams.ch1 = { eqBands: bands };
    const patch = diffPlans(before, after);
    const p = clonePlanState(before);
    applyPatch(p, patch);
    const applied = p.nodeParams.ch1!.eqBands!;
    expect(0 in applied).toBe(false);
    expect(applied[3]).toEqual({ gain: 4 });
    expect(applied.length).toBe(4);
    applyPatch(p, invertPatch(patch));
    expect("eqBands" in (p.nodeParams.ch1 ?? {})).toBe(false);
  });

  it("tells a hole apart from an explicit undefined element", () => {
    const before = emptyPlan("URX44V");
    const holes = [] as unknown[];
    holes[1] = { gain: 1 };
    before.nodeParams.ch1 = { eqBands: holes as never };
    const after = clonePlanState(before);
    const explicit = [undefined, { gain: 1 }] as unknown[];
    after.nodeParams.ch1 = { eqBands: explicit as never };
    expect(diffPlans(before, after).length).toBe(1);
  });
});

describe("connections", () => {
  it("keys wires by (from, to) uniquely in every model's factory plan", () => {
    for (const id of MODEL_IDS) {
      const plan = defaultPlan(id);
      const keys = plan.connections.map((c) => `${c.from} -> ${c.to}`);
      expect(new Set(keys).size, `${id} has duplicate wires`).toBe(keys.length);
    }
  });

  it("restores both wires of a paired delete", () => {
    const before = emptyPlan("URX44V");
    before.connections = [
      { from: "ch1:out", to: "bus.mix1:in", kind: "send", params: { level: -3 } },
      { from: "ch2:out", to: "bus.mix1:in", kind: "send", params: { level: -3 } },
    ];
    roundTrip(before, (p) => {
      p.connections = [];
    });
  });

  it("replaces a wire whole when its kind changed", () => {
    const before = emptyPlan("URX44V");
    before.connections = [{ from: "ch1:out", to: "bus.mix1:in", kind: "send" }];
    const after = clonePlanState(before);
    after.connections = [{ from: "ch1:out", to: "bus.mix1:in", kind: "record", params: { tap: "pre" } }];
    const patch = diffPlans(before, after);
    expect(patch.map((e) => e.field)).toEqual(["connections"]);
    const p = clonePlanState(before);
    applyPatch(p, patch);
    expect(p.connections[0]).toEqual(after.connections[0]);
  });

  it("falls back to a whole-array entry when a plan holds duplicate wires", () => {
    const before = emptyPlan("URX44V");
    before.connections = [
      { from: "ch1:out", to: "bus.mix1:in", kind: "send", params: { level: -3 } },
      { from: "ch1:out", to: "bus.mix1:in", kind: "send", params: { level: -9 } },
    ];
    const after = clonePlanState(before);
    after.connections[0].params = { level: 0 };
    const patch = diffPlans(before, after);
    expect(patch.map((e) => e.field)).toEqual(["connectionsAll"]);
    const p = clonePlanState(before);
    applyPatch(p, patch);
    expect(p.connections).toEqual(after.connections);
    applyPatch(p, invertPatch(patch));
    expect(p.connections).toEqual(before.connections);
  });

  it("reports a connParams entry whose wire has since been removed", () => {
    const before = emptyPlan("URX44V");
    before.connections = [{ from: "ch1:out", to: "bus.mix1:in", kind: "send", params: { level: -3 } }];
    const after = clonePlanState(before);
    after.connections[0].params = { level: 0 };
    const patch = diffPlans(before, after);
    const p = clonePlanState(before);
    p.connections = [];
    expect(applyPatch(p, patch).length).toBe(1);
  });
});

describe("patchTouch", () => {
  it("names the node a nodeParams entry belongs to", () => {
    const before = seed();
    const after = clonePlanState(before);
    after.nodeParams.ch1 = { ...after.nodeParams.ch1, hpf: true };
    const touch = patchTouch(diffPlans(before, after));
    expect([...touch.fields]).toEqual(["nodeParams"]);
    expect([...touch.nodes]).toEqual(["ch1"]);
  });

  it("names both ends of a wire", () => {
    const before = emptyPlan("URX44V");
    const after = clonePlanState(before);
    after.connections = [{ from: "ch1:out", to: "bus.mix1:in", kind: "send" }];
    const touch = patchTouch(diffPlans(before, after));
    expect([...touch.nodes].sort()).toEqual(["bus.mix1", "ch1"]);
  });

  it("names no node for a rate change", () => {
    const before = seed();
    const after = clonePlanState(before);
    after.sampleRate = 96000;
    const touch = patchTouch(diffPlans(before, after));
    expect([...touch.fields]).toEqual(["sampleRate"]);
    expect(touch.nodes.size).toBe(0);
  });
});

describe("clonePlanState", () => {
  it("leaves the transient device provenance out", () => {
    const p = seed();
    p.unreadNodes = new Set(["ch1"]);
    expect("unreadNodes" in clonePlanState(p)).toBe(false);
  });

  it("keeps a field the differ has not been taught", () => {
    const p = seed() as Plan & { futureField?: number };
    p.futureField = 7;
    expect((clonePlanState(p) as Plan & { futureField?: number }).futureField).toBe(7);
  });
});

describe("PlanHistoryStack", () => {
  it("records one entry per commit and undoes it", () => {
    const plan = seed();
    const stack = new PlanHistoryStack(plan);
    expect(stack.canUndo()).toBe(false);
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, hpf: true };
    expect(stack.record(plan)).not.toBeNull();
    expect(stack.canUndo()).toBe(true);
    applyPatch(plan, stack.takeUndo()!);
    // Back to the factory value the seeded plan carries, not to absent.
    expect(plan.nodeParams.ch1?.hpf).toBe(false);
    expect(stack.canRedo()).toBe(true);
  });

  it("records nothing when the plan did not change, and leaves redo alone", () => {
    const plan = seed();
    const stack = new PlanHistoryStack(plan);
    plan.sampleRate = 96000;
    stack.record(plan);
    applyPatch(plan, stack.takeUndo()!);
    stack.rebase(plan);
    expect(stack.canRedo()).toBe(true);
    expect(stack.record(plan)).toBeNull();
    expect(stack.canRedo()).toBe(true);
  });

  it("clears redo on a fresh entry", () => {
    const plan = seed();
    const stack = new PlanHistoryStack(plan);
    plan.sampleRate = 96000;
    stack.record(plan);
    applyPatch(plan, stack.takeUndo()!);
    stack.rebase(plan);
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, hpf: true };
    stack.record(plan);
    expect(stack.canRedo()).toBe(false);
  });

  it("redoes what it undid", () => {
    const plan = seed();
    const stack = new PlanHistoryStack(plan);
    plan.sampleRate = 96000;
    stack.record(plan);
    applyPatch(plan, stack.takeUndo()!);
    stack.rebase(plan);
    expect(plan.sampleRate).not.toBe(96000);
    applyPatch(plan, stack.takeRedo()!);
    expect(plan.sampleRate).toBe(96000);
  });

  it("walks a run of edits back one at a time", () => {
    const plan = seed();
    const stack = new PlanHistoryStack(plan);
    const rates = [96000, 48000, 88200];
    for (const rate of rates) {
      plan.sampleRate = rate;
      stack.record(plan);
    }
    for (const expected of [48000, 96000]) {
      applyPatch(plan, stack.takeUndo()!);
      stack.rebase(plan);
      expect(plan.sampleRate).toBe(expected);
    }
  });

  it("drops the oldest entry past the cap", () => {
    const plan = seed();
    const stack = new PlanHistoryStack(plan, 3);
    for (let i = 0; i < 5; i++) {
      plan.notes.ch1 = `n${i}`;
      stack.record(plan);
    }
    expect(stack.depth().undo).toBe(3);
    for (let i = 0; i < 3; i++) {
      applyPatch(plan, stack.takeUndo()!);
      stack.rebase(plan);
    }
    expect(stack.canUndo()).toBe(false);
    // Only the capped window is reachable, so the oldest state is not.
    expect(plan.notes.ch1).toBe("n1");
  });

  it("peeks without consuming", () => {
    const plan = seed();
    const stack = new PlanHistoryStack(plan);
    plan.sampleRate = 96000;
    stack.record(plan);
    expect(stack.peekUndo()).not.toBeNull();
    expect(stack.depth()).toEqual({ undo: 1, redo: 0 });
    expect(stack.peekRedo()).toBeNull();
  });

  it("keeps recorded entries across a rebase", () => {
    const plan = seed();
    const stack = new PlanHistoryStack(plan);
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, hpf: true };
    stack.record(plan);
    // A device readback settled another node; the entry above still undoes ch1.
    plan.nodeParams.ch3 = { ...plan.nodeParams.ch3, gain: 30 };
    stack.rebase(plan);
    expect(stack.canUndo()).toBe(true);
    applyPatch(plan, stack.takeUndo()!);
    // Back to the factory value the seeded plan carries, not to absent.
    expect(plan.nodeParams.ch1?.hpf).toBe(false);
    // The device's own value is untouched: the inverse only wrote ch1's keys.
    expect(plan.nodeParams.ch3?.gain).toBe(30);
  });

  it("drops the stacks when the model changed under it", () => {
    const plan = seed();
    const stack = new PlanHistoryStack(plan);
    plan.sampleRate = 96000;
    stack.record(plan);
    const other = defaultPlan("URX22");
    expect(stack.record(other)).toBeNull();
    expect(stack.canUndo()).toBe(false);
  });
});
