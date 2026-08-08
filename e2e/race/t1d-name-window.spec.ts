// T1d — the NAME path's post-write window, and the refetch that used to read into it.
//
// The staleness window is not numeric-only. Measured on a URX44V (System V1.3.1.0):
// a channel name written and then polled every 4 ms answered the PREVIOUS name for
// 81 ms. The numeric repair does not reach it — `writeOverlay` answers an address out
// of what the unit ANNOUNCED, and a name is written on the string path (`vdSetStr`),
// whose loop records nothing in the flush's write ledger, so a name address is never in
// the `PendingWrites` the overlay is built from and a settle could only spend its bound.
// The unit's own announcement does arrive, and is followed — that is the second case
// below — but it reaches the follow layer, not the read the refetch issues.
//
// What that costs is worse than the numeric case rather than milder. A stale numeric
// read oscillates: the plan and the snapshot disagree, the next diff re-sends, and the
// operator sees a value flicker. A stale NAME read is written into the plan AND
// `nameSnapshot` together — they agree, no diff remains, and the rename is reverted
// with nothing left to retry and nothing on screen to notice.
//
// The fix is not to wait but to not read: Live sync's sideEffect refetch skips names
// entirely, because the read exists to collect what the unit RECOMPUTED and no
// parameter write makes the unit recompute a name. This case pins that, and pins that
// every other read path still reads them — a rename made on the unit must still arrive.
import { test, expect, type Page } from "@playwright/test";
import {
  installFake,
  goLive,
  setLatency,
  staleReadsAt,
  staleStateOf,
  memStrOf,
  memOf,
  traceOf,
  pushNameNotify,
  mark,
  settleAfter,
} from "./fake-device";
import { getsOf } from "./analyze";
import { openEqScreen } from "./ui";

/** CH1's name (vd-params.md `18`: 64-byte fixed-length string, one instance per mono
 *  channel). The only name address this case touches. */
const CH1_NAME = "18:0:0";

/** ch1's EQ 1-knob ON — `sideEffect: "refetch"`, so writing it is what makes the flush
 *  issue the scoped read that used to take the name with it. */
const CH1_ONE_KNOB_ON = "46:0:0";

/** The graph node, addressed the way rename.spec.ts does. */
const node = (page: Page, id: string): ReturnType<Page["locator"]> =>
  page.locator(`#graph-host g.node[data-id="${id}"]`);

const nameInput = (page: Page): ReturnType<Page["locator"]> => page.locator("#inspector input[type='text']");

const oneKnobOn = (page: Page): ReturnType<Page["locator"]> =>
  page
    .locator("#dyn-screen-box .prefs-section", { has: page.locator("#dyn-oneknob-level") })
    .locator(".prefs-toggle button")
    .first();

test.describe("T1d name window", () => {
  test.beforeEach(async ({ page }) => {
    await installFake(page);
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  test("a rename flushed beside a sideEffect edit survives the refetch", async ({ page }) => {
    await goLive(page);
    // Slow enough that the rename and the 1-knob click land in one 120 ms window — the
    // only shape in which the exposure is reachable at all, and the reason a hand-driven
    // repro cannot decide this: missing the window looks exactly like a pass.
    await setLatency(page, { get: 2, set: 5 });

    // The unit answers the pre-write name for the next read of that address. One read is
    // all a pass takes (readPass reads each node's name once), and it is armed after the
    // live-sync readback so that sweep ran against a truthful device.
    await staleReadsAt(page, CH1_NAME, 1);

    await page.click("#btn-view-graph");
    await node(page, "ch1").click();
    await expect(nameInput(page)).toHaveCount(1);
    // The screen is opened BEFORE the window is, so none of its round trips are inside
    // it, and the toggle is tagged here so the single task below can reach it.
    await openEqScreen(page, "ch1");
    await oneKnobOn(page).evaluate((el) => el.setAttribute("data-race-knob", "1"));

    await mark(page, "rename");
    // Both edits in ONE in-page task. They have to share a 120 ms flush window for the
    // exposure to exist at all, and driving them from the driver put six round trips
    // between them: measured 545 ms apart at 6x CPU throttling and 682 ms at 12x, i.e.
    // on any loaded runner this case was measuring nothing and reporting a pass for it.
    // `textInput` (ui/inspector.ts) commits on "input", so the native setter plus that
    // event is the same path a typed character takes.
    await page.evaluate(() => {
      const input = document.querySelector("#inspector input[type='text']") as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "OperatorTyped");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      (document.querySelector("[data-race-knob]") as HTMLElement).click();
    });
    await settleAfter(page, "rename", 1200);

    // The two gestures really did leave in ONE flush, which is the only shape in which
    // the exposure exists — the rename has to still be in the diff when the sideEffect
    // write triggers the refetch. Six driver round trips sit between them (opening the
    // screen, then the toggle), so it is not a given, and if they miss the window the
    // refetch has no name to read and the `spent === 0` verdict below is satisfied for
    // free. Its sibling t1c asserts its own gates the same way, and for the same
    // reason: a case that stops measuring anything must fail rather than pass.
    const flushTrace = await traceOf(page);
    const nameWrite = flushTrace.find((e) => e.kind === "ipc-start" && e.cmd === "vd_set_str" && e.addr === CH1_NAME);
    const knobWrite = flushTrace.find(
      (e) => e.kind === "ipc-start" && e.cmd === "vd_set" && e.addr === CH1_ONE_KNOB_ON,
    );
    expect(nameWrite, "the rename never reached the device").toBeDefined();
    expect(knobWrite, "the 1-knob write never reached the device").toBeDefined();
    expect(Math.abs(nameWrite!.t - knobWrite!.t)).toBeLessThan(120);

    // The device took the rename: this is about what the app does with the READ, not
    // about the write.
    const heldNames = await memStrOf(page);
    expect(heldNames[CH1_NAME]).toBe("OperatorTyped");

    // And the plan still carries it. Before the fix the refetch's name read answered
    // the pre-write name, `readPass` wrote that into `plan.nodeNames`, and live.ts's
    // re-base put the same value into `nameSnapshot` — leaving nothing to re-send.
    //
    // Read off the canvas rather than out of a probe: `__urxTrace` exposes the live
    // snapshot and the write ledger, not the plan, and the graph label is what the
    // operator would actually lose. It only prints device names with the labels toggle
    // on, and it repaints on every follow batch, so it tracks the plan rather than the
    // text that was typed into the input.
    //
    // The tuning screen is still open over the toolbar, so it is closed first — a click
    // on a covered menu button times out rather than failing on the assertion, which
    // hides what the case is actually about.
    await page.keyboard.press("Escape");
    await expect(page.locator("#dyn-screen-box")).toBeHidden();
    await page.click("#btn-view");
    await page.locator("#btn-labels").click();
    await expect(node(page, "ch1").locator("text").first()).toHaveText("OperatorTyped");

    // The scripted staleness was never spent, which is the mechanism rather than the
    // symptom: the refetch did not read the name at all. A pass that read it and
    // happened to get the right answer would show spent > 0.
    const stale = await staleStateOf(page);
    expect(stale[CH1_NAME]?.spent ?? 0).toBe(0);

    // The sideEffect edit itself still went out, so the case is not silently measuring
    // a flush that never happened.
    const held = await memOf(page);
    expect(held[CH1_ONE_KNOB_ON]).toBe(1);
  });

  // The other half of the same address: a rename made on the UNIT must reach the app.
  // It could not, for the life of the follow layer — names are not in
  // `planToCommands`, so they were in no registration and `Subs::absorb` dropped the
  // notify the unit does send (measured on a URX44V: one notify on the renamed
  // address, identical whether the rename came from the LCD or a client). The app now
  // registers them, so this is a direct follow: the label changes with no readback.
  test("a rename made on the unit reaches the plan, and the app's own rename does not bounce", async ({ page }) => {
    await goLive(page);
    await page.click("#btn-view");
    await page.locator("#btn-labels").click();

    // Delivered, not merely pushed: an address the session never registered is
    // refused, and a refusal is indistinguishable from an app that ignored it.
    const pushedAt = await page.evaluate(() => performance.now());
    const why = await pushNameNotify(page, CH1_NAME, "FromTheLCD");
    expect(why).toEqual([""]);
    await expect(node(page, "ch1").locator("text").first()).toHaveText("FromTheLCD");

    // …and it is a DIRECT follow: no whole-device readback was provoked. An
    // unregistered or unrecognised address escalates to one, which is ~800 reads —
    // counted off the trace rather than guessed at, and compared against the live-sync
    // start's own sweep so the bar is a property of this run rather than a constant.
    const afterGo = getsOf(await traceOf(page)).filter((g) => g.start > pushedAt);
    expect(afterGo.length).toBeLessThan(50);

    // The app's own rename must not come back round. live.ts moves the name snapshot
    // when it writes, so the echo of that write reads as an echo rather than as a
    // device-side change — without it the two would ping-pong.
    await page.click("#btn-view-graph");
    await node(page, "ch1").click();
    await mark(page, "own-rename");
    await nameInput(page).fill("TypedInTheApp");
    await settleAfter(page, "own-rename", 600);
    const held = await memStrOf(page);
    expect(held[CH1_NAME]).toBe("TypedInTheApp");
    const why2 = await pushNameNotify(page, CH1_NAME, "TypedInTheApp");
    expect(why2).toEqual([""]);
    await expect(node(page, "ch1").locator("text").first()).toHaveText("TypedInTheApp");
  });
});
