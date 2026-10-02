// Robustness audit pins for the value paths that reach a device write outside
// vd.ts's numeric encoders. Those encoders (level / pan / gain / EQ / dynamics …)
// all run through clamp(), which is both a range firewall and a NaN trap (see
// vd.audit.test.ts). encodeValue("raw" / "enum") is a pure passthrough, so the FX-
// channel and Insert-FX paths carry their own firewall at the emit site instead,
// bounding each raw to the calibrated catalog range and coercing off-menu
// selectors. These tests pin that firewall (the audit that found it originally
// pinned the UNBOUNDED behavior; the pins were rewritten with the fix) so removing
// it — or letting a new raw path skip it — is caught.
//
//   - tagPortRef still collides with the "nothing selected" sentinel at one port
//     id. AUDIT: unreachable with real port ids (all small), pinned as a KNOWN GAP.

import { describe, expect, it } from "vitest";
import { getModel } from "../../models";
import { emptyPlan } from "../plan";
import { planToCommands } from "./translate";
import { ENGINE_COMPANDER_INPUT } from "./insert-fx-effect";
import { FX_EFFECT_ARRAY_PARAM, FX_EFFECT_TYPE_DEFAULT, FX_EFFECT_TYPE_PARAM } from "./fx-effect";
import {
  BUS_TYPE_VARI,
  DELAY_FRAME_RATE_DEFAULT,
  INSERT_FX_NONE,
  REC_POINT_DEFAULT,
  REC_POINT_PRE_COMP,
  denormalizeInsertFx,
} from "./params";
import { PORT_REF_NONE, SSMCS_MORPHING_MAX, tagPortRef, vdToPortRef } from "./vd";

const model = getModel("URX44V");

describe("FX / Insert-FX raw emit path is bounded to the calibrated catalog range", () => {
  it("clamps an over-range Insert-FX engine slot (COMPANDER slot 6 is -5400..0)", () => {
    // COMPANDER_PARAMS slot 6 (threshold) is calibrated rawMin -5400 / rawMax 0.
    const plan = emptyPlan("URX44V");
    plan.nodeParams["ch1"] = { insertFx: 1793, insertFxParams: { "6": 999999 } };
    const cmd = planToCommands(model, plan).find((c) => c.paramId === ENGINE_COMPANDER_INPUT && c.y === 6);
    expect(cmd?.vdValue).toBe(0);
  });

  it("clamps an under-range Insert-FX engine slot", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["ch1"] = { insertFx: 1793, insertFxParams: { "6": -999999 } };
    const cmd = planToCommands(model, plan).find((c) => c.paramId === ENGINE_COMPANDER_INPUT && c.y === 6);
    expect(cmd?.vdValue).toBe(-5400);
  });

  it("drops a non-finite Insert-FX engine slot rather than writing it", () => {
    // No catalog default applies to an absent slot (the selector populates the
    // device's per-type default), so a NaN raw is not written at all.
    const plan = emptyPlan("URX44V");
    plan.nodeParams["ch1"] = { insertFx: 1793, insertFxParams: { "6": NaN } };
    const cmd = planToCommands(model, plan).find((c) => c.paramId === ENGINE_COMPANDER_INPUT && c.y === 6);
    expect(cmd).toBeUndefined();
  });

  it("clamps an over-range FX-channel effect param (REV-X reverbTime is 0..69)", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["bus.fx1"] = { fxEffect: { type: 0, params: { reverbTime: 9999 } } };
    const cmd = planToCommands(model, plan).find((c) => c.paramId === FX_EFFECT_ARRAY_PARAM[0] && c.y === 7);
    expect(cmd?.vdValue).toBe(69);
  });

  it("falls an off-menu FX effect TYPE back to the channel's factory type", () => {
    // An unknown TYPE is never written verbatim: the device would take it, and
    // fxFamilyOf would emit delay-family slots alongside it.
    const plan = emptyPlan("URX44V");
    plan.nodeParams["bus.fx1"] = { fxEffect: { type: 4242 } };
    const cmds = planToCommands(model, plan);
    const type = cmds.find((c) => c.paramId === FX_EFFECT_TYPE_PARAM[0] && c.y === 0);
    expect(type?.vdValue).toBe(FX_EFFECT_TYPE_DEFAULT[0]);
  });

  it("coerces an off-menu insert-FX selector to No Effect", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["ch1"] = { insertFx: 4242 };
    const cmd = planToCommands(model, plan).find((c) => c.name === "INSERT_FX" && c.y === 0);
    expect(cmd?.vdValue).toBe(denormalizeInsertFx(INSERT_FX_NONE));
  });

  it("clamps an over-range SSMCS raw (Morphing is 0..120)", () => {
    // SSMCS morphing (param 93) is a passthrough "raw" whose range lives in vd.ts,
    // not the encoder — a hand-edited plan must not write past it.
    const plan = emptyPlan("URX44V");
    plan.nodeParams["ch1"] = { compEqType: 1, ssmcs: { morphing: 9999 } };
    const cmd = planToCommands(model, plan).find((c) => c.name === "SSMCS_MORPHING" && c.y === 0);
    expect(cmd?.vdValue).toBe(SSMCS_MORPHING_MAX);
  });

  it("coerces an off-menu Rec Point enum back to the default", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["ch1"] = { recPoint: 99 };
    const cmd = planToCommands(model, plan).find((c) => c.name === "REC_POINT" && c.y === 0);
    expect(cmd?.vdValue).toBe(REC_POINT_DEFAULT);
  });

  // A stage the channel's own Rec Point list does not offer: a mono-only stage on a stereo
  // channel is PRE FADER, and PRE EQ on a channel in SSMCS mode is PRE COMP, the unit's own move.
  it("sends a channel only a Rec Point stage its own list offers", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["ch_5_6"] = { recPoint: 0 };
    plan.nodeParams["ch1"] = { compEqType: 1, recPoint: 2 };
    plan.nodeParams["ch2"] = { compEqType: 0, recPoint: 2 };
    const sent = (node: string) =>
      planToCommands(model, plan).find((c) => c.name === "REC_POINT" && c.node === node)?.vdValue;
    expect(sent("ch_5_6")).toBe(REC_POINT_DEFAULT);
    expect(sent("ch1")).toBe(REC_POINT_PRE_COMP);
    expect(sent("ch2")).toBe(2);
  });

  it("coerces an off-menu BUS Type enum back to VARI", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["bus.mix1"] = { busType: 42 };
    const cmd = planToCommands(model, plan).find((c) => c.name === "BUS_TYPE");
    expect(cmd?.vdValue).toBe(BUS_TYPE_VARI);
  });

  it("coerces an off-menu STREAMING DELAY frame rate back to the default", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["bus.stream"] = { delay: { frameRate: 42 } };
    const cmd = planToCommands(model, plan).find((c) => c.name === "STREAM_DELAY_FRAME_RATE");
    expect(cmd?.vdValue).toBe(DELAY_FRAME_RATE_DEFAULT);
  });
});

// vd_set takes an integer, so a fraction or a boolean reaching a command's vdValue is a write
// the shell refuses before it reaches the unit, and the write stops there. Every raw family is
// fed a fractional leaf and a boolean one through a plan no load repaired.
describe("every emitted vdValue is an integer", () => {
  const rawPlan = (leaf: number | boolean): ReturnType<typeof emptyPlan> => {
    const plan = emptyPlan("URX44V");
    const v = leaf as number;
    plan.nodeParams["ch1"] = { compEqType: 0, comp: { oneKnobLevel: v } };
    plan.nodeParams["ch2"] = {
      compEqType: 1,
      ssmcs: {
        compDrive: v,
        morphing: v,
        outGain: v,
        comp: { attack: v, release: v, ratio: v, threshold: v, makeup: v },
        sc: { q: v, freq: v, gain: v },
        eq: { low: { freq: v, gain: v }, mid: { q: v, freq: v, gain: v }, high: { freq: v, gain: v } },
      },
    };
    plan.nodeParams["ch3"] = { insertFx: 1793, insertFxParams: { "compander:6": v, "compander:7": v } };
    plan.nodeParams["bus.stereo"] = { eqOneKnob: { level: v } };
    plan.nodeParams["bus.osc"] = { osc: { interval: v } };
    return plan;
  };

  it("rounds a fractional raw before it is bounded", () => {
    const cmds = planToCommands(model, rawPlan(10.5));
    const families = [
      "COMP_ONE_KNOB_LEVEL",
      "SSMCS_COMP_DRIVE",
      "INSERT_FX_EFFECT",
      "EQ_ONE_KNOB_LEVEL",
      "OSC_BURST_INTERVAL",
    ];
    // The positive control: each family is emitted at all, so an integer check below is not
    // satisfied by a family that went missing.
    for (const name of families)
      expect(
        cmds.some((c) => c.name === name),
        name,
      ).toBe(true);
    expect(cmds.filter((c) => !Number.isInteger(c.vdValue)).map((c) => `${c.name} ${c.vdValue}`)).toEqual([]);
  });

  it("sends no command for a raw that is not a number", () => {
    const cmds = planToCommands(model, rawPlan(true));
    expect(cmds.filter((c) => !Number.isInteger(c.vdValue)).map((c) => `${c.name} ${c.vdValue}`)).toEqual([]);
  });
});

describe("AUDIT: port-ref tag collides with the none sentinel at one port id (KNOWN GAP)", () => {
  it("tagging port 0x7fffffff yields the nothing-selected sentinel", () => {
    // tagPortRef sets bit 31: 0x80000000 | 0x7fffffff = 0xffffffff = PORT_REF_NONE.
    // A port id with all low 31 bits set would therefore encode as "cleared".
    expect(tagPortRef(0x7fffffff)).toBe(PORT_REF_NONE);
    // …and decode back to null rather than the port. Unreachable in practice: real
    // URX port ids are small (< a few hundred), never near 0x7fffffff.
    expect(vdToPortRef(tagPortRef(0x7fffffff))).toBeNull();
    // A realistic tagged port still round-trips cleanly.
    expect(vdToPortRef(tagPortRef(288))).toBe(288);
  });
});
