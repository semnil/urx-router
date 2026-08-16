#!/usr/bin/env node
// Verifies the "## Reusable assets" table in CLAUDE.md, and the file references the
// design documents make, against the repo.
//
// The prose is judgement and is not generatable, so this checks the ANCHORS:
// every row points at something that exists (forward), and everything that
// exists is in a row (reverse). "Reach for it when" is unverifiable by
// construction, which is why the table is hand-written in the first place.
// docs/{en,ja}/*.md gets the forward half of that treatment — see the docs section.
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
//     ignored path is SKIPPED, never failed (`git check-ignore`). The skip is decided by
//     the ignore rule and not by whether the tree is there, so it holds in the
//     operator's checkout too: a private path that went stale is skipped, not reported,
//     in EVERY checkout (measured). The skip is named on the OK line for that reason —
//     it is the one outcome a reader has to check by hand.
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
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DOC = "CLAUDE.md";
const SECTION = "## Reusable assets";
const DOC_DIRS = ["docs/en", "docs/ja"];
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
  ["*.test-util.ts", "a glob naming a family; every member is checked by reverse rule E2"],
  ["probe-*.mjs", "a glob over the private reference repo, absent from this checkout"],
  ["PLAN.md", "lives in the private reference repo, absent from this checkout"],
  ["dist", "the build output directory, named as the thing ci.yml greps"],
  ["ci.yml", "named as the workflow that greps; the grep itself is asserted per handle"],
  ["ls scripts/", "an instruction to the reader, not a path"],
  ["ruby", "the interpreter, named as the thing that has to be present for a differential to run"],
  ["File.fnmatch", "Ruby's method, named as the authority a matcher is measured against"],
  // Playwright's own declarations, named as the two shapes a skip ledger cannot read off a
  // listing: one annotates itself something other than a skip, the other is not there at all.
  ["test.fixme", "a Playwright declaration, named as itself"],
  ["test.skip()", "a Playwright declaration, named as itself"],
  ['grep -rn "window.__urx" src/', "an instruction to the reader, not a path"],
  // The CDP row names what it drives. None of these is a file in any tree: the first two
  // are Playwright's and CSS's own vocabulary, the last three are DevTools-protocol
  // methods, and `WebSocket` is the platform global that replaces the client.
  ["connectOverCDP", "a Playwright API named as the thing NOT to use, not a path"],
  ["forced-colors", "the CSS media feature, named as itself"],
  ["WebSocket", "the platform global the CDP route is driven with"],
  ["Runtime.evaluate", "a DevTools-protocol method"],
  ["Input.dispatchMouseEvent", "a DevTools-protocol method"],
  ["Page.captureScreenshot", "a DevTools-protocol method"],
  // Four more from the same row: the DOM method and the evaluate parameter that name
  // one of the three routes leaving the popup shut on an inactive window, and the Win32
  // pair behind "a probe cannot activate a window across processes".
  [
    "showPicker()",
    "a DOM method, named as one of the routes that does not open the popup while the window is inactive",
  ],
  ["userGesture", "a DevTools-protocol parameter of Runtime.evaluate"],
  ["SetForegroundWindow", "a Win32 call, named as the one the foreground lock silently refuses"],
  ["GetForegroundWindow", "a Win32 call, named as what an armed capture polls"],
  // The race tier's split. The variable is Playwright's own, undocumented in its shipped
  // types, which is why the row names it at all; the disabled spelling is the mutation the
  // scan was tightened against, and the third is a key inside the ledger the row already
  // names as a file.
  ["PWTEST_SHARD_WEIGHTS", "a Playwright environment variable, named as itself"],
  ["PWTEST_SHARD_WEIGHTS_DISABLED", "a rename of that variable, named as the mutation a substring check missed"],
  ["collect.shardWeights", "a key inside e2e/race/skip-ledger.json, not a path"],
  ["includes()", "JavaScript's own method, named as the check that was too loose"],
  ["test.describe.serial", "a Playwright declaration, named as itself"],
  ["(retry #1)", "the list reporter's retry suffix, quoted as the text a parser has to strip"],
  ["floor(weight × collected ÷ sum)", "Playwright's own shard-size arithmetic, written out"],
  // The recorded macOS platform version: Mach-O and linker vocabulary, the Xcode tool that
  // reads the field back, and the compiler flag whose output a guard fixture was recorded
  // from. None of them is a file in any tree.
  ["LC_BUILD_VERSION", "a Mach-O load command, named as itself"],
  ["-platform_version", "a linker argument, named as itself"],
  ["vtool", "an Xcode command line tool, named as the thing the guard parses the output of"],
  ["-mmacosx-version-min=10.9", "a compiler flag, quoted as what produced a recorded fixture"],
]);

// The same discipline for docs/{en,ja}, keyed `<document>|<token>`: the English and
// Japanese copies are one document, so one entry covers both, and the same string stays
// checked in every other document. Reverse rule G reports an entry that stops
// suppressing anything, so the list cannot become a blanket pardon.
const DOC_MENTIONS = new Map([
  [
    "architecture.md|THIRD_PARTY_LICENSES.html",
    "cargo-about generates it into src-tauri/ and .gitignore excludes it — the sentence naming it says exactly that",
  ],
  [
    "architecture.md|latest.json",
    "the updater manifest tauri-action publishes to a GitHub Release, served from a URL and never a file in the tree",
  ],
]);

const SOURCE_EXT = /\.(ts|mjs|js|py|rs|json|sh|yml|yaml|html|css|png|svg)$/;

// Extensions that make a bare basename in a design document a file claim. Wider than
// SOURCE_EXT (which classifies a command's arguments) because the documents name
// documents, manifests and the license text too.
const DOC_EXT = "ts|tsx|rs|mjs|cjs|js|json|md|css|html|toml|txt|ya?ml|py|sh|png|svg|hbs";
const DOC_ROOTED = /^(?:src-tauri|src|e2e|scripts|docs|public|reference|\.github|\.claude)\//;
// A token with at least one slash. The head may start with a dot (.github/…), and the
// tail may end in one (core/control/), carry a glob (e2e/race/t*.spec.ts) or a brace
// alternation (docs/{en,ja}/…). `<` is excluded from the head so a Mermaid label's
// <br/> is not a token: it matched 110 times and was pardoned as "another tree's path",
// which made the OK line's suppression count say the opposite of what was suppressed.
const DOC_SLASHY = /(?<![\w./~@<-])([A-Za-z.][\w.-]*\/(?:[\w.*{}@,-]+\/)*[\w.*{}@,-]*)/g;
const DOC_BASENAME = new RegExp(String.raw`(?<![\w./~@-])([A-Za-z][\w.-]*\.(?:${DOC_EXT}))(?![\w/-])`, "g");
// A dotfile name (.env.demo, .gitignore). Never followed by a slash — .github/… is a
// path and belongs to DOC_SLASHY. Which of these is a claim is decided by DOT_ROOTS.
const DOC_DOTFILE = /(?<![\w./~@-])(\.[A-Za-z][\w.-]*)(?![\w/-])/g;
const DOC_PATH_TAIL = new RegExp(String.raw`(?:\.(?:${DOC_EXT})|/)$`);
// Markdown link and image targets, stripped before the prose scan: a broken target is a
// different class, visible to the reader who clicks it, and deliberately not checked.
const MD_TARGET = /\]\([^)\n]*\)/g;

const HOOK = process.argv.includes("--hook");

// Fail closed everywhere but the hook: an infrastructure failure (git unavailable, an
// unreadable package.json) must not read as a pass. The hook is the exception — it
// fires on every edit, so a broken checker there must not block the operator's work.
process.on("uncaughtException", (e) => {
  if (HOOK) process.exit(0);
  console.error(`${DOC}: the check could not run — ${e.message}`);
  process.exit(1);
});

// Which edit this hook run is about. Resolved against the cwd rather than matched on a
// basename: a basename gate fires for ANY file called CLAUDE.md — `~/.claude/CLAUDE.md`
// among them — and then checks THIS repository's copy, which the edit never touched.
// What this run covers. One decision, taken at the gate, instead of the same question
// re-derived at each section: the sections below read a field rather than re-testing
// HOOK. A later mode is a new row here, not a fifth condition somewhere downstream —
// which is what the previous shape's failure looked like, since a section that forgot
// the guard fails by checking the wrong corpus rather than by erroring.
let scope = { claudeMd: true, docFiles: null }; // null = walk DOC_DIRS
if (HOOK) {
  let edited;
  try {
    edited = JSON.parse(readFileSync(0, "utf8"))?.tool_input?.file_path;
  } catch {
    process.exit(0);
  }
  if (!edited) process.exit(0);
  const rel = relative(process.cwd(), resolve(edited)).split(sep).join("/");
  // A docs/{en,ja} document is its own business: the same hook already checks its
  // TABLES (check-md-tables.mjs), so skipping its REFERENCES made one Edit answer half
  // a question. Only that one file is walked below, which is what keeps the run inside
  // the hook's budget.
  const isDocsMd = DOC_DIRS.some((d) => rel.startsWith(`${d}/`)) && rel.endsWith(".md");
  if (rel !== DOC && !isDocsMd) process.exit(0);
  // A CLAUDE.md edit answers for the asset table; a docs edit answers for that one
  // document. Neither answers for the other.
  scope = isDocsMd ? { claudeMd: false, docFiles: [rel] } : { claudeMd: true, docFiles: [] };
}

// Kept structured so the report can be read in file order: findings are produced in
// rule order, and rule order is not reading order once they span thirteen documents.
const findings = [];
const finding = (where, message) => findings.push({ where, message });
function reportFindings() {
  const key = (f) => {
    const m = f.where.match(/^(.*):(\d+)$/);
    return [m ? m[1] : f.where, m ? Number(m[2]) : 0];
  };
  findings.sort((a, b) => {
    const [af, al] = key(a);
    const [bf, bl] = key(b);
    return af.localeCompare(bf) || al - bl;
  });
  for (const f of findings) console.error(`${f.where}: ${f.message}`);
}

// --- repo inventory helpers -------------------------------------------------

// Never walked. A build output is not part of the repository's inventory, and
// src-tauri/target alone is large enough to make the whole-tree walk below unaffordable.
const WALK_SKIP = new Set(["node_modules", ".git", "dist", "dist-trace", "target", "gen", ".vite"]);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (WALK_SKIP.has(entry.name)) continue;
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

// The code spans in each table line's FIRST cell — what a row is ABOUT. Parsed here
// rather than beside the rules that consume it because the classifier runs first and
// needs to judge a span against the row it sits on, not against the section as a whole.
const firstCellSpans = new Map();
for (let i = start; i < end; i++) {
  if (!/^\s*\|/.test(lines[i])) continue;
  const names = [...(lines[i].split("|")[1] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  if (names.length) firstCellSpans.set(i + 1, names);
}

// Spans from the tables AND the surrounding paragraphs: the private probe index and
// the "ci.yml greps dist" claim live in prose.
const spans = [];
// A hook run about a docs/ file answers for that file only: the asset table belongs to
// the edit that touched CLAUDE.md, and re-reporting it here would blame every docs edit
// for a row somebody else broke.
if (scope.claudeMd)
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
// Mirrors vitest.config.ts's `include`, which is what a `pnpm test <filter>` actually
// globs: src for the app, and scripts for the tooling that has pins of its own.
const unitTests = [
  ...srcFiles.filter((f) => f.endsWith(".test.ts")),
  ...scriptFiles.filter((f) => f.endsWith(".test.mjs")),
];
// The unit half of rule E. These are the hosts and stubs a layer needs in order to run
// at all under jsdom or node, and vitest does not collect them (only `.test.ts`), so a
// search for tests does not turn them up either — which is how eight of them
// accumulated while the section indexed only the E2E ones.
const unitFixtures = srcFiles.filter((f) => f.endsWith(".test-util.ts"));
const e2eFixtures = e2eFiles.filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts"));
// Every spelling, because a detector that sees one lets the others slip past E3 in
// silence. Enumerated over these files rather than guessed, and there are three plus one
// exclusion: the declaration (`export const x` / `export function x` / `export type X =`),
// the list `export { x, y as z }` — where an alias exports the ALIAS — and the type list
// `export type { A, B } from "…"`, which fixtures.ts uses on the line BELOW the
// `export { expect }` that motivated the list form, and which a list regex without the
// `type` alternative misses for exactly the reason this comment gives. No fixture uses
// `export * from`. A default export is deliberately excluded: it has no name for a row to
// spell, so the row names the file instead (coverage-options.ts, coverage-reporter.ts).
const EXPORT_DECL = /^export\s+(?:async\s+)?(?:function|const|class|type|interface)\s+(\w+)/gm;
const EXPORT_LIST = /^export\s*(?:type\s+)?\{([^}]*)\}/gm;
function exportsOf(file) {
  const src = read(file);
  const listed = [...src.matchAll(EXPORT_LIST)].flatMap((m) =>
    m[1]
      .split(",")
      .map((part) =>
        part
          .trim()
          .split(/\s+as\s+/)
          .pop()
          .trim(),
      )
      .filter((name) => name && name !== "default"),
  );
  return [...[...src.matchAll(EXPORT_DECL)].map((m) => m[1]), ...listed];
}
// Which fixtures export a given name, so a row may spell one in a code span. Without a
// branch for it the classifier rejects a bare identifier as unclassified, which is part
// of why a row could describe a fixture and never name what it hands you. Keyed by name
// AND owner: the names are ordinary words (`test`, `key`, `mark`, `wire`, `drag`), so
// accepting one anywhere in the section would pardon it on a row about another file.
const exportOwners = new Map();
for (const file of [...e2eFixtures, ...unitFixtures]) {
  for (const name of exportsOf(file)) {
    if (!exportOwners.has(name)) exportOwners.set(name, new Set());
    exportOwners.get(name).add(file);
  }
}
// Rows written as an INVENTORY of what the file hands you, rather than as prose about
// when to reach for it. Only these are held to naming every export (rule E3). The
// distinction is the whole design: on a prose row a new export is not a row change —
// fake-device.ts exports 51 names and its row is one sentence about what the fake is
// for — and requiring it everywhere would demand nearly every export these tables' files
// carry. HOW nearly is deliberately not written here: the figure moves with any edit to
// a fixture's exports or to a row's code spans, which is two files away from this
// sentence. Five revisions of this comment carried it and four stated something the tree
// did not; the one that was right was then copied forward verbatim into a push whose own
// edit moved it. It is replaced by the census the OK line prints. Read it there.
//
// It was not zero for lack of trying, either. Over all 70 revisions of this table exactly
// one row ever carried an export in a code span (`colorToken` on the fixtures row,
// 66ebab6), and the VERY NEXT commit (f0d7018) stripped it because THIS checker refused
// it as unclassified, choosing that over widening PROSE_TOKENS. The row-tied branch above
// is what lifts that refusal, so the span is back. An inventory row
// is the opposite: it enumerates, so an export missing from it is a reader being told
// the list is complete when it is not, which is how the wire locator was forked four
// times and hand-written eighteen more while the row listed five other things.
const INVENTORY_ROWS = new Map([["e2e/graph-helpers.ts", "the row enumerates what a spec can address"]]);
// What rule H holds against the map documents: the files those documents undertake to
// describe, which is everything that is neither a test nor a fixture nor a type
// declaration. The shell's Rust is in it beside the frontend's TypeScript because
// architecture.md names both halves the same way — and the walk starts at src-tauri
// rather than src-tauri/src, which left build.rs out of the inventory while it was named
// by no document at all. WALK_SKIP already keeps target/ and gen/ out.
const mappedSources = [
  ...srcFiles.filter((f) => f.endsWith(".ts") && !/\.(test|test-util|d)\.ts$/.test(f)),
  ...walk("src-tauri").filter((f) => f.endsWith(".rs")),
];
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
// The checker's own two inputs. `read` answers "" for a file that is not there, and an
// empty corpus does not fail a rule — it makes every handle read as ungrepped and
// md-hook.sh read as unreferenced, which is a rename reported as a dozen wrong things.
// Named here instead, once. This is also what backs the PROSE_TOKENS pardon of `ci.yml`:
// the row's claim is about a real file, and the file is asserted even though the span is
// not a path.
const CI_WORKFLOW = ".github/workflows/ci.yml";
const SETTINGS = ".claude/settings.json";
const ciText = read(CI_WORKFLOW);
const settingsText = read(SETTINGS);
// Not in the hook: it fires on every CLAUDE.md edit, and a missing input is the repo's
// problem to report on a full run, not a reason to block the operator mid-edit.
if (!HOOK && !ciText)
  finding(CI_WORKFLOW, "does not exist, so the per-handle bundle-grep assertion has nothing to read");
if (!HOOK && !settingsText)
  finding(SETTINGS, "does not exist, so a script reached only through the tracked hook reads as unreferenced");
// One whole-tree walk, shared: the environment-variable oracle reads a few files out of
// it, and the docs half indexes it by directory name and by basename.
const repoFiles = walk(".");
const envText = repoFiles
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
const usedProse = new Set(); // PROSE_TOKENS entries that actually pardoned a span
const skipped = [];
const testFilterHits = new Set(); // for reverse rule F
let checked = 0;

// `file` is the document making the claim: the table's rows and a design document's
// spans share this funnel, so both reach the same git check-ignore classification below.
function assertPath(token, line, note = "", file = DOC) {
  const path = token.replace(/^\.\//, "");
  if (existsSync(path)) return true;
  return { miss: path, line, note, file };
}

const pathMisses = [];
const takePath = (token, line, note, file) => {
  const r = assertPath(token, line, note, file);
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

  if (PROSE_TOKENS.has(token)) {
    usedProse.add(token);
    continue;
  }
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
  } else if ((firstCellSpans.get(line) ?? []).some((anchor) => exportOwners.get(token)?.has(anchor))) {
    // A name exported by a file THIS row heads. Checkable in the same sense as a path:
    // it stops resolving the moment the export is renamed or dropped. Tied to the row
    // because the names are ordinary words — accepting `wire` or `test` section-wide
    // would pardon it on a row about a file that exports no such thing.
    checked++;
  } else {
    // The load-bearing invariant. A silently-ignored token class is how this check
    // would rot the same way the table does.
    finding(
      `${DOC}:${line}`,
      `unclassified token \`${token}\` — add a classifier or add it to PROSE_TOKENS with a reason`,
    );
  }
}

// --- docs/{en,ja}: the file references the design documents make -------------
//
// The table above is checked and the private memory is checked; the design documents
// name files on nearly 600 spans and were checked by nobody. Nothing in them is stale
// today (measured), so this is preventive: the point is that the next moved file is
// caught by a run rather than by a reader months later.
//
// The one design problem is the memory checker's: a CLAIM is not a MENTION. Three
// rules, each measured against the corpus before it was kept:
//
//   - A rooted path (src/, e2e/, docs/, .github/ …) has to resolve as written. It goes
//     through the same funnel as the table's own paths, so src-tauri/target/release/bundle/
//     reads as generated rather than missing. 178 assertions, 2 misses, both that one.
//   - An abbreviated one — `core/routing.ts`, `ui/dom.ts`, `control/live.ts`, the form
//     the reader resolves by context — resolves under any directory carrying its FIRST
//     segment. That segment is the whole discriminator: it tells this repo's shorthand
//     from another tree's path, because `ui` and `control` are directories here and
//     `tauri-runtime` is not, so `tauri-runtime/src/webview.rs` never becomes a claim
//     and needs no pardon. check-memory-refs.mjs settled the same rule after measuring
//     plain suffix matching at 10 false positives out of 10 — that path among them.
//     137 assertions, 0 misses.
//   - A bare basename (`main.ts`, `ci.yml`, `tauri.conf.json`) resolves by name anywhere
//     in the tree. The memory checker does NOT check this class (45 unresolved there,
//     0 real findings); in documents that describe only this repo it measures the other
//     way — 292 spans, 8 misses, and all 8 are the two DOC_MENTIONS entries, each named
//     twice per language.
//   - A dotfile (`.env.demo`) is invisible to that rule — it has no extension the rule
//     knows, and every leading-dot span in the corpus is a CSS class, a file format or a
//     method (`.consent-scrim`, `.urxf`, `.toContain`). So the same discriminator the
//     shortened form uses applies: a leading dot-segment that names a top-level entry of
//     THIS repo, or the stem of one (`.env` from .env.demo). 4 assertions, 0 misses, and
//     26 distinct spans (74 occurrences) classified as mentions without an allowlist
//     entry each.
//
// Fenced blocks are scanned whole, like the memory checker's: they are code, and a path
// in a Mermaid label rots like any other (+86 assertions, no new misses). Prose outside
// backticks is scanned for basenames and dotfiles ONLY — a slash in a sentence is not a
// path (`ON/OFF`, `CH3/4`), but `console-sends.md` in a sentence is still that file, and
// backticks are a house style rather than a rule the documents follow. Measured before
// keeping it: 43 assertions, 0 misses, and it is the ONLY thing that covers
// console-sends.md and live-race-harness.md, which no backticked span in the corpus
// names at all.
//
// Deliberately not checked: Markdown link and image targets (a different class, and a
// broken one is visible to the reader who clicks it — MD_TARGET strips them before the
// prose scan, so the link TEXT is checked and the target is not), and anything a
// document says about ANOTHER repository.
//
// What the HOOK runs is narrower, and not for the reason this once gave. It used to say
// "a document the edit did not touch is not the edit's business" — but its gate was the
// edited file's BASENAME, so a docs/ edit was dropped before anything was read, and the
// same hook went on checking that file's TABLES (check-md-tables.mjs): one Edit, half an
// answer. The gate is now the resolved path, and a docs/{en,ja} edit runs the docs half
// against THAT ONE FILE. The reverse half stays off for the hook whatever was edited
// (`forwardOnly` below), and that boundary really is a judgement rather than a rule: rule
// H reads CLAUDE.md as one side of a map whose other side is architecture.md, so a
// CLAUDE.md edit CAN create a finding about a document it did not touch. docs.yml runs
// the whole file on every pull request and every push, external pull requests included,
// so nothing escapes permanently — the hook buys the report at the edit, not the gate.

const docSkips = new Map(); // reason -> count, named on the OK line
const docSkipped = []; // docs-side paths skipped as generated/private, named the same way
const usedMentions = new Set();
let docFileCount = 0;
let docSpans = 0;
let docChecked = 0;

if (scope.docFiles === null || scope.docFiles.length) {
  const docFiles =
    scope.docFiles ??
    DOC_DIRS.flatMap((d) => walk(d))
      .filter((f) => f.endsWith(".md"))
      .sort();
  docFileCount = docFiles.length;
  // An empty corpus is finding #1, never a silent pass: moving or renaming the
  // documentation directories would otherwise disable every assertion below at once,
  // and a run that checks nothing prints the same OK line as a run that checks 646.
  if (!docFileCount) finding(DOC_DIRS.join(" / "), "holds no Markdown, so no document reference was checked");

  // Directory NAMES and file basenames of the whole tree, derived from the one walk
  // rather than a second one.
  const dirsByName = new Map();
  const dirs = new Set();
  const byBase = new Map();
  for (const f of repoFiles) {
    const parts = f.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join("/");
      if (dirs.has(p)) continue;
      dirs.add(p);
      if (!dirsByName.has(parts[i])) dirsByName.set(parts[i], []);
      dirsByName.get(parts[i]).push(p);
    }
    const base = parts[parts.length - 1];
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(f);
  }

  const docNote = (reason) => docSkips.set(reason, (docSkips.get(reason) ?? 0) + 1);
  const trimTok = (t) => t.replace(/[.,]+$/, "");

  // Leading dot-segments of the repo's own top-level dot entries: .env (from .env.demo
  // and .env.trace), .github, .claude, .gitignore. Derived, so a new dotfile family is
  // covered by existing, and a token whose lead is not one of these is a mention.
  const DOT_ROOTS = new Set(
    readdirSync(".", { withFileTypes: true })
      .filter((e) => e.name.startsWith("."))
      .map((e) => e.name.split(".").slice(0, 2).join(".")),
  );

  // `{en,ja}` enumerates NAMED things, so every alternative has to resolve. A group with
  // no comma is the writer's placeholder (`{ProductCode}`) and globs instead.
  function expandBraces(s) {
    const m = s.match(/\{([^{}]*)\}/);
    if (!m) return [s];
    const head = s.slice(0, m.index);
    const tail = s.slice(m.index + m[0].length);
    if (!m[1].includes(",")) return expandBraces(`${head}*${tail}`);
    return m[1].split(",").flatMap((alt) => expandBraces(head + alt + tail));
  }

  const globHit = (pattern) => {
    const re = new RegExp(
      `^${pattern
        .replace(/\/+$/, "")
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")}$`,
    );
    return repoFiles.some((f) => re.test(f)) || [...dirs].some((d) => re.test(d));
  };

  function docClaim(file, line, token, slashy) {
    const key = `${file.split("/").pop()}|${token}`;
    const why = DOC_MENTIONS.get(key);
    if (why) {
      usedMentions.add(key);
      docNote(why);
      return;
    }
    // Dotfile lane, NON-slashy only: `.github/workflows/ci.yml` is a path and belongs to
    // the rooted rule below — routing it here by its leading dot suppressed it silently.
    if (!slashy && token.startsWith(".")) {
      if (!DOT_ROOTS.has(token.split(".").slice(0, 2).join("."))) {
        docNote("a leading dot that names no top-level entry of this repo (`.consent-scrim`, `.urxf`, `.toContain`)");
        return;
      }
      docChecked++;
      if (!byBase.has(token)) finding(`${file}:${line}`, `\`${token}\` names no file in the repository`);
      return;
    }
    if (!slashy) {
      docChecked++;
      if (byBase.has(token)) return;
      // The likeliest way a basename claim goes stale is a changed extension
      // (main.js → main.ts, a .yml workflow renamed .yaml), so name that file.
      const stem = token.slice(0, token.lastIndexOf("."));
      const alt = [...byBase.keys()].find((k) => k !== token && k.slice(0, k.lastIndexOf(".")) === stem);
      finding(
        `${file}:${line}`,
        `\`${token}\` names no file in the repository${alt ? ` (did you mean ${byBase.get(alt)[0]}?)` : ""}`,
      );
      return;
    }
    if (DOC_ROOTED.test(token)) {
      for (const variant of expandBraces(token)) {
        docChecked++;
        if (/[*?]/.test(variant)) {
          if (!globHit(variant)) finding(`${file}:${line}`, `\`${variant}\` matches no file in the repository`);
        } else {
          takePath(variant, line, "", file);
        }
      }
      return;
    }
    // Not rooted: a claim about this repo's layout only if it is shaped like a path AND
    // its first segment names a directory here. Everything else is a mention.
    if (!DOC_PATH_TAIL.test(token) && !/[*?]/.test(token)) {
      docNote("a slash that is not a path (`ON/OFF`, `Ctrl/Cmd`, `node/param`)");
      return;
    }
    const [head, ...rest] = token.replace(/\/+$/, "").split("/");
    const bases = dirsByName.get(head);
    if (!bases) {
      docNote("leading segment names no directory of this repo — another tree's path, or a build output");
      return;
    }
    for (const variant of expandBraces(rest.join("/"))) {
      docChecked++;
      const hit = !variant
        ? true
        : bases.some((b) => (/[*?]/.test(variant) ? globHit(`${b}/${variant}`) : existsSync(`${b}/${variant}`)));
      if (!hit) finding(`${file}:${line}`, `\`${token}\` — no ${head}/ directory in the repo holds ${variant}`);
    }
  }

  for (const file of docFiles) {
    let fenced = false;
    read(file)
      .split("\n")
      .forEach((raw, i) => {
        if (/^\s*```/.test(raw)) {
          fenced = !fenced;
          return;
        }
        const texts = fenced ? [raw] : [...raw.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
        docSpans += texts.length;
        for (const text of texts) {
          for (const m of text.matchAll(DOC_SLASHY)) {
            const token = trimTok(m[1]);
            if (token.includes("/")) docClaim(file, i + 1, token, true);
          }
          for (const m of text.matchAll(DOC_BASENAME)) docClaim(file, i + 1, trimTok(m[1]), false);
          for (const m of text.matchAll(DOC_DOTFILE)) docClaim(file, i + 1, trimTok(m[1]), false);
        }
        // The same two name rules over the prose, with the code spans and the link
        // targets removed. Not the slashy rule: outside backticks a slash is prose.
        if (!fenced) {
          const prose = raw.replace(/`[^`\n]*`/g, "").replace(MD_TARGET, "]()");
          for (const m of prose.matchAll(DOC_BASENAME)) docClaim(file, i + 1, trimTok(m[1]), false);
          for (const m of prose.matchAll(DOC_DOTFILE)) docClaim(file, i + 1, trimTok(m[1]), false);
        }
      });
  }
}

// Path misses, resolved against .gitignore in one spawn: a private path is skipped,
// a genuinely missing one fails.
const ignored = ignoredSet(pathMisses.map((m) => m.miss));
for (const m of pathMisses) {
  if (ignored.has(m.miss)) {
    (m.file === DOC ? skipped : docSkipped).push(m.miss);
    continue;
  }
  const base = m.miss.split("/").pop();
  const near = [...srcFiles, ...e2eFiles, ...scriptFiles].find((f) => f.endsWith("/" + base));
  finding(`${m.file}:${m.line}`, `\`${m.miss}\` does not resolve to a file${near ? ` (did you mean ${near}?)` : ""}`);
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
for (const row of scope.claudeMd ? rows : []) {
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

// Every code span in a row's FIRST cell — what "X has a row" has to mean. The rules
// below asked `sectionText.includes(file)` instead, which any mention satisfies: a row
// deleted and the same path written into a sentence of prose left the run green.
// Measured on this section — the E2E fixture table down to 43 rows, still OK. Exact
// match rather than substring, so one path cannot be answered by a longer one that
// contains it.
const rowAnchors = new Set(rows.flatMap((row) => firstCellSpans.get(row) ?? []));
const rowLineOf = new Map(rows.flatMap((row) => (firstCellSpans.get(row) ?? []).map((name) => [name, row])));

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
  //    pnpm script CLAUDE.md names, wired into the tracked hook, or — for a test —
  //    selected by a `pnpm test <filter>` row, which is how the pin table names one
  //    without spelling the path. All four are required: e2e-worktree.mjs /
  //    reset-storage.mjs are reached only through their pnpm scripts, md-hook.sh only
  //    through .claude/settings.json, and a test file only through its filter.
  for (const file of scriptFiles) {
    const base = file.split("/").pop();
    if (doc.includes(file) || testFilterHits.has(file)) continue;
    const viaScript = Object.entries(scripts).some(([name, cmd]) => cmd.includes(file) && named(name));
    if (viaScript || settingsText.includes(base)) continue;
    finding(file, `is in scripts/ but no row, pnpm script or hook names it`);
  }

  // C and D stay a MENTION check, unlike E/E2 above, and their messages say so: not
  // every one of these heads a row. A handle can be a fixture's surface rather than an
  // asset of its own (`__urxFake` belongs to the fake device's row), and a launch flag
  // is named in the "How" column of the tool it drives.

  // C. every published in-page handle is named somewhere in the section.
  for (const [name, side] of handles) {
    if (!sectionText.includes(name)) {
      finding(side === "src" ? "src/" : "e2e/", `${name} is published but is named nowhere in "${SECTION}"`);
    }
  }

  // D. every Tauri launch flag is named somewhere in the section.
  for (const flag of launchFlags) {
    if (!sectionText.includes(flag)) {
      finding("src-tauri/src/lib.rs", `launch flag ${flag} is named nowhere in "${SECTION}"`);
    }
  }

  // E. every E2E fixture (a non-spec .ts) has a row of its own.
  for (const file of e2eFiles.filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts"))) {
    if (!rowAnchors.has(file)) finding(file, `is an E2E fixture but heads no row`);
  }

  // E2. every unit fixture has a row, for the same reason as E — and this one did not
  //     exist while the table did, which is precisely why the table only ever listed
  //     the E2E half.
  for (const file of unitFixtures) {
    if (!rowAnchors.has(file)) finding(file, `is a unit fixture but heads no row`);
  }

  // E3. an inventory row names every export of the file it heads. E and E2 stop at "a
  //     row exists", which is what let this row stay green while the file gained two
  //     exports — measured over the twelve days this table has existed, eight commits
  //     added an export to a file whose row already existed and touched none of them.
  //     Naming the export rather than merely editing the row is the point: a diff-based
  //     rule is satisfied by any edit, including one that leaves the list wrong.
  for (const [file, why] of INVENTORY_ROWS) {
    const row = rowLineOf.get(file);
    if (row === undefined) {
      finding(DOC, `INVENTORY_ROWS names ${file}, which heads no row — drop the entry or restore the row`);
      continue;
    }
    const text = lines[row - 1];
    const missing = exportsOf(file).filter((name) => !text.includes(`\`${name}\``));
    if (missing.length) {
      finding(`${DOC}:${row}`, `${file} exports ${missing.join(", ")}, which this row does not name (${why})`);
    }
  }

  // F. every contract/pin test is covered by one of the section's `pnpm test <filter>`
  //    tokens — resolved, not string-matched, so meter-bench.contract.test.ts is
  //    satisfied by `pnpm test meter-bench` and the audit family by `pnpm test audit`.
  for (const file of unitTests.filter((f) => /\.(contract|audit)\.test\.ts$/.test(f))) {
    if (!testFilterHits.has(file)) finding(file, `is a contract/pin test that no \`pnpm test\` row selects`);
  }

  // G. a suppression that suppresses nothing. Both allowlists are exact-string pardons
  //    written for one span each; once that span is gone the entry only stands ready to
  //    pardon the next token that happens to be spelled the same way. Delete it instead.
  for (const token of PROSE_TOKENS.keys()) {
    if (!usedProse.has(token))
      finding(DOC, `PROSE_TOKENS entry \`${token}\` no longer matches any span in "${SECTION}" — delete it`);
  }
  for (const [key, why] of DOC_MENTIONS) {
    if (usedMentions.has(key)) continue;
    const [doc, token] = key.split("|");
    finding(
      DOC_DIRS.map((d) => `${d}/${doc}`).join(" / "),
      `DOC_MENTIONS entry \`${token}\` (${why}) no longer suppresses anything — delete it`,
    );
  }

  // H. every source file the map documents undertake to describe is named by one of them:
  //    CLAUDE.md's one-line directory map, or BOTH architecture.md translations, whose
  //    "Source layout" says outright that it is "what each file is for".
  //    Nothing looked this way round before. The docs half above only checks that a path a
  //    document NAMES exists, so a file no document mentions at all was invisible to every
  //    assertion here — which is how five modules extracted out of graph.ts and
  //    inspector.ts in one afternoon, and the DUCKER screen for three days, stayed outside
  //    the map while every check stayed green and CLAUDE.md still called DUCKER "to
  //    follow".
  //    Matched by BASENAME, because that is how these documents write a file inside a
  //    directory-scoped bullet ("`plan.ts` plan state", under `src/core/`) — and matched
  //    with BOUNDARIES, not as a substring: the first version asked `text.includes(base)`,
  //    which the mention of dyn-plot.ts answers for an unmapped plot.ts, exactly the
  //    substring-for-an-exact-thing defect rule E2 was fixed for one PR earlier. A `/` may
  //    precede the name so a mention written as a full path counts; `-` and `.` may not,
  //    since that is what separates a file from a longer name ending in it, and a trailing
  //    word character is refused so plan.tsx cannot answer for plan.ts.
  //    A duplicated basename (index.ts, device-setup.ts, link-stats.ts) can still be
  //    answered by its sibling's mention: this catches a file nothing describes, not one
  //    described under the wrong directory. Requiring BOTH translations is what makes a
  //    half-translated addition a finding rather than a silence.
  const mapDocs = DOC_DIRS.map((d) => `${d}/architecture.md`);
  const mapText = new Map(mapDocs.map((f) => [f, read(f)]));
  const absentMaps = mapDocs.filter((d) => !mapText.get(d));
  if (absentMaps.length) {
    // Reported once, for the same reason as the empty-corpus finding on the docs side: a
    // missing map would otherwise report every source file, and 95 findings read as a
    // broken check rather than as the one document that moved.
    finding(absentMaps.join(" / "), "is missing, so no source file could be checked against the map");
  } else {
    for (const file of mappedSources) {
      const base = file.split("/").pop();
      const named = new RegExp(String.raw`(?<![\w.-])${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\w-])`);
      if (named.test(doc)) continue;
      const absent = mapDocs.filter((d) => !named.test(mapText.get(d)));
      if (absent.length === mapDocs.length) finding(file, `is a source file that no map document names`);
      else if (absent.length) finding(file, `is named in one translation only — missing from ${absent.join(", ")}`);
    }
  }
}

// --- report -----------------------------------------------------------------

if (forwardOnly) {
  // The reverse half is excluded deliberately: it is legitimately red between
  // "delete the script" and "update the table", and a hook that blocks that
  // sequence gets ignored.
  if (findings.length) {
    reportFindings();
    process.exit(2);
  }
  process.exit(0);
}

if (findings.length) {
  reportFindings();
  console.error(`\n${findings.length} finding(s)`);
  process.exit(1);
}

// Named, not counted: a skip is the one outcome that looks like a pass, and a path
// that quietly became ignored (a build output, a moved directory) has to be readable
// off the OK line. Same for a mention the docs half pardoned by name.
const note = skipped.length ? ` (skipped as private/generated: ${[...new Set(skipped)].join(", ")})` : "";
// Computed rather than written down anywhere: this is the figure behind E3 being narrow,
// and four of the five prose copies it had were false at the revision that shipped them,
// because the edits that move it (a fixture's exports, a row's code spans) are in other
// files. Printed, it cannot disagree with the tree it was read from.
const census = [...rowAnchors]
  .filter((a) => e2eFixtures.includes(a) || unitFixtures.includes(a))
  .reduce(
    (acc, file) => {
      const text = lines[rowLineOf.get(file) - 1];
      for (const name of exportsOf(file)) {
        acc.total++;
        if (text.includes(`\`${name}\``)) acc.named++;
      }
      return acc;
    },
    { total: 0, named: 0 },
  );
console.log(
  `OK: ${spans.length} tokens${note}, ${checked} assertions, ${rows.length} rows, 7 inventories` +
    `, ${census.total - census.named} of ${census.total} fixture exports unnamed by their row`,
);
console.log(
  `    docs: ${docFileCount} files, ${docSpans} code spans, ${docChecked} file references (spans and prose)` +
    (docSkipped.length ? ` (skipped as private/generated: ${[...new Set(docSkipped)].join(", ")})` : "") +
    (docSkips.size ? `\n    suppressed: ${[...docSkips].map(([why, n]) => `${n}× ${why}`).join("; ")}` : ""),
);
