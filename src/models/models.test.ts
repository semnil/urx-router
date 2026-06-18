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
    expect(MODELS.URX44.channelPairs).toEqual([["ch1", "ch2"], ["ch3", "ch4"]]);
  });
});
