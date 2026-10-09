// A lit amber face that carries text takes `--led-face`, and its ink takes
// `--on-accent-ink`. `--led` is the lamp itself — a dot, a rail, a rule, an accent used
// AS ink on a dark ground — and `--seg` is the gradient for faces nothing is printed on
// (fader caps, knobs, slider thumbs). Neither is a face to print on.
//
// The reason is measured and already written into style.css beside the chip rule: on the
// light theme the dark ink reaches APCA Lc 55.4 against `--led`, short of the Lc 60 floor,
// where `--led-face` reaches 76. That migration went into the toggles and the console chips
// and was then missed by five more surfaces plus a canvas one — nothing in the tree said so,
// because the split lives in two layers that never referred to each other:
//
//   CSS     a rule that declares both a `--led` / `--seg` face and a `color`
//   canvas  a plot that fills a shape in one of those tokens and writes text inside it
//
// This holds both. The CSS half reads the stylesheet as text (see style-css.test-util).
// The canvas half runs EVERY registered processor through a recording context and compares
// geometry — did a `fillText` anchor land inside a `--led` / `--seg` face — rather than
// forbidding the token in a fill, because the rule's own text calls a lit dot legitimate
// and `dyn-gate` / `dyn-ducker` print `--led` AS ink straight onto the plot ground.
//
// Its honest limit: the harness sees only the states it drives here, so it is a wide net
// rather than an airtight one. A face that only appears under a value this file never sets
// is not covered.
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { CSS, RULES, THEME_SELECTOR, decl, faceDecl, tokensIn } from "./style-css.test-util";
import type { CssRule } from "./style-css.test-util";
import { NAMED_TOKENS, recorder, vals } from "./dyn-plot.test-util";
import { DYN_PROCESSORS } from "./dyn-registry";
import { defaultPlan } from "../models/initial-state";
import { getModel } from "../models";
import { INSERT_FX_OPTIONS, OUTPUT_INSERT_FX_OPTIONS } from "../core/control/params";
import { effectiveInsertFx } from "../core/control/translate";
import { t } from "../i18n";

/** The compander, by name off the shared table rather than as a literal. */
const COMPANDER_H = INSERT_FX_OPTIONS.find((o) => o.label === "Compander-H")!.value;
/** The multi-band compressor, the one family whose plot names its bands. */
const MBC = OUTPUT_INSERT_FX_OPTIONS.find((o) => o.label === "M.B.Comp")!.value;

/** The tokens that are lamps and gradients, never faces to print on. */
const NOT_A_FACE = ["--led", "--seg"];

describe("a lit face that carries text uses --led-face, not --led or --seg", () => {
  it("no CSS rule prints text on a --led or --seg face", () => {
    // A face that IS the token, not one tinted with it: `color-mix(in srgb, var(--led)
    // 16%, var(--ctl-bg))` is the lit OUTLINE recipe (.con-tap / .con-panbtn.open), whose
    // ink is --led-ink and which measures Lc 68.2 / 60.6 — above the floor.
    const faces = NOT_A_FACE.map((t) => `var(${t})`);
    const offenders = RULES.filter(
      (r) => faces.includes(faceDecl(r.body) ?? "") && decl(r.body, "color") !== undefined,
    ).map((r) => r.selector);
    expect(offenders, "print on var(--led-face) with var(--led-ink) as the rim instead").toEqual([]);
  });

  it("a --led-face face always names its ink", () => {
    // The other half of the recipe. Every current user declares it, so this is a real
    // invariant rather than an aspiration — and it is what stops a surface lighting the
    // right face and then printing the wrong colour on it.
    const missing = RULES.filter(
      (r) => faceDecl(r.body) === "var(--led-face)" && decl(r.body, "color") !== "var(--on-accent-ink)",
    ).map((r) => r.selector);
    expect(missing, "a lit face takes var(--on-accent-ink)").toEqual([]);
  });

  it("the tokens this rule is written in terms of are all still declared", () => {
    // Without this the first test greens on a rename: the regex finds no `var(--led)`
    // face, which reads as "no offenders" rather than "the token moved".
    for (const [theme, sel] of Object.entries(THEME_SELECTOR)) {
      const declared = Object.keys(tokensIn(sel));
      for (const t of ["--led", "--seg", "--led-face", "--led-ink"]) {
        expect(declared, `${t} missing from the ${theme} theme`).toContain(t);
      }
    }
    // --on-accent-ink is deliberately declared once: it is dark in both themes and the
    // light block inherits it. Pinned so "missing from light" cannot be read as drift.
    expect(CSS.match(/--on-accent-ink:/g)).toHaveLength(1);
  });

  it("no plot writes text inside a --led or --seg face", () => {
    const inside = (t: { x: number; y: number }, f: { x0: number; y0: number; x1: number; y1: number }): boolean =>
      t.x >= f.x0 && t.x <= f.x1 && t.y >= f.y0 && t.y <= f.y1;

    const plan = defaultPlan("URX44V");
    // The INS FX screen resolves what to draw from the PLAN, so a node holding nothing
    // draws nothing and the pass over it would be vacuous — covered by this test in name
    // and by nothing in fact. CH 1 takes a compander, the one family whose response is
    // defined by its parameters, so `insfx` has a curve to be checked.
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, insertFx: COMPANDER_H, insertFxOn: true };
    const offenders: string[] = [];
    // A processor that draws no plot has nothing for this to read, so it is skipped — but
    // the skip is DECLARED rather than taken silently. The plot hooks became optional when
    // the INS FX screen arrived, which turned a line that had never skipped anything into
    // one that can absorb a whole processor: a new plot-less descriptor would then be
    // covered by nothing and turn nothing red.
    const skipped: string[] = [];
    for (const [kind, proc] of Object.entries(DYN_PROCESSORS)) {
      if (!proc.drawCurve || !proc.plotGeo) {
        skipped.push(kind);
        continue;
      }
      // Band 0 selected, so the EQ's lit marker is among the faces drawn. A processor
      // that ignores `sel` is unaffected by it. The model and the messages are real
      // because a descriptor may READ them to decide what it draws — the INS FX screen
      // asks the model which effect the node can hold before it draws anything.
      const ctx = { nodeId: "ch1", sel: 0, plan, model: getModel("URX44V"), m: t() } as never;
      const r = recorder();
      proc.drawCurve(r.ctx, proc.plotGeo(600, 320, ctx), vals(), NAMED_TOKENS, ctx);
      for (const text of r.texts) {
        const face = r.faces.find((f) => NOT_A_FACE.includes(f.style) && inside(text, f));
        if (face) offenders.push(`${kind}: ${text.style} on ${face.style}`);
      }
    }
    expect(offenders, "fill the face with --led-face and write --on-accent-ink on it").toEqual([]);
    // `fx` draws no plot on any family and never will: a reverb's decay and a delay's
    // repeat train are not derivable from the values the app holds, so its display column is
    // a lane rack alone. Named rather than allowed for by a bare "skip what has no curve" —
    // the point of this list is that a NEW plot-less descriptor is a red line and not a
    // silent absence, and `insfx` is here to show that a descriptor whose plot is
    // conditional still gets checked on the family that has one.
    expect(skipped, "a processor that draws no plot has to be named here").toEqual(["fx"]);
    // …and the seeding that gave the INS FX pass something to draw is itself asserted:
    // dropped, that pass runs against a node holding nothing, draws nothing, and covers
    // the screen not at all — while staying green. (A curve that only strokes paints no
    // face and writes no text, so the recorder cannot tell those two apart.)
    expect(effectiveInsertFx(getModel("URX44V"), plan, "ch1"), "CH 1 must hold a compander").toBe(COMPANDER_H);
  });
});

// A tick label, a band name, any number a plot prints, is text read on the groove, and
// --plot-faint is a rule's tone there rather than an ink: text takes --plot-dim, the tier
// the DOM tick column on the same groove prints in. Driven over every processor's axes and
// curve, on nodes holding each kind of plot, with each band selected in turn.
describe("a plot prints no text in --plot-faint", () => {
  it("draws every tick label and band name in an ink, not in the rules' tone", () => {
    const plan = defaultPlan("URX44V");
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, insertFx: COMPANDER_H, insertFxOn: true };
    plan.nodeParams["bus.mix1"] = { ...plan.nodeParams["bus.mix1"], insertFx: MBC, insertFxOn: true };
    const offenders: string[] = [];
    let texts = 0;
    for (const [kind, proc] of Object.entries(DYN_PROCESSORS)) {
      if (!proc.drawCurve || !proc.plotGeo) continue;
      for (const nodeId of ["ch1", "bus.mix1", "out.ducker1"])
        for (const sel of [0, 1, 2, 3]) {
          const ctx = { nodeId, sel, plan, model: getModel("URX44V"), m: t() } as never;
          const r = recorder();
          const geo = proc.plotGeo(600, 320, ctx);
          proc.drawAxes?.(r.ctx, geo, NAMED_TOKENS, ctx);
          proc.drawCurve(r.ctx, geo, vals(), NAMED_TOKENS, ctx);
          texts += r.texts.length;
          for (const text of r.texts)
            if (text.style === "--plot-faint") offenders.push(`${kind} on ${nodeId}: "${text.text}"`);
        }
    }
    expect([...new Set(offenders)], "print it in --plot-dim").toEqual([]);
    // The positive control: the drive reached text at all.
    expect(texts).toBeGreaterThan(100);
  });
});

// Text a plot writes on a face of its own (a band marker's pill, a lit marker) is read
// against that face, not the groove, so the pair has to reach 4.5:1 in each theme with the
// token values the stylesheet declares. Graded where both are drawn at full strength: a
// marker drawn dim is a band switched off, which says so by being dim.
describe("a plot's text on a face of its own reads at 4.5:1", () => {
  it("in both themes", () => {
    const themes = {
      dark: tokensIn(THEME_SELECTOR.dark),
      light: { ...tokensIn(THEME_SELECTOR.dark), ...tokensIn(THEME_SELECTOR.light) },
    };
    const value = (map: Record<string, string>, token: string): string => {
      let v = map[token] ?? "";
      for (let i = 0; i < 5 && v.startsWith("var("); i++) v = map[v.slice(4, -1)] ?? "";
      return v;
    };
    const rgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const lum = (c: number[]): number => {
      const [r, g, b] = c.map((v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: string, b: string): number => {
      const [hi, lo] = [lum(rgb(a)), lum(rgb(b))].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const plan = defaultPlan("URX44V");
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, insertFx: COMPANDER_H, insertFxOn: true };
    plan.nodeParams["bus.mix1"] = { ...plan.nodeParams["bus.mix1"], insertFx: MBC, insertFxOn: true };
    const pairs = new Set<string>();
    for (const proc of Object.values(DYN_PROCESSORS)) {
      if (!proc.drawCurve || !proc.plotGeo) continue;
      for (const nodeId of ["ch1", "bus.mix1", "out.ducker1"])
        for (const sel of [-1, 0, 1, 2, 3]) {
          const ctx = { nodeId, sel, plan, model: getModel("URX44V"), m: t() } as never;
          const r = recorder();
          const geo = proc.plotGeo(600, 320, ctx);
          proc.drawAxes?.(r.ctx, geo, NAMED_TOKENS, ctx);
          proc.drawCurve(r.ctx, geo, vals(), NAMED_TOKENS, ctx);
          for (const text of r.texts) {
            if (text.alpha !== 1) continue;
            const under = r.faces
              .filter((f) => f.seq < text.seq && f.x0 <= text.x && text.x <= f.x1 && f.y0 <= text.y && text.y <= f.y1)
              .at(-1);
            if (under?.alpha === 1) pairs.add(`${text.style} on ${under.style}`);
          }
        }
    }
    const short: string[] = [];
    for (const pair of pairs) {
      const [ink, face] = pair.split(" on ");
      for (const [theme, map] of Object.entries(themes)) {
        const [a, b] = [value(map, ink), value(map, face)];
        if (!/^#[0-9a-f]{6}$/i.test(a) || !/^#[0-9a-f]{6}$/i.test(b)) continue;
        if (ratio(a, b) < 4.5) short.push(`${theme}: ${pair} ${ratio(a, b).toFixed(2)}`);
      }
    }
    expect(short).toEqual([]);
    // The positive control: the drive met text on a face — the EQ markers' — at all.
    expect([...pairs].some((p) => p.endsWith("on --led-face"))).toBe(true);
    expect(pairs.size).toBeGreaterThan(1);
  });
});

// A ring drawn INSIDE a lit face in the lamp's own colour is invisible on it: in the dark
// theme --led-face IS --led. The packed racks draw their ring inside (offset -2px), so every
// lit state whose unlit control rings that way has to name a ring of its own. Derived from
// the stylesheet — the lit faces, then the inset amber ring each one's control wears — so a
// lit state added tomorrow is covered the day it is written.
describe("a focus ring drawn inside a lit face does not take the lamp's colour", () => {
  const LIT_STATE = /(\.on|\.active|\[aria-pressed="true"\])$/;
  const litSelectors = RULES.filter((r) => faceDecl(r.body) === "var(--led-face)")
    .flatMap((r) => r.selector.split(",").map((s) => s.trim()))
    .filter((s) => LIT_STATE.test(s));
  // The last rule that names the ring AND declares the property read from it: RULES flattens
  // the @media blocks, so a later forced-colors rule that only restyles the ring's line would
  // otherwise stand in for the one that gives it its colour.
  const ringOf = (selector: string, prop: string): CssRule | undefined =>
    RULES.filter(
      (r) =>
        r.selector
          .split(",")
          .map((s) => s.trim())
          .includes(`${selector}:focus-visible`) && decl(r.body, prop) !== undefined,
    ).at(-1);

  it("finds lit states to hold", () => {
    expect(litSelectors.length).toBeGreaterThan(3);
  });

  it("every lit state whose control rings inside in amber names an ink ring", () => {
    const inset: string[] = [];
    const missing: string[] = [];
    for (const lit of litSelectors) {
      const base = ringOf(lit.replace(LIT_STATE, ""), "outline");
      if (!base) continue;
      const offset = parseFloat(decl(base.body, "outline-offset") ?? "0");
      if (!(offset < 0 && (decl(base.body, "outline") ?? "").includes("var(--led)"))) continue;
      inset.push(lit);
      if (decl(ringOf(lit, "outline-color")?.body ?? "", "outline-color") !== "var(--on-accent-ink)") missing.push(lit);
    }
    // The positive control: the racks this exists for are found by the derivation.
    expect(inset).toEqual(expect.arrayContaining([".con-chip.on", ".con-ifxpop .irow.active"]));
    expect(missing, "give the lit state `outline-color: var(--on-accent-ink)` on focus").toEqual([]);
  });
});
