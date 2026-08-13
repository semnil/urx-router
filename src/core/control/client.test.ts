import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../../models";
import { emptyPlan, ensureFixedConnections, type Plan } from "../plan";

// client.ts drives the device through platform.vdGet / vdSet (numbers) and
// vdGetStr / vdSetStr (the CH SETTING names), so mock those four: the rest of
// platform.ts (file IO, dialogs) is untouched here.
vi.mock("../platform", () => ({ vdGet: vi.fn(), vdSet: vi.fn(), vdGetStr: vi.fn(), vdSetStr: vi.fn() }));

import { vdGet, vdGetStr, vdSet, vdSetStr } from "../platform";
import {
  compareCounts,
  compareNames,
  comparePlan,
  diffNames,
  diffPlan,
  dryRun,
  formatCompareReport,
  formatWriteReport,
  rateAction,
  readClockState,
  readFollowUsb,
  sendCommands,
  sendConverging,
  sendNames,
  setFollowUsb,
} from "./client";
import { planToCommands, planToNameWrites, type VdCommand } from "./translate";
import { NODE_NAME_MAX_CHARS, PARAMS, PORT_REF_PARAM_IDS as PORT_REF_PARAMS } from "./params";
import { PORT_REF_NONE } from "./vd";

const model = getModel("URX44V");

function basePlan(): Plan {
  const plan = emptyPlan("URX44V");
  ensureFixedConnections(model, plan);
  return plan;
}

// A plan that actually implies name writes: an unnamed node emits none.
function namedPlan(): Plan {
  const plan = basePlan();
  for (const node of model.nodes) plan.nodeNames[node.id] = `N-${node.id}`;
  return plan;
}

const aborted = (): AbortSignal => AbortSignal.abort();

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
  vi.mocked(vdGetStr).mockReset();
  vi.mocked(vdSetStr).mockReset();
});

describe("clock state", () => {
  // Both halves decide whether a rate write can stick, so the read is one call
  // that either answers or rejects — a partial answer is the failure it prevents.
  it("reads the Follow USB policy and the running rate together", async () => {
    vi.mocked(vdGet).mockImplementation((id) =>
      Promise.resolve(id === PARAMS.FOLLOW_USB.id ? 1 : id === PARAMS.SAMPLE_RATE.id ? 48000 : 0),
    );
    expect(await readClockState()).toEqual({ followUsb: true, sampleRate: 48000 });
  });

  it("reports Follow USB off as false rather than the raw value", async () => {
    vi.mocked(vdGet).mockResolvedValue(0);
    expect(await readClockState()).toEqual({ followUsb: false, sampleRate: 0 });
    expect(await readFollowUsb()).toBe(false);
  });

  it("treats any non-zero Follow USB value as on", async () => {
    vi.mocked(vdGet).mockResolvedValue(2);
    expect(await readFollowUsb()).toBe(true);
  });

  it("rejects rather than reporting half a clock state when the rate read fails", async () => {
    vi.mocked(vdGet).mockImplementation((id) =>
      id === PARAMS.FOLLOW_USB.id ? Promise.resolve(1) : Promise.reject(new Error("timeout")),
    );
    await expect(readClockState()).rejects.toThrow("timeout");
  });

  it("rejects when the policy read fails, without reading the rate", async () => {
    vi.mocked(vdGet).mockRejectedValue(new Error("timeout"));
    await expect(readClockState()).rejects.toThrow("timeout");
    expect(vi.mocked(vdGet)).toHaveBeenCalledTimes(1);
  });

  it("writes Follow USB as 1 / 0 on its own address", async () => {
    vi.mocked(vdSet).mockResolvedValue(undefined);
    await setFollowUsb(true);
    await setFollowUsb(false);
    expect(vi.mocked(vdSet).mock.calls).toEqual([
      [PARAMS.FOLLOW_USB.id, 0, 0, 1],
      [PARAMS.FOLLOW_USB.id, 0, 0, 0],
    ]);
  });

  it("propagates a failed Follow USB write rather than reporting success", async () => {
    vi.mocked(vdSet).mockRejectedValue(new Error("nak"));
    await expect(setFollowUsb(true)).rejects.toThrow("nak");
  });

  // The matrix the rate three-way prompt is built from.
  it("decides what a rate write must settle before it is sent", () => {
    expect(rateAction(48000, { followUsb: false, sampleRate: 48000 })).toBe("proceed");
    expect(rateAction(48000, { followUsb: true, sampleRate: 48000 })).toBe("proceed");
    expect(rateAction(96000, { followUsb: false, sampleRate: 48000 })).toBe("confirmReclock");
    expect(rateAction(96000, { followUsb: true, sampleRate: 48000 })).toBe("askChoice");
  });
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
    const stopped = await diffPlan(model, plan, { stopOnError: true });
    expect(stopped.errors).toHaveLength(1);
    expect(all.errors.length).toBeGreaterThan(1);
  });
});

describe("sendCommands", () => {
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
    const r = await sendConverging(model, dirtyPlan(), { settleMs: 0 });
    expect(r.rounds).toBe(1);
    expect(r.residual).toEqual([]);
  });

  it("re-sends and converges a param the device drops on the first write", async () => {
    // CH_ON (140:0:0) is accepted only on its second write.
    installDevice({ stuckKey: "140:0:0", stickAfter: 2 });
    const r = await sendConverging(model, dirtyPlan(), { settleMs: 0 });
    expect(r.rounds).toBe(2);
    expect(r.residual).toEqual([]);
  });

  it("gives up after maxRounds and reports the residual for a stuck param", async () => {
    installDevice({ stuckKey: "140:0:0" }); // never sticks
    const r = await sendConverging(model, dirtyPlan(), { settleMs: 0 });
    expect(r.rounds).toBe(3);
    expect(r.residual.some((d) => d.command.paramId === 140)).toBe(true);
  });

  // Re-sending the whole plan over a link that just failed would re-trigger the
  // side-effect resets this loop exists to settle, so one round is all it does.
  it("stops after a round that failed to send instead of retrying", async () => {
    installDevice();
    vi.mocked(vdSet).mockRejectedValue(new Error("link down"));
    const r = await sendConverging(model, dirtyPlan(), { settleMs: 0 });
    expect(r.rounds).toBe(1);
    expect(r.outcomes.some((o) => !o.ok && !o.skipped)).toBe(true);
  });

  // The EQ 1-knob reset chain, measured on a URX44V: an OFF->ON transition discards
  // the type back to Intensity, and a type write discards the level to that type's
  // neutral. A round that re-sends only what differs walks the chain one link per
  // round — ON, then the type it just discarded, then the level that discarded —
  // and a 3-round budget runs out with the level still wrong. The chain travels as
  // one group, so a single round lands all three.
  it("re-sends a reset chain whole rather than one link per round", async () => {
    const table = installDevice();
    const inner = vi.mocked(vdSet).getMockImplementation()!;
    vi.mocked(vdSet).mockImplementation(async (id, x, y, v) => {
      const wasOn = table.get(`46:${x}:${y}`) ?? 0;
      await inner(id, x, y, v);
      if (id === 46 && v === 1 && wasOn !== 1) table.set(`47:${x}:${y}`, 0);
      if (id === 47) table.set(`48:${x}:${y}`, 0);
    });
    // The device already holds the type and level the plan wants, with 1-knob off:
    // only the ON differs, which is exactly the state a round-1 bank reset leaves.
    table.set("47:0:0", 2);
    table.set("48:0:0", 11);
    const plan = dirtyPlan();
    plan.nodeParams["ch1"] = { ...plan.nodeParams["ch1"], eqOneKnob: { on: true, type: 2, level: 11 } };

    const r = await sendConverging(model, plan, { settleMs: 0 });
    expect(r.residual).toEqual([]);
    expect(r.rounds).toBe(1);
    expect([table.get("46:0:0"), table.get("47:0:0"), table.get("48:0:0")]).toEqual([1, 2, 11]);
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
    const r = await sendConverging(model, dirtyPlan(), { settleMs: 0 });
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

  // Both shapes are "it failed and said nothing": an outcome carrying no error at
  // all, and one carrying an empty message — which is what a rejection with no
  // reason leaves behind, and which used to print a bare dash.
  it("falls back to a generic reason for a failure that named none", () => {
    expect(formatWriteReport("URX44V", [{ name: "CH2 EQ" }], [])).toContain("- CH2 EQ — unknown error");
    expect(formatWriteReport("URX44V", [{ name: "CH2 EQ", error: "" }], [])).toContain("- CH2 EQ — unknown error");
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

  // An address more than one node writes was compared against the surviving
  // node's value only — the others' plan values are on no address of their own,
  // so a "matches" there means less than it reads.
  it("names the nodes a shared address dropped", () => {
    const shared = entry("INSERT_FX_EFFECT", 689, -1500, -1500);
    shared.command.node = "ch2";
    shared.command.shadowed = ["ch1"];
    const md = formatCompareReport("URX44V", [shared], []);
    expect(md).toContain("1 match, 0 differ; 1 shared by more than one node");
    expect(md).toContain("## Shared device settings (one address, more than one node)");
    expect(md).toContain("- INSERT_FX_EFFECT @ 689:0:1 — kept ch2, dropped ch1");
  });

  it("omits the shared section when no address has more than one node", () => {
    const md = formatCompareReport("URX44V", [entry("CH1 PAN", 140, 512, 512)], []);
    expect(md).not.toContain("## Shared device settings");
    expect(md).not.toContain("shared by more than one node");
  });
});

describe("cancellation", () => {
  // Every sweep over the device checks the signal per command, so a cancel takes
  // effect within one round trip instead of after the whole plan.
  it("stops a read sweep before the first round trip", async () => {
    await expect(diffPlan(model, basePlan(), { signal: aborted() })).rejects.toThrow();
    expect(vi.mocked(vdGet)).not.toHaveBeenCalled();
  });

  it("stops a write sweep before the first round trip", async () => {
    await expect(sendCommands(planToCommands(model, basePlan()), aborted())).rejects.toThrow();
    expect(vi.mocked(vdSet)).not.toHaveBeenCalled();
  });

  it("stops a comparison before the first round trip", async () => {
    await expect(comparePlan(model, basePlan(), aborted())).rejects.toThrow();
    expect(vi.mocked(vdGet)).not.toHaveBeenCalled();
  });

  it("stops a sweep partway once the signal fires", async () => {
    const ctl = new AbortController();
    let reads = 0;
    vi.mocked(vdGet).mockImplementation(() => {
      if (++reads === 3) ctl.abort();
      return Promise.resolve(0);
    });
    await expect(diffPlan(model, basePlan(), { signal: ctl.signal })).rejects.toThrow();
    expect(reads).toBe(3);
  });

  // The converge loop re-checks between rounds, so a cancel does not buy another
  // full re-send of the plan.
  it("stops the converge loop between rounds", async () => {
    const ctl = new AbortController();
    const plan = basePlan();
    const commands = planToCommands(model, plan);
    vi.mocked(vdGet).mockResolvedValue(-1);
    vi.mocked(vdSet).mockImplementation(() => {
      ctl.abort();
      return Promise.resolve();
    });
    await expect(
      sendConverging(model, plan, {
        initialDiffs: [{ command: commands[0], current: -1 }],
        settleMs: 0,
        signal: ctl.signal,
      }),
    ).rejects.toThrow();
  });
});

// The emit site is where `boundRaw` bounds the numeric leaves, and it is the one
// place every name passes on the way to the wire. The load funnel and the rename
// bound their own inputs, but a name also reaches the plan from a device read
// (`readback`) and from a rename made on the unit's own LCD, neither of which goes
// through either — so a plan holding an over-long name must still not emit one.
describe("planToNameWrites bounds what reaches the wire", () => {
  it("cuts a name no gate upstream of it happened to bound", () => {
    const plan = namedPlan();
    // `namedPlan` names every node, but only some carry a name control — so take the
    // target from what the emit actually writes rather than from the plan's keys.
    const carried = planToNameWrites(model, plan)[0].value;
    const target = Object.keys(plan.nodeNames).find((id) => plan.nodeNames[id] === carried)!;
    plan.nodeNames[target] = "あ".repeat(200);
    const writes = planToNameWrites(model, plan);
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect([...w.value].length).toBeLessThanOrEqual(NODE_NAME_MAX_CHARS);
    // Cut on a code-point boundary, so the wire never carries half a character.
    expect(writes.find((w) => w.value.startsWith("あ"))!.value).toBe("あ".repeat(NODE_NAME_MAX_CHARS));
  });
});

describe("diffNames", () => {
  it("keeps only the names the device does not already have", async () => {
    const plan = namedPlan();
    const writes = planToNameWrites(model, plan);
    expect(writes.length).toBeGreaterThan(1);
    // The device agrees with everything but the first name.
    vi.mocked(vdGetStr).mockImplementation((param, _x, y) =>
      Promise.resolve(
        param === writes[0].param && y === writes[0].y
          ? "something else"
          : (writes.find((w) => w.param === param && w.y === y)?.value ?? ""),
      ),
    );
    const { writes: out, errors } = await diffNames(model, plan);
    expect(errors).toEqual([]);
    expect(out).toEqual([writes[0]]);
  });

  it("reports nothing to write when every name already matches", async () => {
    const plan = namedPlan();
    const writes = planToNameWrites(model, plan);
    vi.mocked(vdGetStr).mockImplementation((param, _x, y) =>
      Promise.resolve(writes.find((w) => w.param === param && w.y === y)?.value ?? ""),
    );
    expect(await diffNames(model, plan)).toEqual({ writes: [], errors: [] });
  });

  // The device pads a name out to its field width; a plan name that fits is not a
  // difference just because the device stores it with trailing blanks.
  it("compares against the device value with its padding trimmed", async () => {
    const plan = namedPlan();
    const writes = planToNameWrites(model, plan);
    vi.mocked(vdGetStr).mockImplementation((param, _x, y) => {
      const value = writes.find((w) => w.param === param && w.y === y)?.value ?? "";
      return Promise.resolve(`${value}    `);
    });
    expect((await diffNames(model, plan)).writes).toEqual([]);
  });

  // The other side of that trim, and the one that could not converge. The trim above
  // is one-sided, so it only closes the gap when the PLAN side is clean — and a name
  // ending in a space survived every gate into the plan. The device does not settle it
  // either: measured on a URX44V (2026-08-14), `"SPCTEST "` is stored and read back
  // unchanged rather than padded away. So the comparison differed on every sync and
  // re-sent the name forever, invisibly — each round reports one write and succeeds at
  // it, and the two names render identically wherever they are shown.
  it("does not re-send a name forever because the plan side carried the padding", async () => {
    const plan = namedPlan();
    for (const id of Object.keys(plan.nodeNames)) plan.nodeNames[id] += " ";
    const writes = planToNameWrites(model, plan);
    expect(writes.length).toBeGreaterThan(0);
    // Nothing leaves for the wire still carrying it — that value is what the device
    // then holds, and what the trimmed read is compared against.
    for (const w of writes) expect(w.value).toBe(w.value.trimEnd());
    // The device holds exactly what emit sent it.
    vi.mocked(vdGetStr).mockImplementation((param, _x, y) =>
      Promise.resolve(writes.find((w) => w.param === param && w.y === y)?.value ?? ""),
    );
    expect((await diffNames(model, plan)).writes).toEqual([]);
  });

  // Matching diffPlan: an unreadable name is reported and left out, so the caller
  // aborts rather than writing over a name it could not read.
  it("leaves an unreadable name out of the writes and records the error", async () => {
    const plan = namedPlan();
    const writes = planToNameWrites(model, plan);
    vi.mocked(vdGetStr).mockImplementation((param, _x, y) =>
      param === writes[0].param && y === writes[0].y
        ? Promise.reject(new Error("timeout"))
        : Promise.resolve("something else"),
    );
    const { writes: out, errors } = await diffNames(model, plan);
    expect(errors).toEqual([`name ${writes[0].param}:${writes[0].y}: timeout`]);
    expect(out).toHaveLength(writes.length - 1);
    expect(out).not.toContainEqual(writes[0]);
  });

  it("renders a non-Error rejection as a string rather than [object Object]", async () => {
    const plan = namedPlan();
    const writes = planToNameWrites(model, plan);
    vi.mocked(vdGetStr).mockRejectedValue("link-down");
    const { errors } = await diffNames(model, plan);
    expect(errors).toHaveLength(writes.length);
    expect(errors[0]).toBe(`name ${writes[0].param}:${writes[0].y}: link-down`);
  });

  it("reads nothing for a plan that names no node", async () => {
    expect(await diffNames(model, basePlan())).toEqual({ writes: [], errors: [] });
    expect(vi.mocked(vdGetStr)).not.toHaveBeenCalled();
  });
});

describe("sendNames", () => {
  it("writes every name through the string transport", async () => {
    vi.mocked(vdSetStr).mockResolvedValue(undefined);
    const writes = planToNameWrites(model, namedPlan());
    const outcomes = await sendNames(writes);
    expect(outcomes).toHaveLength(writes.length);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(vi.mocked(vdSetStr).mock.calls[0]).toEqual([writes[0].param, 0, writes[0].y, writes[0].value]);
  });

  // Names are idempotent and independent, so unlike sendCommands a failure does
  // not stop the rest: the write that failed is the only one reported failed.
  it("continues past a failure rather than skipping the rest", async () => {
    const writes = planToNameWrites(model, namedPlan());
    vi.mocked(vdSetStr).mockImplementation((param, _x, y) =>
      param === writes[0].param && y === writes[0].y ? Promise.reject(new Error("nak")) : Promise.resolve(),
    );
    const outcomes = await sendNames(writes);
    expect(outcomes[0]).toEqual({ write: writes[0], ok: false, error: "nak" });
    expect(outcomes.slice(1).every((o) => o.ok)).toBe(true);
    expect(vi.mocked(vdSetStr)).toHaveBeenCalledTimes(writes.length);
  });

  it("renders a non-Error rejection as a string", async () => {
    vi.mocked(vdSetStr).mockRejectedValue("link-down");
    const [outcome] = await sendNames(planToNameWrites(model, namedPlan()));
    expect(outcome.error).toBe("link-down");
  });

  it("writes nothing when there is nothing to write", async () => {
    expect(await sendNames([])).toEqual([]);
    expect(vi.mocked(vdSetStr)).not.toHaveBeenCalled();
  });
});

describe("comparePlan", () => {
  // A comparison that returns "matches" instantly is otherwise indistinguishable
  // from one that read nothing, so every parameter is kept — matched or not.
  it("keeps every parameter it read, not only the mismatches", async () => {
    const plan = basePlan();
    const table = deviceTableFor(plan);
    vi.mocked(vdGet).mockImplementation((id, x, y) => Promise.resolve(table.get(`${id}:${x}:${y}`) ?? 0));
    const { entries, errors } = await comparePlan(model, plan);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(planToCommands(model, plan).length);
    expect(entries.every((e) => e.match)).toBe(true);
  });

  it("records the device's value beside the plan's on a mismatch", async () => {
    const plan = basePlan();
    const target = planToCommands(model, plan)[0];
    const table = deviceTableFor(plan);
    vi.mocked(vdGet).mockImplementation((id, x, y) => {
      const k = `${id}:${x}:${y}`;
      return Promise.resolve(k === `${target.paramId}:${target.x}:${target.y}` ? 12345 : (table.get(k) ?? 0));
    });
    const { entries } = await comparePlan(model, plan);
    const mismatch = entries.filter((e) => !e.match);
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0].device).toBe(12345);
    expect(mismatch[0].command.vdValue).toBe(target.vdValue);
  });

  // Reads all — no stopOnError — so one dead parameter does not truncate the audit,
  // and "matched" stays distinct from "could not be read".
  it("collects a read failure and keeps sweeping the rest", async () => {
    const plan = basePlan();
    const commands = planToCommands(model, plan);
    const table = deviceTableFor(plan);
    vi.mocked(vdGet).mockImplementation((id, x, y) =>
      id === commands[0].paramId && x === commands[0].x && y === commands[0].y
        ? Promise.reject(new Error("timeout"))
        : Promise.resolve(table.get(`${id}:${x}:${y}`) ?? 0),
    );
    const { entries, errors } = await comparePlan(model, plan);
    expect(errors).toEqual([`${commands[0].name}: timeout`]);
    expect(entries).toHaveLength(commands.length - 1);
    expect(vi.mocked(vdGet)).toHaveBeenCalledTimes(commands.length);
  });

  it("renders a non-Error rejection as a string", async () => {
    vi.mocked(vdGet).mockRejectedValue("link-down");
    const { entries, errors } = await comparePlan(model, basePlan());
    expect(entries).toEqual([]);
    expect(errors[0]).toContain(": link-down");
  });
});

describe("compareNames", () => {
  it("keeps every name it read, matched or not, with the device's value", async () => {
    const plan = namedPlan();
    const writes = planToNameWrites(model, plan);
    vi.mocked(vdGetStr).mockImplementation((param, _x, y) =>
      Promise.resolve(
        param === writes[0].param && y === writes[0].y
          ? "DEVICE"
          : `${writes.find((w) => w.param === param && w.y === y)?.value ?? ""}  `,
      ),
    );
    const { entries, errors } = await compareNames(model, plan);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(writes.length);
    expect(entries[0]).toEqual({ write: writes[0], device: "DEVICE", match: false });
    expect(entries.slice(1).every((e) => e.match)).toBe(true);
  });

  it("collects a read failure and keeps sweeping the rest", async () => {
    const plan = namedPlan();
    const writes = planToNameWrites(model, plan);
    vi.mocked(vdGetStr).mockImplementation((param, _x, y) =>
      param === writes[0].param && y === writes[0].y ? Promise.reject(new Error("timeout")) : Promise.resolve(""),
    );
    const { entries, errors } = await compareNames(model, plan);
    expect(errors).toEqual([`name ${writes[0].param}:${writes[0].y}: timeout`]);
    expect(entries).toHaveLength(writes.length - 1);
  });

  it("renders a non-Error rejection as a string", async () => {
    vi.mocked(vdGetStr).mockRejectedValue("link-down");
    const { errors } = await compareNames(model, namedPlan());
    expect(errors[0]).toContain(": link-down");
  });

  it("reads nothing for a plan that names no node", async () => {
    expect(await compareNames(model, basePlan())).toEqual({ entries: [], errors: [] });
    expect(vi.mocked(vdGetStr)).not.toHaveBeenCalled();
  });
});
