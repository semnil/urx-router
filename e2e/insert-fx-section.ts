// The Inspector's Insert FX section, and opening it — shared by every tier.
//
// The section FOLDS with its own ON state, so a node holding nothing, or holding a bypassed
// effect, ships with it closed and the controls inside are then not focusable at all. A spec
// that reaches for the selector without opening it first gets "no such control" rather than
// "the control is not visible", which reads in a failure as the feature being gone.
//
// It imports a TYPE only, for the same reason `choose-option.ts` does: the ordinary tier
// takes its `expect` from `e2e/fixtures.ts` so the coverage reporter can collect, and the
// race tier takes the bare one. A module both tiers import must bind neither.
import type { Locator, Page } from "@playwright/test";

/** The section itself, found by its heading rather than by position: it is one of several
 *  `details.insp-section` and the order they appear in is the panel's business. */
export const insertFxSection = (page: Page): Locator =>
  page
    .locator("#inspector details.insp-section")
    .filter({ has: page.locator(".sec-title", { hasText: /^Insert FX$/ }) });

/** Open it if it is folded. Every case that reads or writes the effect type goes through
 *  here. */
export async function openInsertFxSection(page: Page): Promise<void> {
  const sec = insertFxSection(page);
  if (!(await sec.evaluate((d) => (d as HTMLDetailsElement).open))) await sec.locator("summary").click();
}
