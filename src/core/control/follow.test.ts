import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// DeviceFollow registers for device-side param notifies through
// platform.vdParamsSubscribe and reconciles on a settled change. Mock the
// transport so a test can capture the notify callback and drive notifies
// directly; the metrics are the debounced reconcile count and the echo filter.
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

const ADDR: [number, number, number] = [139, 0, 0];

function followFor(overrides: Partial<DeviceFollowHooks> = {}): DeviceFollow {
  return new DeviceFollow({
    addrs: () => [ADDR],
    isEcho: () => false,
    reconcile: async () => {},
    onFollow: () => {},
    onError: () => {},
    ...overrides,
  });
}

function notify(value: number): void {
  h.onUpdate?.({ paramId: ADDR[0], x: ADDR[1], y: ADDR[2], value });
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

  it("reconciles once after a burst of device-side changes settles", async () => {
    const reconcile = vi.fn(async () => {});
    const follow = followFor({ reconcile });
    follow.begin();
    // A knob sweep: several non-echo notifies inside the debounce window.
    for (let i = 1; i <= 6; i++) {
      notify(-i * 100);
      await vi.advanceTimersByTimeAsync(40);
    }
    expect(reconcile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("ignores echoes of our own writes (no reconcile)", async () => {
    const reconcile = vi.fn(async () => {});
    const follow = followFor({ isEcho: () => true, reconcile });
    follow.begin();
    notify(-600);
    await vi.advanceTimersByTimeAsync(500);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("does not re-register after a reconcile that left the address set unchanged", async () => {
    const follow = followFor({ reconcile: async () => {} });
    follow.begin();
    expect(h.subscribeCalls).toBe(1);
    notify(-600);
    await vi.advanceTimersByTimeAsync(250);
    // The set is identical, so the post-reconcile subscribe is a no-op — no
    // re-posting of every address to the broker.
    expect(h.subscribeCalls).toBe(1);
  });

  it("re-registers only when the writable address set changed", async () => {
    let addrs: Array<[number, number, number]> = [ADDR];
    const follow = followFor({ addrs: () => addrs, reconcile: async () => { addrs = [ADDR, [140, 0, 0]]; } });
    follow.begin();
    expect(h.subscribeCalls).toBe(1);
    notify(-600);
    await vi.advanceTimersByTimeAsync(250);
    // The reconcile grew the set, so the post-reconcile subscribe re-registers.
    expect(h.subscribeCalls).toBe(2);
    expect(h.addrs).toEqual([ADDR, [140, 0, 0]]);
  });

  it("stops and reports when a reconcile fails", async () => {
    const onError = vi.fn();
    const follow = followFor({ reconcile: async () => { throw new Error("readback failed"); }, onError });
    follow.begin();
    notify(-600);
    await vi.advanceTimersByTimeAsync(250);
    expect(onError).toHaveBeenCalledWith("readback failed");
    expect(follow.isActive()).toBe(false);
  });

  it("is inert after end(): unsubscribes and drops a pending reconcile", async () => {
    const reconcile = vi.fn(async () => {});
    const follow = followFor({ reconcile });
    follow.begin();
    notify(-600); // schedules a reconcile
    follow.end();
    expect(h.unsub).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("does nothing on a notify before begin", async () => {
    const reconcile = vi.fn(async () => {});
    followFor({ reconcile });
    // No begin(): nothing subscribed, so there is no callback to fire.
    expect(h.onUpdate).toBeNull();
    await vi.advanceTimersByTimeAsync(500);
    expect(reconcile).not.toHaveBeenCalled();
  });
});
