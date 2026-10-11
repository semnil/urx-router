// A channel's input stage is the jack or the source it reads: +48V, A.GAIN and HI-Z (where that
// jack has it) on a MIC/LINE jack, D.GAIN on a digital source, nothing on no source. It is held
// there, so every channel reading the same jack or source shows and writes one value.
import { test, expect, type Page } from "./fixtures";
import { drag, port } from "./graph-helpers";
import { planParamZ } from "./plan-param";
import { LIVE_COMMANDS, deviceValueOf, setDeviceValue, stubTauriDevice, writesOf } from "./tauri-stub";
import { PARAMS } from "../src/core/control/params";

const strip = (page: Page, name: string) => page.locator(`.con-strip[aria-label="${name}"]`);
const knob = (page: Page, name: string, label: string) => strip(page, name).locator(`.con-knob[aria-label="${label}"]`);
const chip = (page: Page, name: string, text: string) =>
  strip(page, name).getByRole("button", { name: text, exact: true });
const row = (page: Page, label: string) => page.locator("#inspector .param", { hasText: label });
const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);

const open = async (page: Page, wires: Array<[string, string]>, nodeParams: Record<string, unknown> = {}) => {
  const connections = wires.map(([from, to]) => ({ from: `${from}:out`, to: `${to}:in`, kind: "source" }));
  await page.goto(
    `/?plan=${planParamZ({ format: "urx-router-plan", version: 1, modelId: "URX44V", connections, nodeParams })}`,
  );
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-disclaimer-accepted", "1");
  });
});

test("a channel on no source shows no input stage, and a wire to a jack brings it back", async ({ page }) => {
  await open(page, []);
  await node(page, "ch1").click();
  await expect(row(page, "A.Gain")).toHaveCount(0);
  await expect(row(page, "+48V")).toHaveCount(0);
  await page.click("#btn-view-console");
  await expect(knob(page, "CH 1", "A.GAIN")).toHaveCount(0);
  await expect(chip(page, "CH 1", "+48")).toHaveCount(0);

  await page.click("#btn-view-graph");
  await drag(page, port(page, "in.micline_1_2:out"), port(page, "ch1:in"));
  await node(page, "ch1").click();
  await expect(row(page, "A.Gain")).toHaveCount(1);
  await expect(row(page, "+48V")).toHaveCount(1);
  await page.click("#btn-view-console");
  await expect(knob(page, "CH 1", "A.GAIN")).toBeVisible();
  await expect(chip(page, "CH 1", "+48")).toBeVisible();
});

test("a channel on the jacks with HI-Z shows Hi-Z, and one on a source shows D.GAIN at ±24", async ({ page }) => {
  await open(page, [
    ["in.micline_3_4", "ch1"],
    ["in.micline_3_4", "ch2"],
    ["in.aux", "ch3"],
  ]);
  await page.click("#btn-view-console");
  await expect(chip(page, "CH 1", "Hi-Z")).toBeVisible();
  await expect(chip(page, "CH 3", "+48")).toHaveCount(0);
  await expect(knob(page, "CH 3", "A.GAIN")).toHaveCount(0);
  await expect(knob(page, "CH 3", "D.GAIN")).toHaveAttribute("aria-valuemin", "-24");
  await expect(knob(page, "CH 3", "D.GAIN")).toHaveAttribute("aria-valuemax", "24");
});

test("an A.GAIN edit reaches every strip reading the same jack, and no other", async ({ page }) => {
  await open(page, [
    ["in.micline_1_2", "ch1"],
    ["in.micline_1_2", "ch2"],
    ["in.micline_1_2", "ch3"],
  ]);
  await page.click("#btn-view-console");
  const value = (name: string) => knob(page, name, "A.GAIN");
  await expect(value("CH 3")).toHaveAttribute("aria-valuenow", "-8");
  await value("CH 1").focus();
  await page.keyboard.press("ArrowUp");
  await expect(value("CH 1")).toHaveAttribute("aria-valuenow", "-7");
  await expect(value("CH 3"), "CH 3 reads jack 1 too").toHaveAttribute("aria-valuenow", "-7");
  await expect(value("CH 2"), "CH 2 reads jack 2").toHaveAttribute("aria-valuenow", "-8");
});

// A document's channel keys move by the ADDRESS they were written at — CH 1 wrote jack 1 —
// not by the source wire the document gives CH 1. Crossed, the two readings differ: CH 1 shows
// jack 3's own value, and CH 3, which reads jack 1, shows what the document wrote for CH 1.
test("a document's channel input stage loads onto the jack its channel addressed", async ({ page }) => {
  await open(
    page,
    [
      ["in.micline_3_4", "ch1"],
      ["in.micline_3_4", "ch2"],
      ["in.micline_1_2", "ch3"],
      ["in.micline_1_2", "ch4"],
    ],
    { ch1: { gain: 24, phantom: true }, "in.micline_3_4": { gainL: 40 } },
  );
  await page.click("#btn-view-console");
  await expect(knob(page, "CH 1", "A.GAIN")).toHaveAttribute("aria-valuenow", "40");
  await expect(knob(page, "CH 3", "A.GAIN")).toHaveAttribute("aria-valuenow", "24");
  await expect(chip(page, "CH 3", "+48")).toHaveAttribute("aria-pressed", "true");
});

// Live: the write goes to the jack's own address. The unit has CH 1 and CH 3 on jack 1 and a
// distinct value on jack 3, so a write at a channel's own index would land there instead.
test("a live A.GAIN edit writes the jack the channel reads", async ({ page }) => {
  await stubTauriDevice(page, { commands: LIVE_COMMANDS, values: { 766: 48000, 848: 0 } });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await setDeviceValue(page, PARAMS.INPUT_SOURCE.id, 2, 0); // CH 3's slot on MIC/LINE 1 (jack 1)
  await setDeviceValue(page, PARAMS.HA_GAIN.id, 2, 1700); // jack 3 at +17 dB
  await setDeviceValue(page, PARAMS.HA_GAIN.id, 0, 1000); // jack 1 at +10 dB
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  await page.click("#btn-view-console");
  await expect(knob(page, "CH 3", "A.GAIN"), "the premise: CH 3 reads jack 1").toHaveAttribute("aria-valuenow", "10");
  const before = (await writesOf(page)).filter(([id]) => id === PARAMS.HA_GAIN.id).length;
  await knob(page, "CH 1", "A.GAIN").focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => deviceValueOf(page, PARAMS.HA_GAIN.id, 0)).toBe(1100);
  expect(await deviceValueOf(page, PARAMS.HA_GAIN.id, 2)).toBe(1700);
  expect((await writesOf(page)).filter(([id]) => id === PARAMS.HA_GAIN.id).length - before).toBe(1);
  await expect(page.locator("#statusbar")).not.toContainText("shares device settings");
});
