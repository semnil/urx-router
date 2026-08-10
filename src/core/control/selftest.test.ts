import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../../models";
import { emptyPlan, ensureFixedConnections, type Plan } from "../plan";
import { defaultPlan } from "../../models/initial-state";

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
import { auditUnverified, eqOneKnob, inputEq, planToCommands, unverifiedAddresses } from "./translate";
import {
  dGainParam,
  INSERT_FX_NONE,
  INSERT_FX_OPTIONS,
  OUTPUT_INSERT_FX_OPTIONS,
  PARAMS,
  PORT_REF_PARAM_IDS as PORT_REF_PARAMS,
} from "./params";
import { D_GAIN_MIN_DB, PORT_REF_NONE, VD_LEVEL_OFF } from "./vd";
import {
  formatSelfTestReport,
  passesFor,
  PASSES,
  perturbedPlan,
  runSelfTest,
  selectableInputIds,
  summarizeVerdicts,
} from "./selftest";

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

describe("passesFor (model-driven sweep count)", () => {
  // Port refs the input-source sweep writes over `passes` passes (NONE sentinel
  // excluded) — the physical ports the run actually exercises.
  function sourcePortsCovered(m: ReturnType<typeof getModel>, passes: number): Set<number> {
    const seed = emptyPlan(m.id);
    ensureFixedConnections(m, seed);
    const covered = new Set<number>();
    for (let pass = 0; pass < passes; pass++) {
      for (const c of planToCommands(m, perturbedPlan(m, seed, pass))) {
        if (/^INPUT_SOURCE$|^STEREO_INPUT_SOURCE_[LR]$/.test(c.name) && c.vdValue !== PORT_REF_NONE) {
          covered.add(c.vdValue);
        }
      }
    }
    return covered;
  }
  for (const id of ["URX44V", "URX44", "URX22"] as const) {
    it(`${id}: reaches every selectable input port, at least the enum floor`, () => {
      const m = getModel(id);
      expect(passesFor(m)).toBeGreaterThanOrEqual(PASSES);
      // A full cycle (one pass per input port) is maximal coverage; passesFor must
      // reach the same port set with its computed count — no port left unexercised.
      const full = sourcePortsCovered(m, selectableInputIds(m).length);
      const actual = sourcePortsCovered(m, passesFor(m));
      expect([...actual].sort((a, b) => a - b)).toEqual([...full].sort((a, b) => a - b));
    });
  }

  it("URX44V/44 need more than the enum floor (the gap this closes)", () => {
    // The old fixed count (PASSES) left the trailing input ports (usbsub / hdmi)
    // unreached on these models; passesFor raises it so they are covered.
    expect(passesFor(getModel("URX44V"))).toBeGreaterThan(PASSES);
    expect(passesFor(getModel("URX44"))).toBeGreaterThan(PASSES);
  });
});

describe("runSelfTest", () => {
  it("passes and restores against a faithful device", async () => {
    installMockDevice(populatedPlan());
    const report = await runSelfTest(model, 0);
    expect(report.device).toBe("URX44V");
    expect(report.phase).toBe("done");
    expect(report.passes).toBe(passesFor(model));
    expect(report.residual).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.restored).toBe(true);
    expect(report.written).toBeGreaterThan(0);
    expect(vi.mocked(vdDisconnect)).toHaveBeenCalled();
  });

  // The verdict's residual covers only what the restore SENT, so it cannot answer the
  // question this asks: is the unit holding what it held? Only a full-address comparison
  // asks that — what an external sweep does against hardware, and this is its in-memory
  // form. It was a PIN of an open gap until 2026-08-10; the gap is closed and it is now
  // a set.
  //
  // The gap: with EQ 1-knob ON in the capture, translate.ts authors no band values (the
  // unit drives them), so the restore emitted none of those addresses while the sweep,
  // which flips 1-knob every pass, wrote them on every pass that saw it OFF. A unit
  // found that way ended with its VISIBLE EQ changed under restored: true. The restore
  // now asks for those addresses explicitly (EmitOptions.includeDeviceDriven), which is
  // sound because the unit keeps such a write — measured, not assumed.
  it("leaves the device holding exactly what it held, including the bands the unit drives", async () => {
    // The factory-default plan, not the sparse fixture: this compares EVERY address, and
    // a sparse seed leaves the mock answering 0 for parameters no unit ever holds at 0
    // (a band Q, a gate time). The capture then reads a value outside the plan's own
    // domain and the restore re-encodes it to the nearest legal one — a difference that
    // is the fixture's, not the app's.
    const seed = defaultPlan("URX44V");
    const table = installMockDevice(seed);
    // 1-knob turned on ON THE DEVICE rather than in the seed plan: a unit found that way
    // still holds legal band values (the seed wrote them, because the plan authors bands
    // while 1-knob is off), which is the state the capture then reads.
    for (const nodeId of ["ch1", "ch2"]) {
      const ok = eqOneKnob(model, nodeId, 0);
      if (ok) for (const inst of ok.instances) table.set(`${ok.on}:0:${inst}`, 1);
    }
    // What vdGet answers for an address nothing has written — the mock's own default, so
    // "never written" and "written back to that value" compare equal instead of reading
    // as a change the run did not make.
    const valueAt = (t: Map<string, number>, k: string): number =>
      t.has(k) ? t.get(k)! : PORT_REF_PARAMS.has(Number(k.split(":")[0])) ? PORT_REF_NONE : 0;
    const before = new Map(table);

    const report = await runSelfTest(model, 0);

    expect(report.aborted).toBe(false);
    expect(report.restored).toBe(true);
    const moved = [...new Set([...before.keys(), ...table.keys()])]
      .filter((k) => valueAt(before, k) !== valueAt(table, k))
      .map((k) => `${k}: ${valueAt(before, k)} -> ${valueAt(table, k)}`);
    expect(moved).toEqual([]);
  });

  // A unit found with EQ 1-knob on: the state the three cases below are about, and the
  // one no run reached until it was staged deliberately. 1-knob goes on ON THE DEVICE
  // rather than in the seed plan, so the bands still hold legal values for the capture
  // to read (the plan authors them while 1-knob is off).
  function seedWithOneKnobOn(): Map<string, number> {
    const table = installMockDevice(defaultPlan("URX44V"));
    for (const nodeId of ["ch1", "ch2"]) {
      const ok = eqOneKnob(model, nodeId, 0);
      if (ok) for (const inst of ok.instances) table.set(`${ok.on}:0:${inst}`, 1);
    }
    return table;
  }

  // The pre-sweep read is the only record of what these addresses held — the captured
  // plan has no command for them. If it fails, the run could perturb one and never put
  // it back, so it does not start. Counting it afterwards was the first attempt and is
  // not enough: the unit is left changed and the verdict merely says so.
  it("refuses to sweep at all when an address it could not read first would be perturbed", async () => {
    const table = seedWithOneKnobOn();
    const before = new Map(table);
    const realGet = vi.mocked(vdGet).getMockImplementation()!;
    // SSMCS_EQ_ON (106) is in the union: the sweep writes it in the other COMP/EQ order
    // and the captured plan has no command for it.
    vi.mocked(vdGet).mockImplementation((id, x, y) =>
      id === 106 ? Promise.reject(new Error("read timeout")) : realGet(id, x, y),
    );

    const report = await runSelfTest(model, 0);

    expect(report.errors.some((e) => e.startsWith("refusing to sweep"))).toBe(true);
    // "refused", not "readback": nothing was written, so the caller must not render
    // this as a failed restore ("the device may not be restored") when the device was
    // never touched. `restored` is false here only because there was nothing to restore.
    expect(report.phase).toBe("refused");
    expect(report.ok).toBe(false);
    // The point of refusing: the unit is untouched, not merely reported on.
    expect(report.written).toBe(0);
    expect([...table]).toEqual([...before]);
  });

  // diffPlan leaves a command it could not read OUT of the diff on purpose — never
  // write on a value you did not confirm — which also leaves it out of the residual.
  // Read as a parameter that matched, both verdicts claim a fidelity nobody measured.
  //
  // ⚠️ WHAT THIS PINS, AND WHAT IT DOES NOT. It pins that both phases REPORT the reads
  // they could not make: remove either errors.push and it fails. It does NOT pin that
  // the counts reach the verdict — removing `readFailures` or `restoreResidual +=`
  // leaves it green, because a read failure also ends the converge loop, so the residual
  // is non-empty for other reasons and ok/restored are false either way.
  //
  // Isolating it needs a run where everything else converges and the only thing standing
  // between it and `restored: true` is the read that never happened. Two fixtures were
  // tried and neither produces that: failing the read from the start leaves the first
  // diff incomplete, and failing it once the restore has put the value back also fires
  // during the sweep, because the perturbation flips that value through its captured one
  // on every pass. What would settle it is a parameter the sweep does not touch whose
  // read fails only in the restore — none exists today, since the sweep writes the whole
  // scope.
  it("does not count a parameter it could not read as one that matched", async () => {
    const table = installMockDevice(populatedPlan());
    const realGet = vi.mocked(vdGet).getMockImplementation()!;
    const home = table.get("140:0:0"); // CH_ON as the capture found it
    let writing = false;
    vi.mocked(vdSet).mockImplementation((id, x, y, v) => {
      writing = true;
      table.set(`${id}:${x}:${y}`, v);
      return Promise.resolve();
    });
    vi.mocked(vdGet).mockImplementation((id, x, y) =>
      writing && id === 140 && table.get(`${id}:${x}:${y}`) === home
        ? Promise.reject(new Error("read timeout"))
        : realGet(id, x, y),
    );

    const report = await runSelfTest(model, 0);

    expect(report.errors.some((e) => e.startsWith("restore read: "))).toBe(true);
    expect(report.restored).toBe(false);
  });
  // Every await in the run goes through phaseStep so a cancel is recorded as one. The
  // direct reads and writes added for the write-back are easy to leave outside it, and
  // then an abort escapes runSelfTest entirely and reaches the operator as an ERROR
  // dialog rather than "cancelled".
  it("reports a cancel during the pre-sweep read as a cancel, not as a thrown error", async () => {
    seedWithOneKnobOn();
    const controller = new AbortController();
    const realGet = vi.mocked(vdGet).getMockImplementation()!;
    // Abort on the first read the pre-sweep loop issues (106 is only ever read there —
    // the captured plan has no command for it, so no other phase asks).
    vi.mocked(vdGet).mockImplementation((id, x, y) => {
      if (id === 106) controller.abort();
      return realGet(id, x, y);
    });

    const report = await runSelfTest(model, 0, controller.signal);

    expect(report.aborted).toBe(true);
    expect(report.phase).toBe("readback");
  });

  // bandsAfterRestore exists for the 1-knob-ON case, and asking planToCommands with the
  // default emit omits exactly those bands — so the field would report "nothing wrong"
  // by inspecting nothing. A device that refuses the band write is what makes the
  // difference visible.
  it("inspects the bands under 1-knob after the restore, not an empty set", async () => {
    const table = seedWithOneKnobOn();
    // The address the app RESOLVES for ch1, not the catalogue anchor: PARAMS holds the
    // mono anchor id, and the per-node block is resolved from it.
    const eq = inputEq(model, "ch1", 0)!;
    const gain = eq.bands[0].gain;
    // A device that takes every write EXCEPT the one that would put this band back. A
    // plain "ignore all writes" mock cannot show anything: the restore writes the
    // captured value, so an address that never moved already agrees with it. What
    // bandsAfterRestore exists to catch is the unit refusing to come home.
    const home = table.get(`${gain}:0:0`);
    vi.mocked(vdSet).mockImplementation((id, x, y, v) => {
      if (id === gain && y === 0 && v === home) return Promise.resolve();
      table.set(`${id}:${x}:${y}`, v);
      return Promise.resolve();
    });

    const report = await runSelfTest(model, 0);

    expect(report.diag.bandsAfterRestore.map((b) => b.addr)).toContain(`${gain}:0:0`);
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

  // URX44V has no unverified mappings, so the per-guess verdicts guard nothing here:
  // every address a stopped pass left behind goes to the report's "Other device
  // divergence (confirmed params)" section and prints as "wrote X, read Y". Those params
  // were never written and never re-read, so one refused write read as the unit
  // disagreeing about hundreds of them — a fidelity finding the run never made.
  it("does not report the diff a stopped pass was midway through as device divergence", async () => {
    const table = installMockDevice(populatedPlan());
    const faderId = PARAMS.CH_FADER.id;
    vi.mocked(vdSet).mockImplementation((id, x, y, v) => {
      if (id === faderId) return Promise.reject(new Error("device busy"));
      table.set(`${id}:${x}:${y}`, v);
      return Promise.resolve();
    });

    const report = await runSelfTest(model, 0);

    // Premise: this model has no guess verdicts, and the run did leave a residual.
    expect(report.unverified).toEqual([]);
    expect(report.residual.length).toBeGreaterThan(0);
    expect(report.ok).toBe(false);
    // Every sweep-pass entry is marked as one the run never got to compare…
    expect(report.residual.filter((m) => m.pass >= 0 && !m.stoppedOn)).toEqual([]);
    // …and the report says so under its own heading instead of as a finding.
    const md = formatSelfTestReport(report);
    expect(md).toContain("## Not compared");
    expect(md).toContain("device was not asked about them");
    expect(md).not.toContain("## Other device divergence");
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
    // As in installMockDevice: without this the name read answers undefined and every
    // URX22 case runs with a channel-name error per channel in its report.
    vi.mocked(vdGetStr).mockResolvedValue("");
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

  // CONFIRMED is a promotion: it is how a guessed device mapping stops being a guess,
  // and `translate.ts` carries those guesses precisely so nothing writes a speculative
  // address as though it were verified. A read failure keeps the command out of the diff
  // (diffPlan) and so out of the residual — which reads as "no mismatch" and confirmed
  // the guess without a single round trip having been checked.
  it("does not confirm a guess whose addresses it could not read", async () => {
    const table = installMock22(seed22());
    const realGet = vi.mocked(vdGet).getMockImplementation()!;
    // One address of the hi-Z guess. Failing only once writing has started keeps it in
    // the captured plan (a read that fails during the capture leaves the parameter out
    // of the plan entirely, so nothing would diff it and the case would be absent).
    const hiZ = [...unverifiedAddresses(m22)].find(([, key]) => key === "hiz-channel");
    expect(hiZ).toBeDefined();
    const [addrKey] = hiZ!;
    const paramId = Number(addrKey.split(":")[0]);
    let writing = false;
    vi.mocked(vdSet).mockImplementation((id, x, y, v) => {
      writing = true;
      table.set(`${id}:${x}:${y}`, v);
      return Promise.resolve();
    });
    vi.mocked(vdGet).mockImplementation((id, x, y) =>
      writing && id === paramId ? Promise.reject(new Error("read timeout")) : realGet(id, x, y),
    );

    const report = await runSelfTest(m22, 0);

    const hiz = report.unverified.find((u) => u.key === "hiz-channel")!;
    expect(hiz.outcome).toBe("unread");
    expect(hiz.mismatches).toEqual([]);
    // And nothing else is refuted either. A read failure stops sendConverging early, so
    // the residual it leaves on OTHER guesses is evidence that the run stopped rather
    // than evidence about the device — in this fixture one unreadable address left
    // `input-ports` holding 14 of them.
    // REFUTED is a claim about the DEVICE and needs its own evidence. Asserting the
    // outcome is what holds that: asserting only `mismatches` left the tally free to
    // count this as a refutation, which is what it did.
    // Named, not just counted: `input-ports` is the guess holding those 14, and the
    // failure it must not fall into is the other direction as well — a divergence with no
    // complete pass behind it is not a refutation, and it is not a confirmation either.
    expect(report.unverified.find((u) => u.key === "input-ports")!.outcome).toBe("unread");
    const verdicts = summarizeVerdicts(report.unverified);
    expect(verdicts.refuted).toBe(0);
    expect(verdicts.untestable).toBeGreaterThan(0);
    expect(formatSelfTestReport(report)).not.toContain("REFUTED");
    // Per address, not a blanket downgrade: the readable guesses still confirm.
    expect(verdicts.confirmed).toBeGreaterThan(0);
  });

  // The other half of the same rule. Withholding REFUTED until the evidence is complete
  // is right; withdrawing one that WAS complete is not, and a run-wide "did any read
  // fail" cannot tell the two apart — it retracts a pass-0 refutation because pass 4
  // failed to read something else entirely. The evidence is per pass: a pass that read
  // every address and still watched one refuse to take the value has settled the guess.
  it("keeps a refutation a complete pass established when a later pass fails to read", async () => {
    const table = installMock22(seed22());
    const realGet = vi.mocked(vdGet).getMockImplementation()!;
    const addr = (c: { paramId: number; x: number; y: number }): string => `${c.paramId}:${c.x}:${c.y}`;
    // The guess that gets refuted, and the unrelated one that goes unreadable. Both ids
    // come from the mapping table, not from a literal: `stereo-block` addresses CH_FADER
    // at a block id of its own, which is the whole content of that guess.
    const inputSourceId = PARAMS.INPUT_SOURCE.id;
    const stereo = [...unverifiedAddresses(m22)].find(([, key]) => key === "stereo-block");
    expect(stereo).toBeDefined();
    const stereoId = Number(stereo![0].split(":")[0]);
    // Pass 1 is told apart from pass 0 by a command the sweep itself moves between them,
    // read out of `perturbedPlan` rather than hard-coded, so the marker cannot drift away
    // from the sweep it is marking.
    const pass0 = new Map(planToCommands(m22, perturbedPlan(m22, seed22(), 0)).map((c) => [addr(c), c.vdValue]));
    const marker = planToCommands(m22, perturbedPlan(m22, seed22(), 1)).find(
      (c) =>
        pass0.has(addr(c)) && pass0.get(addr(c)) !== c.vdValue && c.paramId !== inputSourceId && c.paramId !== stereoId,
    );
    expect(marker).toBeDefined();

    let pastPass0 = false;
    // INPUT_SOURCE is accepted and never stored, so `input-ports` diverges in every pass —
    // including pass 0, which reads cleanly.
    vi.mocked(vdSet).mockImplementation((id, x, y, v) => {
      if (id !== inputSourceId) table.set(`${id}:${x}:${y}`, v);
      if (id === marker!.paramId && x === marker!.x && y === marker!.y && v === marker!.vdValue) pastPass0 = true;
      return Promise.resolve();
    });
    // …and from pass 1 on, an address of a DIFFERENT guess stops being readable.
    vi.mocked(vdGet).mockImplementation((id, x, y) =>
      pastPass0 && id === stereoId ? Promise.reject(new Error("read timeout")) : realGet(id, x, y),
    );

    const report = await runSelfTest(m22, 0);

    // The fixture's own premise, asserted rather than assumed: pass 0 read everything and
    // a later pass did not. Without this the case could pass while testing nothing.
    expect(report.errors.some((e) => e.startsWith("p0 read:"))).toBe(false);
    expect(report.errors.some((e) => /^p[1-9]\d* read:/.test(e))).toBe(true);

    expect(report.unverified.find((u) => u.key === "input-ports")!.outcome).toBe("refuted");
    expect(report.unverified.find((u) => u.key === "stereo-block")!.outcome).toBe("unread");
    expect(summarizeVerdicts(report.unverified).refuted).toBe(1);
    expect(formatSelfTestReport(report)).toContain("REFUTED");
  });

  // The write side of the same rule, and the sharper half of it. sendConverging leaves
  // the round loop on a refused write WITHOUT re-reading, so what it hands back is the
  // diff it was ABOUT TO send — every address the pass meant to change. Publishing that
  // as divergence refutes a guess on the strength of a write that never happened, which
  // is the one thing REFUTED must never mean.
  it("does not refute anything from a pass whose write the device refused", async () => {
    const table = installMock22(seed22());
    const stereo = [...unverifiedAddresses(m22)].find(([, key]) => key === "stereo-block");
    expect(stereo).toBeDefined();
    const stereoId = Number(stereo![0].split(":")[0]);
    // One address the device refuses outright. It never stores, so it is in every round's
    // diff, so every pass stops on it — no pass ever completes.
    vi.mocked(vdSet).mockImplementation((id, x, y, v) => {
      if (id === stereoId) return Promise.reject(new Error("device busy"));
      table.set(`${id}:${x}:${y}`, v);
      return Promise.resolve();
    });

    const report = await runSelfTest(m22, 0);

    // The fixture's premise: there IS a residual and the write DID fail. Without both,
    // "nothing was refuted" would be true for the uninteresting reason.
    expect(report.residual.length).toBeGreaterThan(0);
    expect(report.errors.some((e) => e.startsWith("p0 ") && e.endsWith("device busy"))).toBe(true);
    expect(report.ok).toBe(false);
    // Not one of those residual lines is published as a claim about the device.
    expect(summarizeVerdicts(report.unverified).refuted).toBe(0);
    expect(report.unverified.every((u) => u.outcome !== "refuted")).toBe(true);
    const md = formatSelfTestReport(report);
    expect(md).not.toContain("REFUTED");
    // …and the verdict names the cause the Issues list names. A refused write reported as
    // "a read failed" contradicts the errors printed a few lines below it.
    expect(report.unverified.some((u) => u.outcome === "unsent")).toBe(true);
    expect(report.unverified.some((u) => u.outcome === "unread")).toBe(false);
    expect(md).toContain("refused a write");
    expect(md).not.toContain("a read failed");
    // A run cannot have written more commands than it handed to the device. `written`
    // counted the ones the refusal skipped, so the same report said "N commands written"
    // and "M command(s) never sent".
    expect(report.written).toBeLessThanOrEqual(vi.mocked(vdSet).mock.calls.length);
    // The trace stops calling the whole round "sent" when part of it never went.
    expect(md).toContain("Issued, in order");
    // The residual carries how its pass ended, which is what keeps the ordinary params —
    // the ones no guess verdict covers — out of the findings section.
    expect(report.residual.every((m) => m.stoppedOn === "write")).toBe(true);
    expect(md).not.toContain("## Other device divergence");
    // And the report says the write stopped: the refusal by name, and what it cut short
    // as a count rather than one undefined-message line per command.
    expect(report.errors.some((e) => /^p0 \d+ command\(s\) never sent/.test(e))).toBe(true);
    expect(report.errors.some((e) => e.includes("undefined"))).toBe(false);
    // Not asserted here: the restore. Every write to that address failed, so the unit
    // still holds the captured value and the restore correctly has nothing to send —
    // which is why the refused RESTORE needs a fixture of its own, below.
  });

  // `restored: false` with a residual count reads as a unit that would not keep the
  // values. A refused write is the opposite — the values never reached it — and the two
  // want different responses from whoever reads the report, so the run has to say which.
  it("says the restore's write was refused, not just that params differ", async () => {
    const table = installMock22(seed22());
    // Refused only for the value the RESTORE writes. The sweep floors every fader, so the
    // captured value is one the sweep never sends: rejecting it cannot fire during a pass,
    // which is what makes this a fixture about the restore rather than about the sweep.
    const faderId = PARAMS.CH_FADER.id;
    const captured = table.get(`${faderId}:0:0`);
    expect(captured).toBeDefined();
    expect(captured).not.toBe(VD_LEVEL_OFF);
    vi.mocked(vdSet).mockImplementation((id, x, y, v) => {
      if (id === faderId && v === captured) return Promise.reject(new Error("device busy"));
      table.set(`${id}:${x}:${y}`, v);
      return Promise.resolve();
    });

    const report = await runSelfTest(m22, 0);

    // Premise: the sweep itself ran clean, so everything below is the restore's.
    expect(report.errors.some((e) => e.startsWith("p"))).toBe(false);
    expect(report.residual.every((m) => m.pass === -1)).toBe(true);
    expect(report.restored).toBe(false);
    expect(report.errors.some((e) => e.startsWith("restore ") && e.endsWith("device busy"))).toBe(true);
    // This line comes only from the converging write — restoreUnsent reports its own
    // failures by address, so it cannot be the one satisfying the assertion above.
    expect(report.errors.some((e) => /^restore \d+ command\(s\) never sent/.test(e))).toBe(true);
  });

  it("confirms every unverified guess on a faithful device (no collisions)", async () => {
    installMock22(seed22());
    const report = await runSelfTest(m22, 0);
    expect(report.device).toBe("URX22");
    expect(report.collisions).toEqual([]);
    expect(report.unverified.map((u) => u.key).sort()).toEqual(
      ["dgain-urx22", "ducker-block", "hiz-channel", "input-ports", "stereo-block"].sort(),
    );
    for (const u of report.unverified) {
      expect(u.outcome).not.toBe("collision");
      // A round trip confirms every guess on a faithful device — including
      // `ducker-block`, which is exactly why the report is not the whole story for it:
      // that guess is about which PAIR a y addresses, and writing y then reading y back
      // passes whichever pair it is. Its entry exists to keep the guess visible in the
      // report, and PLAN.md's D-1 carries the LCD check that actually settles it.
      expect(u.outcome).toBe("confirmed");
    }
    expect(report.restored).toBe(true);
    // The exported report leads with the per-guess verdicts.
    const md = formatSelfTestReport(report);
    expect(md).toContain("# URX self-test report — URX22");
    expect(md).toContain("CONFIRMED");
  });
});
