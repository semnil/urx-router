import { test, expect, type Page } from "@playwright/test";

// Long-pressing a node traces the live signal path feeding it: every upstream
// input / channel / bus reached through live wiring lights up, the rest fade.
const port = (page: Page, ref: string) => page.locator(`[data-ref="${ref}"]`);
const node = (page: Page, id: string) => page.locator(`g.node[data-id="${id}"]`);

// Press and hold a node past the long-press threshold (450ms), then release.
async function longPress(page: Page, id: string): Promise<void> {
  const box = await node(page, id).boundingBox();
  if (!box) throw new Error(`node not found: ${id}`);
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.waitForTimeout(550);
  await page.mouse.up();
}
// The visible wire (not the transparent hit band, not the halo) for a route: the
// last path inside the wire's group, after any lit-state halo.
const wire = (page: Page, from: string, to: string) =>
  page.locator(`#graph-host g:has(> path.wire-hit[data-from="${from}"][data-to="${to}"]) > path:not(.wire-hit)`).last();

async function connect(page: Page, fromRef: string, toRef: string): Promise<void> {
  const a = await port(page, fromRef).boundingBox();
  const b = await port(page, toRef).boundingBox();
  if (!a || !b) throw new Error(`port not found: ${fromRef} -> ${toRef}`);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    // Empty board so only the wires this test draws are present.
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("long-pressing a leaf input reports no upstream path", async ({ page }) => {
  await longPress(page, "in.aux");
  await expect(page.locator("#statusbar")).toHaveText(/No live signal path feeds/);
});

test("long-pressing a node lights its path and fades the rest", async ({ page }) => {
  await connect(page, "in.micline_1_2:out", "ch1:in");
  await connect(page, "in.aux:out", "ch_5_6:in");

  await longPress(page, "ch1");

  // The traced node plus its one upstream input.
  await expect(page.locator("#statusbar")).toHaveText(/Tracing the signal path into .+ — 2 nodes/);
  // The path wire stays full; the unrelated source wire fades back.
  await expect(wire(page, "in.micline_1_2:out", "ch1:in")).toHaveAttribute("opacity", "1");
  await expect(wire(page, "in.aux:out", "ch_5_6:in")).toHaveAttribute("opacity", "0.16");
  // Nodes follow the same lit / faded split: the path nodes stay full, off-path
  // nodes fade back.
  await expect(node(page, "ch1")).toHaveAttribute("opacity", "1");
  await expect(node(page, "in.micline_1_2")).toHaveAttribute("opacity", "1");
  await expect(node(page, "in.aux")).toHaveAttribute("opacity", "0.3");
});

test("a path trace clears when the selection is dropped", async ({ page }) => {
  await connect(page, "in.micline_1_2:out", "ch1:in");
  await connect(page, "in.aux:out", "ch_5_6:in");
  await longPress(page, "ch1");
  await expect(wire(page, "in.aux:out", "ch_5_6:in")).toHaveAttribute("opacity", "0.16");

  // Escape drops the selection and the trace with it, so every wire and node
  // returns to its normal opacity.
  await page.keyboard.press("Escape");
  await expect(wire(page, "in.aux:out", "ch_5_6:in")).toHaveAttribute("opacity", "0.85");
  await expect(node(page, "in.aux")).toHaveAttribute("opacity", "1");
});
