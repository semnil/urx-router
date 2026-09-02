import { test, expect } from "./fixtures";
import type { Page } from "./fixtures";
import { dialogsOf, stubTauriDevice, writesOf } from "./tauri-stub";
import { chooseOption } from "./choose-option";

// The sample rate is the one plan value the device can accept and then undo by
// itself: with SETUP > Follow USB on it slaves its clock to the USB host, so a rate
// write re-clocks and is dragged back to the host's rate a moment later. The write
// path reads that state first and asks before touching anything.

// Param ids, spelled out here so the test pins the addresses the app must use.
const SAMPLE_RATE = 766;
const FOLLOW_USB = 848;
// The microSD Track Count, in stereo PAIRS: 8 is the full 16 tracks.
const SD_REC_TRACK_COUNT = 839;

interface StubOptions {
  /** What the device reports as its running rate (the plan defaults to 48 kHz). */
  deviceRate?: number;
  /** Device-side Follow USB state. */
  followUsb?: boolean;
  /** Reject the Follow USB read, so the clock state cannot be established. */
  failClockRead?: boolean;
  /** The recorder's Track Count in stereo pairs. Unset reads 0, which is no recorder
   *  state at all and warns about nothing. */
  trackPairs?: number;
}

// Only the two clock addresses are spec-specific; the rest of the link is the
// shared stub. A failing clock read is expressed by simply not answering 848 and
// letting the stub's failReads reject it.
function stubDevice(page: Page, opts: StubOptions = {}): Promise<void> {
  const values: Record<number, number> = { [SAMPLE_RATE]: opts.deviceRate ?? 48000 };
  if (!opts.failClockRead) values[FOLLOW_USB] = opts.followUsb ? 1 : 0;
  if (opts.trackPairs !== undefined) values[SD_REC_TRACK_COUNT] = opts.trackPairs;
  return stubTauriDevice(page, { values, failReads: opts.failClockRead });
}

async function startWrite(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-device"); // the device actions live in a menu
  await page.click("#btn-write");
}

test("a rate the device is following prompts for a choice instead of writing", async ({ page }) => {
  await stubDevice(page, { deviceRate: 96000, followUsb: true });
  await startWrite(page);

  const modal = page.locator("#rate-choice");
  await expect(modal).toBeVisible();
  await expect(page.locator("#rate-choice-intro")).toContainText("96 kHz");
  await expect(page.locator("#rate-choice-intro")).toContainText("48 kHz");

  await page.click("#rate-choice-cancel");
  await expect(modal).toBeHidden();
  await expect(page.locator("#statusbar")).toContainText("Canceled");
  // Canceling is the one answer that must leave the device exactly as it was.
  expect(await writesOf(page)).toEqual([]);
  // No write confirm either: the rate is settled before the diff is even taken.
  expect(await dialogsOf(page)).not.toContainEqual(expect.stringContaining("Write "));
});

test("adopting the device's rate moves the plan onto it", async ({ page }) => {
  await stubDevice(page, { deviceRate: 96000, followUsb: true });
  await startWrite(page);

  await page.click("#rate-choice-adopt");
  await expect(page.locator("#rate-choice")).toBeHidden();
  // The plan now names the rate the device is running, so the rate write is a no-op.
  await expect(page.locator("#rate-picker")).toHaveValue("96000");
  expect(await writesOf(page)).not.toContainEqual([FOLLOW_USB, expect.anything()]);
});

test("releasing Follow USB writes 848 off and leaves the plan's rate alone", async ({ page }) => {
  await stubDevice(page, { deviceRate: 96000, followUsb: true });
  await startWrite(page);

  await page.click("#rate-choice-release");
  await expect(page.locator("#rate-choice")).toBeHidden();
  await expect(page.locator("#rate-picker")).toHaveValue("48000");
  expect(await writesOf(page)).toContainEqual([FOLLOW_USB, 0]);
  // The badge follows the write, so the toolbar stops claiming the device is slaved.
  await expect(page.locator("#follow-usb")).toHaveAttribute("aria-pressed", "false");
});

test("a matching rate goes straight to the write confirm", async ({ page }) => {
  await stubDevice(page, { deviceRate: 48000, followUsb: true });
  await startWrite(page);

  // Nothing to settle, so no modal — Follow USB only matters when the rates differ.
  await expect(page.locator("#rate-choice")).toBeHidden();
  await expect.poll(() => dialogsOf(page)).toEqual(expect.arrayContaining([expect.stringContaining("Write ")]));
});

test("an unreadable clock state cancels the write before anything is sent", async ({ page }) => {
  await stubDevice(page, { deviceRate: 96000, failClockRead: true });
  await startWrite(page);

  await expect(page.locator("#rate-choice")).toBeHidden();
  await expect
    .poll(() => dialogsOf(page))
    .toEqual(expect.arrayContaining([expect.stringContaining("Nothing was written")]));
  expect(await writesOf(page)).toEqual([]);
});

test("the Follow USB badge reads as unknown until a device has been read", async ({ page }) => {
  await stubDevice(page, { deviceRate: 48000, followUsb: true });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");

  const badge = page.locator("#follow-usb");
  // Unknown is its own state, shown rather than hidden: the badge warns that the
  // rate picker may not stick, which is worth least after the operator has already
  // committed to a device action. It must never read as "off" (aria-pressed false),
  // which is the state in which the picker IS trusted.
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute("data-state", "unknown");
  await expect(badge).toHaveAttribute("aria-pressed", "mixed");

  await page.click("#btn-device");
  await page.click("#btn-write");
  await expect(badge).toHaveAttribute("data-state", "on");
  await expect(badge).toHaveAttribute("aria-pressed", "true");
});

test("clicking the badge while unknown reads the device instead of toggling it", async ({ page }) => {
  await stubDevice(page, { deviceRate: 48000, followUsb: true });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");

  await page.locator("#follow-usb").click();
  await expect(page.locator("#follow-usb")).toHaveAttribute("data-state", "on");
  // Toggling from unknown would have to guess a direction; nothing was written.
  expect(await writesOf(page)).toEqual([]);
});

// The unit lowers its own Track Count to fit a rate it cannot carry, and nothing the app
// can write raises it again. The two arms of this dialog do not share that cost: releasing
// writes the PLAN's rate and can pay it, adopting takes the rate the device is already
// running and pays nothing. So the warning sits on the release arm rather than in the
// note, which speaks for the whole dialog.
test("the release arm names what the plan's rate costs the recorder, and the shared note does not", async ({
  page,
}) => {
  await stubDevice(page, { deviceRate: 48000, followUsb: true, trackPairs: 8 });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await chooseOption(page.locator("#rate-picker"), { value: "96000" });
  await page.click("#btn-device");
  await page.click("#btn-write");

  await expect(page.locator("#rate-choice")).toBeVisible();
  // The premise: the plan really is on the high rate, so the release arm really would
  // cost the recorder. Without this the case can pass on a dialog about nothing.
  await expect(page.locator("#rate-choice-intro")).toContainText("96 kHz");
  const releaseNote = page.locator("#rate-choice-release-note");
  await expect(releaseNote).toBeVisible();
  await expect(releaseNote).toContainText("16");
  await expect(releaseNote).toContainText("8");
  // Where it must NOT be: the note belongs to every arm, adopting included.
  await expect(page.locator("#rate-choice-note")).not.toContainText("Track Count");

  await page.click("#rate-choice-cancel");
  expect(await writesOf(page)).toEqual([]);
});

// The other half, and the one that keeps the warning worth reading: a count the new rate
// can already carry loses nothing, so the arm carries no note at all.
test("the release arm is silent when the recorder's count already fits the plan's rate", async ({ page }) => {
  await stubDevice(page, { deviceRate: 48000, followUsb: true, trackPairs: 4 }); // 8 tracks
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await chooseOption(page.locator("#rate-picker"), { value: "96000" });
  await page.click("#btn-device");
  await page.click("#btn-write");

  await expect(page.locator("#rate-choice")).toBeVisible();
  // Attached AND hidden. `toBeHidden` alone passes on an element that is not there at all,
  // so it would go on passing if the note were deleted outright.
  await expect(page.locator("#rate-choice-release-note")).toBeAttached();
  await expect(page.locator("#rate-choice-release-note")).toBeHidden();
  await page.click("#rate-choice-cancel");
});
