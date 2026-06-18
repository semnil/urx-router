import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../../models";
import { emptyPlan, ensureFixedConnections, type Plan } from "../plan";

// client.ts drives the device through platform.vdGet / vdSet, so mock those: the
// rest of platform.ts (file IO, dialogs) is untouched here.
vi.mock("../platform", () => ({ vdGet: vi.fn(), vdSet: vi.fn() }));

import { vdGet, vdSet } from "../platform";
import { diffPlan, dryRun, sendCommands, sendPlan } from "./client";
import { planToCommands } from "./translate";

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
      id === first.paramId && x === first.x && y === first.y
        ? Promise.reject(new Error("nak"))
        : Promise.resolve(),
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
