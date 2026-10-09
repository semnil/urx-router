import { test, expect, textContrast } from "./fixtures";
import { LIVE_COMMANDS, stubTauriDevice } from "./tauri-stub";

// What the toolbar says and refuses while a live session holds the device.
//
// The two are one statement: the session runs against the model the picker names
// (a mismatch is refused before any read), so the tally naming it as well was the
// same fact printed twice. The tally prints the tag alone, and the picker is what
// names the unit — which is why it must not be changeable underneath a session.

// The tally is the red lamp's colour written as text on its own tint.
test("the LIVE tally's tag clears AA in the light theme", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("urx-theme", "light"));
  await stubTauriDevice(page, { commands: LIVE_COMMANDS });
  await page.goto("/");
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#live-tally")).toHaveText("LIVE");
  expect(await textContrast(page, page.locator("#live-tally"))).toBeGreaterThanOrEqual(4.5);
});

test("a live session prints the tag alone and locks the model picker", async ({ page }) => {
  await stubTauriDevice(page, { commands: LIVE_COMMANDS });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await expect(page.locator("#model-picker")).toBeEnabled();

  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "true");

  // The tally says a session is on; which unit it is on is the picker's to say, and
  // the picker still says it while locked.
  await expect(page.locator("#live-tally")).toHaveText("LIVE");
  await expect(page.locator("#model-picker")).toBeDisabled();
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");

  // Ending the session hands the picker back — the lock belongs to the session, not
  // to a state a teardown can leave stuck on.
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("#live-tally")).toBeHidden();
  await expect(page.locator("#model-picker")).toBeEnabled();
});
