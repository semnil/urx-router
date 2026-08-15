#!/usr/bin/env node
// Derives `collect.shardWeights` in e2e/race/skip-ledger.json — how many cases each
// `--shard=k/N` of the race harness takes — from a race.yml run that actually happened.
//
//   node scripts/race-shard-weights.mjs <run id>        a race.yml run, read through `gh`
//   node scripts/race-shard-weights.mjs --log <file>    the same log already on disk
//   …                                 --shards <N>      a different shard count (default: the
//                                                       length of the array in the ledger)
//
// Prints the array to paste. It writes nothing: the ledger is where a human decides the
// split lives, and this is the arithmetic behind it.
//
// WHY there is an array at all. Playwright's own sharding takes a CONTIGUOUS slice of the
// collected order and sizes it by case count (`filterForShard` walks the groups in path
// order and cuts on a cumulative count). Equal counts are not equal times here: the six
// t2*-shape-change files are adjacent in that order and are the expensive ones, so one
// shard inherits them. `PWTEST_SHARD_WEIGHTS` sizes the same contiguous slices, so this
// only has to choose the two cut points — which it does against measured durations.
//
// The model the cuts are chosen under: each shard runs 2 workers, Playwright hands the
// next case to whichever is free, and a shard costs about 9 s of worker startup on top.
// Checked against the run this was first derived from — predicted 381 / 144 / 261 s
// against 380 / 143 / 261 s observed — which is what makes a predicted wall worth
// optimizing rather than a number to admire.
//
// The result is VERIFIED before it is printed: `--list --shard=k/N` is re-run under the
// weights and the counts have to come back exactly. A cut cannot land inside an
// indivisible group (a `test.describe.serial` block travels whole), and rather than model
// that, the plan is asked of the runner and refused if it does not hold.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = "e2e/race/skip-ledger.json";
const WORKERS = 2;
const WORKER_START_MS = 9_000;

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? null : args[i + 1];
};
const runId = args.find(
  (a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--log" && args[args.indexOf(a) - 1] !== "--shards",
);

function die(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

// --- the run's own durations -------------------------------------------------

// The list reporter's own line, whatever wraps it: `gh run view --log` prefixes every line
// with a job name, a step name and a timestamp, and a log read from disk may not.
const LINE = /[✓✘×✕±-]\s+\d+\s+\[race\]\s+›\s+(\S+?\.spec\.ts):(\d+):\d+\s+›\s+(.+?)\s+\((\d+(?:\.\d+)?)(ms|s|m)\)\s*$/;
const SCALE = { ms: 1, s: 1_000, m: 60_000 };
const key = (file, line, title) => `${file.split("/").pop()}:${line}|${title.split(" › ").pop().trim()}`;

function durations(text) {
  const out = new Map();
  for (const raw of text.split("\n")) {
    const m = raw.match(LINE);
    if (!m) continue;
    out.set(key(m[1], m[2], m[3]), Number(m[4]) * SCALE[m[5]]);
  }
  return out;
}

function logText() {
  const file = flag("--log");
  if (file) return readFileSync(file, "utf8");
  if (!runId) die("give a race.yml run id, or --log <file> — see the header");
  // Not piped into anything: a pipeline's status is its last command's, and a `gh` that
  // could not read the run would arrive here as an empty log rather than as a failure.
  const r = spawnSync("gh", ["run", "view", runId, "--log"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error) die(`gh could not be started: ${r.error.message}`);
  if (r.status !== 0) die(`gh run view ${runId} exited ${r.status}: ${r.stderr.trim().split("\n")[0] ?? ""}`);
  return r.stdout;
}

// --- the collected order -----------------------------------------------------

const require = createRequire(import.meta.url);
function playwright(extra, env) {
  const manifest = require.resolve("@playwright/test/package.json");
  const declared = JSON.parse(readFileSync(manifest, "utf8")).bin;
  const bin = resolve(dirname(manifest), typeof declared === "string" ? declared : declared.playwright);
  const r = spawnSync(process.execPath, [bin, "test", "--project=race", "--list", "--reporter=json", ...extra], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) die(`playwright could not be started: ${r.error.message}`);
  const json = (() => {
    try {
      return JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    } catch {
      die(
        `playwright --list exited ${r.status} and printed no report:\n${r.stderr.trim().split("\n").slice(0, 8).join("\n")}`,
      );
    }
  })();
  const out = [];
  const walk = (suite) => {
    for (const child of suite.suites ?? []) walk(child);
    for (const spec of suite.specs ?? []) out.push({ key: key(spec.file, spec.line, spec.title), file: spec.file });
  };
  for (const suite of json.suites ?? []) walk(suite);
  return out;
}

// --- the split ---------------------------------------------------------------

// One shard's wall: the cases in declaration order, handed to whichever worker is free.
const wallOf = (ms, from, to) => {
  const w = Array(WORKERS).fill(0);
  for (let i = from; i < to; i++) {
    let at = 0;
    for (let k = 1; k < WORKERS; k++) if (w[k] < w[at]) at = k;
    w[at] += ms[i];
  }
  return Math.max(...w) + WORKER_START_MS;
};

// Contiguous partition minimising the worst shard's wall. A plain DP rather than a
// bisection on the target, because the cost of a segment is a schedule and not a sum.
function split(ms, shards) {
  const n = ms.length;
  let prev = Array(n + 1).fill(Infinity);
  prev[0] = 0;
  const from = Array.from({ length: shards + 1 }, () => Array(n + 1).fill(-1));
  for (let k = 1; k <= shards; k++) {
    const cur = Array(n + 1).fill(Infinity);
    for (let i = k; i <= n; i++) {
      for (let j = k - 1; j < i; j++) {
        if (prev[j] === Infinity) continue;
        const v = Math.max(prev[j], wallOf(ms, j, i));
        if (v < cur[i]) {
          cur[i] = v;
          from[k][i] = j;
        }
      }
    }
    prev = cur;
  }
  const sizes = [];
  let at = n;
  for (let k = shards; k >= 1; k--) {
    const j = from[k][at];
    sizes.unshift(at - j);
    at = j;
  }
  return sizes;
}

// --- run ---------------------------------------------------------------------

const ledger = JSON.parse(readFileSync(resolve(repo, LEDGER), "utf8"));
const shards = Number(flag("--shards") ?? ledger.collect?.shardWeights?.length ?? 3);
if (!Number.isInteger(shards) || shards < 1) die(`--shards must be a positive integer, not "${flag("--shards")}"`);

const collected = playwright([], {});
const measured = durations(logText());
const ms = collected.map((c) => measured.get(c.key) ?? 0);
const missing = collected.filter((c) => !measured.has(c.key));
const unused = [...measured.keys()].filter((k) => !collected.some((c) => c.key === k));

// A skipped case has no duration and belongs at 0. Anything else missing means the log and
// the checkout disagree about what the corpus is, and a split derived across that gap would
// be arithmetic over a suite that does not exist. Said plainly rather than absorbed: this
// is the one input that cannot be checked afterwards by re-running the collection.
console.log(`${collected.length} cases collected, ${measured.size} timed in the log`);
if (missing.length) console.log(`  ${missing.length} with no duration (skips sit here, and count as 0):`);
for (const c of missing.slice(0, 12)) console.log(`    ${c.key}`);
if (unused.length) {
  console.log(`  ${unused.length} timed case(s) the checkout does not collect — the log is from another revision:`);
  for (const k of unused.slice(0, 12)) console.log(`    ${k}`);
}

const sizes = split(ms, shards);
let at = 0;
const walls = sizes.map((c) => {
  const w = wallOf(ms, at, at + c);
  at += c;
  return w;
});

// Asked of the runner rather than trusted: the weights are a case COUNT, and Playwright
// assigns whole groups, so a cut inside a `test.describe.serial` block moves cases the
// arithmetic above put elsewhere.
const env = { PWTEST_SHARD_WEIGHTS: sizes.join(":") };
const actual = sizes.map((_, i) => playwright([`--shard=${i + 1}/${shards}`], env).length);
const off = actual.map((n, i) => (n === sizes[i] ? null : i)).filter((i) => i !== null);

console.log(
  `\nshard walls (2 workers, +${WORKER_START_MS / 1000}s startup): ${walls.map((w) => (w / 1000).toFixed(0) + "s").join(" / ")}`,
);
console.log(
  `worst ${(Math.max(...walls) / 1000).toFixed(0)}s, against ${(wallOf(ms, 0, ms.length) / 1000 / shards).toFixed(0)}s if the work divided evenly`,
);
if (off.length) {
  die(
    `the plan does not hold: ${off
      .map((i) => `--shard=${i + 1}/${shards} takes ${actual[i]} case(s), not ${sizes[i]}`)
      .join("; ")} — a cut landed inside a group Playwright assigns whole`,
  );
}
console.log(`\npaste into ${LEDGER} (collect.shardWeights):\n    "shardWeights": [${sizes.join(", ")}]`);
