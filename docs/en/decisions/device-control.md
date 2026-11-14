# Decisions: device control

> 日本語版: [../../ja/decisions/device-control.md](../../ja/decisions/device-control.md)

Closed decisions about the layer that talks to the unit (`src/core/control/` and
`src-tauri/src/vd.rs`): the route it uses, what it does not write, and what it does not implement.
How the layer works is in [architecture.md](../architecture.md), "Live control connection"; what
it cannot do today is in [known-issues.md](../known-issues.md); the decisions about Live sync and
device follow, which run on top of it, are in [live-sync.md](live-sync.md). "The operator" below is
the person who directs this project's work and decides for it. Read this before adding a route to
the unit, before writing a setting this layer leaves alone, and before implementing something the
sections below list as left out.

## The app reaches the unit through Device Center's official route

**Decision (the operator).** Integration first. The app does not drive the unit over MIDI and does
not open the unit itself: it connects to the local broker that Yamaha's Device Center runs and
speaks that broker's own protocol, which the code calls the vd protocol.

**What follows.** Device Center running, with the unit attached, is the precondition of every
control feature (architecture.md, "Live control connection").

## The unit's USB MIDI port is not a control route

**Decision.** The control layer does not use the USB MIDI port the unit presents to the computer.
The user guide gives that port to the unit's DAW Integration ("Using the Software Integration
functions"), which is a separate system from the protocol above and outside `src/core/control/`.

External MIDI control (architecture.md, "External MIDI control") is a different thing: a
controller's messages coming in to the app, to move the app's own controls.

## One route only: the port Device Center advertises for the session

**Decision (2026-10-14, the operator).** The app connects over the port Device Center advertises
for the session, and over nothing else. The older WebSocket route (`casket`) was the default until
[#300](https://github.com/semnil/urx-router/pull/300) and was removed from the app in
[#631](https://github.com/semnil/urx-router/pull/631), together with its dependency and the
`--experimental --casket` launch flag. Bringing it back, or keeping it as a fallback, is not
proposed again.

**Why.** The app is meant to run beside Device Center's own window and beside any other client of
the broker, and it assumes that the per-session port serves several clients at once. What each
change did is in the two pull requests.

## Follow is classified per address, not per feature

**Decision.** Whether the app pushes the plan's value back or leaves a change to the unit is
decided one address at a time, from what the unit is seen to do with that address. The two cases
and how to tell them apart are in architecture.md, "What the app models, and what it leaves to the
unit".

**What happened.** Insert FX's automatic ON was once classified, as one feature, on the "leave it
to the unit" side. The feature lies across both cases: the pointers that say which engine a slot
refers to are left to the unit, and the ON switches are the plan's, pushed back when the unit moves
them. A classification made per feature goes wrong at exactly this kind of place.

## The rounding stays in the decoders

**Decision.** `vdToGain` and `vdToEqFreq` in `src/core/control/vd.ts` keep their `Math.round`.
Removing it was proposed and turned down; the comment above each function states the invariant
instead.

**Why.** The code assumes the unit holds a head-amp gain at whole decibels and an EQ band frequency
at whole hertz. Under that assumption the rounding changes no value the unit can return, so a value
going back and forth between the plan and the unit is already at a fixed point, and the "rounding
ping-pong" the removal was meant to cure is not a defect.

## Track Count is not written

**Decision (2026-08-10, the operator; not raised again).** The microSD Rec Track Count is read from
the unit and never written, and its entry in known-issues.md stays. Three options were put:

1. write the one value software can reach;
2. take Track Count out of the plan and make it a read-only value the unit owns;
3. leave the implementation as it is and correct the wording to what the unit does.

The third was taken.

**Turned down.** The first, and its reason is the heart of the decision: the only count software
can reach is two tracks, so the write would be one-way. The app could lower the count and could not
raise it again; that would take the unit's own panel.

**Reopen when.** A firmware update lets software set the higher counts. The first option then holds
as it stands, and the limit is checked again whenever the firmware is updated.

## What is left unimplemented

**Decision.** These are not implemented, and each for the reason beside it.

- **Settings the unit's own screens do not have**: a compressor on the outputs, Sound Pad,
  Monitor 3–4, MIX 3–8, a second PEQ block, and the on/off parameters that remain apart from the
  oscillator's Burst.
- **The band values of an EQ whose 1-knob is on.** The unit recomputes them from the knob, so the
  app does not write them (device-model.md, "Fixed (non-wireable) elements").
- **A warning about EQ on the HDMI input.** It was removed and is not brought back: neither the
  block diagram nor the user guide supports it, and it had been carried over, unverified, from the
  first release.
- **The area where the unit keeps the user's PEQ while 1-knob is on** (2026-08-10). It is not in
  `params.ts` and is neither read nor written. A sweep of the whole unit taken around a self-test
  reports those addresses as not restored; they are this area and not a defect of the app, and no
  address is added to the catalogue on a guess to cover them.

## An item without enough to go on is skipped

**Decision (the operator).** A setting on the unit's screens for which there is not enough to go
on — it is absent from the control parameter map, and nothing gives its range or its list of
values — may be skipped. It is not implemented on a guess.

## The Ducker-bypass warning names the USB direct out only

**Decision.** A channel whose Ducker is on and which is wired to a USB direct out raises the
warning; the same channel wired to microSD Rec does not, because recording the dry signal is a
valid way to work. The operator asked again on 2026-10-12 whether microSD Rec should warn too,
recalled this reason, and kept the exclusion. It is not raised again. What the warning says, the
two other reasons that had been written beside this one and did not hold, and the tests that pin
the behavior are in [#602](https://github.com/semnil/urx-router/pull/602).

**Turned down.** A badge on the wire or on the node, and an addition to the Rec Point helper text,
for the same bypass. The existing warning and hint styles carry it.

## A stereo output's source is written on both sides

**Decision.** A source selection that has a left slot and a right slot is written to both.

**What happened.** The USB outputs' source was written to the left slot alone, and the right slot
kept the value it had held before. The other left/right selections were then audited and found
correct: the linked kind writes the same value to both sides and reads back the first, which is
sound by construction.

## The effect array slot the unit does not show is neither read nor written

**Decision (2026-09-10, the operator; not raised again).** One slot of the FX channel's effect
array is reached by no control of the unit's own: its effect screen does not show it. That slot is
out of the app, for reading and for writing alike. The row, the readout, the MIDI id, the plan
field, the factory values, the emit and the readback were removed in
[#481](https://github.com/semnil/urx-router/pull/481), which also says why the save format's
version went up with the removal. The unit keeps whatever it holds there.

**Reopen when.** A firmware update. Nothing else brings the slot back.

## The six unverified mappings left on the URX44 stay until a URX44 is at hand

**Decision (2026-10-17, the operator; not raised again).** Six entries of `UNVERIFIED_MAPPINGS` in
`src/core/control/translate.ts` remain, and each of them is a guess about the URX44 alone:
`dgain-source`, `jack-axis`, `stereo-block`, `input-ports`, `lcd-side` and `cue-flags`. They stay
as they are. Each entry's `howToSettle` is the procedure that settles it, used as written.

**Reopen when.** A URX44 unit is at hand.

## The URX44 is assumed to behave as the URX44V

**Decision (2026-11-14, the operator).** No URX44 is available for measurement. A device fact
confirmed on the URX44V is assumed to hold on the URX44 too, and is marked unconfirmed for the URX44
until a URX44 can be measured. This is the standing rule for every model-dependent fact, and the
six entries above are it applied to addresses the app writes. How a fact is marked:

- **An address the app writes** on that footing is an entry of `UNVERIFIED_MAPPINGS` in
  `src/core/control/translate.ts`, so the self-test names it and says how it would be settled.
- **A fact the app only reads or shows**, such as a meter, is said to be unconfirmed on the URX44
  where the documents state it, beside the models it was confirmed on. known-issues.md is where a
  user meets it.

**Reopen when.** A URX44 can be measured: each fact taken on this footing is measured then, and the
mark comes off the ones that hold.

## Console Lock: the app holds its own writes back, and never writes the lock

**Decision (2026-11-12, the operator).** The unit takes writes over the link while it is under
[Console Lock] (System firmware V1.5) — a self-test against a locked unit passes — so the app holds
its own back. It reads the lock and never writes it: no unlock from the app, and no lock from it
either, since a lock written over the link takes effect only while the unit shows its Console Lock
menu and no write that moves the unit there has been found, while an unlock written over the link
unlocks the unit whatever password is set. Which writes stop, and what happens to the rest, was
decided once every path the app writes through was listed (`vdSet` and `vdSetStr`, fifteen call
sites):

- **Edits to the plan during Live sync** — the board, the CONSOLE, the Inspector, MIDI, the SIM view,
  undo, a `.urxf` import, the rate — are refused while the lock stands, put back, and said on the
  status line, so the app's screen and the unit do not disagree.
- **Operations outside the plan during Live sync** — a cue, Clear CUE, CUE Mode, a stereo channel's
  displayed side, Device setup, Follow USB, the [Sends] destination — are refused and said.
- **Writes outside Live sync** — Write to device, Device setup's Apply, Follow USB, the self-test —
  read the lock right after connecting, and refuse a locked unit.
- **Reading never stops**: a fetch, a compare, Live sync's start and follow, and the meters.
- **A lock announced in the middle of a write stops it at the next command.** A Live sync flush puts
  what it had not sent back to the unit's values at once; Write to device says how many of how many
  went out, and pressing it again once the unit is unlocked sends the rest; a self-test keeps what
  it read before the run, says the unit is not restored, and the operator runs the restore alone from
  the Device menu once the unit is unlocked. The rest of the self-test is not resumed, and quitting
  the app drops what it kept.

How it is built is in [architecture.md](../architecture.md), "Console Lock".

**Turned down.** Unlocking from the app; holding edits made under the lock and sending them once it
is taken off; ending the Live sync session when the lock arrives; for Write to device, sending the
rest by itself once the unit is unlocked; for the self-test, writing it back by itself once the unit
is unlocked.

**Reopen when.** A write over the link that moves the unit to its Console Lock menu turns up (it
would make a lock from the app possible), or the unit starts refusing writes while it is locked.
