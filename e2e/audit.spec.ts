import { test, expect, type Page } from "@playwright/test";

// UI-layer audit regressions: gaps the interaction probes surfaced that the rest
// of the suite did not already pin. Each test locks in a verified-correct behaviour
// (model-switch selection reset, GRAPH/CONSOLE EQ sync, send-level grid bounds).

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const section = (page: Page, title: RegExp) =>
  page.locator("#inspector .insp-section", { has: page.locator("summary", { hasText: title }) });
// A console strip located by its scribble's exact node name (so "CH 1" never
// matches "CH 11/12").
const strip = (page: Page, name: string) => page.locator(".con-strip", { has: page.getByText(name, { exact: true }) });

test.describe("model switch clears the selection", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("urx-lang", "en");
      localStorage.setItem("urx-theme", "dark");
      localStorage.setItem("urx-model", "URX44V");
    });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  test("switching model drops a node selection and resets the inspector", async ({ page }) => {
    await node(page, "ch1").click();
    await expect(page.locator("#graph-host g.node.selected")).toHaveCount(1);
    await expect(page.locator("body")).toHaveClass(/has-selection/);
    expect(await page.locator("#inspector .param").count()).toBeGreaterThan(0);

    // URX22 has fewer channels; the URX44V selection cannot carry over. The plan is
    // clean (a bare selection is not a dirty edit), so the swap needs no discard.
    await page.locator("#model-picker").selectOption("URX22");
    await expect(page.locator("#model-picker")).toHaveValue("URX22");

    // Nothing stays selected, the mobile bottom-sheet flag clears, and the inspector
    // falls back to its no-selection legend instead of a stale channel's params.
    await expect(page.locator("#graph-host g.node.selected")).toHaveCount(0);
    await expect(page.locator("body")).not.toHaveClass(/has-selection/);
    await expect(page.locator("#inspector .param")).toHaveCount(0);
    await expect(page.locator("#inspector")).toContainText("Connection types");
  });

  test("switching model drops a selected connection's inspector", async ({ page }) => {
    // Select the fixed CH1 -> STEREO wire: the inspector shows its routing (From/To).
    await page.locator('.wire-hit[data-from="ch1:out"][data-to="bus.stereo:in"]').dispatchEvent("pointerdown");
    await expect(page.locator("#inspector")).toContainText("Connection");
    expect(await page.locator("#inspector .param").count()).toBeGreaterThan(0);

    await page.locator("#model-picker").selectOption("URX22");
    await expect(page.locator("#model-picker")).toHaveValue("URX22");

    // The wire's endpoints belong to the old plan; the inspector must not keep a
    // stale connection editor pointing at nodes the new model rebuilt.
    await expect(page.locator("#inspector .param")).toHaveCount(0);
    await expect(page.locator("#inspector")).toContainText("Connection types");
  });
});

test.describe("GRAPH <-> CONSOLE EQ sync", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("urx-lang", "en");
      localStorage.setItem("urx-theme", "dark");
      localStorage.setItem("urx-model", "URX44V");
    });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  test("a graph-side EQ off shows the console EQ chip released", async ({ page }) => {
    await node(page, "ch1").click();
    // EQ defaults on; the section's first param row is its ON/OFF toggle.
    await section(page, /^EQ$/).locator(".sec-body > .param").first().locator("button", { hasText: "OFF" }).click();

    await page.click("#btn-view-console");
    const eqChip = strip(page, "CH 1").locator(".con-chip", { hasText: /^EQ$/ }).first();
    await expect(eqChip).toHaveAttribute("aria-pressed", "false");
  });

  test("a console EQ chip toggle shows the graph inspector EQ off", async ({ page }) => {
    await page.click("#btn-view-console");
    const eqChip = strip(page, "CH 1").locator(".con-chip", { hasText: /^EQ$/ }).first();
    await expect(eqChip).toHaveAttribute("aria-pressed", "true"); // on by default
    await eqChip.click();
    await expect(eqChip).toHaveAttribute("aria-pressed", "false");

    await page.click("#btn-view-graph");
    await node(page, "ch1").click();
    // The EQ section's active toggle button reads OFF (its class survives the fold
    // an off section triggers, so no need to expand it first).
    await expect(section(page, /^EQ$/).locator(".sec-body > .param").first().locator(".toggle button.on")).toHaveText(
      "OFF",
    );
  });
});

test.describe("language switch re-localizes the graph chrome", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("urx-lang", "en");
      localStorage.setItem("urx-theme", "dark");
      // Empty board so in.aux is unconnected and therefore shelvable.
      localStorage.setItem("urx-seed", "empty");
      localStorage.setItem("urx-model", "URX44V");
    });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  test("a language switch re-localizes the hidden shelf", async ({ page }) => {
    // Shelve a node so the shelf chrome is on screen when the language flips.
    await node(page, "in.aux").click();
    await page.locator("#inspector button.subtle").click();
    await expect(page.locator(".hidden-shelf .shelf-showall")).toHaveText("Show all");

    // The shelf must repaint with the new messages immediately, not wait for the
    // next hide/restore to redraw it.
    await page.click("#btn-lang");
    await expect(page.locator(".hidden-shelf .shelf-showall")).toHaveText("全て表示");
  });

  test("a language switch re-localizes the selection bar", async ({ page }) => {
    // Two nodes selected brings up the floating multi-select bar (Ctrl works on
    // every platform under test: the app reads ctrlKey || metaKey).
    await node(page, "in.aux").click({ modifiers: ["Control"] });
    await node(page, "in.micline_1_2").click({ modifiers: ["Control"] });
    await expect(page.locator(".selbar-hide")).toHaveText("Hide 2");
    await expect(page.locator(".selbar-clear")).toHaveText("Clear");

    await page.click("#btn-lang");
    await expect(page.locator(".selbar-hide")).toHaveText("2 件を非表示");
    await expect(page.locator(".selbar-clear")).toHaveText("選択解除");
  });
});

test.describe("send-level fader snaps to the device grid", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("urx-lang", "en");
      localStorage.setItem("urx-theme", "dark");
      // Empty board: the fixed CH1 -> STEREO wire is deterministic at 0.0 dB.
      localStorage.setItem("urx-seed", "empty");
      localStorage.setItem("urx-model", "URX44V");
    });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  test("keyboard stepping floors at -inf and ceils at +10 dB", async ({ page }) => {
    await page.locator('.wire-hit[data-from="ch1:out"][data-to="bus.stereo:in"]').dispatchEvent("pointerdown");
    const levelRow = page.locator("#inspector .param", { hasText: "Level" }).first();
    const slider = levelRow.locator('input[type="range"]');
    // The index-based grid maps 0 = off (-inf) .. LEVEL_STEPS_DB.length = +10 dB.
    await expect(slider).toHaveAttribute("min", "0");
    await expect(slider).toHaveAttribute("max", "40");
    await expect(levelRow.locator(".param-val")).toHaveText("0.0 dB");

    // Step well past the bottom detent: the value floors at -inf and the readout
    // renders the infinity glyph wrapped in a .glyph-inf span (glyph.ts), not a
    // bare, shrunken "∞".
    await slider.focus();
    for (let i = 0; i < 50; i++) await page.keyboard.press("ArrowDown");
    await expect(slider).toHaveValue("0");
    await expect(levelRow.locator(".param-val")).toHaveText("-∞ dB");
    await expect(levelRow.locator(".param-val .glyph-inf")).toHaveText("∞");

    // Step well past the top detent: the value ceils at +10 dB.
    for (let i = 0; i < 60; i++) await page.keyboard.press("ArrowUp");
    await expect(slider).toHaveValue("40");
    await expect(levelRow.locator(".param-val")).toHaveText("+10.0 dB");
  });
});
