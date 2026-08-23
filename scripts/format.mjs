#!/usr/bin/env node
// Runs Prettier over this repository, on a file list DERIVED rather than written down.
//
// It is derived because another check depends on the two sets agreeing. The comment
// provenance check reads a JavaScript or TypeScript file as the union of three lexings, and
// the union has one false positive: a regex whose closing slash is followed immediately by a
// division, so the two slashes touch and the pair reads as a line comment. Formatted text
// cannot hold that shape, because Prettier puts a space between them — but that argument is
// only as wide as the formatter's reach, and written as a glob list the checker read `*.mjs`
// at the repository root while `pnpm format` did not. A valid file there failed the check,
// and formatting it changed nothing.
//
// So the JavaScript half of this list is exactly what the checker scans. Widening the
// checker widens the formatter in the same edit, and neither can be narrowed alone.
//
// Usage: node scripts/format.mjs [prettier args…]

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { extname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { trackedSources } from "./check-comment-provenance.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The extensions Prettier parses, out of everything the provenance checker reads. Rust,
 *  shell, TOML and Python it does not; YAML it does, and formatting seventeen workflows to
 *  buy nothing is a diff nobody asked for — the union's false positive is a JavaScript
 *  shape, and every other dialect is read exactly once. */
const FORMATTED = new Set([".ts", ".mjs", ".cjs", ".js", ".css", ".html"]);
/** The half the provenance check's argument rests on. */
export const JS_FAMILY = new Set([".ts", ".mjs", ".cjs", ".js"]);

/** The repo-relative files to format, out of a list of absolute source paths. */
export function formatTargets(sources) {
  return sources
    .filter((path) => FORMATTED.has(extname(path).toLowerCase()))
    .map((path) => relative(ROOT, path).split("\\").join("/"))
    .sort();
}

// Real paths on both sides: node resolves the entry module's symlinks and leaves argv[1] as
// typed, and read as "not the program" this formats nothing while exiting 0.
const invokedDirectly = (() => {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  const files = formatTargets(trackedSources());
  if (!files.length) {
    console.error("No source files to format. That is not a formatted tree, it is a broken list.");
    process.exit(1);
  }
  execFileSync(
    process.execPath,
    ["node_modules/prettier/bin/prettier.cjs", "--write", ...process.argv.slice(2), ...files],
    {
      cwd: ROOT,
      stdio: "inherit",
    },
  );
}
