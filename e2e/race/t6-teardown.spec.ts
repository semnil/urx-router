import { test, expect, type Page } from "@playwright/test";
import {
  installFake,
  goLive,
  mark,
  pushNotify,
  pushBulkChange,
  traceOf,
  setLatency,
  blockAt,
  releaseBarrier,
  waitQuiet,
  settleAfter,
  countersOf,
  setDialogAnswer,
  dialogsOf,
  divergeAt,
  meterAddrsOf,
} from "./fake-device";
import { analyze, report, timeline, markTime, spans, getsOf } from "./analyze";
import { CH1_FADER, CH1_HPF_FREQ, faderOf, faderReadout, strip } from "./ui";

// T6 teardown — session and plan lifetime (docs/{en,ja}/live-race-harness.md).
//
// Everything here asks the same question from a different side: what happens to work
// that is already in flight when the thing that started it goes away. A whole-device
// readback is seconds long and takes `plan` by reference at its call, a live session
// is a held connection plus two subscriptions plus three module-level latches, and
// none of it is cancellable. The cases place a teardown inside each of those windows
// and read the fake's IPC trace back to see what still reached the device — and what
// still reached the plan that is no longer on screen.
//
// The windows are placed the way T1 places them: with the fake's barrier, or by
// counting the reads the sweep has issued so far, never with a wall-clock sleep.

// HPF frequency at the same input index — a scoped (non-direct) param, so a notify on
// it schedules a read-back of the whole node rather than a direct apply.
const DISCARD = "You have unsaved changes. Discard them?";

/** How many reads the fake has been asked for so far. Every sweep in this tier is
 *  measured in reads rather than milliseconds: the count is what the app actually did,
 *  and it stays meaningful when the link latency changes underneath. */
const getCount = (page: Page): Promise<number> =>
  page.evaluate(() => window.__urxFake.log.filter((e) => e.kind === "ipc-start" && e.cmd === "vd_get").length);

const waitForReads = (page: Page, n: number, timeout = 40_000): Promise<unknown> =>
  page.waitForFunction(
    (target) => window.__urxFake.log.filter((e) => e.kind === "ipc-start" && e.cmd === "vd_get").length >= target,
    n,
    { timeout },
  );

/** Click a File menu item (the menu opens on its trigger and closes on the item). */
async function fileMenu(page: Page, id: string): Promise<void> {
  await page.click("#btn-file");
  await page.click(`#${id}`);
}

/** Click the live toggle without opening the Device menu — the menu closes on the
 *  first click, so a second one within the same window has nowhere visible to land.
 *  This is also how a sub-frame double click is dispatched at all. */
const clickLive = (page: Page, times = 1): Promise<void> =>
  page.evaluate((n) => {
    const btn = document.getElementById("btn-live") as HTMLButtonElement;
    for (let i = 0; i < n; i++) btn.click();
  }, times);

const statusText = (page: Page): Promise<string> =>
  page.evaluate(() => document.getElementById("statusbar")?.textContent ?? "");

test.describe("T6 teardown", () => {
  test.beforeEach(async ({ page }) => {
    await installFake(page);
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  // teardown-plan-replacement-during-reconcile.
  //
  // The gate that protects a Fetch (deviceReadInFlight) is raised by the Fetch button's
  // handler, not by the readback, and follow.ts's identical whole-device read
  // deliberately does not raise it: a File > New refused because somebody brushed a knob
  // on the unit is a menu item that does nothing at a moment the operator cannot
  // predict. The plan-replacement hazard is handled at the READ instead — it is
  // abandoned (aborted) at the replacement, and its result is dropped because the plan
  // it was issued for is no longer the open document. What this ladder measures is that
  // both halves hold at every phase of the sweep.
  //
  // The ladder is a position in the sweep, measured in reads against the one the
  // session start just performed, and the fake's barrier HOLDS it there: blockAt
  // freezes the reconcile at its nth read and keeps every later read frozen too, so
  // the phase is exact and the flow under test has as many round trips as it needs.
  // Waiting for a read count and then racing File > New against the rest of the sweep
  // would make the late rung a coin toss (at 0.95 there is a fraction of a second of
  // sweep left, and the flow is several round trips long).
  for (const [label, frac] of [
    ["early", 0.08],
    ["mid", 0.48],
    ["late", 0.95],
  ] as Array<[string, number]>) {
    test(`File > New ${label} in a whole-device follow reconcile is not refused, and the read is abandoned`, async ({
      page,
    }) => {
      await page.click("#btn-view-console");
      await expect(faderReadout(page, "CH 1")).toBeVisible();
      // What a brand-new plan shows here, sampled before any device value exists: the
      // baseline both the pre-teardown edit and the one made on the replacing plan are
      // measured against, so "the readout moved" is never a reading of the same value.
      const fresh = (await faderReadout(page, "CH 1").textContent())!;

      await goLive(page);
      await setDialogAnswer(page, "Ok");
      // The sweep the session start just ran is the yardstick for the one below.
      const sweepReads = await getCount(page);
      await setLatency(page, { get: 8, set: 8 });

      // Three history entries and a dirty plan, so File > New has to ask before it
      // replaces anything — the confirm is what proves the flow was not refused.
      await faderOf(page, "CH 1").focus();
      for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowUp");
      await waitQuiet(page);
      const edited = (await faderReadout(page, "CH 1").textContent())!;
      expect(edited).not.toBe(fresh);

      // Make the device hold a value no fresh plan could produce, so a device value
      // reaching the new plan would be visible rather than inferred.
      await divergeAt(page, CH1_FADER, 20);

      const base = await getCount(page);
      const nth = Math.max(4, Math.round(sweepReads * frac));
      await blockAt(page, "vd_get", nth);
      await mark(page, "unknown-notify");
      await pushBulkChange(page);
      // The sentinel resolves to no node, so it forces the settle to a full sweep, and
      // the barrier stops that sweep dead on its nth read. Nothing below is racing it.
      await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 90_000 });
      const reachedAt = await getCount(page);

      const dialogsBefore = (await dialogsOf(page)).length;
      await mark(page, "file-new");
      await fileMenu(page, "btn-new");
      await expect(page.locator("#statusbar")).toContainText("Created a new plan");
      const dialogsAfter = await dialogsOf(page);
      const livePressed = await page.locator("#btn-live").getAttribute("aria-pressed");

      // One edit on the plan that REPLACED the one being read, so the current history
      // has a depth of its own. The Edit menu's enabled state crosses IPC on a real
      // depth transition, which is the observable that separates "the epilogue ran"
      // from "the epilogue ran against the plan now on screen": if the reflect's
      // planHistory.reset() is the module-level one, this entry dies with it.
      await faderOf(page, "CH 1").focus();
      await page.keyboard.press("ArrowUp");
      await page.waitForFunction(
        (d) => {
          const f = window.__urxFake;
          const m = f.log.find((e) => e.kind === "mark" && e.detail === d);
          return (
            m !== undefined &&
            f.log.some(
              (e) => e.kind === "ipc-end" && e.cmd === "set_edit_menu_state" && e.detail === "true/false" && e.t > m.t,
            )
          );
        },
        "file-new",
        { timeout: 20_000 },
      );
      const newEdited = (await faderReadout(page, "CH 1").textContent())!;
      await mark(page, "plan-replaced");

      // Let the frozen sweep run out. Everything from here on is a read issued for a
      // session that no longer exists — or it stops, which is the other world.
      await releaseBarrier(page);
      await settleAfter(page, "plan-replaced");

      const trace = await traceOf(page);
      const replacedAt = markTime(trace, "plan-replaced")!;
      const findings = analyze(trace, { quiesceAfter: "plan-replaced" });
      const readsAfter = getsOf(trace).filter((g) => g.start > replacedAt);
      const menuAfter = spans(trace)
        .filter((s) => s.cmd === "set_edit_menu_state" && s.start > replacedAt)
        .map((s) => s.detail);
      const afterReadout = (await faderReadout(page, "CH 1").textContent())!;

      console.log(timeline(trace, { from: markTime(trace, "unknown-notify")! - 50 }));
      console.log(report(`plan replacement during reconcile (${label})`, findings));
      console.log(
        `phase: intended ${(frac * 100).toFixed(0)}% of ${sweepReads} reads, held at ${reachedAt - base}` +
          ` (${(((reachedAt - base) / sweepReads) * 100).toFixed(0)}%); reads after teardown: ${readsAfter.length}` +
          `; edit-menu pushes after teardown=[${menuAfter.join(" ")}]`,
      );
      console.log(
        `readout: fresh=${fresh} edited=${edited} newPlanEdited=${newEdited} afterSweep=${afterReadout}` +
          `; status=${await statusText(page)}`,
      );

      // Not refused: the discard confirm was reached, which fileFlow would have
      // short-circuited past had deviceReadInFlight been raised for this read.
      expect(dialogsAfter.length).toBe(dialogsBefore + 1);
      expect(dialogsAfter.at(-1)).toBe(DISCARD);
      // loadPlan's own teardown did run — the session is down.
      expect(livePressed).toBe("false");

      // The sweep is abandoned at the replacement rather than run to completion. The
      // abort is cooperative — readback.ts checks the signal at group boundaries, not
      // per command — so a tail of one node's group can still land; what must not
      // happen is the rest of the device being read for a session that has ended.
      const remaining = sweepReads - (reachedAt - base);
      expect(readsAfter.length).toBeLessThan(remaining);
      expect(readsAfter.length).toBeLessThan(sweepReads / 4);
      // And the epilogue does not run at all: the read is bound to the plan it was
      // issued for, and that plan is gone, so nothing claims a device follow on the
      // status line…
      expect(await statusText(page)).not.toMatch(/← device \(\d+\)/);
      // …and nothing resets the history of the document that replaced it. The entry the
      // operator made after File > New is still theirs: the Edit menu was never pushed
      // back to disabled without an operator action.
      expect(menuAfter).not.toContain("false/false");

      // The values stay with the plan they were read for, which is discarded: the plan
      // on screen shows its own edit rather than the value the device was made to hold.
      expect(afterReadout).toBe(newEdited);
      expect(afterReadout).not.toBe(fresh);
    });
  }

  // teardown-flow-refusals, guarded half. The identical read behind a Fetch DOES raise
  // deviceReadInFlight, so every file flow is refused for its duration — and a refusal
  // must not consume anything: the same attempt has to pass once the read is done.
  test("file flows are refused while a Fetch holds the plan, and the same attempts pass afterwards", async ({
    page,
  }) => {
    await setDialogAnswer(page, "Ok");
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    await faderOf(page, "CH 1").focus();
    await page.keyboard.press("ArrowUp"); // dirty, so every flow below has to confirm
    await setLatency(page, { get: 8 });

    const base = await getCount(page);
    await page.click("#btn-device");
    await page.click("#btn-fetch");
    await waitForReads(page, base + 40); // the read is genuinely under way
    await mark(page, "during-fetch");

    const dialogsBefore = (await dialogsOf(page)).length;
    await fileMenu(page, "btn-new");
    await fileMenu(page, "btn-open");
    await page.locator("#model-picker").selectOption("URX22");
    const duringStatus = await statusText(page);
    const duringDialogs = (await dialogsOf(page)).length;
    const pickerDuring = await page.locator("#model-picker").inputValue();
    const openDialogsDuring = spans(await traceOf(page)).filter((s) => s.cmd === "plugin:dialog|open").length;

    await expect(page.locator("#statusbar")).toContainText("Fetched", { timeout: 40_000 });
    await mark(page, "fetch-done");

    // The same three attempts, unchanged, once the latch is down.
    await page.locator("#model-picker").selectOption("URX22");
    await expect(page.locator("#statusbar")).toContainText("Switched to URX22");
    await fileMenu(page, "btn-open");
    await fileMenu(page, "btn-new");
    await expect(page.locator("#statusbar")).toContainText("Created a new plan");
    const openDialogsAfter = spans(await traceOf(page)).filter((s) => s.cmd === "plugin:dialog|open").length;

    await waitQuiet(page);
    const trace = await traceOf(page);
    console.log(timeline(trace, { from: markTime(trace, "during-fetch")! - 200 }));
    console.log(
      `during fetch: status="${duringStatus}" picker=${pickerDuring} dialogs=${duringDialogs} (was ${dialogsBefore})` +
        `; open dialogs during=${openDialogsDuring} after=${openDialogsAfter}`,
    );

    // Refused, and refused silently at the shared latch: no discard confirm was even
    // asked, so nothing was consumed and no native dialog was left on screen.
    expect(duringDialogs).toBe(dialogsBefore);
    expect(duringStatus).not.toContain("Created a new plan");
    expect(openDialogsDuring).toBe(0);
    // The picker is the one flow with visible state of its own: it must snap back to
    // the model still on screen rather than sit on a model nothing loaded.
    expect(pickerDuring).toBe("URX44V");

    // Invariant 15: the identical retry passes in one attempt.
    expect(openDialogsAfter).toBe(1);
    expect(await page.locator("#model-picker").inputValue()).toBe("URX22");
    expect(await statusText(page)).toContain("Created a new plan");
  });

  // teardown-flow-refusals, unguarded half — the direct contrast, and the measurement
  // that turns "the gate is missing" from an inference into a fact. Same whole-device
  // read, started by follow instead of by the Fetch button.
  //
  // Two of the guarded half's three flows, because the third is no longer comparable
  // between them: the model picker is disabled outright for the live SESSION's duration
  // (syncDeviceActionUi), and this half is the one that has a session. The guarded half
  // reaches the picker and is refused by the read latch; here it is never reachable.
  // The lock is measured rather than dropped, because the picker's cover comes from the
  // session and NOT from the reconcile gate this case is about — counted as one of three
  // flows that "some are refused", it would read as the gate partly working.
  test("the same file flows are NOT refused while a follow reconcile holds the plan", async ({ page }) => {
    await setDialogAnswer(page, "Ok");
    await goLive(page);
    const sweepReads = await getCount(page);
    await setLatency(page, { get: 8, set: 8 });

    // Dirty the plan so the flows have to confirm, exactly as in the guarded half.
    await page.click("#btn-view-console");
    await faderOf(page, "CH 1").focus();
    await page.keyboard.press("ArrowUp");
    await waitQuiet(page);

    // Hold the escalated sweep a fifth of the way in, on the barrier rather than on a
    // read count reached and then left to run: both flows below are several round
    // trips each, and the read they are supposed to be running over has to still be
    // in flight when the last of them lands.
    const base = await getCount(page);
    await blockAt(page, "vd_get", Math.max(4, Math.round(sweepReads * 0.2)));
    await pushBulkChange(page);
    await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 90_000 });
    const heldAt = (await getCount(page)) - base;
    await mark(page, "during-reconcile");

    const dialogsBefore = (await dialogsOf(page)).length;
    await fileMenu(page, "btn-open"); // cancels (the fake answers the open dialog null)
    const openDialogs = spans(await traceOf(page)).filter((s) => s.cmd === "plugin:dialog|open").length;
    const pickerLocked = await page.locator("#model-picker").isDisabled();
    const pickerDuring = await page.locator("#model-picker").inputValue();
    await fileMenu(page, "btn-new");
    const statusDuring = await statusText(page);
    const dialogsDuring = (await dialogsOf(page)).length;
    await mark(page, "flows-done");

    // Only now let the held sweep run out, so every read below the mark is one the
    // app chose to issue after both flows had replaced the plan under it.
    await releaseBarrier(page);
    await settleAfter(page, "flows-done");
    const trace = await traceOf(page);
    const findings = analyze(trace, { quiesceAfter: "flows-done" });
    const readsAfter = getsOf(trace).filter((g) => g.start > markTime(trace, "flows-done")!);

    console.log(timeline(trace, { from: markTime(trace, "during-reconcile")! - 200 }));
    console.log(report("flows during an unguarded reconcile", findings));
    console.log(
      `during reconcile (held at read ${heldAt} of ~${sweepReads}): picker=${pickerDuring}` +
        ` (locked=${pickerLocked}) status="${statusDuring}"` +
        ` dialogs=${dialogsDuring} (was ${dialogsBefore}); open dialogs=${openDialogs};` +
        ` reads after the flows=${readsAfter.length}`,
    );

    // Pinned behaviour, and the point of the pair: neither flow that can run is refused
    // while the very same whole-device read is mutating the very same plan.
    expect(openDialogs).toBe(1); // File > Open reached its native dialog
    expect(statusDuring).toContain("Created a new plan"); // and so did File > New
    expect(dialogsDuring).toBeGreaterThan(dialogsBefore); // each one asked its confirm
    // The third flow never runs at all — locked by the session, not by the reconcile —
    // so the model on screen is still the one the session named.
    expect(pickerLocked).toBe(true);
    expect(pickerDuring).toBe("URX44V");
    // …and the read that both ran over is still going.
    expect(readsAfter.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.inv === 16)).toBe(true);
  });

  // teardown-flow-refusals, the stacked-dialog half. fileFlow is one latch across every
  // file entry point, so a second Save while the first is still holding a native dialog
  // must be dropped rather than stack a second one on the operator's screen.
  test("a second Save while the first holds a native dialog is dropped, not stacked", async ({ page }) => {
    await blockAt(page, "plugin:dialog|save", 1);
    await fileMenu(page, "btn-save");
    await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 15_000 });
    await mark(page, "save-pending");
    await fileMenu(page, "btn-save");
    const saveDialogs = spans(await traceOf(page)).filter((s) => s.cmd === "plugin:dialog|save").length;
    await releaseBarrier(page);
    await expect(page.locator("#statusbar")).toContainText("Canceled");

    const trace = await traceOf(page);
    console.log(timeline(trace, { from: markTime(trace, "save-pending")! - 500 }));
    console.log(`save dialogs opened while one was pending: ${saveDialogs}`);
    expect(saveDialogs).toBe(1);
  });

  // teardown-live-toggle-race, run A. singleFlight wraps the activation because it is a
  // long async flow during which the toggle is neither on nor off; two clicks inside it
  // must not open two connections.
  test("two live-toggle clicks in the same tick admit exactly one activation", async ({ page }) => {
    await setLatency(page, { connect: 200, subscribe: 100 });
    await page.click("#btn-device");
    await mark(page, "double-click");
    await clickLive(page, 2);
    await page.waitForSelector('#btn-live[aria-pressed="true"]', { state: "attached", timeout: 40_000 });
    await waitQuiet(page);

    const counters = await countersOf(page);
    const trace = await traceOf(page);
    console.log(timeline(trace, { from: markTime(trace, "double-click")! - 50, limit: 40 }));
    console.log(`connects=${counters.connects} param subs=${counters.subscribes}/${counters.unsubscribes}`);

    expect(counters.connects).toBe(1);
    expect(counters.subscribes).toBe(1);
    expect(counters.unsubscribes).toBe(0);
  });

  // teardown-live-toggle-race, run B — the half-started window. live.begin() flips
  // LiveSync.active before the awaited follow.begin(), so between them isActive() is
  // true while liveSessionUp is still false: the toggle's click handler routes into
  // deactivateLive, which early-returns on liveSessionUp. The operator's "off" is
  // swallowed and the session comes up anyway.
  test("a deactivate click inside the half-started window is swallowed and the session comes up", async ({ page }) => {
    await setLatency(page, { subscribe: 400 });
    await blockAt(page, "vd_params_subscribe", 1);
    await page.click("#btn-device");
    await page.click("#btn-live");
    await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 40_000 });

    await mark(page, "deactivate-attempt");
    await clickLive(page);
    // aria-pressed here is the pre-activation state and says nothing about the click
    // — it is logged, not asserted. What the toggle being enabled does say is that
    // the click was dispatched into a live control rather than an inert one.
    const pressedDuring = await page.locator("#btn-live").getAttribute("aria-pressed");
    const disabledDuring = await page.evaluate(
      () => (document.getElementById("btn-live") as HTMLButtonElement).disabled,
    );
    await releaseBarrier(page);
    await page.waitForSelector('#btn-live[aria-pressed="true"]', { state: "attached", timeout: 40_000 });
    await waitQuiet(page);

    const pressedAfter = await page.locator("#btn-live").getAttribute("aria-pressed");
    const counters = await countersOf(page);
    const statusAfter = await statusText(page);

    // The control arm for the gesture itself: the identical programmatic click on the
    // identical button, once the session is up, does tear it down. The difference
    // between the two clicks is the window they land in, not the way they are made.
    await mark(page, "deactivate-after");
    await clickLive(page);
    await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "false");
    const countersEnd = await countersOf(page);

    const trace = await traceOf(page);
    console.log(timeline(trace, { from: markTime(trace, "deactivate-attempt")! - 200, limit: 40 }));
    console.log(
      `aria-pressed during=${pressedDuring} (pre-activation) after=${pressedAfter} disabled=${disabledDuring};` +
        ` connects=${counters.connects} param subs=${counters.subscribes}/${counters.unsubscribes}` +
        ` → after the control click ${countersEnd.subscribes}/${countersEnd.unsubscribes}; status="${statusAfter}"`,
    );

    // Pinned behaviour: the click changed nothing. deactivateLive's liveSessionUp
    // guard (which exists so an error-path teardown is idempotent) also makes the
    // toggle dead for the whole half-started window, and the subscription that was in
    // flight is kept rather than unwound.
    expect(disabledDuring).toBe(false);
    expect(pressedAfter).toBe("true");
    expect(counters.subscribes).toBe(1);
    expect(counters.unsubscribes).toBe(0);
    expect(statusAfter).toContain("Live sync on");
    // …while the same click outside the window is honoured immediately.
    expect(countersEnd.unsubscribes).toBe(1);
  });

  // teardown-live-toggle-race, run C. The disconnect is fire-and-forget, so a late one
  // could close a connection a later activation opened; every session captures the
  // generation it holds and releases exactly that one.
  test("five live cycles produce five connects and five disconnects, each with its own epoch", async ({ page }) => {
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    await setLatency(page, { connect: 20, subscribe: 20 });

    for (let i = 0; i < 5; i++) {
      await goLive(page);
      await clickLive(page);
      await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "false");
      await page.waitForTimeout(300);
    }
    await waitQuiet(page);

    const counters = await countersOf(page);
    const trace = await traceOf(page);
    const disconnects = spans(trace).filter((s) => s.cmd === "vd_disconnect");
    console.log(timeline(trace, { from: 0, limit: 60 }));
    console.log(
      `connects=${counters.connects} disconnects=${disconnects.length} epochs=[${disconnects
        .map((d) => d.detail)
        .join(",")}] param subs=${counters.subscribes}/${counters.unsubscribes}` +
        ` meter subs=${counters.meterSubs}/${counters.meterUnsubs}`,
    );

    expect(counters.connects).toBe(5);
    // Each teardown releases the generation its own session opened, in order — the
    // property that keeps a late disconnect from closing a newer connection.
    expect(disconnects.map((d) => d.detail)).toEqual(["1", "2", "3", "4", "5"]);
    // Nothing survives a cycle: both channels are balanced at the end.
    expect(counters.unsubscribes).toBe(counters.subscribes);
    expect(counters.subscribes).toBe(5);
    expect(counters.meterSubs).toBeGreaterThan(0);
    expect(counters.meterUnsubs).toBe(counters.meterSubs);
  });

  // teardown-live-toggle-race, run D. The broker has one meter slot per process, and
  // setLiveUi hands it out in a fixed order: the console subscribes, then an open
  // tuning screen takes it back off it. Starting a session with the screen already
  // open must land on the screen, not the console.
  test("a session started with a tuning screen open leaves the meter slot with the screen", async ({ page }) => {
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    await strip(page, "CH 1").locator('[aria-label="Comp screen…"]').click();
    await expect(page.locator("#dyn-screen-box")).toBeVisible();

    // Not goLive(): the screen is modal and its scrim intercepts pointer events for
    // the whole page, so the Device menu cannot be opened behind it. The toggle is
    // the same button either way — this dispatches it directly.
    await clickLive(page);
    await page.waitForSelector('#btn-live[aria-pressed="true"]', { state: "attached", timeout: 60_000 });
    const withScreen = await meterAddrsOf(page);
    // Closing hands the slot back; the console's own set is what it becomes.
    await page.keyboard.press("Escape");
    await expect(page.locator("#dyn-screen-box")).toBeHidden();
    await waitQuiet(page);
    const withConsole = await meterAddrsOf(page);

    const counters = await countersOf(page);
    const trace = await traceOf(page);
    const meterCalls = spans(trace)
      .filter((s) => s.cmd.startsWith("vd_meters_"))
      .map((s) => s.cmd.replace("vd_meters_", ""));
    console.log(
      `meter registration: with the screen open ${withScreen.length} address(es)` +
        ` [${withScreen.map((a) => a.join(":")).join(" ")}], after closing ${withConsole.length};` +
        ` meter subs=${counters.meterSubs}/${counters.meterUnsubs}; calls=[${meterCalls.join(" ")}]`,
    );
    console.log(timeline(trace, { from: 0, limit: 40 }));

    // The screen's lanes are a handful of taps on one node; the console's are every
    // strip. The slot ending on the small set is what says the screen won the handover.
    expect(withScreen.length).toBeGreaterThan(0);
    expect(withConsole.length).toBeGreaterThan(withScreen.length);

    // Pinned behaviour, invariant 11. The handover on the way OUT of the screen is
    // clean (unsubscribe, then subscribe), but the one setLiveUi performs on the way
    // IN is not: the console subscribes and the screen subscribes straight over it,
    // with no unsubscribe between. The broker has one slot per process, so the
    // console's registration is displaced by a call it did not make.
    //
    // What is NOT shown here: that anything is stranded. vd_meters_subscribe REPLACES
    // the registration, so the subscribe/unsubscribe imbalance below is the arithmetic
    // of a replacing API rather than a leaked stream — it is pinned as the shape this
    // sequence produces today, not as evidence of one. Whether the console still
    // considers itself the owner is module state this harness cannot see.
    expect(meterCalls).toEqual(["subscribe", "subscribe", "unsubscribe", "subscribe"]);
    expect(counters.meterSubs - counters.meterUnsubs).toBe(2);
  });

  // teardown-deactivate-with-armed-timers, the pure coalesce window. A direct notify
  // arms the 50 ms reflect; the deactivate lands inside it, in the same tick, so the
  // timer is armed and unclaimed when the session goes away. Nothing may reach the
  // device afterwards.
  test("deactivating inside the reflect coalesce window sends nothing more to the device", async ({ page }) => {
    await goLive(page);
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    await setLatency(page, { get: 8, set: 25 });

    const before = (await faderReadout(page, "CH 1").textContent())!;
    // Both in one tick: the notify arms the reflect and the click tears the session
    // down before the timer can fire. The mark is stamped after the click, so the
    // synchronous part of the teardown (the two unsubscribes) stays outside it.
    await page.evaluate(() => {
      const f = window.__urxFake;
      f.pushNotify([[139, 0, 0, 20]]);
      (document.getElementById("btn-live") as HTMLButtonElement).click();
      f.mark("deactivated");
    });
    await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "false");
    // The verdict below is an ABSENCE, so it may not be bounded by the driver's
    // patience: settleAfter waits for the link to wake up after the mark before it
    // looks for silence, and its grace outstays the 50 ms reflect and the 300/900 ms
    // follow nets. waitQuiet on its own would return immediately here.
    await settleAfter(page, "deactivated");

    const after = (await faderReadout(page, "CH 1").textContent())!;
    const trace = await traceOf(page);
    const findings = analyze(trace, { quiesceAfter: "deactivated" });
    console.log(timeline(trace, { from: markTime(trace, "deactivated")! - 300 }));
    console.log(report("deactivate inside the reflect coalesce", findings));
    console.log(`readout: before=${before} after=${after}; status="${await statusText(page)}"`);

    // Invariant 16 for the direct path: follow.end() cancels the settle and idle
    // timers, and the reflect the notify armed does no IPC of its own, so the link
    // goes quiet at the click.
    expect(findings.filter((f) => f.inv === 16)).toHaveLength(0);
    // The notify's value was applied to the plan before the teardown, and nothing
    // undid it — the reflect that repaints it runs after the session is gone.
    expect(after).not.toBe(before);
  });

  // teardown-deactivate-with-armed-timers, the in-flight-reconcile window. Here the
  // reconcile's continuation runs entirely after the teardown: it sets followFull,
  // requests a reflect, and the reflect then calls planHistory.reset() and
  // live.resync() on a session that no longer exists.
  test("deactivating while a scoped reconcile is awaiting leaves reads and a reflect running past teardown", async ({
    page,
  }) => {
    await goLive(page);
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    await setLatency(page, { get: 8, set: 25 });

    // An edit first, so the history has depth: the app pushes the Edit menu's enabled
    // state over IPC only on a real transition, which makes planHistory.reset() the one
    // module-level latch in this file that is observable from outside the page.
    await faderOf(page, "CH 1").focus();
    await page.keyboard.press("ArrowUp");
    await waitQuiet(page);

    // Make the device hold a fader value the app never wrote, so the scoped read below
    // genuinely AUTHORS a key. Without it the read agrees with the plan at every key,
    // the reflect's reset is skipped as the no-op it would be, and the Edit-menu push
    // this case reads as its evidence never happens — leaving the case asserting the
    // reads half of its own title and nothing about the reflect.
    await divergeAt(page, CH1_FADER, 20);

    // A scoped notify: the settle runs applyNodeState over ch1. Hold its first read so
    // the teardown can be placed inside the await.
    await blockAt(page, "vd_get", 1);
    await mark(page, "scoped-notify");
    await pushNotify(page, [[...CH1_HPF_FREQ, 40]]);
    await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 20_000 });

    // Release and tear down in the same tick: the held read resolves on a microtask,
    // so every remaining read of the node is issued after the session ended.
    await page.evaluate(() => {
      const f = window.__urxFake;
      f.release();
      (document.getElementById("btn-live") as HTMLButtonElement).click();
      f.mark("deactivated");
    });
    await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "false");
    await settleAfter(page, "deactivated");

    const trace = await traceOf(page);
    const at = markTime(trace, "deactivated")!;
    const findings = analyze(trace, { quiesceAfter: "deactivated" });
    const readsAfter = getsOf(trace).filter((g) => g.start > at);
    const menuAfter = spans(trace).filter((s) => s.cmd === "set_edit_menu_state" && s.start > at);

    console.log(timeline(trace, { from: markTime(trace, "scoped-notify")! - 100 }));
    console.log(report("deactivate during a scoped reconcile", findings));
    console.log(
      `reads after teardown=${readsAfter.length}; edit-menu pushes after teardown=` +
        `[${menuAfter.map((s) => s.detail).join(" ")}]; status="${await statusText(page)}"`,
    );

    // Pinned behaviour (invariants 14 and 16): applyNodeState takes no abort signal
    // and follow's own `active` flag is only checked before the await, so the rest of
    // the node's reads go out on a dead session…
    expect(readsAfter.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.inv === 16)).toBe(true);
    // …and the continuation still runs: followFull is latched, the reflect fires, and
    // planHistory.reset() drops the operator's entry — visible from outside the page
    // as the Edit menu going disabled after the session ended. The reset is conditional
    // on the read having authored something, which the diverged fader above is what
    // makes true: this assertion is therefore also the positive arm of that condition.
    expect(menuAfter.map((s) => s.detail)).toContain("false/false");
  });
});
