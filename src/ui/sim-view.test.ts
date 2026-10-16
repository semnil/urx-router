import { describe, expect, it } from "vitest";
import { tapFor, tapsFor } from "../core/meters";
import { simMeterTap } from "./sim-view";

describe("the SIM's meters", () => {
  it("read the tap of the same name on the strip the LCD names", () => {
    expect(simMeterTap("ch1@input", "URX44V")).toEqual(tapFor("ch1", "input", "URX44V"));
    expect(simMeterTap("ch1@preFader", "URX44V")).toEqual(tapFor("ch1", "prefader", "URX44V"));
    expect(simMeterTap("ch1@preComp", "URX44V")).toEqual(tapFor("ch1", "precomp", "URX44V"));
    expect(simMeterTap("bus.mix1@post", "URX44V")).toEqual(tapFor("bus.mix1", "post", "URX44V"));
  });

  it("read what a strip puts out for a bare strip id", () => {
    expect(simMeterTap("bus.stereo", "URX44V")).toEqual(tapFor("bus.stereo", "post", "URX44V"));
  });

  it("read an FX channel's effect before its fader, and a bus's sum before its EQ", () => {
    expect(simMeterTap("fx1@effect", "URX44V")).toEqual(tapFor("bus.fx1", "prefader", "URX44V"));
    expect(simMeterTap("bus.mix2@sum", "URX44V")).toEqual(tapFor("bus.mix2", "preeq", "URX44V"));
  });

  it("read a stereo channel's input for the PRE EQ point its chain does not have", () => {
    expect(tapsFor("ch_5_6", "URX44V").some((t) => t.key === "preeq")).toBe(false);
    expect(simMeterTap("ch_5_6@preEq", "URX44V")).toEqual(tapFor("ch_5_6", "input", "URX44V"));
  });

  it("read the monitor buses and the oscillator off their outputs", () => {
    expect(simMeterTap("monitor.2", "URX44V")).toEqual(tapFor("bus.mon2", "post", "URX44V"));
    expect(simMeterTap("osc", "URX44V")).toEqual(tapFor("bus.osc", "post", "URX44V"));
  });

  it("read nothing where the session meters nothing", () => {
    expect(simMeterTap("cue", "URX44V")).toBeNull();
    expect(simMeterTap("playback", "URX44V")).toBeNull();
    expect(simMeterTap("ch1@nowhere", "URX44V")).toBeNull();
  });
});
