// The rules over the race tier's shard split, shown the broken arrangements they exist to
// reject. Three of these were run by hand against the real workflow and the real ledger
// before this file existed — a weight that no longer sums to the corpus, a checker that did
// not pass the variable (standing in for a Playwright that stopped reading it), and the env
// key renamed to PWTEST_SHARD_WEIGHTS_DISABLED, which is what caught `includes()` passing
// while nothing was read. A hand-run mutation is a measurement of the guard on one day; this
// is the same measurement on every run.
//
// Every case is paired with the good arrangement it is a mutation of, because a rule that
// fires on everything is as useless as one that fires on nothing.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { caseKey, durations, inspectWeights, weightShapeProblem } from "./shard-weights.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = readFileSync(join(repo, ".github/workflows/race.yml"), "utf8");
const LEDGER = JSON.parse(readFileSync(join(repo, "e2e/race/skip-ledger.json"), "utf8"));

/** The committed arrangement, with one thing swapped out per case. */
const good = (over = {}) => ({
  weights: [38, 73, 59],
  collectedCount: 170,
  shardCounts: [38, 73, 59],
  workflowText: WORKFLOW,
  ...over,
});
const messages = (over) => inspectWeights(good(over)).map((p) => `${p.where}: ${p.message}`);

// The only place in this repository that parses another tool's output format, and the one
// input to the derivation nothing downstream can re-check. Lines are taken verbatim from a
// race.yml run (job / step / timestamp prefixes included) and from a local run (no prefix).
describe("durations", () => {
  const PREFIXED =
    "race (2)\tRun pnpm test:e2e:race --shard=2/3\t2026-08-15T00:38:34.5713414Z   ✓   1 [race] › " +
    "e2e/race/t3-undo.spec.ts:651:5 › T3 undo › an entry opened 5 ms after a notify survives a 10 Hz device sweep (12.9s)";
  const BARE =
    "  ✓  56 [race] › e2e/race/tzb-tail.spec.ts:998:3 › Tzb tail › repeated live sessions leave no subscription (1.0m)";

  it("reads a line wrapped by gh run view, and one that is not", () => {
    expect(
      durations(PREFIXED).get(
        caseKey("t3-undo.spec.ts", 651, "an entry opened 5 ms after a notify survives a 10 Hz device sweep"),
      ),
    ).toBe(12_900);
    expect(durations(BARE).get(caseKey("tzb-tail.spec.ts", 998, "repeated live sessions leave no subscription"))).toBe(
      60_000,
    );
  });

  it("scales all three units the reporter prints", () => {
    const line = (d) => `  ✓  1 [race] › e2e/race/t0-baseline.spec.ts:28:3 › T0 › a case (${d})`;
    const at = (text) => durations(text).get(caseKey("t0-baseline.spec.ts", 28, "a case"));
    expect(at(line("900ms"))).toBe(900);
    expect(at(line("4.6s"))).toBe(4_600);
    expect(at(line("1.5m"))).toBe(90_000);
  });

  // The tier retries once on CI, so a case that failed and passed prints twice: the retry
  // suffix has to leave the title, and the later line has to win. Left in the title, the key
  // matches no collected case and the run reads as "a log from another revision".
  it("strips the retry suffix and keeps the attempt that ran last", () => {
    const first = "  ✘  7 [race] › e2e/race/t5-drop.spec.ts:141:7 › T5 drop › link loss at the mid (120.0s)";
    const retry = "  ✓  7 [race] › e2e/race/t5-drop.spec.ts:141:7 › T5 drop › link loss at the mid (retry #1) (8.2s)";
    const map = durations(`${first}\n${retry}`);
    expect([...map.keys()]).toEqual([caseKey("t5-drop.spec.ts", 141, "link loss at the mid")]);
    expect([...map.values()]).toEqual([8_200]);
  });

  it("reads nothing out of another project's lines", () => {
    const other = "  ✓  1 [chromium] › e2e/console.spec.ts:10:3 › console › a case (1.0s)";
    const skipped = "  -  23 [race] › e2e/race/t3b-undo.spec.ts:1395:8 › T3b undo › a refused entry";
    expect(durations(`${other}\n${skipped}`).size).toBe(0);
  });
});

describe("weightShapeProblem", () => {
  it("accepts a list of counts", () => {
    expect(weightShapeProblem([38, 73, 59])).toBeNull();
    expect(weightShapeProblem([0, 170, 0])).toBeNull(); // odd, but not malformed
  });

  // The empty list is the one jq lets through: `.collect.shardWeights | join(":")` on []
  // prints nothing and exits 0, and an empty PWTEST_SHARD_WEIGHTS is not a parse error to
  // Playwright — it is a silent fall back to the equal-count split.
  it("refuses the shapes that reach Playwright as nothing at all", () => {
    expect(weightShapeProblem([])).toMatch(/empty/);
    expect(weightShapeProblem(undefined)).toMatch(/must be an array/);
    expect(weightShapeProblem("38:73:59")).toMatch(/must be an array/);
  });

  it("refuses a member that is not a count", () => {
    expect(weightShapeProblem([38, "73", 59])).toMatch(/non-negative integers/);
    expect(weightShapeProblem([38, -1, 59])).toMatch(/non-negative integers/);
    expect(weightShapeProblem([38, 73.5, 59])).toMatch(/non-negative integers/);
  });
});

describe("inspectWeights", () => {
  it("says nothing about the arrangement this repository is committed in", () => {
    expect(inspectWeights(good())).toEqual([]);
  });

  // Mutation 1 as it was run by hand: [39, 73, 59] against a corpus of 170.
  it("reports a sum that no longer matches the corpus, and says to re-derive", () => {
    const found = messages({ weights: [39, 73, 59], shardCounts: null });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/sums to 171 but --project=race collects 170/);
    expect(found[0]).toMatch(/race-shard-weights\.mjs/);
  });

  // Mutation 2: the counts that come back when the variable is ignored are Playwright's own
  // equal-count split. Every shard is wrong, and each says so on its own line.
  it("reports the counts an ignored variable produces", () => {
    const found = messages({ shardCounts: [57, 57, 56] });
    expect(found).toHaveLength(3);
    expect(found[0]).toMatch(/--shard=1\/3 collects 57 case\(s\).*not the 38/s);
    expect(found.every((m) => /stopped reading PWTEST_SHARD_WEIGHTS/.test(m))).toBe(true);
  });

  // A cut that falls inside a group Playwright assigns whole (e2e/race has one, the serial
  // ladder in t5-drop) moves cases without moving the sum.
  it("reports a single shard whose collected count is off", () => {
    const found = messages({ shardCounts: [38, 74, 58] });
    expect(found).toHaveLength(2);
  });

  // The sum is what says "re-derive"; taking the per-shard readings as well would report
  // the same corpus move three more times in a shape that names a different cause.
  it("does not ask for per-shard readings once the sum is wrong", () => {
    expect(messages({ weights: [39, 73, 59], shardCounts: null })).toHaveLength(1);
  });

  describe("what it holds against the workflow", () => {
    // Mutation 3, verbatim: the rename that kept a substring check green.
    it("refuses the variable renamed out of use", () => {
      const found = messages({
        workflowText: WORKFLOW.replaceAll("PWTEST_SHARD_WEIGHTS:", "PWTEST_SHARD_WEIGHTS_DISABLED:"),
      });
      expect(found.some((m) => /workflow: no longer names PWTEST_SHARD_WEIGHTS as an env key/.test(m))).toBe(true);
    });

    it("refuses the env key deleted outright", () => {
      const found = messages({ workflowText: WORKFLOW.replace(/^\s*PWTEST_SHARD_WEIGHTS:.*$/m, "") });
      expect(found.some((m) => /as an env key/.test(m))).toBe(true);
    });

    // A commented-out key is the shape a "temporarily disable this" edit leaves behind, and
    // the anchor is what keeps it from counting.
    it("refuses a key that is only a comment", () => {
      const found = messages({
        workflowText: WORKFLOW.replace(/^(\s*)PWTEST_SHARD_WEIGHTS:/m, "$1# PWTEST_SHARD_WEIGHTS:"),
      });
      expect(found.some((m) => /as an env key/.test(m))).toBe(true);
    });

    // The realistic mutation, and the one a bare token match survived: the jq read becomes a
    // literal while the comment above it and the error below it still name the key. Deleting
    // every mention instead — which is what this case did at first — tests a rewrite nobody
    // would make, and left the loose pattern looking like a rule.
    it("refuses the weights inlined into the workflow with the prose left behind", () => {
      const mutated = WORKFLOW.replace(/weights=\$\(jq -er .*\)/, "weights=38:73:59");
      expect(mutated).toContain("collect.shardWeights"); // the comment and the error survive
      const found = messages({ workflowText: mutated });
      expect(found.some((m) => /no longer names a jq read of collect\.shardWeights/.test(m))).toBe(true);
    });

    it("refuses a read that is only a comment", () => {
      const mutated = WORKFLOW.replace(/^(\s*)weights=\$\(jq -er /m, "$1# weights=$(jq -er ");
      const found = messages({ workflowText: mutated });
      expect(found.some((m) => /no longer names a jq read/.test(m))).toBe(true);
    });

    // The value travels through four names and GitHub resolves a missing one to "", so the
    // guard at the consumer is what turns any of them breaking into a failed job. The
    // mutation deletes whatever line carries the test rather than a spelling of it: written
    // against `[[ -z … ]]`, this case stopped mutating anything the moment the guard was
    // rewritten in POSIX syntax for the container's `sh`, and would have passed on a
    // workflow with no guard at all.
    it("refuses the run step with its emptiness guard removed", () => {
      const mutated = WORKFLOW.replace(/^.*-z .*PWTEST_SHARD_WEIGHTS.*$/m, "if false; then");
      expect(mutated).not.toBe(WORKFLOW);
      const found = messages({ workflowText: mutated });
      expect(found.some((m) => /guard against an empty PWTEST_SHARD_WEIGHTS/.test(m))).toBe(true);
    });
  });
});

// The ledger is the arrangement the rules are aimed at, so it is read rather than restated:
// a fixture that drifts from it would leave every case above passing about nothing.
describe("the committed ledger", () => {
  it("carries a shard array the rules accept", () => {
    expect(weightShapeProblem(LEDGER.collect?.shardWeights)).toBeNull();
  });

  it("matches the matrix race.yml declares", () => {
    const matrix = WORKFLOW.match(/^\s*shard: \[([^\]]+)\]/m);
    expect(matrix).not.toBeNull();
    // Playwright refuses a weight list whose length is not the shard total, so this is the
    // arrangement failing at the first shard rather than skewing quietly — reported here so
    // it fails on the pull request instead of after a container has started.
    expect(LEDGER.collect.shardWeights).toHaveLength(matrix[1].split(",").length);
  });
});
