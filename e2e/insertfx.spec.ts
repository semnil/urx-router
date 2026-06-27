import { test, expect, type Page } from "@playwright/test";

// Insert-FX effect editing: selecting an insert effect (guitar amp / pitch fix /
// compander / multi-band comp) reveals its parameter editor, and the values
// round-trip through save/open. Slots/encodings: core/control/insert-fx-effect.ts.

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const insertSelect = (page: Page) =>
  page.locator("#inspector .param", { hasText: "Insert FX" }).locator("select");
const paramSelect = (page: Page, label: string) =>
  page.locator("#inspector .param", { hasText: label }).locator("select");
const param = (page: Page, label: string) =>
  page.locator("#inspector .param", { hasText: label });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await page.locator("#model-picker").waitFor();
});

test("guitar amp (Clean) reveals common params + cabinet list", async ({ page }) => {
  await node(page, "ch1").click();
  await insertSelect(page).selectOption({ label: "Clean" });
  // Common params appear.
  await expect(param(page, "Treble")).toBeVisible();
  await expect(param(page, "Output")).toBeVisible();
  await expect(param(page, "Blend")).toBeVisible(); // Clean-only
  // SP Type lists the eight cabinets in order.
  await expect(paramSelect(page, "SP Type").locator("option")).toHaveText([
    "BS 4x12",
    "AC 2x12",
    "AC 1x12",
    "AC 4x10",
    "BC 2x12",
    "AM 4x12",
    "YC 4x12",
    "JC 2x12",
  ]);
});

test("switching guitar amp type swaps the type-specific control", async ({ page }) => {
  await node(page, "ch1").click();
  await insertSelect(page).selectOption({ label: "Clean" });
  await expect(param(page, "Blend")).toBeVisible();
  await insertSelect(page).selectOption({ label: "Drive" });
  await expect(param(page, "Blend")).toHaveCount(0);
  await expect(param(page, "Amp Type")).toBeVisible(); // Drive-only
  await expect(param(page, "Master")).toBeVisible();
});

test("compander on the STEREO master reveals dynamics params", async ({ page }) => {
  await node(page, "bus.stereo").click();
  await insertSelect(page).selectOption({ label: "Compander-H" });
  await expect(param(page, "Threshold")).toBeVisible();
  await expect(param(page, "Ratio")).toBeVisible();
  await expect(param(page, "Width")).toBeVisible();
});

test("multi-band comp on a MIX bus reveals three bands", async ({ page }) => {
  await node(page, "bus.mix1").click();
  await insertSelect(page).selectOption({ label: "M.Band Comp" });
  await expect(param(page, "LOW Threshold")).toBeVisible();
  await expect(param(page, "MID Threshold")).toBeVisible();
  await expect(param(page, "HIGH Threshold")).toBeVisible();
  await expect(param(page, "L-M XOVER")).toBeVisible();
});

test("pitch fix reveals key + scale keyboard", async ({ page }) => {
  await node(page, "ch1").click();
  await insertSelect(page).selectOption({ label: "Pitch Fix" });
  await expect(param(page, "Coarse")).toBeVisible();
  await expect(paramSelect(page, "Key").locator("option")).toHaveCount(12);
  await expect(param(page, "MIDI Control")).toBeVisible();
});

test("insert-fx param round-trips through save and open", async ({ page }, testInfo) => {
  await node(page, "ch1").click();
  await insertSelect(page).selectOption({ label: "Clean" });
  await paramSelect(page, "SP Type").selectOption({ label: "JC 2x12" });
  await expect(paramSelect(page, "SP Type")).toHaveValue("8");

  await page.click("#btn-file");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btn-save")]);
  const saved = testInfo.outputPath("plan.json");
  await download.saveAs(saved);

  await page.click("#btn-file");
  await page.click("#btn-new");
  await node(page, "ch1").click();
  await expect(insertSelect(page)).toHaveValue("-1"); // No Effect after reset

  await page.click("#btn-file");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#btn-open")]);
  await chooser.setFiles(saved);
  await node(page, "ch1").click();
  await expect(insertSelect(page)).toHaveValue("256"); // Clean
  await expect(paramSelect(page, "SP Type")).toHaveValue("8"); // JC 2x12
});
