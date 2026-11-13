# Decisions: the development process

> 日本語版: [../../ja/decisions/development-process.md](../../ja/decisions/development-process.md)

Closed decisions about how work on this repository is carried out — scratch files, the instruction
file, release pull requests, estimating, and what is run before a pull request — with what happened
that led to each.
The rules themselves are in `CLAUDE.md` "Development" and "Conventions"; this document holds the
reasoning those do not. "The operator" below is the person who directs this project's work and
decides for it.

## `work/` stays out of `.gitignore`

**Decision (2026-09-04).** `work/` is not added to `.gitignore`; its contents are deleted instead.
The operator decided this, and adding the line is not proposed again. Where a scratch file goes instead is in [local-runs.md](../local-runs.md), "Scratch files
under `work/`".

## The instruction file is tracked as `AGENTS.md`

**Decision (2026-11-13).** The project instructions are one tracked file, `AGENTS.md`, and no
`CLAUDE.md` is kept beside it. The operator decided this. It reopens the entry of 2026-08-21 that
kept `/AGENTS.md` in `.gitignore`: that file was then a per-machine rendering of `CLAUDE.md` for
another tool, and tracking it would have made one rule two texts. With a single file there is one
text, so the ignore entry is removed.

## Release pull requests

**Decision.** A release pull request changes the version and nothing else, and its body is copied
from the previous release pull request with every number taken again on the new range. The set of
measurements, and the form of the body, are in the latest one,
[#752](https://github.com/semnil/urx-router/pull/752).

Two of those measurements decide what the release is called and what its body has to say:

- **Patch or minor is read from the commits, not from the pull request titles.**
  `git log --no-merges --format=%s v<previous>..origin/main` is searched for `feat`. In one range
  the titles were fixes, documents and dependencies, and two `feat` commits sat inside a combined
  pull request.
- **`PLAN_VERSION` is compared across the range** (`git diff v<previous>..HEAD -- src/core/plan.ts`).
  When it has moved, a plan saved by the new version cannot be opened by the previous one, and the
  body says so; when it has not, the body says plans open in both directions.

**Incident.** The 1.12.0 release ([#486](https://github.com/semnil/urx-router/pull/486)) was a
one-line diff. Its review was given the publishing path and the range of merges the release would
ship as well as the diff, and what it found was outside the diff: `PLAN_VERSION` had been raised
within the range, so a plan saved by 1.12.0 would be refused by 1.11.0 as
`planVersionUnsupported`, and the body did not say it. The old value was read from the previous
tag before the finding was taken. Since then the comparison is one of the measurements and does
not wait for a reviewer to notice.

## Estimating a change to a shared path

**Decision.** A change to a path that several features go through — the MIDI engine's apply, the
write funnel's mirror — is not estimated as one fix. The first fix can make reachable a state that
was not reachable before.

**Incident.** Four change requests in a row arrived on one mechanism, the MIDI gang, from external
review ([#457](https://github.com/semnil/urx-router/pull/457),
[#458](https://github.com/semnil/urx-router/pull/458),
[#459](https://github.com/semnil/urx-router/pull/459),
[#460](https://github.com/semnil/urx-router/pull/460)). None was turned down: each reproduced when
measured and each was a real defect. In order they form layers — a mirror is added; the order of a
gang's writes then decides the result; the unlocking direction alone is fixed; the locking
direction remains; mirror equivalents are collapsed; the collapse crosses an address boundary.
Three of them were made by the fix just before: adding the mirror created the dependence on order,
collapsing created the crossing, and a version keyed on the mirror's identifier alone had never
collapsed anything. When a coupling defect is being fixed by adding a coupling, the fix is checked
for being the next one.

## What to run before a pull request

**Decision.** Two rules in `CLAUDE.md` "Conventions" came from the incidents below: a change that
adds a row or a toggle to a panel runs the whole of `pnpm test:e2e:app` before the pull request,
and a change to behaviour the race harness pins runs the race specs that name it.

**Incident.**

- A row was added to the inspector, and the E2E run before the pull request was three spec files.
  Another, `e2e/nodeoff.spec.ts`, counts on the first toggle in the inspector being Channel ON,
  and it failed the required check ([#609](https://github.com/semnil/urx-router/pull/609)).
- On the same pull request, the merge instruction was answered by enabling auto-merge, and a
  question — whether to fill the uncovered lines of the patch — was raised to the operator
  immediately after. By the time the answer came the pull request had merged, and the tests went in
  as a separate one ([#610](https://github.com/semnil/urx-router/pull/610)). A question that is
  still open is settled before auto-merge is enabled, or the merge waits.
- Twice a change to behaviour the race harness pins was opened without a race run on the
  development machine, and the race job turned red in CI. What the cases had pinned is in
  [#611](https://github.com/semnil/urx-router/pull/611) and
  [#678](https://github.com/semnil/urx-router/pull/678).
