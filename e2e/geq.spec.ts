// Flex12GEQ (System firmware V1.5): the 31-band graphic EQ an output bus runs in place of its
// 4band PEQ, chosen by the Inspector's EQ Type. The screen's faders make the unit's own moves —
// 0.5 dB steps inside the side's GEQ Limit, and no more than twelve bands away from 0 dB — and
// during Live sync STEREO's bands above 20 Hz are the unit's alone: the control link takes no
// write to them, so they show the unit's value and follow it.
import { test, expect, type Locator, type Page } from "./fixtures";
import { chooseOption } from "./choose-option";
import { planParamZ } from "./plan-param";
import { deviceValueOf, LIVE_COMMANDS, notifyParam, setDeviceValue, stubTauriDevice } from "./tauri-stub";
import { PARAMS } from "../src/core/control/params";
import { en } from "../src/i18n/en";

const STEREO_TYPE = PARAMS.STEREO_EQ_TYPE.id;
const STEREO_EQ_ON = PARAMS.STEREO_EQ_ON.id;
const STEREO_BAND = PARAMS.STEREO_GEQ_BAND.id;

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const box = (page: Page) => page.locator("#dyn-screen-box");
const card = (page: Page, x: number) => box(page).locator(`.gt-fader[data-dyn-fader="band${x}"]`);
const fader = (page: Page, x: number) => card(page, x).locator("input");
const reading = (page: Page, x: number) => card(page, x).locator(".gt-val");
const available = (page: Page) =>
  box(page).locator(".prefs-row", { hasText: en.dynTuning.geq.available }).locator(".param-val");
const eqType = (sec: Locator) => sec.locator('.param[data-param-label="EQ Type"] select');

/** The node's EQ section in the Inspector, opened. */
async function eqSection(page: Page, id: string): Promise<Locator> {
  await node(page, id).click();
  const sec = page.locator("#inspector .insp-section", { has: page.locator("summary", { hasText: /^EQ$/ }) });
  if (!(await sec.evaluate((el) => (el as HTMLDetailsElement).open))) await sec.locator("summary").click();
  return sec;
}

const closeScreen = (page: Page) => page.locator("#dyn-screen-modal .consent-btn-secondary").click();

/** Step a fader with the keyboard, as many presses as `n` says (down for a negative `n`). */
async function step(page: Page, x: number, n: number): Promise<void> {
  await fader(page, x).focus();
  for (let i = 0; i < Math.abs(n); i++) await page.keyboard.press(n > 0 ? "ArrowUp" : "ArrowDown");
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-model", "URX44V");
    localStorage.setItem("urx-disclaimer-accepted", "1");
  });
});

test("the EQ Type picks the screen a bus's EQ opens, and a fader steps 0.5 dB", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  const sec = await eqSection(page, "bus.mix1");
  await expect(sec.locator("#btn-eq-screen"), "4band PEQ, as a bus ships").toBeVisible();
  await chooseOption(eqType(sec), "2");
  await expect(sec.locator("#btn-eq-screen")).toHaveCount(0);
  await sec.locator("#btn-geq-screen").click();
  await expect(box(page)).toBeVisible();
  await expect(box(page).locator(".gt-fader")).toHaveCount(31);
  await expect(card(page, 17).locator(".lbl")).toHaveText("1k");

  await step(page, 17, 2);
  await expect(reading(page, 17)).toHaveText("+1.0");
  await expect(fader(page, 17), "the re-lock as the band left 0 dB kept the fader focused").toBeFocused();
  await expect(available(page)).toHaveText("11");
  await closeScreen(page);

  // The CONSOLE strip's EQ opener follows the type too.
  await page.click("#btn-view-console");
  await page.locator('[data-dyn-node="bus.mix1"][data-dyn-open="geq"]').click();
  await expect(box(page)).toBeVisible();
  await expect(reading(page, 17)).toHaveText("+1.0");
});

test("twelve bands away from 0 dB shut the rest until one returns", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  const sec = await eqSection(page, "bus.mix2");
  await chooseOption(eqType(sec), "2");
  await sec.locator("#btn-geq-screen").click();
  await expect(box(page)).toBeVisible();

  for (let x = 0; x < 12; x++) await step(page, x, -1);
  await expect(available(page)).toHaveText("0");
  await expect(fader(page, 20)).toBeDisabled();
  await expect(card(page, 20)).toHaveAttribute("title", en.dynTuning.geq.full);
  await expect(fader(page, 20)).toHaveAttribute("aria-description", en.dynTuning.geq.full);
  await expect(fader(page, 3), "a band already in use still moves").toBeEnabled();

  await step(page, 3, 1);
  await expect(reading(page, 3)).toHaveText("0.0");
  await expect(fader(page, 20)).toBeEnabled();
  await expect(available(page)).toHaveText("1");
});

test("a rate above 48 kHz puts a bus back to 4band PEQ, says which, and holds the EQ Type", async ({ page }) => {
  await page.goto(
    `/?plan=${planParamZ({
      format: "urx-router-plan",
      version: 6,
      modelId: "URX44V",
      connections: [],
      nodeParams: { "bus.mix1": { eqType: 2 } },
    })}`,
  );
  await expect(page.locator("#statusbar")).toContainText(en.status.planLoaded);
  await page.locator("#rate-picker").evaluate((el: HTMLSelectElement) => {
    el.value = "88200";
    el.dispatchEvent(new Event("change"));
  });
  await expect(page.locator("#statusbar")).toContainText("MIX 1 went back to 4band PEQ");
  const sec = await eqSection(page, "bus.mix1");
  await expect(eqType(sec)).toHaveValue("0");
  await expect(eqType(sec)).toBeDisabled();
  await expect(sec).toContainText(en.inspector.geqRateLocked);
  await expect(sec.locator("#btn-eq-screen")).toBeVisible();
});

test("live, STEREO's bands above 20 Hz show the unit's value, follow it, and are never written", async ({ page }) => {
  await stubTauriDevice(page, {
    commands: LIVE_COMMANDS,
    values: { 766: 48000, 848: 0, [STEREO_TYPE]: 2, [STEREO_EQ_ON]: 1 },
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await setDeviceValue(page, STEREO_BAND, 0, -300, 5);
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });

  const sec = await eqSection(page, "bus.stereo");
  await expect(eqType(sec), "the unit's own type").toHaveValue("2");
  await sec.locator("#btn-geq-screen").click();
  await expect(box(page)).toBeVisible();
  await expect(reading(page, 5), "what the unit holds").toHaveText("-3.0");
  await expect(fader(page, 5)).toBeDisabled();
  await expect(card(page, 5)).toHaveAttribute("title", en.dynTuning.geq.unwritable);
  await expect(fader(page, 0), "the 20 Hz band takes a write").toBeEnabled();

  // A move on the unit's own GEQ screen: the app writes nothing there, so only the follow
  // registration can carry it.
  await setDeviceValue(page, STEREO_BAND, 0, -600, 5);
  await notifyParam(page, STEREO_BAND, 0, -600, 5);
  await expect(reading(page, 5)).toHaveText("-6.0");

  // The 20 Hz band is the session's to write.
  await step(page, 0, 1);
  await expect.poll(() => deviceValueOf(page, STEREO_BAND, 0, 0)).toBe(50);
  expect(await deviceValueOf(page, STEREO_BAND, 0, 5), "and the band above it stays the unit's").toBe(-600);

  // The unit put back on 4band PEQ under the open screen: its values stay, and the screen says
  // they no longer reach the signal.
  for (const y of [0, 1]) await setDeviceValue(page, STEREO_TYPE, y, 0);
  await notifyParam(page, STEREO_TYPE, 0, 0);
  await expect(box(page)).toContainText(en.dynTuning.geq.notSelected);
});
