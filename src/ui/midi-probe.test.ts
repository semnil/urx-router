// @vitest-environment jsdom
// The probe is a measuring instrument, so what is pinned here is that it measures:
// entries keep their arrival order on one clock, a send the port swallowed stays
// distinguishable from one that went out, and `report()` states the two numbers a
// gate length is chosen from — how many messages a mark's window emitted, and how
// long after the mark the first reply arrived. A probe that silently records nothing
// is worse than no probe, which is the same reason meter-bench.contract.test.ts exists.
import { describe, it, expect, beforeEach } from "vitest";
import { midiProbe, type MidiProbe, type MidiProbeHandle } from "./midi-probe";

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
    expect(text).toMatch(/first rx \+\d+\.\d\d ms \(CH 16 CC 80 = 12\)/);
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
