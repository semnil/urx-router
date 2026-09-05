// Take the local side back to the remote once a pull request has merged: remove the worktree
// that carried the branch, delete the branch, and fast-forward the default branch to origin.
//
//   pnpm sync:merged            # fetch, then report what would happen
//   pnpm sync:merged --apply    # do it
//
// The three steps are one command because they are one moment. Split apart, the first two get
// done and the third is the one nobody remembers, and a checkout left behind the remote goes on
// answering about the revision it holds: a script comparing the design-system artifact against
// src/style.css sees a selector the merge added as absent rather than as different, and absent
// is the bucket its output calls a specimen-only class.
//
// A branch has landed when its tip is reachable from origin/<default>. That leaves two shapes
// this cannot tell apart, and both are kept rather than guessed at: a branch created from the
// default and never committed to, and one that landed by fast-forward — the tip of each sits on
// the remote's own first-parent line. A squash merge leaves no reachable tip at all, so nothing
// about it is landed here either.
//
// WHAT IT REFUSES. Removing a worktree: the one this run is in, a locked one, one holding
// anything uncommitted, one that cannot be read, and one with a build or a server running out of
// it. Fast-forwarding: a default branch carrying commits the remote does not, one checked out
// nowhere, and the same running-process rule over the tree that holds it. **A blocked
// fast-forward stops the whole apply** — the deletions are what the fast-forward makes legal, so
// running them without it deletes worktrees and then leaves every branch behind.
//
// The dry run FETCHES. It has to: every answer above is about the remote, and reporting them off
// a stale one would be reporting about a different repository. Nothing else is touched — no
// branch, no worktree, no working tree, no HEAD.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";

function git(args, cwd, allowFail = false) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
  const out = typeof r.stdout === "string" ? r.stdout.replace(/\r/g, "") : "";
  const err = (typeof r.stderr === "string" ? r.stderr : (r.error?.message ?? "")).replace(/\r/g, "").trim();
  if (!allowFail && r.status !== 0) throw new Error(`git ${args.join(" ")}\n${err}`);
  return { out: out.replace(/\n+$/, ""), err, status: r.status };
}

/** Every checkout of this repository. Read NUL-separated, since a path may hold a newline and
 *  the line-oriented form gives no way to tell that from the next record. */
function worktrees(cwd) {
  const list = [];
  let cur = null;
  for (const rec of git(["worktree", "list", "--porcelain", "-z"], cwd).out.split("\0")) {
    if (rec.startsWith("worktree ")) {
      cur = { path: rec.slice("worktree ".length), branch: null, locked: false };
      list.push(cur);
    } else if (rec.startsWith("branch refs/heads/")) {
      cur.branch = rec.slice("branch refs/heads/".length);
    } else if (rec === "locked" || rec.startsWith("locked ")) {
      // A lock may carry a reason, which git writes on the same record.
      cur.locked = true;
    }
  }
  return list;
}

/** The commands that hold a tree's content open: a dev server, a build, a test run. Matched on
 *  whole words so that a path merely containing one of them is not a process running it — this
 *  repository's own checkout path is under a directory named for the product, and a scratchpad
 *  path carries it too, so a shell was answering as a build. */
const HOLDERS = /(^|[/\s])(vite|vitest|playwright|tauri|cargo|rustc|esbuild|e2e-serve)([\s/.\-]|$)/i;

/** Each process's working directory, or null where they cannot be read. */
function workingDirs() {
  if (platform() === "win32") return null;
  const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (typeof ps.stdout !== "string" || ps.status !== 0) return null;
  const candidates = [];
  for (const line of ps.stdout.split("\n")) {
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
  // A missing lsof leaves stdout unset rather than empty, and empty is also what a machine with
  // nothing running produces — so the two are separated before the output is read.
  if (typeof lsof.stdout !== "string") return null;
  const cwds = new Map();
  let pid = null;
  for (const line of lsof.stdout.split("\n")) {
    if (line.startsWith("p")) pid = line.slice(1);
    else if (line.startsWith("n") && pid) cwds.set(pid, line.slice(1));
  }
  return candidates.filter((c) => cwds.has(c.pid)).map((c) => ({ ...c, cwd: cwds.get(c.pid) }));
}

const under = (path, dir) => path === dir || path.startsWith(dir.endsWith("/") ? dir : dir + "/");

/**
 * Which of `procs` are running out of `dir` — the worktree they are in being `dir` itself rather
 * than one nested inside it. This repository keeps its worktrees under the main checkout, so a
 * plain prefix reads every process in every worktree as one in the main checkout.
 */
export function holdersOf(dir, procs, trees) {
  if (procs === null) return null;
  const owner = (p) =>
    trees
      .map((t) => t.path)
      .filter((t) => under(p, t))
      .sort((a, b) => b.length - a.length)[0];
  return procs.filter((c) => owner(c.cwd) === dir);
}

/** Why a worktree may not be removed, or null when it may. Uncommitted content of any kind
 *  counts, ignored files excluded — and so does a worktree that cannot be asked, since a
 *  directory nobody can look inside is not the same as one that is empty. */
function unclean(path) {
  const r = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], path, true);
  if (r.status !== 0) return "its worktree could not be read — the directory may be gone";
  return r.out === "" ? null : "its worktree holds uncommitted work";
}

/**
 * What to do about the default branch, from facts alone.
 *
 * `running` is the list of processes running out of the tree that holds it, or null where the
 * question could not be put to the machine — on which the step goes ahead, saying so, since
 * git's own refusals still stand between it and anything uncommitted.
 */
export function decide({ base, remote, local, ahead, fastForward, holder, running }) {
  if (local === null) return { skip: `${base} does not exist here` };
  if (local === ahead) return { skip: `${base} is already at ${remote}` };
  if (!fastForward) return { blocked: `${base} has commits ${remote} does not — not a fast-forward` };
  if (!holder) return { blocked: `${base} is checked out in no worktree` };
  if (running === null)
    return { go: holder, note: `what runs in ${holder} could not be read — git's refusals are the only guard here` };
  if (running.length > 0)
    return { blocked: running.map((c) => `pid ${c.pid} runs out of ${holder}: ${c.command}`).join("\n         ") };
  return { go: holder };
}

function plan(cwd, log) {
  const here = git(["rev-parse", "--show-toplevel"], cwd).out;
  const head = git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], cwd, true);
  if (head.status !== 0) throw new Error("origin/HEAD names no branch — run `git remote set-head origin -a`");
  const base = head.out.slice("refs/remotes/origin/".length);
  const remote = `origin/${base}`;

  git(["fetch", "--prune", "origin"], cwd);

  const tip = (ref) => {
    const r = git(["rev-parse", "--verify", "--quiet", ref], cwd, true);
    return r.status === 0 && r.out !== "" ? r.out : null;
  };
  const ahead = tip(`refs/remotes/${remote}`);
  if (ahead === null) throw new Error(`${remote} does not exist — the remote's default branch may have been renamed`);

  const trees = worktrees(cwd);
  const procs = workingDirs();
  const landed = (ref) => git(["merge-base", "--is-ancestor", ref, remote], cwd, true).status === 0;
  const onFirstParent = new Set(git(["rev-list", "--first-parent", remote], cwd).out.split("\n"));

  const removals = [];
  const kept = [];
  for (const rec of git(["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads"], cwd).out.split("\n")) {
    const [ref, at] = rec.split("\0");
    if (!ref) continue;
    const branch = ref.slice("refs/heads/".length);
    if (branch === base) continue;
    const tree = trees.find((w) => w.branch === branch);
    const busy = tree && holdersOf(tree.path, procs, trees);
    const why = !landed(branch)
      ? `not merged into ${remote}`
      : onFirstParent.has(at)
        ? "its tip is on the remote's own first-parent line — an unstarted branch, or one that landed by fast-forward, and this cannot tell the two apart"
        : tree && tree.path === here
          ? "this session is working in it"
          : tree && tree.locked
            ? "its worktree is locked — another session is inside"
            : tree
              ? (unclean(tree.path) ??
                (busy && busy.length > 0
                  ? `${busy.length} process(es) run out of its worktree: pid ${busy[0].pid}`
                  : null))
              : null;
    if (why) kept.push({ branch, tree, why });
    else removals.push({ branch, tree });
  }

  const local = tip(`refs/heads/${base}`);
  const holder = trees.find((w) => w.branch === base);
  const sync = decide({
    base,
    remote,
    local,
    ahead,
    fastForward: local !== null && landed(base),
    holder: holder?.path ?? null,
    running: holder ? holdersOf(holder.path, procs, trees) : [],
  });

  for (const { branch, tree, why } of kept) log(`keep   ${branch}${tree ? ` (${tree.path})` : ""} — ${why}`);
  for (const { branch, tree } of removals) log(`remove ${branch}${tree ? ` + ${tree.path}` : ""}`);
  log(
    sync.skip ? `sync   ${sync.skip}` : sync.blocked ? `SYNC BLOCKED — ${sync.blocked}` : `sync   ${base} -> ${remote}`,
  );
  if (sync.note) log(`note   ${sync.note}`);
  return { removals, sync, remote, base, ahead };
}

export function run(cwd = process.cwd(), apply = false, log = console.log) {
  let p;
  try {
    p = plan(cwd, log);
  } catch (e) {
    log(`REFUSED — ${e.message}`);
    return 1;
  }
  const { removals, sync, remote, base, ahead } = p;

  if (!apply) {
    log(removals.length || sync.go ? "\n(dry run — pass --apply to act)" : "\n(nothing to apply)");
    return sync.blocked ? 1 : 0;
  }
  if (sync.blocked) {
    log("\nnothing applied — the fast-forward is what makes the deletions legal");
    return 1;
  }

  let failed = false;
  for (const { branch, tree } of removals) {
    if (!tree) continue;
    const r = git(["worktree", "remove", tree.path], cwd, true);
    if (r.status !== 0) {
      log(`keep   ${branch} — its worktree could not be removed: ${r.err}`);
      failed = true;
    }
  }

  // The fast-forward comes before the branch deletions: git is asked whether a branch is merged
  // into HEAD, and until the default branch has moved the answer is no for exactly these.
  if (sync.go) {
    const ff = git(["merge", "--ff-only", remote], sync.go, true);
    if (ff.status !== 0) {
      log(`SYNC BLOCKED — ${ff.err}`);
      return 1;
    }
    log(`synced ${base} -> ${ahead.slice(0, 7)}`);
  }

  // Deleted from the tree that holds the default branch rather than from the one this run was
  // started in: `-d` asks whether the branch is merged into the HEAD it is asked from, and a run
  // started in some other branch's worktree would be answered about that branch instead. `-d`
  // rather than `-D` because it is a second opinion on the ancestry read above; no legitimate
  // state reaches its refusal once that read is right, so nothing here pins it.
  const deleteFrom = sync.go ?? cwd;
  for (const { branch, tree } of removals) {
    if (tree && git(["worktree", "list", "--porcelain", "-z"], cwd).out.includes(`worktree ${tree.path}\0`)) continue;
    const r = git(["branch", "-d", branch], deleteFrom, true);
    if (r.status !== 0) {
      log(`keep   ${branch} — git declined to delete it: ${r.err}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

/**
 * Whether this module is the program rather than an import.
 *
 * Compared as REAL paths on both sides. Node resolves the entry module's symlinks before it
 * stamps `import.meta.url`, and leaves `process.argv[1]` exactly as it was typed, so on a path
 * through a link the two are different strings for one file.
 */
function isEntry(url) {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(fileURLToPath(url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isEntry(import.meta.url)) process.exit(run(process.cwd(), process.argv.slice(2).includes("--apply")));
