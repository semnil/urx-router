import { test, expect, type Page } from "@playwright/test";

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const port = (page: Page, ref: string) => page.locator(`[data-ref="${ref}"]`);
const wires = (page: Page) => page.locator("#graph-host .wire-hit");
const param = (page: Page, label: string) => page.locator("#inspector .param", { hasText: label });
const busTypeSelect = (page: Page) => param(page, "BUS Type").locator("select");

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

test("FIXED bus drops the send LEVEL and shows a hint", async ({ page }) => {
  await connect(page, "ch1:out", "bus.mix1:in");
  await node(page, "bus.mix1").click();
  await busTypeSelect(page).selectOption("1"); // FIXED

  await wires(page).last().click();
  await expect(param(page, "Level")).toHaveCount(0);
  await expect(param(page, "Pan")).toHaveCount(1);
  await expect(page.locator("#inspector .hint", { hasText: "Send level is fixed" })).toHaveCount(1);
});

test("VARI + Pan Link drops the send PAN and shows a hint", async ({ page }) => {
  await connect(page, "ch1:out", "bus.mix1:in");
  await node(page, "bus.mix1").click();
  await param(page, "Pan Link").locator("button", { hasText: "ON" }).click();

  await wires(page).last().click();
  await expect(param(page, "Pan")).toHaveCount(0);
  await expect(param(page, "Level")).toHaveCount(1);
  await expect(page.locator("#inspector .hint", { hasText: "Pan follows" })).toHaveCount(1);
});
