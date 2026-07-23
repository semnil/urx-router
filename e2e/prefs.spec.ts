import { test, expect } from "@playwright/test";
import { stubTauriBoot } from "./tauri-stub";

// Preferences modal (toolbar gear). The gear is an independent entry available
// in every build; rows that need the desktop shell render disabled with a
// "Desktop app only" tag in a plain browser, which is exactly what this harness
// serves (the built bundle without VITE_DEMO, no Tauri shell).

test.describe("plain browser", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("urx-lang", "en"));
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  test("the gear opens the modal; desktop-only rows are locked and tagged", async ({ page }) => {
    await page.click("#btn-prefs");
    await expect(page.locator("#prefs-modal")).toBeVisible();
    await expect(page.locator("#prefs-title")).toHaveText("Preferences");
    // Device scope: locked (needs the desktop shell), tagged, buttons disabled.
    const scopeRow = page.locator("#prefs-device-scope").locator("..");
    await expect(scopeRow).toHaveClass(/locked/);
    await expect(scopeRow.locator(".prefs-lock")).toHaveText("Desktop app only");
    await expect(page.locator("#prefs-device-scope button").first()).toBeDisabled();
    // Save scope applies in every build.
    await expect(page.locator("#prefs-save-scope button").first()).toBeEnabled();
    // Version shows; the manual update check needs the desktop shell.
    await expect(page.locator("#prefs-version")).toContainText("URX Router");
    await expect(page.locator("#prefs-update-now")).toHaveCount(0);
    await page.click("#prefs-modal .consent-btn-primary");
    await expect(page.locator("#prefs-modal")).toBeHidden();
  });

  test("a changed setting applies immediately and survives a reload", async ({ page }) => {
    await page.click("#btn-prefs");
    await page.click('#prefs-save-scope button:has-text("Scene only")');
    await expect(page.locator("#prefs-save-scope button.on")).toHaveText("Scene only");
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("urx-settings") ?? "{}"));
    expect(stored.saveScope).toBe("scene");
    await page.reload();
    await page.click("#btn-prefs");
    await expect(page.locator("#prefs-save-scope button.on")).toHaveText("Scene only");
  });

  test("fine-tuning latch: Shift toggles instead of holding", async ({ page }) => {
    await page.click("#btn-prefs");
    await page.click('#prefs-fine button:has-text("Latch")');
    await page.click("#prefs-modal .consent-btn-primary");
    // One press latches fine mode on through the keyup...
    await page.keyboard.down("Shift");
    await page.keyboard.up("Shift");
    await expect(page.locator("html")).toHaveClass(/fine-mode/);
    // ...and the next press releases it.
    await page.keyboard.down("Shift");
    await page.keyboard.up("Shift");
    await expect(page.locator("html")).not.toHaveClass(/fine-mode/);
  });

  test("a shrunken window keeps the modal scrollable and closable", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 420 });
    await page.click("#btn-prefs");
    const box = page.locator("#prefs-box");
    await expect(box).toBeVisible();
    // The box caps below the viewport and scrolls its overflow instead of clipping.
    const metrics = await box.evaluate((el) => ({
      client: el.clientHeight,
      scroll: el.scrollHeight,
      viewport: window.innerHeight,
    }));
    expect(metrics.client).toBeLessThanOrEqual(metrics.viewport);
    expect(metrics.scroll).toBeGreaterThan(metrics.client);
    // The Close action stays reachable (Playwright scrolls it into view).
    await page.click("#prefs-modal .consent-btn-primary");
    await expect(page.locator("#prefs-modal")).toBeHidden();
  });
});

test("the desktop shell unlocks the device rows (stubbed Tauri)", async ({ page }) => {
  await stubTauriBoot(page);
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-prefs");
  await expect(page.locator("#prefs-device-scope button").first()).toBeEnabled();
  const scopeRow = page.locator("#prefs-device-scope").locator("..");
  await expect(scopeRow.locator(".prefs-lock")).toHaveCount(0);
  await expect(page.locator("#prefs-update-now")).toBeVisible();
});
