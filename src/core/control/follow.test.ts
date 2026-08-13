import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// DeviceFollow registers for device-side param notifies through
// platform.vdParamsSubscribe and classifies each via the live address index
// (lookup): a direct param applies straight into the plan, a scoped one re-reads
// its owner node after the burst settles, and an unknown / over-concentrated
// burst escalates to a full read. Mock the transport so a test can capture the
// notify callback and drive notifies directly.
const h = vi.hoisted(() => ({
  // The payload the bridge actually delivers, `valueStr` included — see ParamUpdate in
  // core/platform.ts. Hand-rolling it without the string field meant the one place the
  // name-notify contract is pinned was the one place the compiler could not check it.
  onUpdate: null as null | ((p: { paramId: number; x: number; y: number; value: number; valueStr?: string }) => void),
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
import { SETTLE_TIMEOUT_MS, writeSettle } from "./settle";
import { addrKey } from "./translate";
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

// A name notify, as the bridge delivers one: the text in `valueStr`, the numeric
// `value` a placeholder 0 (src-tauri/src/vd.rs decodes whichever the frame carries).
function notifyName(paramId: number, valueStr: string): void {
  h.onUpdate?.({ paramId, x: 0, y: 0, value: 0, valueStr });
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
  it("registers the follow address set on begin", async () => {
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

  // A rename made on the unit: applied straight into the plan, one repaint, and the
  // idle net armed like any other followed change.
  it("follows a rename directly and arms the idle net for it", async () => {
    const applyName = vi.fn(() => "ch1");
    const flushDirect = vi.fn();
    const reconcileAll = vi.fn(async () => {});
    const reconcileNodes = vi.fn(async () => {});
    const follow = followFor({ applyName, flushDirect, reconcileAll, reconcileNodes });
    await follow.begin();
    notifyName(18, "FromTheLCD");
    expect(applyName).toHaveBeenCalledWith(18, 0, 0, "FromTheLCD");
    expect(flushDirect).toHaveBeenCalledTimes(1);
    // No scoped read — a name has no catalog entry to re-read — but the net still runs.
    await vi.advanceTimersByTimeAsync(900);
    expect(reconcileNodes).not.toHaveBeenCalled();
    expect(reconcileAll).toHaveBeenCalledTimes(1);
  });

  // The app's own rename echoed back, stopped by the SAME gate a numeric echo is. The
  // unit announces one for every name write it takes (measured on a URX44V), so this is
  // not an edge case: it is what EVERY rename made in the app produces, four times over
  // for one typed name. Letting it past the gate armed the idle net each time, and that
  // net is a full reconcile whose reflect calls planHistory.reset() — so a rename during
  // Live sync swept the whole device 900 ms later and erased its own undo entry.
  //
  // `applyName` must not even be consulted: the echo test is one hook for both paths
  // (the host dispatches it on valueStr), and a second gate inside the apply is what
  // this pins against.
  it("does not repaint or arm the net for the app's own rename coming back", async () => {
    const applyName = vi.fn(() => "ch1");
    const flushDirect = vi.fn();
    const reconcileAll = vi.fn(async () => {});
    const reconcileNodes = vi.fn(async () => {});
    const onFollow = vi.fn();
    const follow = followFor({ isEcho: () => true, applyName, flushDirect, reconcileAll, reconcileNodes, onFollow });
    await follow.begin();
    notifyName(18, "TypedInTheApp");
    expect(applyName).not.toHaveBeenCalled();
    expect(flushDirect).not.toHaveBeenCalled();
    expect(onFollow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(reconcileAll).not.toHaveBeenCalled();
    expect(reconcileNodes).not.toHaveBeenCalled();
  });

  // A string notify on an address no name owns is a shape no URX sends; it must not be
  // swallowed by the name branch but fall through to the unknown-address escalation.
  it("escalates a string notify on an address that is not a name", async () => {
    const applyName = vi.fn(() => undefined);
    const reconcileAll = vi.fn(async () => {});
    const follow = followFor({ applyName, lookup: () => undefined, reconcileAll });
    await follow.begin();
    notifyName(777, "not-a-name");
    // The hook ran and declined — without this the case would also pass with no hook
    // installed at all, which is a different code path.
    expect(applyName).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
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

  it("re-registers only when the follow address set changed", async () => {
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

  // The subscription this class owns is the app's only notify stream, so it is also
  // what a write can be settled against (settle.ts). Two obligations come with that.
  it("feeds the settle before the echo filter drops our own write's answer", async () => {
    // The answer to a write of ours IS an echo. A settle told only about what survives
    // this method would never see the one notify it is waiting for.
    const follow = followFor({ isEcho: () => true });
    await follow.begin();
    const before = writeSettle.mark();
    notify(-600);
    expect(writeSettle.mark()).toBeGreaterThan(before);
    follow.end();
  });

  it("arms the idle full reconcile for a write the unit never announced", async () => {
    // The settle's report: a value-changing write on an address outside the scoped read
    // that would have repaired it, and the unit said nothing about it inside the bound.
    // Nothing else can repair that — the settle knows a write went silent and nothing
    // about how to re-read — so it comes back here, and the missed-notify safety net is
    // exactly the response.
    const reconcileAll = vi.fn(async () => {});
    const follow = followFor({ reconcileAll });
    await follow.begin();
    const k = addrKey(9001, 0, 0);
    await writeSettle.settle(new Map([[k, writeSettle.mark()]]), {
      mustSettle: new Set(),
      mustAnnounce: new Set([k]),
    });
    expect(reconcileAll).not.toHaveBeenCalled();
    // The report lands at the bound, not at the settle's return.
    await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS);
    expect(reconcileAll).not.toHaveBeenCalled();
    // …and it arms the idle timer rather than sweeping at once, so a burst of these
    // during a drag costs one sweep after the drag rather than one each.
    await vi.advanceTimersByTimeAsync(900);
    expect(reconcileAll).toHaveBeenCalledTimes(1);
    follow.end();
  });

  // A registration stalled at the broker outlives the session that issued it. The
  // post-await guard used to ask `this.active`, which is a boolean and is `true`
  // again for a DIFFERENT session — so the stale handle was installed over the live
  // one, leaving the real subscription with nobody to unsubscribe it (a registration
  // pile-up at the broker is the failure link-stats.ts was built to investigate),
  // notifies delivered twice while both lived, and a settle sink arming reconciles
  // across later sessions.
  it("drops a registration that resolved after its session ended and another began", async () => {
    let release!: (v: () => void) => void;
    const stalled = new Promise<() => void>((r) => (release = r));
    const staleUnsub = vi.fn();
    const mod = await import("../platform");
    const real = vi.mocked(mod.vdParamsSubscribe).getMockImplementation()!;
    vi.mocked(mod.vdParamsSubscribe).mockImplementationOnce(async (addrs, onUpdate) => {
      void real(addrs, onUpdate);
      return stalled;
    });

    const follow = followFor({});
    const first = follow.begin();
    follow.end();
    await follow.begin(); // the second session registers for real
    const liveUnsub = h.unsub;

    release(staleUnsub);
    await first;
    // The stalled one unsubscribed ITSELF rather than replacing the live handle.
    expect(staleUnsub).toHaveBeenCalledTimes(1);
    expect(liveUnsub).not.toHaveBeenCalled();

    // …and the live session is still the one that gets torn down.
    follow.end();
    expect(liveUnsub).toHaveBeenCalledTimes(1);
  });

  // The settle cannot tell a re-registration from a new session — from there both are
  // a release followed by an arm — so a watch armed under the old session can fire
  // into the new one's sink. The stamp is what stops it arming a sweep that session
  // has no reason for.
  it("ignores a settle report armed under a session that has since ended", async () => {
    const reconcileAll = vi.fn(async () => {});
    const follow = followFor({ reconcileAll });
    await follow.begin();
    const k = addrKey(9002, 0, 0);
    const settled = writeSettle.settle(new Map([[k, writeSettle.mark()]]), {
      mustSettle: new Set(),
      mustAnnounce: new Set([k]),
    });
    follow.end();
    await follow.begin(); // a new session arms its own sink
    await settled;
    await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS + 900);
    expect(reconcileAll).not.toHaveBeenCalled();
    follow.end();
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
