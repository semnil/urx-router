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
//   node scripts/check-comment-provenance.mjs --update    LOWER the ledger to what the tree
//                                                         now carries; it refuses to raise
//   node scripts/check-comment-provenance.mjs --reseed    take the counts as they are, for a
//                                                         RULE change that grows the corpus
//
// Exits 1 on findings above the ledger; --hook exits 2 so the message is fed back to Claude.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_ANYWHERE = new Set(["node_modules", ".git", "dist", "dist-trace", "coverage"]);
const SKIP_PATHS = new Set(["reference", "src-tauri/target", ".claude/skills/urx-routing-planner-workspace"]);
// `.tsx` is deliberately absent. JSX text is neither code nor a comment, and read as code a
// URL in it opens a line comment at the `//` — `<div>https://x.test/(measured)</div>` was
// reported as a finding. This tree carries no JSX at all, so lexing it would be a state
// machine written against no input; the day one arrives, the extension and the JSX state go
// in together rather than the extension alone.
const EXTS = new Set([".ts", ".mjs", ".cjs", ".js", ".css"]);
// This checker and its own pins quote the shapes they refuse, so they are not scanned.
const SELF = /(^|\/)check-comment-provenance(\.test)?\.mjs$/;

/** The enforced shapes, each named for what it is so the finding can say it. */
const RULES = [
  {
    id: "hedge-parenthetical",
    // "(measured)" / "(measured, ...)" — the appositive that says where a fact came from.
    // `\b` is asserted only around the LATIN word: JavaScript's word class is ASCII, so a
    // boundary next to 実 or 測 never matches and the Japanese half would silently never
    // fire. The full-width parenthesis is the pair that form is actually written in.
    re: /[(（](?:measured\b|実測)[^)）]*[)）]/gi,
    say: "a parenthetical naming the run behind the claim",
  },
  {
    id: "hedge-dash",
    // "-- measured, ..." / "— measured." — the same appositive, set off by a dash.
    re: /(?:—|--)\s*(?:measured\b|実測)/gi,
    say: "a dash appositive naming the run behind the claim",
  },
  {
    id: "hedge-sentence",
    // "Measured on a URX44V", "Measured with the faces rendered", "measured by driving ...".
    // `against` and `in` are deliberately absent: "the drag is measured against the cap"
    // and "measured in ms" are the code's own vocabulary, and a rule that cannot tell them
    // from provenance would be teaching people to reword rather than to move the reading.
    re: /\bmeasured\s+(?:on|at|with|by|before)\b/gi,
    say: "a sentence recording how the fact was measured",
  },
  {
    id: "hedge-sentence-ja",
    // The same sentence in Japanese. Its boundary is the particle or punctuation that
    // follows, not `\b` — and a following Latin word (実測 on a URX44V) counts too, which
    // is the shape a mixed comment takes.
    // 値 is deliberately absent: 実測値 NAMES the data, the way "the measured EQ model"
    // does in English, and refusing it would be refusing the thing rather than its sourcing.
    // 日 stays — a measurement's DATE is provenance whatever language it is written in.
    re: /実測(?:[でにをはがのしすさ済日]|[:：]|\s*[A-Za-z(（])/g,
    say: "a sentence recording how the fact was measured",
  },
  {
    id: "capture-date",
    // A reading's timestamp. Dates belong to the run, and the run is written up elsewhere.
    re: /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/g,
    say: "a capture date",
  },
];

// Whether a `/` opens a PATTERN or divides is not decidable from the preceding character:
// `)` ends a value after a call and starts an expression after `if (…)`, `}` ends a value
// after an object literal and starts one after a block, and `+` is an operator in `a + /re/`
// and part of a postfix `++` in `x++ / 2`. So the lexer carries the goal as STATE, the way
// the grammar does: the last significant token, plus a stack per bracket kind saying what
// that bracket was.

/** After these keywords a `/` opens a PATTERN; after any other name — an identifier, or a
 *  keyword that IS a value like `this` — it divides. */
const REGEX_AFTER = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "case",
  "do",
  "else",
  "yield",
  "await",
  "new",
  "delete",
  "void",
  "throw",
]);
/** A `(` that follows one of these heads a control structure, so its `)` does not end a
 *  value and a `/` after it opens a pattern. Every other `(` is a call or a group. */
const CONTROL_HEADS = new Set(["if", "for", "while", "with", "switch", "catch"]);
/** A `{` after one of these is an OBJECT literal, because each demands an expression. After
 *  anything else — a `)`, a `;`, `=>`, another block, the start of input — it is a block. */
const OBJECT_AFTER = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "instanceof",
  "yield",
  "await",
  "new",
  "delete",
  "void",
  "throw",
]);

const isIdStart = (c) => /[A-Za-z_$]/.test(c);
const isIdPart = (c) => /[A-Za-z0-9_$]/.test(c);

/**
 * Comment spans of one source file, as {line, text}.
 *
 * A hand lexer rather than a parser: it has to tell a comment from a string, a template and
 * a regex literal, and nothing more. The goal is carried as STATE — the last significant
 * token, and a stack per bracket kind recording what that bracket was — because the
 * preceding CHARACTER cannot decide it.
 */
export function comments(src, css = false) {
  const out = [];
  let line = 1;
  let i = 0;
  // {kind: "value"|"name"|"punct", text, regexOk?, paren?, brace?, postfix?}
  let last = null;
  const parens = []; // "control" | "call"
  const braces = []; // "block" | "object"
  const tpl = []; // the brace-stack depth each open `${` returns to

  const push = (startLine, text) => {
    text.split("\n").forEach((t, n) => out.push({ line: startLine + n, text: t }));
  };
  const value = () => (last = { kind: "value", text: "" });
  const punct = (text, extra = {}) => (last = { kind: "punct", text, ...extra });
  const afterDot = () => last?.kind === "punct" && last.text === ".";
  /** True where the grammar would be looking for an expression, so a `/` opens a pattern. */
  const regexAllowed = () => {
    if (!last) return true;
    if (last.kind === "value") return false;
    if (last.kind === "name") return last.regexOk;
    const t = last.text;
    if (t === ")") return last.paren === "control";
    if (t === "}") return last.brace === "block";
    if (t === "]") return false;
    if (t === "++" || t === "--") return !last.postfix;
    return true;
  };
  /** Whether the token just read ends a value, which is what makes a `++` postfix. */
  const endsValue = () => {
    if (!last) return false;
    if (last.kind === "value") return true;
    if (last.kind === "name") return !last.regexOk;
    return last.text === ")" || last.text === "]";
  };
  const braceKind = () => {
    if (!last) return "block";
    if (last.kind === "name") return OBJECT_AFTER.has(last.text) ? "object" : "block";
    if (last.kind === "value") return "object";
    const t = last.text;
    return t === ")" || t === "]" || t === "}" || t === ";" || t === "{" || t === "=>" ? "block" : "object";
  };

  /** Consume a quoted string starting at `i`, which is its opening quote. */
  const quoted = (q) => {
    i++;
    while (i < src.length && src[i] !== q) {
      if (src[i] === "\\") i++;
      else if (src[i] === "\n") line++;
      i++;
    }
    i++;
  };
  /** Consume a template literal from its opening backtick, or from the `}` that resumed it,
   *  stopping at a `${`. Returns whether an interpolation opened. */
  const template = () => {
    i++;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "\n") line++;
      if (c === "`") {
        i++;
        return false;
      }
      if (c === "$" && src[i + 1] === "{") {
        i += 2;
        return true;
      }
      i++;
    }
    return false;
  };

  while (i < src.length) {
    const c = src[i];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (!css && two === "//") {
      const nl = src.indexOf("\n", i);
      const stop = nl === -1 ? src.length : nl;
      push(line, src.slice(i + 2, stop));
      i = stop;
      continue;
    }
    if (two === "/*") {
      const close = src.indexOf("*/", i + 2);
      const stop = close === -1 ? src.length : close;
      push(line, src.slice(i + 2, stop));
      line += (src.slice(i, stop).match(/\n/g) ?? []).length;
      i = stop + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      quoted(c);
      value();
      continue;
    }
    if (!css && c === "`") {
      if (template()) tpl.push(braces.length);
      value();
      continue;
    }
    if (isIdStart(c)) {
      let j = i;
      while (j < src.length && isIdPart(src[j])) j++;
      const text = src.slice(i, j);
      const property = afterDot();
      last = { kind: "name", text, regexOk: !property && REGEX_AFTER.has(text) };
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9a-fA-FxXoObBnEe._]/.test(src[j])) j++;
      i = j;
      value();
      continue;
    }
    if (!css && c === "/") {
      if (regexAllowed()) {
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
          while (i < src.length && isIdPart(src[i])) i++; // flags
          value();
          continue;
        }
      }
      punct("/");
      i++;
      continue;
    }
    if (c === "(") {
      parens.push(last?.kind === "name" && CONTROL_HEADS.has(last.text) ? "control" : "call");
      punct("(");
      i++;
      continue;
    }
    if (c === ")") {
      punct(")", { paren: parens.pop() ?? "call" });
      i++;
      continue;
    }
    if (c === "{") {
      braces.push(braceKind());
      punct("{");
      i++;
      continue;
    }
    if (c === "}") {
      if (tpl.length && tpl[tpl.length - 1] === braces.length) {
        tpl.pop();
        i--; // template() steps past one character, and this `}` is it
        if (template()) tpl.push(braces.length);
        value();
        continue;
      }
      punct("}", { brace: braces.pop() ?? "block" });
      i++;
      continue;
    }
    if (two === "++" || two === "--") {
      punct(two, { postfix: endsValue() });
      i += 2;
      continue;
    }
    if (two === "=>") {
      punct("=>");
      i += 2;
      continue;
    }
    punct(c);
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
// The ledger is keyed by repo-relative path, and the hook is handed an absolute one. This
// script lives in <root>/scripts/, which is what makes the root derivable without asking
// git — the hook runs with no cwd guarantee of its own.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const repoPath = (path) => relative(ROOT, resolve(path)).split(sep).join("/");

/**
 * True when a `relative()` result leaves the root it was taken from.
 *
 * `startsWith("..")` is not that test on Windows: `relative()` between two DRIVES cannot
 * express the step, so it returns the target ABSOLUTE — `C:\tmp\x.ts` against a repo on
 * `G:` — and a check for a leading `..` reads that as a path inside the tree with a ceiling
 * of zero. The same holds for a UNC root. `p` is the path module to reason with, so the
 * Windows semantics are testable from any platform.
 */
export function escapesRoot(rel, p = { isAbsolute, sep }) {
  return rel === ".." || rel.startsWith(".." + p.sep) || rel.startsWith("../") || p.isAbsolute(rel);
}

/** The per-file ceilings, keyed by repo-relative path. */
export function readLedger() {
  try {
    return JSON.parse(readFileSync(LEDGER, "utf8")).files ?? {};
  } catch {
    return {};
  }
}

/** Findings grouped by repo-relative path. */
export function byFile(found) {
  const out = {};
  for (const f of found) {
    const key = repoPath(f.path);
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
export function verdict(grouped, ledger, scanned = null) {
  const over = [];
  const under = [];
  // `scanned` is the set of paths this run actually read. A ledger row outside it was not
  // examined, and reporting it as emptied would name 102 files a one-file run never opened
  // — which is what the documented single-path invocation printed before this argument
  // existed. Null means the whole tree was read, and only then is an absent row a removal.
  const inScope = (path) => scanned === null || scanned.has(path);
  for (const [path, findings] of Object.entries(grouped)) {
    const ceiling = ledger[path] ?? 0;
    if (findings.length > ceiling) over.push({ path, ceiling, count: findings.length, findings });
    else if (findings.length < ceiling) under.push({ path, ceiling, count: findings.length });
  }
  for (const path of Object.keys(ledger)) {
    if (!grouped[path] && inScope(path)) under.push({ path, ceiling: ledger[path], count: 0 });
  }
  over.sort((a, b) => a.path.localeCompare(b.path));
  under.sort((a, b) => a.path.localeCompare(b.path));
  return { over, under };
}

/**
 * What the hook should do about one edited file: the same ceiling the scan applies.
 *
 * Its own function so it can be pinned rather than only hand-run. Refusing on any finding
 * at all — which is what the first version did — refuses every edit to each of the files
 * the ledger already names, so the backlog would stop the work instead of the other way
 * round. A path outside this repository has no row and never will, and reported by relative
 * path would read as "../../../tmp/x.ts", naming nothing.
 */
export function hookDecision(path, src, ledger) {
  const key = repoPath(path);
  if (escapesRoot(relative(ROOT, resolve(path))))
    return { exit: 0, key, ceiling: 0, findings: [], reason: "outside this repository" };
  const findings = findingsIn(src, path);
  const ceiling = ledger[key] ?? 0;
  return {
    exit: findings.length > ceiling ? 2 : 0,
    key,
    ceiling,
    findings,
    reason: findings.length > ceiling ? "above its ceiling" : "at or below its ceiling",
  };
}

/**
 * The ledger the tree earns, and what a write of it would give away.
 *
 * The ledger only ever shrinks — that is the whole of what it promises. `--update` taking
 * the current counts unconditionally breaks it: a run that adds a comment, is refused by the
 * scan, and then updates the ledger has the ceiling raised to fit, and the next whole-tree
 * scan is green with the violation inside it. So a write reports what it would RAISE, and
 * the caller refuses on that rather than applying it.
 *
 * `scope` is the set of paths the run read; rows outside it are carried over untouched.
 */
export function nextLedger(grouped, ledger, scope = null) {
  const inScope = (path) => scope === null || scope.has(path);
  const files = {};
  const raised = [];
  for (const [path, ceiling] of Object.entries(ledger)) {
    if (!inScope(path)) {
      files[path] = ceiling;
      continue;
    }
    const count = grouped[path]?.length ?? 0;
    if (count > ceiling) raised.push({ path, ceiling, count });
    if (count > 0) files[path] = Math.min(ceiling, count);
  }
  for (const [path, findings] of Object.entries(grouped)) {
    if (path in ledger || !inScope(path)) continue;
    raised.push({ path, ceiling: 0, count: findings.length });
  }
  return { files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))), raised };
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
  const d = hookDecision(path, readFileSync(path, "utf8"), readLedger());
  if (d.exit === 0) process.exit(0);
  console.error(`${d.key}: ${d.findings.length} finding(s), ledger allows ${d.ceiling}`);
  report(d.findings);
  process.exit(2);
}

const roots = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const scanRoots = roots.length ? roots : ["src", "e2e", "scripts"];
const targets = scanRoots.flatMap((r) => (existsSync(r) ? collect(r) : []));
const found = targets.flatMap((p) => findingsIn(readFileSync(p, "utf8"), p));
const grouped = byFile(found);

// What this run actually read. A partial scan compares only these, so a ledger row it never
// opened is neither reported as emptied nor dropped from the file.
const scanned = new Set(targets.map((p) => repoPath(p)));
const partial = roots.length > 0;

const reseed = process.argv.includes("--reseed");
if (process.argv.includes("--update") || reseed) {
  // A partial write MERGES: rewriting the whole ledger from a subset would delete every row
  // the run never looked at, silently taking the ceiling of 102 files to zero.
  const { files: lowered, raised } = nextLedger(grouped, readLedger(), partial ? scanned : null);
  if (raised.length && !reseed) {
    for (const r of raised) {
      console.error(`${r.path}: ${r.count} finding(s), ledger allows ${r.ceiling}`);
    }
    console.error(
      `\n--update lowers a ceiling; it does not raise one. ${raised.length} file(s) above theirs.` +
        ` Move the run, the reading and the date to the pull request or to docs/.` +
        ` A RULE change that legitimately grows the corpus is --reseed, which is a separate` +
        ` decision and shows in the diff as one.`,
    );
    process.exit(1);
  }
  const files = reseed
    ? Object.fromEntries(
        Object.entries({
          ...(partial ? Object.fromEntries(Object.entries(readLedger()).filter(([p]) => !scanned.has(p))) : {}),
          ...Object.fromEntries(Object.entries(grouped).map(([path, f]) => [path, f.length])),
        })
          .filter(([, n]) => n > 0)
          .sort(([a], [b]) => a.localeCompare(b)),
      )
    : lowered;
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
  const total = Object.values(files).reduce((a, b) => a + b, 0);
  console.log(
    `ledger ${reseed ? "reseeded" : partial ? "merged" : "written"}: ${Object.keys(files).length} file(s),` +
      ` ${total} finding(s)` +
      (partial ? ` (${scanned.size} scanned, the rest carried over)` : ""),
  );
  process.exit(0);
}

const { over, under } = verdict(grouped, readLedger(), partial ? scanned : null);
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
console.log(
  `OK: ${targets.length} source file(s)${partial ? " (partial scan)" : ""}, ${found.length} ledgered finding(s),` +
    ` none above its ceiling`,
);
if (under.length) {
  console.log(`\n${under.length} file(s) now carry fewer than the ledger allows. Paste to lower it:`);
  for (const f of under)
    console.log(`    ${JSON.stringify(f.path)}: ${f.count},${f.count ? "" : "   // (delete the row)"}`);
}
