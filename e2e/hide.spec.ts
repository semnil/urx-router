import { test, expect, type Page } from "@playwright/test";

// One .wire-hit band exists per committed connection (the painted path is a sibling).
const wires = (page: Page) => page.locator("#graph-host .wire-hit");
// Fixed wires are seeded on every plan (URX44V startup): every CH / FX-channel send
// is fixed now (STEREO main paths plus every CH/FX → MIX/FX send). They are skipped
// when an endpoint is shelved, so hiding unused nodes leaves only the user wires
// whose endpoints stay on the canvas.
const FIXED = 48;
// "Hide unused" now shelves only zero-wire nodes, and every channel/bus carries a
// fixed send. So on an empty URX44V board all 8 channels + 5 buses (STEREO, MIX 1/2,
// FX 1/2) stay wired; adding one user wire keeps its source node too — 14 in all.
const WIRED = 14;
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

test("Hide unused shelves only zero-wire nodes, keeping every wired node", async ({ page }) => {
  await connect(page, "in.micline_1_2:out", "ch_5_6:in");
  await expect(wires(page)).toHaveCount(FIXED + 1);
  await expect(page.locator(".hidden-shelf")).toBeHidden();

  await page.click("#btn-view");
  await page.click("#btn-hide-unused");

  await expect(page.locator(".hidden-shelf")).toBeVisible();
  // Every channel and bus carries fixed sends, so they all stay; only nodes with no
  // wires at all (spare inputs/outputs, OSC, streaming/monitor, duckers) are shelved.
  await expect(nodes(page)).toHaveCount(WIRED);
  await expect(page.locator("#statusbar")).toContainText("unused node");
  // No fixed-wire endpoint was hidden, so every fixed wire and the user wire survive.
  await expect(wires(page)).toHaveCount(FIXED + 1);
});

test("a shelf chip restores its node and selects it", async ({ page }) => {
  await connect(page, "in.micline_1_2:out", "ch_5_6:in");
  await page.click("#btn-view");
  await page.click("#btn-hide-unused");
  const hiddenBefore = await chips(page).count();

  await chips(page).first().click();

  await expect(nodes(page)).toHaveCount(WIRED + 1);
  await expect(chips(page)).toHaveCount(hiddenBefore - 1);
  await expect(page.locator("#statusbar")).toContainText("Showing");
  // Restored node is unconnected, so the inspector offers to hide it again.
  await expect(page.locator("#inspector button.subtle")).toBeVisible();
});

test("Show all empties the shelf and brings every node back", async ({ page }) => {
  const total = await nodes(page).count();
  await connect(page, "in.micline_1_2:out", "ch_5_6:in");
  await page.click("#btn-view");
  await page.click("#btn-hide-unused");
  await expect(nodes(page)).toHaveCount(WIRED);

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
  await page.click("#btn-view");
  await page.click("#btn-hide-unused");
  const hiddenCount = await chips(page).count();

  await page.click("#btn-file");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btn-save")]);
  const saved = testInfo.outputPath("URX44V-plan.json");
  await download.saveAs(saved);

  // Clear the shelf (New now restores the persisted hidden layout, so use Show all
  // to get an empty board) and prove opening the file overrides the current state.
  await page.click(".shelf-showall");
  await expect(page.locator(".hidden-shelf")).toBeHidden();

  // Show all leaves the plan dirty, so Open prompts to discard first; accept it.
  page.once("dialog", (d) => void d.accept());
  await page.click("#btn-file");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#btn-open")]);
  await chooser.setFiles(saved);

  await expect(page.locator(".hidden-shelf")).toBeVisible();
  await expect(chips(page)).toHaveCount(hiddenCount);
  await expect(nodes(page)).toHaveCount(WIRED);
});

test("hidden state survives a reload via localStorage", async ({ page }) => {
  await connect(page, "in.micline_1_2:out", "ch_5_6:in");
  await page.click("#btn-view");
  await page.click("#btn-hide-unused");
  const hiddenCount = await chips(page).count();
  expect(hiddenCount).toBeGreaterThan(0);

  // No save/open: a plain reload must restore the shelf from localStorage so the
  // live device-control workflow keeps its canvas layout across an app restart.
  await page.reload();
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");

  await expect(page.locator(".hidden-shelf")).toBeVisible();
  await expect(chips(page)).toHaveCount(hiddenCount);
});
