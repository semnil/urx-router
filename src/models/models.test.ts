import { describe, it, expect } from "vitest";
import { MODELS, MODEL_IDS } from "./index";
import { parseRef } from "./types";

describe("model registry", () => {
  it("registers exactly the three supported models", () => {
    expect(MODEL_IDS).toHaveLength(3);
    expect(new Set(MODEL_IDS)).toEqual(new Set(["URX22", "URX44", "URX44V"]));
  });

  it.each(MODEL_IDS)("%s has nodes and rules", (id) => {
    expect(MODELS[id].nodes.length).toBeGreaterThan(0);
    expect(MODELS[id].rules.length).toBeGreaterThan(0);
  });

  it.each(MODEL_IDS)("%s: every rule endpoint resolves to a real port", (id) => {
    const m = MODELS[id];
    const resolves = (r: string): boolean => {
      const { nodeId, portId } = parseRef(r);
      const node = m.nodes.find((n) => n.id === nodeId);
      return !!node && node.ports.some((p) => p.id === portId);
    };
    for (const rule of m.rules) {
      expect(resolves(rule.from), `${id}: from ${rule.from}`).toBe(true);
      expect(resolves(rule.to), `${id}: to ${rule.to}`).toBe(true);
    }
  });
});

describe("model-specific topology", () => {
  it("URX22 has neither microSD Rec nor LINE OUT", () => {
    expect(MODELS.URX22.nodes.some((n) => n.id === "out.sdrec")).toBe(false);
    expect(MODELS.URX22.nodes.some((n) => n.id === "out.line")).toBe(false);
  });

  it("URX44 has both microSD Rec and LINE OUT", () => {
    expect(MODELS.URX44.nodes.some((n) => n.id === "out.sdrec")).toBe(true);
    expect(MODELS.URX44.nodes.some((n) => n.id === "out.line")).toBe(true);
  });

  it("only URX44V has an HDMI input", () => {
    expect(MODELS.URX44V.nodes.some((n) => n.id === "in.hdmi")).toBe(true);
    expect(MODELS.URX44.nodes.some((n) => n.id === "in.hdmi")).toBe(false);
  });

  it.each(MODEL_IDS)("%s drops USB DAW OUT and the merged front-mic source", (id) => {
    expect(MODELS[id].nodes.some((n) => n.id === "out.usbdaw")).toBe(false);
    expect(MODELS[id].nodes.some((n) => n.id === "in.micfront")).toBe(false);
  });

  it.each(MODEL_IDS)("%s exposes paired sources but not the bulk-set actions", (id) => {
    const has = (nodeId: string): boolean => MODELS[id].nodes.some((n) => n.id === nodeId);
    expect(has("in.micline_1_2")).toBe(true);
    expect(has("in.usbdaw_1_2")).toBe(true);
    // "All Input" / "All USB DAW" are bulk-set actions, not source nodes.
    expect(has("in.allinput")).toBe(false);
    expect(has("in.allusbdaw")).toBe(false);
  });

  it("splits MIC/LINE and USB DAW into 2-channel pairs", () => {
    // URX22: 2 MIC/LINE (one pair) and 10 USB DAW (five pairs).
    expect(MODELS.URX22.nodes.some((n) => n.id === "in.micline_3_4")).toBe(false);
    expect(MODELS.URX22.nodes.some((n) => n.id === "in.usbdaw_9_10")).toBe(true);
    expect(MODELS.URX22.nodes.some((n) => n.id === "in.usbdaw_11_12")).toBe(false);
    // URX44: 4 MIC/LINE (two pairs) and 12 USB DAW (six pairs).
    expect(MODELS.URX44.nodes.some((n) => n.id === "in.micline_3_4")).toBe(true);
    expect(MODELS.URX44.nodes.some((n) => n.id === "in.usbdaw_11_12")).toBe(true);
  });

  it("pairs mono channels for shared source selection", () => {
    expect(MODELS.URX22.channelPairs).toEqual([["ch1", "ch2"]]);
    expect(MODELS.URX44.channelPairs).toEqual([
      ["ch1", "ch2"],
      ["ch3", "ch4"],
    ]);
    // URX44V shares URX44's 4 mono channels, so it pairs identically.
    expect(MODELS.URX44V.channelPairs).toEqual([
      ["ch1", "ch2"],
      ["ch3", "ch4"],
    ]);
  });
});

// Structural contracts every consumer (routing engine, seeding, skill export)
// assumes when it walks a DeviceModel. These are model-wide invariants rather
// than per-feature checks: a node-id collision, a backwards wire, or a dangling
// node would silently corrupt connect / validate for all three models.
describe("model structural invariants", () => {
  it.each(MODEL_IDS)("%s: node ids are unique", (id) => {
    const ids = MODELS[id].nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(MODEL_IDS)("%s: no duplicate (from,to) routing rule", (id) => {
    // findRule / ruleKind return the first match, so a repeated from->to pair would
    // make the second rule (possibly a different kind) unreachable and ambiguous.
    const keys = MODELS[id].rules.map((r) => `${r.from} ${r.to}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(MODEL_IDS)("%s: every rule.from is an out port and every rule.to is an in port", (id) => {
    // A wire is directional; a rule endpoint pointing at the wrong port direction
    // (e.g. from an in port) would let the graph draw a backwards connection.
    const m = MODELS[id];
    const dir = (r: string, want: "in" | "out"): boolean => {
      const { nodeId, portId } = parseRef(r);
      return m.nodes.find((n) => n.id === nodeId)?.ports.find((p) => p.id === portId)?.direction === want;
    };
    for (const rule of m.rules) {
      expect(dir(rule.from, "out"), `${id}: from ${rule.from}`).toBe(true);
      expect(dir(rule.to, "in"), `${id}: to ${rule.to}`).toBe(true);
    }
  });

  it.each(MODEL_IDS)("%s: the only nodes absent from every routing rule are headers", (id) => {
    // Every node must be wired into the graph except the microSD Rec header, which
    // deliberately takes no wire (its track slots carry the record routes).
    const m = MODELS[id];
    const inRule = new Set<string>();
    for (const r of m.rules) {
      inRule.add(parseRef(r.from).nodeId);
      inRule.add(parseRef(r.to).nodeId);
    }
    for (const n of m.nodes.filter((x) => !inRule.has(x.id))) {
      expect(n.header, `${id}: ${n.id} is orphaned but not a header`).toBe(true);
    }
  });

  // The non-removable wire budget per model: channels x 5 sends + 2 FX x 3 sends +
  // 2 MIX "TO ST" switches = 5*(mono+stereo) + 8. URX22 = 5*6+8 = 38; URX44/44V =
  // 5*8+8 = 48. Pins the count the FIXED-wire e2e and seeding rely on.
  const FIXED_COUNT = { URX22: 38, URX44: 48, URX44V: 48 } as const;
  it.each(MODEL_IDS)("%s: carries exactly its expected number of fixed wires", (id) => {
    expect(MODELS[id].rules.filter((r) => r.fixed).length).toBe(FIXED_COUNT[id]);
  });
});
