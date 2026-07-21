// FX-channel effect catalog + encoding tests. Encoding anchors are the live LCD
// calibration points (reference/work/vd/vd-params.md "FX channel EFFECT"); the
// translate / readback round-trip confirms the slot addressing and family layout.

import { describe, expect, it, vi } from "vitest";
import { getModel } from "../../models";
import { emptyPlan } from "../plan";
import {
  balanceLabel,
  delayMs,
  fx2FreqHz,
  fxFamilyOf,
  fxParams,
  initDelayMs,
  pingPongDelayMs,
  ratio10,
  revR3TimeSec,
  revxFreqHz,
  revxTimeSec,
} from "./fx-effect";
import { planToCommands } from "./translate";

describe("fx-effect encodings (live calibration anchors)", () => {
  it("REV-X frequency = 20 × 2^(raw/6)", () => {
    expect(revxFreqHz(0)).toBeCloseTo(20, 1);
    expect(Math.round(revxFreqHz(9))).toBe(57); // LCD 56, idealized 56.6
    expect(Math.round(revxFreqHz(52))).toBe(8127); // LCD 8.00k
  });
  it("Rev.R3 / delay frequency = 15 × 2^(raw/12)", () => {
    expect(Math.round(fx2FreqHz(31))).toBe(90);
    expect(Math.round(fx2FreqHz(41))).toBe(160);
    expect(Math.round(fx2FreqHz(111))).toBe(9133); // LCD 9.00k
  });
  it("Initial/ER delay = raw × 200/127", () => {
    expect(initDelayMs(0)).toBeCloseTo(0, 1);
    expect(initDelayMs(26)).toBeCloseTo(41.0, 0);
    expect(initDelayMs(127)).toBeCloseTo(200, 1);
  });
  it("Mono delay = raw / 14.976", () => {
    expect(delayMs(7563)).toBeCloseTo(505, 0);
    expect(Math.round(delayMs(40436))).toBe(2700);
  });
  it("Ping Pong delay = raw / 10 (LCD-confirmed 2026-07-19)", () => {
    expect(pingPongDelayMs(13500)).toBeCloseTo(1350, 1); // official max
    expect(pingPongDelayMs(20218)).toBeCloseTo(2021.8, 1);
    expect(pingPongDelayMs(10)).toBeCloseTo(1.0, 5); // official min
  });
  it("Ping Pong delay-time slot has its own law and range, not Mono's", () => {
    const pp = fxParams(1025).find((d) => d.key === "delay")!;
    const mono = fxParams(1024).find((d) => d.key === "delay")!;
    expect(pp.rawMax).toBe(13500);
    expect(mono.rawMax).toBe(40436);
    // Same raw, different displayed ms between the two delay types.
    expect(pp.format!(13500, {})).toBe("1350 ms");
    expect(pp.format!(13500, {})).not.toBe(mono.format!(13500, {}));
  });
  it("Hi/Low ratio = raw / 10", () => {
    expect(ratio10(8)).toBeCloseTo(0.8, 5);
  });
  it("ER/Rev balance label = 63 − raw", () => {
    expect(balanceLabel(54)).toBe("E9>R");
    expect(balanceLabel(63)).toBe("E=R");
    expect(balanceLabel(72)).toBe("E<R9");
  });
  it("Rev.R3 reverb time piecewise table", () => {
    expect(revR3TimeSec(0)).toBeCloseTo(0.3, 5);
    expect(revR3TimeSec(16)).toBeCloseTo(1.9, 5);
    expect(revR3TimeSec(57)).toBeCloseTo(10.0, 5);
    expect(revR3TimeSec(69)).toBeCloseTo(30.0, 5);
  });
  it("REV-X reverb time is base × 3^(roomSize/31)", () => {
    expect(revxTimeSec(24, 0)).toBeCloseTo(0.927, 2);
    expect(revxTimeSec(24, 31)).toBeCloseTo(2.79, 1); // ×3.0
    expect(revxTimeSec(69, 0)).toBeCloseTo(10.3, 1);
  });
  it("family of each effect type value", () => {
    expect(fxFamilyOf(0)).toBe("revx");
    expect(fxFamilyOf(768)).toBe("revr3");
    expect(fxFamilyOf(1024)).toBe("delay");
  });
});

describe("fx-effect translate", () => {
  const model = getModel("URX44V");

  it("emits the EFFECT TYPE (679/683) and the family's parameter slots", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["bus.fx1"] = {
      fxEffect: { type: 0, on: true, level: 100, params: { reverbTime: 24, hpf: 9 } },
    };
    plan.nodeParams["bus.fx2"] = {
      fxEffect: { type: 1024, on: true, params: { delay: 7563, note: 9 } },
    };
    const cmds = planToCommands(model, plan);
    const at = (id: number, y: number) => cmds.find((c) => c.paramId === id && c.y === y);

    // FX1 type selector 679 = 0 (Rev-X Hall); FX2 type 683 = 1024 (Mono Delay).
    expect(at(679, 0)!.vdValue).toBe(0);
    expect(at(683, 0)!.vdValue).toBe(1024);
    // FX1 (array 681) reverb-time slot 7 + hpf slot 10 carry their raw values.
    expect(at(681, 7)!.vdValue).toBe(24);
    expect(at(681, 10)!.vdValue).toBe(9);
    // FX2 (array 685) delay slot 6 + note slot 11.
    expect(at(685, 6)!.vdValue).toBe(7563);
    expect(at(685, 11)!.vdValue).toBe(9);
    // The delay family does NOT emit reverb-only slots (no roomSize slot 12 on 685).
    expect(cmds.some((c) => c.paramId === 685 && c.y === 12)).toBe(false);
  });

  it("emits nothing for an FX channel without an fxEffect", () => {
    const plan = emptyPlan("URX44V");
    const cmds = planToCommands(model, plan);
    expect(cmds.some((c) => c.paramId === 679 || c.paramId === 681)).toBe(false);
  });
});

describe("fx-effect readback round-trip", () => {
  it("reads the type then the family slots into the plan", async () => {
    vi.resetModules();
    const table = new Map<string, number>([
      ["683:0:0", 768], // FX2 = Rev.R3 Hall
      ["685:0:1", 1], // on
      ["685:0:2", 100], // level
      ["685:0:7", 15], // reverbTime
      ["685:0:14", 54], // erRevBalance
    ]);
    vi.doMock("../platform", () => ({
      vdGet: vi.fn((id: number, x: number, y: number) => Promise.resolve(table.get(`${id}:${x}:${y}`) ?? 0)),
      vdGetStr: vi.fn(() => Promise.resolve("")),
    }));
    const { applyDeviceState } = await import("./readback");
    const { getModel: gm } = await import("../../models");
    const { emptyPlan: ep } = await import("../plan");
    const plan = ep("URX44V");
    await applyDeviceState(gm("URX44V"), plan);
    const fx = plan.nodeParams["bus.fx2"]?.fxEffect;
    expect(fx?.type).toBe(768);
    expect(fx?.params?.reverbTime).toBe(15);
    expect(fx?.params?.erRevBalance).toBe(54);
    vi.doUnmock("../platform");
  });
});
