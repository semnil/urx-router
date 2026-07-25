#!/usr/bin/env node
// Flags Markdown tables that a GFM renderer will not render as a table.
//
// A table is only recognised when a header row is immediately followed by a
// delimiter row ("| --- |"). Inserting a paragraph or a list in the middle of a
// table and then resuming the rows leaves the resumed rows without that pair, so
// they render as literal "| a | b |" text instead of cells.
//
//   node scripts/check-md-tables.mjs [path ...]  check files/directories (default: cwd)
//   node scripts/check-md-tables.mjs --hook      check the file named in a Claude Code
//                                                PostToolUse payload read from stdin
//
// Exits 1 on findings; --hook exits 2 so the message is fed back to Claude.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

const SKIP_ANYWHERE = new Set(["node_modules", ".git"]);
// Matched against the path relative to the scan root, so a documentation
// directory that happens to be named "dist" deeper in the tree still gets read.
// The nested private reference repository runs this same script itself.
const SKIP_PATHS = new Set(["dist", "reference", "src-tauri/target", ".claude/skills/urx-routing-planner-workspace"]);

const TABLE_ROW = /^\s{0,3}\|/;
const DELIMITER_ROW = /^\s{0,3}\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*\|?\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;

// A table inside a blockquote carries a "> " prefix on every line.
const unquote = (line) => line.replace(/^\s{0,3}(?:>\s?)+/, "");

function collect(root, dir = root, found = []) {
  if (statSync(dir).isFile()) {
    if (extname(dir).toLowerCase() === ".md") found.push(dir);
    return found;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const rel = relative(root, path).split(sep).join("/");
      if (!SKIP_ANYWHERE.has(entry.name) && !SKIP_PATHS.has(rel)) collect(root, path, found);
    } else if (extname(entry.name).toLowerCase() === ".md") {
      found.push(path);
    }
  }
  return found;
}

function check(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const broken = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = unquote(lines[i]);
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !TABLE_ROW.test(line)) continue;
    let end = i;
    while (end < lines.length && TABLE_ROW.test(unquote(lines[end]))) end++;
    const run = lines.slice(i, end).map(unquote);
    // A lone pipe line is prose; two or more without a delimiter row is a table
    // that lost its header.
    if (run.length >= 2 && !DELIMITER_ROW.test(run[1])) {
      broken.push({ start: i + 1, end, count: run.length, sample: run[0].trim().slice(0, 100) });
    }
    i = end - 1;
  }
  return broken;
}

function report(files, base) {
  let total = 0;
  for (const file of files) {
    for (const hit of check(file)) {
      total++;
      console.error(
        `${relative(base, file)}:${hit.start}-${hit.end}: ${hit.count} rows render as text, not a table ` +
          `(the row after the first one is not a "| --- |" delimiter)\n    ${hit.sample}`,
      );
    }
  }
  return total;
}

if (process.argv.includes("--hook")) {
  let file;
  try {
    file = JSON.parse(readFileSync(0, "utf8"))?.tool_input?.file_path;
  } catch {
    process.exit(0);
  }
  if (!file || extname(file).toLowerCase() !== ".md" || !existsSync(file)) process.exit(0);
  process.exit(report([file], process.cwd()) ? 2 : 0);
}

const roots = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const files = (roots.length ? roots : [process.cwd()]).flatMap((root) => collect(root));
const total = report(files, process.cwd());
if (total) {
  console.error(`\n${total} broken table(s) across ${files.length} Markdown file(s)`);
  process.exit(1);
}
console.log(`OK: ${files.length} Markdown file(s), no broken tables`);
