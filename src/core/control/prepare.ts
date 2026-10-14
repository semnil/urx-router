// Experimental: write a distinctive, silent, modified state to the live device
// WITHOUT restoring it — the no-write-back sibling of selftest.ts. It captures the
// device, spreads every writable plan scalar to a distinctive value well inside
// its legal range, and sends the result, leaving that state on the device so a
// scene SAVE/RECALL audit can save it and diff it (see reference/work/urxf).
//
// SAFETY: the written state is silent by construction, exactly like the self-test
// — every output/send level is floored to -inf, the oscillator generator is off,
// and phantom power is off — so mass-writing gains and routing cannot produce hot
// or +48V output. Input gain is left distinctive (not floored): with the outputs
// down it carries no signal, and its round-trip is what we want to audit.
//
// INPUT STAGE: a write carries the input stage of the jacks and sources some channel
// reads. So the run then routes the channels through every input in turn, writing the
// input stage each pass, which puts a distinctive value on every jack and source the
// unit keeps; and it ends by writing the captured routing back, so the unit is left on
// the routing it started with.
//
// VALUES: each scalar is moved to a value spread across its legal range by a cycled
// set of non-round fractions, never the captured value + 1. Adjacent-to-factory
// nudges (the self-test's perturb) would be ambiguous in a scene readback; a value
// a third of the way up a range, distinct per item, tells a preserved value from a
// lost one at a glance. Ranges come from the encoder bounds in vd.ts, so a written
// value never has to be clamped by the device to become legal.

import type { DeviceModel } from "../../models/types";
import { PHANTOM_KEYS } from "../plan";
import type { Plan } from "../plan";
import { vdConnect, vdDisconnect } from "../platform";
import { dryRun, reachedAndFailed, sendCommands } from "./client";
import { captureDeviceState, floorSilent, sweepInputSource } from "./selftest";
import { selectableInputIds } from "./translate";
import type { VdCommand } from "./translate";
import type { ParamName } from "./params";
import {
  A_GAIN_MIN_DB,
  D_GAIN_MAX_DB,
  D_GAIN_MIN_DB,
  HI_Z_A_GAIN_MAX_DB,
  DELAY_TIME_MAX_MS,
  DELAY_TIME_MIN_MS,
  DUCKER_DECAY_MAX_MS,
  DUCKER_DECAY_MIN_MS,
  DYN_ATTACK_MAX_MS,
  DYN_ATTACK_MIN_MS,
  DYN_HOLD_MAX_MS,
  DYN_HOLD_MIN_MS,
  DYN_RELEASE_MAX_MS,
  DYN_RELEASE_MIN_MS,
  EQ_FREQ_MAX_HZ,
  EQ_FREQ_MIN_HZ,
  EQ_GAIN_MAX_DB,
  EQ_GAIN_MIN_DB,
  EQ_Q_MAX,
  EQ_Q_MIN,
  PAN_MAX,
  PAN_MIN,
  PHONES_LEVEL_MAX,
  PHONES_LEVEL_MIN,
  SSMCS_ATTACK_RAW_MAX,
  SSMCS_ATTACK_RAW_MIN,
  SSMCS_COMP_DRIVE_MAX,
  SSMCS_COMP_DRIVE_MIN,
  SSMCS_COMP_INTERNAL_MAX,
  SSMCS_COMP_INTERNAL_MIN,
  SSMCS_FREQ_RAW_MAX,
  SSMCS_FREQ_RAW_MIN,
  SSMCS_GAIN_MAX,
  SSMCS_GAIN_MIN,
  SSMCS_MORPHING_MAX,
  SSMCS_MORPHING_MIN,
  SSMCS_Q_RAW_MAX,
  SSMCS_Q_RAW_MIN,
  SSMCS_RATIO_RAW_MAX,
  SSMCS_RATIO_RAW_MIN,
  SSMCS_RELEASE_RAW_MAX,
  SSMCS_RELEASE_RAW_MIN,
} from "./vd";

export interface PrepareReport {
  device: string;
  /** Body-parameter groups read in the initial capture. */
  applied: number;
  /** Commands the device accepted. */
  written: number;
  /** Commands the device rejected (a genuine device lock: skipped, not aborted on). */
  residual: number;
  /** Read/send failures collected along the way. */
  errors: string[];
  /** True if the user cancelled before the write finished. */
  aborted: boolean;
}

// Non-round, well-separated fractions of a range. Cycling them per scalar keeps
// written values off each other and off the round numbers factory defaults use.
const FRACTIONS = [0.13, 0.61, 0.37, 0.83, 0.29, 0.71, 0.47, 0.91, 0.19, 0.53];

// Legal plan-domain [lo, hi] per dotted field path (band low/mid/high collapse to
// `band`). Backed by the encoder bounds in vd.ts; the GATE/COMP/DUCKER dB fields
// vd.ts clamps only to int16 use a safe in-range window (the device's own DynField
// bounds clamp them tighter upstream, and the readback shows where they landed).
const RANGES: Record<string, [number, number]> = {
  "conn.pan": [PAN_MIN, PAN_MAX],
  // Node-level master balance (STEREO / MIX) and PHONES level (0..10 scale) —
  // both are writable scalars that had no range, so they fell through unspread.
  pan: [PAN_MIN, PAN_MAX],
  phonesLevel: [PHONES_LEVEL_MIN, PHONES_LEVEL_MAX],
  // A jack's A.Gain, inside the window HI-Z leaves it (the spread turns every jack's HI-Z
  // on), and a source's D.Gain.
  gainL: [A_GAIN_MIN_DB, HI_Z_A_GAIN_MAX_DB],
  gainR: [A_GAIN_MIN_DB, HI_Z_A_GAIN_MAX_DB],
  dGain: [D_GAIN_MIN_DB, D_GAIN_MAX_DB],
  "eqOneKnob.level": [0, 100],
  "eqBands.freq": [EQ_FREQ_MIN_HZ, EQ_FREQ_MAX_HZ],
  "eqBands.q": [EQ_Q_MIN, EQ_Q_MAX],
  "eqBands.gain": [EQ_GAIN_MIN_DB, EQ_GAIN_MAX_DB],
  "gate.threshold": [-72, -3],
  "gate.range": [-72, -3],
  "gate.attack": [DYN_ATTACK_MIN_MS, DYN_ATTACK_MAX_MS],
  "gate.hold": [DYN_HOLD_MIN_MS, DYN_HOLD_MAX_MS],
  "gate.decay": [DYN_RELEASE_MIN_MS, DYN_RELEASE_MAX_MS],
  "comp.threshold": [-54, -3],
  "comp.ratio": [1, 20],
  "comp.gain": [0, 18],
  "comp.attack": [DYN_ATTACK_MIN_MS, DYN_ATTACK_MAX_MS],
  "comp.release": [DYN_RELEASE_MIN_MS, DYN_RELEASE_MAX_MS],
  "comp.oneKnobLevel": [0, 100],
  "ducker.threshold": [-54, -3],
  "ducker.range": [-72, -3],
  "ducker.attack": [DYN_ATTACK_MIN_MS, DYN_ATTACK_MAX_MS],
  "ducker.decay": [DUCKER_DECAY_MIN_MS, DUCKER_DECAY_MAX_MS],
  "delay.time": [DELAY_TIME_MIN_MS, DELAY_TIME_MAX_MS],
  "ssmcs.compDrive": [SSMCS_COMP_DRIVE_MIN, SSMCS_COMP_DRIVE_MAX],
  "ssmcs.morphing": [SSMCS_MORPHING_MIN, SSMCS_MORPHING_MAX],
  "ssmcs.outGain": [SSMCS_GAIN_MIN, SSMCS_GAIN_MAX],
  "ssmcs.comp.attack": [SSMCS_ATTACK_RAW_MIN, SSMCS_ATTACK_RAW_MAX],
  "ssmcs.comp.release": [SSMCS_RELEASE_RAW_MIN, SSMCS_RELEASE_RAW_MAX],
  "ssmcs.comp.ratio": [SSMCS_RATIO_RAW_MIN, SSMCS_RATIO_RAW_MAX],
  "ssmcs.comp.threshold": [SSMCS_COMP_INTERNAL_MIN, SSMCS_COMP_INTERNAL_MAX],
  "ssmcs.comp.makeup": [SSMCS_COMP_INTERNAL_MIN, SSMCS_COMP_INTERNAL_MAX],
  "ssmcs.sc.q": [SSMCS_Q_RAW_MIN, SSMCS_Q_RAW_MAX],
  "ssmcs.sc.freq": [SSMCS_FREQ_RAW_MIN, SSMCS_FREQ_RAW_MAX],
  "ssmcs.sc.gain": [SSMCS_GAIN_MIN, SSMCS_GAIN_MAX],
  "ssmcs.eq.band.q": [SSMCS_Q_RAW_MIN, SSMCS_Q_RAW_MAX],
  "ssmcs.eq.band.freq": [SSMCS_FREQ_RAW_MIN, SSMCS_FREQ_RAW_MAX],
  "ssmcs.eq.band.gain": [SSMCS_GAIN_MIN, SSMCS_GAIN_MAX],
};

// Enum / detent fields written by cycling a legal option list (never a blind +1,
// which would drive a small enum out of range). hpfFreq skips its 80 Hz default.
const OPTIONS: Record<string, number[]> = {
  hpfFreq: [40, 60, 100, 120],
  "comp.knee": [0, 1, 2],
  "ssmcs.comp.knee": [0, 1, 2],
};

// Fields left as captured: structural selectors whose change resets a bank or
// rejects sibling writes (compEqType / stereoLink / busType / panBal), the
// preset that repopulates SSMCS (sweetSpotData), the rec-point / insert-FX
// selectors (slot exclusivity / stereo-only options), raw effect engine arrays,
// and the audio levels the silence pass owns. Everything else is spread.
const SKIP = new Set([
  "compEqType",
  "stereoLink",
  "busType",
  "panBal",
  "panLink", // on a VARI MIX it locks the send pan we also write — leave it off
  "recPoint",
  "sweetSpotData",
  "insertFx",
  "insertFxParams",
  "insertFxOn",
  "fxEffect",
  "oneKnob",
  "osc",
  "level",
]);

// Toggles that are ON by factory default: set these off, every other toggle on,
// so the target is non-default AND capture-independent (a re-run converges to the
// same state — the pick* helpers already ignore the captured value). Monitor CUE
// interrupt ships ON, so it belongs here or it lands back on its factory default.
const ON_BY_DEFAULT = new Set(["on", "eqOn", "cueInterrupt"]);

// Collapse a band index (low/mid/high) so the three SSMCS EQ bands share one range key.
const normalizeBand = (path: string): string => path.replace(/\.(low|mid|high)\./g, ".band.");

// A distinctive integer a cycled fraction of the way up [lo, hi], clamped in.
function pickInRange(lo: number, hi: number, i: number): number {
  const v = Math.round(lo + (hi - lo) * FRACTIONS[i % FRACTIONS.length]);
  return v < lo ? lo : v > hi ? hi : v;
}

// Walk a plan sub-tree in place, spreading each scalar. `ctr.n` advances per
// written scalar so consecutive items draw different fractions (distinct values).
function spread(obj: Record<string, unknown>, path: string, ctr: { n: number }): void {
  for (const [k, v] of Object.entries(obj)) {
    if (SKIP.has(k)) continue;
    if (typeof v === "boolean") {
      // +48V off for safety.
      obj[k] = (PHANTOM_KEYS as readonly string[]).includes(k) ? false : !ON_BY_DEFAULT.has(k);
      continue;
    }
    // The PRE/POST tap is a string, not a number/toggle: set it to the non-default
    // PRE so a send tap becomes distinctive too (a read-only CH → FX tap is simply
    // never emitted by planToCommands, so setting it here is harmless).
    if (typeof v === "string") {
      if (k === "tap") obj[k] = "pre";
      continue;
    }
    // The accumulated dotted path for this field (band low/mid/high collapse to `band`).
    const fieldPath = normalizeBand(path ? `${path}.${k}` : k);
    if (Array.isArray(v)) {
      // Recurse with the accumulated prefix, not the bare key, so a nested array's
      // elements still resolve their range keys (today only eqBands is top-level).
      for (const el of v) if (el && typeof el === "object") spread(el as Record<string, unknown>, fieldPath, ctr);
      continue;
    }
    // Only numbers and nested objects key into the range/option tables.
    if (typeof v === "number") {
      const opts = OPTIONS[fieldPath];
      if (opts) obj[k] = opts[ctr.n++ % opts.length];
      else if (RANGES[fieldPath]) obj[k] = pickInRange(RANGES[fieldPath][0], RANGES[fieldPath][1], ctr.n++);
      // No range and no option list: a raw enum/index we cannot bound safely — left
      // as captured so the write stays legal.
    } else if (v && typeof v === "object") {
      spread(v as Record<string, unknown>, fieldPath, ctr);
    }
  }
}

// The channel source selects, and those plus the input stage they put on a jack or source.
const SOURCE_SELECTS: ReadonlySet<ParamName> = new Set([
  "INPUT_SOURCE",
  "STEREO_INPUT_SOURCE_L",
  "STEREO_INPUT_SOURCE_R",
]);
const ROUTING_AND_INPUT_STAGE: ReadonlySet<ParamName> = new Set([
  ...SOURCE_SELECTS,
  "PHANTOM",
  "HA_GAIN",
  "CLIP_SAFE",
  "HI_Z",
  "D_GAIN",
]);

/**
 * Return a distinctive, silent copy of `plan`: every writable scalar spread across
 * its legal range, then the shared silence pass applied. Pure (clones its input) so
 * the value strategy is unit-testable without a device.
 */
export function buildModifiedPlan(plan: Plan): Plan {
  const next = structuredClone(plan);
  const ctr = { n: 0 };
  for (const np of Object.values(next.nodeParams)) spread(np as Record<string, unknown>, "", ctr);
  for (const c of next.connections) if (c.params) spread(c.params as Record<string, unknown>, "conn", ctr);
  floorSilent(next); // shared with the self-test: floor levels, osc + phantom off
  return next;
}

/**
 * The write batches a run sends for a modified plan, in order: the whole plan; then, for each
 * selectable input, the channels routed through that input with the source selects and the
 * input stage they put on a jack or source; then the plan's own source selects, which leaves the
 * unit on the routing it was captured with. Each batch is sent tolerantly on its own.
 */
export function prepareBatches(model: DeviceModel, plan: Plan): VdCommand[][] {
  const batches = [dryRun(model, plan)];
  const inputs = selectableInputIds(model).length;
  for (let pass = 0; pass < inputs; pass++) {
    const routed = structuredClone(plan);
    sweepInputSource(routed, pass, model);
    batches.push(dryRun(model, routed).filter((c) => ROUTING_AND_INPUT_STAGE.has(c.name)));
  }
  if (inputs > 0) batches.push(dryRun(model, plan).filter((c) => SOURCE_SELECTS.has(c.name)));
  return batches;
}

/**
 * Connect, capture the device, spread every writable scalar to a distinctive
 * silent value, and send it — leaving that state on the device (no restore). The
 * caller must ensure the connected device matches `model`. Read/send failures are
 * collected, not thrown; the connection is always closed.
 */
export async function runPrepareModified(model: DeviceModel, signal?: AbortSignal): Promise<PrepareReport> {
  const report: PrepareReport = { device: "", applied: 0, written: 0, residual: 0, errors: [], aborted: false };
  const device = await vdConnect(model.id);
  report.device = device.model;
  try {
    // Connect prologue shared with the self-test: model check + device capture.
    const cap = await captureDeviceState(model, device.model, signal);
    report.applied = cap.applied;
    report.errors.push(...cap.errors);
    if (!cap.ok) return report;

    const plan = buildModifiedPlan(cap.plan);
    // Tolerant send: the live write path aborts the whole operation at the first
    // failure, but a scene audit wants every writable parameter to land. sendCommands
    // stops at the first rejection and marks the rest skipped, so drop the rejected
    // command and retry the remainder — only the genuinely device-locked params are
    // recorded, the rest still get written.
    const rejected: string[] = [];
    const send = async (list: VdCommand[]): Promise<void> => {
      let commands = list;
      while (commands.length) {
        signal?.throwIfAborted();
        const outcomes = await sendCommands(commands, signal);
        report.written += outcomes.filter((o) => o.ok).length;
        const idx = outcomes.findIndex(reachedAndFailed);
        if (idx === -1) break;
        const c = commands[idx];
        // `||`, not `??`: sendCommands always sets `error` to a string on a reached
        // failure, so the nullish form never fired — while an Error carrying an empty
        // message (a rejection with no reason, which the transport can produce) got
        // through it and printed a bare trailing colon. Both are "the device refused
        // and said nothing", and both have to read as that.
        rejected.push(`${c.name}@${c.paramId}:${c.x}:${c.y}: ${outcomes[idx].error || "rejected"}`);
        commands = commands.slice(idx + 1);
      }
    };
    // Write the whole modified plan (dryRun = planToCommands): the values are
    // deliberately distinctive, so almost everything differs from the device anyway
    // — a diffPlan pre-read would re-read the entire device to filter almost nothing.
    for (const batch of prepareBatches(model, plan)) await send(batch);
    report.residual = rejected.length;
    report.errors.push(...rejected);
    return report;
  } catch (e) {
    if (signal?.aborted) {
      report.aborted = true;
      return report;
    }
    throw e;
  } finally {
    await vdDisconnect(device.epoch);
  }
}
