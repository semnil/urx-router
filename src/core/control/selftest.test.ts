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
  vdGetStr: vi.fn(),
}));

import { vdConnect, vdDisconnect, vdGet, vdGetStr, vdSet } from "../platform";
import { auditUnverified, planToCommands } from "./translate";
import { D_GAIN_PARAM, INSERT_FX_OPTIONS, PARAMS, PORT_REF_PARAM_IDS as PORT_REF_PARAMS } from "./params";
import { D_GAIN_MIN_DB, PORT_REF_NONE, VD_LEVEL_OFF } from "./vd";
import { formatSelfTestReport, perturbedPlan, runSelfTest } from "./selftest";

const model = getModel("URX44V");

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
  vi.mocked(vdConnect).mockResolvedValue({ model: "URX44V", label: "URX44V", epoch: 1 });
  vi.mocked(vdDisconnect).mockResolvedValue(undefined);
  vi.mocked(vdGet).mockImplementation((id, x, y) => {
    const k = `${id}:${x}:${y}`;
    return Promise.resolve(table.has(k) ? table.get(k)! : PORT_REF_PARAMS.has(id) ? PORT_REF_NONE : 0);
  });
  vi.mocked(vdSet).mockImplementation((id, x, y, v) => {
    table.set(`${id}:${x}:${y}`, v);
    return Promise.resolve();
  });
  // Names are read via the string IPC but not part of the self-test round-trip;
  // a faithful device reports no custom name (empty).
  vi.mocked(vdGetStr).mockResolvedValue("");
  return table;
}

beforeEach(() => {
  for (const m of [vdConnect, vdDisconnect, vdGet, vdSet, vdGetStr]) vi.mocked(m).mockReset();
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

  it("cancels mid-run via an abort signal: skips remaining passes and restore, still disconnects", async () => {
    installMockDevice(populatedPlan());
    const controller = new AbortController();
    // Abort once the device has been written to, so the run is cancelled in flight.
    vi.mocked(vdSet).mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve();
    });
    const report = await runSelfTest(model, 0, controller.signal);
    expect(report.aborted).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.restored).toBe(false);
    // A cancelled run does not sweep all passes.
    expect(report.phase).not.toBe("done");
    expect(vi.mocked(vdDisconnect)).toHaveBeenCalled();
  });

  it("does not start any pass when the signal is already aborted", async () => {
    installMockDevice(populatedPlan());
    const report = await runSelfTest(model, 0, AbortSignal.abort());
    expect(report.aborted).toBe(true);
    expect(report.written).toBe(0);
    expect(vi.mocked(vdSet)).not.toHaveBeenCalled();
    expect(vi.mocked(vdDisconnect)).toHaveBeenCalled();
  });

  it("aborts on model mismatch without writing, and disconnects", async () => {
    installMockDevice(populatedPlan());
    vi.mocked(vdConnect).mockResolvedValue({ model: "URX22", label: "URX22", epoch: 1 });
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

describe("unverified-guess workflow (URX22)", () => {
  const m22 = getModel("URX22");

  function seed22(): Plan {
    const plan = emptyPlan("URX22");
    ensureFixedConnections(m22, plan);
    return plan;
  }

  function installMock22(seed: Plan): Map<string, number> {
    const table = new Map<string, number>();
    for (const c of planToCommands(m22, seed)) table.set(`${c.paramId}:${c.x}:${c.y}`, c.vdValue);
    vi.mocked(vdConnect).mockResolvedValue({ model: "URX22", label: "URX22", epoch: 1 });
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

  it("has no static collisions after the ch_3_4 D.Gain id was moved off CLIP_SAFE", () => {
    // The re-guess (param 11) is free; the earlier guess (5) collided with CLIP_SAFE.
    expect(auditUnverified("URX22")).toEqual([]);
    expect(D_GAIN_PARAM["ch_3_4"]).not.toBe(PARAMS.CLIP_SAFE.id);
  });

  it("suppressGuess drops a D.Gain write without touching the shared-id confirmed param", () => {
    const original = seed22();
    original.nodeParams["ch_3_4"] = { gain: 6 };
    original.nodeParams["ch1"] = { clipSafe: true };
    const plan = perturbedPlan(m22, original, 0, new Set(["dgain-ch_3_4"]));
    expect(plan.nodeParams["ch_3_4"]?.gain).toBeUndefined();
    const cmds = planToCommands(m22, plan);
    // The D.Gain (HA_GAIN at its own id) is gone; CLIP_SAFE is still sent.
    expect(cmds.some((c) => c.name === "HA_GAIN" && c.paramId === D_GAIN_PARAM["ch_3_4"])).toBe(false);
    expect(cmds.some((c) => c.name === "CLIP_SAFE" && c.paramId === PARAMS.CLIP_SAFE.id)).toBe(true);
  });

  it("floors a non-colliding stereo channel's gain to its device minimum", () => {
    const original = seed22();
    original.nodeParams["ch_5_6"] = { gain: 12 };
    const plan = perturbedPlan(m22, original, 0);
    expect(plan.nodeParams["ch_5_6"]?.gain).toBe(D_GAIN_MIN_DB);
  });

  it("sweeps input source across real ports (not just the captured selection)", () => {
    const plan = perturbedPlan(m22, seed22(), 0);
    expect(plan.connections.some((c) => c.kind === "source")).toBe(true);
    const cmds = planToCommands(m22, plan);
    expect(cmds.some((c) => c.name === "INPUT_SOURCE" && c.vdValue !== PORT_REF_NONE)).toBe(true);
  });

  it("confirms every unverified guess on a faithful device (no collisions)", async () => {
    installMock22(seed22());
    const report = await runSelfTest(m22, 0);
    expect(report.device).toBe("URX22");
    expect(report.collisions).toEqual([]);
    expect(report.unverified.map((u) => u.key).sort()).toEqual(
      ["dgain-ch_3_4", "hiz-channel", "input-ports", "stereo-block"].sort(),
    );
    for (const u of report.unverified) {
      expect(u.collision).toBe(false);
      expect(u.confirmed).toBe(true);
    }
    expect(report.restored).toBe(true);
    // The exported report leads with the per-guess verdicts.
    const md = formatSelfTestReport(report);
    expect(md).toContain("# URX self-test report — URX22");
    expect(md).toContain("CONFIRMED");
  });
});
