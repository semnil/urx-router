// The wire palette exists twice and always has: `PALETTES` in ui/graph.ts draws the
// board (the SVG stroke is a presentation attribute, so a CSS variable cannot reach
// it), while `--w-*` in style.css draws everything that talks *about* a wire — the
// inspector legend's swatches, the routing list's dots, and the MIDI window's gang
// rail, which borrows the send colour to mean "these move together".
//
// Nothing kept the two in step. Recolouring a route meant editing both files, and
// missing one left half the surface on the old colour — with no test, no lint and no
// type to say so, in either direction. This is that guard: it parses the stylesheet
// as text (the app's own CSS is the artifact under test, not a copy of it) and holds
// it against the object the board is drawn from.
//
// It also pins the reduction itself. Six connection kinds share three colours because
// the other three distinctions are carried by geometry: `key` is a `source` into a
// ducker, `sendSwitch` is a `send` with an on/off, `record` is an output selection
// landing on a track. Re-splitting one means changing WIRE_GROUP, and that has to be
// a decision rather than a drift, so the mapping is written out here too.
// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CSS, THEME_SELECTOR, tokensIn } from "./style-css.test-util";
import { PALETTES, WIRE_GROUP, type WireGroup } from "./graph";
import { PLOT_TOKENS } from "./dyn-screen";
import type { ConnectionKind } from "../models/types";

const GROUPS: WireGroup[] = ["select", "send", "out"];

describe("the wire palette's two layers", () => {
  it.each(Object.keys(PALETTES) as (keyof typeof PALETTES)[])("%s: every group has the same value in both", (theme) => {
    const tokens = tokensIn(THEME_SELECTOR[theme]);
    for (const g of GROUPS) {
      expect(tokens[`--w-${g}`], `--w-${g} in ${THEME_SELECTOR[theme]}`).toBe(PALETTES[theme].wire[g]);
    }
  });

  it("declares exactly the three groups on each side — no orphan token, no orphan entry", () => {
    const declared = [...CSS.matchAll(/^\s*(--w-[a-z0-9-]+):/gm)].map((m) => m[1]);
    // Each group is declared once per theme and nowhere else.
    expect(declared.sort()).toEqual(GROUPS.flatMap((g) => [`--w-${g}`, `--w-${g}`]).sort());
    for (const theme of Object.keys(PALETTES) as (keyof typeof PALETTES)[]) {
      expect(Object.keys(PALETTES[theme].wire).sort()).toEqual([...GROUPS].sort());
    }
  });

  it("uses no --w-* token the palette does not define — in the stylesheet or in the sources", () => {
    // Both halves matter, and the second one is the one that bites. The legend's
    // shape swatches are built in TypeScript and set `style.stroke = "var(--w-…)"`,
    // where a dangling token is an invalid value: the declaration is dropped and the
    // swatch renders with no colour at all. Caught exactly that way once — the Rec
    // Point tap row kept `--w-record` through the reduction and drew in the old
    // violet until the token vanished under it.
    const sources: Record<string, string> = { "style.css": CSS };
    const dir = resolve(__dirname, "..");
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = resolve(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
          sources[p.slice(dir.length + 1)] = readFileSync(p, "utf8");
      }
    };
    walk(dir);
    const allowed = GROUPS.map((g) => `--w-${g}`);
    for (const [where, text] of Object.entries(sources)) {
      for (const m of text.matchAll(/var\((--w-[a-z0-9-]+)\)/g)) {
        expect(allowed, `${where} reads ${m[1]}`).toContain(m[1]);
      }
    }
  });

  it("has a .dot-<group> class for each group, reading that group's token", () => {
    for (const g of GROUPS) {
      const at = CSS.indexOf(`.dot-${g} {`);
      expect(at, `.dot-${g} missing`).toBeGreaterThanOrEqual(0);
      expect(CSS.slice(at, CSS.indexOf("}", at))).toContain(`var(--w-${g})`);
    }
    // A dot named after a connection kind would be a leftover from the six-colour
    // shape and would silently render with no background.
    const kinds: ConnectionKind[] = ["source", "send", "sendSwitch", "patch", "key", "record"];
    for (const k of kinds) {
      if (GROUPS.includes(k as WireGroup)) continue;
      expect(CSS.includes(`.dot-${k} {`), `.dot-${k} outlived the reduction`).toBe(false);
    }
  });

  it("maps every connection kind to a group, and every group is used", () => {
    expect(WIRE_GROUP).toEqual({
      source: "select",
      key: "select",
      send: "send",
      sendSwitch: "send",
      patch: "out",
      record: "out",
    });
    expect(new Set(Object.values(WIRE_GROUP))).toEqual(new Set(GROUPS));
  });

  it("draws on a canvas with tokens the canvas is actually handed", () => {
    // The other half of the dangling-token defect, on the canvas instead of the
    // stylesheet. A plot is handed PLOT_TOKENS and nothing else, so `tok["--text-dim"]`
    // reads undefined — and assigning undefined to `fillStyle` is IGNORED by canvas
    // rather than refused, leaving whatever colour the previous draw set. The measured
    // case: the compander's window and threshold marks came out in `--gr`, the ink that
    // means gain reduction, because the annotation before them had set it.
    // `__dirname`, not `import.meta.url`: this file is transformed and its module URL is
    // the served path, which is not a directory on disk — the same `resolve(__dirname, …)`
    // the source scan above uses.
    const dir = resolve(__dirname);
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.includes(".test"));
    const dangling: string[] = [];
    let reads = 0;
    for (const f of sources) {
      for (const m of readFileSync(resolve(dir, f), "utf8").matchAll(/tok\["(--[a-z0-9-]+)"\]/g)) {
        reads++;
        if (!(PLOT_TOKENS as readonly string[]).includes(m[1])) dangling.push(`${f}: ${m[1]}`);
      }
    }
    expect(dangling).toEqual([]);
    // The positive control: the scan found token reads at all. Zero of them would satisfy
    // the assertion above for the reason it exists to catch.
    expect(reads).toBeGreaterThan(20);
  });

  it("keeps the borrowed gang rail on the send colour", () => {
    // The MIDI window's linked-row rail is not a wire; it borrows the send colour to
    // say "these move together". If the token is ever renamed, this is the one reader
    // outside the graph that a grep for "wire" will not find.
    const at = CSS.indexOf(".mw-list tr.linked td:first-child::before");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(CSS.slice(at, CSS.indexOf("}", at))).toContain("var(--w-send)");
  });
});
