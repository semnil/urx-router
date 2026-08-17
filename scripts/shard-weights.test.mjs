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

import {
  caseKey,
  doubledInLog,
  durations,
  inspectWeights,
  logCoverage,
  offsets,
  planMismatch,
  planProblems,
  runShape,
  runShapeProblem,
  skippedInLog,
  weightShapeProblem,
} from "./shard-weights.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = readFileSync(join(repo, ".github/workflows/race.yml"), "utf8");
const LEDGER = JSON.parse(readFileSync(join(repo, "e2e/race/skip-ledger.json"), "utf8"));

/** The committed arrangement, with one thing swapped out per case. Read from the ledger
 *  rather than written out: hard-coded, these two described the repository as it stood when
 *  the file was written, and a case deleted from the harness moved both. */
const WEIGHTS = LEDGER.collect.shardWeights;
const TOTAL = WEIGHTS.reduce((a, b) => a + b, 0);
const good = (over = {}) => ({
  weights: WEIGHTS,
  collectedCount: TOTAL,
  shardCounts: WEIGHTS,
  workflowText: WORKFLOW,
  ...over,
});
const messages = (over) => inspectWeights(good(over)).map((p) => `${p.where}: ${p.message}`);

// The reporter's finished line for one synthetic case, shared by the suites that need a line
// rather than a particular case. The verbatim samples are separate and stay that way — those
// are the pin on the format, this is a fixture the assertions are built out of.
const resultLine = (line, dur) => `  ✓  1 [race] › e2e/race/t0-baseline.spec.ts:${line}:3 › T0 › a case (${dur})`;
// The pair a retried case prints: the attempt that failed, then the one that passed. The tier
// takes one CI retry, so this is the only legitimate way a key is timed twice.
const retriedPair = (title) => [
  `  ✘  7 [race] › e2e/race/t5-drop.spec.ts:141:7 › T5 drop › ${title} (120.0s)`,
  `  ✓  7 [race] › e2e/race/t5-drop.spec.ts:141:7 › T5 drop › ${title} (retry #1) (8.2s)`,
];

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
    const at = (text) => durations(text).get(caseKey("t0-baseline.spec.ts", 28, "a case"));
    expect(at(resultLine(28, "900ms"))).toBe(900);
    expect(at(resultLine(28, "4.6s"))).toBe(4_600);
    expect(at(resultLine(28, "1.5m"))).toBe(90_000);
  });

  // The tier retries once on CI, so a case that failed and passed prints twice: the retry
  // suffix has to leave the title, and the later line has to win. Left in the title, the key
  // matches no collected case and the run reads as "a log from another revision".
  it("strips the retry suffix and keeps the attempt that ran last", () => {
    const map = durations(retriedPair("link loss at the mid").join("\n"));
    expect([...map.keys()]).toEqual([caseKey("t5-drop.spec.ts", 141, "link loss at the mid")]);
    expect([...map.values()]).toEqual([8_200]);
  });

  it("reads nothing out of another project's lines", () => {
    const other = "  ✓  1 [chromium] › e2e/console.spec.ts:10:3 › console › a case (1.0s)";
    const skipped = "  -  23 [race] › e2e/race/t3b-undo.spec.ts:1395:8 › T3b undo › a refused entry";
    expect(durations(`${other}\n${skipped}`).size).toBe(0);
  });
});

// Two runs in one file. `durations` takes the last line for a key, so whichever log was
// appended supplies every duration they share — and the thing that used to catch it was a
// side effect of refusing a log with cases this checkout no longer collects, which a deletion
// makes every existing log carry.
describe("doubledInLog", () => {
  it("says nothing about one run", () => {
    expect(doubledInLog(`${resultLine(28, "4.6s")}\n${resultLine(73, "1.2s")}`).size).toBe(0);
  });

  // The legitimate double: a case that failed and passed carries the reporter's own marker on
  // the second line, and a tier that retries prints both.
  it("leaves a retried case alone", () => {
    expect(doubledInLog(retriedPair("link loss").join("\n")).size).toBe(0);
  });

  it("names a case timed twice with no retry between them", () => {
    const text = [resultLine(28, "4.6s"), resultLine(73, "1.2s"), resultLine(28, "9.9s")].join("\n");
    expect([...doubledInLog(text)]).toEqual([caseKey("t0-baseline.spec.ts", 28, "a case")]);
  });
});

// The half `doubledInLog` cannot reach. Two partial logs that do not overlap — shard 1 from
// one run, shards 2 and 3 from another — double nothing and leave nothing uncovered, so every
// other reading here is satisfied while the durations come from two machines at two times.
// Lines are verbatim from run 31865018013 (the header the list reporter opens a sharded run
// with, and the webkit job's, which carries no shard clause).
describe("runShape / runShapeProblem", () => {
  const header = (tests, k, of = 3) =>
    `race (${k})\tRun if [ -z "$PWTEST_SHARD_WEIGHTS" ]; then\t2026-08-15T04:41:44.5107108Z ` +
    `Running ${tests} tests using 2 workers, shard ${k} of ${of}`;
  const mark = (id) => `race (1)\tRun echo\t2026-08-15T04:41:40.0000000Z urx-race-run ${id}`;
  // One per shard job, which is what run 31866387883's log carries.
  const marks = (id, n = 3) => Array.from({ length: n }, () => mark(id));
  const WEBKIT =
    "race-webkit\tRun pnpm test:e2e:race:webkit\t2026-08-15T04:41:48.4857372Z Running 5 tests using 2 workers";
  const RUN = [header(38, 1), header(72, 2), header(59, 3), WEBKIT].join("\n");
  const problem = (text) => runShapeProblem(runShape(text), 3);

  it("passes one complete run, with or without run marks", () => {
    expect(problem(RUN)).toBeNull();
    expect(problem([...marks("31865018013/1"), RUN].join("\n"))).toBeNull();
  });

  // The state every existing log is in the moment the array has to be re-derived: a case was
  // deleted, so the log counts one case more than this checkout collects. Refusing that here
  // would put back the refusal race-shard-weights.mjs demoted to a note for this exact reason.
  it("says nothing about a corpus that has since lost a case", () => {
    expect(problem(RUN)).toBeNull();
    expect(runShape(RUN).shards.reduce((a, s) => a + s.tests, 0)).toBe(169);
  });

  // The webkit job runs the same specs in another project and prints the same opening line
  // without a shard clause. Counted as a shard it would make every complete log a stitch.
  it("does not read the webkit job's header as a shard", () => {
    expect(runShape(RUN).shards.map((s) => s.shard)).toEqual([1, 2, 3]);
  });

  it("refuses a file carrying two runs' marks", () => {
    const text = [mark("31865018013/1"), RUN, mark("31862345557/1")].join("\n");
    expect(problem(text)).toMatch(/2 runs \(31865018013\/1, 31862345557\/1\)/);
  });

  // A re-run of the failed jobs keeps the run id, so the attempt is part of the identity.
  it("refuses two attempts of the same run", () => {
    expect(problem([mark("31865018013/1"), RUN, mark("31865018013/2")].join("\n"))).toMatch(/2 runs/);
  });

  // The stitch the marks exist for and the headers cannot see: a fresh run supplying two shards
  // and a log written before the echo supplying the third. One id, three headers, right corpus —
  // and the marks are two where a whole run leaves three.
  it("refuses a run whose shards are not all marked", () => {
    const text = [...marks("31865018013/1", 2), RUN].join("\n");
    expect(problem(text)).toMatch(/2 of 3 shard\(s\) name the run that produced them/);
  });

  it("refuses a shard that starts twice", () => {
    expect(problem(`${RUN}\n${header(38, 1)}`)).toMatch(/shard 1 of 3 starts more than once/);
  });

  // One run's whole log pasted twice: same id throughout, so the two-ids clause says nothing
  // and the count is the reading. Named for what it is rather than as a missing mark.
  it("refuses one run's log carried twice", () => {
    const text = [...marks("31865018013/1", 6), RUN, RUN].join("\n");
    expect(problem(text)).toMatch(/marks 6 shards where a run has 3 — this file carries that run more than once/);
  });

  // The reviewed defect, in its unmarked form: two disjoint partial logs whose union covers
  // the corpus exactly once. Nothing else in the derivation objects to it.
  it("refuses a union of partial runs that leaves a shard unstarted", () => {
    expect(problem([header(38, 1), header(72, 2)].join("\n"))).toMatch(/shard 3 of 3 never started/);
  });

  it("refuses a log split into another number of shards", () => {
    expect(problem([header(85, 1, 2), header(84, 2, 2)].join("\n"))).toMatch(/split into 2, not into 3/);
  });

  it("refuses a log that was never sharded at all", () => {
    expect(problem(WEBKIT)).toMatch(/no `shard k of 3` header/);
  });
});

// A case the RUN skipped, which a listing cannot know about: `expectedStatus` covers the
// declaration only, so without this reading a complete log from a run with one failure inside
// a serial block is refused as partial.
describe("skippedInLog", () => {
  // The shape this function was added for: the ladder in e2e/race/t5-drop.spec.ts is a
  // `test.describe.serial`, so a failure in one rung leaves the rest reported like this.
  const LADDER = "  -  8 [race] › e2e/race/t5-drop.spec.ts:141:7 › T5 drop › link loss at the mid of a flush send loop";
  const KEY = caseKey("t5-drop.spec.ts", 141, "link loss at the mid of a flush send loop");

  it("reads the marker line a skipped case prints", () => {
    expect([...skippedInLog(LADDER)]).toEqual([KEY]);
  });

  it("reads it through the prefix gh run view puts on every line", () => {
    const prefixed = `race (3)\tRun pnpm test:e2e:race --shard=3/3\t2026-08-15T00:38:34.5713414Z ${LADDER}`;
    expect([...skippedInLog(prefixed)]).toEqual([KEY]);
  });

  // A title may end in something duration-shaped, and `-` marks a skip and nothing else in
  // this reporter — so the line below is a SKIP whose title happens to look timed. It read as
  // a timed case while `-` was in LINE's marker class: the key lost its "(8.2s)", the real
  // case went to `unexplained` and the truncated one to `unused`, so a complete log was
  // refused twice over for reasons neither of them names, and --accept-run-skips could not
  // reach it because nothing had classified it as a skip.
  it("keeps a skipped case whose title ends in a duration", () => {
    const titled = `${LADDER} waits (8.2s)`;
    const key = caseKey("t5-drop.spec.ts", 141, "link loss at the mid of a flush send loop waits (8.2s)");
    expect([...skippedInLog(titled)]).toEqual([key]);
    expect(durations(titled).size).toBe(0);
  });

  // …and a RESULT line is still taken out of the skip set first, which the markers alone no
  // longer do: a title can carry a marker-shaped fragment, and the line's own prefix keeps
  // SKIP_LINE from being anchored. Dropping the `LINE.test` guard turns this into a key built
  // from the middle of a title.
  it("leaves a timed case out even when its title embeds a marker line", () => {
    const nested =
      "  ✓  2 [race] › e2e/race/t5-drop.spec.ts:141:7 › T5 drop › a title reading -  3 [race] › e2e/race/x.spec.ts:2:2 › y (8.2s)";
    expect(skippedInLog(nested).size).toBe(0);
    expect(durations(nested).size).toBe(1);
  });

  it("strips the retry suffix a skipped attempt carries", () => {
    expect([...skippedInLog(`${LADDER} (retry #1)`)]).toEqual([KEY]);
  });

  it("reads nothing out of another project's lines", () => {
    expect(skippedInLog("  -  4 [chromium] › e2e/console.spec.ts:10:3 › console › a case").size).toBe(0);
  });

  // The two shapes the reporter's epilogue prints for a FAILED case. Neither is a result
  // line, and reading one as a skip would let a log that never ran a case account for it.
  it("reads nothing out of the failure epilogue", () => {
    const header = "  1) [race] › e2e/race/t5-drop.spec.ts:141:7 › T5 drop › link loss at the mid";
    const entry = "    [race] › e2e/race/t5-drop.spec.ts:141:7 › T5 drop › link loss at the mid";
    expect(skippedInLog(`${header}\n${entry}`).size).toBe(0);
  });
});

describe("logCoverage", () => {
  const collected = [
    { key: "a", skipped: false },
    { key: "b", skipped: true },
    { key: "c", skipped: false },
    { key: "d", skipped: false },
  ];
  const split = (measured, runtime) => logCoverage(collected, new Map(measured), new Set(runtime));

  it("puts each case in the group its own evidence names", () => {
    const found = split([["a", 100]], ["c"]);
    expect(found).toEqual({ timed: ["a"], declaredSkips: ["b"], runtimeSkips: ["c"], unexplained: ["d"] });
  });

  // The count that used to be a remainder. On a cancelled run — cases missing for no stated
  // reason — subtracting the declared skips from everything untimed reported them all as
  // "the run itself skipped", which is a claim the log never made.
  it("does not call a case the log never mentions a run-time skip", () => {
    expect(split([["a", 100]], []).runtimeSkips).toEqual([]);
    expect(split([["a", 100]], []).unexplained).toEqual(["c", "d"]);
  });

  it("prefers a duration over either kind of skip", () => {
    const found = split(
      [
        ["a", 1],
        ["b", 2],
        ["c", 3],
      ],
      ["c"],
    );
    expect(found.timed).toEqual(["a", "b", "c"]);
    expect(found.declaredSkips).toEqual([]);
    expect(found.runtimeSkips).toEqual([]);
  });
});

describe("planMismatch", () => {
  const plan = ["a:1|x", "b:2|y", "c:3|z"];

  it("says nothing when the runner takes the cases the plan cut", () => {
    expect(planMismatch("--shard=1/3", plan, [...plan])).toBeNull();
  });

  // The case the sequence comparison exists for: same count, different membership. Reported
  // by position and by both keys, since the counts are equal and say nothing.
  it("names the first position and both keys when the counts are equal", () => {
    const found = planMismatch("--shard=2/3", plan, ["a:1|x", "d:4|w", "c:3|z"]);
    // The label is the only thing saying WHICH shard diverged: the caller joins these into
    // one string, so a message without it sends the reader to the wrong shard.
    expect(found).toMatch(/^--shard=2\/3 /);
    expect(found).toMatch(/position 1/);
    expect(found).toMatch(/takes d:4\|w/);
    expect(found).toMatch(/plan puts b:2\|y/);
    expect(found).not.toMatch(/3 cases against/);
  });

  // The divergence the whole comparison exists for: Playwright grouping the SAME cases in
  // another order. A membership check passes it, and passed every other case in this file
  // when it was tried (measured), so this is the one that says sequence.
  it("reports the plan's own cases handed back in another order", () => {
    const found = planMismatch("--shard=1/3", plan, ["b:2|y", "a:1|x", "c:3|z"]);
    expect(found).toMatch(/position 0: Playwright takes b:2\|y where the plan puts a:1\|x/);
  });

  it("adds the counts only when they differ", () => {
    const short = planMismatch("--shard=3/3", plan, ["a:1|x", "b:2|y"]);
    expect(short).toMatch(/2 cases against the plan's 3/);
    expect(short).toMatch(/takes \(nothing\) where the plan puts c:3\|z/);
    expect(planMismatch("--shard=3/3", plan, [...plan, "d:4|w"])).toMatch(/position 3.*takes d:4\|w.*\(nothing\)/s);
  });
});

// The walk that turns a plan into per-shard questions. Its subject is the OFFSET: the caller
// used to keep one accumulator across this loop and the one that computes shard walls, and a
// reset that went missing would compare a shard against another shard's slice — printing a
// well-formed mismatch that blames Playwright for the walk's own error.
describe("planProblems", () => {
  const keys = ["a", "b", "c", "d", "e", "f"];
  const correct = (k) => keys.slice((k - 1) * 2, k * 2);

  // UNEVEN on purpose, and the committed array is `[38, 73, 59]`. With equal sizes every
  // offset expression built from the wrong element — `sizes[0]`, the last size, `i * stride`
  // — produces the same windows as the right one, so a suite of equal plans is green under
  // all of them (measured). The real weights are not equal, so those would refuse a correct
  // derivation and blame Playwright for it.
  it("cuts each shard at its own size and offset, not the first one's", () => {
    const plan = [1, 3, 2];
    const cut = { 1: ["a"], 2: ["b", "c", "d"], 3: ["e", "f"] };
    expect(planProblems(plan, keys, (k) => cut[k])).toEqual([]);
  });

  it("says nothing when every shard takes the slice the plan cut", () => {
    expect(planProblems([2, 2, 2], keys, correct)).toEqual([]);
  });

  // A shard the plan gives nothing is still asked and still compared: `weightShapeProblem`
  // accepts a zero, so the two files would otherwise disagree about whether one is legal.
  it("asks a zero-size shard too, and holds it against an empty slice", () => {
    const asked = [];
    const found = planProblems([0, 2], ["a", "b"], (k) => {
      asked.push(k);
      return k === 1 ? [] : ["a", "b"];
    });
    expect(asked).toEqual([1, 2]);
    expect(found).toEqual([]);
  });

  // The offset itself, stated as a case: shard 2 must be held against positions 2-3. Handed
  // shard 1's slice for every shard — which is what a lost reset produces — the first shard
  // agrees and the rest do not.
  it("holds each shard against its own positions", () => {
    const found = planProblems([2, 2, 2], keys, () => keys.slice(0, 2));
    expect(found).toHaveLength(2);
    expect(found[0]).toMatch(/^--shard=2\/3 differs from position 0: Playwright takes a where the plan puts c/);
    expect(found[1]).toMatch(/^--shard=3\/3 differs from position 0: Playwright takes a where the plan puts e/);
  });

  it("numbers the shards from one and counts them from the plan", () => {
    const found = planProblems([1, 1], ["a", "b"], () => []);
    expect(found[0]).toMatch(/^--shard=1\/2 /);
    expect(found[1]).toMatch(/^--shard=2\/2 /);
  });

  // The offsets themselves, shared with the loop that prices each segment. `[0, 170, 0]` is
  // there because weightShapeProblem accepts it: a zero-size shard must not move the ones
  // after it.
  it("starts each shard where the ones before it end", () => {
    expect(offsets([38, 73, 59])).toEqual([0, 38, 111]);
    expect(offsets([0, 170, 0])).toEqual([0, 0, 170]);
    expect(offsets([])).toEqual([]);
  });

  it("asks the runner once per shard, in order", () => {
    const asked = [];
    planProblems([2, 2, 2], keys, (k) => {
      asked.push(k);
      return correct(k);
    });
    expect(asked).toEqual([1, 2, 3]);
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

  // Mutation 1 as it was run by hand against the ledger: one shard given a case it does not
  // have. The corpus is the ledger's own sum, so this stays a mutation of the committed
  // arrangement however the harness grows or shrinks.
  const oneOver = [WEIGHTS[0] + 1, ...WEIGHTS.slice(1)];
  it("reports a sum that no longer matches the corpus, and says to re-derive", () => {
    const found = messages({ weights: oneOver, shardCounts: null });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(new RegExp(`sums to ${TOTAL + 1} but --project=race collects ${TOTAL}`));
    expect(found[0]).toMatch(/race-shard-weights\.mjs/);
  });

  // Mutation 2: the counts that come back when the variable is ignored are Playwright's own
  // equal-count split. Every shard is wrong, and each says so on its own line.
  it("reports the counts an ignored variable produces", () => {
    // Playwright's own equal-count split of the same corpus, derived rather than written out.
    const n = WEIGHTS.length;
    const equal = WEIGHTS.map((_, i) => Math.floor(TOTAL / n) + (i < TOTAL % n ? 1 : 0));
    const found = messages({ shardCounts: equal });
    expect(found).toHaveLength(n);
    expect(found[0]).toMatch(new RegExp(`--shard=1/${n} collects ${equal[0]} case\\(s\\).*not the ${WEIGHTS[0]}`, "s"));
    expect(found.every((m) => /stopped reading PWTEST_SHARD_WEIGHTS/.test(m))).toBe(true);
  });

  // A cut that falls inside a group Playwright assigns whole (e2e/race has one, the serial
  // ladder in t5-drop) moves cases without moving the sum — so the two shards either side
  // of that cut both report. Expressed against the ledger's own array rather than written
  // out: a re-derivation moves those numbers, and a fixture holding the previous ones
  // fails for a reason that has nothing to do with the rule (measured — this case broke
  // on the array going 38:66:59 → 38:74:51, where the literal it held was one shard off
  // instead of two and the rule itself was untouched).
  it("reports the two shards either side of a cut that moved", () => {
    const moved = [...WEIGHTS];
    moved[1] += 1;
    moved[2] -= 1;
    expect(messages({ shardCounts: moved })).toHaveLength(2);
  });

  // The sum is what says "re-derive"; taking the per-shard readings as well would report
  // the same corpus move three more times in a shape that names a different cause.
  it("does not ask for per-shard readings once the sum is wrong", () => {
    expect(messages({ weights: oneOver, shardCounts: null })).toHaveLength(1);
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
