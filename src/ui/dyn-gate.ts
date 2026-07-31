// The GATE processor for the channel tuning screen.
//
// A GATE threshold in dB is directly comparable with the PRE GATE meter's dBFS
// (measured: CH1's -54 dBFS noise floor sat below a -52 dB threshold and the gate
// stayed shut), which is what earns the lane rack's one gesture — the threshold is a
// fader cap dragged on the input meter itself.

import { formatDyn } from "../core/control/translate";
import { GATE_RANGE_OFF_DB } from "../core/control/vd";
import { GR_FLOOR_DB } from "../core/meters";
import { bindChannelStrip, displayBar, subObjectIo } from "./dyn-chan";
import { transferPlot } from "./dyn-plot";
import { HI_DB } from "./dyn-screen";
import type { DynProcessor } from "./dyn-screen";

/** Input axis: the exact domain a GATE threshold can occupy, so a cap position
 *  maps to a threshold value linearly. */
const LO_DB = -72;

// The curve's output axis, which is deliberately NOT the input axis. The closed
// shelf sits at threshold + range, and for most of the range domain that falls
// below the -72 dB the input spans — at the factory settings -50 + -56 = -106 dB.
// Sharing the input's floor pinned every range past -22 dB to the same line, so
// at the factory threshold 70% of the range domain drew an identical picture and
// range was invisible. Running the output axis to the GR floor puts the shelf on
// scale: moving range from -30 to -56 shifts it by 20% of the plot height, from
// 0% before. A log-compressed axis was measured too and is worse (8.5%) — dB is
// already a log unit, and compressing it again squeezes exactly the deep region
// range lives in.
const OUT_LO_DB = -128;
/** Output-axis gridlines. Coarser than the input's: the axis is 1.8× longer and
 *  the region below -72 dB is context, not something to read off. */
const OUT_TICKS = [0, -24, -48, -72, -96, -128];

const io = subObjectIo("gate");

export const GATE_DYN: DynProcessor = {
  key: "gate",
  loDb: LO_DB,
  tickStep: 5,
  title: (m) => m.dynTuning.gate.title,
  // No grFullDb: a gate's reduction runs the whole ruler (range reaches -∞), so the
  // shared tick column reads for it — a GR bar down to the -56 tick is 56 dB.
  bind: (ctx) =>
    bindChannelStrip(ctx, { fields: (dyn) => dyn.gate, grKind: "gate", inTapKey: "pregate", outTapKey: "precomp" }),
  bar: displayBar,
  ...transferPlot({ loDb: LO_DB, outLoDb: OUT_LO_DB, outTicks: OUT_TICKS, hint: (m) => m.dynTuning.gate.curveHint }),
  persistSel: true,
  read: io.read,
  patch: io.patch,
  // The curve carries one editable value, so a press on it is unambiguous.
  plotDragsCap: true,

  drawCurve: (c, g, v, tok) => {
    const thr = v.get("threshold");
    const rangeDb = v.get("range");
    // range at its -∞ notch closes completely, and the axis floor is what stands for that
    // (it is the GR meters' own floor, and the label prints "-∞"): pinning it there is the
    // representation, not a clamp. A FINITE range deep enough to fall below the axis —
    // threshold -72…-56 with the deepest ranges reaches -144 — is a different thing, and
    // is drawn at its true depth so the host's clip takes it off the frame. Clamping it
    // drew the same picture as -∞ for a gate that is not closed.
    const closed = rangeDb <= GATE_RANGE_OFF_DB;
    const drop = closed ? GR_FLOOR_DB : rangeDb;
    const shelfY = (db: number): number => g.py(closed ? Math.max(db, OUT_LO_DB) : db);

    c.strokeStyle = tok["--led"];
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(g.px(LO_DB), shelfY(LO_DB + drop));
    c.lineTo(g.px(thr), shelfY(thr + drop));
    c.stroke();
    c.beginPath();
    c.moveTo(g.px(thr), g.py(thr));
    c.lineTo(g.px(HI_DB), g.py(HI_DB));
    c.stroke();

    // The knee's drop, labelled with the range it represents. Only a -∞ range
    // reaches the axis floor; every finite range lands on scale, which is the
    // point of running the output axis past the input's.
    c.strokeStyle = tok["--gr"];
    c.setLineDash([3, 3]);
    c.beginPath();
    c.moveTo(g.px(thr), g.py(thr));
    c.lineTo(g.px(thr), shelfY(thr + drop));
    c.stroke();
    c.setLineDash([]);
    c.fillStyle = tok["--gr"];
    const right = g.px(thr) > g.w - 94;
    c.textAlign = right ? "right" : "left";
    const shown = closed ? "-∞" : formatDyn(rangeDb, "db");
    // The label is clamped where the line is not: it names the range, so it has to stay
    // readable even when the shelf it belongs to has left the frame.
    c.fillText(
      shown,
      g.px(thr) + (right ? -6 : 6),
      Math.min(g.py(Math.max(thr + drop, OUT_LO_DB)) - 6, g.h - g.pad.b - 4),
    );

    c.strokeStyle = tok["--led"];
    c.globalAlpha = 0.35;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(g.px(thr) + 0.5, g.pad.t);
    c.lineTo(g.px(thr) + 0.5, g.h - g.pad.b);
    c.stroke();
    c.globalAlpha = 1;
    c.fillStyle = tok["--led"];
    c.textAlign = "left";
    c.fillText(formatDyn(thr, "db"), Math.min(g.px(thr) + 5, g.w - 74), g.pad.t + 11);
  },
};
