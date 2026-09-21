import { test, expect, type Page } from "./fixtures";
import { drag, port, tapJack, wire } from "./graph-helpers";
import { chooseOption } from "./choose-option";
import {
  deviceValueOf,
  dialogsOf,
  LIVE_COMMANDS,
  notifyBurst,
  notifyParam,
  setDeviceValue,
  stubTauriDevice,
  writesOf,
} from "./tauri-stub";
import { PARAMS, STEREO_ON as STEREO_CH_ON } from "../src/core/control/params";

// The unit's USB output source list carries a mono PAIR — `CH 1/2`, `CH 3/4` — beside the
// single mono channels, and writes it as the two channels' own input slots: L = the first
// channel's, R = the second's, where a single mono channel is the same slot on both halves.
// A plan holds that pair as two ordinary patch wires into the output, one from each channel.
//
// What these pin is where the operator meets it: the board after a device read, the Live
// session that read starts, and the two halves a pair on the board is written as. The two
// halves in any other combination — the pair the wrong way round, two channels of different
// pairs, one half left clear — name nothing the list offers, and those stay a value the read
// could not place: the plan's own wire is kept and the output wears the unread badge.
const USB_OUT_A = PARAMS.USB_OUT_SRC_A.id;
const USB_A_IN = "out.usbmain_a:in";
/** The "no source" sentinel a selector holds — vd.ts's PORT_REF_NONE, spelled out because
 *  importing vd.ts into a spec fails on its import cycle. */
const PORT_REF_NONE = 0xffffffff;
const CH2_SLOT = 1;
const CH3_SLOT = 2;
const CH4_SLOT = 3;
const CH3 = "ch3:out";
const CH4 = "ch4:out";
const STEREO_TO_USB_A = ["bus.stereo:out", USB_A_IN] as const;

/** The tag a node carries while its master ON is off (graph.ts). */
const mutedTag = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"] text:text-is("MUTE")`);

/** The badge a node carries when the read left it at its plan value (graph.ts). */
const unreadBadge = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"] text:text-is("?")`);

/** Every wire drawn into USB MAIN OUT A, whatever it comes from. */
const wiresIntoUsbA = (page: Page) => page.locator(`#graph-host .wire-hit[data-to="${USB_A_IN}"]`);

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const sigSelect = (page: Page) => page.locator("#inspector .param", { hasText: "Signal Type" }).locator("select");

/** Seed the unit's USB MAIN A source as the two halves the unit itself writes. */
async function usbOutA(page: Page, l: number, r: number): Promise<void> {
  await setDeviceValue(page, USB_OUT_A, 0, l);
  await setDeviceValue(page, USB_OUT_A, 1, r);
}

/** What the unit holds on USB MAIN A, as [L, R]. */
async function usbOutAOf(page: Page): Promise<Array<number | undefined>> {
  return [await deviceValueOf(page, USB_OUT_A, 0), await deviceValueOf(page, USB_OUT_A, 1)];
}

async function fetchFromDevice(page: Page): Promise<void> {
  await page.click("#btn-device");
  await page.click("#btn-fetch");
  await expect(page.locator("#statusbar")).toContainText("Fetched", { timeout: 20000 });
}

async function startLive(page: Page): Promise<void> {
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
}

test.beforeEach(async ({ page }) => {
  await stubTauriDevice(page, { commands: LIVE_COMMANDS, confirm: "Ok" });
});

/** The app as the operator left it, before the page is opened. */
async function open_(page: Page, settings?: Record<string, unknown>): Promise<void> {
  if (settings) {
    await page.addInitScript((s) => localStorage.setItem("urx-settings", JSON.stringify(s)), settings);
  }
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
}

test("a USB output the unit holds on a mono PAIR fetches as the pair's two wires", async ({ page }) => {
  await open_(page);
  await usbOutA(page, CH3_SLOT, CH4_SLOT); // `CH 3/4` as the unit writes it

  await fetchFromDevice(page);

  // Both channels' own wires, and nothing of the plan's STEREO patch left beside them. A node
  // read in full carries no badge.
  await expect(wire(page, CH3, USB_A_IN)).toHaveCount(1);
  await expect(wire(page, CH4, USB_A_IN)).toHaveCount(1);
  await expect(wire(page, ...STEREO_TO_USB_A)).toHaveCount(0);
  await expect(unreadBadge(page, "out.usbmain_a")).toHaveCount(0);
});

test("a USB output on a single mono channel still fetches onto that channel alone", async ({ page }) => {
  await open_(page);
  await usbOutA(page, CH3_SLOT, CH3_SLOT); // `CH 3`: one slot on both halves

  await fetchFromDevice(page);

  // The control for the case above: the pair reading must not turn a single channel into
  // the pair it belongs to, and must not cost the reading that already worked.
  await expect(wire(page, CH3, USB_A_IN)).toHaveCount(1);
  await expect(wire(page, CH4, USB_A_IN)).toHaveCount(0);
  await expect(wire(page, ...STEREO_TO_USB_A)).toHaveCount(0);
  await expect(unreadBadge(page, "out.usbmain_a")).toHaveCount(0);
});

// The halves the unit's own list never produces. Each keeps the plan's STEREO patch and
// flags the output, rather than being taken as the L half's channel, which the next write
// would then send on both halves, moving the unit off what it held.
const UNPLACEABLE = [
  { shape: "the pair the wrong way round", l: CH4_SLOT, r: CH3_SLOT },
  { shape: "two channels of different pairs", l: CH2_SLOT, r: CH3_SLOT },
  { shape: "one half selected and the other clear", l: CH3_SLOT, r: PORT_REF_NONE },
];

for (const { shape, l, r } of UNPLACEABLE) {
  test(`a USB output the unit holds on ${shape} fetches as unread, with the plan's wire kept`, async ({ page }) => {
    await open_(page);
    await usbOutA(page, l, r);

    await fetchFromDevice(page);

    await expect(wire(page, ...STEREO_TO_USB_A)).toHaveCount(1);
    await expect(wiresIntoUsbA(page)).toHaveCount(1);
    await expect(unreadBadge(page, "out.usbmain_a")).toHaveCount(1);
  });
}

test("Live sync starts under All on a unit holding a mono PAIR, and writes nothing to that output", async ({
  page,
}) => {
  // The session snapshots the plan the read produced as device truth, so a pair read as its
  // two wires is a complete read and the session comes up. What makes that snapshot TRUE is
  // that the plan writes the pair as the unit's own two halves: a Signal Type edit converges,
  // re-reading the whole write scope and re-sending every address where the unit differs
  // from the plan's write, so a plan that wrote the pair any other way sends USB MAIN A here.
  await open_(page);
  await usbOutA(page, CH3_SLOT, CH4_SLOT);

  await startLive(page);
  await expect(wire(page, CH3, USB_A_IN)).toHaveCount(1);
  await expect(wire(page, CH4, USB_A_IN)).toHaveCount(1);

  await node(page, "ch3").click();
  await chooseOption(sigSelect(page), "1"); // STEREO
  // The flush's end: `→ device (n)` is written once its converge has finished.
  await expect(page.locator("#statusbar")).toHaveText(/^→ device \(\d+\)/, { timeout: 20000 });
  expect(
    (await writesOf(page)).filter(([id]) => id === PARAMS.SIGNAL_TYPE.id),
    "the converge ran",
  ).not.toEqual([]);
  expect(
    (await writesOf(page)).filter(([id]) => id === USB_OUT_A),
    "no write to USB MAIN A",
  ).toEqual([]);
  expect(await usbOutAOf(page)).toEqual([CH3_SLOT, CH4_SLOT]);
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true");
  // Linking the pair leaves the output's two wires as they are.
  await expect(wire(page, CH3, USB_A_IN)).toHaveCount(1);
  await expect(wire(page, CH4, USB_A_IN)).toHaveCount(1);
});

test("a pair drawn partner first is written L = the primary's slot, R = the partner's", async ({ page }) => {
  // The wire order is the order the operator drew them in; the halves are the pair's own
  // order, as the unit writes `CH 3/4`.
  await open_(page);
  await usbOutA(page, PORT_REF_NONE, PORT_REF_NONE); // nothing selected
  await startLive(page);
  await expect(wiresIntoUsbA(page)).toHaveCount(0);

  await drag(page, tapJack(page, CH4), port(page, USB_A_IN));
  await drag(page, tapJack(page, CH3), port(page, USB_A_IN));
  await expect(wire(page, CH4, USB_A_IN)).toHaveCount(1);
  await expect(wire(page, CH3, USB_A_IN)).toHaveCount(1);

  await expect.poll(() => usbOutAOf(page), { timeout: 20000 }).toEqual([CH3_SLOT, CH4_SLOT]);
});

test("Live sync does not start while the unit holds a USB output on a pair the wrong way round", async ({ page }) => {
  // The app's own rule, not a new one: a session snapshots the plan as device truth, so a
  // read that could not place a value refuses to start one (main.ts, liveReadIncomplete).
  // Halves the list does not offer reach that rule the way an undecodable port does.
  await open_(page);
  await usbOutA(page, CH4_SLOT, CH3_SLOT);

  await page.click("#btn-device");
  await page.click("#btn-live");

  // The failure reaches the operator as a dialog; the stub records what it was told to
  // show, so the assertion is on the text rather than on a box that may be a native one.
  await expect.poll(async () => (await dialogsOf(page)).join(" | "), { timeout: 20000 }).toContain("could not be read");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "false");
});

test("Scene only starts Live sync against the same unit, and writes no USB output", async ({ page }) => {
  // The scene device scope syncs the mixer and leaves the device-wide settings — every
  // output patch among them — to the unit. A USB output the unit holds in a shape the read
  // cannot place is then routing this session does not sync, and a verdict about it must
  // not stop the session: the read does not ask for it at all, which is also what keeps it
  // out of the writes.
  await open_(page, { deviceScope: "scene" });
  await usbOutA(page, CH4_SLOT, CH3_SLOT);

  await startLive(page);

  const usbWrites = (await writesOf(page)).filter(([id]) => id === USB_OUT_A);
  expect(usbWrites, "the scope's own rule: no write to a device-wide setting").toEqual([]);
  // …and the board still shows the plan's own wire, which is what the scope restores.
  await expect(wire(page, ...STEREO_TO_USB_A)).toHaveCount(1);
});

test("Scene only keeps a session running when a USB output turns unreadable mid-session", async ({ page }) => {
  // The in-session half of the case above: the session is up, the unit comes to hold halves
  // its list does not offer — the broker takes them from a write over the control link — and
  // the next whole-device read, the follow layer's answer to a burst wider than two hands,
  // must not end the session over routing it is not syncing.
  await open_(page, { deviceScope: "scene" });
  await startLive(page);

  await usbOutA(page, CH4_SLOT, CH3_SLOT);
  // Five distinct controls, past the follow layer's MAX_CONCENTRATION of 3, seeded first so
  // the read finds what the burst announced — delivered as ONE batch, or the settle can fire
  // part-way and take the scoped path this case is not about.
  const burst: Array<{ paramId: number; y: number; value: number }> = [0, 1, 2, 3].map((y) => ({
    paramId: PARAMS.CH_FADER.id,
    y,
    value: 100,
  }));
  burst.push({ paramId: PARAMS.HA_GAIN.id, y: 0, value: 300 });
  for (const b of burst) await setDeviceValue(page, b.paramId, b.y, b.value);
  // Evidence that the WHOLE-device read ran rather than the scoped one: CH 5/6's ON, moved
  // with no notify of its own and on a node the burst does not name, reaches the board only
  // through a read of everything.
  await setDeviceValue(page, STEREO_CH_ON, 0, 0);
  await notifyBurst(page, burst);
  // Waited on the read's END, whichever way it ends: a whole-device follow read that
  // completes writes `← device (n)` to the status line, and one that fails ends the session
  // with a dialog. Asserting "still live" without this passes in the moments before a
  // failing read has finished, which is the exact failure this case is here to catch.
  await expect
    .poll(
      async () =>
        /^← device \(\d+\)/.test((await page.locator("#statusbar").textContent()) ?? "") ||
        (await dialogsOf(page)).length > 0,
      { timeout: 20000 },
    )
    .toBe(true);
  expect(await dialogsOf(page), "no session-ending dialog").toEqual([]);
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true");
  await expect(mutedTag(page, "ch_5_6")).toHaveCount(1);

  // Follow is still following: a hand on the unit's CH 3 [ON] reaches the board.
  await setDeviceValue(page, PARAMS.CH_ON.id, 2, 0);
  await notifyParam(page, PARAMS.CH_ON.id, 2, 0);
  await expect(mutedTag(page, "ch3")).toHaveCount(1);
  expect(
    (await writesOf(page)).filter(([id]) => id === USB_OUT_A),
    "no write to a device-wide setting",
  ).toEqual([]);
});

test("All still ends a session when a USB output turns unreadable mid-session", async ({ page }) => {
  // The scope's other half, and the reason the scene case is a SCOPE rule rather than a
  // relaxed one: with every setting in the session, a value the whole-device read cannot
  // place is still the incomplete read that ends it.
  await open_(page);
  await startLive(page);

  await usbOutA(page, CH4_SLOT, CH3_SLOT);
  const burst: Array<{ paramId: number; y: number; value: number }> = [0, 1, 2, 3].map((y) => ({
    paramId: PARAMS.CH_FADER.id,
    y,
    value: 100,
  }));
  burst.push({ paramId: PARAMS.HA_GAIN.id, y: 0, value: 300 });
  for (const b of burst) await setDeviceValue(page, b.paramId, b.y, b.value);
  await notifyBurst(page, burst);

  await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "false", { timeout: 20000 });
  await expect.poll(async () => (await dialogsOf(page)).join(" | ")).toContain("could not be read");
});
