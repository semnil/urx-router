import { describe, it, expect } from "vitest";
import { rateConstraints, formatRate, SAMPLE_RATES, DEFAULT_SAMPLE_RATE } from "./constraints";
import { getModel } from "../models";

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

  it("warns about HDMI EQ only on a model with HDMI (URX44V)", () => {
    expect(rateConstraints(getModel("URX44V"), 176400).warnings).toContain("hdmiEq");
    expect(rateConstraints(getModel("URX44"), 176400).warnings).not.toContain("hdmiEq");
  });

  it("treats 176.4 kHz the same as 192 kHz", () => {
    const a = rateConstraints(getModel("URX22"), 176400);
    const b = rateConstraints(getModel("URX22"), 192000);
    expect(a).toEqual(b);
  });
});

describe("formatRate", () => {
  it("renders kHz with a fractional part where needed", () => {
    expect(formatRate(48000)).toBe("48 kHz");
    expect(formatRate(44100)).toBe("44.1 kHz");
    expect(formatRate(176400)).toBe("176.4 kHz");
  });
});

describe("sample-rate table", () => {
  it("includes the default rate", () => {
    expect(SAMPLE_RATES).toContain(DEFAULT_SAMPLE_RATE);
  });
});
