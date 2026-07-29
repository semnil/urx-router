import { describe, it, expect, vi, afterEach } from "vitest";
import * as platform from "./platform";
import {
  decodeGrDb,
  decodeMeterDb,
  defaultTapKey,
  gateGrAddr,
  GR_FLOOR_DB,
  hasMeter,
  MeterStore,
  METER_OVER_RAW,
  METER_TOP_DB,
  subscribeMeters,
  tapAddrs,
  tapFor,
  tapsFor,
} from "./meters";
import { MODELS, MODEL_IDS } from "../models/index";

afterEach(() => vi.restoreAllMocks());

// MeterStore.reading() was removed (no production consumer — console.ts reads via
// readingTap). These pins exercise the same decode path through the public
// readingTap + tapFor pair.
const reading = (store: MeterStore, nodeId: string, tapKey: string, modelId?: string) =>
  store.readingTap(tapFor(nodeId, tapKey, modelId) ?? null);

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

describe("GATE gain-reduction meter", () => {
  it("maps mono channels only, on the mono channel axis", () => {
    expect(gateGrAddr("ch1")).toEqual([107, 0]);
    expect(gateGrAddr("ch4")).toEqual([107, 3]);
    // GATE is a MONO IN feature: no stereo channel, bus or output has one.
    expect(gateGrAddr("ch_5_6")).toBeUndefined();
    expect(gateGrAddr("bus.stereo")).toBeUndefined();
    expect(gateGrAddr("out.main")).toBeUndefined();
  });

  it("stops at CH1-2 on URX22", () => {
    expect(gateGrAddr("ch1", "URX22")).toEqual([107, 0]);
    expect(gateGrAddr("ch2", "URX22")).toEqual([107, 1]);
    expect(gateGrAddr("ch3", "URX22")).toBeUndefined();
  });

  it("stays off the level chain, so the meter-point selector never offers it", () => {
    const addrs = tapAddrs(tapsFor("ch1")).map(([id]) => id);
    expect(addrs).not.toContain(107);
  });

  it("reads both idle values as no reduction", () => {
    // Measured on a URX44V: the gate reports 0 while switched off and the OVER
    // sentinel while switched on and open. Neither is a reduction, and neither
    // may raise a clip flag.
    expect(decodeGrDb(0)).toBe(0);
    expect(decodeGrDb(METER_OVER_RAW)).toBe(0);
  });

  it("scales a reduction by 1/10 and clamps at the floor", () => {
    expect(decodeGrDb(-239)).toBeCloseTo(-23.9);
    expect(decodeGrDb(-1280)).toBe(GR_FLOOR_DB);
    expect(decodeGrDb(-5000)).toBe(GR_FLOOR_DB);
  });

  it("reports null until the address has reported, then the reduction", () => {
    const store = new MeterStore();
    // A just-subscribed stream is not "0 dB of reduction" — that would read as a
    // gate passing everything.
    expect(store.readGr(gateGrAddr("ch1"))).toBeNull();
    store.apply({ meterId: 107, x: 0, value: -239 });
    expect(store.readGr(gateGrAddr("ch1"))).toBeCloseTo(-23.9);
    expect(store.readGr(gateGrAddr("ch2"))).toBeNull();
  });

  it("reports null for a node with no gate", () => {
    expect(new MeterStore().readGr(gateGrAddr("bus.stereo"))).toBeNull();
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

  it("lists INPUT, PRE FADER, PRE DUCKER and POST for a stereo channel (URX22)", () => {
    expect(tapsFor("ch_3_4", "URX22").map((t) => t.key)).toEqual(["input", "prefader", "preducker", "post"]);
    expect(tapsFor("ch_5_6", "URX22").map((t) => t.key)).toEqual(["input", "prefader", "preducker", "post"]);
  });

  it("lists INPUT, PRE FADER, PRE DUCKER and POST for a stereo channel (URX44/URX44V)", () => {
    expect(tapsFor("ch_5_6", "URX44").map((t) => t.key)).toEqual(["input", "prefader", "preducker", "post"]);
    expect(tapsFor("ch_5_6", "URX44V").map((t) => t.key)).toEqual(["input", "prefader", "preducker", "post"]);
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

  it("resolves a tap by key for URX22", () => {
    expect(tapFor("ch_3_4", "input", "URX22")!.l).toEqual([101, 0]);
    expect(tapFor("ch_3_4", "input", "URX22")!.r).toEqual([101, 1]);
    expect(tapFor("ch_5_6", "input", "URX22")!.l).toEqual([101, 2]);
    expect(tapFor("ch_5_6", "input", "URX22")!.r).toEqual([101, 3]);
  });

  it("resolves a tap by key for URX44/URX44V", () => {
    expect(tapFor("ch_5_6", "input", "URX44")!.l).toEqual([101, 0]);
    expect(tapFor("ch_5_6", "input", "URX44")!.r).toEqual([101, 1]);
    expect(tapFor("ch_5_6", "input", "URX44V")!.l).toEqual([101, 0]);
    expect(tapFor("ch_5_6", "input", "URX44V")!.r).toEqual([101, 1]);
  });
});

describe("MeterStore reading (readingTap + tapFor)", () => {
  it("returns null for an unmapped node", () => {
    expect(reading(new MeterStore(), "out.main", "post")).toBeNull();
  });

  it("returns null before any reading arrives (no stream yet is not silence)", () => {
    expect(reading(new MeterStore(), "ch1", "input")).toBeNull();
    expect(reading(new MeterStore(), "bus.stereo", "preeq")).toBeNull();
  });

  it("rests the missing side of a stereo tap at the silence floor", () => {
    const store = new MeterStore();
    store.apply({ meterId: 104, x: 0, value: -60 }); // STEREO PRE EQ L only
    const r = reading(store, "bus.stereo", "preeq")!;
    expect(r.l).toBe(-6);
    expect(r.r).toBe(-128);
    expect(r.stereo).toBe(true);
  });

  it("reads the address of the selected tap (mono, L mirrored onto R)", () => {
    const store = new MeterStore();
    store.apply({ meterId: 100, x: 0, value: -120 }); // ch1 INPUT
    store.apply({ meterId: 115, x: 0, value: -60 }); // ch1 POST
    expect(reading(store, "ch1", "input")!.l).toBe(-12);
    expect(reading(store, "ch1", "post")!.l).toBe(-6);
    expect(reading(store, "ch1", "input")!.stereo).toBe(false);
  });

  it("decodes independent L/R for a stereo tap and flags OVER per side", () => {
    const store = new MeterStore();
    store.apply({ meterId: 104, x: 0, value: -60 }); // STEREO PRE EQ L
    store.apply({ meterId: 104, x: 1, value: METER_OVER_RAW }); // STEREO PRE EQ R clips
    const r = reading(store, "bus.stereo", "preeq")!;
    expect(r.l).toBe(-6);
    expect(r.r).toBe(METER_TOP_DB);
    expect(r.overL).toBe(false);
    expect(r.overR).toBe(true);
    expect(r.stereo).toBe(true);
  });

  it("clear() drops every reading back to no-stream", () => {
    const store = new MeterStore();
    store.apply({ meterId: 100, x: 0, value: 0 });
    store.clear();
    expect(reading(store, "ch1", "input")).toBeNull();
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
  it("maps every (node, tap, side) to a unique broker address within each model", () => {
    for (const modelId of MODEL_IDS) {
      const owner = new Map<string, string>();
      const collisions: string[] = [];
      for (const n of MODELS[modelId].nodes) {
        if (!hasMeter(n.id, modelId)) continue;
        for (const t of tapsFor(n.id, modelId)) {
          for (const a of [t.l, t.r]) {
            if (!a) continue;
            const key = `${a[0]}:${a[1]}`;
            const here = `${n.id}.${t.key}`;
            if (owner.has(key)) collisions.push(`[${modelId}] ${key} -> ${owner.get(key)} & ${here}`);
            else owner.set(key, here);
          }
        }
      }
      expect(owner.size, modelId).toBeGreaterThan(10);
      expect(collisions).toEqual([]);
    }
  });
});

describe("meter subscription ownership", () => {
  // The broker has one registration process-wide and its unsubscribe takes no
  // address, so a handle held past a takeover would cancel the new owner's stream.
  it("ignores a release from a superseded subscription", async () => {
    const calls: string[] = [];
    vi.spyOn(platform, "vdMetersSubscribe").mockImplementation((addrs) => {
      const tag = addrs.map((a) => a.join(":")).join(",");
      calls.push(`sub ${tag}`);
      return Promise.resolve(() => calls.push(`unsub ${tag}`));
    });

    const first = new MeterStore();
    const second = new MeterStore();
    const releaseFirst = await subscribeMeters(first, [[106, 0]]);
    const releaseSecond = await subscribeMeters(second, [[107, 0]]);

    releaseFirst(); // the displaced consumer catching up — must not cancel #2
    expect(calls).toEqual(["sub 106:0", "sub 107:0"]);

    releaseSecond();
    expect(calls).toEqual(["sub 106:0", "sub 107:0", "unsub 107:0"]);
  });

  it("drops frames from a superseded subscription", async () => {
    let deliver: ((m: { meterId: number; x: number; value: number }) => void) | null = null;
    vi.spyOn(platform, "vdMetersSubscribe").mockImplementation((_addrs, onUpdate) => {
      deliver = onUpdate;
      return Promise.resolve(() => {});
    });

    const stale = new MeterStore();
    await subscribeMeters(stale, [[106, 0]]);
    const staleDeliver = deliver!;
    await subscribeMeters(new MeterStore(), [[107, 0]]);

    // A frame still in flight for the old registration reaches its callback.
    staleDeliver({ meterId: 106, x: 0, value: -200 });
    expect(stale.readingTap({ key: "pregate", label: "PRE GATE", l: [106, 0] })).toBeNull();
  });
});
