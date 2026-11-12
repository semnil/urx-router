# Decisions: build, release, CI and distribution

> 日本語版: [../../ja/decisions/build-and-release.md](../../ja/decisions/build-and-release.md)

Closed decisions about how the app is built, checked and shipped: what was decided, why, what
was turned down, and what would reopen it. How the build and the workflows work today is in
[architecture.md](../architecture.md) "Build and distribution" and in the workflow headers; this
document holds only the reasoning that those do not.

## Native dialogs go through tauri-plugin-dialog

**Decision.** The open, save and message dialogs call the official `tauri-plugin-dialog`. The
frontend invokes the plugin's commands directly from `src/core/platform.ts`, with no npm package
added. Reading and writing the chosen file stays with the shell's own file commands, so no plugin
file scope has to be configured.

**Turned down.** Hand-written dialog code on top of the `rfd` crate, in two shapes. Awaiting its
asynchronous file dialog from an async Tauri command never completed on macOS. Running its
synchronous dialog on the main thread worked for the first dialog and hung on the second. Either
way the symptom was the same: Open and Save did nothing.

## The release is dispatched on the tag without a personal access token

**Decision.** `tag-release.yml` starts `release.yml` with `gh workflow run --ref <tag>`, and
`release.yml` decides what the run is from the type of the ref it was given. The mechanism is in
`CLAUDE.md` "Development"; the change that introduced it is
[#235](https://github.com/semnil/urx-router/pull/235).

**Why.** A tag pushed with the repository's own token starts no workflow. The dispatch form was
chosen because it needs no personal access token.

**Reopen when.** A proposal to rebuild this path first has to hold without a personal access token.

## No .git-blame-ignore-revs

**Decision (2026-08-16).** The repository carries no `.git-blame-ignore-revs`, and nothing else is
done about a commit that re-indents a file.

**Why.** The question came up when `scripts/check-assets-index.mjs` was wrapped in an entry guard
and the re-indentation moved most of the file's blame onto that one commit
([#398](https://github.com/semnil/urx-router/pull/398) has the line counts). That file states its
reasons in comments beside the code, so little depends on its blame.

## The message catalogs stay out of the coverage set

**Decision (2026-08-13).** `src/i18n/en.ts` and `src/i18n/ja.ts` are excluded from coverage
([#362](https://github.com/semnil/urx-router/pull/362)). The reason is the comment in
`vitest.config.ts`.

**Turned down.** A walker test that calls every formatter in both catalogs. It was run before it
was proposed: each of the 204 formatters did not throw, returned a non-empty string, showed its
argument in the output and changed its output when the argument changed. The exclusion was chosen
over it on cost, so the walker is not an untried idea.

**Left as it is.** The exclusion is written by hand in three places — `vitest.config.ts`,
`e2e/coverage-options.ts` and `.github/codecov.yml` — and nothing holds them together.

**Reopen when.** A fourth catalog is added; until then a guard over the three places was judged not
worth its cost.

## What the pull request template carries

Which boxes the template holds, and why running the formatter is not one of them:
[#238](https://github.com/semnil/urx-router/pull/238), revised by
[#653](https://github.com/semnil/urx-router/pull/653).

## The demo deploys when the draft is published

**Decision.** `pages.yml` deploys the demo when a person publishes the draft release
([#283](https://github.com/semnil/urx-router/pull/283)); the mechanism is in `CLAUDE.md`
"Development". Three refinements were considered and not added: leaving prereleases out, guarding
against an older release being published after a newer one, and deploying again when a release is
published a second time.

**Reopen when.** One of those three causes harm.

**Incident.** Before the change, the Pages run for v1.6.3 was cancelled during its deploy and the
recovery was a dispatch on `main`. The public demo was therefore built from a commit ahead of the
tag, and "the demo follows the release" did not hold.

## The release build's cache: what was left out

Warming the release cache on `main`, and leaving a prebuilt cargo-about out in favour of the
release path's reliability: [#217](https://github.com/semnil/urx-router/pull/217).

**Turned down.**

- Warming the cache only when `src-tauri/**` changes. A cache entry is dropped after a week without
  being read, and a tag can follow any merge.
- Writing the placeholder license file with `touch`. The Windows runner's default shell has none.
- Stubbing `dist` so the pnpm steps can go. The release also reads the pnpm cache those steps warm.
- A composite action for the two workflows' shared steps. A matrix cannot be folded at job level,
  so it would add an indirection and remove nothing.

## The vd commands are async fn with spawn_blocking

**Decision.** A `vd_*` command that waits for the worker's reply is an `async fn`, and its send
and wait run inside `tauri::async_runtime::spawn_blocking`. A command that waits for nothing, such
as `vd_disconnect`, stays synchronous. The reason — a synchronous command runs on the window's own
thread, so each wait froze the UI — is the comment in `src-tauri/src/lib.rs`.

**Turned down.**

- A generic helper that folds the commands' repeated `spawn_blocking` lines. Its type bound is
  harder to read than the lines it replaces.
- Moving the worker to tokio. An async reply channel would mean moving the link's WebSocket client
  as well, which is more than the freeze needs.

## The first-run consent gate runs after every declaration

**Decision.** `void boot()` is the last statement of `src/main.ts`, after every declaration in the
module.

**Incident.** `void boot()` once ran above the declaration of the constant that names the consent
key. In the desktop app the gate read that constant while it was still uninitialised, which threw;
`boot` rejected with nothing handling it, the gate never appeared, and the app carried on without
consent. In a browser the gate returns before it touches the constant, so the type check, the build
and the browser tests all passed. What separated this from a profile that had already consented was
that the consent flag was absent from the webview's storage.

## The format check verifies and never writes

**Decision (2026-08-11).** `format.yml` verifies the formatting and fails on a difference. It never
pushes to a pull request's branch, and running `pnpm format` before committing is required. The
rule is in `CLAUDE.md` "Conventions"; the reasoning is the workflow's header.

**Turned down.** Keeping the automatic fix-up push alongside required checks, in two forms: pushing
the fix-up with a personal access token or a GitHub App token so that it starts the workflows, and
leaving it as it was and recovering by closing and reopening the pull request when it happened.

**History.** Until then the workflow pushed a formatting commit to a same-repository pull request.
A push made with the repository's own token starts no workflow, so that commit became a head with
no check runs at all: every required context stayed "Expected" and the pull request could not
merge, with nothing in the symptom pointing at the remedy. It happened once.

**`printWidth` is 120.** The three candidate widths were compared by the size of the first
reformat of the existing code: 100, 110 and 120 changed +4361, +2789 and +2009 lines. The code
already favoured long lines, and 120 moved the least.

## Coverage is uploaded once every report exists

**Decision (2026-11-09).** `codecov/project` is a required check, the uploads run in one final
`coverage` job, and Codecov is told to wait for all of them before it reports
([#754](https://github.com/semnil/urx-router/pull/754)). An upload that fails turns the job red on
a pull request and is let through on a push to `main`, so that a failed upload does not hold back
a release. `codecov/patch` is not required.

**Turned down.**

- A `coverage` job that waits for Codecov's result and reports it as its own status, in place of
  adding `codecov/project` to the ruleset.
- Merging the three E2E shards into one upload. The four uploads stay, so the shard names stay
  visible in Codecov.

**Left as it is (2026-11-09).** Two review findings were answered with "as it is":

- A re-run can upload a report twice, and the duplicate can satisfy the count while a report is
  still missing. The uploads stay one per report because the unit and E2E flags need separate
  uploads. On a pull request Codecov does not report while CI is failing, so this is reachable
  only by re-running by hand on `main`.
- The reports are kept as artifacts for one day. That is a hand-off inside one run, not storage;
  past a day the recovery is re-running every job, which rebuilds the reports.

## Windows jobs in ci.yml

**Decision (2026-10-26).** `ci.yml` runs the unit tests, `cargo test` and the Chromium E2E suite on
Windows, and all three are required. The tuning-screen note's layout test judges by the region the
text itself occupies, and the CSS is unchanged. The changes are
[#730](https://github.com/semnil/urx-router/pull/730) and
[#731](https://github.com/semnil/urx-router/pull/731).

**Decision (2026-10-26): Prettier stays LF.** A checkout with CRLF line endings is handled on the
test side: a test that reads the checkout reads it with the line endings normalised, and a
scratch repository a test creates sets `core.autocrlf=false` itself.

**Turned down.** `endOfLine: auto` for Prettier. The format check would then pass a file committed
with CRLF.

## Windows ships NSIS only

Why the MSI was dropped: [#221](https://github.com/semnil/urx-router/pull/221), and
[architecture.md](../architecture.md) "Build and distribution".

**Accepted cost.** `src-tauri/LICENSE.txt` repeats the MIT text the root `LICENSE` already holds.
The installer reads one file and cannot compose two, and a generation step for a few lines of
stable text would cost more than the repetition.

## External fetches in CI

**Decision.** Every E2E job runs in the official Playwright image, and no fetch is retried. Both,
with their reasons, are in the header of `.github/actions/install-browsers/action.yml`.

**Turned down.** Caching the `.deb` files apt downloads. Keeping and restoring apt's archive
directory needs privileged setup on both sides, and Playwright calls apt itself, so no option can
be passed through to it. A fragile CI step costs hands later.

## Dependabot: what merges on its own, and the branches it leaves

Which updates merge on their own is in [architecture.md](../architecture.md) "Build and
distribution" and in the header of `.github/workflows/dependabot-auto-merge.yml`.

**Decision (2026-11-09).** A branch left behind by an automatically merged Dependabot pull request
is deleted by hand. Nothing automates it.

**Why.** The repository's delete-on-merge setting is assumed to act only when the merge is
attributed to a person. When the workflow's token enabled the merge, Dependabot removes the branch
itself in some cases and not in others, and no condition separating the two was found.

**Turned down.**

- A scheduled workflow that deletes such branches with the repository's token.
- Enabling auto-merge with a personal access token. The merge would then start `ci.yml`, `docs.yml`
  and `post-merge.yml` on `main`.

## The recorded macOS platform version is declared in the repository

**Decision (2026-08-16).** The `-platform_version` link argument in `src-tauri/.cargo/config.toml`
states the version the binary records
([#399](https://github.com/semnil/urx-router/pull/399),
[#400](https://github.com/semnil/urx-router/pull/400)). cargo applies it to the release build and
to a host build without `--target` alike, so one edit moves both.

**Turned down.**

- Pinning `DEVELOPER_DIR` in CI. It does not reach the development build.
- Declaring the version and only comparing it. That changes nothing in the binary.

## Ubuntu jobs name ubuntu-26.04

Why the Ubuntu jobs name the image version in place of `ubuntu-latest`:
[#526](https://github.com/semnil/urx-router/pull/526) and
[#540](https://github.com/semnil/urx-router/pull/540).

## The version lives in package.json alone

The release path makes no assumption about the number of digits in a version:
[#405](https://github.com/semnil/urx-router/pull/405).

**Record (v1.13.0, 2026-09-25).** The version in `package.json` reaches every place the bundle
states one. The published asset names, the version in the updater manifest, `CFBundleShortVersionString`
and `CFBundleVersion` in the app's `Info.plist`, and `FileVersion` and `ProductVersion` in the
Windows installer all read 1.13.0. A version bump does not need to check these again.
