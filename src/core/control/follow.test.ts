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
  failNext: false,
}));

vi.mock("../platform", () => ({
  // Awaited by DeviceFollow, so a failed registration stops the session rather
  // than leaving it blind to device-side edits.
  vdParamsSubscribe: vi.fn(async (addrs: Array<[number, number, number]>, onUpdate: typeof h.onUpdate) => {
    h.addrs = addrs;
    h.onUpdate = onUpdate;
    h.subscribeCalls++;
    if (h.failNext) {
      h.failNext = false;
      throw new Error("subscribe rejected");
    }
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
    noteDirect: () => {},
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
  h.failNext = false;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DeviceFollow", () => {
  it("registers the writable address set on begin", async () => {
    const follow = followFor();
    await follow.begin();
    expect(h.subscribeCalls).toBe(1);
    expect(h.addrs).toEqual([ADDR]);
  });

  // Without the notify stream the app cannot see device-side edits, and the next
  // converge writes the plan back over them — so a failed registration has to
  // reach the caller instead of leaving a session that looks started.
  it("rejects from begin when the registration fails", async () => {
    h.failNext = true;
    const follow = followFor();
    await expect(follow.begin()).rejects.toThrow("subscribe rejected");
  });

  it("re-reads the owner node once after a scoped burst settles", async () => {
    const reconcileNodes = vi.fn(async () => {});
    const follow = followFor({ reconcileNodes });
    await follow.begin();
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
    const noteDirect = vi.fn();
    const flushDirect = vi.fn();
    const reconcileNodes = vi.fn(async () => {});
    const reconcileAll = vi.fn(async () => {});
    const follow = followFor({
      lookup: () => ({ name: "CH_FADER", node: "ch1", direct: true }),
      applyDirect,
      noteDirect,
      flushDirect,
      reconcileNodes,
      reconcileAll,
    });
    await follow.begin();
    notify(-600);
    // Applied synchronously; the host coalesces the render via flushDirect.
    expect(applyDirect).toHaveBeenCalledWith("ch1", "CH_FADER", -600);
    // The snapshot is patched with the notify's address + value (no full re-translate).
    expect(noteDirect).toHaveBeenCalledWith(ADDR[0], ADDR[1], ADDR[2], -600);
    expect(flushDirect).toHaveBeenCalled();
    // Settle window passes without any read-back (direct-only window).
    await vi.advanceTimersByTimeAsync(300);
    expect(reconcileNodes).not.toHaveBeenCalled();
    expect(reconcileAll).not.toHaveBeenCalled();
  });

  it("does not patch the snapshot when a direct apply reports unplaceable", async () => {
    const noteDirect = vi.fn();
    const follow = followFor({
      lookup: () => ({ name: "CH_FADER", node: "ch1", direct: true }),
      applyDirect: () => false,
      noteDirect,
    });
    await follow.begin();
    notify(-600);
    // Falls back to a scoped read, so the snapshot must not be pre-patched.
    expect(noteDirect).not.toHaveBeenCalled();
  });

  it("falls back to a scoped read when a direct apply reports it is unplaceable", async () => {
    const reconcileNodes = vi.fn(async () => {});
    const follow = followFor({
      lookup: () => ({ name: "CH_FADER", node: "ch1", direct: true }),
      applyDirect: () => false,
      reconcileNodes,
    });
    await follow.begin();
    notify(-600);
    await vi.advanceTimersByTimeAsync(300);
    expect(reconcileNodes).toHaveBeenCalledWith(new Set(["ch1"]));
  });

  it("ignores echoes of our own writes (no apply, no read-back)", async () => {
    const applyDirect = vi.fn();
    const reconcileNodes = vi.fn(async () => {});
    const follow = followFor({ isEcho: () => true, applyDirect, reconcileNodes });
    await follow.begin();
    notify(-600);
    await vi.advanceTimersByTimeAsync(500);
    expect(applyDirect).not.toHaveBeenCalled();
    expect(reconcileNodes).not.toHaveBeenCalled();
  });

  it("escalates an unknown address to a full read", async () => {
    const reconcileAll = vi.fn(async () => {});
    const reconcileNodes = vi.fn(async () => {});
    const follow = followFor({ lookup: () => undefined, reconcileAll, reconcileNodes });
    await follow.begin();
    notify(-600);
    await vi.advanceTimersByTimeAsync(300);
    expect(reconcileAll).toHaveBeenCalledTimes(1);
    expect(reconcileNodes).not.toHaveBeenCalled();
  });

  it("escalates the bulk-change sentinel (scene recall) to a full read", async () => {
    // A scene recall emits a single address-less namespace notify, which vd.rs
    // forwards as the 0:-1:-1 sentinel (negative coordinates cannot exist in the
    // catalog, so the live index never resolves them).
    const reconcileAll = vi.fn(async () => {});
    const reconcileNodes = vi.fn(async () => {});
    const follow = followFor({
      lookup: (_id, x) => (x < 0 ? undefined : SCOPED),
      reconcileAll,
      reconcileNodes,
    });
    await follow.begin();
    h.onUpdate!({ paramId: 0, x: -1, y: -1, value: 0 });
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
    await follow.begin();
    for (const id of [10, 11, 12, 13]) notifyAddr(id, -100);
    await vi.advanceTimersByTimeAsync(300);
    expect(reconcileAll).toHaveBeenCalledTimes(1);
    expect(reconcileNodes).not.toHaveBeenCalled();
  });

  it("runs a full read as an idle safety net after the device goes quiet", async () => {
    const reconcileNodes = vi.fn(async () => {});
    const reconcileAll = vi.fn(async () => {});
    const follow = followFor({ reconcileNodes, reconcileAll });
    await follow.begin();
    notify(-600);
    await vi.advanceTimersByTimeAsync(300);
    expect(reconcileNodes).toHaveBeenCalledTimes(1);
    expect(reconcileAll).not.toHaveBeenCalled();
    // 900 ms total since the notify → the idle full reconcile fires once.
    await vi.advanceTimersByTimeAsync(600);
    expect(reconcileAll).toHaveBeenCalledTimes(1);
  });

  it("keeps the idle full reconcile when it fires during an in-flight scoped read", async () => {
    // A scoped node readback is dozens of sequential round-trips, so the idle
    // timer routinely fires while it is still in flight. Hold the scoped read
    // open with a manually resolved promise to reproduce that overlap.
    let release: () => void = () => {};
    const reconcileNodes = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const reconcileAll = vi.fn(async () => {});
    const follow = followFor({ reconcileNodes, reconcileAll });
    await follow.begin();
    notify(-600);
    // The settle fires and starts the scoped read, which stays in flight.
    await vi.advanceTimersByTimeAsync(300);
    expect(reconcileNodes).toHaveBeenCalledTimes(1);
    // The idle timer fires at 900 ms while still reconciling: deferred, not run.
    await vi.advanceTimersByTimeAsync(600);
    expect(reconcileAll).not.toHaveBeenCalled();
    // The scoped read completes → the replay must run the promised full read.
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcileAll).toHaveBeenCalledTimes(1);
  });

  it("does not re-register after a reconcile that left the address set unchanged", async () => {
    const follow = followFor();
    await follow.begin();
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
    await follow.begin();
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
    await follow.begin();
    notify(-600);
    await vi.advanceTimersByTimeAsync(300);
    expect(onError).toHaveBeenCalledWith("readback failed");
    expect(follow.isActive()).toBe(false);
  });

  it("is inert after end(): unsubscribes and drops pending work", async () => {
    const reconcileNodes = vi.fn(async () => {});
    const reconcileAll = vi.fn(async () => {});
    const follow = followFor({ reconcileNodes, reconcileAll });
    await follow.begin();
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
