import { test, expect } from "./fixtures";
import { invokesOf, stubTauriBoot } from "./tauri-stub";

// Recent entries whose file no longer loads: the stubbed shell answers no
// read_text_file command, so opening one fails exactly like a moved / deleted
// file. The failure drops the entry automatically (keeping it would only
// reproduce the same error) and says so on the status line.

const GONE = [{ path: "/tmp/gone.json", name: "gone.json", modelId: "URX44V" }];

test("a recent plan that fails to load is removed and the status line says so", async ({ page }) => {
  await stubTauriBoot(page, { "plugin:dialog|message": null });
  await page.addInitScript((entries) => {
    localStorage.setItem("urx-recent", JSON.stringify(entries));
  }, GONE);
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  const row = page.locator(".recent-row");
  await expect(row).toHaveCount(1);
  await row.click();
  await expect(page.locator(".recent-row")).toHaveCount(0);
  await expect(page.locator("#statusbar")).toHaveText("Removed gone.json from the recent plans");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("urx-recent") ?? "[]") as unknown);
  expect(stored).toEqual([]);
});

test("declining the discard confirm keeps the recent entry", async ({ page }) => {
  // The stubbed message dialog returns null (never "Ok"), so every confirm is
  // declined — the open is canceled before any load attempt.
  await stubTauriBoot(page, { "plugin:dialog|message": null });
  await page.addInitScript((entries) => {
    localStorage.setItem("urx-recent", JSON.stringify(entries));
  }, GONE);
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  // Dirty the plan so the discard confirm gates the open.
  await page.selectOption("#rate-picker", "96000");
  await page.locator(".recent-row").click();
  // Wait for the confirm to have been RAISED, not for a clock. The open is decided at
  // that dialog, so once it has been asked and declined the outcome is settled — where
  // a fixed sleep is the whole definition of "nothing was attempted" and is satisfied
  // just as well by a click that had not been processed yet.
  await expect.poll(() => invokesOf(page)).toContain("plugin:dialog|message");
  await expect(page.locator(".recent-row")).toHaveCount(1);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("urx-recent") ?? "[]") as unknown[]);
  expect(stored).toHaveLength(1);
});
