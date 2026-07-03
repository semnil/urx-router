// The MIDI mapping model: which physical control (a MIDI address) drives which
// console control, and how its values are taken in. Mappings are free-form
// (bound by MIDI-learn), keyed by a fixed control id — see controls.ts — so a
// binding works regardless of the console's visible tab. Persisted per model.

/** A physical MIDI control's address. cc14 is the 14-bit CC pair convention:
 *  `controller` (0..31) carries the MSB, `controller + 32` the LSB. */
export type MidiAddr =
  | { type: "cc"; channel: number; controller: number }
  | { type: "cc14"; channel: number; controller: number }
  | { type: "note"; channel: number; note: number }
  | { type: "pitchbend"; channel: number };

// Each vocabulary is one `as const` array: the type, the persistence
// sanitizer, and the UI's option list all derive from it, so adding a value
// is a single edit.

/** How a continuous mapping takes values in (toggles ignore this):
 *  absolute = apply as-is (jumps when the physical control is elsewhere);
 *  pickup = ignore until the physical value reaches/crosses the current one;
 *  relative = the CC value is a signed delta (endless encoders). */
export const TAKE_MODES = ["absolute", "pickup", "relative"] as const;
export type TakeMode = (typeof TAKE_MODES)[number];

/** Relative-CC delta encodings (controller-dependent):
 *  twos = two's complement (1..63 up, 127..65 down);
 *  offset64 = value - 64; signbit = 0..63 up, 64..127 down by (value - 64). */
export const RELATIVE_ENCODINGS = ["twos", "offset64", "signbit"] as const;
export type RelativeEncoding = (typeof RELATIVE_ENCODINGS)[number];

/** Toggle-button behavior (toggle controls only):
 *  edge (default, shown as "Toggle") = flip on a press (note-on / CC rising
 *  edge; a release is ignored);
 *  state (shown as "Momentary") = the value is the state (note on / CC ≥ 64 =
 *  on, else off) — for hold buttons and senders that alternate one message per
 *  press (e.g. Stream Deck toggles). */
export const BUTTON_MODES = ["edge", "state"] as const;
export type ButtonMode = (typeof BUTTON_MODES)[number];

export interface MidiMapping {
  /** The bound console control (controls.ts id, e.g. "ch1/level@bus.mix1"). */
  control: string;
  addr: MidiAddr;
  mode: TakeMode;
  /** Delta encoding, meaningful only when mode = "relative". */
  encoding?: RelativeEncoding;
  /** Toggle behavior, meaningful only on toggle controls. Absent = edge. */
  button?: ButtonMode;
}

/** A stable lookup key for an address (one mapping per physical control). */
export function addrKey(addr: MidiAddr): string {
  switch (addr.type) {
    case "cc":
      return `cc:${addr.channel}:${addr.controller}`;
    case "cc14":
      return `cc14:${addr.channel}:${addr.controller}`;
    case "note":
      return `note:${addr.channel}:${addr.note}`;
    case "pitchbend":
      return `pb:${addr.channel}`;
  }
}

/** Compact human-readable address ("CH 1 CC 7", "CH 2 NOTE 64", "CH 1 PB");
 *  channel shown 1-based like every MIDI utility. Language-invariant. */
export function addrLabel(addr: MidiAddr): string {
  const ch = `CH ${addr.channel + 1}`;
  switch (addr.type) {
    case "cc":
      return `${ch} CC ${addr.controller}`;
    case "cc14":
      return `${ch} CC ${addr.controller}/${addr.controller + 32} (14bit)`;
    case "note":
      return `${ch} NOTE ${addr.note}`;
    case "pitchbend":
      return `${ch} PITCH BEND`;
  }
}

function isChannel(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 15;
}

function isData7(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 127;
}

function oneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

function isAddr(v: unknown): v is MidiAddr {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  if (!isChannel(a.channel)) return false;
  switch (a.type) {
    case "cc":
      return isData7(a.controller);
    case "cc14":
      // MSB controller only; the LSB pair partner (controller + 32) is implied.
      return typeof a.controller === "number" && Number.isInteger(a.controller) && a.controller >= 0 && a.controller < 32;
    case "note":
      return isData7(a.note);
    case "pitchbend":
      return true;
    default:
      return false;
  }
}

/** Validate one persisted mapping (localStorage may hold anything). */
export function isMapping(v: unknown): v is MidiMapping {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  if (typeof m.control !== "string" || !m.control) return false;
  if (!isAddr(m.addr)) return false;
  if (!oneOf(TAKE_MODES, m.mode)) return false;
  if (m.encoding !== undefined && !oneOf(RELATIVE_ENCODINGS, m.encoding)) return false;
  if (m.button !== undefined && !oneOf(BUTTON_MODES, m.button)) return false;
  return true;
}

/** Filter a persisted mapping list down to the valid entries. */
export function sanitizeMappings(v: unknown): MidiMapping[] {
  return Array.isArray(v) ? v.filter(isMapping) : [];
}
