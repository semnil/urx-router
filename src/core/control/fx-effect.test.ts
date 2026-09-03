// FX-channel effect catalog + encoding tests. Encoding anchors are the live LCD
// calibration points (reference/work/vd/vd-params.md "FX channel EFFECT"); the
// translate / readback round-trip confirms the slot addressing and family layout.

import { describe, expect, it, vi } from "vitest";
import { getModel, MODEL_IDS } from "../../models";
import { defaultPlan } from "../../models/initial-state";
import { deserialize, emptyPlan, serialize } from "../plan";
import {
  balanceLabel,
  delayMs,
  FX_TYPE_DEFAULTS,
  formatFx1Hz,
  formatFx2Hz,
  fx2FreqHz,
  FX_EFFECT_TYPE_DEFAULT,
  fxEffectTypes,
  fxFamilyOf,
  fxParams,
  initDelayMs,
  migrateFxEffectParams,
  MONO_DELAY_KEY,
  pingPongDelayMs,
  PINGPONG_DELAY_KEY,
  ratio10,
  revR3TimeSec,
  revxFreqHz,
  revxTimeSec,
  type FxFamily,
  type FxParamDesc,
} from "./fx-effect";
import { planToCommands } from "./translate";

describe("fx-effect encodings (live calibration anchors)", () => {
  // Every filter frequency read off the unit's own screen, and the law has to reproduce each
  // EXACTLY rather than closely. That is the whole difference between a preferred-number
  // series and the geometric formula it looks like: 10^(1/40) and 2^(1/12) agree to four
  // digits, so a formula passes at the bottom of a range and drifts at the top — which is how
  // the previous version stood, with two of these assertions written to the formula's own
  // answer and a comment beside each recording that the unit said otherwise.
  it("REV-X frequency is the R20 series, at every point read off the unit", () => {
    for (const [raw, hz] of [
      [0, 20],
      [9, 56],
      [52, 8000],
      [34, 1000],
      [45, 3550],
      [60, 20000],
      [28, 500],
      [59, 18000],
    ] as const) {
      expect(revxFreqHz(raw), `raw ${raw}`).toBe(hz);
    }
  });
  it("Rev.R3 / delay frequency is the R40 series, at every point read off the unit", () => {
    for (const [raw, hz] of [
      [6, 21.2],
      [21, 50],
      [31, 90],
      [41, 160],
      [53, 315],
      [101, 5000],
      [109, 8000],
      [111, 9000],
      [121, 16000],
    ] as const) {
      expect(fx2FreqHz(raw), `raw ${raw}`).toBe(hz);
    }
  });
  // Every filter frequency label read off the unit, both families. The two are printed to
  // DIFFERENT precisions and only the Hz band differs: FX1 drops the decimal FX2 keeps. That is
  // the shape of the two tables — R20's grades stay distinct as integers (20/22/25/28/32/36)
  // while R40's would not (10.6 and 11.2 both read 11) — so a single formatter cannot serve
  // both, and the app's shared `formatHz` serves neither.
  //
  // The app writes a space before the unit and the LCD does not; that is house typography,
  // applied to every frequency row in the app, and the VALUE is what the panel and the unit
  // have to agree on.
  it("prints each family at the precision the unit prints it", () => {
    for (const [hz, label] of [
      // FX1, below 1 kHz: an integer, so the grade's own decimal is dropped.
      [22.4, "22 Hz"],
      [25, "25 Hz"],
      [28, "28 Hz"],
      [31.5, "32 Hz"],
      [35.5, "36 Hz"],
      // …and at 100 Hz and up the grades are already integers, which is where "round to the
      // integer" and "two significant figures" part company (315 rather than 320).
      [250, "250 Hz"],
      [280, "280 Hz"],
      [315, "315 Hz"],
      [355, "355 Hz"],
      [450, "450 Hz"],
      // From 1 kHz, three significant figures, trailing zeros and all.
      [1120, "1.12 kHz"],
      [1400, "1.40 kHz"],
      [2800, "2.80 kHz"],
      [3150, "3.15 kHz"],
      [5000, "5.00 kHz"],
      [18000, "18.0 kHz"],
    ] as const) {
      expect(formatFx1Hz(hz), `${hz}`).toBe(label);
    }
    for (const [hz, label] of [
      [21.2, "21.2 Hz"],
      [50, "50.0 Hz"],
      [315, "315 Hz"],
      [8000, "8.00 kHz"],
      [16000, "16.0 kHz"],
    ] as const) {
      expect(formatFx2Hz(hz), `${hz}`).toBe(label);
    }
    // The one value both families reach, printed the same way by each, so the pair above is a
    // difference in the Hz band rather than two unrelated formatters.
    expect(formatFx1Hz(315)).toBe(formatFx2Hz(315));
    // …and the difference itself: the same grade, one dropping the decimal.
    expect(formatFx1Hz(22.4)).not.toBe(formatFx2Hz(22.4));
  });

  // …and the rows themselves take it. Pinning the formatters alone leaves a descriptor free to
  // go on calling the app's shared `formatHz`, which is a row that reads 3.55 kHz as "3.55 kHz"
  // and 22.4 Hz as "22 Hz" — right by luck in one band and wrong in the other. Measured raws,
  // through the descriptor the panel actually renders.
  it("renders each filter row through its own family's formatter", () => {
    const row = (type: number, key: string): FxParamDesc => fxParams(type).find((d) => d.key === key)!;
    for (const [type, key, raw, label] of [
      // REV-X Hall: the two readings taken one click above each control's floor, and the LPF
      // point the old record already carried.
      [0, "revxHpf", 1, "22 Hz"],
      [0, "lowFreq", 1, "22 Hz"],
      [0, "revxLpf", 44, "3.15 kHz"],
      [0, "revxLpf", 45, "3.55 kHz"],
      // The top of each REV-X window, which is the band where the app's shared formatHz and
      // this one part company (it writes two decimals in kHz, so 18.0 would read 18.00).
      // Without a point here the row can go on calling the shared one and every other
      // assertion still passes. Two swaps here are behaviour-preserving over the DECLARED
      // window and stay green correctly: `revxHpf` to the shared `formatHz` (its window,
      // raw 0-52 = 20 Hz to 8 kHz, ends below the 10 kHz band where the two diverge), and
      // `revxLpf` to `formatFx2Hz` (its window, raw 34-60, is entirely at or above 1 kHz,
      // where the two families print alike). Both are equivalences of the window, not of the
      // functions — `format` does not clamp, so either is separable at an out-of-window raw.
      [0, "lowFreq", 59, "18.0 kHz"],
      [0, "revxLpf", 60, "20.0 kHz"],
      // Mono Delay: one click above THRU, and both ends of the LPF's window.
      [1024, "delayHpf", 6, "21.2 Hz"],
      [1024, "delayLpf", 21, "50.0 Hz"],
      [1024, "delayLpf", 121, "16.0 kHz"],
      [1024, "delayHpf", 109, "8.00 kHz"],
      // Rev.R3 shares the delay family's table and window, so it shares its precision. BOTH
      // of its rows: they are separate descriptors and each carries its own formatter call,
      // so one of them can be rewired without the other going red.
      [768, "revr3Hpf", 6, "21.2 Hz"],
      [768, "revr3Lpf", 21, "50.0 Hz"],
    ] as const) {
      expect(row(type, key).format!(raw, {}), `${key} raw ${raw}`).toBe(label);
    }
  });

  // A series steps by its grade, which is what a formula cannot do: the neighbours of a
  // labelled value are the next labels, not the value times a ratio. Without this, a formula
  // fitted to the points above would still pass them.
  it("steps in grades, so a neighbour is the next label rather than a ratio", () => {
    expect([53, 54, 55].map(fx2FreqHz)).toEqual([315, 335, 355]);
    expect([44, 45, 46].map(revxFreqHz)).toEqual([3150, 3550, 4000]);
  });
  it("Initial/ER delay = raw × 200/127", () => {
    expect(initDelayMs(0)).toBeCloseTo(0, 1);
    expect(initDelayMs(26)).toBeCloseTo(41.0, 0);
    expect(initDelayMs(127)).toBeCloseTo(200, 1);
  });
  it("Mono delay = raw / 10, on the three points that disproved raw / 14.976", () => {
    // Read off the unit with Sync off. 7563 is the raw the retired record claimed was
    // 505.0 ms; it is 756.3, which is what settled the law.
    expect(delayMs(5000)).toBeCloseTo(500.0, 1);
    expect(delayMs(20000)).toBeCloseTo(2000.0, 1);
    expect(delayMs(7563)).toBeCloseTo(756.3, 1);
    expect(Math.round(delayMs(27000))).toBe(2700); // official max
  });
  it("both delay types read a raw the same way", () => {
    for (const raw of [10, 5000, 13500]) expect(delayMs(raw)).toBe(pingPongDelayMs(raw));
  });
  it("Ping Pong delay = raw / 10 (LCD-confirmed 2026-07-19)", () => {
    expect(pingPongDelayMs(13500)).toBeCloseTo(1350, 1); // official max
    expect(pingPongDelayMs(20218)).toBeCloseTo(2021.8, 1);
    expect(pingPongDelayMs(10)).toBeCloseTo(1.0, 5); // official min
  });
  it("Ping Pong delay-time slot has its own RANGE, not its own law", () => {
    const pp = fxParams(1025).find((d) => d.key === PINGPONG_DELAY_KEY)!;
    const mono = fxParams(1024).find((d) => d.key === MONO_DELAY_KEY)!;
    expect(pp.rawMin).toBe(10); // 1.0 ms
    expect(pp.rawMax).toBe(13500); // 1350 ms
    expect(mono.rawMin).toBe(1); // 0.1 ms
    expect(mono.rawMax).toBe(27000); // 2700 ms
    // Same raw, same displayed ms — the split is the range, and it is what keeps a
    // Mono time above 1350 ms off a descriptor that would have the device clamp it.
    expect(pp.format!(13500, {})).toBe("1350 ms");
    expect(pp.format!(13500, {})).toBe(mono.format!(13500, {}));
    expect(mono.rawMax).toBeGreaterThan(pp.rawMax!);
  });
  it("the FX2 / delay filters read THRU at the ends the official range names", () => {
    const hpf = fxParams(1024).find((d) => d.key === "delayHpf")!;
    const lpf = fxParams(1024).find((d) => d.key === "delayLpf")!;
    // "Thru, 21.2 Hz - 8 kHz" and "50 Hz - 16 kHz, Thru": the word sits on the end the
    // unit puts it on, and the window reaches the official limits at both ends.
    expect([hpf.rawMin, hpf.rawMax]).toEqual([0, 109]);
    expect([lpf.rawMin, lpf.rawMax]).toEqual([21, 122]);
    expect(hpf.format!(0, {})).toBe("THRU");
    expect(hpf.format!(5, {})).toBe("THRU");
    expect(lpf.format!(122, {})).toBe("THRU");
    // The ends themselves are pinned as VALUES, which is what the unit was read for. Where the
    // window reaches is this case's subject; how the row is spelled belongs to the formatter
    // cases above, which pin every label read off the unit.
    expect(fx2FreqHz(6)).toBe(21.2);
    expect(fx2FreqHz(109)).toBe(8000);
    expect(fx2FreqHz(21)).toBe(50);
    expect(fx2FreqHz(121)).toBe(16000);
    // Rev.R3 takes the same window on its own slots.
    for (const [k, want] of [
      ["revr3Hpf", [0, 109]],
      ["revr3Lpf", [21, 122]],
    ] as const) {
      const d = fxParams(768).find((x) => x.key === k)!;
      expect([d.rawMin, d.rawMax]).toEqual(want);
    }
  });
  it("REV-X reverb time carries the selected type's own scale", () => {
    const at = (type: number, raw: number, roomSize: number): number => revxTimeSec(raw, roomSize, type);
    // Room Size 0, raw 69: the LCD reads 10.3 / 15.2 / 17.6 s on Hall / Room / Plate.
    expect(at(0, 69, 0)).toBeCloseTo(10.3, 1);
    expect(at(1, 69, 0)).toBeCloseTo(15.2, 1);
    expect(at(2, 69, 0)).toBeCloseTo(17.6, 1);
    // The Room Size scale is exactly 3 and type-independent, so each ceiling is its own
    // rs0 reading times three. The guide's published ceilings are 31.0 / 45.3 / 52.0 and
    // the products are 30.9 / 45.6 / 52.8 — near them, and NOT asserted against them:
    // those are nominal figures, and widening the tolerance until they pass would be
    // fitting the measurement to the rounding.
    for (const t of [0, 1, 2]) expect(at(t, 69, 31)).toBeCloseTo(at(t, 69, 0) * 3, 5);
    expect(at(0, 69, 31)).toBeCloseTo(30.9, 1);
    expect(at(1, 69, 31)).toBeCloseTo(45.6, 1);
    expect(at(2, 69, 31)).toBeCloseTo(52.8, 1);
    // An unknown type reads as Hall rather than throwing.
    expect(at(99, 69, 0)).toBeCloseTo(at(0, 69, 0), 5);
  });
  it("every EFFECT TYPE carries its own factory defaults", () => {
    // The device keeps these per type; a family-wide table would write one type's
    // values for all of them. Spot the rows that differ inside a family.
    expect(fxParams(0).find((d) => d.key === "reverbTime")!.def).toBe(23); // Rev-X Hall
    expect(fxParams(1).find((d) => d.key === "reverbTime")!.def).toBe(6); // Room
    expect(fxParams(2).find((d) => d.key === "revxHpf")!.def).toBe(12); // Plate
    expect(fxParams(770).find((d) => d.key === "erRevBalance")!.def).toBe(63); // Rev.R3 Plate
    for (const [key, mono, pp] of [
      ["delayFeedback", 20, 14],
      ["delayHiRatio", 7, 4],
      ["delayHpf", 40, 0],
      ["delayLpf", 110, 120],
    ] as const) {
      expect(fxParams(1024).find((d) => d.key === key)!.def).toBe(mono);
      expect(fxParams(1025).find((d) => d.key === key)!.def).toBe(pp);
    }
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
      fxEffect: { type: 0, on: true, level: 100, params: { reverbTime: 24, revxHpf: 9 } },
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

  // Silence is a statement, and this is the one place it is held. The skill's SKILL.md and
  // plan-schema.md both instruct a plan author to omit the FX section when the user did not
  // ask to change the effect, and promise that the unit keeps its current settings — so
  // emitting defaults for an undescribed channel resets a unit's FX from a document that says
  // nothing, and the EFFECT TYPE write is not recoverable (it refills the engine array with
  // that type's defaults, and selecting the old type back does not bring the old values).
  // This case carried no reason for a while, which is how it came to be rewritten as its own
  // opposite.
  it("emits nothing for an FX channel without an fxEffect", () => {
    const plan = emptyPlan("URX44V");
    const cmds = planToCommands(model, plan);
    expect(cmds.some((c) => c.paramId === 679 || c.paramId === 681)).toBe(false);
    expect(cmds.some((c) => c.paramId === 683 || c.paramId === 685)).toBe(false);
    // The positive control: the same plan DESCRIBING the channel writes it, so the assertion
    // above is about the omission rather than about an emit that never runs.
    plan.nodeParams["bus.fx1"] = { fxEffect: { type: 0 } };
    expect(planToCommands(model, plan).some((c) => c.paramId === 679)).toBe(true);
  });

  // …and the other half of that contract, which is the trap: there is no PARTIAL FX write.
  // An author told "author a selector only when the user asked to change the effect" can
  // write `{ level: 80 }` believing no selector goes out. The whole channel is authored the
  // moment the section exists — the array is absolute state, and a type write would refill
  // the slots left out anyway.
  it("writes the whole channel, selector included, once the plan describes it at all", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["bus.fx1"] = { fxEffect: { level: 80 } };
    const cmds = planToCommands(model, plan).filter((c) => c.paramId === 679 || c.paramId === 681);
    // The selector goes out although the document names no type…
    expect(cmds.find((c) => c.paramId === 679)?.vdValue).toBe(0);
    // …and every parameter slot with it, at the type's own defaults.
    const full = fxParams(0);
    expect(cmds.filter((c) => c.paramId === 681).length).toBe(full.length + 2);
    for (const d of full) expect(cmds.find((c) => c.y === d.slot)?.vdValue, d.key).toBe(d.def);
  });

  // Both types read a raw as raw / 10 and differ in the range they take. A 2000 ms Mono
  // delay is raw 20000, which is past Ping Pong's 13500, so re-keying it onto that type
  // would have the device clamp it to 1350 ms while the plan still showed 2000.
  it("does not re-interpret a Mono delay time as a Ping Pong one across a type switch", () => {
    const plan = emptyPlan("URX44V");
    const mono = 20000; // 2000 ms
    plan.nodeParams["bus.fx2"] = { fxEffect: { type: 1024, params: { [MONO_DELAY_KEY]: mono } } };
    expect(planToCommands(model, plan).find((c) => c.paramId === 685 && c.y === 6)?.vdValue).toBe(mono);
    // The EFFECT TYPE menu patches the type and keeps the params (inspector.ts).
    plan.nodeParams["bus.fx2"] = { fxEffect: { type: 1025, params: { [MONO_DELAY_KEY]: mono } } };
    const pingPong = planToCommands(model, plan).find((c) => c.paramId === 685 && c.y === 6)?.vdValue;
    expect(pingPong).not.toBe(mono);
    expect(pingPong).toBe(fxParams(1025).find((d) => d.key === PINGPONG_DELAY_KEY)!.def);
    // And back: the Mono value is still there, under its own key.
    plan.nodeParams["bus.fx2"] = { fxEffect: { type: 1024, params: { [MONO_DELAY_KEY]: mono } } };
    expect(planToCommands(model, plan).find((c) => c.paramId === 685 && c.y === 6)?.vdValue).toBe(mono);
  });

  // The two channels' menus are different lists (FX1 reverbs are Rev-X, FX2's are
  // Rev.R3), so a type real on the other channel is still one this selector does not
  // offer — writing it verbatim would hand the device a reverb the channel has not got.
  it("coerces a type off THIS channel's menu to the channel's factory type", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["bus.fx1"] = { fxEffect: { type: 768 } }; // Rev.R3 Hall: FX2 only
    plan.nodeParams["bus.fx2"] = { fxEffect: { type: 0 } }; // Rev-X Hall: FX1 only
    const cmds = planToCommands(model, plan);
    expect(cmds.find((c) => c.paramId === 679 && c.y === 0)?.vdValue).toBe(FX_EFFECT_TYPE_DEFAULT[0]);
    expect(cmds.find((c) => c.paramId === 683 && c.y === 0)?.vdValue).toBe(FX_EFFECT_TYPE_DEFAULT[1]);
    // …and the parameter slots follow the type actually written, not the plan's.
    expect(cmds.some((c) => c.paramId === 681 && c.y === 12)).toBe(true); // Rev-X roomSize
    expect(cmds.some((c) => c.paramId === 685 && c.y === 6)).toBe(true); // Mono Delay time
  });
});

// The three families share one plan params map, so a key two of them use is one
// storage slot: whatever the effect type is switched to reads what the previous type
// left there. That is the intent for reverbTime (slot 7 in both reverb families, one
// device parameter) and a defect for anything else.
describe("fx-effect parameter keys", () => {
  it("never gives two families the same key at different slots", () => {
    // Walked out of the catalog rather than off a list of names — every EFFECT TYPE
    // either menu offers, grouped by family — so a descriptor added later cannot
    // re-open the hole by reusing a name.
    const slotsByKey = new Map<string, Map<FxFamily, number>>();
    for (const t of [...fxEffectTypes(0), ...fxEffectTypes(1)]) {
      for (const d of fxParams(t.value)) {
        const perFamily = slotsByKey.get(d.key) ?? new Map<FxFamily, number>();
        perFamily.set(fxFamilyOf(t.value), d.slot);
        slotsByKey.set(d.key, perFamily);
      }
    }
    const offenders = [...slotsByKey]
      .filter(([, per]) => new Set(per.values()).size > 1)
      .map(([key, per]) => `${key} @ ${[...per].map(([f, s]) => `${f} ${s}`).join(", ")}`);
    expect(offenders).toEqual([]);
    // The one key two families deliberately share, at the slot that makes it one
    // parameter: a Rev-X reverb time carried into Rev.R3 is the same device value.
    expect([...(slotsByKey.get("reverbTime") ?? [])]).toEqual([
      ["revx", 7],
      ["revr3", 7],
    ]);
  });

  // The family is not the finest grain that matters: Mono Delay and Ping Pong are both
  // family "delay" and both put the delay time on slot 6. A key shared by two types a
  // CHANNEL offers is one storage slot the operator can move between with the EFFECT
  // TYPE menu, so the two must agree on where it lives and what it accepts.
  //
  // The DISPLAY is in the probe, with the one key that legitimately differs declared as
  // data: REV-X scales its Reverb Time per type, so one storage slot reads as three
  // different times. A new type-dependent display is red until it is named here.
  // Sampled at fixed raws rather than at `def`, which is per type by design.
  const DISPLAY_EXCEPTIONS = new Set(["reverbTime"]);
  it("never gives two of one channel's types the same key a different slot, range or display", () => {
    const probe = (d: FxParamDesc): string => {
      const shape = [d.slot, d.rawMin, d.rawMax, d.rawStep].join("|");
      if (!d.format || DISPLAY_EXCEPTIONS.has(d.key)) return shape;
      const lo = d.rawMin ?? 0;
      const hi = d.rawMax ?? 0;
      return [shape, ...[lo, Math.round((lo + hi) / 2), hi].map((r) => d.format!(r, {}))].join("|");
    };
    const offenders: string[] = [];
    for (const fxIndex of [0, 1]) {
      const byKey = new Map<string, { type: number; probe: string }>();
      for (const t of fxEffectTypes(fxIndex)) {
        for (const d of fxParams(t.value)) {
          const seen = byKey.get(d.key);
          const mine = probe(d);
          if (seen && seen.probe !== mine) {
            offenders.push(`FX${fxIndex + 1} ${d.key}: type ${seen.type} ${seen.probe} vs type ${t.value} ${mine}`);
          }
          if (!seen) byKey.set(d.key, { type: t.value, probe: mine });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // The table is keyed by SLOT, and a slot number means a different parameter in each
  // family — 16 is internal to REV-X and the LPF in Rev.R3 — so a row pasted under the
  // wrong type id lands on a real slot of another parameter and applies without complaint.
  // A row short of a slot is as quiet: fxParams falls back to the family array's own def,
  // which is one type's factory capture, and that is the defect the table exists to remove.
  it("every EFFECT TYPE names a default for exactly the slots its own descriptors address", () => {
    const offenders: string[] = [];
    for (const t of [...fxEffectTypes(0), ...fxEffectTypes(1)]) {
      const descs = fxParams(t.value);
      const row = FX_TYPE_DEFAULTS[t.value];
      if (!row) {
        offenders.push(`type ${t.value}: no row at all`);
        continue;
      }
      const addressed = new Set(descs.map((d) => d.slot));
      for (const d of descs) {
        if (row[d.slot] === undefined) offenders.push(`type ${t.value}: no default for ${d.key} @ slot ${d.slot}`);
      }
      for (const slot of Object.keys(row).map(Number)) {
        if (!addressed.has(slot))
          offenders.push(`type ${t.value}: default for slot ${slot}, which it does not address`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("REV-X shares one reverb-time slot across three types that display differently", () => {
    const seen = [0, 1, 2].map((t) => {
      const d = fxParams(t).find((x) => x.key === "reverbTime")!;
      return { slot: d.slot, range: [d.rawMin, d.rawMax].join("-"), shown: d.format!(69, { roomSize: 0 }) };
    });
    // One device parameter: same slot, same domain.
    expect(new Set(seen.map((x) => x.slot)).size).toBe(1);
    expect(new Set(seen.map((x) => x.range)).size).toBe(1);
    // Three readings, because the unit scales the seconds by type — and each type reads
    // its own, so swapping two rows of the scale table is red rather than still three.
    expect(seen.map((x) => x.shown)).toEqual(["10.3 s", "15.2 s", "17.6 s"]);
  });

  it("gives the two delay types their own delay-time key", () => {
    const mono = fxParams(1024).map((d) => d.key);
    const pingPong = fxParams(1025).map((d) => d.key);
    expect(mono).toContain(MONO_DELAY_KEY);
    expect(mono).not.toContain(PINGPONG_DELAY_KEY);
    expect(pingPong).toContain(PINGPONG_DELAY_KEY);
    expect(pingPong).not.toContain(MONO_DELAY_KEY);
  });

  it("re-keys a legacy plan's bare parameters onto the family that saved them", () => {
    const revx = { type: 0, params: { reverbTime: 24, hpf: 9, lpf: 55, hiRatio: 6 } };
    migrateFxEffectParams(revx, 0, 1);
    expect(revx.params).toEqual({ reverbTime: 24, revxHpf: 9, revxLpf: 55, revxHiRatio: 6 });

    const delay = { type: 1024, params: { delay: 7563, hpf: 9, lpf: 55, hiRatio: 6 } };
    migrateFxEffectParams(delay, 1, 1);
    expect(delay.params).toEqual({ delay: 7563, delayHpf: 9, delayLpf: 55, delayHiRatio: 6 });
  });

  // A plan saved by a pre-qualification build carries `params` with no `type` whenever
  // the operator changed a parameter without ever opening the EFFECT TYPE menu (the
  // inspector's parameter edit writes params alone). The channel's selector still has a
  // value then — the factory one — so the values are attributable, and skipping them
  // left the plan holding a key no build reads: the next flush wrote factory defaults
  // over the operator's settings, silently.
  it("attributes an untyped legacy fxEffect to its channel's factory type", () => {
    const fx1 = { params: { hpf: 9, lpf: 55 } };
    migrateFxEffectParams(fx1, 0, 1); // FX1 = Rev-X Hall
    expect(fx1.params).toEqual({ revxHpf: 9, revxLpf: 55 });

    const fx2 = { params: { hpf: 9, lpf: 55 } };
    migrateFxEffectParams(fx2, 1, 1); // FX2 = Mono Delay
    expect(fx2.params).toEqual({ delayHpf: 9, delayLpf: 55 });
  });

  it("keeps an untyped legacy document's values through a load", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["bus.fx1"] = { fxEffect: { params: { hpf: 9 } } };
    plan.nodeParams["bus.fx2"] = { fxEffect: { params: { hiRatio: 4 } } };
    const legacy = JSON.stringify({ ...JSON.parse(serialize(plan)), version: 1 });
    const loaded = deserialize(legacy);
    expect(loaded.nodeParams["bus.fx1"]?.fxEffect?.params).toEqual({ revxHpf: 9 });
    expect(loaded.nodeParams["bus.fx2"]?.fxEffect?.params).toEqual({ delayHiRatio: 4 });
    // The re-keyed values are what the write path emits — not the factory defaults it
    // emitted while the key addressed nothing.
    const cmds = planToCommands(getModel("URX44V"), loaded);
    expect(cmds.find((c) => c.paramId === 681 && c.y === 10)?.vdValue).toBe(9); // Rev-X HPF
    expect(cmds.find((c) => c.paramId === 685 && c.y === 8)?.vdValue).toBe(4); // delay Hi Ratio
  });

  it("runs on every load path (the deserialize funnel), for a version-1 document only", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["bus.fx1"] = { fxEffect: { type: 0, params: { hpf: 9 } } };
    const legacy = JSON.stringify({ ...JSON.parse(serialize(plan)), version: 1 });
    expect(deserialize(legacy).nodeParams["bus.fx1"]?.fxEffect?.params).toEqual({ revxHpf: 9 });
    // From version 2 on, the qualified names are what a document carries; a bare key
    // in one is not a legacy value and re-keying it would move a parameter the
    // document meant to leave alone.
    expect(deserialize(serialize(plan)).nodeParams["bus.fx1"]?.fxEffect?.params).toEqual({ hpf: 9 });
  });

  it("re-keys a pre-split document's Ping Pong delay time, and only before version 2", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["bus.fx2"] = { fxEffect: { type: 1025, params: { [MONO_DELAY_KEY]: 12000 } } };
    const legacy = JSON.stringify({ ...JSON.parse(serialize(plan)), version: 1 });
    expect(deserialize(legacy).nodeParams["bus.fx2"]?.fxEffect?.params).toEqual({ [PINGPONG_DELAY_KEY]: 12000 });
    // From version 2 on, a `delay` key beside a Ping Pong type is the MONO value parked
    // under its own key — re-keying it would be the re-interpretation the split prevents.
    expect(deserialize(serialize(plan)).nodeParams["bus.fx2"]?.fxEffect?.params).toEqual({
      [MONO_DELAY_KEY]: 12000,
    });
  });

  it("keeps an already-qualified value and a key the saved family does not have", () => {
    const fx = { type: 0, params: { hpf: 9, revxHpf: 4, feedback: 20 } };
    migrateFxEffectParams(fx, 0, 1);
    expect(fx.params.revxHpf).toBe(4); // Rev-X's own value wins over the bare one
    expect(fx.params.feedback).toBe(20); // Rev-X has no Feedback Gain — left alone
  });

  it("seeds every default plan's FX parameters under its own family's keys", () => {
    for (const modelId of MODEL_IDS) {
      const plan = defaultPlan(modelId);
      for (const [nodeId, np] of Object.entries(plan.nodeParams)) {
        const fx = np.fxEffect;
        if (!fx) continue;
        const owned = new Set(fxParams(fx.type ?? 0).map((d) => d.key));
        const stray = Object.keys(fx.params ?? {}).filter((k) => !owned.has(k));
        expect([modelId, nodeId, stray]).toEqual([modelId, nodeId, []]);
      }
    }
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
