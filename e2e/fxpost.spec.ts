import { test, expect, type Page } from "@playwright/test";

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const param = (page: Page, label: string) => page.locator("#inspector .param", { hasText: label });
const fxSelect = (page: Page) => param(page, "Post Fader Send").locator("select");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("FX bus offers a post-fader MIX source; default none", async ({ page }) => {
  await node(page, "bus.fx1").click();
  await expect(fxSelect(page).locator("option")).toHaveText(["—", "MIX 1", "MIX 2"]);
  await expect(fxSelect(page)).toHaveValue("-1"); // none
});

test("post-fader source round-trips through save and open", async ({ page }, testInfo) => {
  await node(page, "bus.fx2").click();
  await fxSelect(page).selectOption("2"); // MIX 2
  await page.click("#btn-file");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btn-save")]);
  const saved = testInfo.outputPath("plan.json");
  await download.saveAs(saved);
  await page.click("#btn-file");
  await page.click("#btn-new");
  await page.click("#btn-file");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#btn-open")]);
  await chooser.setFiles(saved);
  await node(page, "bus.fx2").click();
  await expect(fxSelect(page)).toHaveValue("2"); // restored from the saved plan
  // A fresh node still defaults to none, confirming the value came from the file.
  await node(page, "bus.fx1").click();
  await expect(fxSelect(page)).toHaveValue("-1");
});
