import { describe, it, expect, beforeEach } from "vitest";
import { MODELS } from "../models/index";
import { ref } from "../models/types";
import {
  canConnect,
  duckerKeySource,
  isBalLinkedPair,
  isFixedConnection,
  isNodeInactive,
  legalSources,
  legalTargets,
  mirrorBalPair,
  partnerChannel,
  possibleSources,
  possibleTargets,
  ruleKind,
  sendHasTap,
  sendTapWritable,
  upstreamNodes,
  validatePlan,
} from "./routing";
import { emptyPlan, type Plan, type PlanConnection } from "./plan";
import { defaultPlan } from "../models/initial-state";
import { PAN_BAL_BAL, PAN_BAL_PAN } from "./control/params";

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

describe("possibleTargets / possibleSources keep occupied partners", () => {
  it("includes an occupied single-input target that legalTargets omits", () => {
    const plan = emptyPlan("URX44");
    plan.connections.push({ from: ref("bus.stereo", "out"), to: ref("out.main", "in"), kind: "patch" });
    const from = ref("bus.mix1", "out");
    expect(legalTargets(u44, plan, from).has(ref("out.main", "in"))).toBe(false);
    expect(possibleTargets(u44, from).has(ref("out.main", "in"))).toBe(true);
  });

  it("includes every source of a full single-input receiver that legalSources drops", () => {
    const plan = emptyPlan("URX44");
    const ch1In = ref("ch1", "in");
    plan.connections.push({ from: ref("in.micline_1_2", "out"), to: ch1In, kind: "source" });
    expect(legalSources(u44, plan, ch1In).size).toBe(0);
    expect(possibleSources(u44, ch1In).has(ref("in.aux", "out"))).toBe(true);
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

describe("sendTapWritable", () => {
  it("is true for CH -> MIX and FX-channel -> MIX taps (broker max_value=1)", () => {
    expect(sendTapWritable(u44, ref("ch1", "out"), ref("bus.mix1", "in"))).toBe(true);
    expect(sendTapWritable(u44, ref("bus.fx1", "out"), ref("bus.mix1", "in"))).toBe(true);
  });

  it("is false for CH -> FX taps (read-only: broker max_value=0 rejects a PRE write)", () => {
    expect(sendTapWritable(u44, ref("ch1", "out"), ref("bus.fx1", "in"))).toBe(false);
    expect(sendTapWritable(u44, ref("ch_5_6", "out"), ref("bus.fx2", "in"))).toBe(false);
  });

  it("is false where there is no tap at all (STEREO main path, non-send)", () => {
    expect(sendTapWritable(u44, ref("ch1", "out"), ref("bus.stereo", "in"))).toBe(false);
    expect(sendTapWritable(u44, ref("in.micline_1_2", "out"), ref("ch1", "in"))).toBe(false);
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

describe("isBalLinkedPair / mirrorBalPair", () => {
  let plan: Plan;
  const stereoSend = (id: string): PlanConnection | undefined =>
    plan.connections.find((c) => c.from === ref(id, "out") && c.to === ref("bus.stereo", "in") && c.kind === "send");

  beforeEach(() => {
    plan = defaultPlan("URX44");
  });

  it("is true only when the pair is STEREO-linked in BAL mode", () => {
    expect(isBalLinkedPair(u44, plan, "ch1")).toBe(false); // unlinked
    plan.nodeParams.ch1 = { stereoLink: true, panBal: PAN_BAL_PAN };
    expect(isBalLinkedPair(u44, plan, "ch1")).toBe(false); // PAN mode
    plan.nodeParams.ch1 = { stereoLink: true, panBal: PAN_BAL_BAL };
    expect(isBalLinkedPair(u44, plan, "ch1")).toBe(true); // BAL mode
    expect(isBalLinkedPair(u44, plan, "ch2")).toBe(true); // partner sees the primary's flag
    expect(isBalLinkedPair(u44, plan, "ch3")).toBe(false); // other pair untouched
  });

  it("does not mirror in PAN mode or when unlinked", () => {
    const before = plan.nodeParams.ch2?.gain;
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, stereoLink: true, panBal: PAN_BAL_PAN, gain: 12 };
    expect(mirrorBalPair(u44, plan, "ch1")).toBe(false);
    expect(plan.nodeParams.ch2?.gain).toBe(before); // partner untouched
  });

  it("mirrors node params to the partner, dropping the pair-level fields", () => {
    plan.nodeParams.ch1 = { stereoLink: true, panBal: PAN_BAL_BAL, gain: 12, on: false, eqOn: false };
    expect(mirrorBalPair(u44, plan, "ch1")).toBe(true);
    expect(plan.nodeParams.ch2?.gain).toBe(12);
    expect(plan.nodeParams.ch2?.on).toBe(false);
    expect(plan.nodeParams.ch2?.eqOn).toBe(false);
    // The pair-level flags stay on the primary only.
    expect(plan.nodeParams.ch2?.stereoLink).toBeUndefined();
    expect(plan.nodeParams.ch2?.panBal).toBeUndefined();
  });

  it("preserves the primary's pair flags when mirroring from the secondary", () => {
    plan.nodeParams.ch1 = { stereoLink: true, panBal: PAN_BAL_BAL };
    plan.nodeParams.ch2 = { gain: 5 };
    expect(mirrorBalPair(u44, plan, "ch2")).toBe(true);
    expect(plan.nodeParams.ch1?.gain).toBe(5);
    expect(plan.nodeParams.ch1?.stereoLink).toBe(true);
    expect(plan.nodeParams.ch1?.panBal).toBe(PAN_BAL_BAL);
  });

  it("mirrors a send's level / PRE-POST / ON and the shared BAL pan", () => {
    plan.nodeParams.ch1 = { stereoLink: true, panBal: PAN_BAL_BAL };
    const a = stereoSend("ch1")!;
    const b = stereoSend("ch2")!;
    a.params = { ...a.params, level: -6, tap: "pre", on: false, pan: -40 };
    b.params = { ...b.params, pan: 40 };
    expect(mirrorBalPair(u44, plan, "ch1")).toBe(true);
    expect(stereoSend("ch2")?.params?.level).toBe(-6);
    expect(stereoSend("ch2")?.params?.tap).toBe("pre");
    expect(stereoSend("ch2")?.params?.on).toBe(false);
    expect(stereoSend("ch2")?.params?.pan).toBe(-40); // the BAL pan is one shared value
  });
});

describe("upstreamNodes", () => {
  // A small explicit chain: two inputs feed a channel each, both channels feed a
  // bus, the bus feeds an output. Ids are arbitrary — the walk only reads
  // connections, not the model.
  const chain: PlanConnection[] = [
    { from: ref("inA", "out"), to: ref("ch1", "in"), kind: "source" },
    { from: ref("inB", "out"), to: ref("ch2", "in"), kind: "source" },
    { from: ref("ch1", "out"), to: ref("bus", "in"), kind: "send" },
    { from: ref("ch2", "out"), to: ref("bus", "in"), kind: "send" },
    { from: ref("bus", "out"), to: ref("out", "in"), kind: "patch" },
  ];
  const planOf = (connections: PlanConnection[]): Plan => ({ ...emptyPlan("URX44"), connections });
  const all = () => true;

  it("collects the whole upstream closure of an output, inclusive", () => {
    const got = upstreamNodes(planOf(chain), "out", all);
    expect([...got].sort()).toEqual(["bus", "ch1", "ch2", "inA", "inB", "out"]);
  });

  it("returns only the node itself for a leaf input", () => {
    expect([...upstreamNodes(planOf(chain), "inA", all)]).toEqual(["inA"]);
  });

  it("does not follow connections rejected by the live predicate", () => {
    // Treat ch2's send into the bus as silent: ch2 and its input drop out.
    const live = (c: PlanConnection) => c.from !== ref("ch2", "out");
    const got = upstreamNodes(planOf(chain), "out", live);
    expect([...got].sort()).toEqual(["bus", "ch1", "inA", "out"]);
  });

  it("terminates on a cycle without revisiting", () => {
    const cyclic: PlanConnection[] = [
      { from: ref("a", "out"), to: ref("b", "in"), kind: "send" },
      { from: ref("b", "out"), to: ref("a", "in"), kind: "send" },
    ];
    expect([...upstreamNodes(planOf(cyclic), "a", all)].sort()).toEqual(["a", "b"]);
  });
});

describe("validatePlan on URX44", () => {
  it("passes a freshly seeded factory plan with no problems", () => {
    const plan = defaultPlan("URX44");
    expect(validatePlan(u44, plan)).toEqual([]);
  });

  it("flags a connection with no matching rule as noRule", () => {
    const plan = emptyPlan("URX44");
    const from = ref("in.micline_1_2", "out");
    const to = ref("out.main", "in"); // no such route
    plan.connections.push({ from, to, kind: "source" });
    expect(validatePlan(u44, plan)).toEqual([{ from, to, reason: "noRule" }]);
  });

  it("flags every wire into an over-subscribed single-input receiver as singleInput", () => {
    const plan = emptyPlan("URX44");
    const to = ref("ch1", "in");
    plan.connections.push({ from: ref("in.micline_1_2", "out"), to, kind: "source" });
    plan.connections.push({ from: ref("in.aux", "out"), to, kind: "source" });
    const problems = validatePlan(u44, plan);
    expect(problems.filter((p) => p.reason === "singleInput")).toHaveLength(2);
  });

  it("flags a repeated from->to pair as duplicate", () => {
    const plan = emptyPlan("URX44");
    const conn: PlanConnection = { from: ref("ch1", "out"), to: ref("bus.stereo", "in"), kind: "send" };
    plan.connections.push({ ...conn }, { ...conn });
    expect(validatePlan(u44, plan).some((p) => p.reason === "duplicate")).toBe(true);
  });
});

// isNodeInactive is the shared dim predicate the GRAPH and CONSOLE both read, yet
// had no direct coverage. Each node kind carries its off-state on a different param
// (duckerOn / osc.on / on), and the default polarity differs — a channel is on when
// absent, a ducker/oscillator is off when absent — so each branch needs its own case.
describe("isNodeInactive", () => {
  it("dims a channel / bus / FX / monitor only when its master on is explicitly false", () => {
    const plan = emptyPlan("URX44");
    // Absent params = device default ON, so nothing is dimmed out of the box.
    expect(isNodeInactive(plan, { id: "ch1", kind: "channel" })).toBe(false);
    expect(isNodeInactive(plan, { id: "bus.stereo", kind: "bus" })).toBe(false);
    expect(isNodeInactive(plan, { id: "bus.fx1", kind: "bus" })).toBe(false);
    expect(isNodeInactive(plan, { id: "bus.mon1", kind: "output" })).toBe(false);
    plan.nodeParams.ch1 = { on: false };
    plan.nodeParams["bus.fx1"] = { on: false };
    expect(isNodeInactive(plan, { id: "ch1", kind: "channel" })).toBe(true);
    expect(isNodeInactive(plan, { id: "bus.fx1", kind: "bus" })).toBe(true);
    // on: true reads as active again.
    plan.nodeParams.ch1 = { on: true };
    expect(isNodeInactive(plan, { id: "ch1", kind: "channel" })).toBe(false);
  });

  it("treats a ducker as inactive unless duckerOn is explicitly true (default off)", () => {
    const plan = emptyPlan("URX44");
    // A ducker reads its own duckerOn, not `on`; absent = bypassed = inactive.
    expect(isNodeInactive(plan, { id: "out.ducker1", kind: "ducker" })).toBe(true);
    plan.nodeParams["out.ducker1"] = { duckerOn: true };
    expect(isNodeInactive(plan, { id: "out.ducker1", kind: "ducker" })).toBe(false);
    plan.nodeParams["out.ducker1"] = { duckerOn: false };
    expect(isNodeInactive(plan, { id: "out.ducker1", kind: "ducker" })).toBe(true);
    // A stray top-level `on` must NOT flip a ducker (wrong param for this kind).
    plan.nodeParams["out.ducker1"] = { on: true, duckerOn: false };
    expect(isNodeInactive(plan, { id: "out.ducker1", kind: "ducker" })).toBe(true);
  });

  it("treats the oscillator as inactive unless osc.on is explicitly true (default off)", () => {
    const plan = emptyPlan("URX44");
    // The oscillator's off lives under osc.on, and its default polarity is OFF, so a
    // fresh plan shows it dimmed — the inverse of a channel.
    expect(isNodeInactive(plan, { id: "bus.osc", kind: "input" })).toBe(true);
    plan.nodeParams["bus.osc"] = { osc: { on: true } };
    expect(isNodeInactive(plan, { id: "bus.osc", kind: "input" })).toBe(false);
    plan.nodeParams["bus.osc"] = { osc: { on: false } };
    expect(isNodeInactive(plan, { id: "bus.osc", kind: "input" })).toBe(true);
    // osc present but with no `on` key resolves to inactive.
    plan.nodeParams["bus.osc"] = { osc: { level: -14 } };
    expect(isNodeInactive(plan, { id: "bus.osc", kind: "input" })).toBe(true);
  });

  it("tolerates a plan with no nodeParams map at all (optional-chaining guard)", () => {
    // The predicate reads plan.nodeParams?.[id]; a malformed plan missing the map
    // must not throw. Each kind then falls to its default polarity.
    const bare = { ...emptyPlan("URX44"), nodeParams: undefined as never };
    expect(isNodeInactive(bare, { id: "ch1", kind: "channel" })).toBe(false); // default on
    expect(isNodeInactive(bare, { id: "out.ducker1", kind: "ducker" })).toBe(true); // default off
    expect(isNodeInactive(bare, { id: "bus.osc", kind: "input" })).toBe(true); // default off
  });
});

describe("duckerKeySource", () => {
  it("classifies a channel key as pre-fader and a bus key as post-fader", () => {
    expect(duckerKeySource(u44, ref("ch1", "out"), ref("out.ducker1", "in"))).toBe("channel");
    expect(duckerKeySource(u44, ref("ch_5_6", "out"), ref("out.ducker2", "in"))).toBe("channel");
    expect(duckerKeySource(u44, ref("bus.stereo", "out"), ref("out.ducker1", "in"))).toBe("bus");
    expect(duckerKeySource(u44, ref("bus.mix1", "out"), ref("out.ducker1", "in"))).toBe("bus");
  });

  it("is null when the wire is not a ducker key", () => {
    expect(duckerKeySource(u44, ref("ch1", "out"), ref("bus.stereo", "in"))).toBeNull();
    expect(duckerKeySource(u44, ref("ch1", "out"), ref("out.usbmain_b", "in"))).toBeNull();
  });
});
