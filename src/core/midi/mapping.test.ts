import { describe, it, expect } from "vitest";
import { addrKey, addrLabel, sanitizeMappings, type MidiMapping } from "./mapping";

describe("MIDI mapping model", () => {
  it("keys each address kind distinctly", () => {
    expect(addrKey({ type: "cc", channel: 0, controller: 7 })).toBe("cc:0:7");
    expect(addrKey({ type: "cc14", channel: 0, controller: 7 })).toBe("cc14:0:7");
    expect(addrKey({ type: "note", channel: 2, note: 60 })).toBe("note:2:60");
    expect(addrKey({ type: "pitchbend", channel: 3 })).toBe("pb:3");
  });

  it("labels addresses with 1-based channels", () => {
    expect(addrLabel({ type: "cc", channel: 0, controller: 7 })).toBe("CH 1 CC 7");
    expect(addrLabel({ type: "cc14", channel: 1, controller: 7 })).toBe("CH 2 CC 7/39 (14bit)");
    expect(addrLabel({ type: "note", channel: 15, note: 64 })).toBe("CH 16 NOTE 64");
    expect(addrLabel({ type: "pitchbend", channel: 0 })).toBe("CH 1 PITCH BEND");
  });

  it("keeps valid persisted mappings and drops broken ones", () => {
    const good: MidiMapping[] = [
      { control: "ch1/level", addr: { type: "cc", channel: 0, controller: 7 }, mode: "absolute" },
      { control: "ch1/level@bus.mix1", addr: { type: "cc14", channel: 0, controller: 1 }, mode: "pickup" },
      { control: "ch1/mute", addr: { type: "cc", channel: 0, controller: 20 }, mode: "absolute", button: "state" },
    ];
    const bad = [
      null,
      {},
      { control: "", addr: { type: "cc", channel: 0, controller: 7 }, mode: "absolute" },
      { control: "x", addr: { type: "cc", channel: 16, controller: 7 }, mode: "absolute" }, // channel out of range
      { control: "x", addr: { type: "cc", channel: 0, controller: 128 }, mode: "absolute" }, // data out of range
      { control: "x", addr: { type: "cc14", channel: 0, controller: 32 }, mode: "absolute" }, // cc14 MSB must be < 32
      { control: "x", addr: { type: "cc", channel: 0, controller: 7 }, mode: "sticky" }, // unknown mode
      { control: "x", addr: { type: "cc", channel: 0, controller: 7 }, mode: "absolute", button: "latch" }, // unknown button mode
    ];
    expect(sanitizeMappings([...good, ...bad])).toEqual(good);
    expect(sanitizeMappings("not a list")).toEqual([]);
  });

  it("migrates the removed relative mode to absolute and drops its encoding", () => {
    const persisted = [
      { control: "ch1/gain", addr: { type: "cc", channel: 0, controller: 10 }, mode: "relative", encoding: "twos" },
      { control: "ch2/level", addr: { type: "cc", channel: 0, controller: 11 }, mode: "pickup", encoding: "offset64" },
    ];
    expect(sanitizeMappings(persisted)).toEqual([
      { control: "ch1/gain", addr: { type: "cc", channel: 0, controller: 10 }, mode: "absolute" },
      { control: "ch2/level", addr: { type: "cc", channel: 0, controller: 11 }, mode: "pickup" },
    ]);
  });
});
