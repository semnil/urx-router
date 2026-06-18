import { describe, expect, it } from "vitest";
import { getModel } from "../../models";
import { emptyPlan, ensureFixedConnections } from "../plan";
import { EQ_TYPE_PASS } from "./params";
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

  it("encodes HPF frequency in 0.1 Hz units on mono channels", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams.ch1 = { hpfFreq: 120 };
    plan.nodeParams.ch_5_6 = { hpfFreq: 120 };
    const cmds = planToCommands(model, plan);
    const freq = cmds.find((c) => c.name === "HPF_FREQ");
    // 120 Hz = broker 1200 at param 26:0:0; stereo channels have no HPF.
    expect(freq!.vdValue).toBe(1200);
    expect(freq!.request.uri).toBe("/vd/parameters/26:0:0?operation=value");
    expect(cmds.filter((c) => c.name === "HPF_FREQ")).toHaveLength(1);
  });

  it("omits HPF on stereo channels", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams.ch_5_6 = { hpf: true };
    const cmds = planToCommands(model, plan);
    expect(cmds.some((c) => c.name === "HPF_ON")).toBe(false);
  });

  it("emits mic-strip toggles (+48V / Clip Safe / phase) on mono channels but not stereo", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams.ch1 = { phantom: true, phase: true, clipSafe: true };
    plan.nodeParams.ch_5_6 = { phantom: true, clipSafe: true };
    const cmds = planToCommands(model, plan);
    const phantom = cmds.find((c) => c.name === "PHANTOM");
    const phase = cmds.find((c) => c.name === "PHASE");
    const clip = cmds.find((c) => c.name === "CLIP_SAFE");
    // Mono CH1: +48V=param 0, phase=24, Clip Safe=5, all at y0.
    expect(phantom!.request.uri).toBe("/vd/parameters/0:0:0?operation=value");
    expect(phase!.request.uri).toBe("/vd/parameters/24:0:0?operation=value");
    expect(clip!.request.uri).toBe("/vd/parameters/5:0:0?operation=value");
    // Stereo channels have neither +48V nor Clip Safe.
    expect(cmds.some((c) => ["PHANTOM", "CLIP_SAFE"].includes(c.name) && c.y !== 0)).toBe(false);
    expect(cmds.filter((c) => ["PHANTOM", "PHASE", "CLIP_SAFE"].includes(c.name))).toHaveLength(3);
  });

  it("emits independent L/R phase on a stereo channel (211/212)", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams.ch_5_6 = { phaseL: true, phaseR: false };
    const cmds = planToCommands(model, plan);
    const l = cmds.find((c) => c.name === "PHASE_L");
    const r = cmds.find((c) => c.name === "PHASE_R");
    // CH5/6 = stereo index 0: L=211:0:0, R=212:0:0, independent.
    expect(l!.vdValue).toBe(1);
    expect(l!.request.uri).toBe("/vd/parameters/211:0:0?operation=value");
    expect(r!.vdValue).toBe(0);
    expect(r!.request.uri).toBe("/vd/parameters/212:0:0?operation=value");
  });

  it("emits Insert FX on mono channels but not stereo", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams.ch1 = { insertFx: 257 }; // Crunch
    plan.nodeParams.ch_5_6 = { insertFx: 257 };
    const cmds = planToCommands(model, plan).filter((c) => c.name === "INSERT_FX");
    // Mono CH1 = param 135 at y0, raw enum value 257; stereo has no insert FX.
    expect(cmds).toHaveLength(1);
    expect(cmds[0].vdValue).toBe(257);
    expect(cmds[0].request.uri).toBe("/vd/parameters/135:0:0?operation=value");
  });

  it("emits output insert FX on STEREO (single) and MIX (L/R-linked)", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams["bus.stereo"] = { insertFx: 1793 }; // Compander-H
    plan.nodeParams["bus.mix1"] = { insertFx: 1792 }; // M.Band Comp
    const cmds = planToCommands(model, plan).filter((c) => c.name === "INSERT_FX");
    const stereo = cmds.filter((c) => c.paramId === 578);
    const mix = cmds.filter((c) => c.paramId === 671);
    // STEREO = 578 single; MIX1 = 671 at y0 and y1 (linked).
    expect(stereo.map((c) => c.request.uri)).toEqual(["/vd/parameters/578:0:0?operation=value"]);
    expect(stereo[0].vdValue).toBe(1793);
    expect(mix.map((c) => c.request.uri)).toEqual([
      "/vd/parameters/671:0:0?operation=value",
      "/vd/parameters/671:0:1?operation=value",
    ]);
    expect(mix.every((c) => c.vdValue === 1792)).toBe(true);
  });

  it("emits COMP/EQ type on mono channels but not stereo", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams.ch1 = { compEqType: 1 }; // SSMCS
    plan.nodeParams.ch_5_6 = { compEqType: 1 };
    const cmds = planToCommands(model, plan).filter((c) => c.name === "COMP_EQ_TYPE");
    // Mono CH1 = param 21 at y0, value 1 (SSMCS); stereo channels have none.
    expect(cmds).toHaveLength(1);
    expect(cmds[0].vdValue).toBe(1);
    expect(cmds[0].request.uri).toBe("/vd/parameters/21:0:0?operation=value");
  });

  it("emits channel-strip section ON, swapping COMP/EQ bank by type", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    // CH1 COMP->EQ: standard bank (GATE 28, COMP 34, EQ 44, all 1 = on).
    plan.nodeParams.ch1 = { gateOn: true, compOn: true, eqOn: false };
    // CH2 SSMCS: morphing bank (GATE 28, COMP 94, EQ 106, inverted: 0 = on).
    plan.nodeParams.ch2 = { compEqType: 1, compOn: true, eqOn: true };
    const cmds = planToCommands(model, plan);
    const at = (name: string, y: number) =>
      cmds.find((c) => c.name === name && c.y === y);
    // CH1 (y0): GATE on = 1, COMP on = 1, EQ off = 0 (off is the on-complement).
    expect(at("GATE_ON", 0)!.vdValue).toBe(1);
    expect(at("COMP_ON", 0)!.vdValue).toBe(1);
    expect(at("EQ_ON", 0)!.request.uri).toBe("/vd/parameters/44:0:0?operation=value");
    expect(at("EQ_ON", 0)!.vdValue).toBe(0);
    // CH2 (y1) SSMCS: COMP/EQ use the inverted 94/106 bank, on = 0.
    expect(at("SSMCS_COMP_ON", 1)!.request.uri).toBe("/vd/parameters/94:0:1?operation=value");
    expect(at("SSMCS_COMP_ON", 1)!.vdValue).toBe(0);
    expect(at("SSMCS_EQ_ON", 1)!.request.uri).toBe("/vd/parameters/106:0:1?operation=value");
    expect(at("SSMCS_EQ_ON", 1)!.vdValue).toBe(0);
  });

  it("emits only EQ (no COMP/GATE) on a stereo channel, param 213", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams.ch_5_6 = { eqOn: false, compOn: true, gateOn: true };
    const cmds = planToCommands(model, plan);
    const eq = cmds.filter((c) => c.name === "STEREO_CH_EQ_ON");
    // Stereo EQ = 213 at stereo index 0, normal polarity: off = 0.
    expect(eq.map((c) => c.request.uri)).toEqual(["/vd/parameters/213:0:0?operation=value"]);
    expect(eq[0].vdValue).toBe(0);
    // No GATE/COMP on a stereo channel even though the params were set.
    expect(cmds.some((c) => ["GATE_ON", "COMP_ON", "SSMCS_COMP_ON"].includes(c.name))).toBe(false);
  });

  it("emits Hi-Z only on CH3/CH4, not other channels", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams.ch1 = { hiZ: true };
    plan.nodeParams.ch3 = { hiZ: true };
    const cmds = planToCommands(model, plan).filter((c) => c.name === "HI_Z");
    // CH3 = param 6 at y2; CH1 has no Hi-Z so it is dropped.
    expect(cmds).toHaveLength(1);
    expect(cmds[0].request.uri).toBe("/vd/parameters/6:0:2?operation=value");
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

  it("emits a mono CH → MIX send on both L/R instances with tap", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.connections.push({
      from: "ch1:out",
      to: "bus.mix1:in",
      kind: "send",
      params: { level: 5, pan: 100, tap: "pre" },
    });
    const cmds = planToCommands(model, plan);
    const lvl = cmds.filter((c) => c.name === "SEND_LEVEL");
    // MIX1 mono = base 146: level at 146 and 152 (L/R), both 5 dB = 500.
    expect(lvl.map((c) => c.request.uri)).toEqual([
      "/vd/parameters/146:0:0?operation=value",
      "/vd/parameters/152:0:0?operation=value",
    ]);
    expect(lvl.every((c) => c.vdValue === 500)).toBe(true);
    expect(cmds.filter((c) => c.name === "SEND_ON").every((c) => c.vdValue === 1)).toBe(true);
    const tap = cmds.find((c) => c.name === "SEND_TAP");
    // PRE = 1, single param at base+5 = 151.
    expect(tap!.vdValue).toBe(1);
    expect(tap!.request.uri).toBe("/vd/parameters/151:0:0?operation=value");
  });

  it("emits a stereo CH → MIX send from the 273-based block", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.connections.push({ from: "ch_5_6:out", to: "bus.mix2:in", kind: "send", params: { level: 0 } });
    const cmds = planToCommands(model, plan).filter((c) => c.name === "SEND_LEVEL");
    // Stereo MIX2 = base 273 + 12 = 285: level at 285 and 291, stereo index y0.
    expect(cmds.map((c) => c.request.uri)).toEqual([
      "/vd/parameters/285:0:0?operation=value",
      "/vd/parameters/291:0:0?operation=value",
    ]);
  });

  it("emits a CH → FX send as a single mono level/on/tap, no pan", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.connections.push({
      from: "ch1:out",
      to: "bus.fx1:in",
      kind: "send",
      params: { level: 7.2, pan: 50, tap: "pre" },
    });
    plan.connections.push({ from: "ch_5_6:out", to: "bus.fx2:in", kind: "send", params: { level: 0 } });
    const cmds = planToCommands(model, plan);
    // Mono FX1 block base 193: level 194, on 196, tap 193 (single, no pan).
    const monoLvl = cmds.filter((c) => c.name === "SEND_LEVEL" && c.paramId === 194);
    expect(monoLvl).toHaveLength(1);
    expect(monoLvl[0].vdValue).toBe(720);
    expect(cmds.find((c) => c.name === "SEND_ON" && c.paramId === 196)!.vdValue).toBe(1);
    const tap = cmds.find((c) => c.name === "SEND_TAP" && c.paramId === 193);
    expect(tap!.vdValue).toBe(1);
    // Stereo FX2 = base 320+4 = 324: level 325.
    expect(cmds.some((c) => c.name === "SEND_LEVEL" && c.paramId === 325)).toBe(true);
    // FX sends carry no pan.
    expect(cmds.some((c) => c.name === "SEND_PAN" && [195, 197].includes(c.paramId))).toBe(false);
  });

  it("emits output EQ ON for STEREO (498, single) and MIX (591, L/R-linked)", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams["bus.stereo"] = { eqOn: false };
    plan.nodeParams["bus.mix1"] = { eqOn: false };
    const cmds = planToCommands(model, plan);
    const stereo = cmds.filter((c) => c.name === "STEREO_EQ_ON");
    const mix = cmds.filter((c) => c.name === "OUT_EQ_ON");
    expect(stereo.map((c) => c.request.uri)).toEqual(["/vd/parameters/498:0:0?operation=value"]);
    expect(stereo[0].vdValue).toBe(0);
    expect(mix.map((c) => c.request.uri)).toEqual([
      "/vd/parameters/591:0:0?operation=value",
      "/vd/parameters/591:0:1?operation=value",
    ]);
    expect(mix.every((c) => c.vdValue === 0)).toBe(true);
  });

  it("emits output PEQ band values: STEREO single, MIX L/R-linked, encodings", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    // STEREO LOW band: HPF type, 200 Hz, +6 dB. MIX1 HIGH-MID band: Q 2.0.
    plan.nodeParams["bus.stereo"] = { eqBands: [{ type: EQ_TYPE_PASS, freq: 200, gain: 6 }] };
    plan.nodeParams["bus.mix1"] = { eqBands: [{}, {}, { q: 2 }] };
    const cmds = planToCommands(model, plan);
    // STEREO band1 block base = 498 + 5 = 503; type 504, freq 506, gain 507, single y0.
    const sType = cmds.find((c) => c.name === "EQ_BAND_TYPE" && c.paramId === 504);
    expect(sType!.request.uri).toBe("/vd/parameters/504:0:0?operation=value");
    expect(sType!.vdValue).toBe(EQ_TYPE_PASS);
    expect(cmds.find((c) => c.paramId === 506)!.vdValue).toBe(2000); // 200 Hz × 10
    expect(cmds.find((c) => c.paramId === 507)!.vdValue).toBe(600); // +6 dB centi
    // A pass filter still writes freq/type; gain was set so it is emitted too.
    // MIX1 band3 (HIGH-MID) Q = param 596 + 10 + 2 = 608, both L/R instances.
    const mq = cmds.filter((c) => c.name === "EQ_BAND_Q" && c.paramId === 608);
    expect(mq.map((c) => c.request.uri)).toEqual([
      "/vd/parameters/608:0:0?operation=value",
      "/vd/parameters/608:0:1?operation=value",
    ]);
    expect(mq.every((c) => c.vdValue === 200)).toBe(true); // Q 2.0 × 100
  });

  it("does not emit a filter type for the fixed-peaking mid bands", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    // Set a type on band2 (mid, fixed peaking) — it must be dropped.
    plan.nodeParams["bus.stereo"] = { eqBands: [{}, { type: 2, gain: 3 }] };
    const cmds = planToCommands(model, plan);
    expect(cmds.some((c) => c.name === "EQ_BAND_TYPE")).toBe(false);
    // The gain on that band still emits (param 503 + 5 + 4 = 512).
    expect(cmds.find((c) => c.paramId === 512)!.vdValue).toBe(300);
  });

  it("emits input PEQ in COMP->EQ mode (base 49) but not SSMCS", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    // CH1 COMP->EQ: LOW band gain +12 dB → 49+4 = 53 at input y0.
    plan.nodeParams.ch1 = { eqBands: [{ gain: 12 }] };
    // CH2 SSMCS: no 4-band PEQ, so its band values are dropped.
    plan.nodeParams.ch2 = { compEqType: 1, eqBands: [{ gain: 6 }] };
    const cmds = planToCommands(model, plan);
    const ch1 = cmds.find((c) => c.name === "EQ_BAND_GAIN" && c.y === 0);
    expect(ch1!.request.uri).toBe("/vd/parameters/53:0:0?operation=value");
    expect(ch1!.vdValue).toBe(1200);
    // CH2 (y1) in SSMCS emits no band gain (no PEQ there).
    expect(cmds.some((c) => c.name === "EQ_BAND_GAIN" && c.y === 1)).toBe(false);
  });

  it("emits input PEQ for a stereo channel at base 218", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    // Stereo CH5/6 HIGH band gain -3 dB → 218 + 15 + 4 = 237 at stereo index 0.
    plan.nodeParams.ch_5_6 = { eqBands: [{}, {}, {}, { gain: -3 }] };
    const cmds = planToCommands(model, plan);
    const eq = cmds.find((c) => c.name === "EQ_BAND_GAIN" && c.paramId === 237);
    expect(eq!.request.uri).toBe("/vd/parameters/237:0:0?operation=value");
    expect(eq!.vdValue).toBe(-300);
  });

  it("emits the STEREO master fader on its single instance", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams["bus.stereo"] = { level: 2 };
    const cmds = planToCommands(model, plan);
    const fader = cmds.filter((c) => c.name === "STEREO_MASTER_FADER");
    expect(fader).toHaveLength(1);
    expect(fader[0].vdValue).toBe(200);
    expect(fader[0].request.uri).toBe("/vd/parameters/581:0:0?operation=value");
  });

  it("emits the MIX output fader on both L/R instances", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams["bus.mix2"] = { level: 1.2 };
    const cmds = planToCommands(model, plan).filter((c) => c.name === "OUT_FADER");
    // MIX2 = param 674 at y2 and y3 (linked), 1.2 dB = 120.
    expect(cmds.map((c) => c.request.uri)).toEqual([
      "/vd/parameters/674:0:2?operation=value",
      "/vd/parameters/674:0:3?operation=value",
    ]);
    expect(cmds.every((c) => c.vdValue === 120)).toBe(true);
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
