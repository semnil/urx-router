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
import {
  dGainParam,
  INSERT_FX_NONE,
  INSERT_FX_OPTIONS,
  OUTPUT_INSERT_FX_OPTIONS,
  PARAMS,
  PORT_REF_PARAM_IDS as PORT_REF_PARAMS,
} from "./params";
import { D_GAIN_MIN_DB, PORT_REF_NONE, VD_LEVEL_OFF } from "./vd";
import { formatSelfTestReport, PASSES, perturbedPlan, runSelfTest } from "./selftest";

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
  vi.mocked(vdConnect).mockResolvedValue({ model: "URX44V", label: "URX44V", firmware: "", epoch: 1 });
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
    expect(report.passes).toBe(8);
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
    vi.mocked(vdConnect).mockResolvedValue({ model: "URX22", label: "URX22", firmware: "", epoch: 1 });
    const report = await runSelfTest(model, 0);
    expect(report.ok).toBe(false);
    expect(report.errors.join(" ")).toContain("URX22");
    expect(vi.mocked(vdSet)).not.toHaveBeenCalled();
    expect(vi.mocked(vdDisconnect)).toHaveBeenCalled();
  });

  it("sweeps insert FX one node per kind and writes the modeled ON/OFF after the selector", () => {
    // A captured "selected but bypassed" effect: the sweep may re-select effects
    // because the ON/OFF (bypass) switch is modeled (insertFxOn) and emitted
    // after the selector, overriding the device's auto-engage — the restore then
    // puts the bypass back.
    const original = populatedPlan();
    // A real capture reads insertFxOn on every insert-capable node; mirror that.
    for (const id of ["ch1", "ch2", "ch3", "ch4"]) {
      original.nodeParams[id] = { ...original.nodeParams[id], insertFxOn: id !== "ch1" };
    }
    original.nodeParams["ch1"] = {
      ...original.nodeParams["ch1"],
      insertFx: 1794,
      insertFxParams: { "6": -1000 },
    };
    original.nodeParams["bus.mix1"] = { insertFx: 1794, insertFxOn: true };
    for (let pass = 0; pass < PASSES; pass++) {
      const plan = perturbedPlan(model, original, pass);
      // Stale engine params never survive the sweep: they belong to the captured
      // effect, and writing them into a freshly selected engine would be nonsense.
      for (const np of Object.values(plan.nodeParams)) expect(np.insertFxParams).toBeUndefined();
      // At most one active effect per kind (device-wide 1-of-N slot exclusivity),
      // holding exactly this pass's option.
      const held = Object.values(plan.nodeParams)
        .map((np) => np.insertFx)
        .filter((v): v is number => v !== undefined && v !== INSERT_FX_NONE);
      const inputOpt = INSERT_FX_OPTIONS[pass % INSERT_FX_OPTIONS.length].value;
      const outputOpt = OUTPUT_INSERT_FX_OPTIONS[pass % OUTPUT_INSERT_FX_OPTIONS.length].value;
      const expected = [inputOpt, outputOpt].filter((v) => v !== INSERT_FX_NONE);
      expect(held.sort()).toEqual(expected.sort());
      // The ON/OFF switch is written only for effect-bearing nodes, after their
      // selector (the device auto-engages on selection; the plan's state must
      // land last). The receiving input rotates across the mono channels per pass.
      const activeIn = ["ch1", "ch2", "ch3", "ch4"][pass % 4];
      const cmds = planToCommands(model, plan);
      if (inputOpt === INSERT_FX_NONE) {
        expect(cmds.filter((c) => c.node === activeIn).map((c) => c.name)).not.toContain("INSERT_FX_ON");
      } else {
        const names = cmds.filter((c) => c.node === activeIn && c.name.startsWith("INSERT_FX")).map((c) => c.name);
        expect(names).toEqual(["INSERT_FX", "INSERT_FX_ON"]);
      }
      // ch1's captured bypass (false) is flipped by perturb, so whenever ch1 is
      // the active holder its switch write is 1.
      if (activeIn === "ch1" && inputOpt !== INSERT_FX_NONE) {
        expect(cmds.find((c) => c.node === "ch1" && c.name === "INSERT_FX_ON")!.vdValue).toBe(1);
      }
      if (inputOpt === INSERT_FX_NONE && outputOpt === INSERT_FX_NONE) {
        expect(cmds.filter((c) => c.name === "INSERT_FX_ON")).toEqual([]);
      }
    }
  });

  it("never sweeps a rate-locked insert FX option (Pitch Fix above 48 kHz)", () => {
    const original = populatedPlan();
    original.sampleRate = 96000;
    for (let pass = 0; pass < PASSES; pass++) {
      const plan = perturbedPlan(model, original, pass);
      for (const np of Object.values(plan.nodeParams)) expect(np.insertFx).not.toBe(512);
    }
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
    vi.mocked(vdConnect).mockResolvedValue({ model: "URX22", label: "URX22", firmware: "", epoch: 1 });
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

  it("has no static collisions: the URX22 D.Gain map reuses confirmed ids, inventing none", () => {
    // The positional map (CH3/4 = 9) reuses URX44V-confirmed D.Gain ids, so there is
    // no invented id to collide with a catalog param.
    expect(auditUnverified("URX22")).toEqual([]);
    expect(dGainParam("URX22", "ch_3_4")).toBe(9);
  });

  it("suppressing dgain-urx22 drops every URX22 D.Gain write but leaves other params", () => {
    const original = seed22();
    original.nodeParams["ch_3_4"] = { gain: 6 };
    original.nodeParams["ch_5_6"] = { gain: -3 };
    original.nodeParams["ch1"] = { clipSafe: true };
    const plan = perturbedPlan(m22, original, 0, new Set(["dgain-urx22"]));
    expect(plan.nodeParams["ch_3_4"]?.gain).toBeUndefined();
    expect(plan.nodeParams["ch_5_6"]?.gain).toBeUndefined();
    const cmds = planToCommands(m22, plan);
    // No D.Gain (HA_GAIN at a D.Gain block id) is sent; CLIP_SAFE is still sent.
    expect(cmds.some((c) => c.name === "HA_GAIN" && [9, 13, 14, 15].includes(c.paramId))).toBe(false);
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
      ["dgain-urx22", "hiz-channel", "input-ports", "stereo-block"].sort(),
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
