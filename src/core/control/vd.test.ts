import { describe, expect, it } from "vitest";
import { LEVEL_MAX_DB, LEVEL_MIN_DB, LEVEL_OFF_DB } from "../plan";
import { INSERT_FX_NONE, normalizeInsertFx } from "./params";
import {
  A_GAIN_MAX_DB,
  D_GAIN_MIN_DB,
  EQ_FREQ_MAX_HZ,
  EQ_FREQ_MIN_HZ,
  EQ_GAIN_MAX_DB,
  EQ_GAIN_MIN_DB,
  EQ_Q_MAX,
  EQ_Q_MIN,
  VD_LEVEL_MAX,
  VD_LEVEL_OFF,
  VD_PAN_MAX,
  boolToVd,
  eqFreqToVd,
  eqGainToVd,
  gainToVd,
  levelToVd,
  panToVd,
  qToVd,
  tagPortRef,
  vdAddr,
  vdSet,
  vdToEqFreq,
  vdToEqGain,
  vdToGain,
  vdToLevel,
  vdToPan,
  vdToPortRef,
  vdToQ,
  DELAY_TIME_MIN_MS,
  DELAY_TIME_MAX_MS,
  delayTimeToVd,
  vdToDelayTime,
  PHONES_LEVEL_MIN,
  PHONES_LEVEL_MAX,
  phonesLevelToVd,
  vdToPhonesLevel,
} from "./vd";

describe("level encoding (shared by faders, sends and the monitor)", () => {
  it("treats below the -96 floor as the off sentinel", () => {
    expect(levelToVd(LEVEL_OFF_DB)).toBe(VD_LEVEL_OFF); // -96.5 (-∞ notch)
    expect(levelToVd(LEVEL_MIN_DB - 10)).toBe(VD_LEVEL_OFF);
    expect(levelToVd(LEVEL_MIN_DB)).toBe(LEVEL_MIN_DB * 100); // -96.0 is a real value (-9600)
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
    expect(vdToLevel(VD_LEVEL_OFF)).toBe(LEVEL_OFF_DB); // off sentinel → -∞ notch
  });
});

describe("pan encoding (device L63 – C – R63, 1:1)", () => {
  it("maps center and extremes", () => {
    expect(panToVd(0)).toBe(0);
    expect(panToVd(VD_PAN_MAX)).toBe(VD_PAN_MAX); // R63
    expect(panToVd(-VD_PAN_MAX)).toBe(-VD_PAN_MAX); // L63
  });

  it("clamps out-of-range input", () => {
    expect(panToVd(250)).toBe(VD_PAN_MAX);
    expect(panToVd(-250)).toBe(-VD_PAN_MAX);
  });

  it("round-trips", () => {
    expect(vdToPan(panToVd(0))).toBe(0);
    expect(vdToPan(VD_PAN_MAX)).toBe(VD_PAN_MAX);
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

describe("EQ band encoding", () => {
  it("maps frequency to 0.1 Hz units and clamps the 20 Hz..20 kHz range", () => {
    expect(eqFreqToVd(1000)).toBe(10000);
    expect(eqFreqToVd(EQ_FREQ_MIN_HZ)).toBe(EQ_FREQ_MIN_HZ * 10); // 200
    expect(eqFreqToVd(EQ_FREQ_MAX_HZ)).toBe(EQ_FREQ_MAX_HZ * 10); // 200000
    expect(eqFreqToVd(5)).toBe(EQ_FREQ_MIN_HZ * 10); // below floor
    expect(eqFreqToVd(40000)).toBe(EQ_FREQ_MAX_HZ * 10); // above ceiling
  });

  it("round-trips frequency through vdToEqFreq", () => {
    expect(vdToEqFreq(eqFreqToVd(1000))).toBe(1000);
    expect(vdToEqFreq(eqFreqToVd(EQ_FREQ_MIN_HZ))).toBe(EQ_FREQ_MIN_HZ);
    expect(vdToEqFreq(eqFreqToVd(EQ_FREQ_MAX_HZ))).toBe(EQ_FREQ_MAX_HZ);
  });

  it("maps Q to ×100 and clamps the 0.50..16.00 range", () => {
    expect(qToVd(1)).toBe(100);
    expect(qToVd(EQ_Q_MIN)).toBe(EQ_Q_MIN * 100); // 50
    expect(qToVd(EQ_Q_MAX)).toBe(EQ_Q_MAX * 100); // 1600
    expect(qToVd(0.1)).toBe(EQ_Q_MIN * 100);
    expect(qToVd(99)).toBe(EQ_Q_MAX * 100);
  });

  it("round-trips Q through vdToQ", () => {
    expect(vdToQ(qToVd(1))).toBe(1);
    expect(vdToQ(qToVd(EQ_Q_MIN))).toBe(EQ_Q_MIN);
    expect(vdToQ(qToVd(EQ_Q_MAX))).toBe(EQ_Q_MAX);
  });

  it("maps gain to centi-dB and clamps the ±18 dB range", () => {
    expect(eqGainToVd(3)).toBe(300);
    expect(eqGainToVd(EQ_GAIN_MIN_DB)).toBe(EQ_GAIN_MIN_DB * 100); // -1800
    expect(eqGainToVd(EQ_GAIN_MAX_DB)).toBe(EQ_GAIN_MAX_DB * 100); // 1800
    expect(eqGainToVd(-50)).toBe(EQ_GAIN_MIN_DB * 100);
    expect(eqGainToVd(50)).toBe(EQ_GAIN_MAX_DB * 100);
  });

  it("round-trips gain through vdToEqGain", () => {
    expect(vdToEqGain(eqGainToVd(3))).toBe(3);
    expect(vdToEqGain(eqGainToVd(EQ_GAIN_MIN_DB))).toBe(EQ_GAIN_MIN_DB);
    expect(vdToEqGain(eqGainToVd(EQ_GAIN_MAX_DB))).toBe(EQ_GAIN_MAX_DB);
  });
});

describe("port-ref encoding", () => {
  it("tags a port with the high bit and strips it on decode", () => {
    // The streaming-source selector stores the port with bit 31 set.
    expect(tagPortRef(256)).toBe((0x80000000 | 256) >>> 0);
    expect(vdToPortRef(tagPortRef(256))).toBe(256);
    expect(vdToPortRef(tagPortRef(0))).toBe(0);
  });

  it("decodes an untagged (raw) port unchanged", () => {
    // USB-output / monitor / ducker selectors store the port raw, no tag bit.
    expect(vdToPortRef(3)).toBe(3);
    expect(vdToPortRef(256)).toBe(256);
  });

  it("decodes the none sentinel to null", () => {
    expect(vdToPortRef(0xffffffff)).toBeNull();
  });
});

describe("insert-FX normalization", () => {
  it("maps the uint32 none sentinel to the table's No Effect (-1)", () => {
    expect(normalizeInsertFx(0xffffffff)).toBe(INSERT_FX_NONE);
    expect(INSERT_FX_NONE).toBe(-1);
  });

  it("leaves a real effect value unchanged", () => {
    expect(normalizeInsertFx(257)).toBe(257); // Crunch
    expect(normalizeInsertFx(1792)).toBe(1792); // M.Band Comp
  });
});

describe("STREAMING DELAY time encoding (param 708, ms×100)", () => {
  it("encodes ms to broker centi-ms", () => {
    expect(delayTimeToVd(DELAY_TIME_MIN_MS)).toBe(100); // 1.00 ms = 100
    expect(delayTimeToVd(100)).toBe(10000); // 100.00 ms = 10000 (confirmed on device)
    expect(delayTimeToVd(DELAY_TIME_MAX_MS)).toBe(100000); // 1000.00 ms = 100000
  });

  it("decodes broker centi-ms to ms", () => {
    expect(vdToDelayTime(100)).toBe(DELAY_TIME_MIN_MS);
    expect(vdToDelayTime(10000)).toBe(100);
    expect(vdToDelayTime(100000)).toBe(DELAY_TIME_MAX_MS);
  });

  it("clamps to the 1.00 … 1000.00 ms range", () => {
    expect(delayTimeToVd(0)).toBe(DELAY_TIME_MIN_MS * 100); // below floor
    expect(delayTimeToVd(5000)).toBe(DELAY_TIME_MAX_MS * 100); // above ceiling
    expect(vdToDelayTime(0)).toBe(DELAY_TIME_MIN_MS); // device default reads as 1.00 ms
  });
});

describe("PHONES level encoding (param 725, 0.0..10.0 scale ×10)", () => {
  it("encodes the 0.0..10.0 scale to broker raw (×10)", () => {
    expect(phonesLevelToVd(PHONES_LEVEL_MIN)).toBe(0); // 0.0 = 0
    expect(phonesLevelToVd(2)).toBe(20); // 2.0 = 20 (factory default)
    expect(phonesLevelToVd(PHONES_LEVEL_MAX)).toBe(100); // 10.0 = 100 (confirmed on device)
  });

  it("decodes broker raw to the 0.0..10.0 scale", () => {
    expect(vdToPhonesLevel(0)).toBe(PHONES_LEVEL_MIN);
    expect(vdToPhonesLevel(20)).toBe(2);
    expect(vdToPhonesLevel(100)).toBe(PHONES_LEVEL_MAX);
  });

  it("clamps to the 0.0..10.0 range", () => {
    expect(phonesLevelToVd(-5)).toBe(PHONES_LEVEL_MIN * 10);
    expect(phonesLevelToVd(50)).toBe(PHONES_LEVEL_MAX * 10);
  });
});
