// A joined segmented bar is two rules that have to agree: the BUTTONS draw their own
// separators (`border: 0` plus a `border-right`, the last one dropped) and draw no
// outline of their own, so the CONTAINER is what supplies the frame — a border, the
// corner radius, and the `overflow: hidden` that makes the end buttons' faces stop at
// that radius instead of squaring it off. A button rule without its container rule is
// not a narrower bar; it is a row of unframed labels, and the buttons say nothing about
// which control they belong to.
//
// The subjects are DERIVED rather than listed: any selector `.foo button` that draws a
// separator is a joined bar, so a bar added tomorrow is checked the day its buttons are
// written. Listing them is what let one go missing — `.view-tabs` and `.udk-banks` lost
// their container rule to a new rule inserted between the comment above them and the
// selector below, which swallowed both into ITS selector list; they inherited a
// six-column grid meant for twelve semitone buttons and rendered as two unframed words
// spread across the toolbar.
import { describe, expect, it } from "vitest";
import { RULES } from "./style-css.test-util";

/** Every declaration that reaches a container, in source order, later winning. Several
 *  rules may carry one recipe between them (`.gt-notes` takes its frame from a bare
 *  rule and its layout from a more specific one), so the reading is their union rather
 *  than any single block. A selector part counts when its LAST compound names the
 *  container — `.prefs-row .ctl.gt-notes` styles a `.gt-notes`, `.gt-notes button`
 *  styles its child. */
function containerDecls(cls: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of RULES) {
    for (const part of rule.selector.split(",").map((s) => s.trim())) {
      const last = part.split(/[ >+~]+/).at(-1) ?? "";
      if (!last.split(/(?=[.:#[])/).includes(cls)) continue;
      for (const m of rule.body.matchAll(/(?:^|;)\s*([a-z-]+)\s*:([^;]+)/g)) out[m[1]] = m[2].trim();
    }
  }
  return out;
}

/** The bars, read off the buttons that draw their own separators. */
const BARS = [
  ...new Set(
    RULES.filter((r) => /border-right\s*:/.test(r.body)).flatMap((r) =>
      r.selector
        .split(",")
        .map((s) => /^(\.[\w-]+) button$/.exec(s.trim())?.[1])
        .filter((s): s is string => s !== undefined),
    ),
  ),
];

describe("joined segmented bars", () => {
  // A guard whose subject list can empty out passes loudest when the thing it watches
  // is gone, so the derivation is asserted before what it derived.
  it("finds every bar in the stylesheet", () => {
    expect(BARS).toEqual(expect.arrayContaining([".view-tabs", ".udk-banks", ".gt-modes", ".gt-notes"]));
  });

  it.each(BARS)("%s carries the container frame", (cls) => {
    const d = containerDecls(cls);
    // The frame. Without these the buttons keep their separators and lose the outline
    // that groups them, which is what the toolbar regression looked like.
    expect(d.border, `${cls}: no border`).toMatch(/\dpx/);
    expect(d["border-radius"], `${cls}: no border-radius`).toMatch(/\dpx/);
    expect(d.overflow, `${cls}: end buttons would square off the radius`).toBe("hidden");
    // Laid out along one axis. `grid` is allowed only where the rule says how many
    // tracks — `.gt-notes` wraps twelve toggles onto two rows on purpose; a bar that
    // says `grid` and names no tracks is one that inherited someone else's layout.
    expect(d.display, `${cls}: no display`).toMatch(/^(flex|grid)$/);
    if (d.display === "grid") expect(d["grid-template-columns"], `${cls}: grid with no tracks`).toBeTruthy();
  });
});
