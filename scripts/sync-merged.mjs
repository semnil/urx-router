// Take the local side back to where the remote is, once a pull request has merged:
// remove the worktree that carried the branch, delete the branch, and fast-forward the
// default branch to it.
//
//   pnpm sync:merged            # say what would happen, change nothing
//   pnpm sync:merged --apply    # do it
//
// The three steps are one command because they are one moment. Split apart, the first two
// get done and the third is the one nobody remembers, and a checkout left behind the remote
// is not visibly wrong: every tool that reads the working tree keeps answering, about the
// revision that is there. The comparison scripts under reference/work/ui-capture/ read
// src/style.css that way, and a selector added by the merge is absent rather than different,
// which their output classifies as "no counterpart" — a bucket that is not a defect.
//
// Nothing here decides anything on its own. A branch is finished when its tip is reachable
// from origin/<default> and is NOT on that branch's own first-parent line — a branch created
// from the default and never committed to is reachable too, and deleting it would throw away
// work that has not started rather than work that has landed. A squash merge leaves no such
// tip, so nothing about it is reachable and this leaves it alone.
//
// Every refusal is printed with the reason. The ones that stop a removal are: the worktree
// this process runs in, a locked worktree, and a worktree holding anything uncommitted —
// tracked or untracked. The one that stops the fast-forward is a build or a server running
// out of the tree, since the files would be swapped under it.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";

const APPLY = process.argv.slice(2).includes("--apply");

function git(args, cwd, allowFail = false) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
  if (!allowFail && r.status !== 0) {
    throw new Error(`git ${args.join(" ")}\n${(r.stderr ?? "").trim()}`);
  }
  return { out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim(), status: r.status };
}

/** Every checkout of this repository. The first entry is the main worktree, which is the one
 *  that can hold the default branch; a `locked` line means another session is inside. */
function worktrees(cwd) {
  const list = [];
  let cur = null;
  for (const line of git(["worktree", "list", "--porcelain"], cwd).out.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice("worktree ".length), branch: null, locked: false };
      list.push(cur);
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch refs/heads/".length);
    } else if (line.startsWith("locked")) {
      cur.locked = true;
    }
  }
  return list;
}

/** The commands that hold a tree's content open: a dev server, a build, a test run, the app
 *  itself. A shell sitting in the directory is not one of them — it reads nothing that a
 *  fast-forward would swap. */
const HOLDERS = /(vite|playwright|tauri|cargo|rustc|esbuild|urx-router|e2e-serve|preview)/i;

/** Processes of that shape whose working directory is inside `dir`, own process excluded.
 *  Returns null where the working directory of another process cannot be read, so a caller
 *  can say the question was not asked rather than that the answer was no. */
function holdersIn(dir) {
  if (platform() === "win32") return null;
  const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (typeof ps.stdout !== "string" || ps.status !== 0) return null;
  const candidates = [];
  for (const line of (ps.stdout ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pid, command] = m;
    if (Number(pid) === process.pid || Number(pid) === process.ppid) continue;
    if (HOLDERS.test(command)) candidates.push({ pid, command });
  }
  if (candidates.length === 0) return [];
  const lsof = spawnSync("lsof", ["-a", "-d", "cwd", "-F", "pn", "-p", candidates.map((c) => c.pid).join(",")], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  // A missing lsof leaves stdout unset rather than empty, and an empty answer is what a tree
  // with nothing running in it also produces — so the two are separated before reading it.
  if (typeof lsof.stdout !== "string") return null;
  const cwds = new Map();
  let pid = null;
  for (const line of lsof.stdout.split("\n")) {
    if (line.startsWith("p")) pid = line.slice(1);
    else if (line.startsWith("n") && pid) cwds.set(pid, line.slice(1));
  }
  const inside = (p) => p === dir || p.startsWith(dir.endsWith("/") ? dir : dir + "/");
  return candidates.filter((c) => cwds.has(c.pid) && inside(cwds.get(c.pid)));
}

/** Why a worktree may not be removed, or null when it may. Uncommitted content of any kind
 *  counts, ignored files excluded — and so does a worktree that cannot be asked, since a
 *  directory nobody can look inside is not the same as one that is empty. */
function unclean(path) {
  const r = git(["status", "--porcelain=v1", "--untracked-files=all"], path, true);
  if (r.status !== 0) return "its worktree could not be read — the directory may be gone";
  return r.out === "" ? null : "its worktree holds uncommitted work";
}

export function run(cwd = process.cwd(), apply = APPLY, log = console.log) {
  const trees = worktrees(cwd);
  const here = git(["rev-parse", "--show-toplevel"], cwd).out;

  const head = git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], cwd, true);
  if (head.status !== 0) throw new Error("origin/HEAD names no branch; run `git remote set-head origin -a`");
  const base = head.out.slice("refs/remotes/origin/".length);
  const remote = `origin/${base}`;

  git(["fetch", "--prune", "origin"], cwd);

  const merged = (ref) => git(["merge-base", "--is-ancestor", ref, remote], cwd, true).status === 0;
  const onFirstParent = new Set(git(["rev-list", "--first-parent", remote], cwd).out.split("\n"));

  const removals = [];
  const kept = [];
  for (const line of git(["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"], cwd).out.split(
    "\n",
  )) {
    const [branch, tip] = line.split(" ");
    if (!branch || branch === base) continue;
    const tree = trees.find((w) => w.branch === branch);
    const why = !merged(branch)
      ? `not merged into ${remote}`
      : onFirstParent.has(tip)
        ? `has no commits of its own — an unstarted branch, not a finished one`
        : tree && tree.path === here
          ? "this session is working in it"
          : tree && tree.locked
            ? "its worktree is locked — another session is inside"
            : tree
              ? unclean(tree.path)
              : null;
    if (why) kept.push({ branch, tree, why });
    else removals.push({ branch, tree });
  }

  for (const { branch, tree, why } of kept) log(`keep   ${branch}${tree ? ` (${tree.path})` : ""} — ${why}`);
  for (const { branch, tree } of removals) log(`remove ${branch}${tree ? ` + ${tree.path}` : ""}`);

  const local = git(["rev-parse", base], cwd, true);
  const ahead = git(["rev-parse", remote], cwd).out;
  const holder = trees.find((w) => w.branch === base);
  let sync = null;
  if (local.status !== 0) sync = { skip: `${base} does not exist here` };
  else if (local.out === ahead) sync = { skip: `${base} is already at ${remote}` };
  else if (!merged(base)) sync = { blocked: `${base} has commits ${remote} does not — not a fast-forward` };
  else if (!holder) sync = { blocked: `${base} is checked out in no worktree` };
  else {
    const running = holdersIn(holder.path);
    if (running === null) sync = { blocked: `cannot read what is running in ${holder.path} on this platform` };
    else if (running.length > 0) {
      sync = {
        blocked: running.map((c) => `pid ${c.pid} runs out of ${holder.path}: ${c.command}`).join("\n         "),
      };
    } else sync = { go: holder.path };
  }
  log(
    sync.skip ? `sync   ${sync.skip}` : sync.blocked ? `SYNC BLOCKED — ${sync.blocked}` : `sync   ${base} -> ${remote}`,
  );

  if (!apply) {
    log(removals.length || sync.go ? "\n(dry run — pass --apply to act)" : "\n(nothing to do)");
    return sync.blocked ? 1 : 0;
  }

  for (const { tree } of removals) if (tree) git(["worktree", "remove", tree.path], cwd);

  // The fast-forward comes before the branch deletions, not after them: `git branch -d` asks
  // whether the branch is merged into HEAD, and until the default branch has moved the answer
  // is no for exactly the branches this is about to delete.
  let failed = Boolean(sync.blocked);
  if (sync.go) {
    const ff = git(["merge", "--ff-only", remote], sync.go, true);
    if (ff.status !== 0) {
      log(`SYNC BLOCKED — ${ff.err}`);
      failed = true;
    } else log(`synced ${base} -> ${ahead.slice(0, 7)}`);
  }

  for (const { branch } of removals) {
    const r = git(["branch", "-d", branch], cwd, true);
    if (r.status !== 0) log(`keep   ${branch} — git declined to delete it: ${r.err}`);
  }
  return failed ? 1 : 0;
}

/**
 * Whether this module is the program rather than an import.
 *
 * Compared as REAL paths on both sides. Node resolves the entry module's symlinks before it
 * stamps `import.meta.url`, and leaves `process.argv[1]` exactly as it was typed, so on a
 * path through a link the two are different strings for one file.
 */
function isEntry(url) {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(fileURLToPath(url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isEntry(import.meta.url)) process.exit(run());
