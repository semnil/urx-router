import { test, expect, type Page } from "@playwright/test";
import { stubTauriBoot } from "./tauri-stub";

// The third-party license notice ships as a Tauri resource, so the File menu
// entry is desktop-only: the stubbed shell serves the generated page, which the
// modal parses and renders as app DOM (no iframe); a plain browser must keep
// the entry hidden.

// The cargo-about structure in miniature: two families, Apache with two text
// variants.
const NOTICE = `<html><body><main class="container"><ul class="licenses-list">
  <li class="license"><h3 id="Apache-2.0">Apache License 2.0</h3>
    <ul class="license-used-by"><li><a href="#">alpha 1.0.0</a></li><li><a href="#">beta 2.1.0</a></li></ul>
    <pre class="license-text">APACHE TEXT ONE</pre></li>
  <li class="license"><h3 id="Apache-2.0">Apache License 2.0</h3>
    <ul class="license-used-by"><li><a href="#">gamma 0.3.0</a></li></ul>
    <pre class="license-text">APACHE TEXT TWO</pre></li>
  <li class="license"><h3 id="MIT">MIT License</h3>
    <ul class="license-used-by"><li><a href="#">delta 4.0.0</a></li></ul>
    <pre class="license-text">MIT TEXT</pre></li>
</ul></main></body></html>`;

async function openLicenses(page: Page): Promise<void> {
  await stubTauriBoot(page, { third_party_licenses: NOTICE });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-file");
  await expect(page.locator("#btn-licenses")).toBeVisible();
  await page.click("#btn-licenses");
  await expect(page.locator("#licenses-modal")).toBeVisible();
}

test("the notice renders as a collapsed family index that unfolds per header", async ({ page }) => {
  await openLicenses(page);
  // The collapsed headers are the index: one row per family, texts hidden.
  await expect(page.locator(".lic-sec")).toHaveCount(2);
  const apache = page.locator(".lic-sec").first();
  await expect(apache.locator(".lic-toggle")).toHaveText("▸Apache License 2.0");
  await expect(apache.locator(".lic-count")).toHaveText("3 crates · 2 texts");
  await expect(apache.locator(".lic-detail")).toBeHidden();
  // The header unfolds its text variants with their own used-by mapping...
  await apache.locator(".lic-toggle").click();
  await expect(apache.locator(".lic-detail")).toBeVisible();
  await expect(apache.locator(".lic-text")).toHaveCount(2);
  await expect(apache.locator(".lic-text").first()).toHaveText("APACHE TEXT ONE");
  await expect(apache.locator(".lic-used").first()).toHaveText("alpha 1.0.0, beta 2.1.0");
  // ...and folds back.
  await apache.locator(".lic-toggle").click();
  await expect(apache.locator(".lic-detail")).toBeHidden();
  // Closing releases the rendered notice.
  await page.click("#licenses-close");
  await expect(page.locator("#licenses-modal")).toBeHidden();
  await expect(page.locator("#licenses-body > *")).toHaveCount(0);
});

test("a press outside the box or Escape dismisses the notice", async ({ page }) => {
  await openLicenses(page);
  // A press inside the box does not close it.
  await page.click("#licenses-title");
  await expect(page.locator("#licenses-modal")).toBeVisible();
  await page.click("#licenses-modal", { position: { x: 8, y: 8 } });
  await expect(page.locator("#licenses-modal")).toBeHidden();
  // Escape closes too.
  await page.click("#btn-file");
  await page.click("#btn-licenses");
  await expect(page.locator("#licenses-modal")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#licenses-modal")).toBeHidden();
});

test("an unparseable notice lands in the error dialog, not an empty modal", async ({ page }) => {
  await stubTauriBoot(page, { third_party_licenses: "<h1>not a notice</h1>", "plugin:dialog|message": null });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-file");
  await page.click("#btn-licenses");
  // The stubbed message dialog resolves immediately; the modal must never show.
  await page.waitForTimeout(300);
  await expect(page.locator("#licenses-modal")).toBeHidden();
});

test("the licenses entry stays hidden in a plain browser", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#model-picker")).toBeVisible();
  await page.click("#btn-file");
  await expect(page.locator("#btn-open")).toBeVisible(); // the menu itself is open
  await expect(page.locator("#btn-licenses")).toBeHidden();
});
