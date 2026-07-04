import { test, expect, type Page } from "@playwright/test";
import { stubTauriBoot } from "./tauri-stub";

// App-chrome behaviour: the theme and language toggles, the toolbar brand and
// Device-menu grouping, and the canvas hit-test after a zoom. These cut across
// the whole UI (toolbar + graph + console), which the per-feature specs do not
// exercise. Each toggle button labels the state it switches TO, so its text
// flips after a click.

const port = (page: Page, ref: string) => page.locator(`[data-ref="${ref}"]`);
const wires = (page: Page) => page.locator("#graph-host .wire-hit");

async function connect(page: Page, fromRef: string, toRef: string): Promise<void> {
  const a = await port(page, fromRef).boundingBox();
  const b = await port(page, toRef).boundingBox();
  if (!a || !b) throw new Error(`port not found: ${fromRef} -> ${toRef}`);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}

test.describe("theme", () => {
  test.beforeEach(async ({ page }) => {
    // Pin lang+model but NOT theme, so the toggle's localStorage write is what
    // drives the post-reload state (the beforeEach init script never re-pins it).
    await page.addInitScript(() => {
      localStorage.setItem("urx-lang", "en");
      localStorage.setItem("urx-model", "URX44V");
    });
  });

  test("the theme glyph cycles light → dark → auto and persists the chosen mode", async ({ page }) => {
    // Pin a dark OS so auto resolves predictably to dark.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");

    const html = page.locator("html");
    const btn = page.locator("#btn-theme");

    // No saved choice → auto, which under a dark OS resolves to dark.
    await expect(btn).toHaveText("◐");
    await expect(html).toHaveAttribute("data-theme", "dark");

    // auto → light
    await btn.click();
    await expect(btn).toHaveText("☀");
    await expect(html).toHaveAttribute("data-theme", "light");
    await expect(page.locator("#statusbar")).toHaveText("Switched to light mode");

    // light → dark
    await btn.click();
    await expect(btn).toHaveText("☾");
    await expect(html).toHaveAttribute("data-theme", "dark");

    // dark → auto (follows the OS again = dark here)
    await btn.click();
    await expect(btn).toHaveText("◐");
    await expect(html).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("#statusbar")).toHaveText("Following the system theme");

    // The chosen mode survives a reload: step to light, reload, expect light + sun.
    await btn.click();
    await page.reload();
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await expect(html).toHaveAttribute("data-theme", "light");
    await expect(page.locator("#btn-theme")).toHaveText("☀");
  });

  test("auto mode follows a live OS color-scheme change", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    const html = page.locator("html");
    // Default (no saved choice) is auto; a light OS resolves to light.
    await expect(page.locator("#btn-theme")).toHaveText("◐");
    await expect(html).toHaveAttribute("data-theme", "light");

    // Flipping the OS preference repaints without a click while in auto.
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(html).toHaveAttribute("data-theme", "dark");
  });

  test("toggling theme inside the console view keeps the console rendered", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await page.click("#btn-view-console");
    await expect(page.locator("#console-host")).toBeVisible();
    const strips = await page.locator(".con-strip").count();

    await page.click("#btn-theme");

    // The console is CSS-variable themed, so it must stay up with all strips intact
    // (no re-mount, no blank view) when the palette flips under it.
    await expect(page.locator("#console-host")).toBeVisible();
    await expect(page.locator(".con-strip")).toHaveCount(strips);
  });
});

test.describe("language", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("urx-lang", "en");
      localStorage.setItem("urx-theme", "dark");
      localStorage.setItem("urx-model", "URX44V");
    });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  test("switching to Japanese relocalizes the toolbar and the console output label live", async ({ page }) => {
    await expect(page.locator("#btn-view-graph")).toHaveText("Graph");
    await page.click("#btn-view-console");
    await expect(page.locator(".con-modelabel")).toHaveText("Output");

    // The button shows the current language code; clicking it re-localizes both
    // the toolbar (static i18n) and the already-rendered console (refresh()).
    await expect(page.locator("#btn-lang")).toHaveText("EN");
    await page.click("#btn-lang");

    await expect(page.locator("#btn-view-graph")).toHaveText("グラフ");
    await expect(page.locator("#btn-hide-unused")).toHaveText("未接続を隠す");
    await expect(page.locator(".con-modelabel")).toHaveText("出力");
    await expect(page.locator("#btn-lang")).toHaveText("JA"); // now the current language
  });

  test("an open selection survives a language switch with the inspector intact", async ({ page }) => {
    await page.locator('g.node[data-id="ch1"]').click();
    const params = await page.locator("#inspector .param").count();
    expect(params).toBeGreaterThan(0);
    await expect(page.locator("body")).toHaveClass(/has-selection/);

    await page.click("#btn-lang");

    // The inspector re-renders in the new language but keeps the same selection
    // (param rows preserved, mobile bottom-sheet flag still set).
    await expect(page.locator("#inspector .param")).toHaveCount(params);
    await expect(page.locator("body")).toHaveClass(/has-selection/);
  });
});

test.describe("canvas hit-test", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("urx-lang", "en");
      localStorage.setItem("urx-theme", "dark");
      localStorage.setItem("urx-seed", "empty");
    });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  test("a legal connection still lands after zooming the canvas in", async ({ page }) => {
    const base = await wires(page).count();
    const svg = page.locator("#graph-host svg");
    const bb = await svg.boundingBox();
    if (!bb) throw new Error("no svg box");

    // Wheel-zoom in at the canvas centre, then draw a known-legal wire. The port
    // boundingBox is read after the zoom, so a correct hit-test still commits it.
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.mouse.wheel(0, -300);
    await connect(page, "in.micline_1_2:out", "ch_5_6:in");

    await expect(wires(page)).toHaveCount(base + 1);
    await expect(page.locator("#statusbar")).toHaveText("Connected");
  });
});

test.describe("toolbar", () => {
  test("the brand is the logo alone (no tagline, no meter decoration)", async ({ page }) => {
    // The brand block is static markup untouched by i18n / model state, so no
    // localStorage pinning is needed.
    await page.goto("/");
    await expect(page.locator(".brand .word")).toHaveText("URX·ROUTER");
    await expect(page.locator(".brand .meta")).toHaveCount(0);
    await expect(page.locator(".brand .seg")).toHaveCount(0);
  });

  // The Device menu only shows under the Tauri shell; stub the bridge so its
  // grouping is testable in the browser.
  async function gotoWithDeviceMenu(page: Page, experimental: boolean): Promise<void> {
    await stubTauriBoot(page, { experimental_enabled: experimental });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await page.click("#btn-device");
    await expect(page.locator("#btn-fetch")).toBeVisible(); // the menu is open
  }

  test("the device menu groups live sync, transfers, MIDI, and the experimental self-test", async ({ page }) => {
    await gotoWithDeviceMenu(page, true);
    await expect(page.locator("#btn-midi")).toBeVisible();
    await expect(page.locator("#btn-selftest")).toBeVisible();
    await expect(page.locator("#device-menu .menu-sep[data-experimental-only]")).toBeVisible();
  });

  test("without --experimental MIDI stays but the self-test hides with its separator", async ({ page }) => {
    await gotoWithDeviceMenu(page, false);
    await expect(page.locator("#btn-midi")).toBeVisible();
    await expect(page.locator("#btn-selftest")).toBeHidden();
    await expect(page.locator("#device-menu .menu-sep[data-experimental-only]")).toBeHidden();
  });
});
