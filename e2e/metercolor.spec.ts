import { test, expect } from "@playwright/test";

// Level-meter color zones: the ladder is split into three bands keyed to absolute
// dBFS — green up to the device's nominal reference (-18 dBFS), yellow up to the
// EBU/OBS permitted maximum (-9 dBFS), red above. The boundaries are written to the
// ladder as --zy / --zr (fraction of the ladder), so the color of a point on the bar
// tracks absolute level, not the lit height.
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

test("the meter ladder carries ordered green/yellow/red zone boundaries", async ({ page }) => {
  const ladder = page.locator(".con-ladder.sig").first();
  await expect(ladder).toBeVisible();

  const zones = await ladder.evaluate((el) => ({
    zy: parseFloat(getComputedStyle(el).getPropertyValue("--zy")),
    zr: parseFloat(getComputedStyle(el).getPropertyValue("--zr")),
  }));

  // Both boundaries land strictly inside the ladder, with green < yellow < red.
  expect(zones.zy).toBeGreaterThan(0);
  expect(zones.zr).toBeLessThan(100);
  expect(zones.zy).toBeLessThan(zones.zr);

  // The colored bar spans the whole ladder and the shade hides the unlit part, so an
  // empty meter (no live sync) is fully shaded.
  await expect(ladder.locator(".bar")).toHaveCount(1);
  const lvl = await ladder.locator(".shade").evaluate((el) => getComputedStyle(el).getPropertyValue("--lvl").trim());
  expect(lvl === "" || lvl === "0%").toBeTruthy();
});
