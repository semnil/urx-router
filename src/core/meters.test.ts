import { describe, it, expect } from "vitest";
import {
  decodeMeterDb,
  defaultTapKey,
  hasMeter,
  MeterStore,
  METER_OVER_RAW,
  METER_TOP_DB,
  tapAddrs,
  tapFor,
  tapsFor,
} from "./meters";
import { MODELS, MODEL_IDS } from "../models/index";

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

describe("tap points", () => {
  it("lists a mono channel's full chain in signal order", () => {
    const keys = tapsFor("ch1").map((t) => t.key);
    expect(keys).toEqual(["input", "pregate", "precomp", "preeq", "preinsfx", "prefader", "post"]);
  });

  it("lists INPUT, PRE FADER, PRE DUCKER and POST for a stereo channel", () => {
    expect(tapsFor("ch_5_6").map((t) => t.key)).toEqual(["input", "prefader", "preducker", "post"]);
  });

  it("lists the four output-bus taps in signal order", () => {
    expect(tapsFor("bus.mix1").map((t) => t.key)).toEqual(["preeq", "prefader", "preinsfx", "post"]);
  });

  it("lists PRE FADER and POST for an FX channel", () => {
    expect(tapsFor("bus.fx1").map((t) => t.key)).toEqual(["prefader", "post"]);
  });

  it("gives a single output tap for monitor buses, none for unknown nodes", () => {
    expect(tapsFor("bus.mon1").map((t) => t.key)).toEqual(["post"]);
    expect(tapsFor("nope")).toEqual([]);
  });

  it("defaults to the most downstream tap", () => {
    expect(defaultTapKey("ch1")).toBe("post");
    expect(defaultTapKey("ch_5_6")).toBe("post");
    expect(defaultTapKey("bus.fx1")).toBe("post");
    expect(defaultTapKey("bus.mon1")).toBe("post");
    // An unmapped node has no taps at all; the key still resolves to the "post"
    // convention rather than undefined, so a caller can round-trip it safely.
    expect(defaultTapKey("out.main")).toBe("post");
    expect(defaultTapKey("nope")).toBe("post");
  });

  it("resolves a tap by key and falls back to the last tap for an unknown key", () => {
    expect(tapFor("ch1", "preeq")!.l).toEqual([111, 0]);
    expect(tapFor("ch2", "preeq")!.l).toEqual([111, 1]);
    expect(tapFor("ch1", "bogus")!.l).toEqual([115, 0]); // → default (post)
    expect(tapFor("nope", "post")).toBeUndefined();
  });
});

describe("MeterStore.reading", () => {
  it("returns null for an unmapped node", () => {
    expect(new MeterStore().reading("out.main", "post")).toBeNull();
  });

  it("rests at the silence floor before any reading arrives", () => {
    const r = new MeterStore().reading("ch1", "input")!;
    expect(r.l).toBe(-128);
    expect(r.r).toBe(-128);
    expect(r.overL).toBe(false);
    expect(r.stereo).toBe(false);
  });

  it("reads the address of the selected tap (mono, L mirrored onto R)", () => {
    const store = new MeterStore();
    store.apply({ meterId: 100, x: 0, value: -120 }); // ch1 INPUT
    store.apply({ meterId: 115, x: 0, value: -60 }); // ch1 POST
    expect(store.reading("ch1", "input")!.l).toBe(-12);
    expect(store.reading("ch1", "post")!.l).toBe(-6);
    expect(store.reading("ch1", "input")!.stereo).toBe(false);
  });

  it("decodes independent L/R for a stereo tap and flags OVER per side", () => {
    const store = new MeterStore();
    store.apply({ meterId: 104, x: 0, value: -60 }); // STEREO PRE EQ L
    store.apply({ meterId: 104, x: 1, value: METER_OVER_RAW }); // STEREO PRE EQ R clips
    const r = store.reading("bus.stereo", "preeq")!;
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
    expect(store.reading("ch1", "input")!.l).toBe(-128);
  });
});

describe("tapAddrs", () => {
  it("collects a tap's distinct addresses (mono = one, stereo = L/R)", () => {
    expect(tapAddrs([tapFor("ch1", "input")!])).toEqual([[100, 0]]);
    expect(tapAddrs([tapFor("bus.stereo", "preeq")!])).toEqual([
      [104, 0],
      [104, 1],
    ]);
  });

  it("dedupes addresses shared across taps", () => {
    const t = tapFor("ch1", "input")!;
    expect(tapAddrs([t, t])).toEqual([[100, 0]]);
  });
});

// Every DSP tap point is a distinct hardware meter, so no two (node, tap) pairs may
// share the same broker address [meterId, x]. The address table is dense and hand-laid
// (mono channels share a meterId at distinct x; stereo/bus pairs pack L/R into adjacent
// x), which is exactly where a copy-paste x-offset slip (e.g. giving MIX2 x=0 like MIX1)
// would silently make two strips mirror each other's meter. Pin global uniqueness across
// every metered node in every model so such a slip is caught.
describe("meter address table has no collisions", () => {
  it("maps every (node, tap, side) to a unique broker address", () => {
    const ids = new Set<string>();
    for (const id of MODEL_IDS) for (const n of MODELS[id].nodes) if (hasMeter(n.id)) ids.add(n.id);
    // Guard against an empty scan silently passing.
    expect(ids.size).toBeGreaterThan(10);
    const owner = new Map<string, string>();
    const collisions: string[] = [];
    for (const id of ids) {
      for (const t of tapsFor(id)) {
        for (const a of [t.l, t.r]) {
          if (!a) continue;
          const key = `${a[0]}:${a[1]}`;
          const here = `${id}.${t.key}`;
          if (owner.has(key)) collisions.push(`${key} -> ${owner.get(key)} & ${here}`);
          else owner.set(key, here);
        }
      }
    }
    expect(collisions).toEqual([]);
  });
});
