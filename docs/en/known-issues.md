# Known issues

A list of current limitations. See [device-model.md](device-model.md) for the
routing rules in detail.

## CH → FX send Pre/Post cannot be pushed to the device

The Pre/Post of a channel's send to **FX 1 / FX 2** can be set freely in the
planner — the plan records the intended value — but it cannot be written to the
URX from software: the device only accepts this setting from its own front panel
(LCD). While live sync is connected the control is therefore read-only and shows
the device's own value.

A Pre/Post changed **on the unit while live sync is connected** does reach the
app: the unit announces the change, and the app subscribes to these addresses
even though it never writes them. The control follows within about a second.

This was not always true, and the reason it was not is worth stating, because
the same shape can recur: the notify registration used to be exactly the set of
addresses the app emits, so an address the app only ever reads was in no
registration and the unit's announcement reached nobody. The value then caught up
only at the next full read. Nothing was wrong with the device or the protocol —
the registration was the only thing missing.

The Pre/Post of **CH → MIX** and **FX-channel → MIX** sends can be written to the
device as usual.

> Background: only the device's front panel can set the CH → FX send Pre/Post — the
> broker rejects a software write.

## The CH SETTING Icon is not modeled

The device's CH SETTING offers an **Icon** alongside its name and color, but the
planner intentionally does not model it. Every node kind — mono channels included
— exposes the icon over the broker, and the value is a bare glyph id that carries
no hint of which picture it selects, so supporting it means calibrating the whole
glyph set against the unit's screen first. The name and the color are supported because their values are
self-describing.

## While the Multi-Band Compressor's 1-Knob is on, only Out Gain stays yours

The unit's multi-band compressor has a **1-Knob** — an On switch and a Level — that sets
the whole effect from one number. Both are offered and both are written, like the 1-knobs
on the COMP and EQ screens.

Switching it on is not an edit but a preset: the unit refills every other value of the
effect with the type's own — the three bands' Bypasses among them, which it clears — and
switching it off leaves them there rather than putting back what was set. Measured on a
URX44V with every other value armed away from where it had been
and away from its neighbours, the ON transition moved all of them — the three bands'
Threshold, Ratio, Gain, Attack and Bypass, the shared Release, both crossovers and the
output gain.

Every Level change afterwards reasserts all but one of them: nine are recomputed from the
Level (**Threshold, Ratio and Gain in each band**) and nine are pinned straight back to fixed
values whatever was written over them (**the three Attacks, the three Bypasses, the shared
Release and both crossovers**). The planner stops writing those eighteen while the knob is
on, and the tuning screen locks the same rows.

**The output gain is the exception** — the knob never touches it, so the planner keeps
writing it and its row stays live. Measured on a URX44V by writing all seven of the
non-recomputed values away from the preset AFTER switching the knob on: every one took the
value and held it through 3.2 s of polling, and then a Level change put six of them back
while the output gain kept what was written.

## While Pitch Fix's MIDI Control is on, the Scale and the notes are the unit's

Pitch Fix's **MIDI Control** picks where the correction takes its target notes from. From
**Setting** on they arrive on a USB-MIDI port of the unit's own, and switching the mode on
clears the twelve-note mask and takes the Scale enum to Custom (measured on a URX44V).

The selector itself is offered and written. The Scale and the twelve notes are not, while
the mode is anything but Off: writing them would put the operator's pre-change mask straight
back over the erase the unit had just performed. The tuning screen locks the same two rows,
and both are released as soon as the mode goes back to Off.

## CUE (solo/monitor interrupt) assignment cannot be controlled

Each device channel has a **CUE** button that interrupts the monitor with that
channel's signal over the CUE bus. The planner does **not model the CUE bus
assignment (which channels are cued) and does not push it to the device**: CUE
routing is a temporary bus that the device clears at power-off, so it cannot hold
a persistent assignment that a saved plan would represent (see
[device-model.md](device-model.md)).

The MONITOR bus **CUE Int** toggle (enable/disable the cue interrupt) is a
confirmed parameter and is supported. What cannot be controlled is the
per-channel CUE on/off (the assignment).

## Live control is hardware-verified on the URX44V only

Live device control was developed and verified against a real **URX44V**. The
**URX44** reuses the URX44V control map verbatim (the only hardware difference
is the HDMI input, which is not routed by default), so it is expected to match
but has not been verified on hardware. On the **URX22**, the CONSOLE live-meter
routing has now been confirmed against real hardware by a URX22 owner (the stereo
channels' meters are indexed by stereo-pair position, which shifts on the URX22
because it has only two mono channels, so its first stereo channel is CH3/4). Its
control (write) map and factory-initial plan, however, remain a conjectured mirror
of the URX44V and are unverified, so those values may not match the device exactly.
Offline planning, the plan JSON and image export are unaffected; this concerns
only live sync on those two models.

**Verified environment.** Live control was confirmed against the following
combination. Future firmware or Device Center updates may change the control
protocol, so newer versions are not guaranteed to behave identically.

| Component | Verified version |
| --- | --- |
| Device | URX44V |
| Firmware | V1.3.1.0 |
| Device Center | 2.2.1 (2.2.1.1) |

## The AUTO (auto gain) trigger is not modeled

The device's input screens offer an **AUTO** button that runs a one-shot
automatic input-gain measurement. The planner does not model it: it is a live
action, not a stored setting, so there is nothing for a saved plan or a
snapshot diff to represent. Input gain itself is planned and synced as usual;
only the auto-measure trigger is out of scope.

## SD Rec Track Count cannot be set from software

The microSD recorder's per-track source assignment is a normal, writable setting
(each stereo track pair selects a source — a channel pair, STEREO or a MIX bus —
over param 736; see [device-model.md](device-model.md)).

The recorder's **Track Count** (2 … 16) is not written by the app, and the reason
is narrower than "the device refuses it". The device does accept the write and
act on it — what is missing is the range. Track Count rides param 839 as
*value × 2*, so 2 … 16 tracks is a value of 1 … 8, but the broker publishes a
maximum of **1** and enforces it: 2, 4 and 8 are all rejected. That leaves
software two reachable values, 1 and 0. 1 means two tracks. 0 is outside the
device's own range and leaves the unit's Track Count screen with nothing selected
at all (verified on a real URX44V). A saved plan's Track Count is therefore not
written to the device — the only settings within reach are one that says "two
tracks" and one the device has no meaning for.

A Track Count changed **on the unit while live sync is connected** does reach the
app: the unit announces the change, and the app subscribes to param 839 even
though it never writes it. The plan's value and the record-track slots the graph
gates by it follow. Under Preferences → device scope *Scene only* it does not:
Track Count is one of the device-wide settings that scope leaves alone, in both
directions.

This applies to the URX44 / URX44V only (the URX22 has no microSD recording).

## The unit's operation mode (Standard / Simple) cannot be detected

The URX runs in one of two operation modes, chosen during its initial setup:
**Standard** or **Simple**. Simple Mode visibly reduces what the unit offers — the
channel and bus display is cut down and no longer scrolls.

Software cannot see which one is active. A sweep of every parameter the broker
publishes is identical between a unit in Standard Mode and the same unit in Simple
Mode (verified on a real URX44V by comparing two factory resets that differed only
in the mode and the display language). The app therefore presents the same
controls either way, including for things Simple Mode has taken away on the unit
itself.

The loaded **preset** is readable, so the unit's `P02`-style indicator does have a
software equivalent — the mode does not. What Simple Mode does to a write the app
sends for a control it has removed has not been measured.

## The STREAMING pre-DELAY meter is not readable

The block diagram shows two meters on the STREAMING channel — one before the
DELAY and one after it. Only the **post-DELAY** meter is exposed by the device
broker; the **pre-DELAY** meter has no address at all (verified on a real
URX44V — the address once taken for it turned out to be the CUE bus's meter).
The CONSOLE STREAMING strip therefore shows the post-DELAY (output) meter only,
with no meter-point selector. The pre/post readings do differ in
timing once a delay is set, but the device offers no pre-DELAY reading to show —
the source bus's own meter (STEREO / MIX, whichever feeds STREAMING) is the
closest equivalent for the pre-DELAY level.

## The sample rate only sticks when the device's Follow USB is off

The planner's **Rate** setting is written to the device (param 766) and re-clocks
it. That write only sticks while the device's own **Follow USB** setting is
**off**. Follow USB decides which side is the clock master, and both directions
are confirmed on a URX44V:

| Follow USB | Clock master | What a rate write does |
| --- | --- | --- |
| **off** | the device | the rate sticks, and the computer follows the device onto it |
| **on** | the computer | the device accepts the rate, re-clocks, and is pulled back |

With Follow USB on, the device's front panel locks its rate buttons but the broker
does **not** reject the write: it accepts the new rate, re-clocks (the LCD shows
its switching dialog), and roughly 0.4 s later the host's rate is reasserted and
the device returns to it — measured twice, at +53 ms accept / +374 ms revert and
+38 ms / +398 ms. The audible result is a brief interruption for a change that
does not last.

The LCD's switching dialog belongs to that pulled-back re-clock specifically. A
rate write with Follow USB **off** re-clocks the device without any dialog (three
transitions observed), though it does interrupt audio just the same — the dialog
and the interruption are separate things.

Follow USB is exposed as a broker parameter (848) and can be both read and
written; its factory default is on. The device ignores a write of the rate it is
already running.

## The HDMI sample-rate ceiling depends on the audio mode

The HDMI input's sample-rate ceiling depends on the mode set on the device's
**HDMI menu** (SETUP > Peripheral > HDMI): **2ch mode** is capped at 48 kHz,
while **Multi Channels mode** goes up to 192 kHz with the multichannel audio
down-mixed 8→2 into the stereo pair.

This mode does not follow the incoming signal; it is a device setting configured
and held on the unit. It is deliberately **not** part of the routing plan, so the
plan models neither the mode nor the mode-dependent rate ceiling, and neither is
reflected in the sample-rate warnings. The 8→2 down-mix, and whether a high-rate signal actually
arrives in Multi Channels mode, still follow the incoming HDMI signal and are not
determined by a saved plan either. The HDMI input stays a selectable channel source and the
8→2 down-mix appears in the routing (see [device-model.md](device-model.md)).


## The unit's clock cannot be set from a computer

The URX has a real-time clock, and it is what date-stamps microSD recordings. It
can only be set on the unit itself (SETUP > Date/Time > the Date/Time popup).

The unit does **not** take the time from a computer connected over USB, and there
is no way to write it from the desktop app either — the clock is not exposed as a
settable value, and writing to the fields that report it changes nothing. So a URX
whose clock has drifted has to be corrected on its own screen, and a unit whose
internal battery has run down (the display warns "Low Battery" or "No Battery")
keeps stamping recordings incorrectly until the battery is replaced.

The date and time *formats* and the time zone are ordinary settings; the clock
itself is not one of them.

## The Time Zone list may name a city wrongly

The unit's Time Zone setting is an index into a fixed list of city names held in the
unit. URX Router reproduces that list so the setting can be shown by name, but the
reproduction was checked against hardware only at a few points, and an entry
elsewhere in the list may name the wrong city.

The consequence is visible and recoverable: after applying, the unit's own
Date/Time screen shows the city it actually selected. If it differs from what was
picked, pick again — nothing else depends on the value.

## The URX22 has no Date/Time menu

The URX22 has no microSD recorder, and the clock exists to date-stamp those
recordings, so the unit has no Date/Time menu at all. The HDMI page is fitted to the
URX44V only.

## The URX does not save device-wide settings in a scene

This is a behavior of the URX itself, not of URX Router — noted here because it
shapes what a URX Router plan can carry that a device scene cannot.

A **scene** on the unit stores the **mixing** setup — input channel processing
(HA, HPF, EQ, gate, comp), sends, fader levels and pan, MIX / FX bus settings,
insert FX, mute / on and channel names — and a recall restores it exactly.

The URX keeps the following as **device-wide settings, outside any scene**, so
saving and recalling a scene on the unit leaves them as they are:

- **MONITOR 1 / 2** source, level and mono
- **PHONES** level
- **Output** patch, **USB output** source and **microSD recording** source
- **Streaming** output and the **oscillator**
- **Sample rate**, and system settings (brightness, USER DEFINED KNOBS, date / time)

The **Monitor source** staying put after a recall is the most visible example.
Yamaha's user guide states the same exclusions at a screen-category level: the
SETUP, MONITOR, microSD and STREAMING settings are "not saved" to a scene.

> Confirmed by comparing the unit's scene and live state.

## Device Center sometimes needs a force quit after a long session

On macOS, after a long Live sync session, Device Center can stop closing through its normal
quit and has to be force quit. The cause is **not established**.

Short sessions do not reproduce it. Quitting URX Router with Live sync explicitly turned off,
and quitting it with Live sync still running, were each tried, and neither was followed by a
hang.

> Not reproduced on demand.
