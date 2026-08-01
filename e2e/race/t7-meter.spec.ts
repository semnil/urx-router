import { test, expect, type Page } from "@playwright/test";
import {
  installFake,
  goLive,
  mark,
  pushNotify,
  traceOf,
  paramAddrsOf,
  meterAddrsOf,
  countersOf,
  setLatency,
  blockAt,
  releaseBarrier,
  divergeAt,
  refuseAt,
  dialogsOf,
  waitQuiet,
  settleAfter,
  pushMeters,
  pushMetersDelivered,
  meterDropsOf,
} from "./fake-device";
import { analyze, report, timeline, markTime, spans } from "./analyze";
import { strip } from "./ui";

// T7 meter — the one process-wide meter registration
// (docs/{en,ja}/live-race-harness.md). `vd_meters_subscribe` REPLACES whatever was
// registered and `vd_meters_unsubscribe` takes no address, so the unsubscribe handle
// a consumer holds is a global operation wearing the shape of a per-subscription
// one. Two consumers exist (the CONSOLE and the channel tuning screens) and the
// handover between them is invisible under a microtask stub: every window these
// cases place lives inside the registration's own await, which only a scripted
// `subscribe` latency (or a barrier on the command) opens at all.

/** URX44V POST taps — what the console registers by default. */
const CH1_POST: [number, number] = [115, 0];
const CH2_POST: [number, number] = [115, 1];
const CH1_PREEQ: [number, number] = [111, 0];
const CH2_PREGATE: [number, number] = [106, 1];
/** The GATE screen's three lanes on ch1: PRE GATE, GATE GR, PRE COMP. */
const GATE_TAPS: Array<[number, number]> = [
  [106, 0],
  [107, 0],
  [108, 0],
];
/** The COMP screen's three lanes on ch1: PRE COMP, COMP GR, PRE EQ. */
const COMP_TAPS: Array<[number, number]> = [
  [108, 0],
  [110, 0],
  [111, 0],
];
/** COMP_EQ_TYPE (21) on ch1. Writing SSMCS (1) takes the compressor away entirely,
 *  which is what makes a COMP screen's `rebind` return null and close it. */
const CH1_COMP_EQ_TYPE: [number, number, number] = [21, 0, 0];
const SSMCS = 1;

const meterReadout = (page: Page, name: string) => strip(page, name).locator(".con-readout .rd.mtr .rv");
const tapBadge = (page: Page, name: string) => strip(page, name).locator(".con-tap");
const dynBox = (page: Page) => page.locator("#dyn-screen-box");
const dynReadout = (page: Page, label: string) => dynBox(page).locator(".gt-ro", { hasText: label }).locator(".v");

const key = (a: readonly [number, number]): string => `${a[0]}:${a[1]}`;
const regOf = async (page: Page): Promise<string[]> => (await meterAddrsOf(page)).map((a) => a.join(":"));

// Every frame below goes through the fake bridge's registered-set filter (the meter half
// of vd.rs `Subs::absorb`), so the driver never has to pre-filter: a frame for an address
// nobody registered is dropped where a real unit would never have sent it, and leaves a
// `meter-drop` record naming the reason. `pushMetersDelivered` is the form for a case
// whose subject is the readout — it throws at the push instead of letting the expectation
// time out — and plain `pushMeters` returns the per-frame verdicts, which is what a case
// measuring the refusal asserts on.

/** Open the console and wait until its own meter registration is on the device. */
async function consoleWithMeters(page: Page): Promise<void> {
  await page.click("#btn-view-console");
  await expect(meterReadout(page, "CH 1")).toBeVisible();
  await expect.poll(() => regOf(page)).toContain(key(CH1_POST));
}

/** Open a tuning screen from the CONSOLE strip (the entry that leaves the console
 *  visible behind the modal, which is where a steal-back would show). */
async function openFromConsole(page: Page, which: number): Promise<void> {
  await page.locator(".con-strip").nth(0).locator(".con-chip-open").nth(which).click();
  await expect(dynBox(page)).toBeVisible();
}

/** The meter registrations issued after `t`, in order. The console's regain is its
 *  own re-registration, so the pair "screen's subscribe, console's subscribe" is the
 *  app's own timestamp of the close — far tighter than the moment the driver notices
 *  the modal is hidden, which is what decides whether the close fell inside the
 *  screen's await. */
const subsAfter = (trace: Awaited<ReturnType<typeof traceOf>>, t: number) =>
  spans(trace).filter((s) => s.cmd === "vd_meters_subscribe" && s.start >= t);

test.describe("T7 meter", () => {
  test.describe("URX44V", () => {
    test.beforeEach(async ({ page }) => {
      await installFake(page);
      await page.goto("/");
      await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    });

    // meter-slot-handover — the reference the two failure cases are differenced
    // against. Without it a dropped stream cannot be told from a handover that never
    // worked in the first place.
    test("the slot is released before the screen registers, is not stolen back by a reconcile, and comes back on close", async ({
      page,
    }) => {
      await goLive(page);
      await consoleWithMeters(page);
      await setLatency(page, { subscribe: 30, get: 4, set: 4 });

      await pushMetersDelivered(page, [
        [...CH1_POST, -153],
        [...CH2_POST, -201],
      ]);
      await expect(meterReadout(page, "CH 1")).toHaveText("-15.3");
      await expect(meterReadout(page, "CH 2")).toHaveText("-20.1");
      const base = await countersOf(page);

      await mark(page, "open-gate");
      await openFromConsole(page, 0);
      await expect.poll(() => meterAddrsOf(page)).toEqual(GATE_TAPS);

      // Exclusivity, from both sides at once: the screen reads its own addresses and
      // the console — whose strips are still in the DOM behind the scrim — has been
      // reset to "—" rather than left holding the last reading of a stream it no
      // longer owns. The console's own address is pushed with it and refused by the
      // bridge, which is the other half of exclusivity: the slot is the registration,
      // so while the screen holds it a frame for CH 1 cannot arrive at all.
      expect(
        await pushMeters(page, [
          [107, 0, -239],
          [...CH1_POST, -100],
        ]),
      ).toEqual(["", "unregistered"]);
      await expect(dynReadout(page, "Gate GR")).toHaveText("-23.9");
      await expect(meterReadout(page, "CH 1")).toHaveText("—");

      const afterOpen = await countersOf(page);
      const taken = await regOf(page);

      // A device-side change on ch1 arrives as a scoped notify: 300 ms settle, a
      // readback of the owning node, then a FULL reflect — which re-renders the
      // console. Every console render ends in startMeters, so this is the path that
      // would take the slot back out from under the screen.
      await mark(page, "scoped-notify");
      await pushNotify(page, [[26, 0, 0, 120]]); // HPF frequency on ch1
      await page.waitForSelector('#statusbar:text-matches("← device \\\\(\\\\d+\\\\)")', { timeout: 30_000 });
      await mark(page, "reconciled");
      await waitQuiet(page);

      const afterReconcile = await countersOf(page);
      expect(await meterAddrsOf(page)).toEqual(GATE_TAPS); // no steal-back
      expect(afterReconcile.meterSubs).toBe(afterOpen.meterSubs);
      expect(afterReconcile.meterUnsubs).toBe(afterOpen.meterUnsubs);
      // …and the screen is still being fed on its own addresses.
      await pushMetersDelivered(page, [[107, 0, -311]]);
      await expect(dynReadout(page, "Gate GR")).toHaveText("-31.1");

      await mark(page, "close-gate");
      await dynBox(page).locator(".consent-btn-primary").click();
      await expect(dynBox(page)).toBeHidden();
      await expect.poll(() => regOf(page)).toContain(key(CH1_POST));
      await waitQuiet(page);

      const end = await countersOf(page);
      const trace = await traceOf(page);
      const findings = analyze(trace, { registration: await paramAddrsOf(page) });
      const meterIpc = spans(trace)
        .filter((s) => s.cmd.startsWith("vd_meters_"))
        .map((s) => `${s.start.toFixed(0)} ${s.cmd}`);

      console.log(timeline(trace, { from: markTime(trace, "open-gate")! - 100 }));
      console.log(report("meter slot handover", findings));
      console.log(`meter IPC: ${meterIpc.join(" | ")}`);
      console.log(
        `counters: subs ${base.meterSubs}→${end.meterSubs}, unsubs ${base.meterUnsubs}→${end.meterUnsubs}; screen held ${taken.join(",")}`,
      );

      // The handover order is the invariant, not just the end state: the console's
      // registration is dropped BEFORE the screen's replaces it, so the broker is
      // never asked to hold two.
      const openAt = markTime(trace, "open-gate")!;
      const closeAt = markTime(trace, "close-gate")!;
      const handover = spans(trace).filter((s) => s.cmd.startsWith("vd_meters_") && s.start >= openAt);
      expect(handover[0].cmd).toBe("vd_meters_unsubscribe");
      expect(handover[1].cmd).toBe("vd_meters_subscribe");
      expect(handover[0].start).toBeLessThanOrEqual(handover[1].start);
      // Exactly one exchange each way, and the give-back re-registers the console's
      // own (larger) address set rather than leaving the screen's three behind.
      expect(afterOpen.meterUnsubs - base.meterUnsubs).toBe(1);
      expect(afterOpen.meterSubs - base.meterSubs).toBe(1);
      expect(end.meterSubs - afterReconcile.meterSubs).toBe(1);
      expect((await meterAddrsOf(page)).length).toBeGreaterThan(GATE_TAPS.length);
      expect(spans(trace).filter((s) => s.cmd === "vd_meters_subscribe" && s.start >= closeAt)).toHaveLength(1);

      // Nothing was dropped by the generation stamp on the way through: the console's
      // freshly regained stream feeds its strips again.
      await pushMetersDelivered(page, [
        [...CH1_POST, -122],
        [...CH2_POST, -180],
      ]);
      await expect(meterReadout(page, "CH 1")).toHaveText("-12.2");
      await expect(meterReadout(page, "CH 2")).toHaveText("-18.0");
      // analyze() is printed but not asserted: this run issues no write and no param
      // notify, so none of its invariants has an input and an empty result would be a
      // property of the call rather than of the app. The counters above are the verdict.
    });

    // meter-slot-handover, the setLiveUi half: consoleView.setLive() runs before
    // dynScreen.setLive(), so a session that drops and returns must end with the slot
    // in the screen's hands, not the console's.
    test("a live off/on cycle with the screen open leaves the slot with the screen", async ({ page }) => {
      await goLive(page);
      await consoleWithMeters(page);
      await openFromConsole(page, 0);
      await expect.poll(() => meterAddrsOf(page)).toEqual(GATE_TAPS);
      const base = await countersOf(page);

      // The screen's scrim covers the whole page, so the toggle cannot be reached by
      // a real click. Dispatching onto the button drives the same listener without
      // asking the driver to defeat a modal that is doing its job.
      await mark(page, "live-off");
      await page.locator("#btn-live").dispatchEvent("click");
      await expect(page.locator('#btn-live[aria-pressed="false"]')).toBeAttached();
      await waitQuiet(page);
      const off = await countersOf(page);

      await mark(page, "live-on");
      await page.locator("#btn-live").dispatchEvent("click");
      await page.waitForSelector('#btn-live[aria-pressed="true"]', { state: "attached", timeout: 30_000 });
      await waitQuiet(page);

      const end = await countersOf(page);
      const trace = await traceOf(page);
      // No analyze() here: this run issues no vd_set and receives no notify, so every
      // invariant the offline analyzer can decide is unreachable and a "clean" verdict
      // would be a property of the run, not of the app. The counters below are the
      // whole check.
      console.log(timeline(trace, { from: markTime(trace, "live-off")! - 100 }));
      console.log(
        `counters: subs ${base.meterSubs}/${off.meterSubs}/${end.meterSubs}, unsubs ${base.meterUnsubs}/${off.meterUnsubs}/${end.meterUnsubs}`,
      );
      console.log(`registration after the cycle: ${(await regOf(page)).join(",")}`);

      // Ending the session tears the stream down exactly once (the console holds no
      // registration to drop — it lent the slot away), and nothing re-registers while
      // the session is down.
      expect(off.meterUnsubs - base.meterUnsubs).toBe(1);
      expect(off.meterSubs).toBe(base.meterSubs);
      // Coming back, the console renders first and the screen takes the slot after —
      // so the device ends up registered for the screen's three lanes, not the
      // console's rack.
      expect(await meterAddrsOf(page)).toEqual(GATE_TAPS);
      expect(end.meterSubs).toBeGreaterThan(off.meterSubs);
      await pushMetersDelivered(page, [[107, 0, -177]]);
      await expect(dynReadout(page, "Gate GR")).toHaveText("-17.7");
    });

    // meter-late-unsub-kills-console, barrier form. The window is the screen's own
    // registration await, held open by a barrier so the close lands strictly inside
    // it rather than statistically near it.
    //
    // The close is UI-DRIVEN, and it has to be. This case used to close the screen the
    // way the ladder below does — a device-side switch to SSMCS, whose scoped reconcile
    // makes rebind() find no compressor — but the bridge is ONE worker thread
    // (src-tauri/src/vd.rs) and the fake now serializes the same way, so those vd_gets
    // queue BEHIND the held vd_meters_subscribe and can never resolve while the gate is
    // shut. "Closed inside its own pending registration" is unreachable on a faithful
    // bridge whenever the closing event itself needs a read; the Close press needs none,
    // and the mechanism under test — the generation stamp in core/meters.ts — does not
    // care which of the two closed the screen. The device-driven close stays measured by
    // the ladder below, where the registration has resolved before the reconcile runs.
    test("a screen closed inside its own pending registration does not tear down the console's new stream", async ({
      page,
    }) => {
      await goLive(page);
      await consoleWithMeters(page);
      await setLatency(page, { subscribe: 200, get: 8, set: 8 });
      await pushMetersDelivered(page, [[...CH1_POST, -153]]);
      await expect(meterReadout(page, "CH 1")).toHaveText("-15.3");
      const base = await countersOf(page);

      // Hold the screen's registration. The barrier holds every later
      // vd_meters_subscribe too, which is deliberate: the console's re-registration
      // is then issued while the screen's is still outstanding, i.e. the two are
      // genuinely in flight together.
      await blockAt(page, "vd_meters_subscribe", 1);
      await mark(page, "open-comp");
      await openFromConsole(page, 1);
      await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 15_000 });

      // Closed strictly inside that await: the screen runs stopMeters with its unsub
      // still null, hands the slot back, and the console re-subscribes while the
      // screen's own registration is still outstanding.
      await mark(page, "close-comp");
      await dynBox(page).locator(".consent-btn-primary").click();
      await expect(dynBox(page)).toBeHidden();
      await mark(page, "screen-closed");

      await mark(page, "release");
      await releaseBarrier(page);
      await waitQuiet(page);

      const end = await countersOf(page);
      const trace = await traceOf(page);
      const findings = analyze(trace, { registration: await paramAddrsOf(page) });
      const openAt = markTime(trace, "open-comp")!;
      const [screenSub, consoleSub] = subsAfter(trace, openAt);

      console.log(timeline(trace, { from: openAt - 100 }));
      console.log(report("late unsub vs the console stream", findings));
      console.log(
        `screen registration ${screenSub?.start.toFixed(0)}–${screenSub?.end.toFixed(0)} ms; the console re-registered at ${consoleSub?.start.toFixed(0)} ms (DOM saw the close at ${markTime(trace, "screen-closed")!.toFixed(0)} ms)`,
      );
      console.log(
        `counters: subs ${base.meterSubs}→${end.meterSubs}, unsubs ${base.meterUnsubs}→${end.meterUnsubs}; registration ${(await regOf(page)).join(",")}`,
      );

      // The placement, measured against the barrier rather than against the screen's
      // own resolve: `consoleSub.start < screenSub.end` would be true by construction,
      // since the gate holds every later subscribe too and `screenSub.end` is therefore
      // the release timestamp. What is not by construction is that the console's regain
      // was ISSUED before the release — the app could equally have deferred it until the
      // screen's registration resolved, which is what would put the two in sequence.
      expect(screenSub).toBeDefined();
      expect(consoleSub).toBeDefined();
      expect(consoleSub.start).toBeLessThan(markTime(trace, "release")!);
      expect(await meterAddrsOf(page)).not.toEqual(COMP_TAPS);

      // The generation stamp in core/meters.ts is what decides this: the closed
      // screen's unsubscribe carries a superseded generation and is suppressed, so
      // exactly one unsubscribe (the console's release when the screen opened) ever
      // reaches the device and the console's freshly established stream survives.
      expect(end.meterUnsubs - base.meterUnsubs).toBe(1);
      await expect.poll(() => regOf(page)).toContain(key(CH1_POST));
      await pushMetersDelivered(page, [[...CH1_POST, -211]]);
      await expect(meterReadout(page, "CH 1")).toHaveText("-21.1"); // bars live, not floored
      expect(findings).toHaveLength(0);
    });

    // meter-late-unsub-kills-console, latency form: a DEVICE-driven close — the unit
    // switches ch1 to SSMCS, the scoped reconcile's reflect calls dynScreen.refresh(),
    // rebind() finds no compressor and the screen closes on its own.
    //
    // WITHDRAWN — the Δ=300 rung ("the same close inside the registration await"). The
    // bridge serves one command at a time, so the reconcile's vd_gets queue behind the
    // registration and cannot start until it has resolved: on a 2000 ms registration the
    // close lands at the earliest ~2000 ms + the 300 ms settle + a node readback, i.e.
    // strictly after the await whatever Δ is asked for. It is not a rung that needs a
    // wider window — it is unreachable by construction on a faithful bridge, because the
    // event that closes the screen is itself made of reads the registration is holding.
    // The rung's subject (a close inside a pending registration) is measured by the
    // barrier case above, where the close is UI-driven and needs no read. One value is
    // left in the loop deliberately, so the withdrawal is legible beside what survives.
    const SUB_MS = 2000;
    for (const delta of [2500]) {
      test(`a screen closed ${delta} ms into a ${SUB_MS} ms registration keeps the console fed`, async ({ page }) => {
        await goLive(page);
        await consoleWithMeters(page);
        await setLatency(page, { subscribe: SUB_MS, get: 8, set: 8 });
        await pushMetersDelivered(page, [[...CH1_POST, -153]]);
        await expect(meterReadout(page, "CH 1")).toHaveText("-15.3");
        const base = await countersOf(page);

        await mark(page, "open-comp");
        await openFromConsole(page, 1);
        await page.waitForTimeout(delta);
        await divergeAt(page, CH1_COMP_EQ_TYPE.join(":"), SSMCS);
        await mark(page, "ssmcs-notify");
        await pushNotify(page, [[...CH1_COMP_EQ_TYPE, SSMCS]]);
        await expect(dynBox(page)).toBeHidden({ timeout: 30_000 });
        await mark(page, "screen-closed");
        await waitQuiet(page);

        const end = await countersOf(page);
        const trace = await traceOf(page);
        const findings = analyze(trace, { registration: await paramAddrsOf(page) });
        const openAt = markTime(trace, "open-comp")!;
        const [screenSub, consoleSub] = subsAfter(trace, openAt);
        const inside = consoleSub.start < screenSub.end;

        console.log(timeline(trace, { from: openAt - 100 }));
        console.log(report(`late unsub ladder Δ=${delta}`, findings));
        console.log(
          `intended Δ=${delta} ms; screen registration ${screenSub.start.toFixed(0)}–${screenSub.end.toFixed(0)} ms, the console re-registered at ${consoleSub.start.toFixed(0)} ms → ${inside ? "INSIDE" : "after"} the await`,
        );
        console.log(`counters: subs ${base.meterSubs}→${end.meterSubs}, unsubs ${base.meterUnsubs}→${end.meterUnsubs}`);

        // The placement first, or the count below is not attributable: the close landed
        // AFTER the registration resolved, which is the only side of the edge a
        // device-driven close can reach (see the withdrawal above). The barrier case is
        // where the other side is measured, and it reads one unsubscribe there.
        expect(inside).toBe(false);
        // A screen whose registration had already resolved owns a stream and
        // unsubscribes it on the way out, so the console's release and the screen's own
        // are two separate exchanges.
        expect(end.meterUnsubs - base.meterUnsubs).toBe(2);
        // Either way the console must end up with a live stream on its own addresses.
        await expect.poll(() => regOf(page)).toContain(key(CH1_POST));
        await pushMetersDelivered(page, [[...CH1_POST, -188]]);
        await expect(meterReadout(page, "CH 1")).toHaveText("-18.8");
        expect(findings).toHaveLength(0);
      });
    }

    // meter-rescope-inside-subpending-ladder. A second re-scope arriving while the
    // first registration is still in flight: `subPending` makes startMeters return
    // before it records the new signature, so the addresses of the second re-scope
    // are never registered AND `subSig` still names the first — which the tail check
    // at the resolve compares equal, and keeps.
    // The ladder is wall-clock placed, so only rungs that land clearly on one side of
    // the registration's closing edge are interpretable; a rung aimed at the edge itself
    // (190 ms into a nominal 200 ms window) landed 23 ms PAST it and could assert
    // nothing. The deterministic form of the "inside" point is the barrier test below.
    for (const d of [10, 50, 260]) {
      test(`a re-scope ${d} ms into a 200 ms registration: what is actually registered`, async ({ page }) => {
        await goLive(page);
        await consoleWithMeters(page);
        await setLatency(page, { subscribe: 200 });

        await mark(page, "rescope1");
        await tapBadge(page, "CH 1").click();
        await page.locator(".con-tappop .crow", { has: page.getByText("PRE EQ", { exact: true }) }).click();
        await expect(tapBadge(page, "CH 1")).toContainText("PRE EQ");

        await page.waitForTimeout(d);
        await tapBadge(page, "CH 2").click();
        await page.locator(".con-tappop .crow", { has: page.getByText("PRE GATE", { exact: true }) }).click();
        // Stamped AFTER the row click, which is the gesture that re-scopes. Stamped
        // before it — with the badge click and a locator resolution still to come —
        // the mark bounds a driver round trip rather than the gesture, and the gap
        // between the two is the same order as the 30 ms dead zone the rung is judged
        // against below.
        await mark(page, "rescope2");
        await expect(tapBadge(page, "CH 2")).toContainText("PRE GATE");
        // The verdict at the low rungs is an absence (no second registration ever
        // left), and waitQuiet answers that immediately whether or not one was on its
        // way. settleAfter waits for the link to wake first, and bounds the wait so the
        // rung where nothing is emitted still terminates.
        await settleAfter(page, "rescope2");

        const trace = await traceOf(page);
        const at = markTime(trace, "rescope2")!;
        const firstSub = spans(trace).find(
          (s) => s.cmd === "vd_meters_subscribe" && s.start >= markTime(trace, "rescope1")!,
        );
        const phase = firstSub ? at - firstSub.start : Number.NaN;
        // Distance from the window's closing edge, measured rather than assumed: a
        // scripted 200 ms latency plus the driver's own round trips is not a 200 ms
        // window, and the ladder is only interpretable against the achieved value.
        const margin = firstSub ? phase - (firstSub.end - firstSub.start) : Number.NaN;
        const laterSub = spans(trace).some((s) => s.cmd === "vd_meters_subscribe" && s.start > at);
        const reg = await regOf(page);

        console.log(timeline(trace, { from: markTime(trace, "rescope1")! - 100 }));
        console.log(
          `intended D=${d} ms, achieved ${phase.toFixed(0)} ms into a registration spanning ${firstSub?.start.toFixed(0)}–${firstSub?.end.toFixed(0)} ms (${margin.toFixed(0)} ms past its edge)`,
        );
        console.log(`registered: ${reg.join(",")}`);
        console.log(
          `CH 2's new tap ${key(CH2_PREGATE)} registered: ${reg.includes(key(CH2_PREGATE))} (a later registration was issued: ${laterSub})`,
        );

        // The rung has to land clearly on one side of the closing edge, or the branch
        // below is skipped and the case asserts nothing: a gesture that slipped into
        // the dead zone fails here rather than passing vacuously.
        expect(Math.abs(margin)).toBeGreaterThan(30);
        // The first re-scope always lands — it was issued when nothing was pending.
        expect(reg).toContain(key(CH1_PREEQ));

        // Pinned behaviour (the defect this ladder exists to place): a re-scope that
        // arrives inside the registration await is dropped whole, and the device is
        // left streaming the previous strip's address for CH 2 while its badge says
        // otherwise. Only rungs that land clearly on one side of the closing edge are
        // asserted — the driver cannot place a click to within the 10 ms a rung at the
        // edge itself would need, so the achieved margin decides which claim applies.
        if (margin < -30) {
          expect(reg).not.toContain(key(CH2_PREGATE));
          expect(reg).toContain(key(CH2_POST)); // still the tap CH 2 no longer shows
          // …and the bar of the strip the operator just re-scoped is dead: the
          // broker sends nothing for an address it was not asked about, which is the
          // bridge refusing the frame rather than the driver declining to push it.
          expect(
            await pushMeters(page, [
              [...CH1_PREEQ, -153],
              [...CH2_PREGATE, -201],
            ]),
          ).toEqual(["", "unregistered"]);
          await expect(meterReadout(page, "CH 1")).toHaveText("-15.3");
          await expect(meterReadout(page, "CH 2")).toHaveText("—");

          // It self-heals only by accident: the next render for any reason recomputes
          // the signature, finds it different from subSig, and re-registers.
          await mark(page, "third-render");
          await tapBadge(page, "CH 3").click();
          await page.locator(".con-tappop .crow", { has: page.getByText("INPUT", { exact: true }) }).click();
          await expect(tapBadge(page, "CH 3")).toContainText("INPUT");
          await expect.poll(() => regOf(page)).toContain(key(CH2_PREGATE));
          await pushMetersDelivered(page, [[...CH2_PREGATE, -201]]);
          await expect(meterReadout(page, "CH 2")).toHaveText("-20.1");
        } else if (margin > 30) {
          expect(reg).toContain(key(CH2_PREGATE));
          expect(reg).not.toContain(key(CH2_POST));
        }
      });
    }

    // The same drop, placed by the barrier rather than by the clock: the first
    // re-scope's registration is held open, so the second gesture is inside it by
    // construction instead of by arithmetic on a scripted latency.
    test("a re-scope issued while the first registration is held is dropped whole", async ({ page }) => {
      await goLive(page);
      await consoleWithMeters(page);

      await blockAt(page, "vd_meters_subscribe", 1);
      await mark(page, "rescope1");
      await tapBadge(page, "CH 1").click();
      await page.locator(".con-tappop .crow", { has: page.getByText("PRE EQ", { exact: true }) }).click();
      await expect(tapBadge(page, "CH 1")).toContainText("PRE EQ");
      await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 15_000 });

      // Strictly inside the first registration's await: it cannot resolve until the
      // driver releases the gate.
      await tapBadge(page, "CH 2").click();
      await mark(page, "rescope2");
      await page.locator(".con-tappop .crow", { has: page.getByText("PRE GATE", { exact: true }) }).click();
      await expect(tapBadge(page, "CH 2")).toContainText("PRE GATE");

      await mark(page, "release");
      await releaseBarrier(page);
      await settleAfter(page, "release");

      const trace = await traceOf(page);
      const subs = subsAfter(trace, markTime(trace, "rescope1")!);
      const reg = await regOf(page);
      console.log(timeline(trace, { from: markTime(trace, "rescope1")! - 100 }));
      console.log(`registrations issued from rescope1 on: ${subs.length}; registered: ${reg.join(",")}`);

      // Pinned behaviour, and a defect: the second re-scope issues no registration of
      // its own (subPending short-circuits startMeters) and the resolve of the first
      // does not notice — subSig still names the signature it was issued with, so the
      // tail check compares equal and keeps it. The device is left streaming CH 2's
      // previous address while the badge says PRE GATE.
      expect(subs).toHaveLength(1);
      expect(reg).toContain(key(CH1_PREEQ));
      expect(reg).not.toContain(key(CH2_PREGATE));
      expect(reg).toContain(key(CH2_POST));
      // The bridge refuses CH 2's new address — the app is not merely failing to draw
      // a frame it received, it can never be sent one — while CH 1's lands.
      expect(
        await pushMeters(page, [
          [...CH1_PREEQ, -153],
          [...CH2_PREGATE, -201],
        ]),
      ).toEqual(["", "unregistered"]);
      await expect(meterReadout(page, "CH 1")).toHaveText("-15.3");
      await expect(meterReadout(page, "CH 2")).toHaveText("—");
    });

    // meter-tap-change-resubscribe. The only operator gesture that re-registers the
    // meter stream, and the one place carryMeterState's per-strip refusal is visible.
    test("a meter-point change re-registers and drops only that strip's meter state", async ({ page }) => {
      await goLive(page);
      await consoleWithMeters(page);
      await setLatency(page, { subscribe: 30 });

      await pushMetersDelivered(page, [
        [...CH1_POST, -153],
        [...CH2_POST, -201],
      ]);
      await expect(meterReadout(page, "CH 1")).toHaveText("-15.3");
      await expect(meterReadout(page, "CH 2")).toHaveText("-20.1");
      const base = await countersOf(page);

      await mark(page, "tap-change");
      await tapBadge(page, "CH 1").click();
      await page.locator(".con-tappop .crow", { has: page.getByText("PRE EQ", { exact: true }) }).click();
      await expect(tapBadge(page, "CH 1")).toContainText("PRE EQ");
      await expect.poll(() => regOf(page)).toContain(key(CH1_PREEQ));
      await waitQuiet(page);

      const end = await countersOf(page);
      const reg = await regOf(page);
      const trace = await traceOf(page);
      // No analyze() here either: a meter-point change writes no parameter and provokes
      // no notify, so the analyzer has nothing to decide. The counters, the address set
      // and the readouts are the check.
      console.log(timeline(trace, { from: markTime(trace, "tap-change")! - 100 }));
      console.log(
        `counters: subs ${base.meterSubs}→${end.meterSubs}, unsubs ${base.meterUnsubs}→${end.meterUnsubs}; registered ${reg.join(",")}`,
      );
      const [ch1Txt, ch2Txt] = [
        await meterReadout(page, "CH 1").textContent(),
        await meterReadout(page, "CH 2").textContent(),
      ];
      console.log(`readouts after the change: CH 1 ${ch1Txt}, CH 2 ${ch2Txt}`);

      // One tear-down, one re-registration, and the address set follows the badge.
      expect(end.meterUnsubs - base.meterUnsubs).toBe(1);
      expect(end.meterSubs - base.meterSubs).toBe(1);
      expect(reg).toContain(key(CH1_PREEQ));
      expect(reg).not.toContain(key(CH1_POST)); // only CH 1 metered it
      expect(reg).toContain(key(CH2_POST)); // every other strip is untouched

      // carryMeterState refuses to carry ballistics across a changed tap, so CH 1 is
      // back to "not reported yet" — which prints "—", not a floor value it never
      // measured — while every other strip keeps the reading it already had. One
      // strip's re-scope must not blank the rack.
      await expect(meterReadout(page, "CH 1")).toHaveText("—");
      await expect(meterReadout(page, "CH 2")).toHaveText("-20.1");

      // The gap ends when the new address reports.
      await pushMetersDelivered(page, [[...CH1_PREEQ, -99]]);
      await expect(meterReadout(page, "CH 1")).toHaveText("-9.9");
    });

    // meter-tap-change-resubscribe, the "while the screen holds the slot" half.
    test("a console tap change behind an open screen does not steal the slot back", async ({ page }) => {
      await goLive(page);
      await consoleWithMeters(page);
      await setLatency(page, { subscribe: 30 });
      await openFromConsole(page, 0);
      await expect.poll(() => meterAddrsOf(page)).toEqual(GATE_TAPS);
      const base = await countersOf(page);

      // The scrim owns the pointer, so the gesture is dispatched onto the controls
      // directly. It still runs the same handlers, and a full console render with it.
      await mark(page, "tap-change-behind-modal");
      await tapBadge(page, "CH 2").dispatchEvent("click");
      await page
        .locator(".con-tappop .crow", { has: page.getByText("PRE GATE", { exact: true }) })
        .dispatchEvent("click");
      await expect(tapBadge(page, "CH 2")).toContainText("PRE GATE");
      // The verdict is an absence — the render this gesture ran cost no broker traffic —
      // and waitQuiet answers "silent" straight after a gesture whether or not a
      // registration is on its way. settleAfter waits for a wake-up first, bounded.
      await settleAfter(page, "tap-change-behind-modal");

      const end = await countersOf(page);
      const trace = await traceOf(page);
      console.log(timeline(trace, { from: markTime(trace, "tap-change-behind-modal")! - 100 }));
      console.log(
        `counters: subs ${base.meterSubs}→${end.meterSubs}, unsubs ${base.meterUnsubs}→${end.meterUnsubs}; registered ${(await regOf(page)).join(",")}`,
      );

      // metersLent short-circuits startMeters, so the render that the tap change ran
      // costs no broker traffic at all and the screen keeps its three lanes.
      expect(await meterAddrsOf(page)).toEqual(GATE_TAPS);
      expect(end.meterSubs).toBe(base.meterSubs);
      expect(end.meterUnsubs).toBe(base.meterUnsubs);
      await pushMetersDelivered(page, [[107, 0, -239]]);
      await expect(dynReadout(page, "Gate GR")).toHaveText("-23.9");

      // The re-scope is not lost, only deferred: closing the screen hands the slot
      // back and the console registers the set its badges now claim.
      await dynBox(page).locator(".consent-btn-primary").click();
      await expect(dynBox(page)).toBeHidden();
      await expect.poll(() => regOf(page)).toContain(key(CH2_PREGATE));
    });

    // meter-error-ends-session, run A. Bars stuck on the floor look exactly like
    // silence, so a registration that cannot be established has to end the session
    // rather than leave a live mixer showing nothing.
    test("a refused meter registration ends the session instead of leaving floored bars", async ({ page }) => {
      await goLive(page);
      await consoleWithMeters(page);
      await setLatency(page, { subscribe: 30 });
      await pushMetersDelivered(page, [[...CH1_POST, -153]]);
      await expect(meterReadout(page, "CH 1")).toHaveText("-15.3");

      await refuseAt(page, "vd_meters_subscribe", 1);
      await mark(page, "tap-change");
      await tapBadge(page, "CH 1").click();
      await page.locator(".con-tappop .crow", { has: page.getByText("PRE EQ", { exact: true }) }).click();
      await expect(page.locator('#btn-live[aria-pressed="false"]')).toBeAttached();
      await mark(page, "session-ended");
      // Invariant 16's verdict is an absence, so the settle has to wait for the link to
      // wake after the mark (the teardown's own traffic) before believing the silence.
      await settleAfter(page, "session-ended");

      const dialogs = await dialogsOf(page);
      const trace = await traceOf(page);
      const findings = analyze(trace, {
        registration: await paramAddrsOf(page),
        quiesceAfter: "session-ended",
      });
      console.log(timeline(trace, { from: markTime(trace, "tap-change")! - 100 }));
      console.log(report("refused meter registration", findings));
      console.log(`dialogs: ${dialogs.join(" | ")}`);

      // The failure is reported once, as a live error, and the teardown drops the
      // bars to "—" (not to a floor value they never measured).
      expect(dialogs).toHaveLength(1);
      await expect(meterReadout(page, "CH 1")).toHaveText("—");

      // Teardown quiescence, measured as the refusal it is: the tear-down's
      // vd_meters_unsubscribe drops the channel in the bridge (vd.rs sets
      // meter_ch = None), so a frame arriving after the session ended is refused at the
      // boundary and no callback in the app is reached at all — neither the console's
      // nor the superseded one the generation stamp exists to catch. That second line
      // of defence is therefore not observable from here; what is observable is that
      // the first one holds, and that the bars stay at "—" rather than at a floor
      // value they never measured.
      const late = await pushMeters(page, [
        [...CH1_PREEQ, -100],
        [...CH1_POST, -100],
      ]);
      await page.waitForTimeout(400);
      console.log(`late frames: ${late.map((w, i) => `${["111:0", "115:0"][i]} ${w || "delivered"}`).join(", ")}`);
      expect(late).toEqual(["no-subscription", "no-subscription"]);
      expect((await meterDropsOf(page)).map((e) => `${e.addr} ${e.detail}`)).toEqual([
        "111:0 no-subscription",
        "115:0 no-subscription",
      ]);
      await expect(meterReadout(page, "CH 1")).toHaveText("—");
      expect(findings).toHaveLength(0);
    });

    // meter-error-ends-session, run C. The failure lands while the tuning screen
    // holds the slot, so the console is sitting on metersLent = true when the session
    // dies — and nothing in the teardown path clears it.
    test("a registration refused while the screen holds the slot does not strand the console", async ({ page }) => {
      await goLive(page);
      await consoleWithMeters(page);
      await openFromConsole(page, 0);
      await expect.poll(() => meterAddrsOf(page)).toEqual(GATE_TAPS);

      // Fail the registration the screen makes when the session comes back up.
      await refuseAt(page, "vd_meters_subscribe", 1);
      await mark(page, "live-off");
      await page.locator("#btn-live").dispatchEvent("click");
      await expect(page.locator('#btn-live[aria-pressed="false"]')).toBeAttached();
      await mark(page, "live-on");
      await page.locator("#btn-live").dispatchEvent("click");
      // Up, then straight back down. The "on" state is too short-lived to poll for,
      // so the session's return is read from the link (a second connect) and its
      // collapse from the error dialog — which stopLiveOnError only raises for a
      // session that was actually up.
      await expect.poll(() => dialogsOf(page)).toHaveLength(1);
      await expect(page.locator('#btn-live[aria-pressed="false"]')).toBeAttached();
      await waitQuiet(page);

      const midTrace = await traceOf(page);
      console.log(timeline(midTrace, { from: markTime(midTrace, "live-off")! - 100 }));
      console.log(`dialogs: ${(await dialogsOf(page)).join(" | ")}`);
      expect((await countersOf(page)).connects).toBe(2);

      // Closing the screen hands the slot back even though there is no session to
      // stream on, and the next session must find the console able to register again
      // — a metersLent left latched would leave the whole rack dark for good.
      await dynBox(page).locator(".consent-btn-primary").click();
      await expect(dynBox(page)).toBeHidden();
      await mark(page, "relive");
      await goLive(page);
      await expect.poll(() => regOf(page)).toContain(key(CH1_POST));
      await pushMetersDelivered(page, [[...CH1_POST, -175]]);
      await expect(meterReadout(page, "CH 1")).toHaveText("-17.5");

      // No analyze() on this run either — no write, no notify, no quiesce mark, so it
      // could only ever report "clean". That the console can register and be fed again
      // on the third session is the claim, and the two lines above are what test it.
      console.log(`registration after the third session: ${(await regOf(page)).join(",")}`);
    });

    // meter-error-ends-session, run B — the silent half. A stream that simply stops
    // has no error to route, and this is the pin of what the app does about it.
    test("a stream that stops without an error leaves the bars frozen and nothing checks", async ({ page }) => {
      await goLive(page);
      await consoleWithMeters(page);
      await pushMetersDelivered(page, [
        [...CH1_POST, -153],
        [...CH2_POST, -201],
      ]);
      await expect(meterReadout(page, "CH 1")).toHaveText("-15.3");
      await waitQuiet(page);

      // The window is bounded by the settle, not by a sleep: settleAfter waits for the
      // link to wake after the mark and gives up after `grace`. A watchdog firing
      // anywhere in that window is a wake-up, so the observation ends early and
      // `during` is non-empty — which is what makes the assertions below able to fail.
      const WINDOW_MS = 4000;
      await mark(page, "feed-stops");
      await settleAfter(page, "feed-stops", 900, WINDOW_MS);
      await mark(page, "after-silence");

      const trace = await traceOf(page);
      const from = markTime(trace, "feed-stops")!;
      const observed = markTime(trace, "after-silence")! - from;
      const during = spans(trace).filter((s) => s.start > from && s.cmd.startsWith("vd_"));
      console.log(timeline(trace, { from: from - 100 }));
      console.log(`device commands in ${observed.toFixed(0)} ms without a frame: ${during.length}`);
      console.log(`readout after the silence: ${await meterReadout(page, "CH 1").textContent()}`);

      // Pinned behaviour, and the defect the case exists to state — as far as a window
      // this size can state it: for the whole of it the readout still shows the last
      // frame, the session is still reported as live, and nothing was sent to check.
      // A stopped stream is, over this window, indistinguishable from steady signal.
      // This bounds the observation; it does not prove no watchdog exists on a longer
      // period (there is none in core/meters.ts today, which is why the window is the
      // claim rather than the evidence).
      expect(observed).toBeGreaterThan(WINDOW_MS - 200); // the window really was observed
      await expect(meterReadout(page, "CH 1")).toHaveText("-15.3");
      await expect(meterReadout(page, "CH 2")).toHaveText("-20.1");
      await expect(page.locator('#btn-live[aria-pressed="true"]')).toBeAttached();
      expect(during).toHaveLength(0);
      expect(await dialogsOf(page)).toHaveLength(0);
    });
  });

  // meter-tap-change-resubscribe, model axis. tapsFor / tapFor / defaultTapKey take
  // an optional model id and silently fall back to the URX44 table without it, so an
  // unqualified resolution is only visible as wrong bars — never as a wrong address —
  // on the one model whose channel topology differs.
  test.describe("URX22", () => {
    test.beforeEach(async ({ page }) => {
      await installFake(page, { model: "URX22" });
      await page.goto("/");
      await expect(page.locator("#model-picker")).toHaveValue("URX22");
    });

    test("registers the URX22 tap table, not the URX44 one", async ({ page }) => {
      await goLive(page);
      await page.click("#btn-view-console");
      await expect(meterReadout(page, "CH 1")).toBeVisible();
      await expect.poll(() => regOf(page)).toContain(key(CH1_POST));
      await waitQuiet(page);

      const reg = await regOf(page);
      const trace = await traceOf(page);
      // No analyze(): bringing a session up issues no write and receives no notify, so
      // the analyzer could only report "clean". The address set is the whole claim.
      console.log(timeline(trace, { limit: 40 }));
      console.log(`registered: ${reg.join(",")}`);

      // On a URX22 the first stereo pair is CH 3/4, so its POST tap is the stereo
      // meter 120:0/120:1 — and the mono POSTs of channels 3 and 4, which only the
      // URX44 table has, must not appear. A resolution that fell back to the URX44
      // table would put 115:2 here and leave CH 3/4 with no meter at all.
      expect(reg).toContain("120:0");
      expect(reg).toContain("120:1");
      expect(reg).not.toContain("115:2");
      expect(reg).not.toContain("115:3");
      // …and the strip really is the one that carries them: a node the table does
      // not know has no meter-point selector.
      await expect(tapBadge(page, "CH 3/4")).toHaveCount(1);
      await expect(tapBadge(page, "CH 3/4")).toContainText("POST");

      await pushMetersDelivered(page, [
        [120, 0, -153],
        [120, 1, -201],
      ]);
      // A stereo strip's readout folds to the peak of L/R.
      await expect(meterReadout(page, "CH 3/4")).toHaveText("-15.3");
    });
  });
});
