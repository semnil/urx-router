// Pins where release.yml lets the signing material go. The `build` job holds the updater
// signing key, the Developer ID certificate, the notarization credentials and a token that
// can write releases; this file holds that no third-party build code runs in that job, so
// none of it can read the keys or leave something behind for the step that holds them.
// Steps of one job share a workspace, an install and an environment; separate jobs start
// from separate VMs and share only what is handed over as an artifact or restored from a
// cache.
//
// The rules, each a property of the workflow text:
//   - the workflow-level `permissions` grant nothing beyond read, and only `create-release`,
//     `build` and `verify-draft` grant `contents: write` — `verify-draft` holds it only to
//     read the draft Release, which GitHub hides from a read-only token, and it names no
//     secret and runs no build code, so it joins the write-holders rather than being refused;
//   - no job but `build` names a secret, and in `build` only the tauri-action step does;
//   - `compile` builds the binary — `tauri build --no-bundle` — and hands it to `build` as an
//     artifact that `build` downloads, restoring the executable bit an artifact drops before
//     the bundle copies the binary into the .app;
//   - `build` runs no build: no `tauri build`, `cargo build` / `cargo test`, or package
//     manager `build` / `test` script, every install carries `--ignore-scripts`, nothing
//     restores a cache, and the checkout leaves no token in the git configuration;
//   - tauri-action's `tauriScript` is scripts/tauri-bundle.mjs, which turns the `build` it is
//     asked for into `bundle` and refuses anything else.
//
// Every workflow rule is also shown the arrangement it refuses, built by mutating the real
// workflow, beside the real workflow it is a mutation of: a rule that only ever sees good
// input can be one that never fires.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleArgs } from "./tauri-bundle.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RELEASE = ".github/workflows/release.yml";
const SHIM = "scripts/tauri-bundle.mjs";
const read = (path) => readFileSync(join(ROOT, path), "utf8");

const WRITERS = new Set(["create-release", "build", "verify-draft"]);

// --- reading the workflow ----------------------------------------------------------------

const indentOf = (line) => line.search(/\S/);
const value = (line) =>
  line
    .slice(line.indexOf(":") + 1)
    .replace(/\s+#.*$/, "")
    .trim();

// The lines a key at `indent` owns: those after it indented further, up to the first that is not.
function owned(lines, at) {
  const indent = indentOf(lines[at]);
  const out = [];
  for (const line of lines.slice(at + 1)) {
    if (indentOf(line) <= indent) break;
    out.push(line);
  }
  return out;
}

// `key:` at exactly `indent`, as the lines it owns, or null when absent.
function section(lines, key, indent) {
  const at = lines.findIndex((l) => indentOf(l) === indent && l.trim().startsWith(`${key}:`));
  return at < 0 ? null : { line: lines[at], body: owned(lines, at) };
}

function parse(text) {
  // Comment-only and blank lines carry nothing either question reads.
  const lines = text.split("\n").filter((l) => l.trim() !== "" && !/^\s*#/.test(l));
  const jobsAt = lines.findIndex((l) => l === "jobs:");
  const jobs = new Map();
  let name = null;
  for (const line of lines.slice(jobsAt + 1)) {
    const header = /^ {2}([\w-]+):\s*$/.exec(line);
    if (header) jobs.set((name = header[1]), []);
    else if (name) jobs.get(name).push(line);
  }
  return { top: lines.slice(0, jobsAt), jobs };
}

// Each step of a job, with its first line's `- ` turned into indentation so every key of the
// step sits at one column.
function steps(jobLines) {
  const stepsAt = jobLines.findIndex((l) => /^ {4}steps:\s*$/.test(l));
  if (stepsAt < 0) return [];
  const out = [];
  for (const line of owned(jobLines, stepsAt)) {
    if (/^ {6}- /.test(line)) out.push([line.replace(/^( {6})- /, "$1  ")]);
    else out.at(-1)?.push(line);
  }
  return out.map((lines) => {
    const uses = section(lines, "uses", 8);
    const run = section(lines, "run", 8);
    const withs = section(lines, "with", 8);
    const input = (key) => {
      const hit = withs && section(withs.body, key, 10);
      return hit ? value(hit.line) : null;
    };
    const runText = run ? [value(run.line), ...run.body.map((l) => l.trim())].join("\n").replace(/^[|>]\n/, "") : null;
    return { uses: uses ? value(uses.line) : null, run: runText, secrets: namesSecret(lines), input };
  });
}

const namesSecret = (lines) => lines.some((l) => /\bsecrets\./.test(l) || /^\s*secrets:\s*inherit\b/.test(l));
// A `permissions` block grants contents: write through its own line (`write-all`) or a scope under it.
const grantsWrite = (permissions) =>
  !!permissions &&
  (value(permissions.line) === "write-all" || permissions.body.some((l) => /^\s*contents:\s*write\b/.test(l)));
const needsOf = (jobLines) => {
  const needs = section(jobLines, "needs", 4);
  return needs
    ? value(needs.line)
        .replace(/[[\]]/g, "")
        .split(",")
        .map((s) => s.trim())
    : [];
};

// A step that runs build code: a compile, a frontend build or a test run.
const BUILDS = /\btauri\s+build\b|\bcargo\s+(?:build|test|run)\b|\b(?:pnpm|npm|yarn)\s+(?:run\s+)?(?:build|test)\b/;
const INSTALLS = /\b(?:pnpm|npm|yarn)\s+(?:install|ci|i)\b/;
const CACHES = /^(?:actions\/cache|swatinem\/rust-cache)@/;

/** Every way `text` (release.yml) lets third-party build code reach the signing material. */
function exposures(text) {
  const found = [];
  const { top, jobs } = parse(text);

  if (namesSecret(section(top, "env", 0)?.body ?? [])) found.push("the workflow env names a secret");
  const topPermissions = section(top, "permissions", 0);
  if (!topPermissions) found.push("the workflow declares no top-level permissions");
  else if (value(topPermissions.line) === "write-all") found.push("the workflow grants write-all to every job");
  for (const line of topPermissions?.body ?? []) {
    if (value(line) === "write") found.push(`the workflow grants ${line.trim()} to every job`);
  }
  for (const [job, lines] of jobs) {
    if (grantsWrite(section(lines, "permissions", 4)) && !WRITERS.has(job)) {
      found.push(`job ${job} grants contents: write`);
    }
    if (job !== "build" && namesSecret(lines)) found.push(`job ${job} names a secret`);
  }

  const compile = jobs.get("compile");
  const build = jobs.get("build");
  if (!compile) found.push("no compile job");
  if (!build) return [...found, "no build job"];
  if (namesSecret(section(build, "env", 4)?.body ?? [])) found.push("the build job's env names a secret");

  const compileSteps = compile ? steps(compile) : [];
  if (compile && !compileSteps.some((s) => /\btauri\s+build\b/.test(s.run ?? "") && /--no-bundle\b/.test(s.run))) {
    found.push("compile does not build the binary with tauri build --no-bundle");
  }
  const handed = compileSteps.find((s) => s.uses?.startsWith("actions/upload-artifact@"))?.input("name");
  if (compile && !handed) found.push("compile uploads no artifact");

  if (!needsOf(build).includes("compile")) found.push("build does not need compile");
  const all = steps(build);
  if (handed && !all.some((s) => s.uses?.startsWith("actions/download-artifact@") && s.input("name") === handed)) {
    found.push(`build does not download ${handed}`);
  }

  const checkout = all.find((s) => s.uses?.startsWith("actions/checkout@"));
  if (checkout?.input("persist-credentials") !== "false") {
    found.push("the build job's checkout leaves the token in the git configuration");
  }
  const bundleAt = all.findIndex((s) => s.uses?.startsWith("tauri-apps/tauri-action@"));
  for (const [i, step] of all.entries()) {
    const label = `build step ${i + 1} (${step.uses ?? step.run})`;
    if (step.secrets && i !== bundleAt) found.push(`${label} holds a secret`);
    if (BUILDS.test(step.run ?? "")) found.push(`${label} runs a build`);
    if (INSTALLS.test(step.run ?? "") && !/--ignore-scripts\b/.test(step.run)) {
      found.push(`${label} installs with install scripts on`);
    }
    if (CACHES.test(step.uses ?? "") || (step.uses?.startsWith("actions/setup-node@") && step.input("cache"))) {
      found.push(`${label} restores a cache`);
    }
  }
  if (bundleAt < 0) return [...found, "no tauri-action step"];
  if (all[bundleAt].input("tauriScript") !== `node ${SHIM}`) {
    found.push(`the tauri-action step does not run the Tauri CLI through ${SHIM}`);
  }
  // An artifact's files arrive with mode 644, so the macOS binary needs its executable bit
  // back before the bundle copies it into the .app.
  const downloadAt = all.findIndex(
    (s) => s.uses?.startsWith("actions/download-artifact@") && s.input("name") === handed,
  );
  const chmodAt = all.findIndex((s) => /\bchmod \+x\b.*urx-router/.test(s.run ?? ""));
  if (chmodAt < 0 || chmodAt < downloadAt || chmodAt > bundleAt) {
    found.push("build does not restore the binary's executable bit between the download and the bundle");
  }
  return found;
}

// --- cases -------------------------------------------------------------------------------

const WORKFLOW = read(RELEASE);

// A mutation that does not change the text would pass every case below vacuously.
function mutate(text, from, to) {
  const out = text.replace(from, to);
  expect(out, `mutation did not apply: ${from}`).not.toBe(text);
  return out;
}

// The build job's lines in the raw text, from its header to the next job's.
const BUILD_JOB = /^ {2}build:\n[\s\S]*?(?=^ {2}[\w-]+:\n)/m;
const inBuild = (from, to) => (text) => {
  const job = BUILD_JOB.exec(text)[0];
  return text.replace(job, mutate(job, from, to));
};

describe("release.yml keeps third-party build code away from the signing material", () => {
  it("holds on the workflow as it stands", () => {
    expect(exposures(WORKFLOW)).toEqual([]);
  });

  it("refuses contents: write beyond create-release, build and verify-draft", () => {
    const wide = mutate(WORKFLOW, /^permissions:\n {2}contents: read$/m, "permissions:\n  contents: write");
    expect(exposures(wide)).toContain("the workflow grants contents: write to every job");
    const all = mutate(WORKFLOW, /^permissions:\n {2}contents: read$/m, "permissions: write-all");
    expect(exposures(all)).toContain("the workflow grants write-all to every job");
    const compile = mutate(WORKFLOW, /^( {4}permissions:\n {6}contents: )read$/m, "$1write");
    expect(exposures(compile)).toContain("job compile grants contents: write");
    const gate = mutate(WORKFLOW, /^ {2}release-gate:\n/m, "  release-gate:\n    permissions: write-all\n");
    expect(exposures(gate)).toContain("job release-gate grants contents: write");
  });

  it("refuses a secret anywhere but build's tauri-action step", () => {
    const licenses = mutate(
      WORKFLOW,
      /^( {4})uses: \.\/\.github\/workflows\/licenses\.yml\n/m,
      "$1uses: ./.github/workflows/licenses.yml\n$1secrets: inherit\n",
    );
    expect(exposures(licenses)).toContain("job licenses names a secret");
    const compile = mutate(
      WORKFLOW,
      /^( {6})- run: pnpm tauri build --no-bundle (.*)\n/m,
      "$1- run: pnpm tauri build --no-bundle $2\n$1  env:\n$1    TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}\n",
    );
    expect(exposures(compile)).toContain("job compile names a secret");
    const install = inBuild(
      /^( {6})- run: pnpm install (.*)\n/m,
      "$1- run: pnpm install $2\n$1  env:\n$1    APPLE_PASSWORD: ${{ secrets.MACOS_NOTARIZATION_PASSWORD }}\n",
    )(WORKFLOW);
    expect(exposures(install).some((f) => /\(pnpm install .*\) holds a secret$/.test(f))).toBe(true);
    const jobEnv = inBuild(
      /^( {4})steps:\n/m,
      "$1env:\n$1  APPLE_PASSWORD: ${{ secrets.MACOS_NOTARIZATION_PASSWORD }}\n$1steps:\n",
    )(WORKFLOW);
    expect(exposures(jobEnv)).toContain("the build job's env names a secret");
  });

  it("refuses a build job that compiles, builds or tests", () => {
    for (const command of ["pnpm build", "pnpm tauri build", "cargo build --release", "pnpm test"]) {
      const text = inBuild(/^( {6})- id: tauri\n/m, `$1- run: ${command}\n$1- id: tauri\n`)(WORKFLOW);
      expect(exposures(text).some((f) => f.endsWith(`(${command}) runs a build`))).toBe(true);
    }
  });

  it("refuses install scripts and caches in the build job", () => {
    const scripts = inBuild(/(- run: pnpm install --frozen-lockfile) --ignore-scripts/, "$1")(WORKFLOW);
    expect(exposures(scripts).some((f) => f.endsWith("installs with install scripts on"))).toBe(true);
    const pnpmCache = inBuild(/^( {10}node-version: 24\n)/m, "$1          cache: pnpm\n")(WORKFLOW);
    expect(exposures(pnpmCache).some((f) => /\(actions\/setup-node@.*\) restores a cache$/.test(f))).toBe(true);
    const rustCache = inBuild(
      /^( {6})- id: tauri\n/m,
      "$1- uses: swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6 # v2.9.2\n$1- id: tauri\n",
    )(WORKFLOW);
    expect(exposures(rustCache).some((f) => /\(swatinem\/rust-cache@.*\) restores a cache$/.test(f))).toBe(true);
  });

  it("refuses a build checkout that persists the token", () => {
    const text = inBuild(/\n\s*persist-credentials: false/, "")(WORKFLOW);
    expect(exposures(text)).toContain("the build job's checkout leaves the token in the git configuration");
  });

  it("refuses a tauri-action that is not started through the bundle script", () => {
    const text = mutate(WORKFLOW, /^ {10}tauriScript: .*\n/m, "");
    expect(exposures(text)).toContain(`the tauri-action step does not run the Tauri CLI through ${SHIM}`);
  });

  it("refuses a binary that compile does not build or build does not take", () => {
    const noCompile = mutate(WORKFLOW, /pnpm tauri build --no-bundle/, "pnpm tauri build");
    expect(exposures(noCompile)).toContain("compile does not build the binary with tauri build --no-bundle");
    const notNeeded = mutate(
      WORKFLOW,
      /needs: \[check-tag, create-release, licenses, compile\]/,
      "needs: [check-tag, create-release, licenses]",
    );
    expect(exposures(notNeeded)).toContain("build does not need compile");
    const otherName = inBuild(/name: app-binary-/, "name: other-binary-")(WORKFLOW);
    expect(exposures(otherName)).toContain("build does not download app-binary-${{ matrix.platform }}");
    const noChmod = inBuild(/^ {6}- if: runner\.os == 'macOS'\n {8}run: chmod \+x .*\n/m, "")(WORKFLOW);
    expect(exposures(noChmod)).toContain(
      "build does not restore the binary's executable bit between the download and the bundle",
    );
  });
});

describe("scripts/tauri-bundle.mjs", () => {
  it("turns tauri-action's build into bundle and passes the rest through", () => {
    expect(bundleArgs(["build", "--target", "aarch64-apple-darwin"])).toEqual([
      "bundle",
      "--target",
      "aarch64-apple-darwin",
    ]);
    expect(bundleArgs(["build"])).toEqual(["bundle"]);
  });

  it("refuses anything but build", () => {
    for (const argv of [[], ["dev"], ["bundle"], ["android", "build"]]) {
      expect(() => bundleArgs(argv)).toThrow(/expected tauri-action to ask for "build"/);
    }
  });

  // The program end to end, against the CLI this checkout installed: `build --help` reaches
  // the real `tauri bundle --help`, and a refused command exits before starting the CLI.
  it("starts the installed CLI's bundle command", () => {
    const run = spawnSync(process.execPath, [join(ROOT, SHIM), "build", "--help"], { cwd: ROOT, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/Generate bundles and installers for your app \(already built by `tauri build`\)/);
    const refused = spawnSync(process.execPath, [join(ROOT, SHIM), "dev"], { cwd: ROOT, encoding: "utf8" });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/expected tauri-action to ask for "build"/);
  });
});
