import { beforeEach, describe, expect, it, vi } from "vitest";
import { SSMCS_INITIAL, emptyPlan } from "../plan";
import { defaultPlan } from "../../models/initial-state";
import { getModel } from "../../models";
import { ref } from "../../models/types";
import type { NodeParams, Plan } from "../plan";

// The run path talks to the device through the transport and reuses the
// self-test's capture; both are stubbed so the sequencing — capture, spread, send,
// retry past a refusal, always disconnect — is testable without hardware. The
// value strategy below keeps the real `floorSilent`, so the silence pass is the
// shipping one.
const mocks = vi.hoisted(() => ({
  vdConnect: vi.fn<() => Promise<{ model: string; epoch: number }>>(),
  vdDisconnect: vi.fn<(epoch: number) => Promise<void>>(),
  vdSet: vi.fn<(id: number, x: number, y: number, v: number) => Promise<void>>(),
  captureDeviceState: vi.fn(),
}));

vi.mock("../platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform")>()),
  vdConnect: mocks.vdConnect,
  vdDisconnect: mocks.vdDisconnect,
  vdSet: mocks.vdSet,
}));

vi.mock("./selftest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./selftest")>()),
  captureDeviceState: mocks.captureDeviceState,
}));

import { buildModifiedPlan, prepareBatches, runPrepareModified } from "./prepare";
import { D_GAIN_SOURCES, MIC_LINE_JACK_BASE, PARAMS } from "./params";
import { dryRun } from "./client";

// A node carrying every sub-structure the spread pass touches, at factory-ish
// starting values, so the test exercises each range.
const richNode = (): NodeParams => ({
  on: true,
  hpf: false,
  hpfFreq: 80,
  gainL: 0,
  gainR: 0,
  dGain: 0,
  phantomL: true,
  phantomR: true,
  gateOn: false,
  gate: { threshold: -20, range: -30, attack: 1, hold: 10, decay: 100 },
  compOn: false,
  comp: { threshold: -18, ratio: 3, knee: 0, gain: 2, attack: 20, release: 150 },
  compEqType: 1,
  busType: 0,
  eqBands: [
    { on: true, type: 0, freq: 100, q: 1, gain: 0 },
    { on: true, type: 0, freq: 1000, q: 1, gain: 0 },
  ],
  ssmcs: structuredClone(SSMCS_INITIAL),
  insertFx: -1,
});

function testPlan(): Plan {
  const plan = defaultPlan("URX44V");
  plan.nodeParams["audit-node"] = richNode();
  plan.connections.push({
    from: ref("audit-node", "out"),
    to: ref("bus.stereo", "in"),
    kind: "send",
    params: { level: 0, pan: 0 },
  });
  return plan;
}

const inRange = (v: number | undefined, lo: number, hi: number): boolean => typeof v === "number" && v >= lo && v <= hi;

describe("buildModifiedPlan value strategy", () => {
  const src = testPlan();
  const out = buildModifiedPlan(src);
  const np = out.nodeParams["audit-node"];
  const ssmcs = np.ssmcs!;

  it("keeps every spread scalar inside its legal range", () => {
    expect(inRange(np.gainL, -8, 40)).toBe(true);
    expect(inRange(np.gainR, -8, 40)).toBe(true);
    expect(inRange(np.dGain, -24, 24)).toBe(true);
    expect([40, 60, 100, 120]).toContain(np.hpfFreq);
    expect(inRange(np.gate!.threshold, -72, -3)).toBe(true);
    expect(inRange(np.gate!.attack, 0.092, 80)).toBe(true);
    expect(inRange(np.gate!.hold, 0.02, 1960)).toBe(true);
    expect(inRange(np.gate!.decay, 9.3, 999)).toBe(true);
    expect(inRange(np.comp!.ratio, 1, 20)).toBe(true);
    expect([0, 1, 2]).toContain(np.comp!.knee);
    expect(inRange(np.eqBands![0].freq, 20, 20000)).toBe(true);
    expect(inRange(np.eqBands![0].q, 0.5, 16)).toBe(true);
    expect(inRange(np.eqBands![0].gain, -18, 18)).toBe(true);
    expect(inRange(ssmcs.compDrive, 0, 200)).toBe(true);
    expect(inRange(ssmcs.comp!.attack, 57, 283)).toBe(true);
    expect([0, 1, 2]).toContain(ssmcs.comp!.knee);
    expect(inRange(ssmcs.sc!.freq, 4, 124)).toBe(true);
    expect(inRange(ssmcs.eq!.low!.freq, 4, 124)).toBe(true);
    expect(inRange(ssmcs.eq!.low!.gain, 0, 360)).toBe(true);
  });

  it("moves values well off their factory value (not an adjacent nudge)", () => {
    expect(Math.abs(np.gate!.threshold! - -20)).toBeGreaterThan(1);
    expect(Math.abs(ssmcs.comp!.attack! - SSMCS_INITIAL.comp.attack)).toBeGreaterThan(1);
    expect(np.eqBands![0].freq).not.toBe(100);
  });

  it("gives adjacent items distinct values", () => {
    // Two EQ bands started identical (freq 100 / 1000 differ, but q/gain matched);
    // the per-scalar fraction cycle should separate their q.
    expect(np.eqBands![0].q).not.toBe(np.eqBands![1].q);
  });

  it("stays silent and safe: levels floored, osc/phantom off", () => {
    expect(np.phantomL).toBe(false);
    expect(np.phantomR).toBe(false);
    const conn = out.connections.find((c) => c.params?.pan !== undefined);
    expect(conn!.params!.level).toBeLessThan(-96);
    for (const p of Object.values(out.nodeParams)) if (p.osc) expect(p.osc.on).toBe(false);
  });

  it("leaves structural selectors as captured", () => {
    expect(np.compEqType).toBe(1);
    expect(np.busType).toBe(0);
    expect(np.insertFx).toBe(-1);
    expect(ssmcs.sweetSpotData).toBe(SSMCS_INITIAL.sweetSpotData);
  });

  it("sets toggles to a deterministic non-default (ON-by-default off, others on)", () => {
    expect(np.on).toBe(false); // ON-by-default -> off
    expect(np.gateOn).toBe(true);
    expect(np.hpf).toBe(true);
  });

  it("is idempotent: re-running converges to the same state (no factory reset needed)", () => {
    // The target depends only on which fields exist, not their values, so applying
    // it to an already-modified plan yields the same result — a re-run from a
    // partially-written device still converges cleanly.
    expect(JSON.stringify(buildModifiedPlan(out))).toBe(JSON.stringify(out));
  });
});

// A write carries the input stage of the jacks and sources some channel reads, so the run routes
// the channels through every input in turn. Over a plan holding every jack and source, the
// batches together put a value on each of them, with +48V off throughout, and the last batch is
// the plan's own source selects.
describe("prepareBatches", () => {
  const model = getModel("URX44V");
  const plan = buildModifiedPlan(defaultPlan("URX44V"));
  const batches = prepareBatches(model, plan);
  const at = (c: { paramId: number; x: number; y: number }): string => `${c.paramId}:${c.x}:${c.y}`;
  const gainAddrs = (cmds: ReturnType<typeof dryRun>): Set<string> =>
    new Set(cmds.filter((c) => c.name === "HA_GAIN" || c.name === "D_GAIN").map(at));
  const every = new Set([
    ...Object.values(MIC_LINE_JACK_BASE).flatMap((base) => [base, base + 1].map((y) => `${PARAMS.HA_GAIN.id}:0:${y}`)),
    ...Object.entries(D_GAIN_SOURCES)
      .filter(([id]) => model.nodes.some((n) => n.id === id))
      .flatMap(([, a]) => a.instances.map((y) => `${a.id}:0:${y}`)),
  ]);

  it("puts a value on every jack and source between them", () => {
    expect(gainAddrs(batches[0]).size, "the premise: the plan alone reaches fewer").toBeLessThan(every.size);
    expect(gainAddrs(batches.flat())).toEqual(every);
  });

  it("sends +48V off in every batch", () => {
    const phantom = batches.flat().filter((c) => c.name === "PHANTOM");
    expect(phantom.length, "the premise: the batches carry +48V").toBeGreaterThan(0);
    expect(phantom.every((c) => c.planValue === 0)).toBe(true);
  });

  it("ends on the plan's own source selects", () => {
    const selects = (cmds: ReturnType<typeof dryRun>) =>
      cmds.filter((c) => c.name.includes("INPUT_SOURCE")).map((c) => [at(c), c.vdValue]);
    expect(batches.at(-1)!.map((c) => [at(c), c.vdValue])).toEqual(selects(batches[0]));
    expect(batches.at(-1)!.length, "the premise: the plan carries source selects").toBeGreaterThan(0);
  });
});

describe("runPrepareModified", () => {
  const model = getModel("URX44V");

  const captured = (): Plan => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["ch1"] = { on: true, hpfFreq: 80 };
    plan.nodeParams["in.micline_1_2"] = { gainL: 0 };
    return plan;
  };

  // What the run will actually try to send, so a test can address a command by
  // position without pinning the emit order itself.
  const plannedCommands = (): ReturnType<typeof dryRun> => prepareBatches(model, buildModifiedPlan(captured())).flat();
  // Commands of the first batch whose address the run sends once, so refusing one refuses one send.
  const sentOnce = (): ReturnType<typeof dryRun> => {
    const all = plannedCommands();
    const at = (c: (typeof all)[number]): string => `${c.paramId}:${c.x}:${c.y}`;
    return dryRun(model, buildModifiedPlan(captured())).filter((c) => all.filter((d) => at(d) === at(c)).length === 1);
  };

  const captureOk = (): void => {
    mocks.captureDeviceState.mockResolvedValue({ ok: true, plan: captured(), applied: 7, errors: [] });
  };

  beforeEach(() => {
    mocks.vdConnect.mockReset().mockResolvedValue({ model: "URX44V", epoch: 3 });
    mocks.vdDisconnect.mockReset().mockResolvedValue(undefined);
    mocks.vdSet.mockReset().mockResolvedValue(undefined);
    mocks.captureDeviceState.mockReset();
  });

  it("captures, writes the spread plan whole, and reports what landed", async () => {
    captureOk();
    const expected = plannedCommands();
    const report = await runPrepareModified(model);
    expect(report).toEqual({
      device: "URX44V",
      applied: 7,
      written: expected.length,
      residual: 0,
      errors: [],
      aborted: false,
    });
    expect(mocks.vdSet).toHaveBeenCalledTimes(expected.length);
    expect(mocks.vdDisconnect).toHaveBeenCalledWith(3);
  });

  // The device it connected to is named in the report whether or not the run
  // proceeds — a mismatch report that does not say what was on the other end is
  // not actionable.
  it("stops on a model mismatch, still naming the device it reached", async () => {
    mocks.vdConnect.mockResolvedValue({ model: "URX22", epoch: 9 });
    mocks.captureDeviceState.mockResolvedValue({
      ok: false,
      plan: emptyPlan("URX44V"),
      applied: 0,
      errors: ["connected device is URX22, not URX44V"],
    });
    const report = await runPrepareModified(model);
    expect(report.device).toBe("URX22");
    expect(report.errors).toEqual(["connected device is URX22, not URX44V"]);
    expect(report.written).toBe(0);
    expect(mocks.vdSet).not.toHaveBeenCalled();
    expect(mocks.vdDisconnect).toHaveBeenCalledWith(9);
  });

  // A capture that read the device but missed some parameters still runs: those
  // errors travel into the report beside anything the write turns up.
  it("carries the capture's read errors into the report and still writes", async () => {
    mocks.captureDeviceState.mockResolvedValue({
      ok: true,
      plan: captured(),
      applied: 5,
      errors: ["CH1 GAIN: timeout"],
    });
    const report = await runPrepareModified(model);
    expect(report.errors).toEqual(["CH1 GAIN: timeout"]);
    expect(report.written).toBeGreaterThan(0);
  });

  // The live write path aborts the whole operation at the first failure; a scene
  // audit instead wants every writable parameter to land, so the rejected command
  // is dropped and the remainder retried.
  it("retries past a refused command instead of skipping the rest", async () => {
    captureOk();
    const expected = plannedCommands();
    const bad = sentOnce()[1];
    mocks.vdSet.mockImplementation((id, x, y) =>
      id === bad.paramId && x === bad.x && y === bad.y ? Promise.reject(new Error("locked")) : Promise.resolve(),
    );
    const report = await runPrepareModified(model);
    expect(report.residual).toBe(1);
    expect(report.errors).toEqual([`${bad.name}@${bad.paramId}:${bad.x}:${bad.y}: locked`]);
    // Everything except the refused one landed, and the refused one was tried once.
    expect(report.written).toBe(expected.length - 1);
    expect(mocks.vdSet).toHaveBeenCalledTimes(expected.length);
  });

  it("records every refusal when more than one command is device-locked", async () => {
    captureOk();
    const expected = plannedCommands();
    const once = sentOnce();
    const locked = new Set([once[0], once[2]].map((c) => `${c.paramId}:${c.x}:${c.y}`));
    mocks.vdSet.mockImplementation((id, x, y) =>
      locked.has(`${id}:${x}:${y}`) ? Promise.reject(new Error("locked")) : Promise.resolve(),
    );
    const report = await runPrepareModified(model);
    expect(report.residual).toBe(2);
    expect(report.written).toBe(expected.length - 2);
    expect(report.errors).toHaveLength(2);
  });

  // The refusal line names the address, not just the parameter: two instances of
  // one param are the same name and only the address separates them.
  it("renders a non-Error refusal as a string, addressed", async () => {
    captureOk();
    const first = plannedCommands()[0];
    mocks.vdSet.mockImplementation((id, x, y) =>
      id === first.paramId && x === first.x && y === first.y ? Promise.reject("locked") : Promise.resolve(),
    );
    const report = await runPrepareModified(model);
    expect(report.errors[0]).toBe(`${first.name}@${first.paramId}:${first.x}:${first.y}: locked`);
  });

  // A rejection carrying no reason still has to read as a refusal rather than as a
  // line that trails off after the colon.
  it("gives a refusal with an empty message a reason of its own", async () => {
    captureOk();
    const first = plannedCommands()[0];
    mocks.vdSet.mockImplementation((id, x, y) =>
      id === first.paramId && x === first.x && y === first.y ? Promise.reject(new Error("")) : Promise.resolve(),
    );
    const report = await runPrepareModified(model);
    expect(report.errors[0]).toBe(`${first.name}@${first.paramId}:${first.x}:${first.y}: rejected`);
  });

  it("reports a cancel as aborted rather than throwing, and still disconnects", async () => {
    captureOk();
    const ctl = new AbortController();
    let sent = 0;
    mocks.vdSet.mockImplementation(() => {
      if (++sent === 2) ctl.abort();
      return Promise.resolve();
    });
    const report = await runPrepareModified(model, ctl.signal);
    expect(report.aborted).toBe(true);
    expect(mocks.vdDisconnect).toHaveBeenCalledWith(3);
    expect(sent).toBeLessThan(plannedCommands().length);
  });

  it("reports a cancel raised during the capture as aborted", async () => {
    const ctl = new AbortController();
    mocks.captureDeviceState.mockImplementation(() => {
      ctl.abort();
      return Promise.reject(new DOMException("aborted", "AbortError"));
    });
    const report = await runPrepareModified(model, ctl.signal);
    expect(report).toMatchObject({ device: "URX44V", aborted: true, written: 0 });
    expect(mocks.vdDisconnect).toHaveBeenCalledWith(3);
  });

  // Only a cancel is swallowed: a genuine failure has to reach the caller, and
  // the link is closed on the way out either way.
  it("rethrows a non-cancel failure and still disconnects", async () => {
    mocks.captureDeviceState.mockRejectedValue(new Error("link down"));
    await expect(runPrepareModified(model)).rejects.toThrow("link down");
    expect(mocks.vdDisconnect).toHaveBeenCalledWith(3);
  });

  it("does not disconnect a link it never opened", async () => {
    mocks.vdConnect.mockRejectedValue(new Error("no device"));
    await expect(runPrepareModified(model)).rejects.toThrow("no device");
    expect(mocks.vdDisconnect).not.toHaveBeenCalled();
  });
});
