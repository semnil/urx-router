// The load's move of a document's channel-held input stage onto the jacks and sources that hold
// it (`migrateInputStage`). By ADDRESS: a mono channel CH n wrote at jack n and a stereo channel's
// gain at its model's legacy D.Gain id, whatever source wire the document gives the channel — so
// a crossed wiring is the case that separates the two readings. A key the document also writes
// on the input node wins, and a key that addresses nothing on the model is dropped.
import { describe, expect, it } from "vitest";
import { deserializeDocument, migrateInputStage, type NodeParams } from "./plan";
import type { ModelId } from "../models/types";

const load = (modelId: ModelId, nodeParams: Record<string, unknown>, connections: unknown[] = [], version = 4) =>
  deserializeDocument(
    JSON.stringify({ format: "urx-router-plan", version, modelId, positions: {}, connections, nodeParams }),
  );
const moved = (from: string, to: string) => ({ from, to, action: "move" });
const dropped = (from: string) => ({ from, action: "drop" });

describe("migrateInputStage", () => {
  // A channel past the jacks, a HI-Z on a model that lists none, and a stereo channel no legacy
  // D.Gain table names all address nothing, so their keys are dropped.
  it("drops a key that addresses nothing on the model", () => {
    const np = {
      ch9: { gain: 10 },
      ch3: { hiZ: true },
      ch_13_14: { gain: 4 },
    } as unknown as Record<string, NodeParams>;
    expect(migrateInputStage(np, "URX99")).toEqual([dropped("ch9.gain"), dropped("ch3.hiZ"), dropped("ch_13_14.gain")]);
    expect(np).toEqual({ ch9: {}, ch3: {}, ch_13_14: {} });
  });

  // One row per mono channel of each model: the four keys, at the jack the channel's index names.
  it.each<[ModelId, string, string, "L" | "R", boolean]>([
    ["URX44V", "ch1", "in.micline_1_2", "L", false],
    ["URX44V", "ch2", "in.micline_1_2", "R", false],
    ["URX44V", "ch3", "in.micline_3_4", "L", true],
    ["URX44V", "ch4", "in.micline_3_4", "R", true],
    ["URX44", "ch3", "in.micline_3_4", "L", true],
    ["URX44", "ch4", "in.micline_3_4", "R", true],
    ["URX22", "ch1", "in.micline_1_2", "L", false],
    ["URX22", "ch2", "in.micline_1_2", "R", true],
  ])("%s %s goes to %s %s", (modelId, ch, jack, side, hiZ) => {
    const { plan, inputStageRewrites } = load(modelId, {
      [ch]: { gain: 12, phantom: true, clipSafe: true, hiZ: true, hpfFreq: 100 },
    });
    expect(plan.nodeParams[ch]).toEqual({ hpfFreq: 100 });
    expect(plan.nodeParams[jack]).toEqual({
      [`gain${side}`]: 12,
      [`phantom${side}`]: true,
      [`clipSafe${side}`]: true,
      ...(hiZ ? { [`hiZ${side}`]: true } : {}),
    });
    expect(inputStageRewrites).toEqual([
      moved(`${ch}.gain`, `${jack}.gain${side}`),
      moved(`${ch}.phantom`, `${jack}.phantom${side}`),
      moved(`${ch}.clipSafe`, `${jack}.clipSafe${side}`),
      hiZ ? moved(`${ch}.hiZ`, `${jack}.hiZ${side}`) : dropped(`${ch}.hiZ`),
    ]);
  });

  it.each<[ModelId, string, string]>([
    ["URX44V", "ch_5_6", "in.aux"],
    ["URX44V", "ch_7_8", "in.usbmain_a"],
    ["URX44V", "ch_9_10", "in.usbmain_b"],
    ["URX44V", "ch_11_12", "in.usbmain_c"],
    ["URX44", "ch_5_6", "in.aux"],
    ["URX22", "ch_3_4", "in.aux"],
    ["URX22", "ch_5_6", "in.usbmain_a"],
    ["URX22", "ch_7_8", "in.usbmain_b"],
    ["URX22", "ch_9_10", "in.usbmain_c"],
  ])("%s %s's gain goes to %s's D.Gain, and its switches are dropped", (modelId, ch, source) => {
    const { plan, inputStageRewrites } = load(modelId, {
      [ch]: { gain: -6, phantom: true, clipSafe: false, hiZ: true, phaseL: true },
    });
    expect(plan.nodeParams[ch]).toEqual({ phaseL: true });
    expect(plan.nodeParams[source]).toEqual({ dGain: -6 });
    expect(inputStageRewrites).toEqual([
      moved(`${ch}.gain`, `${source}.dGain`),
      dropped(`${ch}.phantom`),
      dropped(`${ch}.clipSafe`),
      dropped(`${ch}.hiZ`),
    ]);
  });

  // By address: CH 1 wired to MIC/LINE 3/4 still wrote jack 1, and CH 5/6 wired to USB SUB still
  // wrote AUX's D.Gain.
  it("moves by the address the key was written at, not by the document's source wire", () => {
    const { plan } = load("URX44V", { ch1: { gain: 20 }, ch_5_6: { gain: 3 } }, [
      { from: "in.micline_3_4:out", to: "ch1:in", kind: "source" },
      { from: "in.usbsub:out", to: "ch_5_6:in", kind: "source" },
    ]);
    expect(plan.nodeParams["in.micline_1_2"]).toEqual({ gainL: 20 });
    expect(plan.nodeParams["in.micline_3_4"]).toBeUndefined();
    expect(plan.nodeParams["in.aux"]).toEqual({ dGain: 3 });
    expect(plan.nodeParams["in.usbsub"]).toBeUndefined();
  });

  it("keeps the input node's own value over the channel's copy", () => {
    const { plan, inputStageRewrites } = load("URX44V", {
      ch1: { gain: 20, phantom: true },
      ch_5_6: { gain: 3 },
      "in.micline_1_2": { gainL: 30 },
      "in.aux": { dGain: -2 },
    });
    expect(plan.nodeParams["in.micline_1_2"]).toEqual({ gainL: 30, phantomL: true });
    expect(plan.nodeParams["in.aux"]).toEqual({ dGain: -2 });
    expect(inputStageRewrites).toEqual([
      dropped("ch1.gain"),
      moved("ch1.phantom", "in.micline_1_2.phantomL"),
      dropped("ch_5_6.gain"),
    ]);
  });

  // Keys nothing emits, reads or shows.
  it("drops an input-stage key that addresses nothing on the model", () => {
    const { plan, inputStageRewrites } = load("URX44V", {
      "in.micline_1_2": { hiZL: true, hiZR: false, gainL: 3 },
      "in.aux": { gainL: 3, phantomR: true, dGain: 2 },
      "bus.mix1": { dGain: 3, gain: 1, level: -3 },
    });
    expect(plan.nodeParams["in.micline_1_2"]).toEqual({ gainL: 3 });
    expect(plan.nodeParams["in.aux"]).toEqual({ dGain: 2 });
    expect(plan.nodeParams["bus.mix1"]).toEqual({ level: -3 });
    expect(inputStageRewrites).toEqual([
      dropped("bus.mix1.gain"),
      dropped("in.micline_1_2.hiZL"),
      dropped("in.micline_1_2.hiZR"),
      dropped("in.aux.gainL"),
      dropped("in.aux.phantomR"),
      dropped("bus.mix1.dGain"),
    ]);
  });

  // A model without the destination: URX22 has no MIC/LINE 3/4 and no microSD player.
  it("drops a key whose destination the model does not carry", () => {
    const { plan, inputStageRewrites } = load("URX22", {
      ch3: { gain: 5 },
      "in.micline_3_4": { gainL: 5 },
      "in.sdplay": { dGain: 1 },
    });
    expect(Object.keys(plan.nodeParams).filter((id) => Object.keys(plan.nodeParams[id] as NodeParams).length)).toEqual(
      [],
    );
    expect(inputStageRewrites).toEqual([
      dropped("ch3.gain"),
      dropped("in.micline_3_4.gainL"),
      dropped("in.sdplay.dGain"),
    ]);
  });

  it("leaves a document with no input-stage key as it is, at every version", () => {
    for (const version of [1, 4, 5]) {
      const nodeParams = { ch1: { hpfFreq: 100 }, "in.micline_1_2": { gainL: 10 }, "in.aux": { dGain: 1 } };
      const { plan, inputStageRewrites } = load("URX44V", nodeParams, [], version);
      expect(inputStageRewrites, `version ${version}`).toEqual([]);
      expect(plan.nodeParams, `version ${version}`).toEqual(nodeParams);
    }
  });
});
