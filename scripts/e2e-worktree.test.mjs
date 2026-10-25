// What `scripts/e2e-worktree.mjs` carries from the working tree into the throwaway worktree,
// asked of the PROGRAM. A fixture repository holds a copy of the script and a stub Playwright
// CLI where the linked install would put the real one; the stub runs inside the worktree, records
// what it finds there, and exits 0. The worktree is gone by the time the program returns, so the
// stub's record is the only reading of it.
//
// The symlink cases are separate tests from the plain-file one, and each is skipped by name where
// this machine cannot make that kind of link (a file symlink on Windows without Developer Mode),
// so the others still run.
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const PROGRAM = resolve(dirname(fileURLToPath(import.meta.url)), "e2e-worktree.mjs");

/** Whether this machine can make a link of `type`. Windows refuses a file symlink without
 *  Developer Mode or the create-symbolic-link privilege, while a junction needs neither; the
 *  type is ignored elsewhere. This repository is worked from both. */
function canLink(type) {
  const tmp = mkdtempSync(join(tmpdir(), "e2e-worktree-symlink-probe-"));
  try {
    mkdirSync(join(tmp, "dir"));
    writeFileSync(join(tmp, "file"), "");
    symlinkSync(join(tmp, type === "junction" ? "dir" : "file"), join(tmp, "link"), type);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
const dirLinks = canLink("junction");
const fileLinks = canLink("file");
const skipNote = (ok) => (ok ? "" : " — SKIPPED, this machine cannot create one");

// Records, for each path it is handed, what the worktree holds there.
const STUB = `
const { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const out = {};
for (const rel of JSON.parse(process.env.STUB_PROBE)) {
  const at = join(process.cwd(), rel);
  try {
    const link = lstatSync(at).isSymbolicLink();
    const read = link && process.env.STUB_INSIDE ? join(at, process.env.STUB_INSIDE) : at;
    out[rel] = {
      link,
      target: link ? readlinkSync(at) : null,
      real: realpathSync(at),
      // A directory is recorded by the names it holds.
      content: statSync(read).isDirectory() ? readdirSync(read) : readFileSync(read, "utf8"),
    };
  } catch (e) {
    out[rel] = { error: e.code };
  }
}
writeFileSync(process.env.STUB_OUT, JSON.stringify({ cwd: realpathSync(process.cwd()), out }));
process.exit(Number(process.env.STUB_EXIT || 0));
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
  // Files are checked out with the line ends they were written with, whatever `core.autocrlf`
  // the machine sets.
  git(repo, "config", "core.autocrlf", "false");
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
function run({ root, repo }, probe, inside = "", { keep = false, exit = 0 } = {}) {
  const wt = join(root, "wt");
  const out = join(root, "stub.json");
  const args = [join(repo, "scripts", "e2e-worktree.mjs"), "--path", wt, "--port", "4398", ...(keep ? ["--keep"] : [])];
  const r = spawnSync(process.execPath, args, {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      STUB_OUT: out,
      STUB_PROBE: JSON.stringify(probe),
      STUB_INSIDE: inside,
      STUB_EXIT: String(exit),
    },
  });
  const seen = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, seen, wt, wtLeft: existsSync(wt) };
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

  it.skipIf(!dirLinks)(`carries an untracked link to a directory as a link${skipNote(dirLinks)}`, () => {
    const f = fixture();
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "inside.txt"), "outside\n");
    mkdirSync(join(f.repo, "work"));
    symlinkSync(outside, join(f.repo, "work", "vd"), "junction");
    const r = run(f, ["work/vd"], "inside.txt");
    expect(r.stderr).not.toMatch(/Error/);
    expect(r.code).toBe(0);
    expect(r.seen.out["work/vd"]).toEqual({ link: true, target: outside, real: outside, content: "outside\n" });
    // Removing the worktree removed the link and left what it pointed at.
    expect(r.wtLeft).toBe(false);
    expect(readFileSync(join(outside, "inside.txt"), "utf8")).toBe("outside\n");
  });

  // Git for Windows lists a junction to an empty directory nowhere in a plain listing, at the top
  // of the tree or inside an untracked directory; the ignored directory beside it has to stay out.
  it.skipIf(!dirLinks)(`carries an untracked link to an empty directory as a link${skipNote(dirLinks)}`, () => {
    const f = fixture();
    const empty = join(f.root, "empty");
    mkdirSync(empty);
    symlinkSync(empty, join(f.repo, "top"), "junction");
    mkdirSync(join(f.repo, "fresh", "deep"), { recursive: true });
    symlinkSync(empty, join(f.repo, "fresh", "deep", "link"), "junction");
    writeFileSync(join(f.repo, "fresh", "note.txt"), "note\n");
    mkdirSync(join(f.repo, "fresh", "node_modules"));
    writeFileSync(join(f.repo, "fresh", "node_modules", "dep.txt"), "dep\n");
    const r = run(f, ["top", "fresh/deep/link", "fresh/note.txt", "fresh/node_modules"]);
    expect(r.stderr).not.toMatch(/Error/);
    expect(r.code).toBe(0);
    const asLink = { link: true, target: empty, real: empty, content: [] };
    expect(r.seen.out["top"]).toEqual(asLink);
    expect(r.seen.out["fresh/deep/link"]).toEqual(asLink);
    expect(r.seen.out["fresh/note.txt"]).toMatchObject({ link: false, content: "note\n" });
    expect(r.seen.out["fresh/node_modules"]).toEqual({ error: "ENOENT" });
    expect(r.wtLeft).toBe(false);
    expect(existsSync(empty)).toBe(true);
  });

  for (const exit of [0, 1]) {
    it.skipIf(!dirLinks)(
      `--keep leaves a carried link in the kept worktree after a run that exits ${exit}${skipNote(dirLinks)}`,
      () => {
        const f = fixture();
        const outside = join(f.root, "outside");
        mkdirSync(outside);
        writeFileSync(join(outside, "inside.txt"), "outside\n");
        mkdirSync(join(f.repo, "work"));
        symlinkSync(outside, join(f.repo, "work", "vd"), "junction");
        const r = run(f, ["work/vd"], "inside.txt", { keep: true, exit });
        expect(r.stderr).not.toMatch(/Error/);
        expect(r.code).toBe(exit);
        expect(r.wtLeft).toBe(true);
        const kept = join(r.wt, "work", "vd");
        expect(lstatSync(kept).isSymbolicLink()).toBe(true);
        expect(readFileSync(join(kept, "inside.txt"), "utf8")).toBe("outside\n");
        // The removal it prints unlinks the carried link before the worktree goes.
        expect(r.stdout).toContain(kept);
      },
    );
  }

  it.skipIf(!fileLinks)(`carries an untracked link to a file as a link, not a copy${skipNote(fileLinks)}`, () => {
    const f = fixture();
    const outside = join(f.root, "outside.txt");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, join(f.repo, "abs.txt"), "file");
    // A relative target resolves against the link's own place, which is inside the worktree.
    symlinkSync("tracked.txt", join(f.repo, "rel.txt"), "file");
    const r = run(f, ["abs.txt", "rel.txt"]);
    expect(r.stderr).not.toMatch(/Error/);
    expect(r.code).toBe(0);
    expect(r.seen.out["abs.txt"]).toEqual({ link: true, target: outside, real: outside, content: "outside\n" });
    expect(r.seen.out["rel.txt"]).toEqual({
      link: true,
      target: "tracked.txt",
      real: join(r.seen.cwd, "tracked.txt"),
      content: "tracked\n",
    });
    expect(r.seen.cwd.startsWith(f.root + sep)).toBe(true);
    expect(r.wtLeft).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });
});
