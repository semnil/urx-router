// Robustness audit pins for the value paths that are NOT bounded before a device
// write. vd.ts's numeric encoders (level / pan / gain / EQ / dynamics …) all run
// through clamp(), which is both a range firewall and a NaN trap (see
// vd.audit.test.ts). Three write paths bypass that firewall by design and are
// pinned here so the exposure is documented in one place and an accidental change
// (adding OR removing a clamp) is caught:
//
//   - encodeValue("raw" / "enum") is a pure passthrough (translate.ts). The FX-
//     channel and Insert-FX effect params, and the effect TYPE selectors, store
//     raw broker integers in the plan and emit them verbatim. The inspector
//     sliders clamp to each descriptor's rawMin/rawMax, so a well-formed plan is
//     always in range — but a hand-edited or ?plan= payload carrying an out-of-
//     range raw is written to the engine array unbounded. AUDIT: no last-line
//     clamp on the raw/enum emit path (contrast the numeric encoders).
//   - tagPortRef collides with the "nothing selected" sentinel at one port id.
//     AUDIT: unreachable with real port ids (all small), pinned as a KNOWN GAP.

import { describe, expect, it } from "vitest";
import { getModel } from "../../models";
import { emptyPlan } from "../plan";
import { planToCommands } from "./translate";
import { ENGINE_COMPANDER_INPUT } from "./insert-fx-effect";
import { FX_EFFECT_ARRAY_PARAM, FX_EFFECT_TYPE_PARAM } from "./fx-effect";
import { PORT_REF_NONE, tagPortRef, vdToPortRef } from "./vd";

const model = getModel("URX44V");

describe("AUDIT: FX / Insert-FX raw emit path is unclamped (no bound firewall)", () => {
  it("Insert-FX engine slot emits an out-of-range raw verbatim (COMPANDER slot 6 is -5400..0)", () => {
    // COMPANDER_PARAMS slot 6 (threshold) is calibrated rawMin -5400 / rawMax 0.
    // A plan carrying a wildly out-of-range raw is written straight to the engine
    // array — the emit path does not re-clamp to the descriptor bounds.
    const plan = emptyPlan("URX44V");
    plan.nodeParams["ch1"] = { insertFx: 1793, insertFxParams: { "6": 999999 } };
    const cmd = planToCommands(model, plan).find((c) => c.paramId === ENGINE_COMPANDER_INPUT && c.y === 6);
    // AUDIT: emitted verbatim, not clamped to 0. A future clamp would change this.
    expect(cmd?.vdValue).toBe(999999);
  });

  it("Insert-FX engine slot emits a negative out-of-range raw verbatim", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["ch1"] = { insertFx: 1793, insertFxParams: { "6": -999999 } };
    const cmd = planToCommands(model, plan).find((c) => c.paramId === ENGINE_COMPANDER_INPUT && c.y === 6);
    expect(cmd?.vdValue).toBe(-999999);
  });

  it("FX-channel effect param emits an out-of-range raw verbatim (REV-X reverbTime is 0..69)", () => {
    const plan = emptyPlan("URX44V");
    plan.nodeParams["bus.fx1"] = { fxEffect: { type: 0, params: { reverbTime: 9999 } } };
    const cmd = planToCommands(model, plan).find((c) => c.paramId === FX_EFFECT_ARRAY_PARAM[0] && c.y === 7);
    // AUDIT: reverbTime slot 7 emitted verbatim past its rawMax 69.
    expect(cmd?.vdValue).toBe(9999);
  });

  it("FX-channel effect TYPE selector emits an out-of-menu value verbatim and defaults its family to delay", () => {
    // An unknown TYPE value is written to the selector as-is (enum passthrough) and
    // fxFamilyOf falls back to the delay family, so delay-family slots are emitted
    // alongside an unrecognized type. AUDIT: no validation against the type menu.
    const plan = emptyPlan("URX44V");
    plan.nodeParams["bus.fx1"] = { fxEffect: { type: 4242 } };
    const cmds = planToCommands(model, plan);
    const type = cmds.find((c) => c.paramId === FX_EFFECT_TYPE_PARAM[0] && c.y === 0);
    expect(type?.vdValue).toBe(4242);
    // Delay family (fallback) emits its delay-time slot 6 on the array param.
    expect(cmds.some((c) => c.paramId === FX_EFFECT_ARRAY_PARAM[0] && c.y === 6)).toBe(true);
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
