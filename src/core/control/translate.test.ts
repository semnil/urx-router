import { describe, expect, it } from "vitest";
import { getModel } from "../../models";
import { emptyPlan, ensureFixedConnections } from "../plan";
import { COLOR_OFF_INDEX, COLOR_PALETTE, EQ_TYPE_PASS, colorIndexToHex, hexToColorIndex } from "./params";
import { nameControl, planToCommands, planToNameWrites } from "./translate";

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
    // This send's ON params (base 146 → 148 / 154 at ch1's y0) are on; the param
    // id is the send type and y selects the channel, so scope to y0.
    const on = cmds.filter((c) => c.name === "SEND_ON" && c.y === 0 && [148, 154].includes(c.paramId));
    expect(on).toHaveLength(2);
    expect(on.every((c) => c.vdValue === 1)).toBe(true);
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

  it("emits a CH → FX send as a single mono level/on, no pan, no tap", () => {
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
    // Mono FX1 block base 193: level 194, on 196 (single, no pan). FX sends have
    // no settable PRE/POST tap — the broker rejects writing base 193, so it is
    // never emitted (even though the wire carries a tap).
    const monoLvl = cmds.filter((c) => c.name === "SEND_LEVEL" && c.paramId === 194);
    expect(monoLvl).toHaveLength(1);
    expect(monoLvl[0].vdValue).toBe(720);
    expect(cmds.find((c) => c.name === "SEND_ON" && c.paramId === 196)!.vdValue).toBe(1);
    expect(cmds.some((c) => c.name === "SEND_TAP" && c.paramId === 193)).toBe(false);
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

  it("emits EQ 1-knob ON/TYPE/LEVEL at the EQ-ON+2/3/4 ids (mono input 46/47/48)", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams.ch1 = { eqOneKnob: { on: true, type: 1, level: 80 } };
    const cmds = planToCommands(model, plan);
    expect(cmds.find((c) => c.name === "EQ_ONE_KNOB_ON" && c.paramId === 46)!.vdValue).toBe(1);
    expect(cmds.find((c) => c.name === "EQ_ONE_KNOB_TYPE" && c.paramId === 47)!.vdValue).toBe(1); // Vocal
    expect(cmds.find((c) => c.name === "EQ_ONE_KNOB_LEVEL" && c.paramId === 48)!.vdValue).toBe(80);
    expect(cmds.find((c) => c.name === "EQ_ONE_KNOB_LEVEL")!.request.uri).toBe("/vd/parameters/48:0:0?operation=value");
  });

  it("skips the 4-band PEQ commands when 1-knob is on (device drives the bands)", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams.ch1 = { eqOneKnob: { on: true }, eqBands: [{ gain: 12 }] };
    const cmds = planToCommands(model, plan);
    expect(cmds.some((c) => c.name === "EQ_BAND_GAIN" && c.y === 0)).toBe(false);
    // With 1-knob off, the bands emit as usual.
    plan.nodeParams.ch1 = { eqOneKnob: { on: false }, eqBands: [{ gain: 12 }] };
    expect(planToCommands(model, plan).some((c) => c.name === "EQ_BAND_GAIN" && c.y === 0)).toBe(true);
  });

  it("emits EQ 1-knob for output STEREO (500/501/502) and MIX (593-595, L/R linked)", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams["bus.stereo"] = { eqOneKnob: { on: true, type: 2, level: 60 } }; // Loudness
    plan.nodeParams["bus.mix1"] = { eqOneKnob: { on: true, type: 2, level: 50 } };
    const cmds = planToCommands(model, plan);
    expect(cmds.find((c) => c.name === "EQ_ONE_KNOB_TYPE" && c.paramId === 501)!.vdValue).toBe(2);
    expect(cmds.find((c) => c.name === "EQ_ONE_KNOB_LEVEL" && c.paramId === 502)!.vdValue).toBe(60);
    // MIX 1 writes both linked L/R instances (y0, y1).
    const mixLevel = cmds.filter((c) => c.name === "EQ_ONE_KNOB_LEVEL" && c.paramId === 595);
    expect(mixLevel.map((c) => c.y).sort()).toEqual([0, 1]);
    expect(mixLevel.every((c) => c.vdValue === 50)).toBe(true);
  });

  it("emits GATE/COMP detail values with the right encodings", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams.ch1 = {
      gate: { threshold: -40, attack: 10.12, hold: 10.1, decay: 100.1 },
      comp: { threshold: -30, ratio: 4, knee: 0, gain: 6, attack: 20.17, release: 200.3 },
    };
    const cmds = planToCommands(model, plan);
    const v = (name: string) => cmds.find((c) => c.name === name && c.y === 0)!.vdValue;
    // GATE: threshold centi-dB; attack µs; hold ×100; decay ×10.
    expect(v("GATE_THRESHOLD")).toBe(-4000);
    expect(v("GATE_ATTACK")).toBe(10120);
    expect(v("GATE_HOLD")).toBe(1010);
    expect(v("GATE_DECAY")).toBe(1001);
    // COMP: threshold/gain centi-dB; ratio ×100; knee enum; attack µs; release ×10.
    expect(v("COMP_THRESHOLD")).toBe(-3000);
    expect(v("COMP_RATIO")).toBe(400);
    expect(v("COMP_KNEE")).toBe(0);
    expect(v("COMP_GAIN")).toBe(600);
    expect(v("COMP_ATTACK")).toBe(20170);
    expect(v("COMP_RELEASE")).toBe(2003);
  });

  it("emits COMP Auto Makeup / 1-knob params", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams.ch1 = { comp: { autoMakeup: true, oneKnob: true, oneKnobLevel: 50 } };
    const cmds = planToCommands(model, plan);
    expect(cmds.find((c) => c.name === "COMP_AUTO_MAKEUP")!.request.uri).toBe("/vd/parameters/41:0:0?operation=value");
    expect(cmds.find((c) => c.name === "COMP_AUTO_MAKEUP")!.vdValue).toBe(1);
    expect(cmds.find((c) => c.name === "COMP_ONE_KNOB")!.vdValue).toBe(1);
    // 1-knob level is a raw 0-100 value (param 43).
    const lvl = cmds.find((c) => c.name === "COMP_ONE_KNOB_LEVEL")!;
    expect(lvl.request.uri).toBe("/vd/parameters/43:0:0?operation=value");
    expect(lvl.vdValue).toBe(50);
  });

  it("drops COMP detail in SSMCS mode but keeps GATE", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams.ch1 = { compEqType: 1, gate: { threshold: -40 }, comp: { threshold: -30 } };
    const cmds = planToCommands(model, plan);
    expect(cmds.some((c) => c.name === "GATE_THRESHOLD")).toBe(true);
    expect(cmds.some((c) => c.name === "COMP_THRESHOLD")).toBe(false);
  });

  it("emits SSMCS detail (raw) only in SSMCS mode on mono channels", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams.ch1 = {
      compEqType: 1,
      ssmcs: {
        on: true,
        compDrive: 100,
        morphing: 16,
        outGain: 180,
        comp: { attack: 170, release: 159, ratio: 60, knee: 1, threshold: 100, makeup: 70 },
        sc: { on: true, q: 12, freq: 30, gain: 133 },
        eq: { low: { on: true, freq: 32, gain: 180 }, mid: { on: true, q: 12, freq: 72, gain: 243 }, high: { on: true, freq: 112, gain: 180 } },
      },
    };
    const cmds = planToCommands(model, plan);
    const at = (name: string) => cmds.find((c) => c.name === name && c.y === 0);
    // Master ON (89), Comp Drive (95), Morphing (93), Out Gain (117) — raw, y0.
    expect(at("SSMCS_ON")!.request.uri).toBe("/vd/parameters/89:0:0?operation=value");
    expect(at("SSMCS_COMP_DRIVE")!.vdValue).toBe(100);
    expect(at("SSMCS_MORPHING")!.request.uri).toBe("/vd/parameters/93:0:0?operation=value");
    expect(at("SSMCS_OUT_GAIN")!.vdValue).toBe(180);
    // Comp detail raw, Mid Q (111), High freq (115).
    expect(at("SSMCS_COMP_RATIO")!.vdValue).toBe(60);
    expect(at("SSMCS_COMP_THRESHOLD")!.vdValue).toBe(100);
    expect(at("SSMCS_SC_FREQ")!.vdValue).toBe(30);
    expect(at("SSMCS_EQ_MID_Q")!.request.uri).toBe("/vd/parameters/111:0:0?operation=value");
    expect(at("SSMCS_EQ_HIGH_FREQ")!.vdValue).toBe(112);
    // Low/High bands carry no Q.
    expect(cmds.some((c) => c.name === "SSMCS_EQ_LOW_Q" as never)).toBe(false);
  });

  it("emits no SSMCS detail in COMP->EQ mode", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams.ch1 = { compEqType: 0, ssmcs: { compDrive: 100 } };
    const cmds = planToCommands(model, plan);
    expect(cmds.some((c) => c.name.startsWith("SSMCS_"))).toBe(false);
  });

  it("emits no GATE/COMP detail on a stereo channel", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams.ch_5_6 = { gate: { threshold: -40 }, comp: { threshold: -30 } };
    const cmds = planToCommands(model, plan);
    expect(cmds.some((c) => c.name === "GATE_THRESHOLD" || c.name === "COMP_THRESHOLD")).toBe(false);
  });

  it("emits Ducker ON at its parent stereo channel's instance", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    // out.ducker1 hangs under the first stereo channel (ch_5_6 = stereo index 0).
    plan.nodeParams["out.ducker1"] = { duckerOn: true };
    const cmds = planToCommands(model, plan);
    const d = cmds.find((c) => c.name === "DUCKER_ON");
    expect(d!.request.uri).toBe("/vd/parameters/258:0:0?operation=value");
    expect(d!.vdValue).toBe(1);
  });

  it("emits Ducker detail values at the parent stereo channel's instance", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    // out.ducker1 → ch_5_6 (stereo index 0). Decay shares the ×10 release scale.
    plan.nodeParams["out.ducker1"] = { ducker: { threshold: -50, range: -20, attack: 25.63, decay: 1500 } };
    const cmds = planToCommands(model, plan);
    const v = (name: string) => cmds.find((c) => c.name === name && c.y === 0)!;
    expect(v("DUCKER_THRESHOLD").vdValue).toBe(-5000);
    expect(v("DUCKER_RANGE").vdValue).toBe(-2000);
    expect(v("DUCKER_ATTACK").vdValue).toBe(25630);
    // 1500 ms × 10 = 15000 (within the widened release clamp, not truncated).
    expect(v("DUCKER_DECAY").vdValue).toBe(15000);
    expect(v("DUCKER_DECAY").request.uri).toBe("/vd/parameters/263:0:0?operation=value");
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

  it("emits PHONES level per monitor (PHONES 1 ↔ mon1 = y0, PHONES 2 ↔ mon2 = y1)", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["bus.mon1"] = { phonesLevel: 10 };
    plan.nodeParams["bus.mon2"] = { phonesLevel: 0 };
    const cmds = planToCommands(model, plan);
    const p1 = cmds.find((c) => c.name === "PHONES_LEVEL" && c.y === 0);
    const p2 = cmds.find((c) => c.name === "PHONES_LEVEL" && c.y === 1);
    expect(p1!.vdValue).toBe(100); // 10.0 = raw 100
    expect(p1!.request.uri).toBe("/vd/parameters/725:0:0?operation=value");
    expect(p2!.vdValue).toBe(0); // 0.0 = raw 0
    expect(p2!.request.uri).toBe("/vd/parameters/725:0:1?operation=value");
  });

  it("emits monitor CUE-interrupt / MONO toggles per monitor", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["bus.mon1"] = { cueInterrupt: false, mono: true };
    const cmds = planToCommands(model, plan);
    const cue = cmds.find((c) => c.name === "MONITOR_CUE_INTERRUPT" && c.y === 0);
    const mono = cmds.find((c) => c.name === "MONITOR_MONO" && c.y === 0);
    expect(cue!.vdValue).toBe(0);
    expect(cue!.request.uri).toBe("/vd/parameters/721:0:0?operation=value");
    expect(mono!.vdValue).toBe(1);
    expect(mono!.request.uri).toBe("/vd/parameters/722:0:0?operation=value");
  });

  it("emits oscillator generator params from the bus.osc node", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["bus.osc"] = { osc: { on: true, level: -20, mode: 0, freq: 2000 } };
    const cmds = planToCommands(model, plan);
    expect(cmds.find((c) => c.name === "OSC_ON")!.vdValue).toBe(1);
    expect(cmds.find((c) => c.name === "OSC_LEVEL")!.vdValue).toBe(-2000);
    expect(cmds.find((c) => c.name === "OSC_FREQ")!.vdValue).toBe(20000);
    expect(cmds.find((c) => c.name === "OSC_ON")!.request.uri).toBe("/vd/parameters/710:0:0?operation=value");
  });

  it("emits STREAMING DELAY params from the bus.stream node", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["bus.stream"] = { delay: { on: true, time: 100, frameRate: 7 } };
    const cmds = planToCommands(model, plan);
    expect(cmds.find((c) => c.name === "STREAM_DELAY_ON")!.vdValue).toBe(1);
    expect(cmds.find((c) => c.name === "STREAM_DELAY_TIME")!.vdValue).toBe(10000); // 100.00 ms = ms×100
    expect(cmds.find((c) => c.name === "STREAM_DELAY_FRAME_RATE")!.vdValue).toBe(7); // 120 fps index
    expect(cmds.find((c) => c.name === "STREAM_DELAY_ON")!.request.uri).toBe(
      "/vd/parameters/707:0:0?operation=value",
    );
    expect(cmds.find((c) => c.name === "STREAM_DELAY_TIME")!.request.uri).toBe(
      "/vd/parameters/708:0:0?operation=value",
    );
    expect(cmds.find((c) => c.name === "STREAM_DELAY_FRAME_RATE")!.request.uri).toBe(
      "/vd/parameters/830:0:0?operation=value",
    );
  });

  it("omits STREAMING DELAY commands when the bus.stream node has no delay", () => {
    const plan = emptyPlan("URX44V");
    const cmds = planToCommands(model, plan);
    expect(cmds.some((c) => c.name.startsWith("STREAM_DELAY_"))).toBe(false);
  });

  it("emits OSC assign with independent L/R for stereo buses, mono for FX", () => {
    const plan = emptyPlan("URX44V");
    plan.connections.push({
      from: "bus.osc:out",
      to: "bus.stereo:in",
      kind: "sendSwitch",
      params: { oscL: true, oscR: false },
    });
    plan.connections.push({ from: "bus.osc:out", to: "bus.mix2:in", kind: "sendSwitch" });
    plan.connections.push({ from: "bus.osc:out", to: "bus.fx1:in", kind: "sendSwitch" });
    const cmds = planToCommands(model, plan);
    // STEREO: L on (716:0), R off (716:1).
    expect(cmds.find((c) => c.name === "OSC_ASSIGN_STEREO" && c.y === 0)!.vdValue).toBe(1);
    expect(cmds.find((c) => c.name === "OSC_ASSIGN_STEREO" && c.y === 1)!.vdValue).toBe(0);
    // MIX2 defaults both on at instances 2/3.
    expect(cmds.find((c) => c.name === "OSC_ASSIGN_MIX" && c.y === 2)!.vdValue).toBe(1);
    expect(cmds.find((c) => c.name === "OSC_ASSIGN_MIX" && c.y === 3)!.vdValue).toBe(1);
    // FX is mono (one instance, no R): FX1 wired on (y0), FX2 unwired off (y1).
    const fx = cmds.filter((c) => c.name === "OSC_ASSIGN_FX");
    expect(fx.map((c) => [c.y, c.vdValue])).toEqual([
      [0, 1],
      [1, 0],
    ]);
  });

  it("omits node-param commands when none are set", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    const cmds = planToCommands(model, plan);
    expect(cmds.some((c) => c.name === "CH_ON" || c.name === "HPF_ON")).toBe(false);
  });

  it("emits a mono channel pair's input source as L/R ports at adjacent slots", () => {
    const plan = emptyPlan("URX44V");
    plan.connections.push({ from: "in.aux:out", to: "ch1:in", kind: "source" });
    plan.connections.push({ from: "in.aux:out", to: "ch2:in", kind: "source" });
    const cmds = planToCommands(model, plan);
    const c1 = cmds.find((c) => c.name === "INPUT_SOURCE" && c.y === 0);
    const c2 = cmds.find((c) => c.name === "INPUT_SOURCE" && c.y === 1);
    expect(c1!.vdValue).toBe(256);
    expect(c1!.request.uri).toBe("/vd/parameters/22:0:0?operation=value");
    expect(c2!.vdValue).toBe(257);
  });

  it("emits a stereo channel's input source across both slots", () => {
    const plan = emptyPlan("URX44V");
    plan.connections.push({ from: "in.usbdaw_5_6:out", to: "ch_5_6:in", kind: "source" });
    const cmds = planToCommands(model, plan).filter((c) => c.name === "INPUT_SOURCE");
    expect(cmds.find((c) => c.y === 4)!.vdValue).toBe(548);
    expect(cmds.find((c) => c.y === 5)!.vdValue).toBe(549);
  });

  it("emits streaming source select as a tagged L/R port ref", () => {
    const plan = emptyPlan("URX44V");
    plan.connections.push({ from: "bus.mix1:out", to: "bus.stream:in", kind: "source" });
    const cmds = planToCommands(model, plan);
    const l = cmds.find((c) => c.name === "STREAM_SRC_L");
    const r = cmds.find((c) => c.name === "STREAM_SRC_R");
    expect(l!.vdValue).toBe((0x80000000 | 288) >>> 0);
    expect(l!.request.uri).toBe("/vd/parameters/705:0:0?operation=value");
    expect(r!.vdValue).toBe((0x80000000 | 289) >>> 0);
  });

  it("emits streaming source as the NONE sentinel when nothing feeds bus.stream", () => {
    const plan = emptyPlan("URX44V");
    const cmds = planToCommands(model, plan);
    // Absolute-state write: an unfed selector is cleared, not omitted.
    expect(cmds.find((c) => c.name === "STREAM_SRC_L")!.vdValue).toBe(0xffffffff);
    expect(cmds.find((c) => c.name === "STREAM_SRC_R")!.vdValue).toBe(0xffffffff);
  });

  it("emits USB output source as a raw port ref (bus or channel)", () => {
    const plan = emptyPlan("URX44V");
    plan.connections.push({ from: "bus.mix2:out", to: "out.usbmain_a:in", kind: "patch" });
    plan.connections.push({ from: "ch1:out", to: "out.usbmain_c:in", kind: "patch" });
    plan.connections.push({ from: "ch_5_6:out", to: "out.usbmain_b:in", kind: "patch" });
    plan.connections.push({ from: "bus.stream:out", to: "out.usbsub:in", kind: "patch" });
    const cmds = planToCommands(model, plan);
    expect(cmds.find((c) => c.name === "USB_OUT_SRC_A")!.vdValue).toBe(290);
    expect(cmds.find((c) => c.name === "USB_OUT_SRC_A")!.request.uri).toBe(
      "/vd/parameters/732:0:0?operation=value",
    );
    expect(cmds.find((c) => c.name === "USB_OUT_SRC_C")!.vdValue).toBe(0);
    expect(cmds.find((c) => c.name === "USB_OUT_SRC_B")!.vdValue).toBe(4);
    expect(cmds.find((c) => c.name === "USB_OUT_SRC_SUB")!.vdValue).toBe(258);
  });

  it("maps a higher stereo channel source to its input slot, not its node index", () => {
    const plan = emptyPlan("URX44V");
    plan.connections.push({ from: "ch_9_10:out", to: "out.usbmain_a:in", kind: "patch" });
    const cmds = planToCommands(model, plan);
    // CH9/10 = input slots 8/9; the source uses slot 8 (node index would be 6).
    expect(cmds.find((c) => c.name === "USB_OUT_SRC_A")!.vdValue).toBe(8);
  });

  it("emits monitor source select as an L/R bus port at the monitor's y", () => {
    const plan = emptyPlan("URX44V");
    plan.connections.push({ from: "bus.mix2:out", to: "bus.mon1:in", kind: "source" });
    const cmds = planToCommands(model, plan).filter((c) => c.name.startsWith("MONITOR_SRC"));
    expect(cmds.find((c) => c.name === "MONITOR_SRC_L" && c.y === 0)!.vdValue).toBe(290);
    expect(cmds.find((c) => c.name === "MONITOR_SRC_R" && c.y === 0)!.vdValue).toBe(291);
  });

  it("emits analog output patch (MAIN/LINE) as an L/R bus port", () => {
    const plan = emptyPlan("URX44V");
    plan.connections.push({ from: "bus.stream:out", to: "out.main:in", kind: "patch" });
    plan.connections.push({ from: "bus.mon2:out", to: "out.line:in", kind: "patch" });
    const cmds = planToCommands(model, plan);
    expect(cmds.find((c) => c.name === "OUT_PATCH_MAIN" && c.y === 0)!.vdValue).toBe(258);
    expect(cmds.find((c) => c.name === "OUT_PATCH_MAIN" && c.y === 1)!.vdValue).toBe(259);
    // Monitor 2 = bus port 338/339.
    expect(cmds.find((c) => c.name === "OUT_PATCH_LINE" && c.y === 0)!.vdValue).toBe(338);
    expect(cmds.find((c) => c.name === "OUT_PATCH_LINE" && c.y === 1)!.vdValue).toBe(339);
  });

  it("emits ducker key source from the key wire (channel slot or bus port)", () => {
    const plan = emptyPlan("URX44V");
    plan.connections.push({ from: "ch4:out", to: "out.ducker1:in", kind: "key" });
    plan.connections.push({ from: "bus.stereo:out", to: "out.ducker2:in", kind: "key" });
    const cmds = planToCommands(model, plan).filter((c) => c.name === "DUCKER_SRC");
    // Ducker 1 hangs under CH5/6 (stereo idx 0); CH4 = input slot 3.
    expect(cmds.find((c) => c.y === 0)!.vdValue).toBe(3);
    // Ducker 2 under CH7/8 (idx 1); STEREO = bus port 256.
    expect(cmds.find((c) => c.y === 1)!.vdValue).toBe(256);
  });
});

// pushDynCommands clamps each value to its DynField plan-domain min/max before
// encoding, since the shared encoders only enforce the broker's raw int/scale
// bounds (e.g. ratio up to 655:1) not the per-field UI limits (ratio 1..20). A
// plan that holds an out-of-range value (loaded from an older file, or hand-edited
// JSON) must not push a broker value outside the field's range.
describe("pushDynCommands clamping", () => {
  const model = getModel("URX44V");
  const vOf = (cmds: ReturnType<typeof planToCommands>, name: string) =>
    cmds.find((c) => c.name === name && c.y === 0)!.vdValue;

  it("clamps GATE detail below min and above max to the field bounds", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    // GATE_THRESHOLD range -72..0 dB; GATE_ATTACK 0.092..80 ms.
    plan.nodeParams.ch1 = { gate: { threshold: -200, attack: 500 } };
    const cmds = planToCommands(model, plan);
    expect(vOf(cmds, "GATE_THRESHOLD")).toBe(-72 * 100); // clamped to -72 dB
    expect(vOf(cmds, "GATE_ATTACK")).toBe(80 * 1000); // clamped to 80 ms (µs)
  });

  it("clamps COMP ratio and threshold to the field bounds", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    // COMP_RATIO range 1..20; COMP_THRESHOLD range -54..0 dB.
    plan.nodeParams.ch1 = { comp: { ratio: 0.1, threshold: 50 } };
    const cmds = planToCommands(model, plan);
    expect(vOf(cmds, "COMP_RATIO")).toBe(1 * 100); // clamped up to 1.0:1
    expect(vOf(cmds, "COMP_THRESHOLD")).toBe(0); // clamped down to 0 dB
  });

  it("clamps DUCKER detail to the field bounds", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    // DUCKER_THRESHOLD range -60..0 dB; DUCKER_DECAY range 1.3..5000 ms.
    plan.nodeParams["out.ducker1"] = { ducker: { threshold: -120, decay: 99999 } };
    const cmds = planToCommands(model, plan);
    expect(vOf(cmds, "DUCKER_THRESHOLD")).toBe(-60 * 100); // clamped to -60 dB
    expect(vOf(cmds, "DUCKER_DECAY")).toBe(5000 * 10); // clamped to 5000 ms (×10)
  });

  it("leaves in-range values untouched", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams.ch1 = { gate: { threshold: -40 }, comp: { ratio: 4 } };
    const cmds = planToCommands(model, plan);
    expect(vOf(cmds, "GATE_THRESHOLD")).toBe(-4000); // -40 dB, not clamped
    expect(vOf(cmds, "COMP_RATIO")).toBe(400); // 4:1, not clamped
  });
});

describe("CH SETTING color", () => {
  const model = getModel("URX44V");

  it("round-trips palette hex ↔ index", () => {
    COLOR_PALETTE.forEach((c, i) => {
      expect(hexToColorIndex(c.hex)).toBe(i);
      expect(colorIndexToHex(i)).toBe(c.hex);
    });
    expect(colorIndexToHex(COLOR_OFF_INDEX)).toBeNull(); // Off → no cap
    expect(hexToColorIndex("#123456")).toBeNull(); // outside the palette
  });

  it("emits the palette index for an input channel at its input slot (param 20)", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeColors.ch1 = COLOR_PALETTE[1].hex; // Orange = index 1
    const cmds = planToCommands(model, plan).filter((c) => c.name === "CH_COLOR");
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ paramId: 20, y: 0, vdValue: 1 });
  });

  it("writes a stereo channel's color to the stereo-index param (208), not the input slot", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeColors.ch_5_6 = COLOR_PALETTE[2].hex; // Yellow = index 2
    const cmds = planToCommands(model, plan).filter((c) => c.name === "STEREO_CH_COLOR");
    expect(cmds).toEqual([expect.objectContaining({ paramId: 208, y: 0, vdValue: 2 })]);
    // The mono-channel color param (20) is not used for a stereo channel.
    expect(planToCommands(model, plan).some((c) => c.name === "CH_COLOR")).toBe(false);
  });

  it("emits MIX color on both L/R instances (586) and STEREO on a single slot (496)", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeColors["bus.mix1"] = COLOR_PALETTE[4].hex; // Cyan = 4
    plan.nodeColors["bus.stereo"] = COLOR_PALETTE[6].hex; // Red = 6
    const cmds = planToCommands(model, plan);
    const mix = cmds.filter((c) => c.name === "MIX_COLOR");
    expect(mix.map((c) => c.y)).toEqual([0, 1]);
    expect(mix.every((c) => c.paramId === 586 && c.vdValue === 4)).toBe(true);
    const stereo = cmds.filter((c) => c.name === "STEREO_COLOR");
    expect(stereo).toHaveLength(1);
    expect(stereo[0]).toMatchObject({ paramId: 496, y: 0, vdValue: 6 });
  });

  it("emits FX color on a single slot (335) and STREAMING on its L/R pair (704)", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeColors["bus.fx1"] = COLOR_PALETTE[2].hex; // Yellow = 2
    plan.nodeColors["bus.fx2"] = COLOR_PALETTE[3].hex; // Purple = 3
    plan.nodeColors["bus.stream"] = COLOR_PALETTE[1].hex; // Orange = 1
    const cmds = planToCommands(model, plan);
    const fx = cmds.filter((c) => c.name === "FX_COLOR");
    expect(fx).toEqual([
      expect.objectContaining({ paramId: 335, y: 0, vdValue: 2 }),
      expect.objectContaining({ paramId: 335, y: 1, vdValue: 3 }),
    ]);
    const stream = cmds.filter((c) => c.name === "STREAM_COLOR");
    expect(stream.map((c) => c.y)).toEqual([0, 1]);
    expect(stream.every((c) => c.paramId === 704 && c.vdValue === 1)).toBe(true);
  });

  it("skips uncolored nodes and non-palette hex (never guesses a write)", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeColors.ch2 = "#abcdef"; // not a palette entry
    const cmds = planToCommands(model, plan).filter((c) => c.name === "CH_COLOR");
    expect(cmds).toHaveLength(0); // ch2 skipped (non-palette), ch1 uncolored
  });
});

describe("CH SETTING name", () => {
  const model = getModel("URX44V");

  it("maps each node kind to its name param + instances (color param − 2)", () => {
    expect(nameControl(model, "ch1")).toEqual({ param: 18, instances: [0] });
    // Stereo channels use the stereo-index param (206), not the input slot (18).
    expect(nameControl(model, "ch_5_6")).toEqual({ param: 206, instances: [0] });
    expect(nameControl(model, "ch_7_8")).toEqual({ param: 206, instances: [1] });
    expect(nameControl(model, "bus.mix1")).toEqual({ param: 584, instances: [0, 1] });
    expect(nameControl(model, "bus.mix2")).toEqual({ param: 584, instances: [2, 3] });
    expect(nameControl(model, "bus.stereo")).toEqual({ param: 494, instances: [0] });
    expect(nameControl(model, "bus.fx1")).toEqual({ param: 333, instances: [0] });
    expect(nameControl(model, "bus.fx2")).toEqual({ param: 333, instances: [1] });
    expect(nameControl(model, "bus.stream")).toEqual({ param: 702, instances: [0, 1] });
    // Monitor / OSC have no device name.
    expect(nameControl(model, "bus.mon1")).toBeNull();
    expect(nameControl(model, "bus.osc")).toBeNull();
  });

  it("emits a name write per linked instance, only for named nodes", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeNames.ch1 = "Vox";
    plan.nodeNames["bus.stream"] = "Live";
    const writes = planToNameWrites(model, plan);
    expect(writes).toEqual([
      { param: 18, y: 0, value: "Vox" },
      { param: 702, y: 0, value: "Live" },
      { param: 702, y: 1, value: "Live" },
    ]);
  });

  it("does not write names for unnamed or non-nameable nodes", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeNames["bus.osc"] = "Tone"; // not nameable on the device
    expect(planToNameWrites(model, plan)).toEqual([]);
  });
});
