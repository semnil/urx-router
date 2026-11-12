# Decisions: the CONSOLE

> 日本語版: [../../ja/decisions/console.md](../../ja/decisions/console.md)

Closed decisions about the CONSOLE view, and what happened around them. How the view works is in
[console-sends.md](../console-sends.md) and in [architecture.md](../architecture.md) "CONSOLE view
(mixer-style level overview)"; this document holds the history those do not. "The operator" below
is the person who directs this project's work and decides for it.

## Controls a rate ceiling stops were still live on the CONSOLE

**What happened (2026-08-29).** The three warnings at the top of the inspector named the ceiling a
sample rate puts on the unit, and on the strips the controls under that ceiling could still be
operated. The operator pointed it out, and a pass over the view found four places:

- the INS FX face carried a tooltip and nothing else;
- the disclosure beside it was fully live;
- the three controls of an `F2` send column wrote to a bus the unit was not running;
- no CSS rule existed for `.con-sl.readonly`. The class and `aria-disabled` were set, so the
  control was off to a screen reader and looked live to the eye.

**Decision.** The treatment is the one in console-sends.md, "What a rate ceiling does to a
control" and "A column whose bus the rate has taken away": a face stays and goes read-only with
its reason, and a disclosure the ceiling has emptied is not drawn. One predicate,
`nodeRateDisabled`, serves the graph's `disabledNodes` and the CONSOLE. They had been separate,
and that is how the graph came to dim a node whose sends the CONSOLE still offered.

**How the width is tested.** Dropping a disclosure once changed the width of the face beside it.
A test of the rendered geometry does not catch that: with the hidden placeholder in the row, a
face that grows lands on the same width as one that declares its width. The test reads the
declaration instead, the face's `flex-grow` and `flex-basis` (`e2e/ratewarning.spec.ts`).
