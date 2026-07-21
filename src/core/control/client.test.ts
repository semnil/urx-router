import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../../models";
import { emptyPlan, ensureFixedConnections, type Plan } from "../plan";

// client.ts drives the device through platform.vdGet / vdSet, so mock those: the
// rest of platform.ts (file IO, dialogs) is untouched here.
vi.mock("../platform", () => ({ vdGet: vi.fn(), vdSet: vi.fn() }));

import { vdGet, vdSet } from "../platform";
import {
  compareCounts,
  diffPlan,
  dryRun,
  formatCompareReport,
  formatWriteReport,
  sendCommands,
  sendConverging,
  sendPlan,
} from "./client";
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

  // An unreadable parameter leaves its device value unknown, so it is reported
  // and left out of the diff rather than written blind — the caller aborts the
  // whole write on a non-empty errors list.
  it("drops an unreadable command from the diff and records the error", async () => {
    const plan = basePlan();
    const target = planToCommands(model, plan)[0];
    const table = deviceTableFor(plan);
    vi.mocked(vdGet).mockImplementation((id, x, y) =>
      id === target.paramId && x === target.x && y === target.y
        ? Promise.reject(new Error("timeout"))
        : Promise.resolve(table.get(`${id}:${x}:${y}`) ?? 0),
    );
    const { diffs, errors } = await diffPlan(model, plan);
    expect(diffs).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("timeout");
  });

  // A caller that aborts on any read failure gains nothing from the rest of the
  // sweep, and on a link that times out rather than fails fast those reads are
  // minutes of waiting for an answer already decided.
  it("stops at the first read failure when asked to", async () => {
    const plan = basePlan();
    vi.mocked(vdGet).mockRejectedValue(new Error("timeout"));
    const all = await diffPlan(model, plan);
    const stopped = await diffPlan(model, plan, undefined, true);
    expect(stopped.errors).toHaveLength(1);
    expect(all.errors.length).toBeGreaterThan(1);
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

  // Order matters (a type selector binds the array that follows it), so the loop
  // stops at the first failure and the rest are reported as never attempted.
  it("stops at the first failure and marks the rest as skipped", async () => {
    const commands = planToCommands(model, basePlan());
    const first = commands[0];
    vi.mocked(vdSet).mockImplementation((id, x, y) =>
      id === first.paramId && x === first.x && y === first.y ? Promise.reject(new Error("nak")) : Promise.resolve(),
    );
    const outcomes = await sendCommands(commands);
    expect(outcomes).toHaveLength(commands.length);
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].error).toBe("nak");
    expect(outcomes[0].skipped).toBeUndefined();
    expect(outcomes.slice(1).every((o) => !o.ok && o.skipped === true)).toBe(true);
    // Only the failing command reached the transport.
    expect(vi.mocked(vdSet)).toHaveBeenCalledTimes(1);
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

  // Re-sending the whole plan over a link that just failed would re-trigger the
  // side-effect resets this loop exists to settle, so one round is all it does.
  it("stops after a round that failed to send instead of retrying", async () => {
    installDevice();
    vi.mocked(vdSet).mockRejectedValue(new Error("link down"));
    const r = await sendConverging(model, dirtyPlan(), undefined, 3, 0);
    expect(r.rounds).toBe(1);
    expect(r.outcomes.some((o) => !o.ok && !o.skipped)).toBe(true);
  });

  // A re-diff that cannot read the device leaves the residual unknowable, so the
  // loop ends and surfaces why rather than sending another round blind.
  it("stops and reports readErrors when a re-diff cannot read the device", async () => {
    installDevice({ stuckKey: "140:0:0" }); // forces a second round
    const realGet = vi.mocked(vdGet).getMockImplementation()!;
    let reads = 0;
    vi.mocked(vdGet).mockImplementation((id, x, y) => {
      // Fail once the first round's writes are done and the re-diff starts.
      if (++reads > 200 && id === 140) return Promise.reject(new Error("timeout"));
      return realGet(id, x, y);
    });
    const r = await sendConverging(model, dirtyPlan(), undefined, 3, 0);
    expect(r.readErrors.length).toBeGreaterThan(0);
    expect(r.rounds).toBeLessThan(3);
  });
});

describe("formatWriteReport", () => {
  // A write aborted on a read failure wrote nothing, so the report must not file
  // those under "Write failures" — the fetch report already models reads properly.
  it("reports read failures as their own category, not as write failures", () => {
    const md = formatWriteReport("URX44V", [], [], ["CH_FADER: timeout"]);
    expect(md).toContain("## Read failures");
    expect(md).toContain("CH_FADER: timeout");
    expect(md).toContain("nothing was written");
    expect(md).not.toContain("Write failures: 1");
  });

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

const cmpCmd = (name: string, paramId: number, vdValue: number) =>
  ({ name, paramId, x: 0, y: 1, vdValue }) as unknown as VdCommand;
const cmpEntry = (name: string, paramId: number, vdValue: number, device: number) => ({
  command: cmpCmd(name, paramId, vdValue),
  device,
  match: device === vdValue,
});

// One definition of the count rule, shared by the report and the status line.
describe("compareCounts", () => {
  it("counts compared and differ from the entries and returns the differing ones", () => {
    const { compared, differ, numDiffs, nameDiffs } = compareCounts(
      [cmpEntry("A", 1, 1, 1), cmpEntry("B", 2, 2, 9)],
      [{ write: { param: 18, y: 0, value: "x" }, device: "y", match: false }],
    );
    expect(compared).toBe(3);
    expect(differ).toBe(2);
    expect(numDiffs.map((e) => e.command.name)).toEqual(["B"]);
    expect(nameDiffs).toHaveLength(1);
  });
});

describe("formatCompareReport", () => {
  const entry = cmpEntry;

  // The point of the full log: an all-match comparison still lists every read, so
  // an instant "matches" is verifiable as N reads that agreed rather than zero.
  it("logs every parameter, matched or not, with a compared count", () => {
    const md = formatCompareReport("URX44V", [entry("CH1 FADER", 139, 800, 800), entry("CH1 PAN", 140, 512, 480)], []);
    expect(md).toContain("Compared 2 parameters: 1 match, 1 differ");
    expect(md).toContain("## Full log (every parameter compared)");
    expect(md).toContain("CH1 FADER @ 139:0:1 — plan 800, device 800 — match");
    expect(md).toContain("CH1 PAN @ 140:0:1 — plan 512, device 480 — DIFFER");
  });

  it("surfaces the mismatches up top before the full log", () => {
    const md = formatCompareReport("URX44V", [entry("CH1 PAN", 140, 512, 480)], []);
    expect(md.indexOf("## Differences (plan vs device)")).toBeLessThan(md.indexOf("## Full log"));
    expect(md).toContain("- CH1 PAN @ 140:0:1 — plan 512, device 480");
  });

  it("compares names against the device value", () => {
    const md = formatCompareReport(
      "URX44V",
      [],
      [{ write: { param: 18, y: 2, value: "Lead Vox" }, device: "ch 3", match: false }],
    );
    expect(md).toContain('name @ 18:2 — plan "Lead Vox", device "ch 3" — DIFFER');
  });

  // A read failure leaves the comparison incomplete, so it is its own section
  // rather than being folded into "matched".
  it("reports unreadable parameters as an incomplete comparison", () => {
    const md = formatCompareReport("URX44V", [entry("CH1 ON", 140, 1, 1)], [], ["CH_PAN: timeout"]);
    expect(md).toContain("1 match, 0 differ; 1 could not be read");
    expect(md).toContain("## Could not be read (comparison incomplete)");
    expect(md).toContain("CH_PAN: timeout");
  });
});
