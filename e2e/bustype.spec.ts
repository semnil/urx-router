import { test, expect, type Page } from "./fixtures";
import { selectWire } from "./graph-helpers";

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const param = (page: Page, label: string) => page.locator("#inspector .param", { hasText: label });
const busTypeSelect = (page: Page) => param(page, "BUS Type").locator("select");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("MIX bus shows BUS Type + Pan Link; FIXED hides Pan Link", async ({ page }) => {
  await node(page, "bus.mix1").click();
  await expect(busTypeSelect(page).locator("option")).toHaveText(["VARI", "FIXED"]);
  await expect(busTypeSelect(page)).toHaveValue("0"); // VARI
  await expect(param(page, "Pan Link")).toHaveCount(1);

  await busTypeSelect(page).selectOption("1"); // FIXED
  await expect(param(page, "Pan Link")).toHaveCount(0);
});

// Every CH → bus send is a fixed (always-wired) connection, so these pick a wire by
// its endpoints rather than creating one. selectWire is graph-helpers'.

test("FIXED bus drops the send LEVEL and shows a hint", async ({ page }) => {
  await node(page, "bus.mix1").click();
  await busTypeSelect(page).selectOption("1"); // FIXED

  await selectWire(page, "ch1:out", "bus.mix1:in");
  await expect(param(page, "Level")).toHaveCount(0);
  await expect(param(page, "Pan")).toHaveCount(1);
  await expect(page.locator("#inspector .hint", { hasText: "Send level is fixed" })).toHaveCount(1);
});

// A .param whose label is EXACTLY `label` (so "Pan" never matches "Pan Link").
const paramExact = (page: Page, label: string) =>
  page.locator("#inspector .param", { has: page.getByText(label, { exact: true }) });

test("STEREO / MIX master expose a Balance control that stays Balance under Pan Link", async ({ page }) => {
  await node(page, "bus.stereo").click();
  await expect(paramExact(page, "Balance")).toHaveCount(1);

  await node(page, "bus.mix1").click();
  await expect(paramExact(page, "Balance")).toHaveCount(1);
  // The device keeps the BALANCE label even with Pan Link on (confirmed on URX44V).
  await param(page, "Pan Link").locator("button", { hasText: "ON" }).click();
  await expect(paramExact(page, "Balance")).toHaveCount(1);
  await expect(paramExact(page, "Pan")).toHaveCount(0);
});

test("VARI + Pan Link drops the send PAN and shows a hint", async ({ page }) => {
  await node(page, "bus.mix1").click();
  await param(page, "Pan Link").locator("button", { hasText: "ON" }).click();

  await selectWire(page, "ch1:out", "bus.mix1:in");
  await expect(param(page, "Pan")).toHaveCount(0);
  await expect(param(page, "Level")).toHaveCount(1);
  await expect(page.locator("#inspector .hint", { hasText: "Pan follows" })).toHaveCount(1);
});

// The inspector's sliders are native ranges, like the tuning screen's rows, and every one
// in the app goes through `holdInertOnBlur`: the engine owns a native drag, so nothing the
// app unhooks ends it — measured on the shipping WKWebView, a slider held through an app
// switch went on writing, and it resumed when focus came back if the treatment only ended
// it once. This is the inspector's half of that wiring, in a real engine: the drag is real
// and only the blur is dispatched, since Playwright emulates focus.
test("a send slider stops at a window blur and stays stopped while the button is held", async ({ page }) => {
  await selectWire(page, "ch1:out", "bus.mix1:in");
  // Both of the inspector's slider builders are on this one selection: Level is the
  // log-scaled one, Pan the plain `rangeSlider` every node-level control also uses.
  for (const label of ["Level", "Pan"]) await heldThroughBlur(page, param(page, label).locator("input[type=range]"));
});

async function heldThroughBlur(page: Page, slider: ReturnType<Page["locator"]>): Promise<void> {
  await expect(slider).toHaveCount(1);

  const b = (await slider.boundingBox())!;
  const y = b.y + b.height / 2;
  await page.mouse.move(b.x + b.width * 0.25, y);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.4, y);
  const dragged = await slider.inputValue();

  await page.evaluate(() => window.dispatchEvent(new FocusEvent("blur")));
  await page.mouse.move(b.x + b.width * 0.8, y);
  expect(await slider.inputValue()).toBe(dragged);
  // The state itself, not only the frozen value: removing the element and re-adding it
  // freezes the value too, and that is the treatment measured to RESUME on the unit.
  await expect(slider).toBeDisabled();

  // Focus returning is not the re-arm — the button is still down.
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  await page.mouse.move(b.x + b.width * 0.95, y);
  expect(await slider.inputValue()).toBe(dragged);

  await page.mouse.up();
  await expect(slider).toBeEnabled();
  await page.mouse.move(b.x + b.width * 0.6, y);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.65, y);
  await page.mouse.up();
  expect(await slider.inputValue()).not.toBe(dragged);
}
