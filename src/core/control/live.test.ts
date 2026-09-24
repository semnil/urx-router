import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../../models";
import { SSMCS_INITIAL, emptyPlan, ensureFixedConnections, type Plan } from "../plan";
import { PlanWriteWitness, clonePlanState } from "../plan-history";

// LiveSync drives the device through platform.vdSet / vdSetStr and re-reads via
// vdGet on a converge; mock those. The point of these tests is the flush cadence
// (how many device writes a drag produces), so vdSet's call count is the metric.
// vdGetStr is here for the one case whose refetch hook runs the REAL readback rather
// than a stand-in (the cadence pin below): a scoped pass reads names too.
vi.mock("../platform", () => ({ vdSet: vi.fn(), vdSetStr: vi.fn(), vdGet: vi.fn(), vdGetStr: vi.fn() }));

import { vdSet, vdSetStr, vdGet, vdGetStr } from "../platform";
import { COMP_EQ_SSMCS, PARAMS, silentKey } from "./params";
import { addrKey, cmdAddr, planToCommands } from "./translate";
import type { SharedOwners } from "./translate";
import { LiveSync } from "./live";
import { MBC_ONE_KNOB, insertFxParamKey } from "./insert-fx-effect";
import { fxParams } from "./fx-effect";
import { applyNodeState, readIntoPlan } from "./readback";
import { SETTLE_TIMEOUT_MS, writeSettle } from "./settle";
import type { PendingWrites } from "./settle";
import { gainToVd } from "./vd";

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
  reregister?: () => void,
): LiveSync {
  return new LiveSync({
    getModel: () => model,
    getPlan: () => plan,
    onError: () => {},
    onSent: () => {},
    onCollapsed: () => {},
    refetchNodes,
    reregister,
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
  // vdSetStr was the one of the four this reset left out, so its calls accumulated across
  // the file and a case asserting the whole call list saw earlier cases' name writes.
  vi.mocked(vdSetStr).mockReset().mockResolvedValue(undefined);
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
  // What the converge hands its caller alongside the addresses it confirmed. The addresses come
  // from the plan the loop SENT, which is a clone taken before its own await — an edit landing
  // in that window is exactly what the case below asserts survives — so a caller resolving them
  // against the live plan would be joining one moment's addresses to another moment's keys.
  it("hands the confirmed addresses over with the plan they came from", async () => {
    const plan = basePlan();
    const seen: Array<{ addrs: ReadonlySet<number>; sent: Plan }> = [];
    const live = new LiveSync({
      getModel: () => model,
      getPlan: () => plan,
      onError: () => {},
      onSent: () => {},
      onCollapsed: () => {},
      onConfirmed: (addrs, sent) => void seen.push({ addrs, sent }),
    });
    live.begin();
    setCh1CompEqType(plan, 1);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);

    expect(seen, "a sideEffect param converges, so the hook fires").toHaveLength(1);
    // Not the live plan — the clone. Handed the live one, every address would be read against
    // whatever the plan holds by the time the caller uses them.
    expect(seen[0]!.sent).not.toBe(plan);
    // What the set CONTAINS is the device flow's question (main.device.test.ts) — this mock's
    // converge re-reads a device that already agrees, so it sends nothing and confirms nothing.
    expect(seen[0]!.addrs).toBeInstanceOf(Set);
  });

  // The park in front of the converge. Three families announce nothing when the unit's own
  // panel moves them, and a converge re-sends whatever differs across the WHOLE write scope
  // — so with no read first, the plan's copy of those goes back over what the operator
  // tuned on the unit, and no event anywhere says it happened.
  it("reads the silent addresses into the plan the converge sends from", async () => {
    const plan = basePlan();
    const seen: Plan[] = [];
    const excluded: ReadonlySet<string>[] = [];
    const live = new LiveSync({
      getModel: () => model,
      getPlan: () => plan,
      onError: () => {},
      onSent: () => {},
      onCollapsed: () => {},
      onConfirmed: (_addrs, sent) => void seen.push(sent),
      parkSilent: async (scope) => {
        // The park in front of the CONVERGE. The one in front of the writes names `only`,
        // and is the case above.
        if (!scope.exclude) return;
        excluded.push(scope.exclude);
        // What a read of the unit's D.Gain would have put here.
        plan.nodeParams.ch_5_6 = { ...plan.nodeParams.ch_5_6, gain: 12 };
      },
    });
    live.begin();
    setCh1CompEqType(plan, 1);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);

    expect(excluded, "one park in front of the converge").toHaveLength(1);
    // A COMP/EQ type resets the channel's COMP/EQ bank, which the unit ANNOUNCES and the
    // park never read — so it names nothing, and CH 1's insert FX (a family this head does
    // not touch, on the same node) is still parked. Named per node instead, the converge
    // sent the plan's copy of that engine array over whatever the panel had done to it.
    expect([...excluded[0]!]).toEqual([]);
    // Ahead of the freeze — what the park wrote is in the copy the converge sends from.
    // Behind it, the read lands in a plan the converge is no longer looking at.
    expect(seen[0]?.nodeParams.ch_5_6?.gain, "the parked value in the converged copy").toBe(12);
  });

  // …and how MANY parks such a flush takes. The two calls are guarded independently — the
  // converge's by `sideEffect`, the head-write one by whether a head this flush is MOVING
  // declares a reset family — so a converging head that resets none of the three takes the
  // converge's alone, and the count for one flush is 0, 1 or 2 rather than a fixed pair.
  // Counted rather than read off the case above, which filters for `exclude` and is
  // satisfied by a run taking both.
  it("takes the converge's park alone where its head resets no silent family", async () => {
    const plan = basePlan();
    const scopes: Array<{ only?: ReadonlySet<string>; exclude?: ReadonlySet<string>; keepHeads?: boolean }> = [];
    const live = new LiveSync({
      getModel: () => model,
      getPlan: () => plan,
      onError: () => {},
      onSent: () => {},
      onCollapsed: () => {},
      parkSilent: async (scope) => void scopes.push(scope),
    });
    live.begin();
    setCh1CompEqType(plan, 1);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);

    expect(scopes, "one park, not a pair").toHaveLength(1);
    expect(scopes[0]?.only, "and it is the converge's, not the head writes'").toBeUndefined();
    expect(scopes[0]?.exclude).toBeDefined();
  });

  // What a head that DOES reset one of the three names, and how narrowly.
  it("names the family its head reset, on that head's node alone", async () => {
    const plan = basePlan();
    const excluded: ReadonlySet<string>[] = [];
    const live = new LiveSync({
      getModel: () => model,
      getPlan: () => plan,
      onError: () => {},
      onSent: () => {},
      onCollapsed: () => {},
      parkSilent: async (scope) => void (scope.exclude && excluded.push(scope.exclude)),
    });
    live.begin();
    // An FX channel's EFFECT TYPE: the one head whose reset IS a family the park reads.
    plan.nodeParams["bus.fx1"] = { ...plan.nodeParams["bus.fx1"], fxEffect: { type: 1 } };
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);

    expect(excluded).toHaveLength(1);
    expect([...excluded[0]!], "that channel's effect family and nothing else").toEqual([silentKey("fx", "bus.fx1")]);
  });

  // What the flush reads BEFORE it writes: the families the heads in this flush are about
  // to reset on the unit. Taken at the boundary every writer passes through rather than at
  // one control, so both EFFECT TYPE selectors, an undo of either, the insert-FX selector
  // and a MIDI mapping are covered by the one read.
  it("reads what its heads are about to reset before the first write goes out", async () => {
    const plan = basePlan();
    const scopes: Array<{ only?: ReadonlySet<string>; exclude?: ReadonlySet<string>; keepHeads?: boolean }> = [];
    const writesBefore: number[] = [];
    const live = new LiveSync({
      getModel: () => model,
      getPlan: () => plan,
      onError: () => {},
      onSent: () => {},
      onCollapsed: () => {},
      parkSilent: async (scope) => {
        scopes.push(scope);
        writesBefore.push(vi.mocked(vdSet).mock.calls.length);
      },
    });
    live.begin();
    plan.nodeParams["bus.fx1"] = { ...plan.nodeParams["bus.fx1"], fxEffect: { type: 1 } };
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);

    expect(scopes, "one park in front of the writes, one in front of the converge").toHaveLength(2);
    expect([...(scopes[0]?.only ?? [])], "the family this head resets, and nothing else").toEqual([
      silentKey("fx", "bus.fx1"),
    ]);
    // The plan is already holding the selection the write is about to carry; adopting the
    // unit's would put the outgoing one back and the write would never go out.
    expect(scopes[0]?.keepHeads, "the plan's own head stays").toBe(true);
    expect(writesBefore[0], "taken before anything went out").toBe(0);
    // …and the one behind the writes leaves that family to the converge, which is what puts
    // the plan's values back over the reset.
    expect([...(scopes[1]?.exclude ?? [])]).toEqual([silentKey("fx", "bus.fx1")]);
    expect(writesBefore[1], "taken after them").toBeGreaterThan(0);
  });

  // The park merges the unit's own values into the plan, so what goes out has to be derived
  // from the plan AGAIN. Sent from the list the flush opened with, the write behind the head
  // carries the app's stale copy — which is the whole thing the park is in front of.
  it("sends what the park merged rather than the list it opened with", async () => {
    const plan = basePlan();
    const hpf = fxParams(1).find((d) => d.key === "revxHpf")!;
    const live = new LiveSync({
      getModel: () => model,
      getPlan: () => plan,
      onError: () => {},
      onSent: () => {},
      onCollapsed: () => {},
      parkSilent: async (scope) => {
        if (!scope.only) return;
        // What a read of the unit's outgoing array would have put here.
        const fx = plan.nodeParams["bus.fx1"]?.fxEffect ?? {};
        plan.nodeParams["bus.fx1"] = {
          ...plan.nodeParams["bus.fx1"],
          fxEffect: { ...fx, params: { ...fx.params, [hpf.key]: 30 } },
        };
      },
    });
    live.begin();
    plan.nodeParams["bus.fx1"] = { ...plan.nodeParams["bus.fx1"], fxEffect: { type: 1 } };
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);

    const sent = vi.mocked(vdSet).mock.calls.find((c) => c[0] === 681 && c[2] === hpf.slot);
    expect(sent?.[3], "the unit's own value went back to it").toBe(30);
  });

  // The park is a READ, and two readers on one link is what the harness catches as invariant
  // 4. Device follow holds its reconcile off while this answers true, so the window has to
  // open at the park rather than at the converge behind it.
  it("holds a reconcile off from the outgoing park onward", async () => {
    const plan = basePlan();
    const seen: boolean[] = [];
    const live: LiveSync = new LiveSync({
      getModel: () => model,
      getPlan: () => plan,
      onError: () => {},
      onSent: () => {},
      onCollapsed: () => {},
      parkSilent: async () => void seen.push(live.isConverging()),
    });
    live.begin();
    plan.nodeParams["bus.fx1"] = { ...plan.nodeParams["bus.fx1"], fxEffect: { type: 1 } };
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);

    expect(seen[0], "already closed to a reconcile inside the first park").toBe(true);
    expect(live.isConverging(), "and open again once the flush is done").toBe(false);
  });

  // A disconnect can land in that read the way it can in the converge's, and everything
  // behind it — the head write included — belongs to a session that has gone.
  it("writes nothing when the session ends inside the outgoing park", async () => {
    const plan = basePlan();
    const live: LiveSync = new LiveSync({
      getModel: () => model,
      getPlan: () => plan,
      onError: () => {},
      onSent: () => {},
      onCollapsed: () => {},
      parkSilent: async () => live.end(),
    });
    live.begin();
    plan.nodeParams["bus.fx1"] = { ...plan.nodeParams["bus.fx1"], fxEffect: { type: 1 } };
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);

    expect(vi.mocked(vdSet), "not even the head that park was taken for").not.toHaveBeenCalled();
  });

  it("takes no park on a flush that does not converge", async () => {
    // The park is a device read, and an ordinary flush is what a drag produces: running it
    // there would put a whole-device pass inside every window of a fader move.
    const plan = basePlan();
    let parks = 0;
    const live = new LiveSync({
      getModel: () => model,
      getPlan: () => plan,
      onError: () => {},
      onSent: () => {},
      onCollapsed: () => {},
      parkSilent: async () => void parks++,
    });
    live.begin();
    setCh1Fader(plan, -6);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    // The positive control: the flush did happen, it just did not converge.
    expect(vi.mocked(vdSet), "the fader still went out").toHaveBeenCalledTimes(1);
    expect(parks).toBe(0);
  });

  it("sends nothing more when the session ends inside the park", async () => {
    // The park awaits a device read, so a disconnect can land in it — and everything the
    // converge would do next belongs to a session that has gone.
    const plan = basePlan();
    const live: LiveSync = new LiveSync({
      getModel: () => model,
      getPlan: () => plan,
      onError: () => {},
      onSent: () => {},
      onCollapsed: () => {},
      parkSilent: async () => live.end(),
    });
    live.begin();
    setCh1CompEqType(plan, 1);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    const afterDirect = vi.mocked(vdSet).mock.calls.length;
    expect(afterDirect, "the direct write went out before the park").toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(vi.mocked(vdSet).mock.calls.length, "no converge round followed").toBe(afterDirect);
    expect(vi.mocked(vdGet), "and no seed read").not.toHaveBeenCalled();
  });

  it("hands the confirmed addresses over even when a later round's send fails", async () => {
    // The failure ends the session, and what earlier rounds confirmed is the plan's only chance
    // at those values: the write that landed is what stops the address differing, so no later
    // flush produces a diff that would carry it again.
    const plan = basePlan();
    plan.nodeParams.ch1 = { on: true };
    const table = new Map<string, number>();
    const key = (id: number, x: number, y: number): string => `${id}:${x}:${y}`;
    vi.mocked(vdGet).mockImplementation((id, x, y) => Promise.resolve(table.get(key(id, x, y)) ?? 0));
    // One address the device accepts and does not keep, so a second round happens, and then
    // refuses — which is what stops the loop before it can re-read.
    const stuck = planToCommands(model, plan).find((c) => c.name === "CH_ON")!;
    let stuckSets = 0;
    vi.mocked(vdSet).mockImplementation((id, x, y, v) => {
      if (id === stuck.paramId && x === stuck.x && y === stuck.y) {
        return ++stuckSets > 1 ? Promise.reject(new Error("nak")) : Promise.resolve();
      }
      table.set(key(id, x, y), v);
      return Promise.resolve();
    });
    const seen: ReadonlySet<number>[] = [];
    const errors: string[] = [];
    const live = new LiveSync({
      getModel: () => model,
      getPlan: () => plan,
      onError: (message) => void errors.push(String(message)),
      onSent: () => {},
      onCollapsed: () => {},
      onConfirmed: (addrs) => void seen.push(addrs),
    });
    live.begin();
    setCh1CompEqType(plan, 1);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);

    expect(errors, "a refused send tears the session down").toHaveLength(1);
    expect(seen).toHaveLength(1);
    // The refused address is not among them; everything round 1 landed and round 2 left alone is.
    expect(seen[0]!.has(cmdAddr(stuck))).toBe(false);
    expect(seen[0]!.size).toBeGreaterThan(0);
  });

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

  // BUS Type is the fourth of the structural selectors prepare.ts's SKIP list names as
  // resetting a bank, and it was the one that did not declare it. On the unit, writing it
  // resets every send into that MIX — levels to -infinity, ONs to the side the written type
  // sets (off for FIXED, on for VARI) — so writing it back restores neither: the levels stay
  // down and sends that were off come back on. Nothing re-sends them, because the plan and
  // the snapshot still agree, so the board goes on showing a mix the device does not have
  // for the rest of the session.
  it("converges after a BUS Type edit, the way the other bank-resetting selectors do", async () => {
    const busTypeOf = (p: Plan, v: number): void => {
      p.nodeParams["bus.mix1"] = { ...p.nodeParams["bus.mix1"], busType: v };
    };
    const plan = basePlan();
    const live = liveFor(plan);
    live.begin();

    // A plain fader edit is the control: it sends and stops, with no re-read behind it.
    setCh1Fader(plan, -6);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);
    const plainReads = vi.mocked(vdGet).mock.calls.length;

    busTypeOf(plan, 1);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);
    // The converge re-reads the write scope; an ordinary flush reads nothing.
    expect(vi.mocked(vdGet).mock.calls.length).toBeGreaterThan(plainReads);
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

// The SSMCS strip's morphing knob recomputes the whole strip on the device — measured on
// a URX44V (2026-08-14): seventeen addresses across 96…117 announced 21 ms after the
// write, including the comp's ratio and knee. The plan mirrors those rather than authoring
// them, so this is a refetch; a converge would push its pre-morph copies back and undo the
// morph with nothing on screen to say so. The mode itself is in the plan from the start
// here — setting it is a converge param, and this case is about the morphing write alone.
function setCh1Morphing(plan: Plan, morphing: number): void {
  plan.nodeParams.ch1 = {
    ...plan.nodeParams.ch1,
    compEqType: COMP_EQ_SSMCS,
    ssmcs: { ...plan.nodeParams.ch1?.ssmcs, morphing },
  };
}

// The COMP 1-knob drives the values in COMP_ONE_KNOB_DRIVEN on the device and announces the
// recomputation (measured 2026-08: the written address goes fresh 0.046 ms before the four
// dependents when the knob is switched on — threshold, ratio, makeup and the knee — and
// 0.111 ms before the three a level change moves, which are the same minus the knee; none
// ahead of it in either direction). The plan mirrors them while the knob is on — the screen
// locks those rows — so this is a refetch, and a converge would push the pre-write copies
// back over what the knob just computed.
function setCh1CompOneKnob(plan: Plan, patch: { oneKnob?: boolean; oneKnobLevel?: number }): void {
  plan.nodeParams.ch1 = {
    ...plan.nodeParams.ch1,
    comp: { ...plan.nodeParams.ch1?.comp, ...patch },
  };
}

describe("LiveSync follow re-registration", () => {
  // A flush's capture rebuilds the follow address set, and nothing asked the follow layer to
  // re-register against it — so an address a structural edit added stayed unsubscribed until
  // some later reconcile, and a device-side change to it went unheard.
  it("asks for a re-registration once a flush that captured has finished", async () => {
    const plan = basePlan();
    const calls: string[] = [];
    const live = liveFor(
      plan,
      async () => {
        calls.push("refetch");
        return null;
      },
      () => calls.push("reregister"),
    );
    live.begin();
    // begin() captured too, and the caller subscribes for the session itself — so that one
    // must not be left for the first flush to ask about.
    expect(calls).toEqual([]);

    // A converge param: the flush captures after the converge.
    setCh1CompEqType(plan, COMP_EQ_SSMCS);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toEqual(["reregister"]);
  });

  // Ordering, which is the whole reason it is deferred: a re-registration unsubscribes before
  // it subscribes, so running it while the flush is still going would drop the notifies the
  // refetch's settle is waiting for. Asserted from inside the refetch — the hook has not been
  // called by then — rather than by counting afterwards, when both orders look the same.
  it("does not re-register before the refetch it shares a flush with", async () => {
    const plan = basePlan();
    setCh1CompEqType(plan, COMP_EQ_SSMCS);
    const seen: string[] = [];
    const live = liveFor(
      plan,
      async () => {
        seen.push(`refetch(reregistered=${seen.includes("reregister")})`);
        // A view rather than null, so the flush's own capture runs — a refetch that
        // re-bases nothing has no set to re-register against.
        return clonePlanState(plan);
      },
      () => seen.push("reregister"),
    );
    live.begin();
    setCh1Morphing(plan, 60);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen).toEqual(["refetch(reregistered=false)", "reregister"]);
  });

  // The case above drives a refetch-only flush, so it cannot see a second ask placed on the
  // converge's own capture — which is the same hazard from the other side, and reachable: both
  // params dirty in one window is one gesture away (a mode change re-authors the strip). The
  // converge runs first and the refetch after it, so an ask sitting on the converge's capture
  // lands while the refetch's settle is waiting for the notifies a re-registration drops.
  it("does not re-register between the converge and the refetch of one flush", async () => {
    const plan = basePlan();
    const seen: string[] = [];
    const live = liveFor(
      plan,
      async () => {
        seen.push(`refetch(reregistered=${seen.includes("reregister")})`);
        return clonePlanState(plan);
      },
      () => seen.push("reregister"),
    );
    live.begin();
    setCh1CompEqType(plan, COMP_EQ_SSMCS); // converge
    setCh1Morphing(plan, 60); // refetch, same window
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen).toEqual(["refetch(reregistered=false)", "reregister"]);
  });

  // A flush that captured nothing asks for nothing: an ordinary fader move cannot have moved
  // the address set, and the callee's own comparison should not be the only thing standing
  // between a drag and a re-registration per window.
  it("stays quiet through a flush that did not capture", async () => {
    const plan = basePlan();
    const calls: string[] = [];
    const live = liveFor(plan, undefined, () => calls.push("reregister"));
    live.begin();
    setCh1Fader(plan, -6);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(500);
    expect(vi.mocked(vdSet)).toHaveBeenCalledTimes(1); // the flush really ran
    expect(calls).toEqual([]);
  });

  // A plan whose emitted set moved with no `sideEffect` head behind it, so the flush
  // reaches neither a converge nor a refetch and so no capture. Built by hand, because no
  // gesture produces one today: every connection the default plan carries is fixed routing
  // the graph refuses to cut ("Fixed connection — cannot be removed"), and of the 310
  // routes the model would let an operator draw, the emitted set moves for none. The flush
  // compares the set against the follow list rather than trusting that to stay true.
  it("asks after a flush that reshaped the set with no converge or refetch in it", async () => {
    const plan = basePlan();
    const calls: string[] = [];
    const live = liveFor(plan, undefined, () => calls.push("reregister"));
    live.begin();
    const before = live.followAddrs().length;
    plan.connections = plan.connections.filter((c) => !(c.from === "ch_5_6:out" && c.to === "bus.mix1:in"));
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(500);
    // The premise: the set really moved, and by the send's own addresses.
    expect(live.followAddrs().length).toBeLessThan(before);
    expect(calls).toEqual(["reregister"]);
  });

  // …and it is the LATCH that keeps it quiet, not the gesture. Once a flush has captured, a
  // flush that captures nothing must still ask nothing — otherwise every window for the rest
  // of the session rebuilds the address list and hands it to the callee, once per step of a
  // drag, which is the cost the case above says the callee's comparison should not be alone in
  // absorbing.
  it("asks once per capture, not once per flush after one", async () => {
    const plan = basePlan();
    const calls: string[] = [];
    const live = liveFor(
      plan,
      async () => clonePlanState(plan),
      () => calls.push("reregister"),
    );
    live.begin();
    setCh1CompEqType(plan, COMP_EQ_SSMCS);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toEqual(["reregister"]);

    const sentBefore = vi.mocked(vdSet).mock.calls.length;
    setCh1Fader(plan, -6);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(500);
    expect(vi.mocked(vdSet).mock.calls.length).toBeGreaterThan(sentBefore); // the second flush ran
    expect(calls).toEqual(["reregister"]);
  });
});

describe("LiveSync sideEffect refetch", () => {
  // The measured membership, pinned by address rather than by count: the morph recomputes
  // every CONTINUOUS value in the strip and none of the five ON switches. Both directions
  // matter — a missing one leaves the converge undoing it, and a spurious one stops the
  // converge from restoring a switch the operator turned off.
  it("declares exactly the strip values the morph drives", () => {
    const drives = PARAMS.SSMCS_MORPHING.drives ?? [];
    const ids = drives.map((n) => (PARAMS as Record<string, { id: number }>)[n].id).sort((a, b) => a - b);
    expect(ids).toEqual([96, 97, 98, 99, 100, 101, 103, 104, 105, 108, 109, 111, 112, 113, 115, 116, 117]);
    // The five the morph left alone are the SC and EQ on/off switches.
    const onSwitches = ["SSMCS_SC_ON", "SSMCS_EQ_ON", "SSMCS_EQ_LOW_ON", "SSMCS_EQ_MID_ON", "SSMCS_EQ_HIGH_ON"];
    expect(onSwitches.map((n) => (PARAMS as Record<string, { id: number }>)[n].id)).toEqual([102, 106, 107, 110, 114]);
    for (const n of onSwitches) expect(drives).not.toContain(n);
    // The preset drives the same seventeen and is measured NOT to move Morphing, so it must
    // not name `93`: excluding that would stop the converge restoring a morph the operator set.
    expect(PARAMS.SWEET_SPOT_DATA.drives).toBe(drives);
    expect(drives).not.toContain("SSMCS_MORPHING");
  });

  // Registration is a SECOND thing from the flush's refetch, and it was missing in a way a
  // re-subscribe could never fix: capture() builds the candidate set, and it read
  // planToNameWrites only for the name snapshot — so a catalog string address was in no list
  // at all, however often the follow layer re-subscribed. Pinned on `followAddrs()`, which is
  // the list itself, rather than on what a session happens to have subscribed by some moment.
  it("offers the preset address for registration, indexed to its owner node", () => {
    const plan = basePlan();
    plan.nodeParams.ch1 = {
      ...plan.nodeParams.ch1,
      compEqType: COMP_EQ_SSMCS,
      ssmcs: { ...structuredClone(SSMCS_INITIAL), sweetSpotData: 1 },
    };
    const live = liveFor(plan);
    live.begin();
    const preset: [number, number, number] = [PARAMS.SWEET_SPOT_DATA.id, 0, 0];
    expect(live.followAddrs()).toContainEqual(preset);
    // And routed like a value rather than like a name: a notify for it re-reads ch1, which is
    // what a preset changed on the unit needs. A name resolves through a different index and
    // would answer undefined here.
    expect(live.lookup(...preset)).toEqual({ name: "SWEET_SPOT_DATA", node: "ch1", direct: false });

    // Only while the plan carries one: in COMP->EQ mode there is no preset to follow.
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, compEqType: 0 };
    live.begin();
    expect(live.followAddrs()).not.toContainEqual(preset);

    // And the SHAPE comes from the live plan even when a device view is handed over. A view
    // predates the read it was taken for, so an edit made during that read is in the plan and
    // not in it — taking the shape from the view would drop the address a person just chose
    // until some later reconcile. The numeric block is the control: it is present either way,
    // which is what makes this a statement about the string path rather than about resync.
    const stale = clonePlanState(plan);
    plan.nodeParams.ch1 = {
      ...plan.nodeParams.ch1,
      compEqType: COMP_EQ_SSMCS,
      ssmcs: { ...structuredClone(SSMCS_INITIAL), sweetSpotData: 3 },
    };
    live.resync(stale);
    const morph = planToCommands(model, plan).find((c) => c.name === "SSMCS_MORPHING" && c.node === "ch1")!;
    expect(live.followAddrs()).toContainEqual([morph.paramId, morph.x, morph.y]);
    expect(live.followAddrs()).toContainEqual(preset);
  });

  // The preset is a refetch head on the STRING path, which the flush's name loop used to walk
  // without consulting either set — so declaring it alone would have changed nothing. This
  // pins the PATH rather than the declaration: it fails if the loop stops reading the flag,
  // stops resolving the owner node, or stops handing the address to the read.
  it("reads the node back after a preset write, and holds the read for it", async () => {
    const plan = basePlan();
    plan.nodeParams.ch1 = {
      ...plan.nodeParams.ch1,
      compEqType: COMP_EQ_SSMCS,
      ssmcs: { ...structuredClone(SSMCS_INITIAL), sweetSpotData: 1 },
    };
    const nodes: string[][] = [];
    const held: number[][] = [];
    const marks: Array<ReadonlyMap<number, number> | undefined> = [];
    const live = liveFor(plan, async (n, pending) => {
      nodes.push([...n]);
      held.push([...pending.mustSettle]);
      marks.push(pending.boundaryMarks);
      return null;
    });
    live.begin();

    plan.nodeParams.ch1 = {
      ...plan.nodeParams.ch1,
      ssmcs: { ...plan.nodeParams.ch1?.ssmcs, sweetSpotData: 2 },
    };
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);

    // The preset really went out on the string path, and nothing numeric did.
    expect(vi.mocked(vdSetStr).mock.calls).toEqual([[PARAMS.SWEET_SPOT_DATA.id, 0, 0, "0002"]]);
    expect(vi.mocked(vdSet)).not.toHaveBeenCalled();
    expect(nodes).toEqual([["ch1"]]);
    // And the read may not start before the unit has spoken for the address it wrote.
    expect(held).toEqual([[addrKey(PARAMS.SWEET_SPOT_DATA.id, 0, 0)]]);
    // With the MARK taken before that write, not just the address. Without it the wait
    // cannot tell this write's announcement from an older one, so an answer that arrived
    // while the flush was still running — the ordinary case, the unit replies in ~15 ms —
    // is missed and the read waits out the whole bound instead.
    expect([...(marks[0] ?? new Map()).keys()]).toEqual([addrKey(PARAMS.SWEET_SPOT_DATA.id, 0, 0)]);
    expect(typeof [...(marks[0] ?? new Map()).values()][0]).toBe("number");
  });

  // An edit made while a refetch head's write is on the wire is carried by none of the
  // flush's writes, and the read is opened only once they have returned — so the flush opens
  // the edit watch where it takes its values and hands that same watch to the read. A flush
  // with no refetch head opens none: the watch samples every edit while it is open.
  it("watches edits from where the flush takes its values and hands the watch to the refetch", async () => {
    const plan = basePlan();
    setCh1CompEqType(plan, COMP_EQ_SSMCS);
    const seen: string[] = [];
    const watch = {
      authored: () => new Set<string>(),
      edits: () => new Map<string, number>(),
      close: () => void seen.push("close"),
    };
    const handed: unknown[] = [];
    const live = new LiveSync({
      getModel: () => model,
      getPlan: () => plan,
      onError: () => {},
      onSent: () => {},
      onCollapsed: () => {},
      watchEdits: () => {
        seen.push("watch");
        return watch;
      },
      refetchNodes: async (_nodes, _pending, edits) => {
        seen.push("refetch");
        handed.push(edits);
        return null;
      },
    });
    vi.mocked(vdSet).mockImplementation(async () => void seen.push("write"));
    live.begin();
    setCh1Morphing(plan, 60);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen).toEqual(["watch", "write", "refetch", "close"]);
    expect(handed).toEqual([watch]);

    // The control: a fader move provokes no read, and opens no watch.
    seen.length = 0;
    setCh1Fader(plan, -6);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen).toEqual(["write"]);
  });

  // The refetch keeps an edit made after the value a refetch head carries was taken, wherever
  // the flush takes it: its first list, a re-take inside the numeric loop, or the name loop's
  // own list. These run the app's own read and merge over a unit that keeps what it is sent,
  // with a write held open while the operator edits, and ask what the plan and the wire end up
  // holding.
  describe("an edit made while a refetch head's write is on the wire", () => {
    /** `recompute` is the unit working out what a write drives, on the values it holds. */
    const heldUnit = (plan: Plan, recompute?: (addr: number, value: number, numbers: Map<number, number>) => void) => {
      const numbers = new Map(planToCommands(model, plan).map((c) => [cmdAddr(c), c.vdValue] as const));
      const refetched: string[][] = [];
      const names = new Map<string, string>();
      type Match = (id: number, x: number, y: number) => boolean;
      const hold: { set: Match | null; str: Match | null } = { set: null, str: null };
      const waiting: Array<() => void> = [];
      const gate = async (kind: "set" | "str", id: number, x: number, y: number): Promise<void> => {
        const match = hold[kind];
        if (!match?.(id, x, y)) return;
        hold[kind] = null;
        await new Promise<void>((r) => waiting.push(r));
      };
      vi.mocked(vdSet).mockImplementation(async (id: number, x: number, y: number, v: number) => {
        numbers.set(addrKey(id, x, y), v);
        recompute?.(addrKey(id, x, y), v, numbers);
        await gate("set", id, x, y);
      });
      vi.mocked(vdSetStr).mockImplementation(async (id: number, x: number, y: number, v: string) => {
        names.set(`${id}:${x}:${y}`, v);
        await gate("str", id, x, y);
      });
      vi.mocked(vdGet).mockImplementation(
        async (id: number, x: number, y: number) => numbers.get(addrKey(id, x, y)) ?? 0,
      );
      vi.mocked(vdGetStr).mockImplementation(
        async (id: number, x: number, y: number) => names.get(`${id}:${x}:${y}`) ?? "",
      );
      const witness = new PlanWriteWitness(() => plan);
      const live = new LiveSync({
        getModel: () => model,
        getPlan: () => plan,
        onError: () => {},
        onSent: () => {},
        onCollapsed: () => {},
        watchEdits: () => witness.watch(),
        refetchNodes: async (nodes, pending, edits) =>
          (refetched.push([...nodes]),
          await readIntoPlan(
            () => plan,
            (into) => applyNodeState(model, into, nodes, undefined, pending, true),
            edits ? { watch: () => edits } : witness,
          ))?.deviceView ?? null,
      });
      return {
        live,
        numbers,
        /** The nodes each refetch read back, in order. */
        refetched,
        /** The edit funnel: the plan moves, the witness is told, and a flush is asked for. */
        edit: (change: () => void): void => {
          change();
          witness.note();
          live.schedule();
        },
        /** Hold the next write of this kind — to this address, when one is named — until `release`. */
        holdNext: (kind: "set" | "str", at?: { paramId: number; x: number; y: number }): void =>
          void (hold[kind] = at ? (id, x, y) => id === at.paramId && x === at.x && y === at.y : () => true),
        held: (): number => waiting.length,
        release: (): void => waiting.shift()?.(),
      };
    };

    const withPreset = (plan: Plan, n: number): void => {
      plan.nodeParams.ch1 = {
        ...plan.nodeParams.ch1,
        compEqType: COMP_EQ_SSMCS,
        ssmcs: { ...structuredClone(SSMCS_INITIAL), ...plan.nodeParams.ch1?.ssmcs, sweetSpotData: n },
      };
    };
    const setFader = (plan: Plan, node: string, db: number): void => {
      const conn = plan.connections.find((c) => c.from === `${node}:out`)!;
      conn.params = { ...conn.params, level: db };
    };
    /** The values written to one command's address, in order. */
    const writesTo = (plan: Plan, name: string, node: string): number[] => {
      const c = planToCommands(model, plan).find((x) => x.name === name && x.node === node)!;
      return vi
        .mocked(vdSet)
        .mock.calls.filter(([id, x, y]) => id === c.paramId && x === c.x && y === c.y)
        .map((w) => w[3]);
    };
    const valueOf = (plan: Plan, name: string, node: string): number =>
      planToCommands(model, plan).find((x) => x.name === name && x.node === node)!.vdValue;
    const presetWrites = (): string[] => vi.mocked(vdSetStr).mock.calls.map((c) => c[3]);

    // The head is in the flush from its start — a preset and a fader together — so the watch
    // opens before the first write, and an edit to either while its own write is on the wire
    // stays: the fader moved during the fader write, the preset during the preset write.
    it("keeps edits made during a flush that carried a preset from its start", async () => {
      const plan = basePlan();
      withPreset(plan, 1);
      const unit = heldUnit(plan);
      unit.live.begin();

      unit.holdNext("set");
      unit.edit(() => {
        setFader(plan, "ch1", -6);
        withPreset(plan, 2);
      });
      await vi.advanceTimersByTimeAsync(120);
      expect(unit.held(), "the premise: the fader write is held").toBe(1);
      const faderFirst = valueOf(plan, "CH_FADER", "ch1");
      unit.edit(() => setFader(plan, "ch1", -12));
      const faderLast = valueOf(plan, "CH_FADER", "ch1");
      unit.holdNext("str");
      unit.release();
      await vi.advanceTimersByTimeAsync(1);
      expect(presetWrites(), "the premise: preset 2 went out in the same flush").toEqual(["0002"]);
      unit.edit(() => withPreset(plan, 3));
      unit.release();
      await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS + 2000);

      expect({ fader: valueOf(plan, "CH_FADER", "ch1"), preset: plan.nodeParams.ch1?.ssmcs?.sweetSpotData }).toEqual({
        fader: faderLast,
        preset: 3,
      });
      expect(writesTo(plan, "CH_FADER", "ch1")).toEqual([faderFirst, faderLast]);
      expect(presetWrites()).toEqual(["0002", "0003"]);
    });

    // The numeric twin: a 1-knob level and a fader together, each moved again during its own write.
    it("keeps edits made during a flush that carried a 1-knob level from its start", async () => {
      const plan = basePlan();
      setCh1OneKnob(plan, { on: true, level: 0 });
      const unit = heldUnit(plan);
      unit.live.begin();

      unit.holdNext("set");
      unit.edit(() => {
        setCh1OneKnob(plan, { level: 40 });
        setFader(plan, "ch1", -6);
      });
      await vi.advanceTimersByTimeAsync(120);
      expect(writesTo(plan, "EQ_ONE_KNOB_LEVEL", "ch1"), "the premise: the level write is held").toHaveLength(1);
      const levelFirst = valueOf(plan, "EQ_ONE_KNOB_LEVEL", "ch1");
      unit.edit(() => setCh1OneKnob(plan, { level: 80 }));
      const levelLast = valueOf(plan, "EQ_ONE_KNOB_LEVEL", "ch1");
      unit.holdNext("set");
      unit.release();
      await vi.advanceTimersByTimeAsync(1);
      expect(writesTo(plan, "CH_FADER", "ch1"), "the premise: the fader write is held").toHaveLength(1);
      const faderFirst = valueOf(plan, "CH_FADER", "ch1");
      unit.edit(() => setFader(plan, "ch1", -12));
      const faderLast = valueOf(plan, "CH_FADER", "ch1");
      unit.release();
      await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS + 2000);

      expect(plan.nodeParams.ch1?.eqOneKnob?.level).toBe(80);
      expect(valueOf(plan, "CH_FADER", "ch1")).toBe(faderLast);
      expect(writesTo(plan, "EQ_ONE_KNOB_LEVEL", "ch1")).toEqual([levelFirst, levelLast]);
      expect(writesTo(plan, "CH_FADER", "ch1")).toEqual([faderFirst, faderLast]);
    });

    // The head turns up only after sending began — a preset chosen during a fader write, with
    // the fader moved again too. It waits for the next flush, which watches from its start.
    it("keeps edits made around a preset the name loop found after sending began", async () => {
      const plan = basePlan();
      withPreset(plan, 1);
      const unit = heldUnit(plan);
      unit.live.begin();

      unit.holdNext("set");
      unit.edit(() => setFader(plan, "ch1", -6));
      await vi.advanceTimersByTimeAsync(120);
      expect(unit.held(), "the premise: the fader write is held").toBe(1);
      const faderFirst = valueOf(plan, "CH_FADER", "ch1");
      unit.edit(() => {
        withPreset(plan, 2);
        setFader(plan, "ch1", -12);
      });
      const faderLast = valueOf(plan, "CH_FADER", "ch1");
      unit.holdNext("str");
      unit.release();
      await vi.advanceTimersByTimeAsync(1);
      expect(presetWrites(), "the premise: preset 2 went out").toEqual(["0002"]);
      unit.edit(() => withPreset(plan, 3));
      unit.release();
      await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS + 2000);

      expect(plan.nodeParams.ch1?.ssmcs?.sweetSpotData).toBe(3);
      expect(valueOf(plan, "CH_FADER", "ch1")).toBe(faderLast);
      expect(presetWrites()).toEqual(["0002", "0003"]);
      expect(writesTo(plan, "CH_FADER", "ch1")).toEqual([faderFirst, faderLast]);
    });

    it("keeps an SSMCS preset chosen while the preset a name re-take picked up is being written", async () => {
      const plan = basePlan();
      plan.nodeParams.ch1 = {
        ...plan.nodeParams.ch1,
        compEqType: COMP_EQ_SSMCS,
        ssmcs: { ...structuredClone(SSMCS_INITIAL), sweetSpotData: 1 },
      };
      const unit = heldUnit(plan);
      const setPreset = (n: number): void =>
        unit.edit(() => {
          plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, ssmcs: { ...plan.nodeParams.ch1?.ssmcs, sweetSpotData: n } };
        });
      const ch3Fader = planToCommands(model, plan).find((c) => c.name === "CH_FADER" && c.node === "ch3")!;
      unit.live.begin();

      // The name loop takes a rename alone. While it is on the wire the preset moves and the
      // unit's panel moves something else, so the loop re-takes its names and the preset goes
      // out as a refetch head its own list did not carry…
      unit.holdNext("str");
      unit.edit(() => (plan.nodeNames = { ...plan.nodeNames, ch1: "Vox" }));
      await vi.advanceTimersByTimeAsync(120);
      expect(unit.held(), "the premise: the rename is held").toBe(1);
      setPreset(2);
      unit.live.noteDirect(ch3Fader.paramId, ch3Fader.x, ch3Fader.y, ch3Fader.vdValue);
      // …and preset 3 is chosen while the write of 2 is on the wire.
      unit.holdNext("str");
      unit.release();
      await vi.advanceTimersByTimeAsync(1);
      expect(
        vi.mocked(vdSetStr).mock.calls.map((c) => c[3]),
        "the premise: the rename, then preset 2",
      ).toEqual(["Vox", "0002"]);
      setPreset(3);
      unit.release();
      await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS + 2000);

      expect(plan.nodeParams.ch1?.ssmcs?.sweetSpotData).toBe(3);
      expect(vi.mocked(vdSetStr).mock.calls.map((c) => c[3])).toEqual(["Vox", "0002", "0003"]);
    });

    it("keeps an SSMCS morph set while the morph a numeric re-take picked up is being written", async () => {
      const plan = basePlan();
      plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, gain: 20 };
      plan.nodeParams.ch2 = {
        ...plan.nodeParams.ch2,
        compEqType: COMP_EQ_SSMCS,
        ssmcs: { ...structuredClone(SSMCS_INITIAL), morphing: 0 },
      };
      const setMorph = (n: number): void => {
        plan.nodeParams.ch2 = { ...plan.nodeParams.ch2, ssmcs: { ...plan.nodeParams.ch2?.ssmcs, morphing: n } };
      };
      const unit = heldUnit(plan);
      const at = (name: string, node: string): number =>
        planToCommands(model, plan).findIndex((c) => c.name === name && c.node === node);
      expect(at("HA_GAIN", "ch1"), "the premise: CH 1's A.Gain goes out ahead of CH 2's morph").toBeLessThan(
        at("SSMCS_MORPHING", "ch2"),
      );
      const morphCmd = () => planToCommands(model, plan).find((c) => c.name === "SSMCS_MORPHING" && c.node === "ch2")!;
      const morphWrites = (): number[] => {
        const c = morphCmd();
        return vi
          .mocked(vdSet)
          .mock.calls.filter(([id, x, y]) => id === c.paramId && x === c.x && y === c.y)
          .map((w) => w[3]);
      };
      const ch3Fader = planToCommands(model, plan).find((c) => c.name === "CH_FADER" && c.node === "ch3")!;
      unit.live.begin();

      // The flush takes CH 1's A.Gain alone. While it is on the wire CH 2's morph moves and the
      // unit's panel moves something else, so the loop re-takes its values and the morph goes
      // out as a refetch head the flush's first list did not carry…
      unit.holdNext("set");
      unit.edit(() => (plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, gain: 30 }));
      unit.live.schedule();
      await vi.advanceTimersByTimeAsync(120);
      expect(unit.held(), "the premise: the A.Gain write is held").toBe(1);
      const ch2FaderFirst = planToCommands(model, plan).find((c) => c.name === "CH_FADER" && c.node === "ch2")!.vdValue;
      unit.edit(() => {
        setMorph(40);
        const conn = plan.connections.find((c) => c.from === "ch2:out")!;
        conn.params = { ...conn.params, level: -12 };
      });
      const taken = morphCmd().vdValue;
      const ch2FaderLast = planToCommands(model, plan).find((c) => c.name === "CH_FADER" && c.node === "ch2")!.vdValue;
      unit.live.noteDirect(ch3Fader.paramId, ch3Fader.x, ch3Fader.y, ch3Fader.vdValue);
      // …and the morph moves again while that write is on the wire.
      unit.holdNext("set", morphCmd());
      unit.release();
      await vi.advanceTimersByTimeAsync(1);
      expect(morphWrites(), "the premise: the re-taken morph went out").toEqual([taken]);
      unit.edit(() => setMorph(80));
      const last = morphCmd().vdValue;
      unit.release();
      await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS + 2000);

      expect(plan.nodeParams.ch2?.ssmcs?.morphing).toBe(80);
      expect(morphWrites()).toEqual([taken, last]);
      const ch2Fader = planToCommands(model, plan).find((c) => c.name === "CH_FADER" && c.node === "ch2")!;
      expect(ch2Fader.vdValue, "CH 2's fader moved with the morph stays").toBe(ch2FaderLast);
      expect(
        vi
          .mocked(vdSet)
          .mock.calls.filter(([id, x, y]) => id === ch2Fader.paramId && x === ch2Fader.x && y === ch2Fader.y)
          .map((w) => w[3]),
      ).toEqual(ch2FaderFirst === ch2FaderLast ? [] : [ch2FaderLast]);
    });

    // A converge in the same flush re-sends whatever differs across the write scope. A refetch
    // head the operator moved that the flush did not send — deferred after a re-take, passed at
    // the value the flush took, or at an address that appeared while it ran — must not go out
    // from there: the unit recomputes what it drives, no read follows, and the converge writes
    // the plan's older copies back. The converge leaves it alone, and the next flush sends it
    // and reads its node back.
    describe("beside a converge", () => {
      const ratioOf = (plan: Plan) =>
        planToCommands(model, plan).find((c) => c.name === "SSMCS_COMP_RATIO" && c.node === "ch2")!;
      const morphOf = (plan: Plan) =>
        planToCommands(model, plan).find((c) => c.name === "SSMCS_MORPHING" && c.node === "ch2")!;
      // A stop index on the SSMCS ratio's own scale (vd.ts SSMCS_RATIO_RAW_MAX).
      const RECOMPUTED = 37;

      it.each([
        ["deferred after a re-take", true],
        ["passed at the value the flush took", false],
      ])("sends an SSMCS morph %s from the next flush, and reads its node back", async (_how, retake) => {
        const plan = basePlan();
        plan.nodeParams.ch2 = {
          ...plan.nodeParams.ch2,
          compEqType: COMP_EQ_SSMCS,
          ssmcs: { ...structuredClone(SSMCS_INITIAL), morphing: 0 },
        };
        const morphAddr = cmdAddr(morphOf(plan));
        const ratioAddr = cmdAddr(ratioOf(plan));
        expect(PARAMS.SSMCS_MORPHING.drives, "the premise: the morph drives the ratio").toContain("SSMCS_COMP_RATIO");
        expect(ratioOf(plan).vdValue, "the premise: the recomputed ratio differs from the plan's").not.toBe(RECOMPUTED);
        const unit = heldUnit(plan, (addr, _v, numbers) => {
          if (addr === morphAddr) numbers.set(ratioAddr, RECOMPUTED);
        });
        const ch3Fader = planToCommands(model, plan).find((c) => c.name === "CH_FADER" && c.node === "ch3")!;
        unit.live.begin();

        // CH 1's COMP/EQ Type — a converge head — is on the wire when CH 2's morph moves.
        unit.holdNext("set");
        unit.edit(() => setCh1CompEqType(plan, COMP_EQ_SSMCS));
        await vi.advanceTimersByTimeAsync(120);
        expect(unit.held(), "the premise: the type write is held").toBe(1);
        unit.edit(() => {
          plan.nodeParams.ch2 = { ...plan.nodeParams.ch2, ssmcs: { ...plan.nodeParams.ch2?.ssmcs, morphing: 40 } };
        });
        const morphed = morphOf(plan).vdValue;
        if (retake) unit.live.noteDirect(ch3Fader.paramId, ch3Fader.x, ch3Fader.y, ch3Fader.vdValue);
        unit.release();
        await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS + 3000);

        const morphWrites = vi
          .mocked(vdSet)
          .mock.calls.filter(([id, x, y]) => addrKey(id, x, y) === morphAddr)
          .map((w) => w[3]);
        expect(morphWrites, "the morph went out once").toEqual([morphed]);
        expect(unit.refetched, "and its node was read back").toContainEqual(["ch2"]);
        expect(unit.numbers.get(ratioAddr), "the unit's recomputed ratio stands").toBe(RECOMPUTED);
        expect(ratioOf(plan).vdValue, "and the plan took it").toBe(RECOMPUTED);
      });

      it("sends a preset deferred beside a converge from the next flush", async () => {
        const plan = basePlan();
        plan.nodeParams.ch1 = {
          ...plan.nodeParams.ch1,
          compEqType: COMP_EQ_SSMCS,
          ssmcs: { ...structuredClone(SSMCS_INITIAL), sweetSpotData: 1 },
        };
        const unit = heldUnit(plan);
        unit.live.begin();

        // CH 2's COMP/EQ Type — a converge head — is on the wire when CH 1's preset moves, and the
        // name loop meets the preset with no watch open.
        unit.holdNext("set");
        unit.edit(() => (plan.nodeParams.ch2 = { ...plan.nodeParams.ch2, compEqType: COMP_EQ_SSMCS }));
        await vi.advanceTimersByTimeAsync(120);
        expect(unit.held(), "the premise: the type write is held").toBe(1);
        unit.edit(() => {
          plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, ssmcs: { ...plan.nodeParams.ch1?.ssmcs, sweetSpotData: 2 } };
        });
        unit.release();
        await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS + 3000);

        expect(vi.mocked(vdSetStr).mock.calls.map((c) => c[3])).toEqual(["0002"]);
        expect(unit.refetched).toContainEqual(["ch1"]);
        expect(plan.nodeParams.ch1?.ssmcs?.sweetSpotData).toBe(2);
      });

      // The head's address can also first appear inside the flush: CH 2 is switched to SSMCS
      // while another write is on the wire, so its morph is in none of the lists the flush took
      // and the snapshot has never held it. The converge leaves it for the next flush all the same.
      it.each([
        ["with no preset", false],
        ["with a preset", true],
      ])(
        "sends a morph whose address appeared during the flush %s from the next flush, and reads its node back",
        async (_how, preset) => {
          const plan = basePlan();
          const { sweetSpotData, ...bank } = structuredClone(SSMCS_INITIAL);
          plan.nodeParams.ch2 = {
            ...plan.nodeParams.ch2,
            ssmcs: { ...bank, ...(preset ? { sweetSpotData } : {}), morphing: 0 },
          };
          expect(
            planToCommands(model, plan).some((c) => c.name === "SSMCS_MORPHING" && c.node === "ch2"),
            "the premise: CH 2 emits no morph before its type moves",
          ).toBe(false);
          const switched = structuredClone(plan);
          switched.nodeParams.ch2 = {
            ...switched.nodeParams.ch2,
            compEqType: COMP_EQ_SSMCS,
            ssmcs: { ...switched.nodeParams.ch2?.ssmcs, morphing: 40 },
          };
          const morphAddr = cmdAddr(morphOf(switched));
          const ratioAddr = cmdAddr(ratioOf(switched));
          expect(ratioOf(switched).vdValue, "the premise: the recomputed ratio differs from the plan's").not.toBe(
            RECOMPUTED,
          );
          const unit = heldUnit(plan, (addr, _v, numbers) => {
            if (addr === morphAddr) numbers.set(ratioAddr, RECOMPUTED);
          });
          unit.live.begin();

          unit.holdNext("set");
          unit.edit(() => setCh1CompEqType(plan, COMP_EQ_SSMCS));
          await vi.advanceTimersByTimeAsync(120);
          expect(unit.held(), "the premise: the type write is held").toBe(1);
          unit.edit(() => (plan.nodeParams.ch2 = structuredClone(switched.nodeParams.ch2)));
          unit.release();
          await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS + 3000);

          const morphWrites = vi
            .mocked(vdSet)
            .mock.calls.filter(([id, x, y]) => addrKey(id, x, y) === morphAddr)
            .map((w) => w[3]);
          expect(morphWrites, "the morph went out once").toEqual([morphOf(switched).vdValue]);
          expect(unit.refetched, "and its node was read back").toContainEqual(["ch2"]);
          expect(unit.numbers.get(ratioAddr), "the unit's recomputed ratio stands").toBe(RECOMPUTED);
          expect(ratioOf(plan).vdValue, "and the plan took it").toBe(RECOMPUTED);
        },
      );

      // A head the operator did not move is still the converge's: whatever the converge head
      // reset on the unit, the converge puts the plan's value back. The unit here resets CH 1's
      // morph with the PAN/BAL write, standing for any reset that reaches a refetch head.
      it("restores a refetch head the operator did not move after a converge head resets it", async () => {
        const plan = basePlan();
        plan.nodeParams.ch1 = {
          ...plan.nodeParams.ch1,
          compEqType: COMP_EQ_SSMCS,
          ssmcs: { ...structuredClone(SSMCS_INITIAL), morphing: 40 },
        };
        const at = (name: string) =>
          cmdAddr(planToCommands(model, plan).find((c) => c.name === name && c.node === "ch1")!);
        const morphAddr = at("SSMCS_MORPHING");
        const panned = structuredClone(plan);
        panned.nodeParams.ch1 = { ...panned.nodeParams.ch1, panBal: 1 };
        const panBalAddr = cmdAddr(
          planToCommands(model, panned).find((c) => c.name === "PAN_BAL" && c.node === "ch1")!,
        );
        const morphed = valueOf(plan, "SSMCS_MORPHING", "ch1");
        expect(morphed, "the premise: the reset moves the morph").not.toBe(0);
        const unit = heldUnit(plan, (addr, _v, numbers) => {
          if (addr === panBalAddr) numbers.set(morphAddr, 0);
        });
        unit.live.begin();

        unit.edit(() => (plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, panBal: 1 }));
        await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS + 3000);

        expect(writesTo(plan, "PAN_BAL", "ch1"), "the premise: the converge head went out").toHaveLength(1);
        expect(unit.numbers.get(morphAddr), "the converge put the morph back").toBe(morphed);
      });
    });
  });

  // A converge and a refetch can land in one flush — PAN/BAL and the morphing knob inside
  // one 120 ms window is enough — and the converge runs first. It makes the unit match the
  // plan across the whole write scope, so every strip value the unit has just recomputed
  // goes back at its pre-morph value and the refetch reads what the converge left: a unit
  // holding a morph position whose strip belongs to a different position, with nothing on
  // screen to say so.
  //
  // The two 1-knobs are closed a step earlier — the plan stops emitting what they drive —
  // but the inspector edits the SSMCS strip directly, so the plan really does author these
  // and the converge has to be told instead (ParamSpec.drives).
  it("leaves the unit's morph alone when a converge shares the flush", async () => {
    const plan = basePlan();
    plan.nodeParams.ch1 = {
      ...plan.nodeParams.ch1,
      compEqType: COMP_EQ_SSMCS,
      panBal: 0,
      ssmcs: { ...structuredClone(SSMCS_INITIAL), morphing: 0 },
    };
    const every = planToCommands(model, plan);
    const cmd = (name: string): (typeof every)[number] => every.find((c) => c.name === name && c.node === "ch1")!;
    const key = (name: string): number => {
      const c = cmd(name);
      return addrKey(c.paramId, c.x, c.y);
    };
    const MORPH = key("SSMCS_MORPHING");
    // A value the morph drives, and one it does not — the second only shows that an edit
    // made in the same window still reaches the unit, since an over-wide exclusion would
    // stop the converge RESTORING such a value rather than stop the flush writing it. The
    // membership pin above is what fails on a widened set.
    const RATIO = key("SSMCS_COMP_RATIO");
    const SC_ON = key("SSMCS_SC_ON");
    const morphed = cmd("SSMCS_COMP_RATIO").vdValue + 54;
    const PAN = key("CH_PAN");
    const planPan = cmd("CH_PAN").vdValue;

    const device = new Map<number, number>(every.map((c) => [addrKey(c.paramId, c.x, c.y), c.vdValue]));
    vi.mocked(vdSet).mockImplementation(async (paramId: number, x: number, y: number, v: number) => {
      const k = addrKey(paramId, x, y);
      device.set(k, v);
      // The selector hard-pans the pair (measured) — that reset is what the converge is FOR,
      // and it has to still be pushed back while the morph's own values are left alone.
      if (k === key("PAN_BAL")) device.set(PAN, 63);
      if (k === MORPH) device.set(RATIO, morphed);
    });
    vi.mocked(vdGet).mockImplementation(async (paramId: number, x: number, y: number) => {
      const v = device.get(addrKey(paramId, x, y));
      if (v === undefined) throw new Error(`fake device holds no ${paramId}:${x}:${y}`);
      return v;
    });

    const seen: Array<{ ratio?: number; scOn?: number }> = [];
    const live = liveFor(plan, async () => {
      seen.push({ ratio: device.get(RATIO), scOn: device.get(SC_ON) });
      return null;
    });
    live.begin();

    // One window carrying both, plus an edit to a strip value the morph does NOT drive.
    plan.nodeParams.ch1 = {
      ...plan.nodeParams.ch1,
      panBal: 1,
      ssmcs: { ...plan.nodeParams.ch1?.ssmcs, morphing: 60, sc: { ...plan.nodeParams.ch1?.ssmcs?.sc, on: false } },
    };
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(5000);

    expect(vi.mocked(vdGet).mock.calls.length).toBeGreaterThan(0); // the converge really ran
    expect(seen).toEqual([{ ratio: morphed, scOn: 0 }]);
    // And the converge still did its own job: the pan the selector slammed is back.
    expect(device.get(PAN)).toBe(planPan);
  });

  // The same shape one layer out: the multi-band compressor's 1-knob is not a plan field
  // but an engine SLOT, and every slot of that array goes out under one parameter name. A
  // name is what carries the side effect, so under the ordinary one this write announced
  // nothing, the plan kept its copy of the eighteen values the unit had just recomputed —
  // and sent them back the moment the knob was switched off.
  it("reads the node back after the multi-band compressor's 1-knob level write", async () => {
    const plan = basePlan();
    const mbc = (level: number): void => {
      plan.nodeParams["bus.stereo"] = {
        ...plan.nodeParams["bus.stereo"],
        insertFx: 1792,
        insertFxParams: {
          [insertFxParamKey("mbc", MBC_ONE_KNOB.on.slot)]: 1,
          [insertFxParamKey("mbc", MBC_ONE_KNOB.level.slot)]: level,
        },
      };
    };
    mbc(10);
    const refetched: string[][] = [];
    const live = liveFor(plan, async (nodes) => {
      refetched.push([...nodes]);
      return null;
    });
    live.begin();
    mbc(30);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);

    expect(refetched).toEqual([["bus.stereo"]]);
  });

  it("reads the node back after a comp 1-knob level write", async () => {
    const plan = basePlan();
    setCh1CompOneKnob(plan, { oneKnob: true, oneKnobLevel: 20 });
    const refetched: string[][] = [];
    const live = liveFor(plan, async (nodes) => {
      refetched.push([...nodes]);
      return null;
    });
    live.begin();
    setCh1CompOneKnob(plan, { oneKnobLevel: 70 });
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);

    expect(refetched).toEqual([["ch1"]]);
    expect(vi.mocked(vdGet)).not.toHaveBeenCalled();
  });

  it("reads the node back when the comp 1-knob is switched on", async () => {
    const plan = basePlan();
    setCh1CompOneKnob(plan, { oneKnob: false, oneKnobLevel: 20 });
    const refetched: string[][] = [];
    const live = liveFor(plan, async (nodes) => {
      refetched.push([...nodes]);
      return null;
    });
    live.begin();
    setCh1CompOneKnob(plan, { oneKnob: true });
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);

    expect(refetched).toEqual([["ch1"]]);
    expect(vi.mocked(vdGet)).not.toHaveBeenCalled();
  });

  // A converge and a refetch can land in one flush — PAN/BAL and the 1-knob level inside
  // the same 120 ms window is enough — and the converge runs first. It makes the unit match
  // the plan across the whole write scope, so any address the plan still emits AND the unit
  // has just recomputed is written back at its pre-write value; the refetch that follows
  // then reads what the converge left. Nothing on screen says so, and the unit is left with
  // a 1-knob level whose three values belong to a different level (a level write moves
  // threshold, ratio and makeup; the knee only moves when the knob is switched on).
  //
  // What keeps it out is that the plan stops emitting the whole driven set while the knob is
  // on (translate.ts) — so this is the flush-level pin under that gate, and removing the gate
  // fails here rather than only in the translate suite.
  it("leaves the unit's 1-knob computation alone when a converge shares the flush", async () => {
    const plan = basePlan();
    plan.nodeParams.ch1 = {
      ...plan.nodeParams.ch1,
      panBal: 0,
      comp: { ...plan.nodeParams.ch1?.comp, oneKnob: true, oneKnobLevel: 20, threshold: -18, ratio: 3, gain: 6 },
    };
    // Through the escape hatch: the gate under test is what keeps these three out of the
    // ordinary emit, and the fake device holds every address regardless of who authors it.
    const every = planToCommands(model, plan, "all", { includeDeviceDriven: true });
    const addr = (name: string): number => {
      const c = every.find((x) => x.name === name && x.node === "ch1")!;
      return addrKey(c.paramId, c.x, c.y);
    };
    const THR = addr("COMP_THRESHOLD");
    const RAT = addr("COMP_RATIO");
    const GAIN = addr("COMP_GAIN");
    const LEVEL = addr("COMP_ONE_KNOB_LEVEL");

    // The unit: seeded from the plan the session opened on, and recomputing the three the
    // knob drives when the level is written (the measured shape — a level change moved all
    // three, announced 0.111 ms behind the level's own notify).
    const device = new Map<number, number>(every.map((c) => [addrKey(c.paramId, c.x, c.y), c.vdValue]));
    vi.mocked(vdSet).mockImplementation(async (paramId: number, x: number, y: number, v: number) => {
      const k = addrKey(paramId, x, y);
      device.set(k, v);
      if (k === LEVEL) {
        device.set(THR, -2700);
        device.set(RAT, 350);
        device.set(GAIN, 630);
      }
    });
    // Refuses an address it was never seeded with rather than answering 0: the seed covers
    // every address the plan can emit, so a miss is this case addressing the wrong one, and
    // a zero would be read as a device value and quietly change what the converge sends.
    vi.mocked(vdGet).mockImplementation(async (paramId: number, x: number, y: number) => {
      const v = device.get(addrKey(paramId, x, y));
      if (v === undefined) throw new Error(`fake device holds no ${paramId}:${x}:${y}`);
      return v;
    });

    const atRefetch: Array<Array<number | undefined>> = [];
    const live = liveFor(plan, async () => {
      atRefetch.push([device.get(THR), device.get(RAT), device.get(GAIN)]);
      return null;
    });
    live.begin();

    // One window carrying both: PAN/BAL (converge) and the 1-knob level (refetch).
    plan.nodeParams.ch1 = {
      ...plan.nodeParams.ch1,
      panBal: 1,
      comp: { ...plan.nodeParams.ch1?.comp, oneKnobLevel: 70 },
    };
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(5000);

    // The converge really ran — otherwise this case would pass for the wrong reason.
    expect(vi.mocked(vdGet).mock.calls.length).toBeGreaterThan(0);
    expect(atRefetch).toEqual([[-2700, 350, 630]]);
    // And it is still what the unit holds once the flush is over.
    expect([device.get(THR), device.get(RAT), device.get(GAIN)]).toEqual([-2700, 350, 630]);
  });

  it("reads the node back after a morphing write instead of pushing the strip back", async () => {
    const plan = basePlan();
    setCh1CompEqType(plan, COMP_EQ_SSMCS);
    const refetched: string[][] = [];
    const live = liveFor(plan, async (nodes) => {
      refetched.push([...nodes]);
      return null;
    });
    live.begin();
    setCh1Morphing(plan, 60);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(2000);

    expect(refetched).toEqual([["ch1"]]);
    // A converge would have re-read the write scope through vdGet and re-sent it, which
    // is what would put the pre-morph ratio and knee back on the device.
    expect(vi.mocked(vdGet)).not.toHaveBeenCalled();
  });

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
    expect(new Set(live.followAddrs().map((a) => a.join(":"))).has(addrOf(grown[0]))).toBe(true);
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

// The unit announces a change to these; the app never writes them. Before they were
// registered the notify reached no one, and a front-panel change showed up only at the
// next full read. Measured on a URX44V (2026-08-11, System V1.3.1.0): a CH → FX PRE/POST
// and a Track Count change each pushed a notify within a second of the panel operation.
describe("LiveSync read-only follow registrations", () => {
  const addrsOf = (live: LiveSync): Set<string> => new Set(live.followAddrs().map((a) => a.join(":")));
  const FX_TAP_IDS = [193, 197, 320, 324];
  const begun = (scope?: "all" | "scene"): { plan: Plan; live: LiveSync } => {
    const plan = basePlan();
    const live = scope
      ? new LiveSync({
          getModel: () => model,
          getPlan: () => plan,
          onError: () => {},
          onSent: () => {},
          onCollapsed: () => {},
          getScope: () => scope,
        })
      : liveFor(plan);
    live.begin();
    return { plan, live };
  };

  it("registers the CH → FX send taps, which translate never emits", () => {
    const { plan, live } = begun();
    const addrs = addrsOf(live);
    // CH1 → FX1 and CH1 → FX2 (mono bases 193 / 197, y = input index).
    expect(addrs.has("193:0:0")).toBe(true);
    expect(addrs.has("197:0:0")).toBe(true);
    // Every channel × every FX bus, not only the first: a panel change on any of them
    // is what this is for, and pinning one address would pass with fifteen missing.
    const taps = [...addrs].filter((a) => FX_TAP_IDS.includes(Number(a.split(":")[0])));
    const channels = model.nodes.filter((n) => n.kind === "channel").length;
    const fxBuses = model.nodes.filter((n) => n.kind === "bus" && n.id.startsWith("bus.fx")).length;
    expect(taps.length).toBe(channels * fxBuses);
    // Registration is not emission: the write side must not have moved.
    expect(planToCommands(model, plan).some((c) => FX_TAP_IDS.includes(c.paramId))).toBe(false);
  });

  it("routes an FX tap notify to its channel, so one scoped node read repairs it", () => {
    const { live } = begun();
    const addr = live.lookup(193, 0, 0);
    expect(addr?.node).toBe("ch1");
    // Not direct: applyDirect has no slot for a connection param, and the channel's
    // scoped read re-reads params.tap for every bus that channel sends to.
    expect(addr?.direct).toBe(false);
  });

  it("routes a Track Count notify to out.sdrec, the node whose scoped read holds 839", () => {
    const { live } = begun();
    expect(addrsOf(live).has("839:0:0")).toBe(true);
    const addr = live.lookup(839, 0, 0);
    // Load-bearing in both directions. An owner node is only correct while readback
    // reads 839 on a scoped read of that node — it is gated by `want("out.sdrec")`, and
    // if that ever went back to `only === undefined` the notify would take a scoped read
    // that never touches the address: green everywhere, repairing nothing. Leaving the
    // node undefined instead is the other failure — it works, at a whole-device read per
    // front-panel turn.
    expect(addr?.node).toBe("out.sdrec");
    expect(addr?.direct).toBe(false);
  });

  // Under *Scene only* a whole-device read restores the plan's scene-external values
  // afterwards (main.ts applyDeviceStateScoped -> scene-scope.ts, which names
  // sdRecTrackCount). Following 839 there would make the notify path and the full-read
  // path disagree about one value under one preference — so the follow set takes the same
  // sceneExternal filter the emitted set takes.
  it("drops the scene-external follow under scope 'scene', and keeps the taps", () => {
    const { live } = begun("scene");
    const addrs = addrsOf(live);
    expect(addrs.has("839:0:0")).toBe(false);
    expect(live.lookup(839, 0, 0)).toBeUndefined();
    // The differential: this is a sceneExternal filter, not "drop the read-only follows".
    // A send tap is scene state and still follows under the narrower scope.
    expect(addrs.has("193:0:0")).toBe(true);
    expect(live.lookup(193, 0, 0)?.node).toBe("ch1");
  });

  // STREAMING's list on the unit has no None, and a plan holds no STREAMING wire only where
  // nothing gave it one — a follow read of a unit on NONE, an undo. The session then writes
  // nothing there, keeps the address registered so a source picked on the unit's panel is
  // heard, and sends the source the moment one is drawn — the snapshot holds no value for it,
  // so the draw is a diff.
  it("follows STREAMING while the plan holds no source for it, and writes the one drawn onto it", async () => {
    const plan = basePlan();
    plan.connections = plan.connections.filter((c) => c.to !== "bus.stream:in");
    const live = liveFor(plan);
    live.begin();
    expect(addrsOf(live).has("705:0:0")).toBe(true);
    expect(addrsOf(live).has("706:0:0")).toBe(true);
    expect(live.lookup(705, 0, 0)?.node).toBe("bus.stream");

    setCh1Fader(plan, -6);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    const ids = vi.mocked(vdSet).mock.calls.map(([id]) => id);
    expect(ids.length, "the control: the flush sent the fader").toBeGreaterThan(0);
    expect(ids).not.toContain(705);
    expect(ids).not.toContain(706);

    vi.mocked(vdSet).mockClear();
    plan.connections.push({ from: "bus.stereo:out", to: "bus.stream:in", kind: "source" });
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    const stream = vi
      .mocked(vdSet)
      .mock.calls.filter(([id]) => id === 705 || id === 706)
      .map(([id, , , value]) => `${id}=${value}`);
    expect(stream.sort()).toEqual([`705=${(0x80000000 | 256) >>> 0}`, `706=${(0x80000000 | 257) >>> 0}`]);
    expect(addrsOf(live).has("705:0:0")).toBe(true);
  });

  // A guard, not evidence: this one passes with the registrations and without them,
  // because the addresses were never written either way. It is here to fail the day
  // someone widens the registration loop into the emit path.
  it("writes none of the newly registered addresses when the plan's own tap changes", async () => {
    const { plan, live } = begun();
    const conn = plan.connections.find((c) => c.from === "ch1:out" && c.to === "bus.fx1:in");
    if (!conn) throw new Error("expected a ch1 → FX1 send connection");
    conn.params = { ...conn.params, tap: conn.params?.tap === "pre" ? "post" : "pre" };
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    const sent = vi.mocked(vdSet).mock.calls.map(([id]) => id);
    for (const id of [...FX_TAP_IDS, 839]) expect(sent).not.toContain(id);
  });
});

// A device-follow read is issued for the node the operator moved on the hardware, and
// that node's addresses can include ones this session's flush wrote tens of ms ago —
// inside the measured 9-204 ms window in which the unit still answers a GET with the
// PRE-write value. The read used to take that as device truth, and the unit's own
// notify for our write (which would have repaired it) was consumed as an echo, so the
// operator's toggle flipped back on screen and plan and snapshot agreed on a value the
// device does not hold until the idle sweep re-read past the window.
describe("LiveSync recentPending", () => {
  it("hands a follow read the writes it must settle before reading them", async () => {
    const plan = basePlan();
    const live = liveFor(plan);
    live.begin();
    setCh1Fader(plan, -6);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    expect(vi.mocked(vdSet)).toHaveBeenCalledTimes(1);
    const [paramId, x, y] = vi.mocked(vdSet).mock.calls[0];
    const k = addrKey(paramId, x, y);

    // Scoped to the node the read covers: that address must be settled.
    const scoped = live.recentPending(new Set(["ch1"]));
    expect(scoped.written.has(k)).toBe(true);
    expect(scoped.mustSettle.has(k)).toBe(true);
    // A read of some OTHER node does not wait for it — it is not reading that address.
    expect(live.recentPending(new Set(["ch2"])).mustSettle.has(k)).toBe(false);
    // Unscoped = a whole-device read, which covers everything.
    expect(live.recentPending().mustSettle.has(k)).toBe(true);

    // The flush already armed the announcement watch for these writes; a second one
    // here would report one silent write twice and arm two reconciles for it.
    expect(scoped.mustAnnounce.size).toBe(0);
  });

  // The claim above is only true because the flush arms one for a flush with NO epilogue
  // too. It used to arm one solely beside the refetch read, so an ordinary edit — a
  // fader, a mute, a pan, a rename, every flush carrying no sideEffect head — had no
  // watch at all: a write the unit silently dropped left the plan and the snapshot
  // agreeing on a value the device does not hold, with nothing scheduled to notice.
  // Follow's idle full sweep is the repair, and this report is the only thing that arms
  // it from the write side.
  it("reports an ordinary write the unit never announced", async () => {
    const plan = basePlan();
    const live = liveFor(plan);
    const reports: Array<ReadonlySet<number>> = [];
    const release = writeSettle.arm((addrs) => reports.push(addrs));
    try {
      // A snapshot that already HOLDS a value for the address is what makes the write an
      // obligation: the unit must move, so it must announce. begin() takes it from the
      // plan, then the edit diffs against it.
      live.begin();
      setCh1Fader(plan, -6);
      live.schedule();
      await vi.advanceTimersByTimeAsync(120);
      expect(vi.mocked(vdSet)).toHaveBeenCalledTimes(1);
      const [paramId, x, y] = vi.mocked(vdSet).mock.calls[0];
      const k = addrKey(paramId, x, y);

      // Nothing is reported before the bound: an announcement still in flight is not a
      // silent write, and reporting it here would order a sweep for every edit.
      await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS - 1);
      expect(reports).toEqual([]);
      await vi.advanceTimersByTimeAsync(2);
      expect(reports.length).toBe(1);
      expect(reports[0].has(k)).toBe(true);
    } finally {
      release();
    }
  });

  // A rename goes out through vdSetStr, which fills none of the numeric write ledger, so
  // the watch has to be handed the name addresses separately. Left out, a dropped rename is
  // invisible twice over: the plan and the name snapshot both hold the new name, so no later
  // flush finds a diff to re-send, and the unit keeps the old one with nothing pointing at it.
  it("reports a rename the unit never announced", async () => {
    const plan = basePlan();
    const live = liveFor(plan);
    const reports: Array<ReadonlySet<number>> = [];
    const release = writeSettle.arm((addrs) => reports.push(addrs));
    try {
      live.begin();
      plan.nodeNames = { ...plan.nodeNames, ch1: "RENAMED" };
      live.schedule();
      await vi.advanceTimersByTimeAsync(120);
      expect(vi.mocked(vdSetStr)).toHaveBeenCalledTimes(1);
      const [param, , y] = vi.mocked(vdSetStr).mock.calls[0];
      const k = addrKey(param, 0, y);

      await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS - 1);
      expect(reports).toEqual([]);
      await vi.advanceTimersByTimeAsync(2);
      expect(reports.length).toBe(1);
      expect(reports[0].has(k)).toBe(true);
    } finally {
      release();
    }
  });

  // A rename sharing its flush with a converge head. Neither epilogue covers names — the
  // converge re-reads numeric commands — so before the watch was lifted out of the
  // epilogue guard this rename was watched by nothing. An external MIDI control can send
  // a bank-resetting selector while a name is being typed, so the two do meet.
  it("reports a silent rename that shared a flush with a converge head", async () => {
    const plan = basePlan();
    const live = liveFor(plan);
    const reports: Array<ReadonlySet<number>> = [];
    const release = writeSettle.arm((addrs) => reports.push(addrs));
    try {
      live.begin();
      plan.nodeParams["bus.mix1"] = { ...plan.nodeParams["bus.mix1"], busType: 1 };
      plan.nodeNames = { ...plan.nodeNames, ch1: "RENAMED" };
      live.schedule();
      await vi.advanceTimersByTimeAsync(120);
      expect(vi.mocked(vdSetStr)).toHaveBeenCalledTimes(1);
      const [param, , y] = vi.mocked(vdSetStr).mock.calls[0];
      const k = addrKey(param, 0, y);
      await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS + 2000);
      expect(reports.some((r) => r.has(k))).toBe(true);
    } finally {
      release();
    }
  });

  it("says nothing about a rename the unit announced in a converge flush", async () => {
    const plan = basePlan();
    const live = liveFor(plan);
    const reports: Array<ReadonlySet<number>> = [];
    const release = writeSettle.arm((addrs) => reports.push(addrs));
    try {
      live.begin();
      plan.nodeParams["bus.mix1"] = { ...plan.nodeParams["bus.mix1"], busType: 1 };
      plan.nodeNames = { ...plan.nodeNames, ch1: "RENAMED" };
      live.schedule();
      await vi.advanceTimersByTimeAsync(120);
      const [param, , y, sent] = vi.mocked(vdSetStr).mock.calls[0];
      const k = addrKey(param, 0, y);
      // The TEXT, because that is what a name announcement carries — its numeric value is
      // 0 filler. Announcing the filler alone is a shape the unit never sends, and it is
      // now the shape of a rename the unit did NOT announce.
      writeSettle.note({ paramId: param, x: 0, y, value: 0, valueStr: sent });
      await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS + 2000);
      expect(reports.some((r) => r.has(k))).toBe(false);
    } finally {
      release();
    }
  });

  it("reports nothing when the unit announced the rename", async () => {
    const plan = basePlan();
    const live = liveFor(plan);
    const reports: Array<ReadonlySet<number>> = [];
    const release = writeSettle.arm((addrs) => reports.push(addrs));
    try {
      live.begin();
      plan.nodeNames = { ...plan.nodeNames, ch1: "RENAMED" };
      live.schedule();
      await vi.advanceTimersByTimeAsync(120);
      const [param, , y, sent] = vi.mocked(vdSetStr).mock.calls[0];
      // The TEXT the unit announces, not merely that the address spoke: a run of renames on
      // one address produces ONE notify, and only its text says whether it answers the last
      // rename or an earlier one the next rename replaced.
      writeSettle.note({ paramId: param, x: 0, y, value: 0, valueStr: sent });
      await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS + 1);
      expect(reports).toEqual([]);
    } finally {
      release();
    }
  });

  it("reports nothing when the unit did announce the write", async () => {
    const plan = basePlan();
    const live = liveFor(plan);
    const reports: Array<ReadonlySet<number>> = [];
    const release = writeSettle.arm((addrs) => reports.push(addrs));
    try {
      live.begin();
      setCh1Fader(plan, -6);
      // The unit answers its own write, which is what the watch is looking for. Fed from
      // inside vdSet so the notify lands AFTER that address's own mark, as a real one does.
      vi.mocked(vdSet).mockImplementation(async (paramId: number, x: number, y: number, value: number) => {
        writeSettle.note({ paramId, x, y, value });
      });
      live.schedule();
      await vi.advanceTimersByTimeAsync(120);
      await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS + 10);
      expect(reports).toEqual([]);
    } finally {
      release();
    }
  });

  it("forgets a write once it is older than the settle window, and at a session boundary", async () => {
    const plan = basePlan();
    const live = liveFor(plan);
    live.begin();
    setCh1Fader(plan, -6);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    const [paramId, x, y] = vi.mocked(vdSet).mock.calls[0];
    const k = addrKey(paramId, x, y);
    expect(live.recentPending().written.has(k)).toBe(true);

    await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS + 1);
    expect(live.recentPending().written.has(k)).toBe(false);

    // And a mark taken on one link means nothing on the next.
    setCh1Fader(plan, -9);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    expect(live.recentPending().written.size).toBeGreaterThan(0);
    live.end();
    expect(live.recentPending().written.size).toBe(0);
  });
});

// +48V and HI-Z are never on together. The flush asks the rule of what it knows the unit
// holds — the snapshot, and what the unit announced since — because an ON can wait in the plan
// while the unit turns the other switch on at its own panel, before the follow read that notify
// schedules has brought it into the plan.
describe("LiveSync and the +48V / HI-Z exclusion", () => {
  const Y = 2; // CH 3
  const switchSends = (): Array<[number, number]> =>
    vi
      .mocked(vdSet)
      .mock.calls.filter(([id, , y]) => y === Y && (id === PARAMS.PHANTOM.id || id === PARAMS.HI_Z.id))
      .map(([id, , , v]) => [id, v]);
  const planWith = (ch3: { phantom: boolean; hiZ: boolean }): Plan => {
    const plan = basePlan();
    plan.nodeParams.ch3 = ch3;
    return plan;
  };
  const flush = async (live: LiveSync): Promise<void> => {
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
  };

  it("sends a +48V ON the plan holds (the control)", async () => {
    const plan = planWith({ phantom: false, hiZ: false });
    const live = liveFor(plan);
    live.begin();
    plan.nodeParams.ch3 = { phantom: true, hiZ: false };
    await flush(live);
    expect(switchSends()).toEqual([[PARAMS.PHANTOM.id, 1]]);
  });

  // The unit is asked for the other switch just before the ON goes, which catches a switch it
  // turned on whose announcement has not reached the session yet.
  it("holds a +48V ON when the unit answers HI-Z on to the read in front of it", async () => {
    const plan = planWith({ phantom: false, hiZ: false });
    const live = liveFor(plan);
    live.begin();
    vi.mocked(vdGet).mockImplementation(async (id, x, y) => (id === PARAMS.HI_Z.id && x === 0 && y === Y ? 1 : 0));
    plan.nodeParams.ch3 = { phantom: true, hiZ: false };
    await flush(live);
    expect(vi.mocked(vdGet).mock.calls, "the premise: the unit was asked").toContainEqual([PARAMS.HI_Z.id, 0, Y]);
    expect(switchSends()).toEqual([]);
  });

  // A read that fails is a failed operation on the device link: the session ends, and the ON
  // it was asked for is not sent on a guess.
  it("ends the session and sends nothing when the read in front of an ON fails", async () => {
    const plan = planWith({ phantom: false, hiZ: false });
    const errors: string[] = [];
    const live = new LiveSync({
      getModel: () => model,
      getPlan: () => plan,
      onError: (m) => void errors.push(m),
      onSent: () => {},
      onCollapsed: () => {},
    });
    live.begin();
    vi.mocked(vdGet).mockRejectedValue(new Error("read refused"));
    plan.nodeParams.ch3 = { phantom: true, hiZ: false };
    await flush(live);
    expect(errors).toEqual(["read refused"]);
    expect(live.isActive()).toBe(false);
    expect(switchSends()).toEqual([]);
  });

  it("holds a +48V ON while the unit has announced HI-Z on, and sends it once the unit says it is off", async () => {
    const plan = planWith({ phantom: false, hiZ: false });
    const live = liveFor(plan);
    live.begin();
    expect(live.isEcho(PARAMS.HI_Z.id, 0, Y, 1), "the premise: a change at the unit's panel").toBe(false);
    plan.nodeParams.ch3 = { phantom: true, hiZ: false };
    await flush(live);
    expect(switchSends()).toEqual([]);
    // Nothing edits the plan from here: the announcement alone asks again.
    live.isEcho(PARAMS.HI_Z.id, 0, Y, 0);
    await vi.advanceTimersByTimeAsync(120);
    expect(switchSends()).toEqual([[PARAMS.PHANTOM.id, 1]]);
  });

  it("holds it against the snapshot as well, where a read found HI-Z on", async () => {
    const plan = planWith({ phantom: false, hiZ: true });
    const live = liveFor(plan);
    live.begin();
    plan.nodeParams.ch3 = { phantom: true, hiZ: true };
    await flush(live);
    expect(switchSends()).toEqual([]);
  });

  it("sends +48V ON behind the HI-Z OFF the same flush sends", async () => {
    const plan = planWith({ phantom: false, hiZ: true });
    const live = liveFor(plan);
    live.begin();
    live.isEcho(PARAMS.HI_Z.id, 0, Y, 1);
    plan.nodeParams.ch3 = { phantom: true, hiZ: false };
    await flush(live);
    expect(switchSends()).toEqual([
      [PARAMS.HI_Z.id, 0],
      [PARAMS.PHANTOM.id, 1],
    ]);
  });

  // A notify can be lost. The read that re-reads the node after the announcement carries what
  // the unit holds, and a HI-Z the read found off lets the held ON out; a read of another node
  // carries nothing about CH 3, so the announcement still stands.
  it("lets the held ON out once a read issued after the announcement covers the channel", async () => {
    const plan = planWith({ phantom: false, hiZ: false });
    const live = liveFor(plan);
    live.begin();
    live.isEcho(PARAMS.HI_Z.id, 0, Y, 1);
    plan.nodeParams.ch3 = { phantom: true, hiZ: false };
    await flush(live);
    expect(switchSends()).toEqual([]);

    const view = (): Plan => {
      const unit = clonePlanState(plan);
      unit.nodeParams.ch3 = { phantom: false, hiZ: false };
      return unit;
    };
    live.resync(view(), live.directMark(), new Set(["ch1"]));
    await vi.advanceTimersByTimeAsync(120);
    expect(switchSends(), "a read of another node").toEqual([]);

    live.resync(view(), live.directMark(), new Set(["ch3"]));
    await vi.advanceTimersByTimeAsync(120);
    expect(switchSends()).toEqual([[PARAMS.PHANTOM.id, 1]]);
  });

  // HI-Z's ON lowers A.Gain in the same edit (`hiZPatch`), and that A.Gain waits with the ON it
  // came with: a press the read then refuses has moved nothing on the unit.
  describe("the A.Gain a HI-Z ON carries", () => {
    const gainSends = (): number[] =>
      vi
        .mocked(vdSet)
        .mock.calls.filter(([id, , y]) => id === PARAMS.HA_GAIN.id && y === Y)
        .map(([, , , v]) => v);

    it("waits with a held HI-Z ON, and goes out with it once the unit says +48V is off", async () => {
      const plan = basePlan();
      plan.nodeParams.ch3 = { phantom: false, hiZ: false, gain: 60 };
      const live = liveFor(plan);
      live.begin();
      live.isEcho(PARAMS.PHANTOM.id, 0, Y, 1);
      plan.nodeParams.ch3 = { phantom: false, hiZ: true, gain: 40 };
      await flush(live);
      expect({ switches: switchSends(), gain: gainSends() }).toEqual({ switches: [], gain: [] });

      live.isEcho(PARAMS.PHANTOM.id, 0, Y, 0);
      await vi.advanceTimersByTimeAsync(120);
      expect({ switches: switchSends(), gain: gainSends() }).toEqual({
        switches: [[PARAMS.HI_Z.id, 1]],
        gain: [gainToVd(40)],
      });
    });

    it("sends an A.Gain the operator set on their own while a HI-Z ON waits", async () => {
      const plan = basePlan();
      plan.nodeParams.ch3 = { phantom: false, hiZ: false, gain: 60 };
      const live = liveFor(plan);
      live.begin();
      live.isEcho(PARAMS.PHANTOM.id, 0, Y, 1);
      plan.nodeParams.ch3 = { phantom: false, hiZ: true, gain: 40 };
      await flush(live);
      plan.nodeParams.ch3 = { phantom: false, hiZ: true, gain: 30 };
      await flush(live);
      expect({ switches: switchSends(), gain: gainSends() }).toEqual({ switches: [], gain: [gainToVd(30)] });
    });

    it("sends an A.Gain moved with no HI-Z ON waiting, while +48V is on (the control)", async () => {
      const plan = basePlan();
      plan.nodeParams.ch3 = { phantom: false, hiZ: false, gain: 60 };
      const live = liveFor(plan);
      live.begin();
      live.isEcho(PARAMS.PHANTOM.id, 0, Y, 1);
      plan.nodeParams.ch3 = { phantom: false, hiZ: false, gain: 50 };
      await flush(live);
      expect(gainSends()).toEqual([gainToVd(50)]);
    });
  });

  // A converge re-sends whatever differs across the write scope, and a switch the unit turned on
  // at its own panel differs from a plan that has not heard yet. The converge leaves that
  // channel's two switches to the follow read the announcement scheduled, and the capture behind
  // it learns nothing about them.
  describe("behind a converge", () => {
    /** The unit: what `plan` holds now, with CH 3's two switches as `sw` says at each read. */
    const unitAnswers = (plan: Plan, sw: { phantom: number; hiZ: number }): void => {
      const values = new Map(planToCommands(model, plan).map((c) => [cmdAddr(c), c.vdValue] as const));
      vi.mocked(vdGet).mockImplementation(async (id: number, x: number, y: number) => {
        if (y === Y && id === PARAMS.PHANTOM.id) return sw.phantom;
        if (y === Y && id === PARAMS.HI_Z.id) return sw.hiZ;
        return values.get(addrKey(id, x, y)) ?? 0;
      });
    };

    it("does not write a HI-Z the unit turned on at its panel back off, and holds +48V against it", async () => {
      const plan = planWith({ phantom: false, hiZ: false });
      const live = liveFor(plan);
      live.begin();
      live.isEcho(PARAMS.HI_Z.id, 0, Y, 1);
      setCh1CompEqType(plan, 1);
      unitAnswers(plan, { phantom: 0, hiZ: 1 });
      await flush(live);
      await vi.advanceTimersByTimeAsync(3000);
      expect(vi.mocked(vdGet), "the premise: the converge read the unit").toHaveBeenCalled();
      expect(switchSends(), "the unit's own HI-Z is left on").toEqual([]);

      plan.nodeParams.ch3 = { phantom: true, hiZ: false };
      await flush(live);
      await vi.advanceTimersByTimeAsync(3000);
      expect(switchSends(), "no +48V ON while the unit holds HI-Z on").toEqual([]);
    });

    it("sends a +48V ON it held across a converge once the unit turns HI-Z off", async () => {
      const plan = planWith({ phantom: false, hiZ: false });
      const live = liveFor(plan);
      live.begin();
      const sw = { phantom: 0, hiZ: 1 };
      live.isEcho(PARAMS.HI_Z.id, 0, Y, 1);
      plan.nodeParams.ch3 = { phantom: true, hiZ: false };
      await flush(live);
      expect(switchSends(), "the premise: the ON is held").toEqual([]);

      setCh1CompEqType(plan, 1);
      unitAnswers(plan, sw);
      await flush(live);
      await vi.advanceTimersByTimeAsync(3000);
      expect(switchSends(), "still held behind the converge").toEqual([]);

      sw.hiZ = 0;
      live.isEcho(PARAMS.HI_Z.id, 0, Y, 0);
      await vi.advanceTimersByTimeAsync(3000);
      expect(switchSends()).toEqual([[PARAMS.PHANTOM.id, 1]]);
    });

    // The panel can move while the converge runs. The CH 1 fader never takes the value the
    // converge sends, so the converge goes round again after the announcement lands.
    it("leaves a HI-Z the unit turns on while the converge runs", async () => {
      const plan = planWith({ phantom: false, hiZ: false });
      const live = liveFor(plan);
      live.begin();
      setCh1CompEqType(plan, 1);
      const unit = clonePlanState(plan);
      setCh1Fader(unit, -20);
      const sw = { phantom: 0, hiZ: 0 };
      let faderSends = 0;
      vi.mocked(vdSet).mockImplementation(async (id: number, _x: number, y: number) => {
        if (id !== PARAMS.CH_FADER.id || y !== 0) return;
        faderSends += 1;
        if (faderSends === 1) {
          sw.hiZ = 1;
          live.isEcho(PARAMS.HI_Z.id, 0, Y, 1);
        }
      });
      unitAnswers(unit, sw);
      await flush(live);
      await vi.advanceTimersByTimeAsync(5000);
      expect(faderSends, "the premise: a round went out after the announcement").toBeGreaterThan(1);
      expect(switchSends(), "the unit's own HI-Z is left on").toEqual([]);
    });
  });
});
