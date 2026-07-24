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

  test("a press outside the box closes the modal (the MIDI panel idiom)", async ({ page }) => {
    await page.click("#btn-prefs");
    await expect(page.locator("#prefs-modal")).toBeVisible();
    await page.click("#prefs-modal", { position: { x: 8, y: 8 } });
    await expect(page.locator("#prefs-modal")).toBeHidden();
    // A press inside the box does not close it.
    await page.click("#btn-prefs");
    await page.click("#prefs-title");
    await expect(page.locator("#prefs-modal")).toBeVisible();
    // Escape closes too, like the toolbar menus.
    await page.keyboard.press("Escape");
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

  test("a shrunken window scrolls the grid while Close stays pinned in view", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 420 });
    await page.click("#btn-prefs");
    const box = page.locator("#prefs-box");
    await expect(box).toBeVisible();
    // The box caps below the viewport; the grid inside it carries the overflow.
    const metrics = await box.evaluate((el) => {
      const grid = el.querySelector(".prefs-grid")!;
      return {
        boxClient: el.clientHeight,
        viewport: window.innerHeight,
        gridClient: grid.clientHeight,
        gridScroll: grid.scrollHeight,
      };
    });
    expect(metrics.boxClient).toBeLessThanOrEqual(metrics.viewport);
    expect(metrics.gridScroll).toBeGreaterThan(metrics.gridClient);
    // Close is pinned below the grid — visible and clickable without scrolling.
    const close = page.locator("#prefs-modal .consent-btn-primary");
    const closeBox = await close.boundingBox();
    expect(closeBox).not.toBeNull();
    expect(closeBox!.y + closeBox!.height).toBeLessThanOrEqual(420);
    await close.click();
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

test("every dismissal locks while a check is in flight (stubbed Tauri)", async ({ page }) => {
  await stubTauriBoot(page);
  // Delay the updater answer so the in-flight window is observable.
  await page.addInitScript(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<unknown> } })
      .__TAURI_INTERNALS__;
    const invoke = internals.invoke.bind(internals);
    internals.invoke = (cmd: string, ...rest: unknown[]) => {
      if (cmd === "plugin:updater|check") return new Promise((r) => setTimeout(() => r(null), 700));
      return (invoke as (...a: unknown[]) => Promise<unknown>)(cmd, ...rest);
    };
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-prefs");
  await page.click("#prefs-update-now");
  // In flight: outside press, Escape and the Close button are all inert.
  await expect(page.locator("#prefs-update-note")).toHaveText("Checking…");
  await page.click("#prefs-modal", { position: { x: 8, y: 8 } });
  await page.keyboard.press("Escape");
  await expect(page.locator("#prefs-modal")).toBeVisible();
  await expect(page.locator("#prefs-modal .consent-btn-primary")).toBeDisabled();
  // Settled: the outcome lands and every dismissal returns.
  await expect(page.locator("#prefs-update-note")).toHaveText("Already up to date.");
  await expect(page.locator("#prefs-modal .consent-btn-primary")).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page.locator("#prefs-modal")).toBeHidden();
});

test("Check now reports 'up to date' inline and keeps the modal open (stubbed Tauri)", async ({ page }) => {
  // stubTauriBoot answers plugin:updater|check with null = no update available.
  await stubTauriBoot(page);
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-prefs");
  await page.click("#prefs-update-now");
  await expect(page.locator("#prefs-update-note")).toHaveText("Already up to date.");
  await expect(page.locator("#prefs-modal")).toBeVisible();
  await expect(page.locator("#prefs-update-now")).toBeEnabled();
});
