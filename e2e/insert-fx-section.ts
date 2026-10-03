// The Inspector's Insert FX section, and opening it — shared by every tier.
//
// The section FOLDS with its own ON state, so a node holding nothing, or holding a bypassed
// effect, ships with it closed and the controls inside are then not rendered or focusable.
// `chooseOption` refuses a select it cannot reach, so a spec that picks the effect type
// without opening the section first fails there.
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

/** Open it if it is folded, and throw if the summary's click left it closed. */
export async function openInsertFxSection(page: Page): Promise<void> {
  const sec = insertFxSection(page);
  const isOpen = (): Promise<boolean> => sec.evaluate((d) => (d as HTMLDetailsElement).open);
  if (await isOpen()) return;
  await sec.locator("summary").click();
  if (!(await isOpen())) throw new Error("openInsertFxSection: the summary's click left the section closed");
}
