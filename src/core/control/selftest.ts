// In-app device self-test: an automated round-trip diagnostic against the live
// device. It reads the current device state, writes a perturbed version of it,
// verifies the device now matches exactly (write fidelity), then restores the
// original state. The live counterpart of completeness.test.ts — it exercises
// the real broker, not a mock, so it catches device-side divergence (clamping,
// ignored params, bulk-write drops) the unit tests cannot. Experimental.

import type { DeviceModel } from "../../models/types";
import type { Plan } from "../plan";
import { emptyPlan } from "../plan";
import { vdConnect, vdDisconnect } from "../platform";
import { diffPlan, sendPlan } from "./client";
import { applyDeviceState } from "./readback";

export interface SelfTestMismatch {
  name: string;
  paramId: number;
  x: number;
  y: number;
  /** Value the plan wrote. */
  expected: number;
  /** Value read back from the device, or null if it could not be read. */
  actual: number | null;
}

export interface SelfTestReport {
  /** True when the device matched the written plan exactly (no residual diff). */
  ok: boolean;
  /** Device model reported on connect. */
  device: string;
  /** Body-parameter groups read in the initial capture. */
  applied: number;
  /** Commands sent for the perturbed plan. */
  written: number;
  /** Params that did not match after the write — the findings. */
  residual: SelfTestMismatch[];
  /** True when the device was returned to its original captured state. */
  restored: boolean;
  /** Residual diff count after writing the original back (0 = fully restored). */
  restoreResidual: number;
  /** Non-fatal issues (read failures, send failures) collected along the way. */
  errors: string[];
  /** Last phase reached — where it stopped if an error was thrown. */
  phase: "connect" | "readback" | "write" | "verify" | "restore" | "done";
}

// Enum fields are cycled within their value count so a perturbed value stays a
// legal enum. Driver toggles (oneKnob/autoMakeup) recompute other COMP params on
// the device, insertFx has cross-channel slot exclusivity, and compEqType is
// structural (it switches active banks) — all excluded so the round trip stays a
// clean fidelity check rather than testing those interactions here.
const ENUM_CYCLE: Record<string, number> = { knee: 3, mode: 3, type: 3 };
const SKIP = new Set(["insertFx", "autoMakeup", "oneKnob", "compEqType"]);

// Perturb every scalar in an object tree in place: flip bools, nudge numbers,
// cycle small enums, flip the PRE/POST tap. Connection sets are not touched.
function perturb(obj: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(obj)) {
    if (SKIP.has(k)) continue;
    if (typeof v === "boolean") obj[k] = !v;
    else if (typeof v === "number") obj[k] = k in ENUM_CYCLE ? (v + 1) % ENUM_CYCLE[k] : v + 1;
    else if (typeof v === "string") {
      if (k === "tap") obj[k] = v === "pre" ? "post" : "pre";
    } else if (Array.isArray(v)) {
      for (const el of v) if (el && typeof el === "object") perturb(el as Record<string, unknown>);
    } else if (v && typeof v === "object") {
      perturb(v as Record<string, unknown>);
    }
  }
}

function perturbPlan(plan: Plan): Plan {
  const p = structuredClone(plan);
  for (const np of Object.values(p.nodeParams)) perturb(np as Record<string, unknown>);
  for (const c of p.connections) if (c.params) perturb(c.params as Record<string, unknown>);
  return p;
}

/**
 * Run the device round-trip self-test. Connects, captures the device state,
 * writes a perturbed copy, verifies the device matches it, then restores the
 * original — always disconnecting. Read/send failures are collected into the
 * report rather than thrown; a thrown error leaves `phase` at the failing step.
 * The caller must ensure the connected device matches `model`.
 */
export async function runSelfTest(model: DeviceModel): Promise<SelfTestReport> {
  const report: SelfTestReport = {
    ok: false,
    device: "",
    applied: 0,
    written: 0,
    residual: [],
    restored: false,
    restoreResidual: 0,
    errors: [],
    phase: "connect",
  };
  const device = await vdConnect();
  report.device = device.model;
  try {
    if (device.model !== model.id) {
      report.errors.push(`connected device is ${device.model}, not ${model.id}`);
      return report;
    }
    // 1. Capture the current device state.
    report.phase = "readback";
    const original = emptyPlan(model.id);
    const r0 = await applyDeviceState(model, original);
    report.applied = r0.applied;
    report.errors.push(...r0.errors);

    // 2. Write a perturbed copy.
    report.phase = "write";
    const perturbed = perturbPlan(original);
    const outcomes = await sendPlan(model, perturbed);
    report.written = outcomes.length;
    report.errors.push(...outcomes.filter((o) => !o.ok).map((o) => `${o.command.name}: ${o.error}`));

    // 3. Verify the device now matches the perturbed plan exactly.
    report.phase = "verify";
    const diff = await diffPlan(model, perturbed);
    report.residual = diff.diffs.map((d) => ({
      name: d.command.name,
      paramId: d.command.paramId,
      x: d.command.x,
      y: d.command.y,
      expected: d.command.vdValue,
      actual: d.current,
    }));
    report.errors.push(...diff.errors);
    report.ok = report.residual.length === 0;

    // 4. Restore the original state.
    report.phase = "restore";
    await sendPlan(model, original);
    const back = await diffPlan(model, original);
    report.restoreResidual = back.diffs.length;
    report.restored = back.diffs.length === 0;

    report.phase = "done";
    return report;
  } finally {
    await vdDisconnect();
  }
}
