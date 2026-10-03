import { test, expect, type Page } from "./fixtures";
import { chooseOption } from "./choose-option";
import { planParamZ } from "./plan-param";

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const param = (page: Page, label: string) => page.locator("#inspector .param", { hasText: label });
const frameRateSelect = (page: Page) => param(page, "Frame rate").locator("select");
// The DELAY on/off toggle, scoped to the STREAMING DELAY section so its "DELAY"
// label is not confused with the "Delay Time" slider row.
const delaySection = (page: Page) => page.locator("#inspector details.insp-section", { hasText: "Frame rate" });
const delayToggle = (page: Page) => delaySection(page).locator(".param", { hasText: "DELAY" }).first();

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("streaming bus shows the DELAY section with frame rate, toggle and time", async ({ page }) => {
  await node(page, "bus.stream").click();
  await expect(frameRateSelect(page).locator("option")).toHaveText([
    "24",
    "25",
    "29.97D",
    "29.97",
    "30D",
    "30",
    "60",
    "120",
  ]);
  await expect(frameRateSelect(page)).toHaveValue("5"); // 30 fps, the device default
  await expect(param(page, "Delay Time")).toHaveCount(1);
  await expect(param(page, "Delay Time").locator("input[type=range]")).toHaveCount(1);
});

test("DELAY settings persist after reselecting the streaming bus", async ({ page }) => {
  await node(page, "bus.stream").click();
  await chooseOption(frameRateSelect(page), "7"); // 120 fps
  await delayToggle(page).locator("button", { hasText: "ON" }).click();

  await node(page, "bus.stereo").click();
  await node(page, "bus.stream").click();
  await expect(frameRateSelect(page)).toHaveValue("7");
  await expect(delayToggle(page).locator("button.on")).toHaveText("ON");
});

const delayTime = (page: Page) => param(page, "Delay Time");

test("Delay Time steps the unit's 0.02 ms grid", async ({ page }) => {
  await node(page, "bus.stream").click();
  const slider = delayTime(page).locator("input[type=range]");
  await expect(slider).toHaveAttribute("step", "0.02");
  await expect(delayTime(page).locator(".param-val")).toHaveText("1.00 ms");
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(delayTime(page).locator(".param-val")).toHaveText("1.02 ms");
});

// A held value off the grid — an odd centi-ms — prints as itself. The thumb rests on the grid
// point the range rounds it to, halfway up, so the first move lands on the grid from there.
test("an off-grid Delay Time prints as held, and the first move lands on the grid", async ({ page }) => {
  const plan = {
    format: "urx-router-plan",
    version: 2,
    modelId: "URX44V",
    connections: [],
    nodeParams: { "bus.stream": { delay: { on: true, time: 45.87 } } },
  };
  await page.goto(`/?plan=${planParamZ(plan)}`);
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await node(page, "bus.stream").click();
  const slider = delayTime(page).locator("input[type=range]");
  await expect(delayTime(page).locator(".param-val")).toHaveText("45.87 ms");
  await expect(slider).toHaveValue("45.88");
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(delayTime(page).locator(".param-val")).toHaveText("45.90 ms");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(delayTime(page).locator(".param-val")).toHaveText("45.86 ms");
});
