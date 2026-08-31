// The app tier's WebKit project (`app-webkit` in playwright.config.ts) is selected by a
// TAG, so a case leaves it through an edit that deletes no line a reader would call a
// deletion: rename a test, drop the " @webkit" off the end of its title, and the project
// runs one case fewer with nothing red anywhere. The `chromium` project keeps every case
// it had, so its count does not move either.
//
// One end of that is already loud: a project collecting NOTHING is Playwright's own
// "No tests found", exit 1, at `--list` and at run time alike. What it cannot see is the
// set shrinking, which is the shape a rename leaves. So the floor is per FILE, the way
// e2e/race/skip-ledger.json holds the harness's, and a file collecting fewer than its
// floor fails here.
//
// The floor lives inline rather than in a ledger of its own: it is one line per file, and
// a JSON file beside a checker that reads nothing else would be a second thing to find.
//
// It asks the RUNNER rather than reading the specs. Collecting a spec executes it, so a
// case in dead code or inside a string never registers, while every version of "grep the
// titles" is satisfied by a title in a comment. And a run that could not answer is fatal
// here rather than an empty collection read as a clean one.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Forward slashes on every platform: the floor below is written the way the repository
// spells a path, and Windows would otherwise hand back e2e\console.spec.ts.
const rel = (p) => relative(repo, p).split(sep).join("/");

// The minimum each file contributes to the WebKit project. A minimum rather than an exact
// count, so adding a case to the class needs no edit here — and every file above its floor
// is printed in this map's own shape, so raising one is a paste.
const FLOOR = {
  "e2e/console.spec.ts": 2,
  "e2e/prefs.spec.ts": 1,
};

const require = createRequire(import.meta.url);

// Started as its own JavaScript entry under this node rather than through node_modules/.bin,
// which holds a shell script and a .cmd on Windows — and node refuses to spawn a .cmd
// without a shell.
function playwrightEntry() {
  const manifest = require.resolve("@playwright/test/package.json");
  const declared = JSON.parse(readFileSync(manifest, "utf8")).bin;
  return resolve(dirname(manifest), typeof declared === "string" ? declared : declared.playwright);
}

// The report goes to a FILE rather than to stdout: a single top-level console.log in any
// spec prints ahead of the JSON, and a check a stray debug line can take down is a check
// that gets deleted.
function collect(args, what) {
  const dir = mkdtempSync(join(tmpdir(), "urx-webkit-tier-"));
  try {
    const file = join(dir, "list.json");
    const r = spawnSync(process.execPath, [playwrightEntry(), "test", "--list", "--reporter=json", ...args], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: file },
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let json;
    try {
      json = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new Error(
        `${what} exited ${r.status} and wrote no report\n${r.stderr.trim().split("\n").slice(0, 10).join("\n")}`,
      );
    }
    const errors = (json.errors ?? []).map((e) => e.message?.split("\n")[0] ?? String(e));
    if (r.status !== 0 || errors.length) throw new Error(`${what} exited ${r.status}: ${errors.join("; ")}`);
    const root = json.config.rootDir;
    const out = [];
    const walk = (suite, trail) => {
      for (const spec of suite.specs ?? [])
        out.push({ file: rel(resolve(root, spec.file)), title: [...trail, spec.title].join(" > ") });
      for (const child of suite.suites ?? []) walk(child, [...trail, child.title]);
    };
    for (const suite of json.suites ?? []) walk(suite, []);
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the app tier's WebKit project", () => {
  const webkit = collect(["--project=app-webkit"], "playwright --list (app-webkit)");
  const perFile = new Map();
  for (const c of webkit) perFile.set(c.file, (perFile.get(c.file) ?? 0) + 1);

  it("collects at least the floor from every file that registers one", () => {
    const below = Object.entries(FLOOR)
      .map(([file, min]) => [file, min, perFile.get(file) ?? 0])
      .filter(([, min, n]) => n < min)
      .map(([file, min, n]) => `${file}: --project=app-webkit collects ${n} case(s), below the floor of ${min}`);
    expect(below).toEqual([]);
  });

  it("has a floor for every file it collects from", () => {
    const shape = [...perFile].filter(([file]) => !(file in FLOOR)).map(([file, n]) => `  "${file}": ${n},`);
    expect(shape, "a tagged file with no floor can lose every case it has without failing").toEqual([]);
  });

  it("reports each file's count so raising a floor is a paste", () => {
    const raise = [...perFile]
      .filter(([file, n]) => file in FLOOR && n > FLOOR[file])
      .map(([file, n]) => `  "${file}": ${n},`);
    expect(raise, "these files carry more than their floor").toEqual([]);
  });

  it("runs the same cases the ordinary tier does, never a fork of them", () => {
    // A tagged case that Chromium does not collect is one no other tier reports on, and
    // the comparison the project exists to make — the same case, the other engine — is
    // then two different cases.
    const chromium = new Set(
      collect(["--project=chromium", "--grep", "@webkit"], "playwright --list (chromium)").map(
        (c) => `${c.file}::${c.title}`,
      ),
    );
    const missing = webkit.map((c) => `${c.file}::${c.title}`).filter((k) => !chromium.has(k));
    expect(missing).toEqual([]);
  });
});
