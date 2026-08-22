// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import type { Plan } from "../core/plan";
import { defaultPlan } from "../models/initial-state";
import { installTraceProbe, type LedgerEntry, type TraceProbeHooks, type WriteSource } from "./trace-probe";

interface InstalledTrace {
  ledger: LedgerEntry[];
  snapshot: () => Record<string, number> | null;
  depth: () => { undo: number; redo: number };
  rates: () => number[];
  sample: (source: WriteSource) => number;
  clear: () => void;
}

function trace(): InstalledTrace {
  return (window as unknown as { __urxTrace: InstalledTrace }).__urxTrace;
}

function install() {
  let plan = defaultPlan("URX44V");
  let snapshot: Record<string, number> | null = { "1:2:3": 4 };
  let depth = { undo: 2, redo: 1 };
  let rates: number[] = [];
  const hooks: TraceProbeHooks = {
    getPlan: () => plan,
    liveSnapshot: () => snapshot,
    depth: () => depth,
    rates: () => rates,
  };
  const probe = installTraceProbe(hooks);
  return {
    probe,
    plan: () => plan,
    setPlan: (next: Plan) => void (plan = next),
    setSnapshot: (next: Record<string, number> | null) => void (snapshot = next),
    setDepth: (next: { undo: number; redo: number }) => void (depth = next),
    setRates: (next: number[]) => void (rates = next),
  };
}

beforeEach(() => Reflect.deleteProperty(window, "__urxTrace"));

describe("installTraceProbe", () => {
  it("attributes scalar and record deltas with stable sequence and sub-keys", () => {
    const { probe, plan } = install();
    plan().sampleRate = 96_000;
    plan().nodeParams.ch1 = { ...plan().nodeParams.ch1, on: false };

    expect(probe.sample("ui")).toBe(2);
    expect(
      trace().ledger.map(({ seq, source, field, key, subKeys }) => ({ seq, source, field, key, subKeys })),
    ).toEqual([
      { seq: 1, source: "ui", field: "sampleRate", key: undefined, subKeys: undefined },
      { seq: 2, source: "ui", field: "nodeParams", key: "ch1", subKeys: ["on"] },
    ]);
    expect(trace().ledger[0].t).toBeGreaterThanOrEqual(0);
    expect(trace().ledger[1].t).toBe(trace().ledger[0].t);
    expect(probe.sample("unknown")).toBe(0);
    expect(trace().ledger).toHaveLength(2);
  });

  it("records connection parameter keys from both sides of a change", () => {
    const { probe, plan } = install();
    const connection = plan().connections.find((candidate) => candidate.params?.level !== undefined)!;
    const before = connection.params!.level!;
    connection.params = { ...connection.params, level: before + 1 };

    expect(probe.sample("midi")).toBe(1);
    expect(trace().ledger[0]).toMatchObject({ seq: 1, source: "midi", field: "connParams", subKeys: ["level"] });
    expect(trace().ledger[0].key).toContain(connection.from);
    expect(trace().ledger[0].key).toContain(connection.to);
  });

  it("represents a cross-model load even though the plan differ returns no patch", () => {
    const { probe, setPlan } = install();
    setPlan(defaultPlan("URX22"));

    expect(probe.sample("load")).toBe(1);
    expect(trace().ledger).toEqual([expect.objectContaining({ seq: 1, source: "load", field: "plan" })]);
  });

  it("exposes live accessors and clear retakes the current plan baseline", () => {
    const { probe, plan, setSnapshot, setDepth, setRates } = install();
    expect(trace().snapshot()).toEqual({ "1:2:3": 4 });
    expect(trace().depth()).toEqual({ undo: 2, redo: 1 });
    expect(trace().rates()).toEqual([]);

    setSnapshot(null);
    setDepth({ undo: 5, redo: 0 });
    // Read through the hook on every call rather than captured at install: what it
    // answers is whether an announcement is STILL standing, which is a question about
    // the moment it is asked.
    setRates([192_000, 48_000]);
    expect(trace().snapshot()).toBeNull();
    expect(trace().depth()).toEqual({ undo: 5, redo: 0 });
    expect(trace().rates()).toEqual([192_000, 48_000]);

    plan().notes.ch1 = "before clear";
    trace().clear();
    expect(trace().ledger).toEqual([]);
    expect(probe.sample("ui")).toBe(0);

    plan().notes.ch1 = "after clear";
    expect(trace().sample("ui")).toBe(1);
    expect(trace().ledger[0]).toMatchObject({ seq: 1, source: "ui", field: "notes", key: "ch1" });
  });
});
