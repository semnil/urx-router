// The stylesheet's scales, held where the design system states them: a value off its scale
// is a control that looks almost like its neighbours, which no other check notices and no
// screen shows plainly. Each rule reads the whole stylesheet, so a value added tomorrow is
// held the day it is written.
//
//   hover      a hovered control brightens by one amount per theme (1.12 dark, 0.97 light)
//   popover    a popover tied to a control (the z-index 60 rung) casts one shadow
//   gap        spacing between items takes a value from one scale
//   learn      the MIDI learn ring keeps a round control's own radius
//   dim ink    the dim text tier clears APCA Lc 60 on every ground of its theme
import { describe, expect, it } from "vitest";
import { RULES, THEME_SELECTOR, decl, tokensIn } from "./style-css.test-util";

const parts = (selector: string): string[] => selector.split(",").map((s) => s.trim());

// APCA 0.0.98G, light-on-dark and dark-on-light, as the magnitude of Lc.
const luminance = (hex: string): number => {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => (c / 255) ** 2.4;
  return 0.2126729 * lin(n >> 16) + 0.7151522 * lin((n >> 8) & 255) + 0.072175 * lin(n & 255);
};
const apcaLc = (text: string, ground: string): number => {
  const clamp = (y: number) => (y > 0.022 ? y : y + (0.022 - y) ** 1.414);
  const t = clamp(luminance(text));
  const b = clamp(luminance(ground));
  const c = b > t ? (b ** 0.56 - t ** 0.57) * 1.14 : (t ** 0.62 - b ** 0.65) * 1.14;
  return c < 0.1 ? 0 : (c - 0.027) * 100;
};

describe("the stylesheet keeps to its scales", () => {
  it("a hover brightens by 1.12 in the dark theme and 0.97 in the light one", () => {
    const off: string[] = [];
    let seen = 0;
    for (const rule of RULES) {
      const value = decl(rule.body, "filter")?.match(/^brightness\(([^)]+)\)$/)?.[1];
      if (value === undefined) continue;
      for (const part of parts(rule.selector)) {
        if (part.includes(":active")) continue; // a press darkens; that is its own state
        seen++;
        const want = part.startsWith('[data-theme="light"]') ? "0.97" : "1.12";
        if (value !== want) off.push(`${part} → ${value} (want ${want})`);
      }
    }
    expect(seen, "found no hover brightness at all").toBeGreaterThan(10);
    expect(off).toEqual([]);
  });

  it("every popover on the control rung casts the popover shadow", () => {
    const popovers = RULES.filter((r) => decl(r.body, "z-index") === "60");
    expect(popovers.length, "the z-index 60 rung is empty").toBeGreaterThan(2);
    const off = popovers
      .filter((r) => decl(r.body, "box-shadow") !== "0 10px 26px rgba(0, 0, 0, 0.6)")
      .map((r) => `${r.selector} → ${decl(r.body, "box-shadow")}`);
    expect(off).toEqual([]);
  });

  it("every gap takes a value from the spacing scale", () => {
    const SCALE = new Set([0, 2, 3, 4, 6, 8, 10, 12, 14, 16, 26, 32]);
    const off: string[] = [];
    let seen = 0;
    for (const rule of RULES) {
      for (const prop of ["gap", "row-gap", "column-gap"]) {
        const value = decl(rule.body, prop);
        if (value === undefined) continue;
        for (const token of value.split(/\s+/)) {
          seen++;
          const px = token === "0" ? 0 : Number(token.match(/^(\d+(?:\.\d+)?)px$/)?.[1] ?? NaN);
          if (!SCALE.has(px)) off.push(`${rule.selector} { ${prop}: ${value} }`);
        }
      }
    }
    expect(seen, "found no gap at all").toBeGreaterThan(30);
    expect(off).toEqual([]);
  });

  it("no learn-ring radius reaches a round knob", () => {
    // The ring follows each control's own radius; a rule that gives `.midi-target` one has
    // to leave the knob out, or a learn draws a square around a round control.
    const squaring = RULES.flatMap((r) => (decl(r.body, "border-radius") === undefined ? [] : parts(r.selector)))
      // A pseudo-element (the mapped dot) is a mark of its own, not the ring.
      .filter((part) => /\.midi-target\b/.test(part) && !/::(before|after)$/.test(part))
      .filter((part) => !/:not\(\.con-knob\)/.test(part));
    expect(squaring).toEqual([]);
  });

  it.each(Object.keys(THEME_SELECTOR) as (keyof typeof THEME_SELECTOR)[])(
    "the %s dim ink clears Lc 60 on every ground it lands on",
    (theme) => {
      const tok = { ...tokensIn(THEME_SELECTOR.dark), ...tokensIn(THEME_SELECTOR[theme]) };
      // The flat grounds, plus every stop of the toolbar gradient: its lighter end is the
      // hardest ground the dim tier sits on there.
      const grounds = ["--panel", "--canvas-bg", "--bar-solid", "--ctl-bg", "--ctl-bg2"].map((k) => [k, tok[k]]);
      for (const stop of tok["--bar"].match(/#[0-9a-f]{6}/gi) ?? []) grounds.push(["--bar", stop]);
      expect(grounds.length, "the --bar gradient carries no hex stop").toBeGreaterThan(6);
      const off = grounds
        .map(([k, g]) => [k, g, apcaLc(tok["--text-dim"], g)] as const)
        .filter(([, , lc]) => lc < 60)
        .map(([k, g, lc]) => `${tok["--text-dim"]} on ${k} ${g} → Lc ${lc.toFixed(1)}`);
      expect(off).toEqual([]);
    },
  );
});
