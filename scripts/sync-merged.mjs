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
// checked out nowhere, one checked out in a tree other than the one this run was started in, one
// carrying commits the remote does not, one whose tree is not where the plan read it, and the same
// running-process rule over the tree that holds it.
//
// **Any of those stops the whole apply, and the fast-forward runs first.** The deletions are what
// it makes legal, so running them without it removes worktrees and then leaves every branch
// behind — which is also why the fast-forward is not placed behind them, where its own failure
// (a working tree that changed since the plan was read) would leave exactly that.
//
// Every write re-reads what the plan read, immediately before making it. A removal names a
// DIRECTORY and acts on whichever branch that directory is on when it runs, and between the plan
// reading one and the apply writing to it sits a fetch over the network, so a session that
// switched a tree in that window would have its checkout removed without being asked what it
// holds. Deleting a branch needs no reading of its own — the merged-only form refuses from a HEAD
// that does not contain it.
//
// A removal can be REFUSED on that reading, on the whole rule rather than on part of it, so
// nothing is destroyed. The sync cannot be, if it is a merge: `git merge` is pointed at a
// directory too and resolves the branch from HEAD as it runs, so a switch arriving in the gap has
// that session's branch fast-forwarded instead — and no lock keeps one out of that gap, an index
// lock not stopping a switch and a worktree lock guarding removal alone. Which is why the sync is
// not a merge; the two commands it is instead are at the head of the apply, with the reasoning.
//
// A switch arriving inside the second command writes no ref, but it does leave an INDEX its
// tree's own HEAD no longer describes — this sync's changes, staged on someone else's branch and
// carried by their next commit. So the tree is read back afterwards, and where it has moved, each
// path the sync wrote goes back to what THAT branch holds — but only where BOTH its index and its
// working file still hold what the sync wrote, the two being asked separately because a file put
// back by hand hides the sync's version in the index behind a working file that matches HEAD.
// Anything else the sync's content is still in is named rather than deleted, that session having
// touched it since. Taking the whole tree back to the branch's old tip instead deletes what the
// branch it is on legitimately has at those paths.
//
// It is also taken in NO TREE BUT THE ONE THIS WAS STARTED IN, which bounds all of that to this
// checkout. Run from anywhere else with a sync pending, nothing is applied.
//
// Where the machine cannot be asked what is running, both halves go ahead saying so: git still
// refuses to remove a worktree holding changes, and refuses to write over them when the sync
// brings a tree in line.
//
// The classification above is over what a REMOVAL destroys. Bringing a tree to a commit is git's
// own operation and behaves as it does anywhere: it refuses over an untracked file it would
// overwrite, and takes an ignored one without a word. Nothing here changes that.
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
  // A reader that never started leaves stdout unset, and there is nothing in it to read.
  if (typeof lsof.stdout !== "string") return null;
  const cwds = new Map();
  let pid = null;
  for (const line of lsof.stdout.split("\n")) {
    if (line.startsWith("p")) pid = line.slice(1);
    else if (line.startsWith("n") && pid) cwds.set(pid, line.slice(1));
  }
  // A non-zero status says one of the pids went unanswered, and it is two different things: a
  // process that has ENDED since the listing was taken is not running out of any tree, which is
  // an answer, while one that is still there is the question not being put — and that second one
  // is what the caller has to be told, since the guard then rests on nothing. The listing and the
  // read are two calls, and this repository's own test runs are in the word list above, so a
  // candidate ending in between is the ordinary case on a busy machine rather than an edge one:
  // taken as a refusal it threw away the answers that had arrived for every other process.
  if (lsof.status !== 0 && candidates.some((c) => !cwds.has(c.pid) && stillThere(c.pid))) return null;
  return candidates.filter((c) => cwds.has(c.pid)).map((c) => ({ ...c, cwd: cwds.get(c.pid) }));
}

/** Whether a pid is still there. A process this user may not signal is still a process, so the
 *  refusal is a yes; only "no such process" is a no. */
function stillThere(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
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

/** What HEAD names in a worktree and where it points, or null where it names no branch at all.
 *  Both in ONE invocation: this is the reading the fast-forward is guarded by, and the gap between
 *  it and the merge is the gap a switch has to land in. */
function headOf(dir) {
  const r = git(["rev-parse", "HEAD", "--symbolic-full-name", "HEAD"], dir, true);
  const [sha, ref] = r.out.split("\n");
  if (r.status !== 0 || !ref?.startsWith("refs/heads/")) return null;
  return { ref, sha };
}

const describeHead = (head) =>
  head === null ? "it is on no branch" : `it is on ${head.ref} at ${head.sha.slice(0, 7)}`;

const lines = (r) => r.out.split("\n").filter(Boolean);

/**
 * Take back what the sync wrote into a worktree that is no longer on the branch it wrote for.
 *
 * WHICH PATHS are acted on is the whole of it, and the INDEX and the WORKING FILE are asked
 * separately at every step. A path is taken back only where both of them still hold exactly what
 * the sync wrote: the working file is where that session's typing lives, so a path holding
 * anything else there is left alone whatever the index says. A path already matching that tree's
 * HEAD on both sides needs nothing, which is every path when the switch lands after the write,
 * git's own checkout having restored the branch's content on the way.
 *
 * What is left holding the sync's content on EITHER side is named and not touched. That is the
 * case a reading of the working file alone cannot see: put the file back by hand and the index
 * still carries the sync's version, staged, for the next commit on that branch to take — `git
 * diff HEAD` is empty there while `git status` says `MM`.
 *
 * Taking the tree back to the branch's OLD TIP instead, which is what a plain reverse read does,
 * deletes whatever that branch legitimately holds at those paths: a file it had committed was
 * removed and staged as a deletion, under a line saying it had been put back. The restore reads
 * that tree's own HEAD, which at the paths this acts on holds the same content as the old tip in
 * every arrangement reachable here — git allows the switch only where it can carry the difference
 * — so the source is not what separates the two; the selection is.
 */
function putBack(cwd, dir, local, ahead) {
  const touched = lines(git(["diff", "--name-only", local, ahead], cwd, true));
  if (touched.length === 0) return { back: true, held: [] };
  const named = (args) => new Set(lines(git(["diff", "--name-only", ...args, "--", ...touched], dir, true)));
  const scan = () => {
    const idxOffHead = named(["--cached", "HEAD"]);
    const wtOffIdx = named([]);
    const idxOffOurs = named(["--cached", ahead]);
    const wtOffOurs = named([ahead]);
    const off = touched.filter((p) => idxOffHead.has(p) || wtOffIdx.has(p));
    return {
      mine: off.filter((p) => !idxOffOurs.has(p) && !wtOffOurs.has(p)),
      ours: off.filter((p) => !idxOffOurs.has(p) || !wtOffOurs.has(p)),
    };
  };
  const first = scan();
  if (first.mine.length) git(["restore", "--source", "HEAD", "--staged", "--worktree", "--", ...first.mine], dir, true);
  // Read again rather than taken from an exit code: the claim is about the tree, not the command.
  const held = scan().ours;
  return { back: held.length === 0, held };
}

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
 *
 * `startedIn` is the tree the command was run from, and a fast-forward is taken in NO OTHER. A
 * merge writes to a worktree by naming its directory and acts on whichever branch that directory
 * is on when it runs, so writing only here rules out every other worktree as a place the switch
 * could come from. What it does not rule out is a second terminal in this same checkout, which is
 * why the sync names the branch rather than merging into it. It costs what it sounds like: run from
 * a worktree with a sync pending, nothing is applied — the fast-forward is what makes the
 * deletions legal, so it stops those too. A run with nothing to fast-forward writes to no tree
 * and is unaffected, which is the cleanup someone else's pull left behind.
 */
export function decide({ base, remote, local, ahead, fastForward, holder, running, startedIn }) {
  if (local === null) return { reason: `${base} does not exist here` };
  if (!holder) return { reason: `${base} is checked out in no worktree` };
  if (local !== ahead && !fastForward) return { reason: `${base} has commits ${remote} does not — not a fast-forward` };
  if (local !== ahead && holder !== startedIn)
    return {
      reason: `${base} is checked out in ${holder} and this run was started in ${startedIn} — the fast-forward is taken in no tree but the one it was started in, so run it from ${holder}`,
    };
  if (running !== null && running.length > 0) {
    return { reason: running.map((c) => `pid ${c.pid} runs out of ${holder}: ${c.command}`).join("\n         ") };
  }
  const note =
    running === null ? `what runs in ${holder} could not be read — git's refusals are the only guard here` : undefined;
  return { act: true, ff: local !== ahead, tree: holder, note };
}

/** Everything the removal rule reads that is shared across branches, taken at one moment. */
function survey(cwd, remote) {
  return {
    here: git(["rev-parse", "--show-toplevel"], cwd).out,
    trees: worktrees(cwd),
    procs: workingDirs(),
    onFirstParent: new Set(git(["rev-list", "--first-parent", remote], cwd).out.split("\n")),
  };
}

/**
 * Why a branch may not be removed, or null when it may, from a survey taken at a moment.
 *
 * Called twice on purpose: once by the plan, to report, and again by the apply on a FRESH survey,
 * immediately before each removal. Nothing it reads holds still — a session can commit to the
 * branch, save a file into the worktree, start a build in it, lock it or switch it away — and by
 * the time anything is destroyed the plan is minutes and a network fetch old. Reading it once and
 * destroying on that answer is the same defect at every one of those readings.
 *
 * `at` names the worktree the plan meant. Given one, the tree is looked up by PATH and required to
 * still be on the branch: found by branch instead, a tree switched away is simply not found, and a
 * run would then leave the checkout standing and delete the branch under it.
 */
function whyKeep(cwd, remote, branch, ref, s, at = null) {
  const tree = (at ? s.trees.find((w) => w.path === at) : s.trees.find((w) => w.branch === branch)) ?? null;
  // Asked with the full refname: a bare name resolves a tag of the same spelling first, so the
  // answer would be about the tag while every other reading here is about the branch. Anything
  // but a plain yes is a no, which keeps the branch — an error here reads as "not landed", and so
  // does a ref that is gone, which is why nothing above asks separately whether it still exists.
  if (git(["merge-base", "--is-ancestor", ref, remote], cwd, true).status !== 0)
    return { tree, why: `not merged into ${remote}` };
  const tip = git(["rev-parse", "--verify", "--quiet", ref], cwd, true);
  if (s.onFirstParent.has(tip.out))
    return {
      tree,
      why: "its tip is on the remote's own first-parent line — an unstarted branch, or one that landed by fast-forward, and this cannot tell the two apart",
    };
  if (at && !tree) return { tree, why: `${at} is no longer a worktree of this repository` };
  if (!tree) return { tree, why: null };
  if (tree.path === s.here) return { tree, why: "this session is working in it" };
  if (tree.branch !== branch) return { tree, why: `its worktree is on ${tree.branch ?? "no branch"} now` };
  if (tree.locked) return { tree, why: "its worktree is locked — another session is inside" };
  const dirty = unclean(tree.path);
  if (dirty) return { tree, why: dirty };
  const busy = holdersOf(tree.path, s.procs, s.trees);
  if (busy && busy.length > 0)
    return { tree, why: `${busy.length} process(es) run out of its worktree: pid ${busy[0].pid}` };
  return { tree, why: null };
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

  const s = survey(cwd, remote);
  const { trees, procs } = s;

  const removals = [];
  const kept = [];
  for (const rec of git(["for-each-ref", "--format=%(refname)", "refs/heads"], cwd).out.split("\n")) {
    const ref = rec;
    if (!ref) continue;
    const branch = ref.slice("refs/heads/".length);
    if (branch === base) continue;
    const { tree, why } = whyKeep(cwd, remote, branch, ref, s);
    if (why) kept.push({ branch, tree, why });
    else removals.push({ branch, ref, tree });
  }

  const local = tip(`refs/heads/${base}`);
  const holder = trees.find((w) => w.branch === base);
  const sync = decide({
    base,
    remote,
    local,
    ahead,
    fastForward:
      local !== null && git(["merge-base", "--is-ancestor", `refs/heads/${base}`, remote], cwd, true).status === 0,
    holder: holder?.path ?? null,
    running: holder ? holdersOf(holder.path, procs, trees) : [],
    startedIn: here,
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
  // What it is asked to move is a BRANCH, and `git merge` can only be pointed at a DIRECTORY —
  // it acts on whichever branch that directory is on when it runs, so a checkout switch arriving
  // while this is in flight has that session's branch fast-forwarded instead. Reading HEAD first
  // narrows the gap and does not close it, and nothing git offers closes it either: an index lock
  // does not stop a switch, and a worktree lock guards removal alone. So the merge is not used.
  // The two things it does are done separately, and only the FIRST of them writes a ref:
  //
  //   update-ref <branch> <new> <old>   names the branch, and swaps it only if it is still where
  //                                     the plan read it. No other ref can be written by it.
  //   read-tree  -m -u <old> <new>      brings that tree's index and files in line. It writes no
  //                                     ref at all, so a switch arriving here moves nothing.
  //
  // The order matters both ways. The swap first, because a tree switched away needs no bringing
  // in line — the branch is then checked out nowhere, and the sync is simply finished. The
  // read-tree behind it, because it is the half that can still refuse (an uncommitted edit to a
  // file the sync writes, an untracked file where it adds one) and by then the branch has moved:
  // that refusal is followed by putting the branch back, which is the one place here that has to
  // undo its own write.
  let failed = false;
  const before = headOf(sync.tree);
  if (before?.ref !== `refs/heads/${base}` || before.sha !== local) {
    const read = `${base} at ${local.slice(0, 7)}`;
    log(`SYNC BLOCKED — ${sync.tree} is not where the plan read it (${read}): ${describeHead(before)}`);
    log("\nnothing applied — the fast-forward is what makes the deletions legal");
    return 1;
  }
  if (sync.ff) {
    const swap = git(
      ["update-ref", "-m", `sync:merged fast-forward to ${remote}`, `refs/heads/${base}`, ahead, local],
      cwd,
      true,
    );
    if (swap.status !== 0) {
      log(`SYNC BLOCKED — ${base} could not be moved: ${swap.err}`);
      log("\nnothing applied — the fast-forward is what makes the deletions legal");
      return 1;
    }
    // The branch is at the remote and its checkout is not. A tree that is no longer on it has
    // nothing to bring in line, since the branch is then checked out nowhere: the sync is done,
    // and the cleanup is not, because what makes the deletions legal is a HEAD that holds it.
    const on = headOf(sync.tree);
    if (on?.ref !== `refs/heads/${base}`) {
      log(`synced ${base} -> ${ahead.slice(0, 7)}`);
      log(`SYNC BLOCKED — ${sync.tree} left ${base} while it was being synced: ${describeHead(on)}`);
      log("\nnothing removed — run again from the tree that holds it");
      return 1;
    }
    const fill = git(["read-tree", "-m", "-u", local, ahead], sync.tree, true);
    if (fill.status !== 0) {
      const back = git(["update-ref", "-m", "sync:merged put back", `refs/heads/${base}`, local, ahead], cwd, true);
      log(`SYNC BLOCKED — ${sync.tree} could not be brought to ${ahead.slice(0, 7)}: ${fill.err}`);
      log(
        back.status === 0
          ? `       ${base} is back at ${local.slice(0, 7)}`
          : `       AND ${base} COULD NOT BE PUT BACK: ${back.err}`,
      );
      log("\nnothing applied — the fast-forward is what makes the deletions legal");
      return 1;
    }
    // read-tree writes no ref, so a switch arriving inside it moves nothing — but it writes an
    // INDEX, and the tree it wrote is then one whose HEAD describes something else: the sync's
    // changes sit there staged, and that session's next commit carries them.
    const left = headOf(sync.tree);
    if (left?.ref !== `refs/heads/${base}`) {
      const put = putBack(cwd, sync.tree, local, ahead);
      log(`synced ${base} -> ${ahead.slice(0, 7)}`);
      log(`SYNC BLOCKED — ${sync.tree} left ${base} while its files were being written: ${describeHead(left)}`);
      log(
        put.back
          ? "       the files it wrote are back to what that branch holds"
          : `       AND IT STILL HOLDS WHAT THIS SYNC WROTE: ${put.held.join(", ")}`,
      );
      log("\nnothing removed — run again from the tree that holds it");
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

  for (const { branch, ref, tree } of removals) {
    if (!tree) continue;
    // Asked again, on a reading taken now rather than on the plan's: the same rule, so a file
    // saved into the tree, a build started in it, a lock, a switch or a commit on the branch is
    // seen here whether it arrived before the plan or after it. Its own branch is left alone
    // below, since the worktree it is in is still listed.
    const { why } = whyKeep(cwd, remote, branch, ref, survey(cwd, remote), tree.path);
    if (why) {
      log(`keep   ${branch} — ${why}`);
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
