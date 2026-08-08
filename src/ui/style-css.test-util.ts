// The stylesheet, as text, for the contract tests that hold two layers against each
// other. Not a test file itself (vitest collects only *.test.ts), so suites import it
// instead of re-declaring the reader.
//
// Text rather than a parsed CSSOM on purpose: the app's own `style.css` is the artifact
// under test, not a copy of it, and jsdom would only report what it managed to parse.
// The cost is that these helpers depend on the file's formatting — a selector followed
// by ` {`, a closing brace at column 0, which Prettier guarantees here. Keeping them in
// one place is what makes that dependency findable when the formatting changes.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// __dirname rather than import.meta.url: these run under jsdom, where the module URL is
// an http: one and cannot be turned back into a path.
export const CSS = readFileSync(resolve(__dirname, "../style.css"), "utf8");

/** The two blocks the palette lives in. Dark is the bare `:root`; light overrides it. */
export const THEME_SELECTOR = {
  dark: ":root",
  light: '[data-theme="light"]',
} as const;

export type Theme = keyof typeof THEME_SELECTOR;

/** The custom properties declared in one selector's block, as a plain map. */
export function tokensIn(selector: string): Record<string, string> {
  const at = CSS.indexOf(selector + " {");
  if (at < 0) throw new Error(`${selector} not found in style.css`);
  const body = CSS.slice(at, CSS.indexOf("\n}", at));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)) out[m[1]] = m[2].trim();
  return out;
}

export interface CssRule {
  /** The selector list, whitespace collapsed. */
  selector: string;
  /** The declaration body, braces excluded. */
  body: string;
}

/** Every rule in the stylesheet, selector + declarations. Comments are stripped first,
 *  so a recipe quoted in prose is never read as a declaration. Parsed once. */
export const RULES: CssRule[] = [...CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
  (m) => ({ selector: m[1].replace(/\s+/g, " ").trim(), body: m[2] }),
);

/** One declaration's value from a rule body, or undefined. The LAST one declared, not
 *  the first: inside a single block source order decides, so the progressive-enhancement
 *  idiom `background: <fallback>; background: <modern>;` is the modern value, and a
 *  caller reading the first would answer with the value the browser discards — in both
 *  directions, since a guard that reads the fallback misses a bad modern value and a
 *  guard that reads a bad fallback fails on a rule that is correct. (Specificity plays
 *  no part here: two rules matching the same element are never joined by this helper.) */
export function decl(body: string, prop: string): string | undefined {
  return [...body.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]+)`, "g"))].at(-1)?.[1].trim();
}

/** The face a rule paints, whichever of the three background properties names it, taking
 *  the last in source order. The shorthand alone is not enough: `--seg` is a gradient, so
 *  `background-image: var(--seg)` is valid CSS a `background`-only read is blind to, as is
 *  `background-color: var(--led)`. Layering is deliberately not modelled — no rule in this
 *  stylesheet declares more than one of the three, and a layer-reset model would be
 *  speculation; reading the last of the three is what that case degrades to. */
export function faceDecl(body: string): string | undefined {
  return decl(body, "background(?:-color|-image)?");
}
