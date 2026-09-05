import { test, expect, type Page } from "./fixtures";
import { faceplate } from "./graph-helpers";
import { LIVE_COMMANDS, notifyParam, setDeviceValue, stubTauriDevice } from "./tauri-stub";
import { PARAMS } from "../src/core/control/params";

// A STEREO link the app did not make. Signal Type is moved on the unit's own panel;
// the notify reaches a live session, whose scoped reconcile writes `stereoLink` into
// the plan with no edit funnel behind it. The snap that linking in the app performs
// has to be taken there too, or the heart tie is drawn across whatever gap an earlier
// manual move opened — which is the state the app's own link exists to snap out of.

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const link = (page: Page) => page.locator("#graph-host text", { hasText: "♥" });

// The pair's Signal Type is held on the primary and read at its input index; both
// members carry the flag on the device. CH 1 / CH 2 are indices 0 and 1.
const SIGNAL_TYPE = PARAMS.SIGNAL_TYPE.id;

test.beforeEach(async ({ page }) => {
  await stubTauriDevice(page, { commands: LIVE_COMMANDS });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("a Signal Type moved on the unit snaps the pair back beside its primary", async ({ page }) => {
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });

  // Park CH 2 away from CH 1 while the pair is still MONO x 2 — a board the operator
  // arranged, and the gap the snap has to close. Measured after the session is up: the
  // starting read re-renders the plan, which refits the viewport.
  const grab = (await faceplate(page, "ch2").boundingBox())!;
  await page.mouse.move(grab.x + grab.width * 0.35, grab.y + 12);
  await page.mouse.down();
  await page.mouse.move(grab.x + grab.width * 0.35 + 240, grab.y + 150, { steps: 10 });
  await page.mouse.up();
  const parked = (await node(page, "ch2").boundingBox())!;
  const before1 = (await node(page, "ch1").boundingBox())!;
  expect(Math.abs(parked.x - before1.x)).toBeGreaterThan(20);
  await expect(link(page)).toHaveCount(0);

  // The unit now holds STEREO on the pair, and says so.
  await setDeviceValue(page, SIGNAL_TYPE, 0, 1);
  await setDeviceValue(page, SIGNAL_TYPE, 1, 1);
  await notifyParam(page, SIGNAL_TYPE, 0, 1);

  // The tie appearing is the reconcile having landed — the settle window plus a scoped
  // read of CH 1, neither of which has a clock this test should guess at.
  await expect(link(page)).toHaveCount(1, { timeout: 30_000 });
  const after1 = (await node(page, "ch1").boundingBox())!;
  const after2 = (await node(page, "ch2").boundingBox())!;
  expect(Math.abs(after1.x - before1.x)).toBeLessThan(2); // the primary stays put
  expect(Math.abs(after2.x - after1.x)).toBeLessThan(2); // partner back in its column
  expect(after2.y).toBeGreaterThan(after1.y); // and below it
  expect(Math.hypot(after2.x - parked.x, after2.y - parked.y)).toBeGreaterThan(20); // it really moved
});
