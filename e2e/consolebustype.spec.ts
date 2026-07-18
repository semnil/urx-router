import { test, expect, type Page } from "@playwright/test";

// The console runs against the factory plan (sends present), so we do NOT seed
// "empty" here — the CH → MIX sends the FIXED / Pan-Link locks act on exist.
const strip = (page: Page, name: string) => page.locator(".con-strip", { has: page.getByText(name, { exact: true }) });
const param = (page: Page, label: string) => page.locator("#inspector .param", { hasText: label });
// The CH 1 → MIX 1 send column (chip → PRE → mini-fader) in the SENDS rack.
const mix1Col = (page: Page) =>
  strip(page, "CH 1").locator(".con-scol", { has: page.getByRole("button", { name: "M1", exact: true }) });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-model", "URX44V");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("FIXED BUS Type locks the MIX send column fader read-only", async ({ page }) => {
  // Set MIX 1 to FIXED in the graph inspector, then view the console.
  await page.locator('g.node[data-id="bus.mix1"]').click();
  await param(page, "BUS Type").locator("select").selectOption("1"); // FIXED
  await page.click("#btn-view-console");

  const fader = mix1Col(page).locator(".con-vfad");
  await expect(fader).toHaveClass(/readonly/);
  await expect(fader).toHaveAttribute("aria-disabled", "true");
});

test("VARI (default) leaves the MIX send column fader editable", async ({ page }) => {
  await page.click("#btn-view-console");
  await expect(mix1Col(page).locator(".con-vfad")).not.toHaveClass(/readonly/);
});

test("Pan Link locks the SEND PAN knob read-only", async ({ page }) => {
  await page.locator('g.node[data-id="bus.mix1"]').click();
  await param(page, "Pan Link").locator("button", { hasText: "ON" }).click();
  await page.click("#btn-view-console");

  // Open CH 1's SEND PAN popover: its MIX 1 knob is read-only under Pan Link.
  await strip(page, "CH 1").locator(".con-panbtn").click();
  const knob = page.locator(".con-spop .pcol", { hasText: "MIX 1" }).locator(".con-knob");
  await expect(knob).toHaveClass(/readonly/);
  await expect(knob).toHaveAttribute("aria-disabled", "true");
});

test("a FIXED MIX bus leaves the head (STEREO main path) fader editable", async ({ page }) => {
  await page.locator('g.node[data-id="bus.mix1"]').click();
  await param(page, "BUS Type").locator("select").selectOption("1"); // FIXED
  await page.click("#btn-view-console");
  // FIXED gates the MIX send level, not the channel's → STEREO main fader.
  await expect(strip(page, "CH 1").locator(".con-fader")).not.toHaveClass(/readonly/);
});
