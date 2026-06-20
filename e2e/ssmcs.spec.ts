import { test, expect, type Page } from "@playwright/test";

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const param = (page: Page, label: string) => page.locator("#inspector .param", { hasText: label });
const typeSelect = (page: Page) => param(page, "COMP/EQ Type").locator("select");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("switching a mono channel to SSMCS swaps in the morphing-strip controls", async ({ page }) => {
  await node(page, "ch1").click();
  const sel = typeSelect(page);
  await expect(sel).toHaveValue("0"); // COMP->EQ

  // COMP->EQ mode: none of the SSMCS Main controls are present.
  await expect(param(page, "Sweet Spot Data")).toHaveCount(0);
  await expect(param(page, "Comp Drive")).toHaveCount(0);

  await sel.selectOption("1"); // SSMCS
  await expect(param(page, "Sweet Spot Data")).toHaveCount(1);
  await expect(param(page, "Comp Drive")).toHaveCount(1);
  await expect(param(page, "Morphing")).toHaveCount(1);
  await expect(param(page, "Out Gain")).toHaveCount(1);
  // The SSMCS comp section carries a Side Chain filter (unique to SSMCS mode).
  await expect(param(page, "Side Chain")).toHaveCount(1);

  // Sweet Spot Data lists all 34 presets and defaults to the first. The SSMCS
  // section opens by default (its ON state seeds true from the device).
  const ssd = param(page, "Sweet Spot Data").locator("select");
  await expect(ssd.locator("option")).toHaveCount(34);
  await expect(ssd).toHaveValue("1");
  await ssd.selectOption("14"); // 08 MR Vocal
  await expect(ssd).toHaveValue("14");

  // Back to COMP->EQ removes the SSMCS controls.
  await sel.selectOption("0");
  await expect(param(page, "Sweet Spot Data")).toHaveCount(0);
  await expect(param(page, "Comp Drive")).toHaveCount(0);
});

test("SSMCS is a MONO IN feature — stereo channels have no COMP/EQ Type", async ({ page }) => {
  await node(page, "ch_5_6").click();
  await expect(typeSelect(page)).toHaveCount(0);
  await expect(param(page, "Sweet Spot Data")).toHaveCount(0);
});
