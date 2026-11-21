import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../platform", () => ({ vdGet: vi.fn(), vdSet: vi.fn() }));
vi.mock("./settle", () => ({ writeSettle: { mark: () => 0, settle: () => Promise.resolve() } }));

import { vdSet } from "../platform";
import { getModel, MODEL_IDS } from "../../models";
import type { ModelId } from "../../models/types";
import type { AppContext } from "../../../node_modules/urx-lcd-sim/src/app/context";
import {
  hasCell,
  safeColumns,
  safeKeyPath,
  safeOnPath,
  safeRows,
} from "../../../node_modules/urx-lcd-sim/src/screens/recall-safe";
import { unitById } from "../../../node_modules/urx-lcd-sim/src/model/units";
import {
  isRecallSafeUnitPath,
  mergeRecallSafeRead,
  readRecallSafe,
  recallSafeAt,
  recallSafeGlassEdit,
  recallSafeGlassPaths,
  recallSafeGlassValues,
  recallSafeNotifyAddrs,
  safeColumnBits,
  safePartKey,
  withPending,
  withPendingEdit,
  safeOnGlassPaths,
  withRecallSafeNotify,
  writeRecallSafeSelect,
  type SafeRowState,
} from "./recall-safe";
import { recallSafeRows } from "./translate";

const urx44v = getModel("URX44V");
const urx22 = getModel("URX22");

/** Each row as `node [Safe address] [selection address]`. */
const rowsOf = (id: ModelId): string[] =>
  recallSafeRows(getModel(id)).map((r) => `${r.node} ${r.safe}:0:${r.y} ${r.select}:0:${r.y}`);

describe("the RECALL SAFE rows", () => {
  it("pins each URX44V row to the addresses a press on that row moves", () => {
    expect(rowsOf("URX44V")).toEqual([
      "ch1 744:0:0 745:0:0",
      "ch2 744:0:1 745:0:1",
      "ch3 744:0:2 745:0:2",
      "ch4 744:0:3 745:0:3",
      "ch_5_6 746:0:0 747:0:0",
      "ch_7_8 746:0:1 747:0:1",
      "ch_9_10 746:0:2 747:0:2",
      "ch_11_12 746:0:3 747:0:3",
      "bus.fx1 748:0:0 749:0:0",
      "bus.fx2 748:0:1 749:0:1",
      "bus.mix1 754:0:0 755:0:0",
      "bus.mix2 754:0:2 755:0:2",
      "bus.stereo 752:0:0 753:0:0",
      "bus.stream 756:0:0 757:0:0",
    ]);
  });

  it("pins each URX22 row the same way: two mono rows, and the stereo rows from CH 3/4", () => {
    expect(rowsOf("URX22")).toEqual([
      "ch1 744:0:0 745:0:0",
      "ch2 744:0:1 745:0:1",
      "ch_3_4 746:0:0 747:0:0",
      "ch_5_6 746:0:1 747:0:1",
      "ch_7_8 746:0:2 747:0:2",
      "ch_9_10 746:0:3 747:0:3",
      "bus.fx1 748:0:0 749:0:0",
      "bus.fx2 748:0:1 749:0:1",
      "bus.mix1 754:0:0 755:0:0",
      "bus.mix2 754:0:2 755:0:2",
      "bus.stereo 752:0:0 753:0:0",
      "bus.stream 756:0:0 757:0:0",
    ]);
  });

  it("gives the URX44 the URX44V's rows", () => {
    expect(rowsOf("URX44")).toEqual(rowsOf("URX44V"));
  });

  // A row's [All] on the unit selects every column it has: the union of the columns' bits is the
  // value that press leaves, per kind of row.
  it("selects, with every column of a row, the value the row's [All] leaves on the unit", () => {
    const all = (node: string): number => {
      const row = recallSafeRows(urx44v).find((r) => r.node === node)!;
      return safeColumnBits(row.kind).reduce((v, [, bits]) => (v | bits) >>> 0, 0);
    };
    expect(all("ch3")).toBe(0x0ff73fff);
    expect(all("ch_5_6")).toBe(0x1a173fff);
    expect(all("bus.fx1")).toBe(0x100fff);
    expect(all("bus.mix2")).toBe(0x0250000f);
    expect(all("bus.stereo")).toBe(0x02500007);
    expect(all("bus.stream")).toBe(0x20110000);
  });

  it("gives no two columns of a row the same bit", () => {
    for (const row of recallSafeRows(urx44v)) {
      const bits = safeColumnBits(row.kind).map(([, b]) => b);
      for (let i = 0; i < bits.length; i++)
        for (let j = i + 1; j < bits.length; j++) expect(bits[i]! & bits[j]!, `${row.node}`).toBe(0);
    }
  });
});

// The glass's paths come from urx-lcd-sim's own screen: a row it lists that the app does not, or a
// column it draws a button for that the app gives no bits, would be a control the session leaves to
// the glass while the unit holds another value.
describe.each(MODEL_IDS)("the %s RECALL SAFE screen against urx-lcd-sim's", (id) => {
  const model = getModel(id);
  const unit = unitById(id);
  // Every Source selected, so HA is a button wherever the row has one.
  const ctx = { store: { bool: () => true } } as unknown as AppContext;

  it("answers each row's [Safe] and every column a row draws a button for, and nothing else", () => {
    const glass = (["Input", "Output"] as const).flatMap((tab) =>
      safeRows(unit, tab).flatMap((strip) => [
        safeOnPath(strip),
        ...safeColumns(tab)
          .filter((c) => hasCell(ctx, strip, c.key))
          .map((c) => safeKeyPath(strip, c.key)),
      ]),
    );
    expect(recallSafeGlassPaths(model).sort()).toEqual(glass.sort());
  });

  it("names the [Safe] of every row it lists", () => {
    const glass = (["Input", "Output"] as const).flatMap((tab) => safeRows(unit, tab).map(safeOnPath));
    expect(safeOnGlassPaths(model)).toEqual(glass);
  });
});

const NONE: SafeRowState = { safe: false, select: 0 };

describe("the glass's view of a reading", () => {
  it("shows a column selected where every one of its bits is", () => {
    const state = new Map([
      ["ch3", { safe: true, select: 0x100000 }],
      // CH ON's bit and one of Processing's six.
      ["ch4", { safe: false, select: 0x2 | 0x200000 }],
    ]);
    const glass = recallSafeGlassValues(urx44v, state);
    expect(glass.get("safe.ch3.on")).toBe(true);
    expect(glass.get("safe.ch3.name")).toBe(true);
    expect(glass.get("safe.ch3.chOn")).toBe(false);
    expect(glass.get("safe.ch4.on")).toBe(false);
    expect(glass.get("safe.ch4.chOn")).toBe(true);
    expect(glass.get("safe.ch4.processing")).toBe(false);
    // A row the reading does not hold gives the glass nothing.
    expect(glass.has("safe.ch1.on")).toBe(false);
  });

  it("names the FX channels as the glass does", () => {
    const glass = recallSafeGlassValues(urx44v, new Map([["bus.fx2", { safe: true, select: 0x100fff }]]));
    expect(glass.get("safe.fx2.on")).toBe(true);
    expect([...glass.keys()].sort()).toEqual(
      ["safe.fx2.on", "safe.fx2.chLevel", "safe.fx2.chOn", "safe.fx2.toSt", "safe.fx2.toMix", "safe.fx2.name"].sort(),
    );
    expect([...glass.values()].every(Boolean)).toBe(true);
  });
});

describe("an edit on the glass", () => {
  const state = new Map([
    // Bit 30 is no column's: a write keeps it.
    ["ch3", { safe: true, select: 0x40000000 | 0x2 }],
    ["bus.mix1", NONE],
  ]);

  it("names the row and the column's bits, by the kind of row", () => {
    expect(recallSafeGlassEdit(urx44v, state, "safe.ch3.name")).toMatchObject({
      row: { node: "ch3", select: 745, y: 2 },
      bits: 0x100000,
    });
    expect(recallSafeGlassEdit(urx44v, state, "safe.bus.mix1.processing")).toMatchObject({
      row: { node: "bus.mix1", select: 755, y: 0 },
      bits: 0x2400000,
    });
  });

  it("sets or clears the column's bits over the unit's selection, and keeps every other bit of the row", () => {
    const held = state.get("ch3")!.select;
    const name = withPendingEdit(undefined, 0x100000, true);
    expect(withPending(held, name)).toBe(0x40000000 | 0x2 | 0x100000);
    const both = withPendingEdit(name, 0x2, false);
    expect(withPending(held, both)).toBe(0x40000000 | 0x100000);
    // A column chosen again the other way takes back what the first choice laid over the row.
    expect(withPending(held, withPendingEdit(both, 0x100000, false))).toBe(0x40000000);
    expect(withPending(held, withPendingEdit(both, 0x2, true))).toBe(0x40000000 | 0x2 | 0x100000);
    // The unit's selection moved under it: what the glass chose is laid over the newer value.
    expect(withPending(0x8, both)).toBe(0x8 | 0x100000);
    expect(withPending(held, undefined)).toBe(held);
  });

  it("shows what the glass chose and has not written yet over the unit's row", () => {
    const pending = new Map([["ch3", withPendingEdit(undefined, 0x100000, true)]]);
    const glass = recallSafeGlassValues(urx44v, state, pending);
    expect([glass.get("safe.ch3.name"), glass.get("safe.ch3.chOn"), glass.get("safe.ch3.on")]).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("refuses a [Safe], and a row the reading does not hold", () => {
    expect(recallSafeGlassEdit(urx44v, state, "safe.ch3.on")).toBe("refused");
    expect(recallSafeGlassEdit(urx44v, state, "safe.ch1.name")).toBe("refused");
  });

  it("leaves Incoming Sends, the Others tab and a column the row has no button for to the glass", () => {
    for (const path of ["safe.bus.mix1.incoming", "safe.others.fx1", "safe.bus.mix1.source", "safe.ch3.bogus"]) {
      expect(recallSafeGlassEdit(urx44v, state, path), path).toBeNull();
      expect(isRecallSafeUnitPath(urx44v, path), path).toBe(false);
    }
    expect(isRecallSafeUnitPath(urx44v, "safe.ch3.on")).toBe(true);
    expect(isRecallSafeUnitPath(urx44v, "safe.bus.stream.source")).toBe(true);
    // A row only the other model lists.
    expect(isRecallSafeUnitPath(urx22, "safe.ch3.name")).toBe(false);
    expect(isRecallSafeUnitPath(urx22, "safe.ch_3_4.name")).toBe(true);
  });
});

describe("reading and following the unit", () => {
  beforeEach(() => vi.mocked(vdSet).mockReset().mockResolvedValue(undefined));

  it("reads every row's [Safe] and selection", async () => {
    const table = new Map([
      ["744:0:2", 1],
      ["745:0:2", 0x100000],
      ["757:0:0", 0x20000000],
    ]);
    const get = vi.fn((id: number, x: number, y: number) => Promise.resolve(table.get(`${id}:${x}:${y}`) ?? 0));
    const read = await readRecallSafe(urx44v, get);
    expect(read.size).toBe(14);
    expect(read.get("ch3")).toEqual({ safe: true, select: 0x100000 });
    expect(read.get("bus.stream")).toEqual({ safe: false, select: 0x20000000 });
    expect(get).toHaveBeenCalledTimes(28);
  });

  it("registers both addresses of every row and places each notify on its row", () => {
    expect(recallSafeNotifyAddrs(urx22)).toHaveLength(24);
    expect(recallSafeAt(urx22, 747, 0, 0)).toMatchObject({ row: { node: "ch_3_4" }, part: "select" });
    expect(recallSafeAt(urx22, 744, 0, 1)).toMatchObject({ row: { node: "ch2" }, part: "safe" });
    expect(recallSafeAt(urx22, 744, 0, 2)).toBeUndefined();
    expect(recallSafeAt(urx22, 744, 1, 0)).toBeUndefined();
    expect(recallSafeAt(urx22, 750, 0, 0)).toBeUndefined();
  });

  it("takes a notify into the row it names", () => {
    const held = new Map([["ch2", NONE]]);
    const safe = withRecallSafeNotify(held, recallSafeAt(urx22, 744, 0, 1)!, 1);
    expect(safe.get("ch2")).toEqual({ safe: true, select: 0 });
    const select = withRecallSafeNotify(safe, recallSafeAt(urx22, 745, 0, 1)!, 0x100000);
    expect(select.get("ch2")).toEqual({ safe: true, select: 0x100000 });
    // A row not read yet is left to the read.
    expect(withRecallSafeNotify(held, recallSafeAt(urx22, 745, 0, 0)!, 2).has("ch1")).toBe(false);
  });

  it("keeps, over a read, each value that moved while it ran, and takes the read's for the other", () => {
    const held = new Map([
      ["ch1", { safe: true, select: 2 }],
      ["ch2", { safe: true, select: 2 }],
      ["ch3", { safe: true, select: 2 }],
    ]);
    const read = new Map([
      ["ch1", { safe: false, select: 0x100000 }],
      ["ch2", { safe: false, select: 0x100000 }],
      ["ch3", { safe: false, select: 0x100000 }],
    ]);
    const merged = mergeRecallSafeRead(
      held,
      read,
      new Set([safePartKey("ch2", "safe"), safePartKey("ch3", "safe"), safePartKey("ch3", "select")]),
    );
    expect(merged.get("ch1"), "nothing moved: the read's").toEqual({ safe: false, select: 0x100000 });
    expect(merged.get("ch2"), "[Safe] announced: the selection is the read's").toEqual({
      safe: true,
      select: 0x100000,
    });
    expect(merged.get("ch3")).toEqual({ safe: true, select: 2 });
    expect(mergeRecallSafeRead(null, read, new Set([safePartKey("ch2", "safe")]))).toEqual(read);
  });

  it("writes a row's selection at the row's own address", async () => {
    const row = recallSafeRows(urx44v).find((r) => r.node === "bus.mix2")!;
    await writeRecallSafeSelect(row, 0x2);
    expect(vi.mocked(vdSet).mock.calls).toEqual([[755, 0, 2, 0x2]]);
  });
});
