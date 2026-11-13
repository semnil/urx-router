# Local runs

> 日本語版: [../ja/local-runs.md](../ja/local-runs.md)

Procedures for running the tests, the builds and one-off evaluations on a development machine. The
commands themselves, the port rules, the rule for stopping a process and the dev app's startup
check are in `AGENTS.md` "Development"; this document holds the steps around them that are needed
only now and then.

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

`AGENTS.md` "Development" says what a server left on port 4173 or 4174 does to the next run. To see
whether one is there, and whose bundle it serves, read the name of the chunk the port is serving
and compare it with the build output on disk:

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
- **Closing the window ends the command with exit code 0.**
- **When stopping it, stop only the `pnpm`, `vite` and app processes you started**, after reading
  their command lines. Another session's `vite` may be running on the same machine.
