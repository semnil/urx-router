# Channel tuning screens (design specification)

> 日本語版: [../ja/channel-tuning.md](../ja/channel-tuning.md)

**Status: GATE, COMP, EQ and DUCKER implemented (DUCKER 2026-08-08).** This document specifies the
per-node screens that put one processor's parameters beside the meters showing what they are doing.
The insert-FX dynamics have gain-reduction meters of their own (see [Scope](#scope)) and belong here
when they follow. Implemented in `src/ui/dyn-screen.ts` (the shared host), `src/ui/dyn-gate.ts` /
`src/ui/dyn-comp.ts` / `src/ui/dyn-eq.ts` / `src/ui/dyn-ducker.ts` (what differs per processor), `src/ui/dyn-chan.ts` (the
binding the two channel-strip processors share), `src/ui/dyn-plot.ts` (the dB×dB transfer plot),
`src/core/eq-response.ts` (the measured filter model), `src/core/meters.ts` (the GR table and
decode), `src/style.css` (`.gt-*`), with coverage in `e2e/dyntuning.spec.ts` and
`e2e/eqoneknob.spec.ts`.

One host serves all three and the processor is chosen per open, so opening any of them replaces
whatever was on it. Two instances would fight over the same DOM, and the broker's single meter slot
means two open at once could not both stream anyway.

**Nothing in the host knows which processor it is showing.** A `DynProcessor` resolves what a node
actually has (its fields and its meter lanes), reads and writes its own corner of the plan, and
arranges its display column out of the parts the host offers. That division is why a processor with
no gain-reduction meter, on nodes whose taps are stereo, whose values live in an array and whose
segmented bar selects a band rather than a display mode, needed no special case in the host.

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
input meter itself**. A press on the cap grabs it where it is; a press on the bare slot jumps the cap
to the pointer and defers to the cap's own listener when the press landed on it (`e.target === cap`).
That is the same press grammar the CONSOLE fader has — see architecture.md "Pressing the main fader",
which carries the reasoning and the measurements for both.

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

A modal on the Preferences / Device setup shell (`.consent-box` + `.prefs-box`, two columns).
The left column is the display, the right the controls and readouts.

**The width is the one part of that shell it does not share.** `#dyn-screen-box` sits in the same
rule as `#console-host` (to share the lane sizing tokens), and the `flex: 1` it picks up there beats
`.prefs-box`'s `width: min(920px, 100%)`. So this screen alone spans the viewport (1452 px in a
1500 px window) and its ground is the board's `--graph-bg` rather than `--panel`. Of the shared
tokens only `--groove` is actually read here; `--strip-w` / `--head-h` are inherited and unused.

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

One cell per lane, printing the live value and the held peak — three for GATE / COMP, four for the
DUCKER. A tap that has not reported prints `—`, never a floor value: a GR of `0.0` would claim the
processor is passing everything, and a level at the floor would claim silence that was never
measured.

Four on a three-column grid wrap to 3 + 1, so the host switches to two columns once a screen has
four lanes (`.gt-readouts.two`). It does not narrow anything — a grid fills its column — it removes
the ragged wrap.

## COMP

The same three-tap shape one stage downstream — PRE COMP (108) in, COMP GR (110), PRE EQ (111) out —
and the same two modes. What the compressor changes:

**The curve is read, not dragged.** The unit's own COMP screen (user guide p.104) puts T
(threshold), R (ratio) and G (gain) on the transfer curve and lets you drag them. That was built and
removed: three grips on one plot means a press has to guess which value was meant, and a press that
missed one fell through to the threshold drag underneath — so pressing the gain grip moved the
threshold. The sliders beside the plot are the editing path; the curve answers what the settings are
doing to the signal. The gate's curve keeps its press-to-set-threshold, because it carries one
editable value and the gesture cannot be misread.

**The reduction gets a scale of its own.** A gate's reduction runs the whole ruler — range reaches
-∞ — so it reads off the shared tick column. A compressor's occupies a few dB of a 54 dB ruler: at
-8 dB it is 15% of the lane, visible but not readable. So the COMP lane is drawn on a 0…-24 dB scale
**printed beside it** and set apart from the level pair. That is not the alternative rejected for
the gate below, which was a second *unlabelled* scale under the *shared* ticks.

**Some values belong to the device while it drives them.** With 1-knob on, the unit computes
threshold / ratio / gain from a single level; with Auto Makeup on, it computes the gain. Each
recomputation is announced per address (measured), so those rows stay on screen and keep updating —
tagged, dimmed and read-only — rather than being hidden or recomputed here.

**1-knob's own two rows are locked, not swapped.** Auto Makeup cannot be operated while 1-knob is
on (user guide), and 1-Knob Level does nothing while it is off — so exactly one of the two applies
at a time. Both stay on screen either way, locked when they do not apply, the way the EQ screen
holds its 1-knob rows; the lock is declared in `rowStates` with every other one, not decided in the
row builder. Swapping them in and out moved the panel — a toggle row and a slider row are not the
same height — and dropping Auto Makeup lifted the 1-knob row itself a full row up, out from under
the pointer that had just clicked it. `e2e/dyntuning.spec.ts` pins both figures.

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

## EQ

The 4-band PEQ, on the same host with three things arranged differently — each for a reason the EQ
has and the two dynamics processors do not.

**There is no display-mode choice.** A gate is read either as a threshold on a meter or as a transfer
curve, and those are alternatives. An EQ's response and its levels are not: the curve says what it is
doing to the spectrum, the meters say whether the stage is clipping, and neither answers the other.
So both are on screen at once — the plot taking the width, the lane rack beside it in its own frame —
and **the segmented bar in the tabs' place selects a band** instead. It resets to LOW on every open,
because it is a cursor into the parameters rather than a way of reading the processor (the display
mode persists per processor; this deliberately does not).

**The plot's axes are frequency against gain**, so it carries no live dot and no press-to-set
gesture. Each band gets a **marker** — a pill with its initials — because the operator needs to see
where it sits; a marker and not a grip, since four grips on one plot cannot tell which value a press
meant (the COMP screen established that with three), so the sliders stay the editing path. Off the
scale is off the frame — see [Off the scale is off the frame](#off-the-scale-is-off-the-frame), which is
the rule for every plot here; a high-pass passes the -18 dB floor within an octave of its corner, and
the markers follow the same rule. Each marker sits at its band's own frequency and at the **composite**
response there, so it is always on the curve: a pass filter has no gain to place it by, and two
overlapping bands would otherwise plant their markers off the line being read.

**It exists on four kinds of node** — mono channel, stereo channel, MIX, STEREO master — which is
where the taps differ, since the EQ sits at a different point in each chain:

| Node | In | Out |
| --- | --- | --- |
| Mono channel | PRE EQ (111) | PRE INS FX (112) |
| Stereo channel | INPUT (101) — its pre-EQ point | PRE FADER (114) |
| MIX / STEREO master | PRE EQ (sum) | PRE FADER (post-EQ) |

A stereo node's taps carry L and R, which the rack draws as **two bars in one lane** under one
caption — the console's own treatment, and for its reason: two half-width bars read as one point
metered in stereo, where two lanes would read as two points in the signal path.

**The mono channel's HPF is deliberately not drawn** on the response. It sits upstream of the
compressor, whose gain varies with frequency content, so it does not add to this stage's curve in any
way the plot could honestly show.

### The response model

Measured on a URX44V by driving the oscillator into MIX 1 and reading the difference between the two
meters bracketing the EQ, then repeated on the STEREO master block and — with the host's USB output
as the source — on a stereo channel. 19 datasets, 108 points, worst case **1.3 dB**, which is the
resolution of a difference between two 1 dB-quantized peak meters. The filters are RBJ cookbook
biquads with three corrections that only came out of measuring, each of which was drawing a visibly
wrong curve before it did:

| Shape | Correction |
| --- | --- |
| Peaking | **The unit's Q is twice the biquad Q.** A "Q 1.00" +12 dB bell measured +12/+10/+7/+3 dB at 1k/700/500/300 Hz — a biquad Q of 0.5. Taking the number at face value drew every bell half as wide as the device's. |
| HPF / LPF | Fixed 2nd-order Butterworth: -3.0 dB exactly at the nominal frequency, 12 dB/octave beyond. **The band's Q slot is ignored** — Q 0.71 and Q 4.00 measured identical, with no corner resonance. Honouring it drew a +12 dB peak that is not there. |
| Shelving | The S = 1 shape, but **the nominal frequency is the point 3 dB below the plateau**, not the midpoint: a +18 dB shelf at 1 kHz measured +15 dB there and reached +18 dB by 4 kHz. So the design frequency is solved for, and the search direction flips with the gain's sign — reusing the boost direction for a cut was 4.2 dB out. |

Two further measurements bound what the model is worth: **bands sum in dB** (a LOW shelf +12 and a
HIGH-MID peaking -9 measured together matched the sum of the two measured separately, within the
meters' own ±2 dB), and **the sample rate moves a high bell by at most 2 dB** across 44.1 … 176.4
kHz — so the drawing is computed at 48 kHz whatever the plan's rate, and says so rather than
pretending otherwise. The model lives in `src/core/eq-response.ts` and every table above is a test
in `src/core/eq-response.test.ts`, with a 2.0 dB tolerance: enough to leave the measurement its
resolution, tight enough that each of the three corrections fails without it.

### The panel keeps its height

The Parameters section is **Band / Type / Q / Freq / Gain whatever is selected** — the same five rows
on all four bands and under every filter type. What varies is which of them the device reads, and
those rows lock and say why rather than disappearing:

| Locked | Tag | Why |
| --- | --- | --- |
| Q, on a shelf or a pass filter | Unused by this type | Only a peaking band reads Q. For a pass filter that is measured — Q 0.71 and Q 4.00 draw an identical high-pass with no corner resonance |
| Gain, on a pass filter | Unused by this type | A pass filter has no gain to apply |
| Type, on LOW MID / HIGH MID | Fixed on this band | The two mid bands are fixed peaking: the device rejects the write (measured, response_code 400), so the row offers that one value |

A row that disappears takes the panel's height with it and moves every row below under the pointer —
including the Close action. Measured across all four bands and all three types, the modal stays at one
height, which `e2e/dyntuning.spec.ts` pins.

**While 1-knob is on the band block goes away entirely**, and still without changing the height. There
is no band being edited then — the device computes all four from one level — so a band selector would
be offering a choice with no effect: the rows are **reserved out of sight** (`visibility: hidden`,
which also takes them out of the tab order, with their controls disabled as well), the band bar goes
inert beside its heading, the band's name leaves the Parameters heading, and no marker on the plot is
drawn as the selected one. The reserved space carries one line saying what owns those values, since a
heading over five rows of nothing reads as a rendering fault — and because hiding the rows removes the
only place that said the numbers are the device's. Reserving rather than removing is what holds the
height: the rows keep their tags too, invisible, because a tag pill makes a row taller (measured:
dropping them lost 3 px over the five, and the heading's own pill another 3).

### 1-knob, and what the device owns

The 1-knob is a section of its own above the band's parameters, because it decides whose the rows
below are. Its Type and Level stay on screen with 1-knob off, **locked** — the section would
otherwise shrink by two rows on every toggle, moving everything under it. The unit swaps that row for
the band's filter type instead; this screen has that row of its own in Parameters, so there is
nothing to swap for. Two device facts sit behind the lock: a TYPE written while 1-knob is off has no
effect, and the OFF→ON transition resets TYPE to Intensity and LEVEL to 50 — so an editable Type
there would offer a value the unit discards. The unit's own screen makes it unreachable by hiding the
row; this one makes it unreachable by locking it, and shows what the value is.

With 1-knob on, all four band rows are the device's: it recomputes them from one level. They are taken
off the screen (see above) rather than shown read-only — a row of numbers nobody can act on is noise,
and there is no band selected to show them for. The response curve stays, which is where the device's
computation can still be read: with a live session the refetch below keeps it true to the unit, and
without one it is the curve the plan last held.

Every EQ instance offers all three preset types (Intensity / Vocal / Loudness), measured. The catalog
used to carry two subsets and both halves were wrong; see the parameter notes for how a level reset
was misread as a refusal.

### Above 96 kHz

A stereo channel's EQ is not merely locked in the app at 176.4 / 192 kHz: measured, a 1 kHz high-pass
that cuts -13 dB at 500 Hz passes it untouched at both rates, while the parameters are still stored
and returned. The rows lock with the rate's own sentence rather than the device-driven one, and the
response is drawn sunk instead of left looking effective.

## DUCKER

**The one screen that does not tune the node it opens on.** GATE / COMP / EQ live inside a channel;
a ducker is its own node hanging under a stereo channel, and its threshold watches a signal that
arrives from somewhere else entirely. Every difference below follows from that.

- **It opens on the ducker node**, from that node's inspector section or from the parent strip's
  opener chip in the CONSOLE. The chip lives on the parent because a hung node has no strip of its
  own; the id it carries is the ducker's.
- **The title names the host channel**, not the node. The ducker node's canvas label is `Ducker`,
  which beside a heading reading DUCKER names nothing — so this descriptor answers the `nodeLabel`
  hook with `CH 5/6` and the rest keep their default.
- **No display bar.** The envelope and the lanes are both on screen, as the EQ's plot and lanes are,
  so nothing chooses between them and `DynProcessor.bar` is left unset — a heading over a segment
  with no buttons would name a choice that does not exist.
- **No MIDI ids.** The control catalog carries a ducker's `duckerOn` and nothing else, so returning
  ids for these four sliders would arm learn against controls that do not exist.

### Four lanes in three slots

| Lane | Address | Notes |
| --- | --- | --- |
| Key | the key source's own tap — a channel's **moves with its Rec Point** (see below), a bus's is its POST | **One bar, whatever the source's width.** Carries the threshold cap |
| Pre Ducker | `116 : 2p, 2p+1` | The host channel, post-fader. Stereo, so two bars |
| Post | `120 : 2p, 2p+1` | The host's output. **The reduction is drawn in this slot** |
| Ducker GR | `119 : p` | No column of its own (`DynLane.sameSlot`); keeps its own readout tile |

**Which tap the key lane reads.** The block diagram settles it: the `Rec Point` selector's output is
the very signal it labels `CH OUT`, and `DUCKER 1-4 SOURCE` takes `CH 1-4 OUT` / `CH 5/6-11/12 OUT` as
its inputs. So a channel key is read at **that channel's current Rec Point** — PRE GATE / PRE COMP /
PRE EQ / PRE INS FX / PRE FADER on a mono strip, PRE EQ or PRE FADER on a stereo one, where PRE EQ is
the INPUT meter because the stereo strip's EQ is the first thing in its chain. Every one of those sits
ahead of the source's own fader and ducker, which is why moving the source's fader does not move the
trigger. A bus key is the bus's own OUT, after its output insert FX. The lane read PRE FADER for every
channel source until 2026-08-13; a source set to any other Rec Point then showed a signal the detector
was not listening to, off by whatever the stages in between were doing.

**Why the key lane is one bar.** Measured on a URX44V: the unit sums a stereo key's two sides before
its detector — a correlated pair reads 6.02 dB above either side alone, not 3 dB (a power sum) and
not 0 dB (a louder-side pick). The cap can only ride a ruler in its own coordinate, and against a
summed display the threshold's onset held to -3.0 ±0.5 dB where against `max(L,R)` it spread 7 dB.
So the lane folds to what the detector reads (`duckerKeyDb`), the cap sits on it unmodified, and the
-3.0 dB is a sine's peak-to-RMS: these meters read peak and the detector reads RMS.

**The cap is a guide, not a calibrated marker,** and the reason is that -3.0 is a sine's figure
rather than a constant. Measured with a tone on one side and preamp noise on the other, the onset
sat 8.5 dB below the summed display instead of 3.5 — because a noise-like key's peak-to-RMS is
nearer 10 dB than 3. So programme material engages at a lower bar reading than the cap implies. No
correction is applied for it: the app has no measurement of the key's crest factor to correct with,
and -3.0 is simply the better of the two available constants (no correction at all puts the tone
cases 3 dB out).

**Why the reduction is on POST.** A reduction grows down from 0 and a level grows up from the floor,
so they collide when `level + |reduction| > 0 dBFS`. On an input lane that is the normal case — at
the factory range of -56 dB the block covers 93% of the ruler and the bar's top is buried. On the
output lane `post = pre - |reduction|`, so they meet only if the pre-ducker signal reaches 0 dBFS,
and **the gap between them is that signal's headroom**.

The cost is that a merged reduction has no scale of its own: it rides the shared ruler, which stays
on the threshold's domain (0..-60 dB), so a reduction deeper than 60 dB pegs. The range control
reaches -70, so that is reachable — traded for keeping every other lane and the cap on the domain
they use.

### Envelope

x is logarithmic time spanning both controls at once (attack from 0.092 ms, decay to 5 s); y is gain,
0 at the top down to the range control's -70 dB floor. Three straight segments: down to the range
over `attack`, held, back to unity over `decay`.

**Straight, and with no live overlay.** The release is an exponential approach whose tail is
dominated by the GR meter's 1 dB quantum, so no single time constant is fitted — the claim is the
arrival time, which is what a ramp between two known points states. A dashed rule at the live
reduction was drawn here while the reduction had a column of its own; once it became a block on the
POST bar a few pixels to the right, the rule was a second display of one quantity and the weaker of
the two, since a time axis gives a live reading no position. COMP keeps its dot because its plot maps
input to output, where a live level does have one.

## Off the scale is off the frame

Every plot draws its curve at the **true** value, and the host **clips it to the plot area**. Clamping
a value onto the axis instead draws a horizontal bar along the edge, which reads as a response the
processor does not have:

| Plot | What clamping did |
| --- | --- |
| EQ | A high-pass passes the -18 dB floor within an octave of its corner, so the curve lay along the bottom of the frame |
| GATE | A closed shelf sits at threshold + range, which reaches -144 dB while the range is still finite (threshold -72 … -56 with the deepest ranges). Clamped to the -128 axis, it drew the same picture as a -∞ range: a gate that is not closed, looking closed |
| Markers | Pinned to the floor, a marker named a frequency at a level the response never reaches there |
| COMP | Nothing — the -54 … +18 axes contain the whole response (makeup gain only adds, the knee interpolation only subtracts), which `src/ui/dyn-plot.test.ts` checks at the extremes rather than assuming |

The split is structural, not a convention each descriptor has to remember: `drawAxes` is called
unclipped (its tick labels belong in the gutters `geo.pad` reserves) and `drawCurve` inside the clip.
A new processor's plot inherits the rule by existing.

Two deliberate exceptions, both stated where they are made:

- **An annotation of a value may be clamped**, because it describes the value rather than being it —
  the gate's range label stays readable at the bottom of the frame while the shelf it names has left
  it. A leader line drawn *to* the annotation is part of the curve and is not clamped.
- **The gate's -∞ range is pinned to the axis floor**, since the floor is what stands for -∞ there (it
  is the GR meters' own floor, and the label prints "-∞"). That is a representation, not a clamp, and
  it is what makes the finite case distinguishable now that the finite case leaves the frame.

## Scope

GATE and COMP are MONO IN features, so those screens exist for CH1-4 (CH1-2 on URX22) only. The EQ
exists wherever there is a 4-band PEQ: every mono channel outside SSMCS mode, every stereo channel,
each MIX bus and the STEREO master. The node is fixed by where the screen was opened from — there is
no in-screen node switch.

The address set is **not** fixed with it. The DUCKER's key lane reads at the source's own Rec Point
(above), so a Rec Point change under an open screen — from the graph inspector, an undo, or the unit's
own front panel — moves that address while the screen stays on the node it was opened for. The screen
therefore compares its address set on every rebind and re-subscribes when it differs; without that the
key bar reads `—` until the screen is closed and reopened.

The remaining confirmed GR meters are DUCKER (119) and the insert FX (132 input / 133 output). Their
axes are **not** the mono channel index the gate's and comp's share — the ducker's is the stereo
pair, the output insert FX's is the effect band — so each one added has to bring its own measured
axis rather than inherit `grAddr`'s.

### The screen is not the frontmost thing on screen

A plan can be loaded — dropped, opened, recalled from the recents — with a tuning screen open over it,
so `loadPlan` refreshes the screen: it reads the plan through a closure and already held the new values,
but nothing had told it to redraw. The refresh re-resolves the binding too, so a screen whose node or
processor the new plan does not have closes itself instead of writing into something that is gone.

The scrims all share one z-index, which made document order the tiebreak — and put the **load report**
behind the tuning screen, where a report about the very drop that raised it could not be read. The
**drag advert** was behind it too, for a second reason worth knowing: its `z-index: 120` sat in a rule
*above* `.consent-scrim`'s `100`, and at equal specificity the later rule wins, so the advert had never
actually been at 120 — the comment claiming it "sits above the modals" had been wrong since it was
written. Both are now in one explicit ladder in `style.css`, placed after `.consent-scrim` so the
cascade cannot quietly undo it (menus 40, control popovers 60, tool modals 100, the drag advert 120, the
decision gates 130): consent, the load report and the rate choice each ask a question that has to be
answerable whatever else is open.

### A gesture the window is taken away from

The three drags this screen runs itself — the threshold cap, the plot, and the value rows — end when the
window loses focus, because no engine ends them for you: taking the OS foreground away with the button
down fires `blur`, fires **no** `pointercancel`, and keeps the pointer capture (measured 2026-08-14 on
Chromium and on the shipping WKWebView). Until this existed, a press held through an app switch went on
writing into the plan and out to the unit while another application was frontmost, and — since
`history.ts` also ends its press at a `blur` — the remainder landed in a *new* undo entry.

The cap and the plot are the view's own gestures, so ending them is dropping what the view holds. **A
value row is a native `<input type="range">`, and the engine owns its drag**, which makes it a different
problem in three ways, each measured:

| Treatment | What it does |
| --- | --- |
| Removing the listener | Nothing. The engine drives the control; the app only mirrors `input` |
| `pointer-events: none` | Nothing. The row kept writing in both engines |
| Detach + re-insert | Ends the drag — but only until focus returns. On the unit the row **resumed** under the still-held button |
| `disabled` | Ends it, and cannot be re-acquired while it lasts |

So a row that loses the window is disabled, and stays disabled **until the press is over or the window
comes back** — a `pointerup`, a `pointercancel`, a `pointermove` reporting no buttons (the release the
window never heard), or the app regaining focus. Ending it at the blur alone was not enough: with the
DETACH treatment the row resumed under the still-held button when focus returned, which is what sent that
treatment back. Disabling does not resume — measured in both engines and confirmed by hand on the unit —
which is what makes the return a safe release, and it is the one signal that always arrives: a release
lost outside the window is never counted, and a touch pointer id is never reused, so without it a row
could stay inert with nothing left to clear it. Focus is restored
with the row, since disabling drops it. It costs nothing on screen: the slider is authored
(`appearance: none`, its own track and thumb), so the engines have nothing of their own to dim — the row
shot enabled and disabled is byte-identical in both.

**This is not the tuning screen's rule but the app's**: `holdInertOnBlur` in `ui/dom.ts` carries it, and
every `<input type="range">` goes through it — the tuning rows, both of the inspector's slider builders,
the shared `sliderRow`, and Device setup's brightness — for the same reason `wheelStep` is shared. What
this screen adds is where a deferred refresh lands. The blur ends the gestures this view runs itself but
leaves `grabbed` set, because the press is still in flight and a rebuild under it would hand the
still-held pointer a live control — the state the hold exists to prevent. So the deferral lasts as long
as the press, and the refresh runs at whichever comes last: this screen's own pointer release, or the
release of the last row held anywhere in the app. The hold in turn asks for the row that is on screen
rather than the one the gesture started on, since a rebuild may already have replaced it. A rebuilt row
keeps whatever `disabled` state the rebuild gave it — COMP's 1-knob coming on hands threshold / ratio /
gain / knee to the device and locks those rows — and it does not get focus back, because no rebuild in
this app restores focus.

The inspector defers on the same signal, through the gate that already waits out an IME composition and
an open `<select>` picker. That one is worth naming because a held row is the only one of the three with
no end event of its own: a composition ends, a picker closes, and a hold ends on a pointer release the
panel never hears — so the gate subscribes to the hold bookkeeping directly.

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
| GRAPH inspector, GATE / COMP / EQ section | A full-width button below the ON/OFF toggle, its label centred and a caret at the trailing edge |
| CONSOLE strip | A narrow chip beside each processor chip the strip has, labelled `▸` |

Both marks point right and both say the same thing, but they are drawn differently on purpose: each
belongs to the family of the surface it sits on. The inspector's is built exactly like the section
header's own disclosure chevron two rows above it — two adjacent borders rather than a glyph — and
measured against that chevron it paints 174 painted pixels to its 180, so the two read as one mark at
one weight. The CONSOLE chip is a glyph because its neighbours are glyphs. Matching the two to each
other would break whichever panel it was matched into.

All three sections are reduced to their ON toggle plus the launcher. A second copy of the sliders in the
inspector is not just duplication: `dynFieldSlider` reads the params snapshot captured at render
time and never re-renders on a value change, so after the screen moved a value those sliders would
sit at the old position and write it back on the next drag.

The console opener is a separate chip rather than a gesture on the processor chip: `wireActivate`
binds click and Space/Enter with no `detail` guard, so a double-click would toggle the processor
twice and write twice, and double-click is already the factory-value reset for this view's faders
and knobs. Each pair fills one row of the two-per-row chip grid — head height is uniform by design
so the SENDS racks, faders and meters stay aligned.

The EQ's opener takes a fourth chip row on a mono channel, which the head has to carry: measured, its
inner height is 254 px, a chip row costs 24 px, and the CH3/CH4 strips — the ones with a Hi-Z chip —
had 0.9 px of slack at the old 252 px. `--head-h` is 276 px, which takes 24 px from the fader zone on
every strip, including those with no chips at all. The opener is not offered where the rate has the
EQ forced off (the toggle beside it is read-only there), nor in SSMCS mode, where the EQ chip belongs
to the morphing strip and there is no 4-band PEQ to open.

## MIDI assignment

Every parameter on these screens can be driven from an external MIDI controller, on the same catalog
and the same learn gesture the CONSOLE strips use (`ui/midi-learn.ts`; the catalog is
`core/midi/controls.ts`, the surrounding design is in architecture.md).

- **The target is the row's control cell.** While learn is on it takes a dashed ring, the armed one a
  solid pulse, and an already-bound one an amber dot — the console's own three states, so a strip
  control and a screen control read the same. The press is taken in the **capture phase**, so the
  slider never starts a drag on the click that arms it, and the wheel is gated for the same reason.
- **A row that is locked is not offered.** The reasons are the ones the rows already print: the rate
  has a stereo channel's EQ inert, 1-knob has handed the values to the device, or the filter type does
  not read that value. Nor are the enum selectors (COMP knee, EQ filter type, EQ 1-knob type) — the
  catalog carries continuous and toggle controls only.
- **A band binds to that band.** The id's scope is `@eq.low` … `@eq.high`, not "whichever band the bar
  has selected": a mapping has to keep working with this screen closed, and the bar resets to LOW on
  every open. `DynProcessor.controlId` is where a descriptor answers which id one of its value keys
  has — the host stays ignorant of which processor it is showing, and answers `null` for a key with no
  control.
- **The grid is the field table's.** A MIDI value and a dragged slider both resolve a position first
  (`dynToPos` / `dynFromPos` in `control/translate.ts`), so the two cannot land on different values of
  one grid.
- **The screen opens while learn is on.** The `▸` opener is not itself assignable, so it passes the
  arming guard through rather than arming instead of opening.

## Without a device

The screen opens in every build and in every state. The parameters are plan values and fully
editable with no device (the browser build included); the meters sit at the floor with their
readouts printing `—`. Nothing is locked or hidden, because nothing here needs the desktop shell to
be *edited* — only to be *observed*.

## Implementation notes

`DynScreen` owns everything that does not depend on which processor is open — the modal, the lane
rack, the meter feed and its peaks, the slot borrow, the canvas lifecycle, the persisted bar
selection. A `DynProcessor` supplies the rest: what the node has (`bind`), its corner of the plan
(`read` / `patch`), its bar, its rows and their states, its plot. Adding DUCKER or an insert-FX
screen means writing one of those, not another screen.

Where each piece lives follows from that:

| Module | Holds |
| --- | --- |
| `src/ui/dyn-screen.ts` | the host: modal, lanes, meter feed, canvas, rows from a `DynField[]` |
| `src/ui/dyn-chan.ts` | what GATE and COMP share as MONO IN channel-strip processors — their binding, their sub-object plan I/O, their display bar |
| `src/ui/dyn-plot.ts` | the dB-in / dB-out transfer plot those two draw: `transferPlot()` returns the five hooks it answers, from three axis constants and a hint |
| `src/ui/dyn-{gate,comp,eq}.ts` | the descriptors — only what differs |
| `src/core/control/translate.ts` | every field table, including the EQ's (`eqBandFields`), so a measured fine grid or range sits beside the others rather than in a UI file |
| `src/core/eq-response.ts` | the measured filter model, tested against the device sweeps |

The EQ's reserved-block line is DOM the descriptor puts in its own `rows.tail`, not a host hook: it
is absolutely positioned (so it costs no height) with `pointer-events: none` — a label that swallows
the press meant for the Close button behind it is worse than no label.

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
after its own DOM writes. A row that changes who owns the *other* rows (1-knob, Auto Makeup) rebuilds
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
| DUCKER's reduction in a column of its own | Costs a column and a scale, and the width goes to the plot instead: 333 → 235 px of lanes, 312 → 410 px of envelope at a 1440 px window |
| DUCKER's reduction merged into KEY or PRE DUCKER | Measured: a reduction grows down from 0 and a level grows up from the floor, so they collide when `level + |reduction| > 0 dBFS`. On an input lane that is the normal case — at the factory range the block covers 93% of the ruler and the bar's top is unreadable |
| A live overlay on the envelope | Once the reduction became a block on the POST bar a few pixels away, an overlay was a second display of one quantity. A time axis gives a live reading no position, so it could only slide up and down |
| A Ladder / Envelope toggle on DUCKER | Both are on screen at once, as the EQ's are, so nothing chooses between them and the heading would name a choice that does not exist |
| Widening DUCKER's ruler to -70 dB so the merged reduction keeps its depth | Buys the deep end of the range control at the cost of every other lane's resolution, and the bottom 10 dB is dead for the KEY lane — the threshold cannot go there |
| Shortening the note's copy to stop it clipping | The container was the defect, not the copy: at one reserved line the shipped COMP and EQ notes already wrapped below ~1150 px of window (~1300 px in Japanese). Shortening only moves the width at which the next one is cut |
| An in-screen channel selector | Every switch would re-register the address set, and the screen is opened per channel from a per-channel control anyway |
| A gesture on the CONSOLE GATE chip (double-click / right-click) | Double-click is the factory reset elsewhere in the view and `wireActivate` has no `detail` guard; right-click is unused app-wide but collides with the macOS native menu on Ctrl+click |
| Adding an app-side release to the level lanes | The device's meters already release at ~30 dB/s; a second one would double it |
| Reading COMP GR as the net applied gain (reduction + makeup) | The idle OVER sentinel on a channel with +18 dB of makeup suggested it, and it would have made the lane useless above modest makeup values. Measured and refuted: the makeup moves the downstream tap and not the GR meter |
| Sharing the level lanes' dB per pixel for the COMP GR lane | A gate's reduction runs the whole ruler; a compressor's is a few dB of it, and reads as a lane that never moves |
| Leaving the COMP knee out of the curve | The selector would change nothing on screen — the same failure the gate's output axis already cost us. Measuring the widths was cheaper than shipping a control with no feedback |
| A second instance of the screen for COMP | Both would bind the same modal host and the same single meter slot; the processor is chosen per open instead |
| T / R / G grips dragged on the COMP curve, as the unit does it | Built, then removed. A press that missed a grip fell through to the threshold drag beneath it, so pressing the gain grip moved the threshold; and the grips were drawn clamped inside the plot while hit-tested at their true position, which put the two ~13 px apart at the axis ends. Underneath both defects, three grips on one plot cannot tell which value a press meant |

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

Identical to the inspector's: `onUpdateNodeParams` merges the patch into the processor's own corner of
`plan.nodeParams[id]` and calls `markChanged()`, which flags the plan dirty, schedules the live mirror
and feeds MIDI feedback. A STEREO-linked pair in BAL mode mirrors the group to its partner like any
other node parameter. Where those values live is the descriptor's business: GATE and COMP keep one
sub-object each, the EQ spreads across `eqBands[i]` and `eqOneKnob` and routes a patch by key.

**A 1-knob write comes back as a read.** `ParamSpec.sideEffect` distinguishes two repairs, because
they differ in who owns what the device just moved:

| Flag | The device moved | Repair |
| --- | --- | --- |
| `"converge"` | values the plan **authors** (a COMP/EQ type change clears the channel-strip toggles) | push them back — a converge round over the write scope |
| `"refetch"` | values the plan only **mirrors** (the EQ 1-knob recomputes all four bands) | read the owner node back, and re-base the snapshot from it |

The EQ 1-knob's three parameters are the refetch case. Converging them would write the operator's
stale manual curve straight over the device's own computation, and nothing announces the
recomputation: the notify registration is an address list, and the band addresses leave it while
1-knob is on (the plan stops emitting them). So `live.ts` calls the same device→plan inverse the
device-follow scoped path uses, then re-captures the snapshot — without which every value the read
brought in would read as a pending edit on the next diff. A device-side turn of the same knob already
took this path; this is the same repair for our own write. A refetch is also one read of one node
rather than a converge round, so the flush window is not held open for a whole convergence — which is
what made a drag on the 1-knob level wait for the pointer to stop.

It is **not free**, and the cost is measurable. The unit does not answer for a write at the moment it
acks it (`docs/en/architecture.md`, "A write is not readable when it is acked"), and the refetch is
issued in that same millisecond — so the read waits the write out from inside the flush, and one
cycle of a 1-knob level drag is write + wait + read where a plain parameter's is write alone. In the
race harness, on the same gesture: **423/428/432 ms per flush window against 322/334 ms** before the
wait existed (`t2c-shape-change`, which is why that case's drag was lengthened from 10 steps to 16 —
a shorter one no longer contains several windows). The control arm in the same case, a LOW band gain
drag with no `sideEffect`, is unchanged at 205/200 ms: only a drag that makes the unit recompute
pays.

**Measured on the unit, not inferred from that** (2026-08-02, URX44V V1.3.1.0, a throwaway build of
the fix carrying the diagnostic instrumentation). A 1-knob LEVEL drag produced ten flush cycles and
the settle ended at the device's own notify in **10 of 10** — 42-203 ms after the write was issued,
write to read-complete 58-298 ms, and the 300 ms bound never reached. So the cost is the device's
announcement window and nothing else, and it cannot be tuned away: lowering the bound does not touch
a drag, and the alternative — deferring the read to pointer-up — leaves the band gains stale for the
whole gesture, so the plot draws a curve the unit is not producing. Several flushes still reach the
unit inside one gesture, which is the property that mattered.
