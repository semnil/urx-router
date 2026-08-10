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
// the device-wide 1-of-N slot exclusivity. The device auto-engages a
// (re)selected effect through its insert ON/OFF switch; that switch is modeled
// (insertFxOn) and emitted after the selector, so the restore puts a captured
// "selected but bypassed" effect back to bypassed. Input source is swept across
// the model's selectable input ports, so the (still-unverified on URX22/44)
// physical port map is exercised, not just the captured selection. The pass count
// (passesFor) is the max of the largest swept enum and the passes needed to reach
// every input port, so the trailing ports (usbsub / hdmi) are covered too.
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
import { vdConnect, vdDisconnect, vdGet, vdSet } from "../platform";
import {
  BUS_TYPE_OPTIONS,
  DELAY_FRAME_RATE_OPTIONS,
  EQ_ONE_KNOB_TYPE_OPTIONS,
  INSERT_FX_NONE,
  INSERT_FX_OPTIONS,
  insertFxAvailable,
  OUTPUT_INSERT_FX_OPTIONS,
  REC_POINT_OPTIONS,
} from "./params";
import { sendConverging } from "./client";
import { SETTLE_TIMEOUT_MS } from "./settle";
import type { ConvergeRound } from "./client";
import { applyDeviceState } from "./readback";
import {
  auditUnverified,
  channelControl,
  cmdAddr,
  formatAddrKey,
  inputPorts,
  insertFxControl,
  planToCommands,
  UNVERIFIED_MAPPINGS,
  unverifiedAddresses,
} from "./translate";
import type { UnverifiedCollision, VdCommand } from "./translate";

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

/**
 * The converge trace of one pass that ended with a residual, plus the captured
 * baseline for the addresses that did not match. A residual line says a parameter
 * differs at the end; it cannot say whether the parameter was in the first round's
 * diff at all (it is not, when the device already held the plan's value and a later
 * command in the same round reset it), whether the following rounds re-sent it, or
 * how long each round took. That is the difference between a device that refuses a
 * write and one that takes it and then moves — which the summary cannot distinguish.
 */
/** One address's value in the captured device state. */
export interface CapturedValue {
  addr: string;
  name: string;
  value: number;
}

export interface SelfTestPassTrace {
  pass: number;
  /** What the capture holds at each residual address — the start of the diff the pass
   *  computed, without which the trace cannot say why a command was or was not sent
   *  in the first round. */
  baseline: CapturedValue[];
  rounds: ConvergeRound[];
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
  /** Per-round trace of every pass that ended with a residual (see SelfTestPassTrace). */
  traces: SelfTestPassTrace[];
  /** Guessed ids that collide with a confirmed param (static audit; the guess is wrong). */
  collisions: UnverifiedCollision[];
  /** Per-unverified-mapping outcome (confirmed / refuted / could-not-test). */
  unverified: UnverifiedFinding[];
  /** True when the user cancelled the run before it finished (remaining passes and
   *  the restore are skipped; the device is left in its last silent perturbed state). */
  aborted: boolean;
  /** True when the device was returned to its original captured state. */
  restored: boolean;
  /** Params that still differ from what the unit held before the run: the converging
   *  restore's residual PLUS the addresses that write has no command for, read before
   *  the sweep and written back after it (restoreUnsent). ⚠️ Still bounded by the app's
   *  parameter catalogue: a run also perturbs the unit's 1-knob base save-off, which
   *  has no entry and so cannot be read, written or counted (measured on a URX44V,
   *  2026-08-10 — 27 addresses; nothing observed restores from it, see diag and the
   *  private PLAN.md). */
  restoreResidual: number;
  /** Non-fatal issues (read failures, send failures) collected along the way. */
  errors: string[];
  /** Last phase reached — where it stopped if an error was thrown. "refused" is the
   *  one that is not a failure: the run declined to start and wrote nothing, so
   *  `restored` says nothing about the unit and callers must not read it as a failed
   *  restore (it is false because nothing was restored, not because something is left
   *  perturbed). */
  phase: "connect" | "readback" | "write" | "verify" | "restore" | "done" | "refused";
  /**
   * DIAGNOSTIC — the restore's own account of itself, small enough to ride the report
   * line the headless launch already prints. It exists because a run that reported
   * `restoreResidual: 0` while an external sweep found 27 addresses changed left
   * nothing to read: neither the verdict nor the log could say whether the restore had
   * SENT those addresses, what the unit answered when it did, or what a later round
   * re-sent over the top. Each field answers exactly one of those.
   */
  diag: {
    /** Addresses the sweep wrote that the restore's command set does not carry. Empty
     *  means the restore does emit them, and the residue has another cause. */
    unrestorable: string[];
    /** Per round of the converging restore: how much went out, how much of it was the
     *  PEQ and the 1-knob chain, and how much still differed on the re-read. A 1-knob
     *  group re-sent in the last round reloads the preset over the bands. */
    restoreRounds: Array<{ sent: number; bands: number; oneKnob: number; residual: number | null }>;
    /** Band gains that disagreed with the captured value when read IMMEDIATELY after
     *  the restore. Empty here while an external sweep later finds them changed means
     *  the unit moved them after the write, not that the write never landed. */
    bandsAfterRestore: Array<{ addr: string; want: number; got: number | null }>;
  };
}

// What the restore emits, named once: the diagnostic below asks "which addresses will
// the restore NOT send", and asking it of a different set than the restore uses is how
// a run reports a gap it does not have (the PEQ was listed as unrestorable in a run
// that restored it, 2026-08-10).
const RESTORE_EMIT = { includeDeviceDriven: true } as const;

// Deep-negative dB that emit clamps to each level param's own minimum (-inf for
// faders / sends, the floor for gain / monitor), so the written state is silent.
const SILENCE_DB = -200;

// Enum params swept across passes (key → legal option values, in device order).
// COMP/EQ type is structural (it switches active GATE/COMP/EQ banks); sweeping it
// exercises both banks over the run. Every captured enum must be listed here so
// it cycles within its legal range — a blind +1 (the fallback for plain numbers)
// drives a 2-value enum like busType out of range, which the broker rejects.
// Driver toggles (oneKnob/autoMakeup), insertFx, and EQ 1-knob type (its legal
// subset depends on the node) are handled separately.
const ENUM_SWEEP: Record<string, number[]> = {
  compEqType: [0, 1],
  knee: [0, 1, 2],
  mode: [0, 1, 2],
  type: [0, 1, 2],
  busType: BUS_TYPE_OPTIONS.map((o) => o.value),
  recPoint: REC_POINT_OPTIONS.map((o) => o.value),
  frameRate: DELAY_FRAME_RATE_OPTIONS.map((o) => o.value),
};
// fxEffect / insertFxParams are skipped wholesale: their values are raw engine-
// array slots holding bounded enums and index tables (SP Type, Ratio index, Amp
// Type, MIDI bits, dB offsets, note numbers, …) plus sentinels, so the generic
// "+1 every number" perturb would write out-of-range values the device clamps or
// rejects (a false failure when a captured baseline has an effect assigned).
// fxEffect's type is per-FX (FX1 0..2/1024..1025, FX2 768..770/1024..1025), and
// both repopulate the array on a type/selector change (sideEffect). The selector
// itself (insertFx) is swept by sweepInsertFx; round-trip coverage for the
// engine slots lives in the completeness / value-coverage / insert-fx-effect /
// translate unit tests.
//
// stereoLink / panBal are skipped too: stereoLink (Signal Type) is structural —
// toggling it resets the secondary channel and rejects independent writes to it
// while linked — and panBal is a 0/1 enum only meaningful while linked, so the
// generic "+1" perturb drives it out of range. Both round-trip in value-coverage.
// comp.oneKnobLevel is a bounded 0..100 raw (not a small enum), so the "+1" nudge
// runs it past 100 when captured at max; skip it (its round-trip is value-covered).
const SKIP = new Set([
  "insertFx",
  "insertFxParams",
  "autoMakeup",
  "oneKnob",
  "oneKnobLevel",
  "fxEffect",
  "stereoLink",
  "panBal",
]);

// Enum-sweep floor: the max option-list length across every swept enum (today
// the 8 input insert-FX options), so every option of every swept enum is written
// at least once over the run. Exported for tests.
export const PASSES = Math.max(
  INSERT_FX_OPTIONS.length,
  OUTPUT_INSERT_FX_OPTIONS.length,
  EQ_ONE_KNOB_TYPE_OPTIONS.length,
  ...Object.values(ENUM_SWEEP).map((o) => o.length),
);

// Passes for a model: enough to write every swept enum option at least once AND
// to point some channel group at every selectable input port. The input-source
// sweep gives group gi the port at (pass + gi) mod N, so the union across G
// groups reaches every one of the N ports only after N - G + 1 passes (URX44V 10
// / URX44 9 / URX22 7). Taking the max with the enum floor keeps the last input
// ports (usbsub / hdmi) reached instead of leaving their INPUT_PORTS guess
// unexercised. Exported for tests.
export function passesFor(model: DeviceModel): number {
  const ports = selectableInputIds(model).length;
  return Math.max(PASSES, ports - channelSourceGroups(model).length + 1);
}

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

// The shared silence core: floor every level (creating connection params if absent,
// so a channel fader / send carries no signal even when the captured plan did not
// set it explicitly — kinds with no level ignore it), and disable the oscillator
// generator and phantom power. The audit-prep writer (prepare.ts) reuses this
// verbatim so the "silent by construction" contract lives in one place: prepare
// leaves its state on the device with no restore, so a drift here would ship a
// non-silent (or +48V) write to hardware.
export function floorSilent(plan: Plan): void {
  for (const np of Object.values(plan.nodeParams)) {
    if (typeof np.level === "number") np.level = SILENCE_DB;
    if (np.phantom) np.phantom = false;
    if (np.osc) np.osc.on = false;
  }
  for (const c of plan.connections) c.params = { ...c.params, level: SILENCE_DB };
}

// Force the perturbed plan silent, applied last so it overrides perturb. Head-amp
// gain is floored to each channel's own minimum (not SILENCE_DB, which would be
// re-clamped and break the round trip): a still-unverified gain param id could
// write to an unintended address, and the channel minimum is the safest value such
// a write can carry while still letting a correct id round-trip.
function makeSilent(model: DeviceModel, plan: Plan): void {
  floorSilent(plan);
  for (const [nodeId, np] of Object.entries(plan.nodeParams)) {
    if (typeof np.gain === "number") {
      const cc = channelControl(model, nodeId);
      if (cc?.gain) np.gain = cc.gain.minDb;
    }
  }
}

// Sweep insert FX: one input channel and one output bus get this pass's option,
// every other insert-FX node is set to none. A single active effect per kind
// respects the device-wide 1-of-N slot exclusivity (two channels cannot hold the
// same slot at once), and options over the captured sample rate's ceiling are
// dropped (a rate-locked selector never round-trips), so the write is always
// legal. The receiving node also rotates per pass, so every node/instance of the
// selector and switch params is exercised, not just the first. The ON/OFF
// (bypass) switch is modeled (insertFxOn, flipped by perturb): translate emits
// it after the selector on the effect-bearing nodes, so the device's auto-engage
// on (re)selection is overridden and both switch states round-trip over the run.
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
    (ifx.isOutput ? outputs : inputs).push(node.id);
  }
  const legalIn = INSERT_FX_OPTIONS.filter((o) => insertFxAvailable(o, plan.sampleRate));
  const legalOut = OUTPUT_INSERT_FX_OPTIONS.filter((o) => insertFxAvailable(o, plan.sampleRate));
  if (inputs.length) {
    plan.nodeParams[inputs[pass % inputs.length]].insertFx = legalIn[pass % legalIn.length].value;
  }
  if (outputs.length) {
    plan.nodeParams[outputs[pass % outputs.length]].insertFx = legalOut[pass % legalOut.length].value;
  }
}

// Ids of the model's selectable input nodes — those with a physical port map
// (INPUT_PORTS). Shared by the input-source sweep (which cycles channel groups
// across them) and the pass count (which needs their count, N). Exported for tests.
export function selectableInputIds(model: DeviceModel): string[] {
  return model.nodes.filter((n) => n.kind === "input" && inputPorts(n.id)).map((n) => n.id);
}

// Group channels into source-selection units: a linked mono pair, or a single
// channel (unpaired mono / stereo). Shared by the input-source sweep (which
// assigns each group an input node) and the pass count (which needs the group
// count, G, to size full port coverage).
function channelSourceGroups(model: DeviceModel): string[][] {
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
  return groups;
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
  const inputs = selectableInputIds(model);
  if (!inputs.length) return;
  const groups = channelSourceGroups(model);
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
  if (suppress) for (const m of UNVERIFIED_MAPPINGS) if (suppress.has(m.key)) m.suppress?.(plan);
  makeSilent(model, plan);
  return plan;
}

/**
 * The connect-time capture shared by the self-test and the audit-prep writer
 * (prepare.ts): verify the just-connected device matches `model`, then read its
 * current state into a fresh plan. Returns whether the model matched (`ok`), the
 * captured plan, and the read's applied count / errors — the model-mismatch
 * message is already in `errors`. The caller owns connect + disconnect and its own
 * cancel handling: a cancel throws out of applyDeviceState and propagates.
 */
export async function captureDeviceState(
  model: DeviceModel,
  deviceModel: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; plan: Plan; applied: number; errors: string[] }> {
  const plan = emptyPlan(model.id);
  if (deviceModel !== model.id) {
    return { ok: false, plan, applied: 0, errors: [`connected device is ${deviceModel}, not ${model.id}`] };
  }
  const r = await applyDeviceState(model, plan, signal);
  return { ok: true, plan, applied: r.applied, errors: r.errors };
}

/**
 * Run the device round-trip self-test. Connects, captures the device state, then
 * for each sweep pass writes a (silent) perturbed copy and verifies the device
 * matches it; finally restores the original — always disconnecting. Read/send
 * failures are collected into the report rather than thrown; a thrown error
 * leaves `phase` at the failing step. The caller must ensure the connected
 * device matches `model`.
 */
export async function runSelfTest(
  model: DeviceModel,
  settleMs = SETTLE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<SelfTestReport> {
  const passes = passesFor(model);
  const report: SelfTestReport = {
    ok: false,
    device: "",
    applied: 0,
    passes,
    written: 0,
    residual: [],
    traces: [],
    collisions: [],
    unverified: [],
    aborted: false,
    restored: false,
    restoreResidual: 0,
    errors: [],
    phase: "connect",
    diag: { unrestorable: [], restoreRounds: [], bandsAfterRestore: [] },
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
  // Reads the run could not make. They are not mismatches — nobody knows whether the
  // parameter matched — so they cannot go in `residual`, and a verdict that ignores
  // them claims a fidelity it did not measure.
  let readFailures = 0;
  // Unverified-mapping keys with at least one address the run could not read. A read
  // failure keeps the command out of the diff (diffPlan) and so out of the residual, so
  // without this the guess shows no mismatch and reports CONFIRMED — a promotion to
  // "verified on hardware" for an address nothing round-tripped.
  const unreadKeys = new Set<string>();
  // Address → unverified-mapping key, so each residual can be tagged with the guess
  // it refutes. A colliding guess shares its address with a confirmed param (whose
  // write is kept); drop those entries so a residual there is attributed to the
  // confirmed param, not mislabeled as the suppressed guess.
  const addresses = unverifiedAddresses(model);
  for (const [addr, key] of addresses) if (suppress.has(key)) addresses.delete(addr);
  const device = await vdConnect();
  report.device = device.model;
  try {
    // 1. Capture the current device state (the connect prologue shared with prepare.ts).
    report.phase = "readback";
    const cap = await phaseStep(captureDeviceState(model, device.model, signal));
    if (!cap) return report; // cancelled during capture
    report.applied = cap.applied;
    report.errors.push(...cap.errors);
    if (!cap.ok) return report; // connected device is not this model
    const original = cap.plan;
    // The capture as device values, for a failing pass's trace: the same inverse the
    // restore writes, indexed once rather than per pass.
    const captured = new Map<number, CapturedValue>();
    for (const c of planToCommands(model, original, "all", RESTORE_EMIT)) {
      captured.set(cmdAddr(c), { addr: formatAddrKey(cmdAddr(c)), name: c.name, value: c.vdValue });
    }
    // Addresses a pass emits that the captured plan does not: the restore has no command
    // for them, so it cannot put them back and its residual cannot speak for them either.
    // They are read off the unit here, BEFORE anything is perturbed, and written back
    // after the restore.
    //
    // A plan emits an address only under the mode that owns it, and the sweep runs in
    // every mode: the SSMCS GATE/COMP/EQ section toggles exist only in the other COMP/EQ
    // order, and the insert-FX ON switch only while an effect is selected. Every one of
    // them is a confirmed param the app already drives, so writing it back is ordinary —
    // what makes them special is only that the captured plan has no command for them.
    //
    // The 4-band PEQ used to be a third family here and is not any more: it is handled
    // where it belongs, by the restore asking for it (EmitOptions.includeDeviceDriven).
    report.phase = "readback";
    const unrestorable = new Map<number, VdCommand>();
    for (let pass = 0; pass < passes; pass++) {
      for (const c of planToCommands(model, perturbedPlan(model, original, pass, suppress))) {
        if (!captured.has(cmdAddr(c))) unrestorable.set(cmdAddr(c), c);
      }
    }
    // Through phaseStep like every other await here: a cancel inside this loop is a
    // cancel, and without it the abort escapes runSelfTest and reaches the user as a
    // self-test ERROR dialog instead.
    const preSweep = await phaseStep(readPreSweep(unrestorable, signal, report));
    if (!preSweep) return report; // cancelled during the pre-sweep read
    // An address in this set has no other record of what it held: the captured plan has
    // no command for it, so a read failure here means the run could perturb it and never
    // put it back. Nothing has been written yet, so the honest answer is not to start —
    // counting it in the residual afterwards leaves the unit changed and only says so.
    //
    // This is not the "aggregate instead of stopping" exception (architecture.md). That
    // one is about a partial CAPTURE, whose addresses the restore still writes; these are
    // the addresses it cannot. `errors` already names each one.
    if (preSweep.size !== unrestorable.size) {
      report.errors.push(
        `refusing to sweep: ${unrestorable.size - preSweep.size} address(es) the restore cannot reach could not be read first`,
      );
      report.phase = "refused";
      return report;
    }

    // 2. Sweep: each pass writes a silent perturbed plan (converging, so params
    // the device resets as a side effect of a mode change are re-sent) and the
    // residual after convergence is the pass's mismatches. Cancellation stops
    // issuing round-trips between commands; the in-flight one finishes (so the
    // device is left consistent), then sendConverging throws and phaseStep bails.
    for (let pass = 0; pass < passes; pass++) {
      const plan = perturbedPlan(model, original, pass, suppress);
      report.phase = "write";
      const result = await phaseStep(sendConverging(model, plan, { settleMs, signal, trace: true }));
      if (!result) break;
      const { outcomes, residual } = result;
      report.written += outcomes.length;
      report.errors.push(...outcomes.filter((o) => !o.ok).map((o) => `p${pass} ${o.command.name}: ${o.error}`));
      // A command whose current value could not be read is left out of the diff by
      // design (diffPlan: never write on a value you did not confirm), which also leaves
      // it out of the residual — so without this it reads as a parameter that matched,
      // and it also ended the converge loop early.

      report.errors.push(...result.readErrors.map((e) => `p${pass} read: ${e}`));
      readFailures += result.readErrors.length;
      for (const c of result.unread) {
        const key = addresses.get(`${c.paramId}:${c.y}`);
        if (key) unreadKeys.add(key);
      }

      report.phase = "verify";
      // Keep the trace of a pass that did not converge, with the captured state of
      // the addresses that stayed wrong: the summary below records the end state,
      // and this is what says how it got there.
      if (residual.length) {
        const baseline = residual.map((d) => captured.get(cmdAddr(d.command))).filter((v) => v !== undefined);
        report.traces.push({ pass, baseline, rounds: result.trace });
      }
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
    report.ok = !report.aborted && report.residual.length === 0 && readFailures === 0;

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
        confirmed: !collision && exercised.has(m.key) && mismatches.length === 0 && !unreadKeys.has(m.key),
      };
    });

    // 3. Restore the original state (converging, for the same reset behavior).
    // Skipped on cancel: the device is left silent (safe by makeSilent), and a
    // restore would only re-run the round-trips the user just cancelled.
    if (!report.aborted) {
      report.phase = "restore";
      report.diag.unrestorable = [...unrestorable.values()].map((c) => `${c.name} ${formatAddrKey(cmdAddr(c))}`);
      // includeDeviceDriven widens the restore — and only the restore — to the bands
      // the app never authors while EQ 1-knob is on, because the unit drives them. A
      // capture holding 1-knob ON otherwise emits none of them while every sweep pass
      // wrote them, so the unit ends with a VISIBLE EQ change under a verdict that says
      // it was restored. The unit keeps such a write (measured; see EmitOptions), and
      // the residual now covers the same set, so a unit that did re-derive would be
      // reported rather than passed over.
      const back = await phaseStep(
        sendConverging(model, original, { settleMs, signal, trace: true, emit: RESTORE_EMIT }),
      );
      if (back) {
        report.diag.restoreRounds = back.trace.map((r) => ({
          sent: r.sent.length,
          bands: r.sent.filter((c) => c.name.startsWith("EQ_BAND")).length,
          oneKnob: r.sent.filter((c) => c.name.startsWith("EQ_ONE_KNOB")).length,
          residual: r.reread?.length ?? null,
        }));
        // Read back the band gains the restore just wrote, before anything else can
        // touch the unit. RESTORE_EMIT, not the default: the default omits exactly the
        // bands this exists to watch — the ones under EQ 1-knob — so asking with it
        // inspects nothing in the one configuration that motivated the field.
        if (!(await phaseStep(probeBands(model, original, signal, report)))) return report;
        report.restoreResidual = back.residual.length;
        // Same for the restore, and it matters more here: a read failure also ENDS the
        // converge loop (sendConverging stops on one), so the write may have stopped
        // part-way. Counting them keeps `restored` a statement about what was checked.
        report.errors.push(...back.readErrors.map((e) => `restore read: ${e}`));
        report.restoreResidual += back.readErrors.length;

        // Then the addresses that write has no command for, put back from what the unit
        // held before the sweep. Last, so the converging write's side-effect resets have
        // already landed.
        const unsent = await phaseStep(restoreUnsent(unrestorable, preSweep, settleMs, signal, report));
        if (unsent === undefined) return report; // cancelled during the write-back
        report.restoreResidual += unsent;
        report.restored = report.restoreResidual === 0;
        report.phase = "done";
      }
    }
    return report;
  } finally {
    await vdDisconnect(device.epoch);
  }
}

/**
 * Read what the unit holds at the addresses the restore has no command for, before
 * anything perturbs them. An address that cannot be read is left OUT of the result: the
 * run then neither writes it back nor claims it did, and the caller counts the shortfall
 * into the residual. Recording it as readable-but-unknown would be the worse shape —
 * restoreUnsent would skip it silently and the verdict would not notice.
 */
async function readPreSweep(
  unrestorable: Map<number, VdCommand>,
  signal: AbortSignal | undefined,
  report: SelfTestReport,
): Promise<Map<number, number>> {
  const preSweep = new Map<number, number>();
  for (const [addr, c] of unrestorable) {
    signal?.throwIfAborted();
    try {
      preSweep.set(addr, await vdGet(c.paramId, c.x, c.y));
    } catch (e) {
      report.errors.push(`pre-sweep read ${formatAddrKey(addr)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return preSweep;
}

/**
 * Read the band gains the restore just wrote, before anything else can touch the unit,
 * and keep only the ones that disagree. Empty here while a later external sweep finds
 * them changed is what separates "the write never went" from "the unit moved it after".
 */
async function probeBands(
  model: DeviceModel,
  original: Plan,
  signal: AbortSignal | undefined,
  report: SelfTestReport,
): Promise<true> {
  for (const c of planToCommands(model, original, "all", RESTORE_EMIT)) {
    if (c.name !== "EQ_BAND_GAIN") continue;
    signal?.throwIfAborted();
    try {
      const got = await vdGet(c.paramId, c.x, c.y);
      if (got !== c.vdValue)
        report.diag.bandsAfterRestore.push({ addr: formatAddrKey(cmdAddr(c)), want: c.vdValue, got });
    } catch {
      report.diag.bandsAfterRestore.push({ addr: formatAddrKey(cmdAddr(c)), want: c.vdValue, got: null });
    }
  }
  return true;
}

/**
 * Write back the addresses the converging restore has no command for, and report how
 * many did not take. `before` is what the unit answered for each ahead of the sweep; an
 * address missing from it was unreadable then, so there is nothing to put back and its
 * failure is already in `errors`.
 *
 * Verified by re-reading past the settle window rather than by trusting the ack: a write
 * is not readable while it is acked, and a read inside that window answers the old value
 * — which would report a restoration that worked as one that failed. Returns the count
 * that still differs, which the caller adds to the residual, so a unit that insists on
 * its own value lands there instead of being passed over.
 */
async function restoreUnsent(
  unrestorable: Map<number, VdCommand>,
  before: Map<number, number>,
  settleMs: number,
  signal: AbortSignal | undefined,
  report: SelfTestReport,
): Promise<number> {
  if (!before.size) return 0;
  for (const [addr, c] of unrestorable) {
    const want = before.get(addr);
    if (want === undefined) continue;
    signal?.throwIfAborted();
    try {
      await vdSet(c.paramId, c.x, c.y, want);
    } catch (e) {
      report.errors.push(`restore ${formatAddrKey(addr)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
  let residual = 0;
  for (const [addr, c] of unrestorable) {
    const want = before.get(addr);
    if (want === undefined) continue;
    signal?.throwIfAborted();
    try {
      const got = await vdGet(c.paramId, c.x, c.y);
      if (got === want) continue;
      residual++;
      // pass -1 = the restore, not a sweep pass.
      report.residual.push({ name: c.name, paramId: c.paramId, x: c.x, y: c.y, expected: want, actual: got, pass: -1 });
    } catch (e) {
      residual++;
      report.errors.push(`restore verify ${formatAddrKey(addr)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return residual;
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
  // The one shape a divergence is printed in, wherever it appears in the report.
  const wroteRead = (name: string, addr: string, wrote: number, read: number | null): string =>
    `${name} @ ${addr} — wrote ${wrote}, read ${read ?? "unreadable"}`;
  const mismatchLine = (m: SelfTestMismatch): string =>
    wroteRead(m.name, `${m.paramId}:${m.x}:${m.y}`, m.expected, m.actual);

  const lines: string[] = [];
  lines.push(`# URX self-test report — ${report.device || "(no device)"}`);
  lines.push("");
  lines.push(`- Result: ${report.ok ? "PASS" : "FAIL"} (phase: ${report.phase})`);
  lines.push(`- Captured groups: ${report.applied}; passes: ${report.passes}; commands written: ${report.written}`);
  lines.push(
    report.phase === "refused"
      ? "- Restored: not applicable — the run refused to start and wrote nothing"
      : `- Restored: ${report.restored ? "yes" : `NO — ${report.restoreResidual} param(s) differ`}`,
  );

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
      for (const m of u.mismatches) lines.push(`  - ${mismatchLine(m)}`);
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
    for (const m of other) lines.push(`- p${m.pass} ${mismatchLine(m)}`);
  }

  if (report.errors.length) {
    lines.push("");
    lines.push("## Issues (read/send failures)");
    for (const e of report.errors) lines.push(`- ${e}`);
  }

  // The time series behind each failing pass. Verbose on purpose: a residual line
  // names the end state, and the question a divergence raises — was it ever sent,
  // what else went out in the same round and in what order, how long did the device
  // have — is answerable only from the rounds themselves.
  for (const t of report.traces) {
    lines.push("");
    lines.push(`## Converge trace — pass ${t.pass}`);
    lines.push("");
    lines.push("Captured value of each address that did not converge (the diff's starting point):");
    for (const b of t.baseline) lines.push(`- ${b.name} @ ${b.addr} = ${b.value}`);
    t.rounds.forEach((r, i) => {
      lines.push("");
      const found =
        r.reread === null ? "no re-read (the round stopped on a send failure)" : `${r.reread.length} still differing`;
      lines.push(`### Round ${i + 1} — sent ${r.sent.length}, ${r.elapsedMs} ms, ${found}`);
      lines.push("");
      lines.push("Sent, in order:");
      for (const c of r.sent) lines.push(`- ${c.name} @ ${formatAddrKey(cmdAddr(c))} = ${c.vdValue}`);
      if (r.reread?.length) {
        lines.push("");
        lines.push("Read back after the settle:");
        for (const d of r.reread) {
          lines.push(`- ${wroteRead(d.command.name, formatAddrKey(cmdAddr(d.command)), d.command.vdValue, d.current)}`);
        }
      }
    });
  }
  lines.push("");
  return lines.join("\n");
}
