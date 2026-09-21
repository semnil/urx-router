import { test, expect, type Page } from "./fixtures";
import { wire } from "./graph-helpers";
import { dialogsOf, LIVE_COMMANDS, setDeviceValue, stubTauriDevice } from "./tauri-stub";
import { PARAMS } from "../src/core/control/params";

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
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("a USB output the unit holds on a mono PAIR fetches as unread, with the plan's wire kept", async ({ page }) => {
  await usbOutA(page, CH3_SLOT, CH4_SLOT); // `CH 3/4` as the unit writes it

  await fetchFromDevice(page);

  await expect(wire(page, ...STEREO_TO_USB_A)).toHaveCount(1);
  await expect(unreadBadge(page, "out.usbmain_a")).toHaveCount(1);
  // The pair's first channel is exactly what reading one half would have taken.
  await expect(wire(page, "ch3:out", "out.usbmain_a:in")).toHaveCount(0);
});

test("a USB output on a single mono channel still fetches onto that channel", async ({ page }) => {
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
  await usbOutA(page, CH3_SLOT, CH4_SLOT);

  await page.click("#btn-device");
  await page.click("#btn-live");

  // The failure reaches the operator as a dialog; the stub records what it was told to
  // show, so the assertion is on the text rather than on a box that may be a native one.
  await expect.poll(async () => (await dialogsOf(page)).join(" | "), { timeout: 20000 }).toContain("could not be read");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "false");
});
