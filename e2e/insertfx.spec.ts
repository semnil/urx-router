import { test, expect, type Page } from "./fixtures";
import { planParamZ } from "./plan-param";
import { dialogsOf, stubTauriDevice, writesOf } from "./tauri-stub";

// Insert-FX effect editing: selecting an insert effect (guitar amp / pitch fix /
// compander / multi-band comp) reveals its parameter editor, and the values
// round-trip through save/open. Slots/encodings: core/control/insert-fx-effect.ts.

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const insertSelect = (page: Page) => page.locator("#inspector .param", { hasText: "Insert FX" }).locator("select");
const param = (page: Page, label: string) => page.locator("#inspector .param", { hasText: label });
// The families the tuning screen shows whole (the guitar amps and the companders) keep
// their sliders there rather than in the Inspector, so a case about one of those opens
// the screen and reads its rows. Pitch Fix and the multi-band compressor still edit in
// the Inspector, and their cases below still read `param`.
const screenBox = (page: Page) => page.locator("#dyn-screen-box");
const screenRow = (page: Page, label: string) =>
  screenBox(page)
    .locator(".prefs-row")
    .filter({ has: page.getByText(label, { exact: true }) });
const openScreen = async (page: Page): Promise<void> => {
  await page.locator("#btn-insfx-screen").click();
  await expect(screenBox(page)).toBeVisible();
};
const closeScreen = (page: Page) => page.locator("#dyn-screen-modal .consent-btn-secondary").click();
const screenSelect = (page: Page, label: string) => screenRow(page, label).locator("select");
// A guitar amp is two faces; the cabinet's four rows are on the second one.
const showCab = (page: Page) => page.click("#dyn-face-insfx-cab");
// COMPANDER_PARAMS writable slots: threshold / ratio / attack / release / outGain / width.
const COMPANDER_SLOT_COUNT = 6;

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
  await openScreen(page);
  // Common params appear. Slot 7 reads Volume here and Gain on the other three amps —
  // the unit's own labelling, and the one row whose name depends on the type.
  await expect(screenRow(page, "Volume")).toBeVisible();
  await expect(screenRow(page, "Gain")).toHaveCount(0);
  await expect(screenRow(page, "Treble")).toBeVisible();
  await expect(screenRow(page, "Output")).toBeVisible();
  await expect(screenRow(page, "Blend")).toBeVisible(); // Clean-only
  // The cabinet is the other face, and the amp's rows are not on it.
  await showCab(page);
  await expect(screenRow(page, "Treble")).toHaveCount(0);
  await expect(screenRow(page, "Gate Level")).toBeVisible();
  // SP Type lists the eight cabinets in order.
  await expect(screenSelect(page, "SP Type").locator("option")).toHaveText([
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
  await openScreen(page);
  await expect(screenRow(page, "Blend")).toBeVisible();
  // The selector is outside the screen, so the type changes underneath an open one and
  // the same modal re-binds — which is the whole reason the screen carries no Type row.
  await closeScreen(page);
  await insertSelect(page).selectOption({ label: "Drive" });
  await openScreen(page);
  await expect(screenRow(page, "Blend")).toHaveCount(0);
  await expect(screenRow(page, "Amp Type")).toBeVisible(); // Drive-only
  await expect(screenRow(page, "Master")).toBeVisible();
  // …and slot 7 changed its name with the type.
  await expect(screenRow(page, "Gain")).toBeVisible();
  await expect(screenRow(page, "Volume")).toHaveCount(0);
});

test("compander on the STEREO master reveals dynamics params", async ({ page }) => {
  await node(page, "bus.stereo").click();
  await insertSelect(page).selectOption({ label: "Compander-H" });
  await openScreen(page);
  await expect(screenRow(page, "Threshold")).toBeVisible();
  await expect(screenRow(page, "Ratio")).toBeVisible();
  await expect(screenRow(page, "Width")).toBeVisible();
  // The taps either side of the insert point, which is what the screen adds over the
  // Inspector's list.
  await expect(screenBox(page).locator(".gt-ladders")).toBeVisible();
});

// The families the screen shows are edited THERE and nowhere else. Restoring the flat
// renderer beside the launcher would put the same values on two surfaces, and the one in
// the inspector reads the snapshot taken at render time and writes a stale value back on
// its next drag — which is the reason the renderer was removed. Nothing else in this file
// would go red for it, so the absence is asserted with the launcher as the positive
// control and the multi-band compressor as the family that still edits in place.
test("a family the screen shows has no editor left in the inspector", async ({ page }) => {
  for (const [id, effect, row] of [
    ["ch1", "Clean", "Treble"],
    ["ch3", "Pitch Fix", "Coarse"],
    ["bus.stereo", "Compander-H", "Width"],
  ] as const) {
    await node(page, id).click();
    await insertSelect(page).selectOption({ label: effect });
    await expect(page.locator("#btn-insfx-screen"), effect).toBeVisible();
    await expect(param(page, row), effect).toHaveCount(0);
  }
  // …and the one family that does still edit in place, which is what says the assertion
  // above can fail at all. On the SAME bus: the compander and the multi-band compressor
  // share one device-wide slot, so a second output cannot take it while this one holds it.
  await insertSelect(page).selectOption({ label: "M.Band Comp" });
  await expect(page.locator("#btn-insfx-screen")).toHaveCount(0);
  await expect(param(page, "LOW Threshold")).toBeVisible();
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
  await openScreen(page);
  // What the correction does to a note is the first face…
  await expect(screenRow(page, "Coarse")).toBeVisible();
  // …and what it is aimed at is the second.
  await showCab(page);
  await expect(screenSelect(page, "Key").locator("option")).toHaveCount(12);
  await expect(screenRow(page, "MIDI Control")).toBeVisible();
  // Shown and never written: the unit takes those notes on a port of its own, and
  // switching it on erases a full note mask. The pill is what says so on the panel; the
  // select is inert.
  await expect(screenSelect(page, "MIDI Control")).toBeDisabled();
  await expect(screenRow(page, "MIDI Control")).toContainText("Set on the device");
});

// One of the twelve semitone buttons on the scale face. They are absolute — named from C
// whatever the Key is — and are a plain row rather than a keyboard for that reason.
const noteToggle = (page: Page, note: string) =>
  page.locator("#dyn-screen-box .gt-notes button", { hasText: new RegExp(`^${note.replace("#", "\\#")}$`) });

test("pitch scale select seeds the note keyboard, and a note edit persists as Custom", async ({ page }, testInfo) => {
  await node(page, "ch1").click();
  await insertSelect(page).selectOption({ label: "Pitch Fix" });
  await openScreen(page);
  await showCab(page);
  // Defaults to Chromatic. Every preset is selectable: the unit derives the twelve notes
  // for each of them from the Key, and the app now authors the same pattern.
  await expect(screenSelect(page, "Scale")).toHaveValue("7");
  await expect(screenSelect(page, "Scale").locator("option:disabled")).toHaveCount(0);

  // Major seeds the major-scale note set (F# a non-major degree is cleared), then
  // toggling F# on rewrites Scale to Custom. Verified through save → open, which is also
  // what says the edit reached the plan rather than only the panel.
  await screenSelect(page, "Scale").selectOption({ label: "Major" });
  await expect(screenSelect(page, "Scale")).toHaveValue("2");
  await expect(noteToggle(page, "F#")).toHaveAttribute("aria-pressed", "false");
  await noteToggle(page, "F#").click();
  await closeScreen(page);
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
  await openScreen(page);
  await showCab(page);
  await expect(screenSelect(page, "Scale")).toHaveValue("0"); // Custom
  await expect(screenSelect(page, "Scale").locator("option", { hasText: "Custom" })).toBeEnabled();
  await expect(noteToggle(page, "F#")).toHaveAttribute("aria-pressed", "true");
});

// A plan can carry any Scale preset: it must display verbatim instead of collapsing to
// Custom. Enum values are LCD-confirmed (insert-fx-effect.ts).
test("a device-preset pitch scale (Pentatonic) loaded from a plan displays verbatim", async ({ page }) => {
  const plan = {
    format: "urx-router-plan",
    version: 1,
    modelId: "URX44V",
    connections: [],
    nodeParams: { ch1: { insertFx: 512, insertFxParams: { "16": 6 } } },
  };
  await page.goto(`/?plan=${planParamZ(plan)}`);
  await node(page, "ch1").click();
  await openScreen(page);
  await showCab(page);
  const scale = screenSelect(page, "Scale");
  await expect(scale).toHaveValue("6");
  await expect(scale.locator("option", { hasText: "Pentatonic" })).toBeEnabled();
  await expect(scale.locator("option", { hasText: "Melodic Minor" })).toBeEnabled();
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
  await openScreen(page);
  await expect(screenRow(page, "Treble")).toBeVisible();
  await closeScreen(page);
  await insertSelect(page).selectOption({ label: "No Effect" });
  // Nothing to tune, so the way in goes with the effect rather than opening on an
  // empty panel.
  await expect(page.locator("#btn-insfx-screen")).toHaveCount(0);
  await expect(insertSelect(page)).toHaveValue("-1");
});

test("insert-fx param round-trips through save and open", async ({ page }, testInfo) => {
  await node(page, "ch1").click();
  await insertSelect(page).selectOption({ label: "Clean" });
  await openScreen(page);
  await showCab(page);
  await screenSelect(page, "SP Type").selectOption({ label: "JC 2x12" });
  await expect(screenSelect(page, "SP Type")).toHaveValue("8");
  await closeScreen(page);

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
  await openScreen(page);
  // The face is a cursor into the panel, not part of the plan: a fresh open lands on the
  // amp whatever the last one was showing.
  await expect(screenRow(page, "Volume")).toBeVisible();
  await showCab(page);
  await expect(screenSelect(page, "SP Type")).toHaveValue("8"); // JC 2x12
});

test("selecting an effect reveals the ON/OFF (bypass) toggle; bypass keeps the selection", async ({ page }) => {
  await node(page, "ch1").click();
  await expect(param(page, "Insert FX ON")).toHaveCount(0); // hidden under No Effect
  await insertSelect(page).selectOption({ label: "Compander-S" });
  const onRow = param(page, "Insert FX ON");
  await expect(onRow.locator(".toggle button.on")).toHaveText("ON"); // ships engaged
  await onRow.getByRole("button", { name: "OFF", exact: true }).click();
  await expect(onRow.locator(".toggle button.on")).toHaveText("OFF");
  await expect(insertSelect(page)).toHaveValue("1794"); // bypass never clears the selector
  // Re-selecting an effect mirrors the device's auto-engage.
  await insertSelect(page).selectOption({ label: "Compander-H" });
  await expect(param(page, "Insert FX ON").locator(".toggle button.on")).toHaveText("ON");
});

test("the console INS FX chip bypasses without clearing the selection", async ({ page }) => {
  await node(page, "ch1").click();
  await insertSelect(page).selectOption({ label: "Compander-S" });
  await page.click("#btn-view-console");
  const chip = page
    .locator(".con-strip", { has: page.getByText("CH 1", { exact: true }) })
    .locator(".con-chip", { hasText: "INS FX" })
    .first();
  await expect(chip).toHaveClass(/\bon\b/);
  await chip.click();
  await expect(chip).not.toHaveClass(/\bon\b/);
  await chip.click();
  await expect(chip).toHaveClass(/\bon\b/);
  // The selection survived the bypass round-trip.
  await page.click("#btn-view-graph");
  await node(page, "ch1").click();
  await expect(insertSelect(page)).toHaveValue("1794");
});

// Two nodes holding the same insert-FX family write ONE engine array (addressed
// engine:0:slot, no channel axis), so the emitted set collapses the repeated
// address to its last command and the loser's values never reach the unit. The
// inspector cannot author that plan (insertFxMenu locks a slot another node holds)
// and a file carrying one only opens past the loader's warning, so a device readback
// is the shortest route in — which is why this case fetches instead of editing.
test("a write says which node's insert-FX values reach the device", async ({ page }) => {
  // vd_get answers by paramId with no y axis, so every MONO IN reports Compander-H
  // (135) and every engine slot the same raw (689) — exactly the coherent, agreeing
  // strip a real readback of a two-owner unit produces.
  await stubTauriDevice(page, {
    values: { 135: 1793, 689: -1000, 766: 48000, 848: 0 },
    confirm: "Ok",
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-device");
  await page.click("#btn-fetch");
  await expect(page.locator("#statusbar")).toContainText("Fetched", { timeout: 20000 });

  await node(page, "ch1").click();
  // CH 1 is the FIRST owner in model order, so its command is the one dropped. The
  // compander every MONO IN reports is edited on the tuning screen.
  await openScreen(page);
  const threshold = screenRow(page, "Threshold").locator('input[type="range"]');
  await threshold.focus();
  await page.keyboard.press("ArrowUp");
  await closeScreen(page);
  // A second, unshared edit so the write has something of its own to confirm — the
  // dropped owner's own change is on no address and would report "no changes".
  await param(page, "HPF").getByRole("button", { name: "ON", exact: true }).click();

  await page.click("#btn-device");
  await page.click("#btn-write");
  await expect
    .poll(() => dialogsOf(page))
    .toContainEqual(
      expect.stringContaining("CH 1 shares device settings with CH 4 — only CH 4's values reach the device"),
    );
  // Prefixed, not substituted: the question the operator answers is unchanged.
  await expect.poll(() => dialogsOf(page)).toContainEqual(expect.stringContaining("to the device?"));
  // The confirm is raised BEFORE the send, so the write log has to be read once the
  // send has STOPPED GROWING — otherwise the count below is a sample taken mid-round
  // and says nothing about how many commands the write emitted. Waited on the log
  // itself rather than on a status string: which string the flow ends on depends on
  // whether it converged, which is the thing under test.
  //
  // The interval has to clear sendConverging's own blind wait between rounds
  // (SETTLE_TIMEOUT_MS, 300 ms). Sampling faster than that — this polled at 200 ms —
  // sees the inter-round gap as "stopped" every time and reads the log mid-write, so
  // the count below became whatever had landed by then: measured 4 on 689 when only
  // the first round was in and 8 when the second had partly landed, from the same
  // build. That is what made this case flaky; it was never a timing accident.
  const POLL_MS = 500;
  let settled = -1;
  for (let i = 0; i < 40 && settled !== (await writesOf(page)).length; i++) {
    settled = (await writesOf(page)).length;
    await page.waitForTimeout(POLL_MS);
  }
  expect(settled).toBeGreaterThan(0);
  // And the write went out carrying the engine array ONCE per slot rather than once
  // per owner (four MONO IN channels hold the same compander here). The stub's writes
  // land in the state its reads answer from, so sendConverging's re-diff finds nothing
  // and the loop stops after one round: the ceiling is the slot count, not the slot
  // count times the round cap.
  const engine = (await writesOf(page)).filter(([id]) => id === 689);
  console.log(
    `write settled at ${settled} command(s), ${engine.length} on 689; dialogs: ${(await dialogsOf(page)).length}`,
  );
  expect(engine.length).toBeGreaterThan(0);
  expect(engine.length).toBeLessThanOrEqual(COMPANDER_SLOT_COUNT);
});

// The desktop minimum pointer target, from the project's UI defaults: 36x36 CSS px.
const MIN_TARGET = 36;

test("every semitone button meets the desktop minimum target, at the smallest window", async ({ page }) => {
  // The SMALLEST window the app admits (tauri.conf.json minWidth / minHeight), because the
  // note row's width does not grow with the viewport, so a reading taken on a wide window
  // would not be the worst case and one taken here covers both. Twelve targets do not reach
  // 36px on one line in this column; six per row do, which is what the stylesheet lays them
  // out as.
  await page.setViewportSize({ width: 960, height: 640 });
  await node(page, "ch1").click();
  await insertSelect(page).selectOption({ label: "Pitch Fix" });
  await openScreen(page);
  await showCab(page);
  const buttons = page.locator("#dyn-screen-box .gt-notes button");
  await expect(buttons).toHaveCount(12);

  const rects: { label: string; w: number; h: number }[] = [];
  for (let i = 0; i < 12; i++) {
    const b = buttons.nth(i);
    const box = await b.boundingBox();
    expect(box, `note ${i} has no box`).not.toBeNull();
    rects.push({ label: (await b.textContent()) ?? "", w: box!.width, h: box!.height });
  }
  console.log(`note targets: ${rects.map((r) => `${r.label} ${r.w.toFixed(2)}x${r.h.toFixed(2)}`).join("  ")}`);
  for (const r of rects) {
    expect(r.w, `${r.label} width`).toBeGreaterThanOrEqual(MIN_TARGET);
    expect(r.h, `${r.label} height`).toBeGreaterThanOrEqual(MIN_TARGET);
  }
  // Two rows of six, not one row of twelve and not some other wrap: distinct top edges,
  // and six buttons sharing each. Without this the size assertions above pass on any wrap
  // the layout happens to produce, an uneven one included.
  const tops = await buttons.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  const rows = [...new Set(tops)];
  expect(rows).toHaveLength(2);
  for (const top of rows) expect(tops.filter((t) => t === top)).toHaveLength(6);
});
