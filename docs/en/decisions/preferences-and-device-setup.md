# Decisions: Preferences and Device setup

> 日本語版: [../../ja/decisions/preferences-and-device-setup.md](../../ja/decisions/preferences-and-device-setup.md)

Closed decisions about the two settings modals: Preferences
([src/ui/prefs.ts](../../../src/ui/prefs.ts)) and Device setup
([src/ui/device-setup.ts](../../../src/ui/device-setup.ts)), with the licenses modal that opens from
Preferences. What they do is in [architecture.md](../architecture.md), "Preferences" and "Device
setup (the unit's SETUP > GENERAL)", and in [known-issues.md](../known-issues.md). This document
holds what was chosen over what. "The operator" below is the person who directs this project's work
and decides for it.

## Preferences

**Decisions.**

- **The scope setting is two separate items**: what goes to and from the device (one setting for
  both directions), and what a plan file saves. **Reading and writing are not given separate
  scopes.** The operator chose this after the risk was laid out: a parameter outside the read scope
  would enter the live snapshot at its default, and converging would overwrite the unit with it.
- **The entry is a gear icon of its own**, drawn as inline SVG and not as a text glyph. The name is
  Preferences, which keeps it apart from the settings file.
- **Changes apply at once**, and the only button is Close.
- **The diagnostics (compare, self-test, prepare) always cover everything**, whatever the scope. The
  sentence that says so is shown only in experimental mode.
- **Loading a scene-scope file merges**: values the file does not carry stay as they are, which is
  what a recall on the unit means. It is accepted for the same model only.
- **A row that does not apply is disabled, not hidden**, with a dashed "Desktop app only" pill on that
  row. The pill is not dimmed. In the demo build the application-version section hides "Check now"
  alone and still shows the version.
- **The recent-plans row is among the rows locked in the browser build.** It was not in the mock; it
  exists on the desktop only.
- **"Check now" does not close the modal.** The result appears beside the version. The modal closes
  only when an update is accepted, to move on to the download.
- **Closing is by a click outside or by Esc**, and Esc was added to the MIDI window to match.
  **While an update check is in flight every way of closing is locked** — Close is disabled and
  dimmed, a click outside and Esc do nothing, and a refresh is held — so the result always has
  somewhere to appear and repeated presses cannot stack. A timeout always releases the lock.
- **The licenses modal also closes on a click outside or Esc.** It shows information and is not a
  gate.
- **The three screens that are gates — consent, the load report and the rate choice — keep neither
  Esc nor a click outside.**
- **The title and Close are always visible.** The scroll is inside the grid. The application-version
  section is the last one.

Where the language and theme controls came from is in
[ui-design.md](ui-design.md), "Language and theme live in Preferences".

## The licenses modal draws its own DOM

**Decision.** The licenses are no longer shown in an iframe. [licenses.ts](../../../src/ui/licenses.ts)
parses the generated page and draws it as the app's own DOM, inserting text nodes only and releasing
them on close.

**Why.** A white band ran down the right edge of the modal. The code assumes that the desktop
webview keeps an unpainted scroll-bar gutter at the right of a sandboxed iframe, through which the
frame's background showed; the scroll bar that could not be grabbed, and the indicator that vanished
in the light theme, came from the same inner scroller. With one scroller, in the main frame, those
are gone, and the list follows the app's theme. A colour-scheme declaration on the frame did nothing
for the band.

**Turned down.** Opening every family expanded with a row of chips to jump between them. The list
opens folded, and its heading rows are the index: if the families fold, the chips are not needed.

## Computer sleep

**Decisions.**

- **What is held off is the system and the display.** Of the three options shown, "the system only"
  and "a three-way setting" were turned down. Only the idle timer is affected: closing the lid, or
  putting the computer to sleep by hand, still works.
- **It is held only during Live sync.** The operator gave two reasons, and they are closed:
  1. Security — if merely running the app kept the computer awake, the computer would never lock
     itself, since holding the display also stops the idle lock.
  2. The only situation that needs this is watching levels without touching anything.

  Holding it for as long as the app runs is not proposed again. Every way into and out of a session
  goes through the release, and nothing is acquired at start-up.
- **The setting is saved only after the OS accepts it.** This is the one setting the OS can refuse.
  Toggling it outside a session saves it and calls nothing; toggling it during a session applies it
  at once.
- **A refusal is written into the row's standing note.** Keeping it in a field and re-rendering was
  turned down: while an update check is in flight a refresh does nothing, and the report would
  disappear. The whole thing is one function in the app entry, handed to the modal as a hook, so the
  modal does not call the shell itself.

## Device setup

**Decisions.**

- **It is a modal.** A third view tab and a non-modal panel were turned down.
- **It opens from the bottom of the Device menu**, behind a separator.
- **Changes are applied together, and each operation connects for itself.** Writing each change at
  once was turned down: a slip would reach the unit immediately. The modal does not hold the link, so
  the other device actions need not be disabled while it is open.
- **It does not follow changes made on the unit.** A change on the unit's panel shows after the modal
  is opened again. Following would need the follower to know these addresses; as it is, registering
  them makes it treat them as unknown and escalate to a full read-back.
- **Since [#666](https://github.com/semnil/urx-router/pull/666) it also opens during Live sync** and
  then writes through the session. **"Apply to device" while offline stays** (2026-10-18): it is a write the
  person presses for explicitly, the same kind as "Write to device".
- **On a model that lacks an item, the item is disabled per menu, not hidden.**
- **There is no plate showing the model, the scene and the unit's time.** While the clock cannot be
  written, a read-only display of it means little. **This is reconsidered if a way to write the clock
  is found.**
- **There is no "Version" section and no "items on other screens" section.** Both can be checked
  elsewhere.
- **No note warns that shortening Auto Power Off may switch the unit off.**
- **The labels stay in English.** The Japanese user guide writes the menu and control names in
  English and only the explanations in Japanese. No provisional translation is given.

## Brightness goes down to 0

**Decision.** The lower bound of Brightness is 0. The unit holds 0, and at 0 its LCD stays just
readable. A lower bound of 1, with a note that 0 was unverified, was withdrawn at the operator's
word.

**What went wrong with the bound at 1.** The modal passes what it has just read through the coercion
to the allowed range. With the bound at 1, a unit at 0 was shown as 1; the baseline and the draft
were both 1, so nothing was written, and the screen misreported the unit without a sign. The first
reading of the defect — the slider alone clamps and the number stays 0 — was wrong, and a capture of
the real rendering showed it. Two cases in [device-setup.spec.ts](../../../e2e/device-setup.spec.ts)
pin the bound: a unit that reports 0 shows 0, and 0 can be applied to a unit that is brighter.
