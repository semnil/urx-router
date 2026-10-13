import { test, expect, type Page } from "./fixtures";
import {
  deviceValueOf,
  heldReadsOf,
  heldWritesOf,
  releaseHeldWrite,
  setHeldWrites,
  LIVE_COMMANDS,
  notifyParam,
  setDeviceValue,
  setHeldReads,
  setRefusedCommands,
  setWriteEffect,
  stubTauriDevice,
  writesOf,
  dialogsOf,
  untilAnswered,
} from "./tauri-stub";
import { chooseOption } from "./choose-option";
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
  // The frame is drawn on a layer over the strip's contents, so the readout's cell borders
  // cannot cut it: a box covering the strip, stacked above every positioned box inside it.
  const layer = await page.locator(`#console-host [data-cue-monitor="bus.mon1"]`).evaluate((strip) => {
    const after = getComputedStyle(strip, "::after");
    const inner = [...strip.querySelectorAll("*")]
      .map((e) => getComputedStyle(e))
      .filter((s) => s.position !== "static" && s.zIndex !== "auto")
      .map((s) => Number(s.zIndex));
    return {
      position: after.position,
      inset: [after.top, after.right, after.bottom, after.left],
      framed: after.boxShadow.includes("inset"),
      above: inner.every((z) => z < Number(after.zIndex)),
    };
  });
  expect(layer).toEqual({ position: "absolute", inset: ["0px", "0px", "0px", "0px"], framed: true, above: true });
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
  // What the unit does with the STEREO write, which the app reads back behind it: the input cues go.
  await setWriteEffect(page, CUE_STEREO, 0, 1, [
    [CUE_MONO, 0, 0],
    [CUE_STEREO_CH, 1, 0],
  ]);
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

// The graph view's way to the same switch: the selected node's CUE row in the inspector.
const cueRow = (page: Page) => page.locator('#inspector .param[data-param-label="CUE"]');

test("a node's CUE row in the inspector is read-only with no session and switches the flag with one", async ({
  page,
}) => {
  await page.locator(`#graph-host g.node[data-id="ch1"]`).click();
  await expect(cueRow(page).getByRole("button", { name: "ON", exact: true })).toBeDisabled();
  // A monitor carries no CUE of its own.
  await page.locator(`#graph-host g.node[data-id="bus.mon1"]`).click();
  await expect(cueRow(page)).toHaveCount(0);
  await goLive(page);
  await page.locator(`#graph-host g.node[data-id="ch1"]`).click();
  await cueRow(page).getByRole("button", { name: "ON", exact: true }).click();
  await expect(readout(page)).toHaveText("CUE CH 1");
  await expect(frame(page, "ch1")).toHaveCount(1);
  await expect(cueRow(page).getByRole("button", { name: "ON", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => writesOf(page).then((w) => w.filter(([id]) => id === CUE_MONO))).toEqual([[CUE_MONO, 1]]);
  // A press on the unit is followed onto the row.
  await setDeviceValue(page, CUE_MONO, 0, 0);
  await notifyParam(page, CUE_MONO, 0, 0);
  await expect(cueRow(page).getByRole("button", { name: "OFF", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#cue-bar")).toBeHidden();
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

test("a pair linked on the unit takes its primary's cue, which clears a cue on the partner alone", async ({ page }) => {
  await setDeviceValue(page, CUE_MONO, 1, 1);
  await goLive(page);
  await page.click("#btn-view-console");
  await expect(chip(page, "ch2")).toHaveAttribute("aria-pressed", "true");
  // The unit links CH 1/2: it copies CH 1's flag (off) onto CH 2 and announces both changes.
  for (const y of [0, 1]) await setDeviceValue(page, PARAMS.SIGNAL_TYPE.id, y, 1);
  await setDeviceValue(page, CUE_MONO, 1, 0);
  await notifyParam(page, PARAMS.SIGNAL_TYPE.id, 0, 1);
  await notifyParam(page, CUE_MONO, 1, 0);
  await expect(chip(page, "ch2")).toHaveAttribute("aria-pressed", "false", { timeout: 10_000 });
  await expect(page.locator("#cue-bar")).toBeHidden();
});

test("a pair linked in the app takes its primary's cue, which clears a cue on the partner alone", async ({ page }) => {
  await setDeviceValue(page, CUE_MONO, 1, 1);
  await goLive(page);
  await page.locator(`#graph-host g.node[data-id="ch1"]`).click();
  await chooseOption(page.locator("#inspector .param", { hasText: "Signal Type" }).locator("select"), "1");
  // What the unit does with the link write: CH 1's flag (off) copied onto CH 2, and announced.
  await setDeviceValue(page, CUE_MONO, 1, 0);
  await notifyParam(page, CUE_MONO, 1, 0);
  await page.click("#btn-view-console");
  await expect(chip(page, "ch2")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#cue-bar")).toBeHidden();
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

// An output cue the unit was holding from before the session: STEREO cued, then CH 1, then the
// session started. The app's read sees CH 1 alone, and turning CH 1 off puts STEREO back on the
// unit with no notify for it.
async function goLiveWithHeldOutput(page: Page): Promise<void> {
  await setDeviceValue(page, CUE_MONO, 0, 1);
  await setWriteEffect(page, CUE_MONO, 0, 0, [[CUE_STEREO, 0, 1]]);
  await goLive(page);
  await expect(readout(page)).toHaveText("CUE CH 1");
}

test("turning the last input cue off in the app shows the output cue the unit put back", async ({ page }) => {
  await goLiveWithHeldOutput(page);
  await page.click("#btn-view-console");
  await chip(page, "ch1").click();
  await expect(chip(page, "bus.stereo")).toHaveAttribute("aria-pressed", "true");
  await expect(chip(page, "ch1")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#cue-bar-names")).toHaveText("CUE STEREO (MAIN)");
  expect((await writesOf(page)).filter(([id]) => id === CUE_STEREO)).toEqual([]);
});

test("Clear CUE also turns off an output cue the unit held from before the session", async ({ page }) => {
  await goLiveWithHeldOutput(page);
  await page.click("#cue-bar-clear");
  await expect
    .poll(() => writesOf(page).then((w) => w.filter(([id]) => id === CUE_MONO || id === CUE_STEREO)))
    .toEqual([
      [CUE_MONO, 0],
      [CUE_STEREO, 0],
    ]);
  await expect(page.locator("#cue-bar")).toBeHidden();
  await page.click("#btn-view-console");
  await expect(chip(page, "bus.stereo")).toHaveAttribute("aria-pressed", "false");
});

test("a read of the flags that lands after the session ended shows nothing", async ({ page }) => {
  await goLive(page);
  // A press on the unit that changed nothing still schedules a read; it is held, and the session
  // ends before it is answered.
  await setHeldReads(page, [CUE_MONO]);
  await notifyParam(page, CUE_MONO, 0, 0);
  await expect.poll(() => heldReadsOf(page)).toBeGreaterThan(0);
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "false");
  await setDeviceValue(page, CUE_MONO, 0, 1);
  await setHeldReads(page, []);
  await expect.poll(() => heldReadsOf(page)).toBe(0);
  // A session's release disconnects only once the cue reads it waits for have landed.
  await untilAnswered(page, "vd_disconnect");
  await expect(page.locator("#cue-bar")).toBeHidden();
  await page.click("#btn-view-console");
  await expect(chip(page, "ch1")).toHaveAttribute("aria-pressed", "false");
  // The next session reads the unit as it is.
  await goLive(page);
  await expect(readout(page)).toHaveText("CUE CH 1");
});

for (const cmd of ["vd_params_subscribe", "vd_watch_link"]) {
  test(`a session whose ${cmd} is refused leaves nothing cued, and the next one reads the unit`, async ({ page }) => {
    await setDeviceValue(page, CUE_MONO, 0, 1);
    await setRefusedCommands(page, [cmd]);
    await page.click("#btn-device");
    await page.click("#btn-live");
    await expect.poll(() => dialogsOf(page)).toContainEqual(expect.stringContaining(`${cmd} refused`));
    await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "false");
    await expect(page.locator("#cue-bar")).toBeHidden();
    await setRefusedCommands(page, []);
    await goLive(page);
    await expect(readout(page)).toHaveText("CUE CH 1");
  });
}

test("a read behind one write does not undo a cue still waiting to be written", async ({ page }) => {
  await goLive(page);
  await page.click("#btn-view-console");
  await setHeldWrites(page, [CUE_MONO]);
  await chip(page, "ch1").click();
  await chip(page, "ch2").click();
  await expect.poll(() => heldWritesOf(page)).toBe(1);
  // CH 1's write lands; the read queued behind it runs before CH 2's write goes out, and CH 2's
  // write is then held in its turn.
  await releaseHeldWrite(page);
  await expect.poll(() => writesOf(page)).toEqual([[CUE_MONO, 1]]);
  await expect.poll(() => heldWritesOf(page)).toBe(1);
  await expect(chip(page, "ch2")).toHaveAttribute("aria-pressed", "true");
  // The operator takes CH 2 back off before its first write has landed.
  await chip(page, "ch2").click();
  await setHeldWrites(page, []);
  await expect
    .poll(() => writesOf(page))
    .toEqual([
      [CUE_MONO, 1],
      [CUE_MONO, 1],
      [CUE_MONO, 0],
    ]);
  expect(await deviceValueOf(page, CUE_MONO, 1)).toBe(0);
  await expect(chip(page, "ch2")).toHaveAttribute("aria-pressed", "false");
  await expect(chip(page, "ch1")).toHaveAttribute("aria-pressed", "true");
  await expect(readout(page)).toHaveText("CUE CH 1");
});
