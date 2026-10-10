import { test, expect, type Page } from "./fixtures";
import { LIVE_COMMANDS, deviceValueOf, notifyBurst, setDeviceValue, stubTauriDevice, writesOf } from "./tauri-stub";
import { PARAMS } from "../src/core/control/params";

// An edit made in the Inspector straight after a device-side change has been followed. The
// unit's own panel turns CH 1's HPF on; the follow layer re-reads the node and reflects it;
// the operator turns it back off the moment the panel shows it. That edit has to reach the
// unit and stay — the whole-device read the session runs once it has been idle reads the
// unit's value back, and it must find the operator's OFF there rather than put the ON back.

const hpfRow = (page: Page) =>
  page
    .locator("#inspector .param")
    .filter({ has: page.locator(".toggle") })
    .filter({ hasText: "HPF" })
    .first();

test("an edit made right after a scoped follow read reaches the unit and stays", async ({ page }) => {
  test.setTimeout(120_000);
  await stubTauriDevice(page, { commands: LIVE_COMMANDS, values: { 766: 48000, 848: 0 } });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  await page.locator(`#graph-host g.node[data-id="ch1"]`).click();
  await expect(hpfRow(page).locator("button.on")).toHaveText("OFF");

  // CH 1 is y 0. The unit's panel turns its HPF on, announced as the unit announces it.
  await setDeviceValue(page, PARAMS.HPF_ON.id, 0, 1);
  await notifyBurst(page, [{ paramId: PARAMS.HPF_ON.id, y: 0, value: 1 }]);
  // The read that notify schedules is scoped to the node, and its line says how much it read.
  await expect(page.locator("#statusbar")).toHaveText(/^← device \(\d{1,2}\)$/, { timeout: 30_000 });
  await expect(hpfRow(page).locator("button.on")).toHaveText("ON");

  // Straight back off, while the session is still settling the follow.
  await hpfRow(page).getByRole("button", { name: "OFF", exact: true }).click();
  await expect
    .poll(async () => (await writesOf(page)).filter(([id]) => id === PARAMS.HPF_ON.id))
    .toEqual([[PARAMS.HPF_ON.id, 0]]);

  // The whole-device read an idle session runs: its line names the whole read, and it is
  // the read that would put the unit's ON back if the edit had not reached the unit.
  await expect(page.locator("#statusbar")).toHaveText(/^← device \(\d{3,}\)$/, { timeout: 30_000 });
  expect(await deviceValueOf(page, PARAMS.HPF_ON.id, 0)).toBe(0);
  await page.locator(`#graph-host g.node[data-id="ch1"]`).click();
  await expect(hpfRow(page).locator("button.on")).toHaveText("OFF");
});
