// Insert-FX effect emission + round-trip. Verifies the selector binds the engine
// and the engine parameter array is written/read at the calibrated slots, and
// that emit∘readback is a fixed point for the effect params (the device twin of
// the live double-write check). Slots/encodings: control/insert-fx-effect.ts.

import { describe, expect, it, vi } from "vitest";
import { getModel } from "../../models";
import { deserialize, emptyPlan, serialize } from "../plan";

vi.mock("../platform", () => ({ vdGet: vi.fn() }));
import { vdGet } from "../platform";
import { INSERT_FX_NONE } from "./params";
import { applyDeviceState } from "./readback";
import { planToCommands } from "./translate";
import type { VdCommand } from "./translate";
import {
  ENGINE_COMPANDER_INPUT,
  ENGINE_GUITAR,
  ENGINE_OUTPUT,
  ENGINE_PITCH,
  MBC_BAND_PARAM,
  MBC_BYPASS_SLOT,
  MBC_GLOBAL,
  MBC_RELEASE_MS,
  MBC_XOVER_LM_RANGE,
  MBC_XOVER_MH_RANGE,
  insertFxEngine,
  insertFxFamilyOf,
  insertFxParamKey,
  insertFxParams,
  insertFxWritableSlots,
  mbcOutGainLabel,
  mbcXoverHz,
  mbcXoverLabel,
  midiNoteName,
  qualifyInsertFxParams,
  type InsertFxFamily,
} from "./insert-fx-effect";

const model = getModel("URX44V");

// First mono input channel that exposes the input insert FX (param 135).
const monoInput = model.nodes.find((n) => n.id === "ch1")?.id ?? model.nodes.find((n) => n.kind === "channel")!.id;

function engineWrites(cmds: VdCommand[], engine: number): Map<number, number> {
  const m = new Map<number, number>();
  for (const c of cmds) if (c.paramId === engine) m.set(c.y, c.vdValue);
  return m;
}

describe("insert-fx encodings (live calibration anchors)", () => {
  it("MBC crossover = exact R40 table (raw 0 = 15 Hz, raw 6 = 21.2 Hz)", () => {
    expect(mbcXoverHz(0)).toBeCloseTo(15, 5);
    expect(mbcXoverHz(6)).toBeCloseTo(21.2, 5);
    expect(Math.round(mbcXoverHz(37))).toBe(125); // device shows 125, not the 127 a pure formula gives
  });
  it("MBC crossover label switches Hz integer / Hz decimal / kHz", () => {
    expect(mbcXoverLabel(0)).toBe("15 Hz");
    expect(mbcXoverLabel(6)).toBe("21.2 Hz");
    expect(mbcXoverLabel(37)).toBe("125 Hz");
    expect(mbcXoverLabel(95)).toBe("3.55 kHz");
  });
  it("MBC crossover valid ranges hit the device endpoints", () => {
    expect(mbcXoverLabel(MBC_XOVER_LM_RANGE.min)).toBe("21.2 Hz");
    expect(mbcXoverLabel(MBC_XOVER_LM_RANGE.max)).toBe("4.00 kHz");
    expect(mbcXoverLabel(MBC_XOVER_MH_RANGE.min)).toBe("42.5 Hz");
    expect(mbcXoverLabel(MBC_XOVER_MH_RANGE.max)).toBe("8.00 kHz");
  });
  it("MBC band Gain taper anchors (raw 0 = -∞, 1/-60, 20/-17, 39/+2, 47/+10, 55/+18)", () => {
    const g = MBC_BAND_PARAM.gain.format;
    expect(g(0)).toBe("-∞ dB");
    expect(g(1)).toBe("-60 dB");
    expect(g(20)).toBe("-17 dB");
    expect(g(39)).toBe("2 dB");
    expect(g(47)).toBe("10 dB");
    expect(g(55)).toBe("18 dB");
  });
  it("MBC band Threshold = raw − 127 (raw 73..121 → -54..-6 dB)", () => {
    const th = MBC_BAND_PARAM.threshold.format;
    expect(th(73)).toBe("-54 dB");
    expect(th(107)).toBe("-20 dB");
    expect(th(121)).toBe("-6 dB");
  });
  it("MBC band Attack / Ratio are index tables", () => {
    expect(MBC_BAND_PARAM.attack.format(0)).toBe("1 ms");
    expect(MBC_BAND_PARAM.attack.format(MBC_BAND_PARAM.attack.rawMax)).toBe("200 ms");
    expect(MBC_BAND_PARAM.ratio.format(0)).toBe("1.0:1");
    expect(MBC_BAND_PARAM.ratio.format(MBC_BAND_PARAM.ratio.rawMax)).toBe("20.0:1");
  });
  it("MBC Out Gain = raw − 64 dB", () => {
    expect(mbcOutGainLabel(64)).toBe("0 dB");
    expect(mbcOutGainLabel(68)).toBe("4 dB");
    expect(mbcOutGainLabel(52)).toBe("-12 dB");
  });
  it("MBC Release table endpoints", () => {
    expect(MBC_RELEASE_MS[0]).toBe(10);
    expect(MBC_RELEASE_MS[MBC_RELEASE_MS.length - 1]).toBe(3000);
  });
  it("Guitar Amp Output taper anchors (raw 0 = -∞ … raw 127 = 0 dB)", () => {
    const out = insertFxParams("guitar-clean").find((d) => d.slot === 14)!.format!;
    expect(out(0)).toBe("-∞ dB");
    expect(out(8)).toBe("-48.0 dB"); // lowest live anchor
    expect(out(96)).toBe("-4.9 dB"); // live anchor
    expect(out(127)).toBe("0.0 dB");
  });
  it("MIDI note name uses Yamaha numbering (C-2 = 0, C3 = 60)", () => {
    expect(midiNoteName(0)).toBe("C-2");
    expect(midiNoteName(60)).toBe("C3");
    expect(midiNoteName(69)).toBe("A3");
    expect(midiNoteName(127)).toBe("G8");
  });
});

describe("insert-fx family / engine / slot mapping", () => {
  it("maps each selector enum to its family (unknown → null)", () => {
    expect(insertFxFamilyOf(256)).toBe("guitar-clean");
    expect(insertFxFamilyOf(259)).toBe("guitar-drive");
    expect(insertFxFamilyOf(512)).toBe("pitch");
    expect(insertFxFamilyOf(1792)).toBe("mbc");
    expect(insertFxFamilyOf(1793)).toBe("compander");
    expect(insertFxFamilyOf(1794)).toBe("compander");
    expect(insertFxFamilyOf(999)).toBeNull();
  });
  it("compander binds 689 on input, 693 on output; others are fixed", () => {
    expect(insertFxEngine("compander", false)).toBe(ENGINE_COMPANDER_INPUT);
    expect(insertFxEngine("compander", true)).toBe(ENGINE_OUTPUT);
    expect(insertFxEngine("guitar-clean", false)).toBe(ENGINE_GUITAR);
    expect(insertFxEngine("pitch", false)).toBe(ENGINE_PITCH);
    expect(insertFxEngine("mbc", true)).toBe(ENGINE_OUTPUT);
  });
  it("pitch writable slots include scale + 12 notes + MIDI bits, with mirrors", () => {
    const slots = insertFxWritableSlots("pitch");
    const ids = slots.map((s) => s.slot);
    expect(ids).toContain(16); // scale
    for (const note of [22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33]) expect(ids).toContain(note);
    expect(ids).toContain(34); // MIDI enable
    expect(ids).toContain(35); // MIDI realtime
    // Coarse/Fine/Formant carry a mirror slot.
    expect(slots.filter((s) => s.mirror !== undefined).map((s) => `${s.slot}->${s.mirror}`)).toEqual([
      "6->9",
      "7->10",
      "8->11",
    ]);
  });
});

describe("the multi-band compressor's Band Bypass", () => {
  it("is not in the writable set, so nothing emits it", () => {
    // It bypasses the band the UNIT has selected, and that selection is on no address:
    // driving the three bands to different depths and setting the slot stopped MID alone
    // while LOW kept reducing. A plan value here would land on a band the app cannot name.
    expect(insertFxWritableSlots("mbc").some((s) => s.slot === MBC_BYPASS_SLOT)).toBe(false);
  });

  it("still names the slot, so it is not rediscovered as a free one", () => {
    expect(MBC_BYPASS_SLOT).toBe(17);
    // …and it is not reachable through the globals, which is what the emit path walks.
    expect(Object.values(MBC_GLOBAL)).not.toContain(MBC_BYPASS_SLOT);
  });
});

describe("the guitar amps' shared rows", () => {
  const labelOf = (family: Parameters<typeof insertFxParams>[0], slot: number): string =>
    insertFxParams(family).find((d) => d.slot === slot)!.label;

  it("names slot 7 Volume on Clean and Gain on the other three", () => {
    // The unit prints Volume there on Clean alone; the slot, its encoding and its range
    // are one thing across all four, so only the label differs.
    expect(labelOf("guitar-clean", 7)).toBe("volume");
    for (const f of ["guitar-crunch", "guitar-lead", "guitar-drive"] as const) {
      expect(labelOf(f, 7)).toBe("gain");
    }
  });

  it("keeps the read order the emit path walks", () => {
    // Substituting the label must not move the row: the writable-slot enumeration and the
    // Inspector both walk this list in order.
    const slots = (f: Parameters<typeof insertFxParams>[0]): number[] => insertFxParams(f).map((d) => d.slot);
    expect(slots("guitar-clean").slice(0, 9)).toEqual(slots("guitar-crunch").slice(0, 9));
  });
});

describe("insert-fx effect emission", () => {
  it("compander: selector + engine 689 array at calibrated slots", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams[monoInput] = {
      insertFx: 1793,
      insertFxParams: { "6": -2000, "7": 400, "8": 5000, "9": 3000, "10": -600, "11": 1200 },
    };
    const cmds = planToCommands(model, plan);
    expect(cmds.some((c) => c.name === "INSERT_FX" && c.vdValue === 1793)).toBe(true);
    const eng = engineWrites(cmds, ENGINE_COMPANDER_INPUT);
    expect(eng.get(6)).toBe(-2000); // threshold
    expect(eng.get(7)).toBe(400); // ratio
    expect(eng.get(9)).toBe(3000); // release
    expect(eng.get(11)).toBe(1200); // width
  });

  it("pitch: coarse mirrors slot 6 -> slot 9, formant mirrors 8 -> 11", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams[monoInput] = { insertFx: 512, insertFxParams: { "6": 7, "8": 100 } };
    const cmds = planToCommands(model, plan);
    const eng = engineWrites(cmds, ENGINE_PITCH);
    expect(eng.get(6)).toBe(7);
    expect(eng.get(9)).toBe(7); // coarse mirror
    expect(eng.get(8)).toBe(100);
    expect(eng.get(11)).toBe(100); // formant mirror
  });

  it("guitar amp: writes to engine 697", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams[monoInput] = { insertFx: 256, insertFxParams: { "11": 80 } }; // treble
    const cmds = planToCommands(model, plan);
    expect(engineWrites(cmds, ENGINE_GUITAR).get(11)).toBe(80);
  });

  it("MBC on STEREO master: writes to output engine 693", () => {
    const plan = emptyPlan("URX44V");
    const stereo = model.nodes.find((n) => n.id === "bus.stereo")?.id ?? model.nodes.find((n) => n.kind === "bus")!.id;
    plan.nodeParams[stereo] = { insertFx: 1792, insertFxParams: { "9": 100 } }; // LOW threshold
    const cmds = planToCommands(model, plan);
    expect(engineWrites(cmds, ENGINE_OUTPUT).get(9)).toBe(100);
  });

  it("compander on an output bus binds engine 693 (not the input 689)", () => {
    const plan = emptyPlan("URX44V");
    const bus = model.nodes.find((n) => n.kind === "bus")!.id;
    plan.nodeParams[bus] = { insertFx: 1793, insertFxParams: { "6": -2500 } };
    const cmds = planToCommands(model, plan);
    expect(engineWrites(cmds, ENGINE_OUTPUT).get(6)).toBe(-2500);
    expect(engineWrites(cmds, ENGINE_COMPANDER_INPUT).has(6)).toBe(false);
  });
});

// The plan keeps ONE engine-slot map per node. Keyed by slot alone it is handed to
// whatever family the selector names next, whose slot is a different parameter under
// a different law: Compander-H Threshold -3000 is MBC's 1-knob switch (a bool), its
// ratio, its band width. INSERT_FX is a converge side effect, so the emit path re-sends
// that until the device agrees — it never reads the device back into the plan.
describe("insert-fx plan storage is qualified by family", () => {
  const stereo = model.nodes.find((n) => n.id === "bus.stereo")?.id ?? model.nodes.find((n) => n.kind === "bus")!.id;

  it("does not emit one family's stored values under the next family's slots", () => {
    const plan = emptyPlan("URX44V");
    // Compander-H on the STEREO master, Threshold -30 dB + Width 6 dB, then the
    // selector moved to Multi-Band Comp with the values left behind.
    plan.nodeParams[stereo] = {
      insertFx: 1793,
      insertFxParams: { [insertFxParamKey("compander", 6)]: -3000, [insertFxParamKey("compander", 11)]: 600 },
    };
    expect(engineWrites(planToCommands(model, plan), ENGINE_OUTPUT).get(6)).toBe(-3000);
    plan.nodeParams[stereo] = { ...plan.nodeParams[stereo], insertFx: 1792 };
    const mbc = engineWrites(planToCommands(model, plan), ENGINE_OUTPUT);
    expect(mbc.has(6)).toBe(false); // MBC 1-knob switch, not a compander threshold
    expect(mbc.has(11)).toBe(false); // MBC LOW band gain, not a compander width
    // Selecting the compander again finds its own values where it left them.
    plan.nodeParams[stereo] = { ...plan.nodeParams[stereo], insertFx: 1793 };
    expect(engineWrites(planToCommands(model, plan), ENGINE_OUTPUT).get(6)).toBe(-3000);
  });

  it("reads a bare slot number as the selected family's (the readback shape)", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams[monoInput] = { insertFx: 1793, insertFxParams: { "6": -2000 } };
    expect(engineWrites(planToCommands(model, plan), ENGINE_COMPANDER_INPUT).get(6)).toBe(-2000);
  });

  it("qualifies a loaded document's bare slots against the selector it carries", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams[stereo] = { insertFx: 1793, insertFxParams: { "6": -3000 } };
    const loaded = deserialize(serialize(plan));
    expect(loaded.nodeParams[stereo]?.insertFxParams).toEqual({ [insertFxParamKey("compander", 6)]: -3000 });
  });

  // A document saved with the selector on No Effect still carries the full engine map
  // of whatever was chosen before it (an older build's selector change kept it), and
  // the next selection reads it — the CONSOLE's INS FX chip restores an effect without
  // going near the map. Nothing can address those raws until a family is named, so the
  // load drops them; what a family already parked under its own key stays.
  it("drops bare slots a No Effect document has nothing to read them as", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams[stereo] = {
      insertFx: INSERT_FX_NONE,
      insertFxParams: { "6": -3000, [insertFxParamKey("compander", 11)]: 600 },
    };
    expect(deserialize(serialize(plan)).nodeParams[stereo]?.insertFxParams).toEqual({
      [insertFxParamKey("compander", 11)]: 600,
    });
    const bareOnly = emptyPlan("URX44V");
    bareOnly.nodeParams[stereo] = { insertFx: INSERT_FX_NONE, insertFxParams: { "6": -3000 } };
    expect(deserialize(serialize(bareOnly)).nodeParams[stereo]?.insertFxParams).toBeUndefined();
  });

  it("keeps the value a family authored over the bare one read back for it", () => {
    const params = qualifyInsertFxParams({ "6": -2000, [insertFxParamKey("compander", 6)]: -3000 }, "compander");
    expect(params).toEqual({ [insertFxParamKey("compander", 6)]: -3000 });
  });
});

// boundRaw is documented as the last line before an out-of-range raw reaches the
// hardware, and it is a no-op for a slot that states no bounds — an opt-out no
// catalog reader can see. MBC slot 6 is the case that showed it: a bool taking a
// compander's -3000 unchanged.
describe("insert-fx writable slots are all bounded", () => {
  const families: InsertFxFamily[] = [
    "guitar-clean",
    "guitar-crunch",
    "guitar-lead",
    "guitar-drive",
    "pitch",
    "compander",
    "mbc",
  ];
  for (const fam of families) {
    it(`${fam}: every emitted slot states a finite raw range`, () => {
      for (const s of insertFxWritableSlots(fam)) {
        expect.soft(Number.isFinite(s.rawMin), `${fam} slot ${s.slot} rawMin`).toBe(true);
        expect.soft(Number.isFinite(s.rawMax), `${fam} slot ${s.slot} rawMax`).toBe(true);
        expect.soft(s.rawMin, `${fam} slot ${s.slot} rawMin <= rawMax`).toBeLessThanOrEqual(s.rawMax);
      }
    });
  }

  it("bounds an out-of-range raw on a device-managed bool slot", () => {
    const plan = emptyPlan("URX44V");
    const stereo = model.nodes.find((n) => n.id === "bus.stereo")?.id ?? model.nodes.find((n) => n.kind === "bus")!.id;
    plan.nodeParams[stereo] = {
      insertFx: 1792,
      insertFxParams: { [insertFxParamKey("mbc", MBC_GLOBAL.oneKnobOn)]: -3000 },
    };
    expect(engineWrites(planToCommands(model, plan), ENGINE_OUTPUT).get(MBC_GLOBAL.oneKnobOn)).toBe(0);
  });
});

describe("insert-fx effect round-trip (emit∘readback fixed point)", () => {
  it("compander values read back then re-emit identically", async () => {
    const table = new Map<string, number>();
    // selector 135 on the mono input's instance + engine 689 slots.
    table.set("135:0:0", 1793);
    for (const [slot, v] of [
      [6, -1500],
      [7, 600],
      [8, 10000],
      [9, 2000],
      [10, -300],
      [11, 3000],
    ]) {
      table.set(`${ENGINE_COMPANDER_INPUT}:0:${slot}`, v);
    }
    vi.mocked(vdGet).mockImplementation((id, x, y) => {
      const k = `${id}:${x}:${y}`;
      if (table.has(k)) return Promise.resolve(table.get(k)!);
      return Promise.resolve(0);
    });
    const plan = emptyPlan("URX44V");
    await applyDeviceState(model, plan);
    // The mono input that owns selector 135:0:0 should have picked up the params.
    const owner = Object.entries(plan.nodeParams).find(([, p]) => p.insertFx === 1793)?.[0];
    expect(owner).toBeTruthy();
    expect(plan.nodeParams[owner!].insertFxParams?.["6"]).toBe(-1500);
    expect(plan.nodeParams[owner!].insertFxParams?.["11"]).toBe(3000);
    // Re-emit reproduces the same engine writes (fixed point).
    const eng = engineWrites(planToCommands(model, plan), ENGINE_COMPANDER_INPUT);
    expect(eng.get(6)).toBe(-1500);
    expect(eng.get(8)).toBe(10000);
  });

  it("pitch reads primary slots then re-emits both primary and mirror", async () => {
    const table = new Map<string, number>();
    table.set("135:0:0", 512); // pitch selector on the mono input instance
    // Readback iterates writable slots by primary slot only; seed coarse/fine/formant
    // primaries (the mirror is enforced on write, not read).
    for (const [slot, v] of [
      [6, 5],
      [7, -20],
      [8, 90],
    ])
      table.set(`${ENGINE_PITCH}:0:${slot}`, v);
    vi.mocked(vdGet).mockImplementation((id, x, y) => Promise.resolve(table.get(`${id}:${x}:${y}`) ?? 0));
    const plan = emptyPlan("URX44V");
    await applyDeviceState(model, plan);
    const owner = Object.entries(plan.nodeParams).find(([, p]) => p.insertFx === 512)?.[0];
    expect(owner).toBeTruthy();
    expect(plan.nodeParams[owner!].insertFxParams?.["6"]).toBe(5);
    const eng = engineWrites(planToCommands(model, plan), ENGINE_PITCH);
    expect(eng.get(6)).toBe(5);
    expect(eng.get(9)).toBe(5); // coarse mirror
    expect(eng.get(8)).toBe(90);
    expect(eng.get(11)).toBe(90); // formant mirror
  });

  it("MBC on the STEREO master round-trips per-band + global engine 693 slots", async () => {
    const stereo = model.nodes.find((n) => n.id === "bus.stereo")?.id ?? model.nodes.find((n) => n.kind === "bus")!.id;
    const ctrl = (await import("./translate")).insertFxControl(model, stereo)!;
    const table = new Map<string, number>();
    table.set(`${ctrl.param}:0:${ctrl.instances[0]}`, 1792); // MBC selector on the STEREO bus
    table.set(`${ENGINE_OUTPUT}:0:9`, 100); // LOW threshold
    table.set(`${ENGINE_OUTPUT}:0:23`, 50); // L-M crossover
    vi.mocked(vdGet).mockImplementation((id, x, y) => Promise.resolve(table.get(`${id}:${x}:${y}`) ?? 0));
    const plan = emptyPlan("URX44V");
    await applyDeviceState(model, plan);
    expect(plan.nodeParams[stereo]?.insertFx).toBe(1792);
    expect(plan.nodeParams[stereo]?.insertFxParams?.["9"]).toBe(100);
    expect(plan.nodeParams[stereo]?.insertFxParams?.["23"]).toBe(50);
    const eng = engineWrites(planToCommands(model, plan), ENGINE_OUTPUT);
    expect(eng.get(9)).toBe(100);
    expect(eng.get(23)).toBe(50);
  });
});
