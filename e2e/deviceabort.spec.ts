import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { dialogsOf, stubTauriDevice, writesOf } from "./tauri-stub";

// The device paths abort rather than continue once a premise has failed: a write
// whose diff could not be read never writes, a unit whose firmware version could
// not be read is not touched at all, and a send that stops part-way offers a
// retry instead of a breakdown the user cannot act on.

interface StubOptions {
  /** null = the firmware read did not land (the Q-1 gate). */
  firmware?: string | null;
  /** Reject every vd_get, so the write's diff cannot establish device values. */
  failReads?: boolean;
}

// The write reads the device's clock state (sample rate 766 / Follow USB 848)
// before the diff, so those two are answered even under failReads: this file is
// about the DIFF read failing, and the clock read's own abort is samplerate.spec.
// 48 kHz matches the plan and Follow USB off means there is nothing to settle.
function stubDevice(page: Page, opts: StubOptions = {}): Promise<void> {
  return stubTauriDevice(page, { ...opts, values: { 766: 48000, 848: 0 } });
}

const setsOf = async (page: Page): Promise<number> => (await writesOf(page)).length;

test("a write whose diff cannot be read is canceled before anything is sent", async ({ page }) => {
  await stubDevice(page, { failReads: true });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");

  await page.click("#btn-device"); // the device actions live in a menu
  await page.click("#btn-write");

  await expect(page.locator("#statusbar")).toContainText("Write canceled");
  await expect(page.locator("#statusbar")).toContainText("could not be read");
  // The abort happens before the confirm, so nothing reached the device.
  expect(await setsOf(page)).toBe(0);
  expect(await dialogsOf(page)).not.toContainEqual(expect.stringContaining("Write "));
});

test("a unit whose firmware version could not be read is not touched", async ({ page }) => {
  await stubDevice(page, { firmware: null });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");

  await page.click("#btn-device"); // the device actions live in a menu
  await page.click("#btn-fetch");

  await expect
    .poll(() => dialogsOf(page))
    .toContainEqual(expect.stringContaining("firmware version could not be read"));
  expect(await setsOf(page)).toBe(0);
});

test("a device that reports no firmware version is still usable", async ({ page }) => {
  // Empty is not the same as unread: the unit answered, it just has no System
  // entry, which disables the mismatch warning by design rather than blocking.
  await stubDevice(page, { firmware: "" });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");

  await page.click("#btn-device"); // the device actions live in a menu
  await page.click("#btn-fetch");

  await expect.poll(() => dialogsOf(page)).not.toContainEqual(expect.stringContaining("firmware version"));
});
