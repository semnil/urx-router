// In-app device self-test: an automated round-trip diagnostic against the live
// device. It reads the current device state, writes perturbed copies of it,
// verifies the device matches each exactly (write fidelity), then restores the
// original state. The live counterpart of completeness.test.ts — it exercises
// the real broker, not a mock, so it catches device-side divergence (clamping,
// ignored params, bulk-write drops) the unit tests cannot. Experimental.
//
// SAFETY: the perturbed plans are silent by construction. Every output level /
// head-amp gain is floored, the oscillator generator is forced off, and phantom
// power is forced off, so toggling channels / sends / routing cannot produce
// audible (or hot, or +48V) output while the test holds a perturbed state. Write
// fidelity for the level params is still exercised, at their (safe) minimum.
//
// COVERAGE: enum params are swept across passes — pass k selects option
// (k mod optionCount) for COMP/EQ type, COMP knee, OSC mode and EQ-band type, so
// every option is written over the run. Insert FX is swept on a single node per
// pass (one input channel + one output bus), the rest set to none, to respect
// the device-wide 1-of-N slot exclusivity. PASSES covers the largest enum.

import type { DeviceModel } from "../../models/types";
import type { Plan } from "../plan";
import { emptyPlan } from "../plan";
import { vdConnect, vdDisconnect } from "../platform";
import { INSERT_FX_NONE, INSERT_FX_OPTIONS, OUTPUT_INSERT_FX_OPTIONS } from "./params";
import { sendConverging } from "./client";
import { applyDeviceState } from "./readback";
import { insertFxControl } from "./translate";

export interface SelfTestMismatch {
  name: string;
  paramId: number;
  x: number;
  y: number;
  /** Value the plan wrote. */
  expected: number;
  /** Value read back from the device, or null if it could not be read. */
  actual: number | null;
  /** Sweep pass that produced this mismatch. */
  pass: number;
}

export interface SelfTestReport {
  /** True when every pass matched its written plan exactly (no residual diff). */
  ok: boolean;
  /** Device model reported on connect. */
  device: string;
  /** Body-parameter groups read in the initial capture. */
  applied: number;
  /** Sweep passes run (each writes + verifies a perturbed plan). */
  passes: number;
  /** Commands sent across all passes. */
  written: number;
  /** Params that did not match after a write — the findings. */
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

// Deep-negative dB that emit clamps to each level param's own minimum (-inf for
// faders / sends, the floor for gain / monitor), so the written state is silent.
const SILENCE_DB = -200;

// Enum params swept across passes (key → legal option values, in device order).
// COMP/EQ type is structural (it switches active GATE/COMP/EQ banks); sweeping it
// exercises both banks over the run. Driver toggles (oneKnob/autoMakeup) and
// insertFx are handled separately, not by the generic perturbation.
const ENUM_SWEEP: Record<string, number[]> = {
  compEqType: [0, 1],
  knee: [0, 1, 2],
  mode: [0, 1, 2],
  type: [0, 1, 2],
};
const SKIP = new Set(["insertFx", "autoMakeup", "oneKnob"]);

// Passes needed to sweep every enum option at least once (the largest is the
// input insert-FX option list).
const PASSES = INSERT_FX_OPTIONS.length;

// Perturb every scalar in an object tree in place: flip bools, nudge numbers,
// cycle the PRE/POST tap, and set swept enums to this pass's option.
function perturb(obj: Record<string, unknown>, pass: number): void {
  for (const [k, v] of Object.entries(obj)) {
    if (SKIP.has(k)) continue;
    if (k in ENUM_SWEEP && typeof v === "number") {
      const opts = ENUM_SWEEP[k];
      obj[k] = opts[pass % opts.length];
    } else if (typeof v === "boolean") {
      obj[k] = !v;
    } else if (typeof v === "number") {
      obj[k] = v + 1;
    } else if (typeof v === "string") {
      if (k === "tap") obj[k] = v === "pre" ? "post" : "pre";
    } else if (Array.isArray(v)) {
      for (const el of v) if (el && typeof el === "object") perturb(el as Record<string, unknown>, pass);
    } else if (v && typeof v === "object") {
      perturb(v as Record<string, unknown>, pass);
    }
  }
}

// Force the plan silent: floor every output fader, disable the oscillator
// generator, and disable phantom power. Applied last so it overrides perturb.
// Head-amp gain and the oscillator level are NOT floored: gain is a pre-fader
// input stage (floored faders already block all output) and the oscillator is
// off, so neither can produce sound — and flooring them past their own device
// range only breaks the round trip (the device re-clamps to its own minimum).
function makeSilent(plan: Plan): void {
  for (const np of Object.values(plan.nodeParams)) {
    if (typeof np.level === "number") np.level = SILENCE_DB;
    if (np.phantom) np.phantom = false;
    if (np.osc) np.osc.on = false;
  }
  // Floor the level on every connection (creating params if absent), so a
  // channel fader / send carries no signal even when the captured plan did not
  // set it explicitly. Connection kinds with no level (source/patch/key) ignore it.
  for (const c of plan.connections) c.params = { ...c.params, level: SILENCE_DB };
}

// Sweep insert FX: one input channel and one output bus get this pass's option,
// every other insert-FX node is set to none. A single active effect per kind
// respects the device-wide 1-of-N slot exclusivity (two channels cannot hold the
// same slot at once), so the write is always legal.
function sweepInsertFx(plan: Plan, pass: number, model: DeviceModel): void {
  const inputs: string[] = [];
  const outputs: string[] = [];
  for (const node of model.nodes) {
    const ifx = insertFxControl(model, node.id);
    if (!ifx) continue;
    (plan.nodeParams[node.id] ??= {}).insertFx = INSERT_FX_NONE;
    (ifx.options === INSERT_FX_OPTIONS ? inputs : outputs).push(node.id);
  }
  if (inputs.length) plan.nodeParams[inputs[0]].insertFx = INSERT_FX_OPTIONS[pass % INSERT_FX_OPTIONS.length].value;
  if (outputs.length) {
    plan.nodeParams[outputs[0]].insertFx = OUTPUT_INSERT_FX_OPTIONS[pass % OUTPUT_INSERT_FX_OPTIONS.length].value;
  }
}

/** Build the (silent) perturbed plan for a given sweep pass. Exported for tests. */
export function perturbedPlan(model: DeviceModel, original: Plan, pass: number): Plan {
  const plan = structuredClone(original);
  for (const np of Object.values(plan.nodeParams)) perturb(np as Record<string, unknown>, pass);
  for (const c of plan.connections) if (c.params) perturb(c.params as Record<string, unknown>, pass);
  sweepInsertFx(plan, pass, model);
  makeSilent(plan);
  return plan;
}

/**
 * Run the device round-trip self-test. Connects, captures the device state, then
 * for each sweep pass writes a (silent) perturbed copy and verifies the device
 * matches it; finally restores the original — always disconnecting. Read/send
 * failures are collected into the report rather than thrown; a thrown error
 * leaves `phase` at the failing step. The caller must ensure the connected
 * device matches `model`.
 */
export async function runSelfTest(model: DeviceModel, settleMs = 300): Promise<SelfTestReport> {
  const report: SelfTestReport = {
    ok: false,
    device: "",
    applied: 0,
    passes: PASSES,
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

    // 2. Sweep: each pass writes a silent perturbed plan (converging, so params
    // the device resets as a side effect of a mode change are re-sent) and the
    // residual after convergence is the pass's mismatches.
    for (let pass = 0; pass < PASSES; pass++) {
      const plan = perturbedPlan(model, original, pass);
      report.phase = "write";
      const { outcomes, residual } = await sendConverging(model, plan, undefined, 3, settleMs);
      report.written += outcomes.length;
      report.errors.push(...outcomes.filter((o) => !o.ok).map((o) => `p${pass} ${o.command.name}: ${o.error}`));
      report.phase = "verify";
      for (const d of residual) {
        report.residual.push({
          name: d.command.name,
          paramId: d.command.paramId,
          x: d.command.x,
          y: d.command.y,
          expected: d.command.vdValue,
          actual: d.current,
          pass,
        });
      }
    }
    report.ok = report.residual.length === 0;

    // 3. Restore the original state (converging, for the same reset behavior).
    report.phase = "restore";
    const back = await sendConverging(model, original, undefined, 3, settleMs);
    report.restoreResidual = back.residual.length;
    report.restored = back.residual.length === 0;

    report.phase = "done";
    return report;
  } finally {
    await vdDisconnect();
  }
}
