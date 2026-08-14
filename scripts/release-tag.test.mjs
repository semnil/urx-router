// Pins the release path's tag-shape gate: the script that decides what a release tag looks
// like, and the two workflow blocks that are supposed to act on its answer.
//
// tag-release.yml builds `v${version}` out of package.json on the merge of a version-bump
// pull request, and that tag is the release. Two gates stand on scripts/release-tag-shape.sh:
// tag-release refuses to push a tag the script declines, and release.yml's check-tag fails
// the run for one that reached it anyway. This file asks the same question one step earlier
// still — on the pull request that sets the version, where the fix is a character rather
// than a red post-merge run and a tag that cannot be moved.
//
// It RUNS the workflows' own `run:` blocks rather than reading them. The first version of
// this file only checked that the script's name appeared in each workflow, and three
// mutations measured green under it: release.yml taking the verdict and discarding it
// (`|| shape=false`), tag-release turning its refusal into a warning, and — the one that
// matters most — tag-release's whole gate moved BELOW `git push`, which is the exact
// arrangement this gate exists to replace, with its own comment still claiming otherwise.
// A name check cannot see any of that, so the blocks are extracted from the YAML and
// executed against a sandbox: a real script, a stub `git` and `gh` that record what they
// were asked to do, and a package.json holding the version under test.
//
// bash runs the script, because the patterns are extglob and nothing else reads them the
// same way. A script FILE rather than `bash -c`: `shopt -s extglob` takes effect after a
// `-c` string has already been parsed, so the patterns are a syntax error there — which is
// also why the decision is a file rather than a shell block pasted into both workflows.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8");

const SHAPE = "scripts/release-tag-shape.sh";
const RELEASE = ".github/workflows/release.yml";
const TAG_RELEASE = ".github/workflows/tag-release.yml";
const WORKFLOWS = ".github/workflows";

// Both callers invoke it this way on purpose: the file carries no executable bit, and `sh`
// would drop `shopt -s extglob` and then decline every tag — fail-closed, but only at the
// moment of a release.
const INVOCATION = `bash ${SHAPE}`;

// Skipped where the tools are absent, and the skip is named rather than silent. On CI they
// are present (ubuntu-latest carries both), so there the skip is refused outright: a green
// run that judged nothing is the failure mode this whole file exists to prevent.
const has = (cmd) => {
  const probe = spawnSync(cmd, ["--version"], { encoding: "utf8" });
  return !probe.error;
};
const toolsAvailable = has("bash") && has("jq") && has("tr");

// --- reading the workflows -------------------------------------------------------------

// A line whose first non-space character is `#` is a comment to both YAML and the shell
// inside a `run:` block, which are the only two places either question arises here.
const executableLines = (text) =>
  text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

// The `run: |` block that follows an anchor, dedented. Its end is the first line indented
// no further than the `run:` key itself, which is how a YAML block scalar ends.
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

// --- the sandbox the blocks run in -------------------------------------------------------

// `stubs` record their whole argv, so a case can assert what a block DID rather than what it
// printed — which is the only way to see a `git push` that should not have happened.
function sandbox({ version = "1.9.0", previous = "1.0.0", script = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "urx-release-gate-"));
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "bin"));
  if (script === null) copyFileSync(join(ROOT, SHAPE), join(dir, SHAPE));
  else if (script !== false) writeFileSync(join(dir, SHAPE), script, { mode: 0o644 });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "urx-router", version }, null, 2));
  const calls = join(dir, "calls.log");
  writeFileSync(calls, "");
  const stub = (name, body) => {
    writeFileSync(join(dir, "bin", name), `#!/bin/bash\nprintf '%s\\n' "${name} $*" >> ${calls}\n${body}\n`, {
      mode: 0o755,
    });
  };
  stub(
    "git",
    [
      'case "$1" in',
      "  rev-parse) echo 1111111111111111111111111111111111111111 ;;",
      `  show) printf '{"version":"%s"}\\n' ${previous} ;;`,
      "  ls-remote) exit 1 ;;",
      "esac",
      "exit 0",
    ].join("\n"),
  );
  stub("gh", "exit 0");
  return {
    dir,
    calls: () =>
      readFileSync(calls, "utf8")
        .split("\n")
        .filter((line) => line !== ""),
  };
}

// GitHub's default shell for a `run:` block with no `shell:` key is `bash -e {0}`.
function execute(body, { dir, env = {} }) {
  const path = join(dir, "block.sh");
  writeFileSync(path, body);
  const proc = spawnSync("bash", ["-e", path], {
    encoding: "utf8",
    cwd: dir,
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, ...env },
  });
  if (proc.error) throw new Error(`could not run the block: ${proc.error.message}`);
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

function ask(...args) {
  const run = spawnSync("bash", [join(ROOT, SHAPE), ...args], { encoding: "utf8" });
  if (run.error) throw new Error(`could not run ${SHAPE}: ${run.error.message}`);
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

// --- text rules, which hold on a machine with no bash ------------------------------------

it("is the only place any workflow judges a tag's shape", () => {
  for (const name of readdirSync(join(ROOT, WORKFLOWS))) {
    const lines = executableLines(read(`${WORKFLOWS}/${name}`));
    // A second copy of the extglob patterns, in any workflow — not only the two that ask.
    // The single home stops being one the moment a third file answers the same question.
    expect(lines, `${WORKFLOWS}/${name} carries the patterns itself`).not.toMatch(/\+\(\[0-9]\)/);
  }
  for (const caller of [RELEASE, TAG_RELEASE]) {
    expect(executableLines(read(caller)), `${caller} invokes it`).toContain(INVOCATION);
  }
});

// The one ordering that a running block cannot show, because the block that would prove it
// is the one that pushes. Measured before this existed: moving the gate below the push left
// every other case in this file green.
it("asks before tag-release pushes, not after", () => {
  const body = executableLines(runBlock(read(TAG_RELEASE), "GH_TOKEN:"));
  const asked = body.indexOf(INVOCATION);
  const pushed = body.indexOf("git push");
  expect(asked, "the gate is in tag-release's block").toBeGreaterThan(-1);
  expect(pushed, "tag-release still pushes a tag").toBeGreaterThan(-1);
  expect(asked, "the gate runs before the push").toBeLessThan(pushed);
});

// check-tag cannot reach the script without one, and deleting it turns every release run
// red on a tag that already exists and cannot be moved.
it("gives check-tag a checkout to reach the script through", () => {
  const job = read(RELEASE).split("\n  check-tag:")[1].split("\n  create-release:")[0];
  expect(job, "check-tag checks the repository out").toContain("actions/checkout@");
});

if (!toolsAvailable && process.env.CI) {
  throw new Error("release-tag: bash, jq and tr are required on CI — refusing to judge the release gate by nothing");
}

describe.skipIf(!toolsAvailable)("the tag shape", () => {
  it("accepts the version in package.json, spelled as a bare version and as the tag", () => {
    const version = JSON.parse(read("package.json")).version;
    expect(ask(version).status, `package.json version ${version}`).toBe(0);
    // tag-release asks with the `v` it prepends. The script strips an optional one, so the
    // bare form alone would not notice a caller that stopped prepending it.
    expect(ask(`v${version}`).status, `the tag v${version}`).toBe(0);
  });

  // The callers read stdout for the answer and stderr for the message, so an accepted tag
  // has to leave stderr empty and say exactly one word.
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
  // version too. The last two are the boundary release.yml's header names: the trigger glob
  // cannot express the trailing `*([0-9.])`, so widening it is invisible to every other case
  // here while `v1.0.0-alphafoo` starts being released.
  it.each([
    ["a channel outside the three", "1.9.0-pre.1"],
    ["a hyphen where the digits go", "1.9.0-rc-1"],
    ["SemVer build metadata", "1.9.0-rc.1+build.7"],
    ["an uppercased channel", "1.9.0-RC1"],
    ["no version at all", "not-a-version"],
    ["a word after the channel", "1.9.0-alphafoo"],
    ["a letter after the channel", "1.9.0-rcx"],
  ])("declines %s, on stderr and with nothing on stdout", (_name, tag) => {
    const answer = ask(tag);
    expect(answer.status).toBe(1);
    expect(answer.stdout).toBe("");
    expect(answer.stderr).toContain("not a tag this repository releases");
  });

  // git refuses these as ref names, so accepting them moves the failure back to `git tag`
  // in the post-merge run — the exact failure this gate was added to pull forward.
  it.each(["1.9.0-rc.", "1.9.0-rc..1"])("declines %s, which git will not name a tag", (tag) => {
    expect(ask(tag).status).toBe(1);
    const refCheck = spawnSync("git", ["check-ref-format", `refs/tags/v${tag}`], { encoding: "utf8" });
    expect(refCheck.status, `git rejects refs/tags/v${tag}`).not.toBe(0);
  });

  // Exit 1 is a verdict on the tag; anything else is this check being broken. Both callers
  // branch on that, and the empty argument is the shape a caller whose variable went missing
  // actually passes — both of them quote theirs, so zero arguments is not reachable and one
  // empty argument is.
  it.each([[[]], [[""]], [["1.0.0", "2.0.0"]]])("exits 2 rather than 1 when called with %j", (args) => {
    expect(ask(...args).status).toBe(2);
  });
});

describe.skipIf(!toolsAvailable)("release.yml's check-tag block", () => {
  const body = runBlock(read(RELEASE), "- id: check");

  const check = (refName, options = {}) => {
    const box = sandbox(options);
    const out = join(box.dir, "outputs");
    writeFileSync(out, "");
    const result = execute(body, {
      dir: box.dir,
      env: { GITHUB_REF_TYPE: options.refType ?? "tag", GITHUB_REF_NAME: refName, GITHUB_OUTPUT: out },
    });
    return { ...result, outputs: readFileSync(out, "utf8") };
  };

  it("writes the three outputs for a stable tag", () => {
    const r = check("v1.9.0");
    expect(r.status).toBe(0);
    expect(r.outputs).toContain("validTag=true");
    expect(r.outputs).toContain("prerelease=false");
    expect(r.outputs).toContain("version=v1.9.0");
  });

  it("marks a prerelease tag as one", () => {
    expect(check("v1.9.0-rc.1").outputs).toContain("prerelease=true");
  });

  it("fails on a tag the script declines, and writes no outputs", () => {
    const r = check("v1.9.0-pre.1");
    expect(r.status).not.toBe(0);
    expect(r.outputs).not.toContain("validTag=true");
    expect(r.stdout).toContain("::error::");
    expect(r.stdout).toContain("not a tag this repository releases");
  });

  // The packaging check. This is the one path the job must not fail, and the checkout that
  // reaches the script is skipped on it — so the block has to return before reading one.
  it("stays successful on a branch dispatch, without a script present", () => {
    const r = check("main", { refType: "branch", script: false });
    expect(r.status).toBe(0);
    expect(r.outputs.trim()).toBe("validTag=false");
  });

  // A script that answers something other than `true`/`false` used to be written straight
  // into `prerelease=`, and create-release compares that to the string `true` — so a
  // prerelease would have been published as a normal Release, which is what `latest`
  // resolves to and what the updater endpoint in src-tauri/tauri.conf.json follows.
  it("fails rather than passing on a corrupted answer", () => {
    const r = check("v1.9.0-rc.1", { script: "#!/bin/bash\nexit 0\n" });
    expect(r.status).not.toBe(0);
    expect(r.outputs).not.toContain("validTag=true");
    expect(r.stdout).toContain("could not run");
  });

  // Missing is not declined: blaming the tag would send the operator to the one thing that
  // is not at fault.
  it("says the check could not run when the script is absent", () => {
    const r = check("v1.9.0", { script: false });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("could not run");
    expect(r.stdout).not.toContain("not a tag this repository releases");
  });
});

describe.skipIf(!toolsAvailable)("tag-release.yml's block", () => {
  const body = runBlock(read(TAG_RELEASE), "GH_TOKEN:");

  const merge = (version, options = {}) => {
    const box = sandbox({ version, ...options });
    const result = execute(body, { dir: box.dir, env: { HEAD_SHA: "abcdef0", GH_TOKEN: "stub" } });
    return { ...result, calls: box.calls() };
  };

  // The positive control. Without it every assertion below is satisfied by a block that
  // pushes nothing under any circumstances.
  it("pushes the tag and dispatches the release when the version is accepted", () => {
    const r = merge("1.9.0");
    expect(r.status).toBe(0);
    expect(r.calls).toContainEqual("git tag v1.9.0 abcdef0");
    expect(r.calls).toContainEqual("git push origin refs/tags/v1.9.0");
    expect(r.calls.some((c) => c.startsWith("gh workflow run release.yml"))).toBe(true);
  });

  it("pushes a prerelease tag too", () => {
    expect(merge("1.9.0-rc.1").calls).toContainEqual("git push origin refs/tags/v1.9.0-rc.1");
  });

  it.each(["1.9.0-pre.1", "1.9.0-rc-1", "1.9.0-rc."])("pushes nothing when the version is %s", (version) => {
    const r = merge(version);
    expect(r.status).not.toBe(0);
    expect(
      r.calls.filter((c) => c.startsWith("git push")),
      "no tag was pushed",
    ).toEqual([]);
    expect(
      r.calls.filter((c) => c.startsWith("git tag")),
      "no tag was even created",
    ).toEqual([]);
    expect(r.stdout).toContain("refusing to tag");
  });

  it("pushes nothing and does not blame package.json when the script is absent", () => {
    const r = merge("1.9.0", { script: false });
    expect(r.status).not.toBe(0);
    expect(r.calls.filter((c) => c.startsWith("git push"))).toEqual([]);
    expect(r.stdout).toContain("could not run");
    expect(r.stdout).not.toContain("correct the version in package.json");
  });

  it("pushes nothing on a corrupted answer", () => {
    const r = merge("1.9.0", { script: "#!/bin/bash\nexit 0\n" });
    expect(r.status).not.toBe(0);
    expect(r.calls.filter((c) => c.startsWith("git push"))).toEqual([]);
  });

  // A version string can hold a real newline, and a second line inside an `::error::` is
  // read by the runner as another workflow command.
  it("does not let a version smuggle a second workflow command into the annotation", () => {
    const r = merge("1.0.0\n::add-mask::secret");
    expect(r.status).not.toBe(0);
    const annotations = r.stdout.split("\n").filter((line) => line.startsWith("::"));
    expect(annotations.some((line) => line.startsWith("::add-mask::"))).toBe(false);
  });

  it("does nothing at all when the version did not move", () => {
    const r = merge("1.0.0", { previous: "1.0.0" });
    expect(r.status).toBe(0);
    expect(r.calls.filter((c) => c.startsWith("git push"))).toEqual([]);
    expect(r.stdout).toContain("not a release");
  });
});

if (!toolsAvailable) {
  // Not a warning to be scrolled past: nothing else in this repository judges the version's
  // shape before the tag exists.
  console.warn("release-tag: bash, jq or tr is absent, so the release tag gate was not checked at all");
}
