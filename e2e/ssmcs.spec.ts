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

  // The SSMCS Main section sits between GATE and COMP.
  const titles = await page.locator("#inspector summary").allInnerTexts();
  const gate = titles.findIndex((t) => t.includes("GATE"));
  const ssmcs = titles.findIndex((t) => t.includes("SSMCS"));
  const comp = titles.findIndex((t) => t.includes("COMP"));
  expect(gate).toBeGreaterThanOrEqual(0);
  expect(gate).toBeLessThan(ssmcs);
  expect(ssmcs).toBeLessThan(comp);

  // Switching to SSMCS turns the COMP/EQ sections ON, so they open (their ON
  // state seeds true from the device).
  const compSection = page.locator("#inspector details").filter({ has: page.locator("summary", { hasText: "COMP" }) });
  const eqSection = page.locator("#inspector details").filter({ has: page.locator("summary", { hasText: "EQ" }) });
  await expect(compSection).toHaveAttribute("open", "");
  await expect(eqSection).toHaveAttribute("open", "");

  // Sweet Spot Data lists all 34 presets and defaults to the first. The SSMCS
  // section opens by default (its ON state seeds true from the device).
  const ssd = param(page, "Sweet Spot Data").locator("select");
  await expect(ssd.locator("option")).toHaveCount(34);
  await expect(ssd).toHaveValue("1");
  await ssd.selectOption("14"); // 08 MR Vocal
  await expect(ssd).toHaveValue("14");

  // Back to COMP->EQ removes the SSMCS controls and resets to COMP off / EQ on.
  await sel.selectOption("0");
  await expect(param(page, "Sweet Spot Data")).toHaveCount(0);
  await expect(param(page, "Comp Drive")).toHaveCount(0);
  await expect(compSection).not.toHaveAttribute("open", ""); // COMP off → folded
  await expect(eqSection).toHaveAttribute("open", ""); // EQ on → open
});

test("re-entering an SSMCS/COMP->EQ mode resets that bank to factory", async ({ page }) => {
  // The device treats the two chains as exclusive and reloads the destination
  // chain's factory values on every switch; the planner mirrors that offline.
  await node(page, "ch1").click();
  const sel = typeSelect(page);
  await sel.selectOption("1"); // SSMCS
  const ssd = param(page, "Sweet Spot Data").locator("select");
  await expect(ssd).toHaveValue("1"); // factory "01 Basic"
  await ssd.selectOption("14"); // 08 MR Vocal
  await expect(ssd).toHaveValue("14");

  // Leave SSMCS and come back: the morphing strip reloads factory, not "08 MR Vocal".
  await sel.selectOption("0"); // COMP->EQ
  await sel.selectOption("1"); // SSMCS again
  await expect(param(page, "Sweet Spot Data").locator("select")).toHaveValue("1");
});

test("toggling the SSMCS value reverts its fold to follow the on-state", async ({ page }) => {
  await node(page, "ch1").click();
  await typeSelect(page).selectOption("1"); // SSMCS
  const ssmcs = page.locator("#inspector details").filter({ has: page.locator("summary", { hasText: "SSMCS" }) });
  const onOff = ssmcs.locator(".sec-body > .param").first();
  await expect(ssmcs).toHaveJSProperty("open", true); // on by default → open

  // Turn SSMCS off: the section folds with the on-state.
  await onOff.locator("button", { hasText: "OFF" }).click();
  await expect(ssmcs).toHaveJSProperty("open", false);

  // Open it by hand while off; the manual fold persists.
  await ssmcs.locator("summary").click();
  await expect(ssmcs).toHaveJSProperty("open", true);

  // Toggling the value on then off must drop the manual override, so an off
  // SSMCS folds again rather than staying open from the earlier hand-open.
  await onOff.locator("button", { hasText: "ON" }).click();
  await expect(ssmcs).toHaveJSProperty("open", true);
  await onOff.locator("button", { hasText: "OFF" }).click();
  await expect(ssmcs).toHaveJSProperty("open", false);
});

test("SSMCS is a MONO IN feature — stereo channels have no COMP/EQ Type", async ({ page }) => {
  await node(page, "ch_5_6").click();
  await expect(typeSelect(page)).toHaveCount(0);
  await expect(param(page, "Sweet Spot Data")).toHaveCount(0);
});
