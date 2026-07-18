import { test, expect } from "@playwright/test";

// The block diagram flags the stereo-channel (CH 5/6–11/12) EQ as disabled at
// 176.4 / 192 kHz. The app still shows that EQ as editable, so a top-of-panel
// sample-rate note is the only cue — it must appear at 176.4 / 192 kHz and not at
// 96 kHz. Sits alongside the existing INS FX / FX2 notes.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

const stereoEqNote = (page: import("@playwright/test").Page) =>
  page.locator("#inspector .warning-line", { hasText: "Stereo channel (CH 5/6–11/12) EQ" });

test("the stereo-channel EQ note appears at 176.4 / 192 kHz, not at 96 kHz", async ({ page }) => {
  await expect(stereoEqNote(page)).toHaveCount(0); // default 48 kHz

  await page.locator("#rate-picker").selectOption("96000");
  await expect(stereoEqNote(page)).toHaveCount(0);

  await page.locator("#rate-picker").selectOption("176400");
  await expect(stereoEqNote(page)).toHaveCount(1);

  await page.locator("#rate-picker").selectOption("192000");
  await expect(stereoEqNote(page)).toHaveCount(1);
});

// The EQ section (stereo channel) locks to OFF with a disabled toggle at 176.4 /
// 192 kHz, and returns to an interactive toggle at 96 kHz and below.
const eqSection = (page: import("@playwright/test").Page) =>
  page.locator("#inspector details.insp-section").filter({ has: page.locator('summary:has-text("EQ")') });
// The section's own ON/OFF toggle is its first .param row (the 1-knob toggle, when
// present, is a later row labeled "1-knob").
const eqToggle = (page: import("@playwright/test").Page) => eqSection(page).locator(".sec-body > .param").first();

test("the stereo-channel EQ toggle is forced off and disabled at 192 kHz", async ({ page }) => {
  await page.locator('#graph-host g.node[data-id="ch_5_6"]').click();

  // At 48 kHz the ON/OFF buttons are live.
  await expect(eqToggle(page).locator("button", { hasText: "ON" })).toBeEnabled();

  await page.locator("#rate-picker").selectOption("192000");
  await page.locator('#graph-host g.node[data-id="ch_5_6"]').click();
  const onBtn = eqToggle(page).locator("button", { hasText: "ON" });
  const offBtn = eqToggle(page).locator("button", { hasText: "OFF" });
  await expect(onBtn).toBeDisabled();
  await expect(offBtn).toBeDisabled();
  // Forced off: OFF is the highlighted state.
  await expect(offBtn).toHaveClass(/on/);
  await expect(onBtn).not.toHaveClass(/on/);

  // Lowering the rate restores the interactive toggle.
  await page.locator("#rate-picker").selectOption("48000");
  await page.locator('#graph-host g.node[data-id="ch_5_6"]').click();
  await expect(eqToggle(page).locator("button", { hasText: "ON" })).toBeEnabled();
});
