import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../../models";
import { decodeLcdSelection, encodeStereoSide, LcdEchoes } from "./lcd-selection";
import { SETTLE_TIMEOUT_MS } from "./settle";

describe("the LCD selection's stereo side", () => {
  const u44v = getModel("URX44V");

  // CH 5/6 L / R are the URX44V's recorded pair; CH 7/8 … 11/12 follow the same numbering.
  it.each([
    ["ch_5_6", "L", 0x0100],
    ["ch_5_6", "R", 0x0101],
    ["ch_7_8", "R", 0x0103],
    ["ch_11_12", "L", 0x0106],
  ] as const)("encodes %s %s as %s and decodes it back", (channel, side, raw) => {
    expect(encodeStereoSide(u44v, channel, side)).toBe(raw);
    expect(decodeLcdSelection(u44v, raw)).toEqual({ channel, side });
  });

  // The URX22's first stereo channel is CH 3/4, at stereo position 0.
  it("numbers a model's stereo channels from its first one", () => {
    expect(encodeStereoSide(getModel("URX22"), "ch_3_4", "R")).toBe(0x0101);
    expect(decodeLcdSelection(getModel("URX22"), 0x0101)).toEqual({ channel: "ch_3_4", side: "R" });
  });

  it("names no side for a mono channel, an FX channel, or a position the model lacks", () => {
    expect(encodeStereoSide(u44v, "ch1", "L")).toBeNull();
    expect(decodeLcdSelection(u44v, 0x0000)).toBeNull();
    expect(decodeLcdSelection(u44v, 0x0300)).toBeNull();
    expect(decodeLcdSelection(u44v, 0x0108)).toBeNull();
  });
});

describe("LcdEchoes", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
  afterEach(() => vi.useRealTimers());

  it("takes a written value once", () => {
    const e = new LcdEchoes();
    e.note(0x0101);
    expect(e.take(0x0100)).toBe(false);
    expect(e.take(0x0101)).toBe(true);
    expect(e.take(0x0101)).toBe(false);
  });

  // Two writes in a row: the older one's answer consumes it, and the newer one stays to be
  // answered. Taking the newer first consumes both, so a late answer to the older one is then a
  // selection made on the unit.
  it("consumes the matched write and every older one", () => {
    const e = new LcdEchoes();
    e.note(0x0101);
    e.note(0x0100);
    expect(e.take(0x0100)).toBe(true);
    expect(e.take(0x0101)).toBe(false);
    e.note(0x0101);
    e.note(0x0100);
    expect(e.take(0x0101)).toBe(true);
    expect(e.take(0x0100)).toBe(true);
  });

  it("lets a write the unit never answered expire", () => {
    const e = new LcdEchoes();
    e.note(0x0101);
    vi.advanceTimersByTime(SETTLE_TIMEOUT_MS + 1);
    expect(e.take(0x0101)).toBe(false);
    e.note(0x0101);
    vi.advanceTimersByTime(SETTLE_TIMEOUT_MS - 1);
    expect(e.take(0x0101), "the positive control: inside the window").toBe(true);
  });

  it("forgets everything on clear", () => {
    const e = new LcdEchoes();
    e.note(0x0101);
    e.clear();
    expect(e.take(0x0101)).toBe(false);
  });
});
