#!/usr/bin/env node
// Verifies the "## Reusable assets" table in CLAUDE.md against the repo.
//
// The prose is judgement and is not generatable, so this checks the ANCHORS:
// every row points at something that exists (forward), and everything that
// exists is in a row (reverse). "Reach for it when" is unverifiable by
// construction, which is why the table is hand-written in the first place.
//
//   node scripts/check-assets-index.mjs        check
//   node scripts/check-assets-index.mjs --hook check after a CLAUDE.md edit (forward half only)
//
// Exits 1 on findings; --hook exits 2 so the message is fed back to Claude.
//
// Zero dependencies and no test-runner invocation: docs.yml runs this on a bare
// setup-node with no `pnpm install`, so every `pnpm test <filter>` is resolved by
// globbing the filesystem the way vitest/playwright would, never by running them.
//
// Known limits, deliberate:
//   - The private half is unverifiable in CI. reference/work/device-tests/ is
//     /reference/-ignored and absent from every checkout but the operator's, so an
//     ignored path is SKIPPED, never failed (`git check-ignore`). Locally, where the
//     private repo is checked out, the same assertion does fire.
//   - Tier-B flags (§CLI flag) are a weak oracle: a substring match that includes
//     comments, because meter-bench-run.mjs composes its flags at runtime
//     ("--" + name), so --tree exists only in its usage comment. Tier A (Tauri
//     launch flags), where the real rename risk lives, parses the actual call sites.
//     THIS FILE is excluded from that corpus: its own header names --tree and --hook,
//     and a checker whose comments answer its own questions passes on itself
//     (measured — renaming --tree away in meter-bench-run.mjs left the run green).
//   - A row is required to INTRODUCE an anchor, not merely to contain one, so a row
//     pasted in with another row's `pnpm dev` in it cannot ride on that row's
//     assertion. What no rule can see is a row that names a real-but-unrelated
//     anchor of its own; the reverse half is what covers that, per inventory.
//   - git check-ignore is trailing-slash sensitive ("dist" does not match the
//     "dist/" pattern while "dist/" does), so every miss is offered both ways.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DOC = "CLAUDE.md";
const SECTION = "## Reusable assets";
// Derived, not spelled: a renamed checker must not quietly re-enter its own corpus.
const SELF = relative(process.cwd(), fileURLToPath(import.meta.url))
  .split(sep)
  .join("/");

// Exact-string allowlist: spans that are prose, not anchors. Every entry needs a
// reason, because an unreasoned entry here is how a real anchor stops being checked.
const PROSE_TOKENS = new Map([
  ["--", "the CLI's argument separator, discussed as itself"],
  [".urxf", "a file format, not a file in this repo"],
  ["?plan=", "the deep-link query prefix"],
  ["*.audit.test.ts", "a glob naming a family; the family is checked by reverse rule F"],
  ["probe-*.mjs", "a glob over the private reference repo, absent from this checkout"],
  ["PLAN.md", "lives in the private reference repo, absent from this checkout"],
  ["dist", "the build output directory, named as the thing ci.yml greps"],
  ["ci.yml", "named as the workflow that greps; the grep itself is asserted per handle"],
  ["ls scripts/", "an instruction to the reader, not a path"],
  ['grep -rn "window.__urx" src/', "an instruction to the reader, not a path"],
]);

const SOURCE_EXT = /\.(ts|mjs|js|py|rs|json|sh|yml|yaml|html|css|png|svg)$/;

const HOOK = process.argv.includes("--hook");

// Fail closed everywhere but the hook: an infrastructure failure (git unavailable, an
// unreadable package.json) must not read as a pass. The hook is the exception — it
// fires on every edit, so a broken checker there must not block the operator's work.
process.on("uncaughtException", (e) => {
  if (HOOK) process.exit(0);
  console.error(`${DOC}: the check could not run — ${e.message}`);
  process.exit(1);
});

if (HOOK) {
  let edited;
  try {
    edited = JSON.parse(readFileSync(0, "utf8"))?.tool_input?.file_path;
  } catch {
    process.exit(0);
  }
  if (!edited || edited.split(/[\\/]/).pop() !== DOC) process.exit(0);
}

const findings = [];
const finding = (where, message) => findings.push(`${where}: ${message}`);

// --- repo inventory helpers -------------------------------------------------

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path.split(sep).join("/"));
  }
  return out;
}

const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");

// One spawn, over misses only. Exit 0 = something matched, 1 = nothing matched,
// anything else is a real git failure and must not read as "not ignored".
function ignoredSet(paths) {
  if (!paths.length) return new Set();
  // Offer each path both bare and with a trailing slash: "dist" does not match the
  // "dist/" pattern while "dist/" does.
  const probes = [...new Set(paths.flatMap((p) => [p, p.endsWith("/") ? p : p + "/"]))];
  const res = spawnSync("git", ["check-ignore", "--stdin"], { input: probes.join("\n"), encoding: "utf8" });
  if (res.error || (res.status !== 0 && res.status !== 1)) {
    finding(DOC, `git check-ignore is unavailable, so private paths cannot be told from missing ones (${res.status})`);
    return new Set();
  }
  const matched = new Set(res.stdout.split("\n").filter(Boolean));
  return new Set(paths.filter((p) => matched.has(p) || matched.has(p + "/")));
}

// --- the document -----------------------------------------------------------

const doc = read(DOC);
if (!doc) {
  // Infrastructure, not a finding: the hook can fire from anywhere, and blocking on a
  // wrong cwd is the failure mode that gets a hook disabled.
  if (HOOK) process.exit(0);
  console.error(`${DOC}: not found (run from the repository root)`);
  process.exit(1);
}
const lines = doc.split("\n");

let start = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim() === SECTION) {
    start = i;
    break;
  }
}
// An absent heading is finding #1, never a silent pass: renaming the heading must
// not disable the whole check.
if (start < 0) {
  // A finding, not infrastructure: the edit that renamed the heading is the one the
  // hook is watching, so it exits 2 like any other finding rather than 1.
  console.error(`${DOC}: section "${SECTION}" not found — renaming it disables every assertion below it`);
  process.exit(HOOK ? 2 : 1);
}
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (lines[i].startsWith("## ")) {
    end = i;
    break;
  }
}

const sectionText = lines.slice(start, end).join("\n");

// Spans from the tables AND the surrounding paragraphs: the private probe index and
// the "ci.yml greps dist" claim live in prose.
const spans = [];
for (let i = start; i < end; i++) {
  for (const m of lines[i].matchAll(/`([^`]+)`/g)) spans.push({ raw: m[1], line: i + 1 });
}

// Placeholders are the author's, not the repo's: "--tree <git worktree>" is the flag
// --tree, and "plan_tool.py validate <plan.json>" is the subcommand validate.
const strip = (t) =>
  t
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();

// --- inventories ------------------------------------------------------------

let pkg;
try {
  pkg = JSON.parse(readFileSync("package.json", "utf8"));
} catch (e) {
  console.error(`package.json: unreadable (${e.message})`);
  process.exit(1);
}
const scripts = pkg.scripts ?? {};

const srcFiles = walk("src");
const e2eFiles = walk("e2e");
const scriptFiles = walk("scripts");
const unitTests = srcFiles.filter((f) => f.endsWith(".test.ts"));
const raceSpecs = e2eFiles.filter((f) => f.startsWith("e2e/race/") && f.endsWith(".spec.ts"));
const appSpecs = e2eFiles.filter((f) => !f.startsWith("e2e/race/") && f.endsWith(".spec.ts"));

const srcText = srcFiles.map(read).join("\n");
const e2eText = e2eFiles.map(read).join("\n");
// Everything under scripts/ EXCEPT this file: the flag and environment-variable
// oracles are substring matches, and a checker that reads its own header answers its
// own questions.
const scriptsText = scriptFiles
  .filter((f) => f !== SELF)
  .map(read)
  .join("\n");
const ciText = read(".github/workflows/ci.yml");
const settingsText = read(".claude/settings.json");
const envText = walk(".")
  .filter((f) => /^\.env/.test(f.replace(/^\.\//, "")) || /\.config\.ts$/.test(f))
  .map(read)
  .join("\n");

// Tauri launch flags, from the actual call sites. Truncated at the first
// column-0 #[cfg(test)] per file: without it lib.rs's
// "--not-a-flag-this-binary-was-given" enters the set and reverse rule D reports
// it as unindexed. Column-0 rather than any indentation, so a nested #[cfg(test)]
// inside a live module (vd.rs has two) cannot truncate real code.
const launchFlags = new Set();
for (const file of walk("src-tauri/src").filter((f) => f.endsWith(".rs"))) {
  const text = read(file);
  const cut = text.search(/^#\[cfg\(test\)\]/m);
  for (const m of (cut < 0 ? text : text.slice(0, cut)).matchAll(/"(--[a-z][a-z0-9-]*)"/g)) launchFlags.add(m[1]);
}

// In-page handles. src/**: every __urx* identifier. e2e/**: only names declared into
// the global Window interface — a handle typed into Window is a shared surface any
// file can reach, while a cast-accessed one (`as unknown as { __urxWrites: … }`) is a
// fixture's private recording array, an implementation detail of a row that already
// exists. The __urx / __*Test naming rule then excludes Tauri's own
// __TAURI_INTERNALS__ without an allowlist.
const handles = new Map(); // name -> "src" | "e2e"
for (const m of srcText.matchAll(/__urx[A-Za-z0-9_]*/g)) handles.set(m[0], "src");
for (const file of e2eFiles.filter((f) => f.endsWith(".ts"))) {
  const text = read(file);
  for (const block of text.matchAll(/declare global\s*\{[\s\S]*?\n\}/g)) {
    for (const m of block[0].matchAll(/(__[A-Za-z0-9_]+)\s*[?:]/g)) {
      const name = m[1];
      if ((/^__urx/.test(name) || /Test$/.test(name)) && !handles.has(name)) handles.set(name, "e2e");
    }
  }
}

// --- forward: a row points at something real --------------------------------

const asserted = new Set(); // line numbers that produced a checkable anchor
const introduced = new Set(); // line numbers that were the first to carry one of their tokens
const claimed = new Set(); // tokens already spoken for by an earlier line
const skipped = [];
const testFilterHits = new Set(); // for reverse rule F
let checked = 0;

function assertPath(token, line, note = "") {
  const path = token.replace(/^\.\//, "");
  if (existsSync(path)) return true;
  return { miss: path, line, note };
}

const pathMisses = [];
const takePath = (token, line, note) => {
  const r = assertPath(token, line, note);
  if (r !== true) pathMisses.push(r);
};

function assertEnv(name, line) {
  checked++;
  const hay = srcText + scriptsText + e2eText + envText;
  if (!hay.includes(name)) finding(`${DOC}:${line}`, `environment variable ${name} appears nowhere in the repo`);
}

function assertTestFilter(script, filter, line) {
  checked++;
  let pool;
  if (script === "test") pool = unitTests;
  else if (script === "test:e2e:race" || script === "test:e2e:race:webkit") pool = raceSpecs;
  else if (script === "test:e2e:app") pool = appSpecs;
  else pool = [...appSpecs, ...raceSpecs];
  const hits = pool.filter((f) => f.includes(filter));
  if (!hits.length) finding(`${DOC}:${line}`, `\`pnpm ${script} ${filter}\` matches no test file`);
  if (script === "test") for (const h of hits) testFilterHits.add(h);
}

function assertHandle(name, line) {
  checked++;
  const inSrc = srcText.includes(name);
  const inE2e = e2eText.includes(name);
  if (!inSrc && !inE2e) {
    finding(`${DOC}:${line}`, `handle ${name} is published nowhere under src/ or e2e/`);
    return;
  }
  // Holds the section's own claim: "ci.yml greps dist for each name". A handle found
  // only under e2e/ (the fake device) never reaches a bundle and is exempt.
  if (inSrc && !ciText.includes(name)) {
    finding(`${DOC}:${line}`, `${name} ships from src/ but ci.yml does not grep the bundle for it`);
  }
}

// One argument loop for `pnpm <script> …` and `node <path> …`: an argument class that
// nothing looks at is the same silent pass as an unclassified token.
function checkArgs(args, line, script) {
  const isTauri = script === "tauri";
  let afterSep = false;
  for (const arg of args) {
    if (arg === "--") {
      afterSep = true;
      continue;
    }
    if (arg.startsWith("--")) {
      checked++;
      if (isTauri && afterSep) {
        // Tier A: a real launch flag, parsed out of the Rust call sites.
        if (!launchFlags.has(arg)) finding(`${DOC}:${line}`, `launch flag ${arg} is not read by src-tauri/src/*.rs`);
      } else if (!scriptsText.includes(arg)) {
        finding(`${DOC}:${line}`, `CLI flag ${arg} appears in no script under scripts/`);
      }
      continue;
    }
    if (arg.includes("/") || SOURCE_EXT.test(arg)) {
      checked++;
      takePath(arg, line);
      continue;
    }
    if (/^(test|test:e2e)/.test(script)) assertTestFilter(script, arg, line);
  }
}

function classifyPnpm(token, line) {
  let rest = token;
  while (/^[A-Z][A-Z0-9_]*=\S+\s/.test(rest)) {
    const [, name] = rest.match(/^([A-Z][A-Z0-9_]*)=/);
    assertEnv(name, line);
    rest = rest.replace(/^\S+\s+/, "");
  }
  const parts = rest.split(" ");
  const script = parts[1];
  checked++;
  if (!(script in scripts)) {
    finding(`${DOC}:${line}`, `\`pnpm ${script}\` is not a script in package.json`);
    return;
  }
  checkArgs(parts.slice(2), line, script);
}

for (const span of spans) {
  const token = strip(span.raw);
  const line = span.line;
  if (!token) continue;

  if (PROSE_TOKENS.has(token)) continue;
  asserted.add(line);
  if (!claimed.has(token)) {
    claimed.add(token);
    introduced.add(line);
  }

  if (/^[A-Z][A-Z0-9_]*=\S+\s+pnpm\s/.test(token) || /^pnpm\s/.test(token)) {
    classifyPnpm(token, line);
  } else if (/^node\s/.test(token)) {
    const [, path, ...rest] = token.split(" ");
    checked++;
    takePath(path, line);
    checkArgs(rest, line, "node");
  } else if (/^python3?\s/.test(token)) {
    const [, path, sub] = token.split(" ");
    checked++;
    takePath(path, line);
    if (sub) {
      checked++;
      const body = read(path);
      if (body && !body.includes(`"${sub}"`) && !body.includes(`'${sub}'`)) {
        finding(`${DOC}:${line}`, `${path} defines no "${sub}" subcommand`);
      }
    }
  } else if (/^(window\.)?__[A-Za-z0-9_]+$/.test(token)) {
    assertHandle(token.replace(/^window\./, ""), line);
  } else if (/^--[a-z]/.test(token)) {
    checked++;
    if (launchFlags.has(token)) {
      // fine: a launch flag named on its own
    } else if (!scriptsText.includes(token)) {
      finding(`${DOC}:${line}`, `CLI flag ${token} appears in no script under scripts/`);
    }
  } else if (/^[A-Z][A-Z0-9_]*=\S+$/.test(token)) {
    assertEnv(token.split("=")[0], line);
  } else if (token.includes("/") || SOURCE_EXT.test(token)) {
    checked++;
    takePath(token, line);
  } else {
    // The load-bearing invariant. A silently-ignored token class is how this check
    // would rot the same way the table does.
    finding(
      `${DOC}:${line}`,
      `unclassified token \`${token}\` — add a classifier or add it to PROSE_TOKENS with a reason`,
    );
  }
}

// Path misses, resolved against .gitignore in one spawn: a private path is skipped,
// a genuinely missing one fails.
const ignored = ignoredSet(pathMisses.map((m) => m.miss));
for (const m of pathMisses) {
  if (ignored.has(m.miss)) {
    skipped.push(m.miss);
    continue;
  }
  const base = m.miss.split("/").pop();
  const near = [...srcFiles, ...e2eFiles, ...scriptFiles].find((f) => f.endsWith("/" + base));
  finding(`${DOC}:${m.line}`, `\`${m.miss}\` does not resolve to a file${near ? ` (did you mean ${near}?)` : ""}`);
}

// Every table row must yield at least one asserted token, and that token must be the
// row's OWN. A row whose only span is prose asserts nothing and rots invisibly — the
// exact failure being designed against — and a row carrying only a span an earlier row
// already anchors (a pasted `pnpm dev`) is that same nothing wearing another row's
// assertion.
const rows = [];
for (let i = start; i < end; i++) {
  const line = lines[i];
  if (!/^\s*\|/.test(line)) continue;
  if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // delimiter
  if (i + 1 < end && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) continue; // header
  rows.push(i + 1);
}
for (const row of rows) {
  const label = () => (lines[row - 1].split("|")[1] ?? "").trim().replace(/`/g, "");
  if (!asserted.has(row)) {
    finding(`${DOC}:${row}`, `row "${label()}" carries no checkable anchor — name the module or file it lives in`);
  } else if (!introduced.has(row)) {
    finding(
      `${DOC}:${row}`,
      `row "${label()}" introduces no anchor of its own — every span in it already anchors an earlier line; name the module, file or command this row is about`,
    );
  }
}

// --- reverse: something real appears in no row ------------------------------

const forwardOnly = HOOK;

if (!forwardOnly) {
  // "pnpm test" must not be answered by "pnpm test:e2e" — a script whose name is a
  // prefix of another's would otherwise stay "documented" after its own line is cut.
  const named = (name) => new RegExp(`pnpm ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w:.-])`).test(doc);

  // A. every package.json script is named somewhere in CLAUDE.md (the ## Development
  //    fence is the everyday list; this section is the rest).
  for (const name of Object.keys(scripts)) {
    if (!named(name)) finding("package.json", `script "${name}" is named nowhere in ${DOC}`);
  }

  // B. every file in scripts/ is reachable from the docs: named directly, run by a
  //    pnpm script CLAUDE.md names, or wired into the tracked hook. All three are
  //    required — e2e-worktree.mjs / reset-storage.mjs are reached only through their
  //    pnpm scripts, md-hook.sh only through .claude/settings.json.
  for (const file of scriptFiles) {
    const base = file.split("/").pop();
    if (doc.includes(file)) continue;
    const viaScript = Object.entries(scripts).some(([name, cmd]) => cmd.includes(file) && named(name));
    if (viaScript || settingsText.includes(base)) continue;
    finding(file, `is in scripts/ but no row, pnpm script or hook names it`);
  }

  // C. every published in-page handle is in the section.
  for (const [name, side] of handles) {
    if (!sectionText.includes(name)) {
      finding(side === "src" ? "src/" : "e2e/", `${name} is published but appears in no row`);
    }
  }

  // D. every Tauri launch flag is in the section.
  for (const flag of launchFlags) {
    if (!sectionText.includes(flag)) finding("src-tauri/src/lib.rs", `launch flag ${flag} appears in no row`);
  }

  // E. every E2E fixture (a non-spec .ts) is in the section.
  for (const file of e2eFiles.filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts"))) {
    if (!sectionText.includes(file)) finding(file, `is an E2E fixture but appears in no row`);
  }

  // F. every contract/pin test is covered by one of the section's `pnpm test <filter>`
  //    tokens — resolved, not string-matched, so meter-bench.contract.test.ts is
  //    satisfied by `pnpm test meter-bench` and the audit family by `pnpm test audit`.
  for (const file of unitTests.filter((f) => /\.(contract|audit)\.test\.ts$/.test(f))) {
    if (!testFilterHits.has(file)) finding(file, `is a contract/pin test that no \`pnpm test\` row selects`);
  }
}

// --- report -----------------------------------------------------------------

if (forwardOnly) {
  // The reverse half is excluded deliberately: it is legitimately red between
  // "delete the script" and "update the table", and a hook that blocks that
  // sequence gets ignored.
  if (findings.length) {
    for (const f of findings) console.error(f);
    process.exit(2);
  }
  process.exit(0);
}

if (findings.length) {
  for (const f of findings) console.error(f);
  console.error(`\n${findings.length} finding(s) in "${SECTION}"`);
  process.exit(1);
}

// Named, not counted: a skip is the one outcome that looks like a pass, and a path
// that quietly became ignored (a build output, a moved directory) has to be readable
// off the OK line.
const note = skipped.length ? ` (skipped as private/generated: ${skipped.join(", ")})` : "";
console.log(`OK: ${spans.length} tokens${note}, ${checked} assertions, ${rows.length} rows, 6 inventories`);
