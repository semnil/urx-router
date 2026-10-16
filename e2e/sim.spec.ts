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
import { COLOR_PALETTE, PARAMS } from "../src/core/control/params";
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

test("holds Follow USB on the LCD's Sampling Frequency screen, naming the toolbar's FOLLOW USB", async ({ page }) => {
  await openSim(page);
  await tapInto(page, lcd(page).getByRole("button", { name: "SETUP", exact: true }), "setup");
  await tapInto(page, lcd(page).getByRole("button", { name: "Sampling Frequency" }), "setup.rate");
  const follow = lcd(page).getByRole("button", { name: "Follow USB", exact: true });
  await expect(follow).toHaveAttribute("aria-disabled", "true");
  await expect(follow).toHaveAttribute("title", en.sim.lockFollowUsb);
  await expect(follow.locator(".lock-mark")).toHaveCount(1);
  await expect(
    lcd(page).getByRole("button", { name: "96kHz", exact: true }),
    "the rate itself is the plan's",
  ).not.toHaveAttribute("aria-disabled");
});

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

// Follow USB is the unit's setting, outside the plan: the LCD shows what the app last read from the
// unit, and off where it has read nothing, so the rate on the LCD is the plan's until the unit says
// it follows USB.
test("the LCD's Follow USB is the unit's while Live sync is up, and off while it is not known", async ({ page }) => {
  const FOLLOW: number = PARAMS.FOLLOW_USB.id;
  await stubTauriDevice(page, { values: { [FOLLOW]: 1 }, commands: { experimental_enabled: true, ...LIVE_COMMANDS } });
  await page.goto("/");
  await page.click("#btn-view-sim");
  await expect(lcd(page)).toBeVisible();
  await tapInto(page, lcd(page).getByRole("button", { name: "SETUP", exact: true }), "setup");
  await tapInto(page, lcd(page).getByRole("button", { name: "Sampling Frequency" }), "setup.rate");
  const follow = lcd(page).getByRole("button", { name: "Follow USB", exact: true });
  const rate = lcd(page).getByRole("button", { name: "96kHz", exact: true });

  await expect(follow, "nothing read yet").toHaveAttribute("aria-pressed", "false");
  await expect(rate).not.toHaveAttribute("aria-disabled");

  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  await expect(follow, "the session shows what the unit holds").toHaveAttribute("aria-pressed", "true");
  await expect(rate, "a unit following USB takes no rate").toHaveAttribute("aria-disabled", "true");

  await setDeviceValue(page, FOLLOW, 0, 0);
  await notifyParam(page, FOLLOW, 0, 0);
  await expect(follow).toHaveAttribute("aria-pressed", "false");
  await expect(rate).not.toHaveAttribute("aria-disabled");
});
