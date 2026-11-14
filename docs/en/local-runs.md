# Local runs

> 日本語版: [../ja/local-runs.md](../ja/local-runs.md)

Procedures for running the tests, the builds and one-off evaluations on a development machine. The
commands themselves, the port rules, the rule for stopping a process and the dev app's startup
check are in `AGENTS.md` "Development"; this document holds the procedures around them.

## Starting a Live sync session from an E2E spec

`e2e/tauri-stub.ts` exports `LIVE_COMMANDS`, the registrations a session makes on top of its reads.
A spec that turns Live sync on passes them as `commands`; without them the activation aborts before
the session counts as up.

Two things about the button that starts it:

- `#btn-live` is an item of `#device-menu`, so the spec clicks `#btn-device` first.
- The menu closes when the item is chosen and the item stays hidden, so a wait for visibility never
  passes. Wait for the attribute, with the element only attached:
  `page.waitForSelector('#btn-live[aria-checked="true"]', { state: "attached" })`.

## Finding a server left on an E2E port

E2E runs against a production build served on port 4173 (and the `race` / `race-webkit` projects
against a trace build on 4174), and `reuseExistingServer` is on locally: a `pnpm preview` left
running (a `build:demo` bundle, say) is reused as-is by `pnpm test:e2e`, silently testing the wrong
bundle. Stop it first — and note the same trap catches a **second checkout**: two runs sharing a
port means the later one is handed the earlier one's bundle and passes against code that is not the
code under test.

To see whether one is there, and whose bundle it serves, read the name of the chunk the port is
serving and compare it with the build output on disk:

```sh
curl -s localhost:<port>/ | grep -o 'assets/main-[A-Za-z0-9_-]*\.js'
ls dist/assets/main-*.js
```

- The entry in `index.html` is `/src/main.ts`, so the chunk Vite emits is `main-<hash>.js`.
- An empty result is not evidence that no server is there. A pattern that names another chunk
  prefix returns nothing against a live server as well.
- A hash that differs from the one on disk means the port is not serving the bundle this tree
  last built. For port 4174 the build output is `dist-trace/`.

Before stopping it, read whose process it is, in the same command that finds it — a listener can
exit between two commands, and then nothing says whose it was:

```sh
for p in $(lsof -tnP -iTCP:<port> -sTCP:LISTEN); do ps -o pid,ppid,lstart,command -p $p; lsof -a -p $p -d cwd -Fn | grep '^n'; done
```

The pair 4173 / 4174 is the E2E server's (`pnpm e2e:serve`); `pnpm tauri dev` listens on 5173
alone. Stop the PID only when its command line and working directory say it is your own run.

## Running the suite beside another checkout

Both ports come from the environment — `E2E_PORT` / `E2E_TRACE_PORT`, defaulting to 4173 / 4174 —
read in `playwright.config.ts` and in `scripts/e2e-serve.mjs`, which the web server inherits, so the
URL polled and the port bound are resolved once from one place. A port pair alone is not isolation:
two runs in one checkout still build into the same `dist/` and `dist-trace/`, so the second one's
build overwrites the bundle the first is serving. **`pnpm e2e:worktree` is the isolated path** — it
derives its port pair from the **process id** (deliberately, rather than scanning for a free pair: a
scan is separated from the bind by the `vite build`, and two runs scanning in that window both pick
the same pair), puts the run in a throwaway `git worktree`, and carries the working state into it
(tracked modifications as a patch, untracked-but-not-ignored files as copies, an untracked symlink
as a symlink with the same target), because a worktree otherwise checks out HEAD and would test the
last commit while reporting on the working tree. `--keep` leaves the tree; anything after `--` goes
to Playwright.

## Comparing coverage between a worktree and another checkout

The `*.local.test.ts` files (`src/core/control/urxf.local.test.ts`,
`src/core/control/dyn-time-stops.local.test.ts`) read sample files that are not part of this
repository, and skip their cases where the files are absent. A fresh worktree does not have the
files, so the same commit reports lower line coverage there for the modules those cases cover than
it does in a checkout that has them. Two runs of one commit reporting different figures is the
missing input, not a suite that changes from run to run.

For a before / after comparison, measure both sides under the same condition: both with the sample
files, or both without.

## Scratch files under `work/`

`.gitignore` does not ignore `work/`. A file placed directly under it shows up in `git status` as
`?? work/`.

- A file that does not have to outlive the task (a draft of a pull request body, say) goes outside
  the repository.
- Files that have to outlive it go in a subdirectory, `work/<name>/`, with one line for that
  subdirectory added to the exclude file that
  `git rev-parse --path-format=absolute --git-path info/exclude` prints. A linked worktree keeps
  its git directory elsewhere, so `.git/info/exclude` is not a path there; the file the command
  prints belongs to the main checkout, and every worktree of the repository reads it.

## Evaluating a `src/` module once, without a test

`node_modules/.bin` carries `esbuild`, and neither `tsx` nor `vite-node`. To evaluate a function
once — comparing a computed value with an expected one, say — bundle a small entry file and run it:

```sh
node_modules/.bin/esbuild <entry>.ts --bundle --platform=node --format=esm --outfile=<out>.mjs
node <out>.mjs
```

- An entry file kept outside the repository resolves its imports relative to itself, so
  `./src/...` fails with `Could not resolve`. Import by the repository's absolute path.
- Read the export's signature before calling it. `bandResponse` in `src/core/eq-response.ts`, for
  one, returns a function that takes a frequency; it does not take an array of frequencies.

## The first build in a new worktree

`vendor/urx-lcd-sim` is a git submodule: a clone and a new worktree start with it empty, and
`pnpm install` links it as it is, so `git submodule update --init` runs before `pnpm install`.

`src-tauri/tauri.conf.json` bundles `src-tauri/THIRD_PARTY_LICENSES.html` as a resource, and the
file is ignored by git. A new worktree therefore has none, and its first build fails in the build script
with `resource path ... doesn't exist`. That happens for `pnpm tauri dev`, and for `cargo check`
and `cargo test` on their own as well.

- When no distributable is being built, the file's content is not read. Copy the file from another
  checkout, or write an empty one the way the CI jobs do:
  `echo "" > src-tauri/THIRD_PARTY_LICENSES.html`.
- To generate the real one, run `cargo about generate` in `src-tauri/` with the arguments
  `.github/workflows/licenses.yml` gives it.
- Before handing anyone a `pnpm tauri dev` command for a worktree, check that the file is there.

## Checking that each commit is green on its own

When a change is split into several commits, each commit is checked in a throwaway detached
worktree:

```sh
git worktree add --detach <dir> <sha>
```

- `node scripts/check-md-tables.mjs` and `node scripts/check-assets-index.mjs` have no
  dependencies, so they run there without `pnpm install`.
- Remove the tree with `git worktree remove --force <dir>` and confirm with `git worktree list`
  that it is gone.
- Do not unpack the commit into a directory that is not a git checkout (`git archive`,
  `git checkout-index`). `scripts/check-assets-index.mjs` asks `git check-ignore` which paths are
  ignored; outside a repository that question has no answer, and the check reports findings that
  are not real.
- Name the commit by its SHA. A relative revision such as `HEAD~2` is resolved against the HEAD of
  the checkout the command runs in, which is another commit when the shell is in another worktree.

## Starting the desktop app for a check

The command is the dev line in the README (`pnpm tauri dev`, with `-- -- --experimental` after it for
the experimental features).

- **A subshell that has not read the login profile has neither Node nor Cargo on its `PATH`.** Put
  the directories of the Node version manager's shims, of Cargo's binaries and of the package
  manager in front of it.
- **If the SIM view fails with `Failed to resolve import` naming the simulator's fonts**, the simulator is
  not linked into `node_modules`. Run the set-up commands of AGENTS.md "Development" (the submodule,
  then the install). No tracked file changes.
- **Whether the app is up** is answered by the process, not by the log: AGENTS.md "Development",
  "The dev app being up is a process, not a log line".
- **The app runs the simulator at the commit the submodule points at.** A change that is not merged
  in the simulator's repository is not in the app; say so when reporting what was seen.
- **If `pnpm tauri dev` keeps showing a stale version or UI**, discard the build caches with
  `pnpm clean` and restart (the version is embedded at build time via
  `tauri.conf.json`→`../package.json`, so it easily sticks in the Vite cache). The webview's
  persistent data (the consent gate in `localStorage`, etc.) lives outside the app and is not
  covered by `pnpm clean`; on macOS delete `~/Library/WebKit/<productName or identifier>/` manually.
- **Closing the window ends the command with exit code 0.**
- **When stopping it, stop only the `pnpm`, `vite` and app processes you started**, after reading
  their command lines. Another session's `vite` may be running on the same machine. What a pattern
  catches here: `pkill -f "playwright test"` matches another checkout's run, a wide `pkill -f vite`
  matches the operator's own `pnpm tauri dev`, and `until ! pgrep -f …` waits for someone else's run
  to finish — the same whether the target is a leftover preview server, a stuck Playwright run, or a
  dev app.

## Resetting the dev app's stored state

How to reset the dev app's localStorage (theme/model/meter point/consent gate/recent files/inspector
open state/user preferences) **and the remembered window geometry** (the state that lives in files
rather than in `localStorage` — `.window-state.json` and the `.window-scale.json` beside it, both
deleted by the reset; [architecture.md](architecture.md) "Window geometry" has the mechanism): in
the browser, open `http://localhost:5173/?reset` (or `#reset`) (`pnpm reset:storage` opens it;
cleared synchronously at startup, then the flag is stripped from the URL); on desktop, launch with
`pnpm tauri dev -- -- --reset-storage` (Rust reads `--reset-storage` and the frontend clears +
reloads; `reset_storage_requested` command). Both entry points funnel into the reset routine in
`src/main.ts`.

## Launch flags against the unit: what reaches the terminal

The flags themselves — `--experimental --self-test`, `--prepare-modified`, `--reset-storage` — and
the rule for editing while a run writes to the unit are in `AGENTS.md` "Development".

- **`--self-test` and `--prepare-modified` wait for the first-run consent gate**: a profile that has
  not accepted it (a fresh install, a profile after `--reset-storage`) shows the gate, logs
  `[self-test] waiting for first-run consent`, and writes nothing until it is accepted
  ([architecture.md](architecture.md) "Use consent (license display and disclaimer)").
- Only Rust's `eprintln!` reaches stdout; the frontend's `console.*` and the status bar live inside
  the webview, and Vite's client forwards `console.warn` as `[vite] (client) [console.warn]` when
  the dev server is attached.
- **An HMR reload while a run is writing to the unit** is a page load, and each page load starts
  another destructive sweep over the one already running. The `take_launch_action` latch stops a
  one-shot flag from re-firing, but the run itself still restarts, and a sweep killed before it
  reaches its restore leaves the unit perturbed with the original state it captured living only in
  the dead page's memory: unrecoverable, not merely interrupted. Stop the app before editing.

## After a merge: `pnpm sync:merged`

The rule is in `AGENTS.md` "Conventions"; this section is what it rests on and how to act on what it
reports.

**Once a pull request merges, the cleanup in the global rules applies** (the local branch and the
worktree that carried it, with that rule's two exceptions). Here the worktree is the half that costs
something — `reuseExistingServer` plus the E2E ports mean a forgotten checkout can hand a later run
the bundle it built, so the run passes against code that is not the code under test. Remove it as
`git worktree remove <path>` followed by `git branch -d <branch>` — git refuses that for a worktree
with `vendor/urx-lcd-sim` checked out, and `pnpm sync:merged` keeps such a worktree rather than
delete the submodule's repository with it — `git worktree remove --force <path>` removes it, that
repository included; deleting the directory instead leaves the worktree registered until someone
remembers `git worktree prune`. **On Windows, unlink a linked `node_modules` first**
(`pnpm e2e:worktree` makes it a junction to the main checkout's install): Git for Windows deletes
THROUGH a junction, so the removal empties the install it points at, whether or not the removal
itself succeeds. `git branch --merged origin/main` also lists a branch that merely points at an
ancestor and has no commits of its own — that is an unstarted branch, not a finished one.

**Fast-forwarding the local default branch is the third step of the same moment**, and the one that
gets skipped: a checkout left behind the remote goes on answering, about the revision it holds, so a
script comparing the design-system artifact against `src/style.css` sees a selector the merge added
as absent rather than as different — and absent is the bucket its output calls a specimen-only
class. `pnpm sync:merged` is the three steps under one command for that reason.

It fast-forwards the default branch to origin (bringing `vendor/urx-lcd-sim` to the commit it
records, unless it was moved by hand), removes the worktree that carried the branch, and deletes the
branch. Every refusal names what it refused and why; `AGENTS.md` "Conventions" has the rule, and
`scripts/sync-merged.mjs` the guards.

It fetches and reports; `--apply` acts. **The fast-forward runs first and anything that stops it
stops the whole apply**, since it is what makes the deletions legal — git is asked whether a branch
is merged into HEAD, and until the default branch has moved the answer is no for exactly these
branches. Behind them instead, its own failure on a working tree that changed since the plan was
read would leave the worktrees gone and every branch behind. Deletions run in the tree that holds
the default branch rather than the one the command was started in, or git answers about that other
branch.

It adds one refusal of its own, over both halves — a build or a server running out of a tree, whose
files would be swapped under it — counting a process by the innermost worktree its directory belongs
to, since this repository keeps its worktrees inside the main checkout and a plain prefix reads
every one of them as the main checkout. Where the machine cannot be asked what is running, both
halves go ahead saying so, git's own refusals being what still stands between them and anything
uncommitted.

**Ignored is not the same as rebuildable**, and here it is not even the common case: this repository
ignores saved routing plans, signing material, a private checkout belonging to another repository
and each machine's own settings, and a removal reaches all of them exactly as it reaches `dist/` —
with no copy anywhere, since git never held them. So the paths a command here writes are named in
`scripts/sync-merged.mjs`, anything else ignored keeps the worktree, and a pattern added to ANY
tracked `.gitignore` is red until it is classified as one or the other — asked of git rather than of
a list of files, since the root one is not the only one: `src-tauri/.gitignore` carries patterns of
its own, `build.rs`'s generated permissions among them, and a pattern nothing classifies keeps a
worktree that holds only build output.

**And every reading the apply rests on is taken again at the moment of writing.** The removal rule
is asked a second time, in full and on a fresh reading, so a file saved into a worktree, a build
started in it, a lock, a switch or a commit on the branch keeps that worktree whether it arrived
before the plan or after it — a rule read once and destroyed on is the same defect at each of its
readings. The tree the fast-forward writes to is re-read on both sides of the merge. A removal can
be refused on that second reading, so nothing is destroyed. A merge cannot be: `git merge` is
pointed at a directory too and resolves the branch from HEAD as it runs, and no lock keeps a
checkout switch out of the gap — an index lock does not stop one, and a worktree lock guards removal
alone — so a switch arriving there would have that session's branch fast-forwarded instead. **So the
sync names the branch rather than merging into it**: a compare-and-swap on the ref, which can write
no other, and then bringing that tree's index and files in line, which writes no ref at all. The
order carries the rest — a tree switched away in between needs no bringing in line, since the branch
is then checked out nowhere; and the half that can still refuse (an uncommitted edit to a file the
sync writes, an untracked file where it adds one) runs second, so it puts the branch back when it
does.

**The fast-forward is still taken in no tree but the one the command was started in**, which bounds
the rest of it to this checkout. A switch arriving inside the index update writes no ref, but it
does leave an index its tree's own HEAD no longer describes — the sync's changes, staged on someone
else's branch and carried by their next commit — so the tree is read back afterwards and each path
the sync wrote goes back to what THAT branch holds. Only where its index AND its working file both
still hold what the sync wrote, **the two asked separately**: a file put back by hand hides the
sync's version in the index behind a working file that matches HEAD, where `git diff HEAD` is empty
and `git status` says `MM`, and the next commit on that branch takes it. Anything else the sync's
content is still in is named rather than deleted, that session having touched it since, and a path
already matching the branch needs nothing — which is every path when the switch lands after the
write, git's own checkout having restored the branch's content on the way. Taking the whole tree
back to the branch's old tip instead, which a plain reverse read does, deletes what the branch it is
on legitimately holds at those paths.

Its cost is the everyday case — started from a worktree with a sync pending, nothing is applied at
all, the fast-forward being what makes the deletions legal — so run it from the checkout that holds
the default branch, or run it there afterwards. The refusal names the tree to run it in, which is
the whole instruction; a session that reports the cleanup as something it cannot do has stopped one
step short of it.

**Start it from a shell whose working directory is outside the checkout it is pointed at**: with the
shell still inside that checkout the apply stops at `SYNC BLOCKED — pid … runs out of …`, and the
process it names is the shell that launched it — change directory out first, then
`pnpm -C <the checkout that holds the default branch> sync:merged --apply`.

**A worktree the report keeps is one the command lacked the evidence to remove, not one it has been
told to leave, so sort it by what it holds**: an open pull request or recent commits — keep it; no
difference and no commits of its own — remove it, since it can be cut again from the same commit; a
difference — look for a copy elsewhere with `cmp` and `git hash-object`, apply that copy to a
throwaway worktree and confirm every file matches before removing, and take a document change the
default branch lacks back in as a pull request once `git apply --check` says it still applies. The
worktree the run is IN is kept by a rule of its own, so the last one goes on the next run, from the
tree that holds the default branch. A run with nothing to fast-forward writes to no tree and is
unaffected, which is the cleanup someone else's pull left behind.

`pnpm test sync-merged` holds each guard against the arrangement it refuses.
