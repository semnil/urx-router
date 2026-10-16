import { test, expect, type Page } from "./fixtures";
import {
  LIVE_COMMANDS,
  notifyParam,
  savedFilesOf,
  setDeviceValue,
  stubTauriBoot,
  stubTauriDevice,
  writesOf,
} from "./tauri-stub";
import { PARAMS } from "../src/core/control/params";
import { chooseOption } from "./choose-option";
import { insertFxSection, openInsertFxSection } from "./insert-fx-section";
import { en } from "../src/i18n/en";

// The SIM view: the unit's LCD (urx-lcd-sim) as a third surface over the same plan,
// offered by an experimental launch only. Its edits go through the plan's funnels, so the
// graph, the undo history and the LCD agree whichever surface made the change.

const sim = (page: Page) => page.locator("#sim-host .urx-lcd-sim");
/** The LCD's own root, inside the shadow tree the SIM view draws it in. */
const glass = (page: Page) => sim(page).locator(".embed-glass");
/** CH 1's [ON] on the LCD's HOME screen, the first strip's. */
const ch1On = (page: Page) => sim(page).locator(".btn-on").first();
const ch1Muted = (page: Page) => page.locator('#graph-host g.node[data-id="ch1"] text:text-is("MUTE")');

async function openSim(page: Page): Promise<void> {
  await stubTauriBoot(page, { experimental_enabled: true });
  await page.goto("/");
  await expect(page.locator("#btn-view-sim")).toBeVisible();
  await page.click("#btn-view-sim");
  await expect(sim(page).locator(".lcd")).toBeVisible();
}

test("offers no SIM tab and no SIM Scale without an experimental launch", async ({ page }) => {
  await stubTauriBoot(page);
  await page.goto("/");
  await expect(page.locator("#btn-view-console")).toBeVisible();
  await expect(page.locator("#btn-view-sim")).toBeHidden();
  await page.click("#btn-view");
  await expect(page.locator("#view-menu .sim-scale")).toHaveCount(5);
  for (const item of await page.locator("#view-menu .sim-scale").all()) await expect(item).toBeHidden();
});

test("shows the LCD in place of the board, the view named on the root", async ({ page }) => {
  await openSim(page);
  await expect(page.locator("#btn-view-sim")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#graph-host")).toBeHidden();
  await expect(page.locator("#console-host")).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-view", "sim");
  await page.click("#btn-view-graph");
  await expect(page.locator("#sim-host")).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-view", "graph");
});

test("an edit on the LCD is the plan's: the graph shows it and undo takes it back on the LCD", async ({ page }) => {
  await openSim(page);
  await expect(ch1On(page)).toHaveAttribute("aria-pressed", "true");
  await ch1On(page).click();
  await expect(ch1On(page)).toHaveAttribute("aria-pressed", "false");

  await page.click("#btn-view-graph");
  await expect(ch1Muted(page)).toHaveCount(1);

  await page.click("#btn-view-sim");
  await page.locator("#sim-host").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(ch1On(page), "the undo reaches the LCD").toHaveAttribute("aria-pressed", "true");
  await page.click("#btn-view-graph");
  await expect(ch1Muted(page)).toHaveCount(0);
});

/** CH 1's fader readout on HOME, the control the LCD turns the level with. */
const ch1Level = (page: Page) => sim(page).locator(".strip-level").first();

test("a key on the LCD is one undo step", async ({ page }) => {
  await openSim(page);
  await expect(ch1Level(page)).toHaveText("0.00");
  await ch1Level(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(ch1Level(page)).not.toHaveText("0.00");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(ch1Level(page)).toHaveText("0.00");
});

test("a drag on the LCD is one undo step, and an undo waits for it to end", async ({ page }) => {
  await openSim(page);
  const box = await ch1Level(page).boundingBox();
  if (!box) throw new Error("CH 1's level is not laid out");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 40, { steps: 8 });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator("#statusbar")).toContainText("Finish the current drag before undoing");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 80, { steps: 8 });
  await page.mouse.up();
  await expect(ch1Level(page)).not.toHaveText("0.00");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(ch1Level(page), "the whole drag is one step").toHaveText("0.00");
});

test("an edit made in the graph's inspector reaches the LCD", async ({ page }) => {
  await openSim(page);
  await page.click("#btn-view-graph");
  await page.locator('g.node[data-id="ch1"]').click();
  await page
    .locator("#inspector .param")
    .filter({ has: page.locator(".toggle") })
    .filter({ hasText: "Channel" })
    .getByRole("button", { name: "OFF", exact: true })
    .click();
  await page.click("#btn-view-sim");
  await expect(ch1On(page)).toHaveAttribute("aria-pressed", "false");
});

test("SIM Scale draws the LCD at the scale chosen, and the choice is kept", async ({ page }) => {
  await openSim(page);
  await expect(page.locator('#view-menu .sim-scale[data-sim-scale="100"]')).toHaveAttribute("aria-checked", "true");
  await page.click("#btn-view");
  await page.click('#view-menu .sim-scale[data-sim-scale="150"]');
  await expect(glass(page)).toHaveAttribute("style", /--zoom:\s*1\.5/);
  await expect(page.locator('#view-menu .sim-scale[data-sim-scale="150"]')).toHaveAttribute("aria-checked", "true");
  await page.reload();
  await expect(glass(page)).toHaveAttribute("style", /--zoom:\s*1\.5/);
});

test("comes back on the SIM tab after a reload, once the experimental launch is known", async ({ page }) => {
  await openSim(page);
  await page.reload();
  await expect(page.locator("#btn-view-sim")).toHaveAttribute("aria-pressed", "true");
  await expect(sim(page).locator(".lcd")).toBeVisible();
});

test("draws the ground around the LCD the same in both themes", async ({ page }) => {
  await openSim(page);
  const ground = () =>
    page.locator("#sim-host").evaluate((el) => {
      const s = getComputedStyle(el);
      return `${s.backgroundColor} ${s.backgroundImage} ${s.colorScheme}`;
    });
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  const dark = await ground();
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  const light = await ground();
  expect(light).toBe(dark);
  expect(dark).toContain("dark");
});

test("holds the unit's own settings shut on the LCD, with the reason as its tooltip", async ({ page }) => {
  await openSim(page);
  const lcd = sim(page).locator(".lcd[data-screen]:not([inert])");
  await lcd.getByRole("button", { name: "SETUP", exact: true }).click();
  await expect(sim(page).locator('.lcd[data-screen="setup"]:not([inert])')).toHaveCount(1);
  const language = lcd.getByRole("button", { name: "Language", exact: true });
  await expect(language).toHaveAttribute("aria-disabled", "true");
  await expect(language).toHaveAttribute("title", en.sim.lockDeviceSetup);
  await expect(language.locator(".lock-mark")).toHaveCount(1);
  const version = lcd.getByRole("button", { name: "Version", exact: true });
  await expect(version, "a screen the plan does not hold is not held either").not.toHaveAttribute("aria-disabled");

  // Pressed where it stands (Playwright declines to click a control marked out of reach), then Version:
  // the LCD reaching Version's screen says the press on Language was answered and opened nothing.
  const at = (await language.boundingBox())!;
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
  await version.click();
  await expect(sim(page).locator('.lcd[data-screen="setup.version"]:not([inert])')).toHaveCount(1);
});

// A change the unit makes beside the one asked for — a BUS Type resetting its bank, an EFFECT TYPE
// refilling its effect — reaches the plan the same from the LCD as from the Inspector.

const SAVE = { "plugin:dialog|save": "/tmp/urx-e2e-plan.urxr", write_text_file: null };
/** The LCD's screen on top. */
const lcd = (page: Page) => sim(page).locator(".lcd[data-screen]:not([inert])");
const onScreen = (page: Page, id: string) => sim(page).locator(`.lcd[data-screen="${id}"]:not([inert])`);

interface SavedPlan {
  nodeParams: Record<string, Record<string, unknown>>;
  connections: { from: string; to: string; params?: Record<string, unknown> }[];
}

/** Open the SIM view on a shell that answers a save. */
async function openSimSaving(page: Page): Promise<void> {
  await stubTauriDevice(page, { commands: { experimental_enabled: true, ...SAVE } });
  await page.goto("/");
  await page.click("#btn-view-sim");
  await expect(lcd(page)).toBeVisible();
}

/** Save the plan and read back the document written. */
async function save(page: Page): Promise<SavedPlan> {
  const before = (await savedFilesOf(page)).length;
  await page.evaluate(() => (document.getElementById("btn-save") as HTMLButtonElement).click());
  await expect.poll(async () => (await savedFilesOf(page)).length).toBe(before + 1);
  return JSON.parse((await savedFilesOf(page)).at(-1)!) as SavedPlan;
}

/** Press `target` and wait for `id`'s screen, pressing once more where the first press only took the focus. */
async function tapInto(page: Page, target: ReturnType<Page["locator"]>, id: string): Promise<void> {
  await target.click();
  if ((await onScreen(page, id).count()) === 0) await target.click();
  await expect(onScreen(page, id)).toHaveCount(1);
}

/** Open a block of the channel view, pressed off the switches inside it. */
async function openBlock(page: Page, name: string | RegExp, id: string): Promise<void> {
  const box = (await lcd(page).getByRole("button", { name }).first().boundingBox())!;
  await page.mouse.click(box.x + 6, box.y + box.height - 6);
  if ((await onScreen(page, id).count()) === 0) await page.mouse.click(box.x + 6, box.y + box.height - 6);
  await expect(onScreen(page, id)).toHaveCount(1);
}

/** A fresh page on the GRAPH with `id` selected in the Inspector. */
async function inspect(page: Page, id: string): Promise<void> {
  await page.goto("/");
  await page.click("#btn-view-graph");
  await page.locator(`#graph-host g.node[data-id="${id}"]`).click();
}

test("BUS Type FIXED leaves the same plan from the LCD as from the Inspector", async ({ page }) => {
  await openSimSaving(page);
  await lcd(page)
    .getByRole("button", { name: /channel bank/ })
    .click();
  await lcd(page).getByRole("button", { name: "MIX, ST STREAMING", exact: true }).click();
  await tapInto(page, lcd(page).getByRole("button", { name: "MIX 1 settings", exact: true }), "channel-view");
  await tapInto(
    page,
    lcd(page)
      .getByRole("button", { name: /^MIX 1 / })
      .first(),
    "ch.setting",
  );
  await lcd(page)
    .getByRole("button", { name: /BUS Type/ })
    .click();
  await sim(page).getByRole("option", { name: "FIXED", exact: true }).click();
  const mix = (p: SavedPlan) => ({
    bus: { busType: p.nodeParams["bus.mix1"]?.busType, panLink: p.nodeParams["bus.mix1"]?.panLink },
    sends: p.connections.filter((c) => c.to === "bus.mix1:in").sort((a, b) => a.from.localeCompare(b.from)),
  });
  const fromLcd = mix(await save(page));
  expect(fromLcd.bus.busType, "the LCD's choice reached the plan").toBe(1);

  await inspect(page, "bus.mix1");
  await chooseOption(page.locator("#inspector .param", { hasText: "BUS Type" }).locator("select"), "1");
  expect(fromLcd).toEqual(mix(await save(page)));
});

for (const effect of ["Rev-X Room", "Mono Delay"]) {
  test(`FX 1's EFFECT TYPE ${effect} leaves the same plan from the LCD as from the Inspector`, async ({ page }) => {
    await openSimSaving(page);
    await lcd(page)
      .getByRole("button", { name: /channel bank/ })
      .click();
    await lcd(page).getByRole("button", { name: "FX 1 - 2", exact: true }).click();
    await tapInto(page, lcd(page).getByRole("button", { name: "FX1 settings", exact: true }), "channel-view");
    await openBlock(page, /FX1 effect/, "ch.effect");
    await lcd(page).getByRole("button", { name: "Select the inserted effect" }).click();
    await sim(page).getByRole("button", { name: effect, exact: true }).click();
    await expect(lcd(page).getByRole("button", { name: "Select the inserted effect" })).toHaveText(effect);
    const fromLcd = (await save(page)).nodeParams["bus.fx1"]?.fxEffect;

    await inspect(page, "bus.fx1");
    await chooseOption(page.locator("#inspector .param", { hasText: "EFFECT TYPE" }).locator("select"), {
      label: effect,
    });
    expect(fromLcd).toEqual((await save(page)).nodeParams["bus.fx1"]?.fxEffect);
  });
}

/** The insert FX's values a plan holds on `id`. */
const insertOf = (p: SavedPlan, id: string) => ({
  insertFx: p.nodeParams[id]?.insertFx,
  insertFxOn: p.nodeParams[id]?.insertFxOn,
  insertFxParams: p.nodeParams[id]?.insertFxParams,
});

/** Open the INS FX block of CH 1, or of MIX 1, on the LCD. */
async function openInsert(page: Page, id: "ch1" | "bus.mix1"): Promise<void> {
  if (id === "bus.mix1") {
    await lcd(page)
      .getByRole("button", { name: /channel bank/ })
      .click();
    await lcd(page).getByRole("button", { name: "MIX, ST STREAMING", exact: true }).click();
    await tapInto(page, lcd(page).getByRole("button", { name: "MIX 1 settings", exact: true }), "channel-view");
  } else {
    await tapInto(page, lcd(page).getByRole("button", { name: "C H 1 settings", exact: true }), "channel-view");
  }
  await openBlock(page, /INS FX/, "ch.insfx");
}

/** Choose `effect` on the INS FX block that is open. */
async function pickInsert(page: Page, effect: string): Promise<void> {
  await lcd(page).getByRole("button", { name: "Select the inserted effect" }).click();
  await sim(page).getByRole("button", { name: effect, exact: true }).click();
  await expect(lcd(page).getByRole("button", { name: "Select the inserted effect" })).toHaveText(effect);
}

for (const [effect, id] of [
  ["Compander-S", "ch1"],
  ["Pitch Fix", "ch1"],
  ["Clean", "ch1"],
  ["M.B.Comp", "bus.mix1"],
] as const) {
  test(`INS FX ${effect} on ${id} leaves the same plan from the LCD as from the Inspector`, async ({ page }) => {
    await openSimSaving(page);
    await openInsert(page, id);
    await pickInsert(page, effect);
    const fromLcd = insertOf(await save(page), id);
    expect(fromLcd.insertFxParams, "the effect's values reached the plan").toBeDefined();

    await inspect(page, id);
    await openInsertFxSection(page);
    await chooseOption(insertFxSection(page).locator(".param", { hasText: "EFFECT TYPE" }).locator("select"), {
      label: effect,
    });
    expect(fromLcd).toEqual(insertOf(await save(page), id));
  });
}

test("a value of the insert changed on the LCD is the raw the plan holds", async ({ page }) => {
  await openSimSaving(page);
  await openInsert(page, "ch1");
  await pickInsert(page, "Compander-S");
  const threshold = lcd(page).getByRole("slider", { name: "Threshold", exact: true });
  await expect(threshold).toHaveAttribute("aria-valuenow", "-8");
  await threshold.focus();
  await page.keyboard.press("ArrowUp");
  await expect(threshold).not.toHaveAttribute("aria-valuenow", "-8");
  const shown = Number(await threshold.getAttribute("aria-valuenow"));
  expect((await save(page)).nodeParams.ch1?.insertFxParams).toMatchObject({ "compander:6": Math.round(shown * 100) });
});

test("1-knob EQ switched on from the LCD is on in the plan", async ({ page }) => {
  await openSimSaving(page);
  await tapInto(page, lcd(page).getByRole("button", { name: "C H 1 settings", exact: true }), "channel-view");
  await openBlock(page, /^EQ/, "ch.eq");
  const knob = lcd(page)
    .getByRole("button", { name: /1-knob/ })
    .first();
  await knob.click();
  await expect.poll(async () => (await save(page)).nodeParams.ch1?.eqOneKnob).toMatchObject({ on: true });
});

test("an insert effect chosen again on the LCD keeps the values the plan holds for it, as the Inspector does", async ({
  page,
}) => {
  await openSimSaving(page);
  await openInsert(page, "ch1");
  await pickInsert(page, "Compander-S");
  const threshold = lcd(page).getByRole("slider", { name: "Threshold", exact: true });
  await threshold.focus();
  await page.keyboard.press("ArrowUp");
  await expect(threshold).not.toHaveAttribute("aria-valuenow", "-8");
  const tuned = ((await save(page)).nodeParams.ch1?.insertFxParams as Record<string, number> | undefined)?.[
    "compander:6"
  ];
  expect(tuned, "the LCD's turn reached the plan").not.toBe(-800);

  await pickInsert(page, "Clean");
  await pickInsert(page, "Compander-S");
  await expect(threshold, "the LCD shows the value the plan kept").toHaveAttribute(
    "aria-valuenow",
    String((tuned as number) / 100),
  );
  expect((await save(page)).nodeParams.ch1?.insertFxParams).toMatchObject({ "compander:6": tuned });

  // The Inspector's own choice over the same plan keeps it as well.
  await page.click("#btn-view-graph");
  await page.locator('#graph-host g.node[data-id="ch1"]').click();
  await openInsertFxSection(page);
  const select = insertFxSection(page).locator(".param", { hasText: "EFFECT TYPE" }).locator("select");
  await chooseOption(select, { label: "Clean" });
  await chooseOption(select, { label: "Compander-S" });
  expect((await save(page)).nodeParams.ch1?.insertFxParams).toMatchObject({ "compander:6": tuned });
});

// HOME's [Sends] destination is the unit's UI state, outside the plan: a session reads it, a
// choice on the unit's panel arrives as a notify, and a choice on the glass is written to it.
test("the LCD's [Sends] destination is the unit's while Live sync is up, and the glass's own without", async ({
  page,
}) => {
  const SENDS: number = PARAMS.SENDS_TARGET.id;
  await stubTauriDevice(page, { values: { [SENDS]: 32 }, commands: { experimental_enabled: true, ...LIVE_COMMANDS } });
  await page.goto("/");
  await page.click("#btn-view-sim");
  await expect(lcd(page)).toBeVisible();
  const tab = lcd(page).locator(".sends-target");
  const pick = async (name: string): Promise<void> => {
    await tab.click();
    await lcd(page).getByRole("button", { name, exact: true }).click();
    await expect(tab).toHaveText(name);
  };
  const sendsWrites = async (): Promise<number[]> =>
    (await writesOf(page)).flatMap(([id, v]) => (id === SENDS ? [v] : []));

  // No session: the choice is the glass's and reaches nothing.
  await pick("FX 1");
  expect(await sendsWrites()).toEqual([]);

  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  await expect(tab, "the session shows what the unit holds").toHaveText("MIX 1");

  // A choice on the unit's panel.
  await setDeviceValue(page, SENDS, 0, 16);
  await notifyParam(page, SENDS, 0, 16);
  await expect(tab).toHaveText("FX 1");
  expect(await sendsWrites(), "the unit's own choice is not written back").toEqual([]);

  // A choice on the glass goes to the unit.
  await pick("MIX 2");
  await expect.poll(sendsWrites).toEqual([34]);
});
