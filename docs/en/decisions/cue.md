# Decisions: CUE

> 日本語版: [../../ja/decisions/cue.md](../../ja/decisions/cue.md)

Closed decisions about showing and switching the unit's CUE (the temporary change of what a monitor
plays) in the graph, the inspector, the CONSOLE, the status bar and MIDI. What the app does is in
[known-issues.md](../known-issues.md), "CUE is controlled during Live sync only, and never saved",
and in the pull requests that carried it:
[#605](https://github.com/semnil/urx-router/pull/605),
[#609](https://github.com/semnil/urx-router/pull/609) and
[#610](https://github.com/semnil/urx-router/pull/610). This document holds what was chosen, what was
turned down, and why. "The operator" below is the person who directs this project's work and decides
for it.

## CUE is shown and switched during Live sync

**Decision (2026-10-12, implemented in #605).** An earlier decision (2026-07-28) was to leave CUE
out until a need for it turned up. The operator reviewed that and decided to implement it, as
follows.

| Item | Decision |
| --- | --- |
| Where the state lives | CUE is state of a Live sync session only. It is not in the plan, is not saved and is not undone. The unit treats it the same way: CUE is in neither the settings file nor a scene, and it is gone at power off |
| What can be cued | A mono channel, a stereo channel, FX, MIX, STEREO and STREAMING. As on the unit, they fall into an input group (channels and FX) and an output group (STEREO, MIX, STREAMING), and cueing in one group clears the other |
| MIDI | CUE is a MIDI target. Outside Live sync every CUE is cleared and Clear CUE is removed; CUE cannot be pressed; assigning by learn is accepted and an assigned control does nothing. When Live sync starts, the unit's state replaces the app's |
| Graph | What is off the path is dimmed, and the nodes on the path (the input, the cued channel, the monitor) get a frame in the CUE colour. Only the monitor carries a "CUE" badge. A solid line in the CUE colour runs on top of everything from the cued channel to each monitor; it stops at the outer edge of the frames and does not enter them. The wire into a monitor that is being replaced is drawn as a faint dashed line, whether its source is STEREO or MIX. No node is added for the CUE bus |
| Inspector | A node that has CUE gets a CUE row (ON / OFF) under its Color row. It cannot be pressed outside Live sync, and a tooltip says why |
| CONSOLE | The CUE chip sits to the right of MUTE and lights only on what is cued. Only the strip of a MONITOR that is listening to the CUE bus gets a frame. There is no badge: that monitor's `C.INT` chip is painted in the CUE colour |
| Always-on display and clearing | While anything is cued, the right side of the status bar, left of the link statistics, shows the names of what is cued and "Clear CUE" |
| Colour | Dark `#84e3ff` (the colour of the unit's lit [CUE]), light `#0b7285`. The ink on it is what `inkOn()` picks (black on dark, white on light) |
| PNG and PDF export | The CUE display is left out |

The CONSOLE row was extended on 2026-11-14: a MONITOR strip whose monitor plays the CUE bus also
meters the CUE bus, inside a ring of its own. That decision is in [console.md](console.md), "The CUE bus
over the MONITOR strips".

**Closed while implementing.**

- **Cueing an output frames the cued output and the monitors only.** Framing the upstream as well
  was turned down: for STEREO it frames most of the board. The upstream is dimmed instead.
- **The line from STREAMING stays a loop.** STREAMING is in the same column as the monitors, so the
  line leaves to the right and comes back. When that is hard to read, placing the nodes is left to
  the person using the app.
- **The frame's margin on the graph is 7px.** The drawings for the design used 10px, and frames one
  row apart touched.
- **The mappings for the URX22 and the URX44 are registered as unverified** (`UNVERIFIED_MAPPINGS`,
  `cue-flags`).
- **The handling outside Live sync was settled a second time, on 2026-10-13.** The first instruction
  about MIDI could be read two ways. The operator then fixed the three points in the table: CUE
  cannot be pressed unless Live sync is on or a MIDI learn is in progress; going offline clears
  every CUE and removes Clear CUE; and at the start the unit's state replaces the app's.
- **A flag that a pair link copies to the partner is not modelled.** The code first copied it
  itself, on the assumption that the unit does not announce it; the unit does, so the copy was
  removed and the app follows the announcement.

**Why.** The unit changes CUE in several situations without announcing it, so the app applies the
group rules itself, and finding those rules took long. The display was closed by drawing the options
and comparing them. Reopening either repeats that work.

## Whether a scene recall drops CUE is left open

**Decision.** Whether a scene recall clears CUE on the unit is not looked into. A recall arrives as
a bulk frame without values, and [follow.ts](../../../src/core/control/follow.ts) raises that to a
full read. With the CUE flags in that read, the app ends up right whichever the unit does.

## The inspector row is repainted, not rebuilt

**Decision (#609, #610).** CUE is switched from the graph through a row in the inspector. Putting
the control on the node itself was not taken.

The row is repainted in place (`syncInspectorCue`), and so is the same row when Live sync starts.
The first version rebuilt the whole panel with `refreshInspector()` on every CUE change, and an
outside review returned two defects:

- A trailing space in a name that was being typed disappeared, because the plan holds the name
  normalized (`normalizeNodeName`).
- While a select had focus, the composition gate held the rebuild back and the CUE row stayed stale.

The rebuild at the end of a session lost the trailing space in the same way; that was already on
`main`. It was fixed in the same pull request: `rebuildInspector` carries the field's text over
only when it equals the plan's value after normalizing.

On the CONSOLE, the frame of the MONITOR strip was first an inset `box-shadow`. The divider lines of
the FADER / METER cells below are drawn over it and cut it, so the frame moved to an `::after` layer
above the strip's content.

## Options that were not taken

Each was drawn on the app's real screens and compared before the decision above. None is proposed
again.

**The CONSOLE chip's place.**

| Option | Where | What it cost |
| --- | --- | --- |
| K1 (taken) | The chip row, to the right of MUTE | The chips after it move one place. The head (292px) and the fader part (398px) keep their heights |
| K2 | Under the fader, above the values | The fader part shrinks from 398px to 369px |
| K3 | Inside the coloured heading, at the lower right of the name | No height changes; the chip is small |

The three were drawn with a frame on the cued channel's strip as well; the frame was then reduced to
the MONITOR strip. A "CUE" badge at the lower right of the MONITOR heading was adopted once and
replaced by painting the `C.INT` chip.

**Drawing the path on the graph.** The form taken is D, with the monitor badge of M1 and the frames
and top line of M5.

| Option | What it draws | Why not, or what it costs |
| --- | --- | --- |
| A — halo | A wide translucent band under the wires and a larger translucent face under the nodes | The halos of two neighbouring monitors run together |
| B — casing | A 6px line in the CUE colour under the path's wires, and a 2px frame on its nodes | The frame is the shape that selection and the path trace already use |
| C — dashes and badges | A dashed line in the CUE colour over the wires, and badges on the cued channel and the monitor | The dashes hide the wire's own colour |
| D — dim what is off the path | The same form as the path trace: wires at 0.16, nodes at 0.3, frames on the path | CUE lasts as long as it is on, so the rest of the board stays dim that long; it looks like the path trace |
| E — badges only | Badges, nothing on the wires | The board does not say which input is heard |

A, B and D were also drawn with the badges added.

**Showing that the monitor plays the CUE bus.** In all five the replaced wire into the monitor is a
faint dashed line.

| Option | What it draws |
| --- | --- |
| M1 (taken, for the badge) | A badge on the monitor. Where the CUE bus comes from is not drawn |
| M2 | A ring in the CUE colour around the monitor's input jack, with "CUE" beside it |
| M3 | The names of what is heard, written inside the monitor node |
| M4 | A thin dotted line from each cued channel to each monitor |
| M5 (taken, for the frames and the line) | Frames on the nodes of the path and a 2.5px solid line on top of everything. The line does not go round nodes, so it crosses other nodes' faces; it does not cover a name that can be read |

In M4 and M5 the number of lines is the number of cued channels times the number of monitors with
CUE Interrupt on.

**Where the always-on display goes.** The toolbar (to the right of the view switch) was turned down
because it is crowded. Inside the status bar, putting the CUE display at the far right was turned
down for the place left of the link statistics.

**The light theme's CUE colour.** Pass or fail is the WCAG 2.1 ratio: 3:1 for a mark against its
ground, 4.5:1 for text on a face. The ink is picked by APCA Lc with a floor of 60. ΔE is the
distance (CIE76) from the blue of a source-select wire.

| Option | Colour | Line and frame against canvas / node | Text against face | Lc of the text | Verdict | ΔE |
| --- | --- | --- | --- | --- | --- | --- |
| L1 | `#0a7ea4` | 3.62 / 4.04 | 4.63 | 77.1 | Passes with little room | 34.5 |
| L2 | `#0c8599` | 3.40 / 3.79 | 4.35 | 75.1 | Fails (text) | 46.5 |
| L3 (taken) | `#0b7285` | 4.36 / 4.87 | 5.59 | 82.8 | Passes | 45.3 |
| L4 | `#6741d9` | 4.92 / 5.50 | 6.30 | 85.8 | Passes | 48.1 |
| L5 | `#d6336c` | 3.61 / 4.03 | 4.62 | 76.1 | Passes with little room | 82.0 |
| L6 | line `#0b7285`, face `#84e3ff` | 4.36 / 4.87 | 13.41 | 81.8 | Fails (the face against its ground, 1.14) | 45.3 |
| L7 | `#32a1b5` | 2.38 / 2.66 | 3.04 | 62.3 | Fails (line, face and text) | 49.5 |

L1 was the provisional value. It is close in lightness to the blue of a source-select wire, so the
casing (B) and the dashes (C) were hard to tell from the wire. The dark theme's colour passes on
every count (12.92 against the canvas, 13.41 for the text, Lc 81.8).
