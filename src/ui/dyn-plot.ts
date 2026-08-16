// The dB-in / dB-out transfer plot GATE and COMP both draw: its coordinate mapping,
// its grid, its axis labels and the unity reference their curves depart from.
//
// It lives beside the descriptors rather than in the screen host because it is not
// the only kind of plot the host carries — the EQ's is frequency against gain, and
// shares none of this. The host owns the canvas (size, device pixel ratio, the cached
// static layer, the theme tokens) and asks a descriptor to draw on it; what the axes
// mean is the descriptor's alone.

import { METER_GREEN_TOP_DB, METER_YELLOW_TOP_DB } from "../core/meters";
import { HI_DB, PLOT_FONT, splitDisplay } from "./dyn-screen";
import type { DynCtx, DynPlotGeo, DynProcessor } from "./dyn-screen";
import type { Messages } from "../i18n/en";

/** Plot-area inset. The left gutter carries the output tick labels, the bottom the
 *  input ones, and both are read back by the host when a press has to become a
 *  value. */
export const CURVE_PAD = { l: 44, r: 14, t: 14, b: 28 };

/** Input axis = the processor's threshold domain (so a press on the plot maps to a
 *  threshold linearly); output axis is the processor's own, because what has to stay
 *  on scale differs — a gate's closed shelf runs far below the input floor, a
 *  compressor's makeup gain runs above it. */
export function dbGeo(w: number, h: number, loDb: number, outLoDb: number, outTicks: readonly number[]): DynPlotGeo {
  const outHi = Math.max(HI_DB, ...outTicks);
  return {
    w,
    h,
    pad: CURVE_PAD,
    px: (db) => CURVE_PAD.l + ((db - loDb) / (HI_DB - loDb)) * (w - CURVE_PAD.l - CURVE_PAD.r),
    py: (db) => h - CURVE_PAD.b - ((db - outLoDb) / (outHi - outLoDb)) * (h - CURVE_PAD.t - CURVE_PAD.b),
  };
}

/** Grid, tick labels, axis names and the unity line — everything under a transfer
 *  curve. Six input gridlines whatever the domain's width; the output ticks are the
 *  processor's own list, since the two axes are not the same length. */
export function drawDbAxes(
  c: CanvasRenderingContext2D,
  g: DynPlotGeo,
  tok: Record<string, string>,
  o: {
    loDb: number;
    outTicks: readonly number[];
    /**
     * dB to lift the unity reference by, where the curve carries a gain over its whole
     * length.
     *
     * Unity is drawn so the curve's departure from it reads as the reduction. A curve that
     * is offset — the SSMCS strip's is, by its makeup and Out Gain — departs from unity by
     * the reduction PLUS that offset, so the line stops being the thing the eye subtracts
     * and the reduction annotation beside it stops touching either end. Lifting the
     * reference by the same amount puts it back to "the level with no compression", which
     * is what it was for.
     */
    unityOffsetDb?: number;
  },
): void {
  const faint = tok["--plot-faint"];
  c.font = PLOT_FONT;
  c.strokeStyle = tok["--plot-line"];
  c.lineWidth = 1;
  c.fillStyle = faint;
  c.textAlign = "center";
  const inStep = Math.round((HI_DB - o.loDb) / 6);
  for (let db = o.loDb; db <= HI_DB; db += inStep) {
    c.beginPath();
    c.moveTo(g.px(db) + 0.5, g.pad.t);
    c.lineTo(g.px(db) + 0.5, g.h - g.pad.b);
    c.stroke();
    c.fillText(String(db), g.px(db), g.h - g.pad.b + 13);
  }
  c.textAlign = "right";
  for (const db of o.outTicks) {
    c.beginPath();
    c.moveTo(g.pad.l, g.py(db) + 0.5);
    c.lineTo(g.w - g.pad.r, g.py(db) + 0.5);
    c.stroke();
    c.fillText(String(db), g.pad.l - 6, g.py(db) + 3);
  }
  c.fillStyle = tok["--plot-dim"];
  c.textAlign = "left";
  c.fillText("IN dBFS", g.w - g.pad.r - 58, g.h - g.pad.b + 24);
  c.save();
  c.translate(13, g.h - g.pad.b - 2);
  c.rotate(-Math.PI / 2);
  c.fillText("OUT dBFS", 0, 0);
  c.restore();

  // Unity reference, so the curve's departure from it reads against something.
  const off = o.unityOffsetDb ?? 0;
  c.strokeStyle = faint;
  c.setLineDash([2, 3]);
  c.beginPath();
  c.moveTo(g.px(o.loDb), g.py(o.loDb + off));
  c.lineTo(g.px(HI_DB), g.py(HI_DB + off));
  c.stroke();
  c.setLineDash([]);
}

/** The live point on a transfer plot: where the signal currently sits on the curve,
 *  coloured by the meter zone it is in. Both dB×dB plots draw the same dot, and
 *  neither draws it without a feed — a dot parked at the floor would read as silence
 *  that is being metered rather than as nothing being metered. */
export function drawLiveDot(
  c: CanvasRenderingContext2D,
  g: DynPlotGeo,
  inDb: number | null,
  outDb: number | null,
  tok: Record<string, string>,
  floor: { in: number; out: number },
): void {
  if (inDb === null || outDb === null) return;
  c.fillStyle =
    inDb >= METER_YELLOW_TOP_DB ? tok["--m-red"] : inDb >= METER_GREEN_TOP_DB ? tok["--m-yellow"] : tok["--m-green"];
  c.beginPath();
  c.arc(g.px(Math.max(inDb, floor.in)), g.py(Math.max(outDb, floor.out)), 5, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = tok["--plot-ink"];
  c.lineWidth = 1.5;
  c.stroke();
}

/**
 * A compressor's transfer curve and the reduction it buys at full scale — the drawing both
 * banks make, from the response each of them models.
 *
 * The annotation spans from the OFFSET unity reference to the curve, not from the frame's
 * own 0 dB: a curve carrying a gain departs from plain unity by the reduction plus that
 * gain, so a rule drawn to the frame touches the curve at neither end and stops saying
 * what it measures. Its LABEL is unchanged by that — the length is the same either way,
 * because the gain cancels in the difference — so the number is still the reduction alone.
 *
 * It is read off the CURVE rather than off the asymptote, so a knee still open at full
 * scale is labelled with what it actually does there.
 */
/**
 * A compressor's response, for both banks: two straight legs joined across a knee.
 *
 * `up` and `down` are how far the knee reaches either side of the threshold. A block whose
 * knee was fitted as one symmetric width passes half of it as each — that is not an
 * approximation here: for `up === down` the cubic below and the quadratic a symmetric
 * model would use satisfy the same four constraints (both edges, both slopes) and are
 * therefore the same polynomial.
 *
 * Between the edges: a cubic through both, carrying the slope each side already has — 1
 * below, 1/ratio above — with the two slopes limited to the cubic's monotone region first.
 * The limit stops an unlimited cubic overshooting, which draws an input increase as an
 * output decrease; it scales both slopes by 3/hypot, which is 1 wherever the pair is
 * already inside the region, so the join stays exact everywhere it can. On a symmetric
 * knee it provably cannot engage: the worst reach over the whole ratio range is 2.0.
 *
 * `gain` is one offset over the whole curve. Which gain that is belongs to the caller —
 * the two banks compute it from different parameters.
 */
export function kneeResponse(o: {
  thr: number;
  ratio: number;
  up: number;
  down: number;
  gain: number;
}): (inDb: number) => number {
  const ratio = Math.max(1, o.ratio);
  const lo = o.thr - o.down;
  const hi = o.thr + o.up;
  const width = hi - lo;
  const hiOut = o.thr + o.up / ratio;
  const secant = width > 0 ? (hiOut - lo) / width : 1;
  const reach = secant > 0 ? Math.hypot(1 / secant, 1 / ratio / secant) : Number.POSITIVE_INFINITY;
  const limit = reach > 3 ? 3 / reach : 1;
  return (inDb) => {
    if (width > 0 && inDb > lo && inDb < hi) {
      const t = (inDb - lo) / width;
      const t2 = t * t;
      const t3 = t2 * t;
      return (
        (2 * t3 - 3 * t2 + 1) * lo +
        (t3 - 2 * t2 + t) * width * limit +
        (-2 * t3 + 3 * t2) * hiOut +
        (t3 - t2) * width * (limit / ratio) +
        o.gain
      );
    }
    return (inDb <= lo ? inDb : o.thr + (inDb - o.thr) / ratio) + o.gain;
  };
}

export function drawTransferCurve(
  c: CanvasRenderingContext2D,
  g: DynPlotGeo,
  tok: Record<string, string>,
  o: { out: (inDb: number) => number; gainDb: number; loDb: number },
): void {
  c.strokeStyle = tok["--led"];
  c.lineWidth = 2;
  c.beginPath();
  // No clamp: the axes contain the whole response, and the host clips the plot area — so a
  // response that did leave the frame leaves it rather than being flattened onto the edge.
  for (let i = 0; i <= 120; i++) {
    const x = o.loDb + ((HI_DB - o.loDb) * i) / 120;
    if (i) c.lineTo(g.px(x), g.py(o.out(x)));
    else c.moveTo(g.px(x), g.py(o.out(x)));
  }
  c.stroke();

  const top = o.out(HI_DB) - o.gainDb;
  if (top >= -0.05) return;
  const from = HI_DB + o.gainDb;
  const to = o.out(HI_DB);
  c.strokeStyle = tok["--gr"];
  c.setLineDash([3, 3]);
  c.beginPath();
  c.moveTo(g.px(HI_DB) - 1, g.py(from));
  c.lineTo(g.px(HI_DB) - 1, g.py(to));
  c.stroke();
  c.setLineDash([]);
  c.fillStyle = tok["--gr"];
  c.textAlign = "right";
  // Inset from the axis so the label does not sit on the frame.
  c.fillText(`${top.toFixed(1)} dB`, g.px(HI_DB) - 22, g.py((from + to) / 2) + 3);
}

/**
 * The five hooks a dB-in / dB-out transfer plot answers, from its axes and its one line of
 * hint. GATE and COMP had these written out twice — identical but for `loDb` / `outLoDb` /
 * `outTicks` and the hint — which is exactly what a factory is for; the EQ's plot shares
 * none of it and supplies its own.
 */
export function transferPlot(o: {
  loDb: number;
  outLoDb: number;
  outTicks: readonly number[];
  hint: (m: Messages) => string;
  /**
   * dB to add to the output reading before plotting it, where the curve carries a gain
   * that the output TAP is upstream of.
   *
   * The SSMCS strip is the case: its Out Gain is applied after the EQ (measured — `117`
   * moves tap `112` one for one and leaves `108` and `111` where they are), while the tap
   * this dot reads is `111`, between the compressor and the EQ. Drawn without this the dot
   * sits exactly Out Gain below the curve at every input level, which is what an operator
   * reported. The alternative was to take Out Gain off the curve instead, which would
   * leave it drawn nowhere: the EQ's plot cannot carry it either, because that axis IS the
   * band gain range and an offset pushes the response off the frame.
   */
  outOffsetDb?: (ctx: DynCtx) => number;
  /** dB the CURVE carries over its whole length, which the unity reference is lifted by —
   *  `drawDbAxes`'s own `unityOffsetDb` says why. Omitted by a processor whose curve has
   *  no gain of its own, where the reference is plain unity. */
  unityOffsetDb?: (ctx: DynCtx) => number;
  /**
   * Which segments carry the LIVE DOT, where its processor's bar offers a segment showing
   * something else on the same canvas (the SSMCS strip's side-chain response puts
   * frequency across). Those segments answer `plotGeo` / `drawAxes` / `drawCurve` — and
   * `hint` — themselves, so what is left for this to decide is the dot: two levels
   * plotted against a frequency axis is a reading of nothing.
   *
   * Omitted, the dot belongs to every segment — which is the case for a processor whose
   * bar selects nothing else.
   */
  on?: (ctx: DynCtx) => boolean;
}): Pick<DynProcessor, "hint" | "display" | "plotGeo" | "drawAxes" | "drawLive" | "liveOn"> {
  const onCurve = (ctx: DynCtx): boolean => o.on?.(ctx) ?? true;
  return {
    liveOn: onCurve,
    hint: (ctx) => o.hint(ctx.m),
    // The plot and the lane rack are shown TOGETHER, with no bar choosing between them —
    // the arrangement the EQ and DUCKER screens have always had. It became possible when
    // the reduction moved onto the output column: a rack that was three columns wide is
    // two, and two fit beside the plot.
    display: splitDisplay,
    plotGeo: (w, h) => dbGeo(w, h, o.loDb, o.outLoDb, o.outTicks),
    drawAxes: (c, g, tok, ctx) =>
      drawDbAxes(c, g, tok, { loDb: o.loDb, outTicks: o.outTicks, unityOffsetDb: o.unityOffsetDb?.(ctx) }),
    // The dot belongs to the TRANSFER curve — its two coordinates are the levels in and
    // out of the processor. A bank whose bar offers a segment showing something else draws
    // something else on those axes (the SSMCS strip's side-chain filter puts frequency
    // across), and a level plotted against a frequency axis is a reading of nothing.
    drawLive: (c, g, read, tok, ctx) => {
      const out = read("out");
      const offset = o.outOffsetDb?.(ctx) ?? 0;
      return drawLiveDot(c, g, read("in"), out === null ? null : out + offset, tok, { in: o.loDb, out: o.outLoDb });
    },
  };
}
