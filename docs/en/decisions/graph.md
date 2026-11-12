# Decisions: the node graph

> 日本語版: [../../ja/decisions/graph.md](../../ja/decisions/graph.md)

Closed decisions about the board that [src/ui/graph.ts](../../../src/ui/graph.ts) draws, and what
happened around them. How the board works is in [architecture.md](../architecture.md): "Node graph
rendering constraints", "Hiding nodes", "Hung nodes (ducker, microSD Rec slots)", "Column layout"
and "Node labels", with the path trace and the uniform OFF display described under "Data model".
This document holds the history those do not. "The operator" below is the person who directs this
project's work and decides for it.

## Two gestures on a node

**Decision.** A double click on a node edits its note, and a long press traces its path. The path
trace is **not** moved back to the double click.

**How it came to this.** The path trace was first on the double click, then moved to the long press,
and the double click then went back to note editing beside it. The two do not collide: the
double-press test runs before the drag is set up and returns, so a quick second press never arms
the long-press timer. The double press is detected by the board itself (`lastNodeClick`), because a
`pointerdown` that calls `preventDefault` suppresses the `dblclick` event. While the long press is
pending, a move shorter than `LONG_PRESS_TOLERANCE` is swallowed; without that the node, already
armed for dragging at the press, would start moving and the press would never complete.

## Ducker and state marks

- **The ducker's key source is a connection kind of its own, `key`.** It is not `source` and not
  `patch`. The aim is that it never matches the `kind === "source"` branches that mirror a pair's
  source on connect and remove the partner's on delete. Reusing `source` would have been a no-op
  only by the accident that a ducker is not in `channelPairs`.
- **One state is shown per node, the highest of three.** A node can be rate-disabled, inactive and
  unread at once. The three blocks are an exclusive chain in the order **rate-disabled, then muted,
  then unread**, and the frame guard in the selection highlight follows the same order. Before that,
  badges overlapped and a lower state's opacity could override a higher one's.
- **`isNodeInactive` is the one predicate for "this node is off".** A ducker keeps its ON / OFF in
  `duckerOn`, not in `on`, so the predicate branches on the kind; the CONSOLE shares it.

## Hiding

**Decision.** Any node can be put on the shelf, connected or not. The parent and child of a hung
node go and come back as one unit.

**What it replaced.** Hiding used to be refused for a node that had a connection, and forcing it had
been turned down by the operator. That was reversed: a wire with a hidden end is skipped when wires
are drawn, so nothing is left dangling, and the connection stays in the plan and comes back with the
node. Hiding is purely a matter of display. The gate and the predicates that served it were removed.

## Path trace

What the trace lights and why is in architecture.md and in
[#607](https://github.com/semnil/urx-router/pull/607) (merged 2026-10-13). Closed there:

- **A ducker is passed or not by where the signal is taken off**, not by a rule for CUE alone. The
  first decision was "leave out CUE only"; a review in another session replaced it with the tap
  position (`tapAheadOfDucker`), which follows the unit's block diagram.
- **An input wire into a muted channel is drawn as normal only while the channel still has a live
  direct out or key.** Turned down: always drawing it as normal, and leaving the display as it was.
- **A muted node on the path keeps its 0.4 dimming.** It is hard to tell from the 0.3 of a node off
  the path; the operator looked at it and accepted that. Turned down: showing the state by badge
  alone. Not proposed again.
- **A send into FX 2 above 96 kHz is off because `isOffSend` says so**, for the whole board. The
  trace has no test of its own for it.
- **The `live` predicate is required.** On this hardware every channel is wired to every bus at all
  times, so following sends that are off or at -∞ makes the closure the whole board.

**A report that was not a defect.** Tracing the STEREO bus left the input of a muted channel fully
lit. The path is correct: connecting a stereo input to a channel also gives the pair's partner a
source connection, and with one channel muted the partner still sends to the bus, so input →
partner → bus is a live path. The input fades only when both channels of the pair are muted. Two
E2E cases pin the two situations, and no production code changed.

## Aligning a STEREO pair and coming back from the shelf

The design is in architecture.md, "Hiding nodes". Five things were found by running it, and each
would come back if the code were written the obvious way.

1. **A stored offset drifts in floating point.** A drag captures `partner - primary` and adds it
   back from another base, so a pair that has not moved ends about 1e-13 px off its canonical
   value (4.68% of 200,000 samples). Testing positions for exact equality rewrites a pair that did
   not move, which is a write to the plan from outside the edit funnels. The test uses a sub-pixel
   tolerance.
2. **`repaintDirtyNodes` cannot draw the tie between a linked pair.** The tie is built only inside
   `renderNodes`, so a path that takes the fine-grained branch alone showed no tie after the link
   state changed, where a full refresh showed one. The full reflect is asked for when the **link
   state** moved, not when a coordinate moved.
3. **The offset that is written is not widened to clear a note.** Arrange repacks a whole column,
   and the snap moves two nodes only, so a widened offset lands on the node in the next row; two
   channels ended at the same `translate`. The written value stays the default offset, and "is it
   already in its slot" is tested as a band: at least the default offset, at most the upper node's
   row count.
4. **The shelf covers the bottom of the canvas, and it is always open when a node comes back.**
   Testing "is it shown" against the graph host passes a node that sits behind the shelf. At the
   minimum window and the largest zoom the usable area ended at y = 556 and the restored node began
   at y = 576. The lower bound is the top of the shelf.
5. **A hung node's position comes from its parent, so the node to bring into view is the one the
   chip named**, not `parentOf(id) ?? id`. Fitting the parent shows the parent, and the track slot
   that the chip, the status line and the inspector all name stays off screen (parent at 146–256,
   slot at 846–956, usable area 0–476).
