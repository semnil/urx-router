# Summary

<!-- What changes, and why. Link the issue this closes, if there is one. -->

## Type

- [ ] Bug fix
- [ ] Feature
- [ ] Performance
- [ ] Documentation
- [ ] Chore / dependencies

## Testing

<!-- Only what this PR's own checks do not already report. The build, the unit tests and
     the ordinary E2E tier run on any PR that is not Markdown/docs-only, and their result
     is in the checks above — do not restate them here.

     The assumptions line is answered, never used to defer. Write each assumption as a
     nested list item opening with the external thing its observation needs — [hardware] a
     reading off the unit, [operator] their own hands, eyes or cursor, [other-checkout] the
     machine this one is not — or answer "none". An observation needing none of the three
     is one to take before opening this, so it has no tag to write. check:pr-assumptions
     reads what is written here whether or not the box beside it is ticked. -->

- [ ] Verified on hardware — model and System firmware:
- [ ] Ran something the checks do not cover — say what and what it showed (a measurement, a
      manual repro, the race harness on a PR touching none of the paths its trigger names):
- [ ] Nothing beyond the checks
- [ ] Assumptions this PR rests on are listed here, each with what would settle it — or "none".
      No check can report the one nobody wrote down

## UI changes

<!-- Before/after screenshots. Remove this section if the pull request changes no UI. -->

## Checklist

<!-- Only what the checks cannot decide. Formatting is not here: the `format` check runs
     Prettier and cargo fmt above, and a merge waits for it. -->

- [ ] E2E coverage added for new behavior
- [ ] `docs/en` and `docs/ja` updated together
- [ ] Routing rule changes: `src/models/`, `docs/*/device-model.md`, and `UPDATE_SKILL=1 pnpm test skill-export`
- [ ] Device parameters are verified against real hardware, not speculative
