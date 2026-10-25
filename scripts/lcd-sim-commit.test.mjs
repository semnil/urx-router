// The commit vite.config.ts hands the bundled simulator as its APP Version, asked of git in throwaway
// repositories: a work tree of its own answers with its commit, and a directory inside another
// repository is refused — what an unchecked-out submodule is, since git run there answers for the
// repository around it.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lcdSimCommit } from "../vite.config.ts";

let root;
let head;

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "lcd-sim-commit-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@t");
  git(root, "config", "user.name", "t");
  mkdirSync(join(root, "vendor", "urx-lcd-sim"), { recursive: true });
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-qm", "one");
  head = git(root, "rev-parse", "HEAD");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the commit the SIM view's APP Version shows", () => {
  it("is the shortened commit of a work tree of its own", () => {
    const commit = lcdSimCommit(root);
    expect(commit.length).toBeGreaterThanOrEqual(7);
    expect(head.startsWith(commit)).toBe(true);
  });

  it("is refused for a submodule directory that is not checked out", () => {
    expect(() => lcdSimCommit(join(root, "vendor", "urx-lcd-sim"))).toThrow(
      /is not checked out .*git submodule update --init/,
    );
  });
});
