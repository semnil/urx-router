// The repaint decision table. The distinction it exists to hold is relayout versus
// in place: a toggle changes which controls the inspector shows and must re-render,
// while a value slider must NOT — a re-render replaces the element under the pointer
// and the drag ends there. Every case below is one or the other.

import { describe, expect, it } from "vitest";
import { nodeParamEffects } from "./node-param-effects";
import type { NodeParams } from "../core/plan";

const fx = (patch: NodeParams, prev: NodeParams = {}) => nodeParamEffects(patch, prev);

const NOTHING = {
  alignStereoPair: false,
  repaintNodes: false,
  repaintWires: false,
  rerender: false,
  resetCompEqBank: false,
  refreshInspector: false,
};

describe("an edit that earns nothing", () => {
  it("asks for no repaint at all for a plain value slick", () => {
    expect(fx({ gain: 12 })).toEqual(NOTHING);
    expect(fx({ pan: 20 })).toEqual(NOTHING);
    expect(fx({ hpfFreq: 100 })).toEqual(NOTHING);
    expect(fx({ phonesLevel: 5 })).toEqual(NOTHING);
  });

  it("asks for nothing for an empty patch", () => {
    expect(fx({})).toEqual(NOTHING);
  });
});

describe("canvas repaints", () => {
  // CH_ON drives the on-canvas mute dimming, and a muted node's wires recede.
  it("repaints nodes and wires when a mute changes", () => {
    expect(fx({ on: false })).toMatchObject({ repaintNodes: true, repaintWires: true });
    expect(fx({ duckerOn: true })).toMatchObject({ repaintNodes: true, repaintWires: true });
  });

  // The oscillator's `on` rides in a patch that also carries level and mode, so the
  // flip has to be detected rather than the patch's presence.
  it("repaints for an oscillator flip but not for its level", () => {
    expect(fx({ osc: { on: true } }, { osc: { on: false } })).toMatchObject({
      repaintNodes: true,
      repaintWires: true,
    });
    expect(fx({ osc: { on: true, level: -20 } }, { osc: { on: true, level: -14 } })).toMatchObject({
      repaintNodes: false,
      repaintWires: false,
    });
  });

  // The STEREO link draws a pair connector — nodes only, no wires.
  it("repaints nodes but not wires for a STEREO link", () => {
    expect(fx({ stereoLink: true })).toMatchObject({ repaintNodes: true, repaintWires: false });
    expect(fx({ stereoLink: false }, { stereoLink: true })).toMatchObject({
      repaintNodes: true,
      repaintWires: false,
    });
  });

  // Linking snaps the partner next to the kept node; unlinking must not move it.
  it("aligns the pair on linking and not on unlinking", () => {
    expect(fx({ stereoLink: true }).alignStereoPair).toBe(true);
    expect(fx({ stereoLink: false }, { stereoLink: true }).alignStereoPair).toBe(false);
  });

  // Track Count gates how many SD Rec track-pair slots exist, so the slot nodes and
  // their wires are added or removed — a full rebuild, not a repaint.
  it("rebuilds the board when the SD Rec track count changes", () => {
    expect(fx({ sdRecTrackCount: 4 })).toMatchObject({ rerender: true });
    expect(fx({ on: false }).rerender).toBe(false);
  });
});

describe("COMP/EQ bank reset", () => {
  // The device does the same: the SSMCS and COMP→EQ banks are exclusive and not
  // preserved across a switch.
  it("resets the destination chain when the type actually changes", () => {
    expect(fx({ compEqType: 1 }, { compEqType: 0 }).resetCompEqBank).toBe(true);
  });

  // A re-assert of the current type is not a switch; resetting there would discard
  // the values the operator is holding.
  it("does not reset when the type is written back unchanged", () => {
    expect(fx({ compEqType: 1 }, { compEqType: 1 }).resetCompEqBank).toBe(false);
  });

  it("resets when the node had no type stored yet", () => {
    expect(fx({ compEqType: 1 }, {}).resetCompEqBank).toBe(true);
  });
});

describe("inspector re-render: the toggles", () => {
  const TOGGLES: Array<[string, NodeParams]> = [
    ["channel on", { on: false }],
    ["HPF", { hpf: true }],
    ["phantom", { phantom: true }],
    ["phase", { phase: true }],
    ["phase L", { phaseL: true }],
    ["phase R", { phaseR: true }],
    ["clip safe", { clipSafe: true }],
    ["Hi-Z", { hiZ: true }],
    ["insert FX", { insertFx: 512 }],
    ["COMP/EQ type", { compEqType: 1 }],
    ["EQ on", { eqOn: true }],
    ["GATE on", { gateOn: true }],
    ["COMP on", { compOn: true }],
    ["ducker on", { duckerOn: true }],
    ["cue interrupt", { cueInterrupt: true }],
    ["mono", { mono: true }],
    ["bus type", { busType: 1 }],
    ["pan link", { panLink: true }],
    ["stereo link", { stereoLink: true }],
    ["pan/bal", { panBal: 1 }],
  ];

  it.each(TOGGLES)("re-renders for %s", (_name, patch) => {
    expect(fx(patch).refreshInspector).toBe(true);
  });
});

describe("inspector re-render: relayout versus in place", () => {
  // An EQ band's filter type / ON changes which controls show (Q, gain).
  it("re-renders for an EQ band's type or ON, not for its values", () => {
    const prev: NodeParams = { eqBands: [{ on: true, type: 0, freq: 100, q: 1, gain: 0 }] };
    expect(fx({ eqBands: [{ on: true, type: 1, freq: 100, q: 1, gain: 0 }] }, prev).refreshInspector).toBe(true);
    expect(fx({ eqBands: [{ on: false, type: 0, freq: 100, q: 1, gain: 0 }] }, prev).refreshInspector).toBe(true);
    expect(fx({ eqBands: [{ on: true, type: 0, freq: 400, q: 2, gain: 6 }] }, prev).refreshInspector).toBe(false);
  });

  it("re-renders for a band the node did not have", () => {
    expect(fx({ eqBands: [{ on: true, type: 0, freq: 100, q: 1, gain: 0 }] }, {}).refreshInspector).toBe(true);
  });

  // COMP 1-knob / Auto Makeup hide or show the individual comp controls; the value
  // sliders must keep focus.
  it("re-renders for COMP 1-knob and Auto Makeup, not for its values", () => {
    const prev: NodeParams = { comp: { oneKnob: false, autoMakeup: false, threshold: -20 } };
    expect(fx({ comp: { oneKnob: true } }, prev).refreshInspector).toBe(true);
    expect(fx({ comp: { autoMakeup: true } }, prev).refreshInspector).toBe(true);
    expect(fx({ comp: { oneKnob: false, autoMakeup: false, threshold: -30 } }, prev).refreshInspector).toBe(false);
  });

  // OSC mode shows or hides the frequency control; the level slider keeps focus.
  it("re-renders for an oscillator's on or mode, not for its level", () => {
    const prev: NodeParams = { osc: { on: true, mode: 0, level: -14 } };
    expect(fx({ osc: { on: false, mode: 0, level: -14 } }, prev).refreshInspector).toBe(true);
    expect(fx({ osc: { on: true, mode: 1, level: -14 } }, prev).refreshInspector).toBe(true);
    expect(fx({ osc: { on: true, mode: 0, level: -20 } }, prev).refreshInspector).toBe(false);
  });

  // The SSMCS toggles' active state only refreshes on re-render; the morphing-strip
  // sliders must not re-render.
  it("re-renders for every SSMCS toggle, not for its values", () => {
    const prev: NodeParams = {
      ssmcs: {
        on: true,
        morphing: 50,
        sc: { on: false },
        eq: { low: { on: false }, mid: { on: false }, high: { on: false } },
      },
    };
    expect(fx({ ssmcs: { on: false } }, prev).refreshInspector).toBe(true);
    expect(fx({ ssmcs: { sc: { on: true } } }, prev).refreshInspector).toBe(true);
    expect(fx({ ssmcs: { eq: { low: { on: true } } } }, prev).refreshInspector).toBe(true);
    expect(fx({ ssmcs: { eq: { mid: { on: true } } } }, prev).refreshInspector).toBe(true);
    expect(fx({ ssmcs: { eq: { high: { on: true } } } }, prev).refreshInspector).toBe(true);
    // The inspector sends the whole sub-object (it merges over the stored one), so
    // a value-only edit still carries every toggle at its current state — which is
    // what makes "nothing flipped" distinguishable from "nothing was sent".
    expect(fx({ ssmcs: { ...prev.ssmcs, morphing: 80 } }, prev).refreshInspector).toBe(false);
  });

  // EQ 1-knob ON swaps the 1-knob controls for the band tabs; its level keeps focus.
  it("re-renders for the EQ 1-knob's ON, not for its level", () => {
    const prev: NodeParams = { eqOneKnob: { on: false, type: 0, level: 30 } };
    expect(fx({ eqOneKnob: { on: true, type: 0, level: 30 } }, prev).refreshInspector).toBe(true);
    expect(fx({ eqOneKnob: { on: false, type: 0, level: 70 } }, prev).refreshInspector).toBe(false);
  });

  // An FX EFFECT type change swaps the whole parameter editor — else the previous
  // effect's editor stays live and writes wrong-scale raws.
  it("re-renders for an FX effect's type, not for its own values", () => {
    const prev: NodeParams = { fxEffect: { type: 1, on: true, params: { 0: 10 } } };
    expect(fx({ fxEffect: { type: 2 } }, prev).refreshInspector).toBe(true);
    expect(fx({ fxEffect: { type: 1, params: { 0: 40 } } }, prev).refreshInspector).toBe(false);
  });
});
