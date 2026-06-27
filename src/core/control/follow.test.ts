import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// DeviceFollow registers for device-side param notifies through
// platform.vdParamsSubscribe and classifies each via the live address index
// (lookup): a direct param applies straight into the plan, a scoped one re-reads
// its owner node after the burst settles, and an unknown / over-concentrated
// burst escalates to a full read. Mock the transport so a test can capture the
// notify callback and drive notifies directly.
const h = vi.hoisted(() => ({
  onUpdate: null as null | ((p: { paramId: number; x: number; y: number; value: number }) => void),
  addrs: null as null | Array<[number, number, number]>,
  unsub: vi.fn(),
  subscribeCalls: 0,
}));

vi.mock("../platform", () => ({
  vdParamsSubscribe: vi.fn((addrs: Array<[number, number, number]>, onUpdate: typeof h.onUpdate) => {
    h.addrs = addrs;
    h.onUpdate = onUpdate;
    h.subscribeCalls++;
    return h.unsub;
  }),
}));

import { DeviceFollow, type DeviceFollowHooks } from "./follow";
import type { FollowAddr } from "./live";

const ADDR: [number, number, number] = [139, 0, 0];
// A scoped owner for ADDR by default, so the reconcile-path tests exercise the
// node-scoped read; direct/escalation tests override lookup.
const SCOPED: FollowAddr = { name: "CH_FADER", node: "ch1", direct: false };

function followFor(overrides: Partial<DeviceFollowHooks> = {}): DeviceFollow {
  return new DeviceFollow({
    addrs: () => [ADDR],
    isEcho: () => false,
    lookup: () => SCOPED,
    applyDirect: () => true,
    flushDirect: () => {},
    reconcileNodes: async () => {},
    reconcileAll: async () => {},
    onFollow: () => {},
    onError: () => {},
    ...overrides,
  });
}

function notify(value: number): void {
  h.onUpdate?.({ paramId: ADDR[0], x: ADDR[1], y: ADDR[2], value });
}

function notifyAddr(paramId: number, value: number): void {
  h.onUpdate?.({ paramId, x: 0, y: 0, value });
}

beforeEach(() => {
  h.onUpdate = null;
  h.addrs = null;
  h.unsub.mockReset();
  h.subscribeCalls = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DeviceFollow", () => {
  it("registers the writable address set on begin", () => {
    const follow = followFor();
    follow.begin();
    expect(h.subscribeCalls).toBe(1);
    expect(h.addrs).toEqual([ADDR]);
  });

  it("re-reads the owner node once after a scoped burst settles", async () => {
    const reconcileNodes = vi.fn(async () => {});
    const follow = followFor({ reconcileNodes });
    follow.begin();
    // A knob sweep: several non-echo notifies inside the debounce window.
    for (let i = 1; i <= 6; i++) {
      notify(-i * 100);
      await vi.advanceTimersByTimeAsync(40);
    }
    expect(reconcileNodes).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(reconcileNodes).toHaveBeenCalledTimes(1);
    expect(reconcileNodes).toHaveBeenCalledWith(new Set(["ch1"]));
  });

  it("applies a direct change straight to the plan with no read-back", async () => {
    const applyDirect = vi.fn(() => true);
    const flushDirect = vi.fn();
    const reconcileNodes = vi.fn(async () => {});
    const reconcileAll = vi.fn(async () => {});
    const follow = followFor({
      lookup: () => ({ name: "CH_FADER", node: "ch1", direct: true }),
      applyDirect,
      flushDirect,
      reconcileNodes,
      reconcileAll,
    });
    follow.begin();
    notify(-600);
    // Applied synchronously; the host coalesces the render via flushDirect.
    expect(applyDirect).toHaveBeenCalledWith("ch1", "CH_FADER", -600);
    expect(flushDirect).toHaveBeenCalled();
    // Settle window passes without any read-back (direct-only window).
    await vi.advanceTimersByTimeAsync(300);
    expect(reconcileNodes).not.toHaveBeenCalled();
    expect(reconcileAll).not.toHaveBeenCalled();
  });

  it("falls back to a scoped read when a direct apply reports it is unplaceable", async () => {
    const reconcileNodes = vi.fn(async () => {});
    const follow = followFor({
      lookup: () => ({ name: "CH_FADER", node: "ch1", direct: true }),
      applyDirect: () => false,
      reconcileNodes,
    });
    follow.begin();
    notify(-600);
    await vi.advanceTimersByTimeAsync(300);
    expect(reconcileNodes).toHaveBeenCalledWith(new Set(["ch1"]));
  });

  it("ignores echoes of our own writes (no apply, no read-back)", async () => {
    const applyDirect = vi.fn();
    const reconcileNodes = vi.fn(async () => {});
    const follow = followFor({ isEcho: () => true, applyDirect, reconcileNodes });
    follow.begin();
    notify(-600);
    await vi.advanceTimersByTimeAsync(500);
    expect(applyDirect).not.toHaveBeenCalled();
    expect(reconcileNodes).not.toHaveBeenCalled();
  });

  it("escalates an unknown address to a full read", async () => {
    const reconcileAll = vi.fn(async () => {});
    const reconcileNodes = vi.fn(async () => {});
    const follow = followFor({ lookup: () => undefined, reconcileAll, reconcileNodes });
    follow.begin();
    notify(-600);
    await vi.advanceTimersByTimeAsync(300);
    expect(reconcileAll).toHaveBeenCalledTimes(1);
    expect(reconcileNodes).not.toHaveBeenCalled();
  });

  it("escalates to a full read when more than three controls change at once", async () => {
    const reconcileAll = vi.fn(async () => {});
    const reconcileNodes = vi.fn(async () => {});
    const follow = followFor({
      lookup: (paramId) => ({ name: "CH_FADER", node: `n${paramId}`, direct: false }),
      reconcileAll,
      reconcileNodes,
    });
    follow.begin();
    for (const id of [10, 11, 12, 13]) notifyAddr(id, -100);
    await vi.advanceTimersByTimeAsync(300);
    expect(reconcileAll).toHaveBeenCalledTimes(1);
    expect(reconcileNodes).not.toHaveBeenCalled();
  });

  it("runs a full read as an idle safety net after the device goes quiet", async () => {
    const reconcileNodes = vi.fn(async () => {});
    const reconcileAll = vi.fn(async () => {});
    const follow = followFor({ reconcileNodes, reconcileAll });
    follow.begin();
    notify(-600);
    await vi.advanceTimersByTimeAsync(300);
    expect(reconcileNodes).toHaveBeenCalledTimes(1);
    expect(reconcileAll).not.toHaveBeenCalled();
    // 900 ms total since the notify → the idle full reconcile fires once.
    await vi.advanceTimersByTimeAsync(600);
    expect(reconcileAll).toHaveBeenCalledTimes(1);
  });

  it("does not re-register after a reconcile that left the address set unchanged", async () => {
    const follow = followFor();
    follow.begin();
    expect(h.subscribeCalls).toBe(1);
    notify(-600);
    await vi.advanceTimersByTimeAsync(300);
    // The set is identical, so the post-reconcile subscribe is a no-op — no
    // re-posting of every address to the broker.
    expect(h.subscribeCalls).toBe(1);
  });

  it("re-registers only when the writable address set changed", async () => {
    let addrs: Array<[number, number, number]> = [ADDR];
    const follow = followFor({
      addrs: () => addrs,
      reconcileNodes: async () => {
        addrs = [ADDR, [140, 0, 0]];
      },
    });
    follow.begin();
    expect(h.subscribeCalls).toBe(1);
    notify(-600);
    await vi.advanceTimersByTimeAsync(300);
    // The reconcile grew the set, so the post-reconcile subscribe re-registers.
    expect(h.subscribeCalls).toBe(2);
    expect(h.addrs).toEqual([ADDR, [140, 0, 0]]);
  });

  it("stops and reports when a reconcile fails", async () => {
    const onError = vi.fn();
    const follow = followFor({
      reconcileNodes: async () => {
        throw new Error("readback failed");
      },
      onError,
    });
    follow.begin();
    notify(-600);
    await vi.advanceTimersByTimeAsync(300);
    expect(onError).toHaveBeenCalledWith("readback failed");
    expect(follow.isActive()).toBe(false);
  });

  it("is inert after end(): unsubscribes and drops pending work", async () => {
    const reconcileNodes = vi.fn(async () => {});
    const reconcileAll = vi.fn(async () => {});
    const follow = followFor({ reconcileNodes, reconcileAll });
    follow.begin();
    notify(-600); // schedules a reconcile + idle full
    follow.end();
    expect(h.unsub).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(reconcileNodes).not.toHaveBeenCalled();
    expect(reconcileAll).not.toHaveBeenCalled();
  });

  it("does nothing on a notify before begin", async () => {
    const reconcileNodes = vi.fn(async () => {});
    followFor({ reconcileNodes });
    // No begin(): nothing subscribed, so there is no callback to fire.
    expect(h.onUpdate).toBeNull();
    await vi.advanceTimersByTimeAsync(500);
    expect(reconcileNodes).not.toHaveBeenCalled();
  });
});
