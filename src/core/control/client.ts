// Application-facing live control: turn a plan into hardware writes, with a
// dry-run that returns exactly what would be sent so the UI can preview and
// confirm before touching the device. Transport lives in core/platform.ts
// (Rust vd commands); this module sequences and reports the writes.

import type { DeviceModel } from "../../models/types";
import type { Plan } from "../plan";
import { vdSet } from "../platform";
import { planToCommands } from "./translate";
import type { VdCommand } from "./translate";

/** The vd commands a plan currently implies — the confirm-before-send preview. */
export function dryRun(model: DeviceModel, plan: Plan): VdCommand[] {
  return planToCommands(model, plan);
}

export interface SendOutcome {
  command: VdCommand;
  ok: boolean;
  error?: string;
}

/**
 * Send every command a plan implies to the connected device, in order, stopping
 * at nothing — each outcome is reported so a partial failure stays visible. The
 * caller must have connected first (platform.vdConnect).
 */
export async function sendPlan(model: DeviceModel, plan: Plan): Promise<SendOutcome[]> {
  const outcomes: SendOutcome[] = [];
  for (const command of planToCommands(model, plan)) {
    try {
      await vdSet(command.paramId, command.x, command.y, command.vdValue);
      outcomes.push({ command, ok: true });
    } catch (e) {
      outcomes.push({ command, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return outcomes;
}
