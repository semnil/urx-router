// @vitest-environment jsdom

// The INS FX tuning screen's descriptor. What it has to get right is the pair of
// indirections nothing else on this screen has: the family is a PLAN value rather than a
// property of the descriptor, and a field names an engine SLOT rather than a parameter —
// so the same key means a different thing under every family, and an edit that lands under
// the wrong one is a value the next selector write reads as its own.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dynHost } from "./dyn-screen.test-util";
import type { DynHost } from "./dyn-screen.test-util";
import { DynScreen } from "./dyn-screen";
import type { DynCtx } from "./dyn-screen";
import { INSFX_DYN, insertFxScreenFamily } from "./insert-fx-screen";
import { insertFxParamKey, insertFxParams } from "../core/control/insert-fx-effect";
import { INSERT_FX_NONE, INSERT_FX_OPTIONS, OUTPUT_INSERT_FX_OPTIONS } from "../core/control/params";
import { t } from "../i18n";

let h: DynHost;

const valueOf = (label: string): number =>
  [...INSERT_FX_OPTIONS, ...OUTPUT_INSERT_FX_OPTIONS].find((o) => o.label === label)!.value;

/** Put an effect on a node and answer the context the descriptor is asked against. */
const holding = (nodeId: string, label: string): DynCtx => {
  h.plan.nodeParams[nodeId] = { ...h.plan.nodeParams[nodeId], insertFx: valueOf(label) };
  return { model: h.model, plan: h.plan, nodeId, sel: 0, m: t() };
};

beforeEach(() => {
  localStorage.clear();
  h = dynHost({ plotSize: { w: 0, h: 0 } });
});

afterEach(() => {
  h?.restore();
  document.body.replaceChildren();
});

describe("what the screen binds to", () => {
  it("refuses a node holding nothing — there is no effect to tune", () => {
    const ctx: DynCtx = { model: h.model, plan: h.plan, nodeId: "ch1", sel: 0, m: t() };
    expect(INSFX_DYN.bind(ctx)).toBeNull();
    h.plan.nodeParams.ch1 = { insertFx: INSERT_FX_NONE };
    expect(INSFX_DYN.bind(ctx)).toBeNull();
    expect(insertFxScreenFamily(h.plan, "ch1")).toBeNull();
  });

  it("refuses a node with no insert FX at all", () => {
    // A stereo input channel has no insert effect, so a plan value on it names nothing.
    expect(INSFX_DYN.bind(holding("ch_5_6", "Clean"))).toBeNull();
  });

  it("binds every family it shows whole", () => {
    for (const label of ["Clean", "Crunch", "Lead", "Drive", "Compander-H", "Compander-S"]) {
      const binding = INSFX_DYN.bind(holding("ch1", label));
      expect(binding, label).not.toBeNull();
      expect(binding!.fields.length, label).toBeGreaterThan(0);
    }
  });

  it("refuses the two families it would show only in part", () => {
    // Pitch Fix keeps its Key, Scale and note mask outside the flat catalogue, and the
    // multi-band compressor is not in it at all. Opening on either would be an editor
    // missing the half that decides what the effect does.
    expect(INSFX_DYN.bind(holding("ch1", "Pitch Fix"))).toBeNull();
    expect(INSFX_DYN.bind(holding("bus.mix1", "M.Band Comp"))).toBeNull();
  });

  it("names the effect in the title, so the heading is not just a slot", () => {
    const ctx = holding("ch1", "Compander-S");
    expect(INSFX_DYN.title(t(), ctx)).toContain("Compander-S");
    expect(INSFX_DYN.title(t(), ctx)).toContain(t().dynTuning.insfx.title);
  });
});

describe("the meter lanes", () => {
  it("takes a mono channel's taps either side of the insert point, with its own reduction", () => {
    const lanes = INSFX_DYN.bind(holding("ch2", "Compander-H"))!.lanes;
    expect(lanes.map((l) => l.key)).toEqual(["in", "out", "gr"]);
    // PRE INS FX (112) into the effect, PRE FADER (113) out of it, input insert GR (132).
    expect(lanes[0].tap!.l).toEqual([112, 1]);
    expect(lanes[1].tap!.l).toEqual([113, 1]);
    expect(lanes[2].gr).toEqual([132, 1]);
    expect(lanes[2].sameSlot).toBe(true);
  });

  it("takes an output bus's post tap and the band-indexed output reduction", () => {
    const lanes = INSFX_DYN.bind(holding("bus.mix1", "Compander-S"))!.lanes;
    // The output effect's GR is addressed by BAND, not by bus: only one runs device-wide.
    expect(lanes[2].gr).toEqual([133, 0]);
    // A bus tap is stereo, and the effect sits AFTER the fader there — so the output side
    // is POST rather than the channel's PRE FADER.
    expect(lanes[1].tap!.r).toBeDefined();
    expect(lanes[1].label).toBe(t().dynTuning.insfx.tapOutBus);
    expect(lanes[0].label).toBe(t().dynTuning.insfx.tapIn);
  });

  it("draws no reduction bar for an effect that reduces nothing", () => {
    // A guitar amp has no GR meter on the unit. The lane is still declared, so the rack
    // keeps one shape across the families, and it simply resolves no address.
    const lanes = INSFX_DYN.bind(holding("ch1", "Crunch"))!.lanes;
    expect(lanes[2].kind).toBe("gr");
    expect(lanes[2].gr).toEqual([132, 0]);
  });
});

describe("reading and writing engine slots", () => {
  it("stores an edit under the family's own key, not the bare slot", () => {
    const ctx = holding("ch1", "Compander-H");
    const patch = INSFX_DYN.patch(ctx, { ifx6: -2000 });
    expect(patch.insertFxParams).toEqual({ [insertFxParamKey("compander", 6)]: -2000 });
  });

  it("replaces a bare slot a readback wrote rather than leaving both to answer", () => {
    const ctx = holding("ch1", "Compander-H");
    h.plan.nodeParams.ch1!.insertFxParams = { "6": -1234 };
    // The bare key is the device-shaped namespace, read as the selected family's until
    // the first edit re-keys it. Two keys for one slot is what must not survive.
    expect(INSFX_DYN.read(ctx).ifx6).toBe(-1234);
    const patch = INSFX_DYN.patch(ctx, { ifx6: -2000 });
    expect(patch.insertFxParams!["6"]).toBeUndefined();
    expect(patch.insertFxParams![insertFxParamKey("compander", 6)]).toBe(-2000);
  });

  it("writes a mirrored slot with its twin", () => {
    // Three Pitch Fix values are stored twice and the device reads both, so an edit that
    // wrote one of them would be half applied. `patch` is asked directly: the screen does
    // not open on this family, and the rule belongs to the writer either way.
    const ctx = holding("ch1", "Pitch Fix");
    const mirrored = insertFxParams("pitch").find((d) => d.mirror !== undefined)!;
    const written = INSFX_DYN.patch(ctx, { [`ifx${mirrored.slot}`]: 7 }).insertFxParams!;
    expect(written[insertFxParamKey("pitch", mirrored.slot)]).toBe(7);
    expect(written[insertFxParamKey("pitch", mirrored.mirror!)]).toBe(7);
  });

  it("reads a value the plan does not carry as the catalogue's own default", () => {
    const ctx = holding("ch1", "Compander-S");
    // ratio, slot 7, factory 350 = 3.5:1.
    expect(INSFX_DYN.read(ctx).ifx7).toBe(350);
  });

  it("keeps one family's stored values out of another's", () => {
    const ctx = holding("ch1", "Compander-H");
    h.plan.nodeParams.ch1!.insertFxParams = { [insertFxParamKey("guitar-clean", 7)]: 99 };
    // Slot 7 is the compander's Ratio and the guitar amp's Volume. Reading the guitar's
    // value here would show 99 as a ratio and write it back as one.
    expect(INSFX_DYN.read(ctx).ifx7).toBe(350);
  });
});

describe("the rendered screen", () => {
  const rowLabels = (): string[] =>
    [...h.box.querySelectorAll<HTMLElement>(".prefs-row .lbl")].map((e) => e.textContent ?? "");

  it("shows the compander's rows grouped by what shapes the response", () => {
    holding("ch1", "Compander-H");
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "ch1");
    const m = t().inspector.insertFxEffect.params;
    const order: string[] = [m.threshold, m.ratio, m.width, m.outGain, m.attack, m.release];
    expect(rowLabels().filter((l) => order.includes(l))).toEqual(order);
    screen.close();
  });

  it("prints a raw through the catalogue's own formatter", () => {
    holding("ch1", "Compander-H");
    h.plan.nodeParams.ch1!.insertFxParams = { [insertFxParamKey("compander", 6)]: -2000 };
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "ch1");
    // -2000 raw is -20.0 dB; the raw itself must not reach the screen.
    const shown = [...h.box.querySelectorAll<HTMLElement>(".gt-val")].map((e) => e.textContent);
    expect(shown).toContain("-20.0 dB");
    expect(shown).not.toContain("-2000");
    screen.close();
  });

  it("shows no plot: an amp's response and a pitch trace are not derivable", () => {
    holding("ch1", "Drive");
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "ch1");
    expect(h.box.querySelector(".gt-ladders")).not.toBeNull();
    expect(h.box.querySelector("canvas")).toBeNull();
    screen.close();
  });

  it("closes itself when a follow takes the effect away underneath it", () => {
    holding("ch1", "Compander-H");
    const screen = new DynScreen(h.hooks);
    screen.open(INSFX_DYN, "ch1");
    expect(screen.isOpen()).toBe(true);
    h.plan.nodeParams.ch1!.insertFx = INSERT_FX_NONE;
    screen.refresh();
    expect(screen.isOpen()).toBe(false);
  });
});
