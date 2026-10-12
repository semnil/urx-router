import { test, expect, type Page } from "./fixtures";
import { LIVE_COMMANDS, notifyParam, setDeviceValue, stubTauriDevice, writesOf } from "./tauri-stub";
import { PARAMS } from "../src/core/control/params";

// The unit's [CUE]: live-session state outside the plan. A press in the app writes the
// strip's flag, a press on the unit arrives as a notify, and the group rule — a cue in the
// other group clears the group in use, and the outputs an input cue cleared come back when the
// last input cue goes off — is applied by the app, since the unit does not announce what it
// clears or puts back. The stubbed device keeps what is written and applies no rule of its own,
// so every case here is the app's half.

const CUE_MONO: number = PARAMS.CUE_MONO.id;
const CUE_STEREO_CH: number = PARAMS.CUE_STEREO_CH.id;
const CUE_STEREO: number = PARAMS.CUE_STEREO.id;

const chip = (page: Page, node: string) => page.locator(`#console-host .con-cue[data-cue="${node}"]`);
const frame = (page: Page, node: string) => page.locator(`#graph-host [data-cue-frame="${node}"]`);
// The readout as printed; a screen reader is handed its spoken form beside it.
const readout = (page: Page) => page.locator('#cue-bar-names > [aria-hidden="true"]');

test.beforeEach(async ({ page }) => {
  await stubTauriDevice(page, { commands: LIVE_COMMANDS });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

async function goLive(page: Page): Promise<void> {
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
}

test("with no session the CUE chips are read-only and nothing is cued", async ({ page }) => {
  await page.click("#btn-view-console");
  for (const node of ["ch1", "ch_7_8", "bus.fx1", "bus.mix1", "bus.stream", "bus.stereo"]) {
    await expect(chip(page, node)).toHaveAttribute("aria-disabled", "true");
    await expect(chip(page, node)).toHaveAttribute("aria-pressed", "false");
  }
  // A monitor and the oscillator carry no CUE.
  await expect(chip(page, "bus.mon1")).toHaveCount(0);
  await expect(chip(page, "bus.osc")).toHaveCount(0);
  // Pressed anyway (a read-only chip refuses the pointer's ordinary click): nothing switches.
  await chip(page, "ch1").click({ force: true });
  await expect(chip(page, "ch1")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#cue-bar")).toBeHidden();
});

test("a session starts from what the unit has cued, on both views and the status bar", async ({ page }) => {
  await setDeviceValue(page, CUE_MONO, 0, 1);
  // Both monitors' Cue Interrupt on, as the unit ships; the stub answers 0 for an address
  // nothing seeded.
  await setDeviceValue(page, PARAMS.MONITOR_CUE_INTERRUPT.id, 0, 1);
  await setDeviceValue(page, PARAMS.MONITOR_CUE_INTERRUPT.id, 1, 1);
  await goLive(page);
  await expect(page.locator("#cue-bar")).toBeVisible();
  await expect(readout(page)).toHaveText("CUE CH 1");
  // The board frames the CUE bus's path — CH 1, and both monitors, whose Cue Interrupt is on
  // (what feeds CH 1 is framed too; which source that is depends on the read, and the graph's
  // unit suite pins it) — badges the monitors, and draws a line from CH 1 to each.
  for (const node of ["ch1", "bus.mon1", "bus.mon2"]) await expect(frame(page, node)).toHaveCount(1);
  await expect(frame(page, "bus.stereo")).toHaveCount(0);
  await expect(page.locator("#graph-host [data-cue-badge]")).toHaveCount(2);
  await expect(page.locator(`#graph-host [data-cue-line="ch1 bus.mon1"]`)).toHaveCount(1);
  await expect(page.locator(`#graph-host [data-cue-line="ch1 bus.mon2"]`)).toHaveCount(1);
  await page.click("#btn-view-console");
  await expect(chip(page, "ch1")).toHaveAttribute("aria-pressed", "true");
  await expect(chip(page, "ch2")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(`#console-host [data-cue-monitor="bus.mon1"]`)).toHaveClass(/cue-take/);
});

test("a cued output is framed alone, with its line to each monitor", async ({ page }) => {
  await setDeviceValue(page, CUE_STEREO, 0, 1);
  for (const y of [0, 1]) await setDeviceValue(page, PARAMS.MONITOR_CUE_INTERRUPT.id, y, 1);
  await goLive(page);
  for (const node of ["bus.stereo", "bus.mon1", "bus.mon2"]) await expect(frame(page, node)).toHaveCount(1);
  await expect(page.locator("#graph-host [data-cue-frame]")).toHaveCount(3);
  await expect(page.locator(`#graph-host [data-cue-line="bus.stereo bus.mon1"]`)).toHaveCount(1);
  await expect(page.locator(`#graph-host [data-cue-line="bus.stereo bus.mon2"]`)).toHaveCount(1);
});

test("a press in the app writes the flag and applies the group rule", async ({ page }) => {
  await goLive(page);
  await page.click("#btn-view-console");
  await chip(page, "ch1").click();
  await chip(page, "ch_7_8").click();
  await expect(chip(page, "ch1")).toHaveAttribute("aria-pressed", "true");
  await expect(chip(page, "ch_7_8")).toHaveAttribute("aria-pressed", "true");
  await expect(readout(page)).toHaveText("CUE CH 1, CH 7/8");
  // An output cue clears the input group.
  await chip(page, "bus.stereo").click();
  await expect(chip(page, "bus.stereo")).toHaveAttribute("aria-pressed", "true");
  await expect(chip(page, "ch1")).toHaveAttribute("aria-pressed", "false");
  await expect(chip(page, "ch_7_8")).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(() => writesOf(page).then((w) => w.filter(([id]) => [CUE_MONO, CUE_STEREO_CH, CUE_STEREO].includes(id))))
    .toEqual([
      [CUE_MONO, 1],
      [CUE_STEREO_CH, 1],
      [CUE_STEREO, 1],
    ]);
});

test("a press on the unit's panel is followed, and the outputs it displaced come back", async ({ page }) => {
  await setDeviceValue(page, CUE_STEREO, 0, 1);
  await goLive(page);
  await page.click("#btn-view-console");
  await expect(chip(page, "bus.stereo")).toHaveAttribute("aria-pressed", "true");
  await setDeviceValue(page, CUE_MONO, 0, 1);
  await setDeviceValue(page, CUE_STEREO, 0, 0);
  await notifyParam(page, CUE_MONO, 0, 1);
  await expect(chip(page, "ch1")).toHaveAttribute("aria-pressed", "true");
  await expect(chip(page, "bus.stereo")).toHaveAttribute("aria-pressed", "false");
  // Releasing the last input cue puts STEREO back, with no notify for it.
  await setDeviceValue(page, CUE_MONO, 0, 0);
  await setDeviceValue(page, CUE_STEREO, 0, 1);
  await notifyParam(page, CUE_MONO, 0, 0);
  await expect(chip(page, "ch1")).toHaveAttribute("aria-pressed", "false");
  await expect(chip(page, "bus.stereo")).toHaveAttribute("aria-pressed", "true");
  // Nothing of it went back to the unit.
  expect((await writesOf(page)).filter(([id]) => id === CUE_MONO || id === CUE_STEREO)).toEqual([]);
});

test("Clear CUE turns every cue off and the readout goes", async ({ page }) => {
  await setDeviceValue(page, CUE_MONO, 0, 1);
  await setDeviceValue(page, CUE_STEREO_CH, 1, 1);
  await goLive(page);
  await expect(readout(page)).toHaveText("CUE CH 1, CH 7/8");
  await page.click("#cue-bar-clear");
  await expect(page.locator("#cue-bar")).toBeHidden();
  await expect(frame(page, "ch1")).toHaveCount(0);
  await expect
    .poll(() => writesOf(page).then((w) => w.filter(([id]) => id === CUE_MONO || id === CUE_STEREO_CH)))
    .toEqual([
      [CUE_MONO, 0],
      [CUE_STEREO_CH, 0],
    ]);
});

test("the cue ends with the session", async ({ page }) => {
  await setDeviceValue(page, CUE_MONO, 0, 1);
  await goLive(page);
  await expect(page.locator("#cue-bar")).toBeVisible();
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("#cue-bar")).toBeHidden();
  await expect(frame(page, "ch1")).toHaveCount(0);
});
