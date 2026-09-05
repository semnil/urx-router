import { test, expect, type Page } from "./fixtures";
import { faceplate, stereoTie } from "./graph-helpers";
import { LIVE_COMMANDS, notifyParam, setDeviceValue, stubTauriDevice } from "./tauri-stub";
import { PARAMS } from "../src/core/control/params";

// A STEREO link the app did not make. Signal Type is moved on the unit's own panel;
// the notify reaches a live session, whose scoped reconcile writes `stereoLink` into
// the plan with no edit funnel behind it. The snap that linking in the app performs
// has to be taken there too, or the heart tie is drawn across whatever gap an earlier
// manual move opened — which is the state the app's own link exists to snap out of.

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);

// The pair's Signal Type is held on the primary and read at its input index; both
// members carry the flag on the device. CH 1 / CH 2 are indices 0 and 1.
const SIGNAL_TYPE = PARAMS.SIGNAL_TYPE.id;

test.beforeEach(async ({ page }) => {
  await stubTauriDevice(page, { commands: LIVE_COMMANDS });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

/** Bring a live session up and park CH 2 away from CH 1 while the pair is still MONO x 2 —
 *  a board the operator arranged, and the gap the snap has to close. Measured after the
 *  session is up: the starting read re-renders the plan, which refits the viewport. */
async function liveWithParkedPartner(page: Page) {
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });

  const grab = (await faceplate(page, "ch2").boundingBox())!;
  await page.mouse.move(grab.x + grab.width * 0.35, grab.y + 12);
  await page.mouse.down();
  await page.mouse.move(grab.x + grab.width * 0.35 + 240, grab.y + 150, { steps: 10 });
  await page.mouse.up();
  const parked = (await node(page, "ch2").boundingBox())!;
  const primary = (await node(page, "ch1").boundingBox())!;
  expect(Math.abs(parked.x - primary.x)).toBeGreaterThan(20);
  await expect(stereoTie(page)).toHaveCount(0);
  // The unit now holds STEREO on the pair. Both members carry the flag; the app reads it
  // at the primary's index.
  await setDeviceValue(page, SIGNAL_TYPE, 0, 1);
  await setDeviceValue(page, SIGNAL_TYPE, 1, 1);
  return { parked, primary };
}

/** CH 2 is back in CH 1's column, below it, and CH 1 did not move. */
async function expectSnapped(page: Page, before: Awaited<ReturnType<typeof liveWithParkedPartner>>) {
  // The tie appearing is the reconcile having landed — a settle window plus a device read,
  // neither of which has a clock this test should guess at.
  await expect(stereoTie(page)).toHaveCount(1, { timeout: 30_000 });
  const after1 = (await node(page, "ch1").boundingBox())!;
  const after2 = (await node(page, "ch2").boundingBox())!;
  expect(Math.abs(after1.x - before.primary.x)).toBeLessThan(2); // the primary stays put
  expect(Math.abs(after2.x - after1.x)).toBeLessThan(2); // partner back in its column
  expect(after2.y).toBeGreaterThan(after1.y); // and below it
  expect(Math.hypot(after2.x - before.parked.x, after2.y - before.parked.y)).toBeGreaterThan(20);
}

test("a Signal Type moved on the unit snaps the pair back beside its primary", async ({ page }) => {
  const before = await liveWithParkedPartner(page);
  await notifyParam(page, SIGNAL_TYPE, 0, 1);
  await expectSnapped(page, before);
});

// The other reconcile. More distinct controls than two hands can move is a scene or preset
// recall rather than hand operation, and the follow layer answers that by re-reading the
// whole device instead of the touched nodes — a different seat, and the one a recall that
// moves several Signal Types at once takes.
test("a burst wide enough to force a whole-device read snaps the pair too", async ({ page }) => {
  const before = await liveWithParkedPartner(page);
  await notifyParam(page, PARAMS.CH_FADER.id, 0, 100);
  await notifyParam(page, PARAMS.CH_FADER.id, 1, 100);
  await notifyParam(page, PARAMS.CH_FADER.id, 2, 100);
  await notifyParam(page, PARAMS.HA_GAIN.id, 0, 300);
  await notifyParam(page, SIGNAL_TYPE, 0, 1);
  await expectSnapped(page, before);
});
