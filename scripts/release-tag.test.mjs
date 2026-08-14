// Pins that the version a release would tag is a tag the release workflow accepts.
//
// tag-release.yml builds `v${version}` out of package.json and pushes it before anything
// judges its shape; release.yml's `check-tag` judges it only once the tag exists, and
// tag-release refuses to move a tag that is already there. So a version in a channel
// `check-tag` does not accept costs a pushed tag, a red release run whose actor is the bot
// rather than a person, no Release, and a manual `git push --delete` to recover. This moves
// that judgement to the pull request that sets the version — which is the version-bump
// pull request, the only one where it can fire, and the one where the fix is a character.
//
// The patterns are EXTRACTED from release.yml rather than restated here. A second copy of
// what a release tag looks like is the drift this is about: the repository already keeps two
// (the `on.push.tags` globs and this `case`), and a third living in a test would be the one
// that silently disagrees.
//
// bash evaluates them, because they are extglob patterns and nothing else reads them the
// same way. A script FILE rather than `bash -c`: `shopt -s extglob` takes effect after a
// `-c` string has been parsed, so the patterns are a syntax error there — measured, and the
// same reason Actions runs a `run:` block as a file.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8");

// Anchored on the `case` and its `esac`, not scanned loosely: the job's own comment block is
// inside the range these lines come from and mentions the channel names in prose.
function acceptedPatterns() {
  const workflow = read(".github/workflows/release.yml");
  const block = /case "\$\{tag\}" in\n([\s\S]*?)\n\s*esac/.exec(workflow);
  if (!block) throw new Error("release.yml: could not find check-tag's `case` block");
  const arms = [...block[1].matchAll(/^\s+(\S[^\n]*?)\s*\)\s*$/gm)].map((match) => match[1]);
  const accepting = arms.filter((arm) => arm !== "*");
  if (accepting.length === 0) throw new Error("release.yml: check-tag's `case` accepts nothing");
  return accepting;
}

// Skipped where bash is absent, and the skip is named rather than silent.
const bash = spawnSync("bash", ["-c", "exit 0"], { encoding: "utf8" });
const bashAvailable = !bash.error && bash.status === 0;

function verdict(version, patterns) {
  const script = join(mkdtempSync(join(tmpdir(), "urx-release-tag-")), "oracle.sh");
  writeFileSync(
    script,
    [
      "#!/bin/bash",
      "shopt -s extglob",
      'case "$1" in',
      ...patterns.map((pattern) => `  ${pattern} ) echo accepted ;;`),
      "  *) echo declined ;;",
      "esac",
      "",
    ].join("\n"),
  );
  const run = spawnSync("bash", [script, version], { encoding: "utf8" });
  if (run.error || run.status !== 0) {
    throw new Error(`bash could not evaluate the patterns: ${(run.stderr || run.error?.message || "").trim()}`);
  }
  return run.stdout.trim();
}

describe.skipIf(!bashAvailable)("the version a release would tag", () => {
  const patterns = acceptedPatterns();

  it("is a tag check-tag accepts", () => {
    const version = JSON.parse(read("package.json")).version;
    expect(verdict(version, patterns), `package.json version ${version}`).toBe("accepted");
  });

  // Without this the test passes on an extraction that lost the discriminating arm, or on
  // one that produced a pattern matching everything — both of which accept the version too.
  it.each([
    ["a channel outside the three", "1.9.0-pre.1"],
    ["a hyphen where the digits go", "1.9.0-rc-1"],
    ["SemVer build metadata", "1.9.0-rc.1+build.7"],
    ["an uppercased channel", "1.9.0-RC1"],
    ["no version at all", "not-a-version"],
  ])("declines %s", (_name, version) => {
    expect(verdict(version, patterns)).toBe("declined");
  });

  it.each(["1.9.0", "1.9.0-rc1", "1.9.0-rc.1", "1.9.0-beta.2", "1.9.0-alpha"])("accepts %s", (version) => {
    expect(verdict(version, patterns)).toBe("accepted");
  });
});

if (!bashAvailable) {
  // Not a warning to be scrolled past: nothing else in this repository judges the version's
  // shape before the tag exists.
  console.warn("release-tag: bash is absent, so the version's tag shape was not checked at all");
}
