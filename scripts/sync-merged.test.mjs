// What `scripts/sync-merged.mjs` does after a merge, asked of git rather than read off the code.
//
// Every rule is shown the arrangement it refuses beside the good one it is a mutation of, because
// a tool that removes worktrees and deletes branches is only as good as what it declines to do.
// The fixtures are throwaway repositories with the shape a merged pull request leaves: a feature
// branch pushed, then merged into the default branch with a merge commit, so its tip is reachable
// from the remote and is not on the remote's own first-parent line.
//
// Three things are asked of the PROGRAM rather than of `run()`, since an exit code and an argv
// are what the pnpm script hands its caller and neither is reachable from a function call: the
// bare invocation changes nothing, `--apply` changes what it said it would, and the entry guard
// fires at all. Read as a function, an inverted flag and a deleted guard are both invisible.
//
// The positive controls are what make the refusals mean something — a run that removed nothing
// would satisfy every assertion about what is kept.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { REGENERABLE, decide, holdersOf, run } from "./sync-merged.mjs";

const PROGRAM = resolve(dirname(fileURLToPath(import.meta.url)), "sync-merged.mjs");

const roots = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * A clone whose default branch is one merge behind its origin, with the merged branch still local.
 *
 * `landing` is how the branch reaches the remote's default branch: a merge commit (what a pull
 * request leaves), a fast-forward, or a squash. The three are not interchangeable — only the first
 * leaves a tip that is reachable and off the first-parent line.
 */
function fixture({ landing = "merge", base = "main", ignore = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sync-merged-"));
  roots.push(root);
  const origin = join(root, "origin");
  const down = join(root, "down");
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", base);
  git(origin, "config", "user.email", "t@t");
  git(origin, "config", "user.name", "t");
  writeFileSync(join(origin, "a.txt"), "a\n");
  git(origin, "add", "a.txt");
  if (ignore) {
    writeFileSync(join(origin, ".gitignore"), ignore);
    git(origin, "add", ".gitignore");
  }
  git(origin, "commit", "-qm", "one");

  git(root, "clone", "-q", origin, down);
  git(down, "config", "user.email", "t@t");
  git(down, "config", "user.name", "t");

  git(down, "switch", "-q", "-c", "feat");
  writeFileSync(join(down, "b.txt"), "b\n");
  git(down, "add", "b.txt");
  git(down, "commit", "-qm", "feature");
  git(down, "push", "-q", "origin", "feat");
  git(down, "switch", "-q", base);
  if (landing === "merge") git(origin, "merge", "-q", "--no-ff", "feat", "-m", "Merge pull request #1");
  if (landing === "ff") git(origin, "merge", "-q", "--ff-only", "feat");
  if (landing === "squash") {
    git(origin, "merge", "-q", "--squash", "feat");
    git(origin, "commit", "-qm", "squashed");
  }
  if (landing !== "none") git(origin, "branch", "-D", "feat");
  return { root, origin, down };
}

/** The output lines a run prints, and the exit code it would return. */
function report(cwd, apply = false) {
  const lines = [];
  const code = run(cwd, apply, (l) => lines.push(l));
  return { code, text: lines.join("\n") };
}

/** The program, driven the way the pnpm script drives it. */
function program(cwd, ...args) {
  const r = spawnSync(process.execPath, [PROGRAM, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, text: (r.stdout ?? "") + (r.stderr ?? "") };
}

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where git is, read before any shim is on the PATH. */
const REAL_GIT = (() => {
  const r = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "git";
})();

/** Whether this machine resolves a shim named `git` ahead of the real one, which is what the race
 *  cases rest on. Asked by putting one there, since a spawn on Windows resolves by extension and
 *  a file with none is not a program however executable its bits say it is. */
const gitCanBeShimmed = (() => {
  try {
    const box = mkdtempSync(join(tmpdir(), "sync-merged-shimprobe-"));
    writeFileSync(join(box, "git"), "#!/bin/sh\necho shimmed\n", { mode: 0o755 });
    const r = spawnSync("git", ["--version"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${box}${delimiter}${process.env.PATH}` },
    });
    rmSync(box, { recursive: true, force: true });
    return r.status === 0 && (r.stdout ?? "").includes("shimmed");
  } catch {
    return false;
  }
})();

/**
 * The program, with `git` resolved through a shim that fires ONCE — at the command named by
 * `at`, before delegating to the real git — and runs `action` there.
 *
 * It exists for a window nothing else can construct: the tree the plan read is switched to
 * another branch before the apply writes to it. Wall-clock that window is a fetch over the
 * network; placed by hand it is one command, and the same either way.
 */
function raced(cwd, { at: trigger, action, nth = 1 }, ...args) {
  const box = mkdtempSync(join(tmpdir(), "sync-merged-git-"));
  roots.push(box);
  const mark = join(box, "fired");
  const seen = join(box, "seen");
  const q = JSON.stringify;
  // `nth` because one command is asked twice — the check on either side of the merge reads HEAD
  // the same way — and which of the two the switch lands in is the whole of some cases.
  writeFileSync(
    join(box, "git"),
    `#!/bin/sh\nif [ "$*" = ${q(trigger)} ]; then\n  echo x >> ${q(seen)}\n  if [ "$(wc -l < ${q(seen)})" -eq ${nth} ]; then\n    : > ${q(mark)}\n    ${action}\n  fi\nfi\nexec ${q(REAL_GIT)} "$@"\n`,
    { mode: 0o755 },
  );
  const r = spawnSync(process.execPath, [PROGRAM, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: `${box}${delimiter}${process.env.PATH}` },
  });
  // Asserted by every case: a trigger that matches nothing leaves the run untouched, and every
  // assertion about what it refused would then be satisfied by a run with no race in it.
  return { code: r.status, text: (r.stdout ?? "") + (r.stderr ?? ""), fired: existsSync(mark) };
}

// Spelled from the full refname rather than the short one: `%(refname:short)` renders as
// `heads/feat` where a tag shares the name, which is the very case one of these drives.
const branches = (cwd) =>
  git(cwd, "for-each-ref", "--format=%(refname)", "refs/heads")
    .split("\n")
    .map((r) => r.slice("refs/heads/".length));
const at = (cwd, ref) => git(cwd, "rev-parse", ref);
const trees = (cwd) => git(cwd, "worktree", "list", "--porcelain");

/** A long-lived process of the shape the guard looks for, started in `cwd` and waited for.
 *  Its own file lives outside the repository, or the tree it is meant to be busy in is dirty
 *  instead — which is a different refusal, and would answer for this one. */
async function holder(cwd, name = "vite-stub.mjs") {
  const box = mkdtempSync(join(tmpdir(), "sync-merged-holder-"));
  roots.push(box);
  const stub = join(box, name);
  const started = join(box, `${name}.started`);
  writeFileSync(
    stub,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(started)}, "x");\nsetTimeout(() => {}, 60000);\n`,
  );
  const child = spawn(process.execPath, [stub], { cwd, stdio: "ignore" });
  for (let i = 0; i < 200 && !existsSync(started); i++) await new Promise((r) => setTimeout(r, 25));
  if (!existsSync(started)) throw new Error("the holder process never started");
  return {
    pid: child.pid,
    async stop() {
      child.kill("SIGKILL");
      await new Promise((r) => child.on("exit", r));
      rmSync(stub, { force: true });
      rmSync(started, { force: true });
    },
  };
}

/** Whether this machine can be asked what a process's working directory is — which is what the
 *  guard rests on, and is not the same question as whether the reader is installed. A container
 *  can carry it and still answer nothing, and the cases below would then be measuring the
 *  could-not-be-asked path while claiming to measure the guard. Asked of this process, whose
 *  answer is known. */
const cwdIsReadable = (() => {
  const r = spawnSync("lsof", ["-a", "-d", "cwd", "-F", "pn", "-p", String(process.pid)], { encoding: "utf8" });
  return r.status === 0 && typeof r.stdout === "string" && r.stdout.includes("\nn");
})();

describe("sync-merged, driven as the program", () => {
  it("changes nothing when it is given no flag", () => {
    const { down } = fixture();
    const before = { branches: branches(down).join(), main: at(down, "main"), trees: trees(down) };
    const { code, text } = program(down);
    expect(code).toBe(0);
    expect(text).toContain("remove feat");
    expect(text).toContain("dry run");
    expect({ branches: branches(down).join(), main: at(down, "main"), trees: trees(down) }).toEqual(before);
  });

  it("acts when it is given --apply", () => {
    const { down } = fixture();
    const { code, text } = program(down, "--apply");
    expect(code).toBe(0);
    expect(text).toContain("synced main");
    expect(branches(down)).not.toContain("feat");
    expect(at(down, "main")).toBe(at(down, "origin/main"));
  });

  it("runs its command line at all rather than exiting silently", () => {
    const { down } = fixture();
    const { text } = program(down);
    expect(text.trim()).not.toBe("");
  });
});

describe("sync-merged, when a branch has landed", () => {
  it("removes the branch and its worktree and fast-forwards the default branch", () => {
    const { down } = fixture();
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");

    expect(report(down).text).toMatch(/^would remove feat \+ /m);
    expect(branches(down)).toContain("feat");
    const removed = realpathSync(tree);

    const { code, text } = report(down, true);
    expect(code).toBe(0);
    expect(text).toContain(`removed ${removed}`);
    expect(text).toContain("removed feat");
    expect(branches(down)).not.toContain("feat");
    expect(existsSync(tree)).toBe(false);
    expect(at(down, "main")).toBe(at(down, "origin/main"));
  });

  it("removes one that never had a worktree", () => {
    const { down } = fixture();
    const { code } = report(down, true);
    expect(code).toBe(0);
    expect(branches(down)).not.toContain("feat");
    expect(at(down, "main")).toBe(at(down, "origin/main"));
  });

  it("removes every landed branch, not the first one", () => {
    const { down, origin } = fixture();
    git(down, "switch", "-q", "-c", "second");
    writeFileSync(join(down, "c.txt"), "c\n");
    git(down, "add", "c.txt");
    git(down, "commit", "-qm", "second feature");
    git(down, "push", "-q", "origin", "second");
    git(down, "switch", "-q", "main");
    git(origin, "merge", "-q", "--no-ff", "second", "-m", "Merge pull request #2");
    git(origin, "branch", "-D", "second");
    const t1 = join(down, "..", "wt1");
    const t2 = join(down, "..", "wt2");
    git(down, "worktree", "add", t1, "feat");
    git(down, "worktree", "add", t2, "second");

    expect(report(down, true).code).toBe(0);
    expect(branches(down)).toEqual(["main"]);
    expect(existsSync(t1)).toBe(false);
    expect(existsSync(t2)).toBe(false);
  });

  it("fast-forwards the tree that holds the default branch, not the one the run is in", () => {
    const { down } = fixture();
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    const featAt = at(down, "feat");

    expect(report(tree, true).text).toMatch(/^keep {3}feat.*this session is working in it$/m);
    expect(at(down, "main")).toBe(at(down, "origin/main"));
    expect(at(down, "feat")).toBe(featAt);
  });

  it("deletes a landed branch though the run's own HEAD does not contain it", () => {
    const { down } = fixture();
    git(down, "branch", "side", "HEAD");
    const tree = join(down, "..", "wtside");
    git(down, "worktree", "add", tree, "side");
    const { code } = report(tree, true);
    expect(code).toBe(0);
    expect(branches(down)).not.toContain("feat");
    expect(at(down, "main")).toBe(at(down, "origin/main"));
  });

  it("takes the default branch from origin/HEAD rather than the name main", () => {
    const { down } = fixture({ base: "trunk" });
    const { code, text } = report(down, true);
    expect(code).toBe(0);
    expect(text).toContain("trunk -> origin/trunk");
    expect(at(down, "trunk")).toBe(at(down, "origin/trunk"));
  });

  it("is a no-op once the default branch is already there", () => {
    const { down } = fixture();
    expect(report(down, true).code).toBe(0);
    const { code, text } = report(down, true);
    expect(code).toBe(0);
    expect(text).toContain("is already at origin/main");
    expect(text).not.toContain("synced");
  });

  it("changes nothing without --apply", () => {
    const { down } = fixture();
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    const before = { branches: branches(down).join(), main: at(down, "main"), trees: trees(down) };
    const { code, text } = report(down);
    expect(code).toBe(0);
    expect(text).toContain("(dry run — pass --apply to act)");
    expect({ branches: branches(down).join(), main: at(down, "main"), trees: trees(down) }).toEqual(before);
  });
});

describe("sync-merged, on a branch it must not delete", () => {
  it("keeps one that is not merged", () => {
    const { down } = fixture({ landing: "none" });
    expect(report(down, true).text).toMatch(/^keep {3}feat.*not merged into origin\/main$/m);
    expect(branches(down)).toContain("feat");
  });

  it("keeps one whose commits reached the remote as a squash", () => {
    const { down } = fixture({ landing: "squash" });
    expect(report(down, true).text).toMatch(/^keep {3}feat.*not merged into origin\/main$/m);
    expect(branches(down)).toContain("feat");
  });

  it("keeps one whose tip sits on the remote's first-parent line", () => {
    const { down } = fixture({ landing: "ff" });
    expect(report(down, true).text).toMatch(/^keep {3}feat.*first-parent line/m);
    expect(branches(down)).toContain("feat");
  });

  it("keeps one that merely points at a commit the default branch already had", () => {
    const { down } = fixture();
    git(down, "branch", "stale", "main");
    expect(report(down, true).text).toMatch(/^keep {3}stale.*first-parent line/m);
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
    expect(branches(down)).toContain("feat");
    expect(existsSync(tree)).toBe(true);
  });

  it("removes one whose worktree holds only build output", () => {
    const { down } = fixture({ ignore: "dist/\n/plans\n" });
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    mkdirSync(join(tree, "dist"));
    writeFileSync(join(tree, "dist", "bundle.js"), "// build output\n");
    expect(report(down, true).code).toBe(0);
    expect(branches(down)).not.toContain("feat");
    expect(existsSync(tree)).toBe(false);
  });

  it("keeps one whose worktree holds ignored files that are not build output", () => {
    // The same .gitignore as the case above: what differs is which ignored path is there. A
    // saved plan is ignored and is the operator's only copy, so removing the worktree over it
    // deletes work that no command brings back and that git never held.
    const { down } = fixture({ ignore: "dist/\n/plans\n" });
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    mkdirSync(join(tree, "plans"));
    writeFileSync(join(tree, "plans", "session.json"), '{"saved":true}\n');
    expect(report(down, true).text).toMatch(/^keep {3}feat.*no command here rebuilds: plans\/$/m);
    expect(branches(down)).toContain("feat");
    expect(readFileSync(join(tree, "plans", "session.json"), "utf8")).toBe('{"saved":true}\n');
  });

  it("keeps one whose worktree directory has gone missing", () => {
    const { down } = fixture();
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    rmSync(tree, { recursive: true, force: true });
    expect(report(down, true).text).toMatch(/^keep {3}feat.*could not be read/m);
    expect(branches(down)).toContain("feat");
  });

  it("keeps one whose worktree is locked, with or without a reason", () => {
    const { down } = fixture();
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    git(down, "worktree", "lock", "--reason", "another session is inside", tree);
    // The reason is asserted, not just the word: git refuses to remove a locked worktree by
    // itself, so a run with no lock guard at all keeps the branch too — on the removal failing.
    expect(report(down, true).text).toMatch(/^keep {3}feat.*its worktree is locked — another session is inside$/m);
    expect(branches(down)).toContain("feat");
    expect(existsSync(tree)).toBe(true);
    git(down, "worktree", "unlock", tree);
  });

  it("keeps the worktree the run itself is in", () => {
    const { down } = fixture();
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    expect(report(tree, true).text).toMatch(/^keep {3}feat.*this session is working in it$/m);
    expect(branches(down)).toContain("feat");
    expect(existsSync(tree)).toBe(true);
  });

  it("asks whether the BRANCH landed when a tag of the same name has", () => {
    const { down } = fixture({ landing: "none" });
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    // The tag points at a commit the remote's default branch holds; the branch does not.
    git(down, "tag", "feat", "origin/main");
    expect(report(down, true).text).toMatch(/^keep {3}feat.*not merged into origin\/main$/m);
    expect(branches(down)).toContain("feat");
    expect(existsSync(tree)).toBe(true);
  });

  it("evaluates the worktree guards when a tag carries the branch's name", () => {
    const { down } = fixture();
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    git(down, "tag", "feat", "main");
    writeFileSync(join(tree, "a.txt"), "edited\n");
    expect(report(down, true).text).toMatch(/^keep {3}feat.*uncommitted work$/m);
    expect(branches(down)).toContain("feat");
    expect(existsSync(tree)).toBe(true);
  });

  it("reports a worktree it cannot remove instead of throwing, and leaves the branch", () => {
    const { down } = fixture();
    git(down, "switch", "-q", "feat");
    const tree = join(down, "..", "wtmain");
    git(down, "worktree", "add", tree, "main");
    const { code, text } = report(tree, true);
    expect(code).toBe(1);
    expect(text).toMatch(/^keep {3}feat.*could not be removed/m);
    expect(branches(down)).toContain("feat");
  });
});

describe("sync-merged, when the fast-forward fails at the moment it is applied", () => {
  it("removes no worktree, since the plan read a working tree that has since changed", () => {
    const { down } = fixture();
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    // b.txt is what the merge writes, and an untracked one of its own is what git refuses over.
    // It arrives after the plan would have been read, which is the ordering this is about.
    writeFileSync(join(down, "b.txt"), "mine\n");
    const { code, text } = report(down, true);
    expect(code).toBe(1);
    expect(text).toContain("nothing applied");
    expect(existsSync(tree)).toBe(true);
    expect(branches(down)).toContain("feat");
    expect(readFileSync(join(down, "b.txt"), "utf8")).toBe("mine\n");
  });
});

describe("sync-merged, when there is nothing to fast-forward", () => {
  it("still cleans up, and deletes from the tree that holds the default branch", () => {
    const { down } = fixture();
    // What someone else's `git pull` leaves: the default branch is already where the remote is,
    // and the branch it merged is still sitting here.
    git(down, "fetch", "-q", "origin");
    git(down, "merge", "-q", "--ff-only", "origin/main");
    git(down, "branch", "side", "HEAD");
    const tree = join(down, "..", "wtside");
    git(down, "worktree", "add", tree, "side");
    const { code, text } = report(tree, true);
    expect(code).toBe(0);
    expect(text).toContain("is already at origin/main");
    expect(branches(down)).not.toContain("feat");
  });

  it("refuses when the default branch does not exist here at all", () => {
    const { down } = fixture();
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    git(down, "checkout", "-q", "--detach");
    git(down, "branch", "-D", "main");
    const { code, text } = report(down, true);
    expect(code).toBe(1);
    expect(text).toContain("main does not exist here");
    expect(text).toContain("nothing applied");
    expect(branches(down)).toContain("feat");
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

  it("applies nothing at all while the fast-forward is blocked", () => {
    const { down } = fixture();
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    writeFileSync(join(down, "local.txt"), "local\n");
    git(down, "add", "local.txt");
    git(down, "commit", "-qm", "local only");
    const { code, text } = report(down, true);
    expect(code).toBe(1);
    expect(text).toContain("nothing applied");
    expect(branches(down)).toContain("feat");
    expect(existsSync(tree)).toBe(true);
  });

  it("reports a blocked fast-forward in a dry run too", () => {
    const { down } = fixture();
    writeFileSync(join(down, "local.txt"), "local\n");
    git(down, "add", "local.txt");
    git(down, "commit", "-qm", "local only");
    expect(report(down).code).toBe(1);
  });

  it("leaves an uncommitted edit in place rather than overwriting it", () => {
    const { down } = fixture();
    // The merge adds b.txt, so an uncommitted b.txt is the file the fast-forward would write.
    writeFileSync(join(down, "b.txt"), "mine\n");
    const { code, text } = report(down, true);
    expect(code).toBe(1);
    expect(text).toContain("SYNC BLOCKED");
    expect(at(down, "main")).not.toBe(at(down, "origin/main"));
    expect(readFileSync(join(down, "b.txt"), "utf8")).toBe("mine\n");
  });

  it("refuses with a reason rather than a stack trace when the remote is unreachable", () => {
    const { down, origin } = fixture();
    rmSync(origin, { recursive: true, force: true });
    const { code, text } = report(down, true);
    expect(code).toBe(1);
    expect(text).toMatch(/^REFUSED — /m);
    expect(branches(down)).toContain("feat");
  });
});

describe("sync-merged, the running-process guard", () => {
  it.skipIf(!cwdIsReadable)("refuses when a build or a server is running out of the tree", async () => {
    const { down } = fixture();
    const h = await holder(down);
    try {
      const { code, text } = report(down, true);
      expect(code).toBe(1);
      expect(text).toContain(`pid ${h.pid} runs out of ${realpathSync(down)}`);
      expect(at(down, "main")).not.toBe(at(down, "origin/main"));
    } finally {
      await h.stop();
    }
  });

  it.skipIf(!cwdIsReadable)("refuses when it is running in a subdirectory of the tree", async () => {
    const { down } = fixture();
    const sub = join(down, "src");
    mkdirSync(sub);
    const h = await holder(sub);
    try {
      expect(report(down, true).code).toBe(1);
    } finally {
      await h.stop();
    }
  });

  it.skipIf(!cwdIsReadable)("proceeds when what runs there is a shell rather than a build", async () => {
    const { down } = fixture();
    const h = await holder(down, "shell-stub.mjs");
    try {
      const { code } = report(down, true);
      expect(code).toBe(0);
      expect(at(down, "main")).toBe(at(down, "origin/main"));
    } finally {
      await h.stop();
    }
  });

  it.skipIf(!cwdIsReadable)("proceeds when the build is running in a worktree nested inside the tree", async () => {
    const { down } = fixture();
    const tree = join(down, "nested");
    git(down, "worktree", "add", tree, "feat");
    const h = await holder(tree);
    try {
      const { code, text } = report(down, true);
      expect(text).toMatch(/^keep {3}feat.*run out of its worktree/m);
      expect(code).toBe(0);
      expect(at(down, "main")).toBe(at(down, "origin/main"));
    } finally {
      await h.stop();
    }
  });

  it.skipIf(!cwdIsReadable)("says the question could not be put when the reader itself fails", async () => {
    const { down } = fixture();
    const box = mkdtempSync(join(tmpdir(), "sync-merged-path-"));
    roots.push(box);
    writeFileSync(join(box, "lsof"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    git(down, "worktree", "add", join(down, "..", "wt"), "feat");
    const h = await holder(down);
    const realPath = process.env.PATH;
    try {
      process.env.PATH = `${box}:${realPath}`;
      const { code, text } = report(down, true);
      expect(text).toContain("could not be read — git's refusals are the only guard here");
      expect(text).toContain("in the worktrees below could not be read");
      expect(text).not.toContain(`pid ${h.pid}`);
      expect(code).toBe(0);
    } finally {
      process.env.PATH = realPath;
      await h.stop();
    }
  });

  it("counts a process by the innermost worktree its directory belongs to", () => {
    const outer = { path: "/repo" };
    const inner = { path: "/repo/.claude/worktrees/one" };
    const procs = [{ pid: "1", command: "vite", cwd: "/repo/.claude/worktrees/one/src" }];
    expect(holdersOf("/repo", procs, [outer, inner])).toEqual([]);
    expect(holdersOf(inner.path, procs, [outer, inner])).toHaveLength(1);
  });

  it("goes ahead, saying so, where the machine cannot be asked what is running", () => {
    const facts = { base: "main", remote: "origin/main", local: "a", ahead: "b", fastForward: true, holder: "/repo" };
    expect(decide({ ...facts, running: null })).toMatchObject({ act: true, ff: true, tree: "/repo" });
    expect(decide({ ...facts, running: null }).note).toContain("could not be read");
    expect(decide({ ...facts, running: [] })).toEqual({ act: true, ff: true, tree: "/repo", note: undefined });
    expect(decide({ ...facts, running: [{ pid: "9", command: "vite" }] }).reason).toContain("pid 9");
    expect(decide({ ...facts, running: [], local: "b" })).toMatchObject({ act: true, ff: false });
  });
});

describe("sync-merged, when the tree it is about to write to is switched under it", () => {
  // A merge names a directory. The plan reads which branch that directory is on; the apply acts
  // on whichever one it is on then, and between the two sits a fetch over the network. Both cases
  // place the switch at an exact command, so the window is the one that exists rather than one
  // some timing happened to open.
  const SWITCH = (down) => `${JSON.stringify(REAL_GIT)} -C ${JSON.stringify(down)} switch -q -c ongoing`;
  // The last thing the plan reads before the apply begins to write.
  const LAST_PLAN_READ = "merge-base --is-ancestor refs/heads/main origin/main";

  it.skipIf(!gitCanBeShimmed)("writes nothing when the switch lands before the fast-forward", () => {
    const { down } = fixture();
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    const was = at(down, "main");

    const r = raced(down, { at: LAST_PLAN_READ, action: SWITCH(down) }, "--apply");
    expect(r.fired).toBe(true);
    expect(r.code).toBe(1);
    expect(r.text).toContain("is not where the plan read it");
    expect(r.text).toContain("on refs/heads/ongoing");
    expect(r.text).toContain("nothing applied");
    expect(at(down, "main")).toBe(was);
    expect(at(down, "ongoing")).toBe(was);
    expect(branches(down)).toContain("feat");
    expect(existsSync(tree)).toBe(true);
  });

  it.skipIf(!gitCanBeShimmed)("writes nothing when the tree stays on the branch and moves on", () => {
    // The other half of the same reading, and the one a branch name alone cannot see: nobody
    // switched anything, someone committed. The plan's answer was about a commit that is no
    // longer the tip, so what a fast-forward would do here was never measured.
    const { down } = fixture();
    const was = at(down, "main");
    const commit = `${JSON.stringify(REAL_GIT)} -C ${JSON.stringify(down)} commit -q --allow-empty -m theirs`;

    // Placed one command later than the case above, at the first read of the check itself: a
    // commit arriving before that is one the plan itself sees, and it is refused for not being a
    // fast-forward — a different guard, which would answer for this one.
    const r = raced(down, { at: "symbolic-ref --quiet HEAD", action: commit }, "--apply");
    expect(r.fired).toBe(true);
    expect(r.code).toBe(1);
    expect(r.text).toContain("is not where the plan read it");
    expect(r.text).toContain("on refs/heads/main");
    expect(at(down, "main")).not.toBe(was);
    expect(branches(down)).toContain("feat");
  });

  it.skipIf(!gitCanBeShimmed)("removes nothing when the switch lands inside the fast-forward", () => {
    const { down } = fixture();
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    const was = at(down, "main");

    const r = raced(down, { at: "merge --ff-only origin/main", action: SWITCH(down) }, "--apply");
    expect(r.fired).toBe(true);
    expect(r.code).toBe(1);
    expect(r.text).toContain("did not reach origin/main");
    expect(r.text).toContain("nothing removed");
    expect(r.text).not.toContain("synced main");
    // What the earlier check cannot prevent, measured rather than assumed away: the merge moved
    // the branch that was there. The default branch did not move, and neither did the cleanup.
    expect(at(down, "main")).toBe(was);
    expect(at(down, "ongoing")).toBe(at(down, "origin/main"));
    expect(branches(down)).toContain("feat");
    expect(existsSync(tree)).toBe(true);
  });

  it.skipIf(!gitCanBeShimmed)("removes nothing when the branch is put back where it was", () => {
    // The check after the merge reads a VALUE and not only a name: a tree back on the branch it
    // was on is not a tree at the commit the sync was for, and the deletions rest on the commit.
    const { down } = fixture();
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    const was = at(down, "main");
    const back = `${JSON.stringify(REAL_GIT)} -C ${JSON.stringify(down)} reset -q --hard ${was}`;

    const r = raced(down, { at: "symbolic-ref --quiet HEAD", nth: 2, action: back }, "--apply");
    expect(r.fired).toBe(true);
    expect(r.code).toBe(1);
    expect(r.text).toContain("did not reach origin/main");
    expect(r.text).toContain("on refs/heads/main");
    expect(at(down, "main")).toBe(was);
    expect(branches(down)).toContain("feat");
    expect(existsSync(tree)).toBe(true);
  });

  it.skipIf(!gitCanBeShimmed)("checks the tree even when there is nothing to fast-forward", () => {
    // Both readings sit outside the merge, or a run with no merge to do writes on a plan nobody
    // re-read — which is exactly the run that only cleans up.
    const { down } = fixture();
    git(down, "fetch", "-q", "origin");
    git(down, "merge", "-q", "--ff-only", "origin/main");
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");

    const r = raced(down, { at: LAST_PLAN_READ, action: SWITCH(down) }, "--apply");
    expect(r.fired).toBe(true);
    expect(r.code).toBe(1);
    expect(r.text).toContain("is not where the plan read it");
    expect(branches(down)).toContain("feat");
    expect(existsSync(tree)).toBe(true);
  });

  it.skipIf(!gitCanBeShimmed)("keeps a worktree that has been switched off the branch it is about to lose", () => {
    // The tree being removed, rather than the tree being written to: a session that switched one
    // is working in it, and git removes a clean worktree without asking what branch it is on.
    const { down } = fixture();
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    const elsewhere = `${JSON.stringify(REAL_GIT)} -C ${JSON.stringify(tree)} switch -q -c theirs`;

    const r = raced(down, { at: LAST_PLAN_READ, action: elsewhere }, "--apply");
    expect(r.fired).toBe(true);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/^keep {3}feat.*is no longer on it: it is on refs\/heads\/theirs/m);
    expect(existsSync(tree)).toBe(true);
    expect(branches(down)).toContain("feat");
    // The fast-forward is what makes the deletions legal and it still ran, so the branch is kept
    // by the reading above rather than by the sync having been refused.
    expect(at(down, "main")).toBe(at(down, "origin/main"));
  });

  it.skipIf(!gitCanBeShimmed)("goes through when the shim fires at nothing", () => {
    // The positive control for both: the same PATH, the same delegation, no switch. Without it,
    // a shim that broke every git call would satisfy every assertion above.
    const { down } = fixture();
    const r = raced(down, { at: "no-such-command", action: "true" }, "--apply");
    expect(r.fired).toBe(false);
    expect(r.code).toBe(0);
    expect(r.text).toContain("synced main");
    expect(branches(down)).not.toContain("feat");
    expect(at(down, "main")).toBe(at(down, "origin/main"));
  });
});

describe("sync-merged, the ignored-content split", () => {
  // Every ignore pattern this repository carries is either something a command here writes or
  // something only this machine holds. The module names the first column; this names the second,
  // so a pattern added to .gitignore is red until someone says which it is. That is the guard over
  // the shape the whole rule comes from: /plans holds saved routing plans, and a worktree removal
  // reaches them exactly as it reaches dist/.
  const LOCAL_WORK = [
    "*.local",
    ".claude/*",
    ".claude/skills/*",
    "/plans",
    "/reference",
    "*.p12",
    "*.pfx",
    "*.pem",
    "*.key",
    "*.cer",
    "*.mobileprovision",
    "/.agents",
    "/.codex",
    "/AGENTS.md",
  ];

  const patterns = readFileSync(join(REPO, ".gitignore"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("!"));

  const rebuildable = (pattern) => {
    const path = pattern.replace(/^\//, "").replace(/\/$/, "");
    if (path.startsWith("*.")) return REGENERABLE.extensions.includes(path.slice(1));
    return REGENERABLE.paths.includes(path) || REGENERABLE.names.includes(path.slice(path.lastIndexOf("/") + 1));
  };

  it("reads a .gitignore that has patterns in it", () => {
    // Two emptiness assertions follow, and an unreadable file satisfies both.
    expect(patterns.length).toBeGreaterThan(10);
    expect(patterns).toContain("/plans");
  });

  it("classifies every pattern in .gitignore as one or the other", () => {
    expect(patterns.filter((p) => !rebuildable(p) && !LOCAL_WORK.includes(p))).toEqual([]);
  });

  it("classifies none of them as both", () => {
    expect(LOCAL_WORK.filter(rebuildable)).toEqual([]);
  });
});
