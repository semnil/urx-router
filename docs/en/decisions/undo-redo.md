# Decisions: undo and redo

> 日本語版: [../../ja/decisions/undo-redo.md](../../ja/decisions/undo-redo.md)

Closed decisions about undo and redo ([src/ui/history.ts](../../../src/ui/history.ts)). How it works
is in [architecture.md](../architecture.md), "Undo / redo", with its parts "What an entry is", "The
patch", "Refusals", "The macOS Edit menu" and "Keyboard bindings". This document holds what was
chosen, what was turned down, and what went wrong on the way. "The operator" below is the person who
directs this project's work and decides for it.

## What undo covers

**Decisions.**

- **The whole plan is covered**: parameters, wiring, and positions, hidden nodes, notes, names and
  colours. It is not narrowed to parameters.
- **Inside the app's own chrome the only entry is the keyboard.** An Edit menu in the toolbar is left
  for later, which is why `canUndo`, `canRedo`, `undo`, `redo` and `menu(kind)` are public and
  separate from the key handling.
- **A value that enters the plan because someone operated the unit is not put on the history.**
- **A value from the unit is absorbed into the baseline key by key (`absorb`). `rebase()` is for a
  read-back only.** `rebase()` drops the open entry and cancels the pending commit, so an edit made
  in the app while the unit is being touched would silently stop being undoable. The re-read and the
  direct notification both go through `absorb`. The MIDI site stopped calling `rebase()` in
  [#554](https://github.com/semnil/urx-router/pull/554), and a MIDI edit enters the history like any
  other.
- **`absorb` also folds the nested leaves of entries already recorded**
  ([#476](https://github.com/semnil/urx-router/pull/476)), on the condition that both the before and
  the after image hold the value the read was taken against. A version that tested the before image
  alone replaced the operator's own history values with the unit's; the pull request has the case.
- **Every path that writes the plan goes through `onChange`.** Building undo found two that did not:
  `setNote` and `openNoteEditor` in the graph wrote a note's fold state without calling it, so
  unfolding a note neither marked the plan changed nor wrote to the unit.

**Turned down.** Reusing the diffs that already existed. The one in the live layer works in the
unit's address space, where positions, notes and hidden nodes do not exist and the mapping cannot be
inverted; the one in the client reads the unit. Restoring a whole snapshot is ruled out in
architecture.md, "The patch".

## Gesture boundaries

When an entry closes differs by the kind of gesture; the table is in architecture.md, "What an entry
is".

**Turned down.** Flushing the delayed commit from inside `note()`. The edit funnels change the plan
first and call `markChanged()` after, so by the time of the flush the new edit is already in the plan
and the entry would take both.

## A drag is a press that moved

**Decision.** Undo is refused during a drag, and a drag is **a press followed by a pointer move**.

**Turned down.** A flag set on press. Selecting a wire on the graph, and the E2E, dispatch a
`pointerdown` with no `pointerup` to follow; the flag stayed set for good and every later undo was
refused. Filtering synthetic events by `isTrusted` was turned down as well: jsdom cannot make a
trusted event, so none of the boundary tests could then be checked.

## A press is tracked by its pointer id

Three pull requests settled how a press ends.

- **A press whose release never arrived is ended by a wheel or a mouse move with no button down only
  when a mouse started it** ([#568](https://github.com/semnil/urx-router/pull/568)). The first
  version ended any press that way, and review showed the harm with touch: while a finger dragged a
  node, turning the mouse wheel let an undo through, and the finger went on moving the node. Neither
  the wheel's buttons nor a mouse move's buttons say anything about a finger or a pen. The condition
  is written as `=== "mouse"`, not as "anything but touch and pen"; the operator set that.
- **A press is held per pointer id** ([#583](https://github.com/semnil/urx-router/pull/583); the
  operator chose among four options). The history, the tuning screens and the inspector's held
  repaint all end a press only on that pointer's own release, its own buttonless mouse move, or a
  blur or focus. With a single press state, a mouse click during a finger drag let an undo through
  and split the drag into two entries.
  **The cost is that a synthetic press with no release stays until a blur**, so `selectWire` and the
  hand-written wire selections in the E2E now send a `pointerup` as well. Leaving the helper as it
  was had every ordinary E2E case passing, and yet in a spec after `selectWire` two wheel steps fused
  into one entry even with a real click between them. A fully green run hid the reason for turning
  that option down.
- **The end of a drag is not tied to the end of the last press**
  ([#585](https://github.com/semnil/urx-router/pull/585)). With a finger resting on the screen, a
  mouse whose release never arrived kept dragging a cap or a plot on buttonless moves. A drag records
  the pointer that started it and ends on that pointer's release, whatever other pointers are down.
  Only the held repaint waits for the last pointer.

## The macOS Edit menu is the app's

**Decision.** The app builds the Edit menu's Undo and Redo itself. Two points were the operator's:

1. While a text field has focus, the menu items hand over to the field's own undo
   (`document.execCommand`).
2. The menu labels follow the app's language.

**Why not the default menu.** The code assumes that the default Undo and Redo items act on the
webview's own text undo without telling the page, and that the page can neither see nor prevent it.
An item cannot be greyed out either, so the choice was between removing the two items and wiring them
to the app.

**One thing the wiring needs.** The menu is told about a change of state only when the state really
changes (`notifyDepth()`). `note()` runs on every edit, dozens of times in one drag, and each
notification crosses to the native side.

## The key probe stays in dev builds

**Decision.** [keyprobe.ts](../../../src/ui/keyprobe.ts) is kept in the source for good, at the
operator's instruction, and is active in a dev build only. It answers questions that only the real
webview can — whether a chord reaches the page, whether the field's undo fires, what a click on a
native menu item does. Its key bindings are pinned by its own unit test.
