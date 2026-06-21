import { describe, it, expect } from "vitest";
import {
  decodeMeterDb,
  hasMeter,
  metersForNodes,
  MeterStore,
  METER_OVER_RAW,
  METER_TOP_DB,
} from "./meters";

describe("decodeMeterDb", () => {
  it("scales the raw deci-dBFS value by 1/10", () => {
    expect(decodeMeterDb(0)).toBe(0);
    expect(decodeMeterDb(-200)).toBe(-20);
    expect(decodeMeterDb(-1280)).toBe(-128);
  });

  it("maps the OVER sentinel to the ladder top", () => {
    expect(decodeMeterDb(METER_OVER_RAW)).toBe(METER_TOP_DB);
  });
});

describe("hasMeter", () => {
  it("is true for mapped console nodes and false otherwise", () => {
    expect(hasMeter("ch1")).toBe(true);
    expect(hasMeter("bus.stereo")).toBe(true);
    expect(hasMeter("bus.mon1")).toBe(true);
    expect(hasMeter("out.main")).toBe(false);
    expect(hasMeter("nope")).toBe(false);
  });
});

describe("MeterStore.reading", () => {
  it("returns null for an unmapped node", () => {
    expect(new MeterStore().reading("out.main")).toBeNull();
  });

  it("rests at the silence floor before any reading arrives", () => {
    const r = new MeterStore().reading("ch1")!;
    expect(r.l).toBe(-128);
    expect(r.r).toBe(-128);
    expect(r.overL).toBe(false);
    expect(r.stereo).toBe(false);
  });

  it("mirrors L onto R for a mono node", () => {
    const store = new MeterStore();
    store.apply({ meterId: 100, x: 0, value: -120 }); // ch1 L
    const r = store.reading("ch1")!;
    expect(r.l).toBe(-12);
    expect(r.r).toBe(-12);
    expect(r.stereo).toBe(false);
  });

  it("decodes independent L/R for a stereo node and flags OVER per side", () => {
    const store = new MeterStore();
    store.apply({ meterId: 104, x: 0, value: -60 }); // STEREO L
    store.apply({ meterId: 104, x: 1, value: METER_OVER_RAW }); // STEREO R clips
    const r = store.reading("bus.stereo")!;
    expect(r.l).toBe(-6);
    expect(r.r).toBe(METER_TOP_DB);
    expect(r.overL).toBe(false);
    expect(r.overR).toBe(true);
    expect(r.stereo).toBe(true);
  });

  it("clear() drops all readings back to silence", () => {
    const store = new MeterStore();
    store.apply({ meterId: 100, x: 0, value: 0 });
    store.clear();
    expect(store.reading("ch1")!.l).toBe(-128);
  });
});

describe("metersForNodes", () => {
  it("collects each mapped node's distinct addresses", () => {
    expect(metersForNodes(["ch1"])).toEqual([[100, 0]]);
    expect(metersForNodes(["bus.stereo"])).toEqual([
      [104, 0],
      [104, 1],
    ]);
  });

  it("skips unmapped nodes so subscriptions stay scoped to known meters", () => {
    expect(metersForNodes(["out.main", "nope"])).toEqual([]);
    expect(metersForNodes(["ch1", "out.main"])).toEqual([[100, 0]]);
  });

  it("dedupes addresses shared across nodes (mono channels share one meter id)", () => {
    const addrs = metersForNodes(["ch1", "ch2", "ch1"]);
    expect(addrs).toEqual([
      [100, 0],
      [100, 1],
    ]);
  });
});
