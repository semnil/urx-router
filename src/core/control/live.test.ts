import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../../models";
import { emptyPlan, ensureFixedConnections, type Plan } from "../plan";

// LiveSync drives the device through platform.vdSet / vdSetStr and re-reads via
// vdGet on a converge; mock those. The point of these tests is the flush cadence
// (how many device writes a drag produces), so vdSet's call count is the metric.
vi.mock("../platform", () => ({ vdSet: vi.fn(), vdSetStr: vi.fn(), vdGet: vi.fn() }));

import { vdSet, vdGet } from "../platform";
import { planToCommands } from "./translate";
import { LiveSync } from "./live";

const model = getModel("URX44V");

function basePlan(): Plan {
  const plan = emptyPlan("URX44V");
  ensureFixedConnections(model, plan);
  return plan;
}

function liveFor(plan: Plan, refetchNodes?: (nodes: ReadonlySet<string>) => Promise<void>): LiveSync {
  return new LiveSync({
    getModel: () => model,
    getPlan: () => plan,
    onError: () => {},
    onSent: () => {},
    refetchNodes,
  });
}

// The ch1 main fader is its fixed STEREO send level (a connection param) — the
// exact path an inspector fader drag takes. Changing only the level diffs to the
// single CH_FADER address.
function setCh1Fader(plan: Plan, db: number): void {
  const conn = plan.connections.find((c) => c.from === "ch1:out");
  if (!conn) throw new Error("expected a ch1 STEREO send connection");
  conn.params = { ...conn.params, level: db };
}

beforeEach(() => {
  vi.mocked(vdSet).mockReset().mockResolvedValue(undefined);
  vi.mocked(vdGet).mockReset().mockResolvedValue(0);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("LiveSync flush cadence", () => {
  it("sends one write per settled change (the baseline)", async () => {
    const plan = basePlan();
    const live = liveFor(plan);
    live.begin();
    setCh1Fader(plan, -6);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    expect(vi.mocked(vdSet)).toHaveBeenCalledTimes(1);
  });

  it("tracks a continuous drag instead of waiting for it to stop", async () => {
    const plan = basePlan();
    const live = liveFor(plan);
    live.begin();
    // 30 input events ~16ms apart (a smooth ~480ms drag), every one of them inside
    // the 120ms window. A window that re-armed on each event never elapsed at all,
    // so the device heard nothing until the pointer stopped; the throttle flushes
    // at the end of each window instead.
    for (let i = 1; i <= 30; i++) {
      setCh1Fader(plan, -i);
      live.schedule();
      await vi.advanceTimersByTimeAsync(16);
    }
    expect(vi.mocked(vdSet).mock.calls.length).toBeGreaterThanOrEqual(3);
    // And the drag's final value still lands once it settles.
    await vi.advanceTimersByTimeAsync(120);
    const last = vi.mocked(vdSet).mock.calls.at(-1);
    expect(last?.[3]).toBe(-3000); // -30 dB in centi-dB
  });

  it("coalesces the events inside one window into a single write", async () => {
    const plan = basePlan();
    const live = liveFor(plan);
    live.begin();
    // Five events well inside one window: they reach the device as one write
    // carrying the last value, because the flush diffs the plan rather than
    // replaying the edits.
    for (let i = 1; i <= 5; i++) {
      setCh1Fader(plan, -i);
      live.schedule();
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(vi.mocked(vdSet)).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120);
    expect(vi.mocked(vdSet)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(vdSet).mock.calls[0][3]).toBe(-500); // -5 dB, the last of the five
  });

  it("sends each step when the drag pauses longer than the debounce", async () => {
    const plan = basePlan();
    const live = liveFor(plan);
    live.begin();
    // Five steps, each settling past the debounce before the next — a deliberate
    // "ride" rather than a smooth drag. Each settled value reaches the device.
    for (let i = 1; i <= 5; i++) {
      setCh1Fader(plan, -i);
      live.schedule();
      await vi.advanceTimersByTimeAsync(120);
    }
    expect(vi.mocked(vdSet)).toHaveBeenCalledTimes(5);
  });

  it("does not send when sync is inactive", async () => {
    const plan = basePlan();
    const live = liveFor(plan);
    // No begin(): schedule must be inert.
    setCh1Fader(plan, -6);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    expect(vi.mocked(vdSet)).not.toHaveBeenCalled();
  });
});

// Setting a mono channel's COMP/EQ type is a sideEffect param: its flush converges
// (re-reads + re-sends) against the device. An edit that lands during that awaited
// converge must not be lost.
function setCh1CompEqType(plan: Plan, type: number): void {
  plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, compEqType: type };
}

describe("LiveSync sideEffect converge", () => {
  it("goes back to waiting for quiet while flushes are converging", async () => {
    // A converge re-reads the whole write scope and settles between rounds, so
    // flushing once per window would chain converge rounds for as long as the drag
    // lasts. The EQ 1-knob level is exactly this case: a dragged slider on a
    // sideEffect param. After a converging flush the window re-arms again, which
    // is the pre-throttle behaviour, until a flush goes out without one.
    const plan = basePlan();
    const live = liveFor(plan);
    live.begin();
    setCh1CompEqType(plan, 1);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000); // let the converge finish
    const afterConverge = vi.mocked(vdSet).mock.calls.length;

    // Now a continuous stream on the same sideEffect param: nothing may go out
    // while it is in motion.
    for (let i = 0; i < 10; i++) {
      setCh1CompEqType(plan, i % 2);
      live.schedule();
      await vi.advanceTimersByTimeAsync(16);
    }
    expect(vi.mocked(vdSet).mock.calls.length).toBe(afterConverge);
  });

  it("does not silence an ordinary drag that merely follows a converge", async () => {
    // The back-off asks the pending diff, not "did the last flush converge". A
    // latch on history alone would put the next gesture — a plain fader drag after
    // flipping an insert FX or a signal type — back on the re-arming window and
    // send nothing until the pointer stopped, which is the behaviour the throttle
    // exists to remove.
    const plan = basePlan();
    const live = liveFor(plan);
    live.begin();
    setCh1CompEqType(plan, 1);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000); // the converge finishes
    const afterConverge = vi.mocked(vdSet).mock.calls.length;

    for (let i = 1; i <= 30; i++) {
      setCh1Fader(plan, -i);
      live.schedule();
      await vi.advanceTimersByTimeAsync(16);
    }
    expect(vi.mocked(vdSet).mock.calls.length).toBeGreaterThan(afterConverge + 2);
  });

  it("does not drop an edit that arrives during a sideEffect converge", async () => {
    const plan = basePlan();
    const live = liveFor(plan);
    live.begin();
    setCh1CompEqType(plan, 1);
    // The device mirrors the plan as it stands when the converge starts, so the
    // converge's initial diff is empty and it exits after one read pass (the exact
    // window where a late edit is at risk of being baked into the snapshot).
    const mirror = new Map(planToCommands(model, plan).map((c) => [`${c.paramId}:${c.x}:${c.y}`, c.vdValue]));
    // On the converge's first device read — after its command list was already
    // built, so this edit is NOT in the read pass — simulate a user moving the ch1
    // fader (-6 dB → encoded -600). With the frozen-copy converge it stays a diff
    // for the trailing flush; baking the live plan here would silently drop it.
    let injected = false;
    vi.mocked(vdGet).mockImplementation(async (paramId: number, x: number, y: number) => {
      if (!injected) {
        injected = true;
        setCh1Fader(plan, -6);
        live.schedule();
      }
      return mirror.get(`${paramId}:${x}:${y}`) ?? 0;
    });
    live.schedule();
    await vi.advanceTimersByTimeAsync(120); // fire the flush; the converge runs + exits
    await vi.advanceTimersByTimeAsync(2000); // drain the trailing flush
    // The fader value (-600) must have reached the device despite landing mid-converge.
    expect(vi.mocked(vdSet).mock.calls.some((c) => c[3] === -600)).toBe(true);
  });

  // sendConverging reports per-command failures rather than rejecting, so a write
  // that fails inside the converge would otherwise be swallowed — and the snapshot
  // would then claim the plan as device truth, leaving those params diverged with
  // no diff left to retry them. It must take the same teardown a direct write does.
  it("stops the session when a write inside the converge fails", async () => {
    const plan = basePlan();
    const errors: string[] = [];
    const live: LiveSync = new LiveSync({
      getModel: () => model,
      getPlan: () => plan,
      onError: (m) => errors.push(m),
      onSent: () => {},
    });
    live.begin();
    setCh1CompEqType(plan, 1);
    // Let the direct writes through, then fail every write the converge issues.
    let direct = true;
    vi.mocked(vdGet).mockResolvedValue(0);
    vi.mocked(vdSet).mockImplementation(() => (direct ? Promise.resolve() : Promise.reject(new Error("converge nak"))));
    const flushed = live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    direct = false;
    await vi.advanceTimersByTimeAsync(2000);
    void flushed;
    expect(errors).toHaveLength(1);
    expect(live.isActive()).toBe(false);
  });
});

describe("LiveSync flush error", () => {
  it("clears active before onError fires (the handler sees a stopped sync)", async () => {
    const plan = basePlan();
    let activeAtError: boolean | null = null;
    const live: LiveSync = new LiveSync({
      getModel: () => model,
      getPlan: () => plan,
      // The flush sets active = false before calling onError, so a handler that
      // guards on isActive() (deactivateLive) must not gate its teardown on it.
      onError: () => {
        activeAtError = live.isActive();
      },
      onSent: () => {},
    });
    vi.mocked(vdSet).mockRejectedValueOnce(new Error("device gone"));
    live.begin();
    setCh1Fader(plan, -6);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    expect(activeAtError).toBe(false);
    expect(live.isActive()).toBe(false);
  });
});

describe("LiveSync device-follow snapshot", () => {
  it("noteDirect patches one entry so a device-followed value is not re-sent", async () => {
    // The ch1 CH_FADER address + device value a -6 dB fader maps to.
    const probe = basePlan();
    setCh1Fader(probe, -6);
    const cmd = planToCommands(model, probe).find((c) => c.name === "CH_FADER" && c.node === "ch1");
    if (!cmd) throw new Error("expected a ch1 CH_FADER command");

    // Baseline: without noteDirect the change diffs from the factory snapshot and sends.
    const a = basePlan();
    const liveA = liveFor(a);
    liveA.begin();
    setCh1Fader(a, -6);
    liveA.schedule();
    await vi.advanceTimersByTimeAsync(120);
    expect(vi.mocked(vdSet)).toHaveBeenCalledTimes(1);

    vi.mocked(vdSet).mockClear();

    // With noteDirect patching the snapshot to the device value (the direct-follow
    // path), the same edit is already in agreement, so nothing is re-sent.
    const b = basePlan();
    const liveB = liveFor(b);
    liveB.begin();
    setCh1Fader(b, -6);
    liveB.noteDirect(cmd.paramId, cmd.x, cmd.y, cmd.vdValue);
    liveB.schedule();
    await vi.advanceTimersByTimeAsync(120);
    expect(vi.mocked(vdSet)).not.toHaveBeenCalled();
  });
});

// The EQ 1-knob is the other kind of side effect: the device recomputes the four band
// values, which the plan mirrors rather than authors. Pushing them back (a converge)
// would write the operator's stale manual curve over the device's own work, so the owner
// node is read instead — and the values the read brings in must not then read as pending
// edits on the next diff.
function setCh1OneKnob(plan: Plan, patch: { on?: boolean; level?: number }): void {
  plan.nodeParams.ch1 = {
    ...plan.nodeParams.ch1,
    eqOneKnob: { ...plan.nodeParams.ch1?.eqOneKnob, ...patch },
  };
}

describe("LiveSync sideEffect refetch", () => {
  it("reads the owner node back instead of converging", async () => {
    const plan = basePlan();
    const refetched: string[][] = [];
    const live = liveFor(plan, async (nodes) => {
      refetched.push([...nodes]);
    });
    live.begin();
    setCh1OneKnob(plan, { on: true });
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);

    expect(refetched).toEqual([["ch1"]]);
    // A converge would have read the whole write scope through vdGet; a refetch reads
    // through the caller's readback instead, so nothing here does.
    expect(vi.mocked(vdGet)).not.toHaveBeenCalled();
  });

  it("does not write the refetched values straight back", async () => {
    const plan = basePlan();
    // The readback stands in for the device recomputing the bands: it writes values into
    // the plan that the app never asked for.
    const live = liveFor(plan, async () => {
      plan.nodeParams.ch1 = {
        ...plan.nodeParams.ch1,
        eqBands: [{ on: true, type: 1, freq: 140, q: 0.71, gain: 0 }],
      };
    });
    live.begin();
    setCh1OneKnob(plan, { on: true });
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);
    const afterRefetch = vi.mocked(vdSet).mock.calls.length;

    // Nothing has changed in the plan since, so the next flush must send nothing. Without
    // re-basing the snapshot after the read, every band value the device computed would
    // go out as an edit.
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    expect(vi.mocked(vdSet).mock.calls.length).toBe(afterRefetch);
  });

  it("keeps flushing on cadence through a 1-knob level drag", async () => {
    // A refetch is one read of one node, not a converge round over the write scope, so
    // the window does not have to back off — which is the whole point of the split: the
    // level is a dragged slider, and it was the case that made every drag on it wait for
    // the pointer to stop.
    const plan = basePlan();
    const live = liveFor(plan, async () => {});
    live.begin();
    setCh1OneKnob(plan, { on: true, level: 0 });
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(500);
    const before = vi.mocked(vdSet).mock.calls.length;

    for (let i = 1; i <= 10; i++) {
      setCh1OneKnob(plan, { level: i * 8 });
      live.schedule();
      await vi.advanceTimersByTimeAsync(130);
    }
    expect(vi.mocked(vdSet).mock.calls.length).toBeGreaterThan(before + 5);
  });
});
