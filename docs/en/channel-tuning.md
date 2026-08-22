# Channel tuning screens (design specification)

> 日本語版: [../ja/channel-tuning.md](../ja/channel-tuning.md)

**Status: GATE, COMP, EQ, DUCKER and the SSMCS bank implemented.** This document specifies the
per-node screens that put one processor's parameters beside the meters showing what they are doing.
The insert-FX dynamics have gain-reduction meters of their own (see [Scope](#scope)).
Implemented in `src/ui/dyn-screen.ts` (the shared host), `src/ui/dyn-gate.ts` /
`src/ui/dyn-comp.ts` / `src/ui/dyn-eq.ts` / `src/ui/dyn-ducker.ts` / `src/ui/dyn-ssmcs.ts` (what
differs per processor), `src/ui/dyn-registry.ts` (which of them exist), `src/ui/dyn-chan.ts` (the
binding the two channel-strip processors share), `src/ui/dyn-plot.ts` (the dB×dB transfer plot),
`src/ui/dyn-freq-plot.ts` (the frequency-against-gain plot the two EQs share),
`src/core/eq-response.ts` (the measured filter model), `src/core/meters.ts` (the GR table and
decode), `src/style.css` (`.gt-*`), with coverage in `e2e/dyntuning.spec.ts`, `e2e/ssmcs.spec.ts` and
`e2e/eqoneknob.spec.ts`.

One host serves all three and the processor is chosen per open, so opening any of them replaces
whatever was on it. Two instances would fight over the same DOM, and this session's one meter subscription
means two open at once could not both stream anyway.

**Nothing in the host knows which processor it is showing.** A `DynProcessor` resolves what a node
actually has (its fields and its meter lanes), reads and writes its own corner of the plan, and
arranges its display column out of the parts the host offers. That division is why a processor with
no gain-reduction meter, on nodes whose taps are stereo, whose values live in an array and whose
band is selected by pressing a marker on its own plot, needed no special case in the host.

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
│ ┌────────────────────────┐ ┌──────┐│ PARAMETERS               │
│ │  transfer curve        │ │0 ┌──┐││ Threshold  ──●──  -50.0 dB
│ │                     ／ │ │  │  │││ Range      ─●───  -56.0 dB
│ │                   ／   │ │-50──││← cap        ──●──   20.2 ms
│ │  _______________／     │ │  │▬▬│││ Hold       ●────   15.3 ms
│ │                        │ │  │▨▨│││ Decay      ─●───  150.2 ms
│ │                        │ │-72└──┘│                          │
│ └────────────────────────┘ │IN  OUT││ METER                   │
│  The curve's knee is the threshold │ [PRE GATE][PRE COMP][GATE GR]
│                                    │                   [Close]│
└──────────────────────────────────────────────────────────────┘
```

**The control column is capped at 400 px rather than given half.** `.prefs-grid` splits its shell down
the middle, and a tuning screen's controls do not need that: a parameter row is a fixed-width slider
plus its label, and the readout tiles stretch to whatever column they are given. Measured with the
column set to `max-content`, the widest any screen actually asks for is 392 px — the 4-band EQ and the
SSMCS EQ face in English, where the tag pill on a locked Q row decides it — against 297–350 px for the
rest, in both languages. The cap is scoped to `#dyn-screen-box`, so Preferences and the device setup
keep their halves. What it returns to the display column is 149 px: the 4-band EQ's plot goes
369 → 518 px and the SSMCS MAIN face's canvas 547 → 696 px.

Every screen now spends that width on a plot and a rack side by side, so there is no longer one whose
extra width only widens black. Where the width is still tight is the 960 px minimum window inside the
SSMCS bank, and that is [The lane ruler](#the-lane-ruler-and-what-it-does-not-carry).

**The last column has 4 px of padding, for a focus ring.** `.prefs-grid` carries `overflow-y: auto`, so
its horizontal axis computes to `auto` and the box clips sideways whether or not it ever scrolls that
way — and every control in that column ends flush with its content edge, which drew their rings outside
it and showed none of them. 4 px is the widest ring any of them draws: a select's outline reaches it
(2 px at offset 2) and the white-ringed controls' halo reaches the same, against 3 px for a plain
button. On the COLUMN rather than on the grid, which is the box that clips: padding on the grid comes
off the plot column too, and 4 px there is enough to make the 960 px window wrap a row that fits.

### The display

**The plot and the lane rack are both on screen, always.** They were alternatives once, chosen between
by a LADDER / CURVE bar, and that bar is gone from every single-processor screen. What ended it is the
reduction moving onto the output column: a rack that was three columns wide became two, and two fit
beside a plot. Nothing chooses between them now — the arrangement the EQ and the DUCKER always had.

The **plot** is the static in/out transfer curve, where the threshold is the knee and the range is the
drop below it. Its **output axis is not the input axis**: it runs to the GR floor (-128 dB) while the
input spans -72..0. The closed shelf sits at threshold + range, which for most of the range domain
falls below -72 dB — at the factory settings -50 + -56 = -106 dB — so a shared floor pinned every range
past -22 dB to the same line and range was invisible. Only a -∞ range reaches the axis floor, and the
drop is labelled with the range it represents.

The **rack** is the taps on one tick column, spanning the processor's own domain (-72..0 dB for the
gate). Linear in dB, which is the threshold's exact domain, so the cap's position and its value stay
proportional. This is why it does not reuse the CONSOLE's ruler, which is spaced by detent index.

**Every display starts at one height**, whether its processor carries a bar or not: a screen without
one reserves the row instead, through the same builder, so the space is whatever the bars that do get
drawn occupy. Without it the black display sat a bar's height higher on those screens.

The note under the display is always printed now, since the plot always is. Its box is a fixed height
whatever it holds — three lines, everywhere — so a longer string is CUT rather than wrapped, and
every string is measured against the 960 px window before it ships.

**A bar survives in one place**: the SSMCS bank, where it selects a face rather than a display mode.

### Lane captions

**The caption under a bar names the POSITION — `Input` / `Output` — and the readout tile below names
the tap.** Both used to name the tap, and neither said which end of the processor it was. The unit's
own dynamics screens meter the same pair: the user guide calls the item "Input/output meter" /
「入出力メーター」, and "Input meter" / 「インプットメーター」 and "Output meter" /
「アウトプットメーター」 where it names the halves (D0). Latin in every language, because the caption
row is a narrow one and translating it costs width there.

**The SSMCS bank is the exception and keeps the tap names.** A position label works because a screen is
one processor, so "the input" is unambiguous — and that bank is several effects behind one title, whose
faces meter overlapping points of one strip. PRE EQ is the compressor's output on one face and the EQ's
input on another, and on the side-chain face it is neither: that face's own output is the detector
feed, which is not metered at all.

The lane's own name still reaches the operator — the readout tile prints it — so nothing is lost, only
moved to the surface with room for it. The meter-id numbers that used to sit under every bar (`108`,
`111`, …) are gone from the screen: they address the protocol, not the signal.

### The GR lane

Rose with a hatch, never the green/yellow/red signal zones, because a reduction is not a level. It no
longer stands in a column of its own on any screen; the rule and its arithmetic are in
[How a reduction is drawn](#how-a-reduction-is-drawn--one-rule-for-every-screen). Two rejected
alternatives are recorded below.

### METER

One cell per lane, printing the live value and the held peak. A tap that has not reported prints
`—`, never a floor value: a GR of `0.0` would claim the processor is passing everything, and a level
at the floor would claim silence that was never measured.

**The heading is the user guide's word for the item, translated.** The guide names it in both
languages — "Channel meter" / 「チャンネルメーター」, "stereo meter" / 「ステレオメーター」,
"LEVEL meter" / 「LEVELメーター」 (D0) — so the heading reads `METER` in English and 「メーター」 in
Japanese. The unit has no screen printing METER, so there is nothing to match letter for letter, and
the guide's qualifier is dropped: one word covers every tap the tiles carry, where LEVEL / CHANNEL
would have to be picked per surface and would cost width on all of them.

**The CONSOLE's own live cell keeps `METER` in Japanese, and that is the exception.** Its caption
sits on a strip whose labels are English throughout — the group separators because they are set in
vertical writing mode, where a full-width glyph widens the column and moves the rack's geometry —
and one katakana word among them reads as a mistake. Both captions there are `fixed()`; this heading
is `tr()`, and it sits in a modal that is Japanese throughout.

The tiles take three columns unless a screen declares otherwise. Four on three columns wrap to
3 + 1 — ragged, and wider than four need to be — so a screen with four lanes asks for two columns
(a 2 x 2 block) or for four (one row). Inside a bank the count is load-bearing rather than
cosmetic: the SSMCS COMP face takes four because a second row of tiles is 64px, which is enough to
push that face past the height its three faces are held at. Declaring it does not narrow anything —
a grid fills its column — it decides the wrap.

## COMP

The same three-tap shape one stage downstream — PRE COMP (108) in, COMP GR (110), PRE EQ (111) out —
and the same display. What the compressor changes:

**The curve is read, not dragged.** The unit's own COMP screen (user guide p.104) puts T
(threshold), R (ratio) and G (gain) on the transfer curve and lets you drag them. That was built and
removed: three grips on one plot means a press has to guess which value was meant, and a press that
missed one fell through to the threshold drag underneath — so pressing the gain grip moved the
threshold. The sliders beside the plot are the editing path; the curve answers what the settings are
doing to the signal. The gate's curve keeps its press-to-set-threshold, because it carries one
editable value and the gesture cannot be misread.

**The reduction reads off the SHARED tick column**, on every screen. It used to get a scale of its
own — a compressor's occupies a few dB of a 54 dB ruler, so at -8 dB it is 15% of the lane, visible
but not readable — printed beside the lane and set apart from the level pair. Merging it into the
level column it was taken off answered the same problem better, and a merged lane is on that
column's ruler by construction: two rulers side by side would read as one, which is the alternative
rejected for the gate below.

**Some values belong to the device while it drives them.** With 1-knob on, the unit owns
threshold / ratio / gain / knee — it computes the first three from a single level, and takes the
knee when the knob engages; with Auto Makeup on, it computes the gain. Each
recomputation is announced per address (measured), so those rows stay on screen and keep updating —
tagged, dimmed and read-only — rather than being hidden or recomputed here.

**1-knob's own two rows are locked, not swapped.** Auto Makeup cannot be operated while 1-knob is
on (user guide), and 1-Knob Level does nothing while it is off — so exactly one of the two applies
at a time. Both stay on screen either way, locked when they do not apply, the way the EQ screen
holds its 1-knob rows; the lock is declared in `rowStates` with every other one, not decided in the
row builder. Swapping them in and out moved the panel — a toggle row and a slider row are not the
same height — and dropping Auto Makeup lifted the 1-knob row itself a full row up, out from under
the pointer that had just clicked it. `e2e/dyntuning.spec.ts` pins both figures.

**The knee is drawn, and its width was measured — twice, in opposite directions.** Soft / Medium /
Hard publish no widths, so the curve would either invent a curvature or leave the selector changing
nothing on screen. The first pass walked the threshold up until the reduction stopped, which finds
the knee's LOWER edge, and doubled the reach under a symmetric-knee model: 0 / 16 / 40 dB.

The second pass held the threshold and walked the SIGNAL past it in 1 dB steps — the direction the
curve is read in — and fitted each candidate width to the result, all three settings sharing one
detector-versus-meter offset because that offset belongs to the rig rather than to the selector.
**Medium and Hard came back unchanged; Soft did not.** Its residual minimum is 51 dB against the 40
that doubling gave, which fits 62% worse, so the constant now carries the measurement (50 / 52 /
54 dB are indistinguishable in the residual, and it takes the round middle).

Doubling worked for Medium and failed for Soft because **the knee is not symmetric**: a 20 dB lower
reach against a 51 dB total leaves about 31 dB above the threshold. A symmetric model can only be
fitted to the best symmetric approximation, which is what the constant holds — so the asymmetry
itself, and the curvature between the edges, remain the standard quadratic and remain assumptions,
recorded as ones.

**The output axis runs above 0 dBFS.** Makeup gain reaches +18 dB, so the curve's axis is -54…+18
while the input spans -54…0. The gate's runs the other way, to the GR floor, for the same reason:
the parameter's effect has to stay on scale.

**No screen in SSMCS.** The morphing strip replaces the compressor, `channelDynamics().comp` is
null, and neither entry point renders.

## EQ

The 4-band PEQ, on the same host with three things arranged differently — each for a reason the EQ
has and the two dynamics processors do not.

**The response and the levels are both on screen** — the plot taking the width, the lane rack beside it
in its own frame. The curve says what the EQ is doing to the spectrum and the meters say whether the
stage is clipping; neither answers the other. This screen was the first arranged that way and is now
the only arrangement there is.

**A band is selected by pressing its marker on the plot**, and there is no band bar. One marker is one
band, so a press is unambiguous — which is what a row of four buttons was doing from a distance, while
the band about to be edited is where the operator is already looking. The selection resets to LOW on
every open, because it is a cursor into the parameters rather than a way of reading the processor.

The hit test and the drawing go through one function, so a press cannot land somewhere other than
where the letter is: a marker moves with its band's frequency AND with the composite curve under it,
and a hit test written from the same numbers separately would drift the moment either changed. The
box is the pill grown by 7 px on every side — the pill is 13–15 px tall, well under what a pointer
target wants, and the plot carries nothing else a press means.

**The plot is a focus stop and the arrow keys move the band.** The markers replaced a segmented bar,
and a segmented bar is operable from the keyboard; a canvas is a single stop, so Left/Right step and
Home/End go to the ends. Selecting rebuilds the column, so focus is restored onto the new canvas the
same way the bars restore theirs. With 1-knob on nothing is selectable and the canvas leaves the tab
order rather than standing in it as a stop that does nothing.

**The plot's axes are frequency against gain**, so it carries no live dot. Each band gets a **marker** —
a pill with its initials — a marker and not a grip: a grip would have to say which of the band's values
a drag moved, and four of them on one plot cannot (the COMP screen established that with three). The
sliders stay the editing path; the marker only selects. Off the
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
which also takes them out of the tab order, with their controls disabled as well), the plot stops
taking a band press and leaves the tab order with it, the band's name leaves the Parameters heading,
and no marker on the plot is drawn as the selected one. The reserved space carries one line saying what owns those values, since a
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

## SSMCS

The Sweet Spot Morphing Channel Strip is the bank a MONO IN channel's COMP/EQ type switches to in
place of the compressor and the 4-band PEQ. It is one processor with more in it than one screen can
show, so it takes **three faces of one screen** rather than three screens:

| Segment | Display | Rows | Lanes |
| --- | --- | --- | --- |
| MAIN | the compressor's transfer curve and the EQ's response, side by side on one canvas | Sweet Spot Data / Comp Drive / Morphing / Out Gain | none (the taps are still read, as tiles) |
| COMP | the transfer curve, the rack beside it | Attack / Release / Ratio / Knee | PRE COMP / PRE EQ |
| Side Chain | the filter's response, the rack beside it | Side Chain / Q / Freq / Gain | PRE COMP / SIDE CHAIN / PRE EQ |
| EQ | the response, the rack beside it | Band / Q / Freq / Gain | PRE EQ / PRE INS FX |

**One bar selects all four, and it is the display column's own.** It carries four segments over three
faces, because the COMP face's two plots answer different questions and are worth naming separately.
It replaced a face bar in the title row plus a display bar under it: two segmented rows meant the
operator had to know which of them held the thing they were looking for, and the title-row one was the
harder of the two to find. A bar item names the face it reaches and the segment to arrive on, so two
items can reach one face; which item reads as pressed is the host's own question, because it is the
only place that knows both the face and the selection within it — and a face whose selection is
something else entirely, as the EQ face's is a band, matches on the face alone.

**The EQ face carries no band row.** The markers on its response ARE the band control, as on the
shipped EQ screen, so the bank's is the only bar on any of the four.

The title stays `[CH 1] SSMCS` on all four. Naming each face would print `[CH 1] Comp` and `[CH 1] EQ` —
the shipped COMP and EQ screens' titles exactly — and nothing would then say which of the channel's
two banks is on screen.

**Each COMP-face segment carries the sliders whose effect is on the plot beside it** — the
compressor's on CURVE, the filter's on SIDE CHAIN. A slider whose curve is not the one drawn moves
nothing the operator can see. The two sets are four rows each, which is also what holds this face at
the height its siblings are held at.

Moving between faces does not close the screen. The three faces are one piece of work on one channel —
turn Morphing, read the reduction, touch Mid, go back to Comp Drive — and closing and reopening between
each step would rebuild the modal and hand the meter slot back and take it again.

**The faces are one height, with their display panels at one top edge.** The bar that moves between
them is above the display, so a modal that resized would move the very control that was just pressed,
and a panel starting at a different y makes the plot jump under the eye reading it. Neither is free:
the faces carry 4 / 4 / 4 / 4 rows now but differ in their readout tiles and in what their displays
are. The grid takes a `min-height` measured from the tallest face, with the headroom a wider font
stack takes.

**The readout tiles' column count is load-bearing here rather than cosmetic.** Four tiles on three
columns wrap to 3 + 1 — ragged, and wider than four need to be — so a face with four asks for two (a
2 x 2 block) or for four (one row). The side-chain face takes four: a second row of tiles is 64 px,
which is more than this reserve can absorb.

**The reserve yields, and the grid scrolls under it.** `.consent-box` clamps itself to the viewport
and hides its overflow, and the action row carrying Close is its last child, so a floor the box cannot
honour pushes Close out of sight — measured at the 960x640 minimum window (`tauri.conf.json`), 68 px
past the box's own edge on each of the six readings (MAIN, COMP and EQ, in both languages). So the
floor is `min(520px, calc(100vh - 211px))`, where 211 px is the modal's chrome around the grid plus
the 48 px the box keeps clear of the viewport, and the grid scrolls below it rather than clipping rows
that then have nowhere to go. The equal height survives the yield: at 640 px every face is the clamped
592 px, because the scroll absorbs what differs.

Two more consequences follow. The hint line is three lines on every screen — it was two, and the bank
took three on its own because the MAIN line has to name Comp Drive, Sweet Spot Data and Morphing, which
took a third line in Japanese at the 960 px minimum and was silently cut. Three became the base when the
COMP note did the same thing on the CI image: **the font decides the wrap, and the runner's font is not
this machine's** — two lines measured clean at 960 px on macOS for every note in both languages, and the
Japanese COMP note was cut by 13 px in CI. Three costs almost nothing, measured: at 960x640 the panel
does not move on any of the six language x screen pairs, and at 1280x800 only GATE grows, 610 to 634 px.
And every face keeps its plot beside its lanes all the way
down to 960 px, where the shipped 4-band screen wraps instead. Inside a bank that wrap is a 291 px
change on one face, so a bank does not wrap at all: the row is `flex-wrap: nowrap`, the rack keeps its
own width (a fixed number of fixed-width slots) and the plot takes what is left. A measured floor was
tried first and is what the arrangement replaced — it has to be re-derived against the WIDEST rack any
face carries every time a lane is added, and the side-chain face wrapped against a floor measured while
the EQ face's two columns were the widest. Measured under the current rule at 960 px: the side-chain
face's plot is 199 px beside its 223 px rack, COMP 264 / 158, EQ 252 / 170, no face wrapping and none
overflowing sideways, at 960 / 1000 / 1280 / 1600 px. A narrow plot at the minimum window is the trade
taken — a transfer curve carries little enough that width costs it least. Earlier measurements: **683 px with a panel top of 141 px** at viewport
heights of 731 px and up, **592 px with the same 141 px** at the 640 px minimum, across 960 / 1000 /
1100 / 1280 / 1440 px widths in both languages, with Close inside the box at each. `e2e/ssmcs.spec.ts`
holds it at the default viewport and again at 960x640; jsdom lays nothing out, so there is nowhere
else it could be held.

**The address set is a subset relation, not an identity.** MAIN's four taps are the union of the other
two faces', so a face change either narrows the registration or widens it back, and the same comparison
the DUCKER's moving key tap needs (below, "Scope") carries it.

**The internal stages are the taps that already exist.** Measured on a URX44V: 108 into the compressor,
110 its reduction, 111 between the compressor and the EQ, 112 after the EQ. 111 is a live tap in this
mode — driving the SSMCS Mid band to +18 dB moved 112 by 7 dB and left 108 and 111 where they were.
That is why MAIN carries four lanes rather than three: the transfer curve's live dot has to point at
the compressor's own output, and 112 would put the EQ's gain on the compressor's curve.

### The lane ruler, and what it does not carry

-60 dB floor, 6 dB steps — the ruler the 4-band EQ screen uses, because these stages carry programme
level. GATE and COMP use -72 / -54 because those are their thresholds' domains; **this bank exposes no
value in dBFS at all**, so there is nothing for a fader cap to ride and the rack has no gesture. The
corner is driven by an internal value the unit never shows.

The reduction lane is the COMP screen's: address 110, its own 0…-24 dB scale, on the COMP face only. On
MAIN the same reduction is the gap between the transfer curve and unity under the live dot, plus its
readout tile.

**The SSMCS COMP face's Side Chain segment carries a third lane: the side chain itself.** It reads address `109`, which is
the side-chain filter's output — what this compressor's detector is listening to, and the one quantity on
the unit's own COMP screen that moves only while the side chain is on. It stands between the input and
the reduction, which is the causal order: the level arrives, the detector hears its own version of it,
the reduction follows, the level leaves.

**It is not a stage the audio passes through**, and the arrangement must not be read as a chain. Measured
on a URX44V (2026-08-15): with the compressor held off its knee, sweeping the filter over 36 dB moved
`109` against `108` by the full ±18 dB while `111` against `108` held at 5.0 dB throughout. The filter is
a branch off the compressor's input, so `108` is both PRE COMP and the filter's input — they are one tap,
not two — and `109` is a key signal rather than audio.

`109` is therefore **not** one of the meter points the console offers. It reads its floor unless the
channel is SSMCS with both the strip's compressor and its side chain on, so as a console tap it would be
a black column nearly everywhere; `meters.ts` keeps it out of `monoTaps` and hands it out through
`sidechainTap` instead. CURVE and SIDE CHAIN keep three lanes — they share the display with a plot.

### How a reduction is drawn — one rule for every screen

**A reduction in a column of its own is the reduction**: absolute, on a ruler that can be its own, and it
agrees with the number in its readout tile. **A reduction merged into a level column is relative**: drawn
shorter by whatever gain the processor adds, so it is an *indication* of the reduction, and its readout
tile is deliberately not the number that bar is showing.

The reason is legibility, and it is a trade taken knowingly. Merged, the two grow from opposite ends of
one ruler, and where they overlap **neither** is readable. The overlap is `in + gain` in dBFS and does not
depend on the reduction at all, so taking the gain off leaves `in` — at or below zero for any real signal.
They then never meet, and the gap between them is the input's own headroom.

**Every screen merges**, which is what the DUCKER has always done: GATE's reduction hangs on PRE COMP,
COMP's and the SSMCS strip's on PRE EQ. The gain subtracted is the processor's own — the shipped
compressor's makeup, the strip's `min(24, |corner| × makeup/200)` — and the gate subtracts nothing,
because a gate has no makeup and so cannot overlap. The column-of-its-own arrangement is **gone from
`bindChannelStrip`**, along with the per-lane scale it was the only carrier of: it was reached by no
screen, and a rendering path no screen reaches is a second arrangement that has to be kept correct
by reading rather than by running.

The alternative to subtracting was to anchor the block to the level it was taken off, which is exact. It
was built and dropped: it makes the block touch the bar, so the two read as one column, and it gives the
eye two moving edges to read a length from instead of one.

**The offset is a parameter, not a second measurement.** It was first computed as `108` - `111`, which is
the same quantity — and is wrong to read frame by frame. Those are separate meter addresses whose frames
arrive at separate instants, so the difference is of two different moments, and since each carries its own
release, a reduction coming off made the bar *lengthen* before it shortened. Out Gain is excluded from it:
that gain lands after the EQ (measured) and so reaches neither tap.

### The two curves

Both are drawn from measured models, and neither is drawn in a line style that would claim one is less
certain than the other — they are both measurements, and dashing one of them would say in a picture
that it is the less reliable. What stays an assumption is the curvature between a knee's edges, which
is the same assumption the shipped COMP curve carries.

- **The compressor.** Its threshold is an internal value driven by Comp Drive, and the drive adds gain
  of its own — so that one knob moves the corner *and* lifts the output, which is what the operator
  sees on the OUT lane. **Comp Drive has two regions, meeting at raw 31.** At and above it the
  threshold parameter owns the corner and the drive slides it, both at 0.2 dB per raw. Below it the
  corner is the drive's own: it runs from 0 dBFS at a drive of zero down to whatever the threshold
  asks for at raw 31, so the threshold keeps only `drive / 31` of its 0.2 dB per raw there. Measured
  on a URX44V (System 1.3.1.0) off the host's recording of the compressor's own output: the corner
  falls 0.8468 dB per drive step below raw 31 against 0.2004 above it, the threshold moves it 0.1616 /
  0.1745 / 0.1938 dB per raw at drives 25 / 27 / 30 against 0.2004 at drive 60, and the two regions
  meet at drive 30.998. **The boundary is that one drive and not a curve across both parameters** —
  sweeping the drive with the threshold held at raw 30 produces no kink at all, and the corner starts
  at drive 31 as a single line of slope 0.2006 dB per step (RMS 0.0022 dB over 22 points). It also explains
  what a low drive looks like: the corner is then above any real signal, so the compressor reads as
  switched out rather than merely slack, and the reduction that is *drawn* stays with it. **A drive of
  zero is still its own behaviour** rather than the ramp's bottom end — the ramp would leave the corner
  at 0 dBFS, where a Soft knee reaches far enough down to draw 0.2 dB on a -19.9 dBFS tone, and the
  unit produces none at any knee while the same tone at drive 10 already gets 1.9 dB. Corner and knee
  together were then checked against the unit at Soft, Medium and Hard, at drives 10, 20, 24 and 28:
  the drawn reduction and the measured one agree to 0.107 dB at worst over those twelve. The knee is
  **asymmetric**, opening further above the threshold than below. **The knee
  model is one function for both banks** (`kneeResponse` in `dyn-plot.ts`), taking the two reaches as a
  pair; what stays per-bank is the DATA. `dyn-comp.ts`'s `KNEE_WIDTH_DB` is a measurement fitted as one
  symmetric width, so that bank passes `up = down = width/2` — and on a symmetric pair the cubic is the
  same polynomial as the quadratic it replaced, satisfying the same four constraints (both edges, both
  slopes), so sharing moved neither curve. The full-scale reduction annotation is read off the drawn curve with the gain terms taken
  back out, not off the asymptote, so a knee still open at 0 dBFS is labelled with what it does there.
- **The makeup is one gain over the whole curve**, as the shipped COMP screen applies its own. What was
  measured is what the unit does WHILE COMPRESSING — five raw points, linear, ±6 dB, with the GR meter
  unmoved. The same run's reading below the threshold is a null result at one threshold setting, and it
  does not separate "the makeup is off here" from "the block was not engaged here". Both cannot shape
  one curve: a gain present on one leg and absent on the other is a step at the corner whatever is
  drawn between the edges, and a Hard knee is 0 dB wide, so there is nothing to draw it across. Carried
  on the compressed leg alone it put a **step** on Hard and a **peak above the plateau** on Medium —
  22.97 px and 1.30 px between adjacent samples on a 320 px canvas at 4.44 px/dB, over a sweep where
  515 of 2100 settings folded and every one of them needed a makeup away from 0 dB. A compressor's
  transfer curve does neither. Which leg the unit puts it on is the open question; what settles it is
  walking the input across the corner and reading `111 - 108` on both sides.
- **The knee's shape** is a cubic through both measured edges carrying each leg's own slope — 1 below,
  1/ratio above — with the two slopes limited to the cubic's monotone region first. A quadratic cannot
  do it at all: its endpoint is fixed by its two slopes, so on an asymmetric knee it lands
  `(1 - 1/ratio)(up - down)/2` from the asymptote, 0.45 dB at the factory settings, drawn as a vertical
  step at the upper edge. The limit is what stops an unlimited cubic overshooting — rising above the
  plateau and coming back down, which is an input increase drawn as an output decrease. It scales both
  slopes by `3/hypot`, which is 1 wherever the pair is already inside the region, so a knee that does
  not need it still joins its legs exactly. **With the measured reaches it never engages**: the worst
  case over the whole ratio range is 2.18 against a bound of 3, and a Hard knee is zero wide so the
  branch does not run at all. It stays because the reaches are measured values that can move again.
- **The EQ.** Three fixed bands: LOW shelving, MID peaking, HIGH shelving. The shelf convention is the
  4-band model's — the nominal frequency is the point 3 dB below the plateau — and the peaking Q is
  **not**: the 4-band's "the unit's Q is twice the biquad Q" was refuted here. MID takes the same
  gain-dependent law as the side-chain filter below, because the two are the same filter; the 4-band's
  constant sits adjacent to it in `eq-response.ts` so neither block's can be carried to the other by
  accident. A band switched off leaves the response and keeps its marker, which sits on the composite
  curve at its own frequency: selected-but-not-contributing is two states, and one picture reads both.
- **Out Gain is drawn on the COMPRESSOR's baseline, and the unit applies it after the EQ.** Where the
  unit applies it was measured: stepping `117` between +18 and -18 dB moved tap `112` one-for-one and
  left `108` and `111` where they were (URX44V, 2026-08-15), so the strip runs
  `108 → compressor → 111 → 3-band EQ → Out Gain → 112`. It is drawn on the other plot anyway, and the
  reason is the axis: this one's gain scale IS the band gain range, so an offset of up to 18 dB pushes
  the response off the frame and takes the shape the operator opened the screen for with it. The
  transfer plot's output axis already runs to +18 because the drive and the makeup add, and a strip
  output gain reads there as a lifted baseline. It reached NEITHER curve before this, so a slider worth
  ±18 dB moved nothing on screen at all.
  **The live dot is lifted to match.** The transfer plot's dot is the pair (`108`, `111`), and `111` is
  upstream of Out Gain — so drawn raw it sat exactly Out Gain below the curve at every input level, which
  an operator reported. The plot's `outOffsetDb` adds the plan's Out Gain to the output reading before
  plotting it; the MAIN face's left half draws the same curve and takes the same lift, through the same
  one function so the two dots cannot sit at different heights. The alternative was to take Out Gain off
  the curve instead, which would leave it drawn nowhere — the EQ's plot cannot carry it for the reason
  just above.

### The second curve: the side chain

The bank's bar carries a segment the shipped COMP screen has no counterpart for, because this compressor
has an input that one does not: a filter in front of its **detector**. Its response is what the segment
draws, from the three rows underneath it — the compressor's own sliders are on the other segment, since
a slider whose curve is not the one drawn moves nothing the operator can see.

**It is the same bell as the strip's MID band — one law draws both**, measured on a URX44V through two instruments that
share the filter and nothing else — the compressor's own reduction with ratio at infinity and a Hard
knee (where GR is the detector minus the threshold, and the threshold is a 0.2 dB-per-step ruler), and
meter `109`, which carries the filter's output. The two agreed at a median of 0.00 dB over 488 paired
readings, and the MID band read through the audio path came out identical to the side chain read
through the detector path at 60 of 61 frequencies. Peak gain and centre frequency are exactly what is
set; 0 dB is an exact bypass.

**The Q the unit prints is not the biquad's, and the factor is not a constant** — the bell narrows as
the gain grows: `Q(biquad) = 0.238 × Q(displayed) × A^0.39`, with `A = 10^(|gain|/40)`. Measured
0.3585 / 0.3085 / 0.2750 / 0.2615 at 18 / 12 / 6 / 3 dB, symmetric in the gain's sign, independent of
the Q set across a 16:1 range and of the centre frequency. A single ratio costs 0.160 dB RMS against
0.064 dB for the law, which is what fitting each gain separately leaves.

The MID band was drawn from a CONSTANT ratio of 0.82 until this law reached it. That number came from a
sweep that read the width between the points 3 dB below the PEAK, where a biquad's Q is the width at
half the gain — for an 18 dB bell the two differ by a factor of 2.78, so every MID bell was drawn about
2.3x too narrow. Against the 61-point sweep the constant lands at 2.2 dB RMS over three states (worst
5.6 dB, always on the narrow side) and this law at 0.47 dB (worst 1.0). `pnpm test eq-response` pins the
law against those readings a point at a time, and the constant fails all three states.

**The axis is inverted against the filter's own sign, and that is the point.** What the segment draws is
the REDUCTION the filter buys, not the gain it applies: lifting a band in the detector makes the
compressor hear more of it and clamp down harder, so a boost draws DOWNWARD. Drawn the other way the
curve rose while the thing it produces fell, and it pointed the opposite way to the reduction lane a few
pixels to its right. The model keeps the filter's true sign; only the drawing flips it.

**This is the one plot in the app whose area is shaded.** Everywhere else the curve is audio, where the
line already says what the operator will hear. Here the line is not audio at all, and the area is the
reading: the band the compressor has been made to react to more, or less. The hint says the same thing
in words, once.

**The rack stands beside it, and each segment drops the lane its own plot does not answer for.** The
transfer curve is the compressor's own pair, so the side-chain tap goes and the rack is two columns.
Side Chain keeps all three: what the filter does is the DIFFERENCE between the input and what the detector hears, so
dropping the input leaves that face unable to answer its own question — and the filter's own output is
not metered at all, so there is no pair to reduce it to. COMP GR merges into the PRE EQ column it was
taken off in both. The taps are the same in every segment, so moving between them re-arranges the rack
without changing what is subscribed.

**The marker carries what the curve cannot.** Flat arrives two ways — the filter switched out, and the
filter engaged at 0 dB — and neither has a curve to be told apart by. `on` dims the marker for the
first, the same treatment a switched-off EQ band gets. The pill is kept whole inside the frame: the
host clips the plot to the axes and the top of that area IS the gain range's maximum, so a filter at
full boost used to lose the upper half of its marker — rare enough to go unseen on a three-band EQ,
ordinary on a one-band side chain.

### What the rows never do

They are never locked while Morphing runs. Morphing and a Sweet Spot preset are a **recomputation**,
not a continuing drive: the device rewrites the compressor, side-chain, EQ and Out Gain values the
moment one is written, and from the next moment they are the operator's again — the unit's own screen
accepts an edit immediately too. That is what makes them unlike the EQ's 1-knob, whose rows are reserved
out of sight for as long as it is on. The repair is a read (`ParamSpec.sideEffect: "refetch"`, and the
`drives` list beside it), not a lock.

The EQ face carries no filter-type row. All three bands are fixed, so the row would be the same locked
one-value row on every band — which is not why the 4-band screen keeps its Type row (there, two of four
bands are typed, and dropping it would change the panel's height per band). The two shelves' Q row does
stay, locked and tagged, for exactly that reason.

## INS FX

**One screen for every insert effect, resolved from the plan.** What a node holds is a selector value
the operator changes on another surface, and a device follow can change it underneath an open screen —
so `insert-fx-screen.ts` reads the family on every call rather than existing once per family. One
registry entry, one modal: a follow re-binds it instead of closing one screen and opening another. The
title carries the effect's own name (`INS FX — Compander-H`), because the heading would otherwise name
a slot rather than what is in it.

- **No Effect Type row, deliberately.** Writing the selector makes the unit refill the bound engine
  array with that type's defaults, and it is not reversible — re-selecting the original type fills it
  with that type's defaults, not with the values that were there. Putting that beside the sliders would
  give it the weight of a slider. Selecting stays on the Inspector's Insert FX row, and this screen
  adjusts what was selected.
- **No plot.** A guitar amp's frequency response and a pitch tracker are not derivable from the
  parameters, and the unit meters neither, so the display is the lane rack alone. That is what
  `plotGeo` / `drawAxes` / `drawCurve` being optional together is for.
- **Fields name an engine slot, not a parameter.** Insert-FX values live in `insertFxParams` keyed by
  family and slot, so a field's key is `ifx6` and only the catalogue knows what slot 6 is under the
  family on screen — which is why `fieldLabel` and `fieldText` are asked with the context. Every range,
  default, enum and formatter comes from `core/control/insert-fx-effect.ts`; nothing here restates one.
- **The compander's rows are grouped by what shapes the response** — Threshold, Ratio, Width, then the
  makeup, then Attack and Release — rather than in the device's read order, which is what the catalogue
  carries for the emit path.
- **No MIDI ids.** The control catalog carries none for these values, so the screen marks nothing —
  the same position DUCKER is in, and for the same reason.

**The note under the display says when nothing reaches the signal**, in either of the two ways
that happens. Above the held effect's own ceiling it names the effect and the ceiling, in the same
words the Inspector and the CONSOLE chip use — the alternative was one panel saying the effect is
off while another handed over a live editor for it. Switched out by its own bypass, it says that
instead. Either way the values are still kept and edited here, and the two level lanes beside the
note read the same thing. The launcher stays available: an effect held and not running is still an
effect to tune.

### The guitar amp is two faces

Everything else this screen shows is one panel. A guitar amp is an amp and a cabinet, and the
cabinet's four rows are a different job from the tone stack, so they are a bank in the sense the
SSMCS section defines: two descriptors, one bar, one reserved height, moved between without closing.

| Face | Rows |
| --- | --- |
| AMP | this type's own values, then Volume (Clean) / Gain, Bass, Middle, Treble, Presence, then the modulation group, then Output |
| CAB | Gate, Gate Level, SP Type, Mic Position — in the order the signal meets them |

The type's own values lead because they are what makes one amp a different amp. The modulation
group is placed by name rather than with them: Clean's Cho/Off/Vib, Speed and Depth are
type-specific too, and putting them at the head would separate Speed and Depth both from the
switch that drives them and from the Output they sit before. **Speed and Depth stay where they
are when that switch is not on vibrato** — dimmed and tagged, never dropped, because a panel that
loses two rows moves everything under them out from under the pointer. The effect guide's CLEAN Only
table is what says they apply only there: "Sets vibrato speed/depth when 'Vib' is On. Not available
when 'Cho' is On."

**Slot 7 is Volume on Clean and Gain on the other three**, which is what the unit prints. The
catalogue swaps the label alone: the slot, its encoding and its range are one thing across the
four, and the row keeps the position the emit path walks.

**The columns reverse for an amp.** Its panel is a dozen controls and its display is a level rack
with nothing else in it, so the parameters take the flexible column and the meters a narrow fixed
one. The companders keep the ordinary order — their display is the point of the screen — and the
binding declares which, since it is a property of what the node holds rather than of the
descriptor.

**A follow that replaces the effect returns to the AMP face.** The faces belong to the effect, so
a compander arriving under an open CAB face is neither of the two things the host does on its own:
a face whose `bind` answers null closes the screen, which is right for a bank taken away and wrong
for one replaced, and a `sel` nothing resets would carry a cabinet segment onto an effect with no
cabinet. `DynProcessor.bankIdentity` is what the host compares to tell those apart.

### Pitch Fix is two faces as well

PITCH is what the correction does to a note — Coarse, Fine, Formant, Correction, Mix. SCALE is what
it is aimed at: the Key, the Scale, the twelve notes, and the two limits and two timings that decide
when it acts.

**The twelve note slots are ABSOLUTE semitones.** Slot 22 is C whatever the Key is, measured by
setting Key = G with Scale = Major and reading them back as C D E F# G A B. So the buttons are named
from C and are not laid out as a keyboard: black and white keys would draw a root that is not there.

**A gesture reads the Key the plan holds, not the one the row was drawn with.** A row's handlers
close over the context they were built with, and the rebuild that would replace them is deferred for
as long as a pointer is down — a press anywhere in the box sets that, a `<select>` included — while a
device follow goes on writing the plan underneath. Choosing a Scale then rooted its mask at the old
Key and the next flush sent it; a note button read its own drawn state and wrote a value straight
back over the follow that had just moved it. Both now read through `DynRowCtx.live()`. What a button
SHOWS is still what it was drawn from — the panel catches up at the deferred rebuild — and what it
WRITES is the negation of what the plan holds when it is pressed.

**Every preset is selectable.** The unit derives the twelve notes itself from the Scale and the Key,
for all eight presets — read at Key = C and Key = G, the offsets came back identical while the
absolute bits moved — so the app authors the same offsets rather than only the two patterns it could
once spell. Editing a note takes the Scale to Custom, which the unit also does on its own; the app
writes it too, because the plan is what the next flush emits and a plan still spelling a preset would
re-derive the mask over the edit.

**MIDI Control is shown and never written.** The unit takes those notes on a USB-MIDI port of its
own — not the port this app reads external control from, so writing here would be a second route into
one setting — and switching it on erases a twelve-note mask that is FULL, taking the Scale enum to
Custom with it. Both measured. The row is inert, with the reason on it.

**Never written means the emit path, not the row.** The two slots are out of
`insertFxWritableSlots`, which is the list `translate` emits from — an inert row alone would not have
been enough, because a device read fills the plan from that same list and the next flush would have
written the enable bit with nobody having touched the app. They stay in `insertFxReadableSlots`, so
the read that feeds the row is unaffected: dropping a slot from the writable list drops the read with
it, and the row would then print a default instead of what the unit holds.

### The two reduction meters are indexed differently

They are not one table, and the difference is the reason:

| Effect sits on | Input lane | Output lane | Reduction |
| --- | --- | --- | --- |
| MONO IN channel | PRE INS FX (`112:ch`) | PRE FADER (`113:ch`) | `132:ch` — x is the mono channel |
| Output bus | PRE INS FX (post-fader) | POST (post-insert) | `133:band` — x is the effect's BAND |

`133` takes no node at all: one output insert effect runs device-wide (the `out-dyn` 1-of slot), so
which bus holds it does not enter the address. A single-band effect reads band 0.

The reduction merges into the OUTPUT column, as every reduction on every screen does, and takes no
offset: the rule is to subtract whatever gain the processor adds, and these add none — the compander's
makeup reaches 0 dB and only attenuates below it, so the level bar and the reduction hanging off the
top of the same ruler cannot meet.

### Which families the screen shows

Everything but the multi-band compressor, whose bands and globals are a structured layout that the
flat catalogue carries none of. It stays in the Inspector's own editor, and `bind` refuses it, so the
two surfaces cannot disagree about where a family is edited.

**And nothing the device path will not act on.** A plan can hold an insert-FX value the node's own
control does not carry — a bus holding a channel effect, which a file, a `?plan=` link or a device
read all land, since the loader gates none of them. `translate` coerces such a value to No Effect and
emits no engine parameter for it at all, so an editor over it collects edits nothing ever sends: at
48 kHz, where the ceiling is not in question, the screen bound four editable fields against zero
`INSERT_FX_EFFECT` commands. Both sides now ask one function, `effectiveInsertFx`, so what the screen
offers to edit and what the unit receives cannot come apart.

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

GATE is a MONO IN feature, so that screen exists for CH1-4 (CH1-2 on URX22) only. COMP is the same
channels **in COMP->EQ mode**, and the SSMCS faces are the same channels in the other mode — the two
banks are exclusive, so a channel offers one set or the other and never both. The EQ exists wherever
there is a 4-band PEQ: every mono channel outside SSMCS mode, every stereo channel, each MIX bus and
the STEREO master. The node is fixed by where the screen was opened from — there is no in-screen node
switch.

Neither is the PROCESSOR fixed, for one bank. The SSMCS faces move between each other from the title
row (above), which is a processor switch inside one open screen — but never a node switch, because a
screen is opened from a per-channel control in the first place.

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
still-held pointer a live control — the state the hold exists to prevent. So the deferral outlives the
blur, and the refresh runs at the **first** release to arrive: this screen's own `pointerup` or
`pointercancel`, or the end of the last hold anywhere in the app — which the window coming back also
produces, so a return with the button still down lands it there. Whichever runs first clears `grabbed`;
the others find it already cleared. The hold in turn asks for the row that is on screen
rather than the one the gesture started on, since a rebuild may already have replaced it. A rebuilt row
keeps whatever `disabled` state the rebuild gave it — COMP's 1-knob coming on hands threshold / ratio /
gain / knee to the device and locks those rows — and it does not get focus back, because no rebuild in
this app restores focus.

The inspector defers on the same signal, through the gate that already waits out an IME composition and
an open `<select>` picker. That one is worth naming because a held row is the only one of the three with
no end event of its own: a composition ends, a picker closes, and a hold ends on a pointer release the
panel never hears — so the gate subscribes to the hold bookkeeping directly.

## Meter subscription ownership

**This app holds one meter subscription per session, and that is its own arrangement rather than a
device limit.** The wire carries no subscription object at all — `reg_meter` sends one `regist` /
`unregist` frame per address. What is single is the worker's own set: `Cmd::MetersSubscribe` in
`src-tauri/src/vd.rs` unregisters `subs.meter_addrs` entry by entry and then registers the new
addresses, so `vd_meters_subscribe` replaces rather than adds, and `vd_meters_unsubscribe` takes no
address because there is only ever one set to drop. The device constraint recorded beside it is a
different one: never bulk-post to `/vd/meters`, which has been seen to crash Device Center.

The replacement is silent and the CONSOLE does not self-heal, so an unannounced takeover would leave
its bars frozen on the floor — indistinguishable from silence.

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
| GRAPH inspector, GATE / SSMCS / COMP / EQ section | A full-width button below the ON/OFF toggle, its label centred and a caret at the trailing edge |
| CONSOLE strip | A narrow chip beside each processor chip the strip has, labelled `▸` |
| GRAPH inspector, Insert FX | The same full-width button, below the Insert FX selector and its ON toggle — shown once an effect this screen tunes is selected, since with none there is nothing to open on |

In SSMCS mode the inspector keeps all four sections and hands each launcher over: the SSMCS section
opens the MAIN face, and the COMP and EQ sections open the COMP and EQ faces of the same bank. They
keep the shipped screens' own labels ("Comp screen", "EQ screen") rather than gaining their own: the
launcher sits in the same section, and a channel never carries both banks, so the label names exactly
one thing on it.

**The CONSOLE does not hand its chips over.** The strip carries one opener for the whole bank, beside
the SSMCS chip, and its COMP and EQ chips read exactly as they do on a channel with no strip at all.
The bank's other two faces are reached from the segment inside the screen, which is where a reader who
has the screen open already looks for them; a second and third entry point on the strip would put
three openers on one channel for one modal. What it costs is that the two faces have no direct route
from the CONSOLE — one press more than the inspector needs.

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
EQ forced off, since the toggle beside it is read-only there.

**A strip in SSMCS mode is the same height.** The morphing strip's own master and its one opener stand
exactly where COMP's and EQ's two openers stand, so the chip count does not move with the bank. The
COMP/EQ type is still a term in the head-height cache key, for the reason the sample rate is: it
changes what a head CARRIES, and what balances it here is a coincidence of counts rather than a rule.
It has moved the head in both directions before — an SSMCS channel carried no opener at all until this
bank had a screen, then three of them for one modal — and the key is what kept a clipped head off the
screen through both.

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
- **The SSMCS scopes mirror the plan's own nesting** — `@ssmcs` for Comp Drive / Morphing / Out Gain,
  `@ssmcs.comp`, `@ssmcs.sc` and `@ssmcs.eq.low` … `@ssmcs.eq.high` — so an id reads as the path to the
  value it edits, and a side-chain Q is told from a band's by the scope rather than by a second token.
  Its master ON takes the bare node scope the other section masters take. The two shelves' Q rows and
  the Sweet Spot Data preset are not offered: a shelf has no Q parameter at all, and the preset is an
  enum selector.
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
| `src/ui/dyn-freq-plot.ts` | the frequency-against-gain plot the two EQs share: its geometry, its grid, and the band markers — the same pill in the same face on both, since only the band set and the filter model differ |
| `src/ui/dyn-{gate,comp,eq,ducker,ssmcs}.ts` | the descriptors — only what differs |
| `src/core/control/translate.ts` | every field table, including the EQ's (`eqBandFields`) and the SSMCS strip's, so a measured fine grid or range sits beside the others rather than in a UI file |
| `src/core/eq-response.ts` | both measured filter models, tested against the device sweeps |

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

The bar's selection is stored per processor (`urx-dyn-display2`, a record keyed by processor), which is
now the SSMCS bank alone. It is a way of reading a processor rather than a per-device mapping — so
unlike the meter point it is not model-scoped. **The stored value is a segment INDEX**, so renumbering
a bar's segments takes a new key — an old index and a new one are indistinguishable, and the previous
key held a three-segment numbering in which 1 meant the transfer curve rather than the side chain.

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
| A second instance of the screen for COMP | Both would bind the same modal host and the same single meter subscription; the processor is chosen per open instead |
| T / R / G grips dragged on the COMP curve, as the unit does it | Built, then removed. A press that missed a grip fell through to the threshold drag beneath it, so pressing the gain grip moved the threshold; and the grips were drawn clamped inside the plot while hit-tested at their true position, which put the two ~13 px apart at the axis ends. Underneath both defects, three grips on one plot cannot tell which value a press meant |
| All eighteen SSMCS rows on one screen | The rows alone are ~18 × 42 px ≈ 756 px against `.consent-box`'s `max-height: calc(100vh - 48px)`, which is 752 px at the 800 px default window and 592 px at the 640 px floor `tauri.conf.json` allows — over before the four headings, the title and the action row are added, and into the internal scroll every shipped screen avoids |
| Folding the side chain into the COMP face's rows | It was one panel of eight rows once, with the Side Chain toggle as the divider. Splitting the bar gave the filter its own segment, and the rows follow the plot: a slider whose curve is not the one drawn moves nothing the operator can see. Four rows each, which is also what holds the face at its siblings' height |
| The face switch in the TITLE row | Two segmented rows meant the operator had to know which of them held what they were after, and the title-row one was the harder of the two to find. It is now one bar in the display column with a segment per face — with the COMP face split in two, since its two plots answer different questions — and the EQ face's band selector is gone from a bar entirely (its markers are the control) |
| A lane rack on the SSMCS MAIN face | Two plots and a rack in one column leave each plot ~152 px of drawing area at a fixed 320 px height, so the same +6 dB bell reads at three times the slope it has on the EQ face. The lanes are still subscribed and still printed as readouts without one — the host builds lane elements only when a descriptor asks for them |
| Widening the display column by giving the readout tiles fewer columns | Measured: the MAIN face's control column is 350 px with the tiles in two columns and 350 px with them in three. A grid of `1fr` tracks fills its parent; what asks for width is the parameter row's fixed-width slider. The observation that the column had slack was right and the lever was wrong — the split between the columns is the lever |
| Merging the SSMCS GR into the OUT slot (`sameSlot`, as the DUCKER does) | The only way to fit a rack beside two plots before the column split changed; unnecessary once it did, and worse than useless here, since MAIN and COMP read the same address set and a rack that reassembled itself per face would move under a switch that is supposed to be a move |
| A Type row on the SSMCS EQ face, locked, as the 4-band screen keeps its own | The 4-band keeps it because two of its four bands are typed and dropping it would change the panel's height per band. All three bands here are fixed, so the row would be the same locked one-value row every time and contributes nothing to the height being constant |
| Out Gain on all three SSMCS faces, as the unit's status bar shows it | The unit repeats it because it is what the encoder is assigned to. Repeating it here only adds occasions for the same value to look different on two faces |
| Locking the SSMCS COMP / EQ rows while Morphing is engaged | Morphing is a recomputation, not a continuing drive: ownership returns to the operator the moment it is written, and the unit's own screen accepts an edit immediately. Locking would forbid what the hardware allows |
| Drawing the SSMCS plots from the 4-band EQ's measured model | Extrapolation to a different DSP block. The 4-band model needed three corrections that only came out of measuring, which is the whole argument against drawing one unmeasured |

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
sub-object each, the EQ spreads across `eqBands[i]` and `eqOneKnob` and routes a patch by key, and the
SSMCS faces flatten a nested shape (`ssmcs`, `ssmcs.comp`, `ssmcs.sc`, `ssmcs.eq.<band>`) onto one
record and split a patch back apart by key — which is why its side-chain filter's three values are
prefixed there and un-prefixed in a control id, where the scope does that job.

**A 1-knob write comes back as a read.** `ParamSpec.sideEffect` distinguishes two repairs, because
they differ in who owns what the device just moved:

| Flag | The device moved | Repair |
| --- | --- | --- |
| `"converge"` | values the plan **authors** (a COMP/EQ type change clears the channel-strip toggles) | push them back — a converge round over the write scope |
| `"refetch"` | values the plan only **mirrors** (the EQ 1-knob recomputes all four bands) | read the owner node back, and re-base the snapshot from it |

Both 1-knobs are the refetch case — the EQ's three parameters and the COMP's two. Converging them
would write the operator's stale manual curve straight over the device's own computation, and
nothing announces the recomputation: the notify registration is an address list, and the band
addresses leave it while 1-knob is on (the plan stops emitting them). So `live.ts` calls the same device→plan inverse the
device-follow scoped path uses, then re-captures the snapshot — without which every value the read
brought in would read as a pending edit on the next diff. A device-side turn of the same knob already
took this path; this is the same repair for our own write. A refetch is also one read of one node
rather than a converge round, so the flush window is not held open for a whole convergence — which is
what made a drag on the 1-knob level wait for the pointer to stop.

**A refetch does not survive a converge, so one of them has to give way.** Both repairs can land in
one flush — PAN/BAL and the morphing knob inside one 120 ms window is enough — and the converge runs
first. It makes the unit match the plan across the whole write scope, so every address the plan still
emits and the unit has just recomputed goes back at its pre-write value, and the refetch that follows
reads what the converge left. Nothing on screen says so, and the unit keeps a morph position whose
strip belongs to a different position.

Which way it gives depends on **who authors the values**:

| The plan… | What closes it | Heads |
| --- | --- | --- |
| only **mirrors** them | the plan stops emitting those addresses while the head is engaged, so nothing can push them back | EQ 1-knob (its four bands), COMP 1-knob (`COMP_ONE_KNOB_DRIVEN`, which is also the set the COMP screen locks and tags, so the writer and the screen cannot disagree about who owns a row) |
| genuinely **authors** them | the head declares what it hands to the device (`ParamSpec.drives`) and the converge is told to leave exactly those alone, for that flush and that node | SSMCS Morphing, SSMCS Sweet Spot Data |

**One of those heads is a string.** Selecting a Sweet Spot Data preset recomputes the same
seventeen values a morph does, and the preset is a 4-digit string, so it rides the name-write
path rather than the numeric one. That path used to walk past both sets, which is why the
catalog could not simply declare it: a `NameWrite` now carries its catalog name and its owner
node, and the flush's name loop reads the flag off it. What the preset does **not** do is move
the morph position — it is announced with the burst whatever it holds, and parking Morphing at
62 before the write showed it announced and read back as 62 — so `drives` names the seventeen
and not `93`, or a converge would be stopped from restoring a morph the operator set.

The first is the better one wherever it is available — an address the plan never sends cannot be
pushed back by anything, and there is no list to keep correct. Morphing cannot take it: the inspector
edits the strip's values directly, so the plan really does author them, and only a converge that has
been told can tell the two apart. Its list is measured rather than assumed — every continuous value
in the strip and none of the five ON switches, which the morph leaves to the operator — and pinned by
address in `live.test.ts`. The exclusion applies to the converge's reads **and** to its round sends,
because group expansion would otherwise carry an excluded address back in on a sibling's difference
without it ever having been compared.

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
