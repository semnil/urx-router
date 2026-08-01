import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../../models";
import { emptyPlan, ensureFixedConnections, type Plan } from "../plan";
import { clonePlanState } from "../plan-history";

// LiveSync drives the device through platform.vdSet / vdSetStr and re-reads via
// vdGet on a converge; mock those. The point of these tests is the flush cadence
// (how many device writes a drag produces), so vdSet's call count is the metric.
vi.mock("../platform", () => ({ vdSet: vi.fn(), vdSetStr: vi.fn(), vdGet: vi.fn() }));

import { vdSet, vdSetStr, vdGet } from "../platform";
import { planToCommands } from "./translate";
import type { SharedOwners } from "./translate";
import { LiveSync } from "./live";

const model = getModel("URX44V");

function basePlan(): Plan {
  const plan = emptyPlan("URX44V");
  ensureFixedConnections(model, plan);
  return plan;
}

// The refetch hook resolves the private copy its read ran against (readback.readIntoPlan)
// — what the device holds as far as the read established it. Returning null stands for
// "no re-base": either the plan it read into is gone, or the case does not exercise one.
function liveFor(plan: Plan, refetchNodes?: (nodes: ReadonlySet<string>) => Promise<Plan | null>): LiveSync {
  return new LiveSync({
    getModel: () => model,
    getPlan: () => plan,
    onError: () => {},
    onSent: () => {},
    onCollapsed: () => {},
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
      onCollapsed: () => {},
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
      onCollapsed: () => {},
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

// A direct-follow notify and a device read overlap constantly while a session is up: a
// reconcile of one node runs for hundreds of milliseconds, and the operator's other hand
// is on the board. The re-base rebuilds the whole snapshot from the copy the read ran
// against — which was cloned when the read was ISSUED, and so cannot carry what the
// device said afterwards.
describe("LiveSync direct-follow journal across a read", () => {
  /** The ch1 CH_ON command at a given state, for its address and its two raw values. */
  function ch1OnCmd(on: boolean) {
    const probe = basePlan();
    probe.nodeParams.ch1 = { ...probe.nodeParams.ch1, on };
    const cmd = planToCommands(model, probe).find((c) => c.name === "CH_ON" && c.node === "ch1");
    if (!cmd) throw new Error("expected a ch1 CH_ON command");
    return cmd;
  }

  it("restores a notify the read's copy predates, instead of fighting the operator", async () => {
    const unmuted = ch1OnCmd(true);
    const muted = ch1OnCmd(false);
    const plan = basePlan();
    // The session starts in agreement: ch1 explicitly on, and the device says so too.
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, on: true };
    const live = liveFor(plan);
    live.begin(clonePlanState(plan));

    // (1) A knob turn on ch4 settles into a scoped reconcile; the read clones the plan
    // as it stands now, and the mark is taken beside it.
    const since = live.directMark();
    const deviceView = clonePlanState(plan);

    // (2) The operator MUTEs ch1 on the hardware while that read is in flight. Follow
    // decodes it straight into the plan and patches the one snapshot entry.
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, on: false };
    live.noteDirect(muted.paramId, muted.x, muted.y, muted.vdValue);

    // (3) The read resolves with ch4's value, which the merge puts into both the plan
    // and the copy it read into. Nothing in it knows about ch1.
    deviceView.nodeParams.ch4 = { ...deviceView.nodeParams.ch4, gain: 30 };
    plan.nodeParams.ch4 = { ...plan.nodeParams.ch4, gain: 30 };
    live.resync(deviceView, since);

    // (4) The operator un-mutes ch1 on the hardware. A snapshot rebuilt from the copy
    // alone claims the channel was never muted, so this notify equals it and follow
    // drops it as our own echo — the plan then keeps the mute the operator lifted.
    expect(live.isEcho(unmuted.paramId, unmuted.x, unmuted.y, unmuted.vdValue)).toBe(false);

    // (5) …and with nothing else pending, the flush must send nothing. Against a stale
    // snapshot entry the plan's mute reads as an unsent edit, and the next window
    // re-mutes the channel on the unit.
    vi.mocked(vdSet).mockClear();
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    expect(vi.mocked(vdSet)).not.toHaveBeenCalled();
  });

  it("lets the read's own value stand over a notify it was issued after", async () => {
    const unmuted = ch1OnCmd(true);
    const muted = ch1OnCmd(false);
    const plan = basePlan();
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, on: true };
    const live = liveFor(plan);
    live.begin(clonePlanState(plan));

    // The mute lands BEFORE the read is issued, so the read sees it and can supersede
    // it: the operator lifted the mute again while the read was on its way to ch1.
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, on: false };
    live.noteDirect(muted.paramId, muted.x, muted.y, muted.vdValue);

    const since = live.directMark();
    const deviceView = clonePlanState(plan);
    deviceView.nodeParams.ch1 = { ...deviceView.nodeParams.ch1, on: true };
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, on: true };
    live.resync(deviceView, since);

    // The journal entry is older than the read, so the read wins: the un-muted value is
    // device truth, and the next notify carrying it is an echo.
    expect(live.isEcho(unmuted.paramId, unmuted.x, unmuted.y, unmuted.vdValue)).toBe(true);
    vi.mocked(vdSet).mockClear();
    live.schedule();
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
      return null;
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
      // What readIntoPlan hands back: the copy the read ran against, carrying the read's
      // own values. Nothing else moved here, so it equals the plan.
      return clonePlanState(plan);
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

  // The re-base takes VALUES from the copy the read ran against and SHAPE from the live
  // plan. These three are the three things that split decides.
  it("sends an edit made during the refetch, because the device view does not carry it", async () => {
    const plan = basePlan();
    setCh1Fader(plan, -20);
    const live = liveFor(plan, async () => {
      // What the read established: the device's own values, sampled before the gesture
      // below exists. The 1-knob write happened, the fader is still where it was.
      const view = clonePlanState(plan);
      // The operator moves the fader while the read is in flight.
      setCh1Fader(plan, 0);
      return view;
    });
    live.begin();
    setCh1OneKnob(plan, { on: true });
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);

    const fader = planToCommands(model, plan).find((c) => c.name === "CH_FADER" && c.y === 0)!;
    vi.mocked(vdSet).mockClear();
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    // Snapshotting the LIVE plan would have recorded 0 dB as a value the device was
    // given, and no later diff could ever see it again.
    expect(vi.mocked(vdSet)).toHaveBeenCalledWith(fader.paramId, fader.x, fader.y, fader.vdValue);
  });

  it("treats an address that only exists in the live plan as a pending write, not device truth", async () => {
    const plan = basePlan();
    let view: Plan | null = null;
    const live = liveFor(plan, async () => {
      // The read's copy predates the insert-FX selection the operator makes below, and
      // that selector is what binds the engine's parameter array — so the array's
      // addresses exist in the live plan and not in the copy.
      view = clonePlanState(plan);
      plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, insertFx: 3, insertFxOn: true };
      return view;
    });
    live.begin();
    setCh1OneKnob(plan, { on: true });
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);

    const addrOf = (c: { paramId: number; x: number; y: number }): string => `${c.paramId}:${c.x}:${c.y}`;
    const seen = new Set(planToCommands(model, view!).map(addrOf));
    const grown = planToCommands(model, plan).filter((c) => !seen.has(addrOf(c)));
    // The premise, stated rather than assumed: the gesture really did add addresses the
    // read never saw. Without it the rest of this case would pass on nothing.
    expect(grown.length).toBeGreaterThan(0);
    // Registered for notifies (shape follows the live plan)…
    expect(new Set(live.writableAddrs().map((a) => a.join(":"))).has(addrOf(grown[0]))).toBe(true);
    // …and still owed to the device, because the read never saw it.
    vi.mocked(vdSet).mockClear();
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    const sent = new Set(vi.mocked(vdSet).mock.calls.map(([id, x, y]) => `${id}:${x}:${y}`));
    expect(sent.has(addrOf(grown[0]))).toBe(true);
  });

  it("records a name the refetch read from the device instead of re-sending it", async () => {
    const plan = basePlan();
    const live = liveFor(plan, async () => {
      // A scoped read DOES carry names (nameControl is gated only by the node filter),
      // so a device-side rename lands in the plan and in the view together.
      plan.nodeNames = { ...plan.nodeNames, ch1: "VOX" };
      return clonePlanState(plan);
    });
    live.begin();
    setCh1OneKnob(plan, { on: true });
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);

    vi.mocked(vdSetStr).mockClear();
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    expect(vi.mocked(vdSetStr)).not.toHaveBeenCalled();
  });

  it("keeps flushing on cadence through a 1-knob level drag", async () => {
    // A refetch is one read of one node, not a converge round over the write scope, so
    // the window does not have to back off — which is the whole point of the split: the
    // level is a dragged slider, and it was the case that made every drag on it wait for
    // the pointer to stop.
    const plan = basePlan();
    // Null: this case measures the flush cadence, not the re-base.
    const live = liveFor(plan, async () => null);
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

// Two nodes holding the same insert-FX family write ONE engine array (no channel
// axis), so the emitted set collapses the repeated address to its last command.
// The flush says so once per owner set — the loss is a salvage, and a silent
// salvage is what the repo rule forbids.
describe("LiveSync shared device address", () => {
  const ENGINE = 689;
  const SLOT = 6;
  function setCompander(plan: Plan, nodeId: string, selector: number, threshold: number): void {
    plan.nodeParams[nodeId] = { ...plan.nodeParams[nodeId], insertFx: selector, insertFxParams: { "6": threshold } };
  }
  function collidingLive(plan: Plan): { live: LiveSync; reports: SharedOwners[][] } {
    const reports: SharedOwners[][] = [];
    const live = new LiveSync({
      getModel: () => model,
      getPlan: () => plan,
      onError: () => {},
      onSent: () => {},
      onCollapsed: (owners) => reports.push(owners),
    });
    return { live, reports };
  }
  const engineWrites = (): number[] =>
    vi
      .mocked(vdSet)
      .mock.calls.filter((c) => c[0] === ENGINE && c[2] === SLOT)
      .map((c) => c[3]);

  it("sends one write to the shared address and names the owners once", async () => {
    const plan = basePlan();
    // Both selectors already on the device (the only route into this state is a
    // readback), so the flush below carries no selector and no converge round.
    setCompander(plan, "ch1", 1793, -1000);
    setCompander(plan, "ch2", 1794, -1500);
    const { live, reports } = collidingLive(plan);
    live.begin();

    setCompander(plan, "ch2", 1794, -1600);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    expect(engineWrites()).toEqual([-1600]);
    expect(reports).toEqual([[{ kept: "ch2", dropped: ["ch1"] }]]);

    // The same owners on the next flush: latched, so an unrelated edit does not
    // repeat the sentence.
    vi.mocked(vdSet).mockClear();
    setCh1Fader(plan, -6);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    expect(engineWrites()).toEqual([]);
    expect(reports).toHaveLength(1);
  });

  it("re-arms on a device re-base, which runs no flush of its own", async () => {
    const plan = basePlan();
    setCompander(plan, "ch1", 1793, -1000);
    setCompander(plan, "ch2", 1794, -1500);
    const { live, reports } = collidingLive(plan);
    live.begin();
    setCompander(plan, "ch2", 1794, -1600);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    expect(reports).toHaveLength(1);

    // What device follow ACTUALLY does, as opposed to the case below: a reconcile reads
    // the one shared address and assigns it to both owners, erasing the divergence, then
    // re-bases through resync(). It runs no flush — the follow funnel is
    // planValuesChanged, which unlike markChanged does not schedule one — so a latch that
    // only clears inside flush() stays set, and the operator's next loss of this same
    // pair is swallowed as already said.
    setCompander(plan, "ch1", 1793, -1600);
    live.resync(plan);
    expect(reports).toHaveLength(1);

    setCompander(plan, "ch1", 1793, -1200);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    expect(reports).toHaveLength(2);
  });

  it("re-arms once the two owners agree again", async () => {
    const plan = basePlan();
    setCompander(plan, "ch1", 1793, -1000);
    setCompander(plan, "ch2", 1794, -1500);
    const { live, reports } = collidingLive(plan);
    live.begin();
    setCompander(plan, "ch2", 1794, -1600);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    expect(reports).toHaveLength(1);

    // What a reconcile leaves behind: both owners carrying the same value, so the
    // duplicates agree and there is nothing to collapse.
    setCompander(plan, "ch1", 1793, -1600);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    expect(reports).toHaveLength(1);

    // A later divergence is a fresh report, not a swallowed one.
    setCompander(plan, "ch1", 1793, -1200);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    expect(reports).toHaveLength(2);
  });

  it("says nothing for a plan with no shared address", async () => {
    const plan = basePlan();
    const { live, reports } = collidingLive(plan);
    live.begin();
    setCh1Fader(plan, -6);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    expect(vi.mocked(vdSet)).toHaveBeenCalledTimes(1);
    expect(reports).toEqual([]);
  });
});
