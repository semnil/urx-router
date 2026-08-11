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
//     collects is no better, so the path must match what vitest and the ordinary
//     Playwright project actually take, and those two patterns are re-read from the
//     configs below so this copy of them cannot drift in silence.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RACE_DIR = "e2e/race";
const LEDGER = join(RACE_DIR, "skip-ledger.json");

// The two collection rules a guarantor can live under, and the literal each is read from.
// If a config stops saying its half, the mirror is stale and this check says so rather
// than quietly widening.
const COLLECTED = [
  {
    config: "vitest.config.ts",
    literal: `include: ["src/**/*.test.ts"]`,
    takes: (f) => f.startsWith("src/") && f.endsWith(".test.ts"),
    label: "vitest",
  },
  {
    config: "playwright.config.ts",
    literal: `testIgnore: "race/**"`,
    takes: (f) => f.startsWith("e2e/") && !f.startsWith(`${RACE_DIR}/`) && /\.(spec|test)\.ts$/.test(f),
    label: "the ordinary Playwright project",
  },
];

const read = (rel) => readFileSync(join(repo, rel), "utf8");
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

const ledger = JSON.parse(read(LEDGER));
const entries = new Map(ledger.skips.map((s) => [key(s.file, s.title), s]));
const problems = [];

for (const { config, literal } of COLLECTED) {
  if (!read(config).includes(literal)) {
    problems.push(
      `${config} no longer says \`${literal}\` — the guarantor allow-list here mirrors it and is now stale`,
    );
  }
}
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
  const runner = COLLECTED.find((c) => c.takes(g.file));
  if (!runner) {
    problems.push(
      `${where} is guarded by ${g.file}, which neither vitest nor the ordinary Playwright project collects — ` +
        `a guard nothing runs cannot report an expired reason`,
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
