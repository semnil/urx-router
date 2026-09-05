import { describe, expect, it } from "vitest";
import { getModel } from ".";
import { defaultPlan, fillFactoryParams } from "./initial-state";
import { deserialize, emptyPlan, isPlainRecord, serialize } from "../core/plan";
import type { NodeParams } from "../core/plan";
import { clonePlanState, nodeParamContestPath } from "../core/plan-history";
import { planToCommands } from "../core/control/translate";

// A document carries only what someone wrote in it. What it omits used to reach the write
// path as `undefined` — skipped by the emit, drawn as a default by the Inspector — so a plan
// carrying no parameters showed a fully specified strip and wrote a fraction of it.
const MODEL = getModel("URX44V");
const load = (doc: object): ReturnType<typeof deserialize> => deserialize(JSON.stringify(doc));
const MINIMAL = { format: "urx-router-plan", version: 2, modelId: "URX44V", connections: [] };
const sent = (plan: Parameters<typeof planToCommands>[1]): number => planToCommands(MODEL, plan).length;

describe("fillFactoryParams", () => {
  it("gives a document with no parameters the values the panel already draws", () => {
    const plan = load(MINIMAL);
    const before = sent(plan);
    fillFactoryParams("URX44V", plan);
    // The magnitude is the point, not the number: the write goes from a fraction of the
    // channel strip to the whole of it. Asserted as a ratio so a catalogue that gains a
    // parameter does not have to be re-counted here.
    expect(before * 2).toBeLessThan(sent(plan));
    expect(plan.nodeParams["ch1"]?.on).toBe(true);
  });

  it("keeps every value the document wrote, and completes the group around it", () => {
    const plan = load({ ...MINIMAL, nodeParams: { ch1: { gain: 12, gate: { threshold: -30 } } } });
    fillFactoryParams("URX44V", plan);
    const ch1 = plan.nodeParams["ch1"]!;
    expect(ch1.gain).toBe(12);
    // The written member stands and its siblings arrive — a group written in part is
    // completed rather than replaced, or the rest of the gate stays absent.
    expect(ch1.gate?.threshold).toBe(-30);
    expect(ch1.gate?.attack).toBe(defaultPlan("URX44V").nodeParams["ch1"]?.gate?.attack);
  });

  it("completes an EQ band by index, leaving the bands the document did not name", () => {
    const factory = defaultPlan("URX44V").nodeParams["ch1"]?.eqBands ?? [];
    const plan = load({ ...MINIMAL, nodeParams: { ch1: { eqBands: [{ gain: 4 }] } } });
    fillFactoryParams("URX44V", plan);
    const bands = plan.nodeParams["ch1"]?.eqBands ?? [];
    expect(bands).toHaveLength(factory.length);
    expect(bands[0]?.gain).toBe(4);
    expect(bands[0]?.freq).toBe(factory[0]?.freq);
    expect(bands[1]).toEqual(factory[1]);
  });

  it("adds nothing to a document the app itself wrote", () => {
    // The round trip is the floor: a plan that already carries everything must come back
    // sending exactly what it sent, or the fill is inventing values rather than completing.
    const base = defaultPlan("URX44V");
    const round = deserialize(serialize(base));
    fillFactoryParams("URX44V", round);
    expect(sent(round)).toBe(sent(base));
    expect(round.nodeParams).toEqual(base.nodeParams);
  });

  it("says where each value came from, down to the leaf", () => {
    const plan = load({ ...MINIMAL, nodeParams: { ch1: { gain: 12, gate: { threshold: -30 } } } });
    fillFactoryParams("URX44V", plan);
    const source = plan.paramSource!;
    // Written by whoever wrote the document…
    expect(source.get(nodeParamContestPath("ch1", "gain"))).toBe("load");
    expect(source.get(nodeParamContestPath("ch1", "gate.threshold"))).toBe("load");
    // …completed by the loader, at the same granularity, inside the same group.
    expect(source.get(nodeParamContestPath("ch1", "gate.attack"))).toBe("default");
    expect(source.get(nodeParamContestPath("ch1", "on"))).toBe("default");
    // Array indices are path segments here too, the way the differ names them.
    expect(source.get(nodeParamContestPath("ch1", "eqBands.1.gain"))).toBe("default");
  });

  it("keeps the provenance out of the document and out of undo", () => {
    const plan = load(MINIMAL);
    fillFactoryParams("URX44V", plan);
    expect(plan.paramSource?.size).toBeGreaterThan(0);
    // Never serialized: the document carries state, not a record of who set what.
    expect(JSON.parse(serialize(plan))).not.toHaveProperty("paramSource");
    // …and not part of the undoable state, so an undo cannot restore a stale source.
    expect(clonePlanState(plan)).not.toHaveProperty("paramSource");
  });

  it("leaves an entry the factory does not carry alone", () => {
    // This fills; removing is the load funnel's own job, and a value it kept must not be
    // dropped here on the way past.
    const plan = load({ ...MINIMAL, nodeParams: { ch1: { eqBands: [{}, {}, {}, {}, { gain: 9 }] } } });
    fillFactoryParams("URX44V", plan);
    expect(plan.nodeParams["ch1"]?.eqBands?.[4]).toEqual({ gain: 9 });
  });
});

// A document may write a scalar where the factory holds a group — the load-time sanitiser
// passes it, since what it drops is a non-finite LEAF rather than a leaf standing where a
// record belongs. Left there, the whole group stays absent from the emit and the panel draws
// defaults for a block the write does not send, which is the divergence this fill removes.
describe("a document that wrote a scalar where a group belongs", () => {
  it("completes the group the factory carries there", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams.ch1 = { gate: 5 } as unknown as NodeParams;
    fillFactoryParams("URX44V", plan);
    const gate = plan.nodeParams.ch1?.gate;
    expect(isPlainRecord(gate), "the scalar was replaced by the factory's group").toBe(true);
    expect(typeof gate?.threshold).toBe("number");
    // …and the completion is recorded as the fill's, not as something the document wrote.
    expect(plan.paramSource?.get(nodeParamContestPath("ch1", "gate.threshold"))).toBe("default");
  });

  // The control: a group the document wrote properly is still the document's, untouched.
  it("leaves a group the document wrote", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams.ch1 = { gate: { threshold: -33 } } as NodeParams;
    fillFactoryParams("URX44V", plan);
    expect(plan.nodeParams.ch1?.gate?.threshold).toBe(-33);
    expect(plan.paramSource?.get(nodeParamContestPath("ch1", "gate.threshold"))).toBe("load");
  });
});

// The fill runs once per load today, but a second run over its own output would read every
// value it supplied as one the document wrote — which is the answer the write confirm asks
// for, so the whole warning would fall silent.
it("does not read its own completions as the document's", () => {
  const plan = emptyPlan("URX44V");
  plan.nodeParams.ch1 = { gain: -20 };
  fillFactoryParams("URX44V", plan);
  const before = new Map(plan.paramSource!);
  fillFactoryParams("URX44V", plan);
  expect(plan.paramSource!.size).toBe(before.size);
  for (const [name, from] of before) expect(plan.paramSource!.get(name), name).toBe(from);
});
