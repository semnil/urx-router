# Decisions: external MIDI control

> 日本語版: [../../ja/decisions/midi-control.md](../../ja/decisions/midi-control.md)

Closed decisions about driving the CONSOLE's and the tuning screens' controls from an external MIDI
controller, and what happened around them. How it works is in [architecture.md](../architecture.md),
"External MIDI control", and which rows of a tuning screen can be assigned is in
[channel-tuning.md](../channel-tuning.md), "MIDI assignment". This document holds conclusions: what
was settled, what was turned down, and what is not proposed again. That the unit's own USB MIDI port
is not a control route is in [device-control.md](device-control.md). "The operator" below is the
person who directs this project's work and decides for it.

## The MIDI ports are opened in the shell

**Decision.** The MIDI side is handled in Rust, with midir (`src-tauri/src/midi.rs`), and the feature
is desktop-only. The reason is that the desktop webview on macOS (WKWebView) does not support Web
MIDI, so the page cannot open a port itself. With the port side in the shell, the browser and demo
builds have no MIDI control (architecture.md, "External MIDI control", under Scope).

## Wording

- **Take-in modes are `absolute` and `pickup`, and nothing else.** `relative`, for endless encoders,
  was removed and is not proposed again. A saved mapping that says `relative` is moved to `absolute`
  when it is loaded, and the binding is kept.
- **A button's behaviour is named after the kind of button on the sending side**: `edge` is
  "Momentary" and `state` is "Toggle". The earlier names described how the receiving side reads the
  message, and they crossed with the sender's names.
- **The labels of the mode and button-mode options stay in English in the Japanese UI.** Only their
  descriptions are translated. The katakana for "absolute" did not fit the select of the earlier
  panel, and the translation was dropped then.
- **GAIN is left as it is.** The assignment list prints the parameter table's `GAIN`, and the CONSOLE
  prints A.GAIN or D.GAIN. The operator accepted the mismatch; it is not something to fix.

## Echo guard

- **No refusal interval timed by a clock** (2026-08-09). An interval that refuses incoming messages
  for a while after a send protects nothing unless it is long, and a long one throws away real
  operation. What guards against an echo is the match by value, which does not depend on the round
  trip's delay. The initial send is therefore not placed inside any refusal interval. Not proposed
  again.
- **`ECHO_MS` went from 300 ms to 50 ms** (2026-08-14,
  [#366](https://github.com/semnil/urx-router/pull/366)). The window was far wider than an echo's
  delay, and on a controller that returns no echo it ate real presses: the confirmation sent for the
  first press armed the guard, and a second press of an `edge` button, which carries the same value
  every time, arrived inside the window and was taken for the echo. `RECENT_MS` is a different
  constant and was left alone.

## What goes out at start-up

**What happened.** A second instance of the app, on starting, sent the values of a plan it had not
yet read from the unit to a bus the first instance was listening on. The first instance, in Live
sync, applied them as a controller's operation and wrote them to the unit.

**Decision (2026-08-16, [#410](https://github.com/semnil/urx-router/pull/410)).** The fix is on the
sending side: nothing is sent, neither the full state nor a difference, until a Live sync read-back
has settled. `liveReadSettled()` opens the output, and the end of the session or a replaced plan
closes it. Closed with it:

- **No burst detection on the receiving side** (the operator's decision). A burst cannot be told
  from what one batch delivers; telling it would take a time window.
- **The operator is not shown that the output is closed.**
- **A fetch and a settings-file import do not open the output.** The cost is known — a motorised
  controller keeps its old position and overwrites the fetched plan when touched — and the answer is
  the pickup mode. architecture.md has it under "What the fetch exclusion costs".

**Incident: two defects the fix itself brought in, both found in review.**

1. The guard stopped the whole pass. With the pass returning early, the bookkeeping on the receiving
   side went with the sending: "the board moved, so disengage the pickup" no longer ran, and a pickup
   left engaged offline wrote the control's position into the plan at the first small move. The pass
   was split into `feedback(resync, deliver)`, so that only the wire and the two caches that describe
   it are held.
2. That split then deleted the pickup state of addresses that had not moved, on every pass. The
   deletion hung on reaching the emit, the emit was guarded by the sent-value cache, and a held pass
   does not write that cache, so the comparison never held. The test was moved to the board's side
   (`lastSeen`). **A cache that means "this was sent" is not used to decide anything on a path that
   does not send.**

## Instrumentation

**Decision (2026-08-16).** The trace is written by a dev launch only. Carrying it in a release
behind a build flag was turned down. What follows from that: a packaged build cannot be watched with
this log, since the recorder and its commands are both compiled out. Whether something seen in a dev
build also applies to a packaged one is answered from the code, once the mechanism is known. Where
the instrumentation is and how to use it is in `AGENTS.md`, "Reusable assets".

## A window of its own

**Why.** A tuning screen is always the window's width less 48 px. The earlier panel was fixed at
`right: 12px` and 360 px wide, so at any window width it covered the rightmost 348 px, and that is
the tuning screen's column of controls.

**What changed with it.** The window is a view and holds no plan (architecture.md). `modalOpen()`
no longer counts it, so **undo is not refused while it is open**; the `inert` that `wireDismiss`
applied has no caller; and the Edit menu's events go to the main window only, since the MIDI window
has no history.

**Incident: the race specs.** The panel is driven from four race specs. After the surface moved, the
change was reported green on one browser project and failed seven cases across the three. A change
that moves or renames a UI surface checks `e2e/race/` as well; `AGENTS.md` has the rule under
"Conventions".

## Scope

- **The ducker has the scope `@ducker`** (2026-09-07). Its four values are inside the scope, and
  `duckerOn` stays unscoped: a control id is the key of a saved mapping, so moving it would cut the
  assignments people already have.
- **`sub` and `scope` are not merged**, although gate, comp and ducker now spell them the same. `sub`
  is a key in the plan; `scope` is the third element of an id that is persisted, and that is a
  different namespace.
- **A band is a scope, not a cursor.** A mapping has to work with the screen closed, and the band bar
  goes back to LOW each time the screen opens.

## Gang

One physical control can drive several controls of the same kind. The head — the first mapping
learned on that address — owns the feedback, the pickup engagement and the toggle echo guard, and
incoming values fan out to every member. `src/core/midi/` in architecture.md's "Source layout"
describes the mechanism.

**Turned down.** Making the pickup a pre-pass (it came out more complicated), and moving the member
rows' left rail to the `var(--rail)` convention (the green LED accent is deliberate). The fast path
for an address with a single mapping stays: it is the hot path, taken by every message of a fader
sweep.

**Incident: the order of writes decided the result** (2026-09-04, found one at a time over four
review rounds). `apply` was split into `decide` and `commit`, and a gang now decides every member's
target from the state before the message, then writes. What made each case hard to see:

- **Applying one member moves another member's control** — the mirror of a linked pair. Written in
  turn, the second member read the value the first had produced and undid it.
- **Members share a lock.** EQ's 1-knob computes four bands. A lock coming **off** can be picked up
  by a retry; a lock going **on** cannot be taken back after its owner has written, so the order has
  to be fixed before writing. The catalogue's `governedBy` declares it: the governed side is written
  first.
- **Polarity is not declared.** A 1-knob locks the bands while it is on and its own level while it is
  off. One rule — governed first, governor after, a refusal is retried — covers both directions, and
  nothing has to be predicted.
- **A retry re-submits the decision. It does not decide again.** An `edge` target is the inverse of
  what was read, so deciding again would make the result depend on the order of learning.
- **The key is the pair, not the channel.** A BAL link copies the node's parameters whole, so two
  1-knobs are one governor. Under PAN each channel keeps its own EQ and COMP, so they are not
  normalised.

**Incident: who gets written at all** (2026-09-04, three more rounds). Members that the mirror keeps
equal are folded into one decision (`mirrorId`).

- **Ordering was not enough.** A mirror settles on whatever was written last, so a pair whose values
  differ at the start was decided by the order of learning — and that state is reachable, through a
  save and a load that report no problem.
- **What a mirror covers is a property of the node and of the link mode.** Declared where each
  parameter is generated, it is always missed somewhere. It is attached to the finished list in one
  step: every control under BAL, the insert effect alone under PAN.
- **A decision to do nothing keeps its seat.** `button` is deliberately not ganged, so a release one
  member ignores must not be acted on by the other on its behalf. `decide` returning null means
  either "not in the plan" or "not addressed to me", and only the first lets another member speak.
- **A gang's boundary is the address.** One CC reaches both the plain CC address and the 14-bit one,
  so folding by mirror alone let a member of another gang speak.

**The same shape twice in the implementation.** The key was first `mirrorId` alone, and the primary,
which answers to its own id, was never in a group. Then the seat test was "the id equals the whole
key", true only while the key was the id. Both were predicates leaning on an asymmetric
representation — only the secondary carries `mirrorId` — and both were rewritten to ask for the
property they depended on.

## The assignment that never arrived

Turning Learn on once delivered no MIDI at all. The cause was not in the MIDI layer: the shell's
handling of a page load closed the main window's ports and session when the MIDI window opened. The
rule that came of it is in architecture.md, "Session teardown".

**What the E2E suite cannot reach.** The stubbed shell has no page-load hook of a real webview, and
the second page is only a Playwright page; reproducing Learn during Live sync in the race harness
came out green. **The net is the Rust unit tests**, which pin who owns a session and a sleep
assertion. `cargo test` runs on pull requests now; before, no pull-request job compiled `src-tauri`
at all.

## No memo on resolve

**What happened (settled in review, 2026-08-29).** `resolve()` memoised by the plan **object**,
which an edit in place never changes. A bound control closes over the insert-effect family, the
processor and the send it was built for, so the memo went on answering after the node had given the
effect up: writes went to a slot that is never sent and surfaced the moment the operator chose the
effect again, and `get()` fed stale values to the feedback. A guard on the setter alone would not
have been enough. The memo protected against the replacement of the plan, which no longer happens,
and missed everything that does.

**Decision.** The memo was removed. The catalogue alone knows what exists, so it is asked every
time, and an id that is gone resolves to null, which callers already handle. Before it was removed
the cost was counted: 22,000 binds fit in 189 ms of test time, under 9 µs each, and nothing depends
on the identity of a `BoundControl` object. `src/ui/midi.ts` carries the comment.

## Legend

**Decision.** The legend for the BEHAVIOR column is a key printed under the table at all times. A
card shown on hover is not proposed again. The hover card was the right form in the old panel only
because a 360 px strip had no room; a separate window removed that premise, and a hover-only legend
brings in an operation nobody finds.

**What it prints.** Only the vocabulary the list is using — the take-in modes alone when every
mapping is continuous, and nothing when there are no mappings. It does not use amber, which in this
window means "assigned". The two vocabularies share the name column through `subgrid`. It is 290 px
tall in English, 241 px in Japanese and 120 px with one vocabulary; the note's contrast is 6.15:1
and the name's 13.74:1 in both themes.

**Incident: the legend vanished when the panel became a window, and nothing showed it**
([#248](https://github.com/semnil/urx-router/pull/248) restored it). The DOM, the CSS and two E2E
cases went together; the message keys stayed in the catalogue with no reference, which type checking
passes; the tests that would have caught the loss were deleted with the feature; and one line in
`CLAUDE.md` went on saying a helper was shared with the legend.

## Where the marks sit

**Decision.** On a tuning screen the dot goes in the row's label gutter and the ring on the control.
The CONSOLE's placement does not carry over, and three were drawn before this one: outside the
corner, the scrolling column clips half of it; inset at the cell's top right, it sits on the last
character of the readout; inset at the top left, it sits exactly on the knob of a control at its
minimum.

## Left unverified

- **The timing of a physical fader sending absolute CC** was closed on 2026-10-10 as "no such
  hardware at hand" (the operator's decision). It is not raised again.
- **When the frontend's output port became null while the shell still held the port open** is left
  to a recurrence (the operator's decision, 2026-10-10). **What reopens it:** the next time the
  MIDI window's port field reads "None" unexpectedly, read `midi_open_ports` before touching
  anything and record it. Opening the port again erases the state. The probe leaves
  `feedback held — no output port` for this.
