import { test, expect, type Page } from "./fixtures";
import { wire } from "./graph-helpers";
import { deviceValueOf, dialogsOf, LIVE_COMMANDS, setDeviceValue, stubTauriDevice } from "./tauri-stub";
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
const NOTE = "The unit's STREAMING was on a state its source list does not offer, so the plan takes STEREO";
const STEREO_TO_STREAM = ["bus.stereo:out", "bus.stream:in"] as const;

/** The badge a node carries when the read left it at its plan value (graph.ts). */
const unreadBadge = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"] text:text-is("?")`);

async function streamingSource(page: Page, l: number, r: number): Promise<void> {
  await setDeviceValue(page, STREAM_L, 0, l);
  await setDeviceValue(page, STREAM_R, 0, r);
}

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
  await streamingSource(page, (0x80000000 | 290) >>> 0, (0x80000000 | 291) >>> 0);
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
