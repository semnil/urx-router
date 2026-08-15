// The SSMCS (Sweet Spot Morphing Channel Strip) for the channel tuning screen: the bank
// a MONO IN channel's COMP/EQ type switches to in place of the compressor and the 4-band
// PEQ. Three faces of ONE processor, moved between from the title row without closing —
// turning Morphing, reading the reduction, touching Mid and going back to Comp Drive is
// one piece of work on one channel, and the three faces' address sets are subsets of the
// MAIN one, so moving between them takes no new tap.
//
//   MAIN  the morphing controls, over the compressor's transfer curve and the EQ's
//         response side by side — one knob moves both, so both have to be on screen
//   COMP  the compressor: its own eight rows, its lane rack and its transfer curve
//   EQ    the 3-band EQ: a band cursor, the response and the two taps that bracket it
//
// Why the plan's own SSMCS sliders in the inspector are not enough, and why the rows here
// are never locked while Morphing runs, are in docs/{en,ja}/channel-tuning.md.
//
// Two device facts shape the drawing:
//   - the internal stage taps are the ones already in the meter table: 108 into the
//     compressor, 110 its reduction, 111 between the compressor and the EQ, 112 after
//     the EQ. 111 is a live tap in this mode, not a dead one;
//   - the compressor's knee is ASYMMETRIC, and its EQ's peaking Q is not the 4-band's,
//     so neither block's constants may be carried across. The numbers are below and in
//     eq-response.ts.

import { COMP_KNEE_DEFAULT, COMP_KNEE_OPTIONS, SWEET_SPOT_DATA_OPTIONS } from "../core/control/params";
import { COMP_EQ_COMP_FIRST } from "../core/control/params";
import {
  channelDynamics,
  isSsmcsScKey,
  ssmcsCompFields,
  ssmcsEqBandFields,
  ssmcsEqBandHasQ,
  ssmcsMainFields,
  ssmcsPlanKey,
  SSMCS_EQ_BAND_NAMES,
} from "../core/control/translate";
import type { DynField, SsmcsEqBandName } from "../core/control/translate";
import {
  ssmcsAttackMs,
  ssmcsCompDrive,
  ssmcsFreqHz,
  ssmcsGainDb,
  ssmcsQ,
  ssmcsRatio,
  ssmcsReleaseMs,
} from "../core/control/vd";
import { ssmcsEqResponse } from "../core/eq-response";
import type { SsmcsBandState } from "../core/eq-response";
import { tapFor } from "../core/meters";
import {
  controlId,
  ssmcsControlParam,
  ssmcsEqBandScope,
  SSMCS_COMP_SCOPE,
  SSMCS_SCOPE,
  SSMCS_SC_SCOPE,
} from "../core/midi/controls";
import type { ControlParam } from "../core/midi/controls";
import { SSMCS_INITIAL } from "../core/plan";
import type { NodeParams, SsmcsBand, SsmcsParams } from "../core/plan";
import { onOff, settingsChoice, settingsRow } from "./dom";
import { bindChannelStrip, displayBar, enumRow } from "./dyn-chan";
import { drawBandMarkers, drawFreqAxes, drawFreqCurve, FREQ_PAD, freqGeo } from "./dyn-freq-plot";
import { fmtSsmcsGain, fmtSsmcsHz, fmtSsmcsMs, fmtSsmcsQ, fmtSsmcsRatio } from "./inspector-format";
import { CURVE_PAD, dbGeo, drawDbAxes, drawLiveDot, transferPlot } from "./dyn-plot";
import { HI_DB, PLOT_FONT, splitDisplay } from "./dyn-screen";
import type { DynCtx, DynFace, DynLane, DynPlotGeo, DynProcessor } from "./dyn-screen";
import type { Messages } from "../i18n/en";

/** Level-lane ruler. The stages this bank sits between carry programme level and it
 *  offers no value in dBFS to drag on a meter, so the ruler is the range a mix is read
 *  in rather than a threshold's domain — the same choice the 4-band EQ screen makes. */
const LO_DB = -60;
const TICK_STEP = 6;

/** Transfer-plot axes. Input is the compressor's own working range; output runs above it,
 *  because the drive's gain and the makeup both add. */
const IN_LO_DB = -54;
const OUT_LO_DB = -54;
const OUT_TICKS = [18, 6, -6, -18, -30, -42, -54];

/** The gap between MAIN's two plots, wide enough for the divider between them. */
const MAIN_GAP = 10;

// ---------------------------------------------------------------- the strip's values

/** Every value the three faces read, with the factory capture standing in for anything
 *  the plan has not set. One function, so a curve and the sliders beside it cannot
 *  disagree about what "not read from the device yet" means. */
interface StripValues {
  sweetSpotData: number;
  compDrive: number;
  morphing: number;
  outGain: number;
  comp: { attack: number; release: number; ratio: number; knee: number; threshold: number; makeup: number };
  sc: { on: boolean; q: number; freq: number; gain: number };
  eq: Record<SsmcsEqBandName, { on: boolean; q: number; freq: number; gain: number }>;
}

const ssmcsOf = (ctx: DynCtx): SsmcsParams => ctx.plan.nodeParams[ctx.nodeId]?.ssmcs ?? {};

function stripOf(ctx: DynCtx): StripValues {
  const s = ssmcsOf(ctx);
  const c = s.comp ?? {};
  const sc = s.sc ?? {};
  const ci = SSMCS_INITIAL.comp;
  const si = SSMCS_INITIAL.sc;
  const band = (name: SsmcsEqBandName): StripValues["eq"][SsmcsEqBandName] => {
    const b: SsmcsBand = s.eq?.[name] ?? {};
    const init = SSMCS_INITIAL.eq[name];
    return {
      on: b.on ?? init.on,
      // The two shelves have no Q parameter; the row that shows one is locked, and the
      // response ignores it. MID's factory Q is what stands in it, so the locked row
      // reads as a value rather than as a zero.
      q: b.q ?? SSMCS_INITIAL.eq.mid.q,
      freq: b.freq ?? init.freq,
      gain: b.gain ?? init.gain,
    };
  };
  return {
    sweetSpotData: s.sweetSpotData ?? SSMCS_INITIAL.sweetSpotData,
    compDrive: s.compDrive ?? SSMCS_INITIAL.compDrive,
    morphing: s.morphing ?? SSMCS_INITIAL.morphing,
    outGain: s.outGain ?? SSMCS_INITIAL.outGain,
    comp: {
      attack: c.attack ?? ci.attack,
      release: c.release ?? ci.release,
      ratio: c.ratio ?? ci.ratio,
      knee: c.knee ?? ci.knee,
      threshold: c.threshold ?? ci.threshold,
      makeup: c.makeup ?? ci.makeup,
    },
    sc: { on: sc.on ?? si.on, q: sc.q ?? si.q, freq: sc.freq ?? si.freq, gain: sc.gain ?? si.gain },
    eq: { low: band("low"), mid: band("mid"), high: band("high") },
  };
}

/** Whether this node is a MONO IN channel running the morphing strip. `channelDynamics`
 *  answers it: it resolves to null off a mic strip, and its COMP fields are null exactly
 *  when SSMCS has replaced the compressor — the same question the COMP screen asks in
 *  the other direction, so the two can never both open on one channel. */
function inSsmcsMode(ctx: DynCtx): boolean {
  const type = ctx.plan.nodeParams[ctx.nodeId]?.compEqType ?? COMP_EQ_COMP_FIRST;
  const dyn = channelDynamics(ctx.model, ctx.nodeId, type);
  return dyn !== null && dyn.comp === null;
}

// ---------------------------------------------------------------- the compressor's curve

/**
 * How far the knee reaches above and below the threshold, by knee setting (0 Soft /
 * 1 Medium / 2 Hard). It is NOT symmetric, so the shipped `KNEE_WIDTH_DB` in dyn-comp.ts
 * — one width per setting — cannot express this one and must not be reused here. The
 * other bank's constants are its own for the same reason: they are different DSP.
 *
 * What stays an assumption is the shape BETWEEN the edges, which takes the cubic below;
 * the shipped COMP curve carries the same kind of assumption, and why neither curve is
 * drawn in a line style that would claim otherwise.
 */
const KNEE_REACH_DB: readonly (readonly [number, number])[] = [
  [17.0, 11.0],
  [5.4, 2.6],
  [0, 0],
];

const kneeReach = (knee: number): readonly [number, number] => KNEE_REACH_DB[knee] ?? KNEE_REACH_DB[COMP_KNEE_DEFAULT];

/**
 * The compressor's response as a function of input level, and the gain it carries there.
 *
 * The threshold is an internal value the unit never shows, driven by Comp Drive, and the
 * drive also adds gain of its own — so turning that one knob moves the corner AND lifts
 * the output, which is what the operator sees on the OUT lane.
 * A drive of zero is not a threshold pushed out of range: it disables the compressor.
 *
 * Built once per redraw rather than read per sample point: the curve evaluates it ~120
 * times, and each read walks the plan.
 */
function transferOf(v: StripValues): { out: (inDb: number) => number; gain: (inDb: number) => number } {
  const drive = v.compDrive;
  const thr = v.comp.threshold / 5 - 44 - 0.21 * (drive - 100);
  const ratio = Math.max(1, ssmcsRatio(v.comp.ratio));
  const driveGain = drive * 0.04;
  const makeup = (v.comp.makeup - 100) * 0.06;
  const [up, down] = kneeReach(v.comp.knee);
  // The knee's two edges, which do not straddle the threshold evenly: below it the curve
  // is still unity, above it the asymptote.
  const lo = thr - down;
  const hi = thr + up;
  const width = hi - lo;
  const hiOut = thr + up / ratio;
  const inKnee = (inDb: number): boolean => width > 0 && inDb > lo && inDb < hi;
  // How far through the knee an input is.
  const frac = (inDb: number): number => (inDb - lo) / width;
  // One output gain over the whole curve, as the shipped COMP screen applies its makeup.
  // The measurement behind the makeup term is what the unit does WHILE COMPRESSING: five
  // raw points, linear, `110` unmoved. What the same run reports below the threshold is a
  // null result at one threshold setting, which does not separate "the makeup is off here"
  // from "the block was not engaged here" — and the two readings cannot both shape the
  // curve, since a gain present on one leg and absent on the other is a step at the corner
  // whatever is drawn between the edges, and 0 dB wide on Hard means there is nothing to
  // draw it across. What would settle it: walk the input across the corner and read
  // `111 - 108` on both sides of it.
  const gain = (): number => (drive === 0 ? 0 : driveGain + makeup);
  /**
   * Between the edges: a cubic through both, carrying the slope each side already has —
   * 1 below, 1/ratio above — with the two slopes limited to the cubic's monotone region
   * first.
   *
   * Both halves are load-bearing. A quadratic cannot do it at all: its endpoint is fixed
   * by its two slopes, so for an ASYMMETRIC knee it lands (1 - 1/ratio)(up - down)/2 away
   * from the asymptote — 0.84 dB at the factory settings, which the curve drew as a
   * vertical step at the upper edge. (The shipped COMP screen's quadratic is not wrong for
   * the same reason: that block's knee is one symmetric width, where the two agree.) And
   * an unlimited cubic overshoots: a Medium knee at infinite ratio leaves the 1:1 leg's
   * slope 3.08x the secant through the knee, past the 3 the monotone region allows, and
   * the curve then rises above the plateau and comes back down — an input increase drawn
   * as an output decrease. Limiting scales both slopes by 3/hypot, which is 1 wherever the
   * pair is already inside the region, so the join stays exact everywhere it can.
   */
  const secant = width > 0 ? (hiOut - lo) / width : 1;
  const reach = secant > 0 ? Math.hypot(1 / secant, 1 / ratio / secant) : Number.POSITIVE_INFINITY;
  const limit = reach > 3 ? 3 / reach : 1;
  const knee = (inDb: number): number => {
    const t = frac(inDb);
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * lo +
      (t3 - 2 * t2 + t) * width * limit +
      (-2 * t3 + 3 * t2) * hiOut +
      (t3 - t2) * width * (limit / ratio)
    );
  };
  const out = (inDb: number): number => {
    if (drive === 0) return inDb;
    if (inKnee(inDb)) return knee(inDb) + gain();
    return (inDb <= lo ? inDb : thr + (inDb - thr) / ratio) + gain();
  };
  return { out, gain: () => gain() };
}

/** The transfer curve plus the reduction it buys at full scale — the same drawing and the
 *  same annotation the shipped COMP screen makes, with this bank's own model behind it. */
function drawTransfer(c: CanvasRenderingContext2D, g: DynPlotGeo, tok: Record<string, string>, v: StripValues): void {
  const { out, gain } = transferOf(v);
  c.strokeStyle = tok["--led"];
  c.lineWidth = 2;
  c.beginPath();
  for (let i = 0; i <= 120; i++) {
    const x = IN_LO_DB + ((HI_DB - IN_LO_DB) * i) / 120;
    if (i) c.lineTo(g.px(x), g.py(out(x)));
    else c.moveTo(g.px(x), g.py(out(x)));
  }
  c.stroke();

  // The gap between the curve and unity at 0 dBFS with the gain terms taken back out —
  // read off the curve rather than off the asymptote, so a knee wide enough to still be
  // open at full scale is labelled with what it actually does there.
  const top = out(HI_DB) - gain(HI_DB);
  if (top >= -0.05) return;
  c.strokeStyle = tok["--gr"];
  c.setLineDash([3, 3]);
  c.beginPath();
  c.moveTo(g.px(HI_DB) - 1, g.py(HI_DB));
  c.lineTo(g.px(HI_DB) - 1, g.py(top));
  c.stroke();
  c.setLineDash([]);
  c.fillStyle = tok["--gr"];
  c.textAlign = "right";
  // Inset from the axis so the label does not sit on the frame.
  c.fillText(`${top.toFixed(1)} dB`, g.px(HI_DB) - 22, g.py((HI_DB + top) / 2) + 3);
}

// ---------------------------------------------------------------- the EQ's response

const MARKER_LABELS: Record<SsmcsEqBandName, string> = { low: "L", mid: "M", high: "H" };

/** The three bands as the response model takes them: plan raw → Hz / Q / dB. */
const bandStates = (v: StripValues): SsmcsBandState[] =>
  SSMCS_EQ_BAND_NAMES.map((kind) => ({
    kind,
    on: v.eq[kind].on,
    freq: ssmcsFreqHz(v.eq[kind].freq),
    q: ssmcsQ(v.eq[kind].q),
    gain: ssmcsGainDb(v.eq[kind].gain),
  }));

/** The composite response and one marker per band. A marker sits at the COMPOSITE value,
 *  so a band switched off keeps its marker at its own frequency on the line the operator
 *  is reading — which is what shows "still selected, no longer contributing". */
function drawEqResponse(
  c: CanvasRenderingContext2D,
  g: DynPlotGeo,
  tok: Record<string, string>,
  v: StripValues,
  sel: SsmcsEqBandName | null,
  x0 = 0,
): void {
  const bands = bandStates(v);
  const resp = ssmcsEqResponse(bands);
  drawFreqCurve(c, g, tok, resp, x0);
  drawBandMarkers(
    c,
    g,
    tok,
    bands.map((b) => ({
      label: MARKER_LABELS[b.kind],
      hz: b.freq,
      db: resp(b.freq),
      on: b.on,
      active: b.kind === sel,
    })),
  );
}

// ---------------------------------------------------------------- shared descriptor parts

/** One title for all three faces. Naming each face instead would print `[CH 1] Comp` and
 *  `[CH 1] EQ` — the shipped COMP and EQ screens' titles exactly, with nothing left to
 *  say which of the channel's two banks is on screen. */
const title = (m: Messages): string => m.inspector.ssmcs.title;

/** The three faces, named once. A thunk because they name each other. */
const FACES = (): readonly DynFace[] => [
  { proc: SSMCS_DYN, label: (m) => m.dynTuning.ssmcs.faceMain, id: "dyn-face-ssmcs-main" },
  { proc: SSMCS_COMP_DYN, label: (m) => m.dynTuning.ssmcs.faceComp, id: "dyn-face-ssmcs-comp" },
  { proc: SSMCS_EQ_DYN, label: (m) => m.dynTuning.ssmcs.faceEq, id: "dyn-face-ssmcs-eq" },
];

/** Raw → the text the unit prints for it. Every SSMCS value is a broker integer whose
 *  display goes through a device curve; Morphing is the one that is its own display, and
 *  falls through to the field's `raw` unit. */
function ssmcsFieldText(f: DynField, v: number): string | undefined {
  switch (f.key) {
    case "compDrive":
      return ssmcsCompDrive(v).toFixed(2);
    case "outGain":
    case "scGain":
    case "gain":
      return fmtSsmcsGain(v);
    case "attack":
      return fmtSsmcsMs(ssmcsAttackMs(v));
    case "release":
      return fmtSsmcsMs(ssmcsReleaseMs(v));
    case "ratio":
      return fmtSsmcsRatio(ssmcsRatio(v));
    case "scQ":
    case "q":
      return fmtSsmcsQ(v);
    case "scFreq":
    case "freq":
      return fmtSsmcsHz(v);
    default:
      return undefined;
  }
}

/** The three taps a lane can carry beyond the ones `bindChannelStrip` names. */
const strippedLane = (ctx: DynCtx, key: string, label: string, tapKey: string): DynLane => ({
  key,
  label,
  kind: "level",
  tap: tapFor(ctx.nodeId, tapKey, ctx.model.id) ?? null,
});

// ---------------------------------------------------------------- MAIN

/** MAIN's canvas carries two plots. Each half's own coordinates come from the same
 *  width, so the two are built here and nowhere else. */
function mainHalves(w: number, h: number): { half: number; left: DynPlotGeo; right: DynPlotGeo } {
  const half = (w - MAIN_GAP) / 2;
  return {
    half,
    left: dbGeo(half, h, IN_LO_DB, OUT_LO_DB, OUT_TICKS),
    right: freqGeo(half, h, half + MAIN_GAP),
  };
}

export const SSMCS_DYN: DynProcessor = {
  key: "ssmcs",
  loDb: LO_DB,
  tickStep: TICK_STEP,
  title,
  faces: FACES,

  // Four lanes, which is one more than the strip's own stages: the compressor's output
  // (111) is what the transfer curve's dot has to point at — using the EQ's output would
  // put the EQ's own gain on the compressor's curve — and the strip's output (112) is
  // what the readouts need to show what the bank did end to end.
  bind: (ctx) => {
    const bound = bindChannelStrip(ctx, {
      fields: (dyn) => (dyn.comp ? null : ssmcsMainFields()),
      grKind: "comp",
      inTapKey: "precomp",
      outTapKey: "preeq",
      // No fader cap: this bank's corner is driven by an internal value, so there is no
      // editable value in the meter's own dBFS to put on it.
      cap: null,
      grFullDb: 24,
      extraLanes: [strippedLane(ctx, "post", ctx.m.dynTuning.ssmcs.tapOut, "preinsfx")],
    });
    // Four tiles, so two columns — the same arrangement the DUCKER's four take.
    return bound && { ...bound, readoutCols: 2 };
  },

  hint: (ctx) => ctx.m.dynTuning.ssmcs.mainHint,
  read: (ctx) => {
    const v = stripOf(ctx);
    return { sweetSpotData: v.sweetSpotData, compDrive: v.compDrive, morphing: v.morphing, outGain: v.outGain };
  },
  patch: (ctx, patch) => ({ ssmcs: { ...ssmcsOf(ctx), ...patch } }) as NodeParams,
  fieldLabel: (f, m) =>
    ({
      compDrive: m.inspector.ssmcs.compDrive,
      morphing: m.inspector.ssmcs.morphing,
      outGain: m.inspector.ssmcs.outGain,
    })[f.key as string],
  fieldText: ssmcsFieldText,
  // The preset is an enum selector, which the catalog does not carry: a control that
  // answers null neither rings nor arms.
  controlId: (ctx, key) => (key === "sweetSpotData" ? null : controlId(ctx.nodeId, key as ControlParam, SSMCS_SCOPE)),

  rows: ({ m, vals, set }) => ({
    lead: [
      enumRow(
        m.inspector.ssmcs.sweetSpotData,
        SWEET_SPOT_DATA_OPTIONS,
        typeof vals.sweetSpotData === "number" ? vals.sweetSpotData : SSMCS_INITIAL.sweetSpotData,
        (v) => set({ sweetSpotData: v }),
      ),
    ],
  }),

  // The lane rack is deliberately absent: two plots and a rack in one column leave each
  // plot too narrow to read a bell in, and the lanes are still subscribed and still
  // printed as readouts without one — the host builds lane elements only when a
  // descriptor asks for them.
  display: (parts) => parts.plot(),

  // The geo the host is handed is the PAIR's bounding box, so its clip covers both
  // plots; its px/py are the left half's, which is where the live dot goes.
  plotGeo: (w, h) => {
    const { left } = mainHalves(w, h);
    return {
      ...left,
      w,
      pad: {
        l: CURVE_PAD.l,
        r: FREQ_PAD.r,
        t: Math.min(CURVE_PAD.t, FREQ_PAD.t),
        b: Math.min(CURVE_PAD.b, FREQ_PAD.b),
      },
    };
  },

  drawAxes: (c, g, tok) => {
    const { half, left, right } = mainHalves(g.w, g.h);
    drawDbAxes(c, left, tok, { loDb: IN_LO_DB, outTicks: OUT_TICKS });
    drawFreqAxes(c, right, tok, half + MAIN_GAP);
    // The divider, and which half is which.
    c.strokeStyle = tok["--plot-line"];
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(half + MAIN_GAP / 2, 8);
    c.lineTo(half + MAIN_GAP / 2, g.h - 8);
    c.stroke();
    c.font = PLOT_FONT;
    c.fillStyle = tok["--plot-dim"];
    c.textAlign = "left";
    c.fillText("COMP", CURVE_PAD.l, 11);
    c.fillText("EQ", half + MAIN_GAP + FREQ_PAD.l, 11);
  },

  drawCurve: (c, g, _v, tok, ctx) => {
    const { half, left, right } = mainHalves(g.w, g.h);
    const v = stripOf(ctx);
    // Each half clips itself: the host's clip is the pair's bounding box, so without
    // this a curve would run through the gutter the other half's tick labels sit in.
    const inHalf = (geo: DynPlotGeo, x0: number, draw: () => void): void => {
      c.save();
      c.beginPath();
      c.rect(x0 + geo.pad.l, geo.pad.t, geo.w - geo.pad.l - geo.pad.r, geo.h - geo.pad.t - geo.pad.b);
      c.clip();
      draw();
      c.restore();
    };
    inHalf(left, 0, () => drawTransfer(c, left, tok, v));
    // No band is selected on this face — Morphing moves all three, and none of them is
    // being edited here — but their positions still have to be visible, since it moves
    // their frequencies too.
    inHalf(right, half + MAIN_GAP, () => drawEqResponse(c, right, tok, v, null, half + MAIN_GAP));
  },

  drawLive: (c, g, read, tok) => drawLiveDot(c, g, read("in"), read("out"), tok, { in: IN_LO_DB, out: OUT_LO_DB }),
};

// ---------------------------------------------------------------- COMP

export const SSMCS_COMP_DYN: DynProcessor = {
  key: "ssmcsComp",
  loDb: LO_DB,
  tickStep: TICK_STEP,
  title,
  faces: FACES,
  bind: (ctx) =>
    bindChannelStrip(ctx, {
      fields: (dyn) => (dyn.comp ? null : ssmcsCompFields()),
      grKind: "comp",
      inTapKey: "precomp",
      outTapKey: "preeq",
      cap: null,
      grFullDb: 24,
    }),
  bar: displayBar,
  // Which of the two ways you read a compressor is a lasting preference, so it persists —
  // the same judgement, and the same bar, as the shipped COMP screen.
  persistSel: true,
  ...transferPlot({ loDb: IN_LO_DB, outLoDb: OUT_LO_DB, outTicks: OUT_TICKS, hint: (m) => m.dynTuning.comp.curveHint }),

  read: (ctx) => {
    const v = stripOf(ctx);
    return { ...v.comp, scOn: v.sc.on, scQ: v.sc.q, scFreq: v.sc.freq, scGain: v.sc.gain };
  },
  // The compressor and its side-chain filter are two sub-objects, so the flat record the
  // rows edit is split back apart by the prefix that kept them apart — through the same
  // translation the catalog uses, not a second spelling of it.
  patch: (ctx, patch) => {
    const s = ssmcsOf(ctx);
    const comp: Record<string, number> = { ...(s.comp ?? {}) };
    const sc: Record<string, number | boolean> = { ...(s.sc ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (k === "scOn") sc.on = v === true;
      else if (isSsmcsScKey(k)) sc[ssmcsPlanKey(k)] = Number(v);
      else comp[k] = Number(v);
    }
    return { ssmcs: { ...s, comp, sc } } as NodeParams;
  },

  fieldLabel: (f, m) =>
    ({ scQ: m.inspector.q, scFreq: m.inspector.frequency, scGain: m.inspector.eqGain })[f.key as string],
  fieldText: ssmcsFieldText,
  // Attack / Release / Ratio belong to the compressor, the three prefixed ones to the
  // filter, and the knee is an enum the catalog does not carry.
  controlId: (ctx, key) => {
    if (key === "knee") return null;
    const sc = isSsmcsScKey(key);
    const param = key === "scOn" ? "sideChain" : ssmcsControlParam(key);
    return controlId(ctx.nodeId, param, sc ? SSMCS_SC_SCOPE : SSMCS_COMP_SCOPE);
  },

  // Knee closes the compressor's rows and Side Chain opens the filter's, so both sit
  // between Ratio and the filter's first slider rather than above everything.
  rows: ({ m, vals, set, midi }) => ({
    before: {
      scQ: [
        settingsRow(
          m.inspector.dyn.knee,
          settingsChoice(
            COMP_KNEE_OPTIONS.map((o) => o.label),
            typeof vals.knee === "number" ? vals.knee : COMP_KNEE_DEFAULT,
            (i) => set({ knee: COMP_KNEE_OPTIONS[i].value }),
          ),
        ),
        midi(
          settingsRow(
            m.inspector.ssmcs.sideChain,
            onOff(vals.scOn === true, (on) => set({ scOn: on })),
          ),
          "scOn",
        ),
      ],
    },
  }),

  drawCurve: (c, g, _v, tok, ctx) => drawTransfer(c, g, tok, stripOf(ctx)),
};

// ---------------------------------------------------------------- EQ

const bandOf = (ctx: DynCtx): SsmcsEqBandName => SSMCS_EQ_BAND_NAMES[ctx.sel] ?? SSMCS_EQ_BAND_NAMES[0];

export const SSMCS_EQ_DYN: DynProcessor = {
  key: "ssmcsEq",
  loDb: LO_DB,
  tickStep: TICK_STEP,
  title,
  faces: FACES,

  bind: (ctx) => {
    if (!inSsmcsMode(ctx)) return null;
    return {
      fields: ssmcsEqBandFields(bandOf(ctx)),
      lanes: [
        strippedLane(ctx, "in", ctx.m.dynTuning.comp.tapOut, "preeq"),
        strippedLane(ctx, "out", ctx.m.dynTuning.ssmcs.tapOut, "preinsfx"),
      ],
    };
  },

  // The bar is a cursor into the parameters rather than a way of reading the processor,
  // so it resets to LOW per open — the 4-band screen's judgement, and its band bar.
  bar: (ctx) => ({
    label: ctx.m.dynTuning.eq.band,
    items: SSMCS_EQ_BAND_NAMES.map((b) => ({ label: ctx.m.inspector.ssmcs.bands[b], id: `dyn-ssmcs-band-${b}` })),
  }),
  paramsTag: (ctx) => ({ text: ctx.m.inspector.ssmcs.bands[bandOf(ctx)], shown: true }),
  hint: (ctx) => ctx.m.dynTuning.eq.plotHint,

  read: (ctx) => stripOf(ctx).eq[bandOf(ctx)],
  patch: (ctx, patch) => {
    const s = ssmcsOf(ctx);
    const band = bandOf(ctx);
    const eq = s.eq ?? {};
    const next: SsmcsBand = { ...(eq[band] ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (k === "on") next.on = v === true;
      else next[k as "q" | "freq" | "gain"] = Number(v);
    }
    return { ssmcs: { ...s, eq: { ...eq, [band]: next } } } as NodeParams;
  },

  // There is no filter-type row: all three bands are fixed, so a row offering one value
  // would be a locked row on every band — which is not what the 4-band screen keeps its
  // Type row for (there, two of four bands are typed and dropping it would change the
  // panel's height per band).
  rowStates: (ctx) =>
    ssmcsEqBandHasQ(bandOf(ctx)) ? null : new Map([["q", { tag: ctx.m.dynTuning.eq.unusedByType, locked: true }]]),

  fieldLabel: (f, m) => ({ freq: m.inspector.frequency, q: m.inspector.q, gain: m.inspector.eqGain })[f.key as string],
  fieldText: ssmcsFieldText,
  // A band value binds to THAT band, not to whichever the bar has selected: a mapping
  // has to keep working with this screen closed, and the bar resets on every open.
  controlId: (ctx, key) => {
    const band = bandOf(ctx);
    if (key === "q" && !ssmcsEqBandHasQ(band)) return null;
    return controlId(ctx.nodeId, key === "on" ? "bandOn" : (key as ControlParam), ssmcsEqBandScope(band));
  },

  rows: ({ m, vals, set, midi }) => ({
    lead: [
      midi(
        settingsRow(
          m.inspector.bandOn,
          onOff(vals.on === true, (v) => set({ on: v })),
        ),
        "on",
      ),
    ],
  }),

  display: splitDisplay,
  plotGeo: (w, h) => freqGeo(w, h),
  drawAxes: (c, g, tok) => drawFreqAxes(c, g, tok),
  drawCurve: (c, g, _v, tok, ctx) => drawEqResponse(c, g, tok, stripOf(ctx), bandOf(ctx)),
};
