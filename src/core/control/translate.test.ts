import { describe, expect, it } from "vitest";
import { getModel } from "../../models";
import { emptyPlan, ensureFixedConnections } from "../plan";
import { planToCommands } from "./translate";

describe("planToCommands", () => {
  const model = getModel("URX44V");

  it("emits fader + pan for each channel's fixed STEREO main path", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    const cmds = planToCommands(model, plan);
    // One CH_FADER + one CH_PAN per channel (4 mono + 4 stereo = 8 channels).
    expect(cmds.filter((c) => c.name === "CH_FADER")).toHaveLength(8);
    expect(cmds.filter((c) => c.name === "CH_PAN")).toHaveLength(8);
  });

  it("encodes edited level and pan into broker values", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    const stereo = plan.connections.find((c) => c.from === "ch1:out" && c.to === "bus.stereo:in");
    stereo!.params = { level: -6, pan: 100 };
    const cmds = planToCommands(model, plan);
    const fader = cmds.find((c) => c.name === "CH_FADER" && c.y === 0);
    const pan = cmds.find((c) => c.name === "CH_PAN" && c.y === 0);
    expect(fader!.vdValue).toBe(-600);
    expect(fader!.request.uri).toBe("/vd/parameters/139:0:0?operation=value");
    expect(pan!.vdValue).toBe(63);
    expect(pan!.request.uri).toBe("/vd/parameters/141:0:0?operation=value");
  });

  it("defaults unedited channels to unity / center", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    const cmds = planToCommands(model, plan);
    const fader = cmds.find((c) => c.name === "CH_FADER" && c.y === 0);
    expect(fader!.vdValue).toBe(0);
  });

  it("emits CH_ON / HPF_ON from node params", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams.ch1 = { on: false, hpf: true, gain: -8 };
    const cmds = planToCommands(model, plan);
    const on = cmds.find((c) => c.name === "CH_ON" && c.y === 0);
    const hpf = cmds.find((c) => c.name === "HPF_ON" && c.y === 0);
    const gain = cmds.find((c) => c.name === "HA_GAIN" && c.y === 0);
    expect(on!.vdValue).toBe(0);
    expect(on!.request.uri).toBe("/vd/parameters/140:0:0?operation=value");
    expect(hpf!.vdValue).toBe(1);
    expect(hpf!.request.uri).toBe("/vd/parameters/25:0:0?operation=value");
    expect(gain!.vdValue).toBe(-800);
    expect(gain!.request.uri).toBe("/vd/parameters/1:0:0?operation=value");
  });

  it("maps stereo D.Gain to its dedicated param on both L/R instances", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams.ch_5_6 = { gain: -24 };
    const cmds = planToCommands(model, plan).filter((c) => c.paramId === 9);
    // CH5/6 D.Gain = param 9, written to y0 and y1 (linked), -24 dB = -2400.
    expect(cmds.map((c) => c.request.uri)).toEqual([
      "/vd/parameters/9:0:0?operation=value",
      "/vd/parameters/9:0:1?operation=value",
    ]);
    expect(cmds.every((c) => c.vdValue === -2400)).toBe(true);
    // It must NOT touch the analog A.Gain param 1.
    expect(planToCommands(model, plan).some((c) => c.paramId === 1)).toBe(false);
  });

  it("maps a stereo channel's fader/pan/ON to the 266/267/268 block", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    const stereo = plan.connections.find((c) => c.from === "ch_5_6:out" && c.to === "bus.stereo:in");
    stereo!.params = { level: -6, pan: 63 };
    plan.nodeParams.ch_5_6 = { on: false };
    const cmds = planToCommands(model, plan);
    const fader = cmds.find((c) => c.name === "CH_FADER" && c.paramId === 266);
    const pan = cmds.find((c) => c.name === "CH_PAN" && c.paramId === 268);
    const on = cmds.find((c) => c.name === "CH_ON" && c.paramId === 267);
    // CH5/6 is stereo index 0; mono params 139/140/141 must not be used.
    expect(fader!.request.uri).toBe("/vd/parameters/266:0:0?operation=value");
    expect(fader!.vdValue).toBe(-600);
    expect(pan!.request.uri).toBe("/vd/parameters/268:0:0?operation=value");
    expect(on!.request.uri).toBe("/vd/parameters/267:0:0?operation=value");
    expect(on!.vdValue).toBe(0);
  });

  it("omits HPF on stereo channels", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams.ch_5_6 = { hpf: true };
    const cmds = planToCommands(model, plan);
    expect(cmds.some((c) => c.name === "HPF_ON")).toBe(false);
  });

  it("emits +48V phantom on mono channels but not stereo", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams.ch1 = { phantom: true };
    plan.nodeParams.ch_5_6 = { phantom: true };
    const cmds = planToCommands(model, plan);
    const mono = cmds.find((c) => c.name === "PHANTOM");
    // Mono CH1 = param 0 at y0; stereo channels have no phantom.
    expect(mono!.vdValue).toBe(1);
    expect(mono!.request.uri).toBe("/vd/parameters/0:0:0?operation=value");
    expect(cmds.filter((c) => c.name === "PHANTOM")).toHaveLength(1);
  });

  it("emits STEREO_MASTER_ON from the stereo bus node param", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams["bus.stereo"] = { on: false };
    const cmds = planToCommands(model, plan);
    const master = cmds.find((c) => c.name === "STEREO_MASTER_ON");
    expect(master!.vdValue).toBe(0);
    expect(master!.request.uri).toBe("/vd/parameters/582:0:0?operation=value");
  });

  it("emits MONITOR_LEVEL for the monitor buses", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams["bus.mon1"] = { level: -6 };
    plan.nodeParams["bus.mon2"] = { level: 0 };
    const cmds = planToCommands(model, plan);
    const m1 = cmds.find((c) => c.name === "MONITOR_LEVEL" && c.y === 0);
    const m2 = cmds.find((c) => c.name === "MONITOR_LEVEL" && c.y === 1);
    expect(m1!.vdValue).toBe(-600);
    expect(m1!.request.uri).toBe("/vd/parameters/724:0:0?operation=value");
    expect(m2!.vdValue).toBe(0);
    expect(m2!.request.uri).toBe("/vd/parameters/724:0:1?operation=value");
  });

  it("omits node-param commands when none are set", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    const cmds = planToCommands(model, plan);
    expect(cmds.some((c) => c.name === "CH_ON" || c.name === "HPF_ON")).toBe(false);
  });
});
