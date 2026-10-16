import { describe, expect, it } from "vitest";
import { getModel } from "../../models";
import { SAMPLE_RATES } from "../constraints";
import { decodeSendsTarget, encodeSendsTarget } from "./sends-target";

const MODELS = ["URX22", "URX44", "URX44V"] as const;
const UNIT: Record<string, number> = { ST: 0, FX1: 16, FX2: 17, MIX1: 32, MIX2: 34 };

describe("HOME's [Sends] destination (763)", () => {
  it("decodes the value the unit holds for each destination, and encodes it back", () => {
    for (const id of MODELS) {
      const model = getModel(id);
      for (const [target, raw] of Object.entries(UNIT)) {
        expect(decodeSendsTarget(model, raw), `${id} ${raw}`).toBe(target);
        expect(encodeSendsTarget(model, target, 48000), `${id} ${target}`).toBe(raw);
      }
    }
  });

  it("names nothing for a value no destination packs to", () => {
    const model = getModel("URX44V");
    for (const raw of [1, 2, 18, 33, 35, 48, 255, -1]) expect(decodeSendsTarget(model, raw), String(raw)).toBeNull();
    expect(encodeSendsTarget(model, "MIX3", 48000)).toBeNull();
  });

  it("does not hand the unit FX 2 above 96 kHz, and hands it every other destination at every rate", () => {
    const model = getModel("URX44V");
    for (const rate of SAMPLE_RATES) {
      expect(encodeSendsTarget(model, "FX2", rate), String(rate)).toBe(rate > 96000 ? null : 17);
      for (const target of ["ST", "FX1", "MIX1", "MIX2"])
        expect(encodeSendsTarget(model, target, rate), `${target} ${rate}`).toBe(UNIT[target]);
    }
  });
});
