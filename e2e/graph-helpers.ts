import type { Locator, Page } from "@playwright/test";

// Locators and gestures shared by the node-graph specs. Most specs still define
// their own one-line `port` / `node` locators (the house style); what lives here
// is the geometry that depends on how the canvas is actually built, so a change
// to the graph is answered in one place instead of in every spec that measures it.

/** A port's clickable target, addressed by its plan ref (`ch1:out`). */
export const port = (page: Page, ref: string): Locator => page.locator(`[data-ref="${ref}"]`);

/** A channel's Rec Point tap. It carries the same `ch:out` ref as the right-edge
 *  output, so it is addressed by data-tap — giving one ref two elements would break
 *  every `[data-ref]` locator under Playwright's strict mode. */
export const tapJack = (page: Page, ref: string): Locator => page.locator(`[data-tap="${ref}"]`);

/** A node's own panel — the first rect in its group. Pointer geometry comes from
 *  here rather than the group's box, which also covers the Rec Point tap jack
 *  standing above the top edge. */
export const faceplate = (page: Page, id: string): Locator =>
  page.locator(`#graph-host g.node[data-id="${id}"]`).locator("rect").first();

/** Press one jack and release over another, committing a connection. */
export async function drag(page: Page, from: Locator, to: Locator): Promise<void> {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error("jack not found");
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}
