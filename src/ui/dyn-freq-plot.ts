// The frequency-against-gain plot the two EQ screens draw on: its coordinate mapping,
// its grid and its band markers.
//
// Beside the descriptors rather than in the screen host for the same reason the dB × dB
// transfer plot is (dyn-plot.ts) — the host owns the canvas and asks a descriptor to
// draw; what the axes mean is the descriptor's. The two EQs on this device are separate
// DSP blocks with different band counts and different filter models, and everything
// they DO share is here: a marker is the same pill in the same face, on the composite
// curve, in both.

import { EQ_FREQ_MAX_HZ, EQ_FREQ_MIN_HZ } from "../core/control/vd";
import { PLOT_FONT } from "./dyn-screen";
import type { DynPlotGeo } from "./dyn-screen";

/** Gain axis: exactly the band gain range, so a maxed band touches the frame. */
export const GAIN_TICKS = [18, 12, 6, 0, -6, -12, -18];
const GAIN_TOP = GAIN_TICKS[0];
const GAIN_BOTTOM = GAIN_TICKS[GAIN_TICKS.length - 1];
/** Decade gridlines, plus the halves an EQ is actually talked about in. */
const FREQ_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const FREQ_LABELS: Record<number, string> = {
  20: "20",
  100: "100",
  1000: "1k",
  10000: "10k",
  20000: "20k",
};

export const FREQ_PAD = { l: 40, r: 12, t: 12, b: 26 };

/** Log frequency across, linear gain down. `x0` offsets the plot inside a wider canvas,
 *  for a face that draws two plots on one (the SSMCS MAIN face); it is 0 everywhere
 *  else, and `w` is then the canvas width. */
export function freqGeo(w: number, h: number, x0 = 0): DynPlotGeo {
  const span = Math.log(EQ_FREQ_MAX_HZ / EQ_FREQ_MIN_HZ);
  return {
    w,
    h,
    pad: FREQ_PAD,
    px: (hz) => x0 + FREQ_PAD.l + ((Math.log(hz) - Math.log(EQ_FREQ_MIN_HZ)) / span) * (w - FREQ_PAD.l - FREQ_PAD.r),
    py: (db) => FREQ_PAD.t + ((GAIN_TOP - db) / (GAIN_TOP - GAIN_BOTTOM)) * (h - FREQ_PAD.t - FREQ_PAD.b),
  };
}

/** The frequency an x maps back to, which is what sampling the response per pixel
 *  column needs. The inverse of `freqGeo`'s `px`, from the same three numbers. */
export function freqAt(g: DynPlotGeo, x: number, x0 = 0): number {
  const span = Math.log(EQ_FREQ_MAX_HZ / EQ_FREQ_MIN_HZ);
  const w = g.w - g.pad.l - g.pad.r;
  return Math.exp(Math.log(EQ_FREQ_MIN_HZ) + ((x - x0 - g.pad.l) / w) * span);
}

/** Whether a gain lands inside the frame. Off the scale is off the frame, for a marker
 *  as much as for the curve: pinning one to the floor would mark a frequency at a level
 *  the response never reaches there. */
export const onGainScale = (db: number): boolean => db <= GAIN_TOP && db >= GAIN_BOTTOM;

/** Grid, tick labels, axis names and the 0 dB line the curve is read against. `x0`
 *  offsets it inside a wider canvas, as `freqGeo`'s does. */
export function drawFreqAxes(c: CanvasRenderingContext2D, g: DynPlotGeo, tok: Record<string, string>, x0 = 0): void {
  c.font = PLOT_FONT;
  c.lineWidth = 1;
  c.strokeStyle = tok["--plot-line"];
  c.fillStyle = tok["--plot-faint"];
  c.textAlign = "center";
  for (const hz of FREQ_TICKS) {
    c.beginPath();
    c.moveTo(g.px(hz) + 0.5, g.pad.t);
    c.lineTo(g.px(hz) + 0.5, g.h - g.pad.b);
    c.stroke();
    const label = FREQ_LABELS[hz];
    if (label) c.fillText(label, g.px(hz), g.h - g.pad.b + 13);
  }
  c.textAlign = "right";
  for (const db of GAIN_TICKS) {
    c.beginPath();
    c.moveTo(x0 + g.pad.l, g.py(db) + 0.5);
    c.lineTo(x0 + g.w - g.pad.r, g.py(db) + 0.5);
    c.stroke();
    c.fillText(String(db), x0 + g.pad.l - 6, g.py(db) + 3);
  }
  // 0 dB is the line the curve is read against, so it is drawn again on top.
  c.strokeStyle = tok["--plot-dim"];
  c.beginPath();
  c.moveTo(x0 + g.pad.l, g.py(0) + 0.5);
  c.lineTo(x0 + g.w - g.pad.r, g.py(0) + 0.5);
  c.stroke();
  c.fillStyle = tok["--plot-dim"];
  c.textAlign = "left";
  c.fillText("Hz", x0 + g.w - g.pad.r - 16, g.h - g.pad.b + 24);
  c.save();
  c.translate(x0 + 11, g.h - g.pad.b - 2);
  c.rotate(-Math.PI / 2);
  c.fillText("dB", 0, 0);
  c.restore();
}

/** One band's marker: where it sits, what it is called, and the two states that are not
 *  the same axis — `on` is whether the device runs it, `active` whether the operator has
 *  it selected. A band switched off keeps its marker so its frequency stays readable. */
export interface BandMarker {
  label: string;
  hz: number;
  /** The COMPOSITE response at this band's frequency, so the marker is always on the
   *  curve: a pass filter has no gain to place it by, and two overlapping bands would
   *  otherwise plant their markers off the line the operator is reading. */
  db: number;
  on: boolean;
  active: boolean;
}

/** The markers, as letters in pills. Not grips — nothing here is draggable: several
 *  grips on one plot cannot tell which value a press meant (the COMP screen proved that
 *  with three), so the sliders stay the editing path. */
export function drawBandMarkers(
  c: CanvasRenderingContext2D,
  g: DynPlotGeo,
  tok: Record<string, string>,
  marks: readonly BandMarker[],
  inert = false,
): void {
  c.save();
  c.font = PLOT_FONT;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.lineWidth = 1.5;
  for (const b of marks) {
    if (!onGainScale(b.db)) continue;
    const x = g.px(b.hz);
    const y = g.py(b.db);
    // A pill sized to its own label, not a circle: "LM" and "HM" do not fit a disc
    // wide enough for "L" without the letters touching the edge.
    const w = Math.max(15, c.measureText(b.label).width + 9);
    const h = b.active ? 15 : 13;
    c.globalAlpha = inert ? 0.3 : b.on ? 1 : 0.35;
    // The ink follows the face. The selected marker is the lit face, so it takes the
    // dark ink every lit face takes; the rest are the dim face and keep the plot's
    // ink. Printing --plot-ink on --led left the selected letter at APCA Lc 16.1.
    c.fillStyle = b.active ? tok["--led-face"] : tok["--plot-dim"];
    c.beginPath();
    c.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
    c.fill();
    c.strokeStyle = tok["--plot-ink"];
    c.stroke();
    c.fillStyle = b.active ? tok["--on-accent-ink"] : tok["--plot-ink"];
    c.fillText(b.label, x, y + 0.5);
  }
  c.restore();
  c.textBaseline = "alphabetic";
}

/** The response as one stroked line, sampled per pixel column. Drawn at its true value:
 *  the host clips the plot area, so where the response runs past the floor — which a
 *  high-pass or low-pass does within an octave of its corner — it leaves the frame
 *  instead of lying along the bottom edge as a response the filter does not have. */
export function drawFreqCurve(
  c: CanvasRenderingContext2D,
  g: DynPlotGeo,
  tok: Record<string, string>,
  resp: (hz: number) => number,
  x0 = 0,
): void {
  const left = x0 + g.pad.l;
  const right = x0 + g.w - g.pad.r;
  c.strokeStyle = tok["--led"];
  c.lineWidth = 2;
  c.beginPath();
  // Per pixel: the curve is redrawn only when a parameter, the size or the theme
  // changes, and a sharp Q 16 bell is a few pixels wide at this scale.
  for (let x = left; x <= right; x++) {
    const y = g.py(resp(freqAt(g, x, x0)));
    if (x === left) c.moveTo(x, y);
    else c.lineTo(x, y);
  }
  c.stroke();
}
