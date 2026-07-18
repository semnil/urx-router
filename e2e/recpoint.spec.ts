import { test, expect, type Page } from "@playwright/test";

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const recSelect = (page: Page) => page.locator("#inspector .param", { hasText: "Rec Point" }).locator("select");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await page.locator("#model-picker").waitFor();
});

test("mono channel offers five rec points; default PRE FADER", async ({ page }) => {
  await node(page, "ch1").click();
  await expect(recSelect(page).locator("option")).toHaveText([
    "PRE GATE",
    "PRE COMP",
    "PRE EQ",
    "PRE INS FX",
    "PRE FADER",
  ]);
  await expect(recSelect(page)).toHaveValue("4"); // PRE FADER
});

test("stereo channel offers only PRE EQ and PRE FADER", async ({ page }) => {
  await node(page, "ch_5_6").click();
  await expect(recSelect(page).locator("option")).toHaveText(["PRE EQ", "PRE FADER"]);
  await expect(recSelect(page)).toHaveValue("4");
});

test("SSMCS drops PRE EQ and moves a PRE EQ tap to PRE COMP", async ({ page }) => {
  // The device has no discrete EQ stage in SSMCS mode: the Rec Point list drops
  // PRE EQ, and switching to SSMCS with PRE EQ selected lands on PRE COMP.
  await node(page, "ch1").click();
  await recSelect(page).selectOption("2"); // PRE EQ
  const typeSelect = page.locator("#inspector .param", { hasText: "COMP/EQ Type" }).locator("select");
  await typeSelect.selectOption("1"); // SSMCS
  await expect(recSelect(page).locator("option")).toHaveText(["PRE GATE", "PRE COMP", "PRE INS FX", "PRE FADER"]);
  await expect(recSelect(page)).toHaveValue("1"); // PRE COMP
  // Back to COMP->EQ: PRE EQ reappears but the tap stays where the device left it.
  await typeSelect.selectOption("0");
  await expect(recSelect(page).locator("option")).toHaveCount(5);
  await expect(recSelect(page)).toHaveValue("1");
});

test("rec point round-trips through save and open", async ({ page }, testInfo) => {
  await node(page, "ch1").click();
  await recSelect(page).selectOption("2"); // PRE EQ
  await page.click("#btn-file");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btn-save")]);
  const saved = testInfo.outputPath("plan.json");
  await download.saveAs(saved);
  await page.click("#btn-file");
  await page.click("#btn-new");
  await node(page, "ch1").click();
  await expect(recSelect(page)).toHaveValue("4");
  await page.click("#btn-file");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#btn-open")]);
  await chooser.setFiles(saved);
  await node(page, "ch1").click();
  await expect(recSelect(page)).toHaveValue("2");
});
