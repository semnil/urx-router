import { test, expect, colorToken, contrastRatio, textContrast } from "./fixtures";
import { dialogsOf, stubTauriDevice, strWritesOf, writesOf } from "./tauri-stub";
import { chooseOption } from "./choose-option";

// The device setup screen: the unit's SETUP > GENERAL settings, which no node on
// the graph and no strip on the console stands for. It is a batch screen — the
// shell reads the whole set before opening, edits stay in the modal, and Apply
// sends only the differences — so the two things worth pinning are that opening
// writes nothing and that applying writes exactly what changed.
//
// Not covered here: the menu entry disables while Live sync holds the connection.
// It rides the same setLiveUi list as Fetch / Write / Compare, and no spec drives a
// live session, so the lock is pinned where that list is.

/** Param ids under test (control/params.ts). */
const BRIGHTNESS = 758;
const AUTO_POWER_OFF = 760;
const TIME_ZONE = 831;
const UDK_FUNCTION = 770;
const UDK_PARAM1 = 771;
const UDK_PARAM2 = 772;

/** A device whose reported settings differ from the factory defaults, so the
 *  screen has to show what it read rather than what it assumed. */
const DEVICE_VALUES = { [BRIGHTNESS]: 4, [AUTO_POWER_OFF]: 0, [TIME_ZONE]: 140 };

const openSetup = async (page: import("@playwright/test").Page): Promise<void> => {
  await page.click("#btn-device");
  await page.click("#btn-device-setup");
  await expect(page.locator("#device-setup-modal")).toBeVisible();
};

test("opens on the values read from the device and writes nothing", async ({ page }) => {
  await stubTauriDevice(page, { values: DEVICE_VALUES });
  await page.goto("/");
  await openSetup(page);

  await expect(page.locator("#device-setup-title")).toHaveText("Device setup");
  await expect(page.locator("#statusbar")).toContainText("Read the device's settings");
  // Read from the device, not assumed: 4 is not the factory brightness (10), and
  // 140 is not the factory time zone (139).
  await expect(page.locator("#device-setup-brightness")).toHaveValue("4");
  await expect(page.locator("#device-setup-timezone")).toHaveValue("140");
  // Nothing is pending on open, so Apply is inert and no write has happened.
  await expect(page.locator("#device-setup-apply")).toBeDisabled();
  await expect(page.locator("#device-setup-pending")).toHaveText("");
  expect(await writesOf(page)).toEqual([]);
  expect(await strWritesOf(page)).toEqual([]);
});

// A Time Zone index past the city list is the unit's own state — the broker stores one
// verbatim — and not the nearest city. Shown as that city, nothing was pending for it and
// choosing the city wrote nothing, so the unit stayed where it was.
test("a time zone past the city list opens as unknown, and the city picked for it is written", async ({ page }) => {
  await stubTauriDevice(page, { values: { ...DEVICE_VALUES, [TIME_ZONE]: 200 } });
  await page.goto("/");
  await openSetup(page);

  await expect(page.locator("#device-setup-timezone")).toHaveValue("200");
  await expect(page.locator("#device-setup-timezone option:checked")).toHaveText("unknown (200)");
  await expect(page.locator("#device-setup-apply")).toBeDisabled();

  await chooseOption(page.locator("#device-setup-timezone"), "153");
  await expect(page.locator("#device-setup-pending")).toHaveText("1 unapplied change");
  await page.click("#device-setup-apply");
  await expect(page.locator("#statusbar")).toContainText("Applied 1 setting to the device");
  expect(await writesOf(page)).toEqual([[TIME_ZONE, 153]]);
});

// Brightness 0 is the unit's own floor, not a dump artefact (hardware: the LCD
// stays readable there). With the floor at 1 the screen coerced the value it read
// on open, so a unit sitting at 0 was reported as 1 and 0 could never be sent back.
test("a device reporting brightness 0 shows 0 on both the slider and the readout", async ({ page }) => {
  await stubTauriDevice(page, { values: { ...DEVICE_VALUES, [BRIGHTNESS]: 0 } });
  await page.goto("/");
  await openSetup(page);

  await expect(page.locator("#device-setup-brightness")).toHaveValue("0");
  await expect(page.locator(".dev-slider .param-val")).toHaveText("0");
  await expect(page.locator("#device-setup-apply")).toBeDisabled();
  expect(await writesOf(page)).toEqual([]);
});

test("brightness 0 can be applied to a device that is brighter", async ({ page }) => {
  await stubTauriDevice(page, { values: DEVICE_VALUES }); // brightness 4
  await page.goto("/");
  await openSetup(page);

  await page.locator("#device-setup-brightness").fill("0");
  await page.locator("#device-setup-brightness").dispatchEvent("change");
  await page.click("#device-setup-apply");

  expect(await writesOf(page)).toEqual([[BRIGHTNESS, 0]]);
});

test("an edit is pending until Apply, which sends only what changed", async ({ page }) => {
  await stubTauriDevice(page, { values: DEVICE_VALUES });
  await page.goto("/");
  await openSetup(page);

  await page.locator("#device-setup-brightness").fill("9");
  await page.locator("#device-setup-brightness").dispatchEvent("change");

  // Pending, not sent: the count appears, the row is marked, Apply comes alive.
  await expect(page.locator("#device-setup-pending")).toHaveText("1 unapplied change");
  await expect(page.locator(".prefs-row.dirty .lbl")).toHaveText("Screen");
  await expect(page.locator("#device-setup-apply")).toBeEnabled();
  expect(await writesOf(page)).toEqual([]);

  await page.click("#device-setup-apply");
  await expect(page.locator("#statusbar")).toContainText("Applied 1 setting to the device");
  // Exactly the changed parameter — not the whole screen.
  expect(await writesOf(page)).toEqual([[BRIGHTNESS, 9]]);
  // The baseline moved, so the screen is clean again and Apply goes inert.
  await expect(page.locator("#device-setup-apply")).toBeDisabled();
  await expect(page.locator("#device-setup-pending")).toHaveText("");
});

// The sub-page names and the knob columns' heads are labels the rows below are read by,
// at the dim tier's ink in the light theme too.
test("the sub-headings and the knob column heads clear AA in the light theme", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("urx-theme", "light"));
  await stubTauriDevice(page, { values: DEVICE_VALUES });
  await page.goto("/");
  await openSetup(page);
  const sub = page.locator("#device-setup-modal .dev-sub").first();
  const head = page.locator("#device-setup-modal .udk-head span:not(:empty)").first();
  await expect(sub).toBeVisible();
  await expect(head).toBeVisible();
  expect(await textContrast(page, sub)).toBeGreaterThanOrEqual(4.5);
  expect(await textContrast(page, head)).toBeGreaterThanOrEqual(4.5);
});

// The dot that marks a row Apply will write is a state graphic on the panel, drawn in the
// accent's ink so it reads at 3:1 in the light theme.
test("the pending-edit dot reads on the light panel", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("urx-theme", "light"));
  await stubTauriDevice(page, { values: DEVICE_VALUES });
  await page.goto("/");
  await openSetup(page);
  await chooseOption(page.locator(".udk-row").first().locator("select").first(), "Monitor");
  const dirty = page.locator(".udk-row.dirty .knob").first();
  await expect(dirty).toBeVisible();
  const dot = await dirty.evaluate((el) => getComputedStyle(el, "::before").backgroundColor);
  expect(dot).toBe(await colorToken(page, "--led-ink"));
  expect(await contrastRatio(page, dot, await colorToken(page, "--panel"))).toBeGreaterThanOrEqual(3);
});

test("a knob assignment writes its three columns together", async ({ page }) => {
  await stubTauriDevice(page, { values: DEVICE_VALUES });
  await page.goto("/");
  await openSetup(page);

  // Knob A of bank 1. Picking a function re-seeds both parameter columns from the
  // catalog, and all three are written — the device reconciles nothing, so a
  // partial write would leave the unit showing a triple no menu could produce.
  await chooseOption(page.locator(".udk-row").first().locator("select").first(), "Monitor");
  await expect(page.locator("#device-setup-pending")).toHaveText("1 unapplied change");
  await page.click("#device-setup-apply");

  expect(await strWritesOf(page)).toEqual([
    [UDK_FUNCTION, 0, "Monitor"],
    [UDK_PARAM1, 0, "Monitor 1"],
    [UDK_PARAM2, 0, "Level"],
  ]);
  expect(await writesOf(page)).toEqual([]);
});

// A Monitor knob the unit reports on a Parameter 1 the catalog does not have is shown as that
// value rather than as Monitor 1, so nothing is pending on open and picking Monitor 1 writes it.
test("a knob's Parameter 1 off the catalog opens as unknown, and the one picked for it is written", async ({
  page,
}) => {
  await stubTauriDevice(page, {
    values: DEVICE_VALUES,
    strings: { [`${UDK_FUNCTION}:0`]: "Monitor", [`${UDK_PARAM1}:0`]: "Monitor 3" },
  });
  await page.goto("/");
  await openSetup(page);

  const p1 = page.locator(".udk-row").first().locator("select").nth(1);
  await expect(p1.locator("option:checked")).toHaveText("unknown (Monitor 3)");
  await expect(page.locator("#device-setup-pending")).toHaveText("");
  await chooseOption(p1, "Monitor 1");
  await expect(page.locator("#device-setup-pending")).toHaveText("1 unapplied change");
  await page.click("#device-setup-apply");

  expect(await strWritesOf(page)).toEqual([
    [UDK_FUNCTION, 0, "Monitor"],
    [UDK_PARAM1, 0, "Monitor 1"],
    [UDK_PARAM2, 0, "Level"],
  ]);
});

test("switching banks addresses the knob slots behind it", async ({ page }) => {
  await stubTauriDevice(page, { values: DEVICE_VALUES });
  await page.goto("/");
  await openSetup(page);

  // Bank 3, knob B = slot 9. Banks are contiguous, four knobs each.
  await page.locator("#device-setup-banks button").nth(2).click();
  await chooseOption(page.locator(".udk-row").nth(1).locator("select").first(), "Oscillator");
  await page.click("#device-setup-apply");

  expect(await strWritesOf(page)).toEqual([
    [UDK_FUNCTION, 9, "Oscillator"],
    [UDK_PARAM1, 9, "Level"],
    [UDK_PARAM2, 9, ""],
  ]);
});

// Every edit and every bank tab rebuilds the screen, and the grid it rebuilds is the
// scrolling region. The control the operator used and the offset they scrolled to both
// survive it, or a keyboard user starts again from the top of the box after every pick.
test("an edit or a bank tab keeps the focused control and the grid's scroll offset", async ({ page }) => {
  await stubTauriDevice(page, { values: DEVICE_VALUES });
  await page.goto("/");
  await openSetup(page);
  // Shrunk after the menu is used, so the grid has an offset to keep.
  await page.setViewportSize({ width: 1280, height: 420 });
  const grid = page.locator("#device-setup-box .prefs-grid");

  const tab = page.locator("#device-setup-banks button").nth(2);
  await tab.focus();
  const before = await grid.evaluate((el) => el.scrollTop);
  // The premise: focusing the tab scrolled the grid, so there is an offset to lose.
  expect(before).toBeGreaterThan(0);
  await page.keyboard.press("Enter");
  await expect(tab).toHaveAttribute("aria-pressed", "true");
  await expect(tab).toBeFocused();
  expect(await grid.evaluate((el) => el.scrollTop)).toBe(before);

  const fn = page.locator(".udk-row").nth(1).locator("select").first();
  await fn.focus();
  const at = await grid.evaluate((el) => el.scrollTop);
  await chooseOption(fn, "Oscillator");
  await expect(fn).toHaveValue("Oscillator");
  await expect(fn).toBeFocused();
  expect(await grid.evaluate((el) => el.scrollTop)).toBe(at);
  expect(await writesOf(page)).toEqual([]);
});

test("closing with unapplied edits asks before discarding them", async ({ page }) => {
  await stubTauriDevice(page, { values: DEVICE_VALUES });
  await page.goto("/");
  await openSetup(page);

  await chooseOption(page.locator("#device-setup-timezone"), "0");
  await page.click("#device-setup-modal .consent-btn-secondary");

  // The stub declines every confirm, so the screen stays open with the edit intact.
  expect(await dialogsOf(page)).toContain("The device setup screen has changes you have not applied. Discard them?");
  await expect(page.locator("#device-setup-modal")).toBeVisible();
  await expect(page.locator("#device-setup-timezone")).toHaveValue("0");
  expect(await writesOf(page)).toEqual([]);
});

test("a clean screen closes without a confirm", async ({ page }) => {
  await stubTauriDevice(page, { values: DEVICE_VALUES });
  await page.goto("/");
  await openSetup(page);

  await page.click("#device-setup-modal .consent-btn-secondary");
  await expect(page.locator("#device-setup-modal")).toBeHidden();
  expect(await dialogsOf(page)).toEqual([]);
});

// The two dialog-action faces, on the one screen that shows both at once. The
// amber edge on the confirming action is the half that had never rendered: the
// shared `.consent-actions button` rule (0,1,1) out-specified the face rule
// (0,1,0), so its shorthand `border` won and Apply carried the same edge as
// Close. Comparing the two is what makes that a failure rather than a colour
// nobody looks at.
test("the confirming action wears the lit face, the leaving action the plain one", async ({ page }) => {
  await stubTauriDevice(page, { values: DEVICE_VALUES });
  await page.goto("/");
  await openSetup(page);

  const face = (sel: string) =>
    page.locator(sel).evaluate((el) => {
      const s = getComputedStyle(el);
      return { edge: s.borderTopColor, fill: s.backgroundImage === "none" ? s.backgroundColor : "gradient" };
    });
  const apply = await face("#device-setup-modal .consent-btn-primary");
  const close = await face("#device-setup-modal .consent-btn-secondary");

  expect(apply.edge).not.toBe(close.edge);
  expect(apply.fill).not.toBe("gradient"); // the lit face is flat amber
  expect(close.fill).toBe("gradient"); // the leaving action is the raised button
});

test("a failed read leaves the screen unopened", async ({ page }) => {
  // The standing device-link rule: a half-read baseline would invite applying a
  // diff against values that were never established.
  await stubTauriDevice(page, { failReads: true });
  await page.goto("/");
  await page.click("#btn-device");
  await page.click("#btn-device-setup");

  await expect(page.locator("#device-setup-modal")).toBeHidden();
  expect((await dialogsOf(page)).join("\n")).toContain("Could not read the device's settings");
});

test("rows for a page the model does not have are locked, not hidden", async ({ page }) => {
  // The URX22 has no HDMI sub-page and no Date/Time menu — it has no microSD
  // recorder for the clock to stamp. Those rows still render, carrying the model
  // tag, so the screen states what the model lacks instead of silently shrinking.
  await stubTauriDevice(page, { model: "URX22", values: { [BRIGHTNESS]: 4 } });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX22");
  await openSetup(page);

  await expect(page.locator("#device-setup-timezone")).toBeDisabled();
  await expect(page.locator("#device-setup-brightness")).toBeEnabled();
  await expect(page.locator(".prefs-lock")).toHaveText(["URX44V / URX44 only", "URX44V only"]);
  // The gated pages are not read from the unit either, so an edit elsewhere still
  // applies cleanly.
  await page.locator("#device-setup-brightness").fill("2");
  await page.locator("#device-setup-brightness").dispatchEvent("change");
  await page.click("#device-setup-apply");
  expect(await writesOf(page)).toEqual([[BRIGHTNESS, 2]]);
});

// Brightness is the app's only slider that commits on `change` rather than on `input`, so
// the app-wide "hold a native slider inert when the window goes away" treatment
// (`holdInertOnBlur`) cannot simply disable it: measured 2026-08-14, disabling a range
// mid-drag makes Chromium fire that pending change at the disable and WebKit fire none at
// all, which loses the value the operator dragged to. The row commits from its own value
// first, then is held. This case drives the real drag; only the blur is dispatched, since
// Playwright emulates focus.
test("a brightness drag interrupted by a window blur is committed, and the row is held", async ({ page }) => {
  await stubTauriDevice(page, { values: DEVICE_VALUES }); // brightness 4
  await page.goto("/");
  await openSetup(page);

  const slider = page.locator("#device-setup-brightness");
  const b = (await slider.boundingBox())!;
  const y = b.y + b.height / 2;
  await page.mouse.move(b.x + b.width * 0.2, y);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.8, y);
  const dragged = await slider.inputValue();
  expect(dragged).not.toBe("4");

  await page.evaluate(() => window.dispatchEvent(new FocusEvent("blur")));
  await expect(slider).toBeDisabled();
  // The value the operator left it on is pending, not lost — and still not written.
  await expect(page.locator("#device-setup-pending")).toHaveText("1 unapplied change");
  await expect(page.locator("#device-setup-apply")).toBeEnabled();
  expect(await writesOf(page)).toEqual([]);

  await page.mouse.up();
  await expect(page.locator("#device-setup-brightness")).toBeEnabled();
  await page.click("#device-setup-apply");
  expect(await writesOf(page)).toEqual([[BRIGHTNESS, Number(dragged)]]);
});
