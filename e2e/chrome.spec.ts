import { test, expect, type Page } from "@playwright/test";
import { stubTauriBoot } from "./tauri-stub";
import { drag, port } from "./graph-helpers";

// App-chrome behaviour: the theme and language rows in the Preferences modal
// (moved off the toolbar), the toolbar brand and Device-menu grouping, and the
// canvas hit-test after a zoom. These cut across the whole UI (toolbar + graph
// + console), which the per-feature specs do not exercise.

const wires = (page: Page) => page.locator("#graph-host .wire-hit");

// Pick one Preferences dropdown value and close the modal again (the tests
// that assert intermediate modal state keep the steps inline instead).
async function pickPref(page: Page, selector: string, value: string): Promise<void> {
  await page.click("#btn-prefs");
  await page.selectOption(selector, value);
  await page.click("#prefs-modal .consent-btn-primary");
}

const connect = (page: Page, fromRef: string, toRef: string): Promise<void> =>
  drag(page, port(page, fromRef), port(page, toRef));

test.describe("theme", () => {
  test.beforeEach(async ({ page }) => {
    // Pin lang+model but NOT theme, so the toggle's localStorage write is what
    // drives the post-reload state (the beforeEach init script never re-pins it).
    await page.addInitScript(() => {
      localStorage.setItem("urx-lang", "en");
      localStorage.setItem("urx-model", "URX44V");
    });
  });

  test("the Preferences theme row applies each mode and persists the choice", async ({ page }) => {
    // Pin a dark OS so auto resolves predictably to dark.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");

    const html = page.locator("html");
    await page.click("#btn-prefs");
    const sel = page.locator("#prefs-theme");

    // No saved choice → auto, which under a dark OS resolves to dark.
    await expect(sel).toHaveValue("auto");
    await expect(html).toHaveAttribute("data-theme", "dark");

    // Each pick applies immediately behind the open modal.
    await sel.selectOption("light");
    await expect(html).toHaveAttribute("data-theme", "light");
    await expect(page.locator("#statusbar")).toHaveText("Switched to light mode");

    await sel.selectOption("dark");
    await expect(html).toHaveAttribute("data-theme", "dark");

    // Back to auto (follows the OS again = dark here).
    await sel.selectOption("auto");
    await expect(html).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("#statusbar")).toHaveText("Following the system theme");

    // The chosen mode survives a reload: pick light, reload, expect light again.
    await sel.selectOption("light");
    await page.reload();
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await expect(html).toHaveAttribute("data-theme", "light");
    await page.click("#btn-prefs");
    await expect(page.locator("#prefs-theme")).toHaveValue("light");
  });

  test("auto mode follows a live OS color-scheme change", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    const html = page.locator("html");
    // Default (no saved choice) is auto; a light OS resolves to light.
    await expect(html).toHaveAttribute("data-theme", "light");

    // Flipping the OS preference repaints without any interaction while in auto.
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(html).toHaveAttribute("data-theme", "dark");
  });

  test("changing the theme inside the console view keeps the console rendered", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await page.click("#btn-view-console");
    await expect(page.locator("#console-host")).toBeVisible();
    const strips = await page.locator(".con-strip").count();

    await pickPref(page, "#prefs-theme", "light");

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

  test("switching to Japanese relocalizes the modal, the toolbar and the console live", async ({ page }) => {
    await expect(page.locator("#btn-view-graph")).toHaveText("Graph");
    await page.click("#btn-view-console");
    // The first strip-group label is INPUTS (the rack's SENDS label stays English).
    await expect(page.locator(".con-grouplabel").first()).toHaveText("INPUTS");

    // The language dropdown lives in Preferences; picking 日本語 re-localizes the
    // open modal itself, the toolbar (static i18n), and the rendered console.
    await page.click("#btn-prefs");
    await expect(page.locator("#prefs-lang")).toHaveValue("en");
    await page.selectOption("#prefs-lang", "ja");
    await expect(page.locator("#prefs-title")).toHaveText("環境設定");
    await expect(page.locator("#prefs-lang")).toHaveValue("ja");
    await page.click("#prefs-modal .consent-btn-primary");

    await expect(page.locator("#btn-view-graph")).toHaveText("グラフ");
    await expect(page.locator("#btn-hide-unused")).toHaveText("未接続を隠す");
    await expect(page.locator(".con-grouplabel").first()).toHaveText("入力");
  });

  test("an open selection survives a language switch with the inspector intact", async ({ page }) => {
    await page.locator('g.node[data-id="ch1"]').click();
    const params = await page.locator("#inspector .param").count();
    expect(params).toBeGreaterThan(0);
    await expect(page.locator("body")).toHaveClass(/has-selection/);

    await pickPref(page, "#prefs-lang", "ja");

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
