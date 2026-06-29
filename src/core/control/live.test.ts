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

function liveFor(plan: Plan): LiveSync {
  return new LiveSync({
    getModel: () => model,
    getPlan: () => plan,
    onError: () => {},
    onSent: () => {},
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

  it("coalesces a continuous drag into a single device write", async () => {
    const plan = basePlan();
    const live = liveFor(plan);
    live.begin();
    // 30 input events ~16ms apart (a smooth ~480ms drag), each below the 120ms
    // debounce, so the trailing timer keeps resetting and nothing is sent yet.
    for (let i = 1; i <= 30; i++) {
      setCh1Fader(plan, -i);
      live.schedule();
      await vi.advanceTimersByTimeAsync(16);
    }
    expect(vi.mocked(vdSet)).not.toHaveBeenCalled();
    // The drag ends; the debounce settles and flushes once with the final value.
    await vi.advanceTimersByTimeAsync(120);
    expect(vi.mocked(vdSet)).toHaveBeenCalledTimes(1);
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
  it("does not drop an edit that arrives during a sideEffect converge", async () => {
    const plan = basePlan();
    const live = liveFor(plan);
    live.begin();
    setCh1CompEqType(plan, 1);
    // The device mirrors the plan as it stands when the converge starts, so the
    // converge's initial diff is empty and it exits after one read pass (the exact
    // window where a late edit is at risk of being baked into the snapshot).
    const mirror = new Map(
      planToCommands(model, plan).map((c) => [`${c.paramId}:${c.x}:${c.y}`, c.vdValue]),
    );
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
