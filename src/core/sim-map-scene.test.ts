import { describe, expect, it } from "vitest";
import { sceneGlassValues, simSceneNumber } from "./sim-map-scene";

describe("the unit's scene pointers on the glass", () => {
  it("reads a user scene n as n - 1, 00 Initial Data as 0x8000 and a preset Pn as 0x8000 + n", () => {
    expect([0, 8, 9, 62].map(simSceneNumber), "01, 09, 10 and 63").toEqual([1, 9, 10, 63]);
    expect(simSceneNumber(0x8000), "00 Initial Data").toBe(0);
    expect([0x8001, 0x8002, 0x8003].map(simSceneNumber), "P01 to P03").toEqual([101, 102, 103]);
  });

  it("leaves a value outside the encoding to the glass", () => {
    expect([63, -1, 0x8004, 0.5, Number.NaN].map(simSceneNumber)).toEqual([null, null, null, null, null]);
    expect(sceneGlassValues(63, 0x8004).size).toBe(0);
    expect(sceneGlassValues(null, null).size).toBe(0);
  });

  it("shows the current scene and the cursor, and the tab where only one of the two lists the cursor's row", () => {
    expect(Object.fromEntries(sceneGlassValues(8, 9))).toEqual({ "scene.current": 9, "scene.selected": 10 });
    expect(Object.fromEntries(sceneGlassValues(0x8000, 0x8000))).toEqual({
      "scene.current": 0,
      "scene.selected": 0,
      "scene.bank": "Standard",
    });
    expect(Object.fromEntries(sceneGlassValues(8, 0x8001))).toEqual({
      "scene.current": 9,
      "scene.selected": 101,
      "scene.bank": "Simple",
    });
  });
});
