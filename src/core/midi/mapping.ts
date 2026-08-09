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
 *  pickup = ignore until the physical value reaches/crosses the current one. */
export const TAKE_MODES = ["absolute", "pickup"] as const;
export type TakeMode = (typeof TAKE_MODES)[number];

/** Toggle-button behavior (toggle controls only), named after the sender's
 *  button type:
 *  edge (default, shown as "Momentary") = flip on each on-value (note-on / CC
 *  ≥ 64); the release is ignored — for push / momentary buttons;
 *  state (shown as "Toggle") = the value is the state (note on / CC ≥ 64 = on,
 *  else off) — for toggle buttons that alternate one message per press
 *  (e.g. Stream Deck toggles). */
export const BUTTON_MODES = ["edge", "state"] as const;
export type ButtonMode = (typeof BUTTON_MODES)[number];

export interface MidiMapping {
  /** The bound console control (controls.ts id, e.g. "ch1/level@bus.mix1"). */
  control: string;
  addr: MidiAddr;
  mode: TakeMode;
  /** Toggle behavior, meaningful only on toggle controls. Absent = edge. */
  button?: ButtonMode;
}

/** A stable lookup key for an address. Several mappings may share one (a gang:
 *  one physical control driving several console controls). */
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

/**
 * The wire's resolution for an address: how many steps a value crosses on its way
 * out. 7 bits for a CC or a note, 14 for a pair or a pitch bend.
 *
 * This is what decides whether a feedback echo can be an EDIT at all. A value that
 * left at 7 bits comes back decoded onto a neighbouring detent whenever the plan's
 * own grid is finer than 128 steps, so the engine guards those addresses; at 14 bits
 * every control round-trips onto the value it started from (measured over all three
 * models, pinned in controls.test.ts), so their echo cannot change anything.
 */
export function wireSteps(addr: MidiAddr): number {
  return addr.type === "cc14" || addr.type === "pitchbend" ? 16383 : 127;
}

/**
 * What actually goes on the wire for an address, from a normalized value.
 *
 * A note address carries on/off and nothing else, so its wire value is the byte a
 * press would send rather than the encoded position — which is what makes the sent
 * cache comparable with an incoming message on the same address, and what keeps the
 * feedback diff from re-emitting a byte-identical note-on every time a fader bound to
 * a note moves without crossing the halfway point.
 */
export function wireRaw(addr: MidiAddr, value: number): number {
  const v = Math.max(0, Math.min(1, value));
  return addr.type === "note" ? (v >= 0.5 ? 127 : 0) : Math.round(v * wireSteps(addr));
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

/** The address at tooltip / badge length. `addrLabel` is the assignment list's full
 *  form; this is what fits beside a control, so the 14-bit pair is written as one
 *  token rather than spelled out. Language-invariant, like its long form. */
export function addrShort(addr: MidiAddr): string {
  const ch = `CH ${addr.channel + 1}`;
  switch (addr.type) {
    case "cc":
      return `${ch} CC ${addr.controller}`;
    case "cc14":
      return `${ch} CC ${addr.controller}+${addr.controller + 32}`;
    case "note":
      return `${ch} NOTE ${addr.note}`;
    case "pitchbend":
      return `${ch} PB`;
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
      return (
        typeof a.controller === "number" && Number.isInteger(a.controller) && a.controller >= 0 && a.controller < 32
      );
    case "note":
      return isData7(a.note);
    case "pitchbend":
      return true;
    default:
      return false;
  }
}

/** Validate one persisted mapping (localStorage may hold anything). */
function isMapping(v: unknown): v is MidiMapping {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  if (typeof m.control !== "string" || !m.control) return false;
  if (!isAddr(m.addr)) return false;
  if (!oneOf(TAKE_MODES, m.mode)) return false;
  if (m.button !== undefined && !oneOf(BUTTON_MODES, m.button)) return false;
  return true;
}

// The STEREO / MONITOR power LED moved off the send-less "mute" (nodeMute, MUTE
// polarity) onto the uniform "chOn" (nodeOn, ON polarity), so rename those persisted
// assignments to keep the binding — the physical control still toggles the same
// master; only the LED-feedback / state-sender polarity flips to match the console.
const LED_MASTER_NODES = new Set(["bus.stereo", "bus.mon1", "bus.mon2"]);
function migrateControl(control: unknown): unknown {
  if (typeof control !== "string") return control;
  const slash = control.indexOf("/");
  const node = slash < 0 ? "" : control.slice(0, slash);
  return control.slice(slash + 1) === "mute" && LED_MASTER_NODES.has(node) ? node + "/chOn" : control;
}

// Migrate a persisted entry from the removed "relative" take-in mode (endless-
// encoder deltas): coerce it to absolute so the binding survives — which is
// also what those controllers were sending all along — and drop the now-unused
// delta encoding field. Also rename the STEREO / MONITOR power-LED control (above).
function coerceLegacy(v: unknown): unknown {
  if (typeof v !== "object" || v === null) return v;
  const { encoding: _drop, ...rest } = v as Record<string, unknown>;
  rest.control = migrateControl(rest.control);
  return rest.mode === "relative" ? { ...rest, mode: "absolute" } : rest;
}

/** Filter a persisted mapping list down to the valid entries. */
export function sanitizeMappings(v: unknown): MidiMapping[] {
  return Array.isArray(v) ? v.map(coerceLegacy).filter(isMapping) : [];
}
