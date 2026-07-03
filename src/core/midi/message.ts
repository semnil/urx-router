// Raw MIDI byte decoding / encoding. Only the channel-voice messages the mapping
// layer understands are modeled (control change, note on/off, pitch bend); other
// messages decode to null and are ignored. The OS layer resolves running status,
// so every incoming message starts with a status byte.

export interface CcEvent {
  type: "cc";
  channel: number; // 0-based (0..15)
  controller: number; // 0..127
  value: number; // 0..127
}

export interface NoteEvent {
  type: "note";
  channel: number;
  note: number; // 0..127
  on: boolean; // note-on with velocity > 0
}

export interface PitchBendEvent {
  type: "pitchbend";
  channel: number;
  value: number; // 14-bit, 0..16383 (8192 = center)
}

export type MidiEvent = CcEvent | NoteEvent | PitchBendEvent;

/** Decode one raw message; null for anything the mapping layer does not use. */
export function decodeMessage(bytes: number[]): MidiEvent | null {
  if (bytes.length < 3) return null;
  const status = bytes[0] & 0xf0;
  const channel = bytes[0] & 0x0f;
  const d1 = bytes[1] & 0x7f;
  const d2 = bytes[2] & 0x7f;
  switch (status) {
    case 0xb0:
      return { type: "cc", channel, controller: d1, value: d2 };
    case 0x90:
      return { type: "note", channel, note: d1, on: d2 > 0 };
    case 0x80:
      return { type: "note", channel, note: d1, on: false };
    case 0xe0:
      return { type: "pitchbend", channel, value: (d2 << 7) | d1 };
    default:
      return null;
  }
}

export function encodeCc(channel: number, controller: number, value: number): number[] {
  return [0xb0 | (channel & 0x0f), controller & 0x7f, value & 0x7f];
}

export function encodeNote(channel: number, note: number, on: boolean): number[] {
  // Feedback LEDs: note-on velocity 127 lights, an explicit note-off clears.
  return on ? [0x90 | (channel & 0x0f), note & 0x7f, 127] : [0x80 | (channel & 0x0f), note & 0x7f, 0];
}

export function encodePitchBend(channel: number, value: number): number[] {
  const v = Math.max(0, Math.min(16383, value));
  return [0xe0 | (channel & 0x0f), v & 0x7f, (v >> 7) & 0x7f];
}
