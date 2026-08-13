// QA audit (core/plan.ts): JSON round-trip identity, malformed / hostile input
// tolerance, and the fixed-connection seeding contract. These tests pin the
// CURRENT behavior of deserialize so the robustness gaps the audit found are
// documented and any future change to them is intentional. Comments tagged
// "AUDIT" flag a divergence from the ideal contract (see the QA report).

import { describe, it, expect } from "vitest";
import {
  clipNodeName,
  normalizeNodeName,
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
  PlanError,
  LEVEL_OFF_DB,
} from "./plan";
import type { Plan } from "./plan";
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

  it("refuses a document tagged newer than this build", () => {
    // A newer document may carry semantics this build would misread, and a plan
    // drives writes to real hardware — so it is refused with a typed code rather
    // than half-read.
    const doc = JSON.stringify({ ...base, version: 999, connections: [] });
    expect(() => deserialize(doc)).toThrow(PlanError);
    try {
      deserialize(doc);
    } catch (e) {
      expect((e as PlanError).code).toBe("planVersionUnsupported");
    }
  });

  it("accepts the current version, and an absent / non-numeric one as current", () => {
    expect(deserialize(JSON.stringify({ ...base, connections: [] })).connections).toEqual([]);
    // A hand-authored plan that omits version (or mistypes it) still loads.
    const noVersion = JSON.stringify({ format: PLAN_FORMAT, modelId: "URX44", connections: [] });
    expect(() => deserialize(noVersion)).not.toThrow();
    expect(() => deserialize(JSON.stringify({ ...base, version: "abc" }))).not.toThrow();
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
      notes: [1, 2, 3], // an array is rejected by the record guard
    });
    const plan = deserialize(doc);
    expect(plan.nodeParams).toEqual({});
    expect(plan.nodeNames).toEqual({});
    expect(plan.nodeColors).toEqual({});
    expect(plan.notes).toEqual({});
  });

  it("guards positions symmetrically with the other record collections", () => {
    // positions runs through the same record guard as nodeParams / nodeNames / notes,
    // so a hostile/garbled `positions: <number>` falls back to {} instead of
    // surviving as-is (H1 resolved). hidden stays array-guarded.
    const doc = JSON.stringify({ ...base, positions: 5, hidden: "nope" });
    const plan = deserialize(doc);
    expect(plan.positions).toEqual({}); // non-record falls back symmetrically
    expect(plan.hidden).toEqual([]); // hidden IS array-guarded, so it falls back
  });

  it("drops the non-string ELEMENTS of the string collections", () => {
    // The container check alone was the gap: a well-formed object whose values are not
    // strings passed, and the graph reaches every note on every render
    // (`(plan.notes?.[id] ?? "").trim()`), so the document loaded and the canvas threw
    // on its first paint. Element-level now, like connections and nodeParams, and by
    // dropping rather than refusing — absence is already "nothing set here".
    const doc = JSON.stringify({
      ...base,
      notes: { ch1: {}, ch2: "kick", ch3: 7 },
      nodeNames: { ch1: ["nope"], ch2: "Kick" },
      nodeColors: { ch1: null, ch2: "#ff0000" },
      hidden: ["ch1", 5, null],
      noteCollapsed: [{}, "ch2"],
    });
    const plan = deserialize(doc);
    expect(plan.notes).toEqual({ ch2: "kick" });
    expect(plan.nodeNames).toEqual({ ch2: "Kick" });
    expect(plan.nodeColors).toEqual({ ch2: "#ff0000" });
    expect(plan.hidden).toEqual(["ch1"]);
    expect(plan.noteCollapsed).toEqual(["ch2"]);
  });

  it("drops a position whose coordinates are not finite numbers", () => {
    // One bad entry among good ones is the case a whole-collection fallback misses:
    // contentBounds only recovers when NOTHING is finite, so a single NaN folded into
    // the min/max frames the view on nothing.
    const doc = JSON.stringify({
      ...base,
      positions: { ch1: { x: 10, y: 20 }, ch2: { x: "5", y: 0 }, ch3: null, ch4: { x: 1 } },
    });
    expect(deserialize(doc).positions).toEqual({ ch1: { x: 10, y: 20 } });
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

  it("deep-validates nodeParams values, symmetrically with connection params", () => {
    // Every NodeParams leaf is a boolean or a number, so a leaf that is anything
    // else is dropped on read — absence is the documented "device default" state,
    // whereas a surviving string would reach an inspector rangeSlider format
    // callback that calls .toFixed on it. A non-record node entry is dropped whole.
    const doc = JSON.stringify({
      ...base,
      nodeParams: {
        ch1: { level: "abc", gain: {}, on: "notbool", hpfFreq: null, phantom: true, pan: 12 },
        ch2: "not even an object",
        "bus.osc": { osc: { level: "loud", freq: 1000, on: true } },
      },
    });
    const plan = deserialize(doc);
    // Malformed leaves gone; well-formed ones (including a nested group) kept.
    expect(plan.nodeParams.ch1).toEqual({ phantom: true, pan: 12 });
    expect(plan.nodeParams.ch2).toBeUndefined();
    expect(plan.nodeParams["bus.osc"]?.osc).toEqual({ freq: 1000, on: true });
  });

  it("drops non-finite numbers, and an eqBands array with any malformed element", () => {
    const doc = JSON.stringify({
      ...base,
      nodeParams: {
        // JSON has no NaN/Infinity literal, so they arrive as null — same drop path.
        ch1: { gain: null, level: 3 },
        ch2: { eqBands: [{ freq: 100 }, "bogus"] },
        ch3: { eqBands: [{ freq: 100 }, { gain: 2 }] },
      },
    });
    const plan = deserialize(doc);
    expect(plan.nodeParams.ch1).toEqual({ level: 3 });
    expect(plan.nodeParams.ch2).toEqual({}); // one bad band drops the array, not the node
    expect(plan.nodeParams.ch3?.eqBands).toEqual([{ freq: 100 }, { gain: 2 }]);
  });

  it("keeps a well-formed unknown key (forward compatibility within a version)", () => {
    const doc = JSON.stringify({ ...base, nodeParams: { ch1: { futureFlag: true, futureValue: 7 } } });
    expect(deserialize(doc).nodeParams.ch1).toEqual({ futureFlag: true, futureValue: 7 });
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

// A CH SETTING name is bounded by what the unit's own text-input screen can produce:
// 8 characters. Nothing else in the stack enforces it — measured on a URX44V, the
// broker stores a 20-character name and reads it back unchanged, and the settings
// file's 64-byte element is the container rather than the limit. Names are the one
// plan string that leaves the app over the device link; the numeric leaves have
// `boundRaw` between them and the wire and nothing played that part for strings, so
// a crafted plan's multi-kilobyte name loaded silently and rode `vd_set_str` uncut —
// and a 63-character one drew a node label across its neighbours on the canvas.
describe("node names are bounded by what the unit can hold", () => {
  const chars = (s: string): number => [...s].length;

  // Both sides of the bound, or "keeps what fits" passes at any width.
  it("keeps a name of exactly the unit's limit, and cuts the next character", () => {
    const exact = "ch 1xxxx";
    expect(chars(exact)).toBe(8);
    expect(clipNodeName(exact)).toBe(exact);
    expect(clipNodeName(`${exact}y`)).toBe(exact);
  });

  it("cuts a longer name to the limit", () => {
    expect(clipNodeName("y".repeat(500))).toBe("y".repeat(8));
  });

  // Counted in code points, so a surrogate pair is one character and is never split.
  // Byte-counting would also make the limit depend on the script, which the unit's
  // own screen does not.
  it("counts characters rather than bytes, and never splits one", () => {
    for (const unit of ["あ", "🎸", "Ø"]) {
      const cut = clipNodeName(unit.repeat(200));
      expect(chars(cut)).toBe(8);
      expect(cut).toBe(unit.repeat(8));
      // A cut that lost half a character re-encodes to U+FFFD rather than to itself.
      // (A `startsWith` check does not catch it: a lone high surrogate IS a prefix of
      // the pair it came from, so the split character passes as whole.)
      expect(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(cut))).toBe(cut);
    }
  });

  it("applies the bound at the load funnel, so a crafted document cannot carry one past it", () => {
    const doc = JSON.stringify({
      format: PLAN_FORMAT,
      version: PLAN_VERSION,
      modelId: "URX44V",
      nodeNames: { ch1: "z".repeat(4000), ch2: "Kick" },
    });
    const plan = deserialize(doc);
    expect(plan.nodeNames["ch1"]).toBe("z".repeat(8));
    // An ordinary name is untouched — the guard bounds, it does not rewrite.
    expect(plan.nodeNames["ch2"]).toBe("Kick");
  });

  // The second half of what a stored name is. The device keeps a trailing space rather
  // than treating it as padding (measured on a URX44V, 2026-08-14: `"SPCTEST "` is
  // stored and read back unchanged), while every read path trims one off — so a plan
  // holding one is never equal to what the device answers, and the name is re-sent on
  // every sync forever. Nothing shows it: the two render identically.
  it("drops trailing padding from a stored name, and keeps a leading space", () => {
    expect(normalizeNodeName("Kick ")).toBe("Kick");
    expect(normalizeNodeName("Kick\t\n ")).toBe("Kick");
    // trimEnd and not trim: the device right-aligns the numbers in the stereo pair
    // labels, so a LEADING space is part of the factory name and stripping it would
    // write the shortened form back on the next sync.
    expect(normalizeNodeName(" 5/ 6")).toBe(" 5/ 6");
    // All blank is no name at all — the callers delete the key on an empty result.
    expect(normalizeNodeName("    ")).toBe("");
  });

  // Cut first, then trim. The other order hands the cut a string whose eighth character
  // is a space and has no second pass to remove it.
  it("cannot leave a trailing space behind by cutting onto one", () => {
    const cutsOntoASpace = "1234567  9";
    expect(chars(cutsOntoASpace)).toBeGreaterThan(8);
    expect(normalizeNodeName(cutsOntoASpace)).toBe("1234567");
    // The order that does not work, pinned so the reason survives the next rewrite:
    // trimming first finds nothing to trim, and the cut then ends on the space.
    expect(clipNodeName(cutsOntoASpace.trimEnd())).toBe("1234567 ");
  });

  it("applies that at the load funnel too", () => {
    const doc = JSON.stringify({
      format: PLAN_FORMAT,
      version: PLAN_VERSION,
      modelId: "URX44V",
      nodeNames: { ch1: "Kick ", ch2: " 5/ 6" },
    });
    const plan = deserialize(doc);
    expect(plan.nodeNames["ch1"]).toBe("Kick");
    expect(plan.nodeNames["ch2"]).toBe(" 5/ 6");
  });
});

// `JSON.parse` gives a document an own `"__proto__"` property, but assigning it onto
// a fresh `{}` goes through the inherited accessor and replaces that object's
// prototype instead of storing an entry — and every collection the loader rebuilds is
// built by assignment. What a crafted plan buys with it is a set of values the app
// reads and the rest of the stack cannot see: an own-key walk finds nothing, so
// serialize, the differ and the write witness all report an empty record while the
// graph, the console and the device emit read the inherited values.
describe("a hostile key cannot hand a rebuilt record its prototype", () => {
  // Written as JSON TEXT, not through an object literal. `{ __proto__: … }` in source
  // sets the literal's own prototype, so `JSON.stringify` of it emits `{}` and the case
  // would test nothing while passing — the document has to reach `JSON.parse`, which is
  // what produces the own `"__proto__"` property this is about.
  const load = (body: string): Plan =>
    deserialize(`{"format":"${PLAN_FORMAT}","version":${PLAN_VERSION},"modelId":"URX44V",${body}}`);

  it("drops it from a node's parameters instead of muting the channel", () => {
    const plan = load('"nodeParams":{"ch1":{"__proto__":{"on":false,"gain":70}}}');
    // The inherited read is what the emit and the views would have taken.
    expect(plan.nodeParams["ch1"]?.on).toBeUndefined();
    expect(Object.getPrototypeOf(plan.nodeParams["ch1"] ?? {})).toBe(Object.prototype);
  });

  it("drops it as a node id, a name, a colour and a position", () => {
    const plan = load(
      '"nodeParams":{"__proto__":{"on":false}},"nodeNames":{"__proto__":"x"},' +
        '"nodeColors":{"__proto__":"#000000"},"positions":{"__proto__":{"x":1,"y":2}}',
    );
    for (const rec of [plan.nodeParams, plan.nodeNames, plan.nodeColors, plan.positions]) {
      expect(Object.getPrototypeOf(rec)).toBe(Object.prototype);
      expect(Object.keys(rec)).toHaveLength(0);
    }
    // The record is a plain object again: nothing reads a phantom entry off it.
    expect((plan.nodeNames as Record<string, unknown>)["on"]).toBeUndefined();
  });
});

// The node side rebuilds a sanitized copy and drops a leaf it does not recognise; the
// wire side used to filter and keep the parsed object, so an unknown key of any type
// rode every clone, diff and save forever. Nothing crashed on it — which is why it
// lasted — but the two collection guards disagreed about what a loaded document may
// contain.
describe("a loaded wire carries its four known fields and nothing else", () => {
  it("drops extras beside the wire and inside its params", () => {
    const doc = JSON.stringify({
      format: PLAN_FORMAT,
      version: PLAN_VERSION,
      modelId: "URX44V",
      connections: [
        {
          from: ref("ch1", "out"),
          to: ref("bus.stereo", "in"),
          kind: "send",
          junk: { a: "x" },
          params: { level: -6, extra: "str" },
        },
      ],
    });
    const c = deserialize(doc).connections.find((w) => w.from === ref("ch1", "out"))!;
    expect(Object.keys(c).sort()).toEqual(["from", "kind", "params", "to"]);
    expect(Object.keys(c.params!)).toEqual(["level"]);
    expect(c.params!.level).toBe(-6);
  });

  it("keeps a wire with no params as a wire with no params", () => {
    const doc = JSON.stringify({
      format: PLAN_FORMAT,
      version: PLAN_VERSION,
      modelId: "URX44V",
      connections: [{ from: ref("ch1", "out"), to: ref("bus.mix1", "in"), kind: "send" }],
    });
    const c = deserialize(doc).connections.find((w) => w.to === ref("bus.mix1", "in"))!;
    expect("params" in c).toBe(false);
  });
});

// The kind is a function of (from, to), stated as an invariant and enforced nowhere.
// A document carrying a real pair under the wrong kind passed the whole load funnel —
// a rule exists, the receiver is not over-subscribed, the pair is not duplicated — and
// then each consumer trusted a different one of the two encodings.
describe("a wire's kind is restated from the rule table", () => {
  it("rewrites a kind the rules disagree with, and leaves a ruleless wire alone", () => {
    const plan = emptyPlan("URX44V");
    // A real output-patch pair, stored as a send. Read as a send it is no longer
    // scene-external (a scene-scoped save would take the output patch with it), while
    // the emit looks it up as a patch, finds nothing, and writes the selector NONE.
    const patch = MODELS.URX44V.rules.find((r) => r.kind === "patch")!;
    plan.connections.push({ from: patch.from, to: patch.to, kind: "send" });
    plan.connections.push({ from: "nowhere:out", to: "nothing:in", kind: "send" });

    ensureFixedConnections(MODELS.URX44V, plan);

    expect(plan.connections.find((c) => c.from === patch.from && c.to === patch.to)!.kind).toBe("patch");
    // No rule, no restatement: that wire is validatePlan's to refuse, and quietly
    // giving it a kind here would hide it.
    expect(plan.connections.find((c) => c.from === "nowhere:out")!.kind).toBe("send");
  });
});
