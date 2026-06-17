import { describe, expect, it } from "vitest";
import { LEVEL_MAX_DB, LEVEL_MIN_DB } from "../plan";
import {
  A_GAIN_MAX_DB,
  D_GAIN_MIN_DB,
  MONITOR_MIN_DB,
  MONITOR_OFF_DB,
  VD_LEVEL_MAX,
  VD_LEVEL_OFF,
  VD_PAN_MAX,
  boolToVd,
  gainToVd,
  levelToVd,
  monitorLevelToVd,
  panToVd,
  vdAddr,
  vdSet,
  vdToGain,
  vdToLevel,
  vdToMonitorLevel,
  vdToPan,
} from "./vd";

describe("level encoding", () => {
  it("maps the plan floor to the off sentinel", () => {
    expect(levelToVd(LEVEL_MIN_DB)).toBe(VD_LEVEL_OFF);
    expect(levelToVd(LEVEL_MIN_DB - 10)).toBe(VD_LEVEL_OFF);
  });

  it("maps dB to centi-dB", () => {
    expect(levelToVd(0)).toBe(0);
    expect(levelToVd(-6)).toBe(-600);
    expect(levelToVd(0.4)).toBe(40);
  });

  it("clamps to the device ceiling", () => {
    expect(levelToVd(LEVEL_MAX_DB)).toBe(VD_LEVEL_MAX);
    expect(levelToVd(999)).toBe(VD_LEVEL_MAX);
  });

  it("round-trips through vdToLevel", () => {
    expect(vdToLevel(levelToVd(LEVEL_MIN_DB))).toBe(LEVEL_MIN_DB);
    expect(vdToLevel(0)).toBe(0);
    expect(vdToLevel(VD_LEVEL_OFF)).toBe(LEVEL_MIN_DB);
  });
});

describe("pan encoding", () => {
  it("maps center and extremes", () => {
    expect(panToVd(0)).toBe(0);
    expect(panToVd(100)).toBe(VD_PAN_MAX);
    expect(panToVd(-100)).toBe(-VD_PAN_MAX);
  });

  it("clamps out-of-range input", () => {
    expect(panToVd(250)).toBe(VD_PAN_MAX);
    expect(panToVd(-250)).toBe(-VD_PAN_MAX);
  });

  it("round-trips center", () => {
    expect(vdToPan(panToVd(0))).toBe(0);
    expect(vdToPan(VD_PAN_MAX)).toBe(100);
  });
});

describe("HA gain encoding", () => {
  it("maps dB to centi-dB", () => {
    expect(gainToVd(0)).toBe(0);
    expect(gainToVd(-8)).toBe(-800);
    expect(gainToVd(70)).toBe(7000); // A.Gain max
    expect(gainToVd(-24)).toBe(-2400); // D.Gain min
  });

  it("clamps to the union of the analog/digital ranges", () => {
    expect(gainToVd(D_GAIN_MIN_DB - 10)).toBe(D_GAIN_MIN_DB * 100);
    expect(gainToVd(A_GAIN_MAX_DB + 10)).toBe(A_GAIN_MAX_DB * 100);
  });

  it("round-trips through vdToGain", () => {
    expect(vdToGain(gainToVd(-8))).toBe(-8);
    expect(vdToGain(2400)).toBe(24);
  });
});

describe("monitor level encoding", () => {
  it("maps dB to centi-dB down to the -96 floor", () => {
    expect(monitorLevelToVd(0)).toBe(0);
    expect(monitorLevelToVd(MONITOR_MIN_DB)).toBe(MONITOR_MIN_DB * 100); // -9600
    expect(monitorLevelToVd(10)).toBe(VD_LEVEL_MAX);
  });

  it("treats below -96 as the off sentinel", () => {
    expect(monitorLevelToVd(MONITOR_OFF_DB)).toBe(VD_LEVEL_OFF);
    expect(monitorLevelToVd(-200)).toBe(VD_LEVEL_OFF);
  });

  it("decodes the off sentinel to the slider floor", () => {
    expect(vdToMonitorLevel(VD_LEVEL_OFF)).toBe(MONITOR_OFF_DB);
    expect(vdToMonitorLevel(-9600)).toBe(MONITOR_MIN_DB);
    expect(vdToMonitorLevel(0)).toBe(0);
  });
});

describe("bool + address", () => {
  it("encodes on/off", () => {
    expect(boolToVd(true)).toBe(1);
    expect(boolToVd(false)).toBe(0);
  });

  it("builds addresses with x defaulting to 0", () => {
    expect(vdAddr(139, 0)).toBe("139:0:0");
    expect(vdAddr(140, 3)).toBe("140:0:3");
    expect(vdAddr(638, 7, 12)).toBe("638:12:7");
  });

  it("builds a value-set request", () => {
    expect(vdSet(140, 2, 1)).toEqual({
      uri: "/vd/parameters/140:0:2?operation=value",
      data: { current_value: 1 },
    });
  });
});
