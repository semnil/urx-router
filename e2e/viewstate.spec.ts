import { test, expect, type Page } from "@playwright/test";

// GRAPH <-> CONSOLE are two views of one plan. These tests cover that an edit made
// in one view is read back in the other (both views funnel edits through
// markChanged, and switching back repaints the target view), for the head fader,
// the SENDS rack, and the MUTE chip.

// A console strip located by its scribble's exact node name (so "CH 1" never
// matches "CH 11/12"). Runs against the factory plan (no "empty" seed).
const strip = (page: Page, name: string) => page.locator(".con-strip", { has: page.getByText(name, { exact: true }) });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-model", "URX44V");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("a rack send-fader edit is read back on the graph's CH -> MIX wire", async ({ page }) => {
  await page.click("#btn-view-console");
  // Edit the CH 1 → MIX 1 send level in the SENDS rack column (Home = +10.0 dB max).
  const fader = strip(page, "CH 1")
    .locator(".con-scol", { has: page.getByRole("button", { name: "M1", exact: true }) })
    .locator(".con-vfad");
  await fader.focus();
  await page.keyboard.press("Home");
  // The header readout reflects the edited send.
  await expect(strip(page, "CH 1").locator(".con-sh .rdout")).toContainText("MIX 1 +10.0");

  // The same send level reads back on the graph's CH 1 -> MIX 1 wire.
  await page.click("#btn-view-graph");
  await page.locator('.wire-hit[data-from="ch1:out"][data-to="bus.mix1:in"]').dispatchEvent("pointerdown");
  await expect(page.locator("#inspector .param", { hasText: "Level" }).locator(".param-val")).toHaveText("+10.0 dB");
});

test("a console fader edit is read back on the graph's CH -> STEREO wire", async ({ page }) => {
  await page.click("#btn-view-console");
  const readout = strip(page, "CH 1").locator(".con-readout .rd:not(.mtr) .rv");
  await expect(readout).toHaveText("0.0");
  await strip(page, "CH 1").locator(".con-fader").focus();
  // Two detents up the level_gain grid: 0.0 -> +0.4 -> +1.2 dB.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(readout).toHaveText("+1.2");

  // The CH 1 main fader IS the CH1 -> STEREO send level; selecting that wire on
  // the graph must show the same +1.2 dB the console just set.
  await page.click("#btn-view-graph");
  await page.locator('.wire-hit[data-from="ch1:out"][data-to="bus.stereo:in"]').dispatchEvent("pointerdown");
  await expect(page.locator("#inspector .param", { hasText: "Level" }).locator(".param-val")).toHaveText("+1.2 dB");
});

test("a graph-side channel mute dims the console strip and unlights its power LED", async ({ page }) => {
  // Mute CH 1 from the graph inspector (the channel ON toggle), then open the
  // console: the console MUTE chip drives the → STEREO assign, so a channel-master
  // mute surfaces as the strip's dim + unlit scribble power LED, not the MUTE chip.
  await page.locator('g.node[data-id="ch1"]').click();
  const onToggle = page.locator("#inspector .param", { hasText: "Channel" }).first();
  // The channel ON/OFF toggle lives in the inspector; click its OFF button to mute.
  await onToggle.locator(".toggle button").filter({ hasText: /^OFF$/ }).click();

  await page.click("#btn-view-console");
  const ch = strip(page, "CH 1");
  await expect(ch).toHaveClass(/inactive/);
  await expect(ch.locator(".con-scribble.power")).toHaveAttribute("aria-pressed", "false");
});

test("a console MUTE persists across a GRAPH round-trip", async ({ page }) => {
  await page.click("#btn-view-console");
  const mute = strip(page, "CH 1").getByRole("button", { name: "MUTE" });
  await expect(mute).toHaveAttribute("aria-pressed", "false");
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true");

  await page.click("#btn-view-graph");
  await page.click("#btn-view-console");

  await expect(strip(page, "CH 1").getByRole("button", { name: "MUTE" })).toHaveAttribute("aria-pressed", "true");
});
