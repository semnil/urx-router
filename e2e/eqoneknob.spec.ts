import { test, expect, heldThroughBlur, type Page } from "./fixtures";

// The EQ 1-knob, on the tuning screen where it lives (the inspector keeps the section's
// ON toggle and a launcher). What it does on the device is measured and recorded in
// reference/work/vd: writing a TYPE loads a preset and initialises LEVEL to that type's
// neutral point, and while 1-knob is on the device computes all four bands and announces
// every recomputation — so the band rows stay on screen, read-only.
const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const box = (page: Page) => page.locator("#dyn-screen-box");
const row = (page: Page, label: string) =>
  box(page)
    .locator(".prefs-row")
    .filter({ has: page.getByText(label, { exact: true }) });

/** The 1-knob section, by its heading — not by text, since the reserved note in the
 *  Parameters section names the 1-knob as well. */
const oneKnob = (page: Page) =>
  box(page)
    .locator(".prefs-section")
    .filter({ has: page.locator("h3", { hasText: "1-knob" }) });

async function openEq(page: Page, id: string): Promise<void> {
  await node(page, id).click();
  await page.locator("#inspector #btn-eq-screen").click();
  await expect(box(page)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

// Every EQ instance offers all three preset types, measured on a URX44V: the catalog
// used to carry two subsets (mono = Intensity/Vocal, else Intensity/Loudness) and both
// halves were wrong. A mono channel and an output bus resolve their EQ down different
// paths, so each is pinned.
const ALL_TYPES = ["Intensity", "Vocal", "Loudness"];

test("a mono channel's 1-knob offers every type", async ({ page }) => {
  await openEq(page, "ch1");
  await expect(row(page, "1-knob Type").locator("option")).toHaveText(ALL_TYPES);
});

test("an output bus's 1-knob offers every type", async ({ page }) => {
  await openEq(page, "bus.stereo");
  await expect(row(page, "1-knob Type").locator("option")).toHaveText(ALL_TYPES);
});

test("the Type and Level rows stay on screen with 1-knob off, locked", async ({ page }) => {
  await openEq(page, "ch1");
  const type = row(page, "1-knob Type");
  const level = row(page, "1-knob Level");
  // Shown rather than hidden: the section would otherwise shrink by two rows on every
  // toggle, moving everything under it. Locked, because the value has no effect until
  // 1-knob is on — and the unit discards it on the transition (measured).
  await expect(type).toHaveClass(/locked/);
  await expect(level).toHaveClass(/locked/);
  await expect(type.locator("select")).toBeDisabled();

  await oneKnob(page).locator("button", { hasText: "ON" }).click();
  await expect(row(page, "1-knob Type")).not.toHaveClass(/locked/);
  await expect(row(page, "1-knob Level").locator("input[type=range]")).toBeEnabled();
});

test("1-knob on takes the bands away entirely, without moving anything", async ({ page }) => {
  await openEq(page, "ch1");
  await expect(row(page, "Freq").locator("input[type=range]")).toBeEnabled();
  const height = async (): Promise<number> => Math.round((await box(page).boundingBox())?.height ?? 0);
  const before = await height();

  await oneKnob(page).locator("button", { hasText: "ON" }).click();

  // The device computes all four bands, so there is no band being edited: the rows go,
  // the band bar goes with them (nothing selected, nothing selectable) and the band's
  // name leaves the Parameters heading.
  const params = box(page).locator(".prefs-section", { hasText: "Parameters" });
  for (const label of ["Band", "Type", "Q", "Freq", "Gain"]) {
    await expect(row(page, label)).toHaveCount(1); // still there…
    await expect(row(page, label)).not.toBeVisible(); // …and not shown
  }
  await expect(box(page).locator(".gt-modes")).not.toBeVisible();
  await expect(box(page).locator("#dyn-band-low")).toHaveAttribute("aria-pressed", "false");
  await expect(box(page).locator("#dyn-band-low")).toBeDisabled();
  await expect(params.locator("h3 .prefs-lock")).not.toBeVisible();
  // The space says why, instead of reading as a rendering fault.
  await expect(box(page).locator(".gt-reserved-note")).toBeVisible();
  // Nothing in the block can be reached, by pointer or by tab.
  await expect(params.locator("input:not([disabled]), select:not([disabled]), button:not([disabled])")).toHaveCount(0);

  // And the panel is exactly as tall as it was — this is why the rows are reserved
  // rather than removed.
  expect(await height()).toBe(before);
});

test("the 1-knob level survives reopening the screen", async ({ page }) => {
  await openEq(page, "ch1");
  await oneKnob(page).locator("button", { hasText: "ON" }).click();
  await row(page, "1-knob Level").locator("input[type=range]").fill("80");
  await expect(row(page, "1-knob Level").locator(".param-val")).toHaveText("80 %");

  await box(page).locator(".consent-btn-secondary").click();
  await node(page, "ch2").click();
  await openEq(page, "ch1");
  await expect(row(page, "1-knob Level").locator(".param-val")).toHaveText("80 %");
});

// The 1-knob Level row is built by `sliderRow` (ui/dom.ts) — the one range builder that
// neither the inspector's case nor the tuning rows' own case reaches. Same wiring, same
// gesture; the shared helper carries what it asserts and why.
test("the 1-knob Level row is held inert when the window goes away", async ({ page }) => {
  await openEq(page, "ch1");
  await oneKnob(page).locator("button", { hasText: "ON" }).click();
  await heldThroughBlur(page, row(page, "1-knob Level").locator("input[type=range]"));
});
