// @vitest-environment jsdom
// The watch is a measuring instrument left running for days to catch one change, so
// what is pinned is that it catches it: a change the unit announces and one it does
// not both land in the file with the wall clock, a watch that went quiet reads
// differently from one with nothing to report, and nothing it does reaches the unit as
// a write or enters the live-sync subscription.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ParamUpdate } from "../core/platform";
import type { ParamWatch, ParamWatchHandle } from "./param-watch";

/** The stubbed shell: a value per address, the watch's notify channel, and the file. */
const shell = {
  tauri: true,
  values: new Map<string, number>(),
  readFails: null as Error | null,
  /** Holds the read of one address open until the case releases it. */
  held: null as { addr: string; release: (v: number) => void } | null,
  holdAddr: null as string | null,
  subscribeFails: null as Error | null,
  subscribeHeld: false,
  releaseSubscribe: null as (() => void) | null,
  appendFails: null as Error | null,
  gets: [] as string[],
  subscribed: [] as Array<Array<[number, number, number]>>,
  notify: null as ((p: ParamUpdate) => void) | null,
  batches: [] as string[][],
};
vi.mock("../core/platform", () => ({
  isTauri: () => shell.tauri,
  vdGet: (id: number, x: number, y: number) => {
    shell.gets.push(`${id}:${x}:${y}`);
    if (shell.readFails) return Promise.reject(shell.readFails);
    if (shell.holdAddr === `${id}:${x}:${y}`) {
      const addr = shell.holdAddr;
      shell.holdAddr = null;
      return new Promise<number>((release) => (shell.held = { addr, release }));
    }
    return Promise.resolve(shell.values.get(`${id}:${x}:${y}`) ?? 0);
  },
  vdProbeSubscribe: (addrs: Array<[number, number, number]>, onUpdate: (p: ParamUpdate) => void) => {
    shell.subscribed.push(addrs);
    shell.notify = onUpdate;
    if (shell.subscribeHeld) return new Promise<void>((release) => (shell.releaseSubscribe = release));
    return shell.subscribeFails ? Promise.reject(shell.subscribeFails) : Promise.resolve();
  },
  appendWatchLog: (lines: string[]) => {
    shell.batches.push(lines);
    return shell.appendFails ? Promise.reject(shell.appendFails) : Promise.resolve("/logs/param-watch.jsonl");
  },
}));

type WatchRecord = Record<string, unknown> & { k: string; ms: number; at: string };

let watch: ParamWatch;
let mod: typeof import("./param-watch");
const handle = (): ParamWatchHandle => {
  const h = (window as unknown as { __urxParamWatch?: ParamWatchHandle }).__urxParamWatch;
  if (!h) throw new Error("watch not installed");
  return h;
};
const written = (): WatchRecord[] => shell.batches.flat().map((l) => JSON.parse(l) as WatchRecord);
const ofKind = (k: string): WatchRecord[] => written().filter((r) => r.k === k);
/** Let the awaited reads resolve, then flush the batch to the stubbed file. */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
  handle().flush();
};
const notify = (paramId: number, value: number, x = 0, y = 0): void =>
  shell.notify?.({ paramId, x, y, value, valueStr: undefined });

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 14, 23, 51, 26, 123));
  Object.assign(shell, {
    tauri: true,
    values: new Map([
      ["838:0:0", 1],
      ["817:0:0", 0],
      ["781:0:0", 0x8000],
      ["863:0:0", 0x8000],
    ]),
    readFails: null,
    held: null,
    holdAddr: null,
    subscribeFails: null,
    subscribeHeld: false,
    releaseSubscribe: null,
    appendFails: null,
    gets: [],
    subscribed: [],
    notify: null,
    batches: [],
  });
  vi.resetModules();
  mod = await import("./param-watch");
  if (!mod.paramWatch) throw new Error("paramWatch is null in a dev test run");
  watch = mod.paramWatch;
});

afterEach(() => {
  watch.stop("test end");
  vi.useRealTimers();
});

describe("param watch", () => {
  it("registers the watched set and the clock as its own subscription, and reads a baseline", async () => {
    watch.start("URX44V");
    await settle();
    expect(shell.subscribed).toEqual([
      [
        [838, 0, 0],
        [817, 0, 0],
        [781, 0, 0],
        [863, 0, 0],
        [789, 0, 0],
        [790, 0, 0],
        [791, 0, 0],
        [792, 0, 0],
        [793, 0, 0],
        [794, 0, 0],
      ],
    ]);
    expect(shell.gets).toEqual(["838:0:0", "817:0:0", "781:0:0", "863:0:0"]);
    expect(written().map((r) => r.k)).toEqual(["open", "start"]);
    expect(ofKind("open")[0].model).toBe("URX44V");
    expect(ofKind("start")[0].values).toEqual({
      "838:0:0": 1,
      "817:0:0": 0,
      "781:0:0": 0x8000,
      "863:0:0": 0x8000,
    });
  });

  it("stamps every record with the wall clock in epoch ms and local time", async () => {
    watch.start("URX44V");
    await settle();
    const [open] = written();
    expect(open.ms).toBe(new Date(2026, 9, 14, 23, 51, 26, 123).getTime());
    expect(open.at).toMatch(/^2026-10-14 23:51:26\.123[+-]\d\d:\d\d$/);
  });

  it("records a notify on a watched address with the value it replaced", async () => {
    watch.start("URX44V");
    await settle();
    notify(838, 2);
    notify(838, 2);
    await settle();
    expect(ofKind("notify").map(({ addr, from, to }) => ({ addr, from, to }))).toEqual([
      { addr: "838:0:0", from: 1, to: 2 },
      { addr: "838:0:0", from: 2, to: 2 },
    ]);
  });

  it("records a change the unit did not announce, found by the once-a-second read", async () => {
    watch.start("URX44V");
    await settle();
    shell.values.set("838:0:0", 2);
    await vi.advanceTimersByTimeAsync(mod.POLL_MS);
    handle().flush();
    expect(ofKind("poll").map(({ addr, from, to }) => ({ addr, from, to }))).toEqual([
      { addr: "838:0:0", from: 1, to: 2 },
    ]);
    // An unchanged reading writes nothing.
    await vi.advanceTimersByTimeAsync(mod.POLL_MS * 3);
    handle().flush();
    expect(ofKind("poll")).toHaveLength(1);
    // …and a change already announced is not recorded a second time by the read after it.
    notify(817, 1);
    shell.values.set("817:0:0", 1);
    await vi.advanceTimersByTimeAsync(mod.POLL_MS);
    handle().flush();
    expect(ofKind("poll")).toHaveLength(1);
    expect(ofKind("notify")).toHaveLength(1);
  });

  it("ignores an address it did not register, counts the clock, and records a bulk change", async () => {
    watch.start("URX44V");
    await settle();
    notify(142, 1);
    notify(789, 5);
    notify(790, 6);
    shell.notify?.({ paramId: 0, x: -1, y: -1, value: 0 });
    await settle();
    expect(ofKind("notify")).toEqual([]);
    expect(ofKind("bulk")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(mod.ALIVE_MS);
    handle().flush();
    const [first] = ofKind("alive");
    expect(first).toMatchObject({ clock: 2, notifies: 0, pollErrors: 0 });
    expect(first.polls).toBe(mod.ALIVE_MS / mod.POLL_MS - 1);
    // Counts are per line: a minute with no clock notify reads 0 rather than a total.
    await vi.advanceTimersByTimeAsync(mod.ALIVE_MS);
    handle().flush();
    expect(ofKind("alive")[1]).toMatchObject({ clock: 0 });
  });

  it("records the first failed read of a run and the recovery, not every failure", async () => {
    watch.start("URX44V");
    await settle();
    shell.readFails = new Error("broker-timeout");
    await vi.advanceTimersByTimeAsync(mod.POLL_MS * 3);
    shell.readFails = null;
    await vi.advanceTimersByTimeAsync(mod.POLL_MS);
    handle().flush();
    expect(ofKind("poll-error")).toEqual([expect.objectContaining({ addr: "838:0:0", error: "broker-timeout" })]);
    expect(ofKind("poll-ok")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(mod.ALIVE_MS);
    handle().flush();
    expect(ofKind("alive")[0].pollErrors).toBe(12);
  });

  it("keeps reading when the registration is refused, and says the notify half is missing", async () => {
    shell.subscribeFails = new Error("not-available");
    watch.start("URX44V");
    await settle();
    expect(ofKind("subscribe-error")).toEqual([expect.objectContaining({ error: "not-available" })]);
    shell.values.set("838:0:0", 2);
    await vi.advanceTimersByTimeAsync(mod.POLL_MS);
    handle().flush();
    expect(ofKind("poll")).toHaveLength(1);
  });

  it("stops reading at stop and drops what the subscription still delivers", async () => {
    watch.start("URX44V");
    await settle();
    watch.stop("off");
    const reads = shell.gets.length;
    notify(838, 2);
    await vi.advanceTimersByTimeAsync(mod.ALIVE_MS * 2);
    handle().flush();
    expect(shell.gets).toHaveLength(reads);
    expect(written().map((r) => r.k)).toEqual(["open", "start", "stop"]);
    expect(ofKind("stop")[0]).toMatchObject({ reason: "off", values: { "838:0:0": 1 } });
  });

  it("drops a late notify from the session a restart replaced", async () => {
    watch.start("URX44V");
    await settle();
    const stale = shell.notify;
    watch.start("URX44V");
    await settle();
    stale?.({ paramId: 838, x: 0, y: 0, value: 2 });
    await settle();
    expect(ofKind("notify")).toEqual([]);
    expect(ofKind("stop")[0].reason).toBe("restart");
  });

  it("gives the file up on a refusal, and the report says so", async () => {
    shell.appendFails = new Error("not-available: the parameter watch is a dev build's diagnostic");
    watch.start("URX44V");
    await settle();
    expect(shell.batches).toHaveLength(1);
    notify(838, 2);
    await settle();
    expect(shell.batches).toHaveLength(1);
    expect(handle().report()).toContain("trace file: STOPPED — not-available");
    // The in-page copy still holds what the file could not.
    expect(
      handle()
        .records()
        .map((r) => r.k),
    ).toContain("notify");
  });

  it("keeps a notify that lands while a later address is being read, rather than reverting it", async () => {
    watch.start("URX44V");
    await settle();
    // The round reads 838 (still 1), then waits on 817 while the unit announces 838 = 2.
    shell.holdAddr = "817:0:0";
    await vi.advanceTimersByTimeAsync(mod.POLL_MS);
    expect(shell.held?.addr).toBe("817:0:0");
    shell.values.set("838:0:0", 2);
    notify(838, 2);
    shell.held?.release(0);
    await settle();
    await vi.advanceTimersByTimeAsync(mod.POLL_MS * 2);
    handle().flush();
    expect(ofKind("notify").map(({ from, to }) => ({ from, to }))).toEqual([{ from: 1, to: 2 }]);
    expect(ofKind("poll")).toEqual([]);
  });

  it("drops a read of an address that took a notify while that read was in flight", async () => {
    watch.start("URX44V");
    await settle();
    shell.holdAddr = "838:0:0";
    await vi.advanceTimersByTimeAsync(mod.POLL_MS);
    expect(shell.held?.addr).toBe("838:0:0");
    shell.values.set("838:0:0", 2);
    notify(838, 2);
    shell.held?.release(1);
    await settle();
    expect(ofKind("poll")).toEqual([]);
    // The next round reads the value the notify carried, so nothing more is recorded.
    await vi.advanceTimersByTimeAsync(mod.POLL_MS);
    handle().flush();
    expect(ofKind("poll")).toEqual([]);
  });

  it("starts from a notify that landed during the first reading, not from the reading before it", async () => {
    shell.holdAddr = "817:0:0";
    watch.start("URX44V");
    await vi.advanceTimersByTimeAsync(0);
    expect(shell.held?.addr).toBe("817:0:0");
    shell.values.set("838:0:0", 2);
    notify(838, 2);
    shell.held?.release(0);
    await settle();
    expect(ofKind("start")[0].values).toMatchObject({ "838:0:0": 2 });
  });

  it("reads nothing when stopped while the registration is still on the wire", async () => {
    shell.subscribeHeld = true;
    watch.start("URX44V");
    await vi.advanceTimersByTimeAsync(0);
    watch.stop("off");
    shell.releaseSubscribe?.();
    await vi.advanceTimersByTimeAsync(mod.POLL_MS * 3);
    expect(shell.gets).toEqual([]);
  });

  it("hands every failed read to the session's owner", async () => {
    const seen: unknown[] = [];
    watch.start("URX44V", (err) => seen.push(err));
    await settle();
    shell.readFails = new Error("device-lost: sync_status offline");
    await vi.advanceTimersByTimeAsync(mod.POLL_MS);
    expect(seen).toHaveLength(mod.WATCHED.length);
    expect(seen[0]).toBe(shell.readFails);
  });

  it("does nothing outside the desktop shell", async () => {
    shell.tauri = false;
    watch.start("URX44V");
    await vi.advanceTimersByTimeAsync(mod.POLL_MS * 2);
    handle().flush();
    expect(shell.subscribed).toEqual([]);
    expect(shell.gets).toEqual([]);
    expect(shell.batches).toEqual([]);
  });

  it("records nothing more once stopped in the middle of a round of reads", async () => {
    watch.start("URX44V");
    await settle();
    shell.holdAddr = "817:0:0";
    await vi.advanceTimersByTimeAsync(mod.POLL_MS);
    watch.stop("off");
    shell.values.set("838:0:0", 2);
    shell.held?.release(5);
    await vi.advanceTimersByTimeAsync(mod.POLL_MS * 2);
    handle().flush();
    expect(written().map((r) => r.k)).toEqual(["open", "start", "stop"]);
    expect(shell.gets.filter((a) => a === "817:0:0")).toHaveLength(2);
  });

  it("names where the file is in the report, or that nothing has landed yet", async () => {
    expect(handle().report()).toContain("trace file: no batch has landed yet");
    watch.start("URX44V");
    await settle();
    expect(handle().report()).toContain("trace file: /logs/param-watch.jsonl");
    expect(handle().report()).toMatch(/^\d{4}-\d\d-\d\d .* open +\{"model":"URX44V"/);
  });

  it("imports nothing from the shell that writes to the unit or touches the live-sync set", () => {
    // The watch's whole contract with the unit is read-only, and what makes that true is
    // which shell functions it can reach at all.
    const src = readFileSync(resolve(process.cwd(), "src/ui/param-watch.ts"), "utf8");
    const imports = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\.\/core\/platform"/g)].flatMap((m) =>
      m[1].split(",").map((s) => s.trim()),
    );
    expect(imports.sort()).toEqual(["appendWatchLog", "isTauri", "type ParamUpdate", "vdGet", "vdProbeSubscribe"]);
    expect(src).not.toMatch(/from\s*"\.\.\/core\/control\//);
  });
});
