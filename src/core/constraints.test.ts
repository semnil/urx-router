import { describe, it, expect } from "vitest";
import { rateConstraints, formatRate, SAMPLE_RATES, DEFAULT_SAMPLE_RATE, duckerBypassWarnings, channelDuckerOn, channelEqUnavailable } from "./constraints";
import { directOutTarget } from "./routing";
import { emptyPlan } from "./plan";
import { getModel } from "../models";
import { ref } from "../models/types";

describe("rateConstraints", () => {
  it("reports no warnings at or below 96 kHz", () => {
    for (const rate of [44100, 48000, 88200, 96000]) {
      const c = rateConstraints(getModel("URX44"), rate);
      expect(c.warnings).toEqual([]);
      expect(c.disabledNodes).toEqual([]);
    }
  });

  it("disables insert FX and the FX2 bus above 96 kHz", () => {
    const c = rateConstraints(getModel("URX44"), 192000);
    expect(c.warnings).toContain("insFx");
    expect(c.warnings).toContain("fx2");
    expect(c.disabledNodes).toContain("bus.fx2");
  });

  it("warns the stereo-channel EQ drops out at 176.4 / 192 kHz, not at 96 kHz", () => {
    for (const id of ["URX22", "URX44", "URX44V"] as const) {
      expect(rateConstraints(getModel(id), 96000).warnings).not.toContain("stereoEq");
      expect(rateConstraints(getModel(id), 176400).warnings).toContain("stereoEq");
      expect(rateConstraints(getModel(id), 192000).warnings).toContain("stereoEq");
    }
  });

  it("treats 176.4 kHz the same as 192 kHz", () => {
    const a = rateConstraints(getModel("URX22"), 176400);
    const b = rateConstraints(getModel("URX22"), 192000);
    expect(a).toEqual(b);
  });
});

describe("channelEqUnavailable", () => {
  it("is true only for a stereo channel at 176.4 / 192 kHz", () => {
    expect(channelEqUnavailable("ch_5_6", 176400)).toBe(true);
    expect(channelEqUnavailable("ch_5_6", 192000)).toBe(true);
    expect(channelEqUnavailable("ch_5_6", 96000)).toBe(false);
    expect(channelEqUnavailable("ch_5_6", 48000)).toBe(false);
  });

  it("never fires for a mono channel or a bus (their EQ survives high rates)", () => {
    expect(channelEqUnavailable("ch1", 192000)).toBe(false);
    expect(channelEqUnavailable("bus.stereo", 192000)).toBe(false);
    expect(channelEqUnavailable("bus.mix1", 192000)).toBe(false);
  });
});

describe("formatRate", () => {
  it("renders kHz with a fractional part where needed", () => {
    expect(formatRate(48000)).toBe("48 kHz");
    expect(formatRate(44100)).toBe("44.1 kHz");
    expect(formatRate(176400)).toBe("176.4 kHz");
  });
});

describe("directOutTarget", () => {
  const u44v = getModel("URX44V");

  it("classifies a channel tap by destination — USB vs microSD Rec", () => {
    expect(directOutTarget(u44v, ref("ch_5_6", "out"), ref("out.usbmain_b", "in"))).toBe("usb");
    expect(directOutTarget(u44v, ref("ch_5_6", "out"), ref("out.sdrec.t1", "in"))).toBe("sdRec");
  });

  it("is null for a bus source into the same direct out (post-Ducker)", () => {
    expect(directOutTarget(u44v, ref("bus.stereo", "out"), ref("out.usbmain_b", "in"))).toBeNull();
    expect(directOutTarget(u44v, ref("bus.mix1", "out"), ref("out.usbmain_b", "in"))).toBeNull();
  });

  it("is null for a bus send (not a patch/record)", () => {
    expect(directOutTarget(u44v, ref("ch_5_6", "out"), ref("bus.stereo", "in"))).toBeNull();
  });
});

describe("duckerBypassWarnings", () => {
  const u44v = getModel("URX44V");

  it("reports nothing when no ducker is on", () => {
    const plan = emptyPlan("URX44V");
    plan.connections.push({ from: ref("ch_5_6", "out"), to: ref("out.usbmain_b", "in"), kind: "patch" });
    expect(duckerBypassWarnings(u44v, plan)).toEqual([]);
  });

  it("reports nothing when the ducked channel has no direct out", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["out.ducker1"] = { duckerOn: true };
    plan.connections.push({ from: ref("ch_5_6", "out"), to: ref("bus.stereo", "in"), kind: "send" });
    expect(duckerBypassWarnings(u44v, plan)).toEqual([]);
  });

  it("flags a channel whose ducker is on and is tapped to a USB direct out", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["out.ducker1"] = { duckerOn: true };
    plan.connections.push({ from: ref("ch_5_6", "out"), to: ref("out.usbmain_b", "in"), kind: "patch" });
    expect(duckerBypassWarnings(u44v, plan)).toEqual(["ch_5_6"]);
  });

  it("does not flag a microSD Rec tap (dry recording is intentional)", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["out.ducker1"] = { duckerOn: true };
    plan.connections.push({ from: ref("ch_5_6", "out"), to: ref("out.sdrec.t1", "in"), kind: "record" });
    expect(duckerBypassWarnings(u44v, plan)).toEqual([]);
  });

  it("does not flag a bus-sourced USB out (the duck is already in the bus)", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["out.ducker1"] = { duckerOn: true };
    plan.connections.push({ from: ref("bus.stereo", "out"), to: ref("out.usbmain_b", "in"), kind: "patch" });
    expect(duckerBypassWarnings(u44v, plan)).toEqual([]);
  });
});

describe("channelDuckerOn", () => {
  const u44v = getModel("URX44V");

  it("is true only when the channel's hung ducker is on", () => {
    const plan = emptyPlan("URX44V");
    expect(channelDuckerOn(u44v, plan, "ch_5_6")).toBe(false); // factory ducker off
    plan.nodeParams["out.ducker1"] = { duckerOn: true }; // ducker1 hangs on ch_5_6
    expect(channelDuckerOn(u44v, plan, "ch_5_6")).toBe(true);
    expect(channelDuckerOn(u44v, plan, "ch_7_8")).toBe(false); // a different channel's ducker
  });
});

describe("sample-rate table", () => {
  it("includes the default rate", () => {
    expect(SAMPLE_RATES).toContain(DEFAULT_SAMPLE_RATE);
  });
});
