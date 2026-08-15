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
// WHY there is an array at all, and what it buys, are in docs/{en,ja}/live-race-harness.md
// ("How the shards are sized"). The mechanism this file needs: Playwright's own sharding
// takes a CONTIGUOUS slice of the collected order and sizes it by case count, so this only
// has to choose the N-1 cut points — which it does against measured durations, under a model
// of how a shard actually spends its time (2 workers, next case to whichever is free, plus a
// fixed worker startup). Those two constants describe the CI runner, not this repository's
// config, so a runner with a different core count needs them re-measured.
//
// EVERY INPUT IS REFUSED RATHER THAN ABSORBED. The log is the one input nothing downstream
// can check — a stale array is caught by check-race-skips.mjs, a bad plan by the runner
// below, but a log that is short, partial, from another workflow or from a run that was
// cancelled produces an ARITHMETICALLY VALID array over a suite that did not run. Measured
// before the refusals existed: an empty log printed `[1, 1, 168]`, claimed 9s/9s/9s balanced
// shards, exited 0, and would have passed check-race-skips.mjs after being pasted.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { caseKey as key, durations, planMismatch, skippedInLog, weightShapeProblem } from "./shard-weights.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = "e2e/race/skip-ledger.json";
const WORKERS = 2;
const WORKER_START_MS = 9_000;

const scratch = mkdtempSync(join(tmpdir(), "urx-shard-weights-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

function die(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

// A flag's value, and "present but unusable" told apart from "absent": `--shards` with
// nothing after it used to fall through to the ledger's length and print a plan for a shard
// count nobody asked for.
const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) die(`${name} needs a value`);
  return value;
}
const flagValues = new Set(["--log", "--shards"].map((f) => flag(f)).filter(Boolean));
const runId = argv.find((a) => !a.startsWith("--") && !flagValues.has(a));

// --- the run's own durations -------------------------------------------------

function logText() {
  const file = flag("--log");
  if (file) {
    try {
      return readFileSync(file, "utf8");
    } catch (e) {
      die(`--log ${file}: ${e.message}`);
    }
  }
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
let listings = 0;
function playwright(extra, env) {
  const manifest = require.resolve("@playwright/test/package.json");
  const declared = JSON.parse(readFileSync(manifest, "utf8")).bin;
  const bin = resolve(dirname(manifest), typeof declared === "string" ? declared : declared.playwright);
  // The report goes to a FILE, the way check-race-skips.mjs takes it: one top-level
  // console.log in any spec prints ahead of the JSON on stdout, and a tree that is perfectly
  // healthy then fails to parse.
  const out = join(scratch, `list-${listings++}.json`);
  const r = spawnSync(process.execPath, [bin, "test", "--project=race", "--list", "--reporter=json", ...extra], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: out },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) die(`playwright could not be started: ${r.error.message}`);
  let json;
  try {
    json = JSON.parse(readFileSync(out, "utf8"));
  } catch {
    die(
      `playwright --list exited ${r.status} and wrote no report:\n${r.stderr.trim().split("\n").slice(0, 8).join("\n")}`,
    );
  }
  // Status AND errors, because `--list` exits 1 with a well-formed report when it finds
  // nothing (measured: `suites: []`, `errors: [Error: No tests found]`), and a spec that
  // fails to import leaves a PARTIAL listing behind the same exit code — a split derived
  // from that is a split over a corpus that is not this one.
  const errors = (json.errors ?? []).map((e) => e.message?.split("\n")[0] ?? String(e));
  if (r.status !== 0 || errors.length) die(`playwright --list exited ${r.status}: ${errors.join("; ") || "no report"}`);
  const cases = [];
  const walk = (suite) => {
    for (const child of suite.suites ?? []) walk(child);
    for (const spec of suite.specs ?? []) {
      cases.push({
        key: key(spec.file, spec.line, spec.title),
        skipped: (spec.tests ?? []).some((t) => t.expectedStatus === "skipped"),
      });
    }
  };
  for (const suite of json.suites ?? []) walk(suite);
  return cases;
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
if (shards > collected.length) die(`--shards ${shards} is more shards than there are cases (${collected.length})`);
const log = logText();
const measured = durations(log);
const ms = collected.map((c) => measured.get(c.key) ?? 0);
const missing = collected.filter((c) => !measured.has(c.key));
const unused = [...measured.keys()].filter((k) => !collected.some((c) => c.key === k));

console.log(`${collected.length} cases collected, ${measured.size} timed in the log`);

// A case with no duration belongs at 0 when the log ACCOUNTS for it — either the listing
// declares it skipped, or the log itself reports it as skipped, which is the only evidence
// for the kind a listing cannot see (a `test.describe.serial` block skips the rest of its
// cases once one fails, and an in-body `test.skip()` is invisible to `--list`). Anything
// else missing, or anything in the log the checkout does not collect, means the two describe
// different corpora — and unlike every other input here, that cannot be caught downstream:
// the resulting array is arithmetically consistent, passes the runner check below and passes
// check-race-skips.mjs.
const skippedThere = skippedInLog(log);
const unexplained = missing.filter((c) => !c.skipped && !skippedThere.has(c.key));
if (measured.size === 0) {
  die("no timed lines in the log — wrong run, wrong workflow, or the list reporter's format has moved");
}
if (unexplained.length) {
  die(
    `${unexplained.length} collected case(s) are in neither the log's results nor its skips — the log is ` +
      `partial (a cancelled or timed-out shard), or from another revision:\n    ` +
      unexplained
        .slice(0, 12)
        .map((c) => c.key)
        .join("\n    "),
  );
}
if (unused.length) {
  die(
    `${unused.length} timed case(s) are not in this checkout's collection — the log is from another revision:\n    ` +
      unused.slice(0, 12).join("\n    "),
  );
}
{
  const declared = missing.filter((c) => c.skipped).length;
  const atRuntime = missing.length - declared;
  console.log(
    `  ${missing.length} case(s) carry no duration and count as 0: ${declared} declared skip(s)` +
      (atRuntime ? `, ${atRuntime} the run itself skipped` : ""),
  );
}

const sizes = split(ms, shards);
const shape = weightShapeProblem(sizes);
if (shape) die(`the derived split is not usable: ${shape}`);
let at = 0;
const walls = sizes.map((c) => {
  const w = wallOf(ms, at, at + c);
  at += c;
  return w;
});

// Asked of the runner rather than trusted, and compared as the SEQUENCE of cases rather than
// as a count: the weights are counts, so a count comparison is satisfied by construction
// once the sum is right, and it would not notice Playwright assigning a group whole (a
// `test.describe.serial` block travels as one) or ordering the groups differently from this
// walk — the two agree only while no race spec declares a file-level beforeAll/afterAll.
const env = { PWTEST_SHARD_WEIGHTS: sizes.join(":") };
const off = [];
at = 0;
for (const [i, size] of sizes.entries()) {
  const want = collected.slice(at, at + size).map((c) => c.key);
  at += size;
  const got = playwright([`--shard=${i + 1}/${shards}`], env).map((c) => c.key);
  const mismatch = planMismatch(`--shard=${i + 1}/${shards}`, want, got);
  if (mismatch) off.push(mismatch);
}

console.log(
  `\nshard walls (${WORKERS} workers, +${WORKER_START_MS / 1000}s startup): ` +
    walls.map((w) => (w / 1000).toFixed(0) + "s").join(" / "),
);
console.log(
  `worst ${(Math.max(...walls) / 1000).toFixed(0)}s, against ` +
    `${(wallOf(ms, 0, ms.length) / 1000 / shards).toFixed(0)}s if the work divided evenly`,
);
if (off.length)
  die(`the plan does not hold: ${off.join("; ")} — the cases Playwright assigns are not the ones cut here`);
console.log(`\npaste into ${LEDGER} (collect.shardWeights):\n    "shardWeights": [${sizes.join(", ")}]`);
