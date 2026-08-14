// Pins that the version a release would tag is a tag the release path accepts, and that
// the release path still asks one place what a release tag looks like.
//
// tag-release.yml builds `v${version}` out of package.json on the merge of a version-bump
// pull request, and that tag is the release. Two gates stand on scripts/release-tag-shape.sh:
// tag-release refuses to push a tag the script declines, and release.yml's check-tag fails
// the run for one that reached it anyway. This asks the same question one step earlier
// still — on the pull request that sets the version, where the fix is a character rather
// than a red post-merge run.
//
// It runs the script rather than restating it. A second copy of what a release tag looks
// like is the drift this is about: the repository already keeps one it cannot fold in
// (release.yml's `on.push.tags` globs, since a trigger filter cannot run a script), and a
// third living in a test would be the one that silently disagrees.
//
// bash runs it, because the patterns are extglob and nothing else reads them the same way.
// A script FILE rather than `bash -c`: `shopt -s extglob` takes effect after a `-c` string
// has already been parsed, so the patterns are a syntax error there — which is also why
// the decision is a file rather than a `run:` block two workflows share.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8");

const SHAPE = "scripts/release-tag-shape.sh";
const CALLERS = [".github/workflows/tag-release.yml", ".github/workflows/release.yml"];

// Skipped where bash is absent, and the skip is named rather than silent.
const bash = spawnSync("bash", ["-c", "exit 0"], { encoding: "utf8" });
const bashAvailable = !bash.error && bash.status === 0;

function ask(...args) {
  const run = spawnSync("bash", [join(ROOT, SHAPE), ...args], { encoding: "utf8" });
  if (run.error) throw new Error(`could not run ${SHAPE}: ${run.error.message}`);
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

// Comments are dropped first, and that is the whole difficulty of this check: both
// workflows also NAME the script in prose, so asking whether the path appears anywhere
// passes on a file whose comment mentions it and whose steps no longer run it — measured,
// by replacing release.yml's invocation and watching every case here stay green. A line
// whose first non-space character is `#` is a comment to both YAML and the shell inside a
// `run:` block, which is the only place either question arises here.
const executableLines = (text) =>
  text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

// A text check, so it holds on a machine with no bash — which is the half that would
// otherwise let a workflow quietly stop asking while every other case here kept passing.
it("is the only place the workflows judge a tag's shape", () => {
  for (const caller of CALLERS) {
    const lines = executableLines(read(caller));
    expect(lines, `${caller} runs ${SHAPE}`).toContain(SHAPE);
    // The extglob patterns themselves, back in a workflow: a copy that would answer
    // differently the moment either side moved. Quoting one in a comment is not that, and
    // release.yml's header does quote the neighbouring `*([0-9.])` to say what its trigger
    // globs cannot express.
    expect(lines, `${caller} restates the patterns`).not.toMatch(/\+\(\[0-9]\)/);
  }
});

describe.skipIf(!bashAvailable)("the version a release would tag", () => {
  it("is a tag the release path accepts", () => {
    const version = JSON.parse(read("package.json")).version;
    expect(ask(version).status, `package.json version ${version}`).toBe(0);
  });

  // Both workflows read stdout and stderr merged into one variable, so an accepted tag has
  // to leave stderr empty: anything on it becomes the prerelease flag they go on to write.
  it.each([
    ["1.9.0", "false"],
    ["v1.9.0", "false"],
    ["1.9.0-rc1", "true"],
    ["v1.9.0-rc.1", "true"],
    ["1.9.0-beta.2", "true"],
    ["1.9.0-alpha", "true"],
  ])("accepts %s and says prerelease=%s on stdout alone", (tag, prerelease) => {
    const answer = ask(tag);
    expect(answer.status).toBe(0);
    expect(answer.stdout).toBe(`${prerelease}\n`);
    expect(answer.stderr).toBe("");
  });

  // Without these the suite passes on a script that accepts everything, which accepts the
  // version too.
  it.each([
    ["a channel outside the three", "1.9.0-pre.1"],
    ["a hyphen where the digits go", "1.9.0-rc-1"],
    ["SemVer build metadata", "1.9.0-rc.1+build.7"],
    ["an uppercased channel", "1.9.0-RC1"],
    ["no version at all", "not-a-version"],
  ])("declines %s, on stderr and with nothing on stdout", (_name, tag) => {
    const answer = ask(tag);
    expect(answer.status).toBe(1);
    expect(answer.stdout).toBe("");
    expect(answer.stderr).toContain("not a tag this repository releases");
  });

  // Exit 1 is a declined tag and exit 2 is a caller that asked wrong. Collapsing them would
  // let a workflow that lost its argument read as a version somebody should go and fix.
  it.each([[[]], [["1.0.0", "2.0.0"]]])("exits 2 rather than 1 when called with %j", (args) => {
    expect(ask(...args).status).toBe(2);
  });
});

if (!bashAvailable) {
  // Not a warning to be scrolled past: nothing else in this repository judges the version's
  // shape before the tag exists.
  console.warn("release-tag: bash is absent, so the version's tag shape was not checked at all");
}
