import { BULK_CHANGE, type TraceEvent } from "./fake-device";

// Offline analyzer for the race harness. It decides the invariants that are
// answerable from the one ordered trace the fake device produces (plus the marks the
// driver stamps into it) — no probe into the app's module scope is needed for these,
// because each one is a statement about IPC that either happened or did not.
//
// The invariants that DO need module state (the plan-key write ledger behind
// "authorship attribution", the snapshot contents behind "snapshot poisoning" in its
// general form) are not implemented here; see docs/{en,ja}/live-race-harness.md.

/** The sentinel's trace address. It belongs to no registered address, so invariant 6's
 *  registration clause must not judge it. */
const BULK_CHANGE_ADDR = BULK_CHANGE.slice(0, 3).join(":");

/** One plan-key write as the trace build's probe recorded it (src/ui/trace-probe.ts). */
export interface LedgerEntry {
  seq: number;
  t: number;
  source: string;
  field: string;
  key?: string;
  subKeys?: string[];
}

export interface Finding {
  /** Invariant number from the design document. */
  inv: number;
  /**
   * What KIND of question the finding answers, which the number cannot carry: invariant
   * 6 alone spans all three. "product" = the app misbehaved, "case" = the case may have
   * measured nothing, "harness" = the harness contradicted itself. Absent means
   * "product", which every invariant but 6 is.
   */
  class?: "product" | "case" | "harness";
  name: string;
  detail: string;
  /** Trace time of the decisive event, ms. */
  at?: number;
}

/** One operator edit the driver declares, so the analyzer can look for its fate. */
export interface DeclaredEdit {
  label: string;
  /** "paramId:x:y" the edit is expected to reach. */
  addr: string;
  /** Trace time the gesture was made (from a mark). */
  at: number;
  /** Optional: the exact value expected on the wire. */
  value?: number;
}

export interface AnalyzeSpec {
  edits?: DeclaredEdit[];
  /** Addresses whose vd_set order is load-bearing, first to last. */
  order?: string[];
  /** The registration set captured at the moment the notifies were pushed. */
  registration?: Array<[number, number, number]>;
  /**
   * Window (trace ms) the address-set check may look at. The registration is a
   * SNAPSHOT of one instant, while writes span the whole run, so comparing every
   * write ever issued against an end-of-run snapshot counts writes that were
   * perfectly well registered when they were sent. Give the window the snapshot
   * describes, or invariant 12 reports an artefact. Omitted = the whole run, which is
   * only correct when the registration did not change during it.
   */
  registrationWindow?: { from: number; to?: number };
  /**
   * Addresses ("paramId:x:y") whose refusal IS the case's subject. Invariant 6's clause
   * A fires on every notify the bridge refused, which is exactly right when the refusal
   * was accidental and exactly wrong when the case pushed the notify to measure the
   * refusal itself — the report would then name the assertion the case just made as a
   * finding, and a clean report would stop meaning clean. Listed here, the drop is
   * subtracted from clause A and stays visible in the timeline.
   */
  expectedDrops?: string[];
  /**
   * The plan-key write ledger from the trace build's probe (window.__urxTrace), and
   * the live snapshot. Both are needed for the invariants the IPC log alone cannot
   * decide.
   */
  ledger?: LedgerEntry[];
  /**
   * "paramId:x:y" → value, as the live snapshot holds it. Its KEY SET is the emitted
   * address set, so invariant 6's clause B pairs it with `registration` — which makes
   * the reading instant load-bearing: capture it at the SAME instant as the
   * registration, not at the end of a run whose registration was taken mid-way.
   * `registrationWindow` cannot repair a mismatched pair, since clause B is a state
   * predicate rather than a scan over events. Invariant 3 is indifferent to the
   * instant: it only looks up addresses `edits` already names.
   */
  snapshot?: Record<string, number> | null;
  /** Mark detail after which no IPC may occur. */
  quiesceAfter?: string;
}

const isStart = (e: TraceEvent): boolean => e.kind === "ipc-start";

/** Pair each ipc-start with its ipc-end, giving a closed interval per command. */
export interface Span {
  cmd: string;
  addr?: string;
  value?: number;
  start: number;
  end: number;
  seq: number;
  /** The ipc-end's own seq, +inf while the command is still in flight. `t` ties are
   *  routine (fake-device.ts), so an interval boundary is only exact in seq. */
  endSeq: number;
  detail?: string;
}

export function spans(trace: TraceEvent[]): Span[] {
  const open = new Map<number, TraceEvent>();
  const out: Span[] = [];
  for (const e of trace) {
    if (isStart(e)) open.set(e.seq, e);
    else if (e.kind === "ipc-end" && e.of !== undefined) {
      const s = open.get(e.of);
      if (!s) continue;
      open.delete(e.of);
      out.push({
        cmd: s.cmd!,
        addr: s.addr,
        value: s.value,
        start: s.t,
        end: e.t,
        seq: s.seq,
        endSeq: e.seq,
        detail: e.detail,
      });
    }
  }
  // A command still in flight when the trace was dumped: keep it, ended at +inf, so a
  // "still reading when the edit landed" case is not silently dropped.
  for (const s of open.values()) {
    out.push({
      cmd: s.cmd!,
      addr: s.addr,
      value: s.value,
      start: s.t,
      end: Number.POSITIVE_INFINITY,
      seq: s.seq,
      endSeq: Number.POSITIVE_INFINITY,
    });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/**
 * A boundary a trace position is compared against: a millisecond, plus the `seq` that
 * produced it when the boundary is itself a trace event.
 *
 * `performance.now()` ties are routine and `seq` is what carries the order
 * (fake-device.ts), so a plain `t` comparison decides every tie on the LENIENT side —
 * an edit stamped in the same millisecond as the read that overtook it reads as clean.
 * Marks are trace events and `markTime` returns a mark's own `t`, so the reverse lookup
 * below is exact; a case-computed offset (a mark time plus 50 ms, say) matches no event
 * and keeps the numeric comparison, which is the only thing available for it.
 */
interface Bound {
  t: number;
  seq?: number;
}

const boundAt = (trace: TraceEvent[], t: number): Bound => {
  const m = trace.find((e) => e.kind === "mark" && e.t === t);
  return m ? { t, seq: m.seq } : { t };
};

/** True when the trace position (t, seq) is strictly before the boundary. */
const beforeBound = (t: number, seq: number, b: Bound): boolean =>
  t !== b.t ? t < b.t : b.seq !== undefined ? seq < b.seq : false;

/** True when the trace position (t, seq) is strictly after the boundary. */
const afterBound = (t: number, seq: number, b: Bound): boolean =>
  t !== b.t ? t > b.t : b.seq !== undefined ? seq > b.seq : false;

export const marksOf = (trace: TraceEvent[]): TraceEvent[] => trace.filter((e) => e.kind === "mark");

export const markTime = (trace: TraceEvent[], detail: string): number | undefined =>
  trace.find((e) => e.kind === "mark" && e.detail === detail)?.t;

export const setsOf = (trace: TraceEvent[]): Span[] => spans(trace).filter((s) => s.cmd === "vd_set");

export const getsOf = (trace: TraceEvent[]): Span[] => spans(trace).filter((s) => s.cmd === "vd_get");

export function analyze(trace: TraceEvent[], spec: AnalyzeSpec = {}): Finding[] {
  const out: Finding[] = [];
  const all = spans(trace);
  const sets = all.filter((s) => s.cmd === "vd_set");
  const gets = all.filter((s) => s.cmd === "vd_get");

  // Every edit's `at` is a mark time, so it resolves to the mark's own seq and a tie
  // between the gesture and the command it raced is decided by order rather than by the
  // millisecond both share.
  const editBounds = new Map<DeclaredEdit, Bound>((spec.edits ?? []).map((e) => [e, boundAt(trace, e.at)]));

  // 1 — stale-read overwrite. A read of the edited address that began BEFORE the
  // gesture and resolved AFTER it answers a pre-edit value that the readback then
  // writes into the plan on top of the operator's own.
  for (const e of spec.edits ?? []) {
    const b = editBounds.get(e)!;
    const straddling = gets.filter(
      (g) => g.addr === e.addr && beforeBound(g.start, g.seq, b) && afterBound(g.end, g.endSeq, b),
    );
    if (straddling.length) {
      out.push({
        inv: 1,
        name: "stale-read overwrite",
        detail: `${e.label}: a read of ${e.addr} started at ${straddling[0].start.toFixed(0)} ms, before the edit at ${e.at.toFixed(0)} ms, and resolved at ${straddling[0].end.toFixed(0)} ms`,
        at: e.at,
      });
    }
  }

  // 2 — lost edit. The gesture changed the plan; nothing carrying it ever left.
  for (const e of spec.edits ?? []) {
    const b = editBounds.get(e)!;
    const after = sets.filter((s) => s.addr === e.addr && !beforeBound(s.start, s.seq, b));
    const carried = e.value === undefined ? after : after.filter((s) => s.value === e.value);
    if (!carried.length) {
      out.push({
        inv: 2,
        name: "lost edit",
        detail: `${e.label}: no vd_set for ${e.addr}${e.value === undefined ? "" : ` = ${e.value}`} after ${e.at.toFixed(0)} ms`,
        at: e.at,
      });
    }
  }

  // 4 — interval overlap. Two of flush / refetch / scoped reconcile / full reconcile /
  // Fetch / Write in flight at the same time: two descriptions of one device, live at
  // once, over a link that answers them in an order neither of them chose.
  //
  // ANY intersecting pair counts, not just "a write issued inside a read". The narrower
  // form was blind to the two same-kind intersections — two readbacks overlapping (the
  // reconcile-during-reconcile shape) and two send loops overlapping (a flush landing
  // inside a Write) — and a case that wanted them had to grow a private overlap counter
  // beside the analyzer. Kinds are reported separately because they are different
  // events: read-write is the stale-read hazard, read-read is a doubled sweep,
  // write-write is two writers on one address space. One report per kind — a burst of
  // them shares its cause, which is the pair named here.
  //
  // Decided in seq: both edges are trace events, and at equal `t` the issue order is the
  // whole question.
  const rw = all.filter((s) => s.cmd === "vd_get" || s.cmd === "vd_set");
  const overlapKind = (a: Span, b: Span): "read-write" | "read-read" | "write-write" =>
    a.cmd === b.cmd ? (a.cmd === "vd_get" ? "read-read" : "write-write") : "read-write";
  const seenKinds = new Set<string>();
  let live: Span[] = [];
  for (const s of rw) {
    // Everything still open when this command was ISSUED intersects it, by construction:
    // it started earlier and has not ended yet.
    live = live.filter((o) => o.endSeq > s.seq);
    for (const other of live) {
      const kind = overlapKind(other, s);
      if (seenKinds.has(kind)) continue;
      seenKinds.add(kind);
      out.push({
        inv: 4,
        name: "interval overlap",
        detail: `${kind}: ${s.cmd} ${s.addr} at ${s.start.toFixed(0)} ms issued inside an in-flight ${other.cmd} ${other.addr} (${other.start.toFixed(0)}–${other.end.toFixed(0)} ms)`,
        at: s.start,
      });
    }
    live.push(s);
  }

  // 6 — stimulus reachability, the grown window, and registration lag behind them. The
  // three share a number but not a kind of question, which is what `Finding.class`
  // carries. Clauses A and C are windowed for the same reason invariant 12 is: a notify
  // that arrived while a DIFFERENT set was registered is not evidence about this one.
  // Without a window this reports the artefact backwards. Clause B is not windowed at
  // all — see its own comment.
  // A window edge is usually a mark time, so it resolves to that mark's seq and an event
  // stamped in the same millisecond as the edge is placed by order rather than dropped
  // to whichever side the tie falls on.
  const w6 = spec.registrationWindow;
  const from6 = w6 ? boundAt(trace, w6.from) : undefined;
  const to6 = w6?.to === undefined ? undefined : boundAt(trace, w6.to);
  const inWindow6At = (t: number, seq: number): boolean =>
    (!from6 || !beforeBound(t, seq, from6)) && (!to6 || !afterBound(t, seq, to6));
  const inWindow6 = (e: TraceEvent): boolean => inWindow6At(e.t, e.seq);

  // A — stimulus reachability. The fake bridge refused a notify the case pushed, so
  // whatever that push was meant to provoke, the app never saw it: an absence verdict
  // resting on it holds for free. This is the clause that catches a case measuring
  // nothing — unless the refusal is what the case set out to measure, which it declares
  // through `expectedDrops`. Judged with no `registration` in hand, unlike B and C: the
  // refusal is a fact about the trace alone, so a case that pushes a stimulus and
  // captures no registration would otherwise lose the check entirely.
  const expectedDrops = new Set(spec.expectedDrops ?? []);
  for (const n of trace.filter((e) => e.kind === "notify-drop" && inWindow6(e))) {
    if (n.addr && expectedDrops.has(n.addr)) continue;
    out.push({
      inv: 6,
      class: "case",
      name: "stimulus reachability",
      detail: `the case pushed a stimulus the bridge refused: notify on ${n.addr} at ${n.t.toFixed(0)} ms (${n.detail ?? "refused"})`,
      at: n.t,
    });
  }

  if (spec.registration) {
    const reg = new Set(spec.registration.map((a) => a.join(":")));

    // B — the grown window. The live snapshot's KEY SET is the emitted address set:
    // capture() rebuilds it from planToCommands at begin / resync / after a converge or
    // refetch, and an address the plan has only just grown has no entry there, so the
    // first flush after the structural edit always sends it and records it. Subtracting
    // the registration therefore names every address the app is ACTIVELY WRITING whose
    // device-side change the bridge would drop — the mirror of invariant 12 and the more
    // dangerous direction, because follow.subscribe() re-posts only at begin() and after
    // a completed reconcile, so an app-side structural edit leaves the window open until
    // something reconciles.
    //
    // A STATE predicate over two same-instant readings, not a scan over events, so
    // `registrationWindow` does not apply and `snapshot` must be read beside
    // `registration` (see that field). The write-based form was rejected because
    // invariant 12 already computes it, and because it is wrong in both directions as a
    // state reading: it goes silent once the grow-flush leaves the window while the
    // window is still open, and keeps reporting a window a later capture() has closed.
    //
    // WHAT A CLEAN VERDICT DOES NOT SAY. It is not "the emitted set is inside the
    // registration" — the clause cannot see:
    //   - an address already in planToCommands but not yet flushed (the ≤120 ms flush
    //     gap, longer while a converge or refetch holds it): in neither reading. Let the
    //     flush run; an unflushed address is invariant 2's subject, not this one.
    //   - a window that has since CLOSED. The pair answers for its own instant only.
    //   - the string path (vd_set_str: channel names, Sweet Spot Data), which has no
    //     snapshot entry and no registration entry, so the clause is silent by
    //     construction — that stays a documented gap, not a finding.
    //   - planExternal params (SETUP > GENERAL), emitted by nothing and correctly
    //     invisible; and the meter registration, which is invariant 11's subject.
    //   - anything at all with no session: snapshotOf answers null and the clause is
    //     inert rather than reading "no keys" as "the app emits nothing".
    // The reverse difference is not judged: FOLLOW_USB (848) is appended to the
    // registration by hand and is in no snapshot, which is the harmless direction.
    if (spec.snapshot) {
      const grown = Object.keys(spec.snapshot).filter((a) => !reg.has(a));
      if (grown.length) {
        out.push({
          inv: 6,
          class: "product",
          name: "grown window",
          detail: `${grown.length} address(es) the plan emits but the ${reg.size}-address registration does not hold, so a device-side change to them is undeliverable until the next reconcile: ${grown.slice(0, 6).join(", ")}`,
        });
      }
    }

    // C — registration lag. A DELIVERED notify for an address outside the registration
    // snapshot. Since the bridge filter landed this can no longer be an observation
    // about the app: the only way to reach it is the sentinel (excluded — it belongs to
    // no address) or a registrationWindow scoped to the wrong instant. It is kept as a
    // harness self-check on the window the case supplied.
    const sentinel = BULK_CHANGE_ADDR;
    for (const n of trace.filter((e) => e.kind === "notify" && inWindow6(e))) {
      if (n.addr && n.addr !== sentinel && !reg.has(n.addr)) {
        out.push({
          inv: 6,
          class: "harness",
          name: "registration lag (harness self-check)",
          detail: `delivered notify on ${n.addr} at ${n.t.toFixed(0)} ms is outside the ${reg.size}-address registration this window claims`,
          at: n.t,
        });
      }
    }
  }

  // 8 — send ordering. A selector types the array after it, so the order binds meaning.
  //
  // The chain is carried ACROSS an address the run never wrote. Comparing adjacent pairs
  // and skipping any pair that touches a hole broke the order into disconnected segments:
  // for [A, B, C] with B never sent, a C-before-A inversion — the whole claim — was
  // invisible, because the only two comparisons available both touched B. Each written
  // element is compared against the last written one instead, so a hole is bridged
  // rather than ending the chain.
  if (spec.order && spec.order.length > 1) {
    let lastSeq = -1;
    let lastAddr = "";
    for (const addr of spec.order) {
      const seq = sets.find((s) => s.addr === addr)?.seq ?? -1;
      if (seq === -1) continue;
      if (lastSeq !== -1 && lastSeq > seq) {
        out.push({
          inv: 8,
          name: "send ordering",
          detail: `${lastAddr} was sent after ${addr}`,
        });
      }
      lastSeq = seq;
      lastAddr = addr;
    }
  }

  // 12 — address-set agreement. Every address written must be one the app also
  // registered for notifies, or a device-side change to it can never be followed.
  if (spec.registration) {
    const reg = new Set(spec.registration.map((a) => a.join(":")));
    const w = spec.registrationWindow;
    const inWindow = w ? sets.filter((s) => inWindow6At(s.start, s.seq)) : sets;
    const written = new Set(inWindow.map((s) => s.addr!).filter(Boolean));
    const orphan = [...written].filter((a) => !reg.has(a));
    if (orphan.length) {
      out.push({
        inv: 12,
        name: "address-set agreement",
        detail: `${orphan.length} address(es) written but not registered${w ? ` in ${w.from.toFixed(0)}–${(w.to ?? Number.POSITIVE_INFINITY).toFixed(0)} ms` : ""}: ${orphan.slice(0, 6).join(", ")}`,
      });
    }
  }

  // 3 — snapshot poisoning, general form. The live snapshot is supposed to hold what
  // the device was last told; an entry it holds for an address nothing ever sent is a
  // value the app believes is on the unit and never put there, so the next diff will
  // not send it either. Needs the probe: the sends are in the trace, the snapshot is
  // not. Only addresses the run actually touched are judged — the rest were captured
  // from a readback and are device truth by construction.
  if (spec.snapshot && spec.edits?.length) {
    for (const e of spec.edits) {
      const held = spec.snapshot[e.addr];
      if (held === undefined) continue;
      const b = editBounds.get(e)!;
      const sent = sets.filter((s) => s.addr === e.addr && !beforeBound(s.start, s.seq, b));
      if (!sent.length) {
        out.push({
          inv: 3,
          name: "snapshot poisoning",
          detail: `${e.label}: the live snapshot holds ${e.addr} = ${held}, but nothing carrying it was sent after ${e.at.toFixed(0)} ms — the next diff measures from a value the device was never given`,
          at: e.at,
        });
      }
    }
  }

  // 13 — authorship attribution. Every plan write must resolve to exactly one writer.
  // Two writers touching the same key inside one window is the shape every overtake in
  // this catalog takes, and it is invisible in the IPC log: the losing write leaves no
  // trace there at all.
  if (spec.ledger?.length) {
    const byKey = new Map<string, LedgerEntry[]>();
    for (const l of spec.ledger) {
      for (const sub of l.subKeys ?? [""]) {
        const id = `${l.field}${l.key === undefined ? "" : `[${l.key}]`}${sub ? `.${sub}` : ""}`;
        byKey.set(id, [...(byKey.get(id) ?? []), l]);
      }
    }
    for (const [id, list] of byKey) {
      const writers = new Set(list.map((l) => l.source));
      if (writers.size < 2) continue;
      const app = new Set(["ui", "midi", "undo"]);
      const device = new Set(["refetch", "follow-direct", "follow-scoped", "follow-full", "device-action"]);
      // An app writer and a device writer on one key is the contested case. Two app
      // writers (an edit then its undo) are ordinary.
      if (![...writers].some((w) => app.has(w)) || ![...writers].some((w) => device.has(w))) continue;
      const first = list[0];
      const lastW = list[list.length - 1];
      out.push({
        inv: 13,
        name: "authorship attribution",
        detail: `${id} was written by {${[...writers].join(", ")}} between ${first.t.toFixed(0)} and ${lastW.t.toFixed(0)} ms; the last writer was "${lastW.source}"`,
        at: lastW.t,
      });
    }
  }

  // 16 — teardown quiescence. Nothing may reach the device after the session ended.
  if (spec.quiesceAfter) {
    const t = markTime(trace, spec.quiesceAfter);
    if (t === undefined) {
      // The mark the check is anchored to is not in the trace — a renamed or misspelled
      // mark, or one the run never reached. Dropping the check silently made `report()`
      // print "clean" and every `findings.filter(f => f.inv === 16)).toHaveLength(0)`
      // pass for free, which is the negative assertion this invariant exists to make.
      // Reported the way clause C reports a mis-scoped registrationWindow: the harness
      // contradicted itself, so it is the harness that needs fixing.
      out.push({
        inv: 16,
        class: "harness",
        name: "quiesce mark missing",
        detail: `quiesceAfter names the mark "${spec.quiesceAfter}", which is not in this trace — nothing was checked`,
      });
    } else {
      const b = boundAt(trace, t);
      const late = all.filter(
        (s) => afterBound(s.start, s.seq, b) && s.cmd.startsWith("vd_") && s.cmd !== "vd_disconnect",
      );
      if (late.length) {
        out.push({
          inv: 16,
          name: "teardown quiescence",
          detail: `${late.length} device command(s) after "${spec.quiesceAfter}": ${late
            .slice(0, 4)
            .map((s) => `${s.cmd} ${s.addr ?? ""}`)
            .join(", ")}`,
          at: late[0].start,
        });
      }
    }
  }

  return out;
}

/** A compact human-readable timeline for the run log — the thing a person reads when
 *  an invariant fires and wants to know what the run actually did. */
export function timeline(trace: TraceEvent[], opts: { from?: number; limit?: number } = {}): string {
  const from = opts.from ?? 0;
  const rows: string[] = [];
  let getRun = 0;
  let getFrom = 0;
  const flushRun = (): void => {
    if (getRun > 1) rows.push(`${getFrom.toFixed(0).padStart(7)} ms  vd_get × ${getRun}`);
    else if (getRun === 1) rows.push(`${getFrom.toFixed(0).padStart(7)} ms  vd_get`);
    getRun = 0;
  };
  for (const e of trace) {
    if (e.t < from) continue;
    if (e.kind === "ipc-end") continue;
    // Meter traffic is deliberately absent from the timeline: a feed is continuous and
    // a row per reading would bury everything else. Skipped explicitly rather than left
    // to fall through the branches below, which would also break the "vd_get × N"
    // collapse in two around a drop and say nothing about why.
    if (e.kind === "meter-drop") continue;
    if (e.kind === "ipc-start" && e.cmd === "vd_get") {
      if (getRun === 0) getFrom = e.t;
      getRun++;
      continue;
    }
    flushRun();
    const t = e.t.toFixed(0).padStart(7);
    if (e.kind === "mark") rows.push(`${t} ms  ▸ ${e.detail}`);
    else if (e.kind === "notify") rows.push(`${t} ms  ← notify ${e.addr} = ${e.value}`);
    else if (e.kind === "notify-drop") rows.push(`${t} ms  ⃠ notify ${e.addr} = ${e.value} (${e.detail})`);
    else if (e.kind === "status") rows.push(`${t} ms  · status: ${e.detail}`);
    else if (e.kind === "subscribe") rows.push(`${t} ms  ⟳ subscribe (${e.detail} addrs)`);
    else if (e.kind === "ipc-start")
      rows.push(`${t} ms  → ${e.cmd} ${e.addr ?? ""}${e.value === undefined ? "" : ` = ${e.value}`}`);
  }
  flushRun();
  const limit = opts.limit ?? 120;
  return rows.length > limit
    ? [...rows.slice(0, limit / 2), `        …  (${rows.length - limit} rows omitted)`, ...rows.slice(-limit / 2)].join(
        "\n",
      )
    : rows.join("\n");
}

/** Heading per finding class, in the order the report prints them. A reader answers a
 *  different question for each: fix the app, fix the case, fix the harness. */
const CLASSES: ReadonlyArray<[NonNullable<Finding["class"]>, string]> = [
  ["product", "the app misbehaved"],
  ["case", "the case may have measured nothing"],
  ["harness", "the harness contradicted itself"],
];

export function report(title: string, findings: Finding[]): string {
  if (!findings.length) return `${title}: clean`;
  const lines = [`${title}: ${findings.length} finding(s)`];
  for (const [cls, heading] of CLASSES) {
    const inClass = findings.filter((f) => (f.class ?? "product") === cls);
    if (!inClass.length) continue;
    lines.push(`  ${cls} — ${heading}`);
    const byInv = new Map<number, Finding[]>();
    for (const f of inClass) byInv.set(f.inv, [...(byInv.get(f.inv) ?? []), f]);
    for (const [inv, list] of [...byInv].sort((a, b) => a[0] - b[0])) {
      lines.push(`    [${inv}] ${list[0].name}`);
      for (const f of list.slice(0, 4)) lines.push(`        ${f.detail}`);
      if (list.length > 4) lines.push(`        … ${list.length - 4} more`);
    }
  }
  return lines.join("\n");
}
