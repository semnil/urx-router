import { test, expect, type Page } from "@playwright/test";

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const section = (page: Page, title: RegExp) =>
  page.locator("#inspector .insp-section", { has: page.locator("summary", { hasText: title }) });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.locator("#model-picker").waitFor();
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("GATE range has a -∞ notch one step below the -72 dB floor", async ({ page }) => {
  await node(page, "ch1").click();
  const gate = section(page, /^GATE$/);
  await gate.locator("summary").click(); // GATE folds off by default
  const range = gate.locator(".param", { hasText: "Range" });
  const slider = range.locator("input[type=range]");
  await expect(slider).toHaveAttribute("min", "-73"); // -73 = the -∞ notch
  await slider.fill("-73");
  await expect(range.locator(".param-val")).toHaveText("-∞ dB");
  await slider.fill("-72");
  await expect(range.locator(".param-val")).toHaveText("-72.0 dB"); // deepest finite step
});

test("COMP 1-Knob shows ratio/gain read-only in place of the manual sliders", async ({ page }) => {
  await node(page, "ch1").click();
  const comp = section(page, /^COMP$/);
  await comp.locator("summary").click(); // COMP folds off by default

  // Off: Ratio is an editable slider.
  await expect(comp.locator(".param", { hasText: "Ratio" }).locator("input[type=range]")).toHaveCount(1);

  // Turn 1-Knob on: Ratio/Gain become read-only rows (no control), Level appears.
  await comp
    .locator(".param")
    .filter({ has: page.getByText("1-Knob", { exact: true }) })
    .locator("button", { hasText: "ON" })
    .click();
  await expect(comp.locator(".param", { hasText: "1-Knob Level" }).locator("input[type=range]")).toHaveCount(1);
  const ratioRo = comp.locator(".param.readonly", { hasText: "Ratio" });
  await expect(ratioRo).toHaveCount(1);
  await expect(ratioRo.locator("input")).toHaveCount(0);
  await expect(comp.locator(".param.readonly", { hasText: "Gain" })).toHaveCount(1);
});
