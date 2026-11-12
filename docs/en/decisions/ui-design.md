# Decisions: the look of the UI

> 日本語版: [../../ja/decisions/ui-design.md](../../ja/decisions/ui-design.md)

Closed decisions about how the app looks: its style, themes, toolbar, contrast, focus, wire colours,
motion and the polarity mark. The rules as they stand are in [architecture.md](../architecture.md),
"Display themes", "Windows high contrast (forced colors)", "Localization (i18n)" and "Preferences",
and in the comments of [src/style.css](../../../src/style.css). This document holds what was chosen
over what, and why. "The operator" below is the person who directs this project's work and decides
for it.

## Studio-rack look, two themes

**Decision.** The UI is drawn as a studio rack and patch bay: brushed metal, amber LEDs, mono LCD
labels, a rail in the module's colour, jacks, and wires in patch-cable colours.

**Turned down.** Two other styles were considered: an engineering drawing or schematic, and a refined
editorial minimalism. The rack is the one that fits what the product is.

**How it came to two themes.** The app was dark only at first. The light theme (brushed aluminium on
a cream console) was added at the operator's wish.

## Language and theme live in Preferences

**Decision.** The toolbar's language and theme buttons were removed, and the two settings moved to the
"Language & theme" section of the Preferences modal. The toolbar had become crowded enough to show a
horizontal scroll bar.

- **The language is a drop-down, not a two-way toggle.** It was first built as a toggle; the operator
  changed it during the implementation so that a language can be added later.
- **The two storage keys stay their own** (`urx-lang`, `urx-theme`). They are read before the settings
  are loaded, so they are not folded into `urx-settings`.

## Toolbar

- **The four display toggles on the right went into a View menu.** It is the third use of the same
  menu helper as File and Device, with no special case. The toolbar stopped overflowing at 1280px.
- **The brand is the logo alone.** The subtitle under it and the decorative level bar were removed.
  The subtitle had gone stale as the app grew; replacing its words would go stale again, so it was
  deleted.
- **The Device menu's groups are divided by static separators**, and the experimental items are
  revealed together. The logic that showed separators dynamically was removed.
- **Turned down: menus at the left with the view tabs in the middle**, the usual desktop
  arrangement. It was shown and passed over; context stays on the left and actions on the right. The
  View menu keeps its name and the File menu its order.
- **The E2E does not count separators.** It asserts the logo-only brand and whether the experimental
  separator is visible. A count breaks the next time a group is added.

## The model picker locks for a live session only

**Decision ([#307](https://github.com/semnil/urx-router/pull/307)).** The on-air tally no longer
names the model, and the model picker is locked during a live session instead. The tally and the
picker had been showing one fact twice: a session only ever connects to the model on the board.

**Not to be aligned.** The lock covers a live session only. The rate picker is locked against any
holder of the link, and the two are different on purpose: while Live sync is starting, the offer to
switch models may rightly change the model, and a switch is already refused while a device read is
in flight. Making the two the same "for consistency" would block the start path.

**The model the app opens on.** The last model chosen is restored; with nothing stored the app opens
on the URX44V. It is the one model that has HDMI THRU, SD recording and Line Out, so the first screen
shows the most.

## A replacing drop is ringed in the warn colour

**Decision ([#579](https://github.com/semnil/urx-router/pull/579)).** Dropping a second source on an
input that takes one replaces the first. While dragging, that jack keeps the "can connect" fill and
only its ring turns to the warn colour. No colour was added.

**Turned down.** Showing an addition and a replacement with the same green: that a wire is about to
disappear cannot be seen before the drop.

## Contrast: two yardsticks

**Decision (2026-08-06).** Pass or fail is the WCAG 2.1 contrast ratio. The choice between dark ink
and light ink on a ground is made by APCA Lc.

**Why two.** The ratio picks the wrong ink systematically on saturated mid-tones: over the ten
channel colours and the ten rail colours the two yardsticks disagreed on 12 of 20. The operator looked
at the grounds and found the ink Lc picks easier to read on each of the 12. Lc is not used for pass or
fail because its size table gives nothing below 12px, and the engraved labels here are 7 to 10px.

## The floor is Lc 60

**Decision.** If neither ink reaches Lc 60 on a ground, the ground is what gets fixed. The value sits
between a lit chip that was rejected (55.4) and a cyan that was accepted (60.7).

- **Four grounds did not reach it.** The LED amber was solved with a face colour of its own
  (`--led-face`). The dark theme's BUS green and OUTPUT ochre keep their colours and get a halo. The
  unit's orange gets a halo only. The operator judged the last three again on the real app, and the
  inks chosen agree with what `inkOn()` picks.
- **"The ratio went up" is not "easier to read".** Darkening the ink on a lit chip took the ratio from
  2.46 to 7.66 and Lc only from 52.9 to 55.4. What works is the lightness of the face: `--led-face`
  with dark ink, and an edge in `--led-ink` that gives back the difference from an unlit chip.
- **The light theme's `--led-ink` is `#755407`**, not `#7a5a08`. The latter falls to 4.27 on the open
  PAN chip, whose face is tinted amber, and the darker value avoids making an exception to the rule.
- **The dark theme's dimmed label went from `#ab9b7d` to `#c2b293`.** The old value passed the ratio
  and sat under the floor. The smallest step that reaches the floor was taken; `#d4c4a6`, which would
  have matched the light theme's spacing between steps, was turned down. `--text-dim` was later raised
  again so that it reaches the floor on every ground, and
  [style-scale.contract.test.ts](../../../src/ui/style-scale.contract.test.ts) pins that.
- **The first version of `inkOn()` had the right mechanism and the wrong yardstick** (the ratio).

## The light theme's focus ring stays amber

**Decision (2026-08-06).** The focus ring in the light theme is amber, at 1.90 to 2.18:1 against its
grounds. That is under 3:1, and it was chosen knowing so: focus is shown as "lit", and the vocabulary
was kept whole. Not raised again.

## Plot text uses `--plot-dim`

**Decision (2026-08-06).** The dB scale of a tuning screen moved from `--plot-faint` to `--plot-dim`.
`pnpm test lit-face` now refuses `--plot-faint` on text in a plot.

## The second audit (D1–D9)

Decided on 2026-08-08. The rules it left:

- **There is one lit face.** An action's face follows from what it does: only an action that commits
  is lit, and Close is a raised button.
- **Focus is amber**, and white with a dark halo only on an amber face.
- **A modal has one shell and one width.**
- **A section's level is said at the left edge**: the body under a heading is indented.

**Focus has three forms.** Amber; white with a halo on nine faces (amber truly fails on three lit
faces, and going back means dropping five selectors from the rule); and, added in
[#554](https://github.com/semnil/urx-router/pull/554), a ring in `--on-accent-ink` drawn inside the
lit face where the rack is too tight for a ring outside.

**D2: Close buttons.** Four Close buttons moved from the primary class to the secondary one, which
meant rewriting the locators that named them. Swapping the CSS alone was turned down: the primary and
secondary classes would then draw each other's face.

**D7: making the app inert under a modal.** A depth counter (`holdAppInert`) with an idempotent
release. Review corrected it three times: the scrim is a sibling of `#app`, so it does nothing for a
modal on top of a modal; showing a modal again left its claim dangling; and **the top modal is the one
displayed on top (by `z-index`, then document order), not the last to claim**. Turned down: matching
`z-index` to the claim order, and holding a class-to-rank table in TypeScript. Either states the
ladder twice. [e2e/licenses.spec.ts](../../../e2e/licenses.spec.ts) has the way to reach that order.

**D9: what went wrong.** The indent was first a `margin-left`, and a table with `width: 100%`
overflowed. The check had looked at the scroll width of the modal body where it should have looked at
the section itself. The fix is `padding-left` with a negative margin on the heading.

## Tuning-screen launcher face

Settled in [#346](https://github.com/semnil/urx-router/pull/346). The mark for a disclosure follows
where it leads: `▸` opens a screen, `▾` opens something over the same place. INS FX and EFFECT are
exceptions because they have a second axis (which effect), and that is **not generalized**.

## Select recipe

Settled in [#350](https://github.com/semnil/urx-router/pull/350): the recipe is held as a list of
selectors and not by id, the control stays the platform's menu list, and nothing is added to the open
drop-down.

## Wire colours: three groups

**Decision ([#273](https://github.com/semnil/urx-router/pull/273)).** The six connection kinds are
drawn in three colours. By structure there are two kinds of wire — a selector (drawing one replaces
the other) and a sum (each one adds) — and the six kinds belong to the model.

- **Legend.** Five rows, with the merged row named "Output / Rec select". Two other namings were
  turned down: one put "Output" on the screen twice, the other left a wire the legend did not point
  at.
- **The light theme's send colour is a blue-green.** A plain green reads better with typical colour
  vision; the blue-green raises the separation for protan vision from 5.6 to 10.0.
- **What colour vision gained most** is record against source for deutan vision in the light theme
  (ΔE 1.6 to 14.8).
- **"Leaves from the top edge means recording" does not hold.** Colour and jack are independent: on
  the URX44V some patch wires leave from the tap and some record wires do not, and the URX22 has no
  record rule at all. "The geometry is strong, so colour can be reduced" cannot be generalized.
- **Hue alone cannot separate five kinds.** If five are ever needed, they need line styles or end
  markers.
- **What the tests compare** is the wire tokens and the warn colour. The rail colours and the canvas
  ground have no check on the app side.

## Motion

**Decision.** The only animation that repeats without end is the armed state of MIDI learn, and there
is one armed control at a time. With animation off it is held on its bright side.

## Tests of a face

A test that pins a face is not finished at "the two are equal": it fixes one token and also checks
that the resolved value is not transparent. Two transparent values are equal.

## The polarity mark is Ф

**Decision (2026-10-11, [#599](https://github.com/semnil/urx-router/pull/599)).** The polarity mark
is Ф (U+0424) everywhere. The operator chose it from a table of the candidates drawn in the typefaces
the app is shown in; each other candidate came out as a looped glyph in one of them or was missing
from one. Not raised again.

- **A screen reader is given a word, Phase.** Read as a character, the mark is spoken as the name of
  a letter.
- **Turned down: putting the spoken word into a sentence as an image part** (`role="img"`). One
  screen reader then announces every part as a graphic. The name goes on the element as
  `aria-label`; a status line gets an invisible live region beside it; a row that cannot be named is
  shown `aria-hidden` with the spoken form in `.sr-only` text.
- **Tooltips.** A tooltip that holds the mark moved to an `aria-hidden` area over the control, and
  the control carries the spoken form as `aria-description` (`setTip`). The operator chose this among
  the options shown.
- **What went wrong in review.** A split switch with `role="group"` was treated as one control and
  covered whole, and after an assignment its ON / OFF could not be pressed. The unit test passed,
  because jsdom does no hit testing. The cover is now handed to each control inside a group, a case
  in [midi-arm.contract.test.ts](../../../src/ui/midi-arm.contract.test.ts) checks the covers on every
  screen for every assignment, and each E2E case ends by checking that no bare mark is left.
