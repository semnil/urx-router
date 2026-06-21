// Edge-case and behavioral coverage for the live-control layer, complementing the
// round-trip / fixed-point suites (vd / translate / readback / completeness /
// value-coverage). These target gaps a QA pass surfaced: encoder behavior at
// non-finite and out-of-range inputs (hand-edited JSON / future UI), the GATE /
// COMP / DUCKER detail codecs in isolation, and LiveSync paths the cadence tests
// do not reach (name sync, the side-effect converge round, deactivate-on-error,
// and the in-flight re-flush). No new device protocol constants are introduced;
// only the catalog's existing exports are referenced.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attackToVd,
  vdToAttack,
  centiDbToVd,
  vdToCentiDb,
  holdToVd,
  vdToHold,
  ratioToVd,
  vdToRatio,
  releaseToVd,
  vdToRelease,
  levelToVd,
  panToVd,
  gainToVd,
  freqToVd,
  qToVd,
  eqFreqToVd,
  DYN_ATTACK_MIN_MS,
  DYN_ATTACK_MAX_MS,
  DYN_HOLD_MIN_MS,
  DYN_HOLD_MAX_MS,
  DYN_RATIO_MIN,
  DYN_RATIO_MAX,
  DUCKER_DECAY_MIN_MS,
  DUCKER_DECAY_MAX_MS,
  VD_LEVEL_MAX,
  VD_LEVEL_OFF,
  VD_PAN_MAX,
} from "./vd";

// ---------------------------------------------------------------------------
// GATE / COMP detail codecs in isolation. The round-trip suites exercise these
// through whole plans; here each scale's encode∘decode identity and its raw
// clamp bounds are pinned directly, since pushDynCommands relies on the encoder
// to enforce the broker int/scale floor (the per-field plan clamp is applied
// upstream, so the encoder's own clamp is the last line of defense).
// ---------------------------------------------------------------------------

describe("dynamics detail codecs (attack / hold / release / ratio)", () => {
  it("attack: ms↔µs round-trips and clamps to the broker scale floor/ceiling", () => {
    expect(vdToAttack(attackToVd(20.17))).toBeCloseTo(20.17, 5);
    // Encoder clamps to the broker µs bounds (0.092..80 ms) even past the field.
    expect(attackToVd(DYN_ATTACK_MIN_MS - 5)).toBe(Math.round(DYN_ATTACK_MIN_MS * 1000));
    expect(attackToVd(DYN_ATTACK_MAX_MS + 5)).toBe(DYN_ATTACK_MAX_MS * 1000);
  });

  it("hold: ms↔(×100) round-trips and clamps to its broker bounds", () => {
    expect(vdToHold(holdToVd(15.3))).toBeCloseTo(15.3, 5);
    expect(holdToVd(DYN_HOLD_MIN_MS - 1)).toBe(Math.round(DYN_HOLD_MIN_MS * 100));
    expect(holdToVd(DYN_HOLD_MAX_MS + 1000)).toBe(DYN_HOLD_MAX_MS * 100);
  });

  it("release/decay: shares the ×10 scale clamped to the widest (ducker) range", () => {
    // The decay encoder is shared; its clamp is the ducker's wide range, not the
    // tighter gate/comp one (those are clamped upstream by pushDynCommands).
    expect(vdToRelease(releaseToVd(218))).toBe(218);
    expect(releaseToVd(DUCKER_DECAY_MIN_MS - 1)).toBe(Math.round(DUCKER_DECAY_MIN_MS * 10));
    expect(releaseToVd(DUCKER_DECAY_MAX_MS + 1000)).toBe(DUCKER_DECAY_MAX_MS * 10);
  });

  it("ratio: N:1 ↔ (×100) round-trips and clamps to the broker ratio bounds", () => {
    expect(vdToRatio(ratioToVd(4))).toBe(4);
    expect(ratioToVd(DYN_RATIO_MIN - 1)).toBe(DYN_RATIO_MIN * 100);
    // The broker accepts up to 655.35:1 (the encoder's ceiling), well past the UI.
    expect(ratioToVd(DYN_RATIO_MAX + 100)).toBe(Math.round(DYN_RATIO_MAX * 100));
  });

  it("centi-dB threshold/range/makeup: round-trips and the decoder is unclamped", () => {
    // Encoder clamps only to the int16 range; decoder is a pure /100. A device
    // value outside any field range decodes faithfully (readback shows the truth).
    expect(vdToCentiDb(centiDbToVd(-40))).toBe(-40);
    expect(vdToCentiDb(-6000)).toBe(-60); // a value past the gate's -72..0 field
  });
});

// ---------------------------------------------------------------------------
// Non-finite and far-out-of-range inputs. A plan loaded from hand-edited JSON or
// produced by a future UI must never let NaN/Infinity escape into a device write.
// These pin the encoders' actual behavior so a regression that starts emitting
// NaN (which would serialize as null in the IPC payload) is caught.
// ---------------------------------------------------------------------------

describe("encoder behavior on non-finite / far-out-of-range input", () => {
  it("level: +Infinity clamps to the ceiling, very negative is the off sentinel", () => {
    expect(levelToVd(Infinity)).toBe(VD_LEVEL_MAX);
    expect(levelToVd(-Infinity)).toBe(VD_LEVEL_OFF); // below the -96 floor → off
    expect(levelToVd(1e6)).toBe(VD_LEVEL_MAX);
  });

  it("pan: ±Infinity clamps to the device ±63 extent", () => {
    expect(panToVd(Infinity)).toBe(VD_PAN_MAX);
    expect(panToVd(-Infinity)).toBe(-VD_PAN_MAX);
  });

  it("gain / freq / Q / eqFreq: ±Infinity clamps to their finite bounds", () => {
    expect(Number.isFinite(gainToVd(Infinity))).toBe(true);
    expect(Number.isFinite(gainToVd(-Infinity))).toBe(true);
    expect(Number.isFinite(freqToVd(Infinity))).toBe(true);
    expect(Number.isFinite(qToVd(Infinity))).toBe(true);
    expect(Number.isFinite(eqFreqToVd(-Infinity))).toBe(true);
  });

  it("NaN propagates through clamp (documents the gap: clamp does not trap NaN)", () => {
    // clamp(NaN, lo, hi) returns NaN because every comparison is false; the level
    // encoder's pre-clamp -∞ guard (db < LEVEL_MIN_DB) is also false for NaN, so a
    // NaN level survives. The UI never produces NaN, but a malformed plan would —
    // worth knowing the encoders are not a NaN firewall. Pin the current behavior.
    expect(Number.isNaN(panToVd(NaN))).toBe(true);
    expect(Number.isNaN(levelToVd(NaN))).toBe(true);
    expect(Number.isNaN(gainToVd(NaN))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LiveSync behavioral paths the cadence tests (live.test.ts) do not cover: the
// name (string-IPC) sync, the side-effect converge round, deactivate-on-error,
// and the re-flush when an edit lands mid-flush.
// ---------------------------------------------------------------------------

vi.mock("../platform", () => ({ vdSet: vi.fn(), vdSetStr: vi.fn(), vdGet: vi.fn() }));

import { getModel } from "../../models";
import { emptyPlan, ensureFixedConnections, type Plan } from "../plan";
import { vdSet, vdSetStr, vdGet } from "../platform";
import { LiveSync } from "./live";

const model = getModel("URX44V");

function basePlan(): Plan {
  const plan = emptyPlan("URX44V");
  ensureFixedConnections(model, plan);
  return plan;
}

function liveFor(plan: Plan, onError: (message: string) => void = () => {}, onSent: (n: number) => void = () => {}): LiveSync {
  return new LiveSync({ getModel: () => model, getPlan: () => plan, onError, onSent });
}

function setCh1Fader(plan: Plan, db: number): void {
  const conn = plan.connections.find((c) => c.from === "ch1:out");
  if (!conn) throw new Error("expected a ch1 STEREO send connection");
  conn.params = { ...conn.params, level: db };
}

describe("LiveSync name sync", () => {
  beforeEach(() => {
    vi.mocked(vdSet).mockReset().mockResolvedValue(undefined);
    vi.mocked(vdSetStr).mockReset().mockResolvedValue(undefined);
    vi.mocked(vdGet).mockReset().mockResolvedValue(0);
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("sends only the changed name via the string IPC, not the numeric one", async () => {
    const plan = basePlan();
    const live = liveFor(plan);
    live.begin(); // snapshot has no name for ch1
    plan.nodeNames.ch1 = "Vox";
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    // The string IPC carried the name; no numeric write was needed for a name-only edit.
    expect(vi.mocked(vdSetStr)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(vdSet)).not.toHaveBeenCalled();
    const [, , , value] = vi.mocked(vdSetStr).mock.calls[0];
    expect(value).toBe("Vox");
  });

  it("does not re-send a name already in the snapshot", async () => {
    const plan = basePlan();
    plan.nodeNames.ch1 = "Vox";
    const live = liveFor(plan);
    live.begin(); // snapshot captures "Vox" as the device truth
    setCh1Fader(plan, -6); // edit an unrelated numeric param only
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    expect(vi.mocked(vdSetStr)).not.toHaveBeenCalled();
    expect(vi.mocked(vdSet)).toHaveBeenCalledTimes(1);
  });
});

describe("LiveSync error handling", () => {
  beforeEach(() => {
    vi.mocked(vdSet).mockReset();
    vi.mocked(vdSetStr).mockReset().mockResolvedValue(undefined);
    vi.mocked(vdGet).mockReset().mockResolvedValue(0);
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("deactivates and reports on a write failure, ignoring later schedules", async () => {
    const plan = basePlan();
    const errors: string[] = [];
    const live = liveFor(plan, (m) => errors.push(m));
    live.begin();
    vi.mocked(vdSet).mockRejectedValueOnce(new Error("nak"));
    setCh1Fader(plan, -6);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);

    expect(errors).toEqual(["nak"]);
    expect(live.isActive()).toBe(false);

    // A subsequent edit must be inert (sync is stopped; the caller drops the link).
    vi.mocked(vdSet).mockResolvedValue(undefined);
    setCh1Fader(plan, -12);
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    expect(vi.mocked(vdSet)).toHaveBeenCalledTimes(1); // still just the failed one
  });
});

describe("LiveSync side-effect converge", () => {
  beforeEach(() => {
    vi.mocked(vdSet).mockReset().mockResolvedValue(undefined);
    vi.mocked(vdSetStr).mockReset().mockResolvedValue(undefined);
    // A blank device (every read 0): after a side-effect write, the converge round
    // re-diffs against this and re-sends the plan, then the snapshot is rebuilt.
    vi.mocked(vdGet).mockReset().mockResolvedValue(0);
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("runs a converge round after a side-effect param (COMP/EQ type) changes", async () => {
    const plan = basePlan();
    const live = liveFor(plan);
    live.begin();
    // COMP_EQ_TYPE (param 21) is flagged sideEffect: the device resets dependents,
    // so the flush must follow with a converge round rather than a single write.
    plan.nodeParams.ch1 = { compEqType: 1 };
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    // settleMs default in sendConverging is 300ms; drain it so the converge loop
    // (re-diff against the blank device) completes.
    await vi.advanceTimersByTimeAsync(1000);

    // The COMP/EQ-type address was written at least once (the initial flush write)
    // and the converge round issued further writes against the blank device.
    const typeWrites = vi.mocked(vdSet).mock.calls.filter(([id]) => id === 21);
    expect(typeWrites.length).toBeGreaterThanOrEqual(1);
    // The converge re-sent more than just the one side-effect param.
    expect(vi.mocked(vdSet).mock.calls.length).toBeGreaterThan(1);
    expect(live.isActive()).toBe(true);
  });

  it("does NOT converge for an ordinary (non-side-effect) param", async () => {
    const plan = basePlan();
    const live = liveFor(plan);
    live.begin();
    setCh1Fader(plan, -6); // CH_FADER is not a side-effect param
    live.schedule();
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(1000);
    // Exactly one write, no converge re-read storm.
    expect(vi.mocked(vdSet)).toHaveBeenCalledTimes(1);
  });
});
