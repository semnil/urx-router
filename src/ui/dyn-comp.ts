// The COMP processor for the dynamics tuning screen.
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

import { onOff, settingsChoice, settingsRow, sliderRow } from "./dom";
import { COMP_KNEE_DEFAULT, COMP_KNEE_OPTIONS } from "../core/control/params";
import { HI_DB } from "./dyn-screen";
import type { DynProcessor, DynValues } from "./dyn-screen";

/** Input axis = the threshold's own domain (-54…0 dB). Ticks every 6 dB. */
const LO_DB = -54;

// Output axis. Unlike the gate's, the compressor's output runs ABOVE the input
// range: makeup gain reaches +18 dB, and an output clamped at 0 would hide every
// makeup setting past the point where the curve reaches the ceiling.
const OUT_LO_DB = -54;
const OUT_TICKS = [18, 6, -6, -18, -30, -42, -54];
const OUT_HI = Math.max(...OUT_TICKS);

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

export const COMP_DYN: DynProcessor = {
  key: "comp",
  grKind: "comp",
  loDb: LO_DB,
  tickStep: 6,
  outLoDb: OUT_LO_DB,
  outTicks: OUT_TICKS,
  inTapKey: "precomp",
  outTapKey: "preeq",
  grFullDb: 24,
  text: (m) => m.dynTuning.comp,
  fields: (dyn) => dyn.comp,

  // The device drives these while 1-knob / Auto Makeup are on, and announces each
  // recomputation per address — so they keep updating on screen, read-only, rather
  // than being hidden or recomputed here.
  driven: (vals) => {
    const set = new Set<string>();
    if (vals.oneKnob) for (const k of ["threshold", "ratio", "gain", "knee"]) set.add(k);
    else if (vals.autoMakeup) set.add("gain");
    return set;
  },

  rows: ({ m, vals, driven, set, setValue }) => {
    const one = vals.oneKnob === true;
    const lead = [];
    // Auto Makeup cannot be operated while 1-knob is on (user guide), and the
    // inspector drops the row entirely there rather than showing a dead control.
    if (!one) {
      lead.push(
        settingsRow(
          m.inspector.autoMakeup,
          onOff(vals.autoMakeup === true, (on) => set({ autoMakeup: on })),
        ),
      );
    }
    lead.push(
      settingsRow(
        m.inspector.oneKnob,
        onOff(one, (on) => set({ oneKnob: on })),
      ),
    );
    if (one) {
      // setValue, not set: this slider changes only itself, and a rebuild on its
      // own input event would take the element out from under the pointer.
      lead.push(
        sliderRow({
          label: m.inspector.oneKnobLevel,
          id: "dyn-oneknob-level",
          min: 0,
          max: 100,
          step: 1,
          value: typeof vals.oneKnobLevel === "number" ? vals.oneKnobLevel : 0,
          format: (v) => `${v} %`,
          onInput: (v) => setValue({ oneKnobLevel: v }),
        }),
      );
    }

    const knee = typeof vals.knee === "number" ? vals.knee : COMP_KNEE_DEFAULT;
    const tail = [
      settingsRow(
        m.inspector.dyn.knee,
        settingsChoice(
          COMP_KNEE_OPTIONS.map((o) => o.label),
          knee,
          (i) => set({ knee: COMP_KNEE_OPTIONS[i].value }),
        ),
        driven.has("knee") ? { tag: m.dynTuning.driven, locked: true } : {},
      ),
    ];
    return { lead, tail };
  },

  drawCurve: (c, g, v, tok) => {
    const out = responseOf(v);
    c.strokeStyle = tok["--led"];
    c.lineWidth = 2;
    c.beginPath();
    for (let i = 0; i <= 120; i++) {
      const x = LO_DB + ((HI_DB - LO_DB) * i) / 120;
      const y = Math.min(Math.max(out(x), OUT_LO_DB), OUT_HI);
      if (i) c.lineTo(g.px(x), g.py(y));
      else c.moveTo(g.px(x), g.py(y));
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
