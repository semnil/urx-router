import { test, expect, type Page, type Locator } from "@playwright/test";

// Mouse-wheel adjust on hover: every continuous control (inspector native-range
// sliders + the console faders / knobs) nudges one detent per wheel notch, matching
// the Arrow keys. deltaY < 0 = up. Guards: device-locked knobs and FIXED-bus send
// faders take no input, and a pure horizontal scroll (deltaY 0) is left alone.

// Hover the control's centre, then send one wheel notch there.
async function wheelOver(page: Page, target: Locator, deltaY: number): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error("target has no bounding box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
}

const strip = (page: Page, name: string) => page.locator(".con-strip", { has: page.getByText(name, { exact: true }) });
const col = (page: Page, name: string, send: string) =>
  strip(page, name).locator(".con-scol", { has: page.getByRole("button", { name: send, exact: true }) });
const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const param = (page: Page, label: string) => page.locator("#inspector .param", { hasText: label });

test.describe("console view", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("urx-lang", "en");
      localStorage.setItem("urx-theme", "dark");
      localStorage.setItem("urx-model", "URX44V");
    });
    await page.goto("/");
    await page.click("#btn-view-console");
    await expect(page.locator("#console-host")).toBeVisible();
  });

  test("the main fader steps one detent per wheel notch", async ({ page }) => {
    const s = strip(page, "CH 1");
    const readout = s.locator(".con-readout .rd:not(.mtr) .rv");
    const fader = s.locator(".con-fader");
    await expect(readout).toHaveText("0.0");
    await wheelOver(page, fader, -100); // up one detent (0.0 -> +0.4, matching ArrowUp)
    await expect(readout).toHaveText("+0.4");
    await wheelOver(page, fader, 100); // down one detent, back to 0.0
    await expect(readout).toHaveText("0.0");
  });

  test("a rotary knob steps by its unit per wheel notch", async ({ page }) => {
    const gain = strip(page, "CH 1").locator(".con-gain", { has: page.locator(".con-knob[aria-label='A.GAIN']") });
    const val = gain.locator(".val");
    const knob = gain.locator(".con-knob");
    await expect(val).toHaveText("-8"); // factory A.Gain
    await wheelOver(page, knob, -100);
    await expect(val).toHaveText("-7");
    await wheelOver(page, knob, 100);
    await expect(val).toHaveText("-8");
  });

  test("a SENDS-rack mini-fader adjusts the send and drives the header readout", async ({ page }) => {
    const s = strip(page, "CH 1");
    const fader = col(page, "CH 1", "M1").locator(".con-vfad");
    const rdout = s.locator(".con-sh .rdout");
    await wheelOver(page, fader, -100); // hover surfaces the readout, wheel bumps it up
    await expect(s.locator(".con-sh")).toHaveClass(/readout/);
    await expect(rdout).toContainText("MIX 1");
    const bumped = await rdout.textContent();
    await wheelOver(page, fader, 100); // down again → readout tracks the change
    await expect(rdout).not.toHaveText(bumped ?? "");
  });
});

test.describe("graph inspector", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("urx-lang", "en");
      localStorage.setItem("urx-theme", "dark");
      localStorage.setItem("urx-seed", "empty");
    });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await node(page, "bus.mon1").click();
  });

  test("a native-range param slider (PHONES Level) steps by its own step on wheel", async ({ page }) => {
    const row = param(page, "PHONES Level");
    const value = row.locator(".param-val");
    const slider = row.locator("input[type=range]");
    await expect(value).toHaveText("2.0"); // factory default, step 0.1
    await wheelOver(page, slider, 100); // down one step
    await expect(value).toHaveText("1.9");
    await wheelOver(page, slider, -100); // back up
    await expect(value).toHaveText("2.0");
  });

  test("a level-grid fader slider (monitor Level) steps a detent on wheel", async ({ page }) => {
    // The monitor output fader ("Level") precedes the "PHONES Level" row in the DOM,
    // so .first() picks the fader (both rows' text contains "Level").
    const row = param(page, "Level").first();
    const value = row.locator(".param-val");
    const slider = row.locator("input[type=range]");
    const before = await value.textContent();
    await wheelOver(page, slider, -100); // up one level_gain detent
    await expect(value).not.toHaveText(before ?? "");
  });

  test("a native-range slider at its ceiling ignores a further wheel-up (clamp no-op)", async ({ page }) => {
    // wheelStep bails when the clamped next value equals the current one, so
    // scrolling up at the max neither overshoots the ceiling nor re-fires 'input'.
    const row = param(page, "PHONES Level");
    const value = row.locator(".param-val");
    const slider = row.locator("input[type=range]");
    await slider.focus();
    await slider.press("End"); // jump the native range to its max (10.0)
    await expect(value).toHaveText("10.0");
    await wheelOver(page, slider, -100); // wheel up past the ceiling
    await expect(value).toHaveText("10.0"); // clamped, unchanged
  });
});

test.describe("device-locked guard", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("urx-lang", "en");
      localStorage.setItem("urx-theme", "dark");
      localStorage.setItem("urx-seed", "empty");
    });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  test("a Pan-Link-locked SEND PAN knob ignores the wheel", async ({ page }) => {
    // Lock MIX 1's send pan via Pan Link, then confirm the console SEND PAN knob is
    // read-only and takes no wheel input (the wheel handler sits below the same
    // readonlyTitle early-return that already blocks drag / keys).
    await node(page, "bus.mix1").click();
    await param(page, "Pan Link").locator("button", { hasText: "ON" }).click();
    await page.click("#btn-view-console");
    await expect(page.locator("#console-host")).toBeVisible();

    await strip(page, "CH 1").locator(".con-panbtn").click();
    const pop = page.locator(".con-spop");
    const mix1 = pop.locator(".pcol", { has: page.getByText("MIX 1", { exact: true }) });
    const knob = mix1.locator(".con-knob");
    const value = mix1.locator(".rv");
    await expect(knob).toHaveClass(/readonly/);
    const before = await value.textContent();
    await wheelOver(page, knob, -100);
    await expect(value).toHaveText(before ?? "");
  });
});
