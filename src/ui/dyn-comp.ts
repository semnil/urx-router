// The COMP processor for the dynamics tuning screen.
//
// The unit's own COMP screen (user guide p.104) is edited on the graph: T
// (threshold), R (ratio) and G (gain) are dragged on the transfer curve, with the
// GR meter beside it and the knee / attack / release as boxes. The CURVE mode here
// is that screen; LADDER is the same three-tap ruler the gate screen uses.
//
// Two device facts shape it, both measured on a URX44V (2026-07-29):
//   - COMP GR (110) reports the reduction alone. Sweeping the makeup gain 0 →
//     +18 dB moved the downstream tap by exactly 18 dB and left the GR meter where
//     it was, so the lane stays readable at any makeup setting;
//   - a compressor's reduction occupies a few dB of the 54 dB input ruler, so the
//     GR lane carries a scale of its own rather than the level lanes' dB per pixel
//     (a -8 dB reduction is 15% of the shared ruler — visible, but not readable).

import { settingsChoice, settingsRow } from "./dom";
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

/** Static transfer response for one input level, makeup included. */
function outFor(v: DynValues, knee: number, inDb: number): number {
  const thr = v.get("threshold");
  const ratio = Math.max(1, v.get("ratio"));
  const w = kneeWidth(knee);
  const d = inDb - thr;
  let out: number;
  if (w > 0 && Math.abs(d) <= w / 2) out = inDb + ((1 / ratio - 1) * (d + w / 2) ** 2) / (2 * w);
  else if (d <= 0) out = inDb;
  else out = thr + d / ratio;
  return out + v.get("gain");
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

  rows: ({ m, vals, set }) => {
    const one = vals.oneKnob === true;
    const lead = [];
    // Auto Makeup cannot be operated while 1-knob is on (user guide), and the
    // inspector drops the row entirely there rather than showing a dead control.
    if (!one) {
      lead.push(
        settingsRow(
          m.inspector.autoMakeup,
          settingsChoice(
            [m.inspector.on, m.inspector.off],
            vals.autoMakeup ? 0 : 1,
            (i) => set({ autoMakeup: i === 0 }),
            true,
          ),
        ),
      );
    }
    lead.push(
      settingsRow(
        m.inspector.oneKnob,
        settingsChoice([m.inspector.on, m.inspector.off], one ? 0 : 1, (i) => set({ oneKnob: i === 0 }), true),
      ),
    );
    if (one) {
      const ctl = document.createElement("span");
      ctl.className = "ctl dev-slider";
      const input = document.createElement("input");
      input.type = "range";
      input.min = "0";
      input.max = "100";
      input.step = "1";
      input.value = String(typeof vals.oneKnobLevel === "number" ? vals.oneKnobLevel : 0);
      input.id = "dyn-oneknob-level";
      input.setAttribute("aria-label", m.inspector.oneKnobLevel);
      const val = document.createElement("span");
      val.className = "param-val gt-val";
      val.textContent = `${input.value} %`;
      input.addEventListener("input", () => {
        val.textContent = `${input.value} %`;
        set({ oneKnobLevel: Number(input.value) });
      });
      ctl.append(input, val);
      lead.push(settingsRow(m.inspector.oneKnobLevel, ctl));
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
        one ? { tag: m.dynTuning.driven, locked: true } : {},
      ),
    ];
    return { lead, tail };
  },

  // The unit's three grips, in its own positions: T on the knee, R at the top of
  // the curve, G at its foot.
  handles: (v) => [
    {
      id: "threshold",
      label: "T",
      x: v.get("threshold"),
      y: outFor(v, COMP_KNEE_DEFAULT, v.get("threshold")),
      drag: (inDb) => ({ threshold: Math.round(v.clamp("threshold", inDb)) }),
    },
    {
      id: "ratio",
      label: "R",
      x: HI_DB,
      y: outFor(v, COMP_KNEE_DEFAULT, HI_DB),
      // Above the threshold the curve is out = thr + (in - thr)/ratio + gain, so a
      // grip dragged to `outDb` at full scale pins the ratio directly. Pulling it
      // down steepens; at or above the unity point the ratio bottoms out at 1:1.
      drag: (_inDb, outDb) => {
        const thr = v.get("threshold");
        const span = outDb - v.get("gain") - thr;
        if (span <= 0) return { ratio: v.clamp("ratio", Number.MAX_SAFE_INTEGER) };
        return { ratio: Number(v.clamp("ratio", (HI_DB - thr) / span).toFixed(1)) };
      },
    },
    {
      id: "gain",
      label: "G",
      x: LO_DB,
      y: outFor(v, COMP_KNEE_DEFAULT, LO_DB),
      // Below the threshold the curve is unity plus the makeup, so the grip's
      // height above the input floor is the makeup gain.
      drag: (_inDb, outDb) => ({ gain: Number((Math.round(v.clamp("gain", outDb - LO_DB) * 2) / 2).toFixed(1)) }),
    },
  ],

  drawCurve: (c, g, v, tok) => {
    const knee = Math.round(v.get("knee"));
    c.strokeStyle = tok["--led"];
    c.lineWidth = 2;
    c.beginPath();
    for (let i = 0; i <= 120; i++) {
      const x = LO_DB + ((HI_DB - LO_DB) * i) / 120;
      const y = Math.min(Math.max(outFor(v, knee, x), OUT_LO_DB), Math.max(...OUT_TICKS));
      if (i) c.lineTo(g.px(x), g.py(y));
      else c.moveTo(g.px(x), g.py(y));
    }
    c.stroke();

    // The reduction at full scale, which is what the ratio buys: the gap between
    // the curve and unity at 0 dBFS, labelled where it is widest.
    const top = outFor(v, knee, HI_DB) - v.get("gain");
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
      // Clear of the R grip, which sits on the same edge at the curve's end.
      c.fillText(`${top.toFixed(1)} dB`, g.px(HI_DB) - 22, g.py((HI_DB + top) / 2) + 3);
    }
  },
};
