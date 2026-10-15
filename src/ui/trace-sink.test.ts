// @vitest-environment jsdom
// The sink behind both dev-build trace files. What is pinned is the give-up rule, which
// both instruments rely on: the first refused batch stops the file for good, nothing
// queued after it is sent, and `status()` says so.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTraceSink, type TraceSink } from "./trace-sink";
import { recordWindowListeners } from "./listener-scope.test-util";

const WINDOW_MS = 250;

/** The shell: each call recorded, each answered when the case settles it. */
let calls: Array<{ lines: string[]; resolve: (path: string) => void; reject: (err: Error) => void }>;
const append = (lines: string[]): Promise<string> =>
  new Promise((resolve, reject) => calls.push({ lines, resolve, reject }));

let scope: ReturnType<typeof recordWindowListeners>;
let sink: TraceSink;

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  scope = recordWindowListeners();
  sink = createTraceSink(append, WINDOW_MS);
});

afterEach(() => {
  scope.stop();
  scope.release();
  vi.useRealTimers();
});

describe("trace sink", () => {
  it("queues nothing until it is opened", () => {
    sink.push({ k: "a" });
    sink.flush();
    expect(calls).toEqual([]);
    expect(sink.status()).toEqual({ state: "closed" });
  });

  it("batches the records of one window into one append, as JSON lines", async () => {
    sink.open();
    sink.push({ k: "a" });
    sink.push({ k: "b\nc" });
    expect(calls).toEqual([]);
    expect(sink.status()).toEqual({ state: "waiting" });
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(calls.map((c) => c.lines)).toEqual([['{"k":"a"}', '{"k":"b\\nc"}']]);
    calls[0].resolve("/logs/x.jsonl");
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.status()).toEqual({ state: "writing", path: "/logs/x.jsonl" });
  });

  it("flushes on pagehide", () => {
    sink.open();
    sink.open();
    sink.push({ k: "a" });
    window.dispatchEvent(new Event("pagehide"));
    expect(calls).toHaveLength(1);
  });

  it("gives the file up on the first refused batch, and sends nothing queued behind it", async () => {
    sink.open();
    sink.push({ k: "a" });
    sink.flush();
    // Queued while the refused batch is still in flight.
    sink.push({ k: "b" });
    calls[0].reject(new Error("not-available"));
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.status()).toMatchObject({ state: "stopped", reason: "not-available" });

    sink.push({ k: "c" });
    sink.flush();
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(calls).toHaveLength(1);
  });

  it("stays stopped after a later batch would have landed", async () => {
    sink.open();
    sink.push({ k: "a" });
    sink.flush();
    sink.push({ k: "b" });
    sink.flush();
    calls[0].reject(new Error("refused"));
    calls[1].resolve("/logs/x.jsonl");
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.status()).toMatchObject({ state: "stopped", reason: "refused" });
  });
});
