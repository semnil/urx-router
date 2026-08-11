import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../../models";
import { emptyPlan, ensureFixedConnections, type Plan } from "../plan";
import { clonePlanState } from "../plan-history";

// LiveSync drives the device through platform.vdSet / vdSetStr and re-reads via
// vdGet on a converge; mock those. The point of these tests is the flush cadence
// (how many device writes a drag produces), so vdSet's call count is the metric.
// vdGetStr is here for the one case whose refetch hook runs the REAL readback rather
// than a stand-in (the cadence pin below): a scoped pass reads names too.
vi.mock("../platform", () => ({ vdSet: vi.fn(), vdSetStr: vi.fn(), vdGet: vi.fn(), vdGetStr: vi.fn() }));

import { vdSet, vdSetStr, vdGet, vdGetStr } from "../platform";
import { addrKey, planToCommands } from "./translate";
import type { SharedOwners } from "./translate";
import { LiveSync } from "./live";
import { applyNodeState } from "./readback";
import { SETTLE_TIMEOUT_MS, writeSettle } from "./settle";
import type { PendingWrites } from "./settle";

const model = getModel("URX44V");

function basePlan(): Plan {
  const plan = emptyPlan("URX44V");
  ensureFixedConnections(model, plan);
  return plan;
}

// The refetch hook resolves the private copy its read ran against (readback.readIntoPlan)
// — what the device holds as far as the read established it. Returning null stands for
// "no re-base": either the plan it read into is gone, or the case does not exercise one.
function liveFor(
  plan: Plan,
  refetchNodes?: (nodes: ReadonlySet<string>, pending: PendingWrites) => Promise<Plan | null>,
): LiveSync {
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
  vi.mocked(vdGetStr).mockReset().mockResolvedValue("");
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

  it("leaves the converge to seed its own diff, with nothing re-sent before the first read", async () => {
    // The seed read is the converge's own, not a diff handed down from this flush.
    // Seeding it from the send list was tried: those values freeze when they go out, so
    // an address the operator moved on the unit during the flush's awaits is written
    // straight back off the board, and every selector in the list is re-sent — which
    // repopulates the engine array it binds.
    const plan = basePlan();
    const live = liveFor(plan);
    const order: string[] = [];
    vi.mocked(vdSet).mockImplementation(async () => {
      order.push("set");
    });
    vi.mocked(vdGet).mockImplementation(async () => {
      order.push("get");
      return 0;
    });
    live.begin();
    setCh1CompEqType(plan, 1);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);

    // …and the seed read waits out the write it follows. The loop reads the whole
    // write scope, and this flush wrote part of it a millisecond ago, so a read
    // taken now answers the values those writes replaced: differences that are
    // not there, and — worse — the resets this loop exists to settle are missed,
    // which exits it before the first re-read. Nothing has been read yet.
    expect(order).toEqual(["set"]);
    await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS);

    // The one address the diff found, sent once and then READ. A seeded round 1 would
    // have sent it a second time before anything was read.
    expect(order[0]).toBe("set");
    expect(order[1]).toBe("get");
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

  // A rejection with no reason still has to name the failure: the teardown message
  // is the only thing the operator sees, and an empty one reads as a session that
  // stopped for no stated cause.
  it("names a converge failure whose rejection carried no message", async () => {
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
    let direct = true;
    vi.mocked(vdGet).mockResolvedValue(0);
    vi.mocked(vdSet).mockImplementation(() => (direct ? Promise.resolve() : Promise.reject(new Error(""))));
    const flushed = live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    direct = false;
    await vi.advanceTimersByTimeAsync(2000);
    void flushed;
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toBe("");
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

  it("does not send a device-followed value the send loop had not reached yet", async () => {
    // The flush translates the plan ONCE and then awaits per command, so a notify that
    // lands in one of those awaits moves the plan and the snapshot under a command list
    // that still carries the pre-notify value. ch1's CH_PAN is emitted one command behind
    // its CH_FADER, which puts it on the far side of the only write this flush makes.
    const plan = basePlan();
    const conn = plan.connections.find((c) => c.from === "ch1:out");
    if (!conn) throw new Error("expected a ch1 STEREO send connection");
    const pan = planToCommands(model, plan).find((c) => c.name === "CH_PAN" && c.node === "ch1");
    if (!pan) throw new Error("expected a ch1 CH_PAN command");
    const panAddr = `${pan.paramId}:${pan.x}:${pan.y}`;

    const live = liveFor(plan);
    live.begin();
    setCh1Fader(plan, -6);
    // The device moves the pan while the fader write is in flight — the direct-follow
    // path, whose two halves both run synchronously from inside that await.
    vi.mocked(vdSet).mockImplementationOnce(async () => {
      conn.params = { ...conn.params, pan: 24 };
      live.noteDirect(pan.paramId, pan.x, pan.y, 24);
    });
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);

    // Only the fader. A write to the pan would carry 0 — the value the device held before
    // it moved — over the hand that just moved it.
    const sent = vi.mocked(vdSet).mock.calls.map(([id, x, y]) => `${id}:${x}:${y}`);
    expect(sent).not.toContain(panAddr);
    expect(sent).toHaveLength(1);
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

// The unit announces a numeric write 58-151 ms after acking it, against a 120 ms flush
// window — so the second write of a drag can move the snapshot before the first write's
// announcement arrives. The snapshot holds one value per address and cannot represent
// the write it has moved past, so that announcement used to read as a device-side
// change: the plan was written back to a value the operator had already replaced, and
// the idle reconcile that followed wiped every undo entry.
describe("LiveSync late echo of a write the snapshot has moved past", () => {
  /** The ch1 STEREO send fader command at a given dB — its address and raw value. */
  function ch1FaderCmd(db: number) {
    const probe = basePlan();
    setCh1Fader(probe, db);
    const cmd = planToCommands(model, probe).find((c) => c.name === "CH_FADER" && c.node === "ch1");
    if (!cmd) throw new Error("expected a ch1 CH_FADER command");
    return cmd;
  }

  /** A live session that has flushed -6 then -12 to the ch1 fader, each in its own
   *  window — the premise every case here starts from, so it is stated once. The
   *  second write moves the snapshot past the first, which is the overtake. */
  async function overtakenDrag() {
    const plan = basePlan();
    const live = liveFor(plan);
    live.begin(clonePlanState(plan));
    for (const db of [-6, -12]) {
      setCh1Fader(plan, db);
      live.schedule();
      await vi.advanceTimersByTimeAsync(120);
    }
    return { plan, live, a: ch1FaderCmd(-6), b: ch1FaderCmd(-12) };
  }

  it("reads the overtaken write's announcement as an echo, not a device edit", async () => {
    const { live, a, b } = await overtakenDrag();
    expect(vi.mocked(vdSet)).toHaveBeenCalledTimes(2); // both writes really went out

    // The FIRST write's announcement, arriving after the second moved the snapshot.
    expect(live.isEcho(a.paramId, a.x, a.y, a.vdValue)).toBe(true);
    // A value we never wrote is still a device-side change.
    expect(live.isEcho(a.paramId, a.x, a.y, ch1FaderCmd(-24).vdValue)).toBe(false);
    // The latest write's own announcement stays an echo — that is the snapshot's job.
    expect(live.isEcho(b.paramId, b.x, b.y, b.vdValue)).toBe(true);
  });

  it("stops calling it an echo once the retention window has passed", async () => {
    const { live, a } = await overtakenDrag();

    await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS + 1);
    // The unit never announced it inside the window a settle waits, so a notify
    // carrying that value now is the operator's own move on the hardware.
    expect(live.isEcho(a.paramId, a.x, a.y, a.vdValue)).toBe(false);
  });

  it("consumes the queue up to the match, so an older write cannot answer for a newer one", async () => {
    const { plan, live, a, b } = await overtakenDrag();
    setCh1Fader(plan, -24);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);

    // The middle write announces first: everything queued before it goes with it.
    expect(live.isEcho(b.paramId, b.x, b.y, b.vdValue)).toBe(true);
    // The earlier value is no longer pending, so the unit reporting it now is a real
    // device-side move back — not our own write arriving late.
    expect(live.isEcho(a.paramId, a.x, a.y, a.vdValue)).toBe(false);
  });

  it("does the same for a name the snapshot has moved past", async () => {
    const plan = basePlan();
    const live = liveFor(plan);
    live.begin(clonePlanState(plan));

    plan.nodeNames = { ...plan.nodeNames, ch1: "FIRST" };
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    plan.nodeNames = { ...plan.nodeNames, ch1: "SECOND" };
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);

    const calls = vi.mocked(vdSetStr).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const [param, , y] = calls[calls.length - 1];
    expect(live.isEchoName(param, y, "FIRST")).toBe(true);
    expect(live.isEchoName(param, y, "SECOND")).toBe(true);
    expect(live.isEchoName(param, y, "NEVER WRITTEN")).toBe(false);
  });

  // The queue is bounded by the RETENTION, not by the session.
  //
  // `takePending` only sweeps the key a notify asks about, so an address the unit never
  // announces would otherwise keep one entry per flush for as long as the session runs —
  // and several params emit no notify at all when written, which makes that ordinary
  // rather than exotic. `notePending` prunes as it appends, which is what bounds it.
  //
  // This reaches private state on purpose: the property has NO behavioural signature —
  // `takePending` prunes on read either way, so `isEcho` answers identically with the
  // pruning removed (verified: deleting it leaves every other case here green). A pin
  // that goes through the public surface is therefore not available, and the choice is
  // between this and no pin at all.
  it("holds a silent address to the retention window, not to the session", async () => {
    const plan = basePlan();
    const live = liveFor(plan);
    live.begin(clonePlanState(plan));
    const depth = (): number => {
      const q = (live as unknown as { pendingValues: Map<number, unknown[]> }).pendingValues;
      return Math.max(0, ...[...q.values()].map((v) => v.length));
    };

    // 40 flushes to one address across well over the retention window, with the device
    // announcing nothing — the shape a converge / refetch param actually takes.
    for (let i = 1; i <= 40; i++) {
      setCh1Fader(plan, -i);
      live.schedule();
      await vi.advanceTimersByTimeAsync(120);
    }
    expect(vi.mocked(vdSet).mock.calls.length).toBeGreaterThanOrEqual(40); // it really wrote
    // 300 ms of retention at a 120 ms cadence is 3 writes; the bound is the window, and
    // the assertion is deliberately loose about the exact count and tight about growth.
    expect(depth()).toBeLessThanOrEqual(4);
  });

  // Both boundaries, asserted separately: `begin` clearing would hide `end` not
  // clearing if the two were only ever checked together.
  it("drops the queue when the session ends", async () => {
    const { live, a } = await overtakenDrag();

    live.end();
    expect(live.isEcho(a.paramId, a.x, a.y, a.vdValue)).toBe(false);
  });

  it("does not carry a previous session's writes into the next one", async () => {
    const { plan, live, a } = await overtakenDrag();

    // Straight into a new session without an intervening end(), which is what a
    // reconnect does — begin() is the boundary that has to hold on its own.
    live.begin(clonePlanState(plan));
    expect(live.isEcho(a.paramId, a.x, a.y, a.vdValue)).toBe(false);
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

  // The unit acks a write before the value is readable, so the read this flush issues
  // is told what the flush just wrote — it holds until the unit has spoken for the
  // addresses it is about to ask about, and answers those from what the unit ANNOUNCED
  // (readback / settle.ts). The cases below pin what is handed over: which addresses,
  // which of them the read may not start before, and which the unit owes an
  // announcement the read will not be looking for.
  const addrOf = (plan: Plan, name: string, node = "ch1"): number => {
    const c = planToCommands(model, plan).find((x) => x.name === name && x.node === node)!;
    return addrKey(c.paramId, c.x, c.y);
  };
  const setFader = (plan: Plan, node: string, db: number): void => {
    const conn = plan.connections.find((c) => c.from === `${node}:out`);
    if (!conn) throw new Error(`expected a ${node} STEREO send connection`);
    conn.params = { ...conn.params, level: db };
  };

  it("hands the refetch exactly the addresses this flush wrote", async () => {
    const plan = basePlan();
    const handed: PendingWrites[] = [];
    const live = liveFor(plan, async (_nodes, pending) => {
      handed.push(pending);
      return null;
    });
    live.begin();
    setCh1OneKnob(plan, { on: true });
    // A second address in the same window, so the map is not trivially one entry.
    setCh1Fader(plan, -6);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);

    const sent = new Set(vi.mocked(vdSet).mock.calls.map(([id, x, y]) => addrKey(id, x, y)));
    expect(sent.size).toBeGreaterThan(1);
    // Equal to the vdSet calls, not merely a superset of them: an address this flush did
    // not send has no write of ours for the unit's word to be attributed to.
    expect(handed.map((p) => new Set(p.written.keys()))).toEqual([sent]);
  });

  it("marks each address at its own write, not once for the flush", async () => {
    // The loop awaits per command, so a device notify for an address it has not reached
    // yet is ordinary. One mark for the whole flush would let that notify count as the
    // announcement of a write not yet made — and the read would then answer with the
    // value the operator's own move replaced. Here every send moves the notify clock,
    // so two addresses sharing a mark would be a mark taken outside the loop.
    const plan = basePlan();
    const handed: PendingWrites[] = [];
    const live = liveFor(plan, async (_nodes, pending) => {
      handed.push(pending);
      return null;
    });
    live.begin();
    setCh1OneKnob(plan, { on: true });
    setCh1Fader(plan, -6);
    vi.mocked(vdSet).mockImplementation(async () => {
      writeSettle.note({ paramId: 9999, x: 0, y: 0, value: 0 });
    });
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);

    const marks = [...handed[0].written.values()];
    expect(marks.length).toBeGreaterThan(1);
    expect(new Set(marks).size).toBe(marks.length);
  });

  it("holds the read for every write to a node it is about to read", async () => {
    // Both writes land on ch1, and ch1 is what the refetch reads — so both are addresses
    // this read will ASK the unit about, and neither may be asked for early. The fader
    // is a change the unit must announce, so its own wait ends at its own notify; nothing
    // here is left for the unannounced report, whose remit is the addresses this read
    // does not look at.
    const plan = basePlan();
    const handed: PendingWrites[] = [];
    const live = liveFor(plan, async (_nodes, pending) => {
      handed.push(pending);
      return null;
    });
    // The session opens on a full device readback, so the 1-knob is already in the
    // snapshot; the fader below is moved from a value the snapshot holds too.
    setCh1OneKnob(plan, { on: false, level: 50 });
    live.begin();
    setCh1OneKnob(plan, { on: true });
    setCh1Fader(plan, -6);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);

    expect(handed[0].written.size).toBe(2);
    expect([...handed[0].mustSettle].sort()).toEqual([addrOf(plan, "EQ_ONE_KNOB_ON"), addrOf(plan, "CH_FADER")].sort());
    expect(handed[0].mustAnnounce.size).toBe(0);
  });

  it("holds for an address the snapshot never held, which only the bound can close", async () => {
    const plan = basePlan();
    const handed: PendingWrites[] = [];
    const live = liveFor(plan, async (_nodes, pending) => {
      handed.push(pending);
      return null;
    });
    live.begin();
    // ch1 carries no eqOneKnob at all until this edit, so its addresses are not in the
    // snapshot the flush diffs against and the flush cannot say they changed. A write
    // the unit already agreed with emits no notify (measured), so nothing but the bound
    // can say the window is over — and the read must not take it before then.
    setCh1OneKnob(plan, { on: true });
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);

    expect(handed[0].mustSettle.has(addrOf(plan, "EQ_ONE_KNOB_ON"))).toBe(true);
    // …and it is NOT reported as a write that went missing when it stays silent: a no-op
    // write legitimately never announces, and ordering a whole-device sweep for one
    // would fire on every structural edit.
    expect(handed[0].mustAnnounce.size).toBe(0);
  });

  it("reports a changed write outside the read's scope instead of waiting for it", async () => {
    // ch2's fader moves in the same window as ch1's 1-knob. The read is scoped to ch1,
    // so it neither confirms nor repairs ch2 — holding it open for ch2 would cost the
    // drag a window and buy nothing. What is left is to say so: the unit must announce a
    // change, and a silent one is a write that went nowhere, which the settle reports to
    // the follow side (settle.ts mustAnnounce).
    const plan = basePlan();
    const handed: PendingWrites[] = [];
    const live = liveFor(plan, async (_nodes, pending) => {
      handed.push(pending);
      return null;
    });
    live.begin();
    setCh1OneKnob(plan, { on: true });
    setFader(plan, "ch2", -6);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);

    const ch2Fader = addrOf(plan, "CH_FADER", "ch2");
    expect(handed[0].written.has(ch2Fader)).toBe(true);
    expect(handed[0].mustSettle.has(ch2Fader)).toBe(false);
    expect([...handed[0].mustAnnounce]).toEqual([ch2Fader]);
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
    //
    // The hook TRAVERSES THE SETTLE, taking the same wait readback.applyDeviceState
    // takes because it IS that read: the hook runs the real applyNodeState, so the wait
    // is reached the way the app reaches it. A hook that called the settle itself would
    // measure this case's own arithmetic instead of the app's — it could not fail if
    // readback.ts stopped waiting at all, which is the regression worth a cadence pin in
    // the first place.
    //
    // Worst case on purpose: no notify source feeds the settle here (DeviceFollow owns
    // the only subscription), so every window spends the bounded fallback rather than
    // ending at the unit's own announcement, which on hardware lands at 9-204 ms. A drag
    // that keeps its cadence under the fallback keeps it under anything the unit does.
    const plan = basePlan();
    const live = liveFor(plan, async (nodes, pending) => {
      await applyNodeState(model, clonePlanState(plan), nodes, undefined, pending);
      // Null: this case measures the flush cadence, not the re-base.
      return null;
    });
    live.begin();
    setCh1OneKnob(plan, { on: true, level: 0 });
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS + 200);
    const before = vi.mocked(vdSet).mock.calls.length;

    // Long enough for several windows of throttle + settle to fit, so the count below
    // discriminates: a converge in this position sends NOTHING until the pointer stops,
    // and one write would be the whole gesture.
    const steps = 24;
    for (let i = 1; i <= steps; i++) {
      setCh1OneKnob(plan, { level: i * 4 });
      live.schedule();
      await vi.advanceTimersByTimeAsync(130);
    }
    const sent = vi.mocked(vdSet).mock.calls.length - before;
    // A window costs the settle and not the throttle on top of it: an edit arriving while
    // a flush is working sets `pending`, and the trailing flush runs straight off the end
    // of that one rather than re-arming the 120 ms timer. So a 3120 ms drag has room for
    // ~10, and it sends 11. Asserted at 7 — the bound rather than the measurement: a
    // modest slowdown leaves it green, and doubling the wait (~5) does not.
    expect(sent).toBeGreaterThan(6);
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
