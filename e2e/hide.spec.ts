import { test, expect, type Page } from "@playwright/test";

// One .wire-hit band exists per committed connection (the painted path is a sibling).
const wires = (page: Page) => page.locator("#graph-host .wire-hit");
// Fixed CH / FX-return -> STEREO wires are seeded on every plan (URX44V startup).
// They are skipped when an endpoint is shelved, so hiding unused nodes leaves
// only the user wires whose endpoints stay on the canvas.
const FIXED = 10;
const nodes = (page: Page) => page.locator("#graph-host g.node");
const chips = (page: Page) => page.locator(".hidden-shelf .chip");
const port = (page: Page, ref: string) => page.locator(`[data-ref="${ref}"]`);

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

test("Hide unused shelves every unconnected node, keeping wired ones", async ({ page }) => {
  const total = await nodes(page).count();
  await connect(page, "in.micline_1_2:out", "ch_5_6:in");
  await expect(wires(page)).toHaveCount(FIXED + 1);
  await expect(page.locator(".hidden-shelf")).toBeHidden();

  await page.click("#btn-hide-unused");

  await expect(page.locator(".hidden-shelf")).toBeVisible();
  // Only the two wired endpoints stay on the canvas; channels carrying just a
  // fixed STEREO wire count as unused and are shelved with their fixed wire.
  await expect(nodes(page)).toHaveCount(2);
  // A ducker hidden under an also-hidden channel folds into that channel's chip,
  // so the 3 shelved stereo channels (CH 7/8, 9/10, 11/12) hide their duckers'
  // chips; the CH 5/6 ducker keeps its own chip (its CH 5/6 stays on the canvas).
  const folded = 3;
  await expect(chips(page)).toHaveCount(total - 2 - folded);
  await expect(page.locator(".shelf-count")).toHaveText(String(total - 2 - folded));
  await expect(page.locator("#statusbar")).toContainText("unused node");
  // Only the user wire survives; fixed wires to shelved endpoints are hidden too.
  await expect(wires(page)).toHaveCount(1);
});

test("a shelf chip restores its node and selects it", async ({ page }) => {
  await connect(page, "in.micline_1_2:out", "ch_5_6:in");
  await page.click("#btn-hide-unused");
  const hiddenBefore = await chips(page).count();

  await chips(page).first().click();

  await expect(nodes(page)).toHaveCount(3);
  await expect(chips(page)).toHaveCount(hiddenBefore - 1);
  await expect(page.locator("#statusbar")).toContainText("Showing");
  // Restored node is unconnected, so the inspector offers to hide it again.
  await expect(page.locator("#inspector button.subtle")).toBeVisible();
});

test("Show all empties the shelf and brings every node back", async ({ page }) => {
  const total = await nodes(page).count();
  await connect(page, "in.micline_1_2:out", "ch_5_6:in");
  await page.click("#btn-hide-unused");
  await expect(nodes(page)).toHaveCount(2);

  await page.click(".shelf-showall");

  await expect(page.locator(".hidden-shelf")).toBeHidden();
  await expect(nodes(page)).toHaveCount(total);
  await expect(page.locator("#statusbar")).toHaveText("Showing all nodes");
});

test("inspector hides a selected unconnected node", async ({ page }) => {
  const total = await nodes(page).count();
  await page.locator('g.node[data-id="in.aux"]').click();
  const hideBtn = page.locator("#inspector button.subtle");
  await expect(hideBtn).toHaveText("Hide this node");

  await hideBtn.click();

  await expect(nodes(page)).toHaveCount(total - 1);
  await expect(chips(page)).toHaveCount(1);
  await expect(page.locator("#statusbar")).toContainText("Hid");
});

test("hidden state round-trips through save and open", async ({ page }, testInfo) => {
  await connect(page, "in.micline_1_2:out", "ch_5_6:in");
  await page.click("#btn-hide-unused");
  const hiddenCount = await chips(page).count();

  await page.click("#btn-file");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btn-save")]);
  const saved = testInfo.outputPath("URX44V-plan.json");
  await download.saveAs(saved);

  await page.click("#btn-file");
  await page.click("#btn-new");
  await expect(page.locator(".hidden-shelf")).toBeHidden();

  await page.click("#btn-file");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#btn-open")]);
  await chooser.setFiles(saved);

  await expect(page.locator(".hidden-shelf")).toBeVisible();
  await expect(chips(page)).toHaveCount(hiddenCount);
  await expect(nodes(page)).toHaveCount(2);
});
