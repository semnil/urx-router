// Insert-FX effect emission + round-trip. Verifies the selector binds the engine
// and the engine parameter array is written/read at the calibrated slots, and
// that emit∘readback is a fixed point for the effect params (the device twin of
// the live double-write check). Slots/encodings: control/insert-fx-effect.ts.

import { describe, expect, it, vi } from "vitest";
import { getModel } from "../../models";
import { emptyPlan } from "../plan";

vi.mock("../platform", () => ({ vdGet: vi.fn() }));
import { vdGet } from "../platform";
import { applyDeviceState } from "./readback";
import { planToCommands } from "./translate";
import type { VdCommand } from "./translate";
import { ENGINE_COMPANDER_INPUT, ENGINE_GUITAR, ENGINE_OUTPUT, ENGINE_PITCH } from "./insert-fx-effect";

const model = getModel("URX44V");

// First mono input channel that exposes the input insert FX (param 135).
const monoInput = model.nodes.find((n) => n.id === "ch_1" || n.id === "ch1" || n.id.startsWith("ch_1"))?.id
  ?? model.nodes.find((n) => n.kind === "channel")!.id;

function engineWrites(cmds: VdCommand[], engine: number): Map<number, number> {
  const m = new Map<number, number>();
  for (const c of cmds) if (c.paramId === engine) m.set(c.y, c.vdValue);
  return m;
}

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
    const stereo = model.nodes.find((n) => n.id === "stereo")?.id ?? model.nodes.find((n) => n.kind === "bus")!.id;
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

describe("insert-fx effect round-trip (emit∘readback fixed point)", () => {
  it("compander values read back then re-emit identically", async () => {
    const table = new Map<string, number>();
    // selector 135 on the mono input's instance + engine 689 slots.
    table.set("135:0:0", 1793);
    for (const [slot, v] of [[6, -1500], [7, 600], [8, 10000], [9, 2000], [10, -300], [11, 3000]]) {
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
});
