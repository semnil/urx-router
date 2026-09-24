import { test, expect, type Page } from "./fixtures";
import { planParamZ } from "./plan-param";
import {
  LIVE_COMMANDS,
  heldReadsOf,
  notifyBurst,
  notifyParam,
  setDeviceValue,
  setHeldReads,
  stubTauriDevice,
  writesOf,
} from "./tauri-stub";
import { PARAMS } from "../src/core/control/params";
import { chooseOption } from "./choose-option";

// +48V and HI-Z are never on together in the app, and A.Gain stops at +40 dB while HI-Z is
// on (docs/en/known-issues.md, "The unit lets +48V and HI-Z be on together; the app does not").

const LOCKED_48V = "Turn Hi-Z off first — +48V and Hi-Z are never on together";
const LOCKED_HIZ = "Turn +48V off first — +48V and Hi-Z are never on together";

const planWith = (ch3: Record<string, unknown>) => ({
  format: "urx-router-plan",
  version: 2,
  modelId: "URX44V",
  connections: [],
  nodeParams: { ch3 },
});

const open = async (page: Page, ch3: Record<string, unknown>): Promise<void> => {
  await page.goto(`/?plan=${planParamZ(planWith(ch3))}`);
  await page.locator("#model-picker").waitFor();
};

const row = (page: Page, label: string) =>
  page
    .locator("#inspector .param")
    .filter({ has: page.locator(".toggle") })
    .filter({ hasText: label });
const gainSlider = (page: Page) =>
  page.locator("#inspector .param", { hasText: "A.Gain" }).locator("input[type=range]");
// The plan's value as the row prints it. A range input clamps what it shows to its own max,
// so the slider alone cannot tell a lowered value from a clamped display.
const gainText = (page: Page) => page.locator("#inspector .param", { hasText: "A.Gain" }).locator(".param-val");
const selectCh3 = (page: Page) => page.locator(`#graph-host g.node[data-id="ch3"]`).click();

const strip = (page: Page, name: string) => page.locator(".con-strip", { has: page.getByText(name, { exact: true }) });
const chip = (page: Page, label: string) => strip(page, "CH 3").locator(".con-chip", { hasText: label }).first();
const gainKnob = (page: Page) => strip(page, "CH 3").locator(".con-knob[aria-label='A.GAIN']");
const gainValue = (page: Page) =>
  strip(page, "CH 3")
    .locator(".con-gain", { has: page.locator(".con-knob[aria-label='A.GAIN']") })
    .locator(".val");

test("the Inspector refuses +48V ON while HI-Z is on, says why, and narrows A.Gain", async ({ page }) => {
  await open(page, { hiZ: true, phantom: false, gain: 30 });
  await selectCh3(page);
  const phantom = row(page, "+48V");
  await expect(phantom).toHaveAttribute("title", LOCKED_48V);
  await expect(phantom.getByRole("button", { name: "ON", exact: true })).toBeDisabled();
  // HI-Z, the lit one, can still be turned off.
  const hiZ = row(page, "Hi-Z");
  await expect(hiZ.getByRole("button", { name: "OFF", exact: true })).toBeEnabled();
  await expect(gainSlider(page)).toHaveAttribute("max", "40");
  await hiZ.getByRole("button", { name: "OFF", exact: true }).click();
  await expect(row(page, "+48V").getByRole("button", { name: "ON", exact: true })).toBeEnabled();
  await expect(gainSlider(page)).toHaveAttribute("max", "70");
  // …and the mirror: with +48V on, HI-Z's ON cannot be pressed.
  await row(page, "+48V").getByRole("button", { name: "ON", exact: true }).click();
  await expect(row(page, "Hi-Z")).toHaveAttribute("title", LOCKED_HIZ);
  await expect(row(page, "Hi-Z").getByRole("button", { name: "ON", exact: true })).toBeDisabled();
});

test("turning HI-Z on lowers A.Gain to +40 dB in one undo step", async ({ page }) => {
  await open(page, { hiZ: false, phantom: false, gain: 60 });
  await selectCh3(page);
  await expect(gainText(page)).toHaveText("+60 dB");
  await row(page, "Hi-Z").getByRole("button", { name: "ON", exact: true }).click();
  await expect(gainText(page)).toHaveText("+40 dB");
  await expect(gainSlider(page)).toHaveAttribute("max", "40");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(row(page, "Hi-Z").locator("button.on")).toHaveText("OFF");
  await expect(gainText(page)).toHaveText("+60 dB");
});

test("the CONSOLE chips follow the same rule, and the A.GAIN knob stops at +40 under HI-Z", async ({ page }) => {
  await open(page, { hiZ: true, phantom: false, gain: 40 });
  await page.click("#btn-view-console");
  await expect(chip(page, "+48")).toHaveClass(/readonly/);
  await expect(chip(page, "+48")).toHaveAttribute("aria-disabled", "true");
  await expect(chip(page, "+48")).toHaveAttribute("title", LOCKED_48V);
  await gainKnob(page).focus();
  await page.keyboard.press("ArrowUp");
  await expect(gainValue(page)).toHaveText("+40");
  // HI-Z off: the chip it locked is live again, and the knob reaches past +40.
  await chip(page, "Hi-Z").click();
  await expect(chip(page, "+48")).not.toHaveClass(/readonly/);
  await gainKnob(page).focus();
  await page.keyboard.press("ArrowUp");
  await expect(gainValue(page)).toHaveText("+41");
  await chip(page, "+48").click();
  await expect(chip(page, "Hi-Z")).toHaveAttribute("title", LOCKED_HIZ);
});

test("a document holding both on opens with +48V off and says so", async ({ page }) => {
  await open(page, { hiZ: true, phantom: true, gain: 60 });
  await expect(page.locator("#statusbar")).toContainText(
    "2 stored values were outside what this app can write, and now read as the nearest value it can send",
  );
  await selectCh3(page);
  await expect(row(page, "+48V").locator("button.on")).toHaveText("OFF");
  await expect(row(page, "Hi-Z").locator("button.on")).toHaveText("ON");
  await expect(gainText(page)).toHaveText("+40 dB");
});

test("a device read finding both on keeps the unit's state and says so", async ({ page }) => {
  // vd_get answers by paramId with no y axis, so every jack reports +48V (0) and HI-Z (6) on.
  await stubTauriDevice(page, { values: { 0: 1, 6: 1, 766: 48000, 848: 0 }, confirm: "Ok" });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-device");
  await page.click("#btn-fetch");
  await expect(page.locator("#statusbar")).toContainText("Fetched", { timeout: 20000 });
  await expect(page.locator("#statusbar")).toContainText("+48V and Hi-Z are both on for CH 3, CH 4");
  expect(
    (await writesOf(page)).filter(([id]) => id === 0 || id === 6),
    "nothing written for it",
  ).toEqual([]);
  await selectCh3(page);
  await expect(row(page, "+48V").locator("button.on")).toHaveText("ON");
  await expect(row(page, "Hi-Z").locator("button.on")).toHaveText("ON");
});

test("starting Live sync on a unit holding both on keeps its state and says so", async ({ page }) => {
  await stubTauriDevice(page, { commands: LIVE_COMMANDS, values: { 0: 1, 6: 1, 766: 48000, 848: 0 } });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
  await expect(page.locator("#statusbar")).toContainText("+48V and Hi-Z are both on for CH 3, CH 4");
  expect(
    (await writesOf(page)).filter(([id]) => id === 0 || id === 6),
    "nothing written for it",
  ).toEqual([]);
});

test("a device follow finding both on says so, and again once the unit turns one back on", async ({ page }) => {
  test.setTimeout(120_000);
  await stubTauriDevice(page, { commands: LIVE_COMMANDS });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
  // CH 3 is y 2. The unit's panel turns HI-Z and +48V on, announced as one batch.
  await setDeviceValue(page, PARAMS.HI_Z.id, 2, 1);
  await setDeviceValue(page, PARAMS.PHANTOM.id, 2, 1);
  await notifyBurst(page, [
    { paramId: PARAMS.HI_Z.id, y: 2, value: 1 },
    { paramId: PARAMS.PHANTOM.id, y: 2, value: 1 },
  ]);
  const note = "+48V and Hi-Z are both on for CH 3";
  // The reconcile read the notify schedules leads its own line with the note.
  await expect(page.locator("#statusbar")).toContainText(`${note} — ← device`, { timeout: 30_000 });
  await selectCh3(page);
  await expect(row(page, "+48V").locator("button.on")).toHaveText("ON");
  await expect(row(page, "Hi-Z").locator("button.on")).toHaveText("ON");
  // The panel turns +48V off: the note goes; turned back on, it returns.
  await setDeviceValue(page, PARAMS.PHANTOM.id, 2, 0);
  await notifyParam(page, PARAMS.PHANTOM.id, 2, 0);
  await expect(row(page, "+48V").locator("button.on")).toHaveText("OFF", { timeout: 30_000 });
  await expect(page.locator("#statusbar")).not.toContainText(note, { timeout: 30_000 });
  await setDeviceValue(page, PARAMS.PHANTOM.id, 2, 1);
  await notifyParam(page, PARAMS.PHANTOM.id, 2, 1);
  await expect(page.locator("#statusbar")).toContainText(note, { timeout: 30_000 });
  expect(
    (await writesOf(page)).filter(([id]) => id === PARAMS.PHANTOM.id || id === PARAMS.HI_Z.id),
    "nothing written for it",
  ).toEqual([]);
});

// The row is drawn from a snapshot of the plan and a gain slide does not rebuild it — the
// slider has to keep the pointer — so the value the cap is taken from is the plan's at the
// moment the switch is pressed.
test("caps the gain the plan holds when Hi-Z goes on, not the one the panel was drawn with", async ({ page }) => {
  await open(page, { hiZ: false, phantom: false, gain: 60 });
  await selectCh3(page);
  await expect(gainText(page)).toHaveText("+60 dB");
  await gainSlider(page).fill("20");
  await expect(gainText(page)).toHaveText("+20 dB");
  await row(page, "Hi-Z").getByRole("button", { name: "ON", exact: true }).click();
  await expect(row(page, "Hi-Z").locator("button.on")).toHaveText("ON");
  await expect(gainText(page), "a gain already under the cap is left where it is").toHaveText("+20 dB");

  // …and the same panel the other way round: raised past the cap since it was drawn, the
  // gain comes down with the switch, in one undo step.
  await row(page, "Hi-Z").getByRole("button", { name: "OFF", exact: true }).click();
  await gainSlider(page).fill("60");
  await expect(gainText(page)).toHaveText("+60 dB");
  await row(page, "Hi-Z").getByRole("button", { name: "ON", exact: true }).click();
  await expect(gainText(page)).toHaveText("+40 dB");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(row(page, "Hi-Z").locator("button.on")).toHaveText("OFF");
  await expect(gainText(page)).toHaveText("+60 dB");
});

// An undo applies its patch whole and asks no surface, so the state it lands on is where
// the rule has to be asked. The device read above is what leaves a channel holding both,
// and undoing the operator's way out of it is what would turn one back on.
test("refuses an undo that would put +48V and Hi-Z back on together, and keeps the step", async ({ page }) => {
  await stubTauriDevice(page, { values: { 0: 1, 6: 1, 766: 48000, 848: 0 }, confirm: "Ok" });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-device");
  await page.click("#btn-fetch");
  await expect(page.locator("#statusbar")).toContainText("+48V and Hi-Z are both on for CH 3, CH 4", {
    timeout: 20000,
  });
  await selectCh3(page);
  await row(page, "+48V").getByRole("button", { name: "OFF", exact: true }).click();
  await expect(row(page, "+48V").locator("button.on")).toHaveText("OFF");

  const held =
    "This step would leave +48V and Hi-Z both on for CH 3 — turn one of them off there first; the step is held back, not lost";
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator("#statusbar")).toContainText(held);
  await expect(row(page, "+48V").locator("button.on")).toHaveText("OFF");
  // Held back rather than taken: the entry is still there to be refused again. The redo in
  // between is what makes the second refusal readable — it writes a line of its own, so the
  // one after it is a line the app wrote rather than the first one still standing.
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(page.locator("#statusbar")).toContainText("Nothing to redo");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator("#statusbar")).toContainText(held);
  // …while the other switch, and an unrelated edit, stay available.
  await row(page, "Hi-Z").getByRole("button", { name: "OFF", exact: true }).click();
  await expect(row(page, "Hi-Z").locator("button.on")).toHaveText("OFF");
  await row(page, "Clip Safe").getByRole("button", { name: "ON", exact: true }).click();
  await expect(row(page, "Clip Safe").locator("button.on")).toHaveText("ON");
  // A fetch writes nothing and neither does an edit behind it — what a refused undo keeps
  // off the link is in the entry suite, where a live session is up.
  expect((await writesOf(page)).filter(([id]) => id === PARAMS.PHANTOM.id)).toEqual([]);
});

// A read in flight is a window in which the plan has not heard what the unit holds, so the
// Inspector takes an ON the unit's own state would refuse. The rule is asked again where the
// read lands: that ON goes back off, the status line says why, and it never reaches the unit.
const switchWrites = async (page: Page, paramId: number): Promise<number[]> =>
  (await writesOf(page)).filter(([id]) => id === paramId).map(([, v]) => v);
const face = (page: Page, label: string) => row(page, label).locator("button.on");
const pressOn = (page: Page, label: string) =>
  row(page, label).getByRole("button", { name: "ON", exact: true }).click();
const startLive = async (page: Page): Promise<void> => {
  await page.click("#btn-device");
  await page.click("#btn-live");
};
const liveOn = (page: Page) =>
  expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });

test("a +48V ON pressed while Live sync's starting read runs is refused where the read finds Hi-Z on", async ({
  page,
}) => {
  await stubTauriDevice(page, { commands: LIVE_COMMANDS, values: { [PARAMS.HI_Z.id]: 1, 766: 48000, 848: 0 } });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await selectCh3(page);
  await setHeldReads(page, [PARAMS.PHANTOM.id]);
  await startLive(page);
  await expect.poll(() => heldReadsOf(page), { timeout: 30_000 }).toBeGreaterThan(0);
  await pressOn(page, "+48V");
  await expect(face(page, "+48V"), "the plan had not heard of the unit's Hi-Z").toHaveText("ON");
  await setHeldReads(page, []);
  await liveOn(page);

  await expect(page.locator("#statusbar")).toContainText(
    "+48V was not turned on for CH 3 — the unit holds Hi-Z on there, and +48V and Hi-Z are never on together",
  );
  await selectCh3(page);
  await expect(face(page, "+48V")).toHaveText("OFF");
  await expect(face(page, "Hi-Z")).toHaveText("ON");
  // An unrelated edit is the flush that would carry a +48V ON the plan still held.
  await pressOn(page, "Clip Safe");
  await expect.poll(() => switchWrites(page, PARAMS.CLIP_SAFE.id), { timeout: 30_000 }).toEqual([1]);
  expect(await switchWrites(page, PARAMS.PHANTOM.id)).toEqual([]);
});

test("a Hi-Z ON pressed while Live sync's starting read runs is refused where the read finds +48V on", async ({
  page,
}) => {
  await stubTauriDevice(page, { commands: LIVE_COMMANDS, values: { [PARAMS.PHANTOM.id]: 1, 766: 48000, 848: 0 } });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await selectCh3(page);
  await setHeldReads(page, [PARAMS.HI_Z.id]);
  await startLive(page);
  await expect.poll(() => heldReadsOf(page), { timeout: 30_000 }).toBeGreaterThan(0);
  await pressOn(page, "Hi-Z");
  await expect(face(page, "Hi-Z")).toHaveText("ON");
  await setHeldReads(page, []);
  await liveOn(page);

  await expect(page.locator("#statusbar")).toContainText(
    "Hi-Z was not turned on for CH 3 — the unit holds +48V on there, and +48V and Hi-Z are never on together",
  );
  await selectCh3(page);
  await expect(face(page, "Hi-Z")).toHaveText("OFF");
  await expect(face(page, "+48V")).toHaveText("ON");
  await pressOn(page, "Clip Safe");
  await expect.poll(() => switchWrites(page, PARAMS.CLIP_SAFE.id), { timeout: 30_000 }).toEqual([1]);
  expect(await switchWrites(page, PARAMS.HI_Z.id)).toEqual([]);
});

test("a +48V ON pressed while a follow read brings in the unit's own Hi-Z ON never reaches the unit", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await stubTauriDevice(page, { commands: LIVE_COMMANDS, values: { 766: 48000, 848: 0 } });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await startLive(page);
  await liveOn(page);

  // CH 3 is y 2. Hi-Z goes on at the unit's panel, and the read its notify schedules is held
  // before it has asked the unit about CH 3.
  await setDeviceValue(page, PARAMS.HI_Z.id, 2, 1);
  await setHeldReads(page, [PARAMS.PHANTOM.id]);
  await notifyParam(page, PARAMS.HI_Z.id, 2, 1);
  await expect.poll(() => heldReadsOf(page), { timeout: 30_000 }).toBeGreaterThan(0);
  await selectCh3(page);
  await expect(face(page, "Hi-Z"), "the plan has not heard yet").toHaveText("OFF");
  await pressOn(page, "+48V");
  await pressOn(page, "Clip Safe");
  // Clip Safe goes out behind +48V in one flush, so its write says the flush is past it.
  await expect.poll(() => switchWrites(page, PARAMS.CLIP_SAFE.id), { timeout: 30_000 }).toEqual([1]);
  expect(await switchWrites(page, PARAMS.PHANTOM.id), "no +48V ON while the unit holds Hi-Z on").toEqual([]);

  await setHeldReads(page, []);
  await expect(page.locator("#statusbar")).toContainText("+48V was not turned on for CH 3", { timeout: 30_000 });
  await selectCh3(page);
  await expect(face(page, "+48V")).toHaveText("OFF");
  await expect(face(page, "Hi-Z")).toHaveText("ON");
  expect(await switchWrites(page, PARAMS.PHANTOM.id)).toEqual([]);
  expect(await switchWrites(page, PARAMS.HI_Z.id), "the unit's own Hi-Z is never written").toEqual([]);
});

// The mirror, and the A.Gain the press lowers goes with it: a refused press moves nothing on the
// unit.
test("a Hi-Z ON pressed while a follow read brings in the unit's own +48V ON sends none of it", async ({ page }) => {
  test.setTimeout(120_000);
  await stubTauriDevice(page, { commands: LIVE_COMMANDS, values: { [PARAMS.HA_GAIN.id]: 6000, 766: 48000, 848: 0 } });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await startLive(page);
  await liveOn(page);
  await selectCh3(page);
  await expect(gainText(page)).toHaveText("+60 dB");

  await setDeviceValue(page, PARAMS.PHANTOM.id, 2, 1);
  await setHeldReads(page, [PARAMS.HI_Z.id]);
  await notifyParam(page, PARAMS.PHANTOM.id, 2, 1);
  await expect.poll(() => heldReadsOf(page), { timeout: 30_000 }).toBeGreaterThan(0);
  await selectCh3(page);
  await pressOn(page, "Hi-Z");
  await expect(gainText(page), "the press lowered A.Gain with it").toHaveText("+40 dB");
  // CH 4 comes after CH 3 in a flush, so its Clip Safe write says the flush is past CH 3's A.Gain.
  await page.locator(`#graph-host g.node[data-id="ch4"]`).click();
  await pressOn(page, "Clip Safe");
  await expect.poll(() => switchWrites(page, PARAMS.CLIP_SAFE.id), { timeout: 30_000 }).toEqual([1]);
  expect({ hiZ: await switchWrites(page, PARAMS.HI_Z.id), gain: await switchWrites(page, PARAMS.HA_GAIN.id) }).toEqual({
    hiZ: [],
    gain: [],
  });

  await setHeldReads(page, []);
  await selectCh3(page);
  await expect(face(page, "Hi-Z")).toHaveText("OFF", { timeout: 30_000 });
  await expect(face(page, "+48V")).toHaveText("ON");
  await expect(gainText(page), "A.Gain is the unit's again").toHaveText("+60 dB");
  expect({ hiZ: await switchWrites(page, PARAMS.HI_Z.id), gain: await switchWrites(page, PARAMS.HA_GAIN.id) }).toEqual({
    hiZ: [],
    gain: [],
  });
});

// A converge re-sends what differs across the write scope. A Hi-Z the unit turned on at its own
// panel differs from a plan the follow read has not reached yet, and is not written off.
test("a converge ahead of the follow read does not write off a Hi-Z the unit's panel turned on", async ({ page }) => {
  test.setTimeout(120_000);
  await stubTauriDevice(page, { commands: LIVE_COMMANDS, values: { 766: 48000, 848: 0 } });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await startLive(page);
  await liveOn(page);
  await selectCh3(page);
  const type = page.locator("#inspector .param", { hasText: "COMP/EQ Type" }).locator("select");
  await expect(type).toBeVisible();

  await setDeviceValue(page, PARAMS.HI_Z.id, 2, 1);
  await notifyParam(page, PARAMS.HI_Z.id, 2, 1);
  await chooseOption(type, "1");
  await expect.poll(() => switchWrites(page, PARAMS.COMP_EQ_TYPE.id), { timeout: 30_000 }).toEqual([1]);
  // The follow read that announcement scheduled lands behind the converge. The select keeps
  // focus, which holds the Inspector's rebuild, so the node is pressed once the read is in.
  await expect(page.locator("#statusbar")).toContainText(/← device \(\d+\)/, { timeout: 30_000 });
  expect(await switchWrites(page, PARAMS.HI_Z.id), "the unit's own Hi-Z is never written").toEqual([]);
  await selectCh3(page);
  await expect(face(page, "Hi-Z")).toHaveText("ON");
});
