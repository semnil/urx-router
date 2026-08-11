#!/usr/bin/env node
// A skipped race case reports as "-", never as a pass, so it cannot make the harness
// green while measuring nothing. What it CAN do is outlive its reason: every skip here
// is permanent and justified by a fact about the app or the harness ("unreachable from
// the UI in this build", "every send is fixed in the model"), and a fact like that
// expires without anyone reading the comment that rests on it.
//
// So each skip is registered in e2e/race/skip-ledger.json with one of two things. A
// `guardedBy` names the test that keeps the reason true — delete or rename that test and
// this check fails, which is the link a reader could not otherwise make. An `unguarded`
// says outright that nothing holds it and what observation would settle it; those are
// counted and printed on every run, so "no predicate" is a number rather than a silence.
//
// The prose reason stays in the comment beside the skip. Duplicating it here would be a
// second copy to go stale, which is the failure this whole check exists to catch.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RACE_DIR = "e2e/race";
const LEDGER = join(RACE_DIR, "skip-ledger.json");

const read = (rel) => readFileSync(join(repo, rel), "utf8");
const key = (file, title) => `${file}::${title}`;

// `test.skip("<title>"` — the only form used here, and the one the ledger keys on. A
// conditional skip (test.skip(cond) inside a body) takes no title and is not this: it is
// a runtime decision, not a permanent one, and belongs to the case rather than here.
const SKIP = /^\s*test\.skip\(\s*(["'])(.+?)\1/gm;

const found = new Map();
for (const name of readdirSync(join(repo, RACE_DIR))
  .filter((n) => n.endsWith(".spec.ts"))
  .sort()) {
  const file = `${RACE_DIR}/${name}`;
  const text = read(file);
  for (const m of text.matchAll(SKIP)) found.set(key(file, m[2]), { file, title: m[2] });
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
  const has = (s.guardedBy ? 1 : 0) + (s.unguarded ? 1 : 0);
  if (has !== 1) {
    problems.push(`${LEDGER}: "${s.title}" needs exactly one of guardedBy / unguarded`);
    continue;
  }
  if (s.unguarded) {
    unguarded.push(s);
    continue;
  }
  // A guarantor is checked by presence, not by outcome: whether it PASSES is the test
  // suite's job, and it runs in the same CI. What is checked here is that it still
  // exists under the name the ledger relies on.
  const { file, title } = s.guardedBy;
  let text;
  try {
    text = read(file);
  } catch {
    problems.push(`${LEDGER}: "${s.title}" is guarded by ${file}, which does not exist`);
    continue;
  }
  if (!text.includes(JSON.stringify(title)) && !text.includes(`'${title}'`)) {
    problems.push(`${LEDGER}: "${s.title}" is guarded by ${file} › "${title}", which that file no longer defines`);
  }
}

if (problems.length) {
  console.error(`FAIL: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log(`OK: ${found.size} permanent skip(s) in ${RACE_DIR}, all registered`);
console.log(`    ${found.size - unguarded.length} guarded by a named test, ${unguarded.length} held by nothing:`);
for (const s of unguarded) console.log(`    - ${s.file.replace(`${RACE_DIR}/`, "")} › ${s.title}`);
