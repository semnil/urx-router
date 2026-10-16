import { describe, expect, it } from "vitest";
import { shippedValues } from "urx-lcd-sim/embed";
import {
  effectParams,
  INPUT_INSERT_EFFECTS,
  OUTPUT_INSERT_EFFECTS,
} from "../../node_modules/urx-lcd-sim/src/model/effects";
import { digitalGainPath, digitalGainShipped } from "../../node_modules/urx-lcd-sim/src/model/source-gain";
import { getModel } from "../models";
import { defaultPlan } from "../models/initial-state";
import type { ModelId } from "../models/types";
import { isRefusal, readSim, simBindings } from "./sim-map";

const MODELS: ModelId[] = ["URX22", "URX44", "URX44V"];

// The digital sources the simulator's INPUT screen lists, by the names it keeps them under. The
// simulator ships a D.Gain only for the sources that leave the factory below 0 dB, and reads every
// other source's at its own default.
const DIGITAL_SOURCES = [
  "AUX IN",
  "USB MAIN A",
  "USB MAIN B",
  "USB MAIN C",
  "USB SUB",
  ...[1, 3, 5, 7, 9, 11].map((n) => `USB DAW ${n}/${n + 1}`),
  "microSD Playback",
  "HDMI",
];

describe.each(MODELS)("the SIM's view of a %s plan", (modelId) => {
  const model = getModel(modelId);
  const bindings = simBindings(model);
  const shipped = new Map(shippedValues(modelId));
  for (const source of DIGITAL_SOURCES)
    if (!shipped.has(digitalGainPath(source))) shipped.set(digitalGainPath(source), digitalGainShipped(source));

  it("names only paths the simulator reads", () => {
    // An FX channel's effect row is read under the family selected, and the simulator ships the
    // rows of each channel's own family only: a row of another family is one it reads once a type
    // of that family is chosen, which is a row it ships on some FX channel.
    const effectRow = /^ch\.fx\d\.effect\.(.+)$/;
    const shippedRows = new Set([...shipped.keys()].map((p) => effectRow.exec(p)?.[1]).filter(Boolean));
    // An insert's rows are read under the effect selected, and the simulator ships every insert
    // at No Effect, which carries none: a row is one it reads once it is a row of an effect that
    // strip's menu offers. The 1-knob EQ's kept band gains are written by the simulator's own
    // 1-knob rule and ship nowhere either: a kept gain is one of a band whose gain it ships.
    const insertRow = /^(ch\.(.+)\.insFx)\.(.+)$/;
    const insertKeys = (strip: string): Set<string> =>
      new Set(
        (strip.startsWith("bus.") ? OUTPUT_INSERT_EFFECTS : INPUT_INSERT_EFFECTS).flatMap((o) =>
          effectParams(o.name).map((p) => p.key),
        ),
      );
    const isInsertRow = (path: string): boolean => {
      const [, base, strip, key] = insertRow.exec(path) ?? [];
      return base !== undefined && shipped.has(`${base}.effect`) && insertKeys(strip).has(key);
    };
    const oneKnobBase = /^(ch\..+)\.eq\.oneKnob\.base\.([^.]+)$/;
    const isOneKnobBase = (path: string): boolean => {
      const [, base, band] = oneKnobBase.exec(path) ?? [];
      return base !== undefined && shipped.has(`${base}.eq.oneKnob.on`) && shipped.has(`${base}.eq.${band}.gain`);
    };
    const unknown = [...bindings.keys()].filter(
      (path) =>
        !shipped.has(path) && !shippedRows.has(effectRow.exec(path)?.[1]) && !isInsertRow(path) && !isOneKnobBase(path),
    );
    expect(unknown).toEqual([]);
  });

  it("reads a new plan as the unit ships, at every path it answers", () => {
    const read = readSim(bindings, defaultPlan(modelId));
    const differs = [...read]
      .filter(([path, value]) => shipped.get(path) !== value)
      .map(([path, value]) => `${path}: plan ${JSON.stringify(value)}, sim ${JSON.stringify(shipped.get(path))}`);
    expect(differs).toEqual([]);
    expect(read.size, "the table answers a real share of the simulator's paths").toBeGreaterThan(100);
  });

  it("writes back what it reads: an edit of each path to the value it holds changes nothing", () => {
    const plan = defaultPlan(modelId);
    const refusals: string[] = [];
    for (const [path, binding] of bindings) {
      if (!binding.write) continue;
      const value = binding.read(plan);
      if (value === undefined) continue;
      const edit = binding.write(plan, value);
      if (isRefusal(edit)) refusals.push(`${path}: ${edit.refused}`);
    }
    expect(refusals).toEqual([]);
  });
});
