// The stylesheet's scales, held where the design system states them: a value off its scale
// is a control that looks almost like its neighbours, which no other check notices and no
// screen shows plainly. Each rule reads the whole stylesheet, so a value added tomorrow is
// held the day it is written.
//
//   hover      a hovered control brightens by one amount per theme (1.12 dark, 0.97 light)
//   popover    a popover tied to a control (the z-index 60 rung) casts one shadow
//   gap        spacing between items takes a value from one scale
//   learn      the MIDI learn ring keeps a round control's own radius
import { describe, expect, it } from "vitest";
import { RULES, decl } from "./style-css.test-util";

const parts = (selector: string): string[] => selector.split(",").map((s) => s.trim());

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
});
