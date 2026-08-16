// A timestamped ring buffer over the MIDI bridge, dev builds only.
//
// The console trace (`localStorage["urx-midi-log"]`) already prints every rx / tx and
// the engine's per-message decision, but it prints them without a clock — and the
// question this exists for is a GAP: how long after the app transmits does the
// controller answer, and does that answer land before or after incoming MIDI stops
// being refused. A console stream cannot be measured; a buffer of `performance.now()`
// stamps can, and it is the same clock the engine runs on (`EngineHooks.now`), so the
// two can never disagree about when something happened.
//
// It records the silences too. A send the port state swallowed and a feedback pass
// that returned before emitting anything both look exactly like "nothing happened"
// from outside, and telling those apart from "sent, no reply" is most of the work.
//
// Recording is unconditional in a dev build rather than behind the trace flag: an
// entry costs 0.08 µs (measured), which is four orders of magnitude below the gap it
// exists to report, and a probe that has to be armed before the run is a probe that is
// not there when the run happens.
//
// Statically dropped from a production build (`import.meta.env.DEV`); ci.yml greps the
// bundle for `__urxMidiProbe` to keep it dropped.
//
// The ring answers "what just happened"; the FILE below answers "what happened the time
// it went wrong", and they are different questions because the symptom this was built
// for spans a page load. The ring lives in page memory, so a reload — which in
// `tauri dev` is every HMR edit — empties it at exactly the moment being investigated,
// and `performance.now()` restarts with it, so two pages' entries cannot be ordered
// against each other by the ring's own clock. Each record therefore carries an epoch
// stamp as well, taken through `performance.timeOrigin`.

import { addrLabel } from "../core/midi/mapping";
import { decodeMessage } from "../core/midi/message";
import { appendMidiLog, isTauri } from "../core/platform";

export type MidiProbeKind = "tx" | "tx-dropped" | "rx" | "note" | "mark";

export interface MidiProbeEntry {
  /** performance.now() at the moment the app saw it. */
  t: number;
  kind: MidiProbeKind;
  /** Decoded message, engine decision line, or mark label. */
  text: string;
  /** Raw bytes, for tx / rx entries. */
  bytes?: number[];
}

/** What `MidiControl` records into. Null outside a dev build. */
export interface MidiProbe {
  mark(label: string): void;
  tx(bytes: number[]): void;
  /** A send the port state swallowed — the silence that reads as "nothing was sent". */
  txDropped(bytes: number[], reason: string): void;
  rx(bytes: number[]): void;
  /** One engine decision (apply / ignore / drop echo / refuse), or a pass outcome. */
  note(message: string): void;
}

/** What `window.__urxMidiProbe` offers. Exported so the handle and the test that pins
 *  it cannot be renamed apart — the same contract `KeyProbe` has with keyprobe.test. */
export interface MidiProbeHandle {
  clear(): void;
  mark(label: string): void;
  entries(): MidiProbeEntry[];
  report(): string;
  /** Write the queued records to the trace file now, instead of waiting out the batch
   *  window — so the file is current before it is read from outside the app. */
  flush(): void;
}

// A live-sync start emits one burst and provokes at most a burst back; a drag on a
// controller is dozens a second. This holds several minutes of either.
const CAPACITY = 4000;

const log: MidiProbeEntry[] = [];

function push(kind: MidiProbeKind, text: string, bytes?: number[]): void {
  if (log.length >= CAPACITY) log.shift();
  const entry: MidiProbeEntry = { t: performance.now(), kind, text, ...(bytes ? { bytes: [...bytes] } : {}) };
  log.push(entry);
  toSink(entry);
}

/**
 * One entry as its file record. `ms` is the wall clock, which is the only field two page
 * loads can be ordered by; `t` is kept beside it because `ms` is rounded to whole
 * milliseconds, so on an engine whose clock resolves finer than that — jsdom and Chromium
 * do, the macOS webview does not — `t` is the only field that keeps the difference.
 *
 * `JSON.stringify` is what keeps a detail's own newline or control character from
 * reaching the file as one: the shell refuses the WHOLE batch over a control character
 * (`log_line_ok`), so an unescaped one would cost the surrounding records too.
 */
function traceLine(e: MidiProbeEntry): string {
  return JSON.stringify({
    ms: Math.round(performance.timeOrigin + e.t),
    t: Number(e.t.toFixed(3)),
    k: e.kind,
    d: e.text,
  });
}

// Long enough that a controller sweep — dozens of messages a second — batches rather
// than putting a round trip behind each message, short enough that the tail a reload
// takes with it is a fraction of a second. What marks the boundary itself is the
// `page:open` record the NEXT page writes, which does not depend on this landing.
const FLUSH_MS = 250;

const pending: string[] = [];
let flushTimer = 0;
let started = false;
/** Where the records are going, once a batch has landed and the shell has said. */
let tracePath: string | null = null;
/** When the sink gave up, and on what. Non-null means nothing more is being written. */
let traceStopped: { t: number; reason: string } | null = null;

// The sink's own status is held here rather than pushed into the ring as entries. The
// ring is the record of what crossed the MIDI bridge, and `report()` tallies it by kind;
// two rows describing the INSTRUMENT would be counted among the messages it measures.
// `report()`'s trailer prints both instead, which is where it already states derived
// facts rather than rows.
function toSink(entry: MidiProbeEntry): void {
  if (!started || traceStopped) return;
  pending.push(traceLine(entry));
  if (flushTimer) return;
  flushTimer = window.setTimeout(flush, FLUSH_MS);
}

/**
 * Hand the queued records to the shell.
 *
 * A batch that is refused gives the sink up rather than retrying it: `pending` is the
 * only thing holding those lines, and re-queueing a failing write grows it for as long
 * as the app runs. The give-up is timestamped and printed by `report()`, so a file that
 * stopped mid-run is distinguishable from one that simply ends.
 */
function flush(): void {
  window.clearTimeout(flushTimer);
  flushTimer = 0;
  if (!pending.length || traceStopped) return;
  const batch = pending.splice(0, pending.length);
  void appendMidiLog(batch).then(
    (path) => {
      tracePath = path;
    },
    (err: unknown) => {
      pending.length = 0;
      traceStopped = { t: performance.now(), reason: err instanceof Error ? err.message : String(err) };
    },
  );
}

/**
 * Begin writing the ring to the trace file, and mark this page's first record.
 *
 * Called when the MIDI bridge is constructed rather than when this module is imported:
 * an import-time `invoke` is a side effect every future importer inherits, and a unit
 * that merely reads the probe's types would perform IPC by loading it. The bridge is
 * also the only thing that feeds the ring, so nothing is recorded before this runs.
 *
 * The `pagehide` flush is best-effort and deliberately not what the page boundary rests
 * on: a dying page's IPC is not guaranteed to leave before the webview is torn down,
 * which is the same reason the shell's own session teardown is native (lib.rs
 * `on_page_load`). What bounds a reload's lost tail is FLUSH_MS; what marks the boundary
 * is the `page:open` record the next page writes.
 */
function start(): void {
  // The browser dev server is also `import.meta.env.DEV` and has no shell to write
  // through; asking here rather than letting the first flush fail keeps that session
  // from opening with a give-up about a file it was never going to have.
  if (started || !isTauri()) return;
  started = true;
  recorder.mark("page:open");
  window.addEventListener("pagehide", flush);
}

/** One line per message, through the app's own decoder and the assignment list's own
 *  address wording — a second vocabulary here would let a probe line and the row for
 *  the same address read differently. */
function describe(bytes: number[]): string {
  const ev = decodeMessage(bytes);
  if (!ev) return `raw [${bytes.join(" ")}]`;
  if (ev.type === "cc")
    return `${addrLabel({ type: "cc", channel: ev.channel, controller: ev.controller })} = ${ev.value}`;
  if (ev.type === "note")
    return `${addrLabel({ type: "note", channel: ev.channel, note: ev.note })} ${ev.on ? "on" : "off"}`;
  return `${addrLabel({ type: "pitchbend", channel: ev.channel })} = ${ev.value}`;
}

const recorder: MidiProbe = {
  mark: (label) => push("mark", label),
  tx: (bytes) => push("tx", describe(bytes), bytes),
  txDropped: (bytes, reason) => push("tx-dropped", `${describe(bytes)} (${reason})`, bytes),
  rx: (bytes) => push("rx", describe(bytes), bytes),
  note: (message) => push("note", message),
};

/** The recorder, or null in a production build — so every call site is a `?.` that
 *  folds away with it, the shape `traceProbe` already has in main.ts. */
export const midiProbe: MidiProbe | null = import.meta.env.DEV ? recorder : null;

/**
 * The log as text: absolute ms from the first entry, the delta from the previous
 * entry, then per-mark measurements. The per-mark trailer is what decides a gate
 * length — for each mark it prints how many messages went out before the next one and
 * how long after it the first incoming message arrived. That reply is looked for past
 * the next mark on purpose: the whole point is that it can land after the app has
 * moved on, which is where the marks around a Live-sync start put it.
 */
function report(): string {
  if (log.length === 0) return "(no entries)";
  // How many decimals this run's clock earns. The engine's clock is `performance.now()`,
  // and **the shipping webview clamps it to whole milliseconds** — measured on macOS
  // WKWebView (2026-08-16): 419 records over five launches, not one carrying a fraction.
  // jsdom and Chromium keep sub-millisecond values, so the same report is read at two
  // resolutions, and a fixed two decimals prints `.00` on every line of a real-device run
  // — a precision the reading does not have, in the one report whose whole subject is how
  // long a gap was. Read off the records rather than off the engine, so it describes the
  // run being printed rather than the environment the reader is assumed to be in.
  const dp = log.some((e) => !Number.isInteger(e.t)) ? 2 : 0;
  const fmt = (ms: number): string => ms.toFixed(dp).padStart(9);
  const t0 = log[0].t;
  const counts: Record<string, number> = {};
  const marks: Array<{ at: number; text: string; tx: number; dropped: number; rx?: MidiProbeEntry }> = [];
  const rows: string[] = [];
  // One pass: the rows, the kind tally, and every mark's window. `open` is the mark
  // still counting sends; a reply is filled in for every mark that has not seen one.
  let open: (typeof marks)[number] | undefined;
  for (const [i, e] of log.entries()) {
    rows.push(`${fmt(e.t - t0)} ${fmt(i === 0 ? 0 : e.t - log[i - 1].t)}  ${e.kind.padEnd(10)} ${e.text}`);
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    if (e.kind === "mark") marks.push((open = { at: e.t, text: e.text, tx: 0, dropped: 0 }));
    else if (e.kind === "tx" && open) open.tx++;
    else if (e.kind === "tx-dropped" && open) open.dropped++;
    else if (e.kind === "rx") for (const m of marks) m.rx ??= e;
  }
  const summary = Object.entries(counts)
    .map(([k, n]) => `${k}=${n}`)
    .join("  ");
  const trailer = marks.map(
    (m) =>
      `  ${m.text}: tx=${m.tx} dropped=${m.dropped}, ` +
      (m.rx ? `first rx +${(m.rx.t - m.at).toFixed(dp)} ms (${m.rx.text})` : "no rx after it"),
  );
  // Said once, above the numbers it qualifies. Stated as the EVIDENCE rather than as a
  // verdict about the engine, and the count is what keeps that honest: a report typed in
  // before any traffic holds one record, and one integral timestamp decides nothing —
  // Chromium coarsens to a fraction of a millisecond rather than to none, so a short ring
  // there comes out integral by chance.
  if (!dp) {
    trailer.unshift(
      `  clock: ${log.length} records, none carrying a sub-millisecond value` +
        ` — read a 0 ms gap as "shorter than this clock" rather than as zero`,
    );
  }
  // Where the file is, and whether it is still being written. A run whose sink gave up
  // holds fewer records than the ring does, and without this the file simply ends —
  // which is indistinguishable from the app having stopped there.
  if (traceStopped)
    trailer.push(`  trace file: STOPPED at ${fmt(traceStopped.t - t0).trim()} ms — ${traceStopped.reason}`);
  else if (tracePath) trailer.push(`  trace file: ${tracePath}`);
  else if (started) trailer.push("  trace file: no batch has landed yet");
  return [`    t(ms)    Δ(ms)  kind       detail`, ...rows, "", `-- ${summary} --`, ...trailer].join("\n");
}

if (import.meta.env.DEV) {
  const handle: MidiProbeHandle = {
    clear: () => {
      log.length = 0;
    },
    mark: (label) => recorder.mark(String(label)),
    entries: () => log.map((e) => ({ ...e })),
    report,
    flush,
  };
  (window as unknown as { __urxMidiProbe?: MidiProbeHandle }).__urxMidiProbe = handle;
}

/** Start the trace file, or null in a production build — the same `?.` shape as
 *  `midiProbe`, so the whole sink folds away with the recorder. */
export const startMidiTrace: (() => void) | null = import.meta.env.DEV ? start : null;
