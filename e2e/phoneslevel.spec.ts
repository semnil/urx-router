import { test, expect, type Page } from "@playwright/test";

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const param = (page: Page, label: string) => page.locator("#inspector .param", { hasText: label });
const phonesSlider = (page: Page) => param(page, "PHONES Level").locator("input[type=range]");
const phonesValue = (page: Page) => param(page, "PHONES Level").locator(".param-val");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("monitor buses show a PHONES Level control (0.0-10.0, default 2.0)", async ({ page }) => {
  for (const id of ["bus.mon1", "bus.mon2"]) {
    await node(page, id).click();
    await expect(param(page, "PHONES Level")).toHaveCount(1);
    const slider = phonesSlider(page);
    await expect(slider).toHaveAttribute("min", "0");
    await expect(slider).toHaveAttribute("max", "10");
    await expect(phonesValue(page)).toHaveText("2.0"); // factory default
  }
});

test("PHONES Level edit persists after reselecting the monitor bus", async ({ page }) => {
  await node(page, "bus.mon1").click();
  await phonesSlider(page).fill("10");
  await expect(phonesValue(page)).toHaveText("10.0");

  await node(page, "bus.mon2").click();
  await node(page, "bus.mon1").click();
  await expect(phonesValue(page)).toHaveText("10.0");
});
