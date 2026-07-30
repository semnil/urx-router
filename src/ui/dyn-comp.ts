// The COMP processor for the channel tuning screen.
//
// CURVE is the compressor's input/output response — the picture the unit's own
// COMP screen draws (user guide p.104), with the live level travelling it. The
// unit lets you drag T / R / G grips on that graph; this screen deliberately does
// not. Three grips on one plot means a press has to guess which value was meant,
// and one that missed fell through to the threshold, so pressing the gain grip
// moved the threshold. The sliders beside the plot are the editing path, and the
// curve answers "what is this doing to my signal". LADDER is the same three-tap
// ruler the gate screen uses.
//
// Two device facts shape it, both measured on a URX44V (2026-07-29):
//   - COMP GR (110) reports the reduction alone. Sweeping the makeup gain 0 →
//     +18 dB moved the downstream tap by exactly 18 dB and left the GR meter where
//     it was, so the lane stays readable at any makeup setting;
//   - a compressor's reduction occupies a few dB of the 54 dB input ruler, so the
//     GR lane carries a scale of its own rather than the level lanes' dB per pixel
//     (a -8 dB reduction is 15% of the shared ruler — visible, but not readable).

import { onOff, settingsChoice, settingsRow } from "./dom";
import type { SettingsRowOptions } from "./dom";
import { COMP_KNEE_DEFAULT, COMP_KNEE_OPTIONS } from "../core/control/params";
import { bindChannelStrip, displayBar, subObjectIo } from "./dyn-chan";
import { transferPlot } from "./dyn-plot";
import { HI_DB, oneKnobLevelRow } from "./dyn-screen";
import type { DynProcessor, DynValues } from "./dyn-screen";

/** Input axis = the threshold's own domain (-54…0 dB). Ticks every 6 dB. */
const LO_DB = -54;

// Output axis. Unlike the gate's, the compressor's output runs ABOVE the input
// range: makeup gain reaches +18 dB, and an output clamped at 0 would hide every
// makeup setting past the point where the curve reaches the ceiling.
const OUT_LO_DB = -54;
const OUT_TICKS = [18, 6, -6, -18, -30, -42, -54];

/**
 * Knee width in dB by selector value (0 Soft / 1 Medium / 2 Hard), from the
 * threshold-departure measurement in reference/work/vd/vd-params.md: with the
 * signal held still, the threshold was walked upward until the reduction stopped,
 * which is where the knee's lower edge leaves the detector behind. Hard stopped
 * immediately, Medium ~8 dB later, Soft ~20 dB later — so these are twice the
 * measured reach under the usual symmetric-knee model.
 *
 * Only the lower edge is measured; this source could not push the detector far
 * enough above the threshold to see where full ratio is reached, so the curvature
 * between the edges is the standard quadratic interpolation and is an assumption.
 */
const KNEE_WIDTH_DB = [40, 16, 0];

const kneeWidth = (knee: number): number => KNEE_WIDTH_DB[knee] ?? KNEE_WIDTH_DB[COMP_KNEE_DEFAULT];

/** The compressor's response as a function of input level, makeup included. Built
 *  once per redraw rather than read per sample point: the curve evaluates it ~120
 *  times, and each `v.get` walks the plan. */
function responseOf(v: DynValues): (inDb: number) => number {
  const thr = v.get("threshold");
  const ratio = Math.max(1, v.get("ratio"));
  const gain = v.get("gain");
  const w = kneeWidth(Math.round(v.get("knee")));
  return (inDb) => {
    const d = inDb - thr;
    if (w > 0 && Math.abs(d) <= w / 2) return inDb + ((1 / ratio - 1) * (d + w / 2) ** 2) / (2 * w) + gain;
    return (d <= 0 ? inDb : thr + d / ratio) + gain;
  };
}

const io = subObjectIo("comp");

export const COMP_DYN: DynProcessor = {
  key: "comp",
  loDb: LO_DB,
  tickStep: 6,
  title: (m) => m.dynTuning.comp.title,
  bind: (ctx) =>
    bindChannelStrip(ctx, {
      fields: (dyn) => dyn.comp,
      grKind: "comp",
      inTapKey: "precomp",
      outTapKey: "preeq",
      grFullDb: 24,
    }),
  bar: displayBar,
  ...transferPlot({ loDb: LO_DB, outLoDb: OUT_LO_DB, outTicks: OUT_TICKS, hint: (m) => m.dynTuning.comp.curveHint }),
  persistSel: true,
  read: io.read,
  patch: io.patch,

  // The device drives threshold / ratio / gain / knee while 1-knob / Auto Makeup are on,
  // and announces each recomputation per address — so those rows keep updating on screen,
  // read-only, rather than being hidden or recomputed here.
  //
  // 1-knob also decides which of the two rows around it applies: Auto Makeup cannot be
  // operated while it is on (user guide), and the level does nothing while it is off. That
  // is a lock, declared here with the rest, and not a swap in `rows` — a swap would break
  // the host's "no row is ever removed" invariant, and it did: a toggle row and a slider
  // row are not the same height, so the panel moved, and dropping Auto Makeup lifted the
  // 1-knob row a full row up, out from under the pointer that had just clicked it.
  rowStates: (ctx, vals) => {
    const out = new Map<string, SettingsRowOptions>();
    const one = vals.oneKnob === true;
    const driven = one ? ["threshold", "ratio", "gain", "knee"] : vals.autoMakeup ? ["gain"] : [];
    for (const k of driven) out.set(k, { tag: ctx.m.dynTuning.driven, locked: true });
    out.set(one ? "autoMakeup" : "oneKnobLevel", { locked: true });
    return out;
  },

  rows: ({ m, vals, states, set, setValue }) => {
    const lead = [
      settingsRow(
        m.inspector.autoMakeup,
        onOff(vals.autoMakeup === true, (on) => set({ autoMakeup: on })),
        states.get("autoMakeup"),
      ),
      settingsRow(
        m.inspector.oneKnob,
        onOff(vals.oneKnob === true, (on) => set({ oneKnob: on })),
      ),
      oneKnobLevelRow({
        label: m.inspector.oneKnobLevel,
        value: vals.oneKnobLevel,
        onInput: (v) => setValue({ oneKnobLevel: v }),
        row: states.get("oneKnobLevel"),
      }),
    ];

    const knee = typeof vals.knee === "number" ? vals.knee : COMP_KNEE_DEFAULT;
    const tail = [
      settingsRow(
        m.inspector.dyn.knee,
        settingsChoice(
          COMP_KNEE_OPTIONS.map((o) => o.label),
          knee,
          (i) => set({ knee: COMP_KNEE_OPTIONS[i].value }),
        ),
        states.get("knee"),
      ),
    ];
    return { lead, tail };
  },

  drawCurve: (c, g, v, tok) => {
    const out = responseOf(v);
    c.strokeStyle = tok["--led"];
    c.lineWidth = 2;
    c.beginPath();
    // No clamp: the axes were chosen to contain the whole response (makeup gain only adds,
    // and the knee interpolation only subtracts, so out(x) stays inside -54…+18 for every
    // setting), and the host clips the plot area anyway — so a response that did leave the
    // frame would leave it rather than being flattened onto the edge.
    for (let i = 0; i <= 120; i++) {
      const x = LO_DB + ((HI_DB - LO_DB) * i) / 120;
      if (i) c.lineTo(g.px(x), g.py(out(x)));
      else c.moveTo(g.px(x), g.py(out(x)));
    }
    c.stroke();

    // The reduction at full scale, which is what the ratio buys: the gap between
    // the curve and unity at 0 dBFS, labelled where it is widest.
    const top = out(HI_DB) - v.get("gain");
    if (top < -0.05) {
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
  },
};
