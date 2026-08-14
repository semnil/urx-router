// The 4-band PEQ for the channel tuning screen.
//
// It is the same host as GATE and COMP with three things arranged differently, each for
// a reason the EQ has and they do not:
//
//   - there is no LADDER/CURVE choice. A gate is read either as a threshold on a meter
//     or as a transfer curve; an EQ's response and its levels are not alternatives, so
//     the plot and the lane rack are both on screen and the segmented bar in the tabs'
//     place selects a **band** instead. The bar resets to LOW per open: it is a cursor
//     into the parameters, not a way of reading the processor.
//   - the plot's axes are frequency against gain, not dBFS against dBFS, so it carries
//     no live dot and no press-to-set gesture. Each band gets a marker, because the
//     operator needs to see where it sits — a marker and not a grip: four grips on one
//     plot cannot tell which value a press meant (the COMP screen proved that with
//     three), so the sliders stay the editing path and nothing here is draggable.
//   - it exists on four kinds of node (mono channel, stereo channel, MIX, STEREO
//     master), which is where the taps differ — a mono channel's EQ sits between PRE EQ
//     and PRE INS FX, a stereo channel's between INPUT and PRE FADER (its INPUT tap is
//     pre-EQ), a bus's between PRE EQ and PRE FADER. A stereo node's taps carry L and R,
//     which the rack draws as two bars in one lane.
//
// The mono channel's HPF is deliberately NOT drawn on the response: it sits upstream of
// the compressor, whose own gain changes with frequency content, so it does not add to
// this stage's curve in any way the plot could honestly show.
//
// The response model itself — and the three corrections that came out of measuring the
// unit rather than reading the cookbook — is core/eq-response.ts.

import {
  EQ_BAND_DEFAULT_FREQ_HZ,
  EQ_ONE_KNOB_TYPE_DEFAULT,
  EQ_ONE_KNOB_TYPE_OPTIONS,
  EQ_Q_DEFAULT,
  EQ_TYPE_HIGH_OPTIONS,
  EQ_TYPE_LOW_OPTIONS,
  EQ_TYPE_PASS,
  EQ_TYPE_PEAKING,
  EQ_TYPE_SHELVING,
  COMP_EQ_COMP_FIRST,
} from "../core/control/params";
import { eqBandFields, EQ_BAND_NAMES, eqBandHasType, hasEq, isStereoChannel } from "../core/control/translate";
import { channelEqUnavailable } from "../core/constraints";
import { eqResponse } from "../core/eq-response";
import type { EqBandState } from "../core/eq-response";
import { controlId, eqBandScope, EQ_SCOPE } from "../core/midi/controls";
import type { ControlParam } from "../core/midi/controls";
import { tapFor } from "../core/meters";
import type { EqBand, NodeParams } from "../core/plan";
import { el, onOff, settingsRow, settingsSection } from "./dom";
import type { SettingsRowOptions } from "./dom";
import { enumRow } from "./dyn-chan";
import { drawBandMarkers, drawFreqAxes, drawFreqCurve, freqGeo } from "./dyn-freq-plot";
import { oneKnobLevelRow, splitDisplay } from "./dyn-screen";
import type { DynCtx, DynLane, DynPlotGeo, DynProcessor } from "./dyn-screen";

/** Level-lane ruler. The stages either side of an EQ are programme level, so the ruler
 *  is the range a mix is read in rather than a threshold's domain (there is no value to
 *  drag on these meters — an EQ's gains are not in dBFS). */
const LO_DB = -60;
const TICK_STEP = 6;

/** One band's values, defaulted the way the device defaults them. The plot and the sliders
 *  read the same function, so they cannot drift on what "unset" means. */
function bandAt(ctx: DynCtx, index: number): EqBandState {
  const b = ctx.plan.nodeParams[ctx.nodeId]?.eqBands?.[index] ?? {};
  return {
    index,
    on: b.on ?? true,
    type: b.type ?? (eqBandHasType(index) ? EQ_TYPE_SHELVING : EQ_TYPE_PEAKING),
    freq: b.freq ?? EQ_BAND_DEFAULT_FREQ_HZ[index],
    q: b.q ?? EQ_Q_DEFAULT,
    gain: b.gain ?? 0,
  };
}

/** Every band, for the response curve and its markers. */
const allBands = (ctx: DynCtx): EqBandState[] => EQ_BAND_NAMES.map((_, i) => bandAt(ctx, i));

/** Which two taps bracket this node's EQ. The stage differs per node kind — a stereo
 *  channel's INPUT tap is its pre-EQ point, a mono channel has a PRE EQ of its own —
 *  and getting it from the tap tables keeps the answer beside the measurements. */
function eqTapKeys(nodeId: string): { in: string; out: string } {
  if (nodeId.startsWith("bus.")) return { in: "preeq", out: "prefader" };
  if (isStereoChannel(nodeId)) return { in: "input", out: "prefader" };
  return { in: "preeq", out: "preinsfx" };
}

/** Whether the device is driving this node's bands right now. */
const oneKnobOn = (ctx: DynCtx): boolean => ctx.plan.nodeParams[ctx.nodeId]?.eqOneKnob?.on === true;

export const EQ_DYN: DynProcessor = {
  key: "eq",
  loDb: LO_DB,
  tickStep: TICK_STEP,
  title: (m) => m.dynTuning.eq.title,

  bind: (ctx) => {
    const np = ctx.plan.nodeParams[ctx.nodeId];
    // A mono channel in SSMCS mode has no 4-band PEQ at all (the morphing strip replaces
    // it), so there is nothing for this screen to show — the same question both launchers
    // ask before offering to open it.
    if (!hasEq(ctx.model, ctx.nodeId, np?.compEqType ?? COMP_EQ_COMP_FIRST)) return null;
    const keys = eqTapKeys(ctx.nodeId);
    // Always the same three sliders, in the order the unit reads them. Which of them the
    // device actually reads depends on the filter type — a pass filter reads neither Q nor
    // gain (measured: Q 0.71 and Q 4.00 draw an identical high-pass with no corner
    // resonance), and only a peaking band reads Q — but a row that disappears takes the
    // panel's height with it and moves every row below under the pointer. So the
    // inapplicable ones lock and say why, which is the treatment the 1-knob's own rows
    // already get while 1-knob is off.
    const fields = eqBandFields(ctx.sel);
    const lane = (key: string, tapKey: string): DynLane => {
      const tap = tapFor(ctx.nodeId, tapKey, ctx.model.id) ?? null;
      // No label rather than the internal key if a tap fails to resolve: the lane then
      // has no meter, and "preeq" is not a caption.
      return { key, label: tap?.label ?? "", kind: "level", tap };
    };
    return { fields, lanes: [lane("in", keys.in), lane("out", keys.out)] };
  },

  bar: (ctx) => ({
    label: ctx.m.dynTuning.eq.band,
    items: EQ_BAND_NAMES.map((k) => ({ label: ctx.m.inspector.eqBand[k], id: `dyn-band-${k.toLowerCase()}` })),
    // No band is being edited while the device drives them all.
    inert: oneKnobOn(ctx) || undefined,
  }),
  hint: (ctx) => ctx.m.dynTuning.eq.plotHint,
  // Named while a band is the operator's, reserved while the device drives them all.
  paramsTag: (ctx) => ({ text: ctx.m.inspector.eqBand[EQ_BAND_NAMES[ctx.sel]], shown: !oneKnobOn(ctx) }),

  read: (ctx) => {
    const ok = ctx.plan.nodeParams[ctx.nodeId]?.eqOneKnob ?? {};
    return {
      ...bandAt(ctx, ctx.sel),
      oneKnobOn: ok.on ?? false,
      oneKnobType: ok.type ?? EQ_ONE_KNOB_TYPE_DEFAULT,
      oneKnobLevel: ok.level ?? 0,
    };
  },

  // The band values and the 1-knob live in different places in the plan, so the patch
  // is split by key rather than merged into one sub-object. The bands are an array: the
  // other three have to survive an edit to this one.
  patch: (ctx, patch) => {
    const np = ctx.plan.nodeParams[ctx.nodeId];
    const out: NodeParams = {};
    const bandPatch: EqBand = {};
    const knobPatch: { on?: boolean; type?: number; level?: number } = {};
    for (const [k, v] of Object.entries(patch)) {
      if (k === "oneKnobOn") knobPatch.on = v === true;
      else if (k === "oneKnobType") knobPatch.type = Number(v);
      else if (k === "oneKnobLevel") knobPatch.level = Number(v);
      else if (k === "on") bandPatch.on = v === true;
      else bandPatch[k as "type" | "freq" | "q" | "gain"] = Number(v);
    }
    if (Object.keys(bandPatch).length) {
      const bands = (np?.eqBands ?? []).slice();
      // Filled dense up to the edited band, never assigned past the end of a shorter
      // array. Writing `bands[3]` onto a plan that carries no eqBands leaves holes at
      // 0-2, `JSON.stringify` writes those as `null`, and the load funnel's rule — one
      // bad element drops the whole collection — then discards every band on reopen,
      // including the edited one. Nothing shows it during the session: the live mirror
      // skips empty slots, so it is lost only across a round trip.
      for (let i = 0; i <= ctx.sel; i++) bands[i] ??= {};
      bands[ctx.sel] = { ...bands[ctx.sel], ...bandPatch };
      out.eqBands = bands;
    }
    if (Object.keys(knobPatch).length) out.eqOneKnob = { ...(np?.eqOneKnob ?? {}), ...knobPatch };
    return out;
  },

  // Three reasons a band row is not the operator's, and they are not the same thing:
  //   - the rate. Above 96 kHz a stereo channel's EQ is not merely locked in the app —
  //     measured, a 1 kHz high-pass that cut -13 dB at 500 Hz passes it untouched at
  //     176.4 and 192 kHz, while the parameters are still stored and returned;
  //   - 1-knob. The device computes all four bands from one level, so the band rows are
  //     **reserved out of sight** and the band bar goes inert: there is no band being
  //     edited, so offering one to select would be offering a choice with no effect. They
  //     keep their space, because a panel that changes height moves everything below it —
  //     including the Close action — under the pointer;
  //   - the filter type. The two mid bands have no type at all (the device rejects the
  //     write, measured 400), a pass filter reads neither Q nor gain, and a shelf reads
  //     no Q. Those rows stay visible and say why, since the operator still owns the band.
  rowStates: (ctx, vals) => {
    const band = ["on", "type", "freq", "q", "gain"];
    if (channelEqUnavailable(ctx.nodeId, ctx.plan.sampleRate)) {
      const locked = { tag: ctx.m.inspector.eqRateLocked, locked: true };
      return new Map([...band, "oneKnobOn", "oneKnobType", "oneKnobLevel"].map((k) => [k, locked]));
    }
    const out = new Map<string, SettingsRowOptions>();
    if (!eqBandHasType(ctx.sel)) out.set("type", { tag: ctx.m.dynTuning.eq.fixedBand, locked: true });
    const type = typeof vals.type === "number" ? vals.type : EQ_TYPE_SHELVING;
    const unused = { tag: ctx.m.dynTuning.eq.unusedByType, locked: true };
    if (type !== EQ_TYPE_PEAKING) out.set("q", unused);
    if (type === EQ_TYPE_PASS) out.set("gain", unused);
    if (vals.oneKnobOn === true) {
      // Reserved and disabled: `visibility` already takes the row out of the tab order,
      // and disabling its control means a stray programmatic focus cannot write either.
      // The tags above are kept rather than dropped — invisible, but a tag pill makes a
      // row taller, so keeping them is what makes a reserved row exactly as tall as the
      // row it stands in for (measured: dropping them lost 3 px over the five).
      for (const k of band) out.set(k, { ...out.get(k), locked: true, cls: "gt-reserved" });
    }
    return out.size ? out : null;
  },

  // `inspector.dyn` cannot name these: it has no freq/q at all, and its `gain` is COMP's
  // makeup gain rather than a band's.
  fieldLabel: (f, m) => ({ freq: m.inspector.frequency, q: m.inspector.q, gain: m.inspector.eqGain })[f.key as string],

  // A band value binds to THAT band, not to whichever the bar has selected — a
  // mapping has to keep working with this screen closed, and the bar resets to LOW
  // on every open. The 1-knob is the processor's own, so it takes the bare `eq`
  // scope; the two enum selectors have no control.
  controlId: (ctx, key) => {
    if (key === "type" || key === "oneKnobType") return null;
    if (key === "oneKnobOn") return controlId(ctx.nodeId, "oneKnob", EQ_SCOPE);
    if (key === "oneKnobLevel") return controlId(ctx.nodeId, "oneKnobLevel", EQ_SCOPE);
    const param = key === "on" ? "bandOn" : (key as ControlParam);
    return controlId(ctx.nodeId, param, eqBandScope(ctx.sel));
  },

  // The 1-knob is a stage of its own, above the band's parameters: it decides whether
  // the band rows below are the operator's or the device's.
  sections: ({ m, vals, states, set, setValue, midi }) => {
    const on = vals.oneKnobOn === true;
    const rateLocked = states.has("oneKnobOn");
    const sec = settingsSection(m.inspector.eqOneKnob);
    sec.append(
      midi(
        settingsRow(
          m.inspector.on,
          onOff(on, (v) => set({ oneKnobOn: v })),
          states.get("oneKnobOn"),
        ),
        "oneKnobOn",
      ),
    );
    // Type and Level stay on screen with 1-knob off, locked: the section would
    // otherwise shrink to a single row on every toggle, moving everything under it.
    // The unit swaps the row for the band's filter type instead — this screen has that
    // row of its own in Parameters, so there is nothing to swap for.
    const off = !on || rateLocked;
    sec.append(
      enumRow(
        m.inspector.eqOneKnobType,
        EQ_ONE_KNOB_TYPE_OPTIONS,
        typeof vals.oneKnobType === "number" ? vals.oneKnobType : EQ_ONE_KNOB_TYPE_DEFAULT,
        (v) => set({ oneKnobType: v }),
        off ? { ...states.get("oneKnobType"), locked: true } : {},
      ),
    );
    sec.append(
      midi(
        oneKnobLevelRow({
          label: m.inspector.eqOneKnobLevel,
          value: vals.oneKnobLevel,
          onInput: (v) => setValue({ oneKnobLevel: v }),
          row: off ? { ...states.get("oneKnobLevel"), locked: true } : {},
        }),
        "oneKnobLevel",
      ),
    );
    return [sec];
  },

  // The unit reads a band as Band / Type / Freq / Q / Gain top to bottom, so the two rows
  // that are not sliders lead the sliders rather than following them. Both change which
  // sliders the device reads, so both use `set` (which rebuilds).
  rows: ({ m, vals, states, set, sel, nodeId, plan, midi }) => {
    // With 1-knob on, the rows below are reserved out of sight — and a heading over five
    // rows of empty space reads as a rendering fault, so the space says what owns those
    // values. Absolutely positioned (`.gt-reserved-note`), so it costs no height.
    const tail: HTMLElement[] = [];
    if (vals.oneKnobOn === true && !channelEqUnavailable(nodeId, plan.sampleRate)) {
      const note = el("p", "gt-reserved-note");
      note.textContent = m.dynTuning.eq.oneKnobDrives;
      tail.push(note);
    }
    // The mid bands are fixed peaking, so their row offers that one value, locked —
    // dropping it would make the panel a row shorter on two of the four bands.
    const options = !eqBandHasType(sel)
      ? [{ value: EQ_TYPE_PEAKING, label: "Peaking" }]
      : sel === 0
        ? EQ_TYPE_LOW_OPTIONS
        : EQ_TYPE_HIGH_OPTIONS;
    const type = eqBandHasType(sel) ? (typeof vals.type === "number" ? vals.type : EQ_TYPE_SHELVING) : EQ_TYPE_PEAKING;
    return {
      tail,
      lead: [
        midi(
          settingsRow(
            m.inspector.bandOn,
            onOff(vals.on === true, (v) => set({ on: v })),
            states.get("on"),
          ),
          "on",
        ),
        enumRow(m.inspector.filterType, options, type, (v) => set({ type: v }), states.get("type")),
      ],
    };
  },

  display: splitDisplay,

  plotGeo: (w, h) => freqGeo(w, h),

  drawAxes: (c, g, tok) => drawFreqAxes(c, g, tok),

  drawCurve: (c, g, _v, tok, ctx) => {
    // Above 96 kHz a stereo channel's EQ is acoustically bypassed (measured), so the
    // response it would have is drawn sunk rather than left looking effective.
    const inert = channelEqUnavailable(ctx.nodeId, ctx.plan.sampleRate);
    // -1 = no band selected, so no handle is drawn as the active one.
    drawResponse(c, g, tok, allBands(ctx), oneKnobOn(ctx) ? -1 : ctx.sel, inert);
  },
};

/** The composite response, and one marker per band. */
function drawResponse(
  c: CanvasRenderingContext2D,
  g: DynPlotGeo,
  tok: Record<string, string>,
  bands: EqBandState[],
  sel: number,
  inert: boolean,
): void {
  const resp = eqResponse(bands);
  c.save();
  if (inert) c.globalAlpha = 0.3;
  drawFreqCurve(c, g, tok, resp);
  c.restore();
  drawBandMarkers(
    c,
    g,
    tok,
    bands.map((b) => ({
      label: MARKER_LABELS[b.index],
      hz: b.freq,
      db: resp(b.freq),
      on: b.on,
      active: b.index === sel,
    })),
    inert,
  );
}

/** Marker letters: LOW / LOW-MID / HIGH-MID / HIGH, initials only — the band's full
 *  name is already on the Parameters heading beside it. */
const MARKER_LABELS = ["L", "LM", "HM", "H"];
