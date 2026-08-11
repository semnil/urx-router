// The two re-entry guards, and the difference between them: one is silent because
// the second click is a slip, the other reports because the operator's request went
// unanswered.

import { describe, expect, it, vi } from "vitest";
import { FileFlowLatch, singleFlight } from "./flow-latch";

/** A promise a test resolves when it decides the action is done. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let the whole promise chain settle — `.finally().catch()` is more than one
 *  microtask deep, so draining a fixed number of them is a race. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("singleFlight", () => {
  const sink = () => vi.fn();

  it("runs the action on the first call", () => {
    const run = vi.fn(async () => {});
    singleFlight(run, sink())();
    expect(run).toHaveBeenCalledTimes(1);
  });

  // A double click must not stack native dialogs or start the work twice.
  it("ignores a second call while the action is in flight", () => {
    const gate = deferred();
    const run = vi.fn(() => gate.promise);
    const handler = singleFlight(run, sink());
    handler();
    handler();
    handler();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs again once the action has finished", async () => {
    const gate = deferred();
    const run = vi.fn(() => gate.promise);
    const handler = singleFlight(run, sink());
    handler();
    gate.resolve();
    await gate.promise;
    await Promise.resolve();
    handler();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("reports nothing for an action that succeeded", async () => {
    const onError = sink();
    singleFlight(async () => {}, onError)();
    await flush();
    expect(onError).not.toHaveBeenCalled();
  });

  // The promise is fired without being awaited, so a rejection with nothing
  // catching it reaches no surface at all. The sink is what makes it land.
  it("reports a rejected action rather than losing it", async () => {
    const onError = sink();
    const failure = new Error("dialog refused");
    singleFlight(async () => {
      throw failure;
    }, onError)();
    await flush();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  // A latch that only cleared on success would wedge the button after one failure.
  it("clears the latch after a rejection, so the button still works", async () => {
    const onError = sink();
    let fail = true;
    const run = vi.fn(async () => {
      if (fail) throw new Error("dialog refused");
    });
    const handler = singleFlight(run, onError);
    handler();
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);

    fail = false;
    handler();
    expect(run).toHaveBeenCalledTimes(2);
  });

  // Cleared BEFORE the report, so a reporter that blocks cannot hold the button
  // shut — the latch is already free by the time the sink is entered.
  it("has already cleared the latch by the time the sink is entered", async () => {
    let reentered = 0;
    const run = vi.fn(async () => {
      if (reentered === 0) throw new Error("first failed");
    });
    let handler!: () => void;
    handler = singleFlight(run, () => {
      reentered++;
      handler(); // the latch must let this through
    });
    handler();
    await flush();
    expect(reentered).toBe(1);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("FileFlowLatch", () => {
  const hooks = () => ({ onDeviceReadBusy: vi.fn(), onReleased: vi.fn() });

  it("runs a flow and returns what it produced", async () => {
    const latch = new FileFlowLatch(hooks());
    await expect(latch.run(async () => "opened")).resolves.toBe("opened");
  });

  it("lets the latch go afterwards, and reports the release", async () => {
    const h = hooks();
    const latch = new FileFlowLatch(h);
    await latch.run(async () => {});
    expect(latch.busy).toBe(false);
    expect(h.onReleased).toHaveBeenCalledTimes(1);
  });

  // A second file flow stays SILENT — its own native dialog is already on screen,
  // and the second click is a rapid-repeat guard rather than a request.
  it("refuses a second flow silently while one is running", async () => {
    const h = hooks();
    const latch = new FileFlowLatch(h);
    const gate = deferred();
    const first = latch.run(() => gate.promise);
    expect(latch.busy).toBe(true);

    const second = await latch.run(async () => "second");
    expect(second).toBeNull();
    expect(h.onDeviceReadBusy).not.toHaveBeenCalled();

    gate.resolve();
    await first;
  });

  // A device read holding the plan is REPORTED: the flow the operator picked simply
  // does not happen, and the status line is showing the read's own progress.
  it("refuses a flow during a device read, and says so", async () => {
    const h = hooks();
    const latch = new FileFlowLatch(h);
    latch.deviceReadInFlight = true;

    const action = vi.fn(async () => "opened");
    expect(await latch.run(action)).toBeNull();
    expect(action).not.toHaveBeenCalled();
    expect(h.onDeviceReadBusy).toHaveBeenCalledTimes(1);
    // Nothing ran, so nothing was released.
    expect(h.onReleased).not.toHaveBeenCalled();
  });

  it("runs again once the device read clears", async () => {
    const latch = new FileFlowLatch(hooks());
    latch.deviceReadInFlight = true;
    expect(await latch.run(async () => "opened")).toBeNull();
    latch.deviceReadInFlight = false;
    expect(await latch.run(async () => "opened")).toBe("opened");
  });

  // `busy` is what the undo history and the MIDI gate consult, so it has to cover
  // both halves rather than only the one that is running.
  it("reads busy for either latch", () => {
    const latch = new FileFlowLatch(hooks());
    expect(latch.busy).toBe(false);
    latch.deviceReadInFlight = true;
    expect(latch.busy).toBe(true);
    latch.deviceReadInFlight = false;
    expect(latch.busy).toBe(false);
  });

  // A flow that throws must not wedge every later one.
  it("releases the latch when the flow throws, and propagates", async () => {
    const h = hooks();
    const latch = new FileFlowLatch(h);
    await expect(latch.run(async () => Promise.reject(new Error("dialog failed")))).rejects.toThrow("dialog failed");
    expect(latch.busy).toBe(false);
    expect(h.onReleased).toHaveBeenCalledTimes(1);
    expect(await latch.run(async () => "opened")).toBe("opened");
  });
});
