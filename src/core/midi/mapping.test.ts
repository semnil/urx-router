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

  it("accepts the address boundary values and rejects the out-of-range neighbours", () => {
    const boundary: MidiMapping[] = [
      { control: "a", addr: { type: "cc14", channel: 0, controller: 0 }, mode: "absolute" }, // MSB 0 ok
      { control: "b", addr: { type: "cc14", channel: 0, controller: 31 }, mode: "absolute" }, // MSB 31 ok (LSB 63)
      { control: "c", addr: { type: "cc", channel: 15, controller: 127 }, mode: "absolute" }, // top of the 7-bit range
      { control: "d", addr: { type: "note", channel: 0, note: 127 }, mode: "absolute" },
      { control: "e", addr: { type: "pitchbend", channel: 0 }, mode: "absolute" },
    ];
    const outOfRange = [
      { control: "x", addr: { type: "cc14", channel: 0, controller: -1 }, mode: "absolute" }, // MSB below 0
      { control: "x", addr: { type: "note", channel: 0, note: 128 }, mode: "absolute" }, // note above 127
      { control: "x", addr: { type: "cc", channel: -1, controller: 7 }, mode: "absolute" }, // channel below 0
      { control: "x", addr: { type: "cc", channel: 0.5, controller: 7 }, mode: "absolute" }, // non-integer channel
      { control: "x", addr: { type: "pitchbend", channel: 16 }, mode: "absolute" }, // channel above 15
    ];
    expect(sanitizeMappings([...boundary, ...outOfRange])).toEqual(boundary);
  });

  it("drops non-object entries and keeps a button flag on any control", () => {
    // localStorage may hold scalars / holes between valid entries.
    const mixed = [
      "junk",
      42,
      undefined,
      { control: "ch1/eqOn", addr: { type: "note", channel: 0, note: 60 }, mode: "absolute", button: "edge" },
    ];
    // The button flag is validated without knowing the control kind (it is inert on
    // continuous controls), so a persisted button survives sanitization.
    expect(sanitizeMappings(mixed)).toEqual([
      { control: "ch1/eqOn", addr: { type: "note", channel: 0, note: 60 }, mode: "absolute", button: "edge" },
    ]);
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

  it("renames the STEREO / MONITOR power LED from the old mute id to chOn", () => {
    const persisted = [
      { control: "bus.stereo/mute", addr: { type: "note", channel: 0, note: 60 }, mode: "absolute" },
      { control: "bus.mon1/mute", addr: { type: "note", channel: 0, note: 61 }, mode: "absolute" },
      { control: "bus.mon2/mute", addr: { type: "note", channel: 0, note: 62 }, mode: "absolute" }, // MON 2 renames too
      { control: "ch1/mute", addr: { type: "note", channel: 0, note: 63 }, mode: "absolute" }, // the → STEREO send: unchanged
      { control: "bus.mix1/mute", addr: { type: "note", channel: 0, note: 64 }, mode: "absolute" }, // the TO ST send: unchanged
      { control: "ch1/mute@bus.mix1", addr: { type: "note", channel: 0, note: 65 }, mode: "absolute" }, // send-scoped mute: unchanged
    ];
    expect(sanitizeMappings(persisted).map((m) => m.control)).toEqual([
      "bus.stereo/chOn",
      "bus.mon1/chOn",
      "bus.mon2/chOn",
      "ch1/mute",
      "bus.mix1/mute",
      "ch1/mute@bus.mix1",
    ]);
  });

  it("applies the relative→absolute and mute→chOn migrations together in one entry", () => {
    const persisted = [
      {
        control: "bus.stereo/mute",
        addr: { type: "cc", channel: 0, controller: 7 },
        mode: "relative",
        encoding: "twos",
      },
    ];
    expect(sanitizeMappings(persisted)).toEqual([
      { control: "bus.stereo/chOn", addr: { type: "cc", channel: 0, controller: 7 }, mode: "absolute" },
    ]);
  });
});
