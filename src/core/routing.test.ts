import { describe, it, expect, beforeEach } from "vitest";
import { MODELS } from "../models/index";
import { ref } from "../models/types";
import { canConnect, isFixedConnection, legalSources, legalTargets, partnerChannel, ruleKind, sendHasTap } from "./routing";
import { emptyPlan, type Plan } from "./plan";

const u44 = MODELS.URX44;

describe("canConnect on URX44", () => {
  let plan: Plan;
  beforeEach(() => {
    plan = emptyPlan("URX44");
  });

  it("allows a legal source select (micline 1/2 -> ch1)", () => {
    expect(canConnect(u44, plan, ref("in.micline_1_2", "out"), ref("ch1", "in")).ok).toBe(true);
  });

  it("rejects an unknown route with noRule", () => {
    const r = canConnect(u44, plan, ref("in.micline_1_2", "out"), ref("out.main", "in"));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("noRule");
  });

  it("rejects an exact duplicate wire with duplicate", () => {
    const from = ref("in.micline_1_2", "out");
    const to = ref("ch1", "in");
    plan.connections.push({ from, to, kind: "source" });
    expect(canConnect(u44, plan, from, to).reason).toBe("duplicate");
  });

  it("rejects a second source into a single-input receiver", () => {
    plan.connections.push({ from: ref("in.micline_1_2", "out"), to: ref("ch1", "in"), kind: "source" });
    const r = canConnect(u44, plan, ref("in.aux", "out"), ref("ch1", "in"));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("singleInput");
  });

  it("accepts summing into a send bus from multiple channels", () => {
    expect(canConnect(u44, plan, ref("ch1", "out"), ref("bus.stereo", "in")).ok).toBe(true);
    plan.connections.push({ from: ref("ch1", "out"), to: ref("bus.stereo", "in"), kind: "send" });
    expect(canConnect(u44, plan, ref("ch2", "out"), ref("bus.stereo", "in")).ok).toBe(true);
  });

  it("accepts MIX 1/2 -> STEREO (TO ST) as a multi-input sendSwitch", () => {
    expect(ruleKind(u44, ref("bus.mix1", "out"), ref("bus.stereo", "in"))).toBe("sendSwitch");
    plan.connections.push({ from: ref("bus.mix1", "out"), to: ref("bus.stereo", "in"), kind: "sendSwitch" });
    expect(canConnect(u44, plan, ref("bus.mix2", "out"), ref("bus.stereo", "in")).ok).toBe(true);
  });

  it("has no CUE bus (a temporary solo bus, cleared at power-off)", () => {
    expect(u44.nodes.some((n) => n.id === "bus.cue")).toBe(false);
    expect(canConnect(u44, plan, ref("ch1", "out"), ref("bus.cue", "in")).reason).toBe("noRule");
    expect(canConnect(u44, plan, ref("bus.cue", "out"), ref("bus.mon1", "in")).reason).toBe("noRule");
  });

  it("keeps a monitor as a single-input source selector", () => {
    plan.connections.push({ from: ref("bus.stereo", "out"), to: ref("bus.mon1", "in"), kind: "source" });
    expect(canConnect(u44, plan, ref("bus.mix1", "out"), ref("bus.mon1", "in")).reason).toBe("singleInput");
  });

  it("has no USB DAW OUT node (CH n -> DAW n is a fixed internal wire)", () => {
    expect(u44.nodes.some((n) => n.id === "out.usbdaw")).toBe(false);
    expect(canConnect(u44, plan, ref("ch1", "out"), ref("out.usbdaw", "in")).reason).toBe("noRule");
  });

  it("offers paired USB DAW returns as channel sources (but not the bulk-set actions)", () => {
    expect(canConnect(u44, plan, ref("in.usbdaw_1_2", "out"), ref("ch1", "in")).ok).toBe(true);
    expect(canConnect(u44, plan, ref("in.usbdaw_11_12", "out"), ref("ch_5_6", "in")).ok).toBe(true);
    // "All Input" / "All USB DAW" are bulk-set actions, not selectable sources.
    expect(u44.nodes.some((n) => n.id === "in.allinput")).toBe(false);
    expect(u44.nodes.some((n) => n.id === "in.allusbdaw")).toBe(false);
  });

  it("enforces single-input on an output patch", () => {
    plan.connections.push({ from: ref("bus.stereo", "out"), to: ref("out.main", "in"), kind: "patch" });
    expect(canConnect(u44, plan, ref("bus.mix1", "out"), ref("out.main", "in")).reason).toBe("singleInput");
  });
});

describe("legalTargets on URX44", () => {
  it("omits an occupied single-input output and keeps free ones", () => {
    const plan = emptyPlan("URX44");
    plan.connections.push({ from: ref("bus.stereo", "out"), to: ref("out.main", "in"), kind: "patch" });
    const targets = legalTargets(u44, plan, ref("bus.mix1", "out"));
    expect(targets.has(ref("out.main", "in"))).toBe(false);
    expect(targets.has(ref("out.line", "in"))).toBe(true);
  });
});

describe("legalSources on URX44", () => {
  it("offers every input source for an empty channel and none once one is taken", () => {
    const plan = emptyPlan("URX44");
    const ch1In = ref("ch1", "in");
    const sources = legalSources(u44, plan, ch1In);
    expect(sources.has(ref("in.micline_1_2", "out"))).toBe(true);
    expect(sources.has(ref("in.aux", "out"))).toBe(true);
    // A single-input receiver offers nothing more once a source is wired.
    plan.connections.push({ from: ref("in.micline_1_2", "out"), to: ch1In, kind: "source" });
    expect(legalSources(u44, plan, ch1In).size).toBe(0);
  });

  it("keeps offering more senders for a summing bus that already has one", () => {
    const plan = emptyPlan("URX44");
    const busIn = ref("bus.stereo", "in");
    plan.connections.push({ from: ref("ch1", "out"), to: busIn, kind: "send" });
    const sources = legalSources(u44, plan, busIn);
    expect(sources.has(ref("ch2", "out"))).toBe(true);
    // The already-wired sender is excluded as a duplicate.
    expect(sources.has(ref("ch1", "out"))).toBe(false);
  });
});

describe("ruleKind", () => {
  it("returns the declared kind for a legal route", () => {
    expect(ruleKind(u44, ref("ch1", "out"), ref("bus.stereo", "in"))).toBe("send");
  });
  it("returns undefined for an illegal route", () => {
    expect(ruleKind(u44, ref("in.micline_1_2", "out"), ref("out.main", "in"))).toBeUndefined();
  });
});

describe("isFixedConnection", () => {
  it("marks every CH / FX-channel send (STEREO main + MIX/FX) as fixed", () => {
    // Main fader paths into STEREO.
    expect(isFixedConnection(u44, ref("ch1", "out"), ref("bus.stereo", "in"))).toBe(true);
    expect(isFixedConnection(u44, ref("ch_5_6", "out"), ref("bus.stereo", "in"))).toBe(true);
    expect(isFixedConnection(u44, ref("bus.fx1", "out"), ref("bus.stereo", "in"))).toBe(true);
    expect(isFixedConnection(u44, ref("bus.fx2", "out"), ref("bus.stereo", "in"))).toBe(true);
    // CH → MIX / FX sends are fixed too: always wired, on/off carried in params.on.
    expect(isFixedConnection(u44, ref("ch1", "out"), ref("bus.mix1", "in"))).toBe(true);
    expect(isFixedConnection(u44, ref("ch_5_6", "out"), ref("bus.fx2", "in"))).toBe(true);
    expect(isFixedConnection(u44, ref("bus.fx1", "out"), ref("bus.mix1", "in"))).toBe(true);
    // MIX 1/2 → STEREO ("TO ST") is fixed too (block diagram); on/off in params.on.
    expect(isFixedConnection(u44, ref("bus.mix1", "out"), ref("bus.stereo", "in"))).toBe(true);
    expect(isFixedConnection(u44, ref("bus.mix2", "out"), ref("bus.stereo", "in"))).toBe(true);
  });

  it("leaves the OSC feeds and output patches into STEREO removable", () => {
    expect(isFixedConnection(u44, ref("bus.osc", "out"), ref("bus.stereo", "in"))).toBe(false);
    expect(isFixedConnection(u44, ref("in.micline_1_2", "out"), ref("out.main", "in"))).toBe(false);
  });
});

describe("sendHasTap", () => {
  it("exposes PRE/POST on editable sends (CH/FX -> MIX/FX)", () => {
    expect(sendHasTap(u44, ref("ch1", "out"), ref("bus.mix1", "in"))).toBe(true);
    expect(sendHasTap(u44, ref("bus.fx1", "out"), ref("bus.mix1", "in"))).toBe(true);
    // OSC -> bus is an on/off assign switch (no PRE/POST), not a tapped send.
    expect(sendHasTap(u44, ref("bus.osc", "out"), ref("bus.stereo", "in"))).toBe(false);
  });

  it("drops PRE/POST on the fixed STEREO / FX-channel main-fader paths", () => {
    expect(sendHasTap(u44, ref("ch1", "out"), ref("bus.stereo", "in"))).toBe(false);
    expect(sendHasTap(u44, ref("ch_5_6", "out"), ref("bus.stereo", "in"))).toBe(false);
    expect(sendHasTap(u44, ref("bus.fx1", "out"), ref("bus.stereo", "in"))).toBe(false);
  });

  it("is false for non-send routes (source / patch / sendSwitch)", () => {
    expect(sendHasTap(u44, ref("in.micline_1_2", "out"), ref("ch1", "in"))).toBe(false);
    expect(sendHasTap(u44, ref("bus.stereo", "out"), ref("out.main", "in"))).toBe(false);
    expect(sendHasTap(u44, ref("bus.mix1", "out"), ref("bus.stereo", "in"))).toBe(false);
  });
});

describe("partnerChannel", () => {
  it("pairs the mono channels (CH1/2, CH3/4) and leaves stereo channels unpaired", () => {
    expect(partnerChannel(u44, "ch1")).toBe("ch2");
    expect(partnerChannel(u44, "ch2")).toBe("ch1");
    expect(partnerChannel(u44, "ch3")).toBe("ch4");
    expect(partnerChannel(u44, "ch_5_6")).toBeUndefined();
  });
});
