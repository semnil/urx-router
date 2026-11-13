# Decisions: the test suite

> 日本語版: [../../ja/decisions/test-suite.md](../../ja/decisions/test-suite.md)

Closed decisions about how the tests are built and run: what was decided, why, what was turned
down, and what happened that led to it. The rules a change has to follow are in `AGENTS.md`
"Development" and "Conventions", and the race harness has its own document,
[live-race-harness.md](../live-race-harness.md); this document holds only the reasoning that
those do not.

## The displayed-item inventory

**Decision (2026-08-06).** `e2e/inventory.spec.ts` derives what each dialog, window, menu and
popover must show from the message catalog, and drives each surface through its states. The rule
itself, and the four escapes a message can take, are in `AGENTS.md` "Conventions".

**Incident.** When MIDI control moved out of an overlay panel into a window of its own, the legend
card of its Behavior column was dropped together with the panel. The two messages it showed
(`modeDesc` and `buttonModeDesc`) stayed in the message catalogs, read by nothing, through several
later revisions. Every test was green throughout.

**Why.** Measured on the ordinary E2E tier before the work started: 76 of the 202 strings a dialog
shows were asserted by some case (37.6%). No spec covered the consent gate, since every spec skips
it through `localStorage`, and the File and View menus were opened and closed without their items
being read. The 173 `toBeVisible` assertions that existed looked at behaviour — a lock, a value,
something opening — and none of them at an item being listed.

**Turned down.**

- **A list of the expected items per surface, written in the spec.** A change that drops an item
  from a surface removes it from that list in the same edit, so the list cannot catch this kind
  of defect.
- **Building the set to check from what the surfaces declare.** A namespace that no surface names
  is then invisible instead of unclaimed: built that way, the check saw 272 of the catalog's 681
  leaves (40%). The set is the whole catalog, and what is outside the check is written out with
  its reason in `OUT_OF_SCOPE`, so a namespace added to the catalog fails the run the day it is
  added.
- **Matching a message as a substring of the surface's whole text.** On one surface or another, 25
  items could be satisfied by a different message of the same surface — `"ON"` inside
  `"MIDI CONTROL"`, `"Copy"` inside "Copy the report below", `"Q"` inside `"EQ"`. Text is collected
  as one run per element, from the element's own text, and a plain message has to equal a run. A
  message that is interpolated or composed was first allowed to be contained in a run; that was
  dropped on 2026-10-10 ([#554](https://github.com/semnil/urx-router/pull/554)) for a match at a
  position the composed text delimits, or an anchored match on the whole run (`shows` in
  `e2e/inventory.ts`).
- **Counting a `title` attribute as a display.** The point of the fix was that an explanation
  revealed on hover is not a display, and with `title` counted, replacing the legend by a tooltip
  would have passed. The default is text only, and an item whose tooltip is the intended display
  is named one by one through `viaAttribute`.
- **Moving the declarations into the unit suite.** Separating the declared data from what drives
  it would be tidier, but an `elsewhere` entry is a statement about which spec drives which
  surface, so the two stay in one place.

**What sits under it.** `src/i18n/refs.contract.test.ts` (`pnpm test refs.contract`) checks
statically that every message key is referenced from `src/`. It catches the defect of the
incident above in milliseconds — on the commit before the fix it reports `modeDesc` as
unreferenced — and leaves to the inventory the other half, a message that is referenced and never
rendered.

**How the scope was settled.** The surfaces were counted by going through every place that sets
`.hidden = false`: fourteen at the time — eight modals, the MIDI window, three menus, two
popovers, and the drop-zone overlay, which the first count had missed. The Inspector, the CONSOLE,
the status line and the warning cards are standing surfaces and are on the `OUT_OF_SCOPE` side.
The guard was shown to fail: with the two legend rows removed, six cases fail.

## Unit suite speed and CI workers

**Decision (2026-10-19).** CI runs the unit suite with the number of workers vitest picks by
default. No worker count is written in the configuration.

**Why.** On CI the suite's run time follows the sum of the files' times divided by the number of
workers, and the longest file fits well inside the whole run, so splitting the files further does
not shorten it. Writing the default out as an explicit setting changes nothing. A count above the
default has not been run on CI, so its effect there is not known.

**History.** The desktop device cases were split into per-feature files in
[#675](https://github.com/semnil/urx-router/pull/675), and the teardown drain was shortened to 18
readings in [#677](https://github.com/semnil/urx-router/pull/677), whose description carries the
reasoning for that number.

## A teardown that does not finish fails the next case

**Decision (2026-10-11).** When the teardown of a desktop unit case is still running as the next
case starts, the next case fails before it boots the app and names the case whose teardown did not
finish. The change is [#589](https://github.com/semnil/urx-router/pull/589).

**Why.** The app the earlier case left running cannot be stopped from the test: `resolveInvoke` in
`src/core/platform.ts` reads `window.__TAURI_INTERNALS__` on every call, so its commands land in
the next case's stub.

**Turned down.**

- **Lengthening the teardown's wait.**
- **Adding a stop routine to `src/main.ts`** so that a test could stop the earlier app. That is a
  change to product code made for the tests.

**Incident.** A case held a device read and registered the release where it ran after every
`afterEach`. With the read still held, the file's teardown waited for the device link until its
hook timed out, went on running after the timeout, and then drained and restored the page of the
case that had started in the meantime. The second failure, a premise that did not hold, was that
side effect and not a defect of the app.

## E2E serves the production build

**Decision.** The E2E web server is `pnpm e2e:serve`: a production build served by
`vite preview`. E2E does not run against the dev server.

**Why.** Against the dev server, a case starting under `fullyParallel` sometimes found
`#model-picker` empty. The cause was the dev server transforming modules on demand and reloading
the page after it optimised dependencies.

## The startup check

**Decision (2026-10-10).** Whether the dev app is up is answered by
`node scripts/check-startup-wait.mjs --pid <tree>`, and a hook refuses a command that waits on the
log instead. How it works is in `AGENTS.md` "Development"; the change is
[#564](https://github.com/semnil/urx-router/pull/564). Two decisions inside it:

- **The check looks only at processes of the current user** (`pgrep -x -u <uid>`). The working
  directory of another user's process cannot be read with `lsof`, so with those included the
  answer would become "cannot tell".
- **The hook reads a command with a narrow reading of shell, and is not widened to cover shell
  syntax as a whole.** What it leaves alone on purpose: a word inside quotes, the body of a
  here-document, a substitution escaped with a backslash, and a grep that follows a loop's `done`.

**Incident.** Before the check existed, the startup was misjudged repeatedly, each time in a
different way: a launch wrapped so that the wrapper's exit stopped the build, a `pgrep -f` on an
absolute path the process does not carry, a pattern broken by shell quoting, a fixed string that
the coloured `Running` line does not contain, a background launch with no test for "up" at all,
and a window closed by hand read as a crash.

## Values that change with module evaluation order

**Decision (2026-09-23).** The module-order defect was fixed in a pull request of its own,
[#509](https://github.com/semnil/urx-router/pull/509), apart from the compressor Ratio stops
([#506](https://github.com/semnil/urx-router/pull/506)). That work had already kept clear of the
same problem by putting its table in a leaf module, `src/core/control/comp-ratio.ts`.

**What was wrong, and the fix.** #509's description states the mechanism: modules that import each
other in a cycle, a table built at module scope from a binding that is not initialised yet, and
only a unit test entering the cycle in the order that exposes it. `src/core/control/vd.ts` became
a leaf, and `pnpm test module-order.contract` guards it.

**Measured.** Before the fix, 21 table entries differed, and only in the order that enters through
`vd.ts`. After it, there is no difference in any of the seven entry orders — the six modules left
in the cycle, and `vd.ts`. With the fix reverted, the guard fails on 22 entries.
