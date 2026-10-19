import { test, expect, type Page } from "./fixtures";
import {
  LIVE_COMMANDS,
  deviceValueOf,
  notifyParam,
  savedFilesOf,
  setDeviceValue,
  setWriteEffect,
  strWritesOf,
  stubTauriBoot,
  stubTauriDevice,
  writesOf,
} from "./tauri-stub";
import { COLOR_PALETTE, PARAMS } from "../src/core/control/params";
import { fxParams } from "../src/core/control/fx-effect";
import { defaultPlan } from "../src/models/initial-state";
import { serialize, type Plan } from "../src/core/plan";
import type { ModelId } from "../src/models/types";
import { planParamZ } from "./plan-param";
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

test("holds Software Integration shut on the LCD with no session, with the reason as its tooltip", async ({ page }) => {
  await openSim(page);
  const lcd = sim(page).locator(".lcd[data-screen]:not([inert])");
  await lcd.getByRole("button", { name: "SETUP", exact: true }).click();
  await expect(sim(page).locator('.lcd[data-screen="setup"]:not([inert])')).toHaveCount(1);
  const integration = lcd.getByRole("button", { name: /Software\s*Integration/ });
  await expect(integration).toHaveAttribute("aria-disabled", "true");
  await expect(integration).toHaveAttribute("title", en.sim.lockIntegrationOff);
  await expect(integration.locator(".lock-mark")).toHaveCount(1);
  const patch = lcd.getByRole("button", { name: "Output Patch", exact: true });
  await expect(patch, "the plan's Output Patch is not held").not.toHaveAttribute("aria-disabled");

  // Pressed where it stands (Playwright declines to click a control marked out of reach), then
  // Output Patch: the LCD reaching that screen says the press on Software Integration was answered
  // and opened nothing.
  const at = (await integration.boundingBox())!;
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
  await patch.click();
  await expect(sim(page).locator('.lcd[data-screen="setup.patch"]:not([inert])')).toHaveCount(1);
});

// A session tells the glass whether a DAW holds the unit, and the glass draws the entry as the unit
// does. Once the session ends, what it told the glass goes with it, and the entry is held shut with
// the reason again.
test("holds Software Integration shut again once Live sync ends, with the reason as its tooltip", async ({ page }) => {
  await stubTauriDevice(page, { commands: { experimental_enabled: true, ...LIVE_COMMANDS } });
  await page.goto("/");
  await page.click("#btn-view-sim");
  await expect(lcd(page)).toBeVisible();
  await tapInto(page, lcd(page).getByRole("button", { name: "SETUP", exact: true }), "setup");
  const integration = lcd(page).getByRole("button", { name: /Software\s*Integration/ });
  await expect(integration.locator(".lock-mark"), "held with no session").toHaveCount(1);

  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  await expect(integration.locator(".lock-mark"), "drawn as the unit draws it, no DAW holding it").toHaveCount(0);
  await expect(integration).toHaveAttribute("aria-disabled", "true");

  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "false");
  await expect(integration).toHaveAttribute("title", en.sim.lockIntegrationOff);
  await expect(integration.locator(".lock-mark")).toHaveCount(1);
});

// What the session told the glass goes when it ends, and what the glass keeps for its own showing
// stays: the channel selected on it, the bank it shows and its knob mode.
test("keeps the LCD's selected channel when Live sync ends", async ({ page }) => {
  await stubTauriDevice(page, { commands: { experimental_enabled: true, ...LIVE_COMMANDS } });
  await page.goto("/");
  await page.click("#btn-view-sim");
  const selected = glass(page).locator(".strip.is-selected .strip-id");
  await expect(selected).toHaveText("CH 1");
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  await glass(page)
    .locator(".strip")
    .filter({ has: page.locator(".strip-id", { hasText: /^CH 2$/ }) })
    .locator(".strip-name")
    .click();
  await expect(selected).toHaveText("CH 2");
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#rate-picker"), "the session's link is let go").toBeEnabled();
  await expect(selected).toHaveText("CH 2");
});

test("keeps the LCD's bank and knob mode when Live sync ends", async ({ page }) => {
  await stubTauriDevice(page, { commands: { experimental_enabled: true, ...LIVE_COMMANDS } });
  await page.goto("/");
  await page.click("#btn-view-sim");
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  await glass(page).locator(".bank-btn").click();
  await glass(page).locator(".bank-option-output").last().click();
  await expect(glass(page).locator(".bank-btn")).toHaveAttribute("aria-label", "OUTPUT channel bank 1 of 1");
  await glass(page).getByRole("button", { name: "USER DEFINED KNOBS mode", exact: true }).click();
  await expect(glass(page).locator(".udk-toggle")).toHaveAttribute("aria-pressed", "true");
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#rate-picker"), "the session's link is let go").toBeEnabled();
  await expect(glass(page).locator(".bank-btn")).toHaveAttribute("aria-label", "OUTPUT channel bank 1 of 1");
  await expect(glass(page).locator(".udk-toggle")).toHaveAttribute("aria-pressed", "true");
});

test("takes Follow USB on the LCD's Sampling Frequency screen as the toolbar's FOLLOW USB", async ({ page }) => {
  await stubTauriDevice(page, {
    values: { [PARAMS.FOLLOW_USB.id]: 1 },
    commands: { experimental_enabled: true },
  });
  await page.goto("/");
  await page.click("#btn-view-sim");
  await expect(lcd(page)).toBeVisible();
  await tapInto(page, lcd(page).getByRole("button", { name: "SETUP", exact: true }), "setup");
  await tapInto(page, lcd(page).getByRole("button", { name: "Sampling Frequency" }), "setup.rate");
  const follow = lcd(page).getByRole("button", { name: "Follow USB", exact: true });
  const badge = page.locator("#follow-usb");
  await expect(follow).not.toHaveAttribute("aria-disabled");
  await expect(badge).toHaveAttribute("data-state", "unknown");
  // Unknown: the press reads the unit, as the toolbar's does, and both show what it holds.
  await follow.click();
  await expect(badge).toHaveAttribute("data-state", "on");
  await expect(follow).toHaveAttribute("aria-pressed", "true");
  // Known: the press switches it on the unit.
  await follow.click();
  await expect(badge).toHaveAttribute("data-state", "off");
  await expect(follow).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(async () => (await writesOf(page)).filter(([id]) => id === PARAMS.FOLLOW_USB.id))
    .toEqual([[PARAMS.FOLLOW_USB.id, 0]]);
});

// While Follow USB is on the unit takes no rate from its own Sampling Frequency screen either, so
// during Live sync the LCD opens that screen with no lock of the app's own and holds the rates still
// from the Follow USB it is given: a press there changes nothing and writes nothing.
test("leaves the Sampling Frequency screen to the unit during Live sync while Follow USB is on", async ({ page }) => {
  const RATE: number = PARAMS.SAMPLE_RATE.id;
  await stubTauriDevice(page, {
    values: { [PARAMS.FOLLOW_USB.id]: 1, [RATE]: 48000 },
    commands: { experimental_enabled: true, ...LIVE_COMMANDS },
  });
  await page.goto("/");
  await page.click("#btn-view-sim");
  await expect(lcd(page)).toBeVisible();
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  await expect(page.locator("#follow-usb")).toHaveAttribute("data-state", "on");
  await tapInto(page, lcd(page).getByRole("button", { name: "SETUP", exact: true }), "setup");
  const entry = lcd(page).getByRole("button", { name: "Sampling Frequency" });
  await expect(entry.locator(".lock-mark")).toHaveCount(0);
  await tapInto(page, entry, "setup.rate");
  await expect(lcd(page).getByRole("button", { name: "Follow USB", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const rate = lcd(page).getByRole("button", { name: "96kHz", exact: true });
  await expect(rate).toHaveAttribute("aria-disabled", "true");
  await expect(rate.locator(".lock-mark")).toHaveCount(0);
  // Pressed where it stands, since Playwright declines to click a control marked out of reach.
  const at = (await rate.boundingBox())!;
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
  await expect(rate).toHaveAttribute("aria-pressed", "false");
  expect((await writesOf(page)).filter(([id]) => id === RATE)).toEqual([]);
  await expect(page.locator("#rate-picker")).toHaveValue("48000");
});

// The app holds the Sampling Frequency screen shut while it is connected to the unit and the rate is
// not one Live sync takes (Scene only here), and lets it go the moment the connection is let go,
// which comes after the session has ended rather than with it. The toolbar's rate field gives the
// same reason as its tooltip, and drops it once the rate opens.
test("holds the Sampling Frequency screen shut while connected during Live sync, and opens it once the link is let go", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("urx-settings", JSON.stringify({ deviceScope: "scene" })));
  await stubTauriDevice(page, {
    values: { [PARAMS.FOLLOW_USB.id]: 0, [PARAMS.SAMPLE_RATE.id]: 48000 },
    commands: { experimental_enabled: true, ...LIVE_COMMANDS },
  });
  await page.goto("/");
  await page.click("#btn-view-sim");
  await expect(lcd(page)).toBeVisible();
  await tapInto(page, lcd(page).getByRole("button", { name: "SETUP", exact: true }), "setup");
  const entry = lcd(page).getByRole("button", { name: "Sampling Frequency" });
  await expect(entry.locator(".lock-mark"), "not held with no connection").toHaveCount(0);

  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  await expect(entry).toHaveAttribute("aria-disabled", "true");
  await expect(entry).toHaveAttribute("title", en.sim.lockRateScope);
  await expect(entry.locator(".lock-mark")).toHaveCount(1);
  const rateField = page.locator("label", { has: page.locator("#rate-picker") });
  await expect(page.locator("#rate-picker")).toBeDisabled();
  await expect(rateField, "the toolbar's rate names the same reason").toHaveAttribute("title", en.sim.lockRateScope);

  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("#rate-picker"), "the toolbar's rate is open again").toBeEnabled();
  await expect(rateField, "and names no reason").not.toHaveAttribute("title");
  await expect(entry.locator(".lock-mark")).toHaveCount(0);
  await expect(entry).not.toHaveAttribute("aria-disabled");
  await tapInto(page, entry, "setup.rate");
});

// The unit's SETUP > GENERAL settings are written over the Live sync session alone: with no session
// the LCD holds their screens shut with the reason as the tooltip, and during Live sync an edit there
// is written to the unit.
test("holds SETUP > GENERAL shut on the LCD with no session, and writes an edit there during Live sync", async ({
  page,
}) => {
  const BRIGHTNESS: number = PARAMS.BRIGHTNESS.id;
  await stubTauriDevice(page, {
    values: { [BRIGHTNESS]: 5 },
    commands: { experimental_enabled: true, ...LIVE_COMMANDS },
  });
  await page.goto("/");
  await page.click("#btn-view-sim");
  await expect(lcd(page)).toBeVisible();
  await tapInto(page, lcd(page).getByRole("button", { name: "SETUP", exact: true }), "setup");
  const entry = lcd(page).getByRole("button", { name: "Brightness", exact: true });
  await expect(entry).toHaveAttribute("aria-disabled", "true");
  await expect(entry).toHaveAttribute("title", en.sim.lockSetupOffline);
  await expect(entry.locator(".lock-mark")).toHaveCount(1);
  // Pressed where it stands (Playwright declines to click a control marked out of reach): the LCD
  // stays on SETUP, and nothing reaches the unit.
  const at = (await entry.boundingBox())!;
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
  await expect(onScreen(page, "setup")).toHaveCount(1);
  const brightnessWrites = async (): Promise<number[]> =>
    (await writesOf(page)).flatMap(([id, v]) => (id === BRIGHTNESS ? [v] : []));
  expect(await brightnessWrites()).toEqual([]);

  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  await expect(entry.locator(".lock-mark")).toHaveCount(0);
  await tapInto(page, entry, "setup.brightness");
  await onScreen(page, "setup.brightness").getByRole("spinbutton").focus();
  await page.keyboard.press("ArrowDown");
  await expect.poll(brightnessWrites).toEqual([4]);
});

// A dialog already open on the LCD when Live sync ends is held with the setting it sets: its [OK]
// is drawn shut with the reason as the tooltip and writes nothing, and once Live sync is up again
// the same [OK] writes the pick to the unit.
for (const { name, params, values, open } of [
  {
    name: "USER DEFINED KNOBS' assignment",
    params: [PARAMS.UDK_FUNCTION.id, PARAMS.UDK_PARAM1.id, PARAMS.UDK_PARAM2.id] as number[],
    values: {},
    open: async (page: Page): Promise<void> => {
      await tapInto(page, lcd(page).getByRole("button", { name: "User Defined Knobs", exact: true }), "setup.udk");
      await lcd(page).locator(".udk-knob").first().click();
      await expect(onScreen(page, "setup.udk.assign")).toHaveCount(1);
      await lcd(page)
        .locator(".pick-dialog-col")
        .first()
        .locator('.pick-dialog-row[aria-pressed="false"]')
        .first()
        .click();
    },
  },
  {
    name: "TIME ZONE",
    params: [PARAMS.TIME_ZONE.id] as number[],
    values: {},
    open: async (page: Page): Promise<void> => {
      await tapInto(page, lcd(page).getByRole("button", { name: "Date/Time", exact: true }), "setup.datetime");
      await tapInto(page, lcd(page).getByRole("button", { name: /^Time Zone/ }), "setup.datetime.zone");
      await lcd(page).locator('.pick-dialog-row[aria-pressed="false"]').first().click();
    },
  },
  {
    name: "Auto Power Off's warning",
    params: [PARAMS.AUTO_POWER_OFF.id] as number[],
    // On, so that switching it off asks.
    values: { [PARAMS.AUTO_POWER_OFF.id]: 1 },
    open: async (page: Page): Promise<void> => {
      await tapInto(page, lcd(page).getByRole("button", { name: "Power Management", exact: true }), "setup.power");
      await lcd(page).getByRole("button", { name: "Enable", exact: true }).click();
    },
  },
]) {
  test(`holds ${name}'s [OK] shut once Live sync ends with it open, and writes it once Live sync is up again`, async ({
    page,
  }) => {
    await stubTauriDevice(page, { values, commands: { experimental_enabled: true, ...LIVE_COMMANDS } });
    await page.goto("/");
    await page.click("#btn-view-sim");
    await expect(lcd(page)).toBeVisible();
    const live = async (on: boolean): Promise<void> => {
      await page.click("#btn-device");
      await page.click("#btn-live");
      await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", String(on), { timeout: 30_000 });
    };
    const setupWrites = async (): Promise<number> =>
      (await writesOf(page)).filter(([id]) => params.includes(id)).length +
      (await strWritesOf(page)).filter(([id]) => params.includes(id)).length;
    const ok = sim(page).getByRole("button", { name: "OK", exact: true });

    await live(true);
    await tapInto(page, lcd(page).getByRole("button", { name: "SETUP", exact: true }), "setup");
    await open(page);
    await expect(ok).toBeVisible();
    await expect(ok).not.toHaveAttribute("aria-disabled");

    await live(false);
    await expect(ok).toHaveAttribute("aria-disabled", "true");
    await expect(ok).toHaveAttribute("title", en.sim.lockSetupOffline);
    await expect(ok.locator(".lock-mark")).toHaveCount(1);
    const before = await setupWrites();
    // Pressed where it stands (Playwright declines to click a control marked out of reach), its box
    // taken once the LCD has drawn it.
    let at: { x: number; y: number; width: number; height: number } | null = null;
    await expect.poll(async () => (at = await ok.boundingBox())).not.toBeNull();
    await page.mouse.click(at!.x + at!.width / 2, at!.y + at!.height / 2);
    await expect(ok, "the dialog stays up").toBeVisible();
    expect(await setupWrites(), "nothing reaches the unit").toBe(before);

    await live(true);
    await expect(ok.locator(".lock-mark")).toHaveCount(0);
    const reconnected = await setupWrites();
    await ok.click();
    await expect(ok, "the dialog closes").toHaveCount(0);
    await expect.poll(setupWrites, "the pick is written to the unit").toBeGreaterThan(reconnected);
  });
}

// A change the unit makes beside the one asked for — a BUS Type resetting its bank, an EFFECT TYPE
// refilling its effect — reaches the plan the same from the LCD as from the Inspector.

const SAVE = { "plugin:dialog|save": "/tmp/urx-e2e-plan.urxr", write_text_file: null };
/** The LCD's screen on top. */
const lcd = (page: Page) => sim(page).locator(".lcd[data-screen]:not([inert])");
const onScreen = (page: Page, id: string) => sim(page).locator(`.lcd[data-screen="${id}"]:not([inert])`);

interface SavedPlan {
  sampleRate?: number;
  nodeNames?: Record<string, string>;
  nodeColors?: Record<string, string>;
  nodeParams: Record<string, Record<string, unknown>>;
  connections: { from: string; to: string; params?: Record<string, unknown> }[];
}

/** Open the SIM view on a shell that answers a save, on `path` (a `?plan=` link, say). */
async function openSimSaving(page: Page, opts: { model?: ModelId; path?: string } = {}): Promise<void> {
  await stubTauriDevice(page, { model: opts.model, commands: { experimental_enabled: true, ...SAVE } });
  await page.goto(opts.path ?? "/");
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

/** A fresh page on the GRAPH with `id` selected in the Inspector, on `path`. */
async function inspect(page: Page, id: string, path = "/"): Promise<void> {
  await page.goto(path);
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

// While Live sync is up, an EFFECT TYPE chosen on any surface leaves the incoming type's factory
// value on the unit — what the unit's own refill puts there — and does not carry over a value the
// unit's panel moved for the outgoing type into a key the two types share.
for (const surface of ["inspector", "console", "lcd"] as const) {
  test(`an EFFECT TYPE chosen from the ${surface} during Live sync leaves the incoming type's default on the unit`, async ({
    page,
  }) => {
    const HPF = fxParams(0).find((d) => d.key === "revxHpf")!;
    const roomHpf = fxParams(1).find((d) => d.key === "revxHpf")!.def;
    const tuned = roomHpf === 10 ? 20 : 10;
    await stubTauriDevice(page, { commands: { experimental_enabled: true, ...LIVE_COMMANDS } });
    await page.goto("/");
    await page.click("#btn-device");
    await page.click("#btn-live");
    await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
    // The unit's panel moves the HPF, which announces nothing, and a type write refills the array.
    await setDeviceValue(page, 681, HPF.slot, tuned);
    await setWriteEffect(page, 679, 0, 1, [[681, HPF.slot, roomHpf]]);
    const before = (await writesOf(page)).length;
    if (surface === "inspector") {
      await page.click("#btn-view-graph");
      await page.locator('#graph-host g.node[data-id="bus.fx1"]').click();
      await chooseOption(page.locator("#inspector .param", { hasText: "EFFECT TYPE" }).locator("select"), "1");
    } else if (surface === "console") {
      await page.click("#btn-view-console");
      await page
        .locator(".con-strip")
        .filter({ has: page.locator(".con-head", { hasText: "FX 1" }) })
        .locator(".con-fxopen")
        .click();
      await page.locator('[data-ctl="fx:1"]').click();
    } else {
      await page.click("#btn-view-sim");
      await expect(lcd(page)).toBeVisible();
      await lcd(page)
        .getByRole("button", { name: /channel bank/ })
        .click();
      await lcd(page).getByRole("button", { name: "FX 1 - 2", exact: true }).click();
      await tapInto(page, lcd(page).getByRole("button", { name: "FX1 settings", exact: true }), "channel-view");
      await openBlock(page, /FX1 effect/, "ch.effect");
      await lcd(page).getByRole("button", { name: "Select the inserted effect" }).click();
      await sim(page).getByRole("button", { name: "Rev-X Room", exact: true }).click();
    }
    // The array goes out behind the type; what the unit holds after it is the verdict.
    const writes = async (): Promise<number[]> => (await writesOf(page)).slice(before).map(([id]) => id);
    await expect.poll(async () => (await writes()).indexOf(679), { timeout: 20_000 }).toBeGreaterThan(-1);
    await expect
      .poll(async () => (await writes()).lastIndexOf(681) > (await writes()).indexOf(679), { timeout: 20_000 })
      .toBe(true);
    await expect.poll(() => deviceValueOf(page, 681, HPF.slot)).toBe(roomHpf);
  });
}

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

// The unit's COMP 1-knob, switched on, sets attack, release, Auto Makeup and the level, and on its
// own COMP screen neither attack nor release turns while it stays on — with nothing drawn on them to
// say so. The LCD's switch is that switch: the plan takes the same values, and the LCD, which
// simulates the unit, holds attack still with no padlock and no dimming of the app's own.
test("COMP 1-knob switched on from the LCD sets the knob's values in the plan and holds attack still", async ({
  page,
}) => {
  await openSimSaving(page);
  await tapInto(page, lcd(page).getByRole("button", { name: "C H 1 settings", exact: true }), "channel-view");
  await openBlock(page, /^COMP/, "ch.comp");
  const attack = lcd(page).getByRole("spinbutton", { name: "Attack", exact: true });
  const attackInPlan = async (): Promise<unknown> =>
    ((await save(page)).nodeParams.ch1?.comp as { attack?: number })?.attack;
  // With the knob off, a turn of Attack reaches the plan.
  await attack.focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(attackInPlan).not.toBe(34.58);

  await lcd(page)
    .getByRole("button", { name: /1-knob/ })
    .first()
    .click();
  await expect
    .poll(async () => (await save(page)).nodeParams.ch1?.comp)
    .toMatchObject({ oneKnob: true, attack: 24.87, release: 295.5, autoMakeup: false, oneKnobLevel: 0 });
  await expect(attack.locator(".lock-mark")).toHaveCount(0);
  await expect(attack).not.toHaveAttribute("title", /.+/);
  await attack.focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  expect(await attackInPlan(), "the knob holds Attack still").toBe(24.87);
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

// The unit holds the values an insert's own switch drives still, with nothing drawn on them: the
// M.B.Comp bands while its 1-knob is on, Pitch Fix's notes while MIDI Control is on. The LCD,
// which simulates the unit, draws them the same way — no padlock of the app's own — and holds
// them itself, so a turn or a touch there leaves the plan as it was.
test("leaves the M.B.Comp bands its 1-knob drives to the LCD, which holds them with no padlock", async ({ page }) => {
  await openSimSaving(page);
  await openInsert(page, "bus.mix1");
  await pickInsert(page, "M.B.Comp");
  await lcd(page).getByRole("button", { name: "Next page of settings" }).click();
  const attack = lcd(page).getByRole("spinbutton", { name: "Attack", exact: true });
  const engine = async (): Promise<string> => JSON.stringify(insertOf(await save(page), "bus.mix1").insertFxParams);
  const before = await engine();
  // With the knob off, a turn of a band reaches the plan.
  await attack.focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(engine).not.toBe(before);

  await lcd(page)
    .getByRole("button", { name: /1-knob/ })
    .first()
    .click();
  await expect(attack).toHaveAttribute("aria-disabled", "true");
  await expect(attack.locator(".lock-mark")).toHaveCount(0);
  const held = await engine();
  await attack.focus();
  await page.keyboard.press("ArrowUp");
  expect(await engine(), "the knob holds the band still").toBe(held);
});

test("leaves Pitch Fix's notes under MIDI Control to the LCD, which holds them with no padlock", async ({ page }) => {
  await openSimSaving(page, {
    path: planLink("URX44V", (plan) => {
      plan.nodeParams.ch1 = {
        ...plan.nodeParams.ch1,
        insertFx: 512,
        insertFxOn: true,
        insertFxParams: { "pitch:34": 1 },
      };
    }),
  });
  await openInsert(page, "ch1");
  await lcd(page).getByRole("button", { name: "Next page of settings" }).click();
  const c = lcd(page).getByRole("button", { name: "C", exact: true });
  await expect(c).toHaveAttribute("aria-disabled", "true");
  await expect(c.locator(".lock-mark")).toHaveCount(0);
  const engine = async (): Promise<string> => JSON.stringify(insertOf(await save(page), "ch1").insertFxParams);
  const held = await engine();
  // Pressed where it stands, since Playwright declines to click a control marked out of reach.
  const at = (await c.boundingBox())!;
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
  expect(await engine(), "MIDI Control holds the notes still").toBe(held);
});

/** A `?plan=` link to `model`'s new plan with `edit` applied to it. */
function planLink(model: ModelId, edit: (plan: Plan) => void): string {
  const plan = defaultPlan(model);
  edit(plan);
  return `/?plan=${planParamZ(JSON.parse(serialize(plan)))}`;
}

/** CH 1's and CH 2's settings and the wires into and out of them, as a saved plan holds them. */
const firstPair = (p: SavedPlan) => ({
  ch1: p.nodeParams.ch1,
  ch2: p.nodeParams.ch2,
  wires: p.connections
    .filter((c) => /^ch[12]:/.test(c.from) || /^ch[12]:/.test(c.to))
    .sort((a, b) => `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`)),
});

// Linking a pair, and taking a linked pair into SSMCS, also writes which channel each of its
// compressors hears: the simulator's own record, which the plan does not hold.
for (const model of ["URX22", "URX44", "URX44V"] as const) {
  test(`Signal Type STEREO and back on ${model}'s CH 1/2 leaves the same plan from the LCD as from the Inspector`, async ({
    page,
  }) => {
    await openSimSaving(page, { model });
    await tapInto(page, lcd(page).getByRole("button", { name: "C H 1 settings", exact: true }), "channel-view");
    await tapInto(
      page,
      lcd(page)
        .getByRole("button", { name: /^CH 1 / })
        .first(),
      "ch.setting",
    );
    const pick = async (type: string): Promise<void> => {
      await lcd(page)
        .getByRole("button", { name: /Signal Type/ })
        .click();
      await sim(page).getByRole("option", { name: type, exact: true }).click();
    };
    await pick("STEREO");
    const linked = firstPair(await save(page));
    expect(linked.ch1?.stereoLink, "the LCD's link reached the plan").toBe(true);
    await pick("MONO x 2");
    const unlinked = firstPair(await save(page));
    expect(unlinked.ch1?.stereoLink, "the LCD's unlink reached the plan").not.toBe(true);

    await inspect(page, "ch1");
    const select = page.locator("#inspector .param", { hasText: "Signal Type" }).locator("select");
    await chooseOption(select, "1");
    expect(linked).toEqual(firstPair(await save(page)));
    await chooseOption(select, "0");
    expect(unlinked).toEqual(firstPair(await save(page)));
  });
}

test("SSMCS on a linked pair leaves the same plan from the LCD as from the Inspector", async ({ page }) => {
  const link = planLink("URX44V", (plan) => {
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, stereoLink: true, panBal: 1 };
  });
  await openSimSaving(page, { path: link });
  await tapInto(page, lcd(page).getByRole("button", { name: "C H 1 settings", exact: true }), "channel-view");
  await tapInto(
    page,
    lcd(page)
      .getByRole("button", { name: /^CH 1 / })
      .first(),
    "ch.setting",
  );
  await lcd(page)
    .getByRole("button", { name: /COMP slash EQ/ })
    .click();
  await sim(page).getByRole("option", { name: "SSMCS", exact: true }).click();
  const fromLcd = firstPair(await save(page));
  expect(fromLcd.ch1?.compEqType, "the LCD's SSMCS reached the plan").toBe(1);

  await inspect(page, "ch1", link);
  await chooseOption(page.locator("#inspector .param", { hasText: "COMP/EQ Type" }).locator("select"), "1");
  expect(fromLcd).toEqual(firstPair(await save(page)));
});

// While 1-knob EQ is on the unit drives the bands, and the plan keeps the gains it held — the
// ones it sends once 1-knob is off again — as every other surface leaves them.
test("turning 1-knob EQ's level on the LCD leaves the plan's band gains, and the LCD shows them", async ({ page }) => {
  const link = planLink("URX44V", (plan) => {
    plan.nodeParams.ch1 = { ...plan.nodeParams.ch1, eqOneKnob: { on: true, type: 0, level: 50 } };
    plan.nodeParams.ch1.eqBands![0].gain = 6;
  });
  await openSimSaving(page, { path: link });
  const lowGain = (p: SavedPlan) => (p.nodeParams.ch1?.eqBands as { gain: number }[] | undefined)?.[0]?.gain;
  const oneKnob = (p: SavedPlan) => p.nodeParams.ch1?.eqOneKnob as { on?: boolean; level?: number } | undefined;
  const openEq = async (): Promise<void> => {
    await tapInto(page, lcd(page).getByRole("button", { name: "C H 1 settings", exact: true }), "channel-view");
    await openBlock(page, /^EQ/, "ch.eq");
  };
  const shown = () => lcd(page).getByRole("slider", { name: "LOW Gain", exact: true });
  await openEq();
  const level = lcd(page).locator(".oneknob-level");
  await level.focus();
  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => oneKnob(await save(page))?.level).toBe(49);
  expect(lowGain(await save(page)), "a level away from 50").toBe(6);
  await level.focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(async () => oneKnob(await save(page))?.level).toBe(50);
  expect(lowGain(await save(page)), "the level back at 50").toBe(6);

  // 1-knob off: the band the LCD now offers is the one the plan holds and sends.
  await lcd(page).locator("button.oneknob").click();
  await expect.poll(async () => oneKnob(await save(page))?.on).toBe(false);
  await expect(shown()).toHaveAttribute("aria-valuenow", "6");
  expect(lowGain(await save(page))).toBe(6);

  // Undone, 1-knob is on again over the same gain.
  await page.locator("#sim-host").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => oneKnob(await save(page))?.on).toBe(true);
  expect(lowGain(await save(page))).toBe(6);

  // The plan opened again shows the gain it holds once 1-knob is off.
  await page.goto(link);
  await page.click("#btn-view-sim");
  await openEq();
  await lcd(page).locator("button.oneknob").click();
  await expect(shown()).toHaveAttribute("aria-valuenow", "6");
});

// The LCD's edits that are not a node's parameters: a channel's name and colour, an output's
// source — a wire drawn or deleted — and the sampling frequency.
test("a name, a colour, an output's source and the rate set on the LCD reach the plan", async ({ page }) => {
  await openSimSaving(page);
  await tapInto(page, lcd(page).getByRole("button", { name: "C H 1 settings", exact: true }), "channel-view");
  await tapInto(
    page,
    lcd(page)
      .getByRole("button", { name: /^CH 1 / })
      .first(),
    "ch.setting",
  );
  const name = lcd(page).getByRole("textbox", { name: "Channel name" });
  await name.fill("Vox");
  await name.press("Enter");
  await lcd(page)
    .getByRole("button", { name: /^Color:/ })
    .click();
  await lcd(page).getByRole("button", { name: "Red", exact: true }).click();
  await expect.poll(async () => (await save(page)).nodeNames?.ch1).toBe("Vox");
  expect((await save(page)).nodeColors?.ch1).toBe(COLOR_PALETTE.find((c) => c.name === "Red")!.hex);

  await tapInto(page, lcd(page).getByRole("button", { name: "HOME", exact: true }), "home");
  await tapInto(page, lcd(page).getByRole("button", { name: "SETUP", exact: true }), "setup");
  await tapInto(page, lcd(page).getByRole("button", { name: "Output Patch" }), "setup.patch");
  const mainOut = (p: SavedPlan) => p.connections.filter((c) => c.to === "out.main:in").map((c) => c.from);
  const pickMainOut = async (source: string): Promise<void> => {
    await lcd(page)
      .getByRole("button", { name: /^MAIN OUT:/ })
      .click();
    await lcd(page).getByRole("button", { name: source, exact: true }).click();
  };
  await pickMainOut("MIX 1");
  await expect.poll(async () => mainOut(await save(page))).toEqual(["bus.mix1:out"]);
  await pickMainOut("None");
  await expect.poll(async () => mainOut(await save(page))).toEqual([]);

  await tapInto(page, lcd(page).getByRole("button", { name: "Back", exact: true }), "setup");
  await tapInto(page, lcd(page).getByRole("button", { name: "Sampling Frequency" }), "setup.rate");
  const rate = lcd(page).getByRole("button", { name: "96kHz", exact: true });
  await rate.click();
  await expect(rate).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await save(page)).sampleRate).toBe(96000);
});

// A choice the unit takes in one step and the board in several: a USB output on a mono pair takes
// the pair's two channels in place of the source it had.
test("a mono pair chosen for a USB output on the LCD wires both of its channels there", async ({ page }) => {
  await openSimSaving(page);
  await tapInto(page, lcd(page).getByRole("button", { name: "SETUP", exact: true }), "setup");
  await tapInto(page, lcd(page).getByRole("button", { name: "Output Patch" }), "setup.patch");
  const usb = lcd(page).getByRole("button", { name: "USB", exact: true });
  await usb.click();
  await expect(usb, "the tab the screen has open is the glass's own").toHaveAttribute("aria-pressed", "true");
  await lcd(page)
    .getByRole("button", { name: /^USB MAIN A:/ })
    .click();
  await lcd(page).getByRole("button", { name: "CH 1/2", exact: true }).click();
  const sources = (p: SavedPlan) =>
    p.connections
      .filter((c) => c.to === "out.usbmain_a:in")
      .map((c) => c.from)
      .sort();
  await expect.poll(async () => sources(await save(page))).toEqual(["ch1:out", "ch2:out"]);
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

  // Above 96 kHz the unit moves FX 2 to FX 1 and announces nothing; the rate it announces is
  // followed by a read of the destination.
  await pick("FX 2");
  await expect.poll(sendsWrites).toEqual([34, 17]);
  const RATE: number = PARAMS.SAMPLE_RATE.id;
  await setDeviceValue(page, SENDS, 0, 16);
  await setDeviceValue(page, RATE, 0, 192000);
  await notifyParam(page, RATE, 0, 192000);
  await expect(tab).toHaveText("FX 1");
  expect(await sendsWrites(), "what the unit moved is not written back").toEqual([34, 17]);

  // Leaving the SIM view gives the session's meters back to the CONSOLE.
  await page.click("#btn-view-console");
  await expect(page.locator("#sim-host")).toBeHidden();
});

// SETUP > Software Integration is usable on the unit only while a compatible DAW holds it (816 not 0),
// which the app reads only while Live sync is up. During Live sync the LCD draws it as the unit does,
// with no lock of the app's own: its two sends are the unit's, read by the session, followed through
// their notifies, and written when picked on the glass while a DAW holds the unit — and a pick made
// while none does writes nothing.
test("draws Software Integration on the LCD during Live sync as the unit does, and writes a send picked there while a DAW holds the unit", async ({
  page,
}) => {
  const DAW: number = PARAMS.DAW_INTEGRATION.id;
  const FX2: number = PARAMS.POST_FADER_SEND_FX2.id;
  await stubTauriDevice(page, { values: { [FX2]: 290 }, commands: { experimental_enabled: true, ...LIVE_COMMANDS } });
  await page.goto("/");
  await page.click("#btn-view-sim");
  await expect(lcd(page)).toBeVisible();
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  await lcd(page).getByRole("button", { name: "SETUP", exact: true }).click();
  const integration = lcd(page).getByRole("button", { name: /Software\s*Integration/ });
  await expect(integration, "no DAW holds the unit: out of reach, as on the unit").toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(integration.locator(".lock-mark"), "and nothing of the app's is drawn").toHaveCount(0);

  await setDeviceValue(page, DAW, 0, 2);
  await notifyParam(page, DAW, 0, 2);
  await expect(integration, "a DAW holds the unit: the entry opens").not.toHaveAttribute("aria-disabled");
  await expect(integration.locator(".lock-mark")).toHaveCount(0);
  await integration.click();
  const fx2 = lcd(page).getByLabel(/^for FX2: /);
  const fx2Writes = async (): Promise<number[]> => (await writesOf(page)).flatMap(([id, v]) => (id === FX2 ? [v] : []));
  await expect(fx2, "the send the unit holds").toHaveAttribute("aria-label", /^for FX2: MIX 2 /);
  await fx2.click();
  await lcd(page).getByRole("option", { name: "MIX 1", exact: true }).click();
  await expect.poll(fx2Writes).toEqual([288]);
  await expect(fx2).toHaveAttribute("aria-label", /^for FX2: MIX 1 /);
  await expect(fx2.locator(".lock-mark")).toHaveCount(0);

  // The DAW lets go of the unit with the screen still open: a pick there is taken back.
  await setDeviceValue(page, DAW, 0, 0);
  await notifyParam(page, DAW, 0, 0);
  await fx2.click();
  await lcd(page).getByRole("option", { name: "MIX 2", exact: true }).click();
  await expect(fx2, "a pick with no DAW holding the unit is taken back").toHaveAttribute(
    "aria-label",
    /^for FX2: MIX 1 /,
  );
  expect(await fx2Writes()).toEqual([288]);
});

// The unit's current scene and SCENE LIST's cursor are live-session state outside the plan: while
// Live sync is up the LCD shows them by number, with no title, and follows the unit's cursor.
test("the LCD shows the unit's current scene and SCENE LIST's cursor while Live sync is up", async ({ page }) => {
  const CURRENT: number = PARAMS.CURRENT_SCENE.id;
  const CURSOR: number = PARAMS.SCENE_CURSOR.id;
  await stubTauriDevice(page, {
    values: { [CURRENT]: 8, [CURSOR]: 9 },
    commands: { experimental_enabled: true, ...LIVE_COMMANDS },
  });
  await page.goto("/");
  await page.click("#btn-view-sim");
  await expect(lcd(page)).toBeVisible();
  const box = lcd(page).locator(".scene-box").first();
  await expect(box.locator(".scene-no"), "the glass's own scene with no session").toHaveText("00");

  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  // HOME's box names the cursor's scene, waiting while it is not the current one.
  await expect(box.locator(".scene-no")).toHaveText("10");
  await expect(box.locator(".scene-no")).toHaveClass(/is-pending/);
  await expect(box.locator(".scene-title"), "no title of the unit's").toHaveText("");

  await tapInto(page, box, "scene");
  await tapInto(page, lcd(page).getByRole("button", { name: "Scene List", exact: true }), "scene.list");
  const rows = onScreen(page, "scene.list").locator(".scene-list .list-row");
  await expect(rows.filter({ hasText: "10" }).first(), "the cursor on 10").toHaveAttribute("aria-selected", "true");
  await expect(rows.filter({ hasText: "09" }).first(), "09 marked recalled").toHaveAttribute(
    "aria-description",
    /recalled/,
  );

  // The cursor moved on the unit's panel, onto P01: the LCD follows it to the Simple tab.
  await setDeviceValue(page, CURSOR, 0, 0x8001);
  await notifyParam(page, CURSOR, 0, 0x8001);
  await expect(rows.filter({ hasText: "P01" }).first()).toHaveAttribute("aria-selected", "true");
});

// Whether a card is in the unit's microSD slot is live-session state outside the plan: while Live
// sync is up the LCD's microSD screen follows the unit's slot, and with no session it shows the
// glass's own card again.
test("the LCD's microSD screen follows the unit's card while Live sync is up", async ({ page }) => {
  const CARD: number = PARAMS.SD_CARD.id;
  await stubTauriDevice(page, { values: { [CARD]: 0 }, commands: { experimental_enabled: true, ...LIVE_COMMANDS } });
  await page.goto("/");
  await page.click("#btn-view-sim");
  await expect(lcd(page)).toBeVisible();
  await tapInto(page, lcd(page).getByRole("button", { name: "microSD", exact: true }), "microsd");
  const noCard = onScreen(page, "microsd").getByRole("button", { name: "Not inserted microSD card" });
  const recorder = onScreen(page, "microsd").getByRole("button", { name: "Recorder", exact: true });
  await expect(recorder, "the glass's own card with no session").toBeVisible();

  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  await expect(noCard, "no card in the unit").toBeVisible();
  await expect(noCard, "putting one in is the unit's own operation").toHaveAttribute("title", en.sim.lockUnitOp);

  // A card put in on the unit.
  await setDeviceValue(page, CARD, 0, 1);
  await notifyParam(page, CARD, 0, 1);
  await expect(recorder).toBeVisible();
  // …and taken out again.
  await setDeviceValue(page, CARD, 0, 0);
  await notifyParam(page, CARD, 0, 0);
  await expect(noCard).toBeVisible();

  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "false", { timeout: 30_000 });
  await expect(recorder, "the glass's own card once the session ends").toBeVisible();
});

// The unit's [CUE] is live-session state outside the plan: while Live sync is up the LCD shows
// the flags the unit holds and a press on the glass switches them on the unit, the way the
// CONSOLE chip does; with no session a press reaches nothing.
test("the LCD's CUE switches the unit's flag while Live sync is up, and reaches nothing without", async ({ page }) => {
  const CUE_MONO: number = PARAMS.CUE_MONO.id;
  await stubTauriDevice(page, { commands: { experimental_enabled: true, ...LIVE_COMMANDS } });
  await page.goto("/");
  // CH 2 is cued on the unit.
  await setDeviceValue(page, CUE_MONO, 1, 1);
  await page.click("#btn-view-sim");
  await expect(sim(page).locator(".lcd")).toBeVisible();
  const cue = (i: number) => sim(page).locator(".btn-cue").nth(i);
  const cueWrites = async (): Promise<number[]> =>
    (await writesOf(page)).flatMap(([id, v]) => (id === CUE_MONO ? [v] : []));

  // No session: the press is taken back and nothing is written.
  await cue(0).click();
  await expect(cue(0)).toHaveAttribute("aria-pressed", "false");
  expect(await cueWrites()).toEqual([]);

  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  await expect(cue(1), "the session shows what the unit has cued").toHaveAttribute("aria-pressed", "true");
  await expect(cue(0)).toHaveAttribute("aria-pressed", "false");

  // A press on the glass goes to the unit, and the app's own surfaces show it.
  await cue(0).click();
  await expect.poll(cueWrites).toEqual([1]);
  await expect(cue(0)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('#cue-bar-names > [aria-hidden="true"]')).toHaveText("CUE CH 1, CH 2");

  // A press on the unit's panel reaches the glass.
  await setDeviceValue(page, CUE_MONO, 0, 0);
  await notifyParam(page, CUE_MONO, 0, 0);
  await expect(cue(0)).toHaveAttribute("aria-pressed", "false");

  // Off again from the glass.
  await cue(1).click();
  await expect.poll(cueWrites).toEqual([1, 0]);
  await expect(cue(1)).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#cue-bar")).toBeHidden();
});

// STEREO and MIX 1 cued on the unit, then CH 1 pressed on the LCD during Live sync: the unit turns
// the outputs off and holds them to put back. The stub plays the unit's rules — CH 1 on takes the
// outputs off, CH 1 off puts them back, an output cue takes CH 1 off — with no notify for what it
// moves. Turning CH 1 off puts both outputs back, pressing STEREO alone cues STEREO alone, and
// CLEAR CUE puts neither back.
test.describe("an output cue the unit holds behind CH 1 on the LCD", () => {
  const CUE_MONO: number = PARAMS.CUE_MONO.id;
  const CUE_STEREO: number = PARAMS.CUE_STEREO.id;
  const CUE_MIX: number = PARAMS.CUE_MIX.id;
  /** A strip on the LCD's HOME by its spoken name ("C H 1", "STEREO", "MIX 1"). */
  const strip = (page: Page, name: string) =>
    sim(page).locator(".strip", { has: page.getByRole("button", { name: `${name} settings`, exact: true }) });
  const cueOf = (page: Page, name: string) => strip(page, name).locator(".btn-cue");
  const outputs = (page: Page) =>
    Promise.all([
      deviceValueOf(page, CUE_STEREO, 0),
      deviceValueOf(page, CUE_MIX, 0),
      deviceValueOf(page, CUE_MONO, 0),
    ]);
  const outputBank = async (page: Page): Promise<void> => {
    await lcd(page)
      .getByRole("button", { name: /channel bank/ })
      .click();
    await lcd(page).getByRole("button", { name: "MIX, ST STREAMING", exact: true }).click();
  };

  test.beforeEach(async ({ page }) => {
    await stubTauriDevice(page, { commands: { experimental_enabled: true, ...LIVE_COMMANDS } });
    await page.goto("/");
    await setDeviceValue(page, CUE_STEREO, 0, 1);
    await setDeviceValue(page, CUE_MIX, 0, 1);
    await setDeviceValue(page, CUE_MIX, 1, 1);
    await setWriteEffect(page, CUE_MONO, 0, 1, [
      [CUE_STEREO, 0, 0],
      [CUE_MIX, 0, 0],
      [CUE_MIX, 1, 0],
    ]);
    await setWriteEffect(page, CUE_MONO, 0, 0, [
      [CUE_STEREO, 0, 1],
      [CUE_MIX, 0, 1],
      [CUE_MIX, 1, 1],
    ]);
    await setWriteEffect(page, CUE_STEREO, 0, 1, [[CUE_MONO, 0, 0]]);
    await page.click("#btn-device");
    await page.click("#btn-live");
    await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
    await page.click("#btn-view-sim");
    await expect(lcd(page)).toBeVisible();
    await cueOf(page, "C H 1").click();
    await expect.poll(() => outputs(page), "the premise: CH 1 took the outputs off").toEqual([0, 0, 1]);
    await expect(cueOf(page, "C H 1")).toHaveAttribute("aria-pressed", "true");
  });

  test("turning CH 1 off puts both outputs back", async ({ page }) => {
    const before = (await writesOf(page)).length;
    await cueOf(page, "C H 1").click();
    await expect.poll(() => outputs(page)).toEqual([1, 1, 0]);
    expect((await writesOf(page)).slice(before), "the release alone is written").toEqual([[CUE_MONO, 0]]);
    await outputBank(page);
    await expect(cueOf(page, "STEREO")).toHaveAttribute("aria-pressed", "true");
    await expect(cueOf(page, "MIX 1")).toHaveAttribute("aria-pressed", "true");
  });

  test("pressing STEREO alone cues STEREO alone", async ({ page }) => {
    await outputBank(page);
    const before = (await writesOf(page)).length;
    await cueOf(page, "STEREO").click();
    await expect.poll(() => outputs(page)).toEqual([1, 0, 0]);
    expect((await writesOf(page)).slice(before), "the press of STEREO is written").toEqual([[CUE_STEREO, 1]]);
    await expect(cueOf(page, "STEREO")).toHaveAttribute("aria-pressed", "true");
    await expect(cueOf(page, "MIX 1")).toHaveAttribute("aria-pressed", "false");
  });

  test("CLEAR CUE puts neither output back", async ({ page }) => {
    await lcd(page).getByRole("button", { name: "Clear cue", exact: true }).click();
    await expect.poll(() => outputs(page)).toEqual([0, 0, 0]);
    await outputBank(page);
    await expect(cueOf(page, "STEREO")).toHaveAttribute("aria-pressed", "false");
    await expect(cueOf(page, "MIX 1")).toHaveAttribute("aria-pressed", "false");
  });
});
