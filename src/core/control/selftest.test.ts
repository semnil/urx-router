import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../../models";
import { emptyPlan, ensureFixedConnections, type Plan } from "../plan";

// runSelfTest drives the device through platform connect/get/set/disconnect, so
// mock those with a faithful in-memory device: vdSet stores, vdGet reads back.
vi.mock("../platform", () => ({
  vdConnect: vi.fn(),
  vdDisconnect: vi.fn(),
  vdGet: vi.fn(),
  vdSet: vi.fn(),
}));

import { vdConnect, vdDisconnect, vdGet, vdSet } from "../platform";
import { planToCommands } from "./translate";
import { INSERT_FX_OPTIONS } from "./params";
import { PORT_REF_NONE, VD_LEVEL_OFF } from "./vd";
import { perturbedPlan, runSelfTest } from "./selftest";

const model = getModel("URX44V");
const PORT_REF_PARAMS = new Set([22, 259, 705, 706, 719, 720, 730, 731, 732, 733, 734, 735]);

function populatedPlan(): Plan {
  const plan = emptyPlan("URX44V");
  ensureFixedConnections(model, plan);
  plan.nodeParams["ch1"] = { on: true, hpf: false, gain: -8, hpfFreq: 80 };
  plan.nodeParams["bus.stereo"] = { on: true };
  plan.connections.push({
    from: "ch1:out",
    to: "bus.mix1:in",
    kind: "send",
    params: { level: -6, pan: 0, tap: "post" },
  });
  return plan;
}

// Faithful mock device: a value table seeded from a plan; vdSet writes, vdGet
// reads (an unset port-ref address reads the NONE sentinel, like the broker).
function installMockDevice(seed: Plan): Map<string, number> {
  const table = new Map<string, number>();
  for (const c of planToCommands(model, seed)) table.set(`${c.paramId}:${c.x}:${c.y}`, c.vdValue);
  vi.mocked(vdConnect).mockResolvedValue({ model: "URX44V", label: "URX44V" });
  vi.mocked(vdDisconnect).mockResolvedValue(undefined);
  vi.mocked(vdGet).mockImplementation((id, x, y) => {
    const k = `${id}:${x}:${y}`;
    return Promise.resolve(table.has(k) ? table.get(k)! : PORT_REF_PARAMS.has(id) ? PORT_REF_NONE : 0);
  });
  vi.mocked(vdSet).mockImplementation((id, x, y, v) => {
    table.set(`${id}:${x}:${y}`, v);
    return Promise.resolve();
  });
  return table;
}

beforeEach(() => {
  for (const m of [vdConnect, vdDisconnect, vdGet, vdSet]) vi.mocked(m).mockReset();
});

describe("runSelfTest", () => {
  it("passes and restores against a faithful device", async () => {
    installMockDevice(populatedPlan());
    const report = await runSelfTest(model, 0);
    expect(report.device).toBe("URX44V");
    expect(report.phase).toBe("done");
    expect(report.passes).toBe(INSERT_FX_OPTIONS.length);
    expect(report.residual).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.restored).toBe(true);
    expect(report.written).toBeGreaterThan(0);
    expect(vi.mocked(vdDisconnect)).toHaveBeenCalled();
  });

  it("reports residual mismatches when the device ignores a write", async () => {
    const table = installMockDevice(populatedPlan());
    // CH_ON (param 140) is accepted but never stored — a stuck parameter.
    vi.mocked(vdSet).mockImplementation((id, x, y, v) => {
      if (id !== 140) table.set(`${id}:${x}:${y}`, v);
      return Promise.resolve();
    });
    const report = await runSelfTest(model, 0);
    expect(report.ok).toBe(false);
    expect(report.residual.some((m) => m.paramId === 140)).toBe(true);
  });

  it("aborts on model mismatch without writing, and disconnects", async () => {
    installMockDevice(populatedPlan());
    vi.mocked(vdConnect).mockResolvedValue({ model: "URX22", label: "URX22" });
    const report = await runSelfTest(model, 0);
    expect(report.ok).toBe(false);
    expect(report.errors.join(" ")).toContain("URX22");
    expect(vi.mocked(vdSet)).not.toHaveBeenCalled();
    expect(vi.mocked(vdDisconnect)).toHaveBeenCalled();
  });

  it("perturbed plans are silent — faders floored, oscillator and phantom off", () => {
    // A live-sounding original: hot gain, master up, oscillator running, phantom on.
    const original = populatedPlan();
    original.nodeParams["ch1"] = { gain: 40, phantom: true };
    original.nodeParams["bus.stereo"] = { on: true, level: 5 };
    original.nodeParams["bus.osc"] = { osc: { on: true, level: -6, mode: 0, freq: 1000 } };

    const plan = perturbedPlan(model, original, 0);
    expect(plan.nodeParams["bus.osc"]?.osc?.on).toBe(false);
    expect(Object.values(plan.nodeParams).some((np) => np.phantom)).toBe(false);

    const cmds = planToCommands(model, plan);
    // Oscillator generator off, no phantom, and every fader / send level floored.
    expect(cmds.find((c) => c.name === "OSC_ON")!.vdValue).toBe(0);
    expect(cmds.filter((c) => c.name === "PHANTOM").every((c) => c.vdValue === 0)).toBe(true);
    const faders = cmds.filter((c) => /FADER|SEND_LEVEL/.test(c.name));
    expect(faders.length).toBeGreaterThan(0);
    expect(faders.every((c) => c.vdValue === VD_LEVEL_OFF)).toBe(true);
  });
});
