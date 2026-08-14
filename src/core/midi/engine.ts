// The MIDI mapping engine: routes decoded MIDI events onto bound console
// controls (with per-mapping take-in modes), runs the MIDI-learn state machine,
// and produces controller feedback (motor faders / LEDs following the plan).
// Pure logic — ports, persistence and timers live in the UI layer; the clock is
// injected so tests drive time explicitly.

import { decodeMessage, encodeCc, encodeNote, encodePitchBend, type CcEvent, type MidiEvent } from "./message";
import { addrKey, wireRaw, wireSteps, type MidiAddr, type MidiMapping } from "./mapping";
import type { BoundControl } from "./controls";

export interface EngineHooks {
  /** Resolve a mapping's control id against the current model + plan. */
  resolve(id: string): BoundControl | null;
  /** An incoming message changed the plan through `control` (mirror + repaint). */
  applied(control: BoundControl): void;
  /** A localized refusal, or null when incoming messages may edit the plan. The
   *  engine never reads the value — it forwards it to `refused`. The window it
   *  belongs to is decided by gateReleased(), not by the string: two windows in a
   *  row carry the same reason whenever the same latch raised both. */
  gate?(): string | null;
  /** The first message of a gated window that would actually have edited
   *  something. Called once per window, never per message: a controller sweep is
   *  dozens of messages a second and the status line is one line. */
  refused?(reason: string): void;
  /** Send feedback bytes out (caller no-ops when no output port is open). */
  send(bytes: number[]): void;
  /** MIDI-learn resolved an address. */
  learned(addr: MidiAddr): void;
  /** A learn candidate is pending (a CC waits for a quiet gap / its 14-bit pair
   *  partner); the caller should schedule flushLearn() after a short delay. */
  learnPending(): void;
  /** Clock in ms (performance.now in the app; scripted in tests). */
  now(): number;
  /** Optional diagnostic: one line per receive decision (drop/ignore/apply). */
  trace?(msg: string): void;
}

// Pickup engages when the physical value lands within this normalized distance
// of the plan value (≈ 2 steps of a 7-bit controller), or crosses it.
const PICKUP_EPS = 2 / 127;

// Feedback for an address is deferred while messages are still arriving from it,
// so a snapped echo never fights an in-progress sweep; the settled value goes
// out on the next pass after this quiet gap.
const RECENT_MS = 300;

// The receive-side mirror of that guard: a controller that reflects feedback
// back (a shared virtual MIDI bus, or a plugin that re-sends its state when
// feedback changes it) returns the just-sent value, which the app would apply as
// an operator gesture — flipping an edge-mode toggle straight back, or landing a
// continuous control on the neighbouring detent its 7-bit trip decoded to. Within
// this window after sending, the FIRST incoming value equal to the last feedback
// on that address (kept in lastSent) is dropped and the guard disarms — the
// transports deliver exactly one echo per sent message, and consuming it one-shot
// keeps an equal real press right after the echo alive (edge-mode presses are
// always 127, so a blanket window would eat them). Which addresses are armed, and
// why the 14-bit ones are not, is decided in feedback().
// Sized from the phenomenon, not from a round number. Measured echo latency on the
// reflecting transports this guard exists for is 0.13-5 ms (echo-repro.test.ts), and
// 300 ms was 60-2300x that — long enough to eat a REAL press on a plain controller
// where no echo will ever arrive to disarm it. Every physical edge press re-armed the
// trap through its own LED confirm: press at t=0, confirm (127) at t≈120, a second
// press at t≈200-420 sends 127 again, equals `lastSent`, and is consumed as the echo.
// The intervening release (0) does not disarm it, since 0 ≠ 127.
const ECHO_MS = 50;

interface PickupState {
  engaged: boolean;
  lastIn: number | null;
}

export class MidiEngine {
  private mappings: MidiMapping[] = [];
  private byKey = new Map<string, MidiMapping[]>();
  private pickup = new Map<string, PickupState>();
  private pair = new Map<string, { msb: number; lsb: number }>(); // cc14 assembly
  private lastSent = new Map<string, number>(); // last raw value fed back per address
  private lastRecv = new Map<string, number>(); // last receive time per address
  private lastFedAt = new Map<string, number>(); // echo guard: last feedback send-time per address
  /** What the guard expects that echo to carry. Separate from `lastSent`, which is the
   *  feedback CACHE: a cc14 emission arms the two plain-CC addresses it lands on, and
   *  writing those bytes into their cache would make each of those bindings re-emit its
   *  own unchanged value on the next pass. */
  private lastFedValue = new Map<string, number>();
  private learn: { pendingCc: CcEvent | null } | null = null;
  // Whether the current gated window has already been reported. Cleared by
  // gateReleased(), and by the first message that is allowed through.
  private gated = false;

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
    // Reset per-mapping state: stale pickup / pair / echo-guard state must not leak across sets.
    this.pickup.clear();
    this.pair.clear();
    this.lastFedAt.clear();
  }

  isMapped(controlId: string): boolean {
    return this.mappings.some((m) => m.control === controlId);
  }

  /** The gate's owner released the plan: end the reported window, so the next one
   *  speaks up again. The engine cannot see this for itself — it runs only on an
   *  incoming message, and a window opens and closes with none arriving whenever
   *  the operator is not touching the controller. Comparing the reason instead
   *  silenced every window after the first, since one latch always names itself
   *  the same way. */
  gateReleased(): void {
    this.gated = false;
  }

  /** True when this mapping shares its address with an earlier one — a gang
   *  member, not the feedback head — so the assignment list can tag it. */
  isLinkedMember(mapping: MidiMapping): boolean {
    const key = addrKey(mapping.addr);
    const list = this.byKey.get(key);
    return !!list && list.length > 1 && !this.isHead(key, mapping);
  }

  /** Mappings grouped by shared address (head first within each group), in
   *  first-learned order — the assignment list renders gangs contiguously. The
   *  head is the first member that resolves (see headOf), so an inert mapping
   *  never renders above the member that actually owns the address. */
  getGangedMappings(): MidiMapping[] {
    return [...this.byKey.entries()].flatMap(([key, gang]) => {
      const head = this.headOf(key);
      return head ? [head, ...gang.filter((m) => m !== head)] : gang;
    });
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
    const matched = this.matches(ev);
    // Unmapped traffic (clock, another controller's CC) is not a refusal.
    if (matched.length === 0) return;
    // Refused BEFORE any receive bookkeeping: the receive timestamp, the pickup
    // engagement and the 14-bit pair assembly are all state a refusal must not
    // consume, or the identical message once the window clears would not behave
    // the way it does with no window at all.
    const refusal = this.hooks.gate?.() ?? null;
    if (refusal !== null) {
      this.reportRefusal(refusal, matched);
      return;
    }
    this.gated = false;
    // Common case: a single mapping, no gang — apply it directly.
    if (matched.length === 1) {
      if (!this.dropEcho(matched[0], ev)) this.apply(matched[0], ev);
      return;
    }
    // Gang: the echo guard is owned per address by the list head, so a whole gang
    // sharing an address drops or keeps together — decide the echo once per address
    // before applying (a non-head member must not move on it).
    const echoed = new Set<string>();
    for (const mapping of matched) {
      if (this.dropEcho(mapping, ev)) echoed.add(addrKey(mapping.addr));
    }
    for (const mapping of matched) {
      if (!echoed.has(addrKey(mapping.addr))) this.apply(mapping, ev);
    }
  }

  // One report per gated window, on the first message that would actually have
  // changed something: an inert mapping (one saved for another model) edits
  // nothing either way, so naming it would report a loss that did not happen. The
  // per-message record goes to the trace log, which is where it belongs.
  private reportRefusal(reason: string, matched: MidiMapping[]): void {
    this.hooks.trace?.(`refuse ${matched.map((m) => m.control).join(",")} (${reason})`);
    if (this.gated) return;
    if (!matched.some((m) => this.hooks.resolve(m.control))) return;
    this.gated = true;
    this.hooks.refused?.(reason);
  }

  // The mappings an event addresses. A CC can hit a plain CC binding and either
  // half of a 14-bit pair binding; note / pitch bend hit exactly one address.
  private matches(ev: MidiEvent): MidiMapping[] {
    const addrs: MidiAddr[] = [];
    if (ev.type === "cc") {
      addrs.push({ type: "cc", channel: ev.channel, controller: ev.controller });
      addrs.push({
        type: "cc14",
        channel: ev.channel,
        controller: ev.controller < 32 ? ev.controller : ev.controller - 32,
      });
    } else if (ev.type === "note") {
      addrs.push({ type: "note", channel: ev.channel, note: ev.note });
    } else {
      addrs.push({ type: "pitchbend", channel: ev.channel });
    }
    return addrs.flatMap((addr) => this.byKey.get(addrKey(addr)) ?? []);
  }

  // A shared address drives a gang of controls; one member is the representative —
  // it alone owns the address' feedback and pickup state. That is the first
  // learned member that RESOLVES for the current plan: a mapping whose control is
  // gone (a removed send, or one persisted for another model) can own neither, or
  // it would strand the whole gang — no feedback ever emitted, and pickup state
  // never created, so every live member stays swallowed. Resolution follows plan
  // state, so it is recomputed rather than cached; callers on the message path
  // resolve once and pass the result down.
  private headOf(key: string): MidiMapping | undefined {
    const gang = this.byKey.get(key);
    if (!gang || gang.length === 1) return gang?.[0];
    return gang.find((m) => this.hooks.resolve(m.control) !== null) ?? gang[0];
  }

  private isHead(key: string, mapping: MidiMapping): boolean {
    return this.headOf(key) === mapping;
  }

  // Consume the one-shot echo guard for a mapping's address, tracing the drop.
  // Only the first call per sent feedback (per address) matches.
  private dropEcho(mapping: MidiMapping, ev: MidiEvent): boolean {
    const key = addrKey(mapping.addr);
    if (!this.consumeEcho(key, ev)) return false;
    this.hooks.trace?.(`drop echo ${key}`);
    return true;
  }

  private apply(mapping: MidiMapping, ev: MidiEvent): void {
    const control = this.hooks.resolve(mapping.control);
    if (!control) return; // stale mapping (other model) — leave it inert
    const key = addrKey(mapping.addr); // a mapping only ever matches via its own address
    const toggle = control.kind === "toggle";
    // Receive bookkeeping defers the next OUTGOING pass for continuous controls
    // only: a toggle press does not represent the new state (a momentary button
    // cannot know it just muted something), so its LED feedback must go out
    // promptly. (The receive-side echo guard itself ran per address in onMessage.)
    if (!toggle) this.lastRecv.set(key, this.hooks.now());
    const before = control.get();
    // Head ownership is needed twice below (pickup engagement, then the sent
    // cache); resolve it once per message rather than per use.
    const isHead = !toggle && this.headOf(key) === mapping;
    const target = toggle
      ? this.toggleTarget(mapping, ev, before)
      : this.continuousTarget(mapping, key, ev, before, isHead);
    if (target === null) {
      this.hooks.trace?.(`ignore ${mapping.control}`); // release / same state / pickup hold
      return;
    }
    if (!control.set(target)) {
      this.hooks.trace?.(`drop locked ${mapping.control}`);
      return; // device-locked — swallowed
    }
    const after = control.get();
    // The controller already shows what it sent: remember the applied value as
    // fed back, so the settle pass only sends a genuinely different value. A gang
    // shares one address, and its head owns that feedback cache — only it records.
    if (isHead) this.lastSent.set(key, wireRaw(mapping.addr, after));
    this.hooks.trace?.(`apply ${mapping.control} ${before} -> ${after}`);
    if (after !== before) this.hooks.applied(control);
  }

  // Toggles: "edge" (default) flips on each on-value — a note-on, or a CC ≥ 64;
  // the release (note-off / CC < 64) is ignored. Not a rising-edge test: a
  // button that sends a fixed on-value per press with no release-to-0 between
  // (e.g. a Stream Deck "Push" configured to send 127 only) must still flip on
  // every press, not just the first. The feedback loopback (also ≥ 64) would
  // itself flip an edge toggle back, so the receive-side echo guard swallows it.
  // "state" follows the value instead (note on / CC ≥ 64 = on, else off), for
  // senders that alternate one message per press (e.g. a Stream Deck toggle
  // button, which would otherwise miss every second press). Take-in modes don't
  // apply.
  private toggleTarget(mapping: MidiMapping, ev: MidiEvent, current: number): number | null {
    // A toggle only meaningfully binds to a note or a plain 7-bit CC. A pitchbend
    // has no discrete press, and a cc14 arrives as two 7-bit halves that would each
    // flip it (≥ 64) — leave both misbindings inert, like the pitchbend one.
    if (mapping.addr.type === "pitchbend" || mapping.addr.type === "cc14") return null;
    if (mapping.button === "state") {
      const target = ev.type === "note" ? (ev.on ? 1 : 0) : ev.value >= 64 ? 1 : 0;
      return target === current ? null : target;
    }
    const on = ev.type === "note" ? ev.on : ev.value >= 64;
    return on ? (current >= 0.5 ? 0 : 1) : null;
  }

  private continuousTarget(
    mapping: MidiMapping,
    key: string,
    ev: MidiEvent,
    current: number,
    isHead: boolean,
  ): number | null {
    // A note bound to a continuous control acts as a momentary full/zero switch.
    if (ev.type === "note") return ev.on ? 1 : 0;
    let incoming: number;
    if (ev.type === "pitchbend") {
      incoming = ev.value / 16383;
    } else if (mapping.addr.type === "cc14") {
      incoming = this.assemblePair(mapping.addr.channel, mapping.addr.controller, ev) / 16383;
    } else {
      incoming = ev.value / 127;
    }
    if (mapping.mode === "pickup") {
      // Pickup state is owned by the address' head, which is applied first
      // (matches() preserves byKey order), so ganged members can inherit its
      // engagement and cross over together behind the one physical control.
      const engaged = isHead ? this.pickupEngaged(key, incoming, current) : (this.pickup.get(key)?.engaged ?? false);
      if (!engaged) return null;
    }
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
    if (resync) this.forgetFeedback();
    const now = this.hooks.now();
    let deferred = false;
    // One address drives one physical control, so iterate ADDRESSES: when a gang
    // shares one, only its head feeds back (the controls it represents may
    // diverge, and a single physical control can follow just one). Walking byKey
    // rather than every mapping also resolves the head once per address per pass.
    for (const key of this.byKey.keys()) {
      const mapping = this.headOf(key);
      const control = mapping && this.hooks.resolve(mapping.control);
      if (!mapping || !control) continue;
      // The diff is taken on what would actually go OUT, so an address that carries
      // less than the value does (a note carries on/off) does not re-emit a
      // byte-identical message every time the position moves.
      const raw = wireRaw(mapping.addr, control.get());
      if (this.lastSent.get(key) === raw) continue;
      if (now - (this.lastRecv.get(key) ?? -Infinity) < RECENT_MS) {
        deferred = true;
        continue;
      }
      this.emit(mapping.addr, raw);
      this.lastSent.set(key, raw);
      // Arm the echo guard: this feedback loops back on a shared bus (or off a
      // controller that re-sends its state when feedback changes it) and is applied
      // as if the operator had moved something. On a toggle that flips an edge
      // mapping straight back. On a CONTINUOUS control it is an edit whenever the
      // plan's own grid is finer than the 7 bits the value crossed on: the decoded
      // value snaps to a neighbouring detent, so `after !== before` and the change
      // reaches the device — once per feedback pass, and so once per Live-sync start.
      // Measured over every bindable continuous control (2026-08-09): 90 of 282 on a
      // URX44V behave that way, all of them tuning-screen parameters (EQ frequency
      // and Q, GATE attack / hold / decay, COMP attack / release / ratio), while
      // every console-level control round-trips unchanged.
      //
      // The 14-bit forms are deliberately left unarmed. A cc14 echo cannot be matched
      // here at all — it arrives as two 7-bit halves — and neither needs to be: at 14
      // bits that same sweep found NO control that fails to round-trip, so their echo
      // re-enters the same plan value and edits nothing. That is the load-bearing half
      // of this decision rather than an aside, so it is pinned in controls.test.ts.
      // Asked of the address' resolution rather than of its type: the property is what
      // decides, and `wireSteps` is the one place a new address type has to choose.
      if (wireSteps(mapping.addr) === 127) {
        this.lastFedAt.set(key, now);
        this.lastFedValue.set(key, raw);
      }
      // …but a cc14 EMISSION still lands on the plain-CC address space, which the
      // decision above never covers: it asks about the address being emitted, and the
      // two bytes go out as CC n and CC n+32. A knob learned as plain CC 39 while a
      // fader is learned as cc14 7/39 (learn can create both) therefore takes the
      // fader's LSB as a value edit — applied, and written to the unit while live —
      // and its own corrective feedback echoes back into the fader's unguarded LSB
      // half, where it re-assembles with the fader's stale MSB. Each side then edits
      // the other at the debounce cadence until the two snapped values happen to
      // coincide. Arming the plain-CC entries the emission actually touches is what
      // stops the first step of that.
      if (mapping.addr.type === "cc14") {
        const half = (controller: number, value: number): void => {
          const k = addrKey({ type: "cc", channel: mapping.addr.channel, controller });
          if (!this.byKey.has(k)) return;
          // The GUARD only. `lastSent` is that address' own feedback cache, and writing
          // this byte into it would make the plain binding re-emit its unchanged value
          // on the next pass, once per cc14 move.
          this.lastFedAt.set(k, now);
          this.lastFedValue.set(k, value);
        };
        half(mapping.addr.controller, (raw >> 7) & 0x7f);
        half(mapping.addr.controller + 32, raw & 0x7f);
      }
      // The physical control no longer matches the plan (the change came from
      // elsewhere): a non-motorized fader must pick the value up again.
      this.pickup.delete(key);
    }
    return deferred;
  }

  // A plain comparison, because the sent cache holds what went on the WIRE (wireRaw)
  // rather than the encoded position — an incoming message carries the same thing, so
  // neither side has to re-derive the other's domain. It did once, and the case it got
  // wrong was a fader bound to a note: the cache held the position while the wire
  // carried 127, so the echo went unrecognised and applied as a full-scale move.
  private consumeEcho(key: string, ev: MidiEvent): boolean {
    const at = this.lastFedAt.get(key);
    if (at === undefined) return false;
    if (this.hooks.now() - at >= ECHO_MS) {
      this.lastFedAt.delete(key);
      return false;
    }
    const raw = ev.type === "note" ? (ev.on ? 127 : 0) : ev.value;
    if (raw !== this.lastFedValue.get(key)) return false;
    this.lastFedAt.delete(key); // one echo per sent message — disarm on the match
    return true;
  }

  /** Forget what the controller has been told, so the next feedback pass re-sends
   *  every mapped value. Called when a feedback send failed: the cache would
   *  otherwise record a value the controller never received, leaving its LED or
   *  fader showing the wrong state until that value happens to change again. The
   *  echo guard is dropped with it — the echo of a send that never left cannot
   *  arrive, and leaving it armed would swallow a real press instead. */
  forgetFeedback(): void {
    this.lastSent.clear();
    this.lastFedAt.clear();
    this.lastFedValue.clear();
  }

  // `raw` is already what this address puts on the wire (wireRaw), so this only has
  // to frame it — no address here re-derives a value from the plan's.
  private emit(addr: MidiAddr, raw: number): void {
    switch (addr.type) {
      case "cc":
        this.hooks.send(encodeCc(addr.channel, addr.controller, raw));
        break;
      case "cc14":
        this.hooks.send(encodeCc(addr.channel, addr.controller, (raw >> 7) & 0x7f));
        this.hooks.send(encodeCc(addr.channel, addr.controller + 32, raw & 0x7f));
        break;
      case "note":
        this.hooks.send(encodeNote(addr.channel, addr.note, raw >= 64));
        break;
      case "pitchbend":
        this.hooks.send(encodePitchBend(addr.channel, raw));
        break;
    }
  }
}
