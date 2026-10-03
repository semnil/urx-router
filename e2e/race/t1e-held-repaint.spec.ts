import { test, expect, type Page } from "@playwright/test";
import {
  installFake,
  goLive,
  mark,
  pushNotifyDelivered,
  setLatency,
  setMemAt,
  settleAfter,
  traceOf,
} from "./fake-device";
import { markTime, setsOf } from "./analyze";
import { CH1_HPF_ADDR, CH1_HPF_FREQ, graphNode, insertFxBypass, insertFxSelect, paramExact } from "./ui";
import { chooseOption } from "../choose-option";

// T1e — overtake-held-repaint-vs-the-next-gesture (docs/{en,ja}/live-race-harness.md,
// "T1 overtake").
//
// Choosing in a select leaves the focus on it, and the inspector holds its rebuild while a
// select inside it is focused, since a rebuild closes an open picker. A device-side change
// to the node arriving then is held, and what releases it is the operator's NEXT gesture:
// it moves the focus, and the focusout ends the hold. That focusout fires partway through
// the gesture — a mouse press moves the focus before its click is dispatched, a Tab before
// the focus lands, a tap before its click — so a rebuild run inside it removes the control
// the gesture is going to, and the click or the key press after it reaches nothing.
//
// Each case selects Compander-H on CH 1 (which leaves the select focused and puts the
// bypass ON / OFF pair on screen), has the unit move CH 1's HPF frequency, and then
// operates the bypass. What it asserts is the write that lands: one, on the bypass address,
// carrying OFF — and the HPF frequency on screen, which is the held rebuild arriving after
// the gesture rather than in place of it. The click pair is the differential: the control
// run has nothing arrive while the select is focused.

const CH1_INSERT_FX_ON = "134:0:0";

/** CH 1's HPF frequency the unit moves to: 100 Hz, on its 20 Hz grid. */
const MOVED_HPF = 1000;

const hpfFreq = (page: Page) => paramExact(page, "HPF Freq").locator('input[type="range"]');

/** Live, CH 1 selected, Compander-H chosen and the select left focused — and, with
 *  `follow`, a device-side change to CH 1's HPF frequency held behind that focus. */
async function selectFocusedWithEffect(page: Page, follow: boolean): Promise<void> {
  await goLive(page);
  await graphNode(page, "ch1").click();
  await setLatency(page, { get: 2, set: 40 });
  const sel = await insertFxSelect(page);
  await mark(page, "select-compander");
  await chooseOption(sel, { label: "Compander-H" });
  await settleAfter(page, "select-compander", 1800);
  if (follow) {
    await setMemAt(page, { [CH1_HPF_ADDR]: MOVED_HPF });
    await mark(page, "hpf-notify");
    await pushNotifyDelivered(page, [[...CH1_HPF_FREQ, MOVED_HPF]]);
    await settleAfter(page, "hpf-notify", 1200);
  }
  await expect(sel, "the Insert FX select still holds the focus").toBeFocused();
}

/** The writes sent after the gesture's mark. */
async function writesAfter(page: Page, detail: string): Promise<string[]> {
  await settleAfter(page, detail, 1200);
  const trace = await traceOf(page);
  const at = markTime(trace, detail)!;
  return setsOf(trace)
    .filter((s) => s.start > at)
    .map((s) => `${s.addr}=${s.value}`);
}

test.describe("T1e held repaint", () => {
  test.beforeEach(async ({ page }) => {
    await installFake(page);
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  for (const follow of [true, false]) {
    test(`a click that ends the select's hold sends its write — ${follow ? "a device change held behind it" : "control: nothing held"} @webkit`, async ({
      page,
    }) => {
      await selectFocusedWithEffect(page, follow);
      const before = await hpfFreq(page).inputValue();

      await mark(page, "bypass-off");
      await (await insertFxBypass(page)).locator("button", { hasText: /^OFF$/ }).click();

      expect(await writesAfter(page, "bypass-off")).toEqual([`${CH1_INSERT_FX_ON}=0`]);
      await expect(hpfFreq(page)).toHaveValue(follow ? "100" : before);
    });
  }

  // WebKit does not stop a Tab on a button, so this one is Chromium's.
  test("a Tab that ends the select's hold lands on the next control, and the key pressed there sends its write", async ({
    page,
  }) => {
    await selectFocusedWithEffect(page, true);
    const bypass = await insertFxBypass(page);

    await mark(page, "bypass-off");
    await page.keyboard.press("Tab");
    await expect(bypass.locator("button", { hasText: /^ON$/ })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(bypass.locator("button", { hasText: /^OFF$/ })).toBeFocused();
    await page.keyboard.press("Space");

    expect(await writesAfter(page, "bypass-off")).toEqual([`${CH1_INSERT_FX_ON}=0`]);
    await expect(hpfFreq(page)).toHaveValue("100");
  });
});

// A tap releases the touch before its click and moves the focus with the click, the
// opposite order to a mouse press.
test.describe("T1e held repaint — touch", () => {
  test.use({ hasTouch: true });

  test.beforeEach(async ({ page }) => {
    await installFake(page);
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  test("a tap that ends the select's hold sends its write", async ({ page }) => {
    await selectFocusedWithEffect(page, true);

    await mark(page, "bypass-off");
    await (await insertFxBypass(page)).locator("button", { hasText: /^OFF$/ }).tap();

    expect(await writesAfter(page, "bypass-off")).toEqual([`${CH1_INSERT_FX_ON}=0`]);
    await expect(hpfFreq(page)).toHaveValue("100");
  });
});
