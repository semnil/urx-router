import { test, expect, type Page } from "@playwright/test";

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const param = (page: Page, label: string) => page.locator("#inspector .param", { hasText: label });
const busTypeSelect = (page: Page) => param(page, "BUS Type").locator("select");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("MIX bus shows BUS Type + Pan Link; FIXED hides Pan Link", async ({ page }) => {
  await node(page, "bus.mix1").click();
  await expect(busTypeSelect(page).locator("option")).toHaveText(["VARI", "FIXED"]);
  await expect(busTypeSelect(page)).toHaveValue("0"); // VARI
  await expect(param(page, "Pan Link")).toHaveCount(1);

  await busTypeSelect(page).selectOption("1"); // FIXED
  await expect(param(page, "Pan Link")).toHaveCount(0);
});

// Select a wire by its endpoints. Every CH → bus send is a fixed (always-wired)
// connection now, so it is picked by endpoint rather than created; dispatchEvent
// bypasses the overlapping wire-hit bands' pointer interception.
const selectWire = (page: Page, from: string, to: string) =>
  page.locator(`.wire-hit[data-from="${from}"][data-to="${to}"]`).dispatchEvent("pointerdown");

test("FIXED bus drops the send LEVEL and shows a hint", async ({ page }) => {
  await node(page, "bus.mix1").click();
  await busTypeSelect(page).selectOption("1"); // FIXED

  await selectWire(page, "ch1:out", "bus.mix1:in");
  await expect(param(page, "Level")).toHaveCount(0);
  await expect(param(page, "Pan")).toHaveCount(1);
  await expect(page.locator("#inspector .hint", { hasText: "Send level is fixed" })).toHaveCount(1);
});

test("VARI + Pan Link drops the send PAN and shows a hint", async ({ page }) => {
  await node(page, "bus.mix1").click();
  await param(page, "Pan Link").locator("button", { hasText: "ON" }).click();

  await selectWire(page, "ch1:out", "bus.mix1:in");
  await expect(param(page, "Pan")).toHaveCount(0);
  await expect(param(page, "Level")).toHaveCount(1);
  await expect(page.locator("#inspector .hint", { hasText: "Pan follows" })).toHaveCount(1);
});
