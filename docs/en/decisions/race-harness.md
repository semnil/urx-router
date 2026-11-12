# Decisions: the race harness

> 日本語版: [../../ja/decisions/race-harness.md](../../ja/decisions/race-harness.md)

Closed decisions about the live-sync race harness (`e2e/race/`), and what writing its cases has
taught. The harness itself — its invariants, the fake device's contract, the tiers and the
findings — is described in [live-race-harness.md](../live-race-harness.md), and the rules a change
has to follow are in `CLAUDE.md` "Development" and "Conventions"; this document holds the reasoning
those do not. "The operator" below is the person who directs this project's work and decides for
it. Read this before adding or rewriting a case, before re-deriving the shard weights, and before
proposing something the first section lists.

## Decisions the operator made

**Decision.** Each of these was settled with the operator and is not proposed again without new
evidence.

- **The model axis is URX44V and URX22. URX44 is not added.**
- **The tier is shortened by weighting its shards, not by removing cases** (2026-08-15). The
  harness's wall clock is set by its slowest shard, so removing a redundant case moves machine time
  and nothing else. The number of cases is not reduced for speed. How the weights work is in
  live-race-harness.md, "How the shards are sized".
- **Three changes were measured and turned down.**
  - Fusing the passes `scripts/race-shard-weights.mjs` makes over one log (`durations`,
    `skippedInLog`, `runShape`, `doubledInLog`) into a single pass. The script's wall clock is
    taken up by spawning `playwright --list`, so the passes are not where its time goes.
  - Running that script's per-shard `planProblems` spawns in parallel. It is a tool run by hand,
    and the change was outside the diff under review.
  - Making the asset checker's classification of environment variables require an "assigned" or a
    "referenced" form. Its wrong detections would fall on the side that turns a required check red.
- **Eight items of a simplification review were decided by the operator**: the address key is
  packed into an integer; restoring focus is gathered into `preserveFocus` in `src/ui/dom.ts`;
  `e2e/race/ui.ts` was created to hold the locators the specs had each repeated (which replaced
  the earlier convention that every spec is self-contained); a plan whose insert effects collide
  on a slot is opened with a warning instead of being refused, while a malformed file and an
  unsupported version stay refused; the second diff inside `readIntoPlan` was removed and its
  report kept; `planProblems` was split out into `src/core/plan-validate.ts`; the slot tally is
  taken once per render by `insertFxCensus`; and `PLAN_VERSION` was raised to 2.
- **No CPU-throttling option is kept in the harness.** When a case has to be driven under load, the
  few lines that set the browser's CPU throttling rate are written for that investigation and
  removed afterwards.
- **A surface of the fake device that no case runs is deleted** (2026-08-06).
- **No standing check scans every route by which a callback crosses into the page** — `evaluate`,
  `evaluateHandle`, `waitForFunction`, `locator.evaluate`, `evaluateAll` (2026-08-13). The scan made
  that day was by hand, over `e2e/` and `scripts/` and over the serialized side only; it found no
  further reference to a module binding. The trap itself is in live-race-harness.md, "What the
  harness itself got wrong".

**Reopen when.** For the standing check: a proposal to add it comes with what has changed since.

## One rung per boundary in the MIDI ladders

**Decision (2026-08-17).** Six cases were removed from the three MIDI ladders, each an extra sample
of a boundary the remaining rungs already state; no subject was retired. Which rungs, why the kept
ones still state the boundary, and what it cost and bought are in
[#412](https://github.com/semnil/urx-router/pull/412). The operator decided it, and the removed
rungs are not proposed again.

## Rungs placed from the app's constants

**Decision.** A rung is placed relative to one constant in its spec, and that constant is imported
from the source when the source exports it; where it does not, a comment points at the source's
definition. What happened when a window was shortened under cases that held its old value as a
literal is in [#367](https://github.com/semnil/urx-router/pull/367), and the sweep that tied the
harness's bounds to `DEBOUNCE_MS` and `IDLE_FULL_MS` — with the sites it left alone, and why — is in
[#582](https://github.com/semnil/urx-router/pull/582). That sweep is closed and is not repeated.

- **`RECONCILE_DEBOUNCE_MS` stays unexported** while no site needs it. Two sites in
  `e2e/race/t5-drop.spec.ts` still restate it as `+ 300`.
- **The margin from a window's edge is decided as an absolute time, not as a share of the window.**
  The residual of a phase bracket was 0–1 ms on the development machine, so a margin of ±10 ms that
  was safe inside a 300 ms window is as safe inside a 50 ms one. Whether the driver's own round
  trip (about 5 ms) is small against the window is checked for the same reason.

**Why.** A case that fails when a constant moves gets fixed. The cases that cost more were the ones
that stayed green and had stopped comparing anything: one had lost the rung it was a contrast to,
and another sat on the boundary itself.

## Pins whose specification changed

**Decision.** When the behaviour a pin states stops being the specification, the pin is rewritten to
state the new behaviour. Re-pointing its selector at whatever now matches is not a fix.

**Incident.**

- MIDI control moved from a panel into a window of its own. Two places pinned "the MIDI panel
  counts as an open modal, so undo is refused": the refusal ladder in `e2e/race/t3-undo.spec.ts` and
  a sweep in `e2e/race/t0b-sweeps.spec.ts`. The move made that false. They were rewritten to the
  opposite claim — a separate window holds nothing back — and not merely given the new selector.
  The fake device had to learn the window as well: creating it, bringing it forward, its geometry,
  and the relay between the two pages. Whether the window exists is the shell's fact, so
  a per-page field would have held one value in the page that closed it and another in the page
  that is asked; it is a getter backed by `localStorage`. The relay is a `BroadcastChannel`, which
  does not echo to its sender, and the fake is installed with `page.context().addInitScript`
  because the second page needs it too.
- A drop onto an input that already holds a source changed from being refused to replacing the
  source ([#579](https://github.com/semnil/urx-router/pull/579)). Two cases of that sweep file
  turned red in the race job, which was the first place they ran: the pull request had run the app
  tier alone on the development machine. The second of them looked like a different cause and was the same one — the
  inspector's connection picker offers the candidates the drag does, so a port that holds a source
  became a candidate there as well.

**What follows.** A pull request that turns a refusal into a behaviour looks in
`e2e/race/t0b-sweeps.spec.ts` for the gestures registered as `silent: true` and for the pins on an
unavailable control, and remembers that the drag's candidates are the picker's too.

## Measuring where it can be measured

**Decision.** A case is written in the tier that can hold the arrangement open, and a case that
cannot fail is deleted and rebuilt there.

- **The window between a MIDI message and a device read does not open in the unit tier**
  ([#483](https://github.com/semnil/urx-router/pull/483)). The regression was a mirror writing the
  same value to its partner during a read, which shows no difference. Four attempts in the unit
  harness each stayed green with the fix removed: a Fetch refuses incoming MIDI; a follow read ends
  after a few round trips, before the press arrives; answering every read with zero lets the whole
  reconcile that follows win, so the case measures that read; and waiting on the status line waits
  on the defect, since a read whose patches were dropped applies nothing and shows nothing. The
  race tier is where a barrier holds the read open, and the verdict is read from the write ledger:
  the held scoped read rewound neither member.
- **To pin what happens at one moment, the later moment that gives the same result has to be closed
  as well** ([#428](https://github.com/semnil/urx-router/pull/428)). The arrangement — the refetch's
  read parked, the full read finishing inside it — was built, and then the park was released before
  the next gesture. The replay read that the excursion had scheduled then ended with nothing else
  open and consumed the report, so the case stayed green with the old guard put back. The mutation
  failed once the next gesture was pushed while the read was still parked. Building the arrangement
  is not the end: the open and close of the reads were instrumented, and what was open at the
  moment of the verdict was read once.
- **An arrangement the race tier cannot build is built in the unit tier.** The device link is one
  queue, so a refetch opened inside a sweep is used up before the sweep's tail; barriers at three
  positions were tried and none held it. The unit files for the booted app
  (`src/main.device.test-util.ts` holds their shared part) can leave a read open for any length by
  answering it with a promise that does not resolve.

## Writing a verdict

**Decision.** After a verdict is written, a separate round tries to refute it. Two such rounds found
verdicts that could not fail and claims wider than the evidence, and each was fixed or withdrawn;
the counts are in live-race-harness.md, "What the harness itself got wrong".

What those rounds and later fixes showed:

- **A count of whole reads stops telling two causes apart once the wait crosses the idle net.** With
  a settle of 300 ms and an idle net of 900 ms, a case that waits 1800 ms after a notify sees one
  whole read whatever happened, so "escalated" and "idle net" give the same number and the case
  stays green when the routing under test is changed. Write the verdict as an order — the scoped
  read comes before the first whole-read marker, which settle and idle guarantee — or look at what
  the lookup returns in a unit test. Cutting by a time window does not work: the address used as
  the marker is read near the end of a whole read, so it does not stand for the read's start.
- **An edit declared to the analyser is removed when the gesture stops making it**, or invariant 2
  fires on every run.
- **A refetch case edits a node outside the refetch's scope.** Editing a node the refetch covers
  measures the readback overwriting the edit, which is a different defect from the one the case is
  named for.
- **"Intermittent, cannot be pinned down" can mean the window has not been placed yet.** A barrier
  can also stop a flush's send loop at one command: hold the n-th write, deliver a notify for an
  address the loop has not reached, and release it.
- **A counter or a flag is decided by how many consumers there are.** A flush has two independent
  consumers, the value loop and the name loop, and a flag one of them has consumed is invisible to
  the other. That is why the snapshot epoch is a counter.
- **Adding one wire does not add a writable address.** A case about "an address that appeared after
  the read" selects an insert effect; written with a wire, its premise is false and it still
  passes.
- **A periodic edit sequence aliases against the flush window, and whether anything is sent then
  depends on phase** ([#592](https://github.com/semnil/urx-router/pull/592)). With a four-beat
  Up/Up/Down/Down sequence, the window that opens after a converge can land each time on the value
  the unit already holds; instrumented, the flush ran and sent nothing, which is not the app
  stopping. After a periodic sequence a case does not assert that something was sent. It pins what
  does not depend on phase: the lower bound of the hold, that a change made during the hold appears
  in the stream, and the final value.

## Writing a pin

**Decision.** A pin states a property of the code, not where two pieces of text sit, and a rewritten
pin is tried four ways before it is trusted.

**Incident.** The unit guard over the launch flags the fake never claims broke three times on a
layout change, the third time on the correct fix
([#354](https://github.com/semnil/urx-router/pull/354)). It was rewritten to state properties: the
name is absent from the serialized side and present in the argument tuple, and the answer is traced
through the name of the callback's last argument, read from the source. That rewrite then went
through two more corrections in review:

- **Both sides of the pin are corrected together.** Comments were stripped for the "absent" check
  alone, so the "present" check went on reading the raw source — and replacing the tuple with a
  literal, with the constant's name in a comment on the same line, passed. Stripping is applied
  once, before any index is taken.
- **An identifier captured from the source is escaped before it goes into a regular expression.**
  `$` is legal in an identifier and an anchor in a pattern, so a name beginning with it never
  matched.

The four ways: put the defect back in the code (fails); make the ledger side a literal and disguise
it with a comment (fails); put the identifier in a comment inside the callback (passes); rename the
argument (passes).

## The permanent-skip ledger

**Decision.** The ledger (`e2e/race/skip-ledger.json`) exists to count what nothing holds, so
over-counting defeats it. An entry names a guard only when that test answers the skip's own reason;
when in doubt the entry stays `unguarded` with its reason written out.

**Incident.** Two entries named a test that answered a different fact
([#348](https://github.com/semnil/urx-router/pull/348); its review caught both). The test named for
the sample-rate entry sets the rate lock itself, so it exercises the refusal branch and not the
reason the case is skipped. The entry for a cancelled Fetch named a path that no longer exists, so
the case could not be written at all. The reasons written in their place were wrong too: "nothing
holds this" was false, because a race case already asserts that a readback clears both stacks, and
the observable described as missing was shipped and in use by the same tier. The accurate reason
was that the assertion exists in a tier that runs only at a release — which is why a guard has to
be a unit test.

**What follows.** Before writing that nothing holds a behaviour, search the race tier for it.

## Re-deriving the shard weights

**Decision.** The array in the ledger is re-derived from a run's log whenever the corpus changes;
subtracting the removed cases is a stopgap. The mechanism is in live-race-harness.md, "How the
shards are sized", and the commands are in `CLAUDE.md`.

- **The log has to measure the corpus this checkout collects.** A case's key is its file, line and
  title, so a comment moving one line in a spec while the branch is behind `main` shifts the keys
  and the derivation refuses the log. The order is: take `main` in, push, run the script on that
  push's run, paste the array into the ledger, push again. The script writes nothing.
- **The paragraph in live-race-harness.md that states the current array has no check.** It was once
  left two generations old. A commit that moves the array corrects the English and the Japanese
  paragraph with it.
- **No pin refers to the ledger's array as a literal.** A fixture in
  `scripts/shard-weights.test.mjs` once held the old array and failed on a re-derivation that had
  nothing to do with it.
- **The script may reject the split it derived as best.** A cut that falls inside a serial block is
  moved by Playwright with the whole block, so the proposal and the runner's assignment would
  differ; the split the runner can reach is the one that goes in the ledger.
- **A pull request that raises Playwright compares the new version's shard filter with the old
  one.** The weights variable is not part of Playwright's typed interface, and what a weight counts
  has changed between versions: whether a case declared as skipped counts toward a shard. The check
  and the derivation count the cases that run.

## Design decisions closed during the fixes

**Decision.** Settled while the fixes the harness drove were made, and not proposed again.

- **The reason for a permanent skip lives in one place, the ledger in this repository
  (`e2e/race/skip-ledger.json`), and is not copied into another document** (2026-08-11). A copy
  goes unread when the reason expires, and the harness runs only on a version-bump pull request.
  What the ledger's check does is in `CLAUDE.md`.
- **Merging on the plan side alone was a regression.** A read returns the copy it used, and a
  capture takes its shape from the live plan and its values from the copy.
- **The three follow reads do not refuse file operations.** They start on their own, and File > New
  doing nothing because of a read the user did not start is the worst outcome on a live stage.
  Replacing the plan is resolved on the read's side.
- **MIDI is not refused during a follow read either.** Refusing would cut the surface out in the
  middle of a one-knob drag, and would differ from what the mouse does.
- **A refusal during a reconcile costs the history entry, and that trade is accepted**: a visible
  refusal is preferred to an edit whose arrival at the unit is left to chance. "A refusal costs
  nothing" holds for the refetch reads alone.
- **A refusal is decided before the entry is closed.** Closing first lets a refused press bake in
  the plan as it stood mid-read, and the retry then pushes that back to the unit.
- **Plan validation runs at one place, `loadFromText`.** A Fetch, the start of a Live sync
  session, a follow reconcile and a settings-file import do not pass through it. The asymmetry is
  intended.

Three shapes the refutation rounds found that had been missed:

- Two pieces of state with one meaning drift apart — a counter of background reads beside the set
  of them, where an abort can empty the set and cannot decrement the counter. The set's size is the
  one source.
- A refused branch is not thereby a branch where nothing happened (the closing order above).
- A function that returns early in silence leaves its caller reporting success: a plan load that
  returned early was still added to the recent list and reported as opened.

## What the audit rounds corrected

**Incident.** A verification audit of the harness raised 60 findings; an adversarial check confirmed
28, downgraded 7 and refuted 4. The eight findings graded S2 each had the form of something
breaking in silence. What changed in the harness is in live-race-harness.md, "What the harness
itself got wrong". What that document does not say:

- **The fixes turned three pins over** — `pushedBack` in the stress tier, `unreported` in the
  baseline sweeps, and a sweep in the undo tier. Each was rewritten as a set and kept its power to
  detect; none was deleted.
- **Nineteen weak cases were fixed, and they had three shapes**: a verdict resting on a count where
  it should rest on a value; an absence sampled at a moment when nothing could have happened yet;
  and a precondition printed to the log and not asserted.
- **An expected value is no longer estimated from the wall clock.** The idle-backstop ladder
  samples the undo depth directly between notches. The estimate it replaced had the sign wrong on
  the rungs under 300 ms.
