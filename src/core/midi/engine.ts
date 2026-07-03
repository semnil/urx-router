// The MIDI mapping engine: routes decoded MIDI events onto bound console
// controls (with per-mapping take-in modes), runs the MIDI-learn state machine,
// and produces controller feedback (motor faders / LEDs following the plan).
// Pure logic — ports, persistence and timers live in the UI layer; the clock is
// injected so tests drive time explicitly.

import { decodeMessage, encodeCc, encodeNote, encodePitchBend, type CcEvent, type MidiEvent } from "./message";
import { addrKey, type MidiAddr, type MidiMapping, type RelativeEncoding } from "./mapping";
import type { BoundControl } from "./controls";

export interface EngineHooks {
  /** Resolve a mapping's control id against the current model + plan. */
  resolve(id: string): BoundControl | null;
  /** An incoming message changed the plan through `control` (mirror + repaint). */
  applied(control: BoundControl): void;
  /** Send feedback bytes out (caller no-ops when no output port is open). */
  send(bytes: number[]): void;
  /** MIDI-learn resolved an address. */
  learned(addr: MidiAddr): void;
  /** A learn candidate is pending (a CC waits for a quiet gap / its 14-bit pair
   *  partner); the caller should schedule flushLearn() after a short delay. */
  learnPending(): void;
  /** Clock in ms (performance.now in the app; scripted in tests). */
  now(): number;
}

// Pickup engages when the physical value lands within this normalized distance
// of the plan value (≈ 2 steps of a 7-bit controller), or crosses it.
const PICKUP_EPS = 2 / 127;

// Feedback for an address is deferred while messages are still arriving from it,
// so a snapped echo never fights an in-progress sweep; the settled value goes
// out on the next pass after this quiet gap.
const RECENT_MS = 300;

interface PickupState {
  engaged: boolean;
  lastIn: number | null;
}

export class MidiEngine {
  private mappings: MidiMapping[] = [];
  private byKey = new Map<string, MidiMapping[]>();
  private pickup = new Map<string, PickupState>();
  private pair = new Map<string, { msb: number; lsb: number }>(); // cc14 assembly
  private lastCc = new Map<string, number>(); // last CC value per mapping (toggle edge)
  private lastSent = new Map<string, number>(); // last raw value fed back per address
  private lastRecv = new Map<string, number>(); // last receive time per address
  private learn: { pendingCc: CcEvent | null } | null = null;

  constructor(private hooks: EngineHooks) {}

  getMappings(): MidiMapping[] {
    return this.mappings;
  }

  /** Replace the mapping set (load / learn / edit / remove / model switch). */
  setMappings(next: MidiMapping[]): void {
    this.mappings = next;
    this.byKey.clear();
    for (const m of next) {
      const key = addrKey(m.addr);
      const list = this.byKey.get(key);
      if (list) list.push(m);
      else this.byKey.set(key, [m]);
    }
    // Reset per-mapping state: stale pickup/edge/pair state must not leak across sets.
    this.pickup.clear();
    this.lastCc.clear();
    this.pair.clear();
  }

  isMapped(controlId: string): boolean {
    return this.mappings.some((m) => m.control === controlId);
  }

  // ---- learn ----

  startLearn(): void {
    this.learn = { pendingCc: null };
  }

  cancelLearn(): void {
    this.learn = null;
  }

  isLearning(): boolean {
    return this.learn !== null;
  }

  /** Commit a pending single-CC learn candidate (called after a quiet gap, so a
   *  lone button CC still binds even though no second message ever arrives). */
  flushLearn(): void {
    const pending = this.learn?.pendingCc;
    if (!pending) return;
    this.finishLearn({ type: "cc", channel: pending.channel, controller: pending.controller });
  }

  private finishLearn(addr: MidiAddr): void {
    this.learn = null;
    this.hooks.learned(addr);
  }

  // A CC stream needs disambiguation: the same controller twice = a plain 7-bit
  // CC; its 14-bit pair partner (MSB n / LSB n+32, either order) = one cc14
  // control; anything else replaces the candidate (the user switched knobs).
  private feedLearn(ev: MidiEvent): void {
    if (ev.type === "note") {
      if (ev.on) this.finishLearn({ type: "note", channel: ev.channel, note: ev.note });
      return;
    }
    if (ev.type === "pitchbend") {
      this.finishLearn({ type: "pitchbend", channel: ev.channel });
      return;
    }
    const pending = this.learn!.pendingCc;
    if (pending && pending.channel === ev.channel) {
      if (pending.controller < 32 && ev.controller === pending.controller + 32) {
        this.finishLearn({ type: "cc14", channel: ev.channel, controller: pending.controller });
        return;
      }
      if (ev.controller < 32 && pending.controller === ev.controller + 32) {
        this.finishLearn({ type: "cc14", channel: ev.channel, controller: ev.controller });
        return;
      }
      if (ev.controller === pending.controller) {
        this.finishLearn({ type: "cc", channel: ev.channel, controller: ev.controller });
        return;
      }
    }
    this.learn = { pendingCc: ev };
    this.hooks.learnPending();
  }

  // ---- incoming ----

  /** Feed one raw incoming message (already split by the platform layer). */
  onMessage(bytes: number[]): void {
    const ev = decodeMessage(bytes);
    if (!ev) return;
    if (this.learn) {
      this.feedLearn(ev);
      return;
    }
    for (const mapping of this.matches(ev)) this.apply(mapping, ev);
  }

  // The mappings an event addresses. A CC can hit a plain CC binding and either
  // half of a 14-bit pair binding; note / pitch bend hit exactly one address.
  private matches(ev: MidiEvent): MidiMapping[] {
    const addrs: MidiAddr[] = [];
    if (ev.type === "cc") {
      addrs.push({ type: "cc", channel: ev.channel, controller: ev.controller });
      addrs.push({ type: "cc14", channel: ev.channel, controller: ev.controller < 32 ? ev.controller : ev.controller - 32 });
    } else if (ev.type === "note") {
      addrs.push({ type: "note", channel: ev.channel, note: ev.note });
    } else {
      addrs.push({ type: "pitchbend", channel: ev.channel });
    }
    return addrs.flatMap((addr) => this.byKey.get(addrKey(addr)) ?? []);
  }

  private apply(mapping: MidiMapping, ev: MidiEvent): void {
    const control = this.hooks.resolve(mapping.control);
    if (!control) return; // stale mapping (other model) — leave it inert
    const key = addrKey(mapping.addr); // a mapping only ever matches via its own address
    const toggle = control.kind === "toggle";
    // Receive bookkeeping suppresses the echo for continuous controls only: a
    // toggle press does not represent the new state (a momentary button cannot
    // know it just muted something), so its LED feedback must go out promptly.
    if (!toggle) this.lastRecv.set(key, this.hooks.now());
    const before = control.get();
    const target = toggle ? this.toggleTarget(mapping, key, ev, before) : this.continuousTarget(mapping, key, ev, before, control.step);
    if (target === null) return;
    if (!control.set(target)) return; // device-locked — swallowed
    const after = control.get();
    // The controller already shows what it sent: remember the applied value as
    // fed back, so the settle pass only sends a genuinely different value.
    if (!toggle && mapping.mode !== "relative") this.lastSent.set(key, this.encodeRaw(mapping.addr, after));
    if (after !== before) this.hooks.applied(control);
  }

  // Toggles: "edge" (default) flips on a note-on or a CC rising edge (≥ 64) —
  // the momentary-button convention, where a release is ignored. "state"
  // follows the value instead (note on / CC ≥ 64 = on, else off), for senders
  // that alternate one message per press (e.g. a Stream Deck toggle button,
  // which would otherwise miss every second press). Take-in modes don't apply.
  private toggleTarget(mapping: MidiMapping, key: string, ev: MidiEvent, current: number): number | null {
    if (ev.type === "pitchbend") return null;
    if (mapping.button === "state") {
      const target = ev.type === "note" ? (ev.on ? 1 : 0) : ev.value >= 64 ? 1 : 0;
      return target === current ? null : target;
    }
    if (ev.type === "note") return ev.on ? (current >= 0.5 ? 0 : 1) : null;
    const prev = this.lastCc.get(key);
    this.lastCc.set(key, ev.value);
    const rising = ev.value >= 64 && (prev === undefined || prev < 64);
    return rising ? (current >= 0.5 ? 0 : 1) : null;
  }

  private continuousTarget(mapping: MidiMapping, key: string, ev: MidiEvent, current: number, step: number): number | null {
    // A note bound to a continuous control acts as a momentary full/zero switch.
    if (ev.type === "note") return ev.on ? 1 : 0;
    let incoming: number;
    if (ev.type === "pitchbend") {
      incoming = ev.value / 16383;
    } else if (mapping.addr.type === "cc14") {
      incoming = this.assemblePair(mapping.addr.channel, mapping.addr.controller, ev) / 16383;
    } else if (mapping.mode === "relative") {
      const delta = decodeRelative(ev.value, mapping.encoding ?? "twos");
      if (delta === 0) return null;
      // One encoder click walks one detent of the control's own grid.
      return Math.max(0, Math.min(1, current + delta * step));
    } else {
      incoming = ev.value / 127;
    }
    if (mapping.mode === "pickup" && !this.pickupEngaged(key, incoming, current)) return null;
    return incoming;
  }

  // 14-bit CC pair assembly: keep the last MSB/LSB per pair and combine on every
  // half, so an MSB-only sweep still moves coarsely and MSB+LSB is exact.
  private assemblePair(channel: number, msbController: number, ev: CcEvent): number {
    const key = `${channel}:${msbController}`;
    const st = this.pair.get(key) ?? { msb: 0, lsb: 0 };
    if (ev.controller === msbController) st.msb = ev.value;
    else st.lsb = ev.value;
    this.pair.set(key, st);
    return (st.msb << 7) | st.lsb;
  }

  // Pickup: swallowed until the physical value reaches (±eps) or crosses the
  // plan value; once engaged it tracks until the mapping state resets (external
  // change fed back / mappings replaced).
  private pickupEngaged(key: string, incoming: number, current: number): boolean {
    const st = this.pickup.get(key) ?? { engaged: false, lastIn: null };
    if (!st.engaged) {
      const crossed = st.lastIn !== null && (st.lastIn - current) * (incoming - current) <= 0;
      if (crossed || Math.abs(incoming - current) <= PICKUP_EPS) st.engaged = true;
    }
    st.lastIn = incoming;
    this.pickup.set(key, st);
    return st.engaged;
  }

  // ---- feedback ----

  /**
   * Push the plan state out to the controller: for every mapping whose encoded
   * value differs from what was last sent, emit the message(s). Addresses that
   * received input within RECENT_MS are deferred (returns true so the caller
   * reschedules a settle pass). Call after any plan change, and with
   * `resync = true` (forget the sent cache) after opening the output port.
   */
  feedback(resync = false): boolean {
    if (resync) this.lastSent.clear();
    const now = this.hooks.now();
    let deferred = false;
    for (const mapping of this.mappings) {
      const control = this.hooks.resolve(mapping.control);
      if (!control) continue;
      const key = addrKey(mapping.addr);
      const raw = this.encodeRaw(mapping.addr, control.get());
      if (this.lastSent.get(key) === raw) continue;
      if (now - (this.lastRecv.get(key) ?? -Infinity) < RECENT_MS) {
        deferred = true;
        continue;
      }
      this.emit(mapping.addr, control.get(), raw);
      this.lastSent.set(key, raw);
      // The physical control no longer matches the plan (the change came from
      // elsewhere): a non-motorized fader must pick the value up again.
      this.pickup.delete(key);
    }
    return deferred;
  }

  private encodeRaw(addr: MidiAddr, value: number): number {
    const v = Math.max(0, Math.min(1, value));
    return addr.type === "cc14" || addr.type === "pitchbend" ? Math.round(v * 16383) : Math.round(v * 127);
  }

  private emit(addr: MidiAddr, value: number, raw: number): void {
    switch (addr.type) {
      case "cc":
        this.hooks.send(encodeCc(addr.channel, addr.controller, raw));
        break;
      case "cc14":
        this.hooks.send(encodeCc(addr.channel, addr.controller, (raw >> 7) & 0x7f));
        this.hooks.send(encodeCc(addr.channel, addr.controller + 32, raw & 0x7f));
        break;
      case "note":
        this.hooks.send(encodeNote(addr.channel, addr.note, value >= 0.5));
        break;
      case "pitchbend":
        this.hooks.send(encodePitchBend(addr.channel, raw));
        break;
    }
  }
}

function decodeRelative(value: number, encoding: RelativeEncoding): number {
  switch (encoding) {
    case "twos":
      return value < 64 ? value : value - 128;
    case "offset64":
      return value - 64;
    case "signbit":
      return value < 64 ? value : -(value - 64);
  }
}
