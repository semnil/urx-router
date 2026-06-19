// Application-facing live control: turn a plan into hardware writes, with a
// dry-run that returns exactly what would be sent so the UI can preview and
// confirm before touching the device. Transport lives in core/platform.ts
// (Rust vd commands); this module sequences and reports the writes.

import type { DeviceModel } from "../../models/types";
import type { Plan } from "../plan";
import { vdGet, vdSet } from "../platform";
import { planToCommands } from "./translate";
import type { VdCommand } from "./translate";

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
  /** Commands whose plan value differs from the device, or could not be confirmed. */
  diffs: CommandDiff[];
  /** Per-command read failures (e.g. timeout); the command is still kept in diffs. */
  errors: string[];
}

/**
 * Compare the plan's intended writes against the device's current values, so the
 * UI can write only what differs (and preview the count). Reads each planned
 * command's live value; a command is included when it differs or could not be
 * read (read failures are reported but the command is kept, so an unreadable
 * parameter is written rather than silently skipped). The caller must have
 * connected first (platform.vdConnect).
 */
export async function diffPlan(model: DeviceModel, plan: Plan): Promise<DiffResult> {
  const diffs: CommandDiff[] = [];
  const errors: string[] = [];
  for (const command of planToCommands(model, plan)) {
    try {
      const current = await vdGet(command.paramId, command.x, command.y);
      if (current !== command.vdValue) diffs.push({ command, current });
    } catch (e) {
      errors.push(`${command.name}: ${e instanceof Error ? e.message : String(e)}`);
      diffs.push({ command, current: null });
    }
  }
  return { diffs, errors };
}

export interface SendOutcome {
  command: VdCommand;
  ok: boolean;
  error?: string;
}

/**
 * Send commands to the connected device, in order, stopping at nothing — each
 * outcome is reported so a partial failure stays visible. The caller must have
 * connected first (platform.vdConnect).
 */
export async function sendCommands(commands: VdCommand[]): Promise<SendOutcome[]> {
  const outcomes: SendOutcome[] = [];
  for (const command of commands) {
    try {
      await vdSet(command.paramId, command.x, command.y, command.vdValue);
      outcomes.push({ command, ok: true });
    } catch (e) {
      outcomes.push({ command, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return outcomes;
}

/** Send every command a plan implies (no diff) — the full-write path. */
export function sendPlan(model: DeviceModel, plan: Plan): Promise<SendOutcome[]> {
  return sendCommands(planToCommands(model, plan));
}

export interface ConvergeResult {
  /** Every command sent across all rounds. */
  outcomes: SendOutcome[];
  /** Send rounds performed (1 = converged on the first write). */
  rounds: number;
  /** Diffs still remaining after the last round — empty means the device matches. */
  residual: CommandDiff[];
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
 */
export async function sendConverging(
  model: DeviceModel,
  plan: Plan,
  initialDiffs?: CommandDiff[],
  maxRounds = 3,
  settleMs = 300,
): Promise<ConvergeResult> {
  const outcomes: SendOutcome[] = [];
  let residual = initialDiffs ?? (await diffPlan(model, plan)).diffs;
  let rounds = 0;
  while (residual.length > 0 && rounds < maxRounds) {
    outcomes.push(...(await sendCommands(residual.map((d) => d.command))));
    rounds++;
    // A side-effect reset (e.g. from a COMP/EQ-type change) lands asynchronously,
    // a beat after the write returns. Let it settle before re-reading, so the
    // residual is the true post-reset state and the next round's re-send is not
    // racing a reset still in flight. (settleMs = 0 in tests, where the mock has
    // no async reset.)
    if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
    residual = (await diffPlan(model, plan)).diffs;
  }
  return { outcomes, rounds, residual };
}
