import { test, expect, type Page } from "./fixtures";
import { planParamZ } from "./plan-param";
import { chooseOption } from "./choose-option";

// FX-channel EFFECT editing in the Inspector: what each row DISPLAYS for a stored raw.
// The unit tests hold the descriptors and the formatters; these hold that the panel puts
// the formatter's answer on screen, which is the half a catalogue test cannot see. Slots,
// windows and per-type defaults: core/control/fx-effect.ts.

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const row = (page: Page, label: string) =>
  page.locator("#inspector .param").filter({ has: page.getByText(label, { exact: true }) });
const rowValue = (page: Page, label: string) => row(page, label).locator(".param-val");
const typeSelect = (page: Page) => page.locator("#inspector .param", { hasText: "EFFECT TYPE" }).locator("select");

const planWith = (nodeId: string, fxEffect: unknown) => ({
  format: "urx-router-plan",
  version: 2,
  modelId: "URX44V",
  connections: [],
  nodeParams: { [nodeId]: { fxEffect } },
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-seed", "empty");
  });
});

// The official ranges put THRU on one end of each filter and a frequency on the other, and
// the two ends are different words rather than different numbers — a window that slipped
// back would show a frequency where the unit shows THRU.
test("the delay filters print THRU at the ends the official range names", async ({ page }) => {
  await page.goto(`/?plan=${planParamZ(planWith("bus.fx2", { type: 1024, params: { delayHpf: 0, delayLpf: 122 } }))}`);
  await node(page, "bus.fx2").click();
  await expect(rowValue(page, "HPF")).toHaveText("THRU");
  await expect(rowValue(page, "LPF")).toHaveText("THRU");

  await page.goto(`/?plan=${planParamZ(planWith("bus.fx2", { type: 1024, params: { delayHpf: 6, delayLpf: 121 } }))}`);
  await node(page, "bus.fx2").click();
  await expect(rowValue(page, "HPF")).not.toHaveText("THRU");
  await expect(rowValue(page, "LPF")).not.toHaveText("THRU");
});

// Each EFFECT TYPE carries its own factory values, so a channel holding no parameters of
// its own shows the SELECTED type's defaults rather than one type's for the whole family.
test("switching EFFECT TYPE shows the new type's own factory values", async ({ page }) => {
  await page.goto("/");
  await node(page, "bus.fx2").click();
  await chooseOption(typeSelect(page), { label: "Mono Delay" });
  const monoHpf = await rowValue(page, "HPF").textContent();

  await chooseOption(typeSelect(page), { label: "Ping Pong" });
  await expect(rowValue(page, "HPF")).not.toHaveText(monoHpf!);
});

// REV-X puts three reverb types on one storage slot and scales the seconds per type, so a
// type change moves the readout while the slider stays put. Only the panel can be asked
// whether it repaints. The plan CARRIES the value, which is what holds the slider still:
// with the key absent the row shows the new type's own factory default and the thumb does
// move, which is the other half of this catalogue change and the case below.
test("a REV-X type change moves the Reverb Time readout without moving its slider", async ({ page }) => {
  const held = planWith("bus.fx1", { type: 0, params: { reverbTime: 69, roomSize: 0 } });
  await page.goto(`/?plan=${planParamZ(held)}`);
  await node(page, "bus.fx1").click();
  const slider = row(page, "Reverb Time").locator("input[type=range]");
  await expect(slider).toHaveValue("69");
  const hallShown = await rowValue(page, "Reverb Time").textContent();

  await chooseOption(typeSelect(page), { label: "Rev-X Plate" });
  await expect(slider).toHaveValue("69");
  await expect(rowValue(page, "Reverb Time")).not.toHaveText(hallShown!);
});

// The other half: a channel holding no value of its own follows the SELECTED type's factory
// default, which is per type on the device and was per family in the catalogue.
test("a type change moves an unheld value to the new type's own default", async ({ page }) => {
  await page.goto("/");
  await node(page, "bus.fx1").click();
  await chooseOption(typeSelect(page), { label: "Rev-X Hall" });
  const slider = row(page, "Reverb Time").locator("input[type=range]");
  const hallRaw = await slider.inputValue();

  await chooseOption(typeSelect(page), { label: "Rev-X Plate" });
  await expect(slider).not.toHaveValue(hallRaw);
});
