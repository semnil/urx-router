import { test, expect, type Page } from "@playwright/test";

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const param = (page: Page, label: string) => page.locator("#inspector .param", { hasText: label });
const frameRateSelect = (page: Page) => param(page, "Frame rate").locator("select");
// The DELAY on/off toggle, scoped to the STREAMING DELAY section so its "DELAY"
// label is not confused with the "Delay Time" slider row.
const delaySection = (page: Page) => page.locator("#inspector details.insp-section", { hasText: "Frame rate" });
const delayToggle = (page: Page) => delaySection(page).locator(".param", { hasText: "DELAY" }).first();

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("streaming bus shows the DELAY section with frame rate, toggle and time", async ({ page }) => {
  await node(page, "bus.stream").click();
  await expect(frameRateSelect(page).locator("option")).toHaveText([
    "24",
    "25",
    "29.97D",
    "29.97",
    "30D",
    "30",
    "60",
    "120",
  ]);
  await expect(frameRateSelect(page)).toHaveValue("5"); // 30 fps, the device default
  await expect(param(page, "Delay Time")).toHaveCount(1);
  await expect(param(page, "Delay Time").locator("input[type=range]")).toHaveCount(1);
});

test("DELAY settings persist after reselecting the streaming bus", async ({ page }) => {
  await node(page, "bus.stream").click();
  await frameRateSelect(page).selectOption("7"); // 120 fps
  await delayToggle(page).locator("button", { hasText: "ON" }).click();

  await node(page, "bus.stereo").click();
  await node(page, "bus.stream").click();
  await expect(frameRateSelect(page)).toHaveValue("7");
  await expect(delayToggle(page).locator("button.on")).toHaveText("ON");
});
