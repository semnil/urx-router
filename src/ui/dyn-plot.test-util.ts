// A recording 2D context for the channel tuning screens' plots, shared by the suites
// that pin what a descriptor draws. Not a test file itself (vitest collects only
// *.test.ts), so suites import it instead of re-declaring the stub.
//
// A recorder rather than pixels: what these tests are about is the coordinate a
// descriptor asks for and the token it asks for it in, and both are lost the moment a
// real canvas rasterizes them.

import type { DynValues } from "./dyn-screen";

/** One painted face: the fill style and opacity in force, and the box the path covered. */
export interface PaintedFace {
  style: string;
  alpha: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** One drawn string: the string itself, the fill style and opacity in force, and where
 *  its anchor landed. The text is kept because an annotation's VALUE is the thing a plot
 *  asserts — a count of drawn labels passes whatever number the model computed. */
export interface PaintedText {
  style: string;
  alpha: number;
  text: string;
  x: number;
  y: number;
}

export interface Recorder {
  ctx: CanvasRenderingContext2D;
  /** The y of every path point, in order. */
  ys: number[];
  /** …and the x, for a figure whose horizontal extent is the thing it says — the
   *  multi-band compressor's band step, where the width of a segment IS the band. */
  xs: number[];
  /** Every `fillStyle` written, in order. */
  fills: string[];
  /** Every filled path, with the box its points covered. */
  faces: PaintedFace[];
  /** Every `fillText`, with the style it was drawn in. */
  texts: PaintedText[];
}

/** A 2D context that records what was drawn and swallows everything else.
 *
 *  The path box is accumulated from the explicit numeric arguments the descriptors
 *  pass — every path op in this family takes them (`roundRect`, `rect`, `moveTo` /
 *  `lineTo`, `arc`) — so a face and the text written on it can be compared by
 *  geometry rather than by trusting a call order. */
export function recorder(): Recorder {
  const ys: number[] = [];
  const xs: number[] = [];
  const fills: string[] = [];
  const faces: PaintedFace[] = [];
  const texts: PaintedText[] = [];
  let style = "";
  // Opacity is state a descriptor uses to say something — a band switched off is drawn
  // DIM rather than differently — so a recorder that swallowed it left every "is this
  // dimmed" assertion comparing two identical readings. `save` / `restore` carry the
  // pair the descriptors here actually set; the real context saves far more, and a case
  // that needs the rest should extend this rather than assume it.
  let alpha = 1;
  const saved: Array<{ style: string; alpha: number }> = [];
  let box: PaintedFace | null = null;

  const cover = (x: number, y: number): void => {
    if (!box) box = { style, alpha, x0: x, y0: y, x1: x, y1: y };
    else {
      box.x0 = Math.min(box.x0, x);
      box.y0 = Math.min(box.y0, y);
      box.x1 = Math.max(box.x1, x);
      box.y1 = Math.max(box.y1, y);
    }
  };

  const ctx = new Proxy(
    {},
    {
      get(_t, prop) {
        switch (prop) {
          case "moveTo":
          case "lineTo":
            return (x: number, y: number) => {
              ys.push(y);
              xs.push(x);
              cover(x, y);
            };
          case "rect":
          case "roundRect":
            return (x: number, y: number, w: number, h: number) => {
              cover(x, y);
              cover(x + w, y + h);
            };
          case "arc":
            return (x: number, y: number, r: number) => {
              cover(x - r, y - r);
              cover(x + r, y + r);
            };
          case "beginPath":
            return () => void (box = null);
          case "save":
            return () => void saved.push({ style, alpha });
          case "restore":
            return () => {
              const s = saved.pop();
              if (s) ({ style, alpha } = s);
            };
          case "fill":
            return () => {
              if (box) faces.push({ ...box, style, alpha });
            };
          case "fillText":
            return (text: string, x: number, y: number) => void texts.push({ style, alpha, text, x, y });
          case "measureText":
            return () => ({ width: 8 });
          default:
            // Everything else is a no-op method.
            return () => {};
        }
      },
      set(_t, prop, value) {
        if (prop === "fillStyle") {
          style = String(value);
          fills.push(style);
        }
        if (prop === "globalAlpha") alpha = Number(value);
        return true;
      },
    },
  ) as CanvasRenderingContext2D;

  return { ctx, ys, xs, fills, faces, texts };
}

/** Values a descriptor reads, defaulting to 0 for anything unnamed. */
export const vals = (v: Record<string, number> = {}): DynValues => ({ get: (k) => v[k] ?? 0 });

/** A token map whose every lookup answers with the token's own name, so a recorded
 *  fill names the TOKEN rather than a colour that would have to be kept in step with
 *  the palette. */
export const NAMED_TOKENS = new Proxy({}, { get: (_t, p) => String(p) }) as Record<string, string>;
