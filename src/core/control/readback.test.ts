import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../../models";
import { emptyPlan, ensureFixedConnections, type Plan, type PlanConnection } from "../plan";
import { ref } from "../../models/types";

// readback.ts pulls live values through platform.vdGet, so mock that module: the
// rest of platform.ts (file IO, dialogs) is untouched here.
vi.mock("../platform", () => ({ vdGet: vi.fn() }));

import { vdGet } from "../platform";
import { applyDeviceState } from "./readback";
import { planToCommands } from "./translate";

const model = getModel("URX44V");

// param_ids whose encoding is a port-ref. An address the emit pass never wrote
// must read back as the broker's "nothing selected" sentinel (0xffffffff), so
// the readback decodes it to null and leaves/clears the wire instead of decoding
// raw 0 into a real port (which would wrongly fabricate a routing wire).
const PORT_REF_NONE = 0xffffffff;
const PORT_REF_PARAMS = new Set([22, 259, 705, 706, 719, 720, 730, 731, 732, 733, 734, 735]);

// Build the device's "current state" table from what emit would write for a plan,
// so vdGet returns exactly the values planToCommands produced. This is the heart
// of the emit↔readback round-trip: any address emit did not set falls back to a
// neutral default (0, or the none sentinel for port-refs).
function deviceTableFor(plan: Plan): Map<string, number> {
  const table = new Map<string, number>();
  for (const cmd of planToCommands(model, plan)) table.set(`${cmd.paramId}:${cmd.x}:${cmd.y}`, cmd.vdValue);
  return table;
}

function mockVdGetFrom(table: Map<string, number>): void {
  vi.mocked(vdGet).mockImplementation((paramId: number, x: number, y: number) => {
    const hit = table.get(`${paramId}:${x}:${y}`);
    if (hit !== undefined) return Promise.resolve(hit);
    return Promise.resolve(PORT_REF_PARAMS.has(paramId) ? PORT_REF_NONE : 0);
  });
}

// Compare the wires that survive a round trip, ignoring iteration order. Fixed
// bus→STEREO FX returns carry a -∞ default emit/readback do not touch, so compare
// on (from,to,kind) plus the params the readback actually reconstructs.
function wireKey(c: PlanConnection): string {
  const p = c.params ?? {};
  // An unedited fader/pan (undefined) means unity/center; readback always
  // materializes those as 0/0 off the device, so coalesce for an apples-to-apples
  // comparison rather than flagging a representation difference as drift.
  return [c.from, c.to, c.kind, p.level ?? 0, p.pan ?? 0, p.tap, p.oscL, p.oscR].join("|");
}

beforeEach(() => {
  vi.mocked(vdGet).mockReset();
});

describe("applyDeviceState round-trip", () => {
  // A representative plan touching every readback group: channel strip, sends,
  // bus faders/EQ, insert FX, ducker, master/monitor, OSC + assign, and routing.
  function richPlan(): Plan {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);

    // Channel main path level/pan on the fixed CH→STEREO send.
    const ch1Stereo = plan.connections.find((c) => c.from === "ch1:out" && c.to === "bus.stereo:in");
    // Use pan extremes that survive the ±63 device quantization exactly.
    ch1Stereo!.params = { level: -6, pan: 63 };

    // Mono channel strip (CH1): on/gain/hpf/mic-strip/phase/comp-eq + GATE/COMP/EQ.
    plan.nodeParams.ch1 = {
      on: false,
      gain: -8,
      hpf: true,
      hpfFreq: 120,
      phantom: true,
      clipSafe: true,
      phase: true,
      compEqType: 0,
      gateOn: true,
      compOn: true,
      eqOn: true,
      gate: { threshold: -40, range: -30, attack: 10, hold: 12, decay: 100 },
      comp: { threshold: -30, ratio: 4, gain: 6, attack: 20, release: 200 },
      eqBands: [
        { on: true, freq: 100, q: 1, gain: 3 },
        { on: false, freq: 1000, q: 2, gain: -3 },
        { on: true, freq: 3000, q: 0.7, gain: 1 },
        { on: true, freq: 8000, q: 1.5, gain: -2 },
      ],
    };

    // Stereo channel (CH5/6): D.Gain + independent L/R phase.
    plan.nodeParams.ch_5_6 = { gain: -12, phaseL: true, phaseR: false };

    // CH1 → MIX1 send (level/pan/PRE tap) and CH1 → FX1 send (level only).
    plan.connections.push({
      from: "ch1:out",
      to: "bus.mix1:in",
      kind: "send",
      params: { level: -3, pan: -63, tap: "pre" },
    });
    plan.connections.push({ from: "ch1:out", to: "bus.fx1:in", kind: "send", params: { level: -9 } });

    // Bus faders / EQ / insert FX.
    plan.nodeParams["bus.stereo"] = { on: true, level: 2, eqOn: true, insertFx: 1793 };
    plan.nodeParams["bus.mix1"] = { level: -4, insertFx: 1792 };

    // Ducker on + detail (out.ducker1 → ch_5_6, stereo index 0).
    plan.nodeParams["out.ducker1"] = {
      duckerOn: true,
      ducker: { threshold: -50, range: -20, attack: 25, decay: 1500 },
    };

    // Monitor buses + oscillator generator.
    plan.nodeParams["bus.mon1"] = { level: -10, cueInterrupt: true, mono: true };
    plan.nodeParams["bus.mon2"] = { level: -20, cueInterrupt: false, mono: false };
    plan.nodeParams["bus.osc"] = { osc: { on: true, level: -12, mode: 0, freq: 1000 } };

    // OSC → STEREO assign (L/R on).
    plan.connections.push({ from: "bus.osc:out", to: "bus.stereo:in", kind: "sendSwitch", params: { oscL: true, oscR: true } });

    // Routing selectors: streaming source + monitor1 source from a MIX bus; an
    // input source on CH2; an output patch on out.main.
    plan.connections.push({ from: "bus.mix1:out", to: "bus.stream:in", kind: "source" });
    plan.connections.push({ from: "bus.mix2:out", to: "bus.mon1:in", kind: "source" });
    plan.connections.push({ from: "in.aux:out", to: "ch2:in", kind: "source" });
    plan.connections.push({ from: "bus.stereo:out", to: "out.main:in", kind: "patch" });

    return plan;
  }

  it("reconstructs the plan's node params from the device's emitted state", async () => {
    const source = richPlan();
    mockVdGetFrom(deviceTableFor(source));

    // Start from a blank plan and let readback rebuild it from the device.
    const target = emptyPlan("URX44V");
    const result = await applyDeviceState(model, target);

    expect(result.errors).toEqual([]);

    // Channel strip values decoded back to plan units.
    expect(target.nodeParams.ch1.on).toBe(false);
    expect(target.nodeParams.ch1.gain).toBe(-8);
    expect(target.nodeParams.ch1.hpf).toBe(true);
    expect(target.nodeParams.ch1.hpfFreq).toBe(120);
    expect(target.nodeParams.ch1.phantom).toBe(true);
    expect(target.nodeParams.ch1.clipSafe).toBe(true);
    expect(target.nodeParams.ch1.phase).toBe(true);
    expect(target.nodeParams.ch1.gateOn).toBe(true);
    expect(target.nodeParams.ch1.compOn).toBe(true);
    expect(target.nodeParams.ch1.eqOn).toBe(true);
    expect(target.nodeParams.ch1.gate).toMatchObject({ threshold: -40, range: -30, decay: 100 });
    expect(target.nodeParams.ch1.comp).toMatchObject({ threshold: -30, ratio: 4, gain: 6 });
    expect(target.nodeParams.ch1.eqBands?.[0]).toMatchObject({ on: true, gain: 3 });

    // Stereo channel D.Gain + L/R phase.
    expect(target.nodeParams.ch_5_6.gain).toBe(-12);
    expect(target.nodeParams.ch_5_6.phaseL).toBe(true);
    expect(target.nodeParams.ch_5_6.phaseR).toBe(false);

    // Bus faders / EQ / insert FX / master on.
    expect(target.nodeParams["bus.stereo"].level).toBe(2);
    expect(target.nodeParams["bus.stereo"].eqOn).toBe(true);
    expect(target.nodeParams["bus.stereo"].insertFx).toBe(1793);
    expect(target.nodeParams["bus.stereo"].on).toBe(true);
    expect(target.nodeParams["bus.mix1"].level).toBe(-4);
    expect(target.nodeParams["bus.mix1"].insertFx).toBe(1792);

    // Ducker.
    expect(target.nodeParams["out.ducker1"].duckerOn).toBe(true);
    expect(target.nodeParams["out.ducker1"].ducker).toMatchObject({ threshold: -50, range: -20 });

    // Monitor + oscillator.
    expect(target.nodeParams["bus.mon1"]).toMatchObject({ level: -10, cueInterrupt: true, mono: true });
    expect(target.nodeParams["bus.mon2"]).toMatchObject({ cueInterrupt: false, mono: false });
    expect(target.nodeParams["bus.osc"].osc).toMatchObject({ on: true, mode: 0, freq: 1000 });
  });

  it("round-trips a SSMCS-mode channel's raw detail values", async () => {
    const source = emptyPlan("URX44V");
    ensureFixedConnections(model, source);
    source.nodeParams.ch1 = {
      compEqType: 1,
      compOn: true,
      eqOn: true,
      ssmcs: {
        on: true,
        compDrive: 100,
        morphing: 16,
        outGain: 243,
        comp: { attack: 170, release: 159, ratio: 60, knee: 2, threshold: 100, makeup: 70 },
        sc: { on: true, q: 12, freq: 30, gain: 133 },
        eq: {
          low: { on: true, freq: 32, gain: 180 },
          mid: { on: true, q: 12, freq: 72, gain: 243 },
          high: { on: true, freq: 112, gain: 180 },
        },
      },
    };
    mockVdGetFrom(deviceTableFor(source));

    const target = emptyPlan("URX44V");
    const result = await applyDeviceState(model, target);
    expect(result.errors).toEqual([]);

    const s = target.nodeParams.ch1.ssmcs!;
    expect(target.nodeParams.ch1.compEqType).toBe(1);
    expect(s.on).toBe(true);
    expect(s.compDrive).toBe(100);
    expect(s.morphing).toBe(16);
    expect(s.outGain).toBe(243);
    expect(s.comp).toMatchObject({ attack: 170, release: 159, ratio: 60, knee: 2, threshold: 100, makeup: 70 });
    expect(s.sc).toMatchObject({ on: true, q: 12, freq: 30, gain: 133 });
    expect(s.eq?.mid).toMatchObject({ on: true, q: 12, freq: 72, gain: 243 });
    expect(s.eq?.low?.q).toBeUndefined();
    expect(s.eq?.high?.q).toBeUndefined();
    // The 4-band PEQ is not present in SSMCS mode.
    expect(target.nodeParams.ch1.eqBands).toBeUndefined();
  });

  it("reconstructs the same wire set (sends, OSC assign, routing) as the source plan", async () => {
    const source = richPlan();
    mockVdGetFrom(deviceTableFor(source));

    const target = emptyPlan("URX44V");
    await applyDeviceState(model, target);

    const sourceKeys = source.connections.map(wireKey).sort();
    const targetKeys = target.connections.map(wireKey).sort();
    expect(targetKeys).toEqual(sourceKeys);
  });

  it("round-trips the channel main fader/pan onto the fixed STEREO send", async () => {
    const source = richPlan();
    mockVdGetFrom(deviceTableFor(source));

    const target = emptyPlan("URX44V");
    await applyDeviceState(model, target);

    const conn = target.connections.find((c) => c.from === "ch1:out" && c.to === "bus.stereo:in");
    expect(conn!.params).toMatchObject({ level: -6, pan: 63 });
  });

  it("counts applied groups across every section, not just channels", async () => {
    // All-default device (every read returns 0 / none): only the groups that are
    // unconditionally read still increment `applied`. Confirms the count spans
    // sends, bus faders, EQ, duckers, master, monitors, OSC and selectors, not
    // only the channel-strip pass.
    mockVdGetFrom(new Map());
    const target = emptyPlan("URX44V");
    const result = await applyDeviceState(model, target);

    expect(result.errors).toEqual([]);
    // Sum of every unconditionally-read group on URX44V. Each constant below
    // names its group so a count change is traceable to a specific readback pass.
    const channels = 8;
    const sends = 8 * 4;
    const busFaders = 3; // STEREO + MIX1 + MIX2
    const insertFx = 3 + 4; // STEREO + 2 MIX outputs + 4 mono channels
    const busEqOn = 3; // STEREO + MIX1 + MIX2
    const busEqBands = 3; // STEREO + MIX1 + MIX2
    const duckers = 4;
    const master = 1;
    const monitors = 2;
    const osc = 1;
    const oscAssign = 5;
    const inputSource = 8;
    const selectors = 9;
    const expected =
      channels + sends + busFaders + insertFx + busEqOn + busEqBands + duckers + master + monitors + osc + oscAssign + inputSource + selectors;
    expect(result.applied).toBe(expected);
    // Sanity: far more than the channel-only count, proving every group counts.
    expect(result.applied).toBeGreaterThan(channels);
  });

  it("records an unknown ducker key source without clearing the existing wire", async () => {
    const target = emptyPlan("URX44V");
    ensureFixedConnections(model, target);
    // Seed an existing ducker key wire that readback must preserve.
    target.connections.push({ from: "ch1:out", to: "out.ducker1:in", kind: "key" });

    // DUCKER_SRC (259) reads back a non-none port value that maps to no node.
    const UNKNOWN_PORT = 9999;
    mockVdGetFrom(new Map([["259:0:0", UNKNOWN_PORT]]));

    const result = await applyDeviceState(model, target);

    const wire = target.connections.find((c) => c.to === ref("out.ducker1", "in") && c.kind === "key");
    expect(wire).toBeDefined();
    expect(wire!.from).toBe("ch1:out");
    expect(result.errors.some((e) => e.includes(`unknown source port ${UNKNOWN_PORT}`))).toBe(true);
  });

  it("records an unknown input/routing source port without clearing its wire", async () => {
    const target = emptyPlan("URX44V");
    ensureFixedConnections(model, target);
    // Existing input-source wire on CH1 and a streaming-source wire to preserve.
    target.connections.push({ from: "in.aux:out", to: "ch1:in", kind: "source" });
    target.connections.push({ from: "bus.mix1:out", to: "bus.stream:in", kind: "source" });

    const UNKNOWN_PORT = 8888;
    mockVdGetFrom(
      new Map([
        ["22:0:0", UNKNOWN_PORT], // INPUT_SOURCE at CH1 slot 0
        ["705:0:0", 0x80000000 | UNKNOWN_PORT], // STREAM_SRC_L tagged, unknown port
      ]),
    );

    const result = await applyDeviceState(model, target);

    expect(target.connections.some((c) => c.to === ref("ch1", "in") && c.kind === "source")).toBe(true);
    expect(target.connections.some((c) => c.to === ref("bus.stream", "in") && c.kind === "source")).toBe(true);
    expect(result.errors.filter((e) => e.includes("unknown source port")).length).toBeGreaterThanOrEqual(2);
  });

  it("removes an existing send wire when the device reports the send OFF", async () => {
    const target = emptyPlan("URX44V");
    ensureFixedConnections(model, target);
    // Pre-existing CH1 → MIX1 send the device now reports as off (all reads 0,
    // so SEND_ON decodes false → the readback splices the wire out).
    target.connections.push({ from: "ch1:out", to: "bus.mix1:in", kind: "send", params: { level: -3 } });

    mockVdGetFrom(new Map());
    const result = await applyDeviceState(model, target);

    expect(result.errors).toEqual([]);
    expect(target.connections.some((c) => c.from === "ch1:out" && c.to === "bus.mix1:in")).toBe(false);
  });

  it("clears a routing-selector wire when the device reports NONE", async () => {
    const target = emptyPlan("URX44V");
    ensureFixedConnections(model, target);
    // Pre-existing streaming source the device now reports as nothing selected
    // (default none sentinel from the empty table) → readback clears the wire.
    target.connections.push({ from: "bus.mix1:out", to: "bus.stream:in", kind: "source" });

    mockVdGetFrom(new Map());
    const result = await applyDeviceState(model, target);

    expect(result.errors).toEqual([]);
    expect(target.connections.some((c) => c.to === ref("bus.stream", "in") && c.kind === "source")).toBe(false);
  });
});

describe("applyDeviceState provenance (unreadNodes)", () => {
  // Reuse the round-trip plan so readback walks every group; redeclared here so
  // this block is self-contained (the round-trip describe owns its own copy).
  function richPlan(): Plan {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    const ch1Stereo = plan.connections.find((c) => c.from === "ch1:out" && c.to === "bus.stereo:in");
    ch1Stereo!.params = { level: -6, pan: 63 };
    plan.nodeParams.ch1 = {
      on: false,
      gain: -8,
      hpf: true,
      hpfFreq: 120,
      phantom: true,
      clipSafe: true,
      phase: true,
      compEqType: 0,
      gateOn: true,
      compOn: true,
      eqOn: true,
      gate: { threshold: -40, range: -30, attack: 10, hold: 12, decay: 100 },
      comp: { threshold: -30, ratio: 4, gain: 6, attack: 20, release: 200 },
      eqBands: [
        { on: true, freq: 100, q: 1, gain: 3 },
        { on: false, freq: 1000, q: 2, gain: -3 },
        { on: true, freq: 3000, q: 0.7, gain: 1 },
        { on: true, freq: 8000, q: 1.5, gain: -2 },
      ],
    };
    plan.nodeParams.ch_5_6 = { gain: -12, phaseL: true, phaseR: false };
    plan.connections.push({ from: "ch1:out", to: "bus.mix1:in", kind: "send", params: { level: -3, pan: -63, tap: "pre" } });
    plan.connections.push({ from: "ch1:out", to: "bus.fx1:in", kind: "send", params: { level: -9 } });
    plan.nodeParams["bus.stereo"] = { on: true, level: 2, eqOn: true, insertFx: 1793 };
    plan.nodeParams["bus.mix1"] = { level: -4, insertFx: 1792 };
    plan.nodeParams["out.ducker1"] = { duckerOn: true, ducker: { threshold: -50, range: -20, attack: 25, decay: 1500 } };
    plan.nodeParams["bus.mon1"] = { level: -10, cueInterrupt: true, mono: true };
    plan.nodeParams["bus.mon2"] = { level: -20, cueInterrupt: false, mono: false };
    plan.nodeParams["bus.osc"] = { osc: { on: true, level: -12, mode: 0, freq: 1000 } };
    plan.connections.push({ from: "bus.osc:out", to: "bus.stereo:in", kind: "sendSwitch", params: { oscL: true, oscR: true } });
    plan.connections.push({ from: "bus.mix1:out", to: "bus.stream:in", kind: "source" });
    plan.connections.push({ from: "bus.mix2:out", to: "bus.mon1:in", kind: "source" });
    plan.connections.push({ from: "in.aux:out", to: "ch2:in", kind: "source" });
    plan.connections.push({ from: "bus.stereo:out", to: "out.main:in", kind: "patch" });
    return plan;
  }

  // Param ids that gate a body group's try block (its first read). Rejecting one
  // throws the whole group for that node, so the node lands in unreadNodes.
  const DUCKER_ON = 258;
  const CH_FADER_MONO = 139; // first read of the mono channel-strip body group

  it("leaves unreadNodes empty when every body read succeeds", async () => {
    mockVdGetFrom(deviceTableFor(richPlan()));
    const target = emptyPlan("URX44V");
    const result = await applyDeviceState(model, target);

    expect(result.errors).toEqual([]);
    // A full success means nothing is flagged as not read.
    expect(result.unreadNodes.size).toBe(0);
  });

  it("never flags input nodes or out.sdrec — they hold no body parameters", async () => {
    // Force every body group to throw (reject all reads): only attempted body
    // nodes may appear, so the never-attempted input/sdrec nodes must stay out.
    vi.mocked(vdGet).mockImplementation(() => Promise.reject(new Error("read timeout")));
    const target = emptyPlan("URX44V");
    const result = await applyDeviceState(model, target);

    for (const node of model.nodes) {
      if (node.kind === "input" || node.id === "out.sdrec") {
        expect(result.unreadNodes.has(node.id)).toBe(false);
      }
    }
  });

  it("adds a node to unreadNodes when its body group throws, but not the others", async () => {
    // Fail the ducker group for every ducker by rejecting DUCKER_ON (its first
    // read): the try aborts, so each ducker node lands in unreadNodes.
    vi.mocked(vdGet).mockImplementation((paramId: number, _x: number, _y: number) => {
      if (paramId === DUCKER_ON) return Promise.reject(new Error("read timeout"));
      const table = deviceTableFor(richPlan());
      const hit = table.get(`${paramId}:${_x}:${_y}`);
      if (hit !== undefined) return Promise.resolve(hit);
      return Promise.resolve(PORT_REF_PARAMS.has(paramId) ? PORT_REF_NONE : 0);
    });

    const target = emptyPlan("URX44V");
    const result = await applyDeviceState(model, target);

    // (a) Every ducker node is flagged — the throwing group recorded each.
    for (const d of ["out.ducker1", "out.ducker2", "out.ducker3", "out.ducker4"]) {
      expect(result.unreadNodes.has(d)).toBe(true);
    }
    // (b) An error entry is recorded per failed ducker group.
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
    expect(result.errors.some((e) => e.includes("read timeout"))).toBe(true);
    // (c) Nodes whose body groups succeeded are not flagged.
    for (const id of ["ch1", "bus.stereo", "bus.mon1", "bus.osc"]) {
      expect(result.unreadNodes.has(id)).toBe(false);
    }
  });

  it("keeps a body-failed channel flagged even when its send wire reads succeed", async () => {
    // Fail only CH1's channel-strip body group (reject its first read at the mono
    // input index y0); let every other read — including CH1's MIX/FX sends —
    // succeed. The successful send must not mask CH1's failed body read.
    vi.mocked(vdGet).mockImplementation((paramId: number, _x: number, y: number) => {
      if (paramId === CH_FADER_MONO && y === 0) return Promise.reject(new Error("read timeout"));
      const table = deviceTableFor(richPlan());
      const hit = table.get(`${paramId}:${_x}:${y}`);
      if (hit !== undefined) return Promise.resolve(hit);
      return Promise.resolve(PORT_REF_PARAMS.has(paramId) ? PORT_REF_NONE : 0);
    });

    const target = emptyPlan("URX44V");
    const result = await applyDeviceState(model, target);

    // CH1's body read failed, so it is flagged despite its sends reading fine.
    expect(result.unreadNodes.has("ch1")).toBe(true);
    expect(result.errors.some((e) => e.includes("read timeout"))).toBe(true);
    // The CH1 → MIX1 / FX1 send wires the device reports ON are still present.
    expect(target.connections.some((c) => c.from === "ch1:out" && c.to === "bus.mix1:in")).toBe(true);
    expect(target.connections.some((c) => c.from === "ch1:out" && c.to === "bus.fx1:in")).toBe(true);
    // Other channels' bodies read fine, so they are not flagged.
    expect(result.unreadNodes.has("ch2")).toBe(false);
  });
});
