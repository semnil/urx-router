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

/** One member's resolved control and what it decided to do to it, if anything. A null decision
 *  is a member that resolved and chose to act on nothing — kept apart from a mapping that named
 *  nothing this plan carries, because only the second may let another member speak for it. */
interface Attempt {
  mapping: MidiMapping;
  control: BoundControl;
  decision: Decision | null;
}

/** One mapping's decided edit: what its control read before the message and what it is to be
 *  set to. A gang decides every member's before this way, then writes them — applying one can
 *  move another's control through the mirror the apply hook runs. */
interface Decision {
  mapping: MidiMapping;
  control: BoundControl;
  key: string;
  isHead: boolean;
  before: number;
  target: number;
}

export class MidiEngine {
  private mappings: MidiMapping[] = [];
  private byKey = new Map<string, MidiMapping[]>();
  private pickup = new Map<string, PickupState>();
  private pair = new Map<string, { msb: number; lsb: number }>(); // cc14 assembly
  private lastSent = new Map<string, number>(); // last raw value fed back per address
  /** The plan value each address carried at the last pass, whether or not that pass put
   *  anything on the wire. Separate from `lastSent`, which is a claim about the
   *  CONTROLLER: the pickup question is "did the plan move under the physical control",
   *  and a held pass reading the sent cache for it answers "always" — every address, on
   *  every pass, taking the seeded crossing state of a binding the operator is in the
   *  middle of picking up with it. */
  private lastSeen = new Map<string, number>();
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
    this.lastSeen.clear();
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
      if (!this.dropEcho(matched[0], ev)) {
        const only = this.attempt(matched[0], ev);
        if (only?.decision) this.commit(only.decision);
      }
      return;
    }
    // Gang: the echo guard is owned per address by the list head, so a whole gang
    // sharing an address drops or keeps together — decide the echo once per address
    // before applying (a non-head member must not move on it).
    const echoed = new Set<string>();
    for (const mapping of matched) {
      if (this.dropEcho(mapping, ev)) echoed.add(addrKey(mapping.addr));
    }
    // Every member's target is decided from the state BEFORE this message, and only then
    // are any of them written. Applying one member can move ANOTHER member's control:
    // a linked stereo pair holds one insert effect between them, so the funnel mirrors an
    // edit onto the partner, and a target computed after that mirror is computed against a
    // value this same message produced. Both faces ganged to one CC then cancelled out —
    // the first flipped the pair off, the second read the mirrored off and flipped it back,
    // and one press left the pair exactly where it started.
    // Every member is RESOLVED and decided first, and a member that decided to do nothing keeps
    // its seat: `decide` answers null both for "this control is not in this plan" and for "this
    // press is not for me" (an edge toggle's release), and only the first of those may let another
    // member speak for the group.
    const attempts = matched
      .filter((mapping) => !echoed.has(addrKey(mapping.addr)))
      .map((mapping) => this.attempt(mapping, ev))
      .filter((a): a is Attempt => a !== null);
    // Members a MIRROR keeps equal are ONE decision, not several. A mirror settles on whichever
    // member was written last, so writing each in turn leaves a pair that started at different
    // values wherever the learn order put it — and a plan can hold such a pair, saved and loaded
    // without complaint. The seat goes to the pair PRIMARY where the gang holds it, so what
    // survives is decided by the pair rather than by the order two assignments were made in;
    // dropping the rest costs nothing, since the mirror writes them anyway.
    //
    // Keyed by the ADDRESS as well as by `mirrorId ?? id`. One incoming CC matches two addresses —
    // its own and the 14-bit pair it is a half of (`matches` owns which halves those are) — so
    // `matched` can hold two
    // gangs at once, and a gang is the members sharing ONE address. Collapsed across that boundary,
    // a member on the other address decided for this one: a 14-bit binding on a toggle is inert by
    // design, and as the pair primary it silenced the plain CC that was bound beside it.
    //
    // The rest of the key is the normalisation the lock ordering matches on: the primary answers to
    // its own id, its partner to the primary's, and a control nothing mirrors is a group of one.
    const groups = new Map<string, Attempt>();
    for (const a of attempts) {
      const key = `${addrKey(a.mapping.addr)}\u0000${a.control.mirrorId ?? a.control.id}`;
      const held = groups.get(key);
      if (held === undefined) {
        groups.set(key, a);
        continue;
      }
      this.hooks.trace?.(`mirror ${a.mapping.control} -> ${a.control.mirrorId ?? a.control.id}`);
      // The primary takes the seat wherever it sits in the gang; otherwise the first one keeps it.
      // A primary is the member whose own id is what its group is keyed by — the secondary is the
      // one that carries a `mirrorId`, and the primary carries none.
      if (a.control.mirrorId === undefined && held.control.mirrorId !== undefined) groups.set(key, a);
    }
    // …and only NOW are the members that decided nothing dropped. Filtered before the grouping,
    // a primary that ignored the press left its partner's decision to drive the pair — which is
    // reachable, since a gang may mix edge and state deliberately (`button` is not ganged).
    const decisions = [...groups.values()].map((a) => a.decision).filter((d): d is Decision => d !== null);
    // …and a member the lock refuses is tried again once the rest have written, because the
    // lock may be another member's to release: the EQ 1-knob computes the four bands while it
    // is on, so a gang told to switch everything off cannot write a band until the knob in the
    // same gang has gone off, and in the order that learns the band FIRST nothing ever did.
    // Bounded by the member count, and stops as soon as a pass writes nothing.
    //
    // A GOVERNED member is written before the one that governs it — a 1-knob over the values it
    // computes, a Sync switch over the time it derives. Which way a write moves the lock is not
    // asked, because it does not have to be: on the way INTO a lock the governed value is
    // written while it still can be, and on the way out of one the retry below lands it once
    // the governor has let go. Asked instead, the answer would have to be predicted from a
    // value nothing has written yet, and it differs per control — a 1-knob locks the bands
    // while it is on and its own level while it is off.
    //
    // Two buckets rather than a sort: no control here governs another that governs a third,
    // and a chain deeper than one is carried by the retry anyway.
    const governors = new Set(
      decisions.map((d) => d.control.governedBy).filter((gid): gid is string => gid !== undefined),
    );
    // Matched on the control's LOCK identity, which is its own id except where the catalogue
    // normalises it: a BAL-linked pair mirrors its whole node params, so its two 1-knobs are
    // one governor and a gang naming either has to be ordered against the values on both.
    const governs = (d: Decision): boolean => governors.has(d.control.lockId ?? d.control.id);
    const ordered = [...decisions.filter((d) => !governs(d)), ...decisions.filter(governs)];
    // The DECISION is what is retried, not the deciding. Re-deciding would read the control
    // again, and for an edge toggle the target is a flip of what it reads — so the two learn
    // orders parted company, one flipping the value the operator was shown and the other
    // flipping the one the release had just put there. Retrying the decision also keeps the
    // 14-bit assembly and the pickup engagement to the one pass that owns them.
    let pending = ordered.filter((d) => !this.commit(d));
    for (let pass = 0; pass < matched.length && pending.length > 0; pass++) {
      const again = pending.filter((d) => !this.commit(d));
      if (again.length === pending.length) break;
      pending = again;
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

  /** What one mapping WOULD do to its control, read before anything is written. Separate from
   *  the write because a gang's members are decided together: see `onMessage`. Answers the
   *  CONTROL as well as the decision, so a member that resolved and chose to do nothing can still
   *  hold its group's seat — null here means the mapping named nothing this plan carries. */
  private attempt(mapping: MidiMapping, ev: MidiEvent): Attempt | null {
    const control = this.hooks.resolve(mapping.control);
    if (!control) return null; // stale mapping (other model) — leave it inert
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
      return { mapping, control, decision: null };
    }
    return { mapping, control, decision: { mapping, control, key, isHead, before, target } };
  }

  /** Write one decided edit. False when the control refused it — which a gang retries, since
   *  the lock may belong to a member of this same message.
   *
   *  The value is read AGAIN here rather than taken from the decision: between deciding and
   *  writing, another member may have moved this control (the funnel mirrors an insert-FX edit
   *  onto a linked partner) or released the lock that was hiding its value. What `applied`
   *  reports has to be the difference this write actually made. */
  private commit({ mapping, control, key, isHead, target }: Decision): boolean {
    const before = control.get();
    if (!control.set(target)) {
      this.hooks.trace?.(`drop locked ${mapping.control}`);
      return false; // device-locked — swallowed, or retried by a gang
    }
    const after = control.get();
    // The controller already shows what it sent: remember the applied value as
    // fed back, so the settle pass only sends a genuinely different value. A gang
    // shares one address, and its head owns that feedback cache — only it records.
    if (isHead) {
      const raw = wireRaw(mapping.addr, after);
      this.lastSent.set(key, raw);
      // The pass's own record of the plan, kept here as well: a pass may not have run
      // for this address yet (no output port, or an offline stretch), and without a
      // value to compare against the first one that does cannot tell a plan that moved
      // under the physical control from one it has simply never watched.
      this.lastSeen.set(key, raw);
    }
    this.hooks.trace?.(`apply ${mapping.control} ${before} -> ${after}`);
    if (after !== before) this.hooks.applied(control);
    return true;
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
    // No same-state shortcut: the value read here may not be the value that is there when the
    // write lands. A control LOCKED by another member of this same message reads as off while
    // holding something else, so dropping the decision on "it already matches" left the state
    // it was hiding in place — and a lock released a moment later put it back on screen.
    // `commit` is what decides nothing happened, by comparing what it read to what it wrote.
    if (mapping.button === "state") return ev.type === "note" ? (ev.on ? 1 : 0) : ev.value >= 64 ? 1 : 0;
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
   *
   * `deliver = false` runs the pass without putting anything on the wire, for a
   * caller that may not state the plan to a controller yet (MidiControl gates that
   * on a settled Live-sync readback). What the pass owes the RECEIVE side is owed
   * either way: a plan value that moved means a non-motorized fader no longer
   * matches it, whether or not the controller was told. What it owes the SEND side
   * — the sent cache, and the echo guard's arming — is skipped, because both are
   * claims about a message that did not go out.
   */
  feedback(resync = false, deliver = true): boolean {
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
      // What this pass is about to decide the pickup question against. An address seen
      // for the FIRST time counts as unmoved: nothing can have been engaged against a
      // value this has not watched yet, and calling it a move deletes the crossing state
      // a pickup binding seeds on its first swallowed message.
      const seen = this.lastSeen.get(key);
      if (this.lastSent.get(key) === raw) {
        // In step with what the controller was told: whatever moved, it is not the plan
        // away from the physical control. Recorded, so a later move is measured from here.
        this.lastSeen.set(key, raw);
        continue;
      }
      if (now - (this.lastRecv.get(key) ?? -Infinity) < RECENT_MS) {
        // NOT recorded: the settle retry that follows is the pass that will act on this
        // value, and a record here would leave it comparing the move against itself.
        deferred = true;
        continue;
      }
      const moved = seen !== undefined && seen !== raw;
      this.lastSeen.set(key, raw);
      if (deliver) {
        this.emit(mapping.addr, raw);
        this.lastSent.set(key, raw);
      }
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
      // bits that same sweep found no control whose READING fails to round-trip, so their
      // echo re-enters the same plan value and edits nothing. That is the load-bearing half
      // of this decision rather than an aside, so it is pinned in controls.test.ts.
      // ONE control is an exception, and it is stated here rather than left to be
      // rediscovered: the Mono Delay time carries more settings than the wire has
      // positions (27000 against 16384), so an echo of its own feedback snaps it to the
      // nearest addressable value — one raw, and idempotent from there. The move stays
      // visible: a cc14 arrives as two messages, so the intermediate value differs and
      // `applied` fires, which puts it on the dirty flag and in the undo ledger rather
      // than only in the plan. `controls.test.ts` pins both halves.
      // Asked of the address' resolution rather than of its type: the property is what
      // decides, and `wireSteps` is the one place a new address type has to choose.
      if (deliver && wireSteps(mapping.addr) === 127) {
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
      if (deliver && mapping.addr.type === "cc14") {
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
      // elsewhere): a non-motorized fader must pick the value up again. Asked of the
      // plan (`moved`) rather than of the sent cache, which says nothing about the plan
      // on a pass that sends nothing.
      if (moved) this.pickup.delete(key);
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
