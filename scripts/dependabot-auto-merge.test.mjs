// Pins which Dependabot pull requests .github/workflows/dependabot-auto-merge.yml lets merge on
// their own: every updated dependency a semver patch update.
//
// It RUNS the workflow's own `run:` block rather than reading it, against a stub `gh` that
// records what it was asked to do, with the metadata handed to it in the shape
// dependabot/fetch-metadata writes `updated-dependencies-json`: a JSON array of its
// `updatedDependency` objects, field names as that action spells them. The dependencies below
// are this repository's own, so the cases are the kinds Dependabot opens here; the
// multi-dependency ones are the arrangement fetch-metadata's summary outputs read wrongly,
// which is why the block reads every dependency instead.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOW = ".github/workflows/dependabot-auto-merge.yml";

const PR_URL = "https://github.com/semnil/urx-router/pull/1";
const HEAD_SHA = "2222222222222222222222222222222222222222";

// Skipped where the tools are absent, and the skip is named rather than silent. On CI they are
// present, so there the skip is refused outright: a green run that judged nothing is the
// failure this file exists to catch.
const has = (cmd) => !spawnSync(cmd, ["--version"], { encoding: "utf8" }).error;
const toolsAvailable = has("bash") && has("jq");

// The `run: |` block that follows an anchor, dedented. Its end is the first line indented no
// further than the `run:` key itself, which is how a YAML block scalar ends.
function runBlock(text, anchor) {
  const lines = text.split("\n");
  const from = lines.findIndex((line) => line.includes(anchor));
  if (from < 0) throw new Error(`anchor not found: ${anchor}`);
  const at = lines.findIndex((line, i) => i >= from && /^\s*run: \|\s*$/.test(line));
  if (at < 0) throw new Error(`no \`run: |\` after: ${anchor}`);
  const keyIndent = lines[at].search(/\S/);
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== "" && line.search(/\S/) <= keyIndent) break;
    body.push(line);
  }
  const indent = Math.min(...body.filter((l) => l.trim() !== "").map((l) => l.search(/\S/)));
  return body.map((l) => l.slice(indent)).join("\n") + "\n";
}

const BLOCK = runBlock(readFileSync(join(ROOT, WORKFLOW), "utf8"), "UPDATED:");

// One `updatedDependency` as fetch-metadata builds it. `packageEcosystem` is the second segment
// of Dependabot's branch name, so it reads `npm_and_yarn` and `github_actions` rather than the
// names dependabot.yml uses. An update with no version reaches it as an empty `updateType`.
const dep = (name, ecosystem, updateType, prevVersion, newVersion) => ({
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

const JSDOM_PATCH = dep("jsdom", "npm_and_yarn", PATCH, "30.1.2", "30.1.3");
const PLAYWRIGHT_MINOR = dep("@playwright/test", "npm_and_yarn", MINOR, "1.63.0", "1.64.0");
const LIBC_PATCH = dep("libc", "cargo", PATCH, "0.2.186", "0.2.190");
const JSDOM_MAJOR = dep("jsdom", "npm_and_yarn", MAJOR, "29.1.1", "30.0.0");
const TOOLCHAIN_SHA = dep(
  "dtolnay/rust-toolchain",
  "github_actions",
  "",
  "",
  "683b588c487a69d01f6c6ddf40f036ff682cc2c8",
);

function run(updated, { autoMerge = "false" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "urx-dependabot-auto-merge-"));
  mkdirSync(join(dir, "bin"));
  const calls = join(dir, "calls.log");
  writeFileSync(calls, "");
  writeFileSync(
    join(dir, "bin", "gh"),
    [
      "#!/bin/bash",
      `printf '%s\\n' "gh $*" >> ${calls}`,
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
      PR_URL,
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

const ENABLE = `gh pr merge --auto --merge --match-head-commit ${HEAD_SHA} ${PR_URL}`;
const VIEW = `gh pr view ${PR_URL} --json autoMergeRequest --jq .autoMergeRequest != null`;

it("runs where the tools are, and never skips on CI", () => {
  if (!toolsAvailable) expect(process.env.CI, "bash and jq are missing on CI").toBeFalsy();
});

describe.skipIf(!toolsAvailable)("the decision", () => {
  const enables = [
    ["a patch update", [JSDOM_PATCH]],
    ["a patch update of a crate below 1.0", [LIBC_PATCH]],
    ["several updates that each qualify", [LIBC_PATCH, JSDOM_PATCH]],
  ];
  it.each(enables)("enables auto-merge for %s", (_, updated) => {
    const result = run(updated);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([ENABLE]);
  });

  const disables = [
    ["a minor update", [PLAYWRIGHT_MINOR]],
    ["a major update", [JSDOM_MAJOR]],
    ["an update with no version", [TOOLCHAIN_SHA]],
    // fetch-metadata's `update-type` reads patch here: a dependency with no type is not counted.
    ["a patch update beside one with no version", [JSDOM_PATCH, TOOLCHAIN_SHA]],
    ["metadata listing no dependency", []],
    ["metadata fetch-metadata did not write", ""],
  ];
  it.each(disables)("leaves auto-merge off for %s", (_, updated) => {
    const result = run(updated);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([VIEW]);
  });
});

describe.skipIf(!toolsAvailable)("the disable half", () => {
  it("turns off an auto-merge an earlier head enabled", () => {
    const result = run([JSDOM_MAJOR], { autoMerge: "true" });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([VIEW, `gh pr merge --disable-auto ${PR_URL}`]);
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
