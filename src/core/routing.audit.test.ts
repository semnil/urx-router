// QA audit (core/routing.ts + constraints.ts): connection-rule symmetry,
// idempotency / determinism of the query helpers, single-input invariants under
// edge inputs, and the sample-rate constraint boundary (BVA). Comments tagged
// "AUDIT" flag a divergence from the ideal contract (see the QA report).

import { describe, it, expect } from "vitest";
import { MODELS, MODEL_IDS } from "../models/index";
import { ref, parseRef, isSingleInput } from "../models/types";
import {
  canConnect,
  legalTargets,
  legalSources,
  possibleSources,
  possibleTargets,
  partnerChannel,
  pairPrimary,
  sendHasOn,
  sendHasTap,
  mirrorBalPair,
} from "./routing";
import { emptyPlan, setExclusiveConnection } from "./plan";
import { rateConstraints, SAMPLE_RATES } from "./constraints";
import { defaultPlan } from "../models/initial-state";
import { PAN_BAL_BAL } from "./control/params";

describe("rule integrity per model", () => {
  it.each(MODEL_IDS)("%s: no duplicate (from,to) rule pairs", (id) => {
    const seen = new Set<string>();
    const dups: string[] = [];
    for (const r of MODELS[id].rules) {
      const key = `${r.from}>${r.to}`;
      if (seen.has(key)) dups.push(key);
      seen.add(key);
    }
    expect(dups).toEqual([]);
  });

  it.each(MODEL_IDS)("%s: no self-loop and no rule from an in-port or into an out-port", (id) => {
    for (const r of MODELS[id].rules) {
      expect(parseRef(r.from).nodeId, `${id} self-loop ${r.from}`).not.toBe(parseRef(r.to).nodeId);
      // from must be an output port id "out", to must be an input port id "in".
      expect(parseRef(r.from).portId).toBe("out");
      expect(parseRef(r.to).portId).toBe("in");
    }
  });

  it.each(MODEL_IDS)("%s: every fixed rule is a send or sendSwitch (never a single-input selector)", (id) => {
    for (const r of MODELS[id].rules) {
      if (!r.fixed) continue;
      expect(isSingleInput(r.kind), `${id} ${r.from}->${r.to}`).toBe(false);
    }
  });
});

describe("possibleTargets / possibleSources are exact inverses of the rule set", () => {
  it.each(MODEL_IDS)("%s: to in possibleTargets(from) iff from in possibleSources(to)", (id) => {
    const model = MODELS[id];
    for (const r of model.rules) {
      expect(possibleTargets(model, r.from).has(r.to), `T ${r.from}->${r.to}`).toBe(true);
      expect(possibleSources(model, r.to).has(r.from), `S ${r.from}->${r.to}`).toBe(true);
    }
  });
});

describe("legal* is a subset of possible*, and equal on an empty plan", () => {
  it.each(MODEL_IDS)("%s: legalTargets ⊆ possibleTargets always", (id) => {
    const model = MODELS[id];
    const plan = emptyPlan(id);
    // Occupy one single-input output patch so at least one target is filtered.
    plan.connections.push({ from: ref("bus.stereo", "out"), to: ref("out.main", "in"), kind: "patch" });
    for (const r of model.rules) {
      const legal = legalTargets(model, plan, r.from);
      const possible = possibleTargets(model, r.from);
      for (const t of legal) expect(possible.has(t), `${r.from} -> ${t}`).toBe(true);
    }
  });

  it.each(MODEL_IDS)("%s: on an empty plan legalTargets equals possibleTargets (nothing occupied)", (id) => {
    const model = MODELS[id];
    const plan = emptyPlan(id);
    const froms = new Set(model.rules.map((r) => r.from));
    for (const from of froms) {
      expect([...legalTargets(model, plan, from)].sort()).toEqual([...possibleTargets(model, from)].sort());
    }
  });
});

describe("canConnect determinism and self-consistency", () => {
  const u44 = MODELS.URX44;

  it("is deterministic: repeated calls on the same plan agree", () => {
    const plan = emptyPlan("URX44");
    const a = canConnect(u44, plan, ref("ch1", "out"), ref("bus.stereo", "in"));
    const b = canConnect(u44, plan, ref("ch1", "out"), ref("bus.stereo", "in"));
    expect(a).toEqual(b);
  });

  it("a legal connection, once applied, reports as a duplicate (the only failure mode for a fresh summing wire)", () => {
    const plan = emptyPlan("URX44");
    const from = ref("ch1", "out");
    const to = ref("bus.stereo", "in");
    expect(canConnect(u44, plan, from, to).ok).toBe(true);
    plan.connections.push({ from, to, kind: "send" });
    expect(canConnect(u44, plan, from, to).reason).toBe("duplicate");
  });

  it("counts single-input occupancy kind-agnostically, so a wrong-kind wire still blocks a source select", () => {
    // The single-input guard counts ANY existing wire into the port, not only ones
    // whose stored c.kind is itself single-input. A pre-existing wire saved with a
    // WRONG kind (e.g. a 'send' into a source receiver, which a hand-edited/garbled
    // plan could carry) still occupies the slot, so a real source select is blocked
    // rather than letting the selector hold two inputs (M1 resolved).
    const plan = emptyPlan("URX44");
    // Inject a malformed wire into ch1:in tagged as a summing send.
    plan.connections.push({ from: ref("in.aux", "out"), to: ref("ch1", "in"), kind: "send" });
    const r = canConnect(u44, plan, ref("in.micline_1_2", "out"), ref("ch1", "in"));
    // The malformed 'send' counts as occupancy, so the source slot is full.
    expect(r.reason).toBe("singleInput");
  });

  it("rejects an entirely unknown node pair with noRule (no rule fabricated)", () => {
    const plan = emptyPlan("URX44");
    expect(canConnect(u44, plan, ref("nope", "out"), ref("nope2", "in")).reason).toBe("noRule");
  });
});

describe("channel pairing helpers", () => {
  it.each(MODEL_IDS)("%s: partnerChannel is symmetric and self-exclusive", (id) => {
    const model = MODELS[id];
    for (const [a, b] of model.channelPairs) {
      expect(partnerChannel(model, a)).toBe(b);
      expect(partnerChannel(model, b)).toBe(a);
      expect(partnerChannel(model, a)).not.toBe(a);
    }
  });

  it.each(MODEL_IDS)("%s: pairPrimary returns the odd/first channel for both members, null off-pair", (id) => {
    const model = MODELS[id];
    for (const [a, b] of model.channelPairs) {
      expect(pairPrimary(model, a)).toBe(a);
      expect(pairPrimary(model, b)).toBe(a);
    }
    expect(pairPrimary(model, "bus.stereo")).toBeNull();
    expect(pairPrimary(model, "nope")).toBeNull();
  });
});

describe("send predicate consistency", () => {
  const u44 = MODELS.URX44;
  it("every tapped send also carries an ON switch (sendHasTap ⊆ sendHasOn)", () => {
    for (const r of u44.rules) {
      if (sendHasTap(u44, r.from, r.to)) {
        expect(sendHasOn(u44, r.from, r.to), `${r.from}->${r.to}`).toBe(true);
      }
    }
  });

  it("the fixed MIX -> STEREO TO ST has an ON switch but no PRE/POST tap", () => {
    expect(sendHasTap(u44, ref("bus.mix1", "out"), ref("bus.stereo", "in"))).toBe(false);
    expect(sendHasOn(u44, ref("bus.mix1", "out"), ref("bus.stereo", "in"))).toBe(true);
  });

  it("the CH/FX main path into STEREO has a STEREO-assign ON switch but no PRE/POST tap (firmware V1.3)", () => {
    expect(sendHasTap(u44, ref("ch1", "out"), ref("bus.stereo", "in"))).toBe(false);
    expect(sendHasOn(u44, ref("ch1", "out"), ref("bus.stereo", "in"))).toBe(true);
    expect(sendHasOn(u44, ref("bus.fx1", "out"), ref("bus.stereo", "in"))).toBe(true);
    // OSC → STEREO is removable (not fixed), so its on/off is wire presence, not a send ON.
    expect(sendHasOn(u44, ref("bus.osc", "out"), ref("bus.stereo", "in"))).toBe(false);
  });
});

describe("rateConstraints boundary (BVA around 96 kHz)", () => {
  it.each(MODEL_IDS)("%s: exactly 96000 is below the FX cutoff (boundary is strict >)", (id) => {
    const c = rateConstraints(MODELS[id], 96000);
    expect(c.warnings).toEqual([]);
    expect(c.disabledNodes).toEqual([]);
  });

  it.each(MODEL_IDS)("%s: just above 96000 already trips the insert-FX warning", (id) => {
    expect(rateConstraints(MODELS[id], 96001).warnings).toContain("insFx");
  });

  it("the two high rates produce identical constraints (no per-rate distinction above 96k)", () => {
    for (const id of MODEL_IDS) {
      expect(rateConstraints(MODELS[id], 176400)).toEqual(rateConstraints(MODELS[id], 192000));
    }
  });

  it("AUDIT: an out-of-table rate is still classified by the same > 96000 rule", () => {
    // rateConstraints does not require the rate to be in SAMPLE_RATES; a stray
    // 200000 is treated like any > 96k rate. Documents the gap (FINDING L1).
    expect(SAMPLE_RATES).not.toContain(200000);
    expect(rateConstraints(MODELS.URX44, 200000).warnings).toContain("insFx");
  });

  it("URX22 (no FX2 node? it has one) — fx2 disable only fires when the bus exists", () => {
    // URX22 does have bus.fx2; assert the disable list references a real node.
    const c = rateConstraints(MODELS.URX22, 192000);
    for (const id of c.disabledNodes) {
      expect(
        MODELS.URX22.nodes.some((n) => n.id === id),
        id,
      ).toBe(true);
    }
  });

  it("AUDIT: a negative / zero rate falls in the ≤ 96000 branch (no warnings, not rejected)", () => {
    // The boundary is a bare `> 96000`, so any rate at or below it — including the
    // physically impossible 0 / negative a garbled plan could carry — is treated as
    // a normal low rate with no FX warnings rather than being flagged. Documents the
    // gap (the rate is never validated for plausibility here). See FINDING L1.
    expect(rateConstraints(MODELS.URX44, 0).warnings).toEqual([]);
    expect(rateConstraints(MODELS.URX44, -48000).warnings).toEqual([]);
  });
});

// Topology invariants on the generated rule set that the canConnect / mutator layer
// relies on. The block-diagram transcription (build.ts) is the source of truth; these
// pin the load-bearing shapes (ducker self-key, OSC removability, send fan-in) so a
// future rule edit that breaks them is caught.
describe("rule-set topology invariants the connect layer relies on", () => {
  it.each(MODEL_IDS)("%s: a stereo channel's ducker may key off the channel itself (self-key is allowed)", (id) => {
    // build.ts seeds ducker key sources from [...channels, STEREO, MIX1, MIX2],
    // including the host channel, so a ducker can trigger from its own pair. Pin
    // this as intended (it is a valid sidechain choice), not an accidental loop.
    const model = MODELS[id];
    const duckers = model.nodes.filter((n) => n.kind === "ducker");
    if (duckers.length === 0) return; // URX22 has no stereo channels → no duckers
    const d = duckers[0];
    const host = d.attachTo!;
    const selfKey = model.rules.find((r) => r.from === ref(host, "out") && r.to === ref(d.id, "in"));
    expect(selfKey, `${host} -> ${d.id}`).toBeDefined();
    expect(selfKey!.kind).toBe("key");
    expect(selfKey!.fixed).toBeFalsy(); // selectable, never seeded
  });

  it.each(MODEL_IDS)("%s: every ducker key rule is a single-input 'key' (never a summing send)", (id) => {
    const model = MODELS[id];
    for (const r of model.rules) {
      if (parseRef(r.to).nodeId.startsWith("out.ducker")) {
        expect(isSingleInput(r.kind), `${r.from}->${r.to}`).toBe(true);
        expect(r.kind).toBe("key");
      }
    }
  });

  it.each(MODEL_IDS)("%s: OSC → bus assigns are non-fixed sendSwitch (removable, never auto-seeded)", (id) => {
    const model = MODELS[id];
    const oscRules = model.rules.filter((r) => parseRef(r.from).nodeId === "bus.osc");
    expect(oscRules.length).toBeGreaterThan(0);
    for (const r of oscRules) {
      expect(r.kind, `${r.from}->${r.to}`).toBe("sendSwitch");
      expect(r.fixed).toBeFalsy(); // OSC assign is optional, so ensureFixedConnections skips it
    }
  });

  it.each(MODEL_IDS)("%s: a summing bus (STEREO) accepts many incoming sendSwitch/send wires at once", (id) => {
    // canConnect's single-input guard must NOT fire for a summing receiver: an OSC
    // assign and a MIX 'TO ST' switch and a channel main send can all coexist into
    // STEREO. Pin the fan-in so a regression that mis-tags STEREO as single-input
    // (which would silently drop wires) is caught.
    const model = MODELS[id];
    const stereo = ref("bus.stereo", "in");
    const plan = emptyPlan(id);
    plan.connections.push({ from: ref("bus.osc", "out"), to: stereo, kind: "sendSwitch" });
    const ch1Send = canConnect(model, plan, ref("ch1", "out"), stereo);
    const mixToSt = canConnect(model, plan, ref("bus.mix1", "out"), stereo);
    expect(ch1Send.ok).toBe(true);
    expect(mixToSt.ok).toBe(true);
  });
});

// The write-side mutator (setExclusiveConnection) and the query-side guard
// (canConnect) must agree on the single-input contract: after the mutator applies,
// the displaced source must be re-connectable and the new one a duplicate.
describe("setExclusiveConnection ↔ canConnect single-input consistency (URX44V)", () => {
  const model = MODELS.URX44V;
  const chIn = ref("ch1", "in");

  it("after an exclusive source select, re-selecting the same source reports duplicate", () => {
    const plan = emptyPlan("URX44V");
    setExclusiveConnection(plan, ref("in.aux", "out"), chIn, "source");
    expect(canConnect(model, plan, ref("in.aux", "out"), chIn).reason).toBe("duplicate");
  });

  it("a replacement keeps the slot single-input: the new source duplicates, the old is now singleInput-blocked", () => {
    // canConnect only ever permits a fresh wire into an EMPTY single-input slot; the
    // mutator is the only way to swap an occupied one. After a replace, the slot
    // holds exactly the replacement: re-adding it is a duplicate, re-adding the
    // displaced source is blocked (the slot is full again), so legalSources is empty.
    const plan = emptyPlan("URX44V");
    setExclusiveConnection(plan, ref("in.aux", "out"), chIn, "source");
    expect(canConnect(model, plan, ref("in.micline_1_2", "out"), chIn).reason).toBe("singleInput");
    setExclusiveConnection(plan, ref("in.micline_1_2", "out"), chIn, "source");
    expect(plan.connections.filter((c) => c.to === chIn && c.kind === "source")).toHaveLength(1);
    expect(canConnect(model, plan, ref("in.micline_1_2", "out"), chIn).reason).toBe("duplicate");
    expect(canConnect(model, plan, ref("in.aux", "out"), chIn).reason).toBe("singleInput");
    // No source is freely addable while the slot is occupied (swap must go via the mutator).
    expect(legalSources(model, plan, chIn).size).toBe(0);
  });
});

// canConnect counts occupancy on a single-input port kind-agnostically (any wire into
// the port blocks a new source/patch/key/record). That count is only self-consistent
// if a port never mixes a single-input rule with a summing (send/sendSwitch) rule:
// otherwise adding the summing wire would be allowed while adding the selector wire
// would be blocked by that same summing wire (an asymmetry). Pin that no generated
// input port is ever "mixed", so the kind-agnostic guard stays sound across models.
describe("no input port mixes a single-input rule with a summing rule", () => {
  it.each(MODEL_IDS)("%s: every destination port is either all-single-input or all-summing", (id) => {
    const byTo = new Map<string, boolean[]>();
    for (const r of MODELS[id].rules) {
      const arr = byTo.get(r.to) ?? [];
      arr.push(isSingleInput(r.kind));
      byTo.set(r.to, arr);
    }
    for (const [to, kinds] of byTo) {
      const allSame = kinds.every((k) => k === kinds[0]);
      expect(allSame, `${id} port ${to} mixes single-input and summing rules`).toBe(true);
    }
  });
});

// AUDIT (routing.ts mirrorBalPair, S4 latent — FIXED): the mirror used to shallow-spread
// the source channel's nodeParams onto the partner, sharing the NESTED param objects
// (gate / comp / eqBands / ssmcs / osc / eqOneKnob) by reference. That was benign under
// the standard edit path (onUpdateNodeParams rebuilds the top-level object and every
// linked edit re-mirrors), but an in-place mutation bled into the partner — and the alias
// outlived the link, persisting until a replace-style edit or a JSON round-trip broke it.
// The mirror now deep-copies; these tests pin that so a regression to sharing is caught.
describe("mirrorBalPair deep-copies nested param objects", () => {
  it("gives the partner its own nested gate/eqBands, with equal values", () => {
    const plan = defaultPlan("URX44");
    plan.nodeParams.ch1 = {
      stereoLink: true,
      panBal: PAN_BAL_BAL,
      gate: { threshold: -20 },
      eqBands: [{ gain: 3 }],
    };
    expect(mirrorBalPair(MODELS.URX44, plan, "ch1")).toBe(true);
    // Mirrored by value, not by identity.
    expect(plan.nodeParams.ch2!.gate).toEqual(plan.nodeParams.ch1!.gate);
    expect(plan.nodeParams.ch2!.gate).not.toBe(plan.nodeParams.ch1!.gate);
    expect(plan.nodeParams.ch2!.eqBands).toEqual(plan.nodeParams.ch1!.eqBands);
    expect(plan.nodeParams.ch2!.eqBands).not.toBe(plan.nodeParams.ch1!.eqBands);
    // An in-place edit to the source no longer bleeds into the partner.
    plan.nodeParams.ch1!.gate!.threshold = -99;
    expect(plan.nodeParams.ch2!.gate!.threshold).toBe(-20);
  });
});
