import { test, expect } from "@playwright/test";
import { stubTauriDevice, writesOf } from "./tauri-stub";

// The experimental read-only compare: it lists every parameter where the device
// differs from the plan and writes nothing. Gated behind --experimental, so the
// stub reports experimental_enabled = true to reveal the Device-menu entry.

test("Compare with device logs every parameter read and writes nothing", async ({ page }) => {
  // The stub answers every vd_get with 0, so the default plan's non-zero settings
  // (faders, etc.) all read as different — a comparison guaranteed to find
  // mismatches without pinning exact encoded values.
  await stubTauriDevice(page, { commands: { experimental_enabled: true } });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");

  await page.click("#btn-device");
  await page.click("#btn-compare");

  // The report modal opens under the neutral title and carries the full audit log
  // plus a compared count, so an instant verdict is verifiable rather than trusted.
  await expect(page.locator("#load-report-title")).toHaveText("Device comparison");
  await expect(page.locator("#load-report")).toBeVisible();
  await expect(page.locator("#load-report-body")).toContainText("## Full log (every parameter compared)");
  await expect(page.locator("#load-report-body")).toContainText("Compared");
  // The status counts the reads and reports the elapsed time.
  await expect(page.locator("#statusbar")).toContainText("differ from the device");
  // Read-only: a compare must never write.
  expect(await writesOf(page)).toEqual([]);
});

test("the full log records the reads that matched, not only the mismatches", async ({ page }) => {
  // The stub returns 0 for every read, so parameters whose plan value is also 0
  // (OFF sentinels, centered pans) match while non-zero ones differ. Both must
  // appear in the log — a matched read being logged is exactly what makes an
  // instant "all match" verifiable rather than trusted.
  await stubTauriDevice(page, { commands: { experimental_enabled: true } });
  await page.goto("/");
  await page.click("#btn-device");
  await page.click("#btn-compare");
  await expect(page.locator("#load-report-body")).toContainText("— match");
  await expect(page.locator("#load-report-body")).toContainText("— DIFFER");
  expect(await writesOf(page)).toEqual([]);
});

test("the compare entry is hidden without --experimental", async ({ page }) => {
  await stubTauriDevice(page); // experimental_enabled defaults to false
  await page.goto("/");
  await page.click("#btn-device");
  await expect(page.locator("#btn-compare")).toBeHidden();
});
