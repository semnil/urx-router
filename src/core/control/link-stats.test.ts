// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appBuildKind: vi.fn<() => Promise<"dev" | "release">>(),
  appendLinkLog: vi.fn<(line: string) => Promise<string>>(),
  vdLinkStats: vi.fn<
    () => Promise<{
      sets: number;
      gets: number;
      paramSubscribes: number;
      meterSubscribes: number;
      registFrames: number;
      unregistFrames: number;
      deadlines: number;
      stalled: number;
    } | null>
  >(),
}));

vi.mock("../platform", () => ({
  appBuildKind: mocks.appBuildKind,
  appendLinkLog: mocks.appendLinkLog,
  vdLinkStats: mocks.vdLinkStats,
}));

import { LINK_LEDGER_KEYS, LinkLedgerTracker, ledgerValue, type LinkLedger } from "./link-stats";

const NOW = new Date("2026-08-11T00:00:00.000Z");
const LOG_PATH = "/tmp/urx-router/link-ledger.jsonl";
const STATS = {
  sets: 40,
  gets: 5,
  paramSubscribes: 2,
  meterSubscribes: 7,
  registFrames: 300,
  unregistFrames: 20,
  deadlines: 6,
  stalled: 1,
};

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function logged(index: number): Record<string, unknown> {
  return JSON.parse(mocks.appendLinkLog.mock.calls[index][0]) as Record<string, unknown>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  mocks.appBuildKind.mockResolvedValue("dev");
  mocks.appendLinkLog.mockResolvedValue(LOG_PATH);
  mocks.vdLinkStats.mockResolvedValue(STATS);
});

afterEach(() => vi.useRealTimers());

describe("ledgerValue", () => {
  it("formats every row from the one typed key list", () => {
    const ledger: LinkLedger = { ...STATS, upMs: 30 * 60 * 60 * 1000 + 2 * 60 * 1000 + 3 * 1000, fullReads: 12_345 };
    const values: Record<(typeof LINK_LEDGER_KEYS)[number], string> = {
      up: "30:02:03",
      sent: "45",
      subscriptions: "9",
      frames: "320",
      reads: "12 345",
      noanswer: "6",
      log: "",
    };
    for (const key of LINK_LEDGER_KEYS) expect(ledgerValue(key, ledger), key).toBe(values[key]);
    expect(ledgerValue("up", { ...ledger, upMs: -1 })).toBe("0:00:00");
  });
});

describe("LinkLedgerTracker", () => {
  it("brackets a session with opening, interval and final records", async () => {
    const tracker = new LinkLedgerTracker("1.8.0");
    tracker.begin("URX44V");
    expect(tracker.active).toBe(true);
    expect(tracker.path).toBeNull();
    await flushPromises();

    expect(mocks.appendLinkLog).toHaveBeenCalledTimes(1);
    expect(logged(0)).toMatchObject({
      at: NOW.toISOString(),
      build: "dev",
      version: "1.8.0",
      device: "URX44V",
      end: null,
      upMs: 0,
      fullReads: 0,
      ...STATS,
    });
    expect(tracker.path).toBe(LOG_PATH);

    tracker.noteFullRead();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.appendLinkLog).toHaveBeenCalledTimes(2);
    expect(logged(1)).toMatchObject({ end: null, upMs: 60_000, fullReads: 1 });

    await tracker.end("off");
    expect(tracker.active).toBe(false);
    await flushPromises();
    expect(mocks.appendLinkLog).toHaveBeenCalledTimes(3);
    expect(logged(2)).toMatchObject({ end: "off", upMs: 60_000, fullReads: 1, ...STATS });

    // Ending twice, advancing the old interval, or noting a read outside a session
    // cannot produce another record or alter the last reading.
    await tracker.end("error");
    tracker.noteFullRead();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.appendLinkLog).toHaveBeenCalledTimes(3);
    await expect(tracker.read()).resolves.toMatchObject({ upMs: 60_000, fullReads: 1 });
    expect(mocks.appBuildKind).toHaveBeenCalledOnce();
  });

  it("keeps the last reading when the broker disappears", async () => {
    const tracker = new LinkLedgerTracker("1.8.0");
    tracker.begin("URX22");
    await flushPromises();
    tracker.noteFullRead();
    vi.setSystemTime(new Date(NOW.getTime() + 2_500));
    await expect(tracker.read()).resolves.toEqual({ upMs: 2_500, ...STATS, fullReads: 1 });

    mocks.vdLinkStats.mockRejectedValueOnce(new Error("link gone"));
    await expect(tracker.read()).resolves.toEqual({ upMs: 2_500, ...STATS, fullReads: 1 });
    mocks.vdLinkStats.mockResolvedValueOnce(null);
    await expect(tracker.read()).resolves.toEqual({ upMs: 2_500, ...STATS, fullReads: 1 });
  });

  it("reports a log failure once per session and continues tracking", async () => {
    mocks.appBuildKind.mockRejectedValue(new Error("kind unavailable"));
    mocks.appendLinkLog.mockRejectedValue(new Error("disk full"));
    const firstError = vi.fn();
    const tracker = new LinkLedgerTracker("1.8.0");

    tracker.begin("URX44", firstError);
    await flushPromises();
    expect(firstError).toHaveBeenCalledOnce();
    expect(firstError).toHaveBeenCalledWith("disk full");
    await vi.advanceTimersByTimeAsync(60_000);
    await tracker.end("error");
    await flushPromises();
    expect(firstError).toHaveBeenCalledOnce();
    expect(logged(0)).toMatchObject({ build: null, end: null });

    // A new session gets one warning of its own, while the immutable build-kind
    // lookup remains cached even when it failed.
    mocks.appendLinkLog.mockRejectedValue("read only");
    const secondError = vi.fn();
    tracker.begin("URX44V", secondError);
    await flushPromises();
    expect(secondError).toHaveBeenCalledWith("read only");
    expect(mocks.appBuildKind).toHaveBeenCalledOnce();
  });
});
