# Decisions: matching the unit's own screens

> 日本語版: [../../ja/decisions/unit-parity.md](../../ja/decisions/unit-parity.md)

Closed decisions that came from laying the app beside the unit's LCD, screen by screen, while the
unit's LCD simulator was being built: places where the app showed something the unit does not have,
or showed a state differently from how the unit holds it. What the app does now is in the pull
requests named below and in [architecture.md](../architecture.md) and
[known-issues.md](../known-issues.md). "The operator" below is the person who directs this project's
work and decides for it.

One line decided each of them: **what the unit's screen does not have is not shown, and a state the
unit holds is shown as the unit holds it.** The options that were turned down are not proposed again.

## The FX strip's EFFECT face

**Decision (2026-09-21, [#494](https://github.com/semnil/urx-router/pull/494)).** The FX channel's
EFFECT ON was taken out of the app. The EFFECT face keeps its lit look, cannot be operated, and
carries a tooltip that says why.

**Turned down.**

- (a) A read-only face drawn dim.
- (b) A face that opens a popover. It was implemented once on a branch.
- (c) No face.

**What was put before the operator first.** The lit look becomes a constant that corresponds to no
value. On the CONSOLE a chip that cannot be operated is otherwise drawn dimmed. And a face that is
lit without being "on" departs from what amber means in the design. The operator chose the lit face
knowing these. For a screen reader the face has the same form as the existing read-only chips.

## A USB output's MONO IN pair is two wires

**Decision (2026-09-21, [#495](https://github.com/semnil/urx-router/pull/495)).** A mono pair on a
USB output (CH 1/2, CH 3/4) is shown as two ordinary wires. Drawn from a linked pair, both wires
appear at once; drawn from one mono channel, the one wire that was drawn; either side can be removed
or added by itself.

- **The two are always written as primary then partner** (`CH n/n+1`). There is no exception.
- **A third wire is refused** with a message worded for a USB output.
- **A combination that is not in the unit's list**, such as the reversed order, stays unread when it
  is read from the unit.

**Turned down.** A flag on the connection with a button that switches the source.

## The input stage sits on the jack and the source

**Decision (2026-09-21, [#590](https://github.com/semnil/urx-router/pull/590)).** D.Gain is a value
of the input source. +48V, A.Gain, Clip Safe and HI-Z are values of the jack. The channel shows the
values of its source and its jack, with one line naming what else shares them.

**Turned down.** Showing only a button that leads to the input node. The CONSOLE and MIDI would have
stayed inconsistent.

**The details, settled the same day.**

- A channel whose source is None drops its gain controls and closes the gap.
- A stereo channel shows one side at a time, chosen in the name field as on the unit's HOME screen.
  There is one polarity control, the power state is an LED on every strip, and the LED's hit area
  takes in its surroundings.
- The side shown is kept in step with the unit in both directions. The URX22 and the URX44 follow the
  same rule and are registered as unverified.
- On the CONSOLE, sharing is said in a tooltip only.
- MIDI keeps addressing the channel by its id and acts on the side that is showing.
- **Editing is on the mixer channel only.** The input node gets no INPUT controls.
- A jack or a source that has not been read is not written. Reading covers them all.
- D.Gain on the URX22 and the URX44 is registered as unverified, with the URX44V's table.
- **HI-Z is never described by channel name.** It is a value of the jack, and which jacks have it
  depends on the model (`HI_Z_JACKS`). Comments and documents that still named channels were
  corrected in [#629](https://github.com/semnil/urx-router/pull/629).

**Reversed later.** "No chip for the Clip Safe state" was one of the details. On 2026-10-17 the
operator decided that the state is shown on the CONSOLE and in the inspector as well
([#659](https://github.com/semnil/urx-router/pull/659), after the forms were compared on real
screens; the SIM view's LCD shows it since
[#651](https://github.com/semnil/urx-router/pull/651)).

## Pull requests that carried the rest

The same comparison produced four more changes, each in a pull request of its own, and one addition
to another.

- [#501](https://github.com/semnil/urx-router/pull/501): Fetch and Live sync stop on a device read
  that fails, and the model is switched only on a complete read.
- [#502](https://github.com/semnil/urx-router/pull/502): STREAMING always has exactly one source, as
  on the unit.
- [#503](https://github.com/semnil/urx-router/pull/503): +48V and HI-Z are never on together, and
  A.Gain is capped under HI-Z.
- [#578](https://github.com/semnil/urx-router/pull/578): hidden nodes are kept when Fetch or Live
  sync switches to the device's model.
- [#579](https://github.com/semnil/urx-router/pull/579): drawing a source onto an input that already
  has one replaces it. Added there: undo refuses an entry that would leave an input that takes one
  source with two wires, or STREAMING with none.

How a failed read is marked on the CONSOLE's gain knob, and how the MIDI window says that a control
is inactive for now, were left to be drawn once the input stage existed; both are in #590.
