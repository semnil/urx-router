import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../../models";
import { defaultPlan } from "../../models/initial-state";
import {
  deviceWritesHeld,
  holdDeviceWrites,
  stoppedByNotificationsLost,
  vdSet,
  vdSetStr,
  WRITES_HELD,
  type ParamUpdate,
} from "../platform";
import {
  CONSOLE_LOCK_ADDR,
  consoleLockAbort,
  readConsoleLock,
  sameDeviceWrites,
  stoppedByConsoleLock,
  watchConsoleLock,
  watchRun,
  type LockWatchIo,
} from "./console-lock";
import { PARAMS } from "./params";

afterEach(() => holdDeviceWrites(false));

// A unit as far as the watch can see it: a value at 895, a notify stream a case drives, and a
// record of what was registered and when it was let go.
function unit(locked: number, failRead = false) {
  let deliver: ((p: ParamUpdate) => void) | null = null;
  let lost: (() => void) | null = null;
  const log: string[] = [];
  const io: LockWatchIo = {
    lost: (listener) => {
      log.push("listen for a loss");
      lost = listener;
      return () => {
        log.push("stop listening for a loss");
        lost = null;
      };
    },
    subscribe: async (addrs, onUpdate) => {
      log.push(`subscribe ${addrs.map((a) => a.join(":")).join(",")}`);
      deliver = onUpdate;
      return () => {
        log.push("unsubscribe");
        deliver = null;
      };
    },
    get: async (paramId, x, y) => {
      log.push(`get ${paramId}:${x}:${y}`);
      if (failRead) throw new Error("not-connected");
      return locked;
    },
  };
  const notify = (value: number, addr = CONSOLE_LOCK_ADDR): void =>
    deliver?.({ paramId: addr[0], x: addr[1], y: addr[2], value });
  /** The connection's notifications are lost. */
  const lose = (): void => lost?.();
  return { io, log, notify, lose };
}

describe("the unit's Console Lock", () => {
  it("is 895, which only ever reads", async () => {
    expect(CONSOLE_LOCK_ADDR).toEqual([895, 0, 0]);
    expect(PARAMS.CONSOLE_LOCK).toMatchObject({ id: 895, planExternal: true, sceneExternal: true });
    const get = vi.fn(async () => 1);
    expect(await readConsoleLock(get)).toBe(true);
    expect(get).toHaveBeenCalledWith(895, 0, 0);
    expect(await readConsoleLock(async () => 0)).toBe(false);
  });

  it("holds every write in front of the link while the app knows the unit is locked", async () => {
    holdDeviceWrites(true);
    expect(deviceWritesHeld()).toBe(true);
    await expect(vdSet(1, 0, 0, 0)).rejects.toThrow(new RegExp(`^${WRITES_HELD}:`));
    await expect(vdSetStr(1, 0, 0, "x")).rejects.toThrow(new RegExp(`^${WRITES_HELD}:`));
    holdDeviceWrites(false);
    // Let through: the write goes on to the shell, which in a test has none to answer it.
    await expect((async () => vdSet(1, 0, 0, 0))()).rejects.not.toThrow(new RegExp(`^${WRITES_HELD}:`));
  });

  it("tells a stop the lock made from a cancel and from any other failure", () => {
    expect(stoppedByConsoleLock(consoleLockAbort())).toBe(true);
    expect(consoleLockAbort().name, "stops where a cancel stops").toBe("AbortError");
    expect(stoppedByConsoleLock(new Error(`${WRITES_HELD}: held`))).toBe(true);
    expect(stoppedByConsoleLock(new Error("broker-rejected: 400"))).toBe(false);
    expect(stoppedByConsoleLock(new DOMException("canceled", "AbortError"))).toBe(false);
    const locked = new AbortController();
    locked.abort(consoleLockAbort());
    expect(stoppedByConsoleLock(locked.signal)).toBe(true);
    const canceled = new AbortController();
    canceled.abort();
    expect(stoppedByConsoleLock(canceled.signal)).toBe(false);
    expect(stoppedByConsoleLock(new AbortController().signal)).toBe(false);
  });
});

describe("watchConsoleLock", () => {
  it("registers for the notify before it reads, so a lock between the two is not missed", async () => {
    const u = unit(0);
    const watch = await watchConsoleLock(() => {}, u.io);
    expect(u.log).toEqual(["subscribe 895:0:0", "get 895:0:0"]);
    expect(watch.lockedAtStart).toBe(false);
    expect(deviceWritesHeld()).toBe(false);
    watch.stop();
    expect(u.log.at(-1)).toBe("unsubscribe");
  });

  it("says a unit locked at the start is locked, and holds writes until it is let go", async () => {
    const u = unit(1);
    const onLock = vi.fn();
    const watch = await watchConsoleLock(onLock, u.io);
    expect(watch.lockedAtStart).toBe(true);
    expect(watch.tripped()).toBe(true);
    expect(deviceWritesHeld()).toBe(true);
    expect(onLock, "the caller refuses on lockedAtStart; there is no run to stop").not.toHaveBeenCalled();
    watch.stop();
    expect(deviceWritesHeld()).toBe(false);
  });

  it("stops the run once on a lock announced while it goes, and ignores the unlock after it", async () => {
    const u = unit(0);
    const onLock = vi.fn();
    const watch = await watchConsoleLock(onLock, u.io);
    u.notify(0);
    u.notify(1, [896, 0, 0]);
    expect(onLock, "an unlocked value, and another address, stop nothing").not.toHaveBeenCalled();
    u.notify(1);
    u.notify(1);
    expect(onLock).toHaveBeenCalledTimes(1);
    expect(deviceWritesHeld()).toBe(true);
    u.notify(0);
    expect(watch.tripped(), "a run stopped by the lock stays stopped").toBe(true);
    expect(deviceWritesHeld()).toBe(true);
    watch.stop();
    expect(deviceWritesHeld()).toBe(false);
    u.notify(1);
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  // The registration's verdict comes after a notify it already let through: a lock announced in
  // between held writes for a watch that then never started, and must not outlive it. The start
  // rejects with the lock it told of, not with the registration's failure.
  it("leaves writes let through when the registration fails after a lock was announced", async () => {
    let deliver: ((p: ParamUpdate) => void) | null = null;
    const io: LockWatchIo = {
      subscribe: async (_addrs, onUpdate) => {
        deliver = onUpdate;
        onUpdate({ paramId: 895, x: 0, y: 0, value: 1 });
        throw new Error("broker-rejected: 895:0:0 response_code 400");
      },
      get: async () => 0,
    };
    const onLock = vi.fn();
    const err = await watchConsoleLock(onLock, io).catch((e: unknown) => e);
    expect(stoppedByConsoleLock(err), String(err)).toBe(true);
    expect(deviceWritesHeld()).toBe(false);
    (deliver as ((p: ParamUpdate) => void) | null)?.({ paramId: 895, x: 0, y: 0, value: 1 });
    expect(deviceWritesHeld(), "a notify after the failed start holds nothing").toBe(false);
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it("leaves nothing registered or held when the read fails", async () => {
    const u = unit(0, true);
    await expect(watchConsoleLock(() => {}, u.io)).rejects.toThrow("not-connected");
    expect(u.log).toEqual(["subscribe 895:0:0", "get 895:0:0", "unsubscribe"]);
    expect(deviceWritesHeld()).toBe(false);
  });
});

describe("watchConsoleLock and a loss of the notifications", () => {
  it("stops the run once when the connection's notifications are lost, and listens no more once let go", async () => {
    const u = unit(0);
    const onLost = vi.fn();
    const watch = await watchConsoleLock(vi.fn(), u.io, onLost);
    u.lose();
    u.lose();
    expect(onLost).toHaveBeenCalledOnce();
    watch.stop();
    expect(u.log).toContain("stop listening for a loss");
  });

  it("stops listening for a loss when the registration fails", async () => {
    const u = unit(0);
    u.io.subscribe = async () => {
      throw new Error("refused");
    };
    await expect(watchConsoleLock(vi.fn(), u.io, vi.fn())).rejects.toThrow("refused");
    expect(u.log).toEqual(["listen for a loss", "stop listening for a loss"]);
  });
});

describe("watchRun", () => {
  it("aborts the run's signal with the lock, and with the caller's cancel", async () => {
    const locked = unit(0);
    const run = await watchRun(undefined, locked.io);
    expect(run.signal.aborted).toBe(false);
    locked.notify(1);
    expect(stoppedByConsoleLock(run.signal)).toBe(true);
    run.stop();

    const lost = unit(0);
    const stopped = await watchRun(undefined, lost.io);
    lost.lose();
    expect(stoppedByNotificationsLost(stopped.signal), "and with the loss of the notifications").toBe(true);
    expect(stoppedByConsoleLock(stopped.signal)).toBe(false);
    stopped.stop();

    const outer = new AbortController();
    const canceled = await watchRun(outer.signal, unit(0).io);
    outer.abort();
    expect(canceled.signal.aborted).toBe(true);
    expect(stoppedByConsoleLock(canceled.signal)).toBe(false);
    canceled.stop();
  });

  it("rejects when the watch cannot be registered, and lets the caller's cancel go", async () => {
    const outer = new AbortController();
    const removed = vi.spyOn(outer.signal, "removeEventListener");
    const u = unit(0);
    u.io.subscribe = async () => {
      throw new Error("subscribe rejected");
    };
    await expect(watchRun(outer.signal, u.io)).rejects.toThrow("subscribe rejected");
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("starts aborted for a caller that already canceled", async () => {
    const outer = new AbortController();
    outer.abort();
    const run = await watchRun(outer.signal, unit(0).io);
    expect(run.signal.aborted).toBe(true);
    run.stop();
  });
});

// A stop the watch tells its caller of while it starts decides how the run ends, whatever the call
// in flight then comes back with: the registration or the read failing after it does not take its
// place. Without a stop, the failure is what the start rejects with (the cases above).
describe("a stop the watch told of before its start failed", () => {
  const CASES = [
    ["registration", "lock"],
    ["registration", "loss"],
    ["read", "lock"],
    ["read", "loss"],
  ] as const;
  // A unit whose registration or read announces the stop and then fails.
  const failingAfter = (phase: "registration" | "read", stop: "lock" | "loss") => {
    const u = unit(0);
    const announce = (): void => (stop === "lock" ? u.notify(1) : u.lose());
    const subscribe = u.io.subscribe;
    const get = u.io.get;
    u.io.subscribe = async (addrs, onUpdate) => {
      const unsubscribe = await subscribe(addrs, onUpdate);
      if (phase !== "registration") return unsubscribe;
      announce();
      throw new Error("connection-reset");
    };
    u.io.get = async (paramId, x, y) => {
      await get(paramId, x, y);
      announce();
      throw new Error("connection-reset");
    };
    return u;
  };
  const stoppedBy = (stop: "lock" | "loss", cause: unknown): boolean =>
    stop === "lock" ? stoppedByConsoleLock(cause) : stoppedByNotificationsLost(cause);

  it.each(CASES)("watchConsoleLock rejects with the stop on a %s that fails after a %s", async (phase, stop) => {
    const u = failingAfter(phase, stop);
    const err = await watchConsoleLock(vi.fn(), u.io, vi.fn()).catch((e: unknown) => e);
    expect(stoppedBy(stop, err), String(err)).toBe(true);
    expect(String(err)).not.toContain("connection-reset");
    expect(deviceWritesHeld(), "nothing is left held").toBe(false);
    expect(u.log).toContain("stop listening for a loss");
  });

  it.each(CASES)("watchRun hands the run back stopped on a %s that fails after a %s", async (phase, stop) => {
    const outer = new AbortController();
    const removed = vi.spyOn(outer.signal, "removeEventListener");
    const run = await watchRun(outer.signal, failingAfter(phase, stop).io);
    expect(stoppedBy(stop, run.signal)).toBe(true);
    expect(run.lockedAtStart).toBe(false);
    expect(removed, "the caller's cancel is let go").toHaveBeenCalledWith("abort", expect.any(Function));
    run.stop();
    expect(deviceWritesHeld()).toBe(false);
  });
});

describe("sameDeviceWrites", () => {
  const model = getModel("URX44V");

  it("is true for an edit that writes nothing to the unit, and false for one that does", () => {
    const before = defaultPlan("URX44V");
    const moved = structuredClone(before);
    moved.positions["ch1"] = { x: 999, y: 999 };
    moved.notes["ch1"] = "a note";
    expect(sameDeviceWrites(model, before, moved, "all")).toBe(true);

    const renamed = structuredClone(before);
    renamed.nodeNames["ch1"] = "Vox";
    expect(sameDeviceWrites(model, before, renamed, "all"), "a name is written to the unit").toBe(false);

    const rate = structuredClone(before);
    rate.sampleRate = before.sampleRate === 48000 ? 44100 : 48000;
    expect(sameDeviceWrites(model, before, rate, "all")).toBe(false);
    expect(sameDeviceWrites(model, before, rate, "scene"), "the Scene only scope writes no rate").toBe(true);
  });
});
