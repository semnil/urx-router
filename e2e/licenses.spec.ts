import { test, expect } from "@playwright/test";
import { stubTauriBoot } from "./tauri-stub";

// The third-party license notice ships as a Tauri resource, so the File menu
// entry is desktop-only: the stubbed shell serves the page into the modal's
// sandboxed frame; a plain browser must keep the entry hidden.

test("the licenses entry opens the bundled notice in a modal (Tauri)", async ({ page }) => {
  await stubTauriBoot(page, { third_party_licenses: "<h1>Stub notice</h1>" });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-file");
  await expect(page.locator("#btn-licenses")).toBeVisible();
  await page.click("#btn-licenses");
  await expect(page.locator("#licenses-modal")).toBeVisible();
  await expect(page.frameLocator("#licenses-frame").locator("h1")).toHaveText("Stub notice");
  await page.click("#licenses-close");
  await expect(page.locator("#licenses-modal")).toBeHidden();
});

test("the licenses entry stays hidden in a plain browser", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#model-picker")).toBeVisible();
  await page.click("#btn-file");
  await expect(page.locator("#btn-open")).toBeVisible(); // the menu itself is open
  await expect(page.locator("#btn-licenses")).toBeHidden();
});
