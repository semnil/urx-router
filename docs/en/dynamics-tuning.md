# Dynamics tuning screens (design specification)

> 日本語版: [../ja/dynamics-tuning.md](../ja/dynamics-tuning.md)

**Status: GATE and COMP implemented (2026-07-29).** This document specifies the per-channel screens
that put a dynamics processor's parameters beside the meters showing what they are doing. DUCKER and
the insert-FX dynamics have gain-reduction meters of their own (see [Scope](#scope)) and belong here
when they follow. Implemented in `src/ui/dyn-screen.ts` (the shared screen), `src/ui/dyn-gate.ts` /
`src/ui/dyn-comp.ts` (what differs per processor), `src/core/meters.ts` (the GR table and decode),
`src/style.css` (`.gt-*`), with coverage in `e2e/dyntuning.spec.ts`.

One host serves both screens and the processor is chosen per open, so opening either replaces
whatever was on it. Two instances would fight over the same DOM, and the broker's single meter slot
means two open at once could not both stream anyway.

## Background

Until now the five GATE parameters were sliders in the inspector, with no way to see their effect.
The gain-reduction meters were identified on a URX44V but deliberately left out of the meter model:
`tapsFor` is also the CONSOLE meter-point selector's contract, and a reduction listed there would be
selectable as a strip meter and drawn on the dBFS ladder with its signal color zones.

Two device facts make a dedicated screen worth building (stated for GATE; the COMP section below
gives the same two for the compressor):

1. A GATE threshold in dB is directly comparable with the PRE GATE meter's dBFS. Measured: CH1's
   -54 dBFS noise floor sat below a -52 dB threshold and the gate stayed shut, so nothing reached
   COMP. The threshold and the meter share one coordinate.
2. All three points of interest are metered — PRE GATE (106) in, GATE GR (107), PRE COMP (108) out —
   on the same mono-channel axis.

The first is what earns the screen's one gesture: the threshold is a **fader cap dragged on the
input meter itself**.

## What the meters can and cannot show

Measured on a URX44V, System firmware 1.3.1.0, 2026-07-29. The full measurement is in the private
reference notes; the parts that constrain this design:

| Fact | Consequence for the screen |
| --- | --- |
| The notify period is 100.0 ms exactly, and every tick is sent whether or not the value changed | Painting faster than 10 Hz shows nothing new; no interpolation is applied between frames, so most frames carry nothing and write nothing — the lane writes are quantized and skipped when unchanged, and the readout text is throttled to ~6 Hz like the console's |
| Each frame is an **instantaneous sample**, not a window extreme | An event shorter than 100 ms is missed with probability (1 − width / 100 ms) |
| The **level** meters (106 / 108) are peak detectors with a release of about 30 dB/s | They hold transients themselves. An app-side release would double what the device already does, so none is added; the peak hold on those lanes is cosmetic |
| The **GR** meter (107) has no ballistics at all — it carries the applied gain | Its peak hold is the only thing that makes a caught gate action readable, and it cannot recover one that was never sampled |
| GR idles at **two** values, and which one is not arbitrary: `0` means the processor is **not engaged** (gate off, comp off), the OVER sentinel `32767` means it **is** engaged with no reduction to report | Both decode as "no reduction", and neither may raise a clip flag. Measured across all three states on the compressor, which is the only processor whose engagement can be toggled without changing what it would report |
| A GR meter carries the **reduction alone**. Sweeping the COMP makeup gain 0 → +18 → 0 dB moved the downstream level tap by exactly 18 dB and left the GR meter at -3.0 dB throughout, with no OVER frames | The lane is readable at any makeup setting, and needs no caveat about makeup hiding the compressor's work. This was measured because the opposite (a net-gain reading) would have made the lane useless above modest makeup values |

The asymmetry in the last two rows is visible in use: an input transient can show on the IN and OUT
lanes with no matching GR, because the GR sample missed it. That is the device, not a defect.

## Layout

A modal on the Preferences / Device setup shell (`.consent-box` + `.prefs-box`, 920 px, two
columns). The left column is the display, the right the controls and readouts.

```text
┌ [CH 1] Gate ─────────────────────────────────────────────────┐
│ DISPLAY            [LADDER][CURVE] │ PARAMETERS               │
│ ┌────────────────────────────────┐ │ Threshold  ──●──  -50.0 dB
│ │   0 ─┐  ┌──┐ ┌──┐ ┌──┐         │ │ Range      ─●───  -56.0 dB
│ │ -10 ─┤  │  │ │▨▨│ │  │         │ │ Attack     ──●──   20.2 ms
│ │ -50 ─┤  │▬▬│ │▨▨│ │  │  ← cap  │ │ Hold       ●────   15.3 ms
│ │ -72 ─┘  └──┘ └──┘ └──┘         │ │ Decay      ─●───  150.2 ms
│ │       PRE   GATE  PRE          │ │                          │
│ │       GATE   GR   COMP         │ │ READOUTS                 │
│ │        106   107   108         │ │ [PRE GATE][GATE GR][PRE COMP]
│ └────────────────────────────────┘ │                          │
│                                    │                   [Close]│
└──────────────────────────────────────────────────────────────┘
```

### Display modes

Two modes over one control set, switched from a tab in the section header — directly above the
control it changes. They are **alternatives, not layers**: each owns the column, so neither has to
shrink to make room for the other.

- **LADDER** — the three taps on one tick column, spanning -72..0 dB. Linear in dB, which is the
  threshold's exact domain, so the cap's position and its value stay proportional. This is why it
  does not reuse the CONSOLE's ruler, which is spaced by detent index.
- **CURVE** — the static in/out transfer plot, where the threshold is the knee and the range is the
  drop below it. Its **output axis is not the input axis**: it runs to the GR floor (-128 dB) while
  the input spans -72..0. The closed shelf sits at threshold + range, which for most of the range
  domain falls below -72 dB — at the factory settings -50 + -56 = -106 dB — so a shared floor pinned
  every range past -22 dB to the same line and range was invisible. Only a -∞ range now reaches the
  axis floor, and the drop is labelled with the range it represents.

The explanatory note under the display appears in CURVE only: a fader cap on a meter explains
itself, dragging a curve's knee does not.

### The GR lane

Drawn at the **same dB per pixel as the level lanes**, so the one tick column reads for all three —
a GR bar down to the -56 tick is 56 dB of reduction. Rose with a hatch, never the green/yellow/red
signal zones, because a reduction is not a level. Two rejected alternatives are recorded below.

### Readouts

Three cells printing the live value and the held peak. A tap that has not reported prints `—`,
never a floor value: a GR of `0.0` would claim the processor is passing everything, and a level at
the floor would claim silence that was never measured.

## COMP

The same three-tap shape one stage downstream — PRE COMP (108) in, COMP GR (110), PRE EQ (111) out —
and the same two modes. What the compressor changes:

**The unit itself edits this one on the graph.** Its COMP screen (user guide p.104) puts T
(threshold), R (ratio) and G (gain) on the transfer curve and lets you drag them, with the GR meter
beside it. CURVE is that screen, so it carries the same three grips; the gate's curve has one (its
threshold), which is the same gesture with fewer values to place.

**The reduction gets a scale of its own.** A gate's reduction runs the whole ruler — range reaches
-∞ — so it reads off the shared tick column. A compressor's occupies a few dB of a 54 dB ruler: at
-8 dB it is 15% of the lane, visible but not readable. So the COMP lane is drawn on a 0…-24 dB scale
**printed beside it** and set apart from the level pair. That is not the alternative rejected for
the gate below, which was a second *unlabelled* scale under the *shared* ticks.

**Some values belong to the device while it drives them.** With 1-knob on, the unit computes
threshold / ratio / gain from a single level; with Auto Makeup on, it computes the gain. Each
recomputation is announced per address (measured), so those rows stay on screen and keep updating —
tagged, dimmed and read-only, with their curve grips withdrawn — rather than being hidden or
recomputed here. Auto Makeup cannot be operated while 1-knob is on, so that row goes.

**The knee is drawn, and its width was measured.** Soft / Medium / Hard publish no widths, so the
curve would either invent a curvature or leave the selector changing nothing on screen. Measured by
walking the threshold up until the reduction stopped (the point where the knee's lower edge leaves
the detector behind): Hard ~0 dB, Medium ~8 dB, Soft ~20 dB of reach, i.e. 0 / 16 / 40 dB under the
usual symmetric-knee model. Only the lower edge is measured — this signal source could not push the
detector far enough above the threshold to find where full ratio is reached — so the curvature
between the edges is the standard quadratic and is an assumption, recorded as one.

**The output axis runs above 0 dBFS.** Makeup gain reaches +18 dB, so the curve's axis is -54…+18
while the input spans -54…0. The gate's runs the other way, to the GR floor, for the same reason:
the parameter's effect has to stay on scale.

**No screen in SSMCS.** The morphing strip replaces the compressor, `channelDynamics().comp` is
null, and neither entry point renders.

## Scope

GATE and COMP are MONO IN features, so the screens exist for CH1-4 (CH1-2 on URX22) only. The
channel is fixed by where the screen was opened from — there is no in-screen channel switch, so the
subscribed address set is constant for the whole session.

The remaining confirmed GR meters are DUCKER (119) and the insert FX (132 input / 133 output). Their
axes are **not** the mono channel index the gate's and comp's share — the ducker's is the stereo
pair, the output insert FX's is the effect band — so each one added has to bring its own measured
axis rather than inherit `grAddr`'s.

## Meter subscription ownership

The broker has **one meter subscription slot process-wide**: `vd_meters_subscribe` replaces the
previous registration and `vd_meters_unsubscribe` takes no address. The replacement is silent and
the CONSOLE does not self-heal, so an unannounced takeover would leave its bars frozen on the floor
— indistinguishable from silence.

Two mechanisms keep that from biting:

- **A generation stamp on the subscription itself** (`subscribeMeters`). The unsubscribe handle a
  caller holds looks per-subscription and is not, so a stale one cancels whoever owns the stream
  *now* — reachable when a console registration is still in flight as the screen takes over, or when
  the screen closes faster than its own subscribe round-trip. A release only unsubscribes if its
  generation is still current, and a late frame from a superseded registration is dropped rather
  than written into the new owner's store.
- **An explicit borrow** (`Console.releaseMeters()` / `regainMeters()`, guarded by `metersLent`).
  The screen takes the slot before subscribing and gives it back on close; while it is lent, a
  console `render()` — which happens for reasons unrelated to the console being looked at, such as a
  device-follow reconcile — does not re-subscribe. `regainMeters` is a no-op unless the console is
  live and on screen; opened from the GRAPH inspector the console may be hidden, and its stream is
  then re-established by the `render()` that the next `show()` already runs.

Live state reaches both surfaces from `setLiveUi`, the funnel every way in and out of a session
already passes through. The order is load-bearing — the console subscribes, then the screen takes
the slot back off it — and lives there rather than at each call site.

The GR peak folds in the subscription callback, not from `MeterStore`: the store is last-write-win
per address, so a batch carrying more than one frame for an address keeps only the last.

## Entry points

| Where | Control |
| --- | --- |
| GRAPH inspector, GATE / COMP section | A full-width button below the ON/OFF toggle |
| CONSOLE, mono strip | A narrow chip beside each of the GATE and COMP chips |

Both sections are reduced to their ON toggle plus the launcher. A second copy of the sliders in the
inspector is not just duplication: `dynFieldSlider` reads the params snapshot captured at render
time and never re-renders on a value change, so after the screen moved a value those sliders would
sit at the old position and write it back on the next drag.

The console opener is a separate chip rather than a gesture on the processor chip: `wireActivate`
binds click and Space/Enter with no `detail` guard, so a double-click would toggle the processor
twice and write twice, and double-click is already the factory-value reset for this view's faders
and knobs. Each pair fills one row of the two-per-row chip grid — head height is uniform by design
so the SENDS racks, faders and meters stay aligned.

## Without a device

The screen opens in every build and in every state. The parameters are plan values and fully
editable with no device (the browser build included); the meters sit at the floor with their
readouts printing `—`. Nothing is locked or hidden, because nothing here needs the desktop shell to
be *edited* — only to be *observed*.

## Implementation notes

`DynScreen` owns everything that does not depend on which processor is open — the modal, the ladder,
the meter feed and its peaks, the slot borrow, the curve's frame and grips, the persisted mode. A
`DynProcessor` supplies the rest: its taps, its axes, its fields, its extra rows, its grips and its
transfer curve. Adding DUCKER or an insert-FX dynamics screen means writing one of those, not
another screen.

The screen is built out of the shared recipes rather than its own: `settingsRow` / `settingsSection`
for the rows and headings, `.udk-banks` for the mode tabs, `setLevelText` for the -∞ readout,
`wheelStep` for the sliders, `fineTag` / `optInFine` for the one value with a device fine grid, and
the console's registered `--lvl` / `--pk` rules for the meter shade and peak. The GR lane adds only
its inversion (it hangs from the top and is the bar rather than the cover over one) and its hatch.
`formatDyn`, the range -∞ notch (`dynValueText`) and which field carries a fine grid all live in
`translate.ts` beside the field table that defines them, so a screen and the inspector cannot
disagree about how a value prints or steps.

The display mode is stored per processor (`urx-dyn-display`, a record keyed by processor). A gate and
a compressor are not read the same way, and the pick is a way of reading a processor rather than a
per-device mapping — so unlike the meter point it is not model-scoped.

The curve is drawn as a cached static layer plus a live dot: everything but the dot depends only on
the parameters, size and theme. Canvas size is measured on open and refresh, and the theme tokens
are read on render — both are forced reads that would otherwise land in the frame loop straight
after its own DOM writes. A row that changes which *other* rows exist (1-knob, Auto Makeup) rebuilds
the control column; the sliders deliberately do not, since a rebuild mid-drag would drop the pointer
capture.

## Rejected alternatives (do not re-litigate without new evidence)

| Rejected | Why |
| --- | --- |
| Sharing the input's -72 dB floor for the curve's output axis | At the factory threshold, 70% of the range domain put the shelf off scale: moving range from -30 to -56 dB moved the drawing by 0% of the plot height |
| A log-compressed output axis | dB is already a log unit, and compressing it again squeezes precisely the deep region range occupies. Measured at 8.5% for the same -30 → -56 step, against 20% for simply extending the axis |
| Plotting gain (out − in) instead of output | The most legible of the four measured (35.6%), and its axis is exactly what meter 107 reports — but it is a gain curve, not a transfer curve, so the 1:1 region flattens to a line at 0 dB and the plugin convention is lost |
| Auto-scaling the output axis to fit the shelf | The shelf stays visible, but dragging range then moves the tick labels instead of the line, so nothing reads as changing |
| GR as an eighth entry in `monoTaps` | `tapsFor` is the CONSOLE meter-point selector's contract; GR would become a selectable strip meter drawn on the dBFS ladder with signal color zones. Also breaks two pinning tests |
| GR on a fixed 0..-30 dB full scale | Saturates at the factory range (-56 dB) — it stops carrying information exactly when the gate is working |
| GR on a range-following full scale | Fixes the saturation but puts a second scale under the shared tick column: it looks readable against the neighbouring ticks and is not |
| Reusing `readingTap` / `decodeMeterDb` for GR | `readingTap` raises its `over` flag on the OVER sentinel, which for GR means "on and open" — a clip indicator for a gate passing signal |
| Deriving OUT as IN + GR | The three taps are metered independently. Within one frame the loudest input and the deepest reduction did not occur at the same instant; summing them printed an output tens of dB low |
| Keeping the five sliders in the inspector as well | `dynFieldSlider` reads the params snapshot captured at render time and never re-renders on a value change, so after the screen moved the threshold those sliders would sit at the old position and write it back on the next drag |
| A scrolling history / level-distribution view | Prototyped and dropped: the gate's nature makes both hard to read. Recorded so the ground they covered — whether the gate drops between phrases, how far the noise floor sits from the source — is known to be out of scope |
| An in-screen channel selector | Every switch would re-register the address set, and the screen is opened per channel from a per-channel control anyway |
| A gesture on the CONSOLE GATE chip (double-click / right-click) | Double-click is the factory reset elsewhere in the view and `wireActivate` has no `detail` guard; right-click is unused app-wide but collides with the macOS native menu on Ctrl+click |
| Adding an app-side release to the level lanes | The device's meters already release at ~30 dB/s; a second one would double it |
| Reading COMP GR as the net applied gain (reduction + makeup) | The idle OVER sentinel on a channel with +18 dB of makeup suggested it, and it would have made the lane useless above modest makeup values. Measured and refuted: the makeup moves the downstream tap and not the GR meter |
| Sharing the level lanes' dB per pixel for the COMP GR lane | A gate's reduction runs the whole ruler; a compressor's is a few dB of it, and reads as a lane that never moves |
| Leaving the COMP knee out of the curve | The selector would change nothing on screen — the same failure the gate's output axis already cost us. Measuring the widths was cheaper than shipping a control with no feedback |
| A second instance of the screen for COMP | Both would bind the same modal host and the same single meter slot; the processor is chosen per open instead |

## Accepted trade-offs / watch items

- **The peak hold time (1.2 s) is a pure UI choice.** The device sets no precedent: its level
  meters hold in hardware and GR holds not at all.
- **The peak line means different things on different lanes** — load-bearing on GR, cosmetic on the
  level lanes. Consistency was chosen over marking the difference.
- **Gate actions shorter than 100 ms are invisible on GR** and no UI can recover them. The screen
  does not claim otherwise; it is for reading steady-state level relationships and setting the
  threshold against them, not for tuning attack / hold / decay.
- **No fine-tuning mode.** The device's push-and-turn fine adjustment is confirmed *inactive* for
  every GATE parameter, so no FINE hint is shown.

## Edit → device data path

Identical to the inspector's: `onUpdateNodeParams` merges the patch into `plan.nodeParams[id].gate`
and calls `markChanged()`, which flags the plan dirty, schedules the live mirror and feeds MIDI
feedback. A STEREO-linked pair in BAL mode mirrors the gate group to its partner like any other
node parameter.
