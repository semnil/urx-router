// A watch over device parameters the app neither reads nor writes, dev builds only.
//
// While Live sync holds the connection it registers a handful of addresses as a
// subscription of its own (`vd_probe_subscribe` — never through the follow layer's set,
// which stays exactly what the plan names) and reads the same addresses again one second
// after each round of reads ends, so a change the unit announces and a change it does not
// both land. Every change goes
// to `param-watch.jsonl` in the app's log directory with the wall clock, which is what
// lets an intermittent change be put beside what the operator was doing at that moment.
//
// It writes nothing to the unit. What it records:
//   start   — the session's first reading of every watched address
//   notify  — every notify on a watched address, with the value it replaced (equal values
//             included: an announcement of an unchanged value is itself a record)
//   poll    — a GET that found a value other than the last one known
//   bulk    — the broker's namespace-wide change push (a scene recall)
//   alive   — once a minute: polls, failed polls, watched notifies and clock notifies
//             since the previous line, so "nothing changed" and "the stream died" read
//             differently on a model whose clock runs
//   poll-error / poll-ok — the first failure of a run of failed reads, and the recovery
//   subscribe-error — the registration was refused; the poll carries on without it
//   stop    — the session ended, and why
//
// Statically dropped from a production build (`import.meta.env.DEV`); ci.yml greps the
// bundle for `__urxParamWatch` to keep it dropped, and the shell refuses both of its
// commands in a release binary.

import { appendWatchLog, isTauri, vdGet, vdProbeSubscribe, type ParamUpdate } from "../core/platform";
import { createTraceSink } from "./trace-sink";

/** The addresses recorded, `[paramId, x, y]`. 838 is the subject; 817 (operation mode)
 *  and 781 / 863 (the preset indices) are the context it is read against. */
export const WATCHED: ReadonlyArray<readonly [number, number, number]> = [
  [838, 0, 0],
  [817, 0, 0],
  [781, 0, 0],
  [863, 0, 0],
];

/** The unit's clock parameters. Registered beside the watched set and counted rather
 *  than recorded. On a model whose clock runs (URX44V / URX44) they arrive every few
 *  seconds, so a minute with none says the notify stream itself has gone quiet; the
 *  URX22's clock does not run and its count stays 0. */
export const CLOCK: ReadonlyArray<readonly [number, number, number]> = [789, 790, 791, 792, 793, 794].map(
  (id) => [id, 0, 0] as const,
);

export const POLL_MS = 1000;
export const ALIVE_MS = 60_000;
/** Records are rare, so the batch window only has to keep a burst of notifies to one write. */
const FLUSH_MS = 250;
/** The in-page copy `report()` prints; the file is the complete record. */
const CAPACITY = 2000;

export interface ParamWatch {
  /** Begin watching on the connection Live sync has just brought up. `onReadError` is
   *  handed every failed read, so the session's owner can end a session whose link a
   *  read found dead; the watch itself carries on reading until `stop`. */
  start(model: string, onReadError?: (err: unknown) => void): void;
  /** Stop polling and ignore what the subscription still delivers. The registration
   *  itself ends with the connection. */
  stop(reason: string): void;
}

/** What `window.__urxParamWatch` offers. */
export interface ParamWatchHandle {
  /** The records this page has produced, as written to the file. */
  records(): Array<Record<string, unknown>>;
  report(): string;
  /** Write the queued records to the file now instead of waiting out the batch window. */
  flush(): void;
}

const key = (id: number, x: number, y: number): string => `${id}:${x}:${y}`;
const watchedKeys = new Set(WATCHED.map(([id, x, y]) => key(id, x, y)));
const clockKeys = new Set(CLOCK.map(([id, x, y]) => key(id, x, y)));

/** Local wall-clock time with its UTC offset, the form the operator's own notes use. */
function localStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}` +
    `${sign}${p(Math.floor(Math.abs(offsetMin) / 60))}:${p(Math.abs(offsetMin) % 60)}`
  );
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const ring: Array<Record<string, unknown>> = [];
const sink = /* @__PURE__ */ createTraceSink(appendWatchLog, FLUSH_MS);

function record(kind: string, fields: Record<string, unknown> = {}): void {
  const ms = Date.now();
  const entry = { ms, at: localStamp(ms), k: kind, ...fields };
  if (ring.length >= CAPACITY) ring.shift();
  ring.push(entry);
  sink.push(entry);
}

/** One session's state. Replaced on every start, so a late answer from an earlier
 *  session compares unequal and is dropped. */
interface Session {
  last: Map<string, number | string>;
  /** Notifies applied per address. A read that saw this move while it was in flight
   *  started before the notify landed, so its value is dropped rather than applied. */
  notified: Map<string, number>;
  onReadError?: (err: unknown) => void;
  pollTimer: number;
  aliveTimer: number;
  polls: number;
  pollErrors: number;
  notifies: number;
  clock: number;
  failing: boolean;
}

let session: Session | null = null;

function snapshot(s: Session): Record<string, number | string> {
  return Object.fromEntries(WATCHED.map(([id, x, y]) => [key(id, x, y), s.last.get(key(id, x, y)) ?? "unknown"]));
}

function onNotify(s: Session, p: ParamUpdate): void {
  if (session !== s) return;
  if (p.x < 0) {
    record("bulk");
    return;
  }
  const k = key(p.paramId, p.x, p.y);
  if (clockKeys.has(k)) {
    s.clock++;
    return;
  }
  if (!watchedKeys.has(k)) return;
  s.notifies++;
  s.notified.set(k, (s.notified.get(k) ?? 0) + 1);
  const to = p.valueStr ?? p.value;
  record("notify", { addr: k, from: s.last.get(k) ?? "unknown", to });
  s.last.set(k, to);
}

/**
 * Read every watched address once, handing each value to `apply` as soon as it arrives.
 * A value whose address took a notify while the read was in flight is dropped: the
 * notify is the newer of the two. Returns false when the session ended under it.
 */
async function readAll(s: Session, apply: (k: string, v: number) => void): Promise<boolean> {
  for (const [id, x, y] of WATCHED) {
    const k = key(id, x, y);
    const before = s.notified.get(k) ?? 0;
    let v: number;
    try {
      v = await vdGet(id, x, y);
    } catch (err) {
      if (session !== s) return false;
      s.pollErrors++;
      if (!s.failing) record("poll-error", { addr: k, error: errorText(err) });
      s.failing = true;
      s.onReadError?.(err);
      if (session !== s) return false;
      continue;
    }
    if (session !== s) return false;
    if (s.failing) record("poll-ok", { addr: k });
    s.failing = false;
    if ((s.notified.get(k) ?? 0) === before) apply(k, v);
  }
  return true;
}

async function poll(s: Session): Promise<void> {
  const read = await readAll(s, (k, v) => {
    const from = s.last.get(k);
    if (from !== v) record("poll", { addr: k, from: from ?? "unknown", to: v });
    s.last.set(k, v);
  });
  if (!read) return;
  s.polls++;
  s.pollTimer = window.setTimeout(() => void poll(s), POLL_MS);
}

function alive(s: Session): void {
  if (session !== s) return;
  record("alive", {
    polls: s.polls,
    pollErrors: s.pollErrors,
    notifies: s.notifies,
    clock: s.clock,
    values: snapshot(s),
  });
  s.polls = s.pollErrors = s.notifies = s.clock = 0;
}

async function begin(s: Session, model: string): Promise<void> {
  record("open", { model, watched: [...watchedKeys], clock: [...clockKeys] });
  try {
    await vdProbeSubscribe(
      [...WATCHED, ...CLOCK].map(([id, x, y]) => [id, x, y]),
      (p) => onNotify(s, p),
    );
  } catch (err) {
    if (session !== s) return;
    record("subscribe-error", { error: errorText(err) });
  }
  if (session !== s) return;
  if (!(await readAll(s, (k, v) => s.last.set(k, v)))) return;
  record("start", { values: snapshot(s) });
  s.aliveTimer = window.setInterval(() => alive(s), ALIVE_MS);
  s.pollTimer = window.setTimeout(() => void poll(s), POLL_MS);
}

function start(model: string, onReadError?: (err: unknown) => void): void {
  if (!isTauri()) return;
  if (session) stop("restart");
  sink.open();
  const s: Session = {
    last: new Map(),
    notified: new Map(),
    onReadError,
    pollTimer: 0,
    aliveTimer: 0,
    polls: 0,
    pollErrors: 0,
    notifies: 0,
    clock: 0,
    failing: false,
  };
  session = s;
  void begin(s, model);
}

function stop(reason: string): void {
  const s = session;
  if (!s) return;
  session = null;
  window.clearTimeout(s.pollTimer);
  window.clearInterval(s.aliveTimer);
  record("stop", { reason, values: snapshot(s) });
  sink.flush();
}

/** The records as one line each, then where the file is and whether it is still written. */
function report(): string {
  const rows = ring.map((r) => {
    const { at, k, ...rest } = r;
    delete rest.ms;
    return `${String(at)}  ${String(k).padEnd(15)} ${JSON.stringify(rest)}`;
  });
  const file = sink.status();
  const trailer =
    file.state === "stopped"
      ? `trace file: STOPPED — ${file.reason}`
      : file.state === "writing"
        ? `trace file: ${file.path}`
        : "trace file: no batch has landed yet";
  return [...rows, "", trailer].join("\n");
}

const watcher: ParamWatch = { start, stop };

/** The watch, or null in a production build — every call site is a `?.` that folds
 *  away with it. */
export const paramWatch: ParamWatch | null = import.meta.env.DEV ? watcher : null;

if (import.meta.env.DEV) {
  const handle: ParamWatchHandle = {
    records: () => ring.map((r) => ({ ...r })),
    report,
    flush: sink.flush,
  };
  (window as unknown as { __urxParamWatch?: ParamWatchHandle }).__urxParamWatch = handle;
}
