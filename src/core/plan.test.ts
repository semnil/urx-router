import { describe, it, expect } from "vitest";
import {
  emptyPlan,
  ensureFixedConnections,
  LEVEL_OFF_DB,
  serialize,
  deserialize,
  hasConnection,
  removeConnection,
  PlanError,
  PLAN_FORMAT,
  PLAN_VERSION,
  type Plan,
} from "./plan";
import { DEFAULT_SAMPLE_RATE } from "./constraints";
import { MODELS } from "../models/index";
import { ref } from "../models/types";

describe("emptyPlan", () => {
  it("starts with the default rate and no positions, connections, hidden nodes or notes", () => {
    const p = emptyPlan("URX44");
    expect(p.modelId).toBe("URX44");
    expect(p.sampleRate).toBe(DEFAULT_SAMPLE_RATE);
    expect(p.positions).toEqual({});
    expect(p.connections).toEqual([]);
    expect(p.nodeParams).toEqual({});
    expect(p.hidden).toEqual([]);
    expect(p.notes).toEqual({});
    expect(p.noteCollapsed).toEqual([]);
  });
});

describe("serialize / deserialize round-trip", () => {
  it("preserves sample rate, positions, connections, params, names, hidden nodes and notes", () => {
    const plan: Plan = {
      modelId: "URX44",
      sampleRate: 96000,
      positions: { ch1: { x: 1, y: 2 } },
      connections: [
        { from: "in.micline_1_2:out", to: "ch1:in", kind: "source" },
        {
          from: "ch1:out",
          to: "bus.stereo:in",
          kind: "send",
          params: { level: -3, pan: 10, tap: "post" },
        },
      ],
      nodeParams: { ch1: { on: false, hpf: true } },
      nodeNames: { ch1: "Lead Vox" },
      nodeColors: { ch1: "#4a78c0" },
      hidden: ["in.usbsub", "out.sdrec"],
      notes: { ch1: "Lead vocal — bump +2 dB for the chorus" },
      noteCollapsed: ["ch1"],
    };
    expect(deserialize(serialize(plan))).toEqual(plan);
  });

  it("defaults nodeParams and nodeNames to {} for a plan saved before the fields existed", () => {
    const legacy = JSON.stringify({
      format: PLAN_FORMAT,
      version: PLAN_VERSION,
      modelId: "URX44",
      connections: [],
    });
    expect(deserialize(legacy).nodeParams).toEqual({});
    expect(deserialize(legacy).nodeNames).toEqual({});
    expect(deserialize(legacy).nodeColors).toEqual({});
  });

  it("embeds the format tag and version", () => {
    const doc = JSON.parse(serialize(emptyPlan("URX22")));
    expect(doc.format).toBe(PLAN_FORMAT);
    expect(doc.version).toBe(PLAN_VERSION);
  });

  it("drops the transient unreadNodes provenance — it is never persisted", () => {
    const plan: Plan = {
      modelId: "URX44",
      sampleRate: 96000,
      positions: { ch1: { x: 1, y: 2 } },
      connections: [{ from: "ch1:out", to: "bus.stereo:in", kind: "send", params: { level: -3 } }],
      nodeParams: { ch1: { on: false, hpf: true } },
      nodeNames: {},
      nodeColors: {},
      hidden: [],
      notes: {},
      noteCollapsed: [],
      // Provenance from a device readback: must not survive serialization.
      unreadNodes: new Set(["ch1", "bus.stereo"]),
    };

    // The JSON document carries no unreadNodes key.
    expect(JSON.parse(serialize(plan))).not.toHaveProperty("unreadNodes");

    const restored = deserialize(serialize(plan));
    expect(restored.unreadNodes).toBeUndefined();
    // Every other field still round-trips unchanged.
    expect(restored.sampleRate).toBe(96000);
    expect(restored.positions).toEqual({ ch1: { x: 1, y: 2 } });
    expect(restored.connections).toEqual(plan.connections);
    expect(restored.nodeParams).toEqual({ ch1: { on: false, hpf: true } });
  });
});

describe("deserialize errors", () => {
  it("rejects a non-plan document with notPlanFile", () => {
    try {
      deserialize(JSON.stringify({ hello: "world" }));
      expect.unreachable("should have thrown PlanError");
    } catch (e) {
      expect(e).toBeInstanceOf(PlanError);
      expect((e as PlanError).code).toBe("notPlanFile");
    }
  });

  it("rejects a plan without a modelId with missingModel", () => {
    const doc = JSON.stringify({ format: PLAN_FORMAT, version: PLAN_VERSION });
    try {
      deserialize(doc);
      expect.unreachable("should have thrown PlanError");
    } catch (e) {
      expect(e).toBeInstanceOf(PlanError);
      expect((e as PlanError).code).toBe("missingModel");
    }
  });

  it("defaults a missing rate, positions, connections, hidden nodes and notes", () => {
    const doc = JSON.stringify({ format: PLAN_FORMAT, version: PLAN_VERSION, modelId: "URX44" });
    const plan = deserialize(doc);
    expect(plan.sampleRate).toBe(DEFAULT_SAMPLE_RATE);
    expect(plan.positions).toEqual({});
    expect(plan.connections).toEqual([]);
    expect(plan.hidden).toEqual([]);
    expect(plan.notes).toEqual({});
    expect(plan.noteCollapsed).toEqual([]);
  });

  // Documents current behavior: an unknown modelId string is NOT rejected here
  // (the UI is expected to guard real model ids). Tighten in deserialize if that
  // assumption ever changes.
  it("does not currently validate that modelId is a real model", () => {
    const doc = JSON.stringify({ format: PLAN_FORMAT, version: PLAN_VERSION, modelId: "NOPE" });
    expect(deserialize(doc).modelId).toBe("NOPE");
  });
});

describe("ensureFixedConnections", () => {
  const u44 = MODELS.URX44;
  const stereo = ref("bus.stereo", "in");

  it("seeds every CH and FX-channel main path into STEREO", () => {
    const plan = emptyPlan("URX44");
    ensureFixedConnections(u44, plan);
    expect(hasConnection(plan, ref("ch1", "out"), stereo)).toBe(true);
    expect(hasConnection(plan, ref("ch_11_12", "out"), stereo)).toBe(true);
    expect(hasConnection(plan, ref("bus.fx1", "out"), stereo)).toBe(true);
    expect(hasConnection(plan, ref("bus.fx2", "out"), stereo)).toBe(true);
    // MIX 1/2 → STEREO ("TO ST") is fixed too, so it is auto-wired (off by default).
    expect(hasConnection(plan, ref("bus.mix1", "out"), stereo)).toBe(true);
    expect(hasConnection(plan, ref("bus.mix2", "out"), stereo)).toBe(true);
    // The OSC feed is an optional assign (not fixed), so it is not auto-wired.
    expect(hasConnection(plan, ref("bus.osc", "out"), stereo)).toBe(false);
  });

  it("seeds FX channels at -∞ and leaves channel main paths at unity", () => {
    const plan = emptyPlan("URX44");
    ensureFixedConnections(u44, plan);
    const fx1 = plan.connections.find((c) => c.from === ref("bus.fx1", "out") && c.to === stereo);
    const ch1 = plan.connections.find((c) => c.from === ref("ch1", "out") && c.to === stereo);
    expect(fx1?.params).toEqual({ level: LEVEL_OFF_DB });
    expect(ch1?.params).toBeUndefined();
  });

  it("seeds the fixed MIX → STEREO (TO ST) switch off, with no level", () => {
    const plan = emptyPlan("URX44");
    ensureFixedConnections(u44, plan);
    const toSt = plan.connections.find((c) => c.from === ref("bus.mix1", "out") && c.to === stereo);
    expect(toSt?.kind).toBe("sendSwitch");
    expect(toSt?.params).toEqual({ on: false });
  });

  it("is idempotent and never duplicates a seeded wire", () => {
    const plan = emptyPlan("URX44");
    ensureFixedConnections(u44, plan);
    const count = plan.connections.length;
    ensureFixedConnections(u44, plan);
    expect(plan.connections.length).toBe(count);
  });

  it("preserves the level/pan of an already-present fixed wire", () => {
    const plan = emptyPlan("URX44");
    plan.connections.push({
      from: ref("ch1", "out"),
      to: stereo,
      kind: "send",
      params: { level: -6, pan: -20 },
    });
    ensureFixedConnections(u44, plan);
    const conn = plan.connections.filter((c) => c.from === ref("ch1", "out") && c.to === stereo);
    expect(conn).toHaveLength(1);
    expect(conn[0].params).toEqual({ level: -6, pan: -20 });
  });
});

describe("hasConnection / removeConnection", () => {
  it("detects and removes a specific wire", () => {
    const plan = emptyPlan("URX44");
    plan.connections.push({ from: "a:out", to: "b:in", kind: "source" });
    expect(hasConnection(plan, "a:out", "b:in")).toBe(true);
    removeConnection(plan, "a:out", "b:in");
    expect(hasConnection(plan, "a:out", "b:in")).toBe(false);
  });
});
