// Pins which Dependabot pull requests .github/workflows/dependabot-auto-merge.yml lets merge on
// their own: every updated dependency a semver patch or a semver minor update, a minor update
// of a cargo crate below 1.0 excepted, in a pull request that is one commit, the head, which
// dependabot[bot] wrote and GitHub verified the signature of.
//
// It RUNS the workflow's own `run:` block rather than reading it, against a stub `gh` that
// records what it was asked to do, with the metadata handed to it in the shape
// dependabot/fetch-metadata writes `updated-dependencies-json`: a JSON array of its
// `updatedDependency` objects, field names as that action spells them. The dependencies below
// are this repository's own, so the cases are the kinds Dependabot opens here; the
// multi-dependency ones are the arrangement fetch-metadata's summary outputs read wrongly,
// which is why the block reads every dependency instead. The stub answers the pull request's
// commit list in the shape the REST pulls API returns it, because fetch-metadata reads the
// first commit alone.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBlock } from "./workflow-block.test-util.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOW = ".github/workflows/dependabot-auto-merge.yml";

const PR_URL = "https://github.com/semnil/urx-router/pull/1";
const HEAD_SHA = "2222222222222222222222222222222222222222";
const OTHER_SHA = "3333333333333333333333333333333333333333";

// One commit as the REST pulls API lists it, with the fields the block reads.
const commit = (sha, login, verified = true) => ({
  sha,
  author: { login },
  commit: { verification: { verified } },
});
const DEPENDABOT_AT_HEAD = [commit(HEAD_SHA, "dependabot[bot]")];

// Skipped where the tools are absent, and the skip is named rather than silent. On CI they are
// present, so there the skip is refused outright: a green run that judged nothing is the
// failure this file exists to catch.
const has = (command) => !spawnSync(command, ["--version"], { encoding: "utf8" }).error;
const toolsAvailable = has("bash") && has("jq");

const BLOCK = runBlock(readFileSync(join(ROOT, WORKFLOW), "utf8"), "UPDATED:");

// One `updatedDependency` as fetch-metadata builds it. `packageEcosystem` is the second segment
// of Dependabot's branch name, so it reads `npm_and_yarn` and `github_actions` rather than the
// names dependabot.yml uses. An update with no version reaches it as an empty `updateType`.
const dependency = (name, ecosystem, updateType, prevVersion, newVersion) => ({
  dependencyName: name,
  dependencyType: "direct:production",
  updateType,
  directory: "/",
  packageEcosystem: ecosystem,
  targetBranch: "main",
  prevVersion,
  newVersion,
  compatScore: 0,
  maintainerChanges: false,
  dependencyGroup: "",
  alertState: "",
  ghsaId: "",
  cvss: 0,
});

const PATCH = "version-update:semver-patch";
const MINOR = "version-update:semver-minor";
const MAJOR = "version-update:semver-major";

const JSDOM_PATCH = dependency("jsdom", "npm_and_yarn", PATCH, "30.1.2", "30.1.3");
const PLAYWRIGHT_MINOR = dependency("@playwright/test", "npm_and_yarn", MINOR, "1.63.0", "1.64.0");
const ESBUILD_MINOR = dependency("esbuild", "npm_and_yarn", MINOR, "0.28.2", "0.29.0");
const UPDATER_MINOR = dependency("tauri-plugin-updater", "cargo", MINOR, "2.13.3", "2.14.0");
const LIBC_PATCH = dependency("libc", "cargo", PATCH, "0.2.186", "0.2.190");
const TUNGSTENITE_MINOR = dependency("tungstenite", "cargo", MINOR, "0.29.0", "0.30.0");
const MIDIR_MINOR = dependency("midir", "cargo", MINOR, "0.10.4", "0.11.0");
const SETUP_NODE_MINOR = dependency("actions/setup-node", "github_actions", MINOR, "7.0.0", "7.1.0");
const JSDOM_MAJOR = dependency("jsdom", "npm_and_yarn", MAJOR, "29.1.1", "30.0.0");
const TOOLCHAIN_SHA = dependency(
  "dtolnay/rust-toolchain",
  "github_actions",
  "",
  "",
  "683b588c487a69d01f6c6ddf40f036ff682cc2c8",
);

function run(updated, { autoMerge = "false", commits = DEPENDABOT_AT_HEAD } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "urx-dependabot-auto-merge-"));
  mkdirSync(join(dir, "bin"));
  const calls = join(dir, "calls.log");
  writeFileSync(calls, "");
  const commitsFile = join(dir, "commits.json");
  if (commits !== null) writeFileSync(commitsFile, JSON.stringify(commits));
  writeFileSync(
    join(dir, "bin", "gh"),
    [
      "#!/bin/bash",
      `printf '%s\\n' "gh $*" >> ${calls}`,
      'if [[ "$1" == "api" ]]; then',
      commits === null ? "  echo 'HTTP 502' >&2; exit 1" : `  cat ${commitsFile}; exit 0`,
      "fi",
      'if [[ "$1 $2" == "pr view" ]]; then',
      `  echo '${autoMerge}'`,
      "fi",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  const path = join(dir, "block.sh");
  writeFileSync(path, BLOCK);
  // GitHub's default shell for a `run:` block with no `shell:` key is `bash -e {0}`.
  const proc = spawnSync("bash", ["-e", path], {
    encoding: "utf8",
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "semnil/urx-router",
      PR_URL,
      PR_NUMBER: "1",
      HEAD_SHA,
      UPDATED: typeof updated === "string" ? updated : JSON.stringify(updated),
    },
  });
  if (proc.error) throw new Error(`could not run the block: ${proc.error.message}`);
  return {
    status: proc.status,
    stdout: proc.stdout,
    calls: readFileSync(calls, "utf8")
      .split("\n")
      .filter((line) => line !== ""),
  };
}

const COMMITS = "gh api repos/semnil/urx-router/pulls/1/commits?per_page=100";
const ENABLE = `gh pr merge --auto --merge --match-head-commit ${HEAD_SHA} ${PR_URL}`;
const VIEW = `gh pr view ${PR_URL} --json autoMergeRequest --jq .autoMergeRequest != null`;
const DISABLE = `gh pr merge --disable-auto ${PR_URL}`;

it("runs where the tools are, and never skips on CI", () => {
  if (!toolsAvailable) expect(process.env.CI, "bash and jq are missing on CI").toBeFalsy();
});

describe.skipIf(!toolsAvailable)("the decision", () => {
  const enables = [
    ["a patch update", [JSDOM_PATCH]],
    ["a minor update of an npm package", [PLAYWRIGHT_MINOR]],
    // The 0.x exception is cargo's alone: an npm package below 1.0 qualifies like any other.
    ["a minor update of an npm package below 1.0", [ESBUILD_MINOR]],
    ["a minor update of a crate at 1.0 or above", [UPDATER_MINOR]],
    ["a patch update of a crate below 1.0", [LIBC_PATCH]],
    ["a minor update of an action", [SETUP_NODE_MINOR]],
    ["several updates that each qualify", [UPDATER_MINOR, LIBC_PATCH, JSDOM_PATCH]],
  ];
  it.each(enables)("enables auto-merge for %s", (_, updated) => {
    const result = run(updated);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([COMMITS, ENABLE]);
  });

  const disables = [
    ["a minor update of a crate below 1.0", [TUNGSTENITE_MINOR]],
    ["a major update", [JSDOM_MAJOR]],
    ["an update with no version", [TOOLCHAIN_SHA]],
    // fetch-metadata's `update-type` reads patch here: a dependency with no type is not counted.
    ["a patch update beside one with no version", [JSDOM_PATCH, TOOLCHAIN_SHA]],
    // fetch-metadata's `previous-version` reads 2.13.3 here: it is the first dependency's.
    ["a qualifying minor update beside a minor of a crate below 1.0", [UPDATER_MINOR, MIDIR_MINOR]],
    ["a minor update of a crate whose previous version is missing", [{ ...UPDATER_MINOR, prevVersion: "" }]],
    ["a minor update whose ecosystem is missing", [{ ...PLAYWRIGHT_MINOR, packageEcosystem: "" }]],
    ["metadata listing no dependency", []],
    ["metadata fetch-metadata did not write", ""],
  ];
  it.each(disables)("leaves auto-merge off for %s", (_, updated) => {
    const result = run(updated);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([VIEW]);
  });
});

describe.skipIf(!toolsAvailable)("the commit history", () => {
  const leavesOff = [
    ["a commit someone added after Dependabot's", [commit(OTHER_SHA, "dependabot[bot]"), commit(HEAD_SHA, "someone")]],
    ["one commit someone else wrote", [commit(HEAD_SHA, "someone")]],
    ["one Dependabot commit whose signature is not verified", [commit(HEAD_SHA, "dependabot[bot]", false)]],
    ["one Dependabot commit that is not the head", [commit(OTHER_SHA, "dependabot[bot]")]],
    [
      "two Dependabot commits with the head listed first",
      [commit(HEAD_SHA, "dependabot[bot]"), commit(OTHER_SHA, "dependabot[bot]")],
    ],
    ["no commit", []],
  ];
  it.each(leavesOff)("leaves auto-merge off for a qualifying update in %s", (_, commits) => {
    const result = run([JSDOM_PATCH], { commits });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([COMMITS, VIEW]);
  });

  it("turns off an auto-merge an earlier head enabled when a commit was added", () => {
    const commits = [commit(OTHER_SHA, "dependabot[bot]"), commit(HEAD_SHA, "someone")];
    const result = run([PLAYWRIGHT_MINOR], { commits, autoMerge: "true" });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([COMMITS, VIEW, DISABLE]);
  });

  it("fails when it cannot read the commits", () => {
    const result = run([JSDOM_PATCH], { commits: null });
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([COMMITS]);
  });
});

describe.skipIf(!toolsAvailable)("the disable half", () => {
  it("turns off an auto-merge an earlier head enabled", () => {
    const result = run([JSDOM_MAJOR], { autoMerge: "true" });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([VIEW, DISABLE]);
  });

  it("fails when it cannot read whether auto-merge is on", () => {
    const result = run([JSDOM_MAJOR], { autoMerge: "" });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("::error::could not read whether auto-merge is enabled");
    expect(result.calls).toEqual([VIEW]);
  });

  it("fails rather than deciding when the metadata is not JSON", () => {
    const result = run("not json");
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([]);
  });
});
