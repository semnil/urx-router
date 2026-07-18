import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../../models";
import { emptyPlan, ensureFixedConnections, type Plan } from "../plan";

// client.ts drives the device through platform.vdGet / vdSet, so mock those: the
// rest of platform.ts (file IO, dialogs) is untouched here.
vi.mock("../platform", () => ({ vdGet: vi.fn(), vdSet: vi.fn() }));

import { vdGet, vdSet } from "../platform";
import { diffPlan, dryRun, formatWriteReport, sendCommands, sendConverging, sendPlan } from "./client";
import { planToCommands, type VdCommand } from "./translate";
import { PORT_REF_PARAM_IDS as PORT_REF_PARAMS } from "./params";
import { PORT_REF_NONE } from "./vd";

const model = getModel("URX44V");

function basePlan(): Plan {
  const plan = emptyPlan("URX44V");
  ensureFixedConnections(model, plan);
  return plan;
}

// The device's "current state" table = exactly what emit would write for a plan,
// so vdGet returns the plan's own values: a device already matching the plan.
function deviceTableFor(plan: Plan): Map<string, number> {
  const table = new Map<string, number>();
  for (const cmd of planToCommands(model, plan)) table.set(`${cmd.paramId}:${cmd.x}:${cmd.y}`, cmd.vdValue);
  return table;
}

beforeEach(() => {
  vi.mocked(vdGet).mockReset();
  vi.mocked(vdSet).mockReset();
});

describe("dryRun", () => {
  it("returns the plan's full command list", () => {
    const plan = basePlan();
    expect(dryRun(model, plan)).toEqual(planToCommands(model, plan));
  });
});

describe("diffPlan", () => {
  it("reports no diffs when the device already matches the plan", async () => {
    const plan = basePlan();
    const table = deviceTableFor(plan);
    vi.mocked(vdGet).mockImplementation((id, x, y) => Promise.resolve(table.get(`${id}:${x}:${y}`) ?? 0));
    const { diffs, errors } = await diffPlan(model, plan);
    expect(errors).toEqual([]);
    expect(diffs).toEqual([]);
  });

  it("reports only the commands whose device value differs", async () => {
    const plan = basePlan();
    const target = planToCommands(model, plan)[0];
    const table = deviceTableFor(plan);
    table.set(`${target.paramId}:${target.x}:${target.y}`, target.vdValue + 1);
    vi.mocked(vdGet).mockImplementation((id, x, y) => Promise.resolve(table.get(`${id}:${x}:${y}`) ?? 0));
    const { diffs } = await diffPlan(model, plan);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].command).toEqual(target);
    expect(diffs[0].current).toBe(target.vdValue + 1);
  });

  it("keeps an unreadable command (current=null) and records the error", async () => {
    const plan = basePlan();
    const target = planToCommands(model, plan)[0];
    const table = deviceTableFor(plan);
    vi.mocked(vdGet).mockImplementation((id, x, y) =>
      id === target.paramId && x === target.x && y === target.y
        ? Promise.reject(new Error("timeout"))
        : Promise.resolve(table.get(`${id}:${x}:${y}`) ?? 0),
    );
    const { diffs, errors } = await diffPlan(model, plan);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].current).toBeNull();
    expect(errors).toHaveLength(1);
  });
});

describe("sendCommands / sendPlan", () => {
  it("sends every command and reports each as ok", async () => {
    vi.mocked(vdSet).mockResolvedValue(undefined);
    const commands = planToCommands(model, basePlan());
    const outcomes = await sendCommands(commands);
    expect(outcomes).toHaveLength(commands.length);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(vi.mocked(vdSet)).toHaveBeenCalledTimes(commands.length);
  });

  it("reports a failed command without aborting the rest", async () => {
    const commands = planToCommands(model, basePlan());
    const first = commands[0];
    vi.mocked(vdSet).mockImplementation((id, x, y) =>
      id === first.paramId && x === first.x && y === first.y ? Promise.reject(new Error("nak")) : Promise.resolve(),
    );
    const outcomes = await sendCommands(commands);
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].error).toBe("nak");
    expect(outcomes.slice(1).every((o) => o.ok)).toBe(true);
  });

  it("sendPlan sends the full plan command list", async () => {
    vi.mocked(vdSet).mockResolvedValue(undefined);
    const plan = basePlan();
    const outcomes = await sendPlan(model, plan);
    expect(outcomes).toHaveLength(planToCommands(model, plan).length);
  });
});

describe("sendConverging", () => {
  // A mutable device: vdSet stores, vdGet reads. An optional stubborn address
  // ignores writes until it has been written `stickAfter` times (models a param
  // the device resets as a side effect of another write, accepted on re-send).
  function installDevice(opts?: { stuckKey?: string; stickAfter?: number }): Map<string, number> {
    const table = new Map<string, number>();
    const writes = new Map<string, number>();
    vi.mocked(vdGet).mockImplementation((id, x, y) => {
      const k = `${id}:${x}:${y}`;
      return Promise.resolve(table.has(k) ? table.get(k)! : PORT_REF_PARAMS.has(id) ? PORT_REF_NONE : 0);
    });
    vi.mocked(vdSet).mockImplementation((id, x, y, v) => {
      const k = `${id}:${x}:${y}`;
      if (opts?.stuckKey === k) {
        const n = (writes.get(k) ?? 0) + 1;
        writes.set(k, n);
        if (opts.stickAfter !== undefined && n >= opts.stickAfter) table.set(k, v);
      } else {
        table.set(k, v);
      }
      return Promise.resolve();
    });
    return table;
  }

  // A plan that differs from a blank device (so there is something to write).
  function dirtyPlan(): Plan {
    const plan = basePlan();
    plan.nodeParams["ch1"] = { on: true, hpf: true, gain: 6 };
    return plan;
  }

  it("converges in one round when every write sticks", async () => {
    installDevice();
    const r = await sendConverging(model, dirtyPlan(), undefined, 3, 0);
    expect(r.rounds).toBe(1);
    expect(r.residual).toEqual([]);
  });

  it("re-sends and converges a param the device drops on the first write", async () => {
    // CH_ON (140:0:0) is accepted only on its second write.
    installDevice({ stuckKey: "140:0:0", stickAfter: 2 });
    const r = await sendConverging(model, dirtyPlan(), undefined, 3, 0);
    expect(r.rounds).toBe(2);
    expect(r.residual).toEqual([]);
  });

  it("gives up after maxRounds and reports the residual for a stuck param", async () => {
    installDevice({ stuckKey: "140:0:0" }); // never sticks
    const r = await sendConverging(model, dirtyPlan(), undefined, 3, 0);
    expect(r.rounds).toBe(3);
    expect(r.residual.some((d) => d.command.paramId === 140)).toBe(true);
  });
});

describe("formatWriteReport", () => {
  // The report reads only name/paramId/x/y/vdValue, so stub a minimal command
  // (the full VdCommand carries planValue/request, irrelevant to formatting).
  const cmd = (name: string, paramId: number, vdValue: number) =>
    ({ name, paramId, x: 0, y: 1, vdValue }) as unknown as VdCommand;

  it("lists write failures with their error", () => {
    const md = formatWriteReport("URX44V", [{ name: "CH1 GATE", error: "timed out" }], []);
    expect(md).toContain("Write failures: 1");
    expect(md).toContain("- CH1 GATE — timed out");
  });

  it("lists non-converged params with wrote vs device value", () => {
    const md = formatWriteReport("URX44V", [], [{ command: cmd("CH1 ON", 140, 1), current: 0 }]);
    expect(md).toContain("did not converge: 1");
    expect(md).toContain("CH1 ON @ 140:0:1 — wrote 1, device has 0");
  });

  it("renders an unreadable device value rather than crashing", () => {
    const md = formatWriteReport("URX44V", [], [{ command: cmd("CH1 ON", 140, 1), current: null }]);
    expect(md).toContain("device has unreadable");
  });

  it("falls back to a generic reason when an outcome has no error string", () => {
    const md = formatWriteReport("URX44V", [{ name: "CH2 EQ" }], []);
    expect(md).toContain("- CH2 EQ — unknown error");
  });
});
