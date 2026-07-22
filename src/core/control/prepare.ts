// Experimental: write a distinctive, silent, modified state to the live device
// WITHOUT restoring it — the no-write-back sibling of selftest.ts. It captures the
// device, spreads every writable plan scalar to a distinctive value well inside
// its legal range, and sends the result, leaving that state on the device so a
// scene SAVE/RECALL audit can save it and diff it (see reference/work/urxf).
//
// SAFETY: the written state is silent by construction, exactly like the self-test
// — every output/send level is floored to -inf, the oscillator generator is off,
// and phantom power is off — so mass-writing gains and routing cannot produce hot
// or +48V output. Head-amp gain is left distinctive (not floored): with the
// outputs down it carries no signal, and its round-trip is what we want to audit.
//
// VALUES: each scalar is moved to a value spread across its legal range by a cycled
// set of non-round fractions, never the captured value + 1. Adjacent-to-factory
// nudges (the self-test's perturb) would be ambiguous in a scene readback; a value
// a third of the way up a range, distinct per item, tells a preserved value from a
// lost one at a glance. Ranges come from the encoder bounds in vd.ts, so a written
// value never has to be clamped by the device to become legal.

import type { DeviceModel } from "../../models/types";
import type { Plan } from "../plan";
import { emptyPlan } from "../plan";
import { vdConnect, vdDisconnect } from "../platform";
import { dryRun, reachedAndFailed, sendCommands } from "./client";
import { applyDeviceState } from "./readback";
import { floorSilent } from "./selftest";
import {
  A_GAIN_MIN_DB,
  D_GAIN_MAX_DB,
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
  // Head-amp gain: the intersection of the analog A.Gain and digital D.Gain ranges,
  // so one value is legal on both — a value above the digital max (fine for analog)
  // is rejected by a digital channel (broker 400).
  gain: [A_GAIN_MIN_DB, D_GAIN_MAX_DB],
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
// same state — the pick* helpers already ignore the captured value).
const ON_BY_DEFAULT = new Set(["on", "eqOn"]);

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
      obj[k] = k === "phantom" ? false : !ON_BY_DEFAULT.has(k); // phantom off for safety
      continue;
    }
    if (Array.isArray(v)) {
      for (const el of v) if (el && typeof el === "object") spread(el as Record<string, unknown>, k, ctr);
      continue;
    }
    // Only numbers and nested objects key into the range/option tables.
    const fieldPath = normalizeBand(path ? `${path}.${k}` : k);
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
 * Connect, capture the device, spread every writable scalar to a distinctive
 * silent value, and send it — leaving that state on the device (no restore). The
 * caller must ensure the connected device matches `model`. Read/send failures are
 * collected, not thrown; the connection is always closed.
 */
export async function runPrepareModified(model: DeviceModel, signal?: AbortSignal): Promise<PrepareReport> {
  const report: PrepareReport = { device: "", applied: 0, written: 0, residual: 0, errors: [], aborted: false };
  const device = await vdConnect();
  report.device = device.model;
  try {
    if (device.model !== model.id) {
      report.errors.push(`connected device is ${device.model}, not ${model.id}`);
      return report;
    }
    const captured = emptyPlan(model.id);
    const r0 = await applyDeviceState(model, captured, signal);
    report.applied = r0.applied;
    report.errors.push(...r0.errors);

    const plan = buildModifiedPlan(captured);
    // Write the whole modified plan (dryRun = planToCommands): the values are
    // deliberately distinctive, so almost everything differs from the device anyway
    // — a diffPlan pre-read would re-read the entire device to filter almost nothing.
    // Tolerant send: the live write path aborts the whole operation at the first
    // failure, but a scene audit wants every writable parameter to land. sendCommands
    // stops at the first rejection and marks the rest skipped, so drop the rejected
    // command and retry the remainder — only the genuinely device-locked params are
    // recorded, the rest still get written.
    let commands = dryRun(model, plan);
    const rejected: string[] = [];
    while (commands.length) {
      signal?.throwIfAborted();
      const outcomes = await sendCommands(commands, signal);
      report.written += outcomes.filter((o) => o.ok).length;
      const idx = outcomes.findIndex(reachedAndFailed);
      if (idx === -1) break;
      const c = commands[idx];
      rejected.push(`${c.name}@${c.paramId}:${c.x}:${c.y}: ${outcomes[idx].error ?? "rejected"}`);
      commands = commands.slice(idx + 1);
    }
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
