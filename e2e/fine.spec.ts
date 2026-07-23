import { test, expect, type Page } from "@playwright/test";
import { wheelOver } from "./graph-helpers";

// Fine-tuning mode (hold Shift), mirroring the device's push-and-turn fine steps.
// Only params with a device-verified fine grid opt in: EQ band gain and COMP gain
// step 0.1 dB (coarse 0.5), the console STREAMING TIME knob steps 0.02 ms (coarse
// 1 ms). Everything else — faders, sends, thresholds, freq/Q — keeps its grid.
// While armed, a FINE tag lights on the hovered eligible control.

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const strip = (page: Page, name: string) => page.locator(".con-strip", { has: page.getByText(name, { exact: true }) });

// Legend opacities, matching .fine-tag / its armed state in src/style.css.
const DIM = "0.55";
const LIT = "1";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-model", "URX44V");
  });
  await page.goto("/");
  await page.locator("#model-picker").waitFor();
});

test.describe("inspector sliders", () => {
  test("EQ gain steps 0.1 dB while Shift is held, 0.5 dB otherwise", async ({ page }) => {
    await node(page, "ch1").click();
    // The active band panel carries the only visible fine-eligible EQ slider.
    const row = page.locator("#inspector .eq-panel:not([hidden]) .param.has-fine");
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

  test("COMP gain is fine-eligible; threshold and Q are not", async ({ page }) => {
    await node(page, "ch1").click();
    const comp = page.locator("#inspector .param.has-fine", { hasText: "Gain" }).last();
    const slider = comp.locator("input[type=range]");
    await expect(slider).toHaveAttribute("data-fine-step", "0.1");
    // Threshold (1 dB grid) and Q (0.1 native) have no fine opt-in.
    const threshold = page.locator("#inspector .param", { hasText: "Threshold" }).first();
    await expect(threshold.locator("input[type=range]")).not.toHaveAttribute("data-fine-step", /.+/);
    const q = page.locator("#inspector .eq-panel:not([hidden]) .param", { hasText: "Q" }).first();
    await expect(q.locator("input[type=range]")).not.toHaveAttribute("data-fine-step", /.+/);
  });

  test("the FINE legend is printed before any interaction and lights while Shift is held", async ({ page }) => {
    await node(page, "ch1").click();
    const row = page.locator("#inspector .eq-panel:not([hidden]) .param.has-fine");
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
