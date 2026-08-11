import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../../models";
import { emptyPlan, ensureFixedConnections, type Plan, type PlanConnection } from "../plan";
import { ref } from "../../models/types";

// readback.ts pulls live values through platform.vdGet, so mock that module: the
// rest of platform.ts (file IO, dialogs) is untouched here.
vi.mock("../platform", () => ({ vdGet: vi.fn(), vdGetStr: vi.fn() }));

import { vdGet, vdGetStr } from "../platform";
import { COLOR_PALETTE, PORT_REF_PARAM_IDS as PORT_REF_PARAMS } from "./params";
import { applyDeviceState, formatReadbackReport } from "./readback";
import { WIRE_SEP } from "../plan-history";
import { SETTLE_TIMEOUT_MS, writeSettle } from "./settle";
import type { PendingWrites } from "./settle";
import { addrKey, planToCommands } from "./translate";

const model = getModel("URX44V");

// param_ids whose encoding is a port-ref (the catalog's canonical set). An address
// the emit pass never wrote must read back as the broker's "nothing selected"
// sentinel (0xffffffff), so the readback decodes it to null and leaves/clears the
// wire instead of decoding raw 0 into a real port (which would wrongly fabricate a
// routing wire — the stereo-source 209/210 and SD-rec 736 among them).
const PORT_REF_NONE = 0xffffffff;

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
// bus→STEREO FX channels carry a -∞ default emit/readback do not touch, so compare
// on (from,to,kind) plus the params the readback actually reconstructs.
function wireKey(c: PlanConnection): string {
  const p = c.params ?? {};
  // An unedited fader/pan/tap (undefined) means unity/center/POST; readback always
  // materializes those as 0/0/"post" off the device, so coalesce for an
  // apples-to-apples comparison rather than flagging a representation difference as
  // drift. (The fixed FX channel → MIX sends seed level only; readback adds tap.)
  return [c.from, c.to, c.kind, p.level ?? 0, p.pan ?? 0, p.tap ?? "post", p.oscL, p.oscR].join("|");
}

beforeEach(() => {
  vi.mocked(vdGet).mockReset();
  // Names read via the string IPC; default to empty (no custom name) so the
  // numeric round-trip tests see clean nodeNames. Name-specific tests override.
  vi.mocked(vdGetStr).mockReset();
  vi.mocked(vdGetStr).mockResolvedValue("");
});

// A representative plan touching every readback group: channel strip, sends,
// bus faders/EQ, insert FX, ducker, master/monitor, OSC + assign, and routing.
// Shared by the round-trip and provenance blocks (one definition, so the two
// cannot drift). Edits the seeded fixed sends in place rather than pushing
// duplicate wires.
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

  // CH1 → MIX1 send (level/pan/PRE tap) and CH1 → FX1 send (level only — CH → FX
  // taps are read-only, so a tap cannot round-trip through a software write). Both
  // are fixed (always-wired) sends seeded above, so set their params in place.
  const ch1Mix1 = plan.connections.find((c) => c.from === "ch1:out" && c.to === "bus.mix1:in");
  ch1Mix1!.params = { level: -3, pan: -63, tap: "pre" };
  const ch1Fx1 = plan.connections.find((c) => c.from === "ch1:out" && c.to === "bus.fx1:in");
  ch1Fx1!.params = { level: -9 };

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
  plan.connections.push({
    from: "bus.osc:out",
    to: "bus.stereo:in",
    kind: "sendSwitch",
    params: { oscL: true, oscR: true },
  });

  // Routing selectors: streaming source + monitor1 source from a MIX bus; an
  // input source on CH2; an output patch on out.main.
  plan.connections.push({ from: "bus.mix1:out", to: "bus.stream:in", kind: "source" });
  plan.connections.push({ from: "bus.mix2:out", to: "bus.mon1:in", kind: "source" });
  plan.connections.push({ from: "in.aux:out", to: "ch2:in", kind: "source" });
  plan.connections.push({ from: "bus.stereo:out", to: "out.main:in", kind: "patch" });

  return plan;
}

describe("applyDeviceState round-trip", () => {
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
    const sends = 8 * 4 + 2 * 2; // 8 channels × (MIX1/2 + FX1/2) + 2 FX channels × MIX1/2
    const fxEffect = 2; // FX1 + FX2 effect type + parameter array
    const fxMainPath = 2; // FX1 + FX2 → STEREO main fader / balance
    const toSt = 2; // MIX1 + MIX2 → STEREO "TO ST" switch onto the connection
    const busFaders = 3; // STEREO + MIX1 + MIX2
    const insertFx = 3 + 4; // STEREO + 2 MIX outputs + 4 mono channels
    const busEqOn = 3; // STEREO + MIX1 + MIX2
    const busEqBands = 3; // STEREO + MIX1 + MIX2
    const duckers = 4;
    const master = 5; // bus master ON: STEREO + MIX1 + MIX2 + FX1 + FX2
    const monitors = 2;
    const osc = 1;
    const delay = 1; // STREAMING DELAY (bus.stream)
    const sampleRate = 1; // global sample rate (plan.sampleRate)
    const oscAssign = 5;
    const inputSource = 8;
    const selectors = 9;
    const colors = 8 + 6; // CH SETTING color: 8 channels + STEREO/MIX1/MIX2/FX1/FX2/STREAMING
    const names = 8 + 6; // CH SETTING name: same node set as color
    const sdRec = 8 + 1; // microSD Rec: 8 track-pair source slots + Track Count
    const expected =
      channels +
      sends +
      fxEffect +
      fxMainPath +
      toSt +
      busFaders +
      insertFx +
      busEqOn +
      busEqBands +
      duckers +
      master +
      monitors +
      osc +
      delay +
      sampleRate +
      oscAssign +
      inputSource +
      selectors +
      colors +
      names +
      sdRec;
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
    // The wire kept is the plan's own, not the device's, so the destination is
    // unread — otherwise a later converge writes it over the real routing.
    expect(result.unreadNodes.has("bus.stream")).toBe(true);
  });

  it("marks a fixed send OFF (params.on=false) but keeps its wire when the device reports OFF", async () => {
    const target = emptyPlan("URX44V");
    ensureFixedConnections(model, target);
    // The CH1 → MIX1 send is fixed (always wired); the device now reports it off
    // (all reads 0, so SEND_ON decodes false). Readback keeps the wire and flips
    // params.on to false rather than removing the routing.
    const seeded = target.connections.find((c) => c.from === "ch1:out" && c.to === "bus.mix1:in")!;
    seeded.params = { ...seeded.params, on: true };

    mockVdGetFrom(new Map());
    const result = await applyDeviceState(model, target);

    expect(result.errors).toEqual([]);
    const wire = target.connections.find((c) => c.from === "ch1:out" && c.to === "bus.mix1:in");
    expect(wire).toBeDefined();
    expect(wire!.params?.on).toBe(false);
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

// The unit acks a write before the value is readable (measured: a GET answers the
// pre-write value until that write's own notify arrives, 9-204 ms later, n = 87).
// Live sync's sideEffect refetch reads a node it has just written, so it hands the
// read what it wrote — and the read answers those addresses with WHAT THE UNIT
// ANNOUNCED about them, never with what was sent.
describe("applyDeviceState write overlay", () => {
  // A plan whose ch1 EQ 1-knob is on — the measured case: writing it makes the unit
  // recompute the four band gains, which is what the refetch is for.
  function oneKnobPlan(): Plan {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, eqOneKnob: { on: true, type: 0, level: 50 } };
    return plan;
  }
  function cmdFor(plan: Plan, name: string): { paramId: number; x: number; y: number; vdValue: number } {
    const cmd = planToCommands(model, plan).find((c) => c.name === name && c.node === "ch1");
    if (!cmd) throw new Error(`expected a ch1 ${name} command`);
    return cmd;
  }
  const oneKnobCommand = (plan: Plan): { paramId: number; x: number; y: number; vdValue: number } =>
    cmdFor(plan, "EQ_ONE_KNOB_ON");
  // The device still answering the value the write replaced: the staleness window.
  function staleTable(plan: Plan, cmd: { paramId: number; x: number; y: number }): Map<string, number> {
    const table = deviceTableFor(plan);
    table.set(`${cmd.paramId}:${cmd.x}:${cmd.y}`, 0);
    return table;
  }
  const keyOf = (cmd: { paramId: number; x: number; y: number }): number => addrKey(cmd.paramId, cmd.x, cmd.y);
  const wasRead = (cmd: { paramId: number; x: number; y: number }): boolean =>
    vi.mocked(vdGet).mock.calls.some(([id, x, y]) => id === cmd.paramId && x === cmd.x && y === cmd.y);

  /** A write the unit has ANNOUNCED, which is what makes answering a read from it
   *  legitimate at all. Nothing is left in scope to wait for, so these cases exercise
   *  the overlay alone; the wait has its own block below. */
  function announced(cmd: { paramId: number; x: number; y: number }, value: number): PendingWrites {
    const at = writeSettle.mark();
    writeSettle.note({ paramId: cmd.paramId, x: cmd.x, y: cmd.y, value });
    return { written: new Map([[keyOf(cmd), at]]), mustSettle: new Set(), mustAnnounce: new Set() };
  }

  // FAKE TIMERS FOR THE WHOLE BLOCK, and not for convenience: most of these cases
  // assert that no wait was taken, and on real timers a settle that spent 300 ms would
  // pass them all unnoticed. Here a wait nothing advances never ends, so the case times
  // out instead of quietly measuring a slower app.
  let armedSource: (() => void) | null = null;
  beforeEach(() => {
    vi.useFakeTimers();
    armedSource = writeSettle.arm(() => {});
  });
  afterEach(() => {
    armedSource?.();
    armedSource = null;
    vi.useRealTimers();
  });

  it("answers an address the unit announced from the announcement, not from the device", async () => {
    const source = oneKnobPlan();
    const cmd = oneKnobCommand(source);
    mockVdGetFrom(staleTable(source, cmd));

    const target = emptyPlan("URX44V");
    await applyDeviceState(model, target, undefined, undefined, announced(cmd, 1));

    expect(target.nodeParams.ch1.eqOneKnob?.on).toBe(true);
    // Not merely decoded to the same answer — the unit was never asked.
    expect(wasRead(cmd)).toBe(false);
  });

  it("answers what the unit announced even when that is not what was sent", async () => {
    // The coerced write — a grid snap, a range clamp, a value the unit adjusts on the
    // way in. It needs no case of its own in the app: the notify carries the unit's
    // value and the unit's value is the answer. Here the flush sent ON and the unit
    // announced OFF, and what lands in the plan is OFF, with no read taken.
    const source = oneKnobPlan();
    const cmd = oneKnobCommand(source);
    mockVdGetFrom(deviceTableFor(source));

    const target = emptyPlan("URX44V");
    await applyDeviceState(model, target, undefined, undefined, announced(cmd, 0));

    expect(target.nodeParams.ch1.eqOneKnob?.on).toBe(false);
    expect(wasRead(cmd)).toBe(false);
  });

  it("still reads every address the announcement does not name", async () => {
    const source = oneKnobPlan();
    source.nodeParams.ch1 = { ...source.nodeParams.ch1, hpf: true, hpfFreq: 120 };
    const cmd = oneKnobCommand(source);
    mockVdGetFrom(staleTable(source, cmd));

    const target = emptyPlan("URX44V");
    await applyDeviceState(model, target, undefined, undefined, announced(cmd, 1));

    // One address is overlaid; the rest of the node is device truth as before.
    expect(target.nodeParams.ch1.hpfFreq).toBe(120);
  });

  it("reads a write the unit never announced rather than answering it from the write", async () => {
    // Nothing has established that the unit took this one. An acked write it silently
    // discarded looks exactly like it, and answering it from the send would record our
    // value as device truth: plan and snapshot then agree, no later flush finds a diff,
    // and only a reconcile heals it. Reading it is the blind read, for that address
    // alone.
    const source = oneKnobPlan();
    const cmd = oneKnobCommand(source);
    mockVdGetFrom(staleTable(source, cmd));

    const target = emptyPlan("URX44V");
    const silent: PendingWrites = {
      written: new Map([[keyOf(cmd), writeSettle.mark()]]),
      mustSettle: new Set(),
      mustAnnounce: new Set(),
    };
    await applyDeviceState(model, target, undefined, undefined, silent);

    expect(wasRead(cmd)).toBe(true);
    expect(target.nodeParams.ch1.eqOneKnob?.on).toBe(false);
  });

  it("answers the announced write and reads the one beside it that nothing announced", async () => {
    // Both halves in one flush, which is the shape live sync actually produces: the
    // 1-knob write is what made it refetch, and an HPF frequency moved in the same
    // window rides along in `written`. One statement each — announced is answered from
    // the announcement, silent is asked for — and the pair is the point: handing over
    // only the announced subset would answer the second address on nothing at all.
    const source = oneKnobPlan();
    source.nodeParams.ch1 = { ...source.nodeParams.ch1, hpf: true, hpfFreq: 120 };
    const knob = oneKnobCommand(source);
    mockVdGetFrom(staleTable(source, knob));
    // A different HPF frequency, so "read off the device" and "answered from the
    // announcement" cannot produce the same number.
    const moved = oneKnobPlan();
    moved.nodeParams.ch1 = { ...moved.nodeParams.ch1, hpf: true, hpfFreq: 400 };
    const hpf = cmdFor(moved, "HPF_FREQ");

    const at = writeSettle.mark();
    writeSettle.note({ paramId: knob.paramId, x: knob.x, y: knob.y, value: 1 });
    const target = emptyPlan("URX44V");
    await applyDeviceState(model, target, undefined, undefined, {
      written: new Map([
        [keyOf(knob), at],
        [keyOf(hpf), at],
      ]),
      mustSettle: new Set(),
      mustAnnounce: new Set(),
    });

    expect(wasRead(knob)).toBe(false);
    expect(target.nodeParams.ch1.eqOneKnob?.on).toBe(true);
    expect(wasRead(hpf)).toBe(true);
    expect(target.nodeParams.ch1.hpfFreq).toBe(120);
  });

  it("ignores an announcement that predates the address's own write", async () => {
    // The unit spoke about this address BEFORE the flush reached it — the operator
    // moving the control on the board while the loop worked through the commands ahead
    // of it. That notify is not the answer to our write, so the address is read.
    const source = oneKnobPlan();
    const cmd = oneKnobCommand(source);
    mockVdGetFrom(staleTable(source, cmd));

    writeSettle.note({ paramId: cmd.paramId, x: cmd.x, y: cmd.y, value: 1 });
    const target = emptyPlan("URX44V");
    await applyDeviceState(model, target, undefined, undefined, {
      written: new Map([[keyOf(cmd), writeSettle.mark()]]),
      mustSettle: new Set(),
      mustAnnounce: new Set(),
    });

    expect(wasRead(cmd)).toBe(true);
    expect(target.nodeParams.ch1.eqOneKnob?.on).toBe(false);
  });

  it("is inert with an empty map — the address comes off the device", async () => {
    const source = oneKnobPlan();
    const cmd = oneKnobCommand(source);
    mockVdGetFrom(staleTable(source, cmd));

    const target = emptyPlan("URX44V");
    const inert: PendingWrites = { written: new Map(), mustSettle: new Set(), mustAnnounce: new Set() };
    await applyDeviceState(model, target, undefined, undefined, inert);

    expect(target.nodeParams.ch1.eqOneKnob?.on).toBe(false);
    expect(wasRead(cmd)).toBe(true);
  });

  // The wait is taken here rather than by the caller: readIntoPlan clones the plan at
  // the call, so a wait taken outside is a window in which an operator edit lands in
  // neither that clone nor the witness that protects an edit made during the read —
  // and the merge would revert it. Inside, both cover it.
  describe("the settle it waits out first", () => {
    function waitingFor(cmd: { paramId: number; x: number; y: number }): PendingWrites {
      return {
        written: new Map([[keyOf(cmd), writeSettle.mark()]]),
        mustSettle: new Set([keyOf(cmd)]),
        mustAnnounce: new Set(),
      };
    }

    it("does not read until the write's own notify arrives", async () => {
      const plan = oneKnobPlan();
      const cmd = oneKnobCommand(plan);
      mockVdGetFrom(deviceTableFor(plan));
      const pending = waitingFor(cmd);

      const read = applyDeviceState(model, emptyPlan("URX44V"), undefined, undefined, pending);
      await vi.advanceTimersByTimeAsync(40);
      expect(vi.mocked(vdGet)).not.toHaveBeenCalled();
      writeSettle.note({ paramId: cmd.paramId, x: cmd.x, y: cmd.y, value: 1 });
      await read;
      expect(vi.mocked(vdGet)).toHaveBeenCalled();
    });

    it("reads anyway once the bounded window expires, since a no-op write never notifies", async () => {
      const plan = oneKnobPlan();
      const cmd = oneKnobCommand(plan);
      mockVdGetFrom(deviceTableFor(plan));
      const pending = waitingFor(cmd);

      const read = applyDeviceState(model, emptyPlan("URX44V"), undefined, undefined, pending);
      await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS - 1);
      expect(vi.mocked(vdGet)).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await read;
      expect(vi.mocked(vdGet)).toHaveBeenCalled();
    });

    it("reads an address the window expired on rather than answering it from the write", async () => {
      const source = oneKnobPlan();
      const cmd = oneKnobCommand(source);
      mockVdGetFrom(staleTable(source, cmd));

      const target = emptyPlan("URX44V");
      const read = applyDeviceState(model, target, undefined, undefined, waitingFor(cmd));
      await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS);
      await read;

      expect(wasRead(cmd)).toBe(true);
      expect(target.nodeParams.ch1.eqOneKnob?.on).toBe(false);
    });

    it("takes no wait for an address outside the read's scope", async () => {
      // The collateral write. It is judged — announced, so it is answered — but the
      // read is not held open for it: doing so would cost the drag that produced it a
      // whole window per flush. Measurable here because the timers are fake: a wait
      // would never end.
      const source = oneKnobPlan();
      const cmd = oneKnobCommand(source);
      mockVdGetFrom(staleTable(source, cmd));

      const target = emptyPlan("URX44V");
      await applyDeviceState(model, target, undefined, undefined, announced(cmd, 1));

      expect(target.nodeParams.ch1.eqOneKnob?.on).toBe(true);
    });

    it("is abortable while it waits, like the reads around it", async () => {
      const cmd = oneKnobCommand(oneKnobPlan());
      const controller = new AbortController();
      const read = applyDeviceState(model, emptyPlan("URX44V"), controller.signal, undefined, waitingFor(cmd));
      controller.abort();
      await expect(read).rejects.toThrow();
      expect(vi.mocked(vdGet)).not.toHaveBeenCalled();
    });
  });
});

describe("applyDeviceState provenance (unreadNodes)", () => {
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

  it("never flags physical input source nodes or out.sdrec — they hold no body parameters", async () => {
    // Force every body group to throw (reject all reads): only attempted body
    // nodes may appear, so the never-attempted input/sdrec nodes must stay out.
    // bus.osc is kind "input" but is the oscillator generator, which does carry
    // body params (on/level/mode/freq), so it is legitimately attemptable —
    // exclude it; this asserts the physical mic/line/USB source nodes only.
    vi.mocked(vdGet).mockImplementation(() => Promise.reject(new Error("read timeout")));
    const target = emptyPlan("URX44V");
    const result = await applyDeviceState(model, target);

    for (const node of model.nodes) {
      if ((node.kind === "input" && node.id !== "bus.osc") || node.id === "out.sdrec") {
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

  it("keeps a body-failed FX channel flagged even when its effect read succeeds", async () => {
    // Fail only FX1's main-path read (its master fader 337 at y0); let every other
    // read — including the FX-channel effect array — succeed. The successful effect
    // read must not mask the FX channel's failed main-path read.
    const FX1_MAIN_FADER = 337; // FX_CHANNEL_FADER, the FX1 → STEREO main-path fader
    vi.mocked(vdGet).mockImplementation((paramId: number, _x: number, y: number) => {
      if (paramId === FX1_MAIN_FADER && y === 0) return Promise.reject(new Error("read timeout"));
      const table = deviceTableFor(richPlan());
      const hit = table.get(`${paramId}:${_x}:${y}`);
      if (hit !== undefined) return Promise.resolve(hit);
      return Promise.resolve(PORT_REF_PARAMS.has(paramId) ? PORT_REF_NONE : 0);
    });

    const target = emptyPlan("URX44V");
    const result = await applyDeviceState(model, target);

    // FX1's main-path read failed, so it is flagged even though its effect read is fine.
    expect(result.unreadNodes.has("bus.fx1")).toBe(true);
    expect(result.errors.some((e) => e.includes("read timeout"))).toBe(true);
    // FX2, whose reads all succeed, is not flagged.
    expect(result.unreadNodes.has("bus.fx2")).toBe(false);
  });

  it("reads CH SETTING names back into nodeNames; empty clears to the default label", async () => {
    mockVdGetFrom(new Map());
    // ch1 named "Vox", bus.stereo named "Main"; everything else empty.
    vi.mocked(vdGetStr).mockImplementation((paramId: number, _x: number, y: number) => {
      if (paramId === 18 && y === 0) return Promise.resolve("Vox");
      if (paramId === 494 && y === 0) return Promise.resolve("Main");
      return Promise.resolve("");
    });
    const target = emptyPlan("URX44V");
    await applyDeviceState(model, target);

    expect(target.nodeNames.ch1).toBe("Vox");
    expect(target.nodeNames["bus.stereo"]).toBe("Main");
    // An empty device name leaves no override (falls back to the model label).
    expect(target.nodeNames.ch2).toBeUndefined();
    expect(target.nodeNames["bus.mix1"]).toBeUndefined();
  });

  // The name path has the same post-write staleness window as the numeric ones
  // (measured on a URX44V: 81 ms), and the numeric repair cannot reach it — a
  // name is written on the string path, which enters no write ledger, so
  // `writeOverlay` has nothing to answer from. Live sync's sideEffect refetch is the one read issued inside that
  // window, so it must not read names at all: a rename flushed in the same
  // window would come back as the name it replaced and be written into the plan
  // AND the name snapshot together, leaving no diff to retry.
  it("skips the name read for the sideEffect refetch, and only for it", async () => {
    mockVdGetFrom(new Map());
    vi.mocked(vdGetStr).mockImplementation((paramId: number, _x: number, y: number) =>
      Promise.resolve(paramId === 18 && y === 0 ? "FromDevice" : ""),
    );

    // The refetch hands over what it just wrote. Names are untouched by it.
    const refetched = emptyPlan("URX44V");
    refetched.nodeNames.ch1 = "OperatorJustTypedThis";
    await applyDeviceState(model, refetched, undefined, new Set(["ch1"]), {
      written: new Map(),
      mustSettle: new Set(),
      mustAnnounce: new Set(),
    });
    expect(refetched.nodeNames.ch1).toBe("OperatorJustTypedThis");
    expect(vi.mocked(vdGetStr).mock.calls.some(([p]) => p === 18)).toBe(false);

    // Every other caller passes no pending set and still reads names, which is
    // how a rename made on the unit reaches the app at all.
    vi.mocked(vdGetStr).mockClear();
    const reconciled = emptyPlan("URX44V");
    reconciled.nodeNames.ch1 = "OperatorJustTypedThis";
    await applyDeviceState(model, reconciled, undefined, new Set(["ch1"]));
    expect(reconciled.nodeNames.ch1).toBe("FromDevice");
    expect(vi.mocked(vdGetStr).mock.calls.some(([p]) => p === 18)).toBe(true);
  });

  // The device's own stereo pair labels are right-aligned in a 2-character field
  // (" 5/ 6"), so a leading-space strip would shorten the name and write the
  // shortened form back on the next sync. Only trailing padding may be dropped.
  it("keeps a leading space in a device name but drops trailing padding", async () => {
    mockVdGetFrom(new Map());
    vi.mocked(vdGetStr).mockImplementation((paramId: number, _x: number, y: number) => {
      if (paramId === 206 && y === 0) return Promise.resolve(" 5/ 6");
      if (paramId === 18 && y === 0) return Promise.resolve("Vox   ");
      if (paramId === 18 && y === 1) return Promise.resolve("   ");
      return Promise.resolve("");
    });
    const target = emptyPlan("URX44V");
    await applyDeviceState(model, target);

    expect(target.nodeNames.ch_5_6).toBe(" 5/ 6");
    expect(target.nodeNames.ch1).toBe("Vox");
    // An all-blank name still reads as empty, so it clears to the model label.
    expect(target.nodeNames.ch2).toBeUndefined();
  });

  it("reads CH SETTING color back into nodeColors (palette index → swatch hex)", async () => {
    const source = emptyPlan("URX44V");
    ensureFixedConnections(model, source);
    source.nodeColors.ch1 = COLOR_PALETTE[1].hex; // Orange
    source.nodeColors["bus.stereo"] = COLOR_PALETTE[6].hex; // Red
    mockVdGetFrom(deviceTableFor(source));

    const target = emptyPlan("URX44V");
    await applyDeviceState(model, target);

    expect(target.nodeColors.ch1).toBe(COLOR_PALETTE[1].hex);
    expect(target.nodeColors["bus.stereo"]).toBe(COLOR_PALETTE[6].hex);
    // An unset colorable node reads the device default index 0 = Blue.
    expect(target.nodeColors.ch2).toBe(COLOR_PALETTE[0].hex);
  });
});

describe("formatReadbackReport", () => {
  it("lists read failures and unconfirmed nodes", () => {
    const md = formatReadbackReport("URX44V", {
      applied: 40,
      errors: ["CH1 GATE: timed out", "CH2 COMP: no response"],
      unreadNodes: new Set(["ch1", "ch2"]),
    });
    expect(md).toContain("Groups read: 40; read failures: 2; nodes unconfirmed: 2");
    expect(md).toContain("- CH1 GATE: timed out");
    expect(md).toContain("- ch1");
  });

  it("omits the failure sections when nothing failed", () => {
    const md = formatReadbackReport("URX44V", { applied: 40, errors: [], unreadNodes: new Set() });
    expect(md).not.toContain("## Read failures");
    expect(md).not.toContain("## Nodes left at plan default");
    // A plain ReadbackResult carries no `unplaced` at all — the field has to be optional
    // (the .urxf import path passes one), and its absence renders nothing.
    expect(md).not.toContain("## Device values not applied");
  });

  // `unplaced` reached exactly one runtime consumer, a console.warn, and a packaged
  // build has no inspector to read it in — so a merge that declined to write part of a
  // device read said so to nobody.
  it("lists the device values the merge did not apply", () => {
    const md = formatReadbackReport("URX44V", {
      applied: 40,
      errors: [],
      unreadNodes: new Set(),
      unplaced: ["nodeParams ch1.on", `connParams ch1:out${WIRE_SEP}bus.stereo:in.level`],
    });
    expect(md).toContain("## Device values not applied");
    expect(md).toContain("- nodeParams ch1.on");
    // A wire key joins its two refs with NUL. Rendered raw it puts a control character
    // into a saved document and runs the two refs together on screen.
    expect(md).toContain("ch1:out -> bus.stereo:in.level");
    expect(md).not.toContain(WIRE_SEP);
  });

  // Both halves of `unplaced` reach this section — a target that is gone, and a key the
  // operator moved while the read was in flight, which the merge leaves standing on
  // purpose. The heading has to hold for the second one too, or the report calls
  // ordinary correct behaviour damage.
  it("does not describe every unapplied value as a missing target", () => {
    const md = formatReadbackReport("URX44V", {
      applied: 40,
      errors: [],
      unreadNodes: new Set(),
      unplaced: ["nodeParams ch1.on"],
    });
    expect(md).not.toMatch(/no longer in the plan/i);
    expect(md).toMatch(/edited here while the read was in flight/i);
  });
});
