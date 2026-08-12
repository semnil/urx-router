import { test, expect, type Page } from "./fixtures";
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

// The notice opens on an await, so it claims the modal hold LAST while the overlay
// ladder still draws it beneath a decision gate (style.css: a gate is z-index 130, a
// tool modal 100). Reading the top off the claim order inerted the report the
// operator was looking at and moved focus into the notice behind it.
const ILLEGAL_PLAN = JSON.stringify({
  format: "urx-router-plan",
  version: 1,
  modelId: "URX44V",
  connections: [{ from: "ch1:out", to: "ch2:in", kind: "source" }],
});
const RECENT = [{ path: "/tmp/illegal.json", name: "illegal.json", modelId: "URX44V" }];

type Internals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

test("a notice arriving under a load report is the one held back, not the report", async ({ page }) => {
  await stubTauriBoot(page, { third_party_licenses: NOTICE, read_text_file: ILLEGAL_PLAN });
  // Hold the notice read open. It is the only way to reach this order at all: while a
  // gate is up the app behind it is inert, so the second modal cannot be raised by a
  // click — it has to be one that was already loading when the gate arrived.
  await page.addInitScript(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;
    const invoke = internals.invoke;
    internals.invoke = (cmd, args) =>
      cmd === "third_party_licenses"
        ? new Promise((resolve) => {
            (window as unknown as { __releaseNotice: () => void }).__releaseNotice = () =>
              void resolve(invoke(cmd, args));
          })
        : invoke(cmd, args);
  });
  await page.addInitScript((entries) => localStorage.setItem("urx-recent", JSON.stringify(entries)), RECENT);
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");

  await page.click("#btn-file");
  await page.click("#btn-licenses"); // in flight, nothing on screen yet
  // The recent entry holds a plan with one connection the routing rules refuse, so
  // opening it stops at the report — the gate, claimed first.
  await page.locator(".recent-row").click();
  await expect(page.locator("#load-report")).toBeVisible();
  await page.evaluate(() => (window as unknown as { __releaseNotice: () => void }).__releaseNotice());
  await expect(page.locator("#licenses-modal")).toBeVisible();

  // The report is what the page draws on top, so it is what stays reachable — and the
  // notice's own `close.focus()` is refused rather than pulling focus out of it.
  const held = await page.evaluate(() => ({
    report: (document.getElementById("load-report") as HTMLElement).inert,
    notice: (document.getElementById("licenses-modal") as HTMLElement).inert,
    focused: document.activeElement?.closest(".consent-scrim")?.id ?? document.activeElement?.tagName ?? null,
  }));
  expect(held).toEqual({ report: false, notice: true, focused: "load-report" });

  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    const scrim = await page.evaluate(
      () => document.activeElement?.closest(".consent-scrim")?.id ?? document.activeElement?.tagName ?? null,
    );
    expect(scrim === "load-report" || scrim === "BODY").toBe(true);
  }

  // Closing the gate hands the notice underneath back.
  await page.click("#load-report-close");
  await expect(page.locator("#load-report")).toBeHidden();
  expect(await page.evaluate(() => (document.getElementById("licenses-modal") as HTMLElement).inert)).toBe(false);
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
