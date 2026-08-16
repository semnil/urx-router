// Addressing a channel-tuning screen from an E2E spec. Two specs drive these screens —
// `dyntuning.spec.ts` for GATE / COMP / EQ / DUCKER and `ssmcs.spec.ts` for the morphing
// bank — and what they share is the plot, which is a control rather than only a picture.

import type { Page } from "@playwright/test";

/** The screen's own box. */
export const screenBox = (page: Page) => page.locator("#dyn-screen-box");

/** The panel's height. Shared across the specs, so two cases asserting that a bank holds
 *  one height cannot end up measuring different boxes and both passing. Read strictly: a
 *  `boundingBox()?.height ?? 0` would compare 0 to 0 — and pass — if the box ever stopped
 *  resolving, which is what these cases exist to catch. */
export const panelHeight = (page: Page) => screenBox(page).evaluate((el) => el.getBoundingClientRect().height);

/** The response plot, where it takes a press. It is one focus stop, so it carries the
 *  arrow keys as well as the click. */
export const pickPlot = (page: Page) => screenBox(page).locator("canvas.gt-pickplot");

/**
 * Select a band by its index in the descriptor's own order.
 *
 * The markers ON the plot are the band control on both EQ screens; there is no bar. The
 * keyboard path is taken rather than a click because a click has to land on a marker, and
 * only the descriptor knows where it drew one — a spec computing that would be a second
 * copy of the layout. `Home` first, so the walk starts from a known band whatever was
 * selected before.
 *
 * The canvas is replaced on every selection (the column rebuilds), but the host puts focus
 * back on the new one carrying the same id, so the presses keep landing.
 */
export const pickBand = async (page: Page, index: number): Promise<void> => {
  await pickPlot(page).focus();
  await page.keyboard.press("Home");
  for (let i = 0; i < index; i++) await page.keyboard.press("ArrowRight");
};
