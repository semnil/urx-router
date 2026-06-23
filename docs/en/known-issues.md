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
