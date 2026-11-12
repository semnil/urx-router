# Decisions: the channel tuning screens

> 日本語版: [../../ja/decisions/tuning-screens.md](../../ja/decisions/tuning-screens.md)

Closed decisions about the tuning screens (GATE, COMP, EQ, DUCKER, SSMCS, INS FX, FX EFFECT), and
what happened around them. How the screens work, and the designs that were turned down, are in
[channel-tuning.md](../channel-tuning.md) — "Rejected alternatives (do not re-litigate without new
evidence)" is the table to read first. This document holds the history that specification does not.
The CONSOLE's own decisions are in [console.md](console.md). "The operator" below is the person who
directs this project's work and decides for it.

## Meter subscription

**Decision (2026-08-15).** The app holds one meter subscription at a time. That is how this app
holds it, not a limit of the unit: the wire has no unit called a subscription, registration is per
address, and the count is one because the shell clears every registered address before registering
the next set. Holding several — a set per consumer with a reference count — is technically possible
and is **not considered** (the operator's decision). It is not proposed again. The mechanism is in
channel-tuning.md, "Meter subscription ownership".

**Incident: the seam between the two owners was stepped on five times.** The handle that releases a
subscription looks as if it belonged to that subscription, and it is global: a stale handle could
cancel the current owner without a sound. A generation stamp and the loan `Console.metersLent` close
it. The five:

1. only the side where the screen takes the subscription was implemented;
2. the CONSOLE took it back at the end of `render()`, which happened only when the screen was opened
   from the CONSOLE;
3. a registration still in flight resolved and erased the other owner's;
4. a face switch sent two registrations at once, and the slower one arrived last and stayed;
5. that failure reached `onMeterError` and dropped a live session.

The last two were fixed by serialising the registrations and guarding by generation
([#390](https://github.com/semnil/urx-router/pull/390)). **Before the next dynamics screen is added,
check what the generation stamp assumes.**

## SSMCS

- **Only the COMP face keeps `persistSel`.** The first version had none of the three faces keep it,
  on the ground that MAIN and COMP have no bar. That ground went away when the transfer curve came
  back to the COMP face.
- **A difference in confidence is not drawn as a line style.** Dashing one of two curves that both
  rest on readings makes the picture say "this one is less sure". What a curve assumes goes in the
  text.
- **The corner model lives in [src/ui/dyn-ssmcs.ts](../../../src/ui/dyn-ssmcs.ts) and is not moved to
  [src/core/control/vd.ts](../../../src/core/control/vd.ts)** (reviewed and turned down, 2026-08-16).
  The `ssmcs*` functions in `vd.ts` each turn one parameter's raw value into its displayed unit. The
  corner is derived from two parameters, and the unit never shows it. Moving it would leave the
  corner floor, the knee reach and the make-up fraction behind, and one transfer model would be
  split across two layers. The side-chain and EQ responses do sit in core
  ([src/core/eq-response.ts](../../../src/core/eq-response.ts)); that asymmetry was already there and
  is not a reason to move the compressor's half.
- **The MID band's Q law was switched together with the drawing that was already shipping**
  (2026-08-16, [#404](https://github.com/semnil/urx-router/pull/404)). The question put to the
  operator was whether to take a change that alters a shipped picture, and the answer was yes. A
  case of "the readings are in, and the picture changes" is not parked in a comment.

## EQ screen

The screen as it is now is in channel-tuning.md ("EQ", "The panel keeps its height", "1-knob, and
what the device owns", and for the insert effects "1-knob is an operator control"). What it took to
get there, including decisions the operator withdrew on the way:

- **The Ladder tab was removed, and the band selector took its place.** A mono channel's HPF is not
  overlaid on the EQ plot, because its response changes with the route through COMP.
- **The position indicator is called a "marker".** "Handle" and "grip" imply that it can be dragged,
  and it is designed not to be.
- **Withdrawn: "the band rows are shown locked".** While 1-knob is on they are hidden instead. The
  height does not change: a row is kept with `visibility: hidden`, and its tag and heading pill are
  kept too, unseen.
- **A row does not disappear with the filter type either.** Parameters is always five rows, and the
  panel's height is pinned in the E2E suite.
- **Withdrawn (2026-08-29): "a control with a destructive side effect is made read-only".** The
  M.B.Comp's 1-Knob and Pitch Fix's MIDI Control had been closed to writing because turning them on
  loses values. The operator turned that down on two grounds: COMP's and EQ's 1-knob have the same
  property and were writable, so these two were the exception; and losing the values is what the
  operator asked for, which is not a reason to block. **The settled form is a driven set, not a
  refusal**: the writer leaves out only the slots the unit recomputes, and the screen locks those
  (`mbcDeviceDriven` and `pitchDeviceDriven`, the same shape as `COMP_ONE_KNOB_DRIVEN`). The
  M.B.Comp's driven set is fifteen slots, and Out Gain alone stays the operator's. An earlier
  reading, that Attack, Release and the crossovers are overwritten once when 1-Knob turns on and
  are free afterwards, was wrong.
- **`DynScreen` was generalised in one step**, with the ducker and the insert effects in view. The
  host does not know which processor it is showing.
- **`--head-h` went from 252 px to 276 px.** A strip that reads a jack with Hi-Z had 0.9 px to spare
  and overflowed by 19 px.
- **Turning the level did not move the curve.** The fix was to split `sideEffect` into `"converge"`
  and `"refetch"`.

## Tags on a card

**Decision (2026-09-05, [#465](https://github.com/semnil/urx-router/pull/465)).** A tag on a card is
one recipe: `.gt-knobtag` and the `.prefs-lock` inside the grid share font, border, padding and
ink. A row outside the grid keeps the settings pill it had.

**Turned down, from a drawing.** Giving the tuning rows the same face was drawn, and an inactive EQ
row became the darkest thing on the screen.

**The exclusion is written per rule.** The row of twelve note keys (`:not(:has(.gt-notes))`) is left
out of the stacking only, not of the face: a row that spans every column has no height to stack a
tag in, and the modal would grow and shrink as tags came and went.

**What it came to.** The pill was 117.3 px wide on a 114.9 px card and stuck out 1.2 px on each
side; it is now 98.7 px, with 8.1 px of clearance. APCA Lc went from 76.2 to 67.0 in the light
theme and from 72.8 to 74.2 in the dark one, against a floor of 60.

## Wiring to follow

- **A screen's `refresh()` is wired to the follow reflect.** Without it, a value moved on the unit
  leaves the screen's slider where it was. A new surface of this kind needs the same wiring.
- **Where the scope guard of `refresh(changed?)` may sit.** The guard that skips a rebuild when no
  changed node is one the screen draws sits **below** `syncBank`, `rebind` and
  `resubscribeIfMoved`, which have to run on every reflect
  ([src/ui/dyn-screen.ts](../../../src/ui/dyn-screen.ts)). The node set it tests holds three things:
  the bound node, the `attachTo` host, and the node a KEY wire starts from (the ducker's KEY lane
  reads another node's Rec Point). **The full branch's `refresh()` is not guarded**: the two
  reconcile hooks add nothing to the dirty-node set, so an empty list is the normal case there.
