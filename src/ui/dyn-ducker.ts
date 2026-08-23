// The DUCKER processor for the channel tuning screen.
//
// The one screen here that does not tune the node it opens on. GATE / COMP / EQ live
// inside a channel; a ducker is its own node hanging under a stereo channel, keyed by
// a wire from somewhere else entirely. So its four lanes come from three places: the
// KEY lane from whatever the key wire starts at, the reduction from the ducker, and
// the level pair from the host channel it attenuates.
//
// The KEY lane is one bar, not two, and that is a measured result rather than a layout
// choice. The unit sums a stereo key's sides before its detector, and the cap can only
// ride a ruler in its own coordinate — against a summed display the threshold's onset
// held to -3.0 ±0.5 dB, where against the louder side it spread 7 dB. `duckerKeyDb`
// carries the fold and the constant; here the lane just asks for it.

import { DUCKER_FIELDS, duckerControl, formatDyn } from "../core/control/translate";
import { REC_POINT_DEFAULT } from "../core/control/params";
import { DYN_ATTACK_MIN_MS, DUCKER_DECAY_MAX_MS } from "../core/control/vd";
import { duckerKeyDb, grAddr, tapFor, tapsFor } from "../core/meters";
import { incomingConnection } from "../core/plan";
import type { NodeParams } from "../core/plan";
import { parseRef, ref } from "../models/types";
import { channelLabel, PLOT_FONT, splitDisplay } from "./dyn-screen";
import type { DynCtx, DynLane, DynPlotProcessor } from "./dyn-screen";

/** Lane ruler floor: the threshold's own domain, and no more. A ducker triggers on
 *  programme rather than on a noise floor, so the key levels worth reading sit above
 *  -60 and the cap that rides them cannot go below it.
 *
 *  The reduction shares this ruler (it is drawn in the POST lane's slot, so it
 *  carries no scale of its own), which means a reduction deeper than 60 dB pegs. The
 *  range control reaches -70, so that is reachable — deliberately traded for keeping
 *  the ruler on the domain every other lane and the cap actually use. */
const LO_DB = -60;

/** Envelope plot: the time axis is logarithmic and spans both controls' domains at
 *  once, because they are what the plot is for and they do not share a decade —
 *  attack starts at 0.092 ms and decay reaches 5 s. */
const T_MIN_MS = DYN_ATTACK_MIN_MS;
const T_MAX_MS = DUCKER_DECAY_MAX_MS;
const T_TICKS = [0.1, 1, 10, 100, 1000, 5000];
const ENV_PAD = { l: 44, r: 14, t: 14, b: 28 };

/** The meter tap each Rec Point setting names, in the tap vocabulary of `meters.ts`.
 *  A stereo strip carries no discrete PRE EQ tap because its EQ is the first thing in
 *  the chain, so its INPUT meter is that point (the second entry is reached only there). */
const REC_POINT_TAPS: Record<number, readonly string[]> = {
  0: ["pregate"],
  1: ["precomp"],
  2: ["preeq", "input"],
  3: ["preinsfx"],
  4: ["prefader"],
};

/** Which meter tap a key source is read at, by what the block diagram calls its OUT.
 *  A channel key is its Rec Point tap — the `Rec Point` selector's output is the very
 *  thing the diagram labels `CH OUT`, and `DUCKER 1-4 SOURCE` takes `CH n OUT` — so the
 *  tap MOVES with that channel's Rec Point setting, and it sits ahead of the channel's
 *  own fader and ducker either way. A bus key is the bus's own OUT, i.e. after its
 *  output insert FX (the diagram prints `STEREO OUT` / `MIX n OUT` beyond the `INS FX`
 *  block, and those are the names the DUCKER SOURCE block takes).
 *
 *  Resolved against the node's own tap list rather than handed to `tapFor`, which falls
 *  back to the most downstream tap for a key a node does not have — on a stereo source
 *  that fallback is POST, i.e. after its ducker, which is the one reading this lane must
 *  never show. */
const keyTapKey = (nodeId: string, np: NodeParams | undefined, modelId?: string): string => {
  if (nodeId.startsWith("bus.")) return "post";
  const wanted = REC_POINT_TAPS[np?.recPoint ?? REC_POINT_DEFAULT] ?? REC_POINT_TAPS[REC_POINT_DEFAULT];
  const keys = new Set(tapsFor(nodeId, modelId).map((t) => t.key));
  return wanted.find((k) => keys.has(k)) ?? "prefader";
};

/** The node this ducker's key wire starts at, or null when nothing is wired — which is
 *  a state the unit has and reports as engaged-at-unity, so the lane says so rather
 *  than drawing an empty bar that reads as silence. */
function keySourceId(ctx: DynCtx): string | null {
  const conn = incomingConnection(ctx.plan, ref(ctx.nodeId, "in"), "key");
  return conn ? parseRef(conn.from).nodeId : null;
}

/** The host stereo channel — the one the ducker attenuates, and the one whose level
 *  pair brackets the reduction. */
function hostId(ctx: DynCtx): string | undefined {
  return ctx.model.nodes.find((n) => n.id === ctx.nodeId)?.attachTo;
}

const cur = (ctx: DynCtx): Record<string, unknown> =>
  (ctx.plan.nodeParams[ctx.nodeId]?.ducker ?? {}) as Record<string, unknown>;

/** Log position of a time in ms, 0..1 across the axis. */
const tPos = (ms: number): number =>
  (Math.log10(Math.max(ms, T_MIN_MS)) - Math.log10(T_MIN_MS)) / (Math.log10(T_MAX_MS) - Math.log10(T_MIN_MS));

export const DUCKER_DYN: DynPlotProcessor = {
  key: "ducker",
  loDb: LO_DB,
  tickStep: 6,
  title: (m) => m.dynTuning.ducker.title,
  // The screen opens on the ducker node, whose canvas label is "Ducker" — beside a
  // title reading DUCKER that names nothing. The host channel is what the operator
  // needs to see, and it is the thing being attenuated.
  nodeLabel: (ctx) => {
    const host = hostId(ctx);
    return host ? channelLabel(ctx.model, host) : undefined;
  },

  bind: (ctx) => {
    const dc = duckerControl(ctx.model, ctx.nodeId);
    const host = hostId(ctx);
    if (!dc || !host) return null;
    const text = ctx.m.dynTuning.ducker;
    const src = keySourceId(ctx);
    const key: DynLane = {
      key: "key",
      label: src ? text.tapKey(channelLabel(ctx.model, src)) : text.noKey,
      kind: "level",
      tap: src ? (tapFor(src, keyTapKey(src, ctx.plan.nodeParams[src], ctx.model.id), ctx.model.id) ?? null) : null,
      // Threshold and this lane are the same coordinate BECAUSE the lane is folded to
      // what the detector reads. Offsetting the cap instead would break the one thing
      // the cap mechanism rests on.
      foldSides: duckerKeyDb,
      cap: "threshold",
    };
    return {
      fields: DUCKER_FIELDS,
      // Four tiles on three columns wrap to 3 + 1 — ragged, and wider than four need
      // to be. Two makes them a 2 x 2 block.
      readoutCols: 2,
      lanes: [
        key,
        {
          key: "in",
          label: text.tapIn,
          caption: ctx.m.dynTuning.laneIn,
          kind: "level",
          tap: tapFor(host, "preducker", ctx.model.id) ?? null,
        },
        // In the PRE DUCKER lane's slot, not a column of its own. The reduction is
        // applied to THAT signal — the key only decides when — so the level going in
        // and the amount taken off it belong in one column, on one ruler. It keeps its
        // own readout tile.
        {
          key: "out",
          label: text.tapOut,
          caption: ctx.m.dynTuning.laneOut,
          kind: "level",
          tap: tapFor(host, "post", ctx.model.id) ?? null,
        },
        { key: "gr", label: text.tapGr, kind: "gr", gr: grAddr("ducker", ctx.nodeId), sameSlot: true },
      ],
    };
  },

  // No bar. The envelope and the lanes are both on screen, so nothing chooses between
  // them — every screen is arranged that way now, and this is where it started. It was a
  // Ladder / Envelope toggle first, and the envelope's live overlay is what made that
  // wrong: the overlay is a reduction DEPTH, and a depth is far easier to read beside
  // the meter that carries the same quantity than in place of it.
  // One line for the whole display, since there is one display. It says the two things
  // the picture cannot: that the diagonals are TIMES rather than the shape of the gain
  // change, and that the KEY lane is a FOLD of two sides. Everything else on screen
  // says what it is — the reduction is a labelled block on a labelled meter.
  hint: (ctx) => ctx.m.dynTuning.ducker.hint,
  read: cur,
  patch: (ctx, patch) => ({ ducker: { ...cur(ctx), ...patch } }) as NodeParams,
  // No `controlId`. The MIDI catalog carries a ducker's `duckerOn` and nothing else,
  // so returning ids for these four sliders would arm learn against controls that do
  // not exist. Making them mappable is a catalog change with its own contract tests,
  // not something this screen can assert on its own.
  //
  // `plotDragsCap` is deliberately unset too. The envelope carries three editable values (range, attack,
  // decay) and its x axis is time, not the threshold's dB — a press has no unambiguous
  // reading, and the cap it would drag is not on this plot's axis at all.

  display: splitDisplay,

  plotGeo: (w, h) => ({
    w,
    h,
    pad: ENV_PAD,
    px: (ms) => ENV_PAD.l + tPos(ms) * (w - ENV_PAD.l - ENV_PAD.r),
    // y is gain in dB, 0 at the top down to the range control's floor
    py: (db) => ENV_PAD.t + (-db / -RANGE_FLOOR_DB) * (h - ENV_PAD.t - ENV_PAD.b),
  }),

  drawAxes: (c, g, tok) => {
    c.font = PLOT_FONT;
    c.strokeStyle = tok["--plot-line"];
    c.lineWidth = 1;
    c.fillStyle = tok["--plot-faint"];
    c.textAlign = "center";
    for (const ms of T_TICKS) {
      c.beginPath();
      c.moveTo(g.px(ms) + 0.5, g.pad.t);
      c.lineTo(g.px(ms) + 0.5, g.h - g.pad.b);
      c.stroke();
      c.fillText(ms >= 1000 ? `${ms / 1000} s` : `${ms} ms`, g.px(ms), g.h - g.pad.b + 13);
    }
    c.textAlign = "right";
    for (const db of GAIN_RULES) {
      c.beginPath();
      c.moveTo(g.pad.l, g.py(db) + 0.5);
      c.lineTo(g.w - g.pad.r, g.py(db) + 0.5);
      c.stroke();
      c.fillText(String(db), g.pad.l - 6, g.py(db) + 3);
    }
    // Axis names are literals, like every other plot here ("IN dBFS", "Hz"): canvas
    // text is outside the display inventory's reach, so a message put here could
    // never be shown in the sense that guard means.
    c.fillStyle = tok["--plot-dim"];
    c.textAlign = "left";
    c.fillText("dB", g.pad.l + 2, g.pad.t - 3);
  },

  // Attack down to the range floor, then release back to unity. Straight ramps: the
  // measured release is an exponential approach whose TAIL is dominated by the GR
  // meter's 1 dB quantum, so no single time constant was fitted and the honest claim
  // is the arrival time — which is what a ramp between two known points states.
  drawCurve: (c, g, v, tok) => {
    const range = v.get("range");
    const attack = v.get("attack");
    const decay = v.get("decay");
    const hold = Math.min(attack * 4, T_MAX_MS);

    c.strokeStyle = tok["--led"];
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(g.px(T_MIN_MS), g.py(0));
    c.lineTo(g.px(attack), g.py(range));
    c.lineTo(g.px(hold), g.py(range));
    c.lineTo(g.px(Math.min(hold + decay, T_MAX_MS)), g.py(0));
    c.stroke();

    // The three values the ramps stand for, each against the segment it sets.
    c.fillStyle = tok["--gr"];
    c.textAlign = "left";
    c.fillText(formatDyn(range, "db"), g.pad.l + 4, g.py(range) - 5);
    c.fillStyle = tok["--led"];
    c.fillText(formatDyn(attack, "ms"), g.px(attack) + 5, g.pad.t + 11);
    c.textAlign = "right";
    c.fillText(formatDyn(decay, "ms"), g.w - g.pad.r - 4, g.pad.t + 11);
  },

  // No `drawLive`. A dashed rule at the live reduction was drawn here while the
  // reduction lived in a column of its own with its own scale; now it is a block on
  // the POST bar, a few pixels to the right of this plot. Two live displays of one
  // quantity, and the plot's was the weaker — it has no x, so it could only slide up
  // and down. The envelope is what the three settings DO; the meter is what is
  // happening. COMP keeps its dot because its plot maps input to output, so a live
  // level has a real position on it. Time has none.
};

/** The gain axis floor: the range control's own deepest setting, so the plot shows
 *  every value range can take and no more. Read from the field catalogue rather than
 *  written down again — this constant WAS a second copy, and it held -72, the floor
 *  of the broker `range` table the ducker shares with the GATE. The device stops the
 *  ducker two steps short of it (confirmed on the unit's own LCD), so the axis drew
 *  2 dB the control cannot reach. */
const RANGE_FLOOR_DB = DUCKER_FIELDS.find((f) => f.key === "range")!.min;

/** The gain rules, spanning the floor in equal steps so the deepest range carries a
 *  label. Derived for the same reason the floor is: a hand-written list outlived the
 *  floor it was drawn against, and `drawAxes` runs outside the host's clip (only
 *  `drawCurve` is clipped), so a rule past the floor is painted into the tick-label
 *  band rather than discarded. */
const GAIN_RULES = Array.from({ length: 6 }, (_, i) => Math.round((RANGE_FLOOR_DB * i) / 5));
