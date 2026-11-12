// The HPF frequency is one of the sixty stops of the unit's own knob, 20 … 600 Hz. The control
// link takes a write only inside 40 … 120 Hz, so a stop outside that window is read from the
// unit and followed, never sent: offline the plan can hold any stop, and during Live sync the
// row offers the stops the session can send.
import { test, expect, type Page } from "./fixtures";
import { planParamZ } from "./plan-param";
import { LIVE_COMMANDS, notifyParam, setDeviceValue, stubTauriDevice, writesOf } from "./tauri-stub";
import { PARAMS } from "../src/core/control/params";

const HPF = PARAMS.HPF_FREQ.id;
const row = (page: Page) => page.locator('#inspector .param[data-param-label="HPF Freq"]');
const readout = (page: Page) => row(page).locator(".param-val");
const slider = (page: Page) => row(page).locator("input[type=range]");
const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const hint = (page: Page) => page.locator("#inspector").getByText("During Live sync this takes 40 to 118 Hz");
const hpfWrites = async (page: Page): Promise<number[]> =>
  (await writesOf(page)).filter(([id]) => id === HPF).map(([, v]) => v);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-disclaimer-accepted", "1");
  });
});

test("offline the row walks the knob's sixty stops, 20.0 to 600 Hz", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await node(page, "ch1").click();
  await expect(readout(page)).toHaveText("80.0 Hz");
  await expect(slider(page)).toHaveAttribute("max", "59");
  await slider(page).focus();
  await page.keyboard.press("End");
  await expect(readout(page)).toHaveText("600 Hz");
  await page.keyboard.press("Home");
  await expect(readout(page)).toHaveText("20.0 Hz");
  await page.keyboard.press("ArrowUp");
  await expect(readout(page)).toHaveText("21.2 Hz");
  await expect(hint(page)).toHaveCount(0);
});

// 120 Hz was a detent before System 1.5 and is between two stops of the 1.5 knob.
test("a document holding 120 Hz opens on 118 Hz, the nearest stop", async ({ page }) => {
  const plan = {
    format: "urx-router-plan",
    version: 1,
    modelId: "URX44V",
    connections: [],
    nodeParams: { ch1: { hpfFreq: 120 }, ch2: { hpfFreq: 250 } },
  };
  await page.goto(`/?plan=${planParamZ(plan)}`);
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await node(page, "ch1").click();
  await expect(readout(page)).toHaveText("118 Hz");
  await node(page, "ch2").click();
  await expect(readout(page), "a stop outside the link's window is kept as it stands").toHaveText("250 Hz");
});

test("live, a frequency the unit's knob put outside the window is shown, followed, and never written", async ({
  page,
}) => {
  await stubTauriDevice(page, { commands: LIVE_COMMANDS, values: { 766: 48000, 848: 0 } });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await setDeviceValue(page, HPF, 0, 2500);
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  await node(page, "ch1").click();
  await expect(readout(page), "what the unit holds").toHaveText("250 Hz");
  await expect(hint(page)).toBeVisible();
  await expect(slider(page), "the twenty stops the link writes").toHaveAttribute("max", "19");

  // A turn of the unit's own knob, to another stop outside the window: the app sends nothing
  // there, so only the follow registration can carry it.
  await setDeviceValue(page, HPF, 0, 3000);
  await notifyParam(page, HPF, 0, 3000);
  await expect(readout(page)).toHaveText("300 Hz");
  expect(await hpfWrites(page), "nothing written so far").toEqual([]);

  // From outside the window a step lands on its nearer end, which the session can send.
  await slider(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(readout(page)).toHaveText("118 Hz");
  await expect.poll(() => hpfWrites(page)).toEqual([1180]);

  // Undoing that would put 300 Hz back in the plan, which the session cannot send: the step is
  // held back, and the unit and the plan stay together.
  // Pressed until the session answers for the entry: while the write is still settling, undo
  // is refused as busy, and a held-back entry stays in the history, so a second press asks again.
  await page.locator("#graph-host").click({ position: { x: 5, y: 5 } });
  await expect(async () => {
    await page.keyboard.press("ControlOrMeta+z");
    await expect(page.locator("#statusbar")).toContainText("outside 40 to 120 Hz, which Live sync cannot send", {
      timeout: 500,
    });
  }).toPass({ timeout: 20_000 });
  await node(page, "ch1").click();
  await expect(readout(page)).toHaveText("118 Hz");
  expect(await hpfWrites(page)).toEqual([1180]);
});
