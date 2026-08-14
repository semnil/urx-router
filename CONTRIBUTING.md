# Contributing

> 日本語版は [CONTRIBUTING.ja.md](CONTRIBUTING.ja.md) を参照してください.

URX Router is maintained by one person, but outside help is welcome — especially anything
involving real hardware, since most of the tool is grounded in measurements rather than in
published documentation.

Security problems go through [SECURITY.md](SECURITY.md), not the issue tracker.

## Ways to help

- **Verify behavior on a unit you own.** The URX22 meter mapping landed exactly this way
  ([#173](https://github.com/semnil/urx-router/pull/173)). Reports from a URX22 or URX44 are
  especially useful: most parameters were confirmed on a URX44V.
- **File an issue** using the bug report or feature request template.
- **Send a pull request.** For anything touching routing rules or device control, open an
  issue first — those changes need hardware evidence, and it is better to agree on the
  evidence before you write the code.

## Setup

Node >= 21.2 (the `?plan=` codec needs `CompressionStream("deflate-raw")`), pnpm, and — for the
desktop shell only — Rust via rustup.

```sh
pnpm install
pnpm dev           # browser at http://localhost:5173, no Rust required
pnpm tauri dev     # desktop app
```

| Command | What it does |
| --- | --- |
| `pnpm build` | `tsc --noEmit` + Vite build |
| `pnpm test` | unit tests (vitest) |
| `pnpm test:e2e` | Playwright E2E against a production build on port 4173 |
| `pnpm typecheck:e2e` | type-checks `e2e/` and the root config files |
| `pnpm format` | Prettier over the TypeScript sources |
| `pnpm check:md` | Markdown table integrity |
| `pnpm check:skips` | every permanent skip in `e2e/race` is registered against what holds its reason |
| `pnpm build:demo` | browser demo build (no save dialog or image export) |

## Conventions

- Identifiers and comments in English. Comments describe behavior, not history.
- Keep diffs minimal and match the surrounding style. Formatting-only changes are not accepted
  on their own.
- **Zero runtime external dependencies** — no npm packages or CDNs in the shipped app. Dev
  dependencies are fine.
- Run `pnpm format` (and `cargo fmt` for Rust changes) before committing. `format.yml` runs
  both and fails on the diff; it does not write anything back to your branch.
- Keep the theme palettes in `src/style.css` and `PALETTES` in `src/ui/graph.ts` in sync.
- **Every string in `src/i18n/en.ts` is wrapped in `dev()`, `fixed()` or `tr()`, and a new key
  has to pick one.** `dev()` is a control reproduced from one of the unit's own screens: the URX
  is English on those screens whichever of its three display languages is selected, so every
  catalogue repeats the same characters and `ja.ts` will not compile with a translation. `fixed()`
  is identical for a reason that is not the device (only the CONSOLE strip group separators, which
  are set in vertical writing mode where a full-width glyph moves the rack's geometry). `tr()` is
  this app's own copy — headings, the legend, hints, status and error text — and each language
  supplies its own wording. Leaving a string unwrapped fails the compile with a message naming the
  file. Which of the three a key takes is a judgement the type system cannot make for you, so say
  which you chose in the pull request; `docs/en/architecture.md` ("Localization" → Terminology)
  lists what has been read off the hardware.

## Tests

`pnpm test` covers the core, the device control layer, the models, the UI, and the app entry —
including its desktop half, which runs against a stubbed Tauri shell because `isTauri()` gates
the whole device layer and nothing else can reach past it.

The hosts and stubs those suites run in are shared, not per-file: they carry a `*.test-util.ts`
suffix (vitest collects only the test files themselves, so a search for tests misses them) and
CLAUDE.md indexes every one under "Reusable assets". Extend one rather than writing a second.

**Feature and UI changes need E2E coverage in `e2e/*.spec.ts`.** Writing the test is what is
asked; running it locally is not. The pull request's own CI runs the ordinary E2E tier and
reports a failure on the pull request, which is where it gets read — so run whatever you find
useful before pushing, at your own judgement.

E2E runs against a production build on port 4173 and reuses an existing server locally, so stop
any `pnpm preview` you left running first — otherwise it silently tests the wrong bundle.

`*.audit.test.ts` files pin behavior found during robustness audits. If you intentionally change
that behavior, rewrite the matching test as a set; do not delete it or leave it failing.

## Documentation

`docs/en/` and `docs/ja/` are kept in sync, and diagrams use Mermaid.

A note pasted between the rows of a Markdown table ends the table: every row after it is
absorbed into that paragraph and stops rendering. Keep the note where it belongs, and restate
the header and separator row to resume the table. `pnpm check:md` catches this.

## Routing rules

The official block diagram is the primary source. Changing the route table means updating
`src/models/` and `docs/{en,ja}/device-model.md` together, then regenerating the data bundled
with the Claude skill:

```sh
UPDATE_SKILL=1 pnpm test skill-export
```

CI diffs the generated files, so an out-of-date bundle fails the build.

## Device control

`src/core/control/` writes to real hardware, which sets three hard rules:

- **Only confirmed parameters.** Every address and encoding must be verified against a
  connected device. Never add a speculative address to `params.ts`.
- **A failed operation aborts the whole operation.** There is no partial success on the device
  link: an unreadable parameter is not written, a partial readback does not start Live sync,
  and a send stops at the first failure.
- **Say what you verified on.** Name the model and the System firmware version in the pull
  request.

## Commits and pull requests

- Conventional Commits, **subject and body in English**, split by semantic unit.
- **Pull request title and body in English** as well.
- Include before/after screenshots for UI changes.
- Pull request CI runs the build, `pnpm typecheck:e2e`, `pnpm check:skips`, the unit tests,
  the ordinary E2E suite and `cargo test` — work that is skipped, as a rule, on a Markdown/docs-only pull
  request. The exception is the skill's generated model references
  (`.claude/skills/urx-routing-planner/references/model-*.md`): they are Markdown, but they
  are diffed against their generator, so they run it too. Third-party license generation
  runs after merge. The live-sync race harness runs on a pull request whose diff touches
  `src/`, `e2e/` or `playwright.config.ts`, and on the one that changes the version —
  about seven minutes, in parallel with the rest.
- The document and configuration checks run on **every** pull request regardless — Markdown
  table integrity, the reusable-assets index and `pnpm check:gates`.
- A merge waits for `ci-required`, `docs-required`, `format` and `race-required`. Each
  reports on every pull request, so a change that skips the work behind one of them still
  gets a green check rather than a check that never arrives. `pnpm check:gates` is what
  keeps that true; run it after editing anything under `.github/workflows/`.

By contributing, you agree that your work is licensed under the [MIT license](LICENSE).
