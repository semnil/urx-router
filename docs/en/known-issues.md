# Known issues

A list of current limitations. See [device-model.md](device-model.md) for the
routing rules in detail.

## CH → FX send Pre/Post cannot be pushed to the device

The Pre/Post of a channel's send to **FX 1 / FX 2** can be set freely in the
planner — the plan records the intended value — but it cannot be written to the
URX from software: the device only accepts this setting from its own front panel
(LCD). While live sync is connected the control is therefore shown read-only
(disabled, with an explanatory tooltip) and reflects the device value, which
readback keeps current — this applies to both the inspector's Pre/Post toggle and
the CONSOLE view's PRE button. Offline (the pure planner) it stays editable.

The Pre/Post of **CH → MIX** and **FX-channel → MIX** sends can be written to the
device as usual.

> Background: only the device's front panel can set the CH → FX send Pre/Post (the
> broker rejects a software write). The app reads it back, so while live it always
> shows the true device value.

## The CH SETTING Icon is not modeled

The device's CH SETTING offers an **Icon** alongside its name and color, but the
planner intentionally does not model it. The mono channels (CH1–4) do not expose
the icon over the broker, so it would only work on stereo channels and buses — an
asymmetric feature. The name (`nodeNames`) and color (`nodeColors`) are supported
because they can be read and written for every node.

## CUE (solo/monitor interrupt) assignment cannot be controlled

Each device channel has a **CUE** button that interrupts the monitor with that
channel's signal over the CUE bus. The planner does **not model the CUE bus
assignment (which channels are cued) and does not push it to the device**: CUE
routing is a temporary bus that the device clears at power-off, so it cannot hold
a persistent assignment that a saved plan would represent (see
[device-model.md](device-model.md)).

The MONITOR bus **CUE Int** toggle (enable/disable the cue interrupt,
`MONITOR_CUE_INTERRUPT`) is a confirmed parameter, so it is read, written and
live-synced from the CONSOLE MONITOR strip and the inspector. What cannot be
controlled is the per-channel CUE on/off (the assignment).

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
| Firmware | V1.3.0.1 |
| Device Center | 2.2.0 (2.2.0.2) |

On connect the app reads the unit's System firmware version (`/vd/device`); when
it differs from the verified version above, fetch, write and live sync warn at
the start that the app may not work correctly. The user can continue or stop — it
never forces a halt (and when the firmware cannot be read, it proceeds without a
warning).

## The AUTO (auto gain) trigger is not modeled

The device's input screens offer an **AUTO** button that runs a one-shot
automatic input-gain measurement. The planner does not model it: it is a live
action, not a stored setting, so there is nothing for a saved plan or a
snapshot diff to represent. Input gain itself is planned and synced as usual;
only the auto-measure trigger is out of scope.

## SD Rec Track Count is read-only

The microSD recorder's per-track source assignment is fully editable and
live-synced (each stereo track pair selects a source — a channel pair, STEREO or
a MIX bus — over param 736; see [device-model.md](device-model.md)).

The recorder's **Track Count** (2 … 16), however, is **read-only**: like the
CH → FX send Pre/Post, the device accepts a software write but ignores it and
only its own front panel changes it (param 839). The planner reads it back and
uses it to gate how many track-pair slots are shown, but cannot push it — so a
saved plan's Track Count is not written to the device.

This applies to the URX44 / URX44V only (the URX22 has no microSD recording).

## The STREAMING pre-DELAY meter is not readable

The block diagram shows two meters on the STREAMING channel — one before the
DELAY and one after it. Only the **post-DELAY** meter is exposed by the device
broker; the **pre-DELAY** meter returns no data in any state (verified on a real
URX44V). The CONSOLE STREAMING strip therefore shows the post-DELAY (output)
meter only, with no meter-point selector. The pre/post readings do differ in
timing once a delay is set, but the device offers no pre-DELAY reading to show —
the source bus's own meter (STEREO / MIX, whichever feeds STREAMING) is the
closest equivalent for the pre-DELAY level.

## The HDMI sample-rate ceiling depends on the audio mode

The HDMI input's sample-rate ceiling depends on the mode set on the device's
HDMI menu: **2ch mode** is capped at 48 kHz, while **Multi Channels mode** goes
up to 192 kHz with the multichannel audio down-mixed 8→2 into the stereo pair.
Because the active mode — and therefore both the ceiling and the down-mix —
follows the incoming HDMI signal at run time, not anything a saved plan holds,
the planner does not model this interaction: it is not enforced in the
sample-rate warnings. The HDMI input stays a selectable channel source and the
8→2 down-mix appears in the routing (see [device-model.md](device-model.md));
only the mode-dependent rate ceiling is out of scope.
