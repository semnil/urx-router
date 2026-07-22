import { describe, expect, it } from "vitest";
import { SSMCS_INITIAL } from "../plan";
import { defaultPlan } from "../../models/initial-state";
import { ref } from "../../models/types";
import type { NodeParams, Plan } from "../plan";
import { buildModifiedPlan } from "./prepare";

// A node carrying every sub-structure the spread pass touches, at factory-ish
// starting values, so the test exercises each range.
const richNode = (): NodeParams => ({
  on: true,
  hpf: false,
  hpfFreq: 80,
  gain: 0,
  phantom: true,
  gateOn: false,
  gate: { threshold: -20, range: -30, attack: 1, hold: 10, decay: 100 },
  compOn: false,
  comp: { threshold: -18, ratio: 3, knee: 0, gain: 2, attack: 20, release: 150 },
  compEqType: 1,
  busType: 0,
  eqBands: [
    { on: true, type: 0, freq: 100, q: 1, gain: 0 },
    { on: true, type: 0, freq: 1000, q: 1, gain: 0 },
  ],
  ssmcs: structuredClone(SSMCS_INITIAL),
  insertFx: -1,
});

function testPlan(): Plan {
  const plan = defaultPlan("URX44V");
  plan.nodeParams["audit-node"] = richNode();
  plan.connections.push({
    from: ref("audit-node", "out"),
    to: ref("bus.stereo", "in"),
    kind: "send",
    params: { level: 0, pan: 0 },
  });
  return plan;
}

const inRange = (v: number | undefined, lo: number, hi: number): boolean => typeof v === "number" && v >= lo && v <= hi;

describe("buildModifiedPlan value strategy", () => {
  const src = testPlan();
  const out = buildModifiedPlan(src);
  const np = out.nodeParams["audit-node"];
  const ssmcs = np.ssmcs!;

  it("keeps every spread scalar inside its legal range", () => {
    expect(inRange(np.gain, -8, 24)).toBe(true);
    expect([40, 60, 100, 120]).toContain(np.hpfFreq);
    expect(inRange(np.gate!.threshold, -72, -3)).toBe(true);
    expect(inRange(np.gate!.attack, 0.092, 80)).toBe(true);
    expect(inRange(np.gate!.hold, 0.02, 1960)).toBe(true);
    expect(inRange(np.gate!.decay, 9.3, 999)).toBe(true);
    expect(inRange(np.comp!.ratio, 1, 20)).toBe(true);
    expect([0, 1, 2]).toContain(np.comp!.knee);
    expect(inRange(np.eqBands![0].freq, 20, 20000)).toBe(true);
    expect(inRange(np.eqBands![0].q, 0.5, 16)).toBe(true);
    expect(inRange(np.eqBands![0].gain, -18, 18)).toBe(true);
    expect(inRange(ssmcs.compDrive, 0, 200)).toBe(true);
    expect(inRange(ssmcs.comp!.attack, 57, 283)).toBe(true);
    expect([0, 1, 2]).toContain(ssmcs.comp!.knee);
    expect(inRange(ssmcs.sc!.freq, 4, 124)).toBe(true);
    expect(inRange(ssmcs.eq!.low!.freq, 4, 124)).toBe(true);
    expect(inRange(ssmcs.eq!.low!.gain, 0, 360)).toBe(true);
  });

  it("moves values well off their factory value (not an adjacent nudge)", () => {
    expect(Math.abs(np.gate!.threshold! - -20)).toBeGreaterThan(1);
    expect(Math.abs(ssmcs.comp!.attack! - SSMCS_INITIAL.comp.attack)).toBeGreaterThan(1);
    expect(np.eqBands![0].freq).not.toBe(100);
  });

  it("gives adjacent items distinct values", () => {
    // Two EQ bands started identical (freq 100 / 1000 differ, but q/gain matched);
    // the per-scalar fraction cycle should separate their q.
    expect(np.eqBands![0].q).not.toBe(np.eqBands![1].q);
  });

  it("stays silent and safe: levels floored, osc/phantom off", () => {
    expect(np.phantom).toBe(false);
    const conn = out.connections.find((c) => c.params?.pan !== undefined);
    expect(conn!.params!.level).toBeLessThan(-96);
    for (const p of Object.values(out.nodeParams)) if (p.osc) expect(p.osc.on).toBe(false);
  });

  it("leaves structural selectors as captured", () => {
    expect(np.compEqType).toBe(1);
    expect(np.busType).toBe(0);
    expect(np.insertFx).toBe(-1);
    expect(ssmcs.sweetSpotData).toBe(SSMCS_INITIAL.sweetSpotData);
  });

  it("sets toggles to a deterministic non-default (ON-by-default off, others on)", () => {
    expect(np.on).toBe(false); // ON-by-default -> off
    expect(np.gateOn).toBe(true);
    expect(np.hpf).toBe(true);
  });

  it("is idempotent: re-running converges to the same state (no factory reset needed)", () => {
    // The target depends only on which fields exist, not their values, so applying
    // it to an already-modified plan yields the same result — a re-run from a
    // partially-written device still converges cleanly.
    expect(JSON.stringify(buildModifiedPlan(out))).toBe(JSON.stringify(out));
  });
});
