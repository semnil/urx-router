import { test, expect, type Page } from "@playwright/test";

// Stereo strips meter L and R independently: the meter keeps one ladder frame and one
// OVER frame (`.con-meter.stereo`), but splits into two bar columns (`.mtrcol.l` /
// `.mtrcol.r`) and two clip cells (`.lit.l` / `.lit.r`), while a mono strip has a single
// column and clip. The split follows the selected tap's channel count, so switching an
// FX strip from its stereo POST tap to a mono PRE FADER tap collapses it to one bar.
const strip = (page: Page, name: string) => page.locator(".con-strip", { has: page.getByText(name, { exact: true }) });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-model", "URX44V");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-view-console");
  await expect(page.locator("#console-host")).toBeVisible();
});

test("a mono channel meters with a single bar column and clip cell", async ({ page }) => {
  const meter = strip(page, "CH 1").locator(".con-meter");
  await expect(meter).not.toHaveClass(/stereo/);
  await expect(meter.locator(".con-ladder.sig .mtrcol")).toHaveCount(1);
  await expect(meter.locator(".con-over .lit")).toHaveCount(1);
});

test("stereo strips split into separate L and R bars and clip cells", async ({ page }) => {
  for (const name of ["CH 5/6", "FX 1", "MIX 1", "STEREO", "STREAMING", "MONITOR 1"]) {
    const meter = strip(page, name).locator(".con-meter");
    await expect(meter, name).toHaveClass(/stereo/);
    // One undivided ladder + OVER frame, each holding an L and an R lane.
    await expect(meter.locator(".con-ladder.sig"), name).toHaveCount(1);
    await expect(meter.locator(".con-over"), name).toHaveCount(1);
    await expect(meter.locator(".con-ladder.sig .mtrcol.l"), name).toHaveCount(1);
    await expect(meter.locator(".con-ladder.sig .mtrcol.r"), name).toHaveCount(1);
    await expect(meter.locator(".con-over .lit.l"), name).toHaveCount(1);
    await expect(meter.locator(".con-over .lit.r"), name).toHaveCount(1);
  }
});

test("selecting a mono tap collapses an FX strip's dual meter to one bar", async ({ page }) => {
  const meter = strip(page, "FX 1").locator(".con-meter");
  // Default POST tap is stereo → two bar columns.
  await expect(meter.locator(".con-ladder.sig .mtrcol")).toHaveCount(2);

  await strip(page, "FX 1").locator(".con-tap").click();
  await page.locator(".con-tappop .crow", { has: page.getByText("PRE FADER", { exact: true }) }).click();

  await expect(strip(page, "FX 1").locator(".con-meter")).not.toHaveClass(/stereo/);
  await expect(strip(page, "FX 1").locator(".con-meter .con-ladder.sig .mtrcol")).toHaveCount(1);
});
