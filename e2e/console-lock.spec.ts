import { test, expect, type Page } from "./fixtures";
import { LIVE_COMMANDS, notifyParam, setDeviceValue, stubTauriDevice, writesOf } from "./tauri-stub";
import { PARAMS } from "../src/core/control/params";

// The unit's Console Lock (System 1.5). The unit goes on taking writes over the link while it is
// locked, so the app holds its own back during a live session: the strip above the board says so,
// an edit that would be written is put back unsent, and an operation outside the plan is refused.
// The session goes on reading the unit, and the strip goes when the unit is unlocked.

const LOCK: number = PARAMS.CONSOLE_LOCK.id;
const OSC_ON: number = PARAMS.OSC_ON.id;
const CUE_MODE: number = PARAMS.CUE_MODE.id;

const strip = (page: Page) => page.locator("#lock-strip");
const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const oscRow = (page: Page) =>
  page
    .locator("#inspector .param")
    .filter({ has: page.locator(".toggle") })
    .filter({ hasText: "Oscillator" });
const writesTo = (page: Page, id: number) => writesOf(page).then((w) => w.filter(([p]) => p === id));

test.beforeEach(async ({ page }) => {
  await stubTauriDevice(page, { commands: LIVE_COMMANDS });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

async function goLive(page: Page): Promise<void> {
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
}

test("a locked unit shows the strip, and an edit is put back with nothing sent", async ({ page }) => {
  await setDeviceValue(page, LOCK, 0, 1);
  await expect(strip(page)).toBeHidden();
  await goLive(page);
  await expect(strip(page)).toBeVisible();
  await expect(strip(page)).toContainText("Console Lock");
  await expect(strip(page)).toContainText("The unit is locked.");

  await node(page, "bus.osc").click();
  await oscRow(page).getByRole("button", { name: "ON", exact: true }).click();
  await expect(page.locator("#statusbar")).toHaveText(
    "The unit is under Console Lock, so this edit was not sent and has been put back",
  );
  await expect(oscRow(page).locator("button.on")).toHaveText("OFF");
  expect(await writesTo(page, OSC_ON)).toEqual([]);

  // Unlocked on the unit: the strip goes, and the next edit is sent.
  await setDeviceValue(page, LOCK, 0, 0);
  await notifyParam(page, LOCK, 0, 0);
  await expect(strip(page)).toBeHidden();
  await oscRow(page).getByRole("button", { name: "ON", exact: true }).click();
  await expect.poll(() => writesTo(page, OSC_ON)).toEqual([[OSC_ON, 1]]);
});

test("a lock that arrives during the session refuses CUE Mode, and the strip goes with the session", async ({
  page,
}) => {
  await goLive(page);
  await expect(strip(page)).toBeHidden();
  await setDeviceValue(page, LOCK, 0, 1);
  await notifyParam(page, LOCK, 0, 1);
  await expect(strip(page)).toBeVisible();

  await page.locator("#cue-mode-last").click();
  await expect(page.locator("#statusbar")).toHaveText("The unit is under Console Lock, so nothing was sent");
  await expect(page.locator("#cue-mode-last")).toHaveAttribute("aria-pressed", "false");
  expect(await writesTo(page, CUE_MODE)).toEqual([]);

  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "false");
  await expect(strip(page)).toBeHidden();
});

// A strip of its own between the toolbar and the board: the board moves down by its height and no
// further, and the window does not scroll for it.
test("the strip takes the width of the window above the board @webkit", async ({ page }) => {
  await setDeviceValue(page, LOCK, 0, 1);
  await goLive(page);
  await expect(strip(page)).toBeVisible();
  const box = await strip(page).boundingBox();
  const stage = await page.locator("#stage").boundingBox();
  const view = page.viewportSize()!;
  expect(box!.x).toBe(0);
  expect(Math.round(box!.width)).toBe(view.width);
  expect(Math.round(stage!.y)).toBe(Math.round(box!.y + box!.height));
  expect(await page.evaluate(() => document.scrollingElement!.scrollHeight <= window.innerHeight)).toBe(true);
});
