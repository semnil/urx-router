import { test, expect, type Page } from "@playwright/test";

// Insert-FX effect editing: selecting an insert effect (guitar amp / pitch fix /
// compander / multi-band comp) reveals its parameter editor, and the values
// round-trip through save/open. Slots/encodings: core/control/insert-fx-effect.ts.

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const insertSelect = (page: Page) => page.locator("#inspector .param", { hasText: "Insert FX" }).locator("select");
const paramSelect = (page: Page, label: string) =>
  page.locator("#inspector .param", { hasText: label }).locator("select");
const param = (page: Page, label: string) => page.locator("#inspector .param", { hasText: label });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await page.locator("#model-picker").waitFor();
});

test("guitar amp (Clean) reveals common params + cabinet list", async ({ page }) => {
  await node(page, "ch1").click();
  await insertSelect(page).selectOption({ label: "Clean" });
  // Common params appear.
  await expect(param(page, "Treble")).toBeVisible();
  await expect(param(page, "Output")).toBeVisible();
  await expect(param(page, "Blend")).toBeVisible(); // Clean-only
  // SP Type lists the eight cabinets in order.
  await expect(paramSelect(page, "SP Type").locator("option")).toHaveText([
    "BS 4x12",
    "AC 2x12",
    "AC 1x12",
    "AC 4x10",
    "BC 2x12",
    "AM 4x12",
    "YC 4x12",
    "JC 2x12",
  ]);
});

test("switching guitar amp type swaps the type-specific control", async ({ page }) => {
  await node(page, "ch1").click();
  await insertSelect(page).selectOption({ label: "Clean" });
  await expect(param(page, "Blend")).toBeVisible();
  await insertSelect(page).selectOption({ label: "Drive" });
  await expect(param(page, "Blend")).toHaveCount(0);
  await expect(param(page, "Amp Type")).toBeVisible(); // Drive-only
  await expect(param(page, "Master")).toBeVisible();
});

test("compander on the STEREO master reveals dynamics params", async ({ page }) => {
  await node(page, "bus.stereo").click();
  await insertSelect(page).selectOption({ label: "Compander-H" });
  await expect(param(page, "Threshold")).toBeVisible();
  await expect(param(page, "Ratio")).toBeVisible();
  await expect(param(page, "Width")).toBeVisible();
});

test("multi-band comp on a MIX bus reveals three bands", async ({ page }) => {
  await node(page, "bus.mix1").click();
  await insertSelect(page).selectOption({ label: "M.Band Comp" });
  await expect(param(page, "LOW Threshold")).toBeVisible();
  await expect(param(page, "MID Threshold")).toBeVisible();
  await expect(param(page, "HIGH Threshold")).toBeVisible();
  await expect(param(page, "L-M XOVER")).toBeVisible();
});

test("pitch fix reveals key + scale keyboard", async ({ page }) => {
  await node(page, "ch1").click();
  await insertSelect(page).selectOption({ label: "Pitch Fix" });
  await expect(param(page, "Coarse")).toBeVisible();
  await expect(paramSelect(page, "Key").locator("option")).toHaveCount(12);
  await expect(param(page, "MIDI Control")).toBeVisible();
});

// A pitch note toggle row: a .param whose label is the bare semitone name (so it
// is not confused with the Key select, whose options also list the note names).
const noteToggle = (page: Page, note: string) =>
  page
    .locator("#inspector .param")
    .filter({ has: page.getByRole("button", { name: "ON", exact: true }) })
    .filter({ hasText: new RegExp(`^${note.replace("#", "\\#")}`) });

test("pitch scale select seeds the note keyboard, and a note edit persists as Custom", async ({ page }, testInfo) => {
  await node(page, "ch1").click();
  await insertSelect(page).selectOption({ label: "Pitch Fix" });
  // Defaults to Chromatic; Custom is not directly selectable until a note is edited.
  await expect(paramSelect(page, "Scale")).toHaveValue("7");
  await expect(paramSelect(page, "Scale").locator("option", { hasText: "Custom" })).toBeDisabled();

  // Major seeds the major-scale note set (F# a non-major degree is cleared), then
  // toggling F# on rewrites Scale to Custom. The note keyboard and the Scale select
  // depend on each other but only refresh on a full re-render, so verify the result
  // through save → open rather than the live DOM.
  await paramSelect(page, "Scale").selectOption({ label: "Major" });
  await expect(paramSelect(page, "Scale")).toHaveValue("2");
  await noteToggle(page, "F#").getByRole("button", { name: "ON", exact: true }).click();
  await page.click("#btn-file");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btn-save")]);
  const saved = testInfo.outputPath("pitch.json");
  await download.saveAs(saved);

  await page.click("#btn-file");
  await page.click("#btn-new");
  await page.click("#btn-file");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#btn-open")]);
  await chooser.setFiles(saved);
  await node(page, "ch1").click();
  await expect(paramSelect(page, "Scale")).toHaveValue("0"); // Custom
  await expect(paramSelect(page, "Scale").locator("option", { hasText: "Custom" })).toBeEnabled();
  await expect(noteToggle(page, "F#").getByRole("button", { name: "ON", exact: true })).toHaveClass(/on/);
});

test("MBC crossover sliders expose the per-band valid ranges", async ({ page }) => {
  await node(page, "bus.stereo").click();
  await insertSelect(page).selectOption({ label: "M.Band Comp" });
  // L-M 21.2 Hz..4 kHz (raw 6..97), M-H 42.5 Hz..8 kHz (raw 18..109): the device
  // splits the crossover ranges so the bands cannot cross.
  const lm = param(page, "L-M XOVER").locator("input[type=range]");
  await expect(lm).toHaveAttribute("min", "6");
  await expect(lm).toHaveAttribute("max", "97");
  const mh = param(page, "M-H XOVER").locator("input[type=range]");
  await expect(mh).toHaveAttribute("min", "18");
  await expect(mh).toHaveAttribute("max", "109");
});

test("insert FX option set depends on node kind (input vs output)", async ({ page }) => {
  // MONO IN channels carry the input effects (guitar amps / pitch / companders);
  // the STEREO / MIX outputs carry the output effects (MBC / companders). Neither
  // family leaks into the other's selector.
  await node(page, "ch1").click();
  await expect(insertSelect(page).locator("option")).toHaveText([
    "No Effect",
    "Clean",
    "Crunch",
    "Lead",
    "Drive",
    "Pitch Fix",
    "Compander-H",
    "Compander-S",
  ]);
  await node(page, "bus.stereo").click();
  await expect(insertSelect(page).locator("option")).toHaveText([
    "No Effect",
    "M.Band Comp",
    "Compander-H",
    "Compander-S",
  ]);
});

test("guitar-amp slot is 1-of-N: taken on one channel disables it on another", async ({ page }) => {
  await node(page, "ch1").click();
  await insertSelect(page).selectOption({ label: "Clean" });
  await node(page, "ch2").click();
  // The four guitar-amp types share one device-wide slot, now held by CH1.
  for (const amp of ["Clean", "Crunch", "Lead", "Drive"]) {
    await expect(insertSelect(page).locator("option", { hasText: amp })).toBeDisabled();
  }
  // Pitch Fix and the companders sit in other slots, so they stay selectable.
  await expect(insertSelect(page).locator("option", { hasText: "Pitch Fix" })).toBeEnabled();
  await expect(insertSelect(page).locator("option", { hasText: "Compander-H" })).toBeEnabled();
});

test("output dynamics slot is 1-of-N across MIX and STEREO outputs", async ({ page }) => {
  await node(page, "bus.mix1").click();
  await insertSelect(page).selectOption({ label: "M.Band Comp" });
  await node(page, "bus.stereo").click();
  // MBC and both companders share the single out-dyn slot, now held by MIX 1.
  for (const fx of ["M.Band Comp", "Compander-H", "Compander-S"]) {
    await expect(insertSelect(page).locator("option", { hasText: fx })).toBeDisabled();
  }
  await expect(insertSelect(page).locator("option", { hasText: "No Effect" })).toBeEnabled();
});

test("sample-rate ceilings gate the insert FX options", async ({ page }) => {
  await page.selectOption("#rate-picker", "48000");
  await node(page, "ch1").click();
  await expect(insertSelect(page).locator("option", { hasText: "Pitch Fix" })).toBeEnabled();

  // Pitch Fix tops out at 48 kHz; the guitar amps run to 96 kHz.
  await page.selectOption("#rate-picker", "96000");
  await expect(insertSelect(page).locator("option", { hasText: "Pitch Fix" })).toBeDisabled();
  await expect(insertSelect(page).locator("option", { hasText: "Clean" })).toBeEnabled();

  // Above 96 kHz every insert effect drops out.
  await page.selectOption("#rate-picker", "192000");
  for (const fx of ["Clean", "Pitch Fix", "Compander-H"]) {
    await expect(insertSelect(page).locator("option", { hasText: fx })).toBeDisabled();
  }
});

test("selecting No Effect removes the effect parameter editor", async ({ page }) => {
  await node(page, "ch1").click();
  await insertSelect(page).selectOption({ label: "Clean" });
  await expect(param(page, "Treble")).toBeVisible();
  await insertSelect(page).selectOption({ label: "No Effect" });
  await expect(param(page, "Treble")).toHaveCount(0);
  await expect(insertSelect(page)).toHaveValue("-1");
});

test("insert-fx param round-trips through save and open", async ({ page }, testInfo) => {
  await node(page, "ch1").click();
  await insertSelect(page).selectOption({ label: "Clean" });
  await paramSelect(page, "SP Type").selectOption({ label: "JC 2x12" });
  await expect(paramSelect(page, "SP Type")).toHaveValue("8");

  await page.click("#btn-file");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btn-save")]);
  const saved = testInfo.outputPath("plan.json");
  await download.saveAs(saved);

  await page.click("#btn-file");
  await page.click("#btn-new");
  await node(page, "ch1").click();
  await expect(insertSelect(page)).toHaveValue("-1"); // No Effect after reset

  await page.click("#btn-file");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#btn-open")]);
  await chooser.setFiles(saved);
  await node(page, "ch1").click();
  await expect(insertSelect(page)).toHaveValue("256"); // Clean
  await expect(paramSelect(page, "SP Type")).toHaveValue("8"); // JC 2x12
});
