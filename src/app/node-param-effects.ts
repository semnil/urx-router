// Which repaint a node-parameter edit earns.
//
// Split out of main.ts's `onUpdateNodeParams`, where it was ~90 lines of derived
// flags inside a closure that also mutates the plan and mirrors a linked pair —
// so nothing could state the rule without performing the edit. Every input is read
// from the patch and the previous values alone, and all six flags are computed
// before any of them is consumed, so the whole block is a pure function of the two.
//
// The distinction the table exists to hold is `relayout` versus `in place`: a
// toggle changes which controls the inspector shows and must re-render, while a
// value slider must NOT — a re-render replaces the element under the pointer and
// the drag ends there.

import type { NodeParams } from "../core/plan";

export interface NodeParamEffects {
  /** Linking a pair snaps its partner next to the kept node, so the tie is not
   *  drawn across a gap an earlier manual move opened. */
  alignStereoPair: boolean;
  /** Something on the canvas changed: a mute dimming, or a pair connector. */
  repaintNodes: boolean;
  /** A mute changed, so the wires out of the node recede (isOffSend). */
  repaintWires: boolean;
  /** The set of nodes changed, so the board is rebuilt (SD Rec Track Count gates
   *  how many track-pair slots exist). */
  rerender: boolean;
  /** Switching COMP/EQ type resets the destination chain to factory, as the unit
   *  does — the SSMCS and COMP→EQ banks are exclusive and not preserved. */
  resetCompEqBank: boolean;
  /** The inspector shows a different set of controls now. */
  refreshInspector: boolean;
}

export function nodeParamEffects(patch: NodeParams, prev: NodeParams | undefined): NodeParamEffects {
  // The oscillator's `on` lives under an osc patch that also carries level / mode,
  // so detect its actual flip rather than the presence of the patch.
  const oscOnChanged = patch.osc !== undefined && patch.osc.on !== prev?.osc?.on;
  const muteChanged = patch.on !== undefined || patch.duckerOn !== undefined || oscOnChanged;

  // An EQ band's filter type / ON changes which controls show (Q, gain), so it
  // needs a re-render; a freq / Q / gain slick must NOT (it keeps slider focus).
  const eqRelayout =
    patch.eqBands !== undefined &&
    patch.eqBands.some((b, i) => b?.type !== prev?.eqBands?.[i]?.type || b?.on !== prev?.eqBands?.[i]?.on);
  // COMP 1-knob / Auto Makeup hide or show the individual comp controls.
  const compRelayout =
    patch.comp !== undefined &&
    (patch.comp.oneKnob !== prev?.comp?.oneKnob || patch.comp.autoMakeup !== prev?.comp?.autoMakeup);
  // OSC on / mode toggles re-render (mode shows or hides the frequency control);
  // the level / frequency sliders must not.
  const oscRelayout = patch.osc !== undefined && (patch.osc.on !== prev?.osc?.on || patch.osc.mode !== prev?.osc?.mode);
  // SSMCS on / side-chain on / EQ band on are two-button toggles whose active state
  // only refreshes on re-render; the morphing-strip value sliders must not.
  const ssmcsRelayout =
    patch.ssmcs !== undefined &&
    (patch.ssmcs.on !== prev?.ssmcs?.on ||
      patch.ssmcs.sc?.on !== prev?.ssmcs?.sc?.on ||
      patch.ssmcs.eq?.low?.on !== prev?.ssmcs?.eq?.low?.on ||
      patch.ssmcs.eq?.mid?.on !== prev?.ssmcs?.eq?.mid?.on ||
      patch.ssmcs.eq?.high?.on !== prev?.ssmcs?.eq?.high?.on);
  // EQ 1-knob ON swaps the 1-knob controls for the band tabs; the type select
  // self-updates and the level slider keeps focus.
  const eqOneKnobRelayout = patch.eqOneKnob !== undefined && patch.eqOneKnob.on !== prev?.eqOneKnob?.on;
  // An FX EFFECT type change swaps the whole parameter editor (each effect keeps its
  // own controls under the shared fxEffect keys), so it must re-render — else the
  // previous effect's editor stays live and writes wrong-scale raws. The effect's own
  // value sliders / ON toggle share the key but leave type unchanged.
  const fxEffectRelayout = patch.fxEffect !== undefined && patch.fxEffect.type !== prev?.fxEffect?.type;

  return {
    alignStereoPair: patch.stereoLink === true,
    repaintNodes: muteChanged || patch.stereoLink !== undefined,
    repaintWires: muteChanged,
    rerender: patch.sdRecTrackCount !== undefined,
    resetCompEqBank: patch.compEqType !== undefined && patch.compEqType !== prev?.compEqType,
    refreshInspector:
      patch.on !== undefined ||
      patch.hpf !== undefined ||
      patch.phantom !== undefined ||
      patch.phase !== undefined ||
      patch.phaseL !== undefined ||
      patch.phaseR !== undefined ||
      patch.clipSafe !== undefined ||
      patch.hiZ !== undefined ||
      patch.insertFx !== undefined ||
      patch.compEqType !== undefined ||
      patch.eqOn !== undefined ||
      patch.gateOn !== undefined ||
      patch.compOn !== undefined ||
      patch.duckerOn !== undefined ||
      patch.cueInterrupt !== undefined ||
      patch.mono !== undefined ||
      patch.busType !== undefined ||
      patch.panLink !== undefined ||
      patch.stereoLink !== undefined ||
      patch.panBal !== undefined ||
      eqRelayout ||
      compRelayout ||
      oscRelayout ||
      ssmcsRelayout ||
      eqOneKnobRelayout ||
      fxEffectRelayout,
  };
}
