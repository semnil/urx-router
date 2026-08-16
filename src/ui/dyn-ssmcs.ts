// The SSMCS (Sweet Spot Morphing Channel Strip) for the channel tuning screen: the bank
// a MONO IN channel's COMP/EQ type switches to in place of the compressor and the 4-band
// PEQ. Three faces of ONE processor, moved between from the bar over the display without
// closing — turning Morphing, reading the reduction, touching Mid and going back to Comp
// Drive is one piece of work on one channel, and the three faces' address sets are subsets
// of the MAIN one, so moving between them takes no new tap.
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
import { ssmcsEqResponse, ssmcsScResponse } from "../core/eq-response";
import type { SsmcsBandState, SsmcsScState } from "../core/eq-response";
import { sidechainTap, tapFor } from "../core/meters";
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
import { bindChannelStrip, enumRow } from "./dyn-chan";
import {
  bandMarkers,
  drawBandMarkers,
  drawFreqAxes,
  drawFreqCurve,
  FREQ_PAD,
  freqGeo,
  pickBandMarker,
} from "./dyn-freq-plot";
import type { BandMarker } from "./dyn-freq-plot";
import { fmtSsmcsGain, fmtSsmcsHz, fmtSsmcsMs, fmtSsmcsQ, fmtSsmcsRatio } from "./inspector-format";
import { CURVE_PAD, dbGeo, drawDbAxes, drawLiveDot, drawTransferCurve, transferPlot } from "./dyn-plot";
import { PLOT_FONT, splitDisplay } from "./dyn-screen";
import type { DynBar, DynCtx, DynLane, DynPlotGeo, DynProcessor } from "./dyn-screen";
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
 * Where the corner stops, in the input meter's own dBFS.
 *
 * Measured on a URX44V (2026-08-15) with ratio at infinity and a hard knee, reading the
 * corner as `108` - |`110`|. Both parameters that move it are 0.2 dB per raw and they pull
 * against each other, so `0.2 * (threshold - drive) - 20` lands on every unclamped point
 * of two runs — threshold raws 50…175 at drive 200, and drives 100…160 at threshold raw 0
 * — within 0.1 dB.
 *
 * The floor is separated from a REDUCTION ceiling, which the same readings would also fit
 * while the input sat still: driving the input to -18 / -25 / -30 / -35 dBFS with the
 * corner asked for -60 gave 36 / 29 / 24 / 19 dB of reduction, which is a corner holding
 * at -54 and not a reduction saturating at 34. The earlier runs had both read -20 dBFS,
 * the one level where the two laws agree.
 */
const CORNER_FLOOR_DB = -54;

/** The makeup's own range, and the ceiling on what it returns. At its maximum it lifts
 *  the corner to 0 dBFS — so it is a FRACTION of the corner's depth, not a number of dB —
 *  and it stops at MAKEUP_MAX_DB. Measured over 22 points in three runs: raw 0 gives
 *  exactly 0 dB at two different corners, which is also what rules out a gain belonging to
 *  Comp Drive itself (what looked like one was this term following the corner as the drive
 *  moved it). */
const MAKEUP_RAW_MAX = 200;
const MAKEUP_MAX_DB = 24;

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
function transferOf(v: StripValues): { out: (inDb: number) => number; gainDb: number } {
  const drive = v.compDrive;
  // The corner, on the input meter's own dBFS. The threshold parameter raises it and Comp
  // Drive lowers it, both at 0.2 dB per raw, and it stops at CORNER_FLOOR_DB.
  const thr = Math.max(CORNER_FLOOR_DB, 0.2 * (v.comp.threshold - drive) - 20);
  const ratio = Math.max(1, ssmcsRatio(v.comp.ratio));
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
  // The makeup returns a FRACTION of the corner's own depth rather than a fixed number of
  // dB: at its maximum it lifts the corner to 0 dBFS, capped at MAKEUP_MAX_DB. Which is
  // why it has to be computed from `thr` and cannot be a term added beside it.
  // Out Gain is the strip's output gain, and the unit applies it at the far end — after
  // the EQ, measured (`117` moves tap `112` one-for-one and leaves `108` and `111` alone,
  // URX44V 2026-08-15). It is drawn HERE anyway, on the compressor's baseline, and the
  // reason is the other plot: the EQ's gain axis IS the band gain range, so an offset of
  // up to 18 dB pushes that response off the frame and takes the shape with it. This axis
  // has the room — its output already runs to +18 because the drive and the makeup add —
  // and a strip output gain reads as a lifted baseline, which is where it lands.
  // It survives a drive of zero, which disables the compressor and nothing else.
  const outDb = ssmcsGainDb(v.outGain);
  const makeupDb = Math.min(MAKEUP_MAX_DB, -thr * (v.comp.makeup / MAKEUP_RAW_MAX));
  const gainDb = (drive === 0 ? 0 : makeupDb) + outDb;
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
    if (inKnee(inDb)) return knee(inDb) + gainDb;
    return (inDb <= lo ? inDb : thr + (inDb - thr) / ratio) + gainDb;
  };
  return { out, gainDb };
}

/** The transfer curve and its reduction annotation, from this bank’s own model. The
 *  drawing itself is shared with the COMP→EQ bank (`drawTransferCurve`): only the response
 *  differs, and the two would otherwise drift apart the way their annotations already had. */
function drawTransfer(c: CanvasRenderingContext2D, g: DynPlotGeo, tok: Record<string, string>, v: StripValues): void {
  const { out, gainDb } = transferOf(v);
  drawTransferCurve(c, g, tok, { out, gainDb, loDb: IN_LO_DB });
}

/** The gain the curve carries over its whole length, which the unity reference has to be
 *  lifted by. It does not vary with the input — the makeup and Out Gain are one offset over
 *  the whole curve — so the axes layer reads a number rather than calling the curve. */
const curveGainDb = (v: StripValues): number => transferOf(v).gainDb;

/** The gain that sits between the compressor's two level taps — the makeup alone, since
 *  Out Gain is applied after the EQ and so reaches neither of them (measured: `117` moves
 *  `112` one for one and leaves `108` and `111` where they are). What the reduction lane
 *  is drawn shorter by where it shares a column with `111`. */
const strapGainDb = (v: StripValues): number => curveGainDb(v) - ssmcsGainDb(v.outGain);

/** dB the output READING is lifted by before it is plotted on the transfer curve — the
 *  curve carries Out Gain and the `111` tap it reads is upstream of it. `transferPlot`'s
 *  `outOffsetDb` carries what that costs when it is left out. Both faces that draw this
 *  curve go through here, so their dots cannot sit at different heights. */
const outLiftDb = (ctx: DynCtx): number => ssmcsGainDb(ssmcsOf(ctx).outGain ?? SSMCS_INITIAL.outGain);

/** The transfer plot's axes, on either face that draws that curve. The unity reference
 *  carries the curve's own gain, or the reduction annotation beside it measures from a
 *  line the curve never touches. */
const stripDbAxes = (c: CanvasRenderingContext2D, g: DynPlotGeo, tok: Record<string, string>, ctx: DynCtx): void =>
  drawDbAxes(c, g, tok, { loDb: IN_LO_DB, outTicks: OUT_TICKS, unityOffsetDb: curveGainDb(stripOf(ctx)) });

// ---------------------------------------------------------------- the EQ's response

const MARKER_LABELS: Record<SsmcsEqBandName, string> = { low: "L", mid: "M", high: "H" };

/** The side chain's marker. The unit's own abbreviation for this signal — its COMP and
 *  COMP Side Chain screens label the meter SC — rather than a word invented here. */
const SC_MARKER = "SC";

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
  drawBandMarkers(c, g, tok, bandMarksOf(bands, resp, sel));
}

/** The markers, from the strip's bands and which one is selected. */
function eqBandMarks(v: StripValues, sel: SsmcsEqBandName | null): BandMarker[] {
  const bands = bandStates(v);
  return bandMarksOf(bands, ssmcsEqResponse(bands), sel);
}

const bandMarksOf = (
  bands: readonly SsmcsBandState[],
  resp: (hz: number) => number,
  sel: SsmcsEqBandName | null,
): BandMarker[] => bandMarkers(bands, resp, (b) => ({ label: MARKER_LABELS[b.kind], active: b.kind === sel }));

// ---------------------------------------------------------------- shared descriptor parts

/** One title for all three faces. Naming each face instead would print `[CH 1] Comp` and
 *  `[CH 1] EQ` — the shipped COMP and EQ screens' titles exactly, with nothing left to
 *  say which of the channel's two banks is on screen. */
const title = (m: Messages): string => m.inspector.ssmcs.title;

/**
 * The one bar the whole bank is selected from — four segments over three faces, since the
 * COMP face's two plots answer different questions and are worth naming separately. It is
 * also where the bank's faces are named, once: the host asks which segment reads as pressed
 * from the items themselves.
 *
 * It replaced a face bar in the title row plus a display bar under it. Two segmented rows
 * meant the operator had to know which of them held the thing they were looking for, and
 * the title-row one was the harder to find of the two.
 */
const BANK_BAR = (ctx: DynCtx): DynBar => ({
  label: ctx.m.dynTuning.display,
  items: [
    { label: ctx.m.dynTuning.ssmcs.faceMain, id: "dyn-face-ssmcs-main", face: SSMCS_DYN, sel: 0 },
    { label: ctx.m.dynTuning.ssmcs.faceComp, id: "dyn-face-ssmcs-comp", face: SSMCS_COMP_DYN, sel: 0 },
    { label: ctx.m.inspector.ssmcs.sideChain, id: "dyn-mode-sidechain", face: SSMCS_COMP_DYN, sel: SC_SEL },
    { label: ctx.m.dynTuning.ssmcs.faceEq, id: "dyn-face-ssmcs-eq", face: SSMCS_EQ_DYN, sel: 0 },
  ],
});

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

/** The compressor's key signal — the side-chain filter's output, which is what its
 *  detector hears. Not a point on the strip, which is why its tap does not come from the
 *  chain the console offers (`meters.ts` `sidechainTap`). */
const sidechainLane = (ctx: DynCtx): DynLane => ({
  key: "sc",
  label: ctx.m.inspector.ssmcs.sideChain,
  kind: "level",
  tap: sidechainTap(ctx.nodeId, ctx.model.id) ?? null,
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
  banked: true,

  // Four lanes, which is one more than the strip's own stages: the compressor's output
  // (111) is what the transfer curve's dot has to point at — using the EQ's output would
  // put the EQ's own gain on the compressor's curve — and the strip's output (112) is
  // what the readouts need to show what the bank did end to end.
  bind: (ctx) => {
    const bound = bindChannelStrip(ctx, {
      fields: (dyn) => (dyn.comp ? null : ssmcsMainFields()),
      tapCaptions: true,
      grKind: "comp",
      inTapKey: "precomp",
      outTapKey: "preeq",
      // No fader cap: this bank's corner is driven by an internal value, so there is no
      // editable value in the meter's own dBFS to put on it.
      cap: null,
      extraLanes: [strippedLane(ctx, "post", ctx.m.dynTuning.ssmcs.tapOut, "preinsfx")],
    });
    // Four tiles, so two columns — the same arrangement the DUCKER's four take.
    return bound && { ...bound, readoutCols: 2 };
  },

  bar: BANK_BAR,
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

  drawAxes: (c, g, tok, ctx) => {
    const { half, left, right } = mainHalves(g.w, g.h);
    stripDbAxes(c, left, tok, ctx);
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

  // MAIN's left half is the same transfer curve, so its dot takes the same lift.
  drawLive: (c, g, read, tok, ctx) => {
    const out = read("out");
    const lifted = out === null ? null : out + outLiftDb(ctx);
    drawLiveDot(c, g, read("in"), lifted, tok, { in: IN_LO_DB, out: OUT_LO_DB });
  },
};

// ---------------------------------------------------------------- COMP
//
// The one face with two ways to read it, because this compressor has an input the others
// do not: a filter in front of its detector. The transfer curve is the shipped COMP
// screen's; SIDE CHAIN is the filter's own response.
//
// Two more readings were built here and taken back out: the curve's predicted reduction
// marked on the reduction lane, and a leader from the live dot to the curve. Both showed
// how far the compressor was from its curve, and neither was legible to the operator they
// were built for — the mark could not be picked out of the lane it sat in, and the leader
// said nothing the dot's own distance did not. What survives of them is a sentence in the
// CURVE hint naming Attack and Release.

/** This face's two segments, both a plot with the lane rack beside it: the transfer curve
 *  at 0, the side-chain response here. */
export const SC_SEL = 1;

/** The side-chain filter as the response model takes it: plan raw → Hz / Q / dB. */
const scState = (v: StripValues): SsmcsScState => ({
  on: v.sc.on,
  freq: ssmcsFreqHz(v.sc.freq),
  q: ssmcsQ(v.sc.q),
  gain: ssmcsGainDb(v.sc.gain),
});

/**
 * The filter's response, drawn as the REDUCTION it buys rather than as the gain it
 * applies — so the axis runs the same way the GR meter beside it does.
 *
 * The filter is in the detector, and lifting a band there makes the compressor hear more
 * of it and clamp down harder. Drawn as the filter's own gain, a boost went UP while the
 * thing it produces went down, and the plot then pointed the opposite way to the
 * reduction lane a few pixels to its right. Negating it costs the reading nothing — the
 * shape is the same — and buys one direction for "more" across the whole display. The
 * MODEL keeps the filter's true sign; only this drawing flips it.
 *
 * The area under the curve is shaded, and this is the only plot in the app that shades
 * one. Everywhere else the curve is audio, where the line already says what the operator
 * will hear and a wash under it adds nothing. Here the line is not audio at all, so the
 * area IS the reading: the band the compressor has been made to react to more, or less.
 *
 * The marker carries the one thing the curve cannot say about itself. Flat arrives two
 * ways and they are not the same state: the filter switched out, and the filter engaged
 * at 0 dB, which the unit runs as an exact bypass. `on` dims the marker for the first.
 */
function drawScResponse(c: CanvasRenderingContext2D, g: DynPlotGeo, tok: Record<string, string>, v: StripValues): void {
  const sc = scState(v);
  const filter = ssmcsScResponse(sc);
  const asReduction = (hz: number): number => -filter(hz);
  drawFreqCurve(c, g, tok, asReduction, 0, true);
  drawBandMarkers(c, g, tok, [{ label: SC_MARKER, hz: sc.freq, db: asReduction(sc.freq), on: sc.on, active: false }]);
}

export const SSMCS_COMP_DYN: DynProcessor = {
  key: "ssmcsComp",
  loDb: LO_DB,
  tickStep: TICK_STEP,
  title,
  banked: true,
  // The reduction hangs on the PRE EQ column it was taken off in every segment, the way
  // the DUCKER screen has always drawn its own — one arrangement rather than one per
  // segment. Both segments carry the same three columns, so the rack does not change
  // width under the pointer when the bar moves between them.
  bind: (ctx) => {
    // Each segment carries the sliders whose effect is on the plot beside them: the
    // compressor's on CURVE, the filter's on SIDE CHAIN. A slider whose curve is not the one
    // drawn moves nothing the operator can see, and the two sets are four rows each, which
    // is what holds this face at the height its siblings are held at.
    const sc = ctx.sel === SC_SEL;
    const bound = bindChannelStrip(ctx, {
      fields: (dyn) => (dyn.comp ? null : ssmcsCompFields().filter((f) => isSsmcsScKey(f.key) === sc)),
      tapCaptions: true,
      grKind: "comp",
      inTapKey: "precomp",
      outTapKey: "preeq",
      cap: null,
      // What the compressor is actually listening to, which on this bank is not the input
      // lane: the side-chain filter sits between them. Its label is the filter's own row
      // label rather than a second spelling of the device's term.
      //
      // SIDE CHAIN keeps all three lanes: what the filter does is the DIFFERENCE between the
      // input and what the detector hears, so dropping the input leaves that face unable to
      // answer its own question — and the filter's own output is not metered at all, so there
      // is no pair to reduce it to. CURVE is the compressor's own pair, so it goes and the
      // rack is two columns.
      ...(sc ? { keyLane: sidechainLane(ctx) } : {}),
      grNetDb: strapGainDb(stripOf(ctx)),
    });
    // Four tiles on SIDE CHAIN, on one row (`readoutCols: 4`); a second row is 64px, more
    // than the height the bank holds its three faces at can absorb.
    return bound && (sc ? { ...bound, readoutCols: 4 } : bound);
  },
  // This face is two of the bank bar's four segments: the transfer curve and the side-chain
  // response, each with the lane rack beside it.
  bar: BANK_BAR,
  // Which of the ways you read a compressor is a lasting preference, so it persists.
  persistSel: true,
  // Only `display` and `drawLive` are taken from here — the segments differ in what the
  // plot IS, so `hint` / `plotGeo` / `drawAxes` are answered per segment below.
  ...transferPlot({
    loDb: IN_LO_DB,
    outLoDb: OUT_LO_DB,
    outTicks: OUT_TICKS,
    hint: (m) => m.dynTuning.comp.curveHint,
    outOffsetDb: outLiftDb,
    on: (ctx) => ctx.sel !== SC_SEL,
  }),

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

  // Knee closes the compressor's rows and Side Chain opens the filter's, each on the segment
  // that carries the sliders it belongs to. Both are keyed on the filter's first slider: on
  // SIDE CHAIN that row exists and the toggle lands above it, and on CURVE it does not, so
  // the host appends the knee after the rows it did place.
  rows: ({ m, vals, set, midi, sel }) => ({
    before: {
      scQ:
        sel === SC_SEL
          ? [
              midi(
                settingsRow(
                  m.inspector.ssmcs.sideChain,
                  onOff(vals.scOn === true, (on) => set({ scOn: on })),
                ),
                "scOn",
              ),
            ]
          : [
              settingsRow(
                m.inspector.dyn.knee,
                settingsChoice(
                  COMP_KNEE_OPTIONS.map((o) => o.label),
                  typeof vals.knee === "number" ? vals.knee : COMP_KNEE_DEFAULT,
                  (i) => set({ knee: COMP_KNEE_OPTIONS[i].value }),
                ),
              ),
            ],
    },
  }),

  hint: (ctx) => (ctx.sel === SC_SEL ? ctx.m.dynTuning.ssmcs.scHint : ctx.m.dynTuning.comp.curveHint),
  plotGeo: (w, h, ctx) => (ctx.sel === SC_SEL ? freqGeo(w, h) : dbGeo(w, h, IN_LO_DB, OUT_LO_DB, OUT_TICKS)),
  drawAxes: (c, g, tok, ctx) => (ctx.sel === SC_SEL ? drawFreqAxes(c, g, tok) : stripDbAxes(c, g, tok, ctx)),
  drawCurve: (c, g, _v, tok, ctx) =>
    ctx.sel === SC_SEL ? drawScResponse(c, g, tok, stripOf(ctx)) : drawTransfer(c, g, tok, stripOf(ctx)),
};

// ---------------------------------------------------------------- EQ

const bandOf = (ctx: DynCtx): SsmcsEqBandName => SSMCS_EQ_BAND_NAMES[ctx.sel] ?? SSMCS_EQ_BAND_NAMES[0];

export const SSMCS_EQ_DYN: DynProcessor = {
  key: "ssmcsEq",
  loDb: LO_DB,
  tickStep: TICK_STEP,
  title,
  banked: true,

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

  bar: BANK_BAR,
  // No band bar: the markers ON the plot are the band control, as on the shipped EQ screen.
  // Which band is selected is a cursor into the parameters rather than a way of reading the
  // processor, so it still resets to LOW per open.
  plotPicks: (ctx) => ({
    count: SSMCS_EQ_BAND_NAMES.length,
    hit: (c, g, at) => pickBandMarker(c, g, eqBandMarks(stripOf(ctx), bandOf(ctx)), at),
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
