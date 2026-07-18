import { describe, it, expect, vi } from "vitest";
import {
  emptyPlan,
  ensureFixedConnections,
  LEVEL_OFF_DB,
  serialize,
  deserialize,
  decodePlanParam,
  encodePlanParam,
  pipeBytes,
  hasConnection,
  removeConnection,
  PlanError,
  PLAN_FORMAT,
  PLAN_VERSION,
  type Plan,
} from "./plan";
import { defaultPlan } from "../models/initial-state";
import { DEFAULT_SAMPLE_RATE, SAMPLE_RATES } from "./constraints";
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

  // A numeric but OFF-TABLE sampleRate (one the picker has no <option> for) is
  // rejected and replaced with the default, so an opened plan can never carry a
  // rate that desyncs the picker.
  it("rejects a sampleRate that is not in the selectable table", () => {
    const offTable = 22050;
    expect(SAMPLE_RATES).not.toContain(offTable);
    const doc = JSON.stringify({
      format: PLAN_FORMAT,
      version: PLAN_VERSION,
      modelId: "URX44",
      sampleRate: offTable,
    });
    expect(deserialize(doc).sampleRate).toBe(DEFAULT_SAMPLE_RATE);
  });

  it("accepts every rate in the selectable table verbatim", () => {
    for (const rate of SAMPLE_RATES) {
      const doc = JSON.stringify({
        format: PLAN_FORMAT,
        version: PLAN_VERSION,
        modelId: "URX44",
        sampleRate: rate,
      });
      expect(deserialize(doc).sampleRate).toBe(rate);
    }
  });

  it("falls back to the default rate when sampleRate is non-numeric", () => {
    const doc = JSON.stringify({
      format: PLAN_FORMAT,
      version: PLAN_VERSION,
      modelId: "URX44",
      sampleRate: "48000",
    });
    expect(deserialize(doc).sampleRate).toBe(DEFAULT_SAMPLE_RATE);
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

describe("encodePlanParam / decodePlanParam", () => {
  it("round-trips a plan through the compressed z format used by the ?plan= link", async () => {
    const plan = defaultPlan("URX44V");
    plan.nodeNames["ch1"] = "ボーカル"; // multi-byte to exercise UTF-8
    const encoded = await encodePlanParam(plan);
    expect(encoded.startsWith("z")).toBe(true);
    expect(encoded).not.toMatch(/[+/=]/); // URL-safe, unpadded
    expect(deserialize(await decodePlanParam(encoded))).toEqual(plan);
  });

  it("compresses a factory-seeded plan to well under the ~8 KB URL limit", async () => {
    // The whole point of the z format: an uncompressed factory URX44V plan
    // encodes to >30k chars, past GitHub Pages' request-line cap.
    const encoded = await encodePlanParam(defaultPlan("URX44V"));
    expect(encoded.length).toBeLessThan(8000);
  });

  it("round-trips 4-byte UTF-8 (emoji surrogate pairs) through the hand-rolled base64", async () => {
    // The encoder walks the deflated byte array through String.fromCharCode + btoa;
    // surrogate-pair emoji (4-byte code points) are the classic break point for a
    // hand-rolled byte<->base64 loop, so pin one explicitly.
    const plan = emptyPlan("URX22");
    plan.nodeNames["ch1"] = "🎸🥁 Ø 日本語";
    plan.notes["ch1"] = "🎚️ +2 dB 😀";
    const restored = deserialize(await decodePlanParam(await encodePlanParam(plan)));
    expect(restored.nodeNames["ch1"]).toBe("🎸🥁 Ø 日本語");
    expect(restored.notes["ch1"]).toBe("🎚️ +2 dB 😀");
  });

  it("still decodes a legacy uncompressed parameter (pre-compression links)", async () => {
    // Links emitted before the z format are plain URL-safe base64 of the JSON;
    // the JSON always starts "{", so they always start "e" — never "z" — and
    // must keep loading.
    const plan = emptyPlan("URX22");
    plan.nodeNames["ch1"] = "レガシー";
    const json = serialize(plan);
    const legacy = Buffer.from(json, "utf8").toString("base64url");
    expect(legacy.startsWith("e")).toBe(true);
    expect(legacy.startsWith("z")).toBe(false);
    expect(await decodePlanParam(legacy)).toBe(json);
  });

  it("rejects malformed encoded parameters in both formats", async () => {
    await expect(decodePlanParam("not base64 !!!")).rejects.toThrow();
    await expect(decodePlanParam("z!!!")).rejects.toThrow();
    // Valid base64url after "z" but not valid deflate data.
    await expect(decodePlanParam("zeyJmb3JtYXQi")).rejects.toThrow();
  });

  it("decodes invalid UTF-8 lossily instead of rejecting (legacy parity)", async () => {
    // TextDecoder runs non-fatal, matching the pre-compression decoder: bad
    // bytes become U+FFFD and the failure surfaces at the JSON parse instead.
    const legacy = Buffer.from([0x7b, 0xff, 0x7d]).toString("base64url"); // "{" 0xFF "}"
    await expect(decodePlanParam(legacy)).resolves.toBe("{�}");
  });

  it('round-trips pipeBytes in the zlib "deflate" format (the PDF FlateDecode pump)', async () => {
    // storage.ts's PDF export delegates its deflate to pipeBytes with the zlib
    // wrapper format; pin that both directions work alongside deflate-raw.
    const src = new TextEncoder().encode("PDF stream bytes");
    const deflated = await pipeBytes(src, new CompressionStream("deflate"));
    const inflated = await pipeBytes(deflated, new DecompressionStream("deflate"));
    expect(new TextDecoder().decode(inflated)).toBe("PDF stream bytes");
  });

  it("throws the typed browser-floor PlanError when the deflate-raw codec is missing", async () => {
    // Old webviews (Safari <16.4 etc.) lack the codec: both directions must
    // reject with PlanError("planUrlUnsupported") so the UI reports a browser
    // limitation instead of a broken link — while legacy uncompressed params
    // keep decoding without the codec at all.
    const plan = emptyPlan("URX22");
    const legacy = Buffer.from(serialize(plan), "utf8").toString("base64url");
    vi.stubGlobal("CompressionStream", undefined);
    vi.stubGlobal("DecompressionStream", undefined);
    try {
      await expect(encodePlanParam(plan)).rejects.toMatchObject({ name: "PlanError", code: "planUrlUnsupported" });
      await expect(decodePlanParam("zAAAA")).rejects.toMatchObject({ name: "PlanError", code: "planUrlUnsupported" });
      await expect(decodePlanParam(legacy)).resolves.toBe(serialize(plan));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
