import { test, expect, type Page } from "./fixtures";
import { chooseOption } from "./choose-option";
import { planParamZ } from "./plan-param";
import { getModel } from "../src/models";

// The FX EFFECT tuning screen and the two surfaces that reach it: the CONSOLE FX strip's
// EFFECT face + disclosure, and the Inspector's FX Effect section. What each family shows,
// and why, is in docs/{en,ja}/channel-tuning.md "FX EFFECT"; the values themselves are
// core/control/fx-effect.ts.

const strip = (page: Page, name: string) => page.locator(".con-strip", { has: page.getByText(name, { exact: true }) });
const screenBox = (page: Page) => page.locator("#dyn-screen-box");
// Both shapes a value takes on this screen: knob cards for the continuous rows, ordinary
// rows for the delay's Sync and Note. A locator naming only one would report the other as
// absent, which reads in a failure as the control being gone rather than moved.
const screenRow = (page: Page, label: string) =>
  screenBox(page)
    .locator(".prefs-row, .gt-knob")
    .filter({ has: page.getByText(label, { exact: true }) });
const readout = (page: Page, label: string) => screenRow(page, label).locator(".gt-val");
const typeSelect = (page: Page) => page.locator("#inspector .param", { hasText: "EFFECT TYPE" }).locator("select");
// Closing WAITS for the modal to go: it holds the app inert while it is up, so a gesture
// aimed at the Inspector immediately after the click lands on nothing and the case reads as
// the value not having changed.
const closeScreen = async (page: Page): Promise<void> => {
  await page.locator("#dyn-screen-modal .consent-btn-secondary").click();
  await expect(screenBox(page)).toBeHidden();
};

const planWith = (nodeId: string, fxEffect: unknown) => ({
  format: "urx-router-plan",
  version: 2,
  modelId: "URX44V",
  connections: [],
  nodeParams: { [nodeId]: { fxEffect } },
});

/** Open the screen from the CONSOLE, which is the route with the popover in it. */
const openFromConsole = async (page: Page, name: string): Promise<void> => {
  await page.click("#btn-view-console");
  await strip(page, name).locator(".con-fxopen").click();
  await page.locator(".con-ifxpop .iopen").click();
  await expect(screenBox(page)).toBeVisible();
};

/** The Inspector's FX Effect section, expanded. It is a `<details>` that folds with the
 *  effect's own ON state, so a bypassed channel ships it closed and everything inside is
 *  then unreachable — which reads in a failure as the control being gone. */
const fxSection = async (page: Page, nodeId: string) => {
  await page.click("#btn-view-graph");
  await page.locator(`g.node[data-id="${nodeId}"]`).click();
  const sec = page.locator("#inspector .insp-section", { has: page.locator("summary", { hasText: "FX Effect" }) });
  if (!(await sec.evaluate((el) => (el as HTMLDetailsElement).open))) await sec.locator("summary").click();
  return sec;
};

/** Select an FX channel in the GRAPH and open its screen from the Inspector. */
const openFromInspector = async (page: Page, nodeId: string): Promise<void> => {
  const sec = await fxSection(page, nodeId);
  await sec.locator("#btn-fx-screen").click();
  await expect(screenBox(page)).toBeVisible();
};

/** Start again on the EMPTY seed. The factory plan describes every FX parameter — the
 *  `bus.fx2` block in `initial-urx44v.ts` carries all eight delay slots — so on it a type
 *  change keeps the value it stored under a shared key, which is correct and is not what a
 *  case about a channel holding NOTHING is asking. */
const gotoEmptySeed = async (page: Page): Promise<void> => {
  await page.addInitScript(() => localStorage.setItem("urx-seed", "empty"));
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-model", "URX44V");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("the FX strip carries an EFFECT face and a disclosure", async ({ page }) => {
  await page.click("#btn-view-console");
  const fx1 = strip(page, "FX 1");
  await expect(fx1.locator(".con-fxface")).toHaveText("EFFECT");
  await expect(fx1.locator(".con-fxopen")).toBeVisible();
  // The face is the EFFECT ON switch, and it is the only thing that switches it: pressing
  // it moves the strip's own state and nothing else on the surface claims that value.
  await expect(fx1.locator(".con-fxface")).toHaveAttribute("aria-pressed", "true");
  await fx1.locator(".con-fxface").click();
  await expect(fx1.locator(".con-fxface")).toHaveAttribute("aria-pressed", "false");
});

test("the disclosure opens a type popover with five live rows and a launcher", async ({ page }) => {
  await page.click("#btn-view-console");
  await strip(page, "FX 1").locator(".con-fxopen").click();
  const pop = page.locator(".con-ifxpop");
  await expect(pop).toBeVisible();
  // FX1's own menu: three Rev-X reverbs and the two delays. Not FX2's — the reverbs differ.
  await expect(pop.locator(".irow")).toHaveCount(5);
  await expect(pop.locator(".irow", { hasText: "Rev-X Hall" })).toHaveAttribute("aria-checked", "true");
  // No row is ever refused here: every type runs at every rate the FX bus itself runs at,
  // and an FX channel's engine is its own, so there is nothing for a `why` column to say.
  await expect(pop.locator(".irow.off")).toHaveCount(0);
  await expect(pop.locator(".irow .why")).toHaveCount(0);
  // …and EFFECT ON is deliberately not in here: the face it hangs off already switches it.
  await expect(pop.getByRole("button", { name: /^(ON|OFF)$/ })).toHaveCount(0);
  await expect(pop.locator(".iopen.off")).toHaveCount(0);
});

test("choosing a type from the popover opens the screen on it", async ({ page }) => {
  await page.click("#btn-view-console");
  await strip(page, "FX 1").locator(".con-fxopen").click();
  await page.locator(".con-ifxpop .irow", { hasText: "Mono Delay" }).click();
  // The popover closes and the screen opens on what was chosen — the INS FX popover's own
  // behaviour, and these two are the app's only Type axis.
  await expect(page.locator(".con-ifxpop")).toBeHidden();
  await expect(screenBox(page)).toBeVisible();
  await expect(screenBox(page)).toContainText("FX EFFECT — Mono Delay");
  await closeScreen(page);
  // …and the swap landed on the strip too: reopening the popover shows it checked.
  await strip(page, "FX 1").locator(".con-fxopen").click();
  await expect(page.locator(".con-ifxpop .irow", { hasText: "Mono Delay" })).toHaveAttribute("aria-checked", "true");
});

test("the Inspector's FX section keeps three controls and no raw sliders", async ({ page }) => {
  const section = await fxSection(page, "bus.fx1");
  await expect(section.locator("select")).toHaveCount(1); // EFFECT TYPE
  await expect(section.locator(".toggle")).toHaveCount(1); // Effect ON
  await expect(section.locator("#btn-fx-screen")).toBeVisible();
  // The parameters moved to the screen whole — Mix included. A slider left here would sit
  // at the position it was drawn at and write that stale value back on the next drag.
  await expect(section.locator('input[type="range"]')).toHaveCount(0);
});

test("the screen names the effect and shows the REV-X face", async ({ page }) => {
  await openFromConsole(page, "FX 1");
  await expect(screenBox(page)).toContainText("FX EFFECT — Rev-X Hall");
  for (const label of ["Mix", "Reverb Time", "Room Size", "Initial Delay", "Hi Ratio", "Low Freq", "HPF", "LPF"]) {
    await expect(screenRow(page, label)).toBeVisible();
  }
  // The selection stays outside: this screen adjusts, and a type write is the one edit that
  // replaces slots nobody named.
  await expect(screenBox(page).locator("select")).toHaveCount(0);
  // A lane rack and no figure — nothing here has a response the parameters define.
  await expect(screenBox(page).locator("canvas")).toHaveCount(0);
  await closeScreen(page);
});

test("the rack is the effect's own input and output, with no reduction lane", async ({ page }) => {
  await openFromConsole(page, "FX 1");
  // The tick column carries a caption-shaped spacer of its own, hidden from the
  // accessibility tree so the ticks line up with the levels; the lanes' own captions are
  // the ones that are not.
  const captions = screenBox(page).locator('.gt-cap-label:not([aria-hidden="true"])');
  await expect(captions).toHaveText(["Input", "Output"]);
  // No reduction: a reverb and a delay take no gain off, so a bar there could never move.
  await expect(screenBox(page).locator(".gt-ro.gr")).toHaveCount(0);
  // …and the two tiles name the taps they read.
  await expect(screenBox(page).locator(".gt-ro .k")).toHaveText(["Input", "Pre Fader"]);
  await closeScreen(page);
});

test("Room Size moves the Reverb Time readout on the same input", async ({ page }) => {
  await openFromConsole(page, "FX 1");
  const before = await readout(page, "Reverb Time").innerText();
  const roomSize = screenRow(page, "Room Size").locator('input[type="range"]');
  // The keyboard rather than a drag: the point is that ANOTHER card's number follows this
  // edit, and an arrow key is the same input event a drag fires without a pointer to lose.
  await roomSize.focus();
  for (let i = 0; i < 6; i++) await roomSize.press("ArrowDown");
  await expect(readout(page, "Room Size")).not.toHaveText("29");
  // The seconds are `base(raw) x 3^(RoomSize/31)`, so this card has to have moved too.
  await expect(readout(page, "Reverb Time")).not.toHaveText(before);
  await closeScreen(page);
});

test("Rev-X Plate reads longer than Hall at the same Reverb Time", async ({ page }) => {
  // The unit scales REV-X's Reverb Time per type — its own maxima are the ratio — so the
  // three types print three different numbers for one raw. Reading Hall's on all of them is
  // the defect this pins, and it is 1.7x short on Plate.
  await openFromInspector(page, "bus.fx1");
  const hall = await readout(page, "Reverb Time").innerText();
  await closeScreen(page);
  await chooseOption(typeSelect(page), { label: "Rev-X Plate" });
  await page.locator("#btn-fx-screen").click();
  await expect(screenBox(page)).toBeVisible();
  const plate = await readout(page, "Reverb Time").innerText();
  const secs = (s: string): number => Number(s.replace(/[^\d.]/g, ""));
  expect(secs(plate)).toBeGreaterThan(secs(hall));
  await closeScreen(page);
});

test("a delay face locks whichever row the unit owns", async ({ page }) => {
  // FX 2 holds Mono Delay out of the factory.
  await openFromConsole(page, "FX 2");
  await expect(screenBox(page)).toContainText("FX EFFECT — Mono Delay");
  const sync = screenRow(page, "Sync");
  const note = screenRow(page, "Note");
  const delayTime = screenRow(page, "Delay");
  // Sync off: the unit does not read the note value, so that row is the locked one and the
  // delay time is the operator's.
  await expect(note).toHaveClass(/locked/);
  await expect(delayTime).not.toHaveClass(/locked/);
  // WHICH tag is on which row, not merely that a row is locked: swapping the two message
  // keys leaves every class assertion here satisfied, and the tag is the whole of what tells
  // the operator why the row is not theirs.
  await expect(note).toContainText("Sync off");
  await sync.getByRole("button").first().click();
  // Sync on: the unit recomputes the delay time from BPM and the note value and announces
  // it, so the two swap. Neither row is removed — the face keeps its height either way.
  await expect(delayTime).toHaveClass(/locked/);
  await expect(note).not.toHaveClass(/locked/);
  await expect(delayTime).toContainText("Synced");
  await expect(screenRow(page, "BPM")).not.toHaveClass(/locked/);
  await closeScreen(page);
});

test("switching family rebuilds the rows and keeps the other family's values", async ({ page }) => {
  await openFromInspector(page, "bus.fx1");
  const hpfHall = await readout(page, "HPF").innerText();
  await closeScreen(page);

  await chooseOption(typeSelect(page), { label: "Mono Delay" });
  await page.locator("#btn-fx-screen").click();
  await expect(screenBox(page)).toContainText("FX EFFECT — Mono Delay");
  // A delay row REV-X does not have, and a REV-X row the delay does not.
  await expect(screenRow(page, "Sync")).toBeVisible();
  await expect(screenRow(page, "Room Size")).toHaveCount(0);
  // The two families' HPFs are different parameters under different laws, so the delay's
  // must not be reading the reverb's stored raw.
  const hpfDelay = await readout(page, "HPF").innerText();
  await closeScreen(page);

  // …and going back finds the reverb's own value where it was left.
  await chooseOption(typeSelect(page), { label: "Rev-X Hall" });
  await page.locator("#btn-fx-screen").click();
  await expect(screenBox(page)).toBeVisible();
  await expect(readout(page, "HPF")).toHaveText(hpfHall);
  expect(hpfDelay).not.toBe(hpfHall);
  await closeScreen(page);
});

test("the screen opens bypassed and says so", async ({ page }) => {
  await page.click("#btn-view-console");
  await strip(page, "FX 1").locator(".con-fxface").click();
  await openFromConsole(page, "FX 1");
  // Editable, metered and open — the plan holds the values and the unit stores them.
  await expect(screenBox(page)).toContainText("Bypassed");
  await expect(screenRow(page, "Reverb Time").locator('input[type="range"]')).toBeEnabled();
  await closeScreen(page);
});

test("FX 2 above 96 kHz still opens, with the rate note in front", async ({ page }) => {
  await page.click("#btn-view-graph");
  await chooseOption(page.locator("#rate-picker"), { label: "192 kHz" });
  await openFromInspector(page, "bus.fx2");
  await expect(screenBox(page)).toContainText("above 96 kHz");
  // The bus is gone at this rate; its own controls are not. The values are untouched and
  // the screen is the same screen.
  await expect(screenRow(page, "Delay").locator('input[type="range"]')).toBeEnabled();
  await closeScreen(page);
});

test("the rate note outranks the bypass note when both are true", async ({ page }) => {
  // `offNote` returns one line, rate first. Each existing case makes exactly one of the two
  // conditions true, so the ORDER — which the comment and the doc both call load-bearing —
  // is satisfied by either arrangement until a case makes both true at once.
  await page.click("#btn-view-console");
  await strip(page, "FX 2").locator(".con-fxface").click(); // bypass it
  await page.click("#btn-view-graph");
  await chooseOption(page.locator("#rate-picker"), { label: "192 kHz" });
  await openFromInspector(page, "bus.fx2");
  await expect(screenBox(page)).toContainText("above 96 kHz");
  await expect(screenBox(page)).not.toContainText("Bypassed");
  await closeScreen(page);
});

test("@webkit the FX chip row holds up when it is the tallest head", async ({ page }) => {
  // `--head-h` is the MAX over every strip's natural head height, so "no head overflows" is
  // true by construction and says nothing about this row. What the acceptance criterion is
  // really about is the ONE shape where the FX head can be that max — every mono channel and
  // both MIX buses hidden — so the case builds it instead of measuring the default plan and
  // reading the answer that arrangement always gives.
  const hidden = getModel("URX44V")
    .nodes.filter((n) => n.kind === "channel" || n.id === "bus.mix1" || n.id === "bus.mix2")
    .map((n) => n.id);
  await page.goto(
    `/?plan=${planParamZ({ format: "urx-router-plan", version: 2, modelId: "URX44V", connections: [], nodeParams: {}, hidden })}`,
  );
  await page.click("#btn-view-console");
  const fx1 = strip(page, "FX 1");
  // The row is what the shared height now has to accommodate — asserted here because every
  // measurement below stays true if the block that builds it is deleted.
  await expect(fx1.locator(".con-fxface")).toBeVisible();
  await expect(fx1.locator(".con-fxopen")).toBeVisible();

  const heads = page.locator(".con-strip .con-head");
  expect(await heads.count()).toBeGreaterThan(0);
  const overflow = await heads.evaluateAll((els) =>
    els.filter((e) => e.scrollHeight > e.clientHeight + 1).map((e) => e.textContent?.slice(0, 24) ?? ""),
  );
  expect(overflow, "a head taller than the shared height it is given").toEqual([]);
  // …and the FX head really is the tallest here, which is what makes the rest of this a
  // measurement of the chip row rather than of whichever strip happens to lead.
  const tallest = await heads.evaluateAll((els) => {
    const max = Math.max(...els.map((e) => e.getBoundingClientRect().height));
    const fx = els.find((e) => e.textContent?.includes("FX 1"));
    return { max, fx: fx?.getBoundingClientRect().height ?? -1 };
  });
  expect(tallest.fx, "the FX head is the one setting the shared height").toBe(tallest.max);
  // …and every strip's fader still starts at one offset, which is what a grown head moves.
  const tops = await page
    .locator(".con-strip .con-fader")
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(tops).size, `faders start at ${new Set(tops).size} different offsets`).toBe(1);
});

// ---------------------------------------------------------------------------------------
// What each row DISPLAYS for a stored raw. These arrived with the catalogue corrections and
// asked the Inspector, which is where the parameters were; they ask the screen for the same
// reason they were written — the unit tests hold the descriptors and the formatters, and
// only a panel can be asked whether the formatter's answer reaches the screen.
// ---------------------------------------------------------------------------------------

// The official ranges put THRU on one end of each filter and a frequency on the other, and
// the two ends are different words rather than different numbers — a window that slipped
// back would show a frequency where the unit shows THRU.
test("the delay filters print THRU at the ends the official range names", async ({ page }) => {
  await page.goto(`/?plan=${planParamZ(planWith("bus.fx2", { type: 1024, params: { delayHpf: 0, delayLpf: 122 } }))}`);
  await openFromInspector(page, "bus.fx2");
  await expect(readout(page, "HPF")).toHaveText("THRU");
  await expect(readout(page, "LPF")).toHaveText("THRU");
  await closeScreen(page);

  await page.goto(`/?plan=${planParamZ(planWith("bus.fx2", { type: 1024, params: { delayHpf: 6, delayLpf: 121 } }))}`);
  await openFromInspector(page, "bus.fx2");
  await expect(readout(page, "HPF")).not.toHaveText("THRU");
  await expect(readout(page, "LPF")).not.toHaveText("THRU");
  await closeScreen(page);
});

// Each EFFECT TYPE carries its own factory values, so a channel holding no parameters of
// its own shows the SELECTED type's defaults rather than one type's for the whole family.
test("switching EFFECT TYPE shows the new type's own factory values", async ({ page }) => {
  await gotoEmptySeed(page);
  await openFromInspector(page, "bus.fx2");
  await closeScreen(page);
  await chooseOption(typeSelect(page), { label: "Mono Delay" });
  await page.locator("#btn-fx-screen").click();
  const monoHpf = await readout(page, "HPF").textContent();
  await closeScreen(page);

  await chooseOption(typeSelect(page), { label: "Ping Pong" });
  await page.locator("#btn-fx-screen").click();
  await expect(readout(page, "HPF")).not.toHaveText(monoHpf!);
  await closeScreen(page);
});

// REV-X puts three reverb types on one storage slot and scales the seconds per type, so a
// type change moves the readout while the slider stays put. The plan CARRIES the value,
// which is what holds the slider still; with the key absent the row follows the new type's
// own factory default and the thumb does move, which is the case below.
test("a REV-X type change moves the Reverb Time readout without moving its slider", async ({ page }) => {
  const held = planWith("bus.fx1", { type: 0, params: { reverbTime: 69, roomSize: 0 } });
  await page.goto(`/?plan=${planParamZ(held)}`);
  await openFromInspector(page, "bus.fx1");
  const slider = screenRow(page, "Reverb Time").locator("input[type=range]");
  await expect(slider).toHaveValue("69");
  const hallShown = await readout(page, "Reverb Time").textContent();
  await closeScreen(page);

  await chooseOption(typeSelect(page), { label: "Rev-X Plate" });
  await page.locator("#btn-fx-screen").click();
  await expect(screenRow(page, "Reverb Time").locator("input[type=range]")).toHaveValue("69");
  await expect(readout(page, "Reverb Time")).not.toHaveText(hallShown!);
  await closeScreen(page);
});

// The other half: a channel holding no value of its own follows the SELECTED type's factory
// default, which is per type on the device and was per family in the catalogue.
test("a type change moves an unheld value to the new type's own default", async ({ page }) => {
  await gotoEmptySeed(page);
  await openFromInspector(page, "bus.fx1");
  await closeScreen(page);
  await chooseOption(typeSelect(page), { label: "Rev-X Hall" });
  await page.locator("#btn-fx-screen").click();
  const hallRaw = await screenRow(page, "Reverb Time").locator("input[type=range]").inputValue();
  await closeScreen(page);

  await chooseOption(typeSelect(page), { label: "Rev-X Plate" });
  await page.locator("#btn-fx-screen").click();
  await expect(screenRow(page, "Reverb Time").locator("input[type=range]")).not.toHaveValue(hallRaw);
  await closeScreen(page);
});
