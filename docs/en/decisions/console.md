# Decisions: the CONSOLE

> 日本語版: [../../ja/decisions/console.md](../../ja/decisions/console.md)

Closed decisions about the CONSOLE view, and what happened around them. How the view works is in
[console-sends.md](../console-sends.md) and in [architecture.md](../architecture.md) "CONSOLE view
(mixer-style level overview)"; this document holds the history those do not. "The operator" below
is the person who directs this project's work and decides for it.

## Controls a rate ceiling stops were still live on the CONSOLE

**What happened (2026-08-29).** The three warnings at the top of the inspector named the ceiling a
sample rate puts on the unit, and on the strips the controls under that ceiling could still be
operated. The operator pointed it out, and a pass over the view found four places:

- the INS FX face carried a tooltip and nothing else;
- the disclosure beside it was fully live;
- the three controls of an `F2` send column wrote to a bus the unit was not running;
- no CSS rule existed for `.con-sl.readonly`. The class and `aria-disabled` were set, so the
  control was off to a screen reader and looked live to the eye.

**Decision.** The treatment is the one in console-sends.md, "What a rate ceiling does to a
control" and "A column whose bus the rate has taken away": a face stays and goes read-only with
its reason, and a disclosure the ceiling has emptied is not drawn. One predicate,
`nodeRateDisabled`, serves the graph's `disabledNodes` and the CONSOLE. They had been separate,
and that is how the graph came to dim a node whose sends the CONSOLE still offered.

**How the width is tested.** Dropping a disclosure once changed the width of the face beside it.
A test of the rendered geometry does not catch that: with the hidden placeholder in the row, a
face that grows lands on the same width as one that declares its width. The test reads the
declaration instead, the face's `flex-grow` and `flex-basis` (`e2e/ratewarning.spec.ts`).

## Closed decisions on the CONSOLE

These are deliberate. None of them is an inconsistency to be evened out, and none is proposed again
without something new to go on.

- **(a) One mechanism behind three MUTEs.** An input channel's MUTE, a MIX's MUTE and the send to
  STEREO being on or off (TO ST) are the same thing since the unit's V1.3 firmware. "Each kind of
  strip has its own function" is a misreading.
- **(b) The power LED and the OSC keep ON as the positive sense.** Aligning them with MUTE's polarity
  would make the button's name "OFF".
- **(c) Every strip's head is as tall as the tallest one, MAIN's.** The point is that faders and
  meters sit at the same height across the rack.
- **(d) Numbers are printed to the precision the unit's LCD prints them.** They are not normalised.
- **(e) `C.INT` is the label.** `CUE` alone reads as the unit's one-shot CUE button, and `CUE Int`
  wraps to two lines.
- **(f) The audio send is written "send" in both languages**, and **(g) `SEND PAN` is correct
  English** (an attributive singular). The wording decision is in
  [localization-and-documents.md](localization-and-documents.md), "The audio send is written send".
- **(h) A send taken down to -∞ keeps its connection.** console-sends.md, "Slots", has the rule.
- **(i) A MIX's master ON is editable from the CONSOLE**, as the power LED. It does not go back to
  being an inspector-only parameter.
- **(j) The control reads BALANCE under Pan Link too**, because that is what the unit's own LCD
  shows. The first specification said PAN there; the unit decided it.
- **(k) The meter's floor (-96 dBFS) and the fader scale's -∞ mark do not line up, on purpose.** A
  meter has no -∞.
- **(l) GRAPH and CONSOLE cannot show different values.** They draw one plan, and every edit goes
  through one funnel. Each place where the two look asymmetric has been listed and confirmed as
  intended.
- **(m) The detail parameters that live only in the inspector stay there.** They do not fit a strip,
  and no candidate for exposure is left open.
- **(n) Faders and sends take no Shift fine adjustment.** The unit has no fine mode for them, which
  was checked on hardware.
- **(n2) The Clip Safe switch is not added to the CONSOLE**, to keep it from being hit by mistake.
  The Clip Safe **state** is shown on the CONSOLE and in the inspector
  ([#659](https://github.com/semnil/urx-router/pull/659)), after its form was compared in rendered
  images.
- **(o) A send popover carries no meter.** The unit offers no meter per send.
- **(p) A repaint is non-destructive by contract**: meter ballistics and focus carry over and the
  rack is redrawn in the same task. The scroll position is deliberately not carried, since saving
  and restoring it forces a layout (architecture.md, "CONSOLE view (mixer-style level overview)").
  A report of flicker during Live sync starts by checking that this contract still holds.
- **(q) A direct follow rebuilds the whole strip.** A table of per-field updates on the CONSOLE side
  would duplicate the read-back and translate tables, and a field missing from it would show a stale
  value without a sound.
- **(r) While a row is held, its repaint waits** (2026-08-14). The value reaches the plan and the
  unit at once, and only the drawing waits for the press to end; the cost — the screen showing an
  older value for that long — was accepted by the operator. "Update in place while held" is not
  proposed again: the hold exists so that a pointer still down is never handed a live control, and
  a value update can replace the row too. The mechanism is in architecture.md, "The inspector
  repaint versus an IME composition", and in channel-tuning.md, "A gesture the window is taken away
  from".

## Meters

**Decision.** A strip's meter tap is chosen in the strip's own popover, and the default is the tap
furthest downstream (POST). There is no bar at the top right that switches every strip at once
(the operator's decision). The choice is kept per model.

**Incident.** A stereo input's meter is addressed by the position of its stereo pair, and the number
of mono channels moves where the pairs start. The first implementation used one table, calibrated
on the URX44V, for every model, and on the URX22 every stereo meter was one pair off. The cause
that hid it: `getTapsMap(undefined)` falls back to the URX44 table, and every meter case in the E2E
suite ran as a URX44V, so the suite passed with the model id not wired through at all. The wiring is
pinned by the unit test [src/ui/console.test.ts](../../../src/ui/console.test.ts), and the collision
audit of the tables runs per model with a guard against an empty table.

## Render cost during Live sync

**Decision (2026-08-31, and 2026-10-10 for the frame gate).** The cost of the meters is set by the
number of frames painted, not by the number of elements or by whether they are on screen. So:

- **No partial stop and no culling of off-screen meters.** Painting one strip instead of the whole
  rack, or having no meter on screen at all, changes the cost little or not at all; stopping the
  paint is what changes it.
- **No gate of the app's own for an occluded or minimised window.** The operating system and the
  engine already drop the load there. A guard that reads the app's own state (a modal is open, the
  view is hidden) also holds while the window is occluded, so it covers that case.
- **`will-change` on `.live` stays.** Taking it off raises the cost.
- **The 30 fps gate stays as it is**, although it paints at fewer than 30 frames a second on a 60 Hz
  display. Loosening it buys smoothness for CPU, and the operator kept the CPU. architecture.md,
  "CONSOLE view (mixer-style level overview)", describes the gate.

**Turned down.**

- Culling by reading `offsetLeft` inside the frame: the read forces a layout and costs more than it
  saves.
- `contain: layout paint`: no change overall.
- `content-visibility: auto`: it does lower the cost at narrow widths, but it applies paint
  containment at all times, and the overflow that `.con-strip`'s `min-height: min-content` produces
  then no longer reaches the rack's scroll area. In the engine the app ships with, the bottom of a
  strip could not be scrolled to at the app's own minimum window size. Not proposed again.

Following from that last one, the layout invariants run in the shipping engine too
([#442](https://github.com/semnil/urx-router/pull/442)); `AGENTS.md` has the command.

## Following the unit

**Decision (2026-10-10).** A rebuild on device follow is not a steady cost: every call that asks for
one starts from a notify or from a write settling. `isEcho` drops an incoming value only when it
equals what was sent, so an echo of the app's own write that the unit rounded, and a value the unit
recomputed after a converge or a re-read, both count as a device-side change and rebuild. That is
accepted and closed: the hardware runs behind the decision returned every written value unrounded,
and a rebuild caused by a recomputed value is follow doing what it is for.

## Level grid

**Decision.** A value that is off the level grid is accepted when it comes from a read-back or from
a loaded file, and it is snapped the next time the control is moved. Routing every entry point
through one place that snaps was considered and skipped: how the unit's finer step list relates to
the grid the UI offers is a correctness question of its own, not a tidying.

## Fixed sends

**Decision.** The CONSOLE adjusts levels and does not route. `setSend` updates the level of a wire
that already exists. A send taken down to -∞ keeps its wire.

**Turned down.** Hiding a send at -∞: the strip's control would vanish the moment its fader reached
the bottom.

## Linked pairs

**Decision.** What gates the mirroring between the two channels of a pair is the Signal Type link,
not the PAN / BAL mode. The mode decides only what happens to a send's pan: under BAL the pair
shares one balance value, so it is written to both channels (leaving it out makes them disagree);
under PAN each channel has its own, so it is left out of the copy.

**Why the mirror is applied at each edit funnel.** There is no single layer under the funnels that
every plan mutation passes through, so the funnel is the right height for it in this architecture.
The partner is redrawn as finely as the edit: at once for a chip, on commit for a knob, in place
for a fader.

## Fader travel

**Decision.** The groove of the MAIN fader keeps its 6 px inset. The mini fader's groove was changed
to run the full height; on the main one the cap covers the ends, so there is nothing to gain. The
other two parts of this question are settled elsewhere: pressing the main fader's cap grabs without
writing (architecture.md, "Pressing the main fader",
[#340](https://github.com/semnil/urx-router/pull/340)), and the column fader's relative drag uses
the same travel as the main one ([#571](https://github.com/semnil/urx-router/pull/571), decided
2026-10-10 after first being left as it was).

## A view lower than the window's minimum

**What happened.** With the devtools docked to the bottom of the window, the view went down to 268 px
high, the fixed-height head took the strips, and the meters and faders were squeezed to a height of
0. That collapse no longer happens: the fader zone has a 140 px floor and the strip a `min-content`
height, so the overflow goes to the strip grid's vertical scroll (2026-07-18). It left the zone below
the fold instead: at 268 px and at 400 px high the visible part of the grid was all head, and no
fader or meter showed until the grid was scrolled.

**Decision (2026-11-12).** Below the window's minimum height (640 px, `minHeight` in
`src-tauri/tauri.conf.json`), the fader zone pins to the bottom of the grid's visible area and the
head and the SENDS rack scroll beneath it. Every part of the strip is still reached by scrolling,
and a control in the head that takes focus is scrolled clear of the zone. The SEND PAN button is
then in view only with the zone's height free below it, so its popover no longer has to open above
it; the E2E case on the popover flip anchors on the meter-point badge instead. From 640 px up nothing
changes: the shots at 640 and 800 px are identical before and after, in both themes. The space the
head shows through is the view's height less the toolbar, the status bar and the zone: at 1280 px
wide, 42 px at 268 px high, 174 px at 400 px, and none at 226 px.

**Turned down.** Leaving it as it was, on the ground that only docked devtools take the view under
640 px: the operator chose to handle it. Pinning the zone from 640 px up as well: at 640 px the
lower part of the zone and the readout are below the fold too, but the change was to leave every
height from the window's minimum up as it was.

**What would reopen it.** A change to the window's minimum height, which moves the boundary, or to
the fixed heights of the head, the SENDS rack or the zone's floor, which changes what fits at 640 px.

## Power LED and focus ring

**Decision.** The power LED sits in a dark recessed washer. On the unit's CH SETTING colours the bare
LED colour reaches a contrast of only 1.0 to 1.6, so the pair that is held to a contrast target is
"lit against the washer" (11.7 in the dark theme, 7.7 in the light one). The focus ring is double,
white with a dark halo, because an amber ring disappears on an amber strip. Which strips carry a
MUTE chip, a power LED or both is in console-sends.md, "Background".

## Contrast

The values below came from reading the effective colours off the rendered DOM and computing the
contrast ratio.

- **MUTE lit: 3.27 → 4.98.** `--mute-on` was split off from `--tally`.
- **An empty meter against its surround: 1.63 → 2.82**, with a new `--meter-frame`. Brighter than
  that is noisy with twenty meters side by side, so this is where it stops.
- **`inkOn` picks black or white by contrast ratio.** The earlier rule, a luminance threshold of
  0.6, picked the wrong one (the red STEREO strip went from 3.96 to 4.93).
- **The factory CH colour `#4a78c0` tops out at 4.43 against either ink.** The colour itself is the
  limit. It is the unit's own data, so it is not altered; a halo carries the legibility instead.
  This is a deliberate trade.
- **`--groove` is fixed dark in the light theme**, so that a meter slot reads as an LED on black.
- **`inkOn` is not moved to a shared module.** It has one consumer.

## SENDS rack

The rejected designs are in console-sends.md, "Rejected alternatives (do not re-litigate without new
evidence)". Two notes belong with that table:

- The dotted-frame design was first judged on a rendering that a CSS specificity bug had made
  unfair to it. The bug was fixed and the design judged again, and the rejection is the result of
  that second look.
- A mock-up shows only values that are on the level grid (`LEVEL_STEPS_DB`).

## Incidents

**The ducker's reflect went nowhere.** A ducker has no strip of its own on the CONSOLE, so
`refreshStrip(duckerId)` found nothing, and a ducker moved by MIDI or by device follow stayed stale
on screen. The refresh now retargets to the parent strip through `attachTo`, inside the view's own
refresh. It stays there and not in a shared reflect layer, because where a control's node is drawn
differs from view to view.
