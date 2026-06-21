import { test, expect, type Page } from "@playwright/test";

// A strip located by its scribble's node name (exact, so "CH 1" never matches
// "CH 11/12"). The console runs against the factory plan, so we do NOT seed
// "empty" — channels, sends, monitors and the master are all present.
const strip = (page: Page, name: string) =>
  page.locator(".con-strip", { has: page.getByText(name, { exact: true }) });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-model", "URX44V");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-view-console");
  await expect(page.locator("#console-host")).toBeVisible();
});

test("GRAPH / CONSOLE tabs switch the visible view", async ({ page }) => {
  await expect(page.locator("#graph-host")).toBeHidden();
  await expect(page.locator("#btn-view-console")).toHaveAttribute("aria-pressed", "true");
  await page.click("#btn-view-graph");
  await expect(page.locator("#console-host")).toBeHidden();
  await expect(page.locator("#graph-host")).toBeVisible();
});

test("MAIN lays out the input channels and the master", async ({ page }) => {
  await expect(strip(page, "CH 1")).toBeVisible();
  await expect(strip(page, "CH 5/6")).toBeVisible();
  await expect(strip(page, "STEREO (MAIN)")).toBeVisible();
});

test("a fader edits its level via the keyboard", async ({ page }) => {
  const s = strip(page, "CH 1");
  const readout = s.locator(".con-readout .db");
  await expect(readout).toHaveText("0.0");
  await s.locator(".con-fader").focus();
  await page.keyboard.press("ArrowUp");
  await expect(readout).toHaveText("+1.0");
});

test("MUTE and EQ chips toggle their pressed state", async ({ page }) => {
  const s = strip(page, "CH 1");
  const mute = s.getByRole("button", { name: "MUTE" });
  await expect(mute).toHaveAttribute("aria-pressed", "false");
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  const eq = s.getByRole("button", { name: "EQ", exact: true });
  await expect(eq).toHaveAttribute("aria-pressed", "true"); // EQ defaults on
  await eq.click();
  await expect(eq).toHaveAttribute("aria-pressed", "false");
});

test("the gain knob edits, and double-click resets to the factory value", async ({ page }) => {
  const s = strip(page, "CH 1");
  const gain = s.locator(".con-gain", { has: page.locator(".con-knob[aria-label='A.GAIN']") });
  const val = gain.locator(".val");
  await expect(val).toHaveText("-8"); // factory A.Gain
  await gain.locator(".con-knob").focus();
  await page.keyboard.press("ArrowUp");
  await expect(val).toHaveText("-7");
  await gain.locator(".con-knob").dblclick();
  await expect(val).toHaveText("-8");
});

test("PAN/BAL is a knob on channels; PHONES on monitor buses", async ({ page }) => {
  await expect(strip(page, "CH 1").locator(".con-knob[aria-label='PAN']")).toBeVisible();
  await expect(strip(page, "CH 5/6").locator(".con-knob[aria-label='BAL']")).toBeVisible();
  await expect(strip(page, "MONITOR 1").locator(".con-knob[aria-label='PHONES']")).toBeVisible();
});

test("DUCKER and φL/φR appear on stereo channels only", async ({ page }) => {
  await expect(strip(page, "CH 5/6").getByRole("button", { name: "DUCKER" })).toBeVisible();
  await expect(strip(page, "CH 5/6").getByRole("button", { name: "φL" })).toBeVisible();
  await expect(strip(page, "CH 1").getByRole("button", { name: "DUCKER" })).toHaveCount(0);
});

test("a send mode shows only the sources of the selected bus", async ({ page }) => {
  await page.locator(".con-modepick").getByRole("button", { name: "MIX 1", exact: true }).click();
  await expect(strip(page, "CH 1")).toBeVisible(); // a MIX source
  await expect(strip(page, "CH 1").locator(".con-readout .send")).toHaveText("→ MIX 1 SEND");
  await expect(strip(page, "STEREO (MAIN)")).toHaveCount(0); // master is not a MIX source
  await expect(strip(page, "MONITOR 1")).toHaveCount(0); // monitors are not sources
});

test("the dB scale includes the -60 and -80 ticks", async ({ page }) => {
  const scale = strip(page, "CH 1").locator(".con-scale");
  await expect(scale).toContainText("60");
  await expect(scale).toContainText("80");
});

test("scrolling stays inside the strip grid (no window scroll)", async ({ page }) => {
  const m = await page.evaluate(() => {
    const app = document.documentElement;
    const strips = document.querySelector(".con-strips") as HTMLElement;
    return {
      bodyVOver: app.scrollHeight - app.clientHeight,
      stripsHOver: strips.scrollWidth - strips.clientWidth,
    };
  });
  expect(m.bodyVOver).toBe(0); // the window never scrolls vertically
  expect(m.stripsHOver).toBeGreaterThan(0); // strips overflow horizontally inside .con-strips
});
