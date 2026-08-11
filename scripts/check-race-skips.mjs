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
//   `playwright test --list`  every collected case, with a declaration-time skip carried
//                             as an annotation of type "skip".
//   `vitest list --json`      the runnable cases only — skipped, conditionally skipped
//                             and never-registered ones are already absent.
//
// The price of being right is node_modules, so this runs from ci.yml rather than the
// install-free docs.yml. Nothing is lost by that: the Markdown/docs-only pull request
// ci.yml skips cannot change a spec or a guarantor.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RACE_DIR = "e2e/race";
const LEDGER = `${RACE_DIR}/skip-ledger.json`;
const key = (file, title) => `${file}::${title}`;

function run(bin, args) {
  return execFileSync(join(repo, "node_modules/.bin", bin), args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// Every case Playwright collects for a project, with the one fact the ledger needs beside
// the name: whether the declaration itself carries a skip. `--list` runs nothing, so a
// conditional `test.skip(cond)` inside a body cannot appear here — only a declared one.
function playwright(project) {
  const json = JSON.parse(run("playwright", ["test", `--project=${project}`, "--list", "--reporter=json"]));
  const root = json.config.rootDir;
  const out = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      out.push({
        file: relative(repo, resolve(root, spec.file)),
        title: spec.title,
        skipped: (spec.tests ?? []).some((t) => (t.annotations ?? []).some((a) => a.type === "skip")),
      });
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of json.suites ?? []) walk(suite);
  return out;
}

// Vitest lists what it would RUN. A skipped case, one inside a describe.skipIf/runIf that
// resolves away, and one that never registers are all simply absent — which is the
// question a guarantor has to answer, asked of the thing that answers it.
function vitest() {
  return JSON.parse(run("vitest", ["list", "--json"])).map((t) => ({
    file: relative(repo, t.file),
    // "outer > inner > the title" — the ledger names the leaf.
    title: t.name.split(" > ").at(-1),
  }));
}

const problems = [];
const collected = playwright("race");
const found = new Map();
for (const c of collected) if (c.skipped) found.set(key(c.file, c.title), c);

const runnable = new Set();
for (const t of playwright("chromium")) if (!t.skipped) runnable.add(key(t.file, t.title));
for (const t of vitest()) runnable.add(key(t.file, t.title));

const ledger = JSON.parse(readFileSync(join(repo, LEDGER), "utf8"));
const entries = new Map(ledger.skips.map((s) => [key(s.file, s.title), s]));

for (const [k, c] of found) {
  if (!entries.has(k)) problems.push(`${c.file}: skip "${c.title}" is not in ${LEDGER}`);
}
for (const [k, s] of entries) {
  if (!found.has(k)) problems.push(`${LEDGER}: entry "${s.title}" is not a skipped case in ${s.file}`);
}

const unguarded = [];
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
  const g = s.guardedBy;
  const gk = key(g.file, g.title);
  if (gk === k) {
    problems.push(`${LEDGER}: "${s.title}" is guarded by itself`);
  } else if (!runnable.has(gk)) {
    problems.push(
      `${LEDGER}: "${s.title}" is guarded by ${g.file} › "${g.title}", which no per-PR runner reports as a ` +
        `runnable test — a guard that does not run cannot report an expired reason`,
    );
  }
}

if (problems.length) {
  console.error(`FAIL: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log(`OK: ${found.size} permanent skip(s) of ${collected.length} cases Playwright collects in ${RACE_DIR}`);
console.log(
  `    ${found.size - unguarded.length} guarded by a test a per-PR runner runs, ${unguarded.length} held by nothing:`,
);
for (const s of unguarded) console.log(`    - ${s.file.replace(`${RACE_DIR}/`, "")} › ${s.title}`);
