import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../platform", () => ({ vdGet: vi.fn(), vdSet: vi.fn() }));

import { getModel } from "../../models";
import { vdSet } from "../platform";
import { CueEchoes, CueSet, readCues, writeCueFlag } from "./cue";
import { cueAddrOf, cueAddrs, cueAt, cueNotifyAddrs } from "./translate";
import { SETTLE_TIMEOUT_MS, writeSettle } from "./settle";

const V = getModel("URX44V");

describe("cue addresses", () => {
  it("puts every URX44V strip's flag at the address the unit keeps it", () => {
    const at = (node: string): string => {
      const a = cueAddrOf(V, node)!;
      return `${a.param}:${a.y}${a.mirrors.length ? ` +${a.mirrors.join(",")}` : ""} ${a.group}`;
    };
    expect(at("ch1")).toBe("138:0 input");
    expect(at("ch4")).toBe("138:3 input");
    expect(at("ch_5_6")).toBe("265:0 input");
    expect(at("ch_11_12")).toBe("265:3 input");
    expect(at("bus.fx1")).toBe("336:0 input");
    expect(at("bus.fx2")).toBe("336:1 input");
    expect(at("bus.stereo")).toBe("580:0 output");
    expect(at("bus.mix1")).toBe("673:0 +1 output");
    expect(at("bus.mix2")).toBe("673:2 +3 output");
    expect(at("bus.stream")).toBe("709:0 +1 output");
  });

  it("covers the channels, the FX channels and the output group, and nothing else", () => {
    for (const id of ["URX22", "URX44", "URX44V"] as const) {
      const model = getModel(id);
      const channels = model.nodes.filter((n) => n.kind === "channel").map((n) => n.id);
      expect(cueAddrs(model).map((a) => a.node)).toEqual([
        ...channels,
        "bus.fx1",
        "bus.fx2",
        "bus.mix1",
        "bus.mix2",
        "bus.stream",
        "bus.stereo",
      ]);
    }
    expect(cueAddrOf(V, "bus.mon1")).toBeUndefined();
    expect(cueAddrOf(V, "bus.osc")).toBeUndefined();
  });

  it("registers each mirror beside its flag and resolves a notify on either to the strip", () => {
    const keys = cueNotifyAddrs(V).map((a) => a.join(":"));
    expect(keys).toContain("673:0:1");
    expect(keys).toContain("673:0:3");
    expect(keys).toContain("709:0:1");
    expect(keys).not.toContain("580:0:1");
    expect(cueAt(V, 673, 0, 3)).toEqual({ addr: cueAddrOf(V, "bus.mix2"), mirror: true });
    expect(cueAt(V, 673, 0, 2)).toEqual({ addr: cueAddrOf(V, "bus.mix2"), mirror: false });
    expect(cueAt(V, 138, 0, 2)?.addr.node).toBe("ch3");
    expect(cueAt(V, 138, 1, 2)).toBeUndefined();
    expect(cueAt(V, 139, 0, 0)).toBeUndefined();
  });
});

describe("CueSet", () => {
  it("adds cues up within a group", () => {
    const s = new CueSet(V);
    s.apply("bus.fx1", true);
    s.apply("ch1", true);
    s.apply("ch_7_8", true);
    expect(s.nodes()).toEqual(["ch1", "ch_7_8", "bus.fx1"]);
    expect(s.group()).toBe("input");
  });

  it("clears the group in use when a cue in the other group is turned on", () => {
    const s = new CueSet(V);
    s.apply("ch1", true);
    s.apply("bus.fx2", true);
    s.apply("bus.stereo", true);
    expect(s.nodes()).toEqual(["bus.stereo"]);
    expect(s.group()).toBe("output");
    s.apply("bus.mix1", true);
    s.apply("bus.stream", true);
    s.apply("ch2", true);
    expect(s.nodes()).toEqual(["ch2"]);
  });

  it("does not clear the other group on a cue turned off", () => {
    const s = new CueSet(V);
    s.apply("ch1", true);
    expect(s.apply("bus.stereo", false)).toBe(false);
    expect(s.nodes()).toEqual(["ch1"]);
  });

  it("puts back every output cue an input cue cleared once the last input cue is off", () => {
    const s = new CueSet(V);
    s.apply("bus.stereo", true);
    s.apply("bus.mix1", true);
    s.apply("ch1", true);
    expect(s.nodes()).toEqual(["ch1"]);
    s.apply("ch1", false);
    expect(s.nodes()).toEqual(["bus.mix1", "bus.stereo"]);
  });

  it("waits for the LAST input cue before putting the outputs back", () => {
    const s = new CueSet(V);
    s.apply("bus.stereo", true);
    s.apply("ch1", true);
    s.apply("ch2", true);
    s.apply("ch1", false);
    expect(s.nodes()).toEqual(["ch2"]);
    s.apply("ch2", false);
    expect(s.nodes()).toEqual(["bus.stereo"]);
  });

  it("forgets the outputs it would put back once a new output cue is turned on", () => {
    const s = new CueSet(V);
    s.apply("bus.stereo", true);
    s.apply("ch1", true);
    s.apply("bus.mix1", true);
    expect(s.nodes()).toEqual(["bus.mix1"]);
    s.apply("bus.mix1", false);
    expect(s.size).toBe(0);
    // …and an input cue turned on and off afterwards brings nothing back.
    s.apply("ch1", true);
    s.apply("ch1", false);
    expect(s.size).toBe(0);
  });

  it("does not put back an output cue turned off while it was held — the panel's CLEAR CUE", () => {
    // The unit announces the cleared input and the held output, each as 0, in either order.
    for (const order of [
      ["ch1", "bus.stereo"],
      ["bus.stereo", "ch1"],
    ]) {
      const s = new CueSet(V);
      s.apply("bus.stereo", true);
      s.apply("ch1", true);
      for (const n of order) s.apply(n, false);
      expect(s.size, order.join(" then ")).toBe(0);
    }
  });

  it("never puts input cues back", () => {
    const s = new CueSet(V);
    s.apply("ch1", true);
    s.apply("bus.stereo", true);
    s.apply("bus.stereo", false);
    expect(s.size).toBe(0);
  });

  it("keeps the outputs to put back across a read that still finds input cues alone", () => {
    const s = new CueSet(V);
    s.apply("bus.stereo", true);
    s.apply("ch1", true);
    s.replace(["ch1", "ch2"]);
    s.apply("ch1", false);
    s.apply("ch2", false);
    expect(s.nodes()).toEqual(["bus.stereo"]);
    // …and forgets them once a read finds no input cue.
    s.apply("ch1", true);
    expect(s.nodes()).toEqual(["ch1"]);
    s.replace([]);
    s.apply("ch1", true);
    s.apply("ch1", false);
    expect(s.size).toBe(0);
  });

  it("moves a linked pair's partner with the flag it shares", () => {
    const s = new CueSet(V);
    s.apply("ch3", true, "ch4");
    expect(s.nodes()).toEqual(["ch3", "ch4"]);
    s.apply("ch4", false, "ch3");
    expect(s.size).toBe(0);
  });

  it("moves its version only on a change", () => {
    const s = new CueSet(V);
    const v0 = s.version;
    expect(s.apply("ch1", false)).toBe(false);
    expect(s.version).toBe(v0);
    expect(s.apply("ch1", true)).toBe(true);
    expect(s.version).toBe(v0 + 1);
    expect(s.replace(["ch1"])).toBe(false);
    expect(s.version).toBe(v0 + 1);
    expect(s.clear()).toBe(true);
    expect(s.version).toBe(v0 + 2);
  });

  it("drops a node the model cannot cue", () => {
    const s = new CueSet(V);
    s.replace(["bus.mon1", "ch2", "nope"]);
    expect(s.nodes()).toEqual(["ch2"]);
    expect(s.apply("bus.mon1", true)).toBe(false);
  });
});

describe("CueEchoes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("takes a written value once, per address", () => {
    const e = new CueEchoes();
    e.note(138, 0, 1);
    expect(e.take(138, 1, 1)).toBe(false);
    expect(e.take(138, 0, 0)).toBe(false);
    expect(e.take(138, 0, 1)).toBe(true);
    expect(e.take(138, 0, 1)).toBe(false);
  });

  it("forgets a write the unit never announced", () => {
    const e = new CueEchoes();
    e.note(580, 0, 1);
    vi.advanceTimersByTime(SETTLE_TIMEOUT_MS + 1);
    expect(e.take(580, 0, 1)).toBe(false);
  });
});

describe("readCues", () => {
  it("reads each flag once, at its own address, and answers the strips holding 1", async () => {
    const asked: string[] = [];
    const held = new Set(["138:0", "265:1", "673:2"]);
    const got = await readCues(V, async (p, x, y) => {
      asked.push(`${p}:${x}:${y}`);
      return held.has(`${p}:${y}`) ? 1 : 0;
    });
    expect(got).toEqual(["ch1", "ch_7_8", "bus.mix2"]);
    expect(asked).toEqual(cueAddrs(V).map((a) => `${a.param}:0:${a.y}`));
  });

  it("rejects when a read fails", async () => {
    await expect(
      readCues(V, async (p) => {
        if (p === 580) throw new Error("boom");
        return 0;
      }),
    ).rejects.toThrow("boom");
  });
});

// The unit acks a write before the flag is readable and announces it once it is; the flags it
// clears or puts back with the write are readable by then too. A read behind the write must
// therefore wait for that announcement, and the write's promise is what it waits on.
describe("writeCueFlag", () => {
  const stereo = cueAddrOf(V, "bus.stereo")!;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(vdSet).mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(vdSet).mockReset();
  });

  async function pending(p: Promise<void>): Promise<() => boolean> {
    let done = false;
    void p.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    return () => done;
  }

  it("resolves once the unit announces the written flag, not when the write is acked", async () => {
    const done = await pending(writeCueFlag(stereo, false));
    expect(vdSet).toHaveBeenCalledWith(580, 0, 0, 0);
    expect(done()).toBe(false);
    writeSettle.note({ paramId: 580, x: 0, y: 0, value: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(done()).toBe(true);
  });

  it("is not ended by an announcement from before the write", async () => {
    writeSettle.note({ paramId: 580, x: 0, y: 0, value: 0 });
    const done = await pending(writeCueFlag(stereo, false));
    expect(done()).toBe(false);
    await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS);
    expect(done()).toBe(true);
  });

  it("resolves at the settle window when nothing is announced", async () => {
    const done = await pending(writeCueFlag(stereo, true));
    await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS - 1);
    expect(done()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done()).toBe(true);
  });
});
