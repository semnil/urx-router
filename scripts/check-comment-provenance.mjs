#!/usr/bin/env node
// Flags a source comment that records where a fact CAME FROM instead of what the code does.
//
// A comment carries the behaviour and the assumptions the code rests on. A reading, a
// capture date, or a hedge naming the run that established a fact is a derivation: it goes
// stale at the next measurement, and it has a home already — the pull request, the
// documents under docs/, or the private ledgers. Two shapes are enforced:
//
//   provenance hedge   "(measured)", "-- measured", "Measured on a URX44V", "measured by
//                      driving ...". The claim beside it stays; only the sourcing goes.
//   capture date       an ISO date in a comment, which is a reading's timestamp and is
//                      wrong the moment anyone re-measures.
//
// The word itself is NOT the target: "the level meters are measured" describes the data,
// and "the measured EQ model" names a model. Only the shapes above are refused, which is
// deliberate — a checker wide enough to catch every phrasing teaches evasion instead.
//
// COMMENTS ONLY. `Object.entries(measured)` is an identifier and must not be reported, so
// the file is lexed rather than grepped.
//
// THE LEDGER. This idiom predates the rule by a long way — 318 comments across 103 files
// carried it when the check was written — and removing them in one sweep would be a
// comment-only diff across a third of the tree, which no one can review and which deletes
// provenance that in places has no other home. So `comment-provenance-baseline.json` holds
// a per-file CEILING: a file may carry what it carried, and no more. A new one fails, and a
// file that has been cleaned prints its lower count in the ledger's own shape so lowering it
// is a paste. What the ceiling cannot see is a file cleaned and later re-dirtied back up to
// its old number; the count is the thing being watched, not which lines it came from.
//
//   node scripts/check-comment-provenance.mjs [path ...]  check files/directories (cwd)
//   node scripts/check-comment-provenance.mjs --hook      check the file named in a Claude
//                                                         Code PostToolUse payload on stdin
//   node scripts/check-comment-provenance.mjs --update    rewrite the ledger from the tree
//
// Exits 1 on findings above the ledger; --hook exits 2 so the message is fed back to Claude.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

const SKIP_ANYWHERE = new Set(["node_modules", ".git", "dist", "dist-trace", "coverage"]);
const SKIP_PATHS = new Set(["reference", "src-tauri/target", ".claude/skills/urx-routing-planner-workspace"]);
const EXTS = new Set([".ts", ".tsx", ".mjs", ".cjs", ".js", ".css"]);
// This checker and its own pins quote the shapes they refuse, so they are not scanned.
const SELF = /(^|\/)check-comment-provenance(\.test)?\.mjs$/;

/** The enforced shapes, each named for what it is so the finding can say it. */
const RULES = [
  {
    id: "hedge-parenthetical",
    // "(measured)" / "(measured, ...)" — the appositive that says where a fact came from.
    re: /\((?:measured|実測)\b[^)]*\)/gi,
    say: "a parenthetical naming the run behind the claim",
  },
  {
    id: "hedge-dash",
    // "-- measured, ..." / "— measured." — the same appositive, set off by a dash.
    re: /(?:—|--)\s*(?:measured|実測)\b/gi,
    say: "a dash appositive naming the run behind the claim",
  },
  {
    id: "hedge-sentence",
    // "Measured on a URX44V", "Measured with the faces rendered", "measured by driving ...".
    // `against` and `in` are deliberately absent: "the drag is measured against the cap"
    // and "measured in ms" are the code's own vocabulary, and a rule that cannot tell them
    // from provenance would be teaching people to reword rather than to move the reading.
    re: /\b(?:measured|実測)\s+(?:on|at|with|by|before)\b/gi,
    say: "a sentence recording how the fact was measured",
  },
  {
    id: "capture-date",
    // A reading's timestamp. Dates belong to the run, and the run is written up elsewhere.
    re: /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/g,
    say: "a capture date",
  },
];

/**
 * Comment spans of one source file, as {line, text}.
 *
 * A hand lexer rather than a parser: it has to tell a comment from a string and from a
 * regex literal, and nothing more. The regex/division ambiguity is resolved by what
 * precedes the slash — after a value a `/` divides, after an operator or an opener it
 * starts a pattern — which is the rule that matters here because a pattern can contain
 * `//` and a division cannot.
 */
export function comments(src, css = false) {
  const out = [];
  let line = 1;
  let i = 0;
  let prev = ""; // last significant character, for the regex/division decision
  const push = (startLine, text) => {
    text.split("\n").forEach((t, n) => out.push({ line: startLine + n, text: t }));
  };
  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (!css && two === "//") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      push(line, src.slice(i + 2, stop));
      i = stop;
      continue;
    }
    if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end;
      const body = src.slice(i + 2, stop);
      push(line, body);
      line += (src.slice(i, stop).match(/\n/g) ?? []).length;
      i = stop + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") i++;
        else if (src[i] === "\n") line++;
        i++;
      }
      i++;
      prev = "x";
      continue;
    }
    if (!css && c === "/" && /[({[,;:=!&|?+\-*%<>~^]|^$/.test(prev)) {
      // A regex literal: skip to its unescaped closing slash, staying on one line.
      let j = i + 1;
      let cls = false;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") cls = true;
        else if (src[j] === "]") cls = false;
        else if (src[j] === "/" && !cls) break;
        j++;
      }
      if (src[j] === "/") {
        i = j + 1;
        prev = "x";
        continue;
      }
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

/** Findings in one file's comments. */
export function findingsIn(src, path) {
  const css = extname(path).toLowerCase() === ".css";
  const found = [];
  for (const { line, text } of comments(src, css)) {
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      for (const m of text.matchAll(rule.re))
        found.push({ path, line, rule: rule.id, say: rule.say, hit: m[0].trim() });
    }
  }
  return found;
}

function collect(root, dir = root, found = []) {
  if (statSync(dir).isFile()) {
    if (EXTS.has(extname(dir).toLowerCase()) && !SELF.test(dir.split(sep).join("/"))) found.push(dir);
    return found;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = relative(root, path).split(sep).join("/");
    if (entry.isDirectory()) {
      if (!SKIP_ANYWHERE.has(entry.name) && !SKIP_PATHS.has(rel)) collect(root, path, found);
    } else if (EXTS.has(extname(entry.name).toLowerCase()) && !SELF.test(rel)) {
      found.push(path);
    }
  }
  return found;
}

const LEDGER = new URL("./comment-provenance-baseline.json", import.meta.url);

/** The per-file ceilings, keyed by repo-relative path. */
export function readLedger() {
  try {
    return JSON.parse(readFileSync(LEDGER, "utf8")).files ?? {};
  } catch {
    return {};
  }
}

/** Findings grouped by repo-relative path. */
export function byFile(found, root = ".") {
  const out = {};
  for (const f of found) {
    const key = relative(root, f.path).split(sep).join("/");
    (out[key] ??= []).push(f);
  }
  return out;
}

/**
 * The ledger's verdict on one scan: what is over its ceiling, and what is under it.
 *
 * A file the ledger does not name has a ceiling of zero, which is what makes a NEW comment
 * fail rather than quietly joining the backlog.
 */
export function verdict(grouped, ledger) {
  const over = [];
  const under = [];
  for (const [path, findings] of Object.entries(grouped)) {
    const ceiling = ledger[path] ?? 0;
    if (findings.length > ceiling) over.push({ path, ceiling, count: findings.length, findings });
    else if (findings.length < ceiling) under.push({ path, ceiling, count: findings.length });
  }
  for (const path of Object.keys(ledger)) {
    if (!grouped[path]) under.push({ path, ceiling: ledger[path], count: 0 });
  }
  over.sort((a, b) => a.path.localeCompare(b.path));
  under.sort((a, b) => a.path.localeCompare(b.path));
  return { over, under };
}

const report = (found) => {
  for (const f of found) {
    console.error(`${f.path}:${f.line}  ${f.say}: ${JSON.stringify(f.hit)}`);
  }
  console.error(
    `\n${found.length} comment(s) record where a fact came from. Keep the claim; move the run,` +
      ` the reading and the date to the pull request or to docs/, which is where they stay findable.`,
  );
};

const hook = process.argv.includes("--hook");
if (hook) {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let path;
  try {
    path = JSON.parse(raw)?.tool_input?.file_path;
  } catch {
    process.exit(0);
  }
  if (!path || !EXTS.has(extname(path).toLowerCase()) || SELF.test(path.split(sep).join("/"))) process.exit(0);
  if (!existsSync(path)) process.exit(0);
  const found = findingsIn(readFileSync(path, "utf8"), path);
  if (!found.length) process.exit(0);
  report(found);
  process.exit(2);
}

const roots = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const scanRoots = roots.length ? roots : ["src", "e2e", "scripts"];
const targets = scanRoots.flatMap((r) => (existsSync(r) ? collect(r) : []));
const found = targets.flatMap((p) => findingsIn(readFileSync(p, "utf8"), p));
const grouped = byFile(found);

if (process.argv.includes("--update")) {
  const files = Object.fromEntries(
    Object.entries(grouped)
      .map(([path, f]) => [path, f.length])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(
    LEDGER,
    JSON.stringify(
      {
        note: "Per-file ceiling for comments that record a fact's provenance. See scripts/check-comment-provenance.mjs. A file may carry what it carried and no more; a cleaned file's lower count belongs here.",
        files,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`ledger written: ${Object.keys(files).length} file(s), ${found.length} finding(s)`);
  process.exit(0);
}

const { over, under } = verdict(grouped, readLedger());
if (over.length) {
  for (const f of over) {
    console.error(`${f.path}: ${f.count} finding(s), ledger allows ${f.ceiling}`);
    for (const x of f.findings) console.error(`  ${f.path}:${x.line}  ${x.say}: ${JSON.stringify(x.hit)}`);
  }
  console.error(
    `\n${over.length} file(s) above the ledger. Keep the claim; move the run, the reading and` +
      ` the date to the pull request or to docs/, which is where they stay findable.`,
  );
  process.exit(1);
}
const total = found.length;
console.log(`OK: ${targets.length} source file(s), ${total} ledgered finding(s), none above its ceiling`);
if (under.length) {
  console.log(`\n${under.length} file(s) now carry fewer than the ledger allows. Paste to lower it:`);
  for (const f of under)
    console.log(`    ${JSON.stringify(f.path)}: ${f.count},${f.count ? "" : "   // (delete the row)"}`);
}
