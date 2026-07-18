// QA audit (core/plan.ts): JSON round-trip identity, malformed / hostile input
// tolerance, and the fixed-connection seeding contract. These tests pin the
// CURRENT behavior of deserialize so the robustness gaps the audit found are
// documented and any future change to them is intentional. Comments tagged
// "AUDIT" flag a divergence from the ideal contract (see the QA report).

import { describe, it, expect } from "vitest";
import {
  emptyPlan,
  ensureFixedConnections,
  serialize,
  deserialize,
  setExclusiveConnection,
  clearIncoming,
  incomingConnection,
  removeConnection,
  hasConnection,
  PLAN_FORMAT,
  PLAN_VERSION,
  LEVEL_OFF_DB,
} from "./plan";
import { DEFAULT_SAMPLE_RATE } from "./constraints";
import { MODELS, MODEL_IDS } from "../models/index";
import { defaultPlan } from "../models/initial-state";
import { ref } from "../models/types";

describe("serialize / deserialize round-trip identity", () => {
  // The factory-seeded plans are the richest real documents (deep nodeParams,
  // every send, EQ bands, SSMCS). A full plan->JSON->plan cycle must be identity
  // for every model, or a save+reopen silently mutates the user's work.
  it.each(MODEL_IDS)("%s factory plan survives a full JSON round-trip unchanged", (id) => {
    const plan = defaultPlan(id);
    const restored = deserialize(serialize(plan));
    // unreadNodes is transient provenance and intentionally not serialized; the
    // factory plan never sets it, so the two are otherwise structurally equal.
    expect(restored).toEqual(plan);
  });

  it("preserves negative, zero, and fractional levels exactly (no rounding)", () => {
    const plan = emptyPlan("URX44");
    plan.connections.push(
      { from: "ch1:out", to: "bus.mix1:in", kind: "send", params: { level: -96.5, pan: -50.5, tap: "pre" } },
      { from: "ch2:out", to: "bus.mix1:in", kind: "send", params: { level: 0, pan: 0 } },
      { from: "ch3:out", to: "bus.mix1:in", kind: "send", params: { level: 10, pan: 50 } },
    );
    const restored = deserialize(serialize(plan));
    expect(restored.connections).toEqual(plan.connections);
  });

  it("replaces an out-of-table sample rate with the default on load", () => {
    // AUDIT: deserialize validates sampleRate against SAMPLE_RATES so an opened
    // plan can never carry a rate the picker has no <option> for.
    const plan = emptyPlan("URX44");
    plan.sampleRate = 1234;
    expect(deserialize(serialize(plan)).sampleRate).toBe(DEFAULT_SAMPLE_RATE);
  });
});

describe("deserialize tolerance to malformed documents", () => {
  const base = { format: PLAN_FORMAT, version: PLAN_VERSION, modelId: "URX44" };

  it("ignores a future/unknown version field (no version gate today)", () => {
    // AUDIT(low): version is written but never read on load. A document tagged a
    // higher version than this build understands is accepted as-is rather than
    // rejected or migrated. Current behavior: the field is dropped on read.
    const doc = JSON.stringify({ ...base, version: 999, connections: [] });
    expect(() => deserialize(doc)).not.toThrow();
    expect(deserialize(doc).connections).toEqual([]);
  });

  it("coerces a non-array connections value to []", () => {
    const doc = JSON.stringify({ ...base, connections: { not: "an array" } });
    expect(deserialize(doc).connections).toEqual([]);
  });

  it("coerces non-object collections to their empty defaults", () => {
    const doc = JSON.stringify({
      ...base,
      nodeParams: "oops",
      nodeNames: 42,
      nodeColors: null,
      notes: [1, 2, 3], // an array is rejected by isStringRecord
    });
    const plan = deserialize(doc);
    expect(plan.nodeParams).toEqual({});
    expect(plan.nodeNames).toEqual({});
    expect(plan.nodeColors).toEqual({});
    expect(plan.notes).toEqual({});
  });

  it("guards positions symmetrically with the other record collections", () => {
    // positions now runs through isStringRecord like nodeParams / nodeNames / notes,
    // so a hostile/garbled `positions: <number>` falls back to {} instead of
    // surviving as-is (H1 resolved). hidden stays array-guarded.
    const doc = JSON.stringify({ ...base, positions: 5, hidden: "nope" });
    const plan = deserialize(doc);
    expect(plan.positions).toEqual({}); // non-record falls back symmetrically
    expect(plan.hidden).toEqual([]); // hidden IS array-guarded, so it falls back
  });

  it("validates each connection element and drops the invalid ones", () => {
    // Each element must carry string from/to and a known ConnectionKind. A null /
    // partial / wrong-typed element is rejected on read so a wire with an undefined
    // kind can never reach routing's single-input guard. Only the fully-formed
    // element survives (H2 resolved).
    const doc = JSON.stringify({
      ...base,
      connections: [
        null,
        { from: "ch1:out" }, // missing to + kind
        { to: "bus.stereo:in", kind: "send" }, // missing from
        7,
        { from: "ch1:out", to: "bus.stereo:in", kind: "send" }, // valid
      ],
    });
    const plan = deserialize(doc);
    expect(plan.connections).toEqual([{ from: "ch1:out", to: "bus.stereo:in", kind: "send" }]);
  });

  it("drops a connection whose params field is mistyped or carries a non-finite level/pan", () => {
    // params is validated on read so a non-numeric level/pan can never reach the
    // console's number formatting (.toFixed), and a mistyped tap/on can never be
    // mistaken for a real value. A well-formed params survives untouched.
    const doc = JSON.stringify({
      ...base,
      connections: [
        { from: "ch1:out", to: "bus.fx1:in", kind: "send", params: "oops" }, // params not an object
        { from: "ch2:out", to: "bus.fx1:in", kind: "send", params: { level: "abc" } }, // non-numeric level
        { from: "ch3:out", to: "bus.fx1:in", kind: "send", params: { level: Infinity } }, // non-finite
        { from: "ch4:out", to: "bus.fx1:in", kind: "send", params: { pan: NaN } }, // NaN → null in JSON
        { from: "ch5:out", to: "bus.fx1:in", kind: "send", params: { tap: "bogus" } }, // bad enum
        { from: "ch6:out", to: "bus.fx1:in", kind: "send", params: { on: "yes" } }, // non-boolean
        { from: "ch7:out", to: "bus.fx1:in", kind: "send", params: { level: -10, tap: "pre", on: true } }, // valid
      ],
    });
    const plan = deserialize(doc);
    expect(plan.connections).toEqual([
      { from: "ch7:out", to: "bus.fx1:in", kind: "send", params: { level: -10, tap: "pre", on: true } },
    ]);
  });

  it("AUDIT: does NOT deep-validate nodeParams values (asymmetry with connection params)", () => {
    // deserialize validates each connection's params (isValidConnParams: numeric
    // level/pan, boolean flags) so a garbled wire can never reach the console's
    // .toFixed. The per-node nodeParams collection gets only the top-level
    // isStringRecord check — its VALUES pass through untouched. So a hostile /
    // hand-corrupted plan can carry a string level / gain, a non-boolean on, or an
    // entirely wrong-typed entry, and it survives the load verbatim. Downstream
    // formatters guard the common fader paths (fmtDb / levelToPos treat a non-finite
    // or non-number as -∞/off), but the guard is not universal — an inspector
    // rangeSlider format callback calls .toFixed directly on e.g. osc.level. Pin the
    // current (unvalidated) behavior so tightening it is a deliberate change.
    const doc = JSON.stringify({
      ...base,
      nodeParams: {
        ch1: { level: "abc", gain: {}, on: "notbool", hpfFreq: null },
        ch2: "not even an object",
        "bus.osc": { osc: { level: "loud" } },
      },
    });
    const plan = deserialize(doc);
    expect(plan.nodeParams.ch1).toEqual({ level: "abc", gain: {}, on: "notbool", hpfFreq: null });
    expect(plan.nodeParams.ch2 as unknown).toBe("not even an object");
    expect((plan.nodeParams["bus.osc"] as { osc: { level: unknown } }).osc.level).toBe("loud");
  });

  it("accepts a connection with no params field (params is optional)", () => {
    const doc = JSON.stringify({
      ...base,
      connections: [{ from: "ch1:out", to: "bus.stereo:in", kind: "send" }],
    });
    expect(deserialize(doc).connections).toEqual([{ from: "ch1:out", to: "bus.stereo:in", kind: "send" }]);
  });

  it("throws on a syntactically invalid JSON string (JSON.parse propagates)", () => {
    expect(() => deserialize("{ not json")).toThrow();
  });
});

describe("ensureFixedConnections idempotency across models", () => {
  it.each(MODEL_IDS)("%s: a second pass adds nothing and preserves params", (id) => {
    const model = MODELS[id];
    const plan = emptyPlan(id);
    ensureFixedConnections(model, plan);
    const after = JSON.stringify(plan.connections);
    ensureFixedConnections(model, plan);
    expect(JSON.stringify(plan.connections)).toBe(after);
  });

  it.each(MODEL_IDS)("%s: every seeded fixed wire corresponds to a fixed rule", (id) => {
    const model = MODELS[id];
    const plan = emptyPlan(id);
    ensureFixedConnections(model, plan);
    for (const c of plan.connections) {
      const rule = model.rules.find((r) => r.from === c.from && r.to === c.to);
      expect(rule, `${c.from} -> ${c.to}`).toBeDefined();
      expect(rule!.fixed).toBe(true);
    }
  });

  it("seeds the MIX TO ST switch off and FX returns at -inf, then a round-trip keeps them", () => {
    const plan = emptyPlan("URX44");
    ensureFixedConnections(MODELS.URX44, plan);
    const toSt = plan.connections.find((c) => c.from === "bus.mix1:out" && c.to === "bus.stereo:in");
    const fx1 = plan.connections.find((c) => c.from === "bus.fx1:out" && c.to === "bus.stereo:in");
    expect(toSt?.params).toEqual({ on: false });
    expect(fx1?.params).toEqual({ level: LEVEL_OFF_DB });
    const restored = deserialize(serialize(plan));
    expect(restored.connections).toEqual(plan.connections);
  });

  it("re-seeds a fixed wire a user removed (the plan cannot lose structural routing)", () => {
    const plan = emptyPlan("URX44");
    ensureFixedConnections(MODELS.URX44, plan);
    const before = plan.connections.length;
    plan.connections = plan.connections.filter(
      (c) => !(c.from === ref("ch1", "out") && c.to === ref("bus.stereo", "in")),
    );
    expect(plan.connections.length).toBe(before - 1);
    ensureFixedConnections(MODELS.URX44, plan);
    expect(plan.connections.length).toBe(before);
  });
});

describe("emptyPlan independence", () => {
  it("returns a fresh object graph each call (no shared mutable collections)", () => {
    const a = emptyPlan("URX44");
    const b = emptyPlan("URX44");
    a.connections.push({ from: "x:out", to: "y:in", kind: "send" });
    a.nodeParams.ch1 = { on: false };
    expect(b.connections).toEqual([]);
    expect(b.nodeParams).toEqual({});
  });
});

// The exclusive-connection mutators express the single-input invariant as a state
// transition (a source / patch / key receiver holds at most one wire). They are the
// write-side counterpart to canConnect's single-input guard, yet were untested; these
// pin their replace / scope / kind-isolation semantics so the invariant is enforced
// both when querying (canConnect) and when applying (setExclusiveConnection).
describe("exclusive-connection mutators (single-input state transitions)", () => {
  const to = ref("ch1", "in");

  it("setExclusiveConnection replaces the prior same-kind wire (selector holds one input)", () => {
    const plan = emptyPlan("URX44");
    setExclusiveConnection(plan, ref("in.aux", "out"), to, "source");
    setExclusiveConnection(plan, ref("in.usbsub", "out"), to, "source");
    const sources = plan.connections.filter((c) => c.to === to && c.kind === "source");
    expect(sources).toHaveLength(1);
    expect(sources[0].from).toBe(ref("in.usbsub", "out")); // the latest wins
  });

  it("setExclusiveConnection leaves a wire of a DIFFERENT kind into the same port intact", () => {
    // clearIncoming filters on kind, so a summing send into the port survives a
    // source select — only the source slot is exclusive, the summing bus is not.
    const plan = emptyPlan("URX44");
    plan.connections.push({ from: ref("in.aux", "out"), to, kind: "send" });
    setExclusiveConnection(plan, ref("in.usbsub", "out"), to, "source");
    expect(plan.connections).toHaveLength(2);
    expect(plan.connections.some((c) => c.to === to && c.kind === "send")).toBe(true);
    expect(plan.connections.some((c) => c.to === to && c.kind === "source")).toBe(true);
  });

  it("clearIncoming removes only the matching kind into the target, by-target scoped", () => {
    const plan = emptyPlan("URX44");
    plan.connections.push(
      { from: ref("in.aux", "out"), to, kind: "source" },
      { from: ref("in.aux", "out"), to, kind: "send" },
      { from: ref("in.aux", "out"), to: ref("ch2", "in"), kind: "source" }, // other target
    );
    clearIncoming(plan, to, "source");
    expect(hasConnection(plan, ref("in.aux", "out"), to)).toBe(true); // the send survives
    expect(plan.connections.filter((c) => c.to === to && c.kind === "source")).toHaveLength(0);
    expect(plan.connections.some((c) => c.to === ref("ch2", "in") && c.kind === "source")).toBe(true);
  });

  it("incomingConnection finds the wire of the requested kind and returns undefined when absent", () => {
    const plan = emptyPlan("URX44");
    plan.connections.push(
      { from: ref("in.aux", "out"), to, kind: "send" },
      { from: ref("in.usbsub", "out"), to, kind: "source" },
    );
    expect(incomingConnection(plan, to, "source")?.from).toBe(ref("in.usbsub", "out"));
    expect(incomingConnection(plan, to, "patch")).toBeUndefined(); // no patch wire here
  });

  it("setExclusiveConnection drops any params on the replaced wire (it writes a bare wire)", () => {
    // The mutator pushes { from, to, kind } with no params; a prior wire's params
    // (a stale level/pan a hand path may have left) do not carry over. Pin it.
    const plan = emptyPlan("URX44");
    plan.connections.push({ from: ref("in.aux", "out"), to, kind: "source", params: { level: -6 } });
    setExclusiveConnection(plan, ref("in.usbsub", "out"), to, "source");
    expect(plan.connections[0].params).toBeUndefined();
  });

  it("removeConnection is a no-op for an absent wire (idempotent delete)", () => {
    const plan = emptyPlan("URX44");
    plan.connections.push({ from: ref("in.aux", "out"), to, kind: "source" });
    removeConnection(plan, ref("nope", "out"), ref("nope2", "in"));
    expect(plan.connections).toHaveLength(1);
    removeConnection(plan, ref("in.aux", "out"), to);
    expect(plan.connections).toHaveLength(0);
  });
});

// A round trip that exercises every mutator path against a real model, then saves
// and reloads — the combined state-transition + persistence invariant the UI relies
// on (an edit session never silently mutates unrelated routing across a save).
describe("mixed mutator sequence + persistence round-trip (URX44V)", () => {
  it("a source-select, send-edit and fixed-wire re-seed all survive a JSON round-trip", () => {
    const model = MODELS.URX44V;
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    // Select an input source on ch1 (exclusive), then re-select (replace).
    setExclusiveConnection(plan, ref("in.aux", "out"), ref("ch1", "in"), "source");
    setExclusiveConnection(plan, ref("in.micline_1_2", "out"), ref("ch1", "in"), "source");
    // Raise the ch1 → MIX1 fixed send off its -∞ seed.
    const mix = plan.connections.find((c) => c.from === ref("ch1", "out") && c.to === ref("bus.mix1", "in"));
    if (!mix) throw new Error("expected the seeded ch1 → MIX1 send");
    mix.params = { ...mix.params, level: -12, tap: "pre" };
    const restored = deserialize(serialize(plan));
    expect(restored.connections).toEqual(plan.connections);
    // Exactly one source into ch1 (the second select replaced the first).
    expect(restored.connections.filter((c) => c.to === ref("ch1", "in") && c.kind === "source")).toHaveLength(1);
  });
});
