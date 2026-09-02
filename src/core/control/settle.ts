// Post-write settle: what a read may believe about an address the caller has just
// written, and how long it must wait before asking the unit instead.
//
// The unit acks a write before the value is readable. Measured on a URX44V (System
// V1.3.1.0), across six addresses and three parameter classes: a GET of a just-written
// address answers the PRE-write value until that write's own change notify arrives.
// Strictly value-paired, n = 87 (53 of them taken during a real drag): 9 ms at the
// fastest, ~101 ms median, 204 ms at the widest, and not one read before its own notify
// was fresh, nor one stale after it. The notify IS the boundary, not an approximation
// of it.
//
// So the answer this module gives is THE VALUE THE DEVICE ANNOUNCED — never the value
// the caller sent. That is the whole of it, and it is why there is no special case for
// a write the unit quantised, clamped or refused: a notify is a confirmation whatever
// value it carries, and that value is what the unit holds. Live sync's stance is that
// the device's word is the truth, the same stance the session's own "unsaved changes
// will be discarded" gate states. An address the unit has said nothing about is not
// answered at all — the caller reads it off the unit, which is what a blind read does
// today and the one answer that cannot enshrine a divergence.
//
// A notify counts as the announcement of OUR write only if it arrived after that
// address's own vdSet was issued, which is why the caller hands over a mark PER
// ADDRESS rather than one for the flush: the write loop awaits per command, so a device
// notify for the fader can easily land before the fader was reached. Getting that
// attribution wrong is SELF-CORRECTING in either direction — the real write's notify
// arrives later and overwrites the value, and a notify that predates the write leaves
// the address to be read off the unit — so the mark removes a spurious reconcile
// rather than carrying the correctness of the merge.
//
// Two ways the wait ends, both measured:
//   - the address's own notify (exact). What every write the snapshot held a DIFFERENT
//     value for owes: the unit must change, and a change is announced.
//   - the bounded window (conservative), 300 ms against the measured 204 ms maximum,
//     i.e. a 1.47x margin. What a write the snapshot held NO entry for gets, because
//     that write may be a no-op and a no-op emits no notify at all (measured: 18 such
//     writes acked in 0-1 ms and produced none). The wait must time out rather than
//     hang, and the address must not be read before it does.
//
// The side-effect family that needs no boundary of its own has TWO measured members, and
// the boundary is only sound while every member is measured — the written address's own
// notify ends the wait, so a dependent that lands before it would be read stale:
//
//   EQ_ONE_KNOB_LEVEL   recomputes the four EQ_BAND_GAIN registers of the same node;
//                       they moved 1-2 ms AFTER the written address went fresh
//                       (4 clean samples).
//   SSMCS_MORPHING      recomputes seventeen addresses across the strip (96…117); the
//                       written address arrived FIRST — 0.085 ms ahead of the earliest
//                       dependent, none ahead of it — and the whole block landed within
//                       0.35 ms (measured 2026-08, URX44V, sub-millisecond clock and
//                       arrival order, because the burst fits inside one millisecond and
//                       a millisecond clock reports it as a tie).
//   COMP_ONE_KNOB       recomputes threshold / ratio / makeup (35 / 36 / 38) to unity and
//                       takes the knee (37) to Medium; written address first by 0.046 ms,
//                       none ahead of it. The knee is the one a first run missed: it was in
//                       the probe's capture list and not in its WATCH list, so its notify
//                       was counted as another client's traffic.
//   COMP_ONE_KNOB_LEVEL recomputes the three, leaving the knee where the knob put it; written address first
//                       by 0.111 ms, none ahead of it. ⚠️ Measuring it needs the knob left
//                       ON — a level write is inert while it is off, and a run that
//                       restored the knob before writing the level reported no dependents
//                       at all.
//
// Both put the boundary before the dependents by well under the flight time of the first
// read the refetch then issues, which is what makes ending on it safe. Every sideEffect:
// "converge" head (COMP_EQ_TYPE, SIGNAL_TYPE, PAN_BAL, the insert-FX and FX type
// selectors) resets values whose latency after the head's own notify nobody has measured.
// So a notify boundary is used where the write is read back by a refetch, and NOT where a
// converge round re-reads: client.ts keeps its blind window.
//
// A THIRD member needs the same measurement before it is added, not the assumption that
// the family behaves alike.

import { addrKey } from "./translate";

/**
 * The bounded wait, and the whole of it for a write no notify can be expected for.
 * See the measured window above. One source for every site that spends it, so a test
 * clearing one wait by advancing another is only ever right while they agree.
 */
export const SETTLE_TIMEOUT_MS = 300;

/** Shared "the device announced nothing about any of it" answer. */
const NOTHING_ANNOUNCED: ReadonlyMap<number, number> = new Map();

export interface SettleOptions {
  /** Cancels the wait the way it cancels the reads around it: the returned promise
   *  rejects with the signal's reason, as signal.throwIfAborted() would. */
  signal?: AbortSignal;
  /** Ceiling on the wait, and the whole of it for an address that never announces.
   *  0 disables the settle entirely (the unit tests, whose fake device has no
   *  asynchronous anything to settle). */
  timeoutMs?: number;
  /** The addresses the wait may not end before hearing about — every address the read
   *  that follows is going to ASK the unit for. Omitted = all of `written`.
   *
   *  An address outside it is still judged: it is answered from its announcement if one
   *  arrived on its own, and left out otherwise. Keeping the two apart is what stops a
   *  flush's collateral write to some other node — a node this read does not touch —
   *  from holding a drag's read open for the whole window. */
  mustSettle?: ReadonlySet<number>;
  /** The addresses the unit is OBLIGED to announce: the caller sent a value the device
   *  did not hold, so it must change and must say so. One still silent when the bound
   *  elapses is a write that went nowhere — reported to whatever registered a source
   *  (see arm), which is how the repair is reached without this module knowing what the
   *  repair is. Class (b) — a write that may be a no-op — must stay out of it, or a
   *  legitimate silence would order a whole-device sweep every time. */
  mustAnnounce?: ReadonlySet<number>;
  /** What each obliged write SENT, so a notify can be matched to the write it answers.
   *  Without it an address's obligations can only be counted, and counting cannot tell the
   *  two one-notify cases apart: a write superseded before its announcement went out (the
   *  notify carries the LATER value and stands for both) and a write announced normally
   *  whose successor was acked and silently discarded (the notify carries the EARLIER
   *  value and stands only for that one). An obligation with no entry here is discharged
   *  by any announcement after its mark — the name path, whose notify carries its text in
   *  a different field and a numeric value of 0. */
  expected?: ReadonlyMap<number, number>;
  /** Marks for addresses that bound the wait but whose VALUE must not be reported: the
   *  flush's string writes. They cannot travel in `written` — that map is what a numeric
   *  read is answered from, and a string notify carries its text in a different field — but
   *  without a mark the wait cannot tell this write's announcement from an older one, so it
   *  waits unconditionally and an answer that arrived while the flush was still running is
   *  missed. Consulted for the mark only; `announced` is still built from `written` alone. */
  boundaryMarks?: ReadonlyMap<number, number>;
}

/**
 * What a writer hands to the read that follows it, so the read is not answered out of
 * its own write's staleness window. Travels as one value because its parts are one
 * statement about one batch of writes — a `written` without the marks it was taken at
 * would count notifies that predate it.
 */
export interface PendingWrites {
  /** Every address the writer sent and the device acked, mapped to the settle mark
   *  taken immediately BEFORE that address's own vdSet: only a notify after it can be
   *  the announcement of that write. The values sent are deliberately not here — they
   *  are not an input to any answer this module gives. */
  written: ReadonlyMap<number, number>;
  /** The subset the following read may not START before: the addresses inside its
   *  scope, which it is going to read off the unit for any it cannot answer from an
   *  announcement. */
  mustSettle: ReadonlySet<number>;
  /** Marks for addresses the read must wait for but whose value it must not be answered
   *  from — the flush's string writes. See SettleOptions.boundaryMarks. */
  boundaryMarks?: ReadonlyMap<number, number>;
  /** What each obliged write sent. See SettleOptions.expected. */
  expected?: ReadonlyMap<number, number>;
  /** The subset outside that scope which the unit owes an announcement (see
   *  SettleOptions.mustAnnounce). This read neither confirms nor repairs them — it does
   *  not look at them at all — so the one repair available is the reconcile a silent
   *  one arms. */
  mustAnnounce: ReadonlySet<number>;
}

/** One write the unit owes an announcement for, still unanswered. `value` is what that
 *  write sent; absent where the caller cannot say (the name path). */
interface Obligation {
  id: number;
  mark: number;
  value?: number;
}

/** One in-flight wait: what the caller is owed an answer about (`announced` filling as
 *  the unit speaks), and separately the addresses whose answer ENDS the wait. */
interface Waiter {
  written: ReadonlyMap<number, number>;
  announced: Map<number, number>;
  waitFor: Set<number>;
  done: () => void;
}

export class WriteSettle {
  // Sinks for the "the unit owed an announcement and made none" report, registered by
  // whoever owns the notify subscription. A set rather than a field so a
  // re-registration cannot leave a stale one behind.
  private readonly sinks = new Set<(addrs: ReadonlySet<number>) => void>();
  private seq = 0;
  // The last notify per address, with the position it arrived at. One entry per
  // writable address however long the session runs, and it is what lets a settle
  // called AFTER its own notify already landed resolve at once: the flush awaits a
  // vdSet per command, so the answer to an early command can arrive while a later
  // one is still in flight.
  private readonly seen = new Map<number, { value: number; at: number }>();
  private readonly waiters = new Set<Waiter>();
  // Every write still owed an announcement, oldest first per address. A write superseded
  // by a later write to the same address BEFORE its announcement went out gets none of its
  // own: the unit announces the value it ENDED UP holding and says nothing about what it
  // passed through, so such a run is answered by exactly one notify. A flush goes out more
  // often than an announcement comes back, so consecutive moves of one fader overlap that
  // way in ordinary use, and asking each of them for an announcement reports every move but
  // the last as a write that went nowhere.
  //
  // Whether a write WAS superseded is settled by the notify's value rather than assumed
  // from the overlap: the same single notify is produced when the earlier write was
  // announced normally and the later one was acked and silently discarded, and there the
  // later write really is lost. So a notify discharges the newest obligation it can be the
  // answer to, and every obligation older than that one — which the unit passed through
  // without announcing — and nothing else.
  private obligationSeq = 0;
  private readonly outstanding = new Map<number, Obligation[]>();

  /** Register the notify source; the returned call releases it. Held by whoever owns
   *  the subscription — while it is up a write can be waited out exactly, and while it
   *  is not nothing feeds note() and every wait spends its bound. `onUnannounced` is
   *  the repair channel: a source is by definition the side that can re-read the
   *  device, and this module has no business knowing how. */
  arm(onUnannounced: (addrs: ReadonlySet<number>) => void): () => void {
    this.sinks.add(onUnannounced);
    return () => this.sinks.delete(onUnannounced);
  }

  /** The notify position to hand back as an address's mark. Taken immediately before
   *  that address's own write goes out. */
  mark(): number {
    return this.seq;
  }

  /** Watch a batch of writes for an announcement WITHOUT waiting for one — for a flush
   *  that issues no read of its own, so it has nothing to hold open and nothing to be
   *  answered from. The obligation is the same as `settle`'s `mustAnnounce`: every
   *  address here is one the caller sent a value the device did not hold, so the unit
   *  must change and must say so, and one still silent at the bound is a write that went
   *  nowhere. `settle` would do this too, but only as a side effect of a wait it would
   *  then have to be given an empty `mustSettle` to skip — which reads as a settle that
   *  settles nothing and rests on that emptiness meaning "do not wait". */
  watch(
    written: ReadonlyMap<number, number>,
    mustAnnounce: ReadonlySet<number>,
    opts: { timeoutMs?: number; signal?: AbortSignal; expected?: ReadonlyMap<number, number> } = {},
  ): void {
    const { timeoutMs = SETTLE_TIMEOUT_MS, signal, expected } = opts;
    // Same disable switch the settle honours: with the wait off there is no window for
    // an announcement to arrive in, so judging one at the bound would report every
    // write as silent.
    if (timeoutMs <= 0 || !mustAnnounce.size) return;
    this.watchAnnouncements(written, mustAnnounce, timeoutMs, signal, expected);
  }

  /** Record an incoming device notify. Called before the echo test — the answer to
   *  our own write IS an echo, so a settle fed after that filter would never see the
   *  one notify it is waiting for. */
  note(p: { paramId: number; x: number; y: number; value: number }): void {
    const k = addrKey(p.paramId, p.x, p.y);
    this.seen.set(k, { value: p.value, at: ++this.seq });
    this.discharge(k, p.value, this.seq);
    for (const w of this.waiters) {
      // The LAST announcement wins, unconditionally. A second notify for one address
      // inside one window is the unit correcting itself (a quantise arriving after the
      // raw echo) or the operator moving the control on the board, and in both readings
      // the later word is the one the unit is standing behind.
      if (w.written.has(k)) w.announced.set(k, p.value);
      // The two are answered independently: this notify may end the wait without being
      // one this caller is owed an answer about, and far more often the other way round.
      if (w.waitFor.delete(k) && !w.waitFor.size) w.done();
    }
  }

  /**
   * Wait until the device has spoken for `mustSettle` (default: all of `written`), or
   * until the bounded window elapses.
   *
   * Resolves with the value the DEVICE ANNOUNCED for each `written` address it spoke
   * for after that address's own mark. An address absent from the result is one the
   * unit has said nothing about — a no-op write, an acked write it silently discarded,
   * or simply one the wait was not held open for — and the caller reads it off the
   * device rather than answering it from what was sent.
   */
  async settle(written: ReadonlyMap<number, number>, opts: SettleOptions = {}): Promise<ReadonlyMap<number, number>> {
    const { signal, timeoutMs = SETTLE_TIMEOUT_MS, mustSettle, mustAnnounce, boundaryMarks, expected } = opts;
    signal?.throwIfAborted();
    // The settle is switched off (the unit tests, whose mock device has no asynchronous
    // anything to settle). Nothing was waited for, so nothing was announced: switching
    // the wait off must not also switch off what rests on it.
    if (timeoutMs <= 0) return NOTHING_ANNOUNCED;
    // Answers already in hand, and the wait set, built separately against each
    // address's own mark. Separately because they are not required to overlap: a
    // collateral write is judged and never waited for, and an address the read will ask
    // for is waited for whether or not this caller wrote it.
    const announced = new Map<number, number>();
    for (const [k, at] of written) {
      const s = this.seen.get(k);
      if (s !== undefined && s.at > at) announced.set(k, s.value);
    }
    const named = mustSettle ?? new Set(written.keys());
    const waitFor = new Set<number>();
    for (const k of named) {
      const s = this.seen.get(k);
      const at = written.get(k) ?? boundaryMarks?.get(k);
      if (s === undefined || at === undefined || s.at <= at) waitFor.add(k);
    }
    if (mustAnnounce?.size) this.watchAnnouncements(written, mustAnnounce, timeoutMs, signal, expected);
    if (waitFor.size > 0) {
      await this.wait(timeoutMs, signal, (done) => {
        const waiter: Waiter = { written, announced, waitFor, done };
        this.waiters.add(waiter);
        return () => this.waiters.delete(waiter);
      });
    }
    return announced.size ? announced : NOTHING_ANNOUNCED;
  }

  // A write the unit was obliged to announce and did not, judged at the bound rather
  // than when the wait happened to end: a wait that ended early on some other address's
  // notify says nothing about this one, and reporting it there would order a sweep for
  // an announcement merely still in flight. The check re-reads `seen`, which keeps the
  // last notify per address for the life of the session, so nothing has to be held open
  // for it.
  //
  // Reported, not repaired. What the addresses have in common is that the read this
  // settle belongs to does not touch them — widening that read would undo the reason it
  // is scoped — so the only thing left is to tell the side that owns the notify stream
  // that its picture may be wrong, and let it decide (follow.ts arms its existing idle
  // full reconcile).
  private watchAnnouncements(
    written: ReadonlyMap<number, number>,
    mustAnnounce: ReadonlySet<number>,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    expected: ReadonlyMap<number, number> | undefined,
  ): void {
    // Who the report goes to is decided at the BOUND, from two facts rather than one:
    // who was listening when the watch was armed, and who is listening when it fires.
    // Asking either alone gets one of the two windows wrong, and both are real.
    //
    // Arming-time alone LOST the report. `DeviceFollow.subscribe()` releases its sink
    // before the re-registration await and re-arms after, so a flush landing in that
    // gap saw an empty set and armed nothing — and a write the unit silently discarded
    // right there was never reported, so the idle repair never ran.
    //
    // Fire-time alone MISDELIVERS it. A watch armed under one session fires up to
    // 300 ms later, by which point that session may have ended and another begun; the
    // new session's sink then takes a report about writes it never issued and arms a
    // full sweep it has no reason for.
    //
    // So: a sink that was listening at arm time gets the report if it is still
    // listening. If nobody was — the re-registration gap, and nothing else — it goes
    // to whoever is listening now, which is the same sink coming back.
    const armed = new Set(this.sinks);
    // Registered at ARM time, not at the bound: a notify can arrive before this watch is
    // armed, and one that arrives after must be able to see every obligation it might be
    // the answer to — including the ones armed by flushes still to come.
    const ids = new Map<number, number>();
    for (const k of mustAnnounce) {
      const mark = written.get(k);
      if (mark === undefined) continue;
      const id = ++this.obligationSeq;
      ids.set(k, id);
      const q = this.outstanding.get(k);
      const entry: Obligation = { id, mark, ...(expected?.has(k) ? { value: expected.get(k) } : {}) };
      if (q) q.push(entry);
      else this.outstanding.set(k, [entry]);
      // The answer can already be in hand: the flush awaits a vdSet per command and arms
      // once at the end, so a notify for an early write lands while a later one is still in
      // flight. Judged against `seen`, which holds the last thing the unit said — one
      // announcement, so a pair that both arrived before the arming leaves the older
      // obligation standing, and its own bound then hands it to the newer one.
      const s = this.seen.get(k);
      if (s !== undefined) this.discharge(k, s.value, s.at);
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      const to = armed.size ? [...this.sinks].filter((s) => armed.has(s)) : [...this.sinks];
      if (!to.length) return;
      const silent = new Set<number>();
      for (const k of mustAnnounce) {
        if (written.get(k) === undefined) {
          silent.add(k);
          continue;
        }
        const q = this.outstanding.get(k);
        const idx = q ? q.findIndex((o) => o.id === ids.get(k)) : -1;
        // Gone from the list = a notify answered it, on its own or as one this address's
        // later write spoke for.
        if (idx < 0 || !q) continue;
        // A LATER obligation on this address is still standing, so the unit has said
        // nothing about either yet. Hand the question to that one rather than reporting
        // here: the answer it is waiting for would have covered this write too, and
        // reporting now orders a sweep for an announcement merely still in flight.
        const last = idx === q.length - 1;
        q.splice(idx, 1);
        if (!q.length) this.outstanding.delete(k);
        if (last) silent.add(k);
      }
      if (silent.size) for (const sink of to) sink(silent);
    }, timeoutMs);
    const onAbort = (): void => clearTimeout(timer);
    signal?.addEventListener("abort", onAbort, { once: true });
  }

  // The newest obligation an announcement can be the answer to, and with it every
  // obligation OLDER than that one: those the unit passed through without announcing.
  // Searched from the newest so a run of writes is answered by its LAST value rather than
  // by its first, which is the whole of the merge. An obligation this does not match is
  // left standing — an announcement carrying an EARLIER write's value says that write was
  // announced on its own, and says nothing at all about the one that superseded it.
  private discharge(k: number, value: number, at: number): void {
    const q = this.outstanding.get(k);
    if (!q) return;
    for (let i = q.length - 1; i >= 0; i--) {
      if (q[i].mark >= at) continue;
      if (q[i].value !== undefined && q[i].value !== value) continue;
      q.splice(0, i + 1);
      if (!q.length) this.outstanding.delete(k);
      return;
    }
  }

  // One wait, one teardown: the timeout, the optional early resolve, and the abort
  // all come through `finish`, so no path leaves a timer or a waiter behind.
  private wait(
    timeoutMs: number,
    signal: AbortSignal | undefined,
    arm?: (done: () => void) => () => void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let closed = false;
      let disarm: (() => void) | undefined;
      const finish = (aborted: boolean): void => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        disarm?.();
        signal?.removeEventListener("abort", onAbort);
        if (aborted) reject(signal?.reason);
        else resolve();
      };
      const onAbort = (): void => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      signal?.addEventListener("abort", onAbort);
      disarm = arm?.(() => finish(false));
    });
  }
}

/**
 * The session's settle. Module state on purpose, unlike readback's ParamSource:
 * there is one device link and one notify stream behind it, and its two ends sit on
 * opposite sides of the app's one direction of travel — follow.ts sees every notify
 * (device → plan), live.ts does the writing (plan → device). Nothing in the import
 * graph forbids joining them (follow.ts already type-imports live.ts); what a hook
 * would cost is the interfaces. The notify stream would have to be handed down through
 * LiveSyncHooks to reach a caller that has no other use for it, and every test
 * constructing one would have to supply it. A shared module is the smaller statement:
 * the writer names the settle, the follow feeds it, and neither learns anything about
 * the other — including the repair, which travels back the same way.
 */
export const writeSettle = new WriteSettle();
