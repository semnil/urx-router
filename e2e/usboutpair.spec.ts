import { test, expect, type Page } from "./fixtures";
import { wire } from "./graph-helpers";
import {
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
// single mono channels, and writes it as the two channels' own input slots, where a single
// mono channel is the same slot on both halves. A plan has no wire for that pair.
//
// What these pin is the board after a device read, which is where the operator meets it:
// the USB output keeps the plan's own wire and wears the unread badge, rather than being
// taken as the pair's FIRST channel — which is what made the next write send that channel
// on both halves and move the unit off the selection made on it.
const USB_OUT_A = PARAMS.USB_OUT_SRC_A.id;
const CH3_SLOT = 2;
const CH4_SLOT = 3;
const STEREO_TO_USB_A = ["bus.stereo:out", "out.usbmain_a:in"] as const;

/** The tag a node carries while its master ON is off (graph.ts). */
const mutedTag = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"] text:text-is("MUTE")`);

/** The badge a node carries when the read left it at its plan value (graph.ts). */
const unreadBadge = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"] text:text-is("?")`);

/** Seed the unit's USB MAIN A source as the two halves the unit itself writes. */
async function usbOutA(page: Page, l: number, r: number): Promise<void> {
  await setDeviceValue(page, USB_OUT_A, 0, l);
  await setDeviceValue(page, USB_OUT_A, 1, r);
}

async function fetchFromDevice(page: Page): Promise<void> {
  await page.click("#btn-device");
  await page.click("#btn-fetch");
  await expect(page.locator("#statusbar")).toContainText("Fetched", { timeout: 20000 });
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

test("a USB output the unit holds on a mono PAIR fetches as unread, with the plan's wire kept", async ({ page }) => {
  await open_(page);
  await usbOutA(page, CH3_SLOT, CH4_SLOT); // `CH 3/4` as the unit writes it

  await fetchFromDevice(page);

  await expect(wire(page, ...STEREO_TO_USB_A)).toHaveCount(1);
  await expect(unreadBadge(page, "out.usbmain_a")).toHaveCount(1);
  // The pair's first channel is exactly what reading one half would have taken.
  await expect(wire(page, "ch3:out", "out.usbmain_a:in")).toHaveCount(0);
});

test("a USB output on a single mono channel still fetches onto that channel", async ({ page }) => {
  await open_(page);
  await usbOutA(page, CH3_SLOT, CH3_SLOT); // `CH 3`: one slot on both halves

  await fetchFromDevice(page);

  // The control for the case above: reading both halves must not cost the reading that
  // already worked, and a node read in full carries no badge.
  await expect(wire(page, "ch3:out", "out.usbmain_a:in")).toHaveCount(1);
  await expect(wire(page, ...STEREO_TO_USB_A)).toHaveCount(0);
  await expect(unreadBadge(page, "out.usbmain_a")).toHaveCount(0);
});

test("Live sync does not start while the unit holds a USB output on a mono PAIR", async ({ page }) => {
  // The app's own rule, not a new one: a session snapshots the plan as device truth, so a
  // read that could not place a value refuses to start one (main.ts, liveReadIncomplete).
  // A pair now reaches that rule the way an undecodable port already did.
  await open_(page);
  await usbOutA(page, CH3_SLOT, CH4_SLOT);

  await page.click("#btn-device");
  await page.click("#btn-live");

  // The failure reaches the operator as a dialog; the stub records what it was told to
  // show, so the assertion is on the text rather than on a box that may be a native one.
  await expect.poll(async () => (await dialogsOf(page)).join(" | "), { timeout: 20000 }).toContain("could not be read");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "false");
});

test("Scene only starts Live sync against the same unit, and writes no USB output", async ({ page }) => {
  // The scene device scope syncs the mixer and leaves the device-wide settings — every
  // output patch among them — to the unit. A USB output the unit holds on a pair is then
  // routing this session does not sync, and a verdict about it must not stop the session:
  // the read does not ask for it at all, which is also what keeps it out of the writes.
  await open_(page, { deviceScope: "scene" });
  await usbOutA(page, CH3_SLOT, CH4_SLOT);

  await page.click("#btn-device");
  await page.click("#btn-live");

  await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
  const usbWrites = (await writesOf(page)).filter(([id]) => id === USB_OUT_A);
  expect(usbWrites, "the scope's own rule: no write to a device-wide setting").toEqual([]);
  // …and the board still shows the plan's own wire, which is what the scope restores.
  await expect(wire(page, ...STEREO_TO_USB_A)).toHaveCount(1);
});

test("Scene only keeps a session running when the unit moves a USB output onto a pair mid-session", async ({
  page,
}) => {
  // The in-session half of the case above: the session is up, the operator picks `CH 3/4` on
  // the unit, and the next whole-device read — the follow layer's answer to a burst wider
  // than two hands — must not end the session over routing it is not syncing.
  await open_(page, { deviceScope: "scene" });
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });

  await usbOutA(page, CH3_SLOT, CH4_SLOT);
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

test("All still ends a session when the unit moves a USB output onto a pair mid-session", async ({ page }) => {
  // The scope's other half, and the reason the scene case is a SCOPE rule rather than a
  // relaxed one: with every setting in the session, a value the whole-device read cannot
  // place is still the incomplete read that ends it.
  await open_(page);
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });

  await usbOutA(page, CH3_SLOT, CH4_SLOT);
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
