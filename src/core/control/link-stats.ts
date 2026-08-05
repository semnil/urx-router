// The link ledger: what one Live sync session asked of the Device Center broker,
// and what the broker failed to answer.
//
// Why these values and not the obvious ones. The symptom this exists for is Device
// Center needing a force quit after a long session, and nothing about that is visible
// as a slowdown — a broker can answer promptly right up to the moment its own teardown
// deadlocks. So round-trip latency, queue depth and feed rates are deliberately absent:
// they measure how the link FEELS from this side, which is not evidence about the
// broker's state. What is here is what this side DID to the broker, counted exactly:
// commands, subscription replacements, registration frames, full reads. Causes, not
// symptoms.
//
// The share of notifies the address filter drops was proposed for this and rejected,
// because it cannot measure what it looks like it measures. Registration and notify
// emission are decoupled on this protocol (measured: a registered address can change
// and announce nothing), and an address nobody moves emits nothing however many times
// it is registered — so a registration piling up at the broker is invisible in the
// inbound stream. See docs/{en,ja}/architecture.md "The link ledger".
//
// The ledger is written to a FILE as well as shown, and the file is the point: the
// symptom appears after the app is gone, so a reading that lives only in the status
// bar is gone exactly when it is wanted. It also outlives this one investigation —
// a later change in Device Center's behaviour shows up as a change in these numbers.

import { appBuildKind, appendLinkLog, vdLinkStats, type LinkStats } from "../platform";

/** One session's counts: the link's own (`LinkStats`, straight from the worker's
 *  atomics) plus the two only this side can know. **Extends** rather than restates, so
 *  a counter added in Rust reaches the log by arriving here, not by being copied into
 *  four places and forgotten in one.
 *
 *  Numbers only: `core/` is language-independent, so every label and every unit is
 *  applied by the UI layer over the keys below. */
export interface LinkLedger extends LinkStats {
  /** Milliseconds since the connection was opened. */
  upMs: number;
  /** Whole-device readbacks: the starting read plus every full reconcile. ~800
   *  commands each, which is why it is counted separately from the command total. */
  fullReads: number;
}

/** How a session ended, on the last line it wrote. Recorded because the question the
 *  log answers is which kind of ending precedes a Device Center that will not quit.
 *  There is deliberately no "the app exited" value: a dying page's IPC is not
 *  guaranteed to leave before the webview goes (the same reason lib.rs tears the
 *  session down natively), so the app's own exit is identified by its ABSENCE — a
 *  session whose last line carries no end reason is one that nothing closed. */
export type LinkSessionEnd = "off" | "error";

/** The rows the ledger panel prints, top to bottom. Exported as a union so a spec's
 *  expectation table is a `Record<LinkLedgerKey, …>` and a row added without a matching
 *  expectation fails to type-check rather than going untested. */
export const LINK_LEDGER_KEYS = ["up", "sent", "subscriptions", "frames", "reads", "noanswer", "log"] as const;
export type LinkLedgerKey = (typeof LINK_LEDGER_KEYS)[number];

/**
 * The rows the status bar prints, left to right. A **subset of the ledger's keys**, and
 * `satisfies` is what holds it to that: the bar prints the ledger's own labels and the
 * ledger's own figures, so there is no second vocabulary that can come to disagree with
 * the first. It had one — the bar said `cmd` where the panel said `Sent` — and a reader
 * had no way to tell that the two named the same number.
 *
 * Two rows, because a status bar is shared with the message text and because these are
 * the two whose value is in being glanced at: how long the link has been up, and whether
 * the broker has failed to answer. The rest are read when the panel is open, which is
 * when a session is actually being looked into.
 */
export const LINK_BAR_KEYS = ["up", "noanswer"] as const satisfies readonly LinkLedgerKey[];
export type LinkBarKey = (typeof LINK_BAR_KEYS)[number];

const EMPTY: LinkLedger = {
  upMs: 0,
  sets: 0,
  gets: 0,
  paramSubscribes: 0,
  meterSubscribes: 0,
  registFrames: 0,
  unregistFrames: 0,
  fullReads: 0,
  deadlines: 0,
  stalled: 0,
};

/** `h:mm:ss`, counting hours without wrapping — a session that ran 30 hours is the
 *  interesting one, so it must not print as 6:00:00. */
function formatUptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Thin-space grouped, so a six-figure count is readable in an 11px mono cell without
 *  a comma that reads as a decimal point in some locales. */
function formatCount(n: number): string {
  return n.toLocaleString("en-US").replace(/,/g, " ");
}

/** Consecutive deadlines that end a session, mirroring BROKER_STALL_LIMIT in
 *  src-tauri/src/vd.rs. Printed beside the current run so "no answer" reads as a
 *  distance to the end of the session rather than as an unscaled tally. */
export const BROKER_STALL_LIMIT = 3;

/** How often a running session appends a line. A minute, so a session that ends with
 *  the app loses at most that much — the frontend cannot be relied on to write anything
 *  as the page dies. */
const LOG_INTERVAL_MS = 60_000;

/** The headline figure of one row, in the panel and — for the two keys the bar also
 *  carries — in the status bar. There is deliberately no second function for the bar:
 *  one figure cannot be printed two ways if only one place computes it. The row's
 *  breakdown is built by the UI layer, which is where the words live. `log` has no
 *  figure — the path is the row. */
export function ledgerValue(key: LinkLedgerKey, l: LinkLedger): string {
  switch (key) {
    case "up":
      return formatUptime(l.upMs);
    case "sent":
      return formatCount(l.sets + l.gets);
    case "subscriptions":
      return formatCount(l.paramSubscribes + l.meterSubscribes);
    case "frames":
      return formatCount(l.registFrames + l.unregistFrames);
    case "reads":
      return formatCount(l.fullReads);
    case "noanswer":
      return formatCount(l.deadlines);
    case "log":
      return "";
  }
}

/**
 * The session's ledger. One instance for the app's lifetime; `begin` / `end` bracket
 * each Live sync session and every count restarts with the connection, because the
 * question is what a single session cost the broker.
 *
 * It owns the whole session policy — the opening line, the interval, and the once-per-
 * session report of a log that could not be written — for the same reason `LiveSync`
 * and `DeviceFollow` own their timers behind their own `begin` / `end`: the timer's
 * lifetime and `startedAt` are one fact, and a caller keeping them in step by hand can
 * leave a timer writing lines for a session that has ended.
 */
export class LinkLedgerTracker {
  private startedAt: number | null = null;
  private fullReads = 0;
  private last: LinkLedger = EMPTY;
  private logPath: string | null = null;
  private device = "";
  private timer: number | null = null;
  private onError: ((message: string) => void) | undefined;
  // Reported once per session: the interval would otherwise repeat one failure into the
  // status line every minute, pushing the operator's own messages off it.
  private warned = false;
  // Which build is writing. The PROMISE is cached, not its result: a failed round trip
  // would otherwise be retried once a line, forever, for a value that cannot change
  // under a running process. Started in `begin` so it overlaps the connect.
  private buildKind: Promise<"dev" | "release" | null> | null = null;

  /** The app version, stamped on every line. Passed in rather than imported: `core/`
   *  is reached from Node by the e2e specs, where a `package.json` import needs an
   *  import attribute the app's own bundler does not want. The shell knows it anyway. */
  constructor(private readonly appVersion: string) {}

  /**
   * A session opened. `device` is the model label, so a log line says which unit;
   * `onError` takes the one report a failed write is allowed to make.
   *
   * Writes the opening line immediately: a session that ends in the first minute is
   * still a session that happened, and it is what tells the readout where the log is.
   */
  begin(device: string, onError?: (message: string) => void): void {
    this.stopTimer();
    this.startedAt = Date.now();
    this.fullReads = 0;
    this.last = EMPTY;
    this.device = device;
    this.onError = onError;
    this.warned = false;
    this.buildKind ??= appBuildKind().catch(() => null);
    void this.write();
    // A line a minute, so a session that ends with the app still left a record of
    // itself: the frontend cannot be relied on to write anything as the page dies, and
    // an abandoned session is exactly the shape worth having on file. Its last line
    // carries no end reason, which is how the log tells it apart from one that was
    // closed.
    this.timer = window.setInterval(() => void this.write(), LOG_INTERVAL_MS);
  }

  /** Whether a session is being tracked (the readout hides when not). */
  get active(): boolean {
    return this.startedAt !== null;
  }

  /** Where the log was last written, once one line has landed. */
  get path(): string | null {
    return this.logPath;
  }

  /** A whole-device readback ran — the starting read, or a full reconcile. Counted
   *  here rather than in Rust because "read the whole device" is a decision this side
   *  makes; the broker only ever sees the ~800 commands it decomposes into. A read
   *  outside a session is not this session's, so it does not bank one. */
  noteFullRead(): void {
    if (this.startedAt !== null) this.fullReads += 1;
  }

  /** Take a fresh reading. Returns the previous one unchanged if the link has no
   *  ledger to report (outside Tauri, or with nothing connected). */
  async read(): Promise<LinkLedger> {
    if (this.startedAt === null) return this.last;
    // A ledger read that fails is not an error worth surfacing: the reading it wanted
    // belongs to a link that has gone, which is a state the teardown is in the middle
    // of producing. The last reading stands, and the session ends as it was going to.
    const stats = await vdLinkStats().catch(() => null);
    if (!stats) return this.last;
    this.last = { upMs: Date.now() - this.startedAt, ...stats, fullReads: this.fullReads };
    return this.last;
  }

  /**
   * The session closed. Resolves once the counters have been READ — which is the only
   * part that needs the link — so a caller can drop the connection the moment this
   * settles; the file write finishes on its own afterwards. Ordering, not politeness:
   * the counters belong to the connection and go to zero with it, so a final line
   * taken after the disconnect would record the session as having done nothing.
   */
  async end(reason: LinkSessionEnd): Promise<void> {
    if (this.startedAt === null) return;
    this.stopTimer();
    const l = await this.read();
    this.startedAt = null;
    void this.append(l, reason);
  }

  /** One JSONL record for a session still running (no end reason — see LinkSessionEnd). */
  private async write(): Promise<void> {
    if (this.startedAt === null) return;
    await this.append(await this.read(), null);
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Salvage, not abort: a log that cannot be written is not a reason to stop a device
   * session, so a failure is reported once and the session continues — the
   * failing-operation-aborts rule covers the device link, and this is not on it.
   */
  private async append(l: LinkLedger, end: LinkSessionEnd | null): Promise<void> {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      // `tauri dev` and the installed app append to the SAME file, so a line that did
      // not say which produced it would leave a diagnostic run and ordinary use
      // interleaved with nothing to separate them.
      build: await this.buildKind,
      version: this.appVersion,
      device: this.device,
      end,
      // Spread, so a counter added to LinkLedger reaches the log by existing rather
      // than by being listed here as well.
      ...l,
    });
    try {
      this.logPath = await appendLinkLog(line);
    } catch (e) {
      if (this.warned) return;
      this.warned = true;
      this.onError?.(e instanceof Error ? e.message : String(e));
    }
  }
}
