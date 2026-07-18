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
// the device-wide 1-of-N slot exclusivity. Input source is swept across the
// model's selectable input ports, so the (still-unverified on URX22/44) physical
// port map is exercised, not just the captured selection. PASSES covers the
// largest enum.
//
// UNVERIFIED GUESSES: some device mappings are confirmed only on URX44V and remain
// guesses on URX22/URX44 (see UNVERIFIED_MAPPINGS). A static audit first refutes
// any guessed id a confirmed param already owns (its writes are suppressed so the
// test never misaddresses hardware); the rest are exercised, and each round-trip
// result is reported per guess (confirmed / refuted / could-not-test) so an owner
// can confirm them. This is the live counterpart of that confirmation workflow.

import type { DeviceModel } from "../../models/types";
import { parseRef, ref } from "../../models/types";
import type { Plan } from "../plan";
import { emptyPlan } from "../plan";
import { canConnect, partnerChannel } from "../routing";
import { vdConnect, vdDisconnect } from "../platform";
import {
  BUS_TYPE_OPTIONS,
  EQ_ONE_KNOB_TYPE_MONO_OPTIONS,
  EQ_ONE_KNOB_TYPE_WIDE_OPTIONS,
  INSERT_FX_NONE,
  INSERT_FX_OPTIONS,
  OUTPUT_INSERT_FX_OPTIONS,
  REC_POINT_OPTIONS,
} from "./params";
import { sendConverging } from "./client";
import { applyDeviceState } from "./readback";
import {
  auditUnverified,
  channelControl,
  inputPorts,
  insertFxControl,
  isStereoChannel,
  UNVERIFIED_MAPPINGS,
  unverifiedAddresses,
} from "./translate";
import type { UnverifiedCollision } from "./translate";

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
  /** Unverified-mapping key this address belongs to, if any (the guess it refutes). */
  unverifiedKey?: string;
}

/** Per-guess outcome of the run, so an owner can confirm or refute each one. */
export interface UnverifiedFinding {
  key: string;
  label: string;
  /** A confirmed catalog param owns the guessed id — the guess is wrong and the
   *  self-test could not exercise it (its writes were suppressed for safety). */
  collision: boolean;
  /** Addresses written for this guess that did not round-trip. */
  mismatches: SelfTestMismatch[];
  /** True when the guess was exercised and every address round-tripped (confirmed). */
  confirmed: boolean;
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
  /** Guessed ids that collide with a confirmed param (static audit; the guess is wrong). */
  collisions: UnverifiedCollision[];
  /** Per-unverified-mapping outcome (confirmed / refuted / could-not-test). */
  unverified: UnverifiedFinding[];
  /** True when the user cancelled the run before it finished (remaining passes and
   *  the restore are skipped; the device is left in its last silent perturbed state). */
  aborted: boolean;
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
// exercises both banks over the run. Every captured enum must be listed here so
// it cycles within its legal range — a blind +1 (the fallback for plain numbers)
// drives a 2-value enum like busType out of range, which the broker rejects.
// Driver toggles (oneKnob/autoMakeup), insertFx, and EQ 1-knob type (its legal
// subset depends on the node) are handled separately, not by the generic sweep.
const ENUM_SWEEP: Record<string, number[]> = {
  compEqType: [0, 1],
  knee: [0, 1, 2],
  mode: [0, 1, 2],
  type: [0, 1, 2],
  busType: BUS_TYPE_OPTIONS.map((o) => o.value),
  recPoint: REC_POINT_OPTIONS.map((o) => o.value),
};
// fxEffect / insertFxParams are skipped wholesale: their values are raw engine-
// array slots holding bounded enums and index tables (SP Type, Ratio index, Amp
// Type, MIDI bits, dB offsets, note numbers, …) plus sentinels, so the generic
// "+1 every number" perturb would write out-of-range values the device clamps or
// rejects (a false failure when a captured baseline has an effect assigned).
// fxEffect's type is per-FX (FX1 0..2/1024..1025, FX2 768..770/1024..1025), and
// both repopulate the array on a type/selector change (sideEffect). The selector
// itself (insertFx) is swept by sweepInsertFx; round-trip coverage for the engine
// slots lives in the completeness / insert-fx-effect / translate unit tests.
//
// stereoLink / panBal are skipped too: stereoLink (Signal Type) is structural —
// toggling it resets the secondary channel and rejects independent writes to it
// while linked — and panBal is a 0/1 enum only meaningful while linked, so the
// generic "+1" perturb drives it out of range. Both round-trip in value-coverage.
const SKIP = new Set(["insertFx", "insertFxParams", "autoMakeup", "oneKnob", "fxEffect", "stereoLink", "panBal"]);

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
// Head-amp gain is floored to each channel's own minimum (not SILENCE_DB, which
// would be re-clamped and break the round trip): a still-unverified gain param id
// could write to an unintended address, and the channel minimum is the safest
// value such a write can carry while still letting a correct id round-trip. The
// oscillator level is left alone (the generator is already off).
function makeSilent(model: DeviceModel, plan: Plan): void {
  for (const [nodeId, np] of Object.entries(plan.nodeParams)) {
    if (typeof np.level === "number") np.level = SILENCE_DB;
    if (np.phantom) np.phantom = false;
    if (np.osc) np.osc.on = false;
    if (typeof np.gain === "number") {
      const cc = channelControl(model, nodeId);
      if (cc?.gain) np.gain = cc.gain.minDb;
    }
  }
  // Floor the level on every connection (creating params if absent), so a
  // channel fader / send carries no signal even when the captured plan did not
  // set it explicitly. Connection kinds with no level (source/patch/key/sendSwitch) ignore it.
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
    // Reset the selector and drop any captured effect params: a fresh effect
    // populates its own per-type defaults on the device, and emitting another
    // effect's stale slots would write nonsense to the new engine.
    const np = (plan.nodeParams[node.id] ??= {});
    np.insertFx = INSERT_FX_NONE;
    delete np.insertFxParams;
    (ifx.options === INSERT_FX_OPTIONS ? inputs : outputs).push(node.id);
  }
  if (inputs.length) plan.nodeParams[inputs[0]].insertFx = INSERT_FX_OPTIONS[pass % INSERT_FX_OPTIONS.length].value;
  if (outputs.length) {
    plan.nodeParams[outputs[0]].insertFx = OUTPUT_INSERT_FX_OPTIONS[pass % OUTPUT_INSERT_FX_OPTIONS.length].value;
  }
}

// Sweep input-source selection across the model's selectable input ports, so the
// physical port map (INPUT_PORTS) is verified — not just whatever the captured
// state happened to assign. Each pass points every channel group at a different
// input node (cycling), replacing its source wire. A linked mono pair is assigned
// together to one node (the device fixes the partner: its L port to the first
// channel, R to its partner), and a stereo channel takes one node's L/R pair —
// matching how planToCommands derives the per-slot port. The port value written is
// inputPorts(node), so a mismatch on read-back pins INPUT_PORTS as wrong. Levels
// are floored by makeSilent, so re-routing inputs stays silent.
function sweepInputSource(plan: Plan, pass: number, model: DeviceModel): void {
  const inputs = model.nodes.filter((n) => n.kind === "input" && inputPorts(n.id)).map((n) => n.id);
  if (!inputs.length) return;
  // Group channels into source-selection units: a linked mono pair, or a single
  // channel (unpaired mono / stereo).
  const groups: string[][] = [];
  const seen = new Set<string>();
  for (const node of model.nodes) {
    if (node.kind !== "channel" || seen.has(node.id)) continue;
    const partner = partnerChannel(model, node.id);
    if (partner && model.nodes.some((n) => n.id === partner)) {
      groups.push([node.id, partner]);
      seen.add(node.id).add(partner);
    } else {
      groups.push([node.id]);
      seen.add(node.id);
    }
  }
  const channelIds = new Set(groups.flat());
  // Drop existing channel source wires (other "source" wires — stream / monitor —
  // are left alone), then assign each group one cycling input node.
  plan.connections = plan.connections.filter((c) => c.kind !== "source" || !channelIds.has(parseRef(c.to).nodeId));
  groups.forEach((group, gi) => {
    const inputId = inputs[(pass + gi) % inputs.length];
    for (const chId of group) {
      const from = ref(inputId, "out");
      const to = ref(chId, "in");
      if (canConnect(model, plan, from, to).ok) plan.connections.push({ from, to, kind: "source" });
    }
  });
}

// Sweep EQ 1-knob TYPE within each node's valid preset subset. The generic
// perturb sweeps the shared "type" key across [0,1,2], but EQ_ONE_KNOB_TYPE
// exposes only a screen-specific subset: mono input channels offer Intensity(0) /
// Vocal(1), stereo channels and output buses offer Intensity(0) / Loudness(2).
// Writing the out-of-subset value (Loudness to a mono channel) makes the device
// reject the preset and floor the 1-knob LEVEL, so it never round-trips. Run after
// perturb to overwrite that conflated value with one the node actually accepts;
// the two subsets together still cover all three options over the node population.
function sweepEqOneKnobType(plan: Plan, pass: number, model: DeviceModel): void {
  for (const node of model.nodes) {
    const ok = plan.nodeParams[node.id]?.eqOneKnob;
    if (!ok || ok.type === undefined) continue;
    const mono = node.kind === "channel" && !isStereoChannel(node.id);
    const opts = mono ? EQ_ONE_KNOB_TYPE_MONO_OPTIONS : EQ_ONE_KNOB_TYPE_WIDE_OPTIONS;
    ok.type = opts[pass % opts.length].value;
  }
}

/**
 * Build the (silent) perturbed plan for a given sweep pass. `suppress` holds the
 * keys of colliding guesses to drop: each such mapping strips its own plan field
 * (the confirmed param sharing that address is still written, so it stays
 * covered). Exported for tests.
 */
export function perturbedPlan(model: DeviceModel, original: Plan, pass: number, suppress?: ReadonlySet<string>): Plan {
  const plan = structuredClone(original);
  for (const np of Object.values(plan.nodeParams)) perturb(np as Record<string, unknown>, pass);
  for (const c of plan.connections) if (c.params) perturb(c.params as Record<string, unknown>, pass);
  sweepInsertFx(plan, pass, model);
  sweepInputSource(plan, pass, model);
  sweepEqOneKnobType(plan, pass, model);
  if (suppress) for (const m of UNVERIFIED_MAPPINGS) if (suppress.has(m.key)) m.suppress?.(plan);
  makeSilent(model, plan);
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
export async function runSelfTest(model: DeviceModel, settleMs = 300, signal?: AbortSignal): Promise<SelfTestReport> {
  const report: SelfTestReport = {
    ok: false,
    device: "",
    applied: 0,
    passes: PASSES,
    written: 0,
    residual: [],
    collisions: [],
    unverified: [],
    aborted: false,
    restored: false,
    restoreResidual: 0,
    errors: [],
    phase: "connect",
  };
  // Run one phase's round-trips, returning its result — or undefined if the user
  // cancelled (the inner loops throw via signal.throwIfAborted). A cancel is
  // recorded on the report and swallowed so the caller can bail; anything else
  // rethrows. Centralizes the "stop on our abort, propagate real errors" contract.
  const phaseStep = async <T>(work: Promise<T>): Promise<T | undefined> => {
    try {
      return await work;
    } catch (e) {
      if (signal?.aborted) {
        report.aborted = true;
        return undefined;
      }
      throw e;
    }
  };
  // Static audit (no device): guessed ids a confirmed param already owns are wrong
  // and must not be written. Their writes are suppressed; they are reported as
  // collisions so an owner knows the guess is refuted before any hardware round-trip.
  report.collisions = auditUnverified(model.id);
  const suppress = new Set(report.collisions.map((c) => c.key));
  // Address → unverified-mapping key, so each residual can be tagged with the guess
  // it refutes. A colliding guess shares its address with a confirmed param (whose
  // write is kept); drop those entries so a residual there is attributed to the
  // confirmed param, not mislabeled as the suppressed guess.
  const addresses = unverifiedAddresses(model);
  for (const [addr, key] of addresses) if (suppress.has(key)) addresses.delete(addr);
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
    const r0 = await phaseStep(applyDeviceState(model, original, signal));
    if (!r0) return report;
    report.applied = r0.applied;
    report.errors.push(...r0.errors);

    // 2. Sweep: each pass writes a silent perturbed plan (converging, so params
    // the device resets as a side effect of a mode change are re-sent) and the
    // residual after convergence is the pass's mismatches. Cancellation stops
    // issuing round-trips between commands; the in-flight one finishes (so the
    // device is left consistent), then sendConverging throws and phaseStep bails.
    for (let pass = 0; pass < PASSES; pass++) {
      const plan = perturbedPlan(model, original, pass, suppress);
      report.phase = "write";
      const result = await phaseStep(sendConverging(model, plan, undefined, 3, settleMs, signal));
      if (!result) break;
      const { outcomes, residual } = result;
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
          unverifiedKey: d.command.x === 0 ? addresses.get(`${d.command.paramId}:${d.command.y}`) : undefined,
        });
      }
    }
    report.ok = !report.aborted && report.residual.length === 0;

    // Per-guess verdict: a collision could not be tested (and is already known
    // wrong); otherwise the guess is confirmed when it was exercised on this model
    // and every one of its addresses round-tripped without a mismatch.
    const exercised = new Set(addresses.values());
    report.unverified = UNVERIFIED_MAPPINGS.filter((m) => m.models.includes(model.id)).map((m) => {
      const collision = suppress.has(m.key);
      const mismatches = report.residual.filter((r) => r.unverifiedKey === m.key);
      return {
        key: m.key,
        label: m.label,
        collision,
        mismatches,
        confirmed: !collision && exercised.has(m.key) && mismatches.length === 0,
      };
    });

    // 3. Restore the original state (converging, for the same reset behavior).
    // Skipped on cancel: the device is left silent (safe by makeSilent), and a
    // restore would only re-run the round-trips the user just cancelled.
    if (!report.aborted) {
      report.phase = "restore";
      const back = await phaseStep(sendConverging(model, original, undefined, 3, settleMs, signal));
      if (back) {
        report.restoreResidual = back.residual.length;
        report.restored = back.residual.length === 0;
        report.phase = "done";
      }
    }
    return report;
  } finally {
    await vdDisconnect(device.epoch);
  }
}

/** Tally the per-guess verdicts in one pass (for the status line / report). */
export function summarizeVerdicts(unverified: UnverifiedFinding[]): {
  confirmed: number;
  refuted: number;
  untestable: number;
} {
  const counts = { confirmed: 0, refuted: 0, untestable: 0 };
  for (const u of unverified) {
    if (u.collision) counts.untestable++;
    else if (u.confirmed) counts.confirmed++;
    else counts.refuted++;
  }
  return counts;
}

/**
 * Render a report as human-readable Markdown an owner can save and send back to
 * confirm the unverified guesses. Leads with the per-guess verdicts (the point of
 * the run on URX22/URX44), then the device-fidelity residual and any issues. Pure.
 */
export function formatSelfTestReport(report: SelfTestReport): string {
  const lines: string[] = [];
  lines.push(`# URX self-test report — ${report.device || "(no device)"}`);
  lines.push("");
  lines.push(`- Result: ${report.ok ? "PASS" : "FAIL"} (phase: ${report.phase})`);
  lines.push(`- Captured groups: ${report.applied}; passes: ${report.passes}; commands written: ${report.written}`);
  lines.push(`- Restored: ${report.restored ? "yes" : `NO — ${report.restoreResidual} param(s) differ`}`);

  if (report.unverified.length) {
    lines.push("");
    lines.push("## Unverified-guess verdicts");
    for (const u of report.unverified) {
      const verdict = u.collision
        ? "COULD NOT TEST — guessed id collides with a confirmed param (guess is wrong)"
        : u.confirmed
          ? "CONFIRMED — round-tripped on the device"
          : `REFUTED — ${u.mismatches.length} address(es) did not round-trip`;
      lines.push(`- **${u.label}** (${u.key}): ${verdict}`);
      for (const m of u.mismatches) {
        lines.push(
          `  - ${m.name} @ ${m.paramId}:${m.x}:${m.y} — wrote ${m.expected}, read ${m.actual ?? "unreadable"}`,
        );
      }
    }
  }

  if (report.collisions.length) {
    lines.push("");
    lines.push("## Static collisions (refuted before any write)");
    for (const c of report.collisions) {
      lines.push(`- ${c.label}: param ${c.paramId} is already owned by ${c.confirmed}`);
    }
  }

  // Device divergence not attributable to an unverified guess — genuine fidelity issues.
  const other = report.residual.filter((r) => !r.unverifiedKey);
  if (other.length) {
    lines.push("");
    lines.push("## Other device divergence (confirmed params)");
    for (const m of other) {
      lines.push(
        `- p${m.pass} ${m.name} @ ${m.paramId}:${m.x}:${m.y} — wrote ${m.expected}, read ${m.actual ?? "unreadable"}`,
      );
    }
  }

  if (report.errors.length) {
    lines.push("");
    lines.push("## Issues (read/send failures)");
    for (const e of report.errors) lines.push(`- ${e}`);
  }
  lines.push("");
  return lines.join("\n");
}
