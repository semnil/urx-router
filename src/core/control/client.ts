// Application-facing live control: turn a plan into hardware writes, with a
// dry-run that returns exactly what would be sent so the UI can preview and
// confirm before touching the device. Transport lives in core/platform.ts
// (Rust vd commands); this module sequences and reports the writes.

import type { DeviceModel } from "../../models/types";
import type { Plan } from "../plan";
import { vdGet, vdGetStr, vdSet, vdSetStr } from "../platform";
import { PARAMS } from "./params";
import { planToCommands, planToNameWrites } from "./translate";
import type { NameWrite, VdCommand } from "./translate";

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
export async function diffPlan(
  model: DeviceModel,
  plan: Plan,
  signal?: AbortSignal,
  stopOnError = false,
): Promise<DiffResult> {
  const diffs: CommandDiff[] = [];
  const errors: string[] = [];
  for (const command of planToCommands(model, plan)) {
    signal?.throwIfAborted();
    try {
      const current = await vdGet(command.paramId, command.x, command.y);
      if (current !== command.vdValue) diffs.push({ command, current });
    } catch (e) {
      errors.push(`${command.name}: ${e instanceof Error ? e.message : String(e)}`);
      if (stopOnError) break;
    }
  }
  return { diffs, errors };
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

/** Send every command a plan implies (no diff) — the full-write path. */
export function sendPlan(model: DeviceModel, plan: Plan): Promise<SendOutcome[]> {
  return sendCommands(planToCommands(model, plan));
}

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

export interface ConvergeResult {
  /** Every command sent across all rounds. */
  outcomes: SendOutcome[];
  /** Send rounds performed (1 = converged on the first write). */
  rounds: number;
  /** Diffs still remaining after the last round — empty means the device matches. */
  residual: CommandDiff[];
  /** Read failures from a re-diff between rounds. Non-empty means the loop
   *  stopped early because the device's state could no longer be confirmed, so
   *  `residual` is what was known at that point rather than a settled answer. */
  readErrors: string[];
}

/**
 * Write the plan to the device until it converges: send the diff, re-read, and
 * re-send whatever still differs, up to maxRounds. A single write is not always
 * enough — setting some params makes the device reset dependents as a side
 * effect (e.g., changing COMP/EQ type resets the channel-strip section toggles),
 * so a value written in the same batch is clobbered and only sticks once the
 * reset has settled and it is re-sent. The caller must have connected first; it
 * may pass the diff it already computed (for the confirm prompt) to skip the
 * first re-read. Stops early when nothing differs.
 *
 * Retrying is only sound while the link is healthy. A round that failed to send,
 * or a re-diff that could not read the device, ends the loop instead of starting
 * another round — re-sending the whole plan over a link that just failed would
 * re-trigger the side-effect resets this loop exists to settle.
 */
export async function sendConverging(
  model: DeviceModel,
  plan: Plan,
  initialDiffs?: CommandDiff[],
  maxRounds = 3,
  settleMs = 300,
  signal?: AbortSignal,
): Promise<ConvergeResult> {
  const outcomes: SendOutcome[] = [];
  const readErrors: string[] = [];
  let residual = initialDiffs;
  if (!residual) {
    const seed = await diffPlan(model, plan, signal);
    readErrors.push(...seed.errors);
    residual = seed.diffs;
  }
  let rounds = 0;
  while (residual.length > 0 && rounds < maxRounds && !readErrors.length) {
    signal?.throwIfAborted();
    const sent = await sendCommands(
      residual.map((d) => d.command),
      signal,
    );
    outcomes.push(...sent);
    rounds++;
    if (sent.some(reachedAndFailed)) break;
    // A side-effect reset (e.g. from a COMP/EQ-type change) lands asynchronously,
    // a beat after the write returns. Let it settle before re-reading, so the
    // residual is the true post-reset state and the next round's re-send is not
    // racing a reset still in flight. (settleMs = 0 in tests, where the mock has
    // no async reset.)
    if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
    const next = await diffPlan(model, plan, signal);
    readErrors.push(...next.errors);
    residual = next.diffs;
  }
  return { outcomes, rounds, residual, readErrors };
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
