import { afterEach, describe, expect, it } from "vitest";
import { displayedSide, onDisplayedSideChange, resetDisplayedSides, setDisplayedSide, shownStage } from "./stereo-side";
import { getModel } from "../models";
import { defaultPlan } from "../models/initial-state";
import { setExclusiveConnection } from "./plan";

afterEach(() => resetDisplayedSides());

describe("the displayed side of a stereo channel", () => {
  it("starts at L, changes once per switch, and is told once per change", () => {
    const heard: string[] = [];
    const off = onDisplayedSideChange((ch, side) => heard.push(`${ch}:${side}`));
    expect(displayedSide("ch_5_6")).toBe("L");
    expect(setDisplayedSide("ch_5_6", "R")).toBe(true);
    expect(setDisplayedSide("ch_5_6", "R"), "the same side again changes nothing").toBe(false);
    expect(displayedSide("ch_5_6")).toBe("R");
    expect(heard).toEqual(["ch_5_6:R"]);
    off();
    setDisplayedSide("ch_5_6", "L");
    expect(heard, "an unsubscribed listener hears nothing").toEqual(["ch_5_6:R"]);
  });

  it("has no side to switch on a mono channel", () => {
    expect(setDisplayedSide("ch1", "R")).toBe(false);
    expect(displayedSide("ch1")).toBe("L");
  });

  it("goes back to L for every channel on a reset", () => {
    setDisplayedSide("ch_5_6", "R");
    setDisplayedSide("ch_7_8", "R");
    resetDisplayedSides();
    expect([displayedSide("ch_5_6"), displayedSide("ch_7_8")]).toEqual(["L", "L"]);
  });

  it("shows the jack of the displayed side", () => {
    const model = getModel("URX44V");
    const plan = defaultPlan("URX44V");
    setExclusiveConnection(plan, "in.micline_1_2:out", "ch_5_6:in", "source");
    expect(shownStage(model, plan, "ch_5_6")).toMatchObject({ kind: "jack", node: "in.micline_1_2", side: "L" });
    setDisplayedSide("ch_5_6", "R");
    expect(shownStage(model, plan, "ch_5_6")).toMatchObject({ kind: "jack", node: "in.micline_1_2", side: "R" });
  });
});
