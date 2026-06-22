import { test, expect, type Page } from "@playwright/test";

// GRAPH <-> CONSOLE are two views of one plan. These tests cover the state that
// must carry across a view round-trip: the console's selected send mode, and the
// fact that an edit made in one view is read back in the other (both views funnel
// edits through markChanged, and switching back repaints the target view).

// A console strip located by its scribble's exact node name (so "CH 1" never
// matches "CH 11/12"). Runs against the factory plan (no "empty" seed).
const strip = (page: Page, name: string) =>
  page.locator(".con-strip", { has: page.getByText(name, { exact: true }) });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-model", "URX44V");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("the console send-mode tab survives a GRAPH round-trip", async ({ page }) => {
  await page.click("#btn-view-console");
  const mix1 = page.locator(".con-modepick").getByRole("button", { name: "MIX 1", exact: true });
  await mix1.click();
  await expect(mix1).toHaveAttribute("aria-pressed", "true");

  // Bounce out to the graph and back; the console keeps its selected send mode
  // rather than resetting to MAIN.
  await page.click("#btn-view-graph");
  await expect(page.locator("#graph-host")).toBeVisible();
  await page.click("#btn-view-console");

  await expect(page.locator(".con-modepick").getByRole("button", { name: "MIX 1", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // The strips re-rendered into the MIX 1 send view, not MAIN: a send mode shows
  // only the bus's sources, so the master strip is gone while CH 1 stays.
  await expect(strip(page, "CH 1")).toBeVisible();
  await expect(strip(page, "STEREO (MAIN)")).toHaveCount(0);
});

test("a console fader edit is read back on the graph's CH -> STEREO wire", async ({ page }) => {
  await page.click("#btn-view-console");
  const readout = strip(page, "CH 1").locator(".con-readout .db");
  await expect(readout).toHaveText("0.0");
  await strip(page, "CH 1").locator(".con-fader").focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(readout).toHaveText("+2.0");

  // The CH 1 main fader IS the CH1 -> STEREO send level; selecting that wire on
  // the graph must show the same +2.0 dB the console just set.
  await page.click("#btn-view-graph");
  await page.locator('.wire-hit[data-from="ch1:out"][data-to="bus.stereo:in"]').dispatchEvent("pointerdown");
  await expect(
    page.locator("#inspector .param", { hasText: "Level" }).locator(".param-val"),
  ).toHaveText("+2.0 dB");
});

test("a graph-side mute is reflected on the console strip", async ({ page }) => {
  // Mute CH 1 from the graph inspector (the channel ON toggle), then open the
  // console: its MUTE chip must already read pressed.
  await page.locator('g.node[data-id="ch1"]').click();
  const onToggle = page.locator("#inspector .param", { hasText: "Channel" }).first();
  // The channel ON/OFF toggle lives in the inspector; click its OFF button to mute.
  await onToggle.locator(".toggle button").filter({ hasText: /^OFF$/ }).click();

  await page.click("#btn-view-console");
  await expect(strip(page, "CH 1").getByRole("button", { name: "MUTE" })).toHaveAttribute("aria-pressed", "true");
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
