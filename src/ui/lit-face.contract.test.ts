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
import { NAMED_TOKENS, recorder, vals } from "./dyn-plot.test-util";
import { DYN_PROCESSORS } from "./dyn-registry";
import { defaultPlan } from "../models/initial-state";

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
    const offenders: string[] = [];
    for (const [kind, proc] of Object.entries(DYN_PROCESSORS)) {
      if (!proc.drawCurve || !proc.plotGeo) continue;
      // Band 0 selected, so the EQ's lit marker is among the faces drawn. A processor
      // that ignores `sel` is unaffected by it.
      const ctx = { nodeId: "ch1", sel: 0, plan } as never;
      const r = recorder();
      proc.drawCurve(r.ctx, proc.plotGeo(600, 320, ctx), vals(), NAMED_TOKENS, ctx);
      for (const text of r.texts) {
        const face = r.faces.find((f) => NOT_A_FACE.includes(f.style) && inside(text, f));
        if (face) offenders.push(`${kind}: ${text.style} on ${face.style}`);
      }
    }
    expect(offenders, "fill the face with --led-face and write --on-accent-ink on it").toEqual([]);
  });
});
