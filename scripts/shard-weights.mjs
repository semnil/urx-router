// The rules over `collect.shardWeights` in e2e/race/skip-ledger.json — the per-shard case
// counts .github/workflows/race.yml hands to Playwright as PWTEST_SHARD_WEIGHTS so the race
// tier is cut by measured duration rather than by the case count Playwright's own sharding
// uses. Pure, so scripts/shard-weights.test.mjs can put the broken arrangements in front of
// it that only a hand-run mutation could otherwise produce.
//
// scripts/check-race-skips.mjs takes the readings (it is the one that may spawn Playwright)
// and this decides what they mean; scripts/race-shard-weights.mjs shares the shape rule so a
// derived array and a committed one are judged the same way.

// --- reading a run's own log -------------------------------------------------

// The list reporter's finished line, whatever wraps it: `gh run view --log` prefixes every
// line with a job name, a step name and a timestamp, and a log read from disk may not.
//
// The marker class is exactly what the reporter writes for a case that RAN — ✓ for a pass,
// ✘ for anything else. `-` belongs to the skipped branch alone (its `green("-")` is the only
// dash marker in the reporter) and used to be in here as well, which made a skipped case
// whose TITLE ends in a duration shape read as a timed one: `… › a screen closed 2500 ms
// into a registration waits (8.2s)` yielded a key with the suffix cut off, so the real case
// went to `unexplained` and the truncated one to `unused`, and the log was refused twice
// over for reasons neither of them names. A run under a terminal without UTF-8 marks a pass
// `ok` and a failure `x`, which this does not read — a log from one produces no timed lines
// at all, which the caller refuses outright rather than deriving anything from.
const LINE = /[✓✘]\s+\d+\s+\[race\]\s+›\s+(\S+?\.spec\.ts):(\d+):\d+\s+›\s+(.+?)\s+\((\d+(?:\.\d+)?)(ms|s|m)\)\s*$/;
// Stripped rather than matched into the title. The reporter writes `title (retry #1) (12.3s)`
// (its own `_retrySuffix` sits between the title and the duration), and the lazy title group
// swallows it — the key then matches no collected case, which reads downstream as "this log
// is from another revision" when what happened is one case failing and passing on its retry
// (`playwright.config.ts` gives the race project one CI retry).
const RETRY = /\s*\(retry #\d+\)\s*$/;
const SCALE = { ms: 1, s: 1_000, m: 60_000 };

/** One case's address, from a log line or from a `--list` report. */
export const caseKey = (file, line, title) => `${file.split("/").pop()}:${line}|${title.split(" › ").pop().trim()}`;

// The same line for a case the run SKIPPED, which carries no duration at all: the reporter
// puts the `(1.2s)` suffix in the branch it takes for a case that ran, so a skipped one ends
// at its title — including a title that itself ends in something duration-shaped, which is
// why the title group runs to the end of the line rather than stopping short of one.
const SKIP_LINE = /-\s+\d+\s+\[race\]\s+›\s+(\S+?\.spec\.ts):(\d+):\d+\s+›\s+(.+?)\s*$/;

/** Every timed case in a run's log, keyed by caseKey. */
export function durations(text) {
  const out = new Map();
  for (const raw of text.split("\n")) {
    const m = raw.match(LINE);
    if (!m) continue;
    // A later line overwrites an earlier one, which is what makes a retried case count as
    // its passing attempt rather than as the timeout that preceded it.
    out.set(caseKey(m[1], m[2], m[3].replace(RETRY, "")), Number(m[4]) * SCALE[m[5]]);
  }
  return out;
}

/**
 * Cases the log times more than once WITHOUT a retry marking one of them — which one run
 * cannot produce, since a case belongs to exactly one shard and a second attempt carries the
 * reporter's `(retry #N)`. Two runs in one file can, and `durations` resolves that by
 * last-wins, so whichever log was appended silently supplies every shared duration.
 *
 * Its own detector because the thing that used to catch it was a side effect: refusing a log
 * that carries cases this checkout does not collect. That refusal had to go (a deletion makes
 * every existing log carry one), and stitching a fresh partial run onto an older one is the
 * move the situation invites.
 */
export function doubledInLog(text) {
  const seen = new Set();
  const doubled = new Set();
  for (const raw of text.split("\n")) {
    const m = raw.match(LINE);
    if (!m || RETRY.test(m[3])) continue;
    const k = caseKey(m[1], m[2], m[3]);
    if (seen.has(k)) doubled.add(k);
    seen.add(k);
  }
  return doubled;
}

/**
 * Every case the run reports as SKIPPED. Separate from `durations` because it answers a
 * different question — those cases have no weight to contribute, and what matters is that
 * they are ACCOUNTED FOR: a caller that only knows about timed cases has to treat them as
 * missing, and "missing" is how a partial log is recognised.
 *
 * A declaration-time skip is already knowable from `--list`. This is the other kind, which
 * is not: a `test.describe.serial` block skips the rest of its cases once one fails (the
 * harness has such a ladder in e2e/race/t5-drop.spec.ts), an in-body `test.skip()` is
 * invisible to a listing altogether, and a suite whose setup fails takes the rest of its
 * file with it.
 *
 * A result line is taken out first even though the two markers no longer overlap: a TITLE
 * may contain anything, a marker-shaped fragment included, and `SKIP_LINE` is not anchored
 * to the start of the line because the log's own prefix sits there.
 */
export function skippedInLog(text) {
  const out = new Set();
  for (const raw of text.split("\n")) {
    if (LINE.test(raw)) continue;
    const m = raw.match(SKIP_LINE);
    if (m) out.add(caseKey(m[1], m[2], m[3].replace(RETRY, "")));
  }
  return out;
}

/**
 * What a log accounts for, against the cases this checkout collects. Each group is decided
 * by its own evidence rather than by subtracting the others: a count taken as a remainder
 * describes whatever is left over, which is how "the run skipped these" ends up printed
 * over cases the log never mentioned.
 *
 * `timed` is the only group that carries a weight. The other two are at zero, and they are
 * NOT the same claim: a declared skip will not run next time either, so zero is its true
 * cost, while a case the run skipped is one whose cost this log simply did not measure —
 * near enough to zero for a serial ladder's tail, and badly wrong for a file that never ran.
 * The caller decides what to do about that; this only says which is which.
 */
export function logCoverage(collectedKeys, measured, skippedThere) {
  const timed = [];
  const declaredSkips = [];
  const runtimeSkips = [];
  const unexplained = [];
  for (const c of collectedKeys) {
    if (measured.has(c.key)) timed.push(c.key);
    else if (c.skipped) declaredSkips.push(c.key);
    else if (skippedThere.has(c.key)) runtimeSkips.push(c.key);
    else unexplained.push(c.key);
  }
  return { timed, declaredSkips, runtimeSkips, unexplained };
}

/**
 * Whether the cases Playwright hands a shard are the ones the plan cut for it, said as the
 * FIRST position they disagree on. Null when they match.
 *
 * The counts are deliberately not the headline. A count comparison is satisfied by
 * construction once the sum is right, so the one failure this sequence check exists to catch
 * — the collected order diverging from the order Playwright groups in — arrives with equal
 * counts, and a message built from them reads "takes 73 case(s) where the plan puts 73".
 */
export function planMismatch(label, want, got) {
  const n = want.findIndex((k, at) => got[at] !== k);
  if (n < 0 && got.length === want.length) return null;
  const where = n < 0 ? want.length : n;
  return (
    `${label} differs from position ${where}: Playwright takes ${got[where] ?? "(nothing)"} ` +
    `where the plan puts ${want[where] ?? "(nothing)"}` +
    (got.length === want.length ? "" : ` (${got.length} cases against the plan's ${want.length})`)
  );
}

/**
 * Every shard whose cases are not the ones the plan cut for it. `listShard(k)` is asked for
 * shard k's case keys — the runner's answer, injected so this can be exercised without one.
 *
 * The walk lives here rather than at the call site because the offset into the plan is the
 * part that can go wrong silently: the caller used to carry one `at` accumulator across two
 * loops, resetting it between them, and a reset that goes missing (or a block landing
 * between them that touches it) compares shard k against another shard's slice. What that
 * prints is a mismatch, correctly formatted, blaming Playwright for the walk's own error.
 */
export function planProblems(sizes, keys, listShard) {
  const from = offsets(sizes);
  const problems = [];
  for (const [i, size] of sizes.entries()) {
    const want = keys.slice(from[i], from[i] + size);
    const mismatch = planMismatch(`--shard=${i + 1}/${sizes.length}`, want, listShard(i + 1));
    if (mismatch) problems.push(mismatch);
  }
  return problems;
}

/**
 * Where each shard's slice starts. One home, because both consumers walk the same plan —
 * this file to compare against the runner, race-shard-weights.mjs to price each segment —
 * and they used to do it with one accumulator passed between them.
 */
export function offsets(sizes) {
  const out = [];
  let at = 0;
  for (const size of sizes) {
    out.push(at);
    at += size;
  }
  return out;
}

/** The array itself, before anything is asked of a runner. */
export function weightShapeProblem(weights) {
  if (!Array.isArray(weights)) return "collect.shardWeights must be an array of case counts, one per shard";
  if (weights.length < 1) return "collect.shardWeights is empty — race.yml would hand Playwright nothing";
  if (weights.some((w) => !Number.isInteger(w) || w < 0)) {
    return `collect.shardWeights must hold non-negative integers, not ${JSON.stringify(weights)}`;
  }
  return null;
}

/**
 * What the readings mean. `shardCounts` is what Playwright collected for each
 * `--shard=k/N` under these weights, or null when it was not worth taking (the sum is
 * already wrong, so every shard would be off by the same arithmetic).
 *
 * WHAT THIS DECIDES, and what it does not. Playwright sizes shard k as
 * `floor(weights[k] * collected / sum(weights))`, so once the sum matches the corpus the
 * counts are an identity — the per-shard reading can only come back wrong if the variable
 * was ignored, or if a cut fell inside a group Playwright assigns whole. So a stale array
 * is caught when the corpus CHANGED SIZE, which is how a stale array is normally produced;
 * a case swapped one-for-one, a file renamed into a different collection order, or a case
 * that simply got slower leaves every count intact and needs a re-derivation nobody here
 * can prompt. The documents say it that way too.
 */
export function inspectWeights({ weights, collectedCount, shardCounts, workflowText }) {
  const problems = [];
  const shape = weightShapeProblem(weights);
  if (shape) return [{ where: "ledger", message: shape }];

  const total = weights.reduce((a, b) => a + b, 0);
  if (total !== collectedCount) {
    // Reported on its own rather than left to the per-shard mismatch, because the two have
    // different answers: this one means re-derive, that one can also mean the variable was
    // ignored. Playwright's remainder handling still runs every case while this is red —
    // the split is simply back to being uneven.
    problems.push({
      where: "ledger",
      message:
        `collect.shardWeights sums to ${total} but --project=race collects ${collectedCount} case(s) — ` +
        "re-derive with `node scripts/race-shard-weights.mjs <run id>`",
    });
  } else if (shardCounts) {
    for (const [i, want] of weights.entries()) {
      const got = shardCounts[i];
      if (got === want) continue;
      problems.push({
        where: "ledger",
        message:
          `--shard=${i + 1}/${weights.length} collects ${got} case(s) under collect.shardWeights, not the ${want} ` +
          "the array claims — either the corpus moved (re-derive) or Playwright stopped reading PWTEST_SHARD_WEIGHTS",
      });
    }
  }

  // …and that race.yml still delivers it. Everything above proves the variable WORKS; only
  // the workflow decides whether it arrives, and a run with it lost is the same green as a
  // run with it honoured. A text scan is the whole of what this half is: it cannot see
  // which step the value reaches, or that the value reaching it came from the ledger. What
  // it catches is the deletion, which is how this arrangement actually goes missing.
  //
  // Each pattern is anchored at the shape it has to have rather than at the name appearing
  // somewhere: `includes("PWTEST_SHARD_WEIGHTS")` stayed green under a rename to
  // PWTEST_SHARD_WEIGHTS_DISABLED — the shape half a revert leaves — while Playwright read
  // nothing. The third one is the runtime guard, and it is here because the value travels
  // through four names on its way to the shard step and GitHub resolves a name that does
  // not exist to the empty string: the guard is what turns that into a failed job, so
  // deleting it puts the silence back.
  for (const [what, pattern, why] of [
    [
      "PWTEST_SHARD_WEIGHTS as an env key",
      /^\s*PWTEST_SHARD_WEIGHTS:\s+\S/m,
      "the split would fall back to Playwright's equal one, and nothing would report it",
    ],
    [
      // Anchored on the jq invocation, not on the key appearing somewhere: the workflow
      // names it in a comment and in the error it prints, so a bare token match stayed
      // green with the read itself replaced by a literal (measured against the real file).
      // The `[^#\n]*` before `jq` is what keeps a commented-out read from counting.
      "a jq read of collect.shardWeights",
      /^[^#\n]*\bjq\b[^\n]*\.collect\.shardWeights/m,
      "the weights would be a second copy rather than a read of the ledger",
    ],
    [
      "a guard against an empty PWTEST_SHARD_WEIGHTS",
      /-z\s+"\$\{?PWTEST_SHARD_WEIGHTS\}?"/,
      "a value lost between detect and the shard step would arrive empty, and Playwright falls back silently",
    ],
  ]) {
    if (!pattern.test(workflowText)) problems.push({ where: "workflow", message: `no longer names ${what} — ${why}` });
  }
  return problems;
}
