import { describe, it, expect } from "vitest";
import { decodeMessage, encodeCc, encodeNote, encodePitchBend } from "./message";

describe("MIDI message decode", () => {
  it("decodes control change with channel and 7-bit data", () => {
    expect(decodeMessage([0xb0, 7, 100])).toEqual({ type: "cc", channel: 0, controller: 7, value: 100 });
    expect(decodeMessage([0xbf, 127, 0])).toEqual({ type: "cc", channel: 15, controller: 127, value: 0 });
  });

  it("decodes note on/off, treating velocity 0 as off", () => {
    expect(decodeMessage([0x90, 60, 127])).toEqual({ type: "note", channel: 0, note: 60, on: true });
    expect(decodeMessage([0x90, 60, 0])).toEqual({ type: "note", channel: 0, note: 60, on: false });
    expect(decodeMessage([0x82, 60, 64])).toEqual({ type: "note", channel: 2, note: 60, on: false });
  });

  it("decodes pitch bend as a 14-bit value (LSB first)", () => {
    expect(decodeMessage([0xe0, 0x00, 0x40])).toEqual({ type: "pitchbend", channel: 0, value: 8192 });
    expect(decodeMessage([0xe1, 0x7f, 0x7f])).toEqual({ type: "pitchbend", channel: 1, value: 16383 });
  });

  it("ignores other and truncated messages", () => {
    expect(decodeMessage([0xc0, 5, 0])).toBeNull(); // program change
    expect(decodeMessage([0xf8])).toBeNull(); // clock
    expect(decodeMessage([0xb0, 7])).toBeNull(); // truncated
    expect(decodeMessage([])).toBeNull(); // empty
    expect(decodeMessage([0x90, 60])).toBeNull(); // 2-byte note (needs a status + 2 data)
  });

  it("treats any note-on velocity > 0 as on and masks out-of-range data bytes", () => {
    expect(decodeMessage([0x90, 60, 1])).toEqual({ type: "note", channel: 0, note: 60, on: true }); // velocity 1 = on
    expect(decodeMessage([0x80, 60, 127])).toEqual({ type: "note", channel: 0, note: 60, on: false }); // note-off velocity ignored
    // The status high nibble selects the message; data bytes are masked to 7 bits.
    expect(decodeMessage([0xb0, 0x80, 0xff])).toEqual({ type: "cc", channel: 0, controller: 0, value: 127 });
  });

  it("masks data bytes to 7 bits on encode", () => {
    expect(encodeCc(0, 7, 127)).toEqual([0xb0, 7, 127]);
    expect(encodeNote(1, 60, true)).toEqual([0x91, 60, 127]);
    expect(encodeNote(1, 60, false)).toEqual([0x81, 60, 0]);
    expect(encodePitchBend(0, 16383)).toEqual([0xe0, 0x7f, 0x7f]);
    expect(encodePitchBend(0, 20000)).toEqual([0xe0, 0x7f, 0x7f]); // clamped
  });

  it("masks the channel nibble and splits pitch bend LSB-first", () => {
    expect(encodeCc(16, 7, 10)).toEqual([0xb0, 7, 10]); // channel 16 wraps to 0
    expect(encodeCc(0, 128, 10)).toEqual([0xb0, 0, 10]); // controller masked
    expect(encodePitchBend(0, 8192)).toEqual([0xe0, 0, 0x40]); // center = MSB 0x40, LSB 0
    expect(encodePitchBend(0, -5)).toEqual([0xe0, 0, 0]); // clamped low
  });

  it("round-trips encode → decode", () => {
    expect(decodeMessage(encodeCc(3, 10, 64))).toEqual({ type: "cc", channel: 3, controller: 10, value: 64 });
    expect(decodeMessage(encodePitchBend(2, 12345))).toEqual({ type: "pitchbend", channel: 2, value: 12345 });
  });
});
