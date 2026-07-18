import { test, expect, type Page } from "@playwright/test";

// The OSCILLATOR strip drives its level with a rotary LEVEL knob (not a fader) and
// borrows the meter-only layout + scale of the STREAMING strip.
const strip = (page: Page, name: string) => page.locator(".con-strip", { has: page.getByText(name, { exact: true }) });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-model", "URX44V");
  });
  await page.goto("/");
  await page.click("#btn-view-console");
  await expect(page.locator("#console-host")).toBeVisible();
});

test("the OSCILLATOR strip uses a LEVEL knob, not a fader", async ({ page }) => {
  const osc = strip(page, "OSCILLATOR");
  await expect(osc.locator(".con-fader")).toHaveCount(0); // no fader
  await expect(osc.getByRole("slider", { name: "LEVEL" })).toBeVisible();
  await expect(osc.locator(".con-gain .val")).toHaveText("-14.0"); // factory level
});

test("the OSCILLATOR on/off is the power LED (no ON chip); off by default = dimmed", async ({ page }) => {
  const osc = strip(page, "OSCILLATOR");
  await expect(osc.getByRole("button", { name: "ON", exact: true })).toHaveCount(0); // no ON chip
  await expect(osc).toHaveClass(/inactive/); // osc.on ships off → strip rests dimmed
  const power = osc.locator(".con-scribble.power");
  await expect(power).toHaveAttribute("aria-pressed", "false");
  await power.click();
  await expect(power).toHaveAttribute("aria-pressed", "true");
  await expect(osc).not.toHaveClass(/inactive/); // switched on → un-dimmed
});

test("the LEVEL knob adjusts the oscillator level by whole dB", async ({ page }) => {
  const osc = strip(page, "OSCILLATOR");
  const knob = osc.getByRole("slider", { name: "LEVEL" });
  const val = osc.locator(".con-gain .val");
  await knob.focus();
  await knob.press("ArrowUp");
  await expect(val).toHaveText("-13.0");
  await knob.press("ArrowDown");
  await knob.press("ArrowDown");
  await expect(val).toHaveText("-15.0");
});

test("the OSCILLATOR scale matches STREAMING (no +5 / +10 marks above 0 dB)", async ({ page }) => {
  const oscTicks = await strip(page, "OSCILLATOR").locator(".con-scale .t").allInnerTexts();
  const strTicks = await strip(page, "STREAMING").locator(".con-scale .t").allInnerTexts();
  expect(oscTicks).toEqual(strTicks); // same meter-only ruler
  expect(oscTicks.some((t) => t.trim() === "5" || t.trim() === "10")).toBe(false);
});
