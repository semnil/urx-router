import { describe, expect, it } from "vitest";
import { getModel, MODEL_IDS } from "../../models";
import { defaultPlan } from "../../models/initial-state";
import type { ModelId } from "../../models/types";
import { emptyPlan, ensureFixedConnections } from "../plan";
import type { Plan } from "../plan";
import { COLOR_OFF_INDEX, COLOR_PALETTE, EQ_TYPE_PASS, PARAMS, colorIndexToHex, hexToColorIndex } from "./params";
import type { ParamSpec } from "./params";
import {
  addrKey,
  cmdAddr,
  collisionKey,
  collisionOwners,
  formatAddrKey,
  insertFxControl,
  nameControl,
  planToCommands,
  planToCommandsUncollapsed,
  planToNameWrites,
} from "./translate";
import type { VdCommand } from "./translate";
import { GATE_RANGE_OFF_DB, VD_LEVEL_OFF } from "./vd";

// The broker REST uri a command addresses ("/vd/parameters/{id}:{x}:{y}?operation=value").
// The transport addresses hardware by paramId/x/y, so the uri is derived here for
// the address assertions rather than carried on every VdCommand.
const uri = (c: VdCommand): string => `/vd/parameters/${c.paramId}:${c.x}:${c.y}?operation=value`;

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
    expect(uri(fader!)).toBe("/vd/parameters/139:0:0?operation=value");
    expect(pan!.vdValue).toBe(63);
    expect(uri(pan!)).toBe("/vd/parameters/141:0:0?operation=value");
  });

  it("emits a STEREO-assign ON per channel + FX, defaulting ON, independent of CH_ON", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    const cmds = planToCommands(model, plan);
    // 8 channels (4 mono + 4 stereo) + 2 FX returns, all default ON (1).
    const assign = cmds.filter((c) => c.name === "STEREO_ASSIGN_ON");
    expect(assign).toHaveLength(10);
    expect(assign.every((c) => c.vdValue === 1)).toBe(true);
    // Mono CH1 = 142, stereo CH5/6 = 269, FX1 = 340 — distinct from CH_ON (140).
    expect(assign.some((c) => uri(c) === "/vd/parameters/142:0:0?operation=value")).toBe(true);
    expect(assign.some((c) => uri(c) === "/vd/parameters/269:0:0?operation=value")).toBe(true);
    expect(assign.some((c) => uri(c) === "/vd/parameters/340:0:0?operation=value")).toBe(true);
  });

  it("STEREO-assign ON follows the main-path connection's on, not the channel master", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    // Turn the → STEREO send off but leave the channel master (CH_ON) on.
    plan.connections.find((c) => c.from === "ch1:out" && c.to === "bus.stereo:in")!.params = { on: false };
    plan.nodeParams.ch1 = { on: true };
    const cmds = planToCommands(model, plan);
    expect(cmds.find((c) => c.name === "STEREO_ASSIGN_ON" && c.paramId === 142)!.vdValue).toBe(0);
    expect(cmds.find((c) => c.name === "CH_ON" && c.y === 0)!.vdValue).toBe(1);
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
    expect(uri(on!)).toBe("/vd/parameters/140:0:0?operation=value");
    expect(hpf!.vdValue).toBe(1);
    expect(uri(hpf!)).toBe("/vd/parameters/25:0:0?operation=value");
    expect(gain!.vdValue).toBe(-800);
    expect(uri(gain!)).toBe("/vd/parameters/1:0:0?operation=value");
  });

  it("maps stereo D.Gain to its dedicated param on both L/R instances", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams.ch_5_6 = { gain: -24 };
    const cmds = planToCommands(model, plan).filter((c) => c.paramId === 9);
    // CH5/6 D.Gain = param 9, written to y0 and y1 (linked), -24 dB = -2400.
    expect(cmds.map((c) => uri(c))).toEqual([
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
    expect(uri(fader!)).toBe("/vd/parameters/266:0:0?operation=value");
    expect(fader!.vdValue).toBe(-600);
    expect(uri(pan!)).toBe("/vd/parameters/268:0:0?operation=value");
    expect(uri(on!)).toBe("/vd/parameters/267:0:0?operation=value");
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
    expect(uri(freq!)).toBe("/vd/parameters/26:0:0?operation=value");
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
    expect(uri(phantom!)).toBe("/vd/parameters/0:0:0?operation=value");
    expect(uri(phase!)).toBe("/vd/parameters/24:0:0?operation=value");
    expect(uri(clip!)).toBe("/vd/parameters/5:0:0?operation=value");
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
    expect(uri(l!)).toBe("/vd/parameters/211:0:0?operation=value");
    expect(r!.vdValue).toBe(0);
    expect(uri(r!)).toBe("/vd/parameters/212:0:0?operation=value");
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
    expect(uri(cmds[0])).toBe("/vd/parameters/135:0:0?operation=value");
  });

  it("emits output insert FX on STEREO (single) and MIX (L/R-linked)", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams["bus.stereo"] = { insertFx: 1793 }; // Compander-H
    plan.nodeParams["bus.mix1"] = { insertFx: 1792 }; // M.B.Comp
    const cmds = planToCommands(model, plan).filter((c) => c.name === "INSERT_FX");
    const stereo = cmds.filter((c) => c.paramId === 578);
    const mix = cmds.filter((c) => c.paramId === 671);
    // STEREO = 578 single; MIX1 = 671 at y0 and y1 (linked).
    expect(stereo.map((c) => uri(c))).toEqual(["/vd/parameters/578:0:0?operation=value"]);
    expect(stereo[0].vdValue).toBe(1793);
    expect(mix.map((c) => uri(c))).toEqual([
      "/vd/parameters/671:0:0?operation=value",
      "/vd/parameters/671:0:1?operation=value",
    ]);
    expect(mix.every((c) => c.vdValue === 1792)).toBe(true);
  });

  it("uses the adopted URX22 INS FX selector/ON instances", () => {
    const u22 = getModel("URX22");
    expect(insertFxControl(u22, "ch1")).toMatchObject({ param: 135, onParam: 134, isOutput: false, instances: [0] });
    expect(insertFxControl(u22, "ch2")).toMatchObject({ param: 135, onParam: 134, isOutput: false, instances: [1] });
    expect(insertFxControl(u22, "bus.stereo")).toMatchObject({
      param: 578,
      onParam: 577,
      isOutput: true,
      instances: [0],
    });
    expect(insertFxControl(u22, "bus.mix1")).toMatchObject({
      param: 671,
      onParam: 670,
      isOutput: true,
      instances: [0, 1],
    });
    expect(insertFxControl(u22, "bus.mix2")).toMatchObject({
      param: 671,
      onParam: 670,
      isOutput: true,
      instances: [2, 3],
    });
    expect(insertFxControl(u22, "ch_3_4")).toBeNull();
  });

  // A URX22 plan carrying both shapes the emit loop can take: an input channel on a
  // single instance, and an output bus whose linked legs share one engine. One `it` per
  // claim — vitest stops at the first failure, so a bundled case leaves the second
  // claim unmeasured on the commit it is supposed to be a net for.
  const u22InsertFxPlan = (): ReturnType<typeof emptyPlan> => {
    const u22 = getModel("URX22");
    const plan = emptyPlan("URX22");
    ensureFixedConnections(u22, plan);
    plan.nodeParams.ch2 = { insertFx: 512, insertFxParams: { "18": 37 }, insertFxOn: false };
    plan.nodeParams["bus.mix2"] = { insertFx: 1792, insertFxParams: { "9": 99 }, insertFxOn: false };
    return plan;
  };

  it("emits a URX22 input selector, then its engine slots, then the bypass intent", () => {
    const cmds = planToCommands(getModel("URX22"), u22InsertFxPlan());
    const selector = cmds.findIndex((c) => c.name === "INSERT_FX" && c.paramId === 135 && c.y === 1);
    const slot = cmds.findIndex((c) => c.paramId === 701 && c.y === 18);
    const on = cmds.findIndex((c) => c.paramId === 134 && c.y === 1);
    expect([cmds[selector].vdValue, cmds[slot].vdValue, cmds[on].vdValue]).toEqual([512, 37, 0]);
    expect(selector).toBeLessThan(slot);
    expect(slot).toBeLessThan(on);
    // Nothing else insert-FX lands inside the run, so hoisting the bypass into a second
    // pass over the nodes fails here rather than satisfying the two comparisons above.
    const between = cmds.slice(selector + 1, on).filter((c) => c.name.startsWith("INSERT_FX"));
    expect(between.length).toBeGreaterThan(0);
    expect(between.every((c) => c.name === "INSERT_FX_EFFECT" && c.paramId === 701)).toBe(true);
  });

  it("emits both URX22 output legs' selectors, then the shared engine slot, then both bypass intents", () => {
    const cmds = planToCommands(getModel("URX22"), u22InsertFxPlan());
    const selectors = cmds.filter((c) => c.name === "INSERT_FX" && c.paramId === 671);
    const slot = cmds.findIndex((c) => c.paramId === 693 && c.y === 9);
    const ons = cmds.filter((c) => c.paramId === 670);
    expect(selectors.map((c) => [c.y, c.vdValue])).toEqual([
      [2, 1792],
      [3, 1792],
    ]);
    expect(cmds[slot].vdValue).toBe(99);
    expect(ons.map((c) => [c.y, c.vdValue])).toEqual([
      [2, 0],
      [3, 0],
    ]);
    // Max and min, so a leg that did not move is a failure rather than an average.
    expect(Math.max(...selectors.map((c) => cmds.indexOf(c)))).toBeLessThan(slot);
    expect(slot).toBeLessThan(Math.min(...ons.map((c) => cmds.indexOf(c))));
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
    expect(uri(cmds[0])).toBe("/vd/parameters/21:0:0?operation=value");
  });

  it("emits channel-strip section ON, swapping COMP/EQ bank by type", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    // CH1 COMP->EQ: standard bank (GATE 28, COMP 34, EQ 44, all 1 = on).
    plan.nodeParams.ch1 = { gateOn: true, compOn: true, eqOn: false };
    // CH2 SSMCS: morphing bank (GATE 28, COMP 94, EQ 106, inverted: 0 = on).
    plan.nodeParams.ch2 = { compEqType: 1, compOn: true, eqOn: true };
    const cmds = planToCommands(model, plan);
    const at = (name: string, y: number) => cmds.find((c) => c.name === name && c.y === y);
    // CH1 (y0): GATE on = 1, COMP on = 1, EQ off = 0 (off is the on-complement).
    expect(at("GATE_ON", 0)!.vdValue).toBe(1);
    expect(at("COMP_ON", 0)!.vdValue).toBe(1);
    expect(uri(at("EQ_ON", 0)!)).toBe("/vd/parameters/44:0:0?operation=value");
    expect(at("EQ_ON", 0)!.vdValue).toBe(0);
    // CH2 (y1) SSMCS: COMP/EQ use the inverted 94/106 bank, on = 0.
    expect(uri(at("SSMCS_COMP_ON", 1)!)).toBe("/vd/parameters/94:0:1?operation=value");
    expect(at("SSMCS_COMP_ON", 1)!.vdValue).toBe(0);
    expect(uri(at("SSMCS_EQ_ON", 1)!)).toBe("/vd/parameters/106:0:1?operation=value");
    expect(at("SSMCS_EQ_ON", 1)!.vdValue).toBe(0);
  });

  it("emits only EQ (no COMP/GATE) on a stereo channel, param 213", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams.ch_5_6 = { eqOn: false, compOn: true, gateOn: true };
    const cmds = planToCommands(model, plan);
    const eq = cmds.filter((c) => c.name === "STEREO_CH_EQ_ON");
    // Stereo EQ = 213 at stereo index 0, normal polarity: off = 0.
    expect(eq.map((c) => uri(c))).toEqual(["/vd/parameters/213:0:0?operation=value"]);
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
    expect(uri(cmds[0])).toBe("/vd/parameters/6:0:2?operation=value");
  });

  it("emits STEREO_MASTER_ON from the stereo bus node param", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams["bus.stereo"] = { on: false };
    const cmds = planToCommands(model, plan);
    const master = cmds.find((c) => c.name === "STEREO_MASTER_ON");
    expect(master!.vdValue).toBe(0);
    expect(uri(master!)).toBe("/vd/parameters/582:0:0?operation=value");
  });

  it("emits master balance for STEREO (583 single) and MIX (676 L/R-linked)", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams["bus.stereo"] = { pan: -20 };
    plan.nodeParams["bus.mix1"] = { pan: 30 };
    const cmds = planToCommands(model, plan);
    const st = cmds.find((c) => c.name === "STEREO_MASTER_BAL");
    expect(st!.vdValue).toBe(-20);
    expect(uri(st!)).toBe("/vd/parameters/583:0:0?operation=value");
    const mix = cmds.filter((c) => c.name === "OUT_MASTER_BAL");
    expect(mix.map((c) => `${uri(c)}=${c.vdValue}`)).toEqual([
      "/vd/parameters/676:0:0?operation=value=30",
      "/vd/parameters/676:0:1?operation=value=30",
    ]);
  });

  it("emits the MIX → STEREO TO ST switch at the MIX L instance", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    const c1 = plan.connections.find((c) => c.from === "bus.mix1:out" && c.to === "bus.stereo:in")!;
    c1.params = { on: true };
    const c2 = plan.connections.find((c) => c.from === "bus.mix2:out" && c.to === "bus.stereo:in")!;
    c2.params = { on: false };
    const cmds = planToCommands(model, plan).filter((c) => c.name === "TO_ST");
    expect(cmds.map((c) => `${uri(c)}=${c.vdValue}`)).toEqual([
      "/vd/parameters/677:0:0?operation=value=1",
      "/vd/parameters/677:0:2?operation=value=0",
    ]);
  });

  it("emits Pan Link at the MIX L instance", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams["bus.mix1"] = { panLink: true };
    plan.nodeParams["bus.mix2"] = { panLink: false };
    const cmds = planToCommands(model, plan).filter((c) => c.name === "PAN_LINK");
    expect(cmds.map((c) => `${uri(c)}=${c.vdValue}`)).toEqual([
      "/vd/parameters/589:0:0?operation=value=1",
      "/vd/parameters/589:0:2?operation=value=0",
    ]);
  });

  it("emits Signal Type to both channels of a pair and PAN/BAL to the primary", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams["ch1"] = { stereoLink: true, panBal: 1 };
    const sig = planToCommands(model, plan).filter((c) => c.name === "SIGNAL_TYPE");
    expect(sig.map((c) => uri(c))).toEqual([
      "/vd/parameters/23:0:0?operation=value",
      "/vd/parameters/23:0:1?operation=value",
    ]);
    const pb = planToCommands(model, plan).filter((c) => c.name === "PAN_BAL");
    expect(pb).toHaveLength(1);
    expect(uri(pb[0])).toBe("/vd/parameters/891:0:0?operation=value");
    expect(pb[0].vdValue).toBe(1);
  });

  it("emits Signal Type / PAN-BAL before every pan the switch slams", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams["ch1"] = { stereoLink: true, panBal: 0 };
    const cmds = planToCommands(model, plan);
    const indices = (names: string[]): number[] => cmds.flatMap((c, i) => (names.includes(c.name) ? [i] : []));
    const selectors = indices(["SIGNAL_TYPE", "PAN_BAL"]);
    const pans = indices(["CH_PAN", "SEND_PAN"]);
    expect(selectors.length).toBeGreaterThan(0);
    expect(pans.length).toBeGreaterThan(0);
    // Switching either selector makes the device slam the pair's CH_PAN and every
    // send pan, so a pan sent ahead of the selector is discarded rather than misread.
    expect(Math.max(...selectors)).toBeLessThan(Math.min(...pans));
  });

  it("emits SSMCS Sweet Spot Data as a 4-digit string write", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams["ch1"] = { compEqType: 1, ssmcs: { sweetSpotData: 2 } };
    const writes = planToNameWrites(model, plan).filter((w) => w.param === 91);
    // It carries its catalog name and owner node, which a node's own name does not: that is
    // what lets the live flush see it is a sideEffect head and which node to read back.
    expect(writes).toEqual([{ param: 91, y: 0, value: "0002", name: "SWEET_SPOT_DATA", node: "ch1" }]);
    const named = { ...plan, nodeNames: { ...plan.nodeNames, ch1: "KICK" } };
    const chName = planToNameWrites(model, named).find((w) => w.value === "KICK");
    expect(chName).toBeDefined();
    expect(chName?.name).toBeUndefined();
    expect(chName?.node).toBeUndefined();
    // COMP->EQ mode (not SSMCS) emits no preset write.
    plan.nodeParams["ch1"] = { compEqType: 0, ssmcs: { sweetSpotData: 2 } };
    expect(planToNameWrites(model, plan).filter((w) => w.param === 91)).toEqual([]);
  });

  it("emits a mono CH → MIX send on both L/R instances with tap", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    // CH → MIX is a fixed (always-wired) send; set its params on the seeded wire.
    const conn = plan.connections.find((c) => c.from === "ch1:out" && c.to === "bus.mix1:in")!;
    conn.params = { level: 5, pan: 100, tap: "pre" };
    const cmds = planToCommands(model, plan);
    // The send param ids are shared across channels (y selects ch1 = y0), so scope
    // to y0 to isolate ch1 from the other channels' also-seeded MIX1 sends.
    const lvl = cmds.filter((c) => c.name === "SEND_LEVEL" && c.y === 0 && [146, 152].includes(c.paramId));
    // MIX1 mono = base 146: level at 146 and 152 (L/R), both 5 dB = 500.
    expect(lvl.map((c) => uri(c))).toEqual([
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
    expect(uri(tap!)).toBe("/vd/parameters/151:0:0?operation=value");
  });

  it("emits a stereo CH → MIX send from the 273-based block", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    const conn = plan.connections.find((c) => c.from === "ch_5_6:out" && c.to === "bus.mix2:in")!;
    conn.params = { level: 0 };
    // Scope to ch_5_6 (stereo index y0) to isolate it from the other stereo
    // channels' also-seeded MIX2 sends (param ids shared, y selects the channel).
    const cmds = planToCommands(model, plan).filter(
      (c) => c.name === "SEND_LEVEL" && c.y === 0 && [285, 291].includes(c.paramId),
    );
    // Stereo MIX2 = base 273 + 12 = 285: level at 285 and 291, stereo index y0.
    expect(cmds.map((c) => uri(c))).toEqual([
      "/vd/parameters/285:0:0?operation=value",
      "/vd/parameters/291:0:0?operation=value",
    ]);
  });

  it("emits a CH → FX send as a single mono level/on, no pan, and no tap (read-only)", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    // CH → FX sends are fixed (always wired); set params on the seeded wires.
    const fx1 = plan.connections.find((c) => c.from === "ch1:out" && c.to === "bus.fx1:in")!;
    fx1.params = { level: 7.2, pan: 50, tap: "pre" };
    const fx2 = plan.connections.find((c) => c.from === "ch_5_6:out" && c.to === "bus.fx2:in")!;
    fx2.params = { level: 0 };
    const cmds = planToCommands(model, plan);
    // Mono FX1 block base 193: level 194, on 196 (single, no pan). Scope to ch1
    // (y0) — the param ids are shared across channels.
    const monoLvl = cmds.filter((c) => c.name === "SEND_LEVEL" && c.paramId === 194 && c.y === 0);
    expect(monoLvl).toHaveLength(1);
    expect(monoLvl[0].vdValue).toBe(720);
    expect(cmds.find((c) => c.name === "SEND_ON" && c.paramId === 196 && c.y === 0)!.vdValue).toBe(1);
    // CH → FX taps are read-only (broker max_value=0 rejects a PRE write), so even a
    // tap="pre" wire emits no SEND_TAP for the FX block (193/197/320/324).
    expect(cmds.some((c) => c.name === "SEND_TAP" && [193, 197, 320, 324].includes(c.paramId))).toBe(false);
    // Stereo FX2 = base 320+4 = 324: level 325 (ch_5_6 = stereo index y0).
    expect(cmds.some((c) => c.name === "SEND_LEVEL" && c.paramId === 325 && c.y === 0)).toBe(true);
    // FX sends carry no pan.
    expect(cmds.some((c) => c.name === "SEND_PAN" && [195, 197].includes(c.paramId))).toBe(false);
  });

  it("emits an FX channel → MIX send on both linked L/R slots with a single tap", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    // FX1 → MIX1 is a fixed (always-wired) send; set its params on the seeded wire.
    // L slot base 342 (tap 342 / level 343 / BAL 344 / on 345), R slot base 347.
    // The param ids are shared across FX channels (y selects FX1=0 / FX2=1), so
    // scope to y0 to isolate FX1 from the also-seeded FX2 → MIX1 send.
    const conn = plan.connections.find((c) => c.from === "bus.fx1:out" && c.to === "bus.mix1:in")!;
    conn.params = { level: -22.4, pan: -11, tap: "pre", on: true };
    const cmds = planToCommands(model, plan);
    const lvl = cmds.filter((c) => c.name === "SEND_LEVEL" && c.y === 0 && [343, 348].includes(c.paramId));
    expect(lvl).toHaveLength(2);
    expect(lvl.every((c) => c.vdValue === -2240)).toBe(true);
    const bal = cmds.filter((c) => c.name === "SEND_PAN" && c.y === 0 && [344, 349].includes(c.paramId));
    expect(bal).toHaveLength(2);
    expect(bal.every((c) => c.vdValue === -11)).toBe(true);
    expect(
      cmds.filter((c) => c.name === "SEND_ON" && c.y === 0 && [345, 350].includes(c.paramId) && c.vdValue === 1),
    ).toHaveLength(2);
    // Tap is written once on the L slot (342); the device links the R slot.
    const tap = cmds.filter((c) => c.name === "SEND_TAP" && c.y === 0 && [342, 347].includes(c.paramId));
    expect(tap).toHaveLength(1);
    expect(tap[0].paramId).toBe(342);
    expect(tap[0].vdValue).toBe(1);
  });

  it("emits SEND_ON = 0 for a fixed FX channel → MIX send turned off (params.on)", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    const conn = plan.connections.find((c) => c.from === "bus.fx1:out" && c.to === "bus.mix1:in")!;
    conn.params = { ...conn.params, on: false };
    const cmds = planToCommands(model, plan);
    // FX1 → MIX1 ON params 345 / 350 at y0 are off; the wire stays (fixed).
    const on = cmds.filter((c) => c.name === "SEND_ON" && c.y === 0 && [345, 350].includes(c.paramId));
    expect(on).toHaveLength(2);
    expect(on.every((c) => c.vdValue === 0)).toBe(true);
  });

  it("emits the FX channel → STEREO main path as FX_CHANNEL_FADER / BAL", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    // The fixed FX channel → STEREO send already exists; set its level / pan.
    const conn = plan.connections.find((c) => c.from === "bus.fx2:out" && c.to === "bus.stereo:in")!;
    conn.params = { level: -6, pan: 20 };
    const cmds = planToCommands(model, plan);
    // FX2 = y 1. Master fader 337, balance 339.
    expect(cmds.find((c) => c.name === "FX_CHANNEL_FADER" && c.paramId === 337 && c.y === 1)!.vdValue).toBe(-600);
    expect(cmds.find((c) => c.name === "FX_CHANNEL_BAL" && c.paramId === 339 && c.y === 1)!.vdValue).toBe(20);
  });

  it("emits output EQ ON for STEREO (498, single) and MIX (591, L/R-linked)", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams["bus.stereo"] = { eqOn: false };
    plan.nodeParams["bus.mix1"] = { eqOn: false };
    const cmds = planToCommands(model, plan);
    const stereo = cmds.filter((c) => c.name === "STEREO_EQ_ON");
    const mix = cmds.filter((c) => c.name === "OUT_EQ_ON");
    expect(stereo.map((c) => uri(c))).toEqual(["/vd/parameters/498:0:0?operation=value"]);
    expect(stereo[0].vdValue).toBe(0);
    expect(mix.map((c) => uri(c))).toEqual([
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
    expect(uri(sType!)).toBe("/vd/parameters/504:0:0?operation=value");
    expect(sType!.vdValue).toBe(EQ_TYPE_PASS);
    expect(cmds.find((c) => c.paramId === 506)!.vdValue).toBe(2000); // 200 Hz × 10
    expect(cmds.find((c) => c.paramId === 507)!.vdValue).toBe(600); // +6 dB centi
    // A pass filter still writes freq/type; gain was set so it is emitted too.
    // MIX1 band3 (HIGH-MID) Q = param 596 + 10 + 2 = 608, both L/R instances.
    const mq = cmds.filter((c) => c.name === "EQ_BAND_Q" && c.paramId === 608);
    expect(mq.map((c) => uri(c))).toEqual([
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
    expect(uri(ch1!)).toBe("/vd/parameters/53:0:0?operation=value");
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
    expect(uri(eq!)).toBe("/vd/parameters/237:0:0?operation=value");
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
    expect(uri(cmds.find((c) => c.name === "EQ_ONE_KNOB_LEVEL")!)).toBe("/vd/parameters/48:0:0?operation=value");
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
    expect(uri(cmds.find((c) => c.name === "COMP_AUTO_MAKEUP")!)).toBe("/vd/parameters/41:0:0?operation=value");
    expect(cmds.find((c) => c.name === "COMP_AUTO_MAKEUP")!.vdValue).toBe(1);
    expect(cmds.find((c) => c.name === "COMP_ONE_KNOB")!.vdValue).toBe(1);
    // 1-knob level is a raw 0-100 value (param 43).
    const lvl = cmds.find((c) => c.name === "COMP_ONE_KNOB_LEVEL")!;
    expect(uri(lvl)).toBe("/vd/parameters/43:0:0?operation=value");
    expect(lvl.vdValue).toBe(50);
  });

  it("skips the COMP values the 1-knob drives while it is on", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    const comp = { threshold: -18, ratio: 3, gain: 6, knee: 1, attack: 20, release: 150, autoMakeup: false };
    plan.nodeParams.ch1 = { comp: { ...comp, oneKnob: true, oneKnobLevel: 50 } };
    const on = planToCommands(model, plan).filter((c) => c.node === "ch1");
    const has = (list: typeof on, name: string): boolean => list.some((c) => c.name === name);
    for (const name of ["COMP_THRESHOLD", "COMP_RATIO", "COMP_GAIN", "COMP_KNEE"]) expect(has(on, name)).toBe(false);
    // Only those four. The knob leaves attack, release and Auto Makeup where the operator
    // put them, so they stay authored — and the knob's own two params are the write.
    for (const name of ["COMP_ATTACK", "COMP_RELEASE", "COMP_AUTO_MAKEUP"]) expect(has(on, name)).toBe(true);
    expect(has(on, "COMP_ONE_KNOB")).toBe(true);
    expect(has(on, "COMP_ONE_KNOB_LEVEL")).toBe(true);

    // Off: the plan authors all four again.
    plan.nodeParams.ch1 = { comp: { ...comp, oneKnob: false, oneKnobLevel: 50 } };
    const off = planToCommands(model, plan).filter((c) => c.node === "ch1");
    for (const name of ["COMP_THRESHOLD", "COMP_RATIO", "COMP_GAIN", "COMP_KNEE"]) expect(has(off, name)).toBe(true);

    // The escape hatch reaches them while it is on, for a caller that wants every
    // address the unit holds rather than the ones the plan authors.
    plan.nodeParams.ch1 = { comp: { ...comp, oneKnob: true, oneKnobLevel: 50 } };
    const all = planToCommands(model, plan, "all", { includeDeviceDriven: true }).filter((c) => c.node === "ch1");
    for (const name of ["COMP_THRESHOLD", "COMP_RATIO", "COMP_GAIN", "COMP_KNEE"]) expect(has(all, name)).toBe(true);
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
        eq: {
          low: { on: true, freq: 32, gain: 180 },
          mid: { on: true, q: 12, freq: 72, gain: 243 },
          high: { on: true, freq: 112, gain: 180 },
        },
      },
    };
    const cmds = planToCommands(model, plan);
    const at = (name: string) => cmds.find((c) => c.name === name && c.y === 0);
    // Master ON (89), Comp Drive (95), Morphing (93), Out Gain (117) — raw, y0.
    expect(uri(at("SSMCS_ON")!)).toBe("/vd/parameters/89:0:0?operation=value");
    expect(at("SSMCS_COMP_DRIVE")!.vdValue).toBe(100);
    expect(uri(at("SSMCS_MORPHING")!)).toBe("/vd/parameters/93:0:0?operation=value");
    expect(at("SSMCS_OUT_GAIN")!.vdValue).toBe(180);
    // Comp detail raw, Mid Q (111), High freq (115).
    expect(at("SSMCS_COMP_RATIO")!.vdValue).toBe(60);
    expect(at("SSMCS_COMP_THRESHOLD")!.vdValue).toBe(100);
    expect(at("SSMCS_SC_FREQ")!.vdValue).toBe(30);
    expect(uri(at("SSMCS_EQ_MID_Q")!)).toBe("/vd/parameters/111:0:0?operation=value");
    expect(at("SSMCS_EQ_HIGH_FREQ")!.vdValue).toBe(112);
    // Low/High bands carry no Q.
    expect(cmds.some((c) => c.name === ("SSMCS_EQ_LOW_Q" as never))).toBe(false);
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
    expect(uri(d!)).toBe("/vd/parameters/258:0:0?operation=value");
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
    expect(uri(v("DUCKER_DECAY"))).toBe("/vd/parameters/263:0:0?operation=value");
  });

  it("emits the STEREO master fader on its single instance", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams["bus.stereo"] = { level: 2 };
    const cmds = planToCommands(model, plan);
    const fader = cmds.filter((c) => c.name === "STEREO_MASTER_FADER");
    expect(fader).toHaveLength(1);
    expect(fader[0].vdValue).toBe(200);
    expect(uri(fader[0])).toBe("/vd/parameters/581:0:0?operation=value");
  });

  it("emits the MIX output fader on both L/R instances", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams["bus.mix2"] = { level: 1.2 };
    const cmds = planToCommands(model, plan).filter((c) => c.name === "OUT_FADER");
    // MIX2 = param 674 at y2 and y3 (linked), 1.2 dB = 120.
    expect(cmds.map((c) => uri(c))).toEqual([
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
    expect(uri(m1!)).toBe("/vd/parameters/724:0:0?operation=value");
    expect(m2!.vdValue).toBe(0);
    expect(uri(m2!)).toBe("/vd/parameters/724:0:1?operation=value");
  });

  it("emits PHONES level per monitor (PHONES 1 ↔ mon1 = y0, PHONES 2 ↔ mon2 = y1)", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["bus.mon1"] = { phonesLevel: 10 };
    plan.nodeParams["bus.mon2"] = { phonesLevel: 0 };
    const cmds = planToCommands(model, plan);
    const p1 = cmds.find((c) => c.name === "PHONES_LEVEL" && c.y === 0);
    const p2 = cmds.find((c) => c.name === "PHONES_LEVEL" && c.y === 1);
    expect(p1!.vdValue).toBe(100); // 10.0 = raw 100
    expect(uri(p1!)).toBe("/vd/parameters/725:0:0?operation=value");
    expect(p2!.vdValue).toBe(0); // 0.0 = raw 0
    expect(uri(p2!)).toBe("/vd/parameters/725:0:1?operation=value");
  });

  it("emits monitor CUE-interrupt / MONO toggles per monitor", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["bus.mon1"] = { cueInterrupt: false, mono: true };
    const cmds = planToCommands(model, plan);
    const cue = cmds.find((c) => c.name === "MONITOR_CUE_INTERRUPT" && c.y === 0);
    const mono = cmds.find((c) => c.name === "MONITOR_MONO" && c.y === 0);
    expect(cue!.vdValue).toBe(0);
    expect(uri(cue!)).toBe("/vd/parameters/721:0:0?operation=value");
    expect(mono!.vdValue).toBe(1);
    expect(uri(mono!)).toBe("/vd/parameters/722:0:0?operation=value");
  });

  it("emits oscillator generator params from the bus.osc node", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["bus.osc"] = { osc: { on: true, level: -20, mode: 0, freq: 2000 } };
    const cmds = planToCommands(model, plan);
    expect(cmds.find((c) => c.name === "OSC_ON")!.vdValue).toBe(1);
    expect(cmds.find((c) => c.name === "OSC_LEVEL")!.vdValue).toBe(-2000);
    expect(cmds.find((c) => c.name === "OSC_FREQ")!.vdValue).toBe(20000);
    expect(uri(cmds.find((c) => c.name === "OSC_ON")!)).toBe("/vd/parameters/710:0:0?operation=value");
  });

  it("emits STREAMING DELAY params from the bus.stream node", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["bus.stream"] = { delay: { on: true, time: 100, frameRate: 7 } };
    const cmds = planToCommands(model, plan);
    expect(cmds.find((c) => c.name === "STREAM_DELAY_ON")!.vdValue).toBe(1);
    expect(cmds.find((c) => c.name === "STREAM_DELAY_TIME")!.vdValue).toBe(10000); // 100.00 ms = ms×100
    expect(cmds.find((c) => c.name === "STREAM_DELAY_FRAME_RATE")!.vdValue).toBe(7); // 120 fps index
    expect(uri(cmds.find((c) => c.name === "STREAM_DELAY_ON")!)).toBe("/vd/parameters/707:0:0?operation=value");
    expect(uri(cmds.find((c) => c.name === "STREAM_DELAY_TIME")!)).toBe("/vd/parameters/708:0:0?operation=value");
    expect(uri(cmds.find((c) => c.name === "STREAM_DELAY_FRAME_RATE")!)).toBe("/vd/parameters/830:0:0?operation=value");
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
    expect(uri(c1!)).toBe("/vd/parameters/22:0:0?operation=value");
    expect(c2!.vdValue).toBe(257);
  });

  it("emits a stereo channel's input source via 209/210 at the stereo index", () => {
    const plan = emptyPlan("URX44V");
    plan.connections.push({ from: "in.usbdaw_5_6:out", to: "ch_5_6:in", kind: "source" });
    const cmds = planToCommands(model, plan);
    // ch_5_6 is stereo index 0: L port -> 209:0:0, R port -> 210:0:0 (not param 22,
    // which the device only honors for the mono slots 0-3).
    const l = cmds.find((c) => c.name === "STEREO_INPUT_SOURCE_L");
    const r = cmds.find((c) => c.name === "STEREO_INPUT_SOURCE_R");
    expect(l!.vdValue).toBe(548);
    expect(uri(l!)).toBe("/vd/parameters/209:0:0?operation=value");
    expect(r!.vdValue).toBe(549);
    expect(uri(r!)).toBe("/vd/parameters/210:0:0?operation=value");
    // No param 22 write touches a stereo slot.
    expect(cmds.some((c) => c.name === "INPUT_SOURCE" && c.y >= 4)).toBe(false);
  });

  it("emits streaming source select as a tagged L/R port ref", () => {
    const plan = emptyPlan("URX44V");
    plan.connections.push({ from: "bus.mix1:out", to: "bus.stream:in", kind: "source" });
    const cmds = planToCommands(model, plan);
    const l = cmds.find((c) => c.name === "STREAM_SRC_L");
    const r = cmds.find((c) => c.name === "STREAM_SRC_R");
    expect(l!.vdValue).toBe((0x80000000 | 288) >>> 0);
    expect(uri(l!)).toBe("/vd/parameters/705:0:0?operation=value");
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
    // USB out is a stereo slot pair: L at y=0, R at y=1 (same param). Writing only
    // L leaves R on its stale source (a CONSOLE-observed regression: B=MIX1 emitted
    // L=MIX1 but R stayed on STEREO until the device panel rewrote both slots).
    const usbOut = (name: string) => [0, 1].map((y) => cmds.find((c) => c.name === name && c.y === y)!);
    expect(usbOut("USB_OUT_SRC_A").map((c) => c.vdValue)).toEqual([290, 291]);
    expect(usbOut("USB_OUT_SRC_A").map((c) => uri(c))).toEqual([
      "/vd/parameters/732:0:0?operation=value",
      "/vd/parameters/732:0:1?operation=value",
    ]);
    // CH1 is mono: both slots take its single input port.
    expect(usbOut("USB_OUT_SRC_C").map((c) => c.vdValue)).toEqual([0, 0]);
    // CH5/6 is stereo (input slots 4/5): L=4, R=5.
    expect(usbOut("USB_OUT_SRC_B").map((c) => c.vdValue)).toEqual([4, 5]);
    expect(usbOut("USB_OUT_SRC_SUB").map((c) => c.vdValue)).toEqual([258, 259]);
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

  it("emits GATE range -∞ as the off sentinel and finite values as centi-dB", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams.ch1 = { gate: { range: GATE_RANGE_OFF_DB } };
    expect(vOf(planToCommands(model, plan), "GATE_RANGE")).toBe(VD_LEVEL_OFF); // -∞
    plan.nodeParams.ch1 = { gate: { range: -72 } };
    expect(vOf(planToCommands(model, plan), "GATE_RANGE")).toBe(-7200); // deepest finite step
  });

  it("clamps DUCKER range down to the -70 dB floor", () => {
    const plan = emptyPlan("URX44V");
    ensureFixedConnections(model, plan);
    plan.nodeParams["out.ducker1"] = { ducker: { range: -120 } };
    const cmds = planToCommands(model, plan);
    expect(vOf(cmds, "DUCKER_RANGE")).toBe(-70 * 100); // clamped to -70 dB (no -∞)
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

// An insert effect's parameters live in ONE engine array per effect family,
// addressed engine:0:slot with no channel axis (insert-fx-effect.ts), so two nodes
// holding the same family emit the same addresses with their own values. The
// emitted set keeps the last (collapseSharedAddrs) and stamps the survivor with
// the owners it displaced.
describe("shared device addresses (last wins)", () => {
  const model = getModel("URX44V");
  const addr = (c: VdCommand): string => `${c.paramId}:${c.x}:${c.y}`;
  const dupes = (cmds: VdCommand[]): string[] => {
    const seen = new Set<string>();
    return cmds.map(addr).filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
  };
  // Compander slot 6 (Threshold): the one slot the input companders and the
  // output MBC both carry, so it is where three owners can meet on engine 693.
  // The slot is a parameter because 6 means different things per family: a compander's
  // Threshold, and the multi-band compressor's 1-Knob — which the emit path reads as "the
  // unit owns every value here" and then emits none of them, so an owner given one would
  // drop out of a collision it is supposed to be in.
  const withCompander =
    (nodeId: string, selector: number, raw: number, slot = 6) =>
    (plan: Plan) => {
      plan.nodeParams[nodeId] = {
        ...plan.nodeParams[nodeId],
        insertFx: selector,
        insertFxParams: { [String(slot)]: raw },
      };
    };
  const planWith = (id: ModelId, ...edits: Array<(plan: Plan) => void>): Plan => {
    const plan = defaultPlan(id);
    for (const edit of edits) edit(plan);
    return plan;
  };

  // Insert FX is the only family that shares an address today. The day a second one
  // does, it fails here rather than on a unit — asked of the UNCOLLAPSED list, because
  // the collapse makes the question trivially true of planToCommands' output whatever
  // the plan holds. A default plan is the right subject: a family that shares an address
  // does so at its factory values too, where the two owners AGREE and nothing is
  // stamped `shadowed`, so a value-based check would not see it.
  it("emits no repeated address for any model's default plan", () => {
    for (const id of ["URX22", "URX44", "URX44V"] as ModelId[]) {
      expect(dupes(planToCommandsUncollapsed(getModel(id), defaultPlan(id)))).toEqual([]);
    }
  });

  it("collapses two owners of one engine slot to the last command", () => {
    const cmds = planToCommands(
      model,
      planWith("URX44V", withCompander("ch1", 1793, -1000), withCompander("ch2", 1794, -1500)),
    );
    const engine = cmds.filter((c) => c.paramId === 689 && c.y === 6);
    expect(engine).toHaveLength(1);
    expect(engine[0].vdValue).toBe(-1500);
    expect(engine[0].node).toBe("ch2");
    expect(engine[0].shadowed).toEqual(["ch1"]);
  });

  // The survivor keeps its OWN index. Hoisted to the first occurrence's, it would
  // be written before ch2's selector, which repopulates the engine array with that
  // type's defaults — the device would end up holding neither owner's value.
  it("keeps the survivor after the later owner's selector", () => {
    const cmds = planToCommands(
      model,
      planWith("URX44V", withCompander("ch1", 1793, -1000), withCompander("ch2", 1794, -1500)),
    );
    const selector = cmds.findIndex((c) => c.name === "INSERT_FX" && c.paramId === 135 && c.y === 1);
    const survivor = cmds.findIndex((c) => c.paramId === 689 && c.y === 6);
    expect(selector).toBeGreaterThan(-1);
    expect(survivor).toBeGreaterThan(selector);
  });

  // The state every device readback produces: both owners hold the same slot
  // values, so the duplicates agree and the collapse discards nothing.
  it("reports nothing when the owners agree", () => {
    const cmds = planToCommands(
      model,
      planWith("URX44V", withCompander("ch1", 1793, -1000), withCompander("ch2", 1794, -1000)),
    );
    const engine = cmds.filter((c) => c.paramId === 689 && c.y === 6);
    expect(engine).toHaveLength(1);
    expect(engine[0].shadowed).toBeUndefined();
    expect(collisionOwners(cmds)).toEqual([]);
    expect(collisionKey(collisionOwners(cmds))).toBe("");
  });

  it("collapses three owners of the output engine to one command", () => {
    const cmds = planToCommands(
      model,
      planWith(
        "URX44V",
        // Slot 9 rather than 6, because 6 is the multi-band compressor's 1-Knob and the
        // writer reads that as the unit owning every value of the effect — an owner given
        // one emits nothing and drops out of the collision it is supposed to be in. Nine
        // is a value under all three: that one's LOW Threshold, and the companders'
        // Release, which is why the raws differ so widely.
        withCompander("bus.stereo", 1792, 100, 9),
        withCompander("bus.mix1", 1793, 1000, 9),
        withCompander("bus.mix2", 1794, 1500, 9),
      ),
    );
    const engine = cmds.filter((c) => c.paramId === 693 && c.y === 9);
    expect(engine).toHaveLength(1);
    expect(engine[0].node).toBe("bus.mix2");
    expect(engine[0].shadowed).toEqual(["bus.stereo", "bus.mix1"]);
    // The several slots one shared array carries read as ONE collision.
    expect(collisionOwners(cmds)).toEqual([{ kept: "bus.mix2", dropped: ["bus.stereo", "bus.mix1"] }]);
    expect(collisionKey(collisionOwners(cmds))).toBe("bus.mix2<bus.stereo+bus.mix1");
  });

  // The collapse runs before the scope filter. Collapsing after it would be the same
  // function only while no address carries two ParamNames: the filter is per name, so a
  // two-name address could drop the survivor and leave a scene-internal owner behind,
  // and the scene subset would stop being the full list filtered. The premise is the
  // load-bearing half and is asked of the UNCOLLAPSED list, where a second name on one
  // address still exists to be seen; the identity is pinned over a COLLIDING plan, which
  // scene-scope.test.ts's default-plan version cannot reach.
  it("leaves the scene subset a filter of the full list, over a colliding plan", () => {
    const plan = planWith("URX44V", withCompander("ch1", 1793, -1000), withCompander("ch2", 1794, -1500));
    const all = planToCommands(model, plan);
    const scene = planToCommands(model, plan, "scene");
    expect(scene).toEqual(all.filter((c) => (PARAMS[c.name] as ParamSpec).sceneExternal !== true));
    const names = new Map<string, string>();
    let compared = 0;
    for (const c of planToCommandsUncollapsed(model, plan)) {
      const prev = names.get(addr(c));
      if (prev !== undefined) compared++;
      expect(prev === undefined || prev === c.name).toBe(true);
      names.set(addr(c), c.name);
    }
    // The repeats this plan carries are what makes the loop above an assertion rather
    // than a walk over unique keys — the shape the vacuous first draft of it had.
    expect(compared).toBeGreaterThan(0);
  });
});

// The packed address key decides WHICH COMMANDS COLLAPSE, and live.ts keys its
// snapshot and follow index on the same packing. Two addresses that folded onto one
// key would drop a write in silence, so the bit layout's headroom is pinned here
// rather than trusted: the widths were chosen off these measured ranges.
describe("addrKey packing", () => {
  const triples = (): Array<[number, number, number]> => {
    const out: Array<[number, number, number]> = [];
    for (const id of MODEL_IDS) {
      for (const c of planToCommandsUncollapsed(getModel(id), defaultPlan(id))) out.push([c.paramId, c.x, c.y]);
    }
    return out;
  };

  it("keeps every emitted address, and the whole catalog, inside the layout", () => {
    const ids = Object.values(PARAMS).map((p) => (p as ParamSpec).id);
    // paramId occupies the bits above 2 * 10, leaving 11 of a non-negative int32.
    expect(Math.max(...ids)).toBeLessThan(1 << 11);
    for (const [paramId, x, y] of triples()) {
      expect(paramId).toBeLessThan(1 << 11);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1 << 10);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(1 << 10);
    }
  });

  it("is injective over every model's emitted addresses", () => {
    const byKey = new Map<number, string>();
    for (const [paramId, x, y] of triples()) {
      const triple = `${paramId}:${x}:${y}`;
      const prev = byKey.get(addrKey(paramId, x, y));
      expect(prev === undefined || prev === triple, `${prev} and ${triple} pack to one key`).toBe(true);
      byKey.set(addrKey(paramId, x, y), triple);
    }
    expect(byKey.size).toBeGreaterThan(0);
  });

  it("is injective at the corners of the layout, and stays a non-negative int32", () => {
    const edge = [0, 1, 17, 18, 1023];
    const seen = new Set<number>();
    for (const paramId of [0, 1, 891, 2047]) {
      for (const x of edge) {
        for (const y of edge) {
          const key = addrKey(paramId, x, y);
          expect(key).toBeGreaterThanOrEqual(0);
          expect(key).toBe(key | 0);
          expect(seen.has(key), `${paramId}:${x}:${y} collides`).toBe(false);
          seen.add(key);
          // The published form the trace probe and the race harness read.
          expect(formatAddrKey(key)).toBe(`${paramId}:${x}:${y}`);
        }
      }
    }
  });

  it("packs a command exactly as its own address does", () => {
    for (const id of MODEL_IDS) {
      for (const c of planToCommandsUncollapsed(getModel(id), defaultPlan(id))) {
        expect(cmdAddr(c)).toBe(addrKey(c.paramId, c.x, c.y));
      }
    }
  });
});

// A `sideEffect` param is by definition the head of a reset chain: writing it makes the
// device move parameters emitted after it. Emit order handles that for a full send;
// `group` is what carries it into a converge round, which re-sends only what differs
// (see client.ts roundCommands). Nothing derives the group from the flag, so this pins
// which heads carry one and — for the rest — why they do not, rather than leaving a new
// emitter to be forgotten until a device run turns up a residual.
describe("reset chains (sideEffect heads vs converge groups)", () => {
  // Measured on a URX44V: ON discards the type, a type write discards the level. Three
  // links, so one link per round exhausts sendConverging's 3-round budget.
  const GROUPED = new Set(["EQ_ONE_KNOB_ON", "EQ_ONE_KNOB_TYPE", "EQ_ONE_KNOB_LEVEL"]);
  // Two links each: the head plus what it repopulates, which one extra round settles.
  // A third link, or a shorter budget, would put them in the same failure as the EQ
  // 1-knob — that is what to check first if a converge leaves one of these behind.
  const UNGROUPED = new Set([
    "COMP_EQ_TYPE", // -> the channel-strip section toggles (bank swap)
    "INSERT_FX", // -> INSERT_FX_ON + the engine array it binds
    "OUTPUT_INSERT_FX_STEREO",
    "OUTPUT_INSERT_FX_MIX",
    "FX_EFFECT_TYPE", // -> the FX_EFFECT_PARAM array
    "SIGNAL_TYPE", // -> the SECONDARY channel's state, so a group cannot express it
    "PAN_BAL", // -> CH_PAN + every SEND_PAN; its order is pinned above
    // The COMP 1-knob, ungrouped for the same reason as the rest after all. Its chain LOOKS
    // like the EQ 1-knob's — writing 42 discards 43 (measured), the shape that earned the EQ
    // triple its group — but it is two links where the EQ's is three, and two is what one
    // extra round settles. Driven rather than reasoned: `client.test.ts` walks it from the
    // state that produces the longest path and it converges in round 2, with nothing further
    // discarded once the level lands (the values the level recomputes are not emitted at all
    // while the knob is on).
    "COMP_ONE_KNOB",
    "COMP_ONE_KNOB_LEVEL",
  ]);

  // ⚠️ This only sees what the DEFAULT plan emits. A sideEffect head that needs a
  // non-default plan to appear at all — SSMCS_MORPHING needs a channel switched to the
  // morphing strip — is invisible here and reaches no decision. Adding one means recording
  // it by hand, because nothing fails when you do not.
  it("accounts for every emitted sideEffect param", () => {
    const emitted = new Set<string>();
    for (const id of MODEL_IDS) {
      for (const c of planToCommandsUncollapsed(getModel(id), defaultPlan(id))) {
        if ((PARAMS[c.name] as ParamSpec).sideEffect) emitted.add(c.name);
      }
    }
    for (const name of emitted) {
      expect(GROUPED.has(name) || UNGROUPED.has(name), `${name} is a reset-chain head with no decision recorded`).toBe(
        true,
      );
    }
  });

  // The 1-knob triple sits at EQ-ON + 2 / 3 / 4, so an anchor and a y name one chain
  // instance across every EQ block (mono channel, stereo channel, output bus).
  const CHAIN_OFFSET: Record<string, number> = { EQ_ONE_KNOB_ON: 2, EQ_ONE_KNOB_TYPE: 3, EQ_ONE_KNOB_LEVEL: 4 };

  it("gives one group to each chain instance of two or more, and to nothing else", () => {
    for (const id of MODEL_IDS) {
      const chains = new Map<string, VdCommand[]>();
      for (const c of planToCommands(getModel(id), defaultPlan(id))) {
        const offset = CHAIN_OFFSET[c.name];
        if (offset === undefined) {
          expect(c.group, `${c.name} carries a group but is not a known chain member`).toBeUndefined();
          continue;
        }
        const key = `${c.paramId - offset}:${c.y}`;
        chains.set(key, [...(chains.get(key) ?? []), c]);
      }
      expect(chains.size).toBeGreaterThan(0);
      for (const [key, members] of chains) {
        // A chain of one cannot be broken by a partial re-send, so it is never tagged.
        if (members.length < 2) expect(members[0].group, `${key} is a chain of one`).toBeUndefined();
        else
          expect(new Set(members.map((m) => m.group)), `${key} is not one group`).toEqual(new Set([members[0].group]));
        if (members.length > 1) expect(members[0].group, `${key} carries no group`).toBeDefined();
      }
    }
  });
});
