#!/usr/bin/env node
// Derives `collect.shardWeights` in e2e/race/skip-ledger.json — how many cases each
// `--shard=k/N` of the race harness takes — from a race.yml run that actually happened.
//
//   node scripts/race-shard-weights.mjs <run id>        a race.yml run, read through `gh`
//   node scripts/race-shard-weights.mjs --log <file>    the same log already on disk
//   …                                 --shards <N>      a different shard count (default: the
//                                                       length of the array in the ledger)
//   …                          --accept-run-skips       weight a case the run skipped at 0,
//                                                       rather than refusing the log
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

import {
  caseKey as key,
  doubledInLog,
  durations,
  logCoverage,
  offsets,
  planProblems,
  skippedInLog,
  weightShapeProblem,
} from "./shard-weights.mjs";

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
// Weighting a case the run skipped at 0 is a guess about work nobody measured, so it is a
// thing to ask for rather than a default. What it costs is in the refusal that names it.
const acceptRunSkips = argv.includes("--accept-run-skips");

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
const skippedThere = skippedInLog(log);
const ms = collected.map((c) => measured.get(c.key) ?? 0);
const seen = new Set([...measured.keys(), ...skippedThere]);
const unused = [...seen].filter((k) => !collected.some((c) => c.key === k));
const { timed, declaredSkips, runtimeSkips, unexplained } = logCoverage(collected, measured, skippedThere);

const list = (keys) => keys.slice(0, 12).join("\n    ");
// `timed` rather than the whole map: the two stopped being the same number when a log may
// carry cases this checkout no longer collects, and the count that means anything here is
// the one over cases being weighted.
console.log(`${collected.length} cases collected, ${timed.length} timed in the log`);

// A case with no duration belongs at 0 only when the log ACCOUNTS for it. A declared skip
// does: it will not run next time either, so zero is its cost. A case the run itself skipped
// does NOT — the log did not measure it, and zero is a guess that is near enough for a
// serial ladder's tail and badly wrong for a file that never ran. Left as a silent zero it
// has no ceiling: measured, a log with one timed case out of 170 derived `[1, 1, 168]` and
// exited 0, which is the array this file's header records as the failure the refusals exist
// to prevent. So it is refused with the cases named, and taking the guess is a flag.
//
// Anything else missing means the log does not describe this corpus — and unlike every
// other input here, that cannot be caught downstream: the resulting array is
// arithmetically consistent, passes the runner check below and passes check-race-skips.mjs.
if (measured.size === 0) {
  die("no timed lines in the log — wrong run, wrong workflow, or the list reporter's format has moved");
}
// Two runs in one file, which the note below cannot be relaxed past: `durations` takes the
// last line for a key, so the appended run supplies every duration they share and the split
// is priced from a run nobody chose. Measured before this refusal existed: stitching an older
// log onto a current one exits 0 with an array the newer run alone does not produce.
{
  const doubled = doubledInLog(log);
  if (doubled.size) {
    die(
      `${doubled.size} case(s) are timed twice with no retry between them — a case runs in one shard, so ` +
        `this file is more than one run and the later one silently wins every duration they share:\n    ` +
        `${list([...doubled])}`,
    );
  }
}
if (unexplained.length) {
  die(
    `${unexplained.length} collected case(s) are in neither the log's results nor its skips — the log is ` +
      `partial (a cancelled or timed-out shard), or from another revision:\n    ${list(unexplained)}`,
  );
}
// The other direction is a NOTE, not a refusal, and the reason is what the split is made of:
// once nothing collected is unaccounted for, every case being cut has a reading and the
// extras describe cases this checkout no longer has. Refusing them made the tool unusable in
// the one situation it is most needed — a case was DELETED, so the ledger's sum no longer
// matches and the array has to be re-derived, from the only logs that exist, which all
// predate the deletion.
//
// It rescues a narrow shape, and the narrowness is the key's: `caseKey` carries the line, so
// only a deletion that shifts nothing below it — the last case in a file, or a whole file —
// leaves every survivor matching. A deletion from the middle of a file moves every case under
// it and dies at `unexplained` above, with no path through this tool; what would settle that
// is a key that survives a line move, which is a change to how a case is addressed rather
// than to a refusal.
if (unused.length) {
  console.log(
    `  ${unused.length} case(s) in the log are not in this checkout's collection — from before they were ` +
      `removed, or from another revision:\n    ${list(unused)}`,
  );
}
if (runtimeSkips.length && !acceptRunSkips) {
  die(
    `${runtimeSkips.length} case(s) ran in neither shard — the log reports them as skipped, so this run did not ` +
      `measure what they cost:\n    ${list(runtimeSkips)}\n` +
      `  Re-derive from a run that executed them, or pass --accept-run-skips to weight them 0 — which under-cuts ` +
      `whichever shard they land in, by however long they would have taken.`,
  );
}
console.log(
  `  ${declaredSkips.length + runtimeSkips.length} case(s) carry no duration and count as 0: ` +
    `${declaredSkips.length} declared skip(s)` +
    (runtimeSkips.length ? `, ${runtimeSkips.length} the run itself skipped (--accept-run-skips)` : ""),
);

const sizes = split(ms, shards);
const shape = weightShapeProblem(sizes);
if (shape) die(`the derived split is not usable: ${shape}`);
// The same offsets planProblems walks, rather than a second copy of the arithmetic: what
// they replaced was one accumulator shared between the two loops and reset in between.
const bounds = offsets(sizes);
const walls = sizes.map((c, i) => wallOf(ms, bounds[i], bounds[i] + c));

// Asked of the runner rather than trusted, and compared as the SEQUENCE of cases rather than
// as a count: the weights are counts, so a count comparison is satisfied by construction
// once the sum is right, and it would not notice Playwright assigning a group whole (a
// `test.describe.serial` block travels as one) or ordering the groups differently from this
// walk — the two agree only while no race spec declares a file-level beforeAll/afterAll.
const env = { PWTEST_SHARD_WEIGHTS: sizes.join(":") };
const off = planProblems(
  sizes,
  collected.map((c) => c.key),
  (k) => playwright([`--shard=${k}/${shards}`], env).map((c) => c.key),
);

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
