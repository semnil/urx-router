import { test, expect, type Page } from "./fixtures";
import { wheelOver } from "./graph-helpers";

// Fine-tuning mode (hold Shift), mirroring the device's push-and-turn fine steps.
// Only params with a device-verified fine grid opt in: EQ band gain and COMP gain
// step 0.1 dB (coarse 0.5), the console STREAMING TIME knob steps 0.02 ms (coarse
// 1 ms). Everything else — faders, sends, thresholds, freq/Q — keeps its grid.
// While armed, a FINE tag lights on the hovered eligible control.

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const strip = (page: Page, name: string) => page.locator(".con-strip", { has: page.getByText(name, { exact: true }) });

// Legend opacities, matching .fine-tag / its armed state / a locked row in src/style.css.
// LOCKED is DIM composed with the locked row's own 0.45, not that 0.45 alone: opacity on
// one element cascades rather than multiplying, so the flat value printed the legend
// heavier than the label it annotates (measured at 1.56x its ink, against 0.90x live).
const DIM = "0.55";
const LIT = "1";
const LOCKED = "0.2475";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-model", "URX44V");
  });
  await page.goto("/");
  await page.locator("#model-picker").waitFor();
});

// Both fine-eligible dB values live on a tuning screen now (the inspector keeps the ON
// toggle and a launcher), and the eligibility travels with the field rather than with
// whichever surface renders it.
const openScreen = async (page: Page, section: RegExp, button: string): Promise<void> => {
  await node(page, "ch1").click();
  const sec = page.locator("#inspector .insp-section", { has: page.locator("summary", { hasText: section }) });
  if (!(await sec.evaluate((el) => (el as HTMLDetailsElement).open))) await sec.locator("summary").click();
  await sec.locator(button).click();
  await expect(page.locator("#dyn-screen-box")).toBeVisible();
};

test.describe("tuning-screen sliders", () => {
  test("EQ gain steps 0.1 dB while Shift is held, 0.5 dB otherwise", async ({ page }) => {
    await openScreen(page, /^EQ$/, "#btn-eq-screen");
    const row = page.locator("#dyn-screen-box .prefs-row.has-fine");
    const slider = row.locator("input[type=range]");
    const readout = row.locator(".param-val");
    await expect(slider).toHaveAttribute("step", "0.5");
    await wheelOver(page, slider, -100);
    await expect(readout).toHaveText("+0.5 dB");
    await page.keyboard.down("Shift");
    await expect(slider).toHaveAttribute("step", "0.1");
    await wheelOver(page, slider, -100);
    await expect(readout).toHaveText("+0.6 dB");
    await page.keyboard.up("Shift");
    await expect(slider).toHaveAttribute("step", "0.5");
  });

  test("COMP gain is fine-eligible; threshold and the EQ's Q are not", async ({ page }) => {
    await openScreen(page, /^COMP$/, "#btn-comp-screen");
    const box = page.locator("#dyn-screen-box");
    const gainRow = box.locator(".prefs-row", { hasText: "Gain" });
    await expect(gainRow.locator("input[type=range]")).toHaveAttribute("data-fine-step", "0.1");
    await expect(gainRow.locator(".fine-tag")).toBeVisible();
    // Threshold (1 dB grid) has no fine opt-in, on the same screen.
    const threshold = box.locator(".prefs-row", { hasText: "Threshold" });
    await expect(threshold.locator("input[type=range]")).not.toHaveAttribute("data-fine-step", /.+/);
    await box.locator(".consent-btn-secondary").click();
    // Nor does Q (0.1 native), on the EQ screen where it lives.
    await openScreen(page, /^EQ$/, "#btn-eq-screen");
    await box.locator("#dyn-band-lowmid").click(); // a peaking band, so Q is offered
    const q = box.locator(".prefs-row", { hasText: "Q" }).first();
    await expect(q.locator("input[type=range]")).not.toHaveAttribute("data-fine-step", /.+/);
  });

  test("the FINE legend is printed before any interaction and lights while Shift is held", async ({ page }) => {
    await openScreen(page, /^EQ$/, "#btn-eq-screen");
    const row = page.locator("#dyn-screen-box .prefs-row.has-fine");
    const tag = row.locator(".fine-tag");
    await expect(tag).toBeVisible(); // printed — eligibility reads with no interaction
    await expect(tag).toHaveText("FINE");
    await expect(tag).toHaveCSS("opacity", DIM);
    await row.hover();
    await expect(tag).toHaveCSS("opacity", DIM); // hover alone does not arm
    await page.keyboard.down("Shift");
    await expect(tag).toHaveCSS("opacity", LIT);
    await page.keyboard.up("Shift");
    await expect(tag).toHaveCSS("opacity", DIM);
    // Label-pinned: a readout width change must not move the legend.
    const before = await tag.boundingBox();
    await wheelOver(page, row.locator("input[type=range]"), -100); // "0 dB" → "+0.5 dB"
    await expect(row.locator(".param-val")).toHaveText("+0.5 dB");
    expect(await tag.boundingBox()).toEqual(before);
  });

  test("the legend survives the device taking the row, ahead of the tag that says so", async ({ page }) => {
    await openScreen(page, /^COMP$/, "#btn-comp-screen");
    const box = page.locator("#dyn-screen-box");
    const gainRow = box.locator(".prefs-row", { hasText: "Gain" });
    const tag = gainRow.locator(".fine-tag");
    const before = await tag.boundingBox();

    // 1-knob on: the device owns the makeup gain. The legend states what the parameter
    // has rather than who is holding it, so it stays exactly where it was and the
    // Device-driven pill lands after it — a legend that came and went would move the
    // label block on every toggle.
    await box
      .locator(".prefs-row")
      .filter({ has: page.getByText("1-Knob", { exact: true }) })
      .locator("button", { hasText: "On" })
      .click();
    await expect(gainRow).toHaveClass(/locked/);
    // A hidden element has no box, so this covers "still printed" too. The sibling
    // combinator states the adjacency the placement is *for*, which a coordinate
    // comparison only implies.
    expect(await tag.boundingBox()).toEqual(before);
    await expect(gainRow.locator(".fine-tag + .prefs-lock")).toHaveCount(1);

    // The row's dimming composes with the legend's own printed dim rather than
    // replacing it, so it stays lighter than the label. And it can never light: a
    // locked slider refuses the gesture the legend describes.
    await expect(tag).toHaveCSS("opacity", LOCKED);
    await gainRow.hover();
    await page.keyboard.down("Shift");
    await expect(tag).toHaveCSS("opacity", LOCKED);
    await page.keyboard.up("Shift");
  });
});

test.describe("console view", () => {
  test.beforeEach(async ({ page }) => {
    await page.click("#btn-view-console");
    await expect(page.locator("#console-host")).toBeVisible();
  });

  test("the TIME knob steps 0.02 ms while Shift is held, and its printed legend never moves", async ({ page }) => {
    const s = strip(page, "STREAMING");
    const time = s.locator(".con-knob[aria-label='TIME']");
    const val = s.locator(".con-gain .val");
    const tag = s.locator(".fine-tag");
    await expect(tag).toBeVisible(); // printed legend, before any interaction
    await expect(strip(page, "MONITOR 1").locator(".con-gain .fine-tag")).toHaveCount(0);
    await expect(val).toHaveText("1.0");
    await wheelOver(page, time, -100);
    await expect(val).toHaveText("2.0");
    const before = await val.boundingBox();
    await page.keyboard.down("Shift");
    await wheelOver(page, time, -100);
    await expect(val).toHaveText("2.02");
    await expect(tag).toHaveCSS("opacity", LIT); // lit —
    expect(await val.boundingBox()).toEqual(before); // — and nothing moved
    await time.focus();
    await page.keyboard.press("ArrowUp"); // Shift still held
    await expect(val).toHaveText("2.04");
    await page.keyboard.up("Shift");
    await wheelOver(page, time, 100);
    await expect(val).toHaveText("1.0"); // coarse again — a coarse notch re-snaps to its grid
  });

  test("the main fader keeps its detent grid under Shift", async ({ page }) => {
    const s = strip(page, "CH 1");
    const readout = s.locator(".con-readout .rd:not(.mtr) .rv");
    await expect(readout).toHaveText("0.0");
    await page.keyboard.down("Shift");
    await wheelOver(page, s.locator(".con-fader"), -100);
    await page.keyboard.up("Shift");
    await expect(readout).toHaveText("+0.4"); // one level_gain detent — no fine grid on faders
  });
});
