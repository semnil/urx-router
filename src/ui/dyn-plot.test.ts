// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { GATE_DYN } from "./dyn-gate";
import { COMP_DYN } from "./dyn-comp";
import { GATE_RANGE_OFF_DB } from "../core/control/vd";
import { recorder, vals } from "./dyn-plot.test-util";
import type { DynPlotGeo } from "./dyn-screen";

// The drawing contract every plot on the channel tuning screens follows: a curve is drawn
// at its TRUE value and the host clips it to the plot area, so a value past the axis leaves
// the frame. Clamping it to the axis draws a horizontal bar along the edge — a response the
// processor does not have, and (for the gate) one indistinguishable from a -∞ range.
//
// Pinned through a recording context rather than pixels: what matters is the coordinate the
// descriptor asks for, and the clip that keeps it off the frame is the host's.

const TOK: Record<string, string> = {};
const W = 600;
const H = 320;

/** Below the plot area's bottom edge = off the frame. */
const floorY = (g: DynPlotGeo): number => H - g.pad.b;

describe("plot drawing stays off the frame instead of on its edge", () => {
  // The descriptors' own geometry, so a change to their axes cannot leave this passing
  // against a plot the app no longer draws.
  const gateGeo = GATE_DYN.plotGeo(W, H, {} as never);

  it("draws a gate's closed shelf at its true depth when the range is finite", () => {
    // threshold -64 + range -72 = -136 dB, below the -128 axis floor. Clamping drew it at
    // the floor, which is where a -∞ range is drawn: two different gates, one picture.
    const r = recorder();
    GATE_DYN.drawCurve(r.ctx, gateGeo, vals({ threshold: -64, range: -72 }), TOK, {} as never);
    expect(Math.max(...r.ys)).toBeGreaterThan(floorY(gateGeo));
  });

  it("keeps a -∞ range pinned to the axis floor, which is what stands for it", () => {
    // The floor is the GR meters' own floor and the label prints "-∞", so this one is a
    // representation rather than a clamp — and it must not be clipped away.
    const r = recorder();
    GATE_DYN.drawCurve(r.ctx, gateGeo, vals({ threshold: -64, range: GATE_RANGE_OFF_DB }), TOK, {} as never);
    expect(Math.max(...r.ys)).toBeCloseTo(gateGeo.py(-128), 5);
    expect(Math.max(...r.ys)).toBeLessThanOrEqual(floorY(gateGeo));
  });

  it("draws the Soft knee at its measured width, not the doubled reach it replaced", () => {
    // The one thing the constant decides, pinned where it decides the most. At the
    // threshold itself the quadratic knee sits (1/ratio - 1) * w/8 below unity, so the
    // curve's depth there IS the width: -4.875 dB at 52, -3.75 dB at 40. Everything else
    // in this suite passes either way, which is how 40 survived a measurement that had
    // already contradicted it.
    //
    // 52 is the measured value (reference/work/vd/vd-params.md, signal-side sweep,
    // 2026-08): the residual minimum is 51 dB and 50 / 52 / 54 are indistinguishable, so
    // the source takes the round middle. Written out here rather than imported — importing
    // the constant would make this agree with any value it is given.
    const SOFT_KNEE_DB = 52;
    const compGeo = COMP_DYN.plotGeo(W, H, {} as never);
    const thr = -30;
    const ratio = 4;
    const r = recorder();
    COMP_DYN.drawCurve(r.ctx, compGeo, vals({ threshold: thr, ratio, gain: 0, knee: 0 }), TOK, {} as never);

    // The response is sampled on a fixed grid from the input floor to 0 dBFS; the
    // annotation adds two more points after it. Asserted rather than assumed, so a change
    // to the sampling fails here instead of silently moving which point is read.
    const SAMPLES = 121;
    expect(r.ys.length).toBe(SAMPLES + 2);
    const lo = COMP_DYN.loDb;
    const at = (db: number): number => r.ys[Math.round(((db - lo) / (0 - lo)) * (SAMPLES - 1))];
    const inAtThreshold = lo + Math.round(((thr - lo) / (0 - lo)) * (SAMPLES - 1)) * ((0 - lo) / (SAMPLES - 1));
    const d = inAtThreshold - thr;
    const depth = ((1 / ratio - 1) * (d + SOFT_KNEE_DB / 2) ** 2) / (2 * SOFT_KNEE_DB);
    expect(at(thr)).toBeCloseTo(compGeo.py(inAtThreshold + depth), 1);
  });

  it("joins the compressor's knee to both legs at the edges, not just at its centre", () => {
    // The centre is where every interpolant through the same two edges agrees, so the pin
    // above cannot see the shape. These are the two joins: below the knee the curve is
    // unity, above it the asymptote, and an interpolant that misses either draws a step.
    //
    // Written out rather than imported, as the pin above is: importing the model would
    // make this agree with whatever the model does.
    const W_MEDIUM = 16;
    const thr = -20;
    const ratio = 4;
    const compGeo = COMP_DYN.plotGeo(W, H, {} as never);
    const r = recorder();
    COMP_DYN.drawCurve(r.ctx, compGeo, vals({ threshold: thr, ratio, gain: 0, knee: 1 }), TOK, {} as never);

    const SAMPLES = 121;
    const lo = COMP_DYN.loDb;
    const step = (0 - lo) / (SAMPLES - 1);
    // The nearest sampled input to a given level, and the level that sample actually
    // carries — an edge does not land on the grid, and comparing at the asked-for level
    // instead would fail by the grid's own spacing.
    const sampled = (db: number) => {
      const i = Math.round((db - lo) / step);
      return { y: r.ys[i], at: lo + i * step };
    };

    const lower = sampled(thr - W_MEDIUM / 2);
    expect(lower.y).toBeCloseTo(compGeo.py(lower.at), 1);

    const upper = sampled(thr + W_MEDIUM / 2);
    expect(upper.y).toBeCloseTo(compGeo.py(thr + (upper.at - thr) / ratio), 1);

    // And between them the curve is neither leg: a knee that had collapsed to a corner
    // would satisfy both joins above while drawing a straight line through the middle.
    const mid = sampled(thr - W_MEDIUM / 4);
    const asUnity = compGeo.py(mid.at);
    expect(Math.abs(mid.y - asUnity)).toBeGreaterThan(1);
  });

  it("leaves a compressor's response inside its own axes at every setting", () => {
    // Not a clamp: makeup gain only adds and the knee interpolation only subtracts, so the
    // -54…+18 axes contain the response. Checked at the extremes rather than assumed.
    const compGeo = COMP_DYN.plotGeo(W, H, {} as never);
    for (const v of [
      { threshold: -54, ratio: 20, gain: 0, knee: 2 },
      { threshold: 0, ratio: 1, gain: 18, knee: 0 },
      { threshold: -18, ratio: 20, gain: 18, knee: 0 },
    ]) {
      const r = recorder();
      COMP_DYN.drawCurve(r.ctx, compGeo, vals(v), TOK, {} as never);
      expect(Math.max(...r.ys)).toBeLessThanOrEqual(floorY(compGeo) + 0.5);
      expect(Math.min(...r.ys)).toBeGreaterThanOrEqual(compGeo.pad.t - 0.5);
    }
  });
});
