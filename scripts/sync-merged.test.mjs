// What `scripts/sync-merged.mjs` does after a merge, asked of git rather than read off the code.
//
// Every rule is shown the arrangement it refuses beside the good one it is a mutation of, because
// a tool that removes worktrees and deletes branches is only as good as what it declines to do.
// The fixtures are throwaway repositories with the shape a merged pull request leaves: a feature
// branch pushed, then merged into the default branch with a merge commit, so its tip is reachable
// from the remote and is not on the remote's own first-parent line.
//
// The positive control is what makes the refusals mean something — a run that removed nothing
// would satisfy every assertion about what it does not remove.
import { describe, expect, it, afterEach } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run } from "./sync-merged.mjs";

const roots = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A clone whose `main` is one merge behind its origin, with the merged branch still local. */
function fixture({ merge = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sync-merged-"));
  roots.push(root);
  const origin = join(root, "origin");
  const down = join(root, "down");
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  git(origin, "config", "user.email", "t@t");
  git(origin, "config", "user.name", "t");
  writeFileSync(join(origin, "a.txt"), "a\n");
  git(origin, "add", "a.txt");
  git(origin, "commit", "-qm", "one");

  git(root, "clone", "-q", origin, down);
  git(down, "config", "user.email", "t@t");
  git(down, "config", "user.name", "t");

  git(down, "switch", "-q", "-c", "feat");
  writeFileSync(join(down, "b.txt"), "b\n");
  git(down, "add", "b.txt");
  git(down, "commit", "-qm", "feature");
  git(down, "push", "-q", "origin", "feat");
  git(down, "switch", "-q", "main");
  if (merge) {
    git(origin, "merge", "-q", "--no-ff", "feat", "-m", "Merge pull request #1");
    git(origin, "branch", "-D", "feat");
  }
  return { root, origin, down };
}

/** The output lines a run prints, and the exit code it would return. */
function report(cwd, apply = false) {
  const lines = [];
  const code = run(cwd, apply, (l) => lines.push(l));
  return { code, text: lines.join("\n") };
}

const branches = (cwd) => git(cwd, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n");
const at = (cwd, ref) => git(cwd, "rev-parse", ref);

describe("sync-merged, when a branch has landed", () => {
  it("removes the branch and its worktree and fast-forwards the default branch", () => {
    const { down } = fixture();
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");

    expect(report(down).text).toMatch(/^remove feat \+ /m);
    expect(branches(down)).toContain("feat");

    const { code } = report(down, true);
    expect(code).toBe(0);
    expect(branches(down)).not.toContain("feat");
    expect(existsSync(tree)).toBe(false);
    expect(at(down, "main")).toBe(at(down, "origin/main"));
  });

  it("changes nothing without --apply", () => {
    const { down } = fixture();
    const before = at(down, "main");
    const { code, text } = report(down);
    expect(code).toBe(0);
    expect(text).toContain("(dry run — pass --apply to act)");
    expect(branches(down)).toContain("feat");
    expect(at(down, "main")).toBe(before);
  });

  it("is a no-op once the default branch is already there", () => {
    const { down } = fixture();
    report(down, true);
    const { code, text } = report(down, true);
    expect(code).toBe(0);
    expect(text).toContain("is already at origin/main");
  });
});

describe("sync-merged, on a branch it must not delete", () => {
  it("keeps one that is not merged", () => {
    const { down } = fixture({ merge: false });
    expect(report(down, true).text).toMatch(/^keep {3}feat.*not merged into origin\/main$/m);
    expect(branches(down)).toContain("feat");
  });

  it("keeps one that merely points at a commit the default branch already had", () => {
    const { down } = fixture();
    git(down, "branch", "stale", "main");
    expect(report(down, true).text).toMatch(/^keep {3}stale.*no commits of its own/m);
    expect(branches(down)).toContain("stale");
  });

  it("keeps one whose worktree holds an uncommitted edit", () => {
    const { down } = fixture();
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    writeFileSync(join(tree, "a.txt"), "edited\n");
    expect(report(down, true).text).toMatch(/^keep {3}feat.*uncommitted work$/m);
    expect(branches(down)).toContain("feat");
    expect(existsSync(tree)).toBe(true);
  });

  it("keeps one whose worktree holds only an untracked file", () => {
    const { down } = fixture();
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    writeFileSync(join(tree, "capture.mjs"), "// not committed\n");
    expect(report(down, true).text).toMatch(/^keep {3}feat.*uncommitted work$/m);
    expect(existsSync(tree)).toBe(true);
  });

  it("keeps one whose worktree directory has gone missing", () => {
    const { down } = fixture();
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    rmSync(tree, { recursive: true, force: true });
    expect(report(down, true).text).toMatch(/^keep {3}feat.*could not be read/m);
    expect(branches(down)).toContain("feat");
  });

  it("keeps one whose worktree is locked", () => {
    const { down } = fixture();
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    git(down, "worktree", "lock", tree);
    expect(report(down, true).text).toMatch(/^keep {3}feat.*locked/m);
    expect(existsSync(tree)).toBe(true);
    git(down, "worktree", "unlock", tree);
  });

  it("keeps the worktree the run itself is in", () => {
    const { down } = fixture();
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    expect(report(tree, true).text).toMatch(/^keep {3}feat.*this session is working in it$/m);
    expect(existsSync(tree)).toBe(true);
  });
});

describe("sync-merged, when the default branch cannot move", () => {
  it("refuses when it carries commits the remote does not", () => {
    const { down } = fixture();
    writeFileSync(join(down, "local.txt"), "local\n");
    git(down, "add", "local.txt");
    git(down, "commit", "-qm", "local only");
    const { code, text } = report(down, true);
    expect(code).toBe(1);
    expect(text).toContain("not a fast-forward");
  });

  it("refuses when a build or a server is running out of the tree", async () => {
    const { down } = fixture();
    const stub = join(down, "vite-stub.mjs");
    const started = join(down, "started");
    writeFileSync(
      stub,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(started)}, "x");\nsetTimeout(() => {}, 60000);\n`,
    );
    const child = spawn(process.execPath, [stub], { cwd: down, stdio: "ignore" });
    try {
      for (let i = 0; i < 100 && !existsSync(started); i++) await new Promise((r) => setTimeout(r, 50));
      expect(existsSync(started)).toBe(true);
      const { code, text } = report(down, true);
      expect(code).toBe(1);
      expect(text).toContain("SYNC BLOCKED");
      expect(text).toContain(String(child.pid));
      expect(at(down, "main")).not.toBe(at(down, "origin/main"));
    } finally {
      child.kill("SIGKILL");
      await new Promise((r) => child.on("exit", r));
    }
    expect(child.killed).toBe(true);
  });

  it("leaves an uncommitted edit in place rather than overwriting it", () => {
    const { down } = fixture();
    // The merge adds b.txt, so an uncommitted b.txt is the file the fast-forward would write.
    writeFileSync(join(down, "b.txt"), "mine\n");
    const { code, text } = report(down, true);
    expect(code).toBe(1);
    expect(text).toContain("SYNC BLOCKED");
    expect(at(down, "main")).not.toBe(at(down, "origin/main"));
  });
});
