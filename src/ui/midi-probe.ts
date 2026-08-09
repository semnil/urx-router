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

import { addrLabel } from "../core/midi/mapping";
import { decodeMessage } from "../core/midi/message";

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
}

// A live-sync start emits one burst and provokes at most a burst back; a drag on a
// controller is dozens a second. This holds several minutes of either.
const CAPACITY = 4000;

const log: MidiProbeEntry[] = [];

function push(kind: MidiProbeKind, text: string, bytes?: number[]): void {
  if (log.length >= CAPACITY) log.shift();
  log.push({ t: performance.now(), kind, text, ...(bytes ? { bytes: [...bytes] } : {}) });
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

const fmt = (ms: number): string => ms.toFixed(2).padStart(9);

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
      (m.rx ? `first rx +${(m.rx.t - m.at).toFixed(2)} ms (${m.rx.text})` : "no rx after it"),
  );
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
  };
  (window as unknown as { __urxMidiProbe?: MidiProbeHandle }).__urxMidiProbe = handle;
}
