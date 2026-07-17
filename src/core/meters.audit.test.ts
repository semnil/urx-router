// QA audit (core/meters.ts): dBFS decode boundaries (OVER / clip / silence /
// over-unity), per-tap L/R resolution, and address-set scoping. Tests pin the
// CURRENT decode behavior; "AUDIT" comments flag where the decode does no
// clamping (see the QA report).

import { describe, it, expect } from "vitest";
import {
  decodeMeterDb,
  defaultTapKey,
  hasMeter,
  MeterStore,
  METER_OVER_RAW,
  METER_TOP_DB,
  METER_FLOOR_DB,
  tapAddrs,
  tapFor,
} from "./meters";

describe("decodeMeterDb boundaries", () => {
  it("maps only the exact OVER sentinel to the ladder top", () => {
    expect(decodeMeterDb(METER_OVER_RAW)).toBe(METER_TOP_DB);
    // One below the sentinel is treated as a real reading, not OVER.
    expect(decodeMeterDb(METER_OVER_RAW - 1)).toBe((METER_OVER_RAW - 1) / 10);
  });

  it("decodes the silence floor sentinel below the ladder bottom", () => {
    // -1280 raw -> -128 dBFS, intentionally below METER_FLOOR_DB (-60): the UI
    // clamps to the ladder, decode does not.
    expect(decodeMeterDb(-1280)).toBe(-128);
    expect(decodeMeterDb(-1280)).toBeLessThan(METER_FLOOR_DB);
  });

  it("AUDIT: does not clamp above 0 dBFS (over-unity raw decodes past the ladder top)", () => {
    // A raw value between the ladder top (0 dBFS = raw 0) and the OVER sentinel
    // decodes to a positive dBFS with no cap. The device is not expected to send
    // this, but decode offers no defensive clamp; the UI must clamp to draw.
    expect(decodeMeterDb(50)).toBe(5);
    expect(decodeMeterDb(32766)).toBe(3276.6);
  });

  it("is a pure linear scale away from the OVER sentinel (symmetry around zero)", () => {
    expect(decodeMeterDb(0)).toBe(0);
    expect(decodeMeterDb(-100)).toBe(-10);
    expect(decodeMeterDb(100)).toBe(10);
  });
});

describe("MeterStore.reading resolution", () => {
  it("treats the OVER sentinel on the silent default as not-over (no false clip at rest)", () => {
    // Resting raw is the silence sentinel, never the OVER sentinel, so a fresh
    // store must report over=false even though decode maps both to a number.
    const r = new MeterStore().reading("bus.stereo", "preeq")!;
    expect(r.overL).toBe(false);
    expect(r.overR).toBe(false);
    expect(r.l).toBe(-128);
    expect(r.r).toBe(-128);
    expect(r.stereo).toBe(true);
  });

  it("flags OVER independently per side and keeps the opposite side's real value", () => {
    const store = new MeterStore();
    store.apply({ meterId: 104, x: 0, value: METER_OVER_RAW }); // STEREO PRE EQ L clips
    store.apply({ meterId: 104, x: 1, value: -123 }); // STEREO PRE EQ R real
    const r = store.reading("bus.stereo", "preeq")!;
    expect(r.overL).toBe(true);
    expect(r.l).toBe(METER_TOP_DB);
    expect(r.overR).toBe(false);
    expect(r.r).toBeCloseTo(-12.3, 5);
  });

  it("mono node mirrors L's over flag onto R (R reads from L)", () => {
    const store = new MeterStore();
    store.apply({ meterId: 100, x: 0, value: METER_OVER_RAW }); // ch1 INPUT (mono) clips
    const r = store.reading("ch1", "input")!;
    expect(r.stereo).toBe(false);
    expect(r.overL).toBe(true);
    // R derives from the L raw for a mono node, so it clips too.
    expect(r.overR).toBe(true);
    expect(r.r).toBe(METER_TOP_DB);
  });

  it("resolves a different address per tap on the same node", () => {
    const store = new MeterStore();
    store.apply({ meterId: 100, x: 0, value: -200 }); // ch1 INPUT
    store.apply({ meterId: 115, x: 0, value: METER_OVER_RAW }); // ch1 POST clips
    expect(store.reading("ch1", "input")!.overL).toBe(false);
    expect(store.reading("ch1", "input")!.l).toBe(-20);
    expect(store.reading("ch1", "post")!.overL).toBe(true);
  });

  it("a stale OVER reading persists until clear() (store holds last value)", () => {
    const store = new MeterStore();
    store.apply({ meterId: 100, x: 0, value: METER_OVER_RAW });
    expect(store.reading("ch1", "input")!.overL).toBe(true);
    // No decay in the store itself; the UI is responsible for hold/release.
    expect(store.reading("ch1", "input")!.overL).toBe(true);
    store.clear();
    expect(store.reading("ch1", "input")!.overL).toBe(false);
  });

  it("the packed stereo bus addresses (126:0/1 vs 126:2/3) do not bleed between MIX1 and MIX2", () => {
    const store = new MeterStore();
    store.apply({ meterId: 126, x: 0, value: -60 }); // MIX1 POST L
    store.apply({ meterId: 126, x: 3, value: METER_OVER_RAW }); // MIX2 POST R
    const mix1 = store.reading("bus.mix1", "post")!;
    const mix2 = store.reading("bus.mix2", "post")!;
    expect(mix1.l).toBe(-6);
    expect(mix1.overR).toBe(false); // MIX1 R (126:1) never set -> silence
    expect(mix2.overR).toBe(true); // MIX2 R (126:3) is the one that clipped
  });
});

describe("tapAddrs scoping", () => {
  it("returns addresses in first-seen order and dedupes a repeated tap", () => {
    // ch1..ch4 INPUT all share meter id 100 at distinct x; order follows the input.
    const taps = ["ch3", "ch1", "ch1", "ch4"].map((id) => tapFor(id, "input")!);
    expect(tapAddrs(taps)).toEqual([
      [100, 2],
      [100, 0],
      [100, 3],
    ]);
  });

  it("includes both sides of a stereo tap and a single address for a mono one", () => {
    const taps = [tapFor("bus.mon1", "post")!, tapFor("bus.osc", "post")!];
    expect(tapAddrs(taps)).toEqual([
      [129, 0],
      [129, 1],
      [135, 0], // OSC is mono -> single address, no phantom R
    ]);
  });

  it("an empty input yields an empty subscription set", () => {
    expect(tapAddrs([])).toEqual([]);
  });

  it("returns undefined for an unmapped node so callers can skip it", () => {
    expect(tapFor("out.main", "post")).toBeUndefined();
    expect(tapFor("nope", "input")).toBeUndefined();
  });
});

describe("tapAddrs → apply → reading pipeline (subscription set is sufficient)", () => {
  it("every address tapAddrs returns resolves a real reading for its node's default tap", () => {
    // The subscription set must cover exactly what reading() needs: feeding a value
    // at each returned address and reading the node back must surface that value, so
    // no metered node is left silent for want of a subscribed address.
    const nodes = ["ch1", "ch_5_6", "bus.mix1", "bus.mix2", "bus.osc"];
    const taps = nodes.map((id) => tapFor(id, defaultTapKey(id))!);
    const addrs = tapAddrs(taps);
    const store = new MeterStore();
    // Drive each subscribed address to a distinct, recoverable raw value.
    addrs.forEach(([meterId, x], i) => store.apply({ meterId, x, value: -(i + 1) * 10 }));
    for (const id of nodes) {
      const r = store.reading(id, defaultTapKey(id))!;
      // A driven address decodes to a real (non-silence) reading; mono mirrors L→R.
      expect(r.l, id).toBeGreaterThan(METER_FLOOR_DB - 100); // not the -128 silence floor
      expect(r.l, id).not.toBe(-128);
    }
  });

  it("one raw below the OVER sentinel on a stereo packed pair stays a real (non-over) reading", () => {
    // BVA on the clip boundary for the packed MIX addresses: METER_OVER_RAW - 1 must
    // decode as a normal value and never light the over flag.
    const store = new MeterStore();
    store.apply({ meterId: 126, x: 0, value: METER_OVER_RAW - 1 }); // MIX1 POST L
    store.apply({ meterId: 126, x: 3, value: METER_OVER_RAW }); // MIX2 POST R clips
    const mix1 = store.reading("bus.mix1", "post")!;
    const mix2 = store.reading("bus.mix2", "post")!;
    expect(mix1.overL).toBe(false);
    expect(mix1.l).toBeCloseTo((METER_OVER_RAW - 1) / 10, 5);
    expect(mix2.overR).toBe(true);
    expect(mix2.r).toBe(METER_TOP_DB);
  });
});

describe("hasMeter mapping completeness", () => {
  it("covers exactly the metered console strips and excludes output patches for URX22", () => {
    for (const id of [
      "ch1", "ch2", "ch_3_4", "ch_5_6", "ch_7_8", "ch_9_10",
      "bus.stereo", "bus.mix1", "bus.mix2", "bus.fx1", "bus.fx2",
      "bus.stream", "bus.mon1", "bus.mon2", "bus.osc",
    ]) {
      expect(hasMeter(id, "URX22"), id).toBe(true);
    }
    for (const id of ["ch3", "ch4", "ch_11_12", "out.main", "out.line", "out.usbsub", "out.ducker1", "in.aux"]) {
      expect(hasMeter(id, "URX22"), id).toBe(false);
    }
  });

  it("covers exactly the metered console strips and excludes output patches for URX44 and URX44V", () => {
    // Test both explicit model IDs and the undefined default fallback (backward compatibility)
    for (const modelId of ["URX44", "URX44V", undefined] as const) {
      for (const id of [
        "ch1", "ch4", "ch_5_6", "ch_11_12",
        "bus.stereo", "bus.mix1", "bus.mix2", "bus.fx1", "bus.fx2",
        "bus.stream", "bus.mon1", "bus.mon2", "bus.osc",
      ]) {
        expect(hasMeter(id, modelId), `${modelId}: ${id}`).toBe(true);
      }
      for (const id of ["out.main", "out.line", "out.usbsub", "out.ducker1", "in.aux"]) {
        expect(hasMeter(id, modelId), `${modelId}: ${id}`).toBe(false);
      }
    }
  });
});
