import { describe, expect, it } from "vitest";
import { getModel } from "../models";
import { defaultPlan } from "../models/initial-state";
import { COLOR_OFF, COLOR_PALETTE } from "./control/params";
import { SAMPLE_RATES } from "./constraints";
import type { Plan } from "./plan";
import { simBindings, type SimValue } from "./sim-map";

const model = getModel("URX44V");
const bindings = simBindings(model);

const binding = (path: string) => {
  const b = bindings.get(path);
  if (!b) throw new Error(`${path} is not bound`);
  return b;
};
const read = (plan: Plan, path: string) => binding(path).read(plan);
const write = (plan: Plan, path: string, value: SimValue) => binding(path).write!(plan, value);

/** A plan whose CH 1/2 pair is STEREO-linked, in PAN or BAL. */
function linked(panBal: 0 | 1): Plan {
  const plan = defaultPlan("URX44V");
  plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, stereoLink: true, panBal };
  return plan;
}

describe("a strip's colour on the SIM", () => {
  it("reads the plan's palette entry as the simulator's swatch, and Off as Off", () => {
    const plan = defaultPlan("URX44V");
    expect(read(plan, "ch.ch1.color")).toBe("#1965ff");
    expect(read(plan, "ch.bus.stereo.color")).toBe("#ce4529");
    plan.nodeColors["ch1"] = COLOR_PALETTE[8].hex.toUpperCase();
    expect(read(plan, "ch.ch1.color")).toBe("#8ce63a");
    plan.nodeColors["ch1"] = COLOR_OFF;
    expect(read(plan, "ch.ch1.color")).toBe("Off");
  });

  it("writes the swatch as the same palette entry of the app, and Off as the app's Off", () => {
    const plan = defaultPlan("URX44V");
    expect(write(plan, "ch.ch1.color", "#ff8200")).toEqual({ kind: "color", id: "ch1", color: COLOR_PALETTE[1].hex });
    expect(write(plan, "ch.fx1.color", "#E6E6E6")).toEqual({
      kind: "color",
      id: "bus.fx1",
      color: COLOR_PALETTE[9].hex,
    });
    expect(write(plan, "ch.ch1.color", "Off")).toEqual({ kind: "color", id: "ch1", color: COLOR_OFF });
    expect(write(plan, "ch.ch1.color", "#123456")).toEqual({ refused: "value" });
  });
});

describe("a source select on the SIM", () => {
  it("draws the chosen input's wire into the channel", () => {
    const plan = defaultPlan("URX44V");
    expect(read(plan, "ch.ch_5_6.source")).toBe("AUX IN");
    expect(write(plan, "ch.ch_5_6.source", "HDMI")).toEqual({ kind: "connect", from: "in.hdmi:out", to: "ch_5_6:in" });
    expect(write(plan, "ch.ch_5_6.source", "USB DAW 3/4")).toEqual({
      kind: "connect",
      from: "in.usbdaw_3_4:out",
      to: "ch_5_6:in",
    });
    expect(write(plan, "ch.ch_5_6.source", "AUX IN")).toEqual({ kind: "none" });
  });

  it("names the partner's source as moving with a mono channel's, and removes the wire for None", () => {
    const plan = defaultPlan("URX44V");
    expect(binding("ch.ch1.source").moves).toEqual(["ch.ch2.source"]);
    expect(binding("ch.ch2.source").moves).toEqual(["ch.ch1.source"]);
    expect(write(plan, "ch.ch2.source", "AUX IN")).toEqual({ kind: "connect", from: "in.aux:out", to: "ch2:in" });
    expect(write(plan, "ch.ch2.source", "None")).toEqual({
      kind: "disconnect",
      from: "in.micline_1_2:out",
      to: "ch2:in",
    });
  });

  it("refuses None where the unit never leaves the input without a source", () => {
    const plan = defaultPlan("URX44V");
    expect(binding("ch.bus.stream.source").values).not.toContain("None");
    expect(write(plan, "ch.bus.stream.source", "None")).toEqual({ refused: "required" });
    expect(write(plan, "monitor.1.source", "None")).toEqual({
      kind: "disconnect",
      from: "bus.stereo:out",
      to: "bus.mon1:in",
    });
  });

  it("draws a recorder track's channel source from its Rec Point tap", () => {
    const plan = defaultPlan("URX44V");
    expect(read(plan, "sd.track.6")).toBe("None");
    expect(read(plan, "sd.track.1")).toBe("CH 3/4");
    expect(write(plan, "sd.track.6", "CH 1/2")).toEqual({
      kind: "connect",
      from: "ch1:out",
      to: "out.sdrec.t7:in",
      tap: true,
    });
    expect(write(plan, "sd.track.6", "CH 11/12")).toEqual({
      kind: "connect",
      from: "ch_11_12:out",
      to: "out.sdrec.t7:in",
      tap: true,
    });
    expect(write(plan, "sd.track.6", "MIX 2")).toEqual({
      kind: "connect",
      from: "bus.mix2:out",
      to: "out.sdrec.t7:in",
    });
    expect(write(plan, "sd.track.0", "None")).toEqual({ kind: "disconnect", from: "ch1:out", to: "out.sdrec.t1:in" });
  });
});

describe("a USB output's patch on the SIM", () => {
  it("reads two wires from a mono pair as that pair", () => {
    const plan = defaultPlan("URX44V");
    plan.connections = plan.connections.filter((c) => c.to !== "out.usbsub:in");
    plan.connections.push({ from: "ch1:out", to: "out.usbsub:in", kind: "patch" });
    expect(read(plan, "setup.outputPatch.usbSub")).toBe("CH 1");
    plan.connections.push({ from: "ch2:out", to: "out.usbsub:in", kind: "patch" });
    expect(read(plan, "setup.outputPatch.usbSub")).toBe("CH 1/2");
  });

  it("takes a mono pair in one choice: one drop where the board completes it, two where it does not", () => {
    const unlinked = defaultPlan("URX44V");
    expect(write(unlinked, "setup.outputPatch.usbSub", "CH 1/2")).toEqual({
      kind: "steps",
      steps: [
        { kind: "connect", from: "ch1:out", to: "out.usbsub:in", tap: true },
        { kind: "connect", from: "ch2:out", to: "out.usbsub:in", tap: true },
      ],
    });
    expect(write(linked(0), "setup.outputPatch.usbSub", "CH 1/2")).toEqual({
      kind: "connect",
      from: "ch1:out",
      to: "out.usbsub:in",
      tap: true,
    });
    const half = defaultPlan("URX44V");
    half.connections = half.connections.filter((c) => c.to !== "out.usbsub:in");
    half.connections.push({ from: "ch1:out", to: "out.usbsub:in", kind: "patch" });
    expect(write(half, "setup.outputPatch.usbSub", "CH 1/2")).toEqual({
      kind: "connect",
      from: "ch2:out",
      to: "out.usbsub:in",
      tap: true,
    });
    expect(write(half, "setup.outputPatch.usbSub", "CH 5/6")).toEqual({
      kind: "connect",
      from: "ch_5_6:out",
      to: "out.usbsub:in",
      tap: true,
    });
  });
});

describe("a MONO IN pair's shared values on the SIM", () => {
  it("reads and writes Signal Type and PAN/BAL on the primary from either member", () => {
    const plan = defaultPlan("URX44V");
    expect(binding("ch.ch2.signalType").moves).toEqual(["ch.ch1.signalType"]);
    expect(write(plan, "ch.ch2.signalType", "STEREO")).toEqual({
      kind: "node",
      id: "ch1",
      patch: { stereoLink: true },
    });
    expect(write(plan, "ch.ch2.panBal", "BAL")).toEqual({ refused: "unlinked" });
    const pair = linked(0);
    expect(read(pair, "ch.ch2.signalType")).toBe("STEREO");
    expect(read(pair, "ch.ch2.panBal")).toBe("PAN");
    expect(write(pair, "ch.ch2.panBal", "BAL")).toEqual({ kind: "node", id: "ch1", patch: { panBal: 1 } });
  });

  it("reads the pair's balance off the primary's main path only in BAL, where it moves with its pan", () => {
    expect(binding("ch.ch1.balance").moves).toEqual(["ch.ch1.pan"]);
    expect(binding("ch.ch1.pan").moves).toContain("ch.ch1.balance");
    const pan = linked(0);
    expect(read(pan, "ch.ch1.balance")).toBeUndefined();
    expect(write(pan, "ch.ch1.balance", 10)).toEqual({ refused: "notBal" });
    const bal = linked(1);
    const main = bal.connections.find((c) => c.from === "ch1:out" && c.to === "bus.stereo:in")!;
    main.params = { ...main.params, pan: -20 };
    expect(read(bal, "ch.ch1.balance")).toBe(-20);
    expect(write(bal, "ch.ch1.balance", 10)).toEqual({
      kind: "send",
      from: "ch1",
      to: "bus.stereo",
      patch: { pan: 10 },
    });
  });
});

describe("the oscillator's assign on the SIM", () => {
  it("turns one side on where there is no wire, drawing it with the other side off", () => {
    const plan = defaultPlan("URX44V");
    expect(read(plan, "osc.assign.mix1L")).toBe(false);
    expect(binding("osc.assign.mix1L").moves).toBeUndefined();
    const edit = write(plan, "osc.assign.mix1L", true);
    expect(edit).toEqual({
      kind: "steps",
      steps: [
        { kind: "connect", from: "bus.osc:out", to: "bus.mix1:in" },
        { kind: "send", from: "bus.osc", to: "bus.mix1", patch: { oscR: false } },
      ],
    });
    plan.connections.push({ from: "bus.osc:out", to: "bus.mix1:in", kind: "sendSwitch", params: { oscR: false } });
    expect(read(plan, "osc.assign.mix1L")).toBe(true);
    expect(read(plan, "osc.assign.mix1R")).toBe(false);
    expect(write(plan, "osc.assign.mix1L", false)).toEqual({
      kind: "send",
      from: "bus.osc",
      to: "bus.mix1",
      patch: { oscL: false },
    });
    expect(write(defaultPlan("URX44V"), "osc.assign.mix1L", false)).toEqual({ kind: "none" });
  });

  it("switches one side of a drawn stereo wire, and an FX bus by the wire alone", () => {
    const plan = defaultPlan("URX44V");
    expect(write(plan, "osc.assign.stereoR", false)).toEqual({
      kind: "send",
      from: "bus.osc",
      to: "bus.stereo",
      patch: { oscR: false },
    });
    expect(write(plan, "osc.assign.fx1", true)).toEqual({ kind: "connect", from: "bus.osc:out", to: "bus.fx1:in" });
    plan.connections.push({ from: "bus.osc:out", to: "bus.fx1:in", kind: "sendSwitch" });
    expect(read(plan, "osc.assign.fx1")).toBe(true);
    expect(write(plan, "osc.assign.fx1", false)).toEqual({ kind: "disconnect", from: "bus.osc:out", to: "bus.fx1:in" });
  });
});

describe("a send's ON switch on the SIM", () => {
  it("switches a wired send, and refuses one into a bus the rate has taken away", () => {
    const plan = defaultPlan("URX44V");
    expect(read(plan, "ch.ch1.send.fx2.on")).toBe(true);
    expect(write(plan, "ch.ch1.send.fx2.on", false)).toEqual({
      kind: "send",
      from: "ch1",
      to: "bus.fx2",
      patch: { on: false },
    });
    plan.sampleRate = 192000;
    expect(write(plan, "ch.ch1.send.fx2.on", false)).toEqual({ refused: "rate" });
    expect(write(plan, "ch.ch1.send.fx2.level", -10), "the unit offers no FX 2 send at this rate").toEqual({
      refused: "rate",
    });
    expect(write(plan, "ch.ch1.send.fx2.pre", true)).toEqual({ refused: "rate" });
    expect(write(plan, "ch.ch1.send.fx1.level", -10)).toEqual({
      kind: "send",
      from: "ch1",
      to: "bus.fx1",
      patch: { level: -10 },
    });
    expect(write(plan, "ch.ch1.send.fx1.on", false)).toEqual({
      kind: "send",
      from: "ch1",
      to: "bus.fx1",
      patch: { on: false },
    });
  });

  it("reads an unwired TO ST off and refuses to switch it on", () => {
    const plan = defaultPlan("URX44V");
    expect(read(plan, "ch.bus.mix1.send.bus.stereo.on")).toBe(false);
    expect(write(plan, "ch.bus.mix1.send.bus.stereo.on", true)).toEqual({ refused: "unwired" });
  });
});

describe("the sampling frequency on the SIM", () => {
  it("offers the rates the toolbar offers and writes one as a rate change", () => {
    const plan = defaultPlan("URX44V");
    expect(binding("setup.samplingFrequency").values).toEqual(SAMPLE_RATES);
    expect(binding("setup.samplingFrequency").moves).toEqual(["sd.trackCount"]);
    expect(write(plan, "setup.samplingFrequency", 96000)).toEqual({ kind: "rate", rate: 96000 });
    expect(write(plan, "setup.samplingFrequency", 32000)).toEqual({ refused: "value" });
    expect(write(plan, "setup.samplingFrequency", "96000")).toEqual({ refused: "value" });
  });

  it("refuses a Track Count above what the rate carries", () => {
    const plan = defaultPlan("URX44V");
    plan.sampleRate = 96000;
    expect(write(plan, "sd.trackCount", 16)).toEqual({ refused: "rate" });
    expect(write(plan, "sd.trackCount", 8)).toEqual({ kind: "node", id: "out.sdrec", patch: { sdRecTrackCount: 8 } });
    expect(write(plan, "sd.trackCount", 7)).toEqual({ refused: "value" });
  });
});
