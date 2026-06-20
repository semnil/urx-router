import { test, expect, type Page } from "@playwright/test";

// A node is a g.node carrying its id; its faceplate label is the first <text>.
const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const nameInput = (page: Page) => page.locator("#inspector input[type='text']");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("the name field sets the device name; the canvas shows it only in device-name mode", async ({ page }) => {
  await node(page, "ch1").click();
  await expect(nameInput(page)).toHaveCount(1);

  await nameInput(page).fill("VocalMic");
  // Default (model) mode keeps the planner label, even with a device name set.
  await expect(node(page, "ch1").locator("text").first()).toHaveText("CH 1");

  // Switching the labels toggle to device names reveals the entered name.
  await page.locator("#btn-labels").click();
  await expect(node(page, "ch1").locator("text").first()).toHaveText("VocalMic");

  // Clearing the name falls back to the model's default label in either mode.
  await nameInput(page).fill("");
  await expect(node(page, "ch1").locator("text").first()).toHaveText("CH 1");
});

test("the labels toggle defaults to model labels and flips both ways", async ({ page }) => {
  await node(page, "ch1").click();
  await nameInput(page).fill("VocalMic");
  const labels = page.locator("#btn-labels");
  await expect(labels).toHaveAttribute("aria-pressed", "false");
  await expect(node(page, "ch1").locator("text").first()).toHaveText("CH 1");

  await labels.click();
  await expect(labels).toHaveAttribute("aria-pressed", "true");
  await expect(node(page, "ch1").locator("text").first()).toHaveText("VocalMic");

  await labels.click();
  await expect(labels).toHaveAttribute("aria-pressed", "false");
  await expect(node(page, "ch1").locator("text").first()).toHaveText("CH 1");
});

test("inputs and outputs carry no name field; only channels and buses do", async ({ page }) => {
  await node(page, "bus.stereo").click();
  await expect(nameInput(page)).toHaveCount(1);

  await node(page, "in.micline_1_2").click();
  await expect(nameInput(page)).toHaveCount(0);
});

test("a color swatch adds a top accent cap; re-clicking it clears the cap", async ({ page }) => {
  await node(page, "ch1").click();
  // Swatch 0 is the "none" clear; swatch 1 is the first color.
  const cap = node(page, "ch1").locator('rect[height="3"]');
  await expect(cap).toHaveCount(0);

  await page.locator("#inspector .swatch").nth(1).click();
  await expect(cap).toHaveCount(1);

  // Re-clicking the active swatch toggles the color off.
  await page.locator("#inspector .swatch").nth(1).click();
  await expect(cap).toHaveCount(0);
});

test("name and color round-trip through save and open", async ({ page }, testInfo) => {
  // Show device names on the canvas so the saved/restored name is visible there.
  await page.locator("#btn-labels").click();
  await node(page, "ch1").click();
  await nameInput(page).fill("VocalMic");
  await page.locator("#inspector .swatch").nth(1).click();
  await expect(node(page, "ch1").locator("text").first()).toHaveText("VocalMic");
  await expect(node(page, "ch1").locator('rect[height="3"]')).toHaveCount(1);

  await page.click("#btn-file");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#btn-save"),
  ]);
  const saved = testInfo.outputPath("URX44V-plan.json");
  await download.saveAs(saved);

  await page.click("#btn-file");
  await page.click("#btn-new");
  await expect(node(page, "ch1").locator("text").first()).toHaveText("CH 1");
  await expect(node(page, "ch1").locator('rect[height="3"]')).toHaveCount(0);

  await page.click("#btn-file");
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.click("#btn-open"),
  ]);
  await chooser.setFiles(saved);
  await expect(node(page, "ch1").locator("text").first()).toHaveText("VocalMic");
  await expect(node(page, "ch1").locator('rect[height="3"]')).toHaveCount(1);
});
