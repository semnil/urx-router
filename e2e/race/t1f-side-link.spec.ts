import { test, expect, type Page } from "@playwright/test";
import {
  depthOf,
  goLive,
  hasProbe,
  installFake,
  mark,
  pushNotifyDelivered,
  setMemAt,
  settleAfter,
  snapshotOf,
  traceOf,
} from "./fake-device";
import { markTime, setsOf, timeline } from "./analyze";
import { strip } from "./ui";

// T1f — the side a stereo channel shows, linked to the unit's LCD selection (param 762).
//
// The link is outside the plan: a switch made in the app writes 762 and the unit announces
// it back (fake-device.ts ANNOUNCE_MS), and a selection made on the unit arrives as a 762 notify that
// shows that channel's side. What a case here decides is whether those two directions keep
// apart under timing — an announcement of the app's own write must not read as a selection
// the operator made on the unit, and a selection on the unit is no plan edit: it writes
// nothing back and leaves no undo entry.

const LCD = 762;
const LCD_ADDR = `${LCD}:0:0`;

const side = (page: Page, shown: string) =>
  strip(page, "CH 5/6").getByRole("button", {
    name: `C H 5 slash 6, showing ${shown.replace(/^CH /, "C H ")}`,
    exact: true,
  });

/** The unit's announcements of 762 after `after`. */
const lcdAnnouncements = async (page: Page, after: number): Promise<number[]> =>
  (await traceOf(page))
    .filter((e) => e.kind === "notify" && e.origin === "device" && e.addr === LCD_ADDR && e.t > after)
    .map((e) => e.value!);

const lcdWrites = async (page: Page, after = 0): Promise<number[]> =>
  setsOf(await traceOf(page))
    .filter((s) => s.addr === LCD_ADDR && s.start > after)
    .map((s) => s.value!);

test.describe("T1f side link", () => {
  test.beforeEach(async ({ page }) => {
    await installFake(page);
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    expect(await hasProbe(page)).toBe(true);
  });

  test("a live start shows the side the unit has selected", async ({ page }) => {
    await setMemAt(page, { [LCD_ADDR]: 0x0101 });
    await goLive(page);
    await page.click("#btn-view-console");
    await expect(side(page, "CH 6 (R)")).toBeVisible();
    expect(await lcdWrites(page), "a side the unit chose is not written back").toEqual([]);
  });

  // Two switches inside the announce delay: both writes go out in order, the unit's
  // announcement comes back after the second write (the fake, like the unit, can leave the
  // first one unannounced), and the side stays where the operator left it.
  test("two switches inside the announce delay end where the operator left them", async ({ page }) => {
    await goLive(page);
    await page.click("#btn-view-console");
    await mark(page, "two-switches");
    const t0 = markTime(await traceOf(page), "two-switches")!;
    await side(page, "CH 5 (L)").click();
    await side(page, "CH 6 (R)").click();
    await settleAfter(page, "two-switches");
    console.log(timeline(await traceOf(page), { limit: 30 }));
    expect(await lcdWrites(page, t0)).toEqual([0x0101, 0x0100]);
    // Past the announcement of the last write.
    await expect.poll(() => lcdAnnouncements(page, t0)).toContain(0x0100);
    await expect(side(page, "CH 5 (L)")).toBeVisible();
    expect(await lcdWrites(page, t0), "no announcement was taken as a selection to write back").toEqual([
      0x0101, 0x0100,
    ]);
  });

  // A selection on the unit: it reaches the app (the bridge delivers only what the session
  // registered), shows the side, and is no plan edit.
  test("a selection made on the unit shows its side and edits nothing", async ({ page }) => {
    await goLive(page);
    await page.click("#btn-view-console");
    const before = await depthOf(page);
    const snapshot = await snapshotOf(page);
    await mark(page, "panel-select");
    const t0 = markTime(await traceOf(page), "panel-select")!;
    await pushNotifyDelivered(page, [[LCD, 0, 0, 0x0101]]);
    await expect(side(page, "CH 6 (R)")).toBeVisible();
    await settleAfter(page, "panel-select");
    expect(await lcdWrites(page, t0)).toEqual([]);
    expect(
      setsOf(await traceOf(page)).filter((s) => s.start > t0),
      "no plan key moved",
    ).toEqual([]);
    expect(await depthOf(page)).toEqual(before);
    expect(await snapshotOf(page)).toEqual(snapshot);
  });

  test("a switch after the session ends writes nothing", async ({ page }) => {
    await goLive(page);
    await page.click("#btn-view-console");
    await page.click("#btn-device");
    await page.click("#btn-live");
    await page.waitForSelector('#btn-live[aria-checked="false"]', { state: "attached" });
    await mark(page, "after-end");
    const t0 = markTime(await traceOf(page), "after-end")!;
    await side(page, "CH 5 (L)").click();
    // The write, where there is one, is issued in the same task as the switch that shows.
    await expect(side(page, "CH 6 (R)")).toBeVisible();
    expect(await lcdWrites(page, t0)).toEqual([]);
  });
});
