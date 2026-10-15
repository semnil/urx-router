// What `scripts/e2e-worktree.mjs` carries from the working tree into the throwaway worktree,
// asked of the PROGRAM. A fixture repository holds a copy of the script and a stub Playwright
// CLI where the linked install would put the real one; the stub runs inside the worktree, records
// what it finds there, and exits 0. The worktree is gone by the time the program returns, so the
// stub's record is the only reading of it.
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const PROGRAM = resolve(dirname(fileURLToPath(import.meta.url)), "e2e-worktree.mjs");

// Records, for each path it is handed, what the worktree holds there.
const STUB = `
const { lstatSync, readFileSync, readlinkSync, realpathSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const out = {};
for (const rel of JSON.parse(process.env.STUB_PROBE)) {
  const at = join(process.cwd(), rel);
  try {
    const link = lstatSync(at).isSymbolicLink();
    out[rel] = {
      link,
      target: link ? readlinkSync(at) : null,
      real: realpathSync(at),
      content: readFileSync(link && process.env.STUB_INSIDE ? join(at, process.env.STUB_INSIDE) : at, "utf8"),
    };
  } catch (e) {
    out[rel] = { error: e.code };
  }
}
writeFileSync(process.env.STUB_OUT, JSON.stringify({ cwd: realpathSync(process.cwd()), out }));
`;

const roots = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A repository holding the program and a stub CLI, with `tracked.txt` committed. */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "e2e-worktree-")));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  writeFileSync(join(repo, "tracked.txt"), "tracked\n");
  copyFileSync(PROGRAM, join(repo, "scripts", "e2e-worktree.mjs"));
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const cli = join(repo, "node_modules", "@playwright", "test");
  mkdirSync(cli, { recursive: true });
  writeFileSync(join(cli, "cli.js"), STUB);
  return { root, repo };
}

/** Runs the program over `repo` and returns its exit code plus the stub's record. */
function run({ root, repo }, probe, inside = "") {
  const wt = join(root, "wt");
  const out = join(root, "stub.json");
  const r = spawnSync(process.execPath, [join(repo, "scripts", "e2e-worktree.mjs"), "--path", wt, "--port", "4398"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, STUB_OUT: out, STUB_PROBE: JSON.stringify(probe), STUB_INSIDE: inside },
  });
  const seen = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
  return { code: r.status, stderr: r.stderr, seen, wt, wtLeft: existsSync(wt) };
}

describe("e2e-worktree carries the working tree", () => {
  it("carries an untracked file whose name git would quote", () => {
    const f = fixture();
    writeFileSync(join(f.repo, "ä.txt"), "umlaut\n");
    const r = run(f, ["ä.txt"]);
    expect(r.stderr).not.toMatch(/Error/);
    expect(r.code).toBe(0);
    expect(r.seen.out["ä.txt"]).toMatchObject({ link: false, content: "umlaut\n" });
    expect(r.wtLeft).toBe(false);
  });
});
