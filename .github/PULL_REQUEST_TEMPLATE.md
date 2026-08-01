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
     the ordinary E2E tier run on every PR and their result is in the checks above — do
     not restate them here. -->

- [ ] Verified on hardware — model and System firmware:
- [ ] Ran something the checks do not cover — say what and what it showed (the race harness
      on a PR that is not a version bump, a measurement, a manual repro):
- [ ] Nothing beyond the checks
- [ ] Assumptions this PR rests on are listed here, each with what would settle it (a measurement,
      a probe, a device read) — or "none". No check can report the one nobody wrote down

## UI changes

<!-- Before/after screenshots. Remove this section if the pull request changes no UI. -->

## Checklist

<!-- Only what the checks cannot decide. Formatting is not here: format.yml applies it
     to a same-repo PR itself and reports above. -->

- [ ] E2E coverage added for new behavior
- [ ] `docs/en` and `docs/ja` updated together
- [ ] Routing rule changes: `src/models/`, `docs/*/device-model.md`, and `UPDATE_SKILL=1 pnpm test skill-export`
- [ ] Device parameters are verified against real hardware, not speculative
