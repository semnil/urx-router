import { describe, expect, it } from "vitest";
import { getModel } from "../../models";
import { emptyPlan, ensureFixedConnections } from "../plan";
import { channelInputIndex, planToCommands } from "./translate";

describe("channelInputIndex", () => {
  it("maps mono and stereo channels to the input axis", () => {
    expect(channelInputIndex("ch1")).toBe(0);
    expect(channelInputIndex("ch4")).toBe(3);
    expect(channelInputIndex("ch_5_6")).toBe(4);
    expect(channelInputIndex("ch_11_12")).toBe(10);
  });

  it("rejects non-channel nodes", () => {
    expect(channelInputIndex("bus.stereo")).toBeNull();
    expect(channelInputIndex("out.main")).toBeNull();
  });
});

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

  it("omits node-param commands when none are set", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    const cmds = planToCommands(model, plan);
    expect(cmds.some((c) => c.name === "CH_ON" || c.name === "HPF_ON")).toBe(false);
  });
});
