import { test, expect, type Page } from "@playwright/test";

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const param = (page: Page, label: string) => page.locator("#inspector .param", { hasText: label });
// The bare 1-knob ON toggle row (its label is exactly "1-knob", not "1-knob Type"/"1-knob Level").
const oneKnobToggle = (page: Page) =>
  page.locator("#inspector .param").filter({ has: page.getByText("1-knob", { exact: true }) });
const typeSelect = (page: Page) => param(page, "1-knob Type").locator("select");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("mono channel EQ 1-knob shows Intensity/Vocal and hides the band tabs when on", async ({ page }) => {
  await node(page, "ch1").click();
  // Off by default: band tabs visible, no type/level.
  await expect(page.locator("#inspector .eq-tabs")).toHaveCount(1);
  await expect(param(page, "1-knob Type")).toHaveCount(0);

  await oneKnobToggle(page).locator("button", { hasText: "ON" }).click();
  await expect(typeSelect(page).locator("option")).toHaveText(["Intensity", "Vocal"]);
  await expect(param(page, "1-knob Level")).toHaveCount(1);
  // Bands are device-driven while 1-knob is on, so the tabs are hidden.
  await expect(page.locator("#inspector .eq-tabs")).toHaveCount(0);
});

test("output bus EQ 1-knob offers Intensity/Loudness", async ({ page }) => {
  await node(page, "bus.stereo").click();
  await oneKnobToggle(page).locator("button", { hasText: "ON" }).click();
  await expect(typeSelect(page).locator("option")).toHaveText(["Intensity", "Loudness"]);
});

test("EQ 1-knob on/level persists after reselecting the channel", async ({ page }) => {
  await node(page, "ch1").click();
  await oneKnobToggle(page).locator("button", { hasText: "ON" }).click();
  await param(page, "1-knob Level").locator("input[type=range]").fill("80");

  await node(page, "ch2").click();
  await node(page, "ch1").click();
  await expect(typeSelect(page)).toHaveCount(1); // still on
  await expect(param(page, "1-knob Level").locator(".param-val")).toHaveText("80%");
});
