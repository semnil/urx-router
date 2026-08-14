// Pins the merge-gate checker, which nothing else covers: it is the only guard over the
// four status checks a merge waits for, and it had shipped two defects and then three more
// in its ref matcher, every one of them found by hand-run fixtures that were then thrown
// away. These are those fixtures, kept.
//
// The shape of every case is the same, and it is the one that matters for a checker: an
// arrangement that is WRONG must produce a finding, and the arrangement it is a mutation
// of must not. A rule that only ever gets shown broken input can be a rule that always
// fires; a rule that only ever gets shown good input can be one that never does.
//
// Driven through `inspect`, which is the same composition the command runs — only the
// reads are the caller's here.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { inspect, PatternError, refMatches } from "./check-merge-gates.mjs";

const MANIFEST = JSON.stringify({ integration_id: 15368, contexts: ["gate"] });

// A workflow that satisfies every rule: no trigger filter, one gate that waits for the
// only other job, `if: always()`, and a step that reads the results and exits non-zero.
const HEALTHY = `name: A
on:
  pull_request:
  push:
    branches: [main]
jobs:
  gate:
    needs: [work]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - name: fail unless every job passed
        if: contains(needs.*.result, 'failure')
        run: |
          exit 1
  work:
    runs-on: ubuntu-latest
    steps:
      - run: echo work
`;

const run = (text, { manifest = MANIFEST } = {}) =>
  inspect({ workflowSources: [{ path: ".github/workflows/a.yml", text }], manifestSource: manifest });

const findingsOf = (text, options) => run(text, options).findings;

describe("the arrangement a merge condition needs", () => {
  it("passes the healthy workflow", () => {
    const { findings, seen } = run(HEALTHY);
    expect(findings).toEqual([]);
    expect(seen.get("gate")).toBe(".github/workflows/a.yml");
  });

  // Rule 1. A workflow skipped by a trigger filter reports no check run at all, so the
  // required context can never arrive and the pull request can never merge.
  it.each(["paths", "paths-ignore", "branches", "branches-ignore"])("rejects an `on.pull_request.%s` filter", (key) => {
    const text = HEALTHY.replace("  pull_request:\n", `  pull_request:\n    ${key}:\n      - 'docs/**'\n`);
    expect(findingsOf(text).join("\n")).toContain(`on.pull_request.${key}`);
  });

  // Rule 1b. Narrowing `types` is the same hazard, quieter: the context exists on the
  // first commit and never on the head that gets merged.
  it("rejects a narrowed `types`, and accepts one that only adds", () => {
    const narrowed = HEALTHY.replace("  pull_request:\n", "  pull_request:\n    types: [opened]\n");
    expect(findingsOf(narrowed).join("\n")).toContain("omits synchronize, reopened");

    const widened = HEALTHY.replace(
      "  pull_request:\n",
      "  pull_request:\n    types: [opened, synchronize, reopened, ready_for_review]\n",
    );
    expect(findingsOf(widened)).toEqual([]);
  });

  // A filter written as a flow mapping is the same filter. The reader used to store it as
  // a value and report "no filter", which is the failure this whole file exists to catch.
  it("refuses an inline `pull_request:` rather than reading it as unfiltered", () => {
    const text = HEALTHY.replace("  pull_request:\n", '  pull_request: { paths: ["docs/**"] }\n');
    expect(findingsOf(text).join("\n")).toContain("carries an inline value");
  });

  it("refuses `on:` written as a flow list", () => {
    const text = HEALTHY.replace("on:\n  pull_request:\n  push:\n    branches: [main]\n", "on: [pull_request, push]\n");
    expect(findingsOf(text).join("\n")).toContain("flow list");
  });

  // Rule 2. A matrix job reports "gate (1)" per combination and never the bare name.
  it("rejects a matrix job as a required context", () => {
    const text = HEALTHY.replace(
      "  gate:\n    needs: [work]\n",
      "  gate:\n    strategy:\n      matrix:\n        shard: [1, 2]\n    needs: [work]\n",
    );
    expect(findingsOf(text).join("\n")).toContain("matrix job");
  });

  // Rule 3. A skipped job reports success, so a condition on the required job itself is a
  // green that measured nothing.
  it("rejects a condition on the required job", () => {
    const text = HEALTHY.replace("    if: always()\n", "    if: github.event_name == 'push'\n");
    expect(findingsOf(text).join("\n")).toContain("carries `if: github.event_name == 'push'`");
  });

  // Rule 4. `needs:` without `always()` is skipped by a failed dependency — and a skip
  // reports success.
  it("rejects `needs:` without `if: always()`", () => {
    const text = HEALTHY.replace("    if: always()\n", "");
    expect(findingsOf(text).join("\n")).toContain("but not `if: always()`");
  });

  // Rule 5. A job the gate does not wait for is a job whose failure blocks nothing.
  it("rejects a job no gate waits for", () => {
    const text = `${HEALTHY}  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo extra\n`;
    expect(findingsOf(text).join("\n")).toContain("does not wait for extra");
  });

  // Rule 6. A cancelled run reports neither success nor failure, so a group a run can be
  // DROPPED from has to be one no second run reporting the same context can join — and
  // cancelling in progress is only one of the two ways a run is dropped: `concurrency.queue`
  // defaults to `single`, which replaces the pending run when the next one arrives. Each
  // arrangement below is shown broken and beside the healthy one it mutates.
  it.each([
    ["a constant group", "gate-fixed"],
    ["a ref-keyed group", "gate-${{ github.ref }}"],
    ["a PR-keyed group with no per-run fallback", "gate-${{ github.event.pull_request.number }}"],
  ])("rejects %s that cancels in progress", (_name, group) => {
    const text = HEALTHY.replace("jobs:\n", `concurrency:\n  group: ${group}\n  cancel-in-progress: true\njobs:\n`);
    expect(findingsOf(text).join("\n")).toContain("can drop a run and is not keyed per run");
  });

  // The same rule at the other level, and in the two forms that would otherwise be read
  // as "no group at all" or "does not cancel".
  it("rejects a ref-keyed cancelling group declared on the job rather than the workflow", () => {
    const text = HEALTHY.replace(
      "  gate:\n    needs:",
      "  gate:\n    concurrency:\n      group: gate-${{ github.ref }}\n      cancel-in-progress: true\n    needs:",
    );
    expect(findingsOf(text).join("\n")).toContain("can drop a run and is not keyed per run");
  });

  it("treats an expression `cancel-in-progress` as cancelling rather than as false", () => {
    const text = HEALTHY.replace(
      "jobs:\n",
      "concurrency:\n  group: gate-${{ github.ref }}\n  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\njobs:\n",
    );
    expect(findingsOf(text).join("\n")).toContain("can drop a run and is not keyed per run");
  });

  it("refuses an inline `concurrency:` rather than reading it as no group", () => {
    const text = HEALTHY.replace(
      "jobs:\n",
      "concurrency: { group: 'gate-${{ github.ref }}', cancel-in-progress: true }\njobs:\n",
    );
    expect(findingsOf(text).join("\n")).toContain("carries an inline value");
  });

  // A key that MENTIONS the run id is not a key that varies with it. Both of these
  // evaluate to the same string for every run, and both passed while the test was a
  // substring search.
  it.each([
    ["a comparison", "gate-${{ github.ref }}-${{ github.run_id == 0 }}"],
    ["a short-circuit", "gate-${{ github.ref }}${{ 0 && github.run_id }}"],
  ])("rejects %s that names the run id and does not vary with it", (_name, group) => {
    const text = HEALTHY.replace("jobs:\n", `concurrency:\n  group: ${group}\n  cancel-in-progress: true\njobs:\n`);
    expect(findingsOf(text).join("\n")).toContain("can drop a run and is not keyed per run");
  });

  // The FALLBACK only reaches the run id when the left side is empty off a pull request.
  // `github.ref` is set on every event, so this key mentions the run id and never uses one.
  it("rejects a fallback whose left side is truthy on a push", () => {
    const text = HEALTHY.replace(
      "jobs:\n",
      "concurrency:\n  group: gate-${{ github.ref || github.run_id }}\n  cancel-in-progress: true\njobs:\n",
    );
    expect(findingsOf(text).join("\n")).toContain("can drop a run and is not keyed per run");
  });

  // A `concurrency` block has to be legal before it can be safe: GitHub refuses the
  // workflow, and a workflow that does not run reports no check run at all.
  it("rejects a queue value GitHub does not define", () => {
    const text = HEALTHY.replace(
      "jobs:\n",
      "concurrency:\n  group: gate-${{ github.run_id }}\n  cancel-in-progress: false\n  queue: bogus\njobs:\n",
    );
    expect(findingsOf(text).join("\n")).toContain("the documented values are");
  });

  it("rejects `queue: max` combined with cancelling, even under a per-run key", () => {
    const text = HEALTHY.replace(
      "jobs:\n",
      "concurrency:\n  group: gate-${{ github.run_id }}\n  cancel-in-progress: true\n  queue: max\njobs:\n",
    );
    expect(findingsOf(text).join("\n")).toContain("which GitHub rejects");
  });

  // `cancel-in-progress: false` is not on its own a group nothing is lost from: the
  // default `queue: single` replaces the pending run instead.
  it("rejects a shared group that does not cancel but also does not queue", () => {
    const text = HEALTHY.replace(
      "jobs:\n",
      "concurrency:\n  group: gate-${{ github.ref }}\n  cancel-in-progress: false\njobs:\n",
    );
    expect(findingsOf(text).join("\n")).toContain("can drop a run and is not keyed per run");
  });

  it("accepts the two keys nothing is dropped from", () => {
    // A run id, on its own and as the fallback half of the house idiom.
    for (const group of [
      "gate-${{ github.run_id }}",
      "gate-${{ github.event.pull_request.number || github.run_id }}",
      "gate-${{ github.head_ref || github.run_id }}",
    ]) {
      const text = HEALTHY.replace("jobs:\n", `concurrency:\n  group: ${group}\n  cancel-in-progress: true\njobs:\n`);
      expect(findingsOf(text)).toEqual([]);
    }
    // A shared group that neither cancels nor replaces: `queue: max` raises the pending
    // ceiling to 100, and cannot be combined with cancelling.
    const queued = HEALTHY.replace(
      "jobs:\n",
      "concurrency:\n  group: gate-${{ github.ref }}\n  cancel-in-progress: false\n  queue: max\njobs:\n",
    );
    expect(findingsOf(queued)).toEqual([]);
  });

  // Rule 7. The worst outcome: a required check that is green by construction.
  it("rejects a gate whose step cannot fail", () => {
    const text = HEALTHY.replace(
      "      - name: fail unless every job passed\n        if: contains(needs.*.result, 'failure')\n        run: |\n          exit 1\n",
      "      - run: echo ok\n",
    );
    expect(findingsOf(text).join("\n")).toContain("cannot fail");
  });

  it("reports a required context no workflow reports", () => {
    const text = HEALTHY.replace("  gate:\n", "  renamed:\n").replace("[work]", "[work]");
    expect(findingsOf(text).join("\n")).toContain("no pull-request workflow reports it");
  });

  // The check-run name is the job's `name:` when it has one, which is what the ruleset
  // matches on — a job id that matches the manifest is not enough.
  it("follows a job's `name:` to the context it actually reports", () => {
    const text = HEALTHY.replace("  gate:\n", "  gate:\n    name: Gate\n");
    expect(findingsOf(text).join("\n")).toContain("no pull-request workflow reports it");
  });

  it("reports a file it cannot read as `on:` + `jobs:`", () => {
    expect(findingsOf("name: A\non:\n  pull_request:\n").join("\n")).toContain("could not be read");
  });

  it("reports an empty workflow directory rather than passing over it", () => {
    const { findings } = inspect({ workflowSources: [], manifestSource: MANIFEST });
    expect(findings.join("\n")).toContain("no workflow files found");
  });
});

// The style where a sequence item sits at its key's own column is valid YAML and common in
// action READMEs. Reading it wrongly did not fail to read the file — it produced a
// confident false diagnosis, and false findings on a required context block the merge.
describe("sequence items at their key's own column", () => {
  const LEVEL_INDENTED = `name: A
on:
  pull_request:
jobs:
  gate:
    needs:
    - work
    if: always()
    runs-on: ubuntu-latest
    steps:
    - name: fail unless every job passed
      if: contains(needs.*.result, 'failure')
      run: |
        exit 1
  work:
    runs-on: ubuntu-latest
    steps:
    - run: echo work
`;

  it("does not let a step's keys become the job's", () => {
    expect(findingsOf(LEVEL_INDENTED)).toEqual([]);
  });

  it("still catches a gate that cannot fail in that style", () => {
    const text = LEVEL_INDENTED.replace(
      "    - name: fail unless every job passed\n      if: contains(needs.*.result, 'failure')\n      run: |\n        exit 1\n",
      "    - run: echo ok\n",
    );
    expect(findingsOf(text).join("\n")).toContain("cannot fail");
  });
});

describe("the manifest", () => {
  it("rejects a third-party context, which no job can report", () => {
    const manifest = JSON.stringify({ integration_id: 15368, contexts: ["gate", "codecov/patch"] });
    expect(findingsOf(HEALTHY, { manifest }).join("\n")).toContain("third-party check");
  });

  it("rejects a missing integration_id", () => {
    const manifest = JSON.stringify({ contexts: ["gate"] });
    expect(findingsOf(HEALTHY, { manifest }).join("\n")).toContain("`integration_id` is missing");
  });

  it("rejects an empty list rather than checking nothing", () => {
    expect(
      findingsOf(HEALTHY, { manifest: JSON.stringify({ integration_id: 15368, contexts: [] }) }).join("\n"),
    ).toContain("nothing would be checked");
  });

  it("reports a missing file and unreadable JSON", () => {
    expect(findingsOf(HEALTHY, { manifest: null }).join("\n")).toContain("no source of truth");
    expect(findingsOf(HEALTHY, { manifest: "{oops" }).join("\n")).toContain("not readable JSON");
  });
});

// The other half of the arrangement: what the live ruleset says. No token available to CI
// can read a ruleset, so this half only ever runs from `--ruleset` — which is exactly why
// its judgement needs pinning here, where it costs nothing to run.
describe("the live ruleset, compared with the manifest", () => {
  const ruleset = (checks, refName = { include: ["~DEFAULT_BRANCH"], exclude: [] }) => ({
    repo: "owner/repo",
    defaultBranch: "main",
    details: [
      {
        name: "main",
        conditions: { ref_name: refName },
        rules: [{ type: "required_status_checks", parameters: { required_status_checks: checks } }],
      },
    ],
  });
  const compare = (rulesetValue) =>
    inspect({
      workflowSources: [{ path: ".github/workflows/a.yml", text: HEALTHY }],
      manifestSource: MANIFEST,
      ruleset: rulesetValue,
    }).findings.join("\n");

  it("passes a ruleset that matches the manifest", () => {
    expect(compare(ruleset([{ context: "gate", integration_id: 15368 }]))).toBe("");
  });

  it("reports a context pinned to another app, which nothing here can satisfy", () => {
    expect(compare(ruleset([{ context: "gate", integration_id: 99999 }]))).toContain("can never be satisfied");
  });

  it("reports a context pinned to no app, which anything can satisfy", () => {
    expect(compare(ruleset([{ context: "gate" }]))).toContain("from any provider");
  });

  it("reports a context the manifest does not list, and one it lists that the ruleset omits", () => {
    expect(
      compare(
        ruleset([
          { context: "gate", integration_id: 15368 },
          { context: "other", integration_id: 15368 },
        ]),
      ),
    ).toContain("does not list");
    expect(compare(ruleset([]))).toContain("does not require `gate`");
  });

  it("reports a ruleset that requires everything on some other branch", () => {
    const elsewhere = ruleset([{ context: "gate", integration_id: 15368 }], {
      include: ["refs/heads/release/*"],
      exclude: [],
    });
    expect(compare(elsewhere)).toContain("does not govern main");
  });

  // The exclude side is where a pattern read as a plain string reports a governed branch
  // that is in fact exempt.
  it("applies an exclude PATTERN, not just an exact ref", () => {
    const excluded = ruleset([{ context: "gate", integration_id: 15368 }], {
      include: ["~ALL"],
      exclude: ["refs/heads/ma*"],
    });
    expect(compare(excluded)).toContain("does not govern main");
  });

  it("does not treat a class that cannot match the separator as an exclusion", () => {
    const notExcluded = ruleset([{ context: "gate", integration_id: 15368 }], {
      include: ["~ALL"],
      exclude: ["refs/heads/mai[/]n"],
    });
    expect(compare(notExcluded)).toBe("");
  });

  it("names a pattern it will not guess at rather than answering", () => {
    const undecidable = ruleset([{ context: "gate", integration_id: 15368 }], {
      include: ["~ALL"],
      exclude: ["refs/heads/m[^x]in"],
    });
    expect(compare(undecidable)).toContain("will not guess at");
  });

  it("reports a ruleset with no required status checks at all", () => {
    const none = { repo: "owner/repo", defaultBranch: "main", details: [{ name: "main", rules: [] }] };
    expect(compare(none)).toContain("no active branch ruleset requires any status check");
  });
});

// GitHub matches a ruleset's ref patterns with Ruby's File.fnmatch under FNM_PATHNAME and
// without backslash quoting. Every expectation below was measured against Ruby, and the
// differential test at the foot of this file re-measures them wherever ruby exists — the
// table alone would only pin whatever the implementation happened to do on the day.
const PATTERNS = [
  ["~ALL", "refs/heads/main", true],
  ["~DEFAULT_BRANCH", "refs/heads/main", true],
  ["refs/heads/main", "refs/heads/main", true],
  ["refs/heads/ma*", "refs/heads/main", true],
  ["refs/heads/*", "refs/heads/main", true],
  ["refs/heads/*", "refs/heads/release/v1", false],
  ["refs/heads/release/*", "refs/heads/release/v1", true],
  ["refs/*", "refs/heads/main", false],
  ["refs/heads/ma?n", "refs/heads/main", true],
  ["refs/heads/ma*n", "refs/heads/main", true],
  ["refs/heads/mai", "refs/heads/main", false],
  ["refs/tags/main", "refs/heads/main", false],
  ["refs/heads/*/*", "refs/heads/main", false],
  // `**` is recursive only as a whole path segment followed by `/`
  ["refs/heads/**/*", "refs/heads/main", true],
  ["refs/heads/**/*", "refs/heads/a/b/c", true],
  ["refs/**/*", "refs/heads", true],
  ["refs/heads/**", "refs/heads/main", true],
  ["refs/heads/**", "refs/heads/a/b", false],
  ["refs/heads/qa**/**/*", "refs/heads/qa/foo", true],
  ["refs/heads/qa**/**/*", "refs/heads/qa/bar/foo", true],
  ["qa/*", "qa/foo/bar", false],
  ["qa/**/*", "qa/foo/bar/hello", true],
  // a class does not match the separator either
  ["refs/heads/m[ab]in", "refs/heads/main", true],
  ["refs/heads/m[!x]in", "refs/heads/main", true],
  ["refs/heads/m[!a]in", "refs/heads/main", false],
  ["refs/heads/[a-z]ain", "refs/heads/main", true],
  ["refs/heads/main[/]extra", "refs/heads/main/extra", false],
  ["refs/heads/m[!/]in", "refs/heads/m/in", false],
  // degenerate classes, and an unterminated bracket that is NOT a literal bracket
  ["refs/heads/[]]x", "refs/heads/]x", false],
  ["refs/heads/[]x", "refs/heads/x", false],
  ["refs/heads/[!]x", "refs/heads/ax", true],
  ["refs/heads/[!]x", "refs/heads//x", false],
  ["refs/heads/[unterminated", "refs/heads/[unterminated", false],
  // one character, not one UTF-16 unit
  ["release-?", "release-\u{1F680}", true],
  ["refs/heads/?", "refs/heads/x", true],
  ["refs/heads/?", "refs/heads/xy", false],
  // a backslash is a literal backslash, and extglob is off
  ["refs/heads/ma\\*", "refs/heads/main", false],
  ["refs/heads/ma\\*", "refs/heads/ma*", false],
  ["refs/heads/ma\\*", "refs/heads/ma\\anything", true],
  ["refs/heads/+(main)", "refs/heads/main", false],
  ["refs/heads/+(main)", "refs/heads/+(main)", true],
];

describe("ref patterns, as GitHub matches them", () => {
  it.each(PATTERNS)("%s vs %s", (pattern, ref, expected) => {
    expect(refMatches(pattern, ref)).toBe(expected);
  });

  it("refuses a `[^…]` complement, which GitHub documents as unsupported", () => {
    expect(() => refMatches("refs/heads/m[^x]in", "refs/heads/main")).toThrow(PatternError);
  });
});

// The table above is a copy of Ruby's answers, and a copy can drift from what it copied.
// Where ruby exists — this machine, and the ubuntu runner ci.yml uses — ask it directly.
// Skipped elsewhere, and the skip is named rather than silent.
const ruby = spawnSync("ruby", ["-e", "puts 1"], { encoding: "utf8" });
const rubyAvailable = !ruby.error && ruby.status === 0;

describe.skipIf(!rubyAvailable)("ref patterns, differentially against File.fnmatch", () => {
  it("agrees with Ruby on every case in the table", () => {
    const script = `
      require "json"
      flags = File::FNM_PATHNAME | File::FNM_NOESCAPE
      puts JSON.generate(JSON.parse(STDIN.read).map { |p, r| File.fnmatch?(p, r, flags) })
    `;
    const pairs = PATTERNS.filter(([pattern]) => !pattern.startsWith("~")).map(([pattern, ref]) => [pattern, ref]);
    const out = spawnSync("ruby", ["-e", script], { input: JSON.stringify(pairs), encoding: "utf8" });
    expect(out.status, out.stderr).toBe(0);
    const oracle = JSON.parse(out.stdout);
    const mine = pairs.map(([pattern, ref]) => refMatches(pattern, ref));
    // Compared as a list of labelled rows so a failure names the pattern, not an index.
    const label = (values) => pairs.map(([p, r], i) => `${p} vs ${r} -> ${values[i]}`);
    expect(label(mine)).toEqual(label(oracle));
  });
});

if (!rubyAvailable) {
  // Not a warning to be scrolled past: this suite's strongest assertion did not run.
  console.warn(
    "check-merge-gates: ruby is absent, so the fnmatch differential did not run — the table alone was checked",
  );
}
