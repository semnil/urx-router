// QA audit (models/build.ts): structural contracts the connect / seeding layer
// relies on but that were only spot-checked. build.ts transcribes the block diagram
// via per-model parameters; these invariants pin the load-bearing couplings (one
// ducker per stereo channel, header <-> child-slot integrity, and the fixed-rule <->
// seeded-wire bijection) so a future parameter or loop-bound edit that desyncs them
// is caught. The block diagram remains the source of truth.

import { describe, it, expect } from "vitest";
import { MODELS, MODEL_IDS } from "./index";
import { emptyPlan, ensureFixedConnections } from "../core/plan";
import { parseRef } from "./types";

const STEREO_CH = /^ch_\d+_\d+$/;
const MONO_CH = /^ch\d+$/;

describe("ducker <-> stereo-channel coupling", () => {
  // build.ts creates stereo channels with a `k < stereoCh` loop but hangs duckers
  // with a hardcoded `d <= 4` loop. They agree only because every model ships
  // stereoCh = 4; this pins the coupling so a model with a different stereo count
  // (which would leave duckers and channels mismatched) is caught.
  it.each(MODEL_IDS)("%s: exactly one ducker per stereo channel, each attached to a real one", (id) => {
    const model = MODELS[id];
    const stereoChannels = model.nodes.filter((n) => n.kind === "channel" && STEREO_CH.test(n.id)).map((n) => n.id);
    const duckers = model.nodes.filter((n) => n.kind === "ducker");
    expect(duckers).toHaveLength(stereoChannels.length);
    const attached = duckers.map((d) => d.attachTo).sort();
    expect(attached).toEqual([...stereoChannels].sort());
    // No two duckers share a host, and every attachTo is a real stereo channel.
    expect(new Set(attached).size).toBe(duckers.length);
    for (const d of duckers) {
      expect(d.attachTo, `${d.id} attachTo`).toBeDefined();
      expect(STEREO_CH.test(d.attachTo!), `${d.id} -> ${d.attachTo}`).toBe(true);
    }
  });

  it.each(MODEL_IDS)("%s: no ducker hangs under a mono channel", (id) => {
    const model = MODELS[id];
    for (const d of model.nodes.filter((n) => n.kind === "ducker")) {
      expect(MONO_CH.test(d.attachTo ?? ""), `${d.id} -> ${d.attachTo}`).toBe(false);
    }
  });

  // The ducker NODES come from a `d <= stereoCh` loop but the ducker KEY RULES come
  // from a hardcoded `d <= 4` loop (build.ts rule 12). They agree only because every
  // model ships stereoCh = 4: a different stereo count would either dangle key rules
  // onto a non-existent ducker or leave a real ducker with no selectable key source.
  // This pins the key-rule <-> ducker-node bijection so that drift is caught.
  it.each(MODEL_IDS)("%s: key rules target exactly the ducker nodes, each offering every key source", (id) => {
    const model = MODELS[id];
    const duckers = model.nodes
      .filter((n) => n.kind === "ducker")
      .map((n) => n.id)
      .sort();
    const keyDests = [...new Set(model.rules.filter((r) => r.kind === "key").map((r) => parseRef(r.to).nodeId))].sort();
    expect(keyDests).toEqual(duckers);
    // Each ducker selects one trigger from every channel plus STEREO / MIX 1 / MIX 2.
    const channelIds = model.nodes.filter((n) => n.kind === "channel").map((n) => n.id);
    const expectedSources = new Set([...channelIds, "bus.stereo", "bus.mix1", "bus.mix2"]);
    for (const d of duckers) {
      const got = new Set(
        model.rules.filter((r) => r.kind === "key" && parseRef(r.to).nodeId === d).map((r) => parseRef(r.from).nodeId),
      );
      expect(got, `${id}: ${d} key sources`).toEqual(expectedSources);
    }
  });
});

describe("attachTo integrity (every hung node points at a real parent)", () => {
  it.each(MODEL_IDS)("%s: every attachTo resolves to an existing node", (id) => {
    const model = MODELS[id];
    const ids = new Set(model.nodes.map((n) => n.id));
    for (const n of model.nodes) {
      if (n.attachTo === undefined) continue;
      expect(ids.has(n.attachTo), `${n.id} -> ${n.attachTo}`).toBe(true);
    }
  });
});

describe("microSD Rec header <-> track-slot integrity", () => {
  it("URX22 has no SD Rec header or track slots", () => {
    expect(MODELS.URX22.nodes.some((n) => n.id === "out.sdrec")).toBe(false);
    expect(MODELS.URX22.nodes.some((n) => n.attachTo === "out.sdrec")).toBe(false);
  });

  it.each(["URX44", "URX44V"] as const)("%s: the header owns 8 stereo track-pair slots and takes no wire", (id) => {
    const model = MODELS[id];
    const header = model.nodes.find((n) => n.id === "out.sdrec");
    expect(header?.header).toBe(true);
    const slots = model.nodes.filter((n) => n.attachTo === "out.sdrec");
    expect(slots).toHaveLength(8);
    // The header itself is never a routing endpoint; its slots carry the record wires.
    expect(model.rules.some((r) => parseRef(r.to).nodeId === "out.sdrec")).toBe(false);
    for (const s of slots) {
      expect(
        model.rules.some((r) => parseRef(r.to).nodeId === s.id),
        `${s.id} has a record rule`,
      ).toBe(true);
    }
  });
});

describe("fixed-rule <-> seeded-wire bijection", () => {
  // plan.audit.test.ts pins that every seeded wire maps to a fixed rule and that a
  // second pass adds nothing. This closes the other direction: ensureFixedConnections
  // seeds EVERY fixed rule exactly once, so the two sets are in bijection (no fixed
  // routing is ever silently left unseeded).
  it.each(MODEL_IDS)("%s: seeding an empty plan reproduces the fixed-rule set exactly", (id) => {
    const model = MODELS[id];
    const plan = emptyPlan(id);
    ensureFixedConnections(model, plan);
    const seeded = new Set(plan.connections.map((c) => `${c.from} ${c.to}`));
    const fixed = new Set(model.rules.filter((r) => r.fixed).map((r) => `${r.from} ${r.to}`));
    expect(plan.connections).toHaveLength(fixed.size);
    expect(seeded).toEqual(fixed);
  });
});

describe("mono-channel pairing integrity", () => {
  it.each(MODEL_IDS)("%s: pairs are disjoint, reference real mono channels, and list the odd primary first", (id) => {
    const model = MODELS[id];
    const seen = new Set<string>();
    const ids = new Set(model.nodes.map((n) => n.id));
    for (const [a, b] of model.channelPairs) {
      expect(MONO_CH.test(a) && MONO_CH.test(b), `${a}/${b}`).toBe(true);
      expect(ids.has(a) && ids.has(b), `${a}/${b} exist`).toBe(true);
      // Consecutive channels, primary first (ch1/ch2, ch3/ch4).
      expect(Number(b.slice(2))).toBe(Number(a.slice(2)) + 1);
      // Disjoint membership: no channel appears in two pairs.
      expect(seen.has(a) || seen.has(b), `${a}/${b} overlap`).toBe(false);
      seen.add(a);
      seen.add(b);
    }
  });
});
