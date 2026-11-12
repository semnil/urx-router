# Decisions: the inspector

> 日本語版: [../../ja/decisions/inspector.md](../../ja/decisions/inspector.md)

Closed decisions about the inspector ([src/ui/inspector.ts](../../../src/ui/inspector.ts)) and about
the values it shows. How the panel is laid out is in [architecture.md](../architecture.md),
"Responsive layout (mobile)"; the order and labels of the tuning screens are in
[channel-tuning.md](../channel-tuning.md); what happens to a plan when it is loaded is in
architecture.md, "An FX channel the plan does not describe". This document holds what was chosen and
why. "The operator" below is the person who directs this project's work and decides for it.

## Rows follow the unit's screens

**Decision.** From top to bottom, the parameters of a node or a connection are in the order in which
the unit's own LCD screen is read, from top left to bottom right, as the user guide shows each
screen.

**Why.** Someone operating the unit can look things up in the same order.

**Settled with it.**

- **A node's ON / OFF is the first row of its parameters, on every kind of node.** The channel alone
  had it at the bottom, after INS FX; it was moved.
- **The EQ shows one band at a time** (about twenty rows became six). The order inside a band did not
  change. Which band is showing is not kept, like a selection. The band editor now lives on the
  tuning screen, which opens on the first band each time.
- **A tag is not a lock.** On one guitar-amp type, two values do not reach the signal unless the
  modulation is vibrato, yet the unit keeps them and accepts writes to them; the rows carry a tag and
  stay editable. The predicate was split in two for this: `insertFxLockedSlots` (nobody may write
  this) and `insertFxInactiveSlots` (this does nothing right now). While one function answered both,
  a row of the second kind was drawn sunk like the first.

## The unit's screen outranks the guide

**Decision (2026-08-30).** A string marked `dev()` is text taken from the unit's screen. The printed
guides are not that: the operator read the unit's screens and showed places where a guide writes a
row name differently, or lists a slot by its values where the unit shows a name.

When only a guide is at hand, the unit's wording is not guessed. The operator is asked to read the
screen.

## Face-bar names are not the unit's

**Decision (2026-08-30).** The segment names on a tuning screen's face bar (Main / Low / Mid / High,
and Main / Comp / Side Chain / EQ on the SSMCS screen) do not appear on the unit. Three of them
had been declared `dev()` and were changed to `fixed()`.

The marker stops translation through the type system and does nothing else. Whether a declaration is
true is not checked by anything.

## Load-time fill and provenance

**Decision (2026-09-05, [#461](https://github.com/semnil/urx-router/pull/461) and
[#462](https://github.com/semnil/urx-router/pull/462)).** The panel used to draw a default for a
parameter the plan did not have, and the write did not send it. Two fixes had been on the table —
change the sending side, or change the panel. Neither was taken. The plan is **filled with the
model's factory values when it is loaded**, so the panel and the wire read one value.

- **Making the sending side match the panel was destructive.** It was implemented and taken back.
- **The fill and its protection cannot be separated.** A filled plan makes a write send every key, so
  on its own it would overwrite settings on the unit that nobody chose. #461 paired it with a record
  of where each key came from (`load`, `default`, `manual`, `device`) and with a write confirmation
  that names the strips nobody touched. There is no form with one half only.
- **A write that lands does not repaint the key as `device`.** The operator's first instruction asked
  for it. Implemented, `default` to `device` could not be seen, and `load` or `manual` to `device`
  made the app warn about a value the operator had written themselves. What silences a landed value
  is the diff: it no longer differs from the unit.
- **A read from the unit marks only the keys it adopted**, taken from the merge patch. Marking by
  node would sweep in the keys a conflict kept and the nodes that could not be read.
- **Importing a settings file marks the keys `load`.** The file may have been written by another
  unit.
- **The inspector's fallback constants were left as they are.** After the fill, the only path that
  still falls back is a node the fetch could not read, and there the value is unknown either way.

**The same shape afterwards.** Each of these is a repair at load, reported on the status line:

- [#535](https://github.com/semnil/urx-router/pull/535): the pan of a send into a linked MIX.
- [#537](https://github.com/semnil/urx-router/pull/537): a number written where a boolean belongs.
  The operator decided to convert at load, to the value a write would send. The leaves to convert are
  derived from whether the factory value is a boolean, not from the types, which missed nested ones.
  The conversion runs before every other check. The status line gives a count and no direction: a
  later rule can turn a converted value back off, and "turned on" would then be false.
- [#539](https://github.com/semnil/urx-router/pull/539): the repairs run from one place
  (`applyLoadRepairs`, then `prepareLoadedPlan`). The order had been written out by hand in three
  places, and one of them had fallen two repairs behind.
- [#538](https://github.com/semnil/urx-router/pull/538): the documents point at the list of repairs
  and no longer give a count of them.

**What to take from it.** When what is shown and what is sent disagree, the choice is not between
those two sides. First see whether loading can make both readers see one value. And a fill goes in
together with the provenance record and the warning, in the same change.

## Inspector edits take the unit's own side effects

Settled in [#611](https://github.com/semnil/urx-router/pull/611): an edit made in the inspector also
takes into the plan what the unit changes by itself when the same thing is done on its panel. The
rules sit in the panel's own patch shaping, or in actions that only the panel calls; no "who is
asking" flag was added to the path that every surface shares.
[#658](https://github.com/semnil/urx-router/pull/658) brought the CONSOLE's effect-type choice and
delay time into line with it.
