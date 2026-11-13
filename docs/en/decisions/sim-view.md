# Decisions: the SIM view

> 日本語版: [../../ja/decisions/sim-view.md](../../ja/decisions/sim-view.md)

Closed decisions about the SIM view — the unit's LCD, drawn by the urx-lcd-sim simulator embedded
beside GRAPH and CONSOLE — and what happened around them. How the view works is in
[architecture.md](../architecture.md), "SIM view (the unit's LCD)"; the rule on refusing a write is in
`CLAUDE.md`, "Conventions" ("A write is refused only for a reason the unit or the operator gives").
Most of what follows is already in the pull requests it links, so a section here is often a
heading, the conclusion and the links. Pull requests written `lcd-sim#N` belong to
[urx-lcd-sim](https://github.com/semnil/urx-lcd-sim). "The operator" below is the person who directs
this project's work and decides for it. Read this before changing what the SIM view writes, what it
holds shut, or how the simulator is taken in.

## Decisions of 2026-10-12

The design was settled in one conversation. The reason behind the set: the two repositories stay
maintainable side by side, and the write path that already exists — Live sync, follow, undo — stays
the only one.

| # | Decision | What was settled, and what was turned down |
| --- | --- | --- |
| D1 | Path of a value | The same as GRAPH and CONSOLE: an edit in the SIM view changes the plan, Live sync writes the unit, follow brings the unit's changes into the plan. Turned down: writing straight to the unit over the Live connection |
| D2 | How it is mounted | In the same document. No iframe. The glass is drawn inside a shadow tree whose root starts every property from its initial value. The first form, a CSS `@scope`, was replaced after review showed that the page's own rules still matched elements inside it |
| D3 | The simulator's outer frame | Not shown. What the app already has is handed in from outside: the model, the connection state, the notice that something cannot be saved |
| D4 | Scale | 100% by default. The switch is a section of the View menu, shown on every view (D11) |
| D5 | Initialize | Not offered. File > New does that job. Turned down: adding it as a section of the Device or File menu |
| D6 | How the simulator is taken in | See "How it is taken in" below |
| D7 | "No external dependencies" | "External" means outside this project owner's own repositories. `CLAUDE.md`, "Tech stack", has the wording |
| D8 | The font's licence | The bundled IBM Plex Sans (OFL) is one more entry on the existing licences screen |
| D9 | The simulated functions | Making the bundle lighter is not a goal. The simulation was reshaped into one interface shared with a real unit (parameters, levels, actions, clock), approved on the condition that undo is not harmed; see "What undo requires of the embedding" |
| D10 | The board behind the glass | The same in both themes: the dark theme's board, with `color-scheme: dark`. The frame around it follows the theme |
| D11 | Menu items per view | None is hidden by view. Arrange, Hide unused and the SIM scale section appear on every view |
| D12 | Spoken names | The simulator's accessible names follow this app's reading (C H, slash, dot, Phase). The display does not change |

Two things changed in implementation. The values travel by path between the plan and the simulator
(`PlanTransport` and [src/core/sim-map.ts](../../../src/core/sim-map.ts)), not through device
addresses as first drawn: the simulator keeps values in the units a person reads, close to the
plan's own. And the accessibility check of the E2E suite was changed to look inside the shadow tree;
before that it had not read a single name in the SIM view.

**Naming** (2026-10-12): class names and attributes are prefixed on the assumption that behaviour
may be switched per view at once. architecture.md, "SIM view (the unit's LCD)", has it under Names.

## What undo requires of the embedding

D9 was approved on the condition that undo keeps working. These are the conditions that were read
out of the two code bases, and each holds in the implementation.

| What was checked | Condition |
| --- | --- |
| One operation in the SIM view is one undo entry | The view is mounted in the same document (D2), and a `focusout` from inside `.urx-lcd-sim` is not a boundary. The simulator redraws at every step of a value and each redraw fires `focusout`; treated as a boundary, one drag became nine entries |
| An edit reaches the plan before the entry closes | `PlanTransport`'s write goes into the plan on the spot, without waiting for IPC |
| Undo does not create a new edit in the SIM view | `PlanTransport` only notifies; it never writes the plan on its own |
| Undo is refused during a drag | As D2: the drag is seen as window pointer events like any other |
| The writes one edit carries along land in the same entry | None: an entry's difference is taken when it closes |
| Arbitration with a read from the unit | The edit enters through the funnel the CONSOLE uses |
| The undo key | With focus in the simulator's title field, the key does nothing to the plan. `ownsNativeUndo` reads the active element inside the shadow tree |

"Reading the code found no problem" was wrong once here: the nine-entry drag was found by the E2E
case, not by the reading.

## How it is taken in

**Decision (2026-10-25, [#728](https://github.com/semnil/urx-router/pull/728)).** The simulator is a
git submodule, updated by the dependency bot and merged automatically. The version the SIM view
shows is the commit of the simulator's checkout.

**What it replaced.** D6 first pinned a commit through the package manager's git dependency, with
submodule, subtree and merging the repositories turned down. Following release tags was tried on
2026-10-22 so that updates could be automatic, and dropped the same day: the dependency bot does not
update a git dependency of that kind. The submodule is what made automatic updates possible.

**`pnpm sync:merged` does not delete a submodule's repository.** A worktree that holds one is left
in place and the command that removes it is printed; the state is read before each deletion. The
earlier shape proved that deletion was safe by listing what would be lost, and the list never
closed. Turned down: continuing to enumerate, and moving the repository under the common git
directory to keep it. #728 has the cases.

## Decisions of 2026-10-14 to 16 (#645)

[#645](https://github.com/semnil/urx-router/pull/645) brought the SIM view in. Closed there:

- **A control that is stopped carries a lock mark and a bubble with the reason.**
- **The microSD entrance stays open; the operations inside are stopped.** The rate is not written
  while the unit is playing back.
- **The app's own rate write needs no re-read of HOME's [Sends] destination.** The app writes the
  rate only in a Write that holds no connection, and it holds no destination then. The item had
  been raised for a decision on a wrong premise.
- **While 1-knob EQ is on, a band value the SIM view writes does not change the plan's band**, as on
  the EQ screen.
- **Of the six writes one edit carries along, only the upper limit of Day is the screen's rule.** The
  unit performs the other five itself.
- **A linked pair's name, icon, colour and input source are not copied to the partner.**

Some of #645's wording was replaced later: the messages for SETUP > GENERAL and Follow USB by
[#651](https://github.com/semnil/urx-router/pull/651), and the refusal of a rate change during Live
sync by Q5 below.

## SETUP > GENERAL

**Decision (2026-10-18, [#670](https://github.com/semnil/urx-router/pull/670)).** The SIM view shows
the unit's values and writes them only during Live sync. Offline, the screen and its values are
held shut.

**What it replaced.** #651 wrote them offline as well. The operator corrected that: being writable
while not in Live sync was never the intent. The misunderstanding came from the question asked
for #651, whose options did not include "during Live sync only".

## Decisions of 2026-10-17 (Q1 to Q8)

Each was put to the operator as options.

| # | Decision | Pull request |
| --- | --- | --- |
| Q1 | Device setup opens during Live sync and writes through the session | [#666](https://github.com/semnil/urx-router/pull/666) |
| Q2 | A Delay under Sync can be turned from the FX tuning screen and by MIDI too. This overturns #651's "stays stopped" | [#668](https://github.com/semnil/urx-router/pull/668) |
| Q3 | The Clip Safe state is shown on the CONSOLE and in the inspector. This reverses the decision of 2026-09-22 not to show it | [#659](https://github.com/semnil/urx-router/pull/659) |
| Q4 | The simulator draws a control as locked when any one of the values it writes is locked | [lcd-sim#106](https://github.com/semnil/urx-lcd-sim/pull/106) |
| Q5 | With Follow USB off, the rate can be changed during Live sync, after it was checked on hardware that the control link holds | [#657](https://github.com/semnil/urx-router/pull/657) |
| Q6 | A settings file is imported during Live sync, and the imported values are written through the session | [#676](https://github.com/semnil/urx-router/pull/676), [#678](https://github.com/semnil/urx-router/pull/678) |
| Q7 | The device scope can be changed during Live sync; the session is set up again | [#674](https://github.com/semnil/urx-router/pull/674) |
| Q8 | Software Integration is usable during Live sync while a supported DAW is connected. The values for two of the DAWs were closed as not checkable without the equipment | [#656](https://github.com/semnil/urx-router/pull/656) |

## Decisions of 2026-10-18

These continue the audit below, which set each write restriction against the unit's own screens.

- **A-1 to A-3** ([#668](https://github.com/semnil/urx-router/pull/668)): the lock on a Delay's Note
  while Sync is off is removed; a Delay's time is always adjustable while Sync is on; Pitch Fix's
  Scale offers the narrowed list the unit offers, and the lock on the twelve notes stays.
- **A-4** ([#667](https://github.com/semnil/urx-router/pull/667)): a MIX send's PAN is adjustable
  under Pan Link, as on the unit's SEND TO.
- **B-1 to B-12**: the locks around 1-knob and Auto Makeup are matched to the unit only after
  looking at the unit's screen. What changed: the M.B.Comp's Out Gain
  ([#662](https://github.com/semnil/urx-router/pull/662),
  [lcd-sim#100](https://github.com/semnil/urx-lcd-sim/pull/100)), D-4, and the simulator's EQ screen
  ([lcd-sim#101](https://github.com/semnil/urx-lcd-sim/pull/101)). The operation mode is read and
  shown, the lock stays, and not implementing the Simple mode is the app's own choice.
- **C and D-1** ([#663](https://github.com/semnil/urx-router/pull/663)): what a sample rate takes
  away cannot be operated, and **can still be chosen as a MIDI assignment**. The same holds for
  anything another rate makes unavailable for a while.
- **D-2** ([#664](https://github.com/semnil/urx-router/pull/664)): an insert effect over the limit
  is removed from the plan as well.
- **D-3** ([#665](https://github.com/semnil/urx-router/pull/665)): the rate stays stopped while the
  unit is recording, standing by or paused, and the message says to stop the recording.
- **D-4** ([#660](https://github.com/semnil/urx-router/pull/660)): turning COMP's 1-knob on puts the
  values the unit sets into the plan as well, and Attack and Release are locked while it is on. It
  was settled after reading the unit on two models at every rate; the third model could not be
  read and is recorded as a premise only.
- **E**: the "Vib only" tag on Clean stays as it is.
- **M7-2** ([#669](https://github.com/semnil/urx-router/pull/669)): the locks are redrawn each time
  the connection is taken or let go.
- **M7-3** ([lcd-sim#102](https://github.com/semnil/urx-lcd-sim/pull/102),
  [#679](https://github.com/semnil/urx-router/pull/679)): during Live sync the LCD is told whether
  a DAW is connected, and when none is, Software Integration cannot be opened and looks as it does
  on the unit — without the app's lock mark. The standalone simulator always opens it, as a
  deliberate exception for taking screenshots.
- **M7-4** ([lcd-sim#103](https://github.com/semnil/urx-lcd-sim/pull/103),
  [lcd-sim#105](https://github.com/semnil/urx-lcd-sim/pull/105)): how the simulator draws the date
  row and the lock.
- **M7-5** ([#672](https://github.com/semnil/urx-router/pull/672)): during Live sync a scene's title
  is left blank, and the unit's current scene and cursor are shown by number.
- **M7-6**: a notice of a Brightness changed offline once reached the next session. One attempt did
  not reproduce it; the path was removed and the item closed with the cause unknown (the operator's
  decision).
- **A dialog left open kept a live OK** (review of #670). The cause was on the simulator's side: its
  OK did not name what it writes. The operator chose to fix the simulator
  ([lcd-sim#104](https://github.com/semnil/urx-lcd-sim/pull/104)) and leave #670 as it was; the E2E
  cases went into a pull request of their own
  ([#680](https://github.com/semnil/urx-router/pull/680)).

## Audit of the write restrictions

**Decision (2026-10-17 to 18).** Every place where the app refuses a write was set against its
ground. A restriction stays only if the unit or the operator gives the reason.

**Kept, with the ground.**

- Track Count during Live sync: the operator's decision, with what
  [device-control.md](device-control.md), "Track Count is not written", records.
- PRE / POST of a CH → FX send during Live sync: the operator's decision that the CONSOLE is the
  reference, and the write cannot be pushed to the unit ([known-issues.md](../known-issues.md)).
- FX 2, the insert effects and the stereo EQ above 96 kHz, and +48V with HI-Z on together: the
  unit's specification.
- The rate during microSD playback and the three recording states: the operator's decision and the
  unit's specification.
- The unit's own operations (scene, card, recording, playback): the operator's decision.
- Operation Mode, Software Integration and the clock: there is no address to write, or the app does
  not write it.
- Pitch Fix's keyboard, and the M.B.Comp's Level while its 1-knob is off: the unit makes the value.
- CUE offline: the operator's decision that CUE cannot be pressed when neither Live sync nor MIDI
  Learn is on.
- Editing while the device is being read
  ([#507](https://github.com/semnil/urx-router/pull/507)).

**Removed.** The rate, Device setup, the settings-file import and the device scope during Live sync;
a Delay under Sync; a Delay's Note; a send's PAN under Pan Link; Pitch Fix's Scale (the list is
narrowed instead). For each of these no statement by the operator that it must not be written at
the same time was found. The only ground was a reason given in architecture.md.

**Added.** Leaving out an insert effect over the limit; the M.B.Comp's Out Gain; COMP's Attack and
Release.

## Lock policy

**Decision (2026-10-18, [#661](https://github.com/semnil/urx-router/pull/661)).** The SIM view draws
a lock or dims a control only for what **the app** cannot do: a value it does not write, a function
it does not have, a state it cannot read. Where the unit itself stops or hides an operation without
showing anything, the simulator draws what the unit draws.

**Why.** The view simulates the unit. With COMP's 1-knob on, the unit keeps showing Attack and
Release and simply does not turn them; a lock mark there is something the unit never shows. #661
removed the locks on the values the insert-effect switch moves, on a send into FX 2 at a high rate,
and on the rate while Follow USB is on. architecture.md has the rule under What it holds shut.

## Browser demo

**Decision (2026-10-13).** The simulator stays in the browser demo's bundle. `SimView` is imported
statically, so the demo build contains it, and the view is created only on an experimental launch
([#649](https://github.com/semnil/urx-router/pull/649)). The operator decided that taking it out is
not under consideration. Not proposed again.

## How the work is split

A defect in the simulator's own behaviour goes to a separate session and a separate pull request in
its repository ([lcd-sim#76](https://github.com/semnil/urx-lcd-sim/pull/76) was the first in that
form).

## Incidents

- **A path the simulator writes that is neither in the table nor under `ui.` takes the whole edit
  back.** The simulator's store is all or nothing. It happened three times in #645: the pair link
  and the SSMCS split (found in review); the playback state written with a rate change, so the rate
  could not be changed from the SIM view; and Output Patch's tab, so the edit never reached the USB
  outputs. The last two were found only when tests were written for lines coverage showed as
  unreached. The view now owns such paths in `GLASS_OWN`
  ([src/ui/sim-view.ts](../../../src/ui/sim-view.ts)). A path the simulator starts writing when the
  submodule's commit is raised is counted by
  [src/ui/sim-view.paths.contract.test.ts](../../../src/ui/sim-view.paths.contract.test.ts), which
  presses the simulator's controls on a URX44V and fails naming each path a press writes that the
  view does not take.
- **A re-read was run on a queue of its own.** The re-read of HOME's [Sends] destination ran beside
  the CUE re-read and broke the race harness's invariant on overlapping reads in thirteen cases.
  Reads from the unit go on the `cueWrites` queue and wait for the flush and for follow's reads. The local
  race run caught it.
- **A test passed without taking the path it was written for.** The case for a failed re-read
  answered some reads and left the others empty; the session fell for a different reason, and the
  case was green. Removing the handler under test and seeing nothing fail exposed it. A reader that
  refuses part of the reads delegates the rest to `unwrittenRead` and is passed to `bootDevice`.
- **The simulator keeps a value it was handed until a whole re-read removes it**
  ([#683](https://github.com/semnil/urx-router/pull/683)). The presence of a DAW is handed over for
  the session only, and it stayed in the simulator's store after the session ended: Software
  Integration went on being drawn as if a DAW were present, and offline the app's lock did not
  apply. The existing cases looked at the app's side only. **When a value is handed over for the
  session only, look at the simulator's store after the session ends.** The whole re-read is built
  from factory values, and its first version also put the LCD's own state (the selected channel,
  the bank, the knob mode) back to factory; the re-read now answers with the simulator's current
  value for any path the app hands nothing for.
- **Unit state kept per session survived a failed start**
  ([#681](https://github.com/semnil/urx-router/pull/681)). When the start was refused after the
  initial read, the clean-up did not clear the unit's state, and the LCD went on showing the unit's
  card with no session. The current scene, the cursor and the operation mode had had the same gap.
  **When per-session unit state is added, check that both the normal end and the failed start clear
  it.**
