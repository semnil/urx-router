import { test, expect, type Page } from "./fixtures";
import { wheelOver } from "./graph-helpers";
import { planParamZ } from "./plan-param";

// Mouse-wheel adjust on hover: every continuous control (inspector native-range
// sliders + the console faders / knobs) nudges one detent per wheel notch, matching
// the Arrow keys. deltaY < 0 = up. Guards: device-locked knobs and FIXED-bus send
// faders take no input, and a pure horizontal scroll (deltaY 0) is left alone.

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

// A level the plan holds between two detents (a loaded plan, a device read) steps to the
// adjacent detent in the direction of travel: the slider's native ArrowDown steps from the
// NEAREST detent instead, and from -15.5 that is -16, so it used to land on -18.
test.describe("an off-grid level in the Inspector", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("urx-lang", "en");
      localStorage.setItem("urx-theme", "dark");
    });
    const plan = {
      format: "urx-router-plan",
      version: 2,
      modelId: "URX44V",
      connections: [],
      nodeParams: { "bus.stereo": { level: -15.5 } },
    };
    await page.goto(`/?plan=${planParamZ(plan)}`);
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await node(page, "bus.stereo").click();
  });

  test("ArrowDown and a wheel notch each land on the adjacent detent", async ({ page }) => {
    const row = param(page, "Level").first();
    const value = row.locator(".param-val");
    const slider = row.locator("input[type=range]");
    await expect(value).toHaveText(/15\.5/);
    await slider.focus();
    await slider.press("ArrowDown");
    await expect(value).toHaveText(/16\.0/);
    await wheelOver(page, slider, 100);
    await expect(value).toHaveText(/18\.0/);
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

// The board reads a wheel gesture along the axis its first event moved on: sideways pans it,
// up and down zooms it. A sideways scroll used to read its deltaY of 0 as a step out.
test.describe("graph board", () => {
  const viewport = (page: Page) => page.locator("#graph-host svg > g").first();
  const transform = async (page: Page): Promise<{ x: number; scale: number }> => {
    const m = /translate\(([-\d.e]+) [-\d.e]+\) scale\(([-\d.e]+)\)/.exec(
      (await viewport(page).getAttribute("transform")) ?? "",
    );
    if (!m) throw new Error("no viewport transform");
    return { x: Number(m[1]), scale: Number(m[2]) };
  };
  const hoverBoard = async (page: Page): Promise<void> => {
    const box = (await page.locator("#graph-host").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  };

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("urx-lang", "en");
      localStorage.setItem("urx-theme", "dark");
    });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  test("a sideways wheel pans the board and leaves its zoom alone", async ({ page }) => {
    await hoverBoard(page);
    const before = await transform(page);
    await page.mouse.wheel(60, 0);
    await expect.poll(async () => (await transform(page)).x).toBe(before.x - 60);
    expect((await transform(page)).scale).toBe(before.scale);
  });

  // The native context menu takes the right button's release, so the page sees the press and
  // then a move with no button held. Headless Chromium opens no menu, so that move is
  // dispatched here; the press, and the held-button move after it, are real.
  test("a right press whose release never arrived leaves no pan following the cursor", async ({ page }) => {
    const box = (await page.locator("#graph-host").boundingBox())!;
    await page.mouse.move(box.x + 12, box.y + 12);
    await page.mouse.down({ button: "right" });
    const before = await viewport(page).getAttribute("transform");
    await page.locator("#graph-host svg").dispatchEvent("pointermove", {
      pointerId: 1,
      pointerType: "mouse",
      buttons: 0,
      clientX: box.x + 200,
      clientY: box.y + 150,
    });
    await page.mouse.move(box.x + 300, box.y + 200, { steps: 4 });
    expect(await viewport(page).getAttribute("transform")).toBe(before);
    await page.mouse.up({ button: "right" });
  });

  test("an upward wheel zooms the board in", async ({ page }) => {
    await hoverBoard(page);
    const before = await transform(page);
    await page.mouse.wheel(0, -100);
    await expect.poll(async () => (await transform(page)).scale).toBeGreaterThan(before.scale);
  });
});
