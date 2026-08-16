// @vitest-environment jsdom
// The probe is a measuring instrument, so what is pinned here is that it measures:
// entries keep their arrival order on one clock, a send the port swallowed stays
// distinguishable from one that went out, and `report()` states the two numbers a
// gate length is chosen from — how many messages a mark's window emitted, and how
// long after the mark the first reply arrived. A probe that silently records nothing
// is worse than no probe, which is the same reason meter-bench.contract.test.ts exists.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { midiProbe, type MidiProbe, type MidiProbeHandle } from "./midi-probe";
import { recordWindowListeners } from "./listener-scope.test-util";

// The shell the sink writes through. Stubbed rather than left to reject, because the
// behaviour under test IS the writing: with the real module `isTauri()` is false under
// jsdom and the sink never starts, which is how the file's first version pinned the
// record shape while every line of the sink went unrun.
const shell = { batches: [] as string[][], fail: null as Error | null };
vi.mock("../core/platform", () => ({
  isTauri: () => true,
  appendMidiLog: (lines: string[]) => {
    shell.batches.push(lines);
    return shell.fail ? Promise.reject(shell.fail) : Promise.resolve("/logs/midi-trace.jsonl");
  },
}));

const handle = (): MidiProbeHandle => {
  const h = (window as unknown as { __urxMidiProbe?: MidiProbeHandle }).__urxMidiProbe;
  if (!h) throw new Error("probe not installed");
  return h;
};

let probe: MidiProbe;

beforeEach(() => {
  if (!midiProbe) throw new Error("midiProbe is null in a dev test run");
  probe = midiProbe;
  handle().clear();
});

describe("midi probe", () => {
  it("publishes its surface on window in a dev build", () => {
    const h = handle();
    expect(typeof h.clear).toBe("function");
    expect(typeof h.mark).toBe("function");
    expect(typeof h.entries).toBe("function");
    expect(typeof h.report).toBe("function");
    expect(typeof h.flush).toBe("function");
  });

  it("keeps arrival order on one non-decreasing clock", () => {
    probe.mark("a");
    probe.tx([0xbf, 80, 95]);
    probe.rx([0xbf, 80, 95]);
    const entries = handle().entries();
    expect(entries.map((e) => e.kind)).toEqual(["mark", "tx", "rx"]);
    expect(entries[1].t).toBeGreaterThanOrEqual(entries[0].t);
    expect(entries[2].t).toBeGreaterThanOrEqual(entries[1].t);
  });

  it("decodes through the app's own decoder, with 1-based channels", () => {
    probe.tx([0xbf, 80, 95]); // status 0xBF = CC on the 16th channel
    probe.rx([0x90, 60, 127]);
    probe.rx([0xe0, 0, 64]);
    probe.rx([0xf8]); // clock — not a channel-voice message
    expect(
      handle()
        .entries()
        .map((e) => e.text),
    ).toEqual(["CH 16 CC 80 = 95", "CH 1 NOTE 60 on", "CH 1 PITCH BEND = 8192", "raw [248]"]);
  });

  it("records a swallowed send as its own kind, not as silence", () => {
    probe.txDropped([0xbf, 80, 95], "no output port");
    const [entry] = handle().entries();
    expect(entry.kind).toBe("tx-dropped");
    expect(entry.text).toContain("no output port");
    expect(entry.bytes).toEqual([0xbf, 80, 95]);
    // And it is not counted as a send by the per-mark measurement.
    expect(handle().report()).toContain("tx-dropped=1");
  });

  it("keeps a copy of the bytes, so a caller reusing its array cannot rewrite history", () => {
    const bytes = [0xbf, 80, 95];
    probe.tx(bytes);
    bytes[2] = 0;
    expect(handle().entries()[0].bytes).toEqual([0xbf, 80, 95]);
  });

  it("reports per mark how much went out and when the first reply landed", () => {
    probe.mark("midi:resync");
    probe.tx([0xbf, 80, 95]);
    probe.tx([0xbf, 81, 30]);
    probe.rx([0xbf, 80, 12]);
    const text = handle().report();
    expect(text).toContain("midi:resync: tx=2 dropped=0");
    // The decimals depend on what the clock offers (the two cases below pin both), so
    // this asserts the measurement rather than the environment it was taken in.
    expect(text).toMatch(/first rx \+\d+(\.\d\d)? ms \(CH 16 CC 80 = 12\)/);
  });

  // The engine's clock is `performance.now()`, and the shipping webview clamps it to
  // whole milliseconds (measured on macOS WKWebView, 2026-08-16: 419 records over five
  // launches, none carrying a fraction) while jsdom and Chromium keep sub-millisecond
  // values. The same report is therefore read at two resolutions, so it states which one
  // it is in: printing `.00` on every line of a real-device run claims a precision the
  // reading does not have, and a 0 there means "below the clock", not "simultaneous".
  it("drops the decimals, and says why, when the clock carries no fractions", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValueOnce(1000).mockReturnValueOnce(1002).mockReturnValueOnce(1004);
    probe.mark("midi:resync (readback)");
    probe.tx([0xbf, 80, 95]);
    probe.rx([0xbf, 80, 12]);
    now.mockRestore();

    const text = handle().report();
    expect(text).toContain("first rx +4 ms");
    expect(text).toContain("clock: whole milliseconds");
    expect(text).not.toMatch(/\d\.\d/);
  });

  it("keeps the decimals where the clock has them, and then claims nothing about it", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValueOnce(1000).mockReturnValueOnce(1000.5).mockReturnValueOnce(1004.25);
    probe.mark("midi:resync (readback)");
    probe.tx([0xbf, 80, 95]);
    probe.rx([0xbf, 80, 12]);
    now.mockRestore();

    const text = handle().report();
    expect(text).toContain("first rx +4.25 ms");
    expect(text).not.toContain("clock: whole milliseconds");
  });

  it("says so when a mark's window drew no reply at all", () => {
    probe.mark("midi:resync");
    probe.tx([0xbf, 80, 95]);
    expect(handle().report()).toContain("no rx after it");
  });

  it("answers a placeholder rather than an empty string with nothing recorded", () => {
    expect(handle().report()).toBe("(no entries)");
  });
});

// The file is what outlives the page, so it is driven here through the surface the module
// publishes — start it, record, `flush()` — rather than through an export opened up for
// the test. Each case loads its own copy: "started" and "gave up" are decisions the module
// takes once, so two cases sharing an instance would not be independent.
interface TraceRecord {
  ms: number;
  t: number;
  k: string;
  d: string;
}

describe("the trace file", () => {
  let scope: ReturnType<typeof recordWindowListeners> | null = null;

  // Each load registers the sink's `pagehide` listener on a window that outlives the
  // file; taken back per case so a stale one cannot flush into the next case's shell.
  const load = async (): Promise<{ probe: MidiProbe; start: () => void }> => {
    shell.batches.length = 0;
    shell.fail = null;
    vi.resetModules();
    scope = recordWindowListeners();
    const mod = await import("./midi-probe");
    if (!mod.midiProbe || !mod.startMidiTrace) throw new Error("probe is null in a dev test run");
    return { probe: mod.midiProbe, start: mod.startMidiTrace };
  };

  const records = (batch: string[]): TraceRecord[] => batch.map((l) => JSON.parse(l) as TraceRecord);

  afterEach(() => {
    scope?.stop();
    scope?.release();
    scope = null;
  });

  it("opens with a page:open record and carries what follows in one batch", async () => {
    const { probe: p, start } = await load();
    start();
    p.rx([0xbf, 80, 95]);
    p.tx([0xbf, 80, 96]);
    handle().flush();
    expect(shell.batches).toHaveLength(1);
    const written = records(shell.batches[0]);
    expect(written.map((r) => r.k)).toEqual(["mark", "rx", "tx"]);
    expect(written[0].d).toBe("page:open");
    expect(written[1].d).toBe("CH 16 CC 80 = 95");
  });

  it("writes nothing until it is started, so importing the module performs no IPC", async () => {
    const { probe: p } = await load();
    p.rx([0xbf, 80, 95]);
    handle().flush();
    expect(shell.batches).toEqual([]);
  });

  it("carries a wall clock as well as the ring's page-relative one", async () => {
    const { probe: p, start } = await load();
    start();
    p.rx([0xbf, 80, 95]);
    handle().flush();
    const rx = records(shell.batches[0]).find((r) => r.k === "rx");
    const entry = handle()
      .entries()
      .find((e) => e.kind === "rx");
    if (!rx || !entry) throw new Error("the rx record was not written");
    expect(rx.d).toBe("CH 16 CC 80 = 95");
    expect(rx.t).toBeCloseTo(entry.t, 3);
    // The epoch stamp is the page's origin plus the entry's offset, which is what makes
    // two page loads comparable. Bracketed rather than compared to one reading, since
    // Date.now() moves between the record and this line.
    expect(rx.ms).toBeGreaterThanOrEqual(Math.round(performance.timeOrigin));
    expect(rx.ms).toBeLessThanOrEqual(Date.now() + 1);
  });

  it("escapes a detail's own newline instead of letting it split the record", async () => {
    // The shell refuses the WHOLE batch over a control character (`log_line_ok` in
    // lib.rs), so an unescaped one costs every record queued beside it, not just this one.
    const { probe: p, start } = await load();
    start();
    p.note("apply ch1/level\nforged: true");
    handle().flush();
    const [batch] = shell.batches;
    expect(batch.every((l) => ![...l].some((c) => (c.codePointAt(0) ?? 0) < 0x20))).toBe(true);
    expect(records(batch).map((r) => r.d)).toContain("apply ch1/level\nforged: true");
  });

  it("names the file in the report once a batch has landed", async () => {
    const { start } = await load();
    start();
    handle().flush();
    await Promise.resolve();
    expect(handle().report()).toContain("trace file: /logs/midi-trace.jsonl");
  });

  it("gives the sink up on a refusal, and says so rather than just ending", async () => {
    const { probe: p, start } = await load();
    shell.fail = new Error("stub: unhandled command append_midi_log");
    start();
    handle().flush();
    await Promise.resolve();
    expect(shell.batches).toHaveLength(1);

    // Nothing more is queued or sent. `pending` is cleared on the give-up and `toSink`
    // returns early afterwards, so a later record reaches neither.
    p.rx([0xbf, 80, 95]);
    handle().flush();
    expect(shell.batches).toHaveLength(1);
    const report = handle().report();
    expect(report).toContain("trace file: STOPPED");
    expect(report).toContain("stub: unhandled command append_midi_log");
    // …and the give-up is not itself a row in the measurement stream: the ring holds the
    // page mark and the message, and nothing describing the instrument.
    expect(report).toContain("mark=1  rx=1");
  });
});
