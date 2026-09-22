import { test, expect, type Page } from "./fixtures";
import { planParamZ } from "./plan-param";
import { LIVE_COMMANDS, notifyBurst, notifyParam, setDeviceValue, stubTauriDevice, writesOf } from "./tauri-stub";
import { PARAMS } from "../src/core/control/params";

// +48V and HI-Z are never on together in the app, and A.Gain stops at +40 dB while HI-Z is
// on (docs/en/known-issues.md, "The unit lets +48V and HI-Z be on together; the app does not").

const LOCKED_48V = "Turn Hi-Z off first — +48V and Hi-Z are never on together";
const LOCKED_HIZ = "Turn +48V off first — +48V and Hi-Z are never on together";

const planWith = (ch3: Record<string, unknown>) => ({
  format: "urx-router-plan",
  version: 2,
  modelId: "URX44V",
  connections: [],
  nodeParams: { ch3 },
});

const open = async (page: Page, ch3: Record<string, unknown>): Promise<void> => {
  await page.goto(`/?plan=${planParamZ(planWith(ch3))}`);
  await page.locator("#model-picker").waitFor();
};

const row = (page: Page, label: string) =>
  page
    .locator("#inspector .param")
    .filter({ has: page.locator(".toggle") })
    .filter({ hasText: label });
const gainSlider = (page: Page) =>
  page.locator("#inspector .param", { hasText: "A.Gain" }).locator("input[type=range]");
// The plan's value as the row prints it. A range input clamps what it shows to its own max,
// so the slider alone cannot tell a lowered value from a clamped display.
const gainText = (page: Page) => page.locator("#inspector .param", { hasText: "A.Gain" }).locator(".param-val");
const selectCh3 = (page: Page) => page.locator(`#graph-host g.node[data-id="ch3"]`).click();

const strip = (page: Page, name: string) => page.locator(".con-strip", { has: page.getByText(name, { exact: true }) });
const chip = (page: Page, label: string) => strip(page, "CH 3").locator(".con-chip", { hasText: label }).first();
const gainKnob = (page: Page) => strip(page, "CH 3").locator(".con-knob[aria-label='A.GAIN']");
const gainValue = (page: Page) =>
  strip(page, "CH 3")
    .locator(".con-gain", { has: page.locator(".con-knob[aria-label='A.GAIN']") })
    .locator(".val");

test("the Inspector refuses +48V ON while HI-Z is on, says why, and narrows A.Gain", async ({ page }) => {
  await open(page, { hiZ: true, phantom: false, gain: 30 });
  await selectCh3(page);
  const phantom = row(page, "+48V");
  await expect(phantom).toHaveAttribute("title", LOCKED_48V);
  await expect(phantom.getByRole("button", { name: "ON", exact: true })).toBeDisabled();
  // HI-Z, the lit one, can still be turned off.
  const hiZ = row(page, "Hi-Z");
  await expect(hiZ.getByRole("button", { name: "OFF", exact: true })).toBeEnabled();
  await expect(gainSlider(page)).toHaveAttribute("max", "40");
  await hiZ.getByRole("button", { name: "OFF", exact: true }).click();
  await expect(row(page, "+48V").getByRole("button", { name: "ON", exact: true })).toBeEnabled();
  await expect(gainSlider(page)).toHaveAttribute("max", "70");
  // …and the mirror: with +48V on, HI-Z's ON cannot be pressed.
  await row(page, "+48V").getByRole("button", { name: "ON", exact: true }).click();
  await expect(row(page, "Hi-Z")).toHaveAttribute("title", LOCKED_HIZ);
  await expect(row(page, "Hi-Z").getByRole("button", { name: "ON", exact: true })).toBeDisabled();
});

test("turning HI-Z on lowers A.Gain to +40 dB in one undo step", async ({ page }) => {
  await open(page, { hiZ: false, phantom: false, gain: 60 });
  await selectCh3(page);
  await expect(gainText(page)).toHaveText("+60 dB");
  await row(page, "Hi-Z").getByRole("button", { name: "ON", exact: true }).click();
  await expect(gainText(page)).toHaveText("+40 dB");
  await expect(gainSlider(page)).toHaveAttribute("max", "40");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(row(page, "Hi-Z").locator("button.on")).toHaveText("OFF");
  await expect(gainText(page)).toHaveText("+60 dB");
});

test("the CONSOLE chips follow the same rule, and the A.GAIN knob stops at +40 under HI-Z", async ({ page }) => {
  await open(page, { hiZ: true, phantom: false, gain: 40 });
  await page.click("#btn-view-console");
  await expect(chip(page, "+48")).toHaveClass(/readonly/);
  await expect(chip(page, "+48")).toHaveAttribute("aria-disabled", "true");
  await expect(chip(page, "+48")).toHaveAttribute("title", LOCKED_48V);
  await gainKnob(page).focus();
  await page.keyboard.press("ArrowUp");
  await expect(gainValue(page)).toHaveText("+40");
  // HI-Z off: the chip it locked is live again, and the knob reaches past +40.
  await chip(page, "Hi-Z").click();
  await expect(chip(page, "+48")).not.toHaveClass(/readonly/);
  await gainKnob(page).focus();
  await page.keyboard.press("ArrowUp");
  await expect(gainValue(page)).toHaveText("+41");
  await chip(page, "+48").click();
  await expect(chip(page, "Hi-Z")).toHaveAttribute("title", LOCKED_HIZ);
});

test("a document holding both on opens with +48V off and says so", async ({ page }) => {
  await open(page, { hiZ: true, phantom: true, gain: 60 });
  await expect(page.locator("#statusbar")).toContainText(
    "2 stored values were outside what this app can write, and now read as the nearest value it can send",
  );
  await selectCh3(page);
  await expect(row(page, "+48V").locator("button.on")).toHaveText("OFF");
  await expect(row(page, "Hi-Z").locator("button.on")).toHaveText("ON");
  await expect(gainText(page)).toHaveText("+40 dB");
});

test("a device read finding both on keeps the unit's state and says so", async ({ page }) => {
  // vd_get answers by paramId with no y axis, so every jack reports +48V (0) and HI-Z (6) on.
  await stubTauriDevice(page, { values: { 0: 1, 6: 1, 766: 48000, 848: 0 }, confirm: "Ok" });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-device");
  await page.click("#btn-fetch");
  await expect(page.locator("#statusbar")).toContainText("Fetched", { timeout: 20000 });
  await expect(page.locator("#statusbar")).toContainText("+48V and Hi-Z are both on for CH 3, CH 4");
  expect(
    (await writesOf(page)).filter(([id]) => id === 0 || id === 6),
    "nothing written for it",
  ).toEqual([]);
  await selectCh3(page);
  await expect(row(page, "+48V").locator("button.on")).toHaveText("ON");
  await expect(row(page, "Hi-Z").locator("button.on")).toHaveText("ON");
});

test("starting Live sync on a unit holding both on keeps its state and says so", async ({ page }) => {
  await stubTauriDevice(page, { commands: LIVE_COMMANDS, values: { 0: 1, 6: 1, 766: 48000, 848: 0 } });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
  await expect(page.locator("#statusbar")).toContainText("+48V and Hi-Z are both on for CH 3, CH 4");
  expect(
    (await writesOf(page)).filter(([id]) => id === 0 || id === 6),
    "nothing written for it",
  ).toEqual([]);
});

test("a device follow finding both on says so, and again once the unit turns one back on", async ({ page }) => {
  test.setTimeout(120_000);
  await stubTauriDevice(page, { commands: LIVE_COMMANDS });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
  // CH 3 is y 2. The unit's panel turns HI-Z and +48V on, announced as one batch.
  await setDeviceValue(page, PARAMS.HI_Z.id, 2, 1);
  await setDeviceValue(page, PARAMS.PHANTOM.id, 2, 1);
  await notifyBurst(page, [
    { paramId: PARAMS.HI_Z.id, y: 2, value: 1 },
    { paramId: PARAMS.PHANTOM.id, y: 2, value: 1 },
  ]);
  const note = "+48V and Hi-Z are both on for CH 3";
  // The reconcile read the notify schedules leads its own line with the note.
  await expect(page.locator("#statusbar")).toContainText(`${note} — ← device`, { timeout: 30_000 });
  await selectCh3(page);
  await expect(row(page, "+48V").locator("button.on")).toHaveText("ON");
  await expect(row(page, "Hi-Z").locator("button.on")).toHaveText("ON");
  // The panel turns +48V off: the note goes; turned back on, it returns.
  await setDeviceValue(page, PARAMS.PHANTOM.id, 2, 0);
  await notifyParam(page, PARAMS.PHANTOM.id, 2, 0);
  await expect(row(page, "+48V").locator("button.on")).toHaveText("OFF", { timeout: 30_000 });
  await expect(page.locator("#statusbar")).not.toContainText(note, { timeout: 30_000 });
  await setDeviceValue(page, PARAMS.PHANTOM.id, 2, 1);
  await notifyParam(page, PARAMS.PHANTOM.id, 2, 1);
  await expect(page.locator("#statusbar")).toContainText(note, { timeout: 30_000 });
  expect(
    (await writesOf(page)).filter(([id]) => id === PARAMS.PHANTOM.id || id === PARAMS.HI_Z.id),
    "nothing written for it",
  ).toEqual([]);
});
