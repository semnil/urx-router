import { test, expect, type Page } from "@playwright/test";

// App-chrome behaviour: the theme and language toggles, and the canvas hit-test
// after a zoom. These cut across the whole UI (toolbar + graph + console), which
// the per-feature specs do not exercise. Each toggle button labels the state it
// switches TO, so its text flips after a click.

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

  test("toggling theme flips data-theme, the button label, and persists across reload", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");

    const html = page.locator("html");
    const btn = page.locator("#btn-theme");
    const start = await html.getAttribute("data-theme");
    const other = start === "dark" ? "light" : "dark";

    // The button names the theme it will switch to, i.e. the opposite of current.
    await expect(btn).toHaveText(other === "light" ? "Light" : "Dark");
    await btn.click();
    await expect(html).toHaveAttribute("data-theme", other);
    await expect(btn).toHaveText(other === "light" ? "Dark" : "Light"); // now names the way back
    await expect(page.locator("#statusbar")).toHaveText(`Switched to ${other} mode`);

    // The chosen theme survives a reload (localStorage), without snapping back to
    // the OS preference.
    await page.reload();
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await expect(html).toHaveAttribute("data-theme", other);
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

    // The button shows the language it switches to; clicking it re-localizes both
    // the toolbar (static i18n) and the already-rendered console (refresh()).
    await expect(page.locator("#btn-lang")).toHaveText("日本語");
    await page.click("#btn-lang");

    await expect(page.locator("#btn-view-graph")).toHaveText("グラフ");
    await expect(page.locator("#btn-hide-unused")).toHaveText("未接続を隠す");
    await expect(page.locator(".con-modelabel")).toHaveText("出力");
    await expect(page.locator("#btn-lang")).toHaveText("English"); // now names the way back
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
