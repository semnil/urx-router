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
// Everything below is one idea applied five ways: a `guardedBy` has to name something
// that RUNS. Each rule is a way an earlier version of this script was satisfied by
// something that guarantees nothing, and each was found by trying to fool it:
//
//   - comments are stripped first. A renamed test whose old definition survives as
//     `// it("<old title>", …)` satisfied a raw substring search, and so did a
//     commented-out skip on the collection side.
//   - a suite is not a test, and a skipped suite runs nothing. `test.describe(…)` matched
//     the definition pattern, and an `it` inside `describe.skipIf(…)` matched while never
//     executing; both are refused by brace-matching the skipped suites and excluding what
//     falls inside them.
//   - the guarantor may not be the skip itself. Self-reference passed trivially.
//   - it may not live in e2e/race: that tier runs on the version-bump pull request alone,
//     so its assertions can break for dozens of merges while this check still sees the
//     title. Being outside that directory is not enough either — a file no runner
//     collects is no better, so the path has to match what vitest and the ordinary
//     Playwright project actually take, and those globs are READ OUT of the two configs
//     rather than copied here. The first version copied them and failed on its first
//     encounter with an unrelated edit: vitest's `include` grew a second entry, the
//     copied literal stopped matching, and the check reported drift where the meaning
//     had not changed. A derived list has nothing to drift.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RACE_DIR = "e2e/race";
const LEDGER = join(RACE_DIR, "skip-ledger.json");

const read = (rel) => readFileSync(join(repo, rel), "utf8");
// The three glob shapes these configs use, and no more: `**/` at any depth, a trailing
// `**` for everything below, `*` within one segment. Translating a trailing `**` as "any
// depth" and nothing else is what let e2e/race back in — the pattern then demanded a path
// ENDING in a slash, so no file matched it and testIgnore ignored nothing. The two
// placeholders keep each rewrite from being re-read by the ones after it.
const globRe = (g) => {
  const src = g
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\/\*\*$/, "@BELOW@")
    .replace(/\*\*\//g, "@DEEP@")
    .replace(/\*/g, "[^/]*")
    .replace(/@BELOW@/g, "(?:/.*)?")
    .replace(/@DEEP@/g, "(?:[^/]*/)*");
  return new RegExp(`^${src}$`);
};

// Where a guarantor may live, derived from the configs that decide it. Anything these
// cannot be read out of is a hard failure: guessing would put the allow-list back to
// being a copy, and a wrong one is exactly the shape this whole check is about.
function collectionRules() {
  const rules = [];
  const vitest = read("vitest.config.ts");
  const include = vitest.match(/\binclude:\s*\[([^\]]*)\]/);
  if (!include) throw new Error("vitest.config.ts: could not read test.include");
  const globs = [...include[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
  rules.push({
    label: `vitest (${globs.join(", ")})`,
    takes: (f) => globs.some((g) => globRe(g).test(f)),
  });

  const pw = read("playwright.config.ts");
  const dir = pw.match(/\btestDir:\s*["'`]([^"'`]+)["'`]/);
  const ignore = pw.match(/\btestIgnore:\s*["'`]([^"'`]+)["'`]/);
  if (!dir || !ignore) throw new Error("playwright.config.ts: could not read testDir / testIgnore");
  const ignored = globRe(`${dir[1]}/${ignore[1]}`);
  rules.push({
    label: `the ordinary Playwright project (${dir[1]}, minus ${ignore[1]})`,
    // Playwright's default testMatch, which this config does not override.
    takes: (f) => f.startsWith(`${dir[1]}/`) && /\.(spec|test)\.[jt]sx?$/.test(f) && !ignored.test(f),
  });
  return rules;
}

const key = (file, title) => `${file}::${title}`;
const quoted = (title) => [JSON.stringify(title), `'${title}'`, `\`${title}\``];
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Blank out comments, keeping length and newlines so every index still lines up with the
// original. String and template bodies are walked through rather than scanned, so a `//`
// inside a test title is not mistaken for the start of a comment.
function withoutComments(src) {
  const out = src.split("");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") out[i++] = " ";
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i++) if (src[i] !== "\n") out[i] = " ";
      i--;
    } else if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
    }
  }
  return out.join("");
}

// Ranges covered by a suite that does not run: describe.skip / .skipIf / .fixme / .todo.
// Both call shapes have to be followed to the end of the BODY, and they differ: `.skip(…)`
// takes the title and the callback in one group, while `.skipIf(cond)(…)` is curried and
// its first group is only the condition — stopping at that one was how an `it` inside a
// skipped suite went on counting as a live guard.
function skippedSuites(src) {
  const ranges = [];
  const head = /(^|[^.\w])(test\.describe|describe)((?:\.\w+)*)\s*(?=\()/g;
  for (const m of src.matchAll(head)) {
    if (!/\.(skip|skipIf|fixme|todo)\b/.test(m[3])) continue;
    let i = m.index + m[0].length;
    while (src[i] === "(") {
      let depth = 0;
      for (; i < src.length; i++) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")" && --depth === 0) break;
      }
      i++; // past the ")"
      while (/\s/.test(src[i] ?? "")) i++;
    }
    ranges.push([m.index, i]);
  }
  return ranges;
}

// Playwright's default testMatch takes both .spec.ts and .test.ts, and testDir recurses —
// a skip in either, at any depth, is one the harness collects.
function collected(rel) {
  const out = [];
  for (const name of readdirSync(join(repo, rel)).sort()) {
    const child = `${rel}/${name}`;
    if (statSync(join(repo, child)).isDirectory()) out.push(...collected(child));
    else if (/\.(spec|test)\.ts$/.test(name)) out.push(child);
  }
  return out;
}

const SKIP = /^\s*test\.skip\(\s*(["'`])(.+?)\1/gm;
const found = new Map();
for (const file of collected(RACE_DIR)) {
  for (const m of withoutComments(read(file)).matchAll(SKIP)) found.set(key(file, m[2]), { file, title: m[2] });
}

const RULES = collectionRules();
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
  const where = `${LEDGER}: "${s.title}"`;
  if (key(g.file, g.title) === k) {
    problems.push(`${where} is guarded by itself`);
    continue;
  }
  const runner = RULES.find((c) => c.takes(g.file));
  if (!runner) {
    problems.push(
      `${where} is guarded by ${g.file}, which no runner collects — a guard nothing runs cannot ` +
        `report an expired reason. Collected here: ${RULES.map((r) => r.label).join("; ")}`,
    );
    continue;
  }
  let src;
  try {
    src = withoutComments(read(g.file));
  } catch {
    problems.push(`${where} is guarded by ${g.file}, which does not exist`);
    continue;
  }
  const suites = skippedSuites(src);
  // An active definition: `test("…"` / `it("…"` with no skip-ish modifier, not a suite,
  // not inside a suite that is itself skipped. Whether it PASSES is the runner's job in
  // the same CI; what is checked here is that it is still there and still runnable.
  const active = quoted(g.title).some((q) => {
    const re = new RegExp(String.raw`(^|[^.\w])(test|it)((?:\.\w+)*)\s*\(\s*${escape(q)}`, "g");
    for (const m of src.matchAll(re)) {
      if (/\.(skip|skipIf|fixme|todo|describe)\b/.test(m[3])) continue;
      if (suites.some(([a, b]) => m.index > a && m.index < b)) continue;
      return true;
    }
    return false;
  });
  if (!active) {
    problems.push(`${where} is guarded by ${g.file} › "${g.title}", which that file does not define as an active test`);
  } else {
    s._runner = runner.label;
  }
}

if (problems.length) {
  console.error(`FAIL: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log(`OK: ${found.size} permanent skip(s) in ${RACE_DIR}, all registered`);
console.log(
  `    ${found.size - unguarded.length} guarded by a test a per-PR runner collects, ${unguarded.length} held by nothing:`,
);
for (const s of unguarded) console.log(`    - ${s.file.replace(`${RACE_DIR}/`, "")} › ${s.title}`);
