#!/usr/bin/env node
// A skipped race case reports as "-", never as a pass, so it cannot make the harness
// green while measuring nothing. What it CAN do is outlive its reason: every skip here
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
// Three rules make a `guardedBy` mean what it says, each of them a way the first version
// of this script could be satisfied by something that guarantees nothing:
//
//   - the guarantor must be an ACTIVE test definition. A bare substring search is happy
//     with a comment, with `test.skip("<same title>")`, or with the ledger's own words
//     quoted somewhere — none of which runs.
//   - it may not be the skip itself. Self-reference passed the substring search trivially.
//   - it may not live in e2e/race. That tier runs on the version-bump pull request alone,
//     so its assertions can break for dozens of merges while this check keeps reporting
//     the title it can still see. A guard nothing runs is not a guard; the entry belongs
//     in `unguarded` until a per-PR test exists.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RACE_DIR = "e2e/race";
const LEDGER = join(RACE_DIR, "skip-ledger.json");

const read = (rel) => readFileSync(join(repo, rel), "utf8");
const key = (file, title) => `${file}::${title}`;
const quoted = (title) => [JSON.stringify(title), `'${title}'`, `\`${title}\``];

// `test.skip("<title>"` — the only form used here, and the one the ledger keys on. A
// conditional skip (test.skip(cond) inside a body) takes no title and is not this: it is
// a runtime decision, not a permanent one, and belongs to the case rather than here.
const SKIP = /^\s*test\.skip\(\s*(["'`])(.+?)\1/gm;

// Playwright's testDir walks subdirectories, so this has to as well — a spec one level
// down was invisible to the first version, which is a skip nothing would have registered.
function specs(rel) {
  const out = [];
  for (const name of readdirSync(join(repo, rel)).sort()) {
    const child = `${rel}/${name}`;
    if (statSync(join(repo, child)).isDirectory()) out.push(...specs(child));
    else if (name.endsWith(".spec.ts")) out.push(child);
  }
  return out;
}

const found = new Map();
for (const file of specs(RACE_DIR)) {
  for (const m of read(file).matchAll(SKIP)) found.set(key(file, m[2]), { file, title: m[2] });
}

const ledger = JSON.parse(read(LEDGER));
const entries = new Map(ledger.skips.map((s) => [key(s.file, s.title), s]));
const problems = [];

for (const [k, { file, title }] of found) {
  if (!entries.has(k)) problems.push(`${file}: skip "${title}" is not in ${LEDGER}`);
}
for (const [k, s] of entries) {
  if (!found.has(k)) problems.push(`${LEDGER}: entry "${s.title}" names no skip in ${s.file}`);
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
  if (key(g.file, g.title) === k) {
    problems.push(`${LEDGER}: "${s.title}" is guarded by itself`);
    continue;
  }
  if (g.file === RACE_DIR || g.file.startsWith(`${RACE_DIR}/`)) {
    problems.push(
      `${LEDGER}: "${s.title}" is guarded by ${g.file}, which runs on the version-bump PR alone — ` +
        `a guard the ordinary tier never executes cannot report an expired reason`,
    );
    continue;
  }
  let text;
  try {
    text = read(g.file);
  } catch {
    problems.push(`${LEDGER}: "${s.title}" is guarded by ${g.file}, which does not exist`);
    continue;
  }
  // An active definition, not a mention: `test("…"` / `it("…"` and nothing modified by
  // .skip / .fixme / .failing. Whether it PASSES is the suite's job in the same CI; what
  // is checked here is that it is still there, still runnable, under the name relied on.
  const active = quoted(g.title).some((q) =>
    new RegExp(
      String.raw`(^|[^.\w])(test|it)\s*(\.(only|concurrent|serial|parallel|describe))*\s*\(\s*${escape(q)}`,
    ).test(text),
  );
  if (!active) {
    problems.push(
      `${LEDGER}: "${s.title}" is guarded by ${g.file} › "${g.title}", which that file does not define as an active test`,
    );
  }
}

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (problems.length) {
  console.error(`FAIL: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log(`OK: ${found.size} permanent skip(s) in ${RACE_DIR}, all registered`);
console.log(
  `    ${found.size - unguarded.length} guarded by a test the ordinary tier runs, ${unguarded.length} held by nothing:`,
);
for (const s of unguarded) console.log(`    - ${s.file.replace(`${RACE_DIR}/`, "")} › ${s.title}`);
