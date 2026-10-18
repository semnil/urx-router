import { describe, expect, it } from "vitest";
import { shippedValues } from "urx-lcd-sim/embed";
import { getModel } from "../models";
import type { ModelId } from "../models/types";
import { defaultDeviceSetup, udkSlot } from "./control/device-setup";
import { isSetupGlassPath, setupGlassEdit, setupGlassPaths, setupGlassValues, withSetupEdit } from "./sim-map-setup";

const MODELS: ModelId[] = ["URX22", "URX44", "URX44V"];

describe.each(MODELS)("the SIM's SETUP > GENERAL on a %s", (modelId) => {
  const model = getModel(modelId);
  const shipped = shippedValues(modelId);

  // The simulator's own paths are the oracle: the list the locks hold shut with no session is every
  // one of them an edit changes on the unit, and nothing else.
  it("lists exactly the simulator's paths an edit changes on the unit", () => {
    const taken = [...shipped.keys()].filter((path) => isSetupGlassPath(model, path));
    expect(setupGlassPaths(model).sort()).toEqual(taken.sort());
  });

  it("takes every value the simulator ships, and shows it back", () => {
    const taken = [...shipped].filter(([path]) => isSetupGlassPath(model, path));
    expect(taken.length).toBeGreaterThan(20);
    for (const [path, value] of taken) {
      const edit = setupGlassEdit(model, path, value);
      expect(edit, path).not.toBe("refused");
      expect(setupGlassValues(model, withSetupEdit(defaultDeviceSetup(), edit as object)).get(path), path).toBe(value);
    }
  });

  it("names only paths the simulator reads, and takes back what it shows", () => {
    const shown = setupGlassValues(model, defaultDeviceSetup());
    expect(shown.size).toBeGreaterThan(5);
    for (const [path, value] of shown) {
      expect(shipped.has(path), path).toBe(true);
      if (path === "setup.udk.bank") continue;
      expect(isSetupGlassPath(model, path), path).toBe(true);
      const edit = setupGlassEdit(model, path, value);
      expect(edit, path).not.toBe("refused");
      expect(setupGlassValues(model, withSetupEdit(defaultDeviceSetup(), edit as object)).get(path), path).toBe(value);
    }
  });

  it("takes an edit into the field it names, and refuses a value the unit does not offer", () => {
    expect(setupGlassEdit(model, "setup.brightness", 3)).toEqual({ brightness: 3 });
    expect(setupGlassEdit(model, "setup.brightness", 11)).toBe("refused");
    expect(setupGlassEdit(model, "setup.language", "Japanese")).toEqual({ language: 1 });
    expect(setupGlassEdit(model, "setup.language", "Klingon")).toBe("refused");
    const knob = setupGlassEdit(model, "setup.udk.2.C", "Monitor 2 Level");
    const after = withSetupEdit(defaultDeviceSetup(), knob as object);
    expect(after.knobs[udkSlot(1, 2)]).toEqual({ fn: "Monitor", p1: "Monitor 2", p2: "Level" });
    expect(after.knobs.filter((k) => k.fn !== "No Assign")).toHaveLength(1);
    expect(setupGlassEdit(model, "setup.udk.bank", 2), "the unit's bank is read and never written").toBeNull();
    expect(setupGlassEdit(model, "setup.operationMode", "Simple")).toBeNull();
    expect(setupGlassEdit(model, "setup.followUsb", true)).toBeNull();
    expect(setupGlassEdit(model, "setup.udk.9.A", "Monitor 2 Level"), "a bank the unit does not have").toBeNull();
  });

  it("shows no name for a setting read past the list the unit offers", () => {
    const shown = setupGlassValues(model, { ...defaultDeviceSetup(), language: 99 });
    expect(shown.has("setup.language")).toBe(false);
    expect(shown.get("setup.brightness"), "the other settings are still shown").toBe(defaultDeviceSetup().brightness);
  });

  it("offers the HDMI and Date/Time settings only on a model that has them", () => {
    expect(isSetupGlassPath(model, "setup.peripheral.hdmiEnable")).toBe(model.hasHDMI);
    expect(isSetupGlassPath(model, "setup.dateTime.timeZone")).toBe(model.hasSD);
  });
});
