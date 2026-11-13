# Decisions: Live sync

> 日本語版: [../../ja/decisions/live-sync.md](../../ja/decisions/live-sync.md)

Closed decisions about Live sync (`src/core/control/live.ts`) and device follow
(`src/core/control/follow.ts`): what was decided, what was turned down, and what is not proposed
again. How the two work is in [architecture.md](../architecture.md), "Live control connection" and
"The link ledger"; what they cannot do today is in [known-issues.md](../known-issues.md). The
decisions about the layer underneath are in [device-control.md](device-control.md), and those about
the race harness, which pins much of what follows, in [race-harness.md](race-harness.md). "The
operator" below is the person who directs this project's work and decides for it. Read this before
changing how an edit is sent, how a device-side change is taken in, or how either one is reported.

## Adding a reader to the worker

**Decision (2026-10-15, [#634](https://github.com/semnil/urx-router/pull/634)).** A reader added
beside the session's own commands — the parameter watch's read, or any read of that kind — follows
two rules.

- **A failure it receives is passed on**, to `linkFailureIn` and from there to `stopLiveOnError`.
  The notice that the device is lost is consumed by whichever command was reading when it came, and
  the shell then latches without raising a link event. A reader that records the error and carries
  on leaves Live sync on over a dead link.
- **What it reads is applied one address at a time, and a value is dropped if a notify for its
  address arrived while it was being read.** Reading several addresses in turn and applying them
  together overwrote a notify that came in between with the older reading, and recorded a round
  trip that never happened.

Both were reproduced and fixed in the review of that pull request.

## Reading the silent families ahead of the write (the park)

The mechanism is in architecture.md (the two parks under "Live control connection") and in
[channel-tuning.md](../channel-tuning.md), "FX EFFECT"; the changes are
[#472](https://github.com/semnil/urx-router/pull/472),
[#476](https://github.com/semnil/urx-router/pull/476) and
[#477](https://github.com/semnil/urx-router/pull/477) (2026-09-08 to 2026-09-10). What is closed:

- **The remedy is a read in front of the write, and only that.** The families the unit announces
  nothing for when they are moved on its panel — the FX parameter array, the insert-FX engine array
  with its three selectors, and D.Gain — cannot be covered by a subscription. A converge re-sends
  whatever differs across its write scope, so left alone it overwrites what was set on the unit
  with the plan's older copy.
- **The read sits at the boundary of `LiveSync.flush()`, not on the UI's selectors.** The version
  hooked to two selectors missed an undo, a MIDI assignment, a plan load and the insert-FX
  selector. At the boundary one read covers every writer, and the UI keeps no hook. Putting the
  read back on the selectors is not proposed again.
- **A head's park lays the addresses out by the head the unit is on.** When the layout head (an FX
  EFFECT TYPE, an insert-FX selector) differs between the plan and the unit, one address means two
  different parameters, and a read laid out by the plan's head puts the wrong parameter's value
  into the plan.
- **A head is taken only when two readings in a row agree.** "The same before and after the read"
  lets through a head that went away and came back while the read ran.
- **What is read is merged, not substituted.** A version that rebuilt the parameters from the
  active family alone erased the settings of the families the channel was not using.
- **The guard "the unit still holds what this session last sent, so answer with the plan's value"
  does not apply to an address a layout head lays out.** Only what no head lays out — an FX's ON
  and LEVEL, an insert FX's bypass — carries that guard at all times.
- **A flush takes no park, one or two, and the two conditions are independent**: whether anything
  is outgoing, and whether a side effect is being sent. Not every converge head declares a reset,
  so the one-park flush — the converge side alone — is real: COMP/EQ Type, BUS Type, Signal Type,
  PAN/BAL. Writing "always two" also gets the guarantee on failure wrong. "A failed read writes no
  type at all" is the guarantee of a head with a park in front of it; in the one-park flush the
  leading write has already gone out.

**What the move brought with it.** With the read at the boundary, its result arrived through
`requestReflect`'s timer, the Inspector's rebuild gate caught the `<select>` the user had open, and
the next press was spent releasing it. The result is now drained at once (`reflectFollow()`) and the
Inspector rebuilt at once (`rebuildInspectorNow()`). This was found by instrumenting the page, which
showed the focused element to be the `<select>`; reading the code had not found it.

**The test that pins the count.** `live.test.ts` held the flush with no park and the one with two,
and not the one with one. The neighbouring COMP/EQ case looked as if it covered it, but narrows
itself with an early return and passes with an implementation that parks twice. The case added for
the one-park flush fails when the outgoing-size condition is forced true.

## The lifetime of the protection record handed to a park

**Decision (2026-10-14, [#611](https://github.com/semnil/urx-router/pull/611)).** Choosing an EFFECT
TYPE in the Inspector puts the new type's factory values into the plan, and during Live sync hands
the park in front of the type write a record (`fxReseeds`, read as `keepFx`) so that the park does
not overwrite those keys. That record is used only by the park directly in front of that channel's
type write. A record whose type write is no longer waiting — the plan has left that type, or the
type last sent to the unit is already that one (`holdsSent`) — is removed by the next park that
runs (`takeFxReseeds`).

**What happened.** The first version handed the record to any park and did not remove it when no
type write took place (Hall, then Room, then Hall again before anything was sent). Another channel's
COMP/EQ Type change then ran its converge park with the stale defaults still protected, and sent
them. An outside review reproduced it on the stub.

**What follows.** The lifetime of a protection or hold record is tied to the write it is waiting
for. A record made per gesture and removed by one particular consumer survives on the path where
that consumer never comes, and acts on a later, unrelated operation.

## Send throttling

**Decision.** Edits go out on a trailing throttle of `DEBOUNCE_MS`: an edit does not restart the
window. The earlier debounce restarted its timer on every edit, so a continuous drag sent nothing
until it stopped. Every continuous control was affected — the CONSOLE's faders, knobs and sends
included — and the unit heard only the end of a move. One flush translates the whole plan and
diffs it, which is cheap enough to do once per window.

**The exception.** A flush that sends a side-effect parameter runs a converge, which takes far
longer than a window, and a slider that carries the flag (the EQ 1-knob level) would chain
converges if the interval were guaranteed. "Did the last flush converge" is not enough of a test
on its own: the first gesture after a converge, an unrelated fader, would fall silent again. Only
while that latch is set does the flush ask whether the pending difference holds a side-effect
parameter (`convergePending`).

## Matching the announcement (echo) of the app's own write

**Decision ([#339](https://github.com/semnil/urx-router/pull/339), 2026-08-11; the order settled in
[#569](https://github.com/semnil/urx-router/pull/569), 2026-10-11).**

- **An echo is matched against the writes that are acked and not yet announced, kept per address,
  as well as against the snapshot.** Matching against the snapshot's one value turned the first of
  two writes to an address into a device-side change as soon as the second had advanced the
  snapshot, which a drag reaches. The older value was then written back into the plan, a
  whole-device reconcile ran, and the undo history was cleared without a word.
- **Those writes are kept by wall clock.** Borrowing settle's notify sequence would never expire an
  entry on a quiet link, and the entries of parameters that are never announced would pile up.
- **The order is: the value of the write still in flight, then the pending queue, then the
  snapshot.** A match on the in-flight value drops that address's pending queue; a match in the
  queue removes the newest matching entry and everything before it. With the earlier order — the
  queue first, the oldest match — an older value stayed queued when the unit announced only the
  last write of a run, and the user setting the unit back to that value within the retention window
  was swallowed as an echo: it reached neither the board nor the plan.
- **The cost taken.** If every write were announced, late and in order, an intermediate value would
  show for a moment and one whole-device reconcile would run, ending in agreement. The code assumes
  the unit does not announce a write that a later write overtook, so this does not happen against
  a unit.

**A trap in the tests.** A unit test over `DeviceFollow` that waits past the idle reconcile before
asserting lets that reconcile repair the error, and the mutation survives. Whether a value was
followed directly is asserted right after the notify (`live.test.ts`, "ends on the unit's last
announcement…").

## Another client's notify that arrives before the app's own announcement

**Decision (2026-09-24, [#507](https://github.com/semnil/urx-router/pull/507)).** A notify for an
address that has a write of this session issued and not yet announced
(`LiveSync.hasUnannouncedWrite`, asked through follow's `isSuperseded` hook) is not put into the
plan. Its node goes to a scoped read instead. The standing case is
`e2e/race/t1b-overtake.spec.ts`.

**Turned down.** The first fix returned early only when the idle net was being armed, and broke
the refetch path. Deciding to drop a direct value means "do not apply it" and nothing more: the
notify always falls through to the re-read.

## Follow re-reads wait while a flush is scheduled or running

**Decision (2026-09-24, the operator; the same pull request).** While a flush is scheduled or
running, a follow reconcile waits (`live.isWriting`). This replaced the rule settled earlier, "wait
for a converge only, and run beside an ordinary flush".

**Why.** The re-read of the section above (a) let settle take another client's value for the
announcement when it started between a write's ack and its announcement, (b) merged away an edit to
the same node that was still waiting to be sent — this one predated the pull request and happens
with an ordinary device-side change — and (c) had no such test for names at all.

**Turned down.**

- **Waiting only through the replacement window.** It leaves the general form of (b).
- **Holding the unsent keys with a plan write watch that is always open.** Its witness counts a
  write that came from the unit as an edit of the app.
- **Laying the overlay of sent values over follow's reads.** Unsent values would enter the device
  view, and the snapshot would record them as sent.

**What followed.** `t8-stress` now puts the read on the wire before the keystroke to make the
overlap; `tzb-tail`'s bulk change during a drag accepts both "read in the gap between flushes" and
"read after the release"; and the unit case in which a refetch stayed open and consumed the
announcement had become unreachable and was removed, on the operator's decision. The same family
on the refetch side is [#513](https://github.com/semnil/urx-router/pull/513): a flush that finds a
refetch head among the values it takes first opens the edit watch before its first write and hands
it to the read, and a head that appears after sending began waits for the next flush.

## A value held for the next flush is guarded on every path that rewrites the snapshot

The rule is in architecture.md, "The internal re-bases: the snapshot and the history baseline" —
the paragraph and the table after it ([#513](https://github.com/semnil/urx-router/pull/513),
[#514](https://github.com/semnil/urx-router/pull/514)).

**What happened.** After deferral went in, six review rounds each found one more path that recorded
an unsent value as sent: the converge's send, the capture after a converge, an address that first
appeared while the flush ran, another node's refetch read-back, and the channel name a refetch does
not read. The table's rows were left behind while the paragraph was corrected round by round, and
pull request #514 corrected them after the merge.

**What follows.** A change of this kind starts by listing the writers of the snapshot — the callers
of `capture`, and `noteDirect` — together with what each read actually read, and gives each path a
test in which the unsent value goes out in the next flush. When the paragraph is corrected, the
table in the same section is read as well.

## Display-update throttling

**Decision.** `requestReflect` is a gate on a timer (`REFLECT_MIN_MS`), and the direct path, the
scoped read-back and the whole-device read-back all go through it. The mechanism is in
architecture.md, "The display update".

**Turned down.**

- **Coalescing on animation frames.** On a 120 Hz display it spins with nothing to draw.
- **Removing `graphDirty`.** The flag tells "a follow batch needs a refresh" from "a CONSOLE edit
  needs a repaint only", and that cannot be derived from the graph being hidden.

## An incomplete follow read merges nothing

**Decision (2026-10-11, the operator; [#580](https://github.com/semnil/urx-router/pull/580)).** All
or nothing: a follow read that comes back incomplete puts none of what it read into the plan. What
was wrong before, and the cost taken with this rule, are in the pull request.

**Turned down.** Keeping the partial merge, marking the nodes that could not be read with a "?",
and leaving the history alone.

**The two guards are separate.** Removing `accept` fails the unit case alone ("merges nothing from
a reconcile whose read comes back incomplete"); moving `assertReadComplete` back fails the two race
cases alone. The race tier reads what is drawn, so it stays green over a dirty plan as long as the
reflect does not run.

**Writing the unit case.** A read fails per node, so a refusal inside one node merges nothing
either way and tells nothing apart. Two nodes are notified together and the read of one is refused.

## The cap on holding sends while a converge is pending

**Decision (2026-10-11, [#592](https://github.com/semnil/urx-router/pull/592)).** While a converge
is pending, the re-arm stops `CONVERGE_DEFER_MAX_MS` after it began. The comparison behind that
value, with the other values tried, is in the pull request.

**Two defects the cap brought out**, both independent of it
([#591](https://github.com/semnil/urx-router/pull/591)):

1. The converge's writes were not registered for the echo check, so follow read the announcement of
   a fader sent from the frozen copy as a move on the unit and took the plan back.
2. The capture after a converge restored, from the journal, a panel move that the converge's write
   had since overwritten. The journal entry of an address is now dropped when the converge's write
   to it is accepted. **Turned down:** clearing the journal in one go when the converge ends, which
   loses a panel move made after the write.

**Closed (the operator).** One run under an earlier, longer cap ended with the plan and the unit
apart after a single operation. It predates the announcement log, its mechanism is unknown, and
defect 1 was active in the same run. It has not occurred since the log went in.
**Turned down:** running the code from before #591 until it reproduces. **Reopen when** the same
symptom appears; the announcement-verdict log is taken first.

## No announcement is required per write

**Decision ([#446](https://github.com/semnil/urx-router/pull/446)). Not proposed again.** `settle.ts` no longer holds that one notify answers one write. The code assumes the unit
does not announce a write that a later write overtook. Requiring an announcement per write reported
every operation of a drag but the last as "a write that reached nowhere", and armed a whole-device
reconcile each time. Outstanding obligations are now merged forward per address.

**Also not proposed again.** A ledger of notify positions. After the merge it can give no answer
other than the one the last-notify test gives; the merge is what solves "two writes share one
mark".

**Where the merge stops.** It reaches obligations that have not been judged yet. The write that
follows one already judged asks for its own announcement.

## The link outlives the session

The decision and its reasons are in architecture.md, "Session teardown", and in
[#450](https://github.com/semnil/urx-router/pull/450): ending a session does not
interrupt a follow read, the link is closed after the reads in stock are done, and the holder is
handed back after the disconnect. One part is recorded here.

**A failed disconnect is reported only when the session did not end on an error**
(`reason !== "error"`). The version that reported it unconditionally stacked a second dialog on the
one `stopLiveOnError` had already shown for the same disconnect. Two cases of the race harness's
`t5-drop` refused it; no mutation had caught it.

## The status line's vocabulary

**Decision.** The status bar carries a subset of the link ledger, printed with the panel's own
labels and figures ([#253](https://github.com/semnil/urx-router/pull/253)). **An item is added to
the bar only on the operator's explicit instruction.**

**`#statusbar` stays the message element.** It was once turned into the container of the whole bar.
The E2E specs use that id to mean "the text of the status line", so the row was given the new name
(`.statusbar-row`) and the id went back to the message.

## A rate change's line is not replaced by the session's

**Decision (2026-11-13, the operator).** A line shown to the operator must not be replaced before it can
be read. During Live sync a rate change's own send and the read that follows the re-clock report at once,
so the rate's line — the rate, and what it took off the plan — leads every sync and follow line until
anything else takes the status line. A read's refusals keep the span they had: the full read of their
own burst, and not the next burst or a send.

**Left for a pull request of its own.** The same holds for every other line an operator's action writes,
and the status line cuts a line too long for it with an ellipsis. Both were decided to be handled across
the app in a separate pull request, after the Flex12GEQ one.

## Clip Safe OFF waits for the A.Gain announcement

**Decision (2026-10-15, chosen by the operator;
[#636](https://github.com/semnil/urx-router/pull/636)).** The A.Gain goes first, and a Clip Safe
OFF is held until the unit announces the value of the last A.Gain written to that jack
(`ClipSafeHold`, `WriteSettle.announcement`; what `settle()` means is unchanged). A live session
holds one hold for its lifetime and drops it at `begin()` and `end()`. The bound on the wait is
counted from the A.Gain's send.

**Turned down.**

- **Making `CLIP_SAFE` a converge head.** The converge's re-read finishes before the unit puts the
  A.Gain back.
- **Spacing the two writes in time.** A gap between the two sends is not a gap between the unit's
  handling of them, and the A.Gain still went back.

## Edits lost on the stub (P-1)

**Decision (2026-10-10, the operator;
[#572](https://github.com/semnil/urx-router/pull/572)).** The loss — an Inspector edit made straight
after a followed device-side change, on the stubbed shell — had stopped occurring on `main` by
the time it was looked at again. Which commit cured it was not bisected; a regression case was
added instead (`e2e/followedit.spec.ts`).

**The shape of the regression case**, settled in the review of that pull request. The first version
had the driver wait for a transient status line and then press. That line is replaced by the line
of the idle whole-device read, so a late observation failed correct code. Run against the commit
that had the defect, the press was tried at three moments: straight after the scoped read lands
(the option approved first) passed every time and so caught nothing; the first version's driver
click failed; and a press inside the flush's wait, as the whole-device read starts, failed every
time. The operator then decided that an observer in the page presses
`IDLE_FULL_MS - DEBOUNCE_MS / 2` after the notify's own line.

**What follows.** A regression case written in the shape that was asked for does not necessarily
fail on the version that has the defect. It is run there.

## Send pans under Pan Link

The behavior is in architecture.md, "Reset chains, and what a converge round sends"; the changes are
[#534](https://github.com/semnil/urx-router/pull/534) and
[#535](https://github.com/semnil/urx-router/pull/535).

**Decisions (2026-09-29, the operator; not raised again).**

- **After Pan Link is turned off, the send pans take their sources' values**, as the unit leaves
  them (`sendPansToSources`, called from the panel's edit and from follow's direct path). Writing
  back what the plan held before the link was not taken.
- **A FIXED bus's send shows its stored PRE, read-only** — the same rule the surface follows for
  Level and Pan ([console-sends.md](../console-sends.md)). The first implementation showed the
  effective value (unlit) and was sent back. Only the GRAPH's PRE mark and the Ducker note answer
  with the signal flow (`sendIsPreFader`).
- **`PAN_LINK` carries no `sideEffect: "converge"`.** A Write with the declaration and one without
  took the same number of rounds and left no residual.
- **Writing Pan Link ahead of the sends does not make a switch-off land first.** A send pan in the
  same round still moves its source, and the next round puts it back. The passing difference is
  accepted and the description was corrected; deferring the sends to the next round was not taken.
- **Undoing a Pan Link ON returns the send pans to what they were before the link.** Undo goes back
  to the plan before the gesture; the first decision above is not applied to it.
- **When the unit's own screen sets a bus to FIXED, it turns Pan Link off without announcing it.**
  A re-read that sees `panLink` go from on to off therefore sets the sends it did not read to their
  sources (a whole-device re-read reads the sends and releases nothing). This covers only the window
  between a scoped re-read and the idle whole-device reconcile, which reads the sends too. It is
  kept, with a unit test as its guard and no phase in the race harness, where its verdict would
  depend on time.
- **The plan's send pans are kept at their sources' positions while the link is on**
  (`sendPansToSources` at both edges, `alignLinkedSendPans` when a linked source moves), **and a
  loaded plan is aligned too.** The version that did not align on load was sent back in the
  re-review of #535: the CONSOLE's read-only SEND PAN knob, the MIDI feedback and the next save
  would have gone on giving the document's value, and since a surface shows what the plan holds,
  swapping the display alone was not an option.

**Superseded (2026-10-14, [#611](https://github.com/semnil/urx-router/pull/611), on the operator's
instruction).** "A FIXED bus still keeps and writes the plan's `panLink`" no longer holds. Setting a
bus to FIXED in the Inspector turns the plan's `panLink` off, as the unit does, and going back to
VARI does not restore it. A loaded document or a device read that brings FIXED with Pan Link on is
written as it is.
