// Application-facing live control: turn a plan into hardware writes, with a
// dry-run that returns exactly what would be sent so the UI can preview and
// confirm before touching the device. Transport lives in core/platform.ts
// (Rust vd commands); this module sequences and reports the writes.

import type { DeviceModel } from "../../models/types";
import type { Plan } from "../plan";
import { vdGet, vdGetStr, vdSet, vdSetStr } from "../platform";
import { PARAMS } from "./params";
import { cmdAddr, planToCommands, planToNameWrites } from "./translate";
import type { EmitOptions, NameWrite, VdCommand, WriteScope } from "./translate";
import { SETTLE_TIMEOUT_MS, writeSettle } from "./settle";
import type { PendingWrites } from "./settle";

/** The device's clock state: whether it slaves to the USB host, and the rate it
 *  is running at right now. Read together as the pre-check a write needs. */
export interface ClockState {
  followUsb: boolean;
  sampleRate: number;
}

/**
 * Read the device's clock state. The caller must have connected first.
 *
 * Rejects rather than reporting a partial answer: both halves are needed to decide
 * whether a rate write can stick, and guessing either one is the failure this check
 * exists to prevent. The write path treats a rejection as fail-closed and stops.
 */
export async function readClockState(): Promise<ClockState> {
  const followUsb = await readFollowUsb();
  const sampleRate = await vdGet(PARAMS.SAMPLE_RATE.id, 0, 0);
  return { followUsb, sampleRate };
}

/** Read just the Follow USB policy. Separate from readClockState because the badge
 *  refresh runs right after a full readback, which has already brought the rate
 *  back — re-reading it there would be a round-trip for a value just obtained. */
export async function readFollowUsb(): Promise<boolean> {
  return (await vdGet(PARAMS.FOLLOW_USB.id, 0, 0)) !== 0;
}

/**
 * What a write should do about the plan's rate, given what the device reports.
 *
 * - `proceed` — the device already runs the plan's rate; nothing to settle.
 * - `confirmReclock` — the rates differ and the device holds its own clock, so the
 *   plan's rate will stick. Worth stating (re-clocking interrupts audio) but it is
 *   a plain yes/no.
 * - `askChoice` — the rates differ and the device is slaved to its USB host, so
 *   writing the plan's rate would be undone a moment later. Neither answer can be
 *   inferred, so the operator picks.
 *
 * Pure, so the matrix is testable without a device or a dialog; the caller owns the
 * IO and the prompts.
 */
export type RateAction = "proceed" | "confirmReclock" | "askChoice";

export function rateAction(planRate: number, clock: ClockState): RateAction {
  if (clock.sampleRate === planRate) return "proceed";
  return clock.followUsb ? "askChoice" : "confirmReclock";
}

/** Turn the device's Follow USB policy on or off. A single write, outside the plan
 *  (see params.ts FOLLOW_USB). The caller must have connected first. */
export function setFollowUsb(on: boolean): Promise<void> {
  return vdSet(PARAMS.FOLLOW_USB.id, 0, 0, on ? 1 : 0);
}

/** Follow USB's notify address. Exported because it is outside the plan, so a
 *  caller that wants device-side changes to it must register the address itself
 *  rather than getting it from the plan's writable set. */
export const FOLLOW_USB_ADDR: [number, number, number] = [PARAMS.FOLLOW_USB.id, 0, 0];

/** The vd commands a plan currently implies — the confirm-before-send preview. */
export function dryRun(model: DeviceModel, plan: Plan): VdCommand[] {
  return planToCommands(model, plan);
}

export interface CommandDiff {
  command: VdCommand;
  /** The device's current encoded value, or null when it could not be read. */
  current: number | null;
}

export interface DiffResult {
  /** Commands whose plan value differs from the device. */
  diffs: CommandDiff[];
  /** Per-command read failures (e.g. timeout). A non-empty list means the
   *  comparison is incomplete and the caller must not write on it. */
  errors: string[];
  /** The commands behind those failures. `errors` carries a name and a message, which
   *  is what a report prints; a caller that has to decide something PER ADDRESS — the
   *  self-test, deciding whether a guessed mapping round-tripped — cannot get there
   *  from a string. */
  unread: VdCommand[];
}

/**
 * Compare the plan's intended writes against the device's current values, so the
 * UI can write only what differs (and preview the count). Reads each planned
 * command's live value and includes it when it differs. A read failure leaves
 * the device's value unknown, so the command is reported in `errors` and left
 * out of `diffs` — the caller aborts rather than writing a parameter whose
 * current value it never confirmed. The caller must have connected first
 * (platform.vdConnect).
 *
 * `stopOnError` returns at the first failure. A caller that aborts on any read
 * failure has nothing to gain from the rest of the sweep, and a link that times
 * out rather than fails fast makes those hundreds of doomed round-trips minutes
 * of waiting for an answer already decided.
 */
export interface DiffOptions {
  signal?: AbortSignal;
  /** Return at the first read failure (a caller that aborts on any failure has
   *  nothing to gain from the rest of the sweep). */
  stopOnError?: boolean;
  /** Write scope (see translate.ts). Diagnostics leave it at "all". */
  scope?: WriteScope;
  /** Include the addresses the device drives (translate.ts, EmitOptions). The
   *  self-test's restore is the only caller that sets it; every other one compares
   *  exactly the set it would write. */
  emit?: EmitOptions;
}

export async function diffPlan(model: DeviceModel, plan: Plan, opts: DiffOptions = {}): Promise<DiffResult> {
  const { signal, stopOnError = false, scope = "all", emit = {} } = opts;
  const diffs: CommandDiff[] = [];
  const errors: string[] = [];
  const unread: VdCommand[] = [];
  for (const command of planToCommands(model, plan, scope, emit)) {
    signal?.throwIfAborted();
    try {
      const current = await vdGet(command.paramId, command.x, command.y);
      if (current !== command.vdValue) diffs.push({ command, current });
    } catch (e) {
      errors.push(`${command.name}: ${e instanceof Error ? e.message : String(e)}`);
      unread.push(command);
      if (stopOnError) break;
    }
  }
  return { diffs, errors, unread };
}

export interface SendOutcome {
  command: VdCommand;
  ok: boolean;
  error?: string;
  /** True when the loop stopped before this command was tried, so the device
   *  never saw it. Distinct from ok:false, which did reach the device and fail. */
  skipped?: boolean;
}

/**
 * Send commands to the connected device, in order, stopping at the first
 * failure. Order matters — a type selector precedes the parameter array it
 * binds (FX type before its array, insert-FX selector before the engine
 * arrays), so continuing past a failed selector would write slot values that
 * the device interprets under the wrong type. The commands after the failure
 * are reported as `skipped` rather than dropped, so the caller can say what the
 * device did and did not see. The caller must have connected first
 * (platform.vdConnect).
 */
export async function sendCommands(commands: VdCommand[], signal?: AbortSignal): Promise<SendOutcome[]> {
  const outcomes: SendOutcome[] = [];
  for (const command of commands) {
    signal?.throwIfAborted();
    try {
      await vdSet(command.paramId, command.x, command.y, command.vdValue);
      outcomes.push({ command, ok: true });
    } catch (e) {
      outcomes.push({ command, ok: false, error: e instanceof Error ? e.message : String(e) });
      break;
    }
  }
  // Everything past the stop was never attempted.
  for (const command of commands.slice(outcomes.length)) outcomes.push({ command, ok: false, skipped: true });
  return outcomes;
}

/** A command the device saw and refused, as opposed to one the loop never tried.
 *  Both are ok:false, so every reader of an outcome list needs the distinction. */
export const reachedAndFailed = (o: SendOutcome): boolean => !o.ok && !o.skipped;

export interface NameOutcome {
  write: NameWrite;
  ok: boolean;
  error?: string;
}

/**
 * The CH SETTING name writes whose value differs from the device — the string
 * analogue of diffPlan, so a name-only edit is counted and a matching name is
 * not re-sent. A read failure is reported and the write left out, matching
 * diffPlan: the caller aborts rather than writing over a name it could not read.
 */
export async function diffNames(model: DeviceModel, plan: Plan): Promise<{ writes: NameWrite[]; errors: string[] }> {
  const writes: NameWrite[] = [];
  const errors: string[] = [];
  for (const write of planToNameWrites(model, plan)) {
    try {
      const current = (await vdGetStr(write.param, 0, write.y)).trimEnd();
      if (current !== write.value) writes.push(write);
    } catch (e) {
      errors.push(`name ${write.param}:${write.y}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { writes, errors };
}

/**
 * Send CH SETTING name writes (string params, via the string IPC). Separate from
 * sendCommands because names are strings outside the numeric VdCommand path;
 * idempotent, so no converge loop is needed. The caller must have connected.
 */
export async function sendNames(writes: NameWrite[]): Promise<NameOutcome[]> {
  const outcomes: NameOutcome[] = [];
  for (const write of writes) {
    try {
      await vdSetStr(write.param, 0, write.y, write.value);
      outcomes.push({ write, ok: true });
    } catch (e) {
      outcomes.push({ write, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return outcomes;
}

/**
 * One converge round, for a caller that has to explain a residual afterwards.
 * The residual alone cannot: it says a parameter differs at the end, not whether
 * it was ever in the diff, whether the later rounds re-sent it, or what the device
 * answered each time. Kept only when `trace` is set (the diagnostics), since a
 * live write would otherwise retain every command it ever sent.
 */
export interface ConvergeRound {
  /** Commands sent this round, in the order they went out. */
  sent: VdCommand[];
  /** Milliseconds from this round's first send to the end of its re-read. */
  elapsedMs: number;
  /** What the re-read found still differing, or null when the round stopped on a
   *  send failure and no re-read was made. */
  reread: CommandDiff[] | null;
}

export interface ConvergeResult {
  /** Every command sent across all rounds. */
  outcomes: SendOutcome[];
  /** Send rounds performed (1 = converged on the first write). */
  rounds: number;
  /** Per-round record, one entry per round — empty unless `trace` was requested. */
  trace: ConvergeRound[];
  /** Diffs still remaining after the last round — empty means the device matches. */
  residual: CommandDiff[];
  /** Read failures from a re-diff between rounds. Non-empty means the loop
   *  stopped early because the device's state could no longer be confirmed, so
   *  `residual` is what was known at that point rather than a settled answer. */
  readErrors: string[];
  /** The commands behind them (see DiffResult.unread), so a caller can decide per
   *  address rather than per message. */
  unread: VdCommand[];
}

/**
 * What a converge round must actually send: everything that differs, plus every
 * member of a `group` any of them belongs to, in emit order.
 *
 * A round that re-sends only what differs is right for independent parameters and
 * wrong for a reset chain. The EQ 1-knob is the measured one: writing ON discards
 * the type, writing the type discards the level. Re-sending ON alone therefore
 * un-sets the type that already matched, the next round re-sends the type and
 * un-sets the level, and the loop alternates until it runs out of rounds — leaving
 * the parameter it never got to as a residual the device did accept every time it
 * was written. Sending the group whole lands all three in one round.
 *
 * The plan is re-translated only when a group is actually involved, which no write
 * without an EQ 1-knob difference ever is.
 */
function roundCommands(
  model: DeviceModel,
  plan: Plan,
  scope: WriteScope,
  emit: EmitOptions,
  diffs: CommandDiff[],
): VdCommand[] {
  const groups = new Set<string>();
  for (const d of diffs) if (d.command.group) groups.add(d.command.group);
  if (!groups.size) return diffs.map((d) => d.command);
  const addrs = new Set(diffs.map((d) => cmdAddr(d.command)));
  return planToCommands(model, plan, scope, emit).filter(
    (c) => addrs.has(cmdAddr(c)) || (c.group !== undefined && groups.has(c.group)),
  );
}

export interface ConvergeOptions {
  /** A diff already in hand (the write path's confirmed set); absent = seed one. Still
   *  the Write button's route in — it diffs the device to build its confirm prompt and
   *  hands the confirmed set straight over (main.ts), which is what makes round 1 send
   *  exactly what the operator agreed to. Live sync is the caller that does NOT: its
   *  flush has already sent the diff itself, so a seeded round would send it twice. */
  initialDiffs?: CommandDiff[];
  /** What the caller wrote immediately before calling, when it is leaving the
   *  diff to be seeded. The seed read is otherwise issued inside those writes'
   *  own staleness window (see architecture.md, "A write is not readable when it
   *  is acked") and reports differences that are not there while missing the
   *  resets this loop exists to settle. Held only until the unit has spoken for
   *  them — measured 17-84 ms on a URX44V, not the bounded fallback — so this
   *  costs a converging flush the window it was already inside, not a flat 300 ms.
   *  Callers that hand over `initialDiffs` never seed and never need it. */
  pending?: PendingWrites;
  maxRounds?: number;
  settleMs?: number;
  signal?: AbortSignal;
  /** Write scope (see translate.ts). Diagnostics leave it at "all". */
  scope?: WriteScope;
  /** Include the addresses the device drives (translate.ts, EmitOptions). Applies to
   *  the round sends AND the re-reads, so the residual speaks for the set being
   *  written — the self-test restore is the only caller that sets it. */
  emit?: EmitOptions;
  /** Keep a per-round record (see ConvergeRound). Diagnostics only. */
  trace?: boolean;
}

/**
 * Write the plan to the device until it converges: send the diff, re-read, and
 * re-send whatever still differs, up to maxRounds. A single write is not always
 * enough — setting some params makes the device reset dependents as a side
 * effect (e.g., changing COMP/EQ type resets the channel-strip section toggles),
 * so a value written in the same batch is clobbered and only sticks once the
 * reset has settled and it is re-sent. What a round sends is `roundCommands`, not
 * the diff itself. The caller must have connected first; it may pass the diff it
 * already computed (for the confirm prompt) to skip the first re-read. Stops early
 * when nothing differs.
 *
 * Retrying is only sound while the link is healthy. A round that failed to send,
 * or a re-diff that could not read the device, ends the loop instead of starting
 * another round — re-sending the whole plan over a link that just failed would
 * re-trigger the side-effect resets this loop exists to settle.
 */
export async function sendConverging(
  model: DeviceModel,
  plan: Plan,
  opts: ConvergeOptions = {},
): Promise<ConvergeResult> {
  const {
    initialDiffs,
    pending,
    maxRounds = 3,
    // One source with settle.ts: this site's blind window and the notify wait's bounded
    // fallback are the same measured number, and a test that clears one by advancing the
    // other is only right while they agree.
    settleMs = SETTLE_TIMEOUT_MS,
    signal,
    scope = "all",
    emit = {},
    trace: wantTrace = false,
  } = opts;
  const outcomes: SendOutcome[] = [];
  const readErrors: string[] = [];
  const unread: VdCommand[] = [];
  const trace: ConvergeRound[] = [];
  let residual = initialDiffs;
  if (!residual) {
    // The whole write set holds this wait, not a subset: the seed read asks the
    // unit about every address in the scope, so any one of them still inside its
    // window would be reported as a difference the plan does not have.
    // Bounded by this function's own `settleMs`, so the one constant governs both
    // waits here and a test that switches the loop's settle off switches this off
    // with it. In production it is the notify that ends it, not the bound.
    if (pending)
      await writeSettle.settle(pending.written, {
        mustSettle: new Set(pending.written.keys()),
        timeoutMs: settleMs,
        signal,
      });
    const seed = await diffPlan(model, plan, { signal, scope, emit });
    readErrors.push(...seed.errors);
    unread.push(...seed.unread);
    residual = seed.diffs;
  }
  let rounds = 0;
  while (residual.length > 0 && rounds < maxRounds && !readErrors.length) {
    signal?.throwIfAborted();
    const startedAt = Date.now();
    const sending = roundCommands(model, plan, scope, emit, residual);
    const sent = await sendCommands(sending, signal);
    outcomes.push(...sent);
    rounds++;
    const record = (reread: CommandDiff[] | null): void => {
      if (wantTrace) trace.push({ sent: sending, elapsedMs: Date.now() - startedAt, reread });
    };
    if (sent.some(reachedAndFailed)) {
      record(null);
      break;
    }
    // A side-effect reset (e.g. from a COMP/EQ-type change) lands asynchronously,
    // a beat after the write returns. Let it settle before re-reading, so the
    // residual is the true post-reset state and the next round's re-send is not
    // racing a reset still in flight. (settleMs = 0 in tests, where the mock has
    // no async reset.)
    //
    // Blind, and not the notify wait a refetch takes: what this round SENDS is
    // `roundCommands`, which pulls in every member of a group any differing command
    // belongs to, and those members were never read. A wait that ended at the read
    // diff's own notifies would return while the rest of the group was still inside
    // its own window. No converge head's reset latency is measured either — only the
    // "refetch" family's, which never reaches this loop.
    if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
    const next = await diffPlan(model, plan, { signal, scope, emit });
    readErrors.push(...next.errors);
    unread.push(...next.unread);
    residual = next.diffs;
    record(residual);
  }
  return { outcomes, rounds, trace, residual, readErrors, unread };
}

/**
 * Render a write's failures as human-readable Markdown the user can save, so the
 * per-command reasons (otherwise console-only) are visible off the status bar.
 * `failed` is the failed send/name outcomes (normalized to name + error);
 * `residual` is the diff that never converged (the device still differs);
 * `reads` are parameters whose current value could not be read. A read failure
 * is its own category — when it aborts the write, nothing was written at all, so
 * it must not be counted among the write failures. Pure.
 */
export function formatWriteReport(
  model: string,
  failed: Array<{ name: string; error?: string }>,
  residual: CommandDiff[],
  reads: string[] = [],
): string {
  const lines: string[] = [];
  lines.push(`# URX write report — ${model}`);
  lines.push("");
  if (reads.length && !failed.length && !residual.length) {
    lines.push(`- Read failures: ${reads.length}. The write was canceled — nothing was written.`);
  } else {
    lines.push(
      `- Write failures: ${failed.length}; parameters that did not converge: ${residual.length}` +
        (reads.length ? `; read failures: ${reads.length}` : ""),
    );
  }
  if (reads.length) {
    lines.push("");
    lines.push("## Read failures");
    for (const e of reads) lines.push(`- ${e}`);
  }
  if (failed.length) {
    lines.push("");
    lines.push("## Write failures");
    for (const f of failed) lines.push(`- ${f.name} — ${f.error ?? "unknown error"}`);
  }
  if (residual.length) {
    lines.push("");
    lines.push("## Did not converge (device value still differs)");
    for (const d of residual) {
      const c = d.command;
      lines.push(
        `- ${c.name} @ ${c.paramId}:${c.x}:${c.y} — wrote ${c.vdValue}, device has ${d.current ?? "unreadable"}`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

// One numeric parameter compared against the device: the full, auditable form of
// a CommandDiff, kept whether or not it matched.
export interface CompareEntry {
  command: VdCommand;
  /** The device's current encoded value. */
  device: number;
  match: boolean;
}

// One CH SETTING name compared against the device.
export interface NameCompareEntry {
  write: NameWrite;
  /** The device's current name (trailing padding trimmed). */
  device: string;
  match: boolean;
}

/**
 * Read every parameter the plan implies and record the device's value beside the
 * plan's — the full, auditable form of `diffPlan`, which keeps only the
 * mismatches. The read-only "Compare with device" uses this so the report can
 * show that every parameter was actually read, not just the ones that differ (a
 * comparison that returns "matches" instantly is otherwise indistinguishable from
 * one that read nothing). A read failure is collected in `errors` and that
 * parameter left out of `entries`, so "matched" and "could not be read" stay
 * distinct. Reads all — no stopOnError — so one dead parameter does not truncate
 * the audit. The caller must have connected first.
 */
export async function comparePlan(
  model: DeviceModel,
  plan: Plan,
  signal?: AbortSignal,
): Promise<{ entries: CompareEntry[]; errors: string[] }> {
  const entries: CompareEntry[] = [];
  const errors: string[] = [];
  for (const command of planToCommands(model, plan)) {
    signal?.throwIfAborted();
    try {
      const device = await vdGet(command.paramId, command.x, command.y);
      entries.push({ command, device, match: device === command.vdValue });
    } catch (e) {
      errors.push(`${command.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { entries, errors };
}

/** The CH SETTING name analogue of comparePlan (string params, via the string IPC). */
export async function compareNames(
  model: DeviceModel,
  plan: Plan,
): Promise<{ entries: NameCompareEntry[]; errors: string[] }> {
  const entries: NameCompareEntry[] = [];
  const errors: string[] = [];
  for (const write of planToNameWrites(model, plan)) {
    try {
      const device = (await vdGetStr(write.param, 0, write.y)).trimEnd();
      entries.push({ write, device, match: device === write.value });
    } catch (e) {
      errors.push(`name ${write.param}:${write.y}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { entries, errors };
}

/**
 * The counts a comparison reports, plus the differing entries the report lists.
 * One definition of "what counts as compared / differ", so the status line and
 * the report cannot drift apart (both derive from this). Pure.
 */
export function compareCounts(
  entries: CompareEntry[],
  nameEntries: NameCompareEntry[],
): { compared: number; differ: number; numDiffs: CompareEntry[]; nameDiffs: NameCompareEntry[] } {
  const numDiffs = entries.filter((e) => !e.match);
  const nameDiffs = nameEntries.filter((e) => !e.match);
  return {
    compared: entries.length + nameEntries.length,
    differ: numDiffs.length + nameDiffs.length,
    numDiffs,
    nameDiffs,
  };
}

/**
 * Render a read-only device↔plan comparison as human-readable Markdown. A summary
 * count, then the differences (the actionable part), then a **full log of every
 * parameter compared** — so an instant "matches" can be verified as hundreds of
 * reads that agreed, not zero reads. `errors` are parameters whose device value
 * could not be read, which leave the comparison incomplete. Pure.
 */
export function formatCompareReport(
  model: string,
  entries: CompareEntry[],
  nameEntries: NameCompareEntry[],
  errors: string[] = [],
): string {
  const lines: string[] = [];
  const numLine = (e: CompareEntry): string =>
    `${e.command.name} @ ${e.command.paramId}:${e.command.x}:${e.command.y} — plan ${e.command.vdValue}, device ${e.device}`;
  const nameLine = (e: NameCompareEntry): string =>
    `name @ ${e.write.param}:${e.write.y} — plan "${e.write.value}", device "${e.device}"`;

  const { compared, differ, numDiffs, nameDiffs } = compareCounts(entries, nameEntries);
  // Addresses more than one plan node writes: the emitted set carries one command
  // for them (last wins), so the compared count is short by the dropped owners.
  const shared = entries.filter((e) => e.command.shadowed?.length);
  lines.push(`# URX compare report — ${model}`);
  lines.push("");
  lines.push(
    `- Compared ${compared} parameters: ${compared - differ} match, ${differ} differ` +
      (errors.length ? `; ${errors.length} could not be read` : "") +
      (shared.length ? `; ${shared.length} shared by more than one node` : ""),
  );

  if (numDiffs.length || nameDiffs.length) {
    lines.push("");
    lines.push("## Differences (plan vs device)");
    for (const e of numDiffs) lines.push(`- ${numLine(e)}`);
    for (const e of nameDiffs) lines.push(`- ${nameLine(e)}`);
  }
  if (errors.length) {
    lines.push("");
    lines.push("## Could not be read (comparison incomplete)");
    for (const e of errors) lines.push(`- ${e}`);
  }
  if (shared.length) {
    lines.push("");
    lines.push("## Shared device settings (one address, more than one node)");
    for (const { command: c } of shared) {
      lines.push(`- ${c.name} @ ${c.paramId}:${c.x}:${c.y} — kept ${c.node ?? "?"}, dropped ${c.shadowed!.join(", ")}`);
    }
    lines.push(
      "(Compared against the kept node's value only — the dropped nodes' plan values are on no address of their own.)",
    );
  }
  // Full audit log: every parameter, matched or not, so the comparison can be
  // checked rather than trusted.
  lines.push("");
  lines.push("## Full log (every parameter compared)");
  for (const e of entries) lines.push(`- ${numLine(e)} — ${e.match ? "match" : "DIFFER"}`);
  for (const e of nameEntries) lines.push(`- ${nameLine(e)} — ${e.match ? "match" : "DIFFER"}`);
  lines.push("");
  return lines.join("\n");
}
