// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { GATE_DYN } from "./dyn-gate";
import { COMP_DYN } from "./dyn-comp";
import { GATE_RANGE_OFF_DB } from "../core/control/vd";
import type { DynPlotGeo, DynValues } from "./dyn-screen";

// The drawing contract every plot on the channel tuning screens follows: a curve is drawn
// at its TRUE value and the host clips it to the plot area, so a value past the axis leaves
// the frame. Clamping it to the axis draws a horizontal bar along the edge — a response the
// processor does not have, and (for the gate) one indistinguishable from a -∞ range.
//
// Pinned through a recording context rather than pixels: what matters is the coordinate the
// descriptor asks for, and the clip that keeps it off the frame is the host's.

interface Recorder {
  ctx: CanvasRenderingContext2D;
  ys: number[];
}

/** A 2D context that records the y of every path point and swallows everything else. */
function recorder(): Recorder {
  const ys: number[] = [];
  const ctx = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "moveTo" || prop === "lineTo") return (_x: number, y: number) => void ys.push(y);
        if (prop === "measureText") return () => ({ width: 8 });
        if (prop === "save" || prop === "restore") return () => {};
        // Everything else is a no-op method; property writes (fillStyle, font …) land on
        // the target and are never read back.
        return () => {};
      },
      set: () => true,
    },
  ) as CanvasRenderingContext2D;
  return { ctx, ys };
}

const vals = (v: Record<string, number>): DynValues => ({ get: (k) => v[k] ?? 0 });
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
