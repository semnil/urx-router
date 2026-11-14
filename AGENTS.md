# AGENTS.md — urx-router

## Overview

Routing planning tool for the YAMAHA URX22 / URX44 / URX44V. Based on the official block diagram,
it visualizes inputs/outputs, mixer buses, and output patches as an SVG node graph, constrained so that
**only connectable routes** can be wired. Plans are saved as JSON and exported as images. Device writes
and Live sync are always enabled in the desktop build (vd protocol, `src/core/control/`).

## Tech stack

- Tauri 2 (desktop shell; Windows 11 / Apple silicon macOS)
- TypeScript + Vite (frontend)
- Rendering is plain SVG. **Zero runtime external dependencies**: no npm packages or CDNs in the runtime from outside github.com/semnil. The one runtime dependency is semnil's own LCD simulator `urx-lcd-sim` (the SIM view), a git submodule at `vendor/urx-lcd-sim` that `package.json` links (`link:`) and Dependabot moves to the newest commit of its default branch

## Structure

**What each file is for, and why it is shaped the way it is, lives in `docs/{en,ja}/architecture.md` "Source layout".** This is the map; that document is the reasoning, and it is the layer an edit goes to when the behaviour changes.

- `src/main.ts` — app entry. Wires models/core/ui/i18n together
- `src/models/` — device definitions: the model builder, the URX22/44/44V registry, the new-plan seed
- `src/core/` — logic with no DOM (plan state and codecs, undo history, load validation, constraints, meters, storage, the shell bridge)
  - `src/core/midi/` — external MIDI control (desktop only)
  - `src/core/control/` — live device control (vd protocol); an `--experimental` launch adds the self-test, Compare with device, the `.urxf` import, the SIM view and the link statistics readout
- `src/ui/` — presentation (node graph, CONSOLE, Inspector, tuning screens, undo / redo, MIDI surfaces, modals, SIM view)
- `src/midi-window.ts` — entry of the MIDI control window, a view with no plan of its own; a MIDI input port delivers its bursts to the window that opened it, so a window with no plan must never open one
- `src/app/` — the entry's non-wiring parts, lifted out of `main.ts` so each is drivable without booting the app
- `src/i18n/` — i18n for the app UI. `en.ts` is the baseline, `ja.ts` the translation, `index.ts` the language registry + active-language switcher; runtime language switching (`core/*` is language-independent)
- `src-tauri/` — Rust shell: webview host, file IO, the `vd_*` and `midi_*` commands, the MIDI window's relay, window geometry, the idle-sleep hold, the macOS Edit menu
- `docs/en/` + `docs/ja/` — `device-model.md` (grounding for the routing rules) / `architecture.md` / `known-issues.md` / `console-sends.md` / `channel-tuning.md` / `live-race-harness.md` / `local-runs.md` / `repository-checks.md` / `reusable-assets.md`; each says at its top what it holds. Keep English and Japanese in sync
- `docs/en/decisions/` + `docs/ja/decisions/` — records of closed decisions, one document per subject and one heading per decision (what was decided, why, what was turned down, what would reopen it); read the subject's record before reopening anything in it. The other documents describe the software as it is; a decision's history goes here. The Japanese file keeps the English headings
- The private notes — a separate private repository, not part of this public one, holding the investigation material this project draws on: primary sources, protocol notes and device probes. A checkout of it may sit inside this one, where it is ignored (`.gitignore`)
- `e2e/race/` — the live-sync race harness: design, the fake device's contract, the tiers and how to write a case are in `docs/{en,ja}/live-race-harness.md`
- `scripts/` — the repository's tooling: checks, hooks, generators, benches; the screenshot capture and the CONSOLE render bench are described in `docs/{en,ja}/reusable-assets.md`

## Development

```sh
git submodule update --init   # vendor/urx-lcd-sim — empty in a fresh clone or worktree; run before pnpm install
pnpm install
pnpm dev          # browser http://localhost:5173 (no Rust required)
pnpm tauri dev    # desktop app (Rust required; install via rustup if missing)
pnpm build        # tsc --noEmit + vite build
pnpm build:demo   # browser demo build (VITE_DEMO=1; excludes save/image export)
pnpm preview      # serve the built dist/ at http://localhost:4173 (browser check of a build:demo bundle)
pnpm e2e:serve    # vite build + preview on 4173 — what playwright.config.ts launches as its webServer (E2E_PORT overrides)
pnpm e2e:serve:trace # e2e:serve --trace: serves dist-trace on E2E_TRACE_PORT, 4174
pnpm e2e:worktree # the suite in a throwaway worktree on its own port pair, beside another checkout's run
pnpm sync:merged  # after a merge: fast-forward the default branch, remove the merged worktree and branch. Reports; `--apply` acts (Conventions)
pnpm test         # vitest: the unit suite, the app entry, the contract and pin tests docs/{en,ja}/reusable-assets.md lists, and scripts/**/*.test.mjs
pnpm test:coverage # the same unit suite with V8 coverage; writes coverage/lcov.info for Codecov
pnpm typecheck:e2e # tsc -p tsconfig.e2e.json — type-checks e2e/ + the root config .ts (playwright/vite/vitest)
pnpm test:e2e     # Playwright E2E, all three projects at once. No CI job runs this — each tier is its own
pnpm test:e2e:app # --project=chromium: e2e/*.spec.ts only. The PR tier, in ci.yml
pnpm test:e2e:app:webkit # --project=app-webkit: the @webkit-tagged app cases in WebKit. Its own job in ci.yml
pnpm test:e2e:coverage # the same ordinary Chromium tier with native V8 coverage remapped to coverage/e2e/lcov.info
pnpm test:e2e:race        # --project=race: the race harness (e2e/race). `--shard=1/3` splits it, NO `--` before it; not CI's shard k
pnpm test:e2e:race:webkit # --project=race-webkit: the @webkit-tagged race cases in WebKit
pnpm build:trace  # production-shaped bundle carrying the trace probe (VITE_TRACE=1) into dist-trace/
pnpm format       # Prettier --write on the file list check:comments scans (scripts/format.mjs; printWidth 120)
pnpm check:md     # Markdown table integrity (a note pasted mid-table silently swallows the rows after it)
pnpm check:assets # docs/en/reusable-assets.md "The asset index" + docs/{en,ja} vs the repo, in both directions
pnpm check:comments # no source comment records where a fact CAME FROM: a `(measured)` appositive, a sentence naming the method, a capture date; `scripts/comment-provenance-baseline.json` is its per-file ceiling
pnpm check:pr-assumptions # the PR body's assumptions field (`PR_BODY` or `--file <path>`): every item tagged and settled under a `Result` entry
pnpm check:gates  # every required context reportable on every PR, step bounds on external fetches, the Codecov upload count; `--ruleset` diffs the live ruleset (admin `gh`)
pnpm check:skips  # every permanently skipped race case is registered in e2e/race/skip-ledger.json, and every spec file still collects at least the floor that ledger names
pnpm check:platform "<binary>" # macOS only: the platform version a built Mach-O records against src-tauri/.cargo/config.toml
pnpm verify:release-draft --tag <vX.Y.Z> --latest <path to latest.json> # verify a release draft's updater manifest
pnpm bench:meters # CONSOLE render bench in Playwright WebKit (--tree <git worktree> measures an older revision the same way)
cargo test --manifest-path src-tauri/Cargo.toml  # the shell's own tests — `cargo check` does NOT compile #[cfg(test)]
cargo fmt --manifest-path src-tauri/Cargo.toml   # the Rust half of the `format` check — nothing applies it for you (Conventions)
pnpm clean        # remove the Vite cache (node_modules/.vite) + dist + dist-trace + Cargo target
pnpm reset:storage # clear the dev app's (browser) localStorage = opens the ?reset URL
```

**Where the detail is.** The procedures around these commands — resetting the dev app's stored state, what a launch flag prints, whether the dev app is up, stale caches, the E2E ports, `pnpm e2e:worktree`, the post-merge cleanup — are in `docs/{en,ja}/local-runs.md`; what each check and test tier holds, and why it is shaped that way, is in `docs/{en,ja}/repository-checks.md`. Read the section for a check before changing the check, its pins or its hook.

**Launch flags run headless against real hardware** — `pnpm tauri dev -- -- --experimental --self-test` (both flags: the self-test's auto-run is nested inside the experimental gate), `-- -- --prepare-modified`, `-- -- --reset-storage`. A packaged build takes them as `open -a 'URX Router' --args --experimental` / `urx-router.exe --experimental`. **`--self-test` and `--prepare-modified` wait for the first-run consent gate** and write nothing until it is accepted. **What editing sources while a run is writing to real hardware does here** (the global `CLAUDE.md` owns the rule): an HMR reload is a page load, and each page load starts another destructive sweep over the one already running; a sweep killed before its restore leaves the unit perturbed, unrecoverably. Stop the app before editing.

**The dev app being up is a process, not a log line.** Ask `node scripts/check-startup-wait.mjs --pid <tree>`: it prints this tree's `urx-router` PID, exits 1 while there is none and 2 when it cannot tell, and with `--wait`, run in the background, exits 0 with the PID once the app is up. Never wait on the dev server's log or `pgrep -f` the binary — a `PreToolUse` hook refuses both. Why, and the hook: `docs/{en,ja}/local-runs.md` "Whether the dev app is up".

Node in the range `package.json` `engines` declares is required (`pnpm test node-engines`), and `src-tauri/Cargo.toml`'s `rust-version` is held by `cargo test --manifest-path src-tauri/Cargo.toml --test rust_version` (`src-tauri/tests/rust_version.rs`). Why those ranges, and the browser floor: `docs/{en,ja}/architecture.md` "Tech stack and rationale".

E2E runs against a production build served on port 4173 (and the `race` / `race-webkit` projects against a trace build on 4174), and `reuseExistingServer` is on locally: a server left on either port — a `pnpm preview`, or a **second checkout's** run — is reused as-is, silently testing the wrong bundle. Stop it first; a second checkout runs `pnpm e2e:worktree`.

**Stopping a process follows the rule in the global `CLAUDE.md`** (ownership read from `ps` / `lsof`, then the PID). What a pattern catches here: `pkill -f "playwright test"` matches another checkout's run, a wide `pkill -f vite` matches the operator's own `pnpm tauri dev`.

The version lives in `package.json` alone. A version bump touches that one file, **in a pull request that carries nothing else** (`chore(release): X.Y.Z`; the global rules' `start-here.md`). **Merging that PR is the release, and nothing else is.** **A fix never rides on the bump.** When the bump's own checks go red on something already on main, the fix merges first as its own pull request, the bump is rebased onto it, and what was verified before the rebase — the checks, and anything read for the pull request body — is taken again on the rebased tree. **A person publishes the draft Release** (the global rules' `rules-ci.md`); automating the publish means giving `pages.yml` an explicit dispatch in the same change. Before touching `tag-release.yml`, `release.yml` or `pages.yml`, read `docs/{en,ja}/architecture.md` "How a release fires" and "Browser demo (GitHub Pages)".

**A local verification names every run a pull request is gated on**: `pnpm test`, `pnpm test:e2e:app`, `pnpm test:e2e:app:webkit`, `pnpm test:e2e:race`, `pnpm test:e2e:race:webkit` and `cargo test`, with `pnpm build`, `pnpm typecheck:e2e`, `pnpm format` + `cargo fmt` (no diff), `pnpm check:skips`, `pnpm check:md`, `pnpm check:assets`, `pnpm check:gates`, `pnpm check:comments` and `pnpm check:pr-assumptions` beside them. A run that was left out — the two race tiers are the long ones — is named as left out in the report.

**What a merge waits for.** The branch ruleset on `main` requires `ci-required`, `docs-required`, `format`, `race-required`, `auto-merge` and `codecov/project`; `.github/required-checks.json` is the only copy outside GitHub's settings and `pnpm check:gates --ruleset` the only comparison. A workflow change keeps these (the global rules' `tools-ci-github.md` and `rules-ci.md`): **every pull-request workflow triggers unfiltered; a path-dependent skip is a job condition**; **a gate is an `if: always()` job that reads `needs.*.result` and waits for every job in its workflow**; **nothing in CI writes to a pull request's branch**; **every job, and every step that fetches from outside GitHub, carries a `timeout-minutes`**; third-party actions are SHA-pinned; `codecov/project` stays required only while its uploads run on every pull request and a failed upload fails its job, and `codecov/patch` stays out; **enabling a merge queue adds the `merge_group` trigger in the same change**. Why, and what each workflow runs: `docs/{en,ja}/architecture.md` "Build and distribution" — read it before changing a workflow.

## Reusable assets

**Nothing needs to be built again.** Before writing a harness, probe, generator, fixture or pin test, read `docs/{en,ja}/reusable-assets.md` "The asset index" — what the repository already carries, and when to reach for each. `pnpm check:assets` holds its English table to the tree both ways: adding, renaming or removing an asset edits its row there, and the Japanese row with it. Extend a fixture rather than forking it; add a case to a contract or pin test rather than a new test file. **A fixture row is compared with the fixture by hand after a pull request adds a public call to it**: only an inventory row (rule E3) is held to naming every export.

Commands the index holds:

```sh
node scripts/capture-screenshots.mjs          # docs screenshots, after pnpm build:demo
node scripts/gen-icon.mjs                     # the icon source; then pnpm tauri icon scripts/app-icon.png
python3 .claude/skills/urx-routing-planner/scripts/plan_tool.py validate <plan.json>  # a plan or a ?plan= link
URX_VITEST_WORKER_LOG=<file> pnpm test        # names the file a vitest worker died in (macOS / Linux)
node scripts/race-shard-weights.mjs <run id>  # re-derive the race shard weights from a CI run
UPDATE_PWSH=1 pnpm test check-comment-provenance  # regenerate scripts/pwsh-boundaries.json
```

Rules inside the index:

- Choose a `<select>` option only through `e2e/choose-option.ts`, and reach the Insert FX section through `e2e/insert-fx-section.ts`; assert a scroll container reachable only with `scrollsByWheel`, and anchor a colour to a theme token with `colorToken` (`e2e/fixtures.ts`).
- `e2e/tauri-stub.ts`: a change on the unit's own panel is `setDeviceValue` then `notifyParam`; wait on the flow's terminal state or `untilAnswered` before reading `writesOf` / `dialogsOf`, never on a fixed wait. Race cases wait with `settleValue`; copy the installed `__midiTest` / `__dynTest` object rather than invent a third stub shape.
- Select a node only after the open in a save → new → open round trip; a gesture that must move no value is a mis-grab of a node, not a press on a fader cap.
- Call `src/core/settings-reset.test-util.ts` at the top level of a suite that writes preferences, ahead of any case that clears storage; a main.device file imports `src/main.device.test-util.ts` and waits on `flowInvokes`. A permanent race skip's guard is a unit test.
- Reading the real webview on Windows: drive the DevTools socket yourself, never through `connectOverCDP`, and arm the capture before asking the operator to click.

## Conventions

- **Layers** (the one-layer rule in the global rules' `rules-documents.md`): the global rules — `~/.claude/CLAUDE.md` and the documents under `~/.claude/docs/` it points to — are the source of truth wherever this file declares no override; **this file** owns this repository's process rules and its overrides of the global rules; `docs/{en,ja}/` own anything that is really a statement about how the software behaves
- **`pnpm format` has no file list of its own**: `scripts/format.mjs` formats what `check:comments` scans, so neither list is narrowed alone, and YAML is deliberately left out — reformatting it would be the formatting-only diff the global rules' `rules-coding.md` forbids. **Measure before quoting a conformance claim**: away from this tree Prettier defaults to `printWidth` 80. Why: `docs/{en,ja}/repository-checks.md` "`pnpm format`"
- **Required**: run `pnpm format` (+ `cargo fmt` for Rust changes) before committing. `format.yml` verifies both and fails on the diff, and `format` is one of the contexts a merge waits for. Nothing applies the formatting for you: CI never writes to a pull request's branch, so the workflow verifies and never writes; the reasoning is in the workflow header and in `docs/{en,ja}/architecture.md` "What a merge waits for"
- A note pasted between rows of a Markdown table ends it (the global rules' `rules-documents.md`); **restate the header + separator row** to resume the table. `pnpm check:md` and the `PostToolUse` hook in `.claude/settings.json` (`scripts/md-hook.sh`, which finds node through `scripts/hook-node.sh`) catch it; what else that hook runs is in `docs/{en,ja}/repository-checks.md` "The edit-time hooks"
- **Every string in `src/i18n/en.ts` carries one of three markers, and `Messages` is derived from them** — `dev()` a control reproduced from one of the unit's own screens, `fixed()` identical for a reason that is not the device, `tr()` this app's own copy. No check can tell whether the choice is true, so the author states it in the PR. How the markers work, and which rows are the unit's: architecture.md "Localization (i18n)"
- **Override of the language rule in the global rules' `rules-documents.md`**: English is the base language of this repository's documents. This file is written entirely in English and has no Japanese counterpart; every document written for readers keeps its English text at its own path and its Japanese counterpart in a separate file beside it — `README.ja.md`, `CONTRIBUTING.ja.md`, `SECURITY.ja.md` and `CODE_OF_CONDUCT.ja.md` next to their English files, `docs/ja/` next to `docs/en/` — kept section for section and cross-linked at the top
- **When changing routing rules, keep `docs/{en,ja}/device-model.md` and `src/models/` in sync** (the official block diagram is the primary source). After changing `src/models/`, also regenerate the data bundled with the `urx-routing-planner` skill (`.claude/skills/urx-routing-planner/scripts/models.json` + `.claude/skills/urx-routing-planner/references/model-*.md`) via `UPDATE_SKILL=1 pnpm test skill-export` and commit it (generator: `src/models/skill-export.ts`; drift is caught in CI by `skill-export.test.ts`). **A rule the tool needs in order to give the app's answer is generated from the catalog into that data, not transcribed into `plan_tool.py`** — `channelPairs`, `insertFxParamSpace` and `fxChannels` are in `models.json` for that reason, and a transcribed copy drifts. **When the `?plan=` link format changes, both ends change in the same change**: `decodePlanParam` in `src/core/plan.ts` and `encode_plan_param` in `plan_tool.py` (the two forms: `docs/{en,ja}/architecture.md` "Browser demo (GitHub Pages)")
- **The skill's hand-written half goes stale in silence**, since no check knows the contract it describes (`docs/{en,ja}/repository-checks.md` "What no check covers: the skill's hand-written half"). Update `SKILL.md`, `references/plan-schema.md` and `references/device-apply.md` inside the same change as any of these **six**: (1) the plan document's shape; (2) a new `NodeParams` key; (3) a claim about a parameter's stability; (4) the load-time gates `plan_tool.py` mirrors; (5) the write UX; (6) "available in a future release" wording. Semantic constraints that never appear in the route table (pre/post-fader, duckers) cannot be generated, so the hand-written feasibility notes are their only carrier
- **The skill's two manifests are versioned by hand and nothing reads them**: bump `version` in `.claude-plugin/marketplace.json` and `.claude/skills/urx-routing-planner/.claude-plugin/plugin.json` in the same change that alters `SKILL.md`, `references/` or `scripts/`
- Keep the theme palettes in sync between the CSS variables in `src/style.css` and `PALETTES` in `src/ui/graph.ts` — architecture.md "Display themes" enumerates what has to correspond; `pnpm test palette.contract` holds the pairs
- **The design system — every token, component recipe, canvas constant and copy rule, rendered as live specimens in the app's own CSS — is a Claude artifact, not a repository document** (its link is kept in the private notes, since this repository is public and the artifact is not). It is a *copy*: `src/style.css` and `src/ui/graph.ts` stay the source of truth, so a token or recipe change has to reach the artifact in the same change or it goes stale in silence. Read it before adding a surface, and before inventing a button / chip / fader / modal that an existing recipe already covers
- **Documentation writes no control-protocol parameter number and no raw value** — the documents under `docs/`, this file and the READMEs. It names an item the way the unit's screen, its user guide or the app's UI names it, and where the unit gives the item no name it says what the item does. The numbers are written in the source, with its tests and comments; the bundled skill's description of the plan file's own shape is outside this rule. Routing rules and the level_gain grid may be written in the documentation. It extends the rule in the global rules' `start-here.md` that keeps real identifiers out of public documents
- **Write only confirmed parameters — confirmed means verified on the unit itself**, by writing a value and reading the result back from the hardware, not inferred from a static descriptor and not read off a broker dump (why: architecture.md "Source layout", `params.ts`). Never add a speculative address to `params.ts`
- **A claim that acquires a "provided that" is a new verification item, from the moment the clause appears** (the global rules' `rules-coding.md` owns the rule: measure every item that can be measured, then raise the rest to the operator with what would settle it, within the session). `UNVERIFIED_MAPPINGS` in `src/core/control/translate.ts` registers each guess for the self-test (architecture.md "Source layout", `selftest.ts`); an entry settles nothing — a verdict is a measured result, and the item stays undecided until the operator has answered it
- **When adding features or changing the UI, add E2E coverage to `e2e/*.spec.ts`**, with the proof the global rules' `rules-verification-testing.md` asks for (the new case fails on the commit before the change; a guard fails under mutation) from a local run of those cases — the rest of the ordinary tier is the pull request's own CI. **A LAYOUT invariant (a constrained window still holds its layout) is tagged `@webkit` as well**; `pnpm test webkit-tier` holds the floor. The race harness runs on every pull request whose diff is not documentation alone; `pnpm test:e2e:race` or `gh workflow run race.yml --ref <branch>` pulls a verdict forward. **`race-required` being green does not say the harness ran** — `detect`'s log does. The tiers, `detect` and what `pnpm check:skips` catches: `docs/{en,ja}/live-race-harness.md` "Where each tier runs".
- **`src/core/` does not import `package.json`.** Vite resolves the import, but an E2E spec that imports that core module loads it through Node's ESM loader, which fails with `needs an import attribute of "type: json"` while the spec file is loading, so the run ends before its cases start. A core module that needs a value from `package.json` is handed it as an argument by the shell side; `src/main.ts` and `src/ui/prefs.ts` are where the import lives
- An item only the other checkout can settle is handed over as the global rules' `rules-coding.md` describes: the change that waits goes on its own branch and pull request, whose body carries a procedure that can be run on its own and how to read its result, and it stays open until the result is in
- **Every dialog, window, menu and popover shows everything its messages say it does, and that stays at 100%.** `e2e/inventory.spec.ts` derives the expected set from the message catalog, so adding a message obliges some surface to display it, or one of the four escapes written down in that file (`elsewhere`, `neverShown`, `viaAttribute`, `composed`); `OUT_OF_SCOPE` grows under the exclusion-list rule in the global rules' `rules-verification-testing.md`. The guard answers presence, not layout (`docs/{en,ja}/repository-checks.md` "The displayed-item inventory")
- `*.audit.test.ts` (`src/core`, `src/core/control`, `src/core/midi`, `src/models`) pin current behavior found during robustness audits (`AUDIT:` comments). When intentionally changing that behavior, rewrite the matching audit test as a set — do not delete it or leave it failing — so the pin tracks the fix
- **On the device link, a failed operation aborts the whole operation**; everything outside that link — MIDI feedback, port restore, file IO — keeps the softer rule of salvaging what can be salvaged, but never in silence. The call sites, the read paths that draw the line differently, and the **four permanent exceptions** are in architecture.md "Aborting on failure". Read that exception list before proposing one: all four are closed decisions
- Where a setting change makes the **device itself** switch what a value reflects, let it: subscribe or read, and do not model the switch in the app. Implement follow only where the device does not — and decide which of the two cases applies by **measuring** the change's effect on the *other* params and readouts, especially those downstream of the one being operated, before writing either. The two cases, why they must not be conflated, and the worked examples are in architecture.md "What the app models, and what it leaves to the unit"
- **A write is refused only for a reason the unit or the operator gives**: where the unit cannot take the value or does not offer it, or where the operator has decided that two writers must not meet. A restriction with neither basis is a defect (architecture.md "Live control connection", "SIM view (the unit's LCD)")
- Commits follow Conventional Commits. Their language, and who decides commit / push / PR / merge, are in the global `CLAUDE.md`
- **The release notes are generated from the merged pull request titles** — `release.yml` creates the draft with `generate_release_notes: true` — and this repository carries no changelog file. A PR title is therefore user-facing text on the Release page, not only an internal convention
- **A pull request body follows `.github/PULL_REQUEST_TEMPLATE.md`.** `gh pr create --body` / `--body-file` **replace** the template, so reproduce its sections; tick a box only for something that actually ran, and keep the unticked ones with a short reason beside them; name the model and System firmware on the hardware-verification line. **The assumptions field is answered, never used to defer**: each item opens with `[hardware]` / `[operator]` / `[other-checkout]`, is settled with the operator before the pull request is opened unless the operator explicitly instructed opening it with the item open (the global rules' `rules-coding.md`), and carries its `Result` entry (`pnpm check:pr-assumptions`; `docs/{en,ja}/repository-checks.md` has why)
- **A change that adds a row or a toggle to a panel runs the whole of `pnpm test:e2e:app` before the pull request**, not the specs of the feature alone. A spec elsewhere can depend on the order of a panel's rows: `e2e/nodeoff.spec.ts` expects the first toggle in the inspector to be Channel ON. `docs/en/decisions/development-process.md` "What to run before a pull request" has what happened
- **A pull request that changes behaviour the race harness pins runs those race specs before it is opened.** Search `e2e/race/` for the name of the control or parameter the change touches, and for the observables the changed rule acts on — the undo depth, the nothing-to-undo answer, a comment stating that the history is reset — and run each spec that matches with `pnpm e2e:worktree -- --project=race <spec>`. After rewriting a pin, put the old behaviour back once and see the case fail. The race job is not part of the ordinary tier, so a run of `pnpm test:e2e:app` does not show these
- **Once a pull request merges, the cleanup in the global rules' `start-here.md` applies** — the branch, its worktree, and fast-forwarding the local default branch — and `pnpm sync:merged` is the three steps under one command. Run it from the checkout that holds the default branch, from a shell whose working directory is outside it: `pnpm -C <that checkout> sync:merged --apply`. A worktree it keeps is one it lacked the evidence to remove: sort it by what it holds before removing it by hand (`docs/{en,ja}/local-runs.md` "After a merge: `pnpm sync:merged`"). **On Windows, unlink a linked `node_modules` first**: Git for Windows deletes through a junction

## Primary sources

- Block diagram (`MWEM-D0`): <https://download.yamaha.com/download/files/2927153/>
- User guide (HTML): <https://manual.yamaha.com/audio/music_audio_production/urx44_urx22/ug/en-US/>
- Official control software: TOOLS for MGX / URX (the control-protocol analysis source behind `src/core/control/`; analysis complete)

**Where the line is.** Observing the protocol from outside — sending a request and recording what comes back — is the permitted route, and it is what all of `src/core/control/` stands on. **Reading a distributed binary is not.** Do not analyze the bundled firmware image or an application binary, and do not propose it, even when a missing enum label, string table or value catalogue makes it the obvious next step; fill those from device observation instead (write, then confirm on the LCD; notify reverse-mapping; snapshot diff) and from the primary sources above. Data already obtained the other way stays where it is, but **its provenance is written in no document, public or private** — which means it has to be kept in a form justifiable from hardware evidence alone, and re-verified that way.
