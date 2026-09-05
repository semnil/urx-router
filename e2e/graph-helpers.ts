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

/** A drawn wire's hit band, addressed by the refs it joins. */
export const wire = (page: Page, from: string, to: string): Locator =>
  page.locator(`.wire-hit[data-from="${from}"][data-to="${to}"]`);

/** Select a wire. `dispatchEvent` rather than a click because the hit bands
 *  overlap: a real press lands on whichever band is on top at that pixel, which
 *  is not necessarily the wire the test named. While nothing here named it, the
 *  ordinary tier had it written by hand in eighteen places across eight specs and
 *  forked into a named local four more times, comment and all.
 *
 *  Two other shapes are not this one and are left alone. Five locators over four
 *  specs (ducker, nodeoff twice, nodestate, pathtrace) reach the painted path
 *  THROUGH the hit band's attributes, which is a different element. And e2e/race
 *  still spells the selector out ten times over six files, three of those lines
 *  dispatching the gesture (two of them one pointerdown/pointerup site, which this
 *  helper does not do) — left for a change whose own checks can run that tier. */
export const selectWire = (page: Page, from: string, to: string): Promise<void> =>
  wire(page, from, to).dispatchEvent("pointerdown");

/** A node's own panel — the first rect in its group. Pointer geometry comes from
 *  here rather than the group's box, which also covers the Rec Point tap jack
 *  standing above the top edge. */
export const faceplate = (page: Page, id: string): Locator =>
  page.locator(`#graph-host g.node[data-id="${id}"]`).locator("rect").first();

/** The heart tie drawn between the two members of a STEREO-linked pair. Its glyph is the
 *  only thing that says the pair is tied on canvas, so a spec asserting the link — or its
 *  absence — addresses it here rather than spelling the glyph out again. */
export const stereoTie = (page: Page): Locator => page.locator("#graph-host text", { hasText: "♥" });

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

/** Hover the control's centre, then send one wheel notch there. */
export async function wheelOver(page: Page, target: Locator, deltaY: number): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error("target has no bounding box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
}
