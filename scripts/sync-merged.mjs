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
// WHAT IT REFUSES. Removing a worktree: the one this run is in, a locked one, one holding tracked
// or untracked changes, one that cannot be read, one carrying ignored content that no command here
// rebuilds, one with a build or a server running out of it, and one that has been switched off the
// branch it is about to lose. Fast-forwarding: a default branch that does not exist here, one
// checked out nowhere, one carrying commits the remote does not, one whose tree is not where the
// plan read it, and the same running-process rule over the tree that holds it.
//
// **Any of those stops the whole apply, and the fast-forward runs first.** The deletions are what
// it makes legal, so running them without it removes worktrees and then leaves every branch
// behind — which is also why the fast-forward is not placed behind them, where its own failure
// (a working tree that changed since the plan was read) would leave exactly that.
//
// Two of the three writes re-read what the plan read, immediately before making it: a merge and a
// removal name a DIRECTORY, and act on whichever branch that directory is on when they run.
// Between the plan reading one and the apply writing to it sits a fetch over the network, so a
// session that switches a tree in that window would have its own branch fast-forwarded under a
// line naming the default one, or its checkout removed without being asked what it holds. The
// third, deleting a branch, needs no reading of its own — the merged-only form refuses from a
// HEAD that does not contain it.
//
// Where the machine cannot be asked what is running, both halves go ahead saying so: git still
// refuses to remove a worktree holding changes, and refuses to overwrite them in a merge.
//
// The classification above is over what a REMOVAL destroys. A fast-forward is git's own operation
// and behaves as it does anywhere: it refuses over an untracked file it would overwrite, and takes
// an ignored one without a word. Nothing here changes that.
//
// The dry run FETCHES, which prunes remote-tracking refs. It has to: every answer above is about
// the remote, and reporting them off a stale one would be reporting about a different repository.
// No branch, worktree, working tree or HEAD is touched.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";

function git(args, cwd, allowFail = false) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
  const out = typeof r.stdout === "string" ? r.stdout.replace(/\r/g, "") : "";
  const err = (typeof r.stderr === "string" ? r.stderr : (r.error?.message ?? "")).replace(/\r/g, "").trim();
  // A command that never started and one that ran and refused are different answers, and the
  // second is the only one whose stderr says anything about this repository.
  if (!allowFail && r.status !== 0) {
    throw new Error(
      r.error
        ? `git could not be started (${r.error.message}) for: git ${args.join(" ")}`
        : `git ${args.join(" ")}\n${err}`,
    );
  }
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
  // Three answers reach this point and only one of them is "nothing is running there": a reader
  // that never started leaves stdout unset, and one that started and refused — a directory it may
  // not read, a process that ended between the two calls — leaves it a string with the answer
  // missing from it. Both are "the question could not be put", which is not the same as no.
  if (typeof lsof.stdout !== "string" || lsof.status !== 0) return null;
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

/**
 * The ignored paths a removal may destroy: each is written by a command in this repository and
 * comes back by running it again.
 *
 * Being ignored is not what makes a file rebuildable, and here it is not even the common case:
 * this repository ignores saved routing plans, signing material, a private checkout belonging to
 * another repository, and each machine's own settings. Removing a worktree deletes every one of
 * them with no copy anywhere, so anything ignored and NOT named here keeps the worktree instead.
 * A path this list does not know is therefore work, which is the direction that fails safe.
 * scripts/sync-merged.test.mjs holds the split against .gitignore, so a pattern added there is
 * red until it is classified.
 */
export const REGENERABLE = {
  paths: [
    "node_modules",
    "dist",
    "dist-trace",
    "coverage",
    "test-results",
    "playwright-report",
    "src-tauri/target",
    "src-tauri/gen",
    "src-tauri/THIRD_PARTY_LICENSES.html",
    "src-tauri/icons/android",
    "src-tauri/icons/ios",
    "scripts/app-icon.png",
  ],
  names: [".DS_Store", "__pycache__"],
  extensions: [".log", ".pyc"],
};

/** Whether one entry of a status listing is something a command here writes. */
function rebuildable(entry) {
  const path = entry.replace(/\/$/, "");
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    REGENERABLE.paths.includes(path) ||
    REGENERABLE.names.includes(name) ||
    REGENERABLE.extensions.some((ext) => name.endsWith(ext))
  );
}

/** Why a worktree may not be removed, or null when it may. Uncommitted content of any kind counts,
 *  and so does ignored content this cannot name; so does a worktree that cannot be asked, since a
 *  directory nobody can look inside is not the same as one that is empty.
 *
 *  `--ignored=matching` reports an ignored directory as itself rather than as its contents, which
 *  is what keeps this from enumerating node_modules; the traditional mode expands it under the
 *  `--untracked-files=all` the tracked half needs. */
function unclean(path) {
  const r = git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"], path, true);
  if (r.status !== 0) return "its worktree could not be read — the directory may be gone";
  const work = [];
  for (const rec of r.out.split("\0")) {
    if (rec === "") continue;
    if (rec.slice(0, 2) !== "!!") return "its worktree holds uncommitted work";
    const entry = rec.slice(3);
    if (!rebuildable(entry)) work.push(entry);
  }
  if (work.length === 0) return null;
  const shown = work.slice(0, 3).join(", ");
  const rest = work.length > 3 ? ` (+${work.length - 3} more)` : "";
  return `its worktree holds ignored files that no command here rebuilds: ${shown}${rest}`;
}

/** What HEAD names in a worktree and where it points, or null where it names no branch at all. */
function headOf(dir) {
  const ref = git(["symbolic-ref", "--quiet", "HEAD"], dir, true);
  const sha = git(["rev-parse", "HEAD"], dir, true);
  if (ref.status !== 0 || sha.status !== 0) return null;
  return { ref: ref.out, sha: sha.out };
}

const describeHead = (head) =>
  head === null ? "it is on no branch" : `it is on ${head.ref} at ${head.sha.slice(0, 7)}`;

/**
 * What to do about the default branch, from facts alone.
 *
 * `running` is the list of processes running out of the tree that holds it, or null where the
 * question could not be put to the machine — on which the step goes ahead, saying so, since
 * git's own refusals still stand between it and anything uncommitted.
 *
 * `act` gates the WHOLE apply rather than the fast-forward alone. Where the default branch cannot
 * be moved, the deletions are not merely unhelpful: it is the fast-forward that makes them legal,
 * and running them alone removes worktrees and then leaves every branch behind. `ff` is false only
 * when the branch is already where the remote is — there is nothing to move, and the cleanup that
 * someone else's pull left behind is exactly what this is then for.
 */
export function decide({ base, remote, local, ahead, fastForward, holder, running }) {
  if (local === null) return { reason: `${base} does not exist here` };
  if (!holder) return { reason: `${base} is checked out in no worktree` };
  if (local !== ahead && !fastForward) return { reason: `${base} has commits ${remote} does not — not a fast-forward` };
  if (running !== null && running.length > 0) {
    return { reason: running.map((c) => `pid ${c.pid} runs out of ${holder}: ${c.command}`).join("\n         ") };
  }
  const note =
    running === null ? `what runs in ${holder} could not be read — git's refusals are the only guard here` : undefined;
  return { act: true, ff: local !== ahead, tree: holder, note };
}

function plan(cwd, log) {
  const here = git(["rev-parse", "--show-toplevel"], cwd).out;
  const head = git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], cwd, true);
  if (head.status !== 0) {
    const origin = git(["remote", "get-url", "origin"], cwd, true);
    throw new Error(
      origin.status !== 0
        ? "this repository has no remote named origin, so there is no default branch to sync to"
        : "origin/HEAD names no branch — run `git remote set-head origin -a`",
    );
  }
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
  // Asked with the full refname: a bare name resolves a tag of the same spelling first, so the
  // answer would be about the tag while every other reading here is about the branch. Anything
  // but a plain yes is a no, which keeps the branch — an error here reads as "not landed".
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
    const why = !landed(ref)
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
    fastForward: local !== null && landed(`refs/heads/${base}`),
    holder: holder?.path ?? null,
    running: holder ? holdersOf(holder.path, procs, trees) : [],
  });

  for (const { branch, tree, why } of kept) log(`keep   ${branch}${tree ? ` (${tree.path})` : ""} — ${why}`);
  for (const { branch, tree } of removals) log(`would remove ${branch}${tree ? ` + ${tree.path}` : ""}`);
  log(
    !sync.act
      ? `SYNC BLOCKED — ${sync.reason}`
      : sync.ff
        ? `sync   ${base} -> ${remote}`
        : `sync   ${base} is already at ${remote}`,
  );
  if (sync.note) log(`note   ${sync.note}`);
  // Said once rather than per worktree: where the machine cannot be asked, it cannot be asked
  // about any of them, and the removals below go ahead on git's own refusals alone.
  if (procs === null && removals.some((r) => r.tree)) {
    log("note   what runs in the worktrees below could not be read — git's refusals are the only guard there");
  }
  return { removals, sync, remote, base, ahead, local };
}

export function run(cwd = process.cwd(), apply = false, log = console.log) {
  let p;
  try {
    p = plan(cwd, log);
  } catch (e) {
    log(`REFUSED — ${e.message}`);
    return 1;
  }
  const { removals, sync, remote, base, ahead, local } = p;

  if (!apply) {
    log(removals.length || sync.ff ? "\n(dry run — pass --apply to act)" : "\n(nothing to apply)");
    return sync.act ? 0 : 1;
  }
  if (!sync.act) {
    log("\nnothing applied — the fast-forward is what makes the deletions legal");
    return 1;
  }

  // The fast-forward goes FIRST, and nothing else runs until it has. It is what makes the
  // deletions legal — git is asked whether a branch is merged into HEAD, and until the default
  // branch has moved the answer is no for exactly these — and it is the step that can still fail
  // here, on a working tree that changed since the plan was read. Behind the removals, that
  // failure would leave the worktrees gone and every branch behind.
  //
  // What it is asked to move is a BRANCH; what it can name is a DIRECTORY, and a merge acts on
  // whichever branch that directory is on when it runs. Between the plan reading it and the apply
  // writing to it sits a fetch over the network, so another session can switch it in the meantime
  // — and the merge would then fast-forward that session's branch instead, under a line naming
  // the one that was meant. Asked here, nothing is written; asked again below, a switch that
  // arrived inside the merge itself stops the deletions rather than passing for a sync.
  let failed = false;
  const before = headOf(sync.tree);
  if (before?.ref !== `refs/heads/${base}` || before.sha !== local) {
    const read = `${base} at ${local.slice(0, 7)}`;
    log(`SYNC BLOCKED — ${sync.tree} is not where the plan read it (${read}): ${describeHead(before)}`);
    log("\nnothing applied — the fast-forward is what makes the deletions legal");
    return 1;
  }
  if (sync.ff) {
    const ff = git(["merge", "--ff-only", remote], sync.tree, true);
    if (ff.status !== 0) {
      log(`SYNC BLOCKED — ${ff.err}`);
      log("\nnothing applied — the fast-forward is what makes the deletions legal");
      return 1;
    }
  }
  const after = headOf(sync.tree);
  if (after?.ref !== `refs/heads/${base}` || after.sha !== ahead) {
    log(`SYNC BLOCKED — ${base} did not reach ${remote} in ${sync.tree}: ${describeHead(after)}`);
    log("\nnothing removed — the fast-forward is what makes the deletions legal");
    return 1;
  }
  if (sync.ff) log(`synced ${base} -> ${ahead.slice(0, 7)}`);

  for (const { branch, tree } of removals) {
    if (!tree) continue;
    // The same window, over the trees this is about to take: a session that switched one of them
    // has a checkout it is working in, and a removal does not ask what branch it is on. Its own
    // branch is left alone below, since the worktree it is in is still listed.
    const head = headOf(tree.path);
    if (head?.ref !== `refs/heads/${branch}`) {
      log(`keep   ${branch} — ${tree.path} is no longer on it: ${describeHead(head)}`);
      failed = true;
      continue;
    }
    const r = git(["worktree", "remove", tree.path], cwd, true);
    if (r.status !== 0) {
      log(`keep   ${branch} — its worktree could not be removed: ${r.err}`);
      failed = true;
    } else log(`removed ${tree.path}`);
  }

  // Deleted from the tree that holds the default branch rather than from the one this run was
  // started in: asking git for a merged-only deletion asks about the HEAD it is asked from, and a
  // run started in some other branch's worktree would be answered about that branch instead. The
  // merged-only form rather than the forcing one because it is a second opinion on the ancestry
  // read above.
  for (const { branch, tree } of removals) {
    if (tree && git(["worktree", "list", "--porcelain", "-z"], cwd).out.includes(`worktree ${tree.path}\0`)) continue;
    const r = git(["branch", "-d", branch], sync.tree, true);
    if (r.status !== 0) {
      log(`keep   ${branch} — git declined to delete it: ${r.err}`);
      failed = true;
    } else log(`removed ${branch}`);
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
