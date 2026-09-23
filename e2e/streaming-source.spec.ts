import { test, expect, type Page } from "./fixtures";
import { drag, port, wire } from "./graph-helpers";
import {
  deviceValueOf,
  dialogsOf,
  heldReadsOf,
  LIVE_COMMANDS,
  setDeviceValue,
  setHeldReads,
  stubTauriDevice,
} from "./tauri-stub";
import { PARAMS } from "../src/core/control/params";

// STREAMING's source list on the unit is STEREO / MIX 1 / MIX 2, with no None. A unit that
// holds NONE there anyway is read as such, and a Fetch or a Live-sync start gives the plan
// STEREO in its place and says so ahead of its own line. A source the list does not offer is
// not taken at all: STREAMING is left unread, and Live sync does not start on it.
const STREAM_L = PARAMS.STREAM_SRC_L.id;
const STREAM_R = PARAMS.STREAM_SRC_R.id;
/** The "no source" sentinel — vd.ts's PORT_REF_NONE, spelled out because importing vd.ts into
 *  a spec fails on its import cycle. */
const PORT_REF_NONE = 0xffffffff;
/** STEREO as tagged port refs, the halves the unit holds for it. */
const STEREO = [(0x80000000 | 256) >>> 0, (0x80000000 | 257) >>> 0];
/** The same for MIX 1 and MIX 2, the other two sources STREAMING's list offers. */
const MIX1 = [(0x80000000 | 288) >>> 0, (0x80000000 | 289) >>> 0];
const MIX2 = [(0x80000000 | 290) >>> 0, (0x80000000 | 291) >>> 0];
const NOTE = "The unit's STREAMING was on a state its source list does not offer, so the plan takes STEREO";
const STEREO_TO_STREAM = ["bus.stereo:out", "bus.stream:in"] as const;

/** The badge a node carries when the read left it at its plan value (graph.ts). */
const unreadBadge = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"] text:text-is("?")`);

async function streamingSource(page: Page, l: number, r: number): Promise<void> {
  await setDeviceValue(page, STREAM_L, 0, l);
  await setDeviceValue(page, STREAM_R, 0, r);
}

const sourceHeld = (page: Page): Promise<[number | undefined, number | undefined]> =>
  Promise.all([deviceValueOf(page, STREAM_L, 0), deviceValueOf(page, STREAM_R, 0)]);

test.beforeEach(async ({ page }) => {
  await stubTauriDevice(page, { commands: LIVE_COMMANDS, confirm: "Ok" });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("a Fetch of a unit on NONE gives STREAMING STEREO, and says so ahead of the fetch", async ({ page }) => {
  await streamingSource(page, PORT_REF_NONE, PORT_REF_NONE);
  await page.click("#btn-device");
  await page.click("#btn-fetch");
  await expect(page.locator("#statusbar")).toContainText("Fetched", { timeout: 20_000 });
  await expect(page.locator("#statusbar")).toHaveText(new RegExp(`^${NOTE} — Fetched \\d+ settings from URX44V$`));
  await expect(wire(page, ...STEREO_TO_STREAM)).toHaveCount(1);
  await expect(unreadBadge(page, "bus.stream")).toHaveCount(0);
});

// The control: a unit on a source its list offers is read onto it, with no note.
test("a Fetch of a unit on MIX 2 reads MIX 2, with no note", async ({ page }) => {
  await streamingSource(page, MIX2[0], MIX2[1]);
  await page.click("#btn-device");
  await page.click("#btn-fetch");
  await expect(page.locator("#statusbar")).toHaveText(/^Fetched \d+ settings from URX44V$/, { timeout: 20_000 });
  await expect(wire(page, "bus.mix2:out", "bus.stream:in")).toHaveCount(1);
  await expect(wire(page, ...STEREO_TO_STREAM)).toHaveCount(0);
});

// The start itself sends nothing there; the flush the next edit starts carries STREAMING's STEREO.
test("a Live-sync start on a unit on NONE sends STREAMING STEREO with the next edit", async ({ page }) => {
  await streamingSource(page, PORT_REF_NONE, PORT_REF_NONE);
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
  await expect(wire(page, ...STEREO_TO_STREAM)).toHaveCount(1);
  await page.locator('#graph-host g.node[data-id="ch1"]').click();
  await page.locator("#inspector .param", { hasText: "HPF" }).getByRole("button", { name: "ON", exact: true }).click();
  await expect
    .poll(async () => [await deviceValueOf(page, STREAM_L, 0), await deviceValueOf(page, STREAM_R, 0)], {
      timeout: 10_000,
    })
    .toEqual(STEREO);
});

test("Live sync does not start on a unit whose STREAMING source is a channel's slot", async ({ page }) => {
  await streamingSource(page, 0, 0);
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect
    .poll(async () => (await dialogsOf(page)).filter((d) => d.startsWith("Live sync stopped:")), { timeout: 30_000 })
    .toEqual([
      "Live sync stopped: 1 setting could not be read, so the device's state is not fully known. Live sync needs a complete read to start.",
    ]);
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "false");
  await expect(wire(page, ...STEREO_TO_STREAM)).toHaveCount(1);
  // An incomplete start merges nothing, so no node carries the read's provenance either.
  await expect(unreadBadge(page, "bus.stream")).toHaveCount(0);
  expect([await deviceValueOf(page, STREAM_L, 0), await deviceValueOf(page, STREAM_R, 0)]).toEqual([0, 0]);
});

// STREAMING takes ONE source, so a replacing drop made while a read is in flight and the
// source that read is carrying cannot both stand. The operator's wins, and the unit's stays
// in the view the next write measures from — so the write that follows moves the unit onto
// what was drawn. The read is stopped at the first address a Fetch asks for, which is where
// it has already cloned the plan and has everything still to merge.
test("a Fetch keeps the source drawn onto STREAMING while its read ran, and writes it", async ({ page }) => {
  await streamingSource(page, MIX1[0], MIX1[1]);
  await setHeldReads(page, [PARAMS.FOLLOW_USB.id]);
  await page.click("#btn-device");
  await page.click("#btn-fetch");
  await expect.poll(() => heldReadsOf(page), { timeout: 20_000 }).toBe(1);
  await drag(page, port(page, "bus.mix2:out"), port(page, "bus.stream:in"));
  await expect(wire(page, "bus.mix2:out", "bus.stream:in")).toHaveCount(1);
  await setHeldReads(page, []);

  await expect(page.locator("#statusbar")).toContainText("Fetched", { timeout: 20_000 });
  await expect(wire(page, "bus.mix2:out", "bus.stream:in")).toHaveCount(1);
  await expect(wire(page, "bus.mix1:out", "bus.stream:in")).toHaveCount(0);
  await expect(wire(page, ...STEREO_TO_STREAM)).toHaveCount(0);
  expect(await sourceHeld(page), "the premise: the fetch itself wrote nothing").toEqual(MIX1);

  await page.click("#btn-device");
  await page.click("#btn-write");
  await expect.poll(() => sourceHeld(page), { timeout: 20_000 }).toEqual(MIX2);
});

// The control: with nothing drawn under it, the read's own source lands.
test("a Fetch nothing was drawn under takes the unit's own source", async ({ page }) => {
  await streamingSource(page, MIX1[0], MIX1[1]);
  await page.click("#btn-device");
  await page.click("#btn-fetch");
  await expect(page.locator("#statusbar")).toContainText("Fetched", { timeout: 20_000 });
  await expect(wire(page, "bus.mix1:out", "bus.stream:in")).toHaveCount(1);
  await expect(wire(page, ...STEREO_TO_STREAM)).toHaveCount(0);
});
