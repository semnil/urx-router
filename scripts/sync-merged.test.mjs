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

/** Where ps is, read before any shim is on the PATH. */
const REAL_PS = (() => {
  const r = spawnSync("sh", ["-c", "command -v ps"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "ps";
})();

/** Where lsof is, read before any shim is on the PATH. */
const REAL_LSOF = (() => {
  const r = spawnSync("sh", ["-c", "command -v lsof"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "lsof";
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
 * The program, with `git` resolved through a shim that fires ONCE — at the command whose
 * arguments BEGIN with `at`, before delegating to the real git — and runs `action` there.
 *
 * A prefix rather than the whole command line, because two of the calls carry object names: the
 * one that brings a worktree to a commit is `read-tree -m -u <old> <new>`, and a case cannot
 * spell what the fixture will generate.
 *
 * It exists for a window nothing else can construct: the tree the plan read is switched to
 * another branch before the apply writes to it. Wall-clock that window is a fetch over the
 * network; placed by hand it is one command, and the same either way.
 */
function raced(cwd, steps, ...args) {
  const box = mkdtempSync(join(tmpdir(), "sync-merged-git-"));
  roots.push(box);
  const q = JSON.stringify;
  const list = Array.isArray(steps) ? steps : [steps];
  // `nth` because one command is asked several times — the sync reads HEAD the same way on either
  // side of each of its two halves — and which of them a switch lands in is the whole of some
  // cases. A LIST because one of them needs two arrivals in two consecutive gaps, and neither
  // stands in for the other.
  const marks = list.map((_, i) => join(box, `fired-${i}`));
  const blocks = list.map(({ at: trigger, action, nth = 1 }, i) => {
    const seen = join(box, `seen-${i}`);
    return `case "$*" in\n  ${q(trigger)}*)\n    echo x >> ${q(seen)}\n    if [ "$(wc -l < ${q(seen)})" -eq ${nth} ]; then\n      : > ${q(marks[i])}\n      ${action}\n    fi\n    ;;\nesac\n`;
  });
  writeFileSync(join(box, "git"), `#!/bin/sh\n${blocks.join("")}exec ${q(REAL_GIT)} "$@"\n`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [PROGRAM, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: `${box}${delimiter}${process.env.PATH}` },
  });
  // Asserted by every case: a trigger that matches nothing leaves the run untouched, and every
  // assertion about what it refused would then be satisfied by a run with no race in it.
  return { code: r.status, text: (r.stdout ?? "") + (r.stderr ?? ""), fired: marks.every((m) => existsSync(m)) };
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
    // The branch moving is half of a sync. The other half is the checkout, so the file the merge
    // brought in has to be ON DISK and the tree has to be clean — a branch moved without it leaves
    // every file the sync touched reading as a local change.
    expect(readFileSync(join(down, "b.txt"), "utf8")).toBe("b\n");
    expect(git(down, "status", "--porcelain=v1")).toBe("");
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

  it("applies nothing when a sync is pending and the run was started somewhere else", () => {
    // A merge writes to a worktree by naming its DIRECTORY, so it is taken in no tree but the one
    // this was started in — leaving the session that could switch it as the one that typed the
    // command. The fast-forward is what makes the deletions legal, so it stops those too.
    const { down } = fixture();
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    const featAt = at(down, "feat");
    const was = at(down, "main");

    const { code, text } = report(tree, true);
    expect(code).toBe(1);
    expect(text).toMatch(/^SYNC BLOCKED — main is checked out in .* and this run was started in /m);
    expect(text).toContain("nothing applied");
    expect(at(down, "main")).toBe(was);
    expect(at(down, "feat")).toBe(featAt);
    expect(existsSync(tree)).toBe(true);
  });

  it("deletes a landed branch though the run's own HEAD does not contain it", () => {
    // Started in a worktree of its own, which the rule above allows because someone else's pull
    // has already fast-forwarded the default branch: with nothing to merge, no tree is written to.
    const { down } = fixture();
    git(down, "fetch", "-q", "origin");
    // Off the merge's first parent, so this run's own HEAD does not contain feat — which is the
    // whole case: a merged-only deletion is answered about the HEAD it is asked from.
    git(down, "branch", "side", "origin/main~1");
    git(down, "merge", "-q", "--ff-only", "origin/main");
    const tree = join(down, "..", "wtside");
    git(down, "worktree", "add", tree, "side");
    // Asserted rather than assumed: the case is void if the run's own HEAD does contain it, and
    // the deletion would then succeed from either tree.
    expect(() => git(tree, "merge-base", "--is-ancestor", "feat", "HEAD")).toThrow();
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
    // b.txt is what the sync writes, and an untracked one of its own is what git refuses over.
    // It arrives after the plan would have been read, which is the ordering this is about.
    const was = at(down, "main");
    writeFileSync(join(down, "b.txt"), "mine\n");
    const { code, text } = report(down, true);
    expect(code).toBe(1);
    expect(text).toContain("nothing applied");
    expect(existsSync(tree)).toBe(true);
    expect(branches(down)).toContain("feat");
    expect(readFileSync(join(down, "b.txt"), "utf8")).toBe("mine\n");
    // The refusal comes from the half that runs SECOND, by which time the branch has been moved.
    // Putting it back is the one write here that undoes another, so it is read back.
    expect(at(down, "main")).toBe(was);
    expect(text).toContain(`main is back at ${was.slice(0, 7)}`);
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
      expect(text).toContain("could not be read in full — git's refusals are the only guard for the rest");
      expect(text).toContain("in the worktrees below could not be read in full");
      expect(text).not.toContain(`pid ${h.pid}`);
      expect(code).toBe(0);
    } finally {
      process.env.PATH = realPath;
      await h.stop();
    }
  });

  it.skipIf(!cwdIsReadable)("keeps the answers that did arrive when the reader refuses one pid", async () => {
    const { down } = fixture();
    const box = mkdtempSync(join(tmpdir(), "sync-merged-path-"));
    roots.push(box);
    // A reader that answers for the pids it found and still exits non-zero — which is what lsof
    // does when one of the pids it was handed has ended since the listing was taken. The pids come
    // from a `ps` snapshot and this repository's own test runs are in the word list, so on a busy
    // machine that is the ordinary case rather than an edge one.
    writeFileSync(join(box, "lsof"), `#!/bin/sh\n${REAL_LSOF} "$@"\nexit 1\n`, { mode: 0o755 });
    const h = await holder(down);
    const realPath = process.env.PATH;
    try {
      process.env.PATH = `${box}:${realPath}`;
      const { code, text } = report(down, true);
      expect(text).toContain(`pid ${h.pid} runs out of ${realpathSync(down)}`);
      expect(code).toBe(1);
      expect(at(down, "main")).not.toBe(at(down, "origin/main"));
    } finally {
      process.env.PATH = realPath;
      await h.stop();
    }
  });

  it.skipIf(!cwdIsReadable)("blocks on the holder it did read while another pid goes unanswered", async () => {
    const { down } = fixture();
    const target = await holder(down);
    // A second process of the same shape, running somewhere else. The reader answers for the
    // target and not for this one — which is what a process this user may not signal looks
    // like — and exits non-zero because one of the pids it was handed went unanswered.
    const elsewhere = mkdtempSync(join(tmpdir(), "sync-merged-bystander-"));
    roots.push(elsewhere);
    const bystander = await holder(elsewhere, "vitest-stub.mjs");
    const box = mkdtempSync(join(tmpdir(), "sync-merged-path-"));
    roots.push(box);
    writeFileSync(
      join(box, "lsof"),
      `#!/bin/sh\n${REAL_LSOF} "$@" | awk -v skip="p${bystander.pid}" '$0==skip {s=1; next} /^p/ {s=0} !s'\nexit 1\n`,
      { mode: 0o755 },
    );
    const realPath = process.env.PATH;
    try {
      process.env.PATH = `${box}:${realPath}`;
      const { code, text } = report(down, true);
      expect(text).toContain(`pid ${target.pid} runs out of ${realpathSync(down)}`);
      expect(code).toBe(1);
      expect(at(down, "main")).not.toBe(at(down, "origin/main"));
    } finally {
      process.env.PATH = realPath;
      await bystander.stop();
      await target.stop();
    }
  });

  it.skipIf(!cwdIsReadable)("blocks on that holder while an unanswered pid has ended", async () => {
    const { down } = fixture();
    const target = await holder(down);
    // A candidate that ENDED between the listing and the read — the ordinary case on a busy
    // machine, staged here by listing a pid that is already gone. The reader exits non-zero
    // for it and answers for the target, whose own answer is what decides.
    const gone = await holder(mkdtempSync(join(tmpdir(), "sync-merged-gone-")), "vitest-stub.mjs");
    const gonePid = gone.pid;
    await gone.stop();
    const box = mkdtempSync(join(tmpdir(), "sync-merged-path-"));
    roots.push(box);
    writeFileSync(join(box, "ps"), `#!/bin/sh\n${REAL_PS} "$@"\necho "  ${gonePid} node /tmp/vitest-stub.mjs"\n`, {
      mode: 0o755,
    });
    const realPath = process.env.PATH;
    try {
      process.env.PATH = `${box}:${realPath}`;
      const { code, text } = report(down, true);
      expect(text).toContain(`pid ${target.pid} runs out of ${realpathSync(down)}`);
      expect(text).not.toContain(`pid ${gonePid}`);
      expect(code).toBe(1);
    } finally {
      process.env.PATH = realPath;
      await target.stop();
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
    const facts = {
      base: "main",
      remote: "origin/main",
      local: "a",
      ahead: "b",
      fastForward: true,
      holder: "/repo",
      startedIn: "/repo",
    };
    expect(decide({ ...facts, running: [], incomplete: true })).toMatchObject({ act: true, ff: true, tree: "/repo" });
    expect(decide({ ...facts, running: [], incomplete: true }).note).toContain("could not be read in full");
    // A holder that WAS read blocks whether or not the rest of the reading arrived — the two
    // are separate answers, and an unanswered pid elsewhere does not unsay this one.
    expect(decide({ ...facts, running: [{ pid: "9", command: "vite" }], incomplete: true }).reason).toContain("pid 9");
    expect(decide({ ...facts, running: [] })).toEqual({ act: true, ff: true, tree: "/repo", note: undefined });
    expect(decide({ ...facts, running: [{ pid: "9", command: "vite" }] }).reason).toContain("pid 9");
    expect(decide({ ...facts, running: [], local: "b" })).toMatchObject({ act: true, ff: false });
  });

  it("takes the fast-forward in no tree but the one the run was started in", () => {
    const facts = { base: "main", remote: "origin/main", ahead: "b", fastForward: true, holder: "/repo", running: [] };
    // Nothing to merge, so no tree is written to and where the run was started does not matter.
    expect(decide({ ...facts, local: "b", startedIn: "/repo/wt" })).toMatchObject({ act: true, ff: false });
    expect(decide({ ...facts, local: "a", startedIn: "/repo" })).toMatchObject({ act: true, ff: true });
    expect(decide({ ...facts, local: "a", startedIn: "/repo/wt" }).reason).toContain("started in /repo/wt");
  });
});

describe("sync-merged, when a second session changes something after the plan was read", () => {
  // A merge names a directory. The plan reads which branch that directory is on; the apply acts
  // on whichever one it is on then, and between the two sits a fetch over the network. Both cases
  // place the switch at an exact command, so the window is the one that exists rather than one
  // some timing happened to open.
  const SWITCH = (down) => `${JSON.stringify(REAL_GIT)} -C ${JSON.stringify(down)} switch -q -c ongoing`;
  // The last thing the plan reads before the apply begins to write.
  const LAST_PLAN_READ = "merge-base --is-ancestor refs/heads/main origin/main";
  // The reading the fast-forward is guarded by, taken once on each side of the merge.
  const HEAD_READ = "rev-parse HEAD --symbolic-full-name HEAD";

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
    const r = raced(down, { at: HEAD_READ, action: commit }, "--apply");
    expect(r.fired).toBe(true);
    expect(r.code).toBe(1);
    expect(r.text).toContain("is not where the plan read it");
    expect(r.text).toContain("on refs/heads/main");
    expect(at(down, "main")).not.toBe(was);
    expect(branches(down)).toContain("feat");
  });

  it.skipIf(!gitCanBeShimmed)("moves no other branch when the switch lands inside the sync", () => {
    const { down } = fixture();
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    const was = at(down, "main");

    // An EXISTING branch at a commit of its own, so that a run which moved it would be visible.
    // Under a `merge --ff-only` this is the branch that was fast-forwarded instead of the default
    // one, which is the whole reason the merge is not used.
    git(down, "branch", "ongoing", was);
    const onto = `${JSON.stringify(REAL_GIT)} -C ${JSON.stringify(down)} switch -q ongoing`;

    const r = raced(down, { at: "read-tree -m -u", action: onto }, "--apply");
    expect(r.fired).toBe(true);
    expect(r.code).toBe(1);
    expect(r.text).toContain("nothing removed");
    // The swap named the branch, so the sync landed on the one it was for and on no other.
    expect(at(down, "main")).toBe(at(down, "origin/main"));
    expect(at(down, "ongoing")).toBe(was);
    // A ref that did not move is half of it. The index is the other half: what read-tree wrote is
    // staged on whatever branch is there, and that session's next commit would carry it. Read
    // back rather than reasoned about — a clean tree with the sync's file absent from it.
    expect(git(down, "status", "--porcelain=v1")).toBe("");
    expect(existsSync(join(down, "b.txt"))).toBe(false);
    expect(r.text).toContain("back to what that branch holds");
    expect(r.text).toContain("run again from the tree that holds it");
    expect(branches(down)).toContain("feat");
    expect(existsSync(tree)).toBe(true);
  });

  it.skipIf(!gitCanBeShimmed)("says what it holds when the switched-to tree cannot be put back", () => {
    // The remainder: a switch AND an edit of their own, both inside the same gap. The index then
    // holds this sync's changes and cannot be taken back without discarding their edit, so it is
    // left and named — the one outcome here a reader has to act on.
    const { down } = fixture();
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    const was = at(down, "main");
    git(down, "branch", "ongoing", was);
    // TWO arrivals in two consecutive gaps, which is what it takes: a switch before the index
    // update, so the tree this run writes to is theirs, and then an edit to the very file the
    // sync brought in, before the run gets to read HEAD back. A switch alone is taken back, and
    // one arriving AFTER the index update is taken back by git's own checkout.
    const onto = `${JSON.stringify(REAL_GIT)} -C ${JSON.stringify(down)} switch -q ongoing`;
    const edit = `printf 'theirs\\n' > ${JSON.stringify(join(down, "b.txt"))}`;

    const r = raced(
      down,
      [
        { at: "read-tree -m -u", action: onto },
        { at: HEAD_READ, nth: 3, action: edit },
      ],
      "--apply",
    );
    expect(r.fired).toBe(true);
    expect(r.code).toBe(1);
    expect(r.text).toContain("STILL HOLDS WHAT THIS SYNC WROTE: b.txt");
    expect(r.text).toContain("run again from the tree that holds it");
    expect(at(down, "main")).toBe(at(down, "origin/main"));
    expect(at(down, "ongoing")).toBe(was);
    // What they typed is still there. It is named rather than deleted, since nothing here can
    // tell a file they wrote over ours from work of their own.
    expect(readFileSync(join(down, "b.txt"), "utf8")).toBe("theirs\n");
    expect(branches(down)).toContain("feat");
    expect(existsSync(tree)).toBe(true);
  });

  it.skipIf(!gitCanBeShimmed)("says so when the sync's version is left in the index alone", () => {
    // The working file put back by hand while the index still carries the sync's version: the
    // next commit on that branch takes it. `git diff HEAD` is empty there and `git status` says
    // MM, so the two are asked separately.
    const { down, origin } = fixture();
    // The landed branch only ADDS a file; a path has to be MODIFIED for there to be an earlier
    // version to put back by hand, so the remote moves one too.
    writeFileSync(join(origin, "a.txt"), "a2\n");
    git(origin, "commit", "-qam", "three");
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    const was = at(down, "main");
    git(down, "branch", "ongoing", was);
    const onto = `${JSON.stringify(REAL_GIT)} -C ${JSON.stringify(down)} switch -q ongoing`;
    const byHand = `printf 'a\\n' > ${JSON.stringify(join(down, "a.txt"))}`;

    const r = raced(
      down,
      [
        { at: "read-tree -m -u", action: onto },
        { at: HEAD_READ, nth: 3, action: byHand },
      ],
      "--apply",
    );
    expect(r.fired).toBe(true);
    expect(r.code).toBe(1);
    expect(r.text).toContain("STILL HOLDS WHAT THIS SYNC WROTE: a.txt");
    expect(r.text).toContain("run again from the tree that holds it");
    // What they put back is what the file holds, and the index is what the report is about.
    expect(readFileSync(join(down, "a.txt"), "utf8")).toBe("a\n");
    expect(git(down, "status", "--porcelain=v1")).toContain("MM a.txt");
    expect(at(down, "main")).toBe(at(down, "origin/main"));
    expect(at(down, "ongoing")).toBe(was);
    expect(branches(down)).toContain("feat");
    expect(existsSync(tree)).toBe(true);
  });

  it.skipIf(!gitCanBeShimmed)("leaves the working file alone when the index has been taken off it", () => {
    // The other side of the same reading. That session unstaged the path, so the index is back at
    // their HEAD while the working file still holds what the sync wrote. Restoring would write
    // over a file whose index they have just decided about, so it is named instead.
    const { down, origin } = fixture();
    writeFileSync(join(origin, "a.txt"), "a2\n");
    git(origin, "commit", "-qam", "three");
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    const was = at(down, "main");
    git(down, "branch", "ongoing", was);
    const onto = `${JSON.stringify(REAL_GIT)} -C ${JSON.stringify(down)} switch -q ongoing`;
    const unstage = `${JSON.stringify(REAL_GIT)} -C ${JSON.stringify(down)} restore --staged a.txt`;

    const r = raced(
      down,
      [
        { at: "read-tree -m -u", action: onto },
        { at: HEAD_READ, nth: 3, action: unstage },
      ],
      "--apply",
    );
    expect(r.fired).toBe(true);
    expect(r.code).toBe(1);
    expect(r.text).toContain("STILL HOLDS WHAT THIS SYNC WROTE: a.txt");
    // Their working file is left exactly as it was found, holding the sync's version.
    expect(readFileSync(join(down, "a.txt"), "utf8")).toBe("a2\n");
    expect(at(down, "main")).toBe(at(down, "origin/main"));
    expect(at(down, "ongoing")).toBe(was);
    expect(branches(down)).toContain("feat");
    expect(existsSync(tree)).toBe(true);
  });

  it.skipIf(!gitCanBeShimmed)("leaves a branch that already holds the file the sync brings in", () => {
    // The switched-to branch has committed the same path — what a branch that has already merged
    // the default one looks like. Putting the tree back to the branch's OLD tip deletes that file
    // and stages the deletion, so the put-back reads the tree's own HEAD instead.
    const { down } = fixture();
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    const was = at(down, "main");
    git(down, "switch", "-q", "-c", "ongoing");
    writeFileSync(join(down, "b.txt"), "b\n");
    git(down, "add", "b.txt");
    git(down, "commit", "-qm", "theirs");
    git(down, "switch", "-q", "main");
    const theirs = at(down, "ongoing");
    const onto = `${JSON.stringify(REAL_GIT)} -C ${JSON.stringify(down)} switch -q ongoing`;

    const r = raced(down, { at: "read-tree -m -u", action: onto }, "--apply");
    expect(r.fired).toBe(true);
    expect(r.code).toBe(1);
    expect(r.text).toContain("back to what that branch holds");
    expect(at(down, "main")).toBe(at(down, "origin/main"));
    expect(at(down, "ongoing")).toBe(theirs);
    // Their file survives, and nothing of the sync is staged on their branch.
    expect(readFileSync(join(down, "b.txt"), "utf8")).toBe("b\n");
    expect(git(down, "status", "--porcelain=v1")).toBe("");
    expect(branches(down)).toContain("feat");
    expect(existsSync(tree)).toBe(true);
    expect(was).not.toBe(at(down, "main"));
  });

  it.skipIf(!gitCanBeShimmed)("leaves a branch holding its own version of that file", () => {
    // The same path with content of its own, which git will not let a session switch onto until
    // the files have been written — so this one arrives just after them, where git's own checkout
    // has already restored the branch's content and the put-back has nothing to do.
    const { down } = fixture();
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    git(down, "switch", "-q", "-c", "ongoing");
    writeFileSync(join(down, "b.txt"), "mine\n");
    git(down, "add", "b.txt");
    git(down, "commit", "-qm", "theirs");
    git(down, "switch", "-q", "main");
    const theirs = at(down, "ongoing");
    const onto = `${JSON.stringify(REAL_GIT)} -C ${JSON.stringify(down)} switch -q ongoing`;

    const r = raced(down, { at: HEAD_READ, nth: 3, action: onto }, "--apply");
    expect(r.fired).toBe(true);
    expect(r.code).toBe(1);
    expect(r.text).toContain("back to what that branch holds");
    expect(at(down, "main")).toBe(at(down, "origin/main"));
    expect(at(down, "ongoing")).toBe(theirs);
    expect(readFileSync(join(down, "b.txt"), "utf8")).toBe("mine\n");
    expect(git(down, "status", "--porcelain=v1")).toBe("");
    expect(branches(down)).toContain("feat");
    expect(existsSync(tree)).toBe(true);
  });

  it.skipIf(!gitCanBeShimmed)("moves the branch only if it is still where the plan read it", () => {
    // Inside the swap itself, which is the last place a commit can arrive. The swap carries the
    // value the plan read, so it declines rather than discarding what landed in between; without
    // that value it would take the branch off their commit and say it had synced.
    const { down } = fixture();
    const commit = `${JSON.stringify(REAL_GIT)} -C ${JSON.stringify(down)} commit -q --allow-empty -m theirs`;

    const r = raced(down, { at: "update-ref -m", action: commit }, "--apply");
    expect(r.fired).toBe(true);
    expect(r.code).toBe(1);
    expect(r.text).toContain("main could not be moved");
    expect(r.text).toContain("nothing applied");
    expect(at(down, "main")).not.toBe(at(down, "origin/main"));
    expect(git(down, "log", "-1", "--format=%s")).toBe("theirs");
    expect(branches(down)).toContain("feat");
  });

  it.skipIf(!gitCanBeShimmed)("finishes the sync and stops when the tree leaves the branch mid-way", () => {
    // Between the swap and the tree being brought in line. The branch is checked out nowhere by
    // then, so there is nothing to bring in line and the sync is simply finished — what does not
    // happen is the cleanup, which rests on a HEAD that holds the branch.
    const { down } = fixture();
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");

    const r = raced(down, { at: HEAD_READ, nth: 2, action: SWITCH(down) }, "--apply");
    expect(r.fired).toBe(true);
    expect(r.code).toBe(1);
    expect(r.text).toContain("synced main");
    expect(r.text).toContain("left main while it was being synced");
    expect(r.text).toContain("nothing removed");
    expect(at(down, "main")).toBe(at(down, "origin/main"));
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

    const r = raced(down, { at: HEAD_READ, nth: 2, action: back }, "--apply");
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
    expect(r.text).toMatch(/^keep {3}feat.*its worktree is on theirs now$/m);
    expect(existsSync(tree)).toBe(true);
    expect(branches(down)).toContain("feat");
    // The fast-forward is what makes the deletions legal and it still ran, so the branch is kept
    // by the reading above rather than by the sync having been refused.
    expect(at(down, "main")).toBe(at(down, "origin/main"));
  });

  it.skipIf(!gitCanBeShimmed)("keeps one whose worktree is given a saved plan after the plan was read", () => {
    // The reason the removal rule is asked twice. A file that was there when the plan ran keeps
    // the worktree; one saved a moment later has to keep it for the same reason, or the rule only
    // covers a session that was already finished when this started.
    const { down } = fixture({ ignore: "dist/\n/plans\n" });
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    const dir = join(tree, "plans");
    const file = join(dir, "session.json");
    const save = `mkdir -p ${JSON.stringify(dir)}; printf '{"saved":true}\\n' > ${JSON.stringify(file)}`;

    const r = raced(down, { at: LAST_PLAN_READ, action: save }, "--apply");
    expect(r.fired).toBe(true);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/^keep {3}feat.*no command here rebuilds: plans\/$/m);
    expect(existsSync(tree)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe('{"saved":true}\n');
    expect(branches(down)).toContain("feat");
    // The fast-forward still ran, so the branch is kept by the reading rather than by the sync
    // having been refused ahead of it.
    expect(at(down, "main")).toBe(at(down, "origin/main"));
  });

  it.skipIf(!gitCanBeShimmed)("keeps one that gains a commit after the plan was read", () => {
    // The same second reading, over the branch rather than the worktree: what the plan measured
    // as landed is a commit that is no longer its tip.
    const { down } = fixture();
    const tree = join(down, "..", "wt");
    git(down, "worktree", "add", tree, "feat");
    const commit = `${JSON.stringify(REAL_GIT)} -C ${JSON.stringify(tree)} commit -q --allow-empty -m theirs`;

    const r = raced(down, { at: LAST_PLAN_READ, action: commit }, "--apply");
    expect(r.fired).toBe(true);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/^keep {3}feat.*not merged into origin\/main$/m);
    expect(existsSync(tree)).toBe(true);
    expect(branches(down)).toContain("feat");
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
