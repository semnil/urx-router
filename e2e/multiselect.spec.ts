import { test, expect, type Page } from "@playwright/test";

// Ctrl/Cmd-click multi-selects nodes; the floating action bar then batch-shelves
// the shelvable ones. The app reads ctrlKey || metaKey, so Control works on every
// platform under test.
const nodes = (page: Page) => page.locator("#graph-host g.node");
const chips = (page: Page) => page.locator(".hidden-shelf .chip");
const bar = (page: Page) => page.locator(".sel-bar");
const port = (page: Page, ref: string) => page.locator(`[data-ref="${ref}"]`);

async function ctrlClick(page: Page, id: string): Promise<void> {
  await page.locator(`g.node[data-id="${id}"]`).click({ modifiers: ["Control"] });
}

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
    // Pin an empty starting board so the factory-seed sends do not perturb counts.
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("the action bar appears only once two nodes are selected", async ({ page }) => {
  await expect(bar(page)).toBeHidden();

  // One node selected is still a single selection: no bar, inspector handles it.
  await ctrlClick(page, "in.aux");
  await expect(bar(page)).toBeHidden();

  await ctrlClick(page, "in.micline_1_2");
  await expect(bar(page)).toBeVisible();
  await expect(page.locator(".selbar-count")).toHaveText("2");
  await expect(page.locator(".selbar-hide")).toHaveText("Hide 2");
});

test("hide selected shelves the whole selection", async ({ page }) => {
  const total = await nodes(page).count();
  await ctrlClick(page, "in.aux");
  await ctrlClick(page, "in.micline_1_2");

  await page.click(".selbar-hide");

  await expect(bar(page)).toBeHidden();
  await expect(nodes(page)).toHaveCount(total - 2);
  await expect(chips(page)).toHaveCount(2);
  await expect(page.locator("#statusbar")).toHaveText("Hid 2 nodes");
});

test("a connected node in the selection shelves with its wire", async ({ page }) => {
  // micline_1_2 carries an editable wire; shelving it takes the wire off-canvas.
  await connect(page, "in.micline_1_2:out", "ch_5_6:in");
  const total = await nodes(page).count();

  await ctrlClick(page, "in.micline_1_2");
  await ctrlClick(page, "in.aux");
  await expect(page.locator(".selbar-count")).toHaveText("2");
  // Every selected node is hidable now.
  await expect(page.locator(".selbar-hide")).toHaveText("Hide 2");

  await page.click(".selbar-hide");

  await expect(nodes(page)).toHaveCount(total - 2);
  await expect(chips(page)).toHaveCount(2);
  await expect(page.locator("#statusbar")).toHaveText("Hid 2 nodes");
});

test("ctrl-clicking a selected node drops it from the selection", async ({ page }) => {
  await ctrlClick(page, "in.aux");
  await ctrlClick(page, "in.micline_1_2");
  await expect(page.locator(".selbar-count")).toHaveText("2");

  // Toggling one back off falls under two nodes, so the bar disappears.
  await ctrlClick(page, "in.micline_1_2");
  await expect(bar(page)).toBeHidden();
});

test("clear and Escape both dismiss the selection", async ({ page }) => {
  await ctrlClick(page, "in.aux");
  await ctrlClick(page, "in.micline_1_2");
  await page.click(".selbar-clear");
  await expect(bar(page)).toBeHidden();

  await ctrlClick(page, "in.aux");
  await ctrlClick(page, "in.micline_1_2");
  await expect(bar(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(bar(page)).toBeHidden();
});
