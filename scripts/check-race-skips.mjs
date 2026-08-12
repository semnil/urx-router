#!/usr/bin/env node
// A skipped race case reports as "-", never as a pass, so it cannot make the harness
// green while measuring nothing. What it CAN do is outlive its reason: every skip there
// is permanent and justified by a fact about the app or the harness ("unreachable from
// the UI in this build", "every send is fixed in the model"), and a fact like that
// expires without anyone reading the comment that rests on it.
//
// So each skip is registered in e2e/race/skip-ledger.json with one of two things. A
// `guardedBy` names the test that keeps the reason true — break or rename that test and
// this check fails, which is the link a reader could not otherwise make. An `unguarded`
// says outright that nothing holds it and what observation would settle it; those are
// counted and printed on every run, so "no predicate" is a number rather than a silence.
//
// The prose reason stays in the comment beside the skip. Duplicating it here would be a
// second copy to go stale, which is the failure this whole check exists to catch.
//
// EVERYTHING BELOW IS ASKED OF THE RUNNERS. Nothing reads the sources, because four
// rounds of review said one thing four ways: a `guardedBy` has to name a test that RUNS,
// and no amount of pattern matching decides that. Every version was satisfied by
// something inert — a title left in a comment, a suite that is itself skipped,
// `describe.runIf(false)`, an `it` inside `if (false)`, a title inside a string, a
// `.spec.js` the scan's extension list did not carry. The runners settle all of it at
// once, because collecting a spec EXECUTES it: a case in dead code or in a string never
// registers, and one that registers with a declared skip is marked as such.
//
//   `playwright test --list`  every case e2e/race collects, and whether its declaration means
//                             it will not run (`expectedStatus`).
//   `vitest run` on the guard files, because collecting is not enough on that side: a case
//                             that skips from inside its own body — `({ skip }) => skip()` —
//                             is listed exactly like one that asserts, and reports as a skip.
//                             A guard has to have RUN, so the state it ended in is what is
//                             read. Its cost is the guard files alone, and it scales with
//                             how many the ledger names: 0.47 s for one file, 6.9 s for the
//                             five it names now (measured 2026-08-13; nearly all of it is
//                             main.device.test.ts booting the app 24 times). ci.yml runs the
//                             whole unit suite in the same job anyway, so this is seconds
//                             counted twice rather than minutes added.
//
// Which is why a guard must be a unit test. The same question about an E2E case can only be
// answered by running the tier — the bundle built and served, minutes rather than seconds —
// and every cheaper answer is one this review already broke: `test.fixme` collects with an
// annotation that is not "skip", and a `test.skip()` in a body is invisible to `--list`
// altogether. So an E2E guard is refused, with the two ways out named in the message.
//
// A ledger row names a case in full — every describe title down to the leaf, joined with
// vitest's own separator (Playwright reports the tree as a tree, so the same join is applied
// to it) — rather than by the leaf alone. Two describes may carry the same leaf title, and
// with the leaf alone one row then answered for both cases. Nothing here splits
// that name back apart either: a leaf title may contain the separator, and a fragment of one
// is not a name.
//
// A joined name is still not a unique address, and no join makes it one: ["a > b", "c"] and
// ["a", "b > c"] are two different cases with the same joined name, and Playwright's own
// duplicate-title refusal does not catch them because it joins on a different separator. So
// the name is not trusted to be unique — it is CHECKED. A ledger row whose name matches more
// than one collected case is refused, and so is a guardedBy that matches more than one
// runnable test.
//
// Both runners are asked for their report in a FILE rather than on stdout. A single top-level
// console.log in any spec prints ahead of the JSON, and parsing stdout then fails on a tree
// that is perfectly healthy — a check that a stray debug line can take down is a check that
// gets deleted.
//
// The price of being right is node_modules, so this runs from ci.yml rather than the
// install-free docs.yml. Nothing is lost by that: the Markdown/docs-only pull request
// ci.yml skips cannot change a spec or a guarantor.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The ledger writes repo-relative paths with forward slashes on every platform; Windows would
// otherwise hand back src\core\… and no entry would match anything.
const rel = (p) => relative(repo, p).split(sep).join("/");
const RACE_DIR = "e2e/race";
const LEDGER = `${RACE_DIR}/skip-ledger.json`;
// What vitest prints between a describe and what it contains; Playwright reports the tree as
// a tree, and the same join is applied to it.
const NAME_SEP = " > ";
const key = (file, title) => `${file}::${title}`;

const reports = mkdtempSync(join(tmpdir(), "urx-skip-check-"));
process.on("exit", () => rmSync(reports, { recursive: true, force: true }));

function fatal(lines) {
  console.error("FAIL: the collection this check reads could not be produced");
  for (const line of lines) console.error(`  ${line}`);
  process.exit(1);
}

// Each runner is started as its own JavaScript entry under this node, not through
// node_modules/.bin. That directory holds a shell script and a .cmd on Windows, and node
// refuses to spawn a .cmd without a shell — so the .bin path is one that works on the CI
// runner and not on half the machines this repo is developed on.
const require = createRequire(import.meta.url);
function entry(pkg, bin) {
  const manifest = require.resolve(`${pkg}/package.json`);
  const declared = JSON.parse(readFileSync(manifest, "utf8")).bin;
  return resolve(dirname(manifest), typeof declared === "string" ? declared : declared[bin]);
}

function run(pkg, bin, args, env) {
  const r = spawnSync(process.execPath, [entry(pkg, bin), ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error) fatal([`${bin} could not be started: ${r.error.message}`]);
  return r;
}

function readReport(file, r, what) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    fatal([`${what} exited ${r.status} and wrote no report`, ...r.stderr.trim().split("\n").slice(0, 10)]);
  }
}

// Every case Playwright collects for a project, with the one fact the ledger needs beside
// the name: whether the declaration means it will not run. That is `expectedStatus`, not the
// annotation list — `test.fixme` is as permanent a skip as `test.skip` and its annotation is
// "fixme", so reading the annotations misses it while the runner reports both as "skipped".
// `--list` runs nothing, so a `test.skip()` inside a body cannot appear here in any form.
// The outermost suite is the file, so the trail starts below it.
function playwright(project) {
  const file = join(reports, `playwright-${project}.json`);
  const what = `playwright --list (${project})`;
  const r = run("@playwright/test", "playwright", ["test", `--project=${project}`, "--list", "--reporter=json"], {
    PLAYWRIGHT_JSON_OUTPUT_NAME: file,
  });
  const json = readReport(file, r, what);
  const errors = (json.errors ?? []).map((e) => e.message?.split("\n")[0] ?? String(e));
  if (r.status !== 0 || errors.length) fatal([`${what} exited ${r.status}`, ...errors]);
  const root = json.config.rootDir;
  const out = [];
  const walk = (suite, trail) => {
    for (const spec of suite.specs ?? []) {
      out.push({
        file: rel(resolve(root, spec.file)),
        title: [...trail, spec.title].join(NAME_SEP),
        skipped: (spec.tests ?? []).some((t) => t.expectedStatus === "skipped"),
      });
    }
    for (const child of suite.suites ?? []) walk(child, [...trail, child.title]);
  };
  for (const suite of json.suites ?? []) walk(suite, []);
  return out;
}

// The guard files, actually run: every case in them with the state vitest ends up giving it.
// A file matching nothing is not an error here — the guardedBy naming it is reported as a row
// problem, which says far more than "no test files found". The reporter's own `fullName` joins
// on a space, so the name is rebuilt from the structured ancestors instead.
function vitestRun(files) {
  const file = join(reports, "vitest-run.json");
  const args = ["run", "--reporter=json", `--outputFile=${file}`, "--passWithNoTests", ...files];
  const r = run("vitest", "vitest", args);
  const json = readReport(file, r, "vitest run");
  const out = new Map();
  for (const result of json.testResults ?? []) {
    for (const a of result.assertionResults ?? []) {
      const k = key(rel(result.name), [...(a.ancestorTitles ?? []), a.title].join(NAME_SEP));
      out.set(k, [...(out.get(k) ?? []), a.status]);
    }
  }
  return out;
}

const problems = [];
const tally = (map, k) => map.set(k, (map.get(k) ?? 0) + 1);

const collected = playwright("race");
const raceNames = new Map();
for (const c of collected) tally(raceNames, key(c.file, c.title));

const found = new Map();
for (const c of collected) {
  if (!c.skipped) continue;
  const k = key(c.file, c.title);
  if (raceNames.get(k) > 1 && !found.has(k)) {
    problems.push(
      `${c.file}: "${c.title}" is the full name of ${raceNames.get(k)} collected cases, so no row addresses one`,
    );
  }
  found.set(k, c);
}

const ledger = JSON.parse(readFileSync(join(repo, LEDGER), "utf8"));

// A floor on what the tier collects. Everything above answers questions about the cases
// Playwright DID collect, so a case that stops being collected at all is invisible to it:
// only a total collection failure is caught (`--list` exits non-zero, see fatal above),
// and short of that, deleting a case — or a whole file — leaves every assertion here
// satisfied and the check green. Measured when this was written: of the 170 cases
// collected, 8 are registered skips in 4 files, so 162 could go one at a time and 118
// could go by the file with nothing objecting.
//
// A MINIMUM per file, not an exact count: adding cases must not be a chore, and the
// failure this guards against is loss. Every file now above its floor is printed at the
// end in the ledger's own shape, so raising one deliberately is a copy-paste rather than
// arithmetic.
{
  const floors = ledger.collect?.minCases ?? {};
  const actual = new Map();
  for (const c of collected) tally(actual, c.file);
  for (const [file, min] of Object.entries(floors)) {
    const n = actual.get(file) ?? 0;
    if (n < min) {
      problems.push(
        `${file}: collects ${n} case(s), below the floor of ${min} in ${LEDGER} — ` +
          `a case that stops being collected is a check that stops running`,
      );
    }
  }
  for (const file of actual.keys()) {
    if (!(file in floors)) problems.push(`${LEDGER}: ${file} is collected but has no collect.minCases floor`);
  }
}

const entries = new Map();
for (const s of ledger.skips) {
  const k = key(s.file, s.title);
  if (entries.has(k)) problems.push(`${LEDGER}: "${s.title}" in ${s.file} is registered twice`);
  entries.set(k, s);
}

for (const [k, c] of found) {
  if (!entries.has(k)) problems.push(`${c.file}: skip "${c.title}" is not in ${LEDGER}`);
}
for (const [k, s] of entries) {
  if (!found.has(k)) problems.push(`${LEDGER}: entry "${s.title}" is not a skipped case in ${s.file}`);
}

const unguarded = [];
const guards = [];
for (const [k, s] of entries) {
  if (!found.has(k)) continue;
  if (Boolean(s.guardedBy) === Boolean(s.unguarded)) {
    problems.push(`${LEDGER}: "${s.title}" needs exactly one of guardedBy / unguarded`);
    continue;
  }
  if (s.unguarded) {
    unguarded.push(s);
    continue;
  }
  const gk = key(s.guardedBy.file, s.guardedBy.title);
  if (gk === k) problems.push(`${LEDGER}: "${s.title}" is guarded by itself`);
  else guards.push({ entry: s, gk, at: `${s.guardedBy.file} › "${s.guardedBy.title}"` });
}

// A guard has to be a unit test, and it is RUN. Collection is not enough: a vitest case that
// skips from inside its own body is listed like any other, and on the Playwright side
// `test.fixme` reports as a collected case whose annotation is not "skip" at all, while a
// `test.skip()` in a body is not visible to `--list` in any form. Verifying an E2E guard
// therefore means running the tier — building the bundle and serving it, minutes rather than
// seconds — so an E2E case is refused as a guard rather than accepted on its declaration.
// Only the guard's own result is read; a sibling failing in the same file is the suite's
// business, not this check's.
const results = guards.length ? vitestRun([...new Set(guards.map((x) => x.entry.guardedBy.file))]) : new Map();

for (const x of guards) {
  const states = results.get(x.gk) ?? [];
  if (states.length === 0) {
    problems.push(
      `${LEDGER}: "${x.entry.title}" is guarded by ${x.at}, which vitest does not run` +
        (x.entry.guardedBy.file.startsWith("e2e/")
          ? ` — an E2E case cannot hold a row here, because this check cannot run one: name a unit test, or ` +
            `record the row as unguarded with what would settle it`
          : ` — a guard that does not run cannot report an expired reason`),
    );
  } else if (states.length > 1) {
    problems.push(
      `${LEDGER}: "${x.entry.title}" is guarded by ${x.at}, which is the full name of ${states.length} ` +
        `runnable tests — the row does not say which one holds the reason`,
    );
  } else if (states[0] !== "passed") {
    problems.push(
      `${LEDGER}: "${x.entry.title}" is guarded by ${x.at}, which vitest reports as "${states[0]}" rather than ` +
        `a pass — a guard whose assertions do not execute cannot report an expired reason`,
    );
  }
}

if (problems.length) {
  console.error(`FAIL: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

// Printed in the ledger's own shape, and only for files that have grown: a floor is
// raised by pasting these lines, so the alternative is counting by hand. Silent when
// every floor is exact, which is the state the ledger is committed in.
{
  const floors = ledger.collect?.minCases ?? {};
  const actual = new Map();
  for (const c of collected) tally(actual, c.file);
  const grown = [...actual].filter(([f, n]) => n > (floors[f] ?? 0)).sort();
  if (grown.length) {
    console.log(`    ${grown.length} file(s) now above their floor — paste to raise:`);
    for (const [f, n] of grown) console.log(`      ${JSON.stringify(f)}: ${n},`);
  }
}

console.log(`OK: ${found.size} permanent skip(s) of ${collected.length} cases Playwright collects in ${RACE_DIR}`);
console.log(`    ${guards.length} guarded by a unit test that runs and passes, ${unguarded.length} held by nothing:`);
for (const s of unguarded) console.log(`    - ${s.file.replace(`${RACE_DIR}/`, "")} › ${s.title}`);
