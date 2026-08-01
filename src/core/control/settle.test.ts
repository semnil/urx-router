import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addrKey } from "./translate";
import { SETTLE_TIMEOUT_MS, WriteSettle } from "./settle";

// The one address these cases write and wait on (the EQ 1-knob ON, the measured
// case), and a second beside it standing for a collateral write in the same flush.
const ADDR = addrKey(46, 0, 0);
const SECOND = addrKey(47, 0, 0);
const NOTIFY = { paramId: 46, x: 0, y: 0, value: 1 };
const NOTIFY_SECOND = { paramId: 47, x: 0, y: 0, value: 2 };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// A fresh instance per case: the shipped `writeSettle` is module state (one device
// link, one notify stream), and a case that armed it would leak that into the next.
// `reported` collects what the settle hands the notify source about writes the unit
// owed an announcement and never made.
function armed(): { settle: WriteSettle; reported: number[][]; release: () => void } {
  const settle = new WriteSettle();
  const reported: number[][] = [];
  return { settle, reported, release: settle.arm((addrs) => reported.push([...addrs])) };
}

/** The handle a writer builds: one address, written at the mark taken before its own
 *  vdSet. Nothing has been announced at this point. */
function wrote(settle: WriteSettle, ...addrs: number[]): Map<number, number> {
  const at = settle.mark();
  return new Map(addrs.map((a) => [a, at]));
}

describe("WriteSettle waiting", () => {
  it("resolves on the write's own notify instead of spending the window", async () => {
    const { settle } = armed();
    const written = wrote(settle, ADDR);
    let done = false;
    const wait = settle.settle(written).then((a) => {
      done = true;
      return a;
    });
    await vi.advanceTimersByTimeAsync(40);
    expect(done).toBe(false);
    settle.note(NOTIFY);
    // …and the answer is the value the DEVICE named, which is the whole point of the
    // wait: nothing here was ever told what was sent.
    expect([...(await wait)]).toEqual([[ADDR, 1]]);
    expect(done).toBe(true);
  });

  it("times out when nothing answers — a write of a value the unit already holds", async () => {
    // Measured: 18 such writes acked in 0-1 ms and produced no notify at all. A wait
    // that only ever ended on a notify would hang the flush that made them.
    const { settle } = armed();
    const written = wrote(settle, ADDR);
    let done = false;
    const wait = settle.settle(written).then((a) => {
      done = true;
      return a;
    });
    await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // Nothing announced, so the caller has nothing to answer the read from and asks
    // the unit for it — the blind read, for that address alone.
    expect((await wait).size).toBe(0);
    expect(done).toBe(true);
  });

  it("takes a notify that landed before the wait began", async () => {
    // A flush awaits a vdSet per command, so the answer to an early command can arrive
    // while a later one is still in flight — before anything calls settle(). Judged
    // against the mark taken before that address's own write, not against "now".
    const { settle } = armed();
    const written = wrote(settle, ADDR);
    settle.note(NOTIFY);
    expect([...(await settle.settle(written))]).toEqual([[ADDR, 1]]);
  });

  it("ignores a notify that predates the address's own write", async () => {
    const { settle } = armed();
    settle.note(NOTIFY);
    const written = wrote(settle, ADDR);
    let done = false;
    const wait = settle.settle(written).then((a) => {
      done = true;
      return a;
    });
    await vi.advanceTimersByTimeAsync(40);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS);
    expect((await wait).size).toBe(0);
  });

  it("marks each address at its own write, not once for the flush", async () => {
    // The loop awaits per command, so a device-side notify for an address the loop has
    // not reached yet is common. One mark for the whole flush would let it confirm that
    // write before it was made — and, on the way through, answer the read with the value
    // the operator's own move replaced.
    const { settle } = armed();
    const first = settle.mark();
    settle.note(NOTIFY); // arrives while the flush is still working through `SECOND`
    const written = new Map([
      [SECOND, first],
      [ADDR, settle.mark()],
    ]);
    settle.note(NOTIFY_SECOND);
    const announced = await settle.settle(written, { mustSettle: new Set() });
    expect([...announced]).toEqual([[SECOND, 2]]);
  });

  it("answers with the value the device announced, not the one the caller sent", async () => {
    // A coerced write (a grid snap, a range clamp): the unit acks 7 and announces
    // something else. There is no special case for it — the announcement IS the answer,
    // and the caller never told this module what it sent.
    const { settle } = armed();
    const written = wrote(settle, ADDR);
    const wait = settle.settle(written);
    settle.note({ ...NOTIFY, value: 7 });
    expect([...(await wait)]).toEqual([[ADDR, 7]]);
  });

  it("lets the last announcement win", async () => {
    // Two notifies for one address inside one window: the unit correcting itself, or
    // the operator moving the control on the board after our write landed. Either way
    // the later word is the one the unit is standing behind. The wait runs on past the
    // first because a second address is still outstanding, which is how a window comes
    // to hold two at all.
    const { settle } = armed();
    const written = wrote(settle, ADDR, SECOND);
    const wait = settle.settle(written);
    settle.note({ ...NOTIFY, value: 1 });
    settle.note({ ...NOTIFY, value: 5 });
    settle.note(NOTIFY_SECOND);
    const announced = await wait;
    expect(announced.get(ADDR)).toBe(5);
  });

  it("keeps the last announcement that landed before the wait began", async () => {
    // The same statement about the notify log the wait is opened against: two answers
    // for one address while the flush was still working through the commands after it.
    const { settle } = armed();
    const written = wrote(settle, ADDR);
    settle.note({ ...NOTIFY, value: 1 });
    settle.note({ ...NOTIFY, value: 5 });
    expect([...(await settle.settle(written))]).toEqual([[ADDR, 5]]);
  });

  it("waits for every named address, not just the first", async () => {
    const { settle } = armed();
    const written = wrote(settle, ADDR, SECOND);
    let done = false;
    const wait = settle.settle(written).then(() => {
      done = true;
    });
    settle.note(NOTIFY);
    await vi.advanceTimersByTimeAsync(40);
    expect(done).toBe(false);
    settle.note(NOTIFY_SECOND);
    await wait;
    expect(done).toBe(true);
  });
});

// `mustSettle` — the addresses the read that follows is going to ASK the unit about —
// is a different question from `written`, which is everything this flush put out. A
// flush writes a fader on some other node beside the 1-knob that made it refetch: the
// read touches only the 1-knob's node, so that is the boundary it holds for, and the
// fader is answered only if the unit got round to announcing it anyway.
describe("WriteSettle scope", () => {
  it("ends the wait on the named address alone, and leaves the rest unanswered", async () => {
    const { settle } = armed();
    const written = wrote(settle, ADDR, SECOND);
    let done = false;
    const wait = settle.settle(written, { mustSettle: new Set([ADDR]) }).then((a) => {
      done = true;
      return a;
    });
    settle.note(NOTIFY);
    await vi.advanceTimersByTimeAsync(0);
    // The window is nowhere near spent, so the wait really did end on the notify.
    expect(done).toBe(true);
    // …and the address nothing spoke for is simply absent: the caller reads it off the
    // unit rather than being handed a value on the unit's behalf.
    expect([...(await wait)]).toEqual([[ADDR, 1]]);
  });

  it("answers an address outside the named set when its own notify did arrive", async () => {
    const { settle } = armed();
    const written = wrote(settle, ADDR, SECOND);
    const wait = settle.settle(written, { mustSettle: new Set([ADDR]) });
    settle.note(NOTIFY_SECOND);
    settle.note(NOTIFY);
    expect([...(await wait)].sort()).toEqual(
      [
        [ADDR, 1],
        [SECOND, 2],
      ].sort(),
    );
  });

  it("still waits for a named address this caller did not write", async () => {
    // The read's scope is what names these, not the send list: an address the read is
    // going to ask for must not be asked for early, whoever last wrote it.
    const { settle } = armed();
    const at = settle.mark();
    let done = false;
    const wait = settle.settle(new Map([[SECOND, at]]), { mustSettle: new Set([ADDR]) }).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(40);
    expect(done).toBe(false);
    settle.note(NOTIFY);
    await wait;
    expect(done).toBe(true);
  });

  it("does not wait at all with nothing named, and still answers what was announced", async () => {
    // Nothing this read asks the unit for was written by this flush, so no boundary is
    // worth holding it open: waiting there would halve the cadence of the drag that
    // produced it and buy nothing.
    const { settle } = armed();
    const written = wrote(settle, ADDR, SECOND);
    settle.note(NOTIFY);
    let done = false;
    const wait = settle.settle(written, { mustSettle: new Set() }).then((a) => {
      done = true;
      return a;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    expect([...(await wait)]).toEqual([[ADDR, 1]]);
  });
});

// The repair for a write this read will not look at (settle.ts mustAnnounce): the unit
// was obliged to change and to say so, and said nothing.
describe("WriteSettle unannounced report", () => {
  it("reports a silent obliged write to the notify source, at the bound", async () => {
    const { settle, reported } = armed();
    const written = wrote(settle, ADDR);
    // Named as owed an announcement, and deliberately NOT waited for: this address is
    // outside the read's scope, which is the whole reason a report is the only repair.
    const wait = settle.settle(written, { mustSettle: new Set(), mustAnnounce: new Set([ADDR]) });
    await wait;
    // Not at the settle's return — the wait ended at once and nothing has had time to
    // go missing yet. Reporting there would order a whole-device sweep for an
    // announcement merely still in flight.
    expect(reported).toEqual([]);
    await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS);
    expect(reported).toEqual([[ADDR]]);
  });

  it("says nothing when the announcement arrives inside the bound", async () => {
    const { settle, reported } = armed();
    const written = wrote(settle, ADDR);
    await settle.settle(written, { mustSettle: new Set(), mustAnnounce: new Set([ADDR]) });
    settle.note(NOTIFY);
    await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS);
    expect(reported).toEqual([]);
  });

  it("says nothing after the source is released", async () => {
    const { settle, reported, release } = armed();
    const written = wrote(settle, ADDR);
    await settle.settle(written, { mustSettle: new Set(), mustAnnounce: new Set([ADDR]) });
    release();
    await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS);
    expect(reported).toEqual([]);
  });

  it("drops the report when the surrounding operation is aborted", async () => {
    const { settle, reported } = armed();
    const written = wrote(settle, ADDR);
    const controller = new AbortController();
    const wait = settle.settle(written, {
      mustSettle: new Set(),
      mustAnnounce: new Set([ADDR]),
      signal: controller.signal,
    });
    await wait;
    controller.abort();
    await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS);
    expect(reported).toEqual([]);
  });
});

describe("WriteSettle without a notify source", () => {
  it("waits the bounded window and announces nothing, since nothing feeds it", async () => {
    // The write path and the self-test hold their own connection with no follow
    // subscription behind it, so note() is never called: 300 ms against a measured
    // 9-204 ms window, and then the address comes off the device.
    const settle = new WriteSettle();
    const written = wrote(settle, ADDR);
    let done = false;
    const wait = settle.settle(written).then((a) => {
      done = true;
      return a;
    });
    await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await wait).size).toBe(0);
  });
});

describe("WriteSettle cancellation", () => {
  it("does not wait at all when the window is zero, and announces nothing", async () => {
    // Switching the wait off (the unit tests, whose mock device has nothing
    // asynchronous to settle) must not also switch off what rests on it. Nothing was
    // waited for, so nothing was established: every address comes off the device,
    // which is what the caller would have done without a settle at all.
    const { settle } = armed();
    const written = wrote(settle, ADDR);
    settle.note(NOTIFY);
    expect((await settle.settle(written, { timeoutMs: 0 })).size).toBe(0);
  });

  it("rejects when the surrounding operation is aborted mid-wait", async () => {
    const { settle } = armed();
    const controller = new AbortController();
    const wait = settle.settle(wrote(settle, ADDR), { signal: controller.signal });
    controller.abort();
    await expect(wait).rejects.toThrow();
  });

  it("rejects an already-aborted signal without starting a wait", async () => {
    const { settle } = armed();
    const controller = new AbortController();
    controller.abort();
    await expect(settle.settle(wrote(settle, ADDR), { signal: controller.signal })).rejects.toThrow();
  });
});
