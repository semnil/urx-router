// The dB-in / dB-out transfer plot GATE and COMP both draw: its coordinate mapping,
// its grid, its axis labels and the unity reference their curves depart from.
//
// It lives beside the descriptors rather than in the screen host because it is not
// the only kind of plot the host carries — the EQ's is frequency against gain, and
// shares none of this. The host owns the canvas (size, device pixel ratio, the cached
// static layer, the theme tokens) and asks a descriptor to draw on it; what the axes
// mean is the descriptor's alone.

import { METER_GREEN_TOP_DB, METER_YELLOW_TOP_DB } from "../core/meters";
import { CURVE_SEL } from "./dyn-chan";
import { HI_DB, PLOT_FONT } from "./dyn-screen";
import type { DynPlotGeo, DynProcessor } from "./dyn-screen";
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
  o: { loDb: number; outTicks: readonly number[] },
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
  c.strokeStyle = faint;
  c.setLineDash([2, 3]);
  c.beginPath();
  c.moveTo(g.px(o.loDb), g.py(o.loDb));
  c.lineTo(g.px(HI_DB), g.py(HI_DB));
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
}): Pick<DynProcessor, "hint" | "display" | "plotGeo" | "drawAxes" | "drawLive"> {
  return {
    hint: (ctx) => (ctx.sel === CURVE_SEL ? o.hint(ctx.m) : null),
    display: (parts, ctx) => (ctx.sel === CURVE_SEL ? parts.plot() : parts.lanes()),
    plotGeo: (w, h) => dbGeo(w, h, o.loDb, o.outLoDb, o.outTicks),
    drawAxes: (c, g, tok) => drawDbAxes(c, g, tok, { loDb: o.loDb, outTicks: o.outTicks }),
    drawLive: (c, g, read, tok) => drawLiveDot(c, g, read("in"), read("out"), tok, { in: o.loDb, out: o.outLoDb }),
  };
}
