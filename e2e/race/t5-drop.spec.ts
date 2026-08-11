import { test, expect, type Page } from "@playwright/test";
import {
  installFake,
  goLive,
  mark,
  pushNotify,
  pushNotifyDelivered,
  pushBulkChange,
  notifyDropsOf,
  traceOf,
  paramAddrsOf,
  snapshotOf,
  setLatency,
  blockAt,
  releaseBarrier,
  waitQuiet,
  settleAfter,
  linkDrop,
  setDeviceLost,
  divergeAt,
  dialogsOf,
  countersOf,
  refuseAt,
  setDialogAnswer,
  type TraceEvent,
} from "./fake-device";
import { analyze, report, timeline, markTime, spans, type Span } from "./analyze";
import { CH1_FADER, faderOf, faderReadout, openEqScreen } from "./ui";

// T5 drop — failure injection (docs/{en,ja}/live-race-harness.md).
//
// Every case here asks the same question from a different side: once the app has
// declared a session dead, what is still talking to the device, and what did the
// half-finished work leave behind in the plan? The windows are placed with the
// fake's BARRIER rather than wall-clock offsets — the send loop and the readback
// sweeps this tier interrupts are hundreds of commands long, and "the drop landed
// at command N" has to be exact for the escape count to be attributable to the loop
// position rather than to the drop.

const HPF_FREQ = 26; // scoped (non-direct) param: a notify on it needs a node read
const CH_FADER = 139; // direct param: a notify on it is applied with no read at all

// Groups a scoped reconcile of one MONO IN channel node reports applying ("← device
// (9)") — measured, and the unit the concentration runs below are counted in.
const GROUPS_PER_NODE = 9;

// planExternal parameters (src/core/control/params.ts): never emitted, never read
// back, and so never in the follow registration — the shape a notify the app has no
// index entry for actually has on this device.
const UNREGISTERED: Array<[number, number, number]> = [
  [758, 0, 0], // BRIGHTNESS
  [760, 0, 0], // AUTO_POWER_OFF
  [787, 0, 0], // DATE_FORMAT
  [795, 0, 0], // DEVICE_LANGUAGE
  [812, 0, 0], // USB_SUPPRESSION
];

// ch1's 4-band PEQ addresses: the band block starts 5 params after the EQ-ON anchor
// (44 → 49) with a 5-param stride, and only LOW/HIGH carry a filter type (translate.ts
// eqBandsFrom). These are exactly the addresses EQ 1-Knob ON removes from the write set
// while leaving them in the follow registration.
const EQ_BAND_ADDRS: string[] = (() => {
  const out: string[] = [];
  for (let i = 0; i < 4; i++) {
    const b = 49 + 5 * i;
    out.push(`${b}:0:0`);
    if (i === 0 || i === 3) out.push(`${b + 1}:0:0`);
    out.push(`${b + 2}:0:0`, `${b + 3}:0:0`, `${b + 4}:0:0`);
  }
  return out;
})();

/** The EQ tuning screen's 1-Knob ON/OFF pair, located from the level slider's id (the
 *  only stable anchor in that section) rather than by its localized label. */
const oneKnobFace = (page: Page, face: 0 | 1) =>
  page
    .locator("#dyn-screen-box .prefs-section", { has: page.locator("#dyn-oneknob-level") })
    .locator(".prefs-toggle button")
    .nth(face);
/**
 * Arm a multi-address diff in one flush window: dispatch a fader step onto the
 * first `n` console strips synchronously, so all of them land inside the same
 * 120 ms throttle and the flush that follows has a send loop long enough to
 * interrupt. Returns how many faders were actually stepped.
 */
const armMultiEdit = (page: Page, n: number): Promise<number> =>
  page.evaluate((count) => {
    const faders = [...document.querySelectorAll<HTMLElement>(".con-fader")].slice(0, count);
    for (const f of faders) {
      f.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    }
    return faders.length;
  }, n);

/** Nodes the graph is flagging as "not confirmed by the device" (the dashed frame
 *  and the "?" badge readback provenance paints — plan.unreadNodes, rendered). */
const unreadBadges = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll<SVGGElement>("#graph-host g.node")]
      .filter((g) => [...g.querySelectorAll("text")].some((tx) => tx.textContent === "?"))
      .map((g) => g.getAttribute("data-id") ?? ""),
  );

/** Undo/redo depth as the app itself reports it: the macOS Edit menu push is the
 *  one machine-readable signal the history emits (set_edit_menu_state, logged by
 *  the fake with `canUndo/canRedo` as its detail). */
const menuStates = (trace: TraceEvent[], from = 0): string[] =>
  trace
    .filter((e) => e.kind === "ipc-end" && e.cmd === "set_edit_menu_state" && e.t >= from)
    .map((e) => e.detail ?? "");

const readsIn = (all: Span[], from: number, to: number): Span[] =>
  all.filter((s) => s.cmd === "vd_get" && s.start >= from && s.start <= to);

/** The reads the FIRST reconcile after `since` costs: from that burst's earliest
 *  possible settle deadline (its first notify + RECONCILE_DEBOUNCE_MS) to the
 *  "← device (n)" the reconcile prints when it lands. Counting to the end of the run
 *  instead would fold in the 900 ms idle net, which is armed in every run and would
 *  hide the difference under test. */
function firstReconcileReads(trace: TraceEvent[], since = 0): { reads: number; from: number; to: number } {
  const first = trace.find((e) => e.kind === "notify" && e.addr && e.t >= since);
  const from = (first?.t ?? since) + 300;
  const landed = trace.find((e) => e.kind === "status" && e.t > from && /← device \(\d+\)/.test(e.detail ?? ""));
  const to = landed?.t ?? Number.POSITIVE_INFINITY;
  return { reads: readsIn(spans(trace), from, to).length, from, to };
}

test.describe("T5 drop", () => {
  test.beforeEach(async ({ page }) => {
    await installFake(page);
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  // drop-link-loss-mid-flush-ladder. The ladder rung is the position in the send
  // loop, expressed as the barrier's command index rather than as an offset in ms:
  // the loop runs at a scripted 60 ms per set, so "the drop landed at set N" is the
  // same statement, made exactly.
  //
  // Serial, and now only so the three rungs are read as one ladder in the log — each
  // rung carries its own verdict. Before the guard in LiveSync.flush() the claim was
  // cross-rung and genuinely needed the order (the remainder of the loop went out,
  // strictly fewer commands the later the drop landed, so the counts had to be compared
  // against each other). It is now the same claim at every position — nothing escapes —
  // which each rung states on its own. The rung positions are unchanged so the two
  // regimes stay comparable.
  const RUNGS = [
    ["early", 2],
    ["mid", 7],
    ["late", 12],
  ] as const;
  const escapedByRung = new Map<string, number>();

  test.describe.serial("link loss ladder", () => {
    for (const [rung, nth] of RUNGS) {
      test(`link loss at the ${rung} of a flush send loop: nothing after it goes out`, async ({ page }) => {
        await goLive(page);
        await page.click("#btn-view-console");
        await expect(faderReadout(page, "CH 1")).toBeVisible();
        await setLatency(page, { get: 25, set: 60 });
        const metersBefore = await countersOf(page);

        // Hold the send loop at command `nth`; the flush cannot get past it until the
        // link has already been declared dead.
        await blockAt(page, "vd_set", nth);
        await mark(page, "arm");
        const armed = await armMultiEdit(page, 20);
        expect(armed).toBeGreaterThanOrEqual(nth + 2);
        await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 20_000 });

        await mark(page, "link-drop");
        await linkDrop(page, "usb unplugged");
        // The teardown itself is synchronous but its IPC (unsubscribe, meter release,
        // disconnect) is issued in the same task; let it drain before the quiescence
        // mark, so what the mark measures is escape rather than teardown.
        await page.waitForTimeout(200);
        await mark(page, "teardown");
        await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "false");

        await releaseBarrier(page);
        await waitQuiet(page);

        const trace = await traceOf(page);
        const all = spans(trace);
        const dropAt = markTime(trace, "link-drop")!;
        const downAt = markTime(trace, "teardown")!;
        const sets = all.filter((s) => s.cmd === "vd_set");
        const beforeDrop = sets.filter((s) => s.start < dropAt);
        const escaped = sets.filter((s) => s.start > downAt);
        const lateReads = all.filter((s) => s.cmd === "vd_get" && s.start > downAt);
        const findings = analyze(trace, { quiesceAfter: "teardown" });
        const counters = await countersOf(page);
        escapedByRung.set(rung, escaped.length);

        console.log(timeline(trace, { from: markTime(trace, "arm")! - 100 }));
        console.log(report(`link loss at set #${nth}`, findings));
        console.log(
          `armed=${armed} sets=${sets.length} beforeDrop=${beforeDrop.length} ` +
            `escaped=${escaped.length} lateReads=${lateReads.length} dialogs=${(await dialogsOf(page)).length}`,
        );
        console.log(
          `meters: subs ${metersBefore.meterSubs}→${counters.meterSubs}, unsubs ` +
            `${metersBefore.meterUnsubs}→${counters.meterUnsubs}; param unsubs=${counters.unsubscribes}`,
        );

        // The barrier landed where the rung says it did: exactly `nth` commands were
        // issued before the drop. Without this the escape count below is a statement
        // about an unknown loop position.
        expect(beforeDrop).toHaveLength(nth);
        // The teardown is synchronous while the send loop is not, so the loop is sitting
        // in an await when the session ends. It now reads the session generation after
        // every await and returns: the command the barrier held completes (it was already
        // on the wire), and nothing after it is issued. The one still in flight is why
        // the boundary is the teardown mark rather than the drop mark.
        expect(escaped.length).toBe(0);
        expect(findings.some((f) => f.inv === 16)).toBe(false);

        // Nothing reads either: no timer (reflect / settle / idle / live debounce)
        // survives the teardown, and the meter stream is released.
        expect(lateReads).toHaveLength(0);
        expect(counters.meterSubs).toBe(counters.meterUnsubs);
        expect(counters.unsubscribes).toBeGreaterThanOrEqual(1);
        // One drop, one dialog: the teardown is idempotent (liveSessionUp gates it), so
        // the escaping writes' own failures could not stack a second report on top.
        expect(await dialogsOf(page)).toHaveLength(1);

        // The three rungs side by side. Logged, not asserted: each rung already states
        // its own zero above, and `expect(armed).toBeGreaterThanOrEqual(nth + 2)` at the
        // top already rules out the vacuous pass (a rung whose arming never reached past
        // the barrier would have nothing left to escape). Re-checking either here would
        // make one rung's verdict depend on its siblings' module state.
        if (rung === RUNGS.at(-1)![0]) {
          console.log(`ladder by rung: ${RUNGS.map(([r]) => `${r}=${escapedByRung.get(r)}`).join(", ")}`);
        }
      });
    }
  });

  // drop-link-loss-mid-reconcile, run A: a scoped reconcile of one node, cut in
  // half. The question is not whether the read fails — it is what the half that
  // succeeded does to the plan and to the undo stack on its way out.
  test("a scoped reconcile cut in half still reflects its partial read and resets the history", async ({ page }) => {
    await goLive(page);
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    await setLatency(page, { get: 8, set: 8 });

    // An operator edit first, so the run has an undo stack to lose. Waiting for the
    // flush keeps it out of the reconcile window under test.
    await mark(page, "edit");
    await faderOf(page, "CH 1").focus();
    await page.keyboard.press("ArrowUp");
    await waitQuiet(page, 400);
    const before = (await faderReadout(page, "CH 1").textContent())!;
    const undoBefore = menuStates(await traceOf(page)).at(-1);
    expect(undoBefore).toBe("true/false"); // the edit is undoable

    // The device holds a value the plan does not: −12.00 dB in broker centi-dB. The
    // channel body group reads the fader first, so a partial read that gets through
    // that group and dies later carries this into the plan.
    await divergeAt(page, CH1_FADER, -1200);

    await blockAt(page, "vd_get", 60);
    await mark(page, "notify");
    await pushNotify(page, [[HPF_FREQ, 0, 0, 40]]);
    await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 20_000 });

    await mark(page, "link-drop");
    await linkDrop(page, "usb unplugged");
    await setDeviceLost(page); // every command from here fails identically
    await page.waitForTimeout(200);
    await mark(page, "teardown");
    await releaseBarrier(page);
    await waitQuiet(page);

    const after = (await faderReadout(page, "CH 1").textContent())!;
    const trace = await traceOf(page);
    const all = spans(trace);
    const downAt = markTime(trace, "teardown")!;
    const lateReads = all.filter((s) => s.cmd === "vd_get" && s.start > downAt);
    const findings = analyze(trace, { quiesceAfter: "teardown" });
    const states = menuStates(trace, downAt);

    console.log(timeline(trace, { from: markTime(trace, "notify")! - 100 }));
    console.log(report("scoped reconcile cut in half", findings));
    console.log(`readout: before=${before} after=${after}; reads after teardown=${lateReads.length}`);
    console.log(`edit-menu state after teardown: ${states.join(" → ") || "(unchanged)"}`);

    // PINNED DEFECT. requestReflect() and followFull are set BEFORE
    // assertReadComplete throws, so the groups that did answer are reflected into the
    // views as if the pass had completed — the plan now holds the device's −12.0 dB
    // for the one node whose body group got through…
    expect(after).not.toBe(before);
    expect(after).toContain("-12");
    // …and reflectFollow's full branch runs planHistory.reset() and live.resync() on
    // a session that is already down, so the operator's undo stack is spent on a plan
    // that is part device state and part never-read.
    expect(states.at(-1)).toBe("false/false");
    // The reads that were still queued behind the barrier are issued after the
    // teardown too — the readback sweep has no active check inside its loop either.
    expect(lateReads.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.inv === 16)).toBe(true);
    // What escapes is only the TAIL of the interrupted sweep — the node read was ~68
    // reads long and the barrier held it at 60. A retry of the consumed notify would
    // re-issue that whole node read, and a fallback to the full sweep some 795; either
    // is an order away from the handful counted here. (Under the device-lost latch the
    // count is the only signal available: the fake stamps the same "device-lost" detail
    // on every command, so a retry cannot be told from the tail by its detail.)
    expect(lateReads.length).toBeLessThan(30);
  });

  // drop-link-loss-mid-reconcile, run B: the same cut through a FULL reconcile,
  // where the provenance marker (plan.unreadNodes) exists and can be checked against
  // what actually failed.
  test("a full reconcile cut in half marks the nodes it never read and reflects the rest", async ({ page }) => {
    await goLive(page);
    await setLatency(page, { get: 4, set: 8 });
    const unreadAtStart = await unreadBadges(page);
    expect(unreadAtStart).toHaveLength(0); // the session started from a complete read
    const nodeCount = await page.locator("#graph-host g.node").count();

    // One operator edit, so the run has an undo stack the reset can be seen to spend.
    // Made on the console and flushed before the window under test opens; the graph
    // is the visible view again by the time the reflect paints the provenance.
    await page.click("#btn-view-console");
    await faderOf(page, "CH 1").focus();
    await page.keyboard.press("ArrowUp");
    await waitQuiet(page, 400);
    await page.click("#btn-view-graph");
    expect(menuStates(await traceOf(page)).at(-1)).toBe("true/false");

    await blockAt(page, "vd_get", 200);
    await mark(page, "notify");
    // The sentinel resolves to no node, forcing the settle to a whole-device read
    // (follow.ts). An unregistered address cannot: the bridge refuses it.
    await pushBulkChange(page);
    await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 20_000 });

    await mark(page, "link-drop");
    await linkDrop(page, "usb unplugged");
    await setDeviceLost(page);
    await page.waitForTimeout(200);
    await mark(page, "teardown");
    await releaseBarrier(page);
    await waitQuiet(page);

    const unread = await unreadBadges(page);
    const trace = await traceOf(page);
    const all = spans(trace);
    const downAt = markTime(trace, "teardown")!;
    const findings = analyze(trace, { quiesceAfter: "teardown" });

    console.log(timeline(trace, { from: markTime(trace, "notify")! - 100 }));
    console.log(report("full reconcile cut in half", findings));
    console.log(`unread nodes after the cut: ${unread.length} of ${nodeCount} — ${unread.slice(0, 8).join(", ")}`);
    console.log(`reads after teardown: ${all.filter((s) => s.cmd === "vd_get" && s.start > downAt).length}`);

    // The half-read plan is reflected and the provenance is set from the partial
    // result, so the "?" badges appear on a plan the app has rebased against, and the
    // session that would have repaired it is gone.
    expect(unread.length).toBeGreaterThan(0);
    expect(unread.length).toBeLessThan(nodeCount); // some nodes WERE read and applied
    expect(findings.some((f) => f.inv === 16)).toBe(true);
    expect(await dialogsOf(page)).toHaveLength(1);
    // The operator's edit survives the cut. This cell used to pin the opposite — the
    // reflect reset the history unconditionally, so the last menu push after teardown
    // was "false/false" and the one entry went with a read that had authored nothing.
    // The reset is now conditional on the read having authored something: the nodes it
    // DID read agreed with the plan, and the nodes it never reached are marked rather
    // than written. So no push follows the teardown at all, and the state standing from
    // before the window is still the one on screen.
    expect(menuStates(trace, downAt)).toHaveLength(0);
    expect(menuStates(trace).at(-1)).toBe("true/false");
  });

  // drop-device-lost-latch. The one disconnection shape that never arrives as a link
  // event: the broker is still there, the unit is not, and every command fails with
  // the same reason. The app can only learn by attrition.
  test("a device-lost latch with no link event is learned only through a failed write", async ({ page }) => {
    await goLive(page);
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    await setLatency(page, { get: 25, set: 25 });

    // A drag in progress when the unit goes away: pointer capture, moves every 40 ms.
    const box = (await faderOf(page, "CH 1").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.7);
    await page.mouse.down();
    for (let i = 0; i < 4; i++) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height * (0.7 - i * 0.05));
      await page.waitForTimeout(40);
    }

    await mark(page, "latch");
    await setDeviceLost(page); // no vd_watch_link event — the point of the case
    // Keep dragging into the latch, then let go.
    for (let i = 4; i < 10; i++) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height * (0.7 - i * 0.05));
      await page.waitForTimeout(40);
    }
    await page.mouse.up();
    // Three more edits at 400 ms, well past the point the session should have ended.
    for (let i = 0; i < 3; i++) {
      await page.waitForTimeout(400);
      await faderOf(page, "CH 1").focus();
      await page.keyboard.press("ArrowUp");
    }
    await mark(page, "last-press");
    // settleAfter, not waitQuiet. Every verdict below this point is an ABSENCE (one
    // doomed write and no more, nothing re-subscribed), and by now the link has been
    // silent for the best part of a second — so waitQuiet returns on the spot, before
    // the last press's own 120 ms flush window has even closed, and a write emitted
    // inside it would land after the trace was read. settleAfter waits for the link to
    // wake after the mark first, and bounds that wait so a press that really emits
    // nothing still terminates.
    await settleAfter(page, "last-press");
    await mark(page, "settled");

    const midTrace = await traceOf(page);
    const latchAt = markTime(midTrace, "latch")!;
    const doomed = spans(midTrace).filter((s) => s.cmd.startsWith("vd_") && s.start > latchAt);
    const endedAt = doomed.find((s) => s.detail === "device-lost")?.end ?? Number.POSITIVE_INFINITY;

    // The live toggle is off and the meter stream is down, without any link event.
    // Counted from the trace rather than from the fake's counters: under the latch a
    // command never reaches the fake's bookkeeping, so the counters would report the
    // release as never attempted when in fact it was issued and rejected.
    await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "false");

    // A fetch attempted afterwards must fail at the connect, not half-run.
    await mark(page, "fetch");
    await page.click("#btn-device");
    await page.click("#btn-fetch");
    await waitQuiet(page, 600);

    const trace = await traceOf(page);
    const fetchAt = markTime(trace, "fetch")!;
    const duringFetch = spans(trace).filter((s) => s.cmd.startsWith("vd_") && s.start > fetchAt);
    const dialogs = await dialogsOf(page);

    console.log(timeline(trace, { from: latchAt - 200 }));
    console.log(
      `doomed commands after the latch: ${doomed.length} ` +
        `(${doomed.map((s) => s.cmd).join(", ")}); session ended at +${(endedAt - latchAt).toFixed(0)} ms;` +
        ` doomed vd_set issued at ${doomed
          .filter((s) => s.cmd === "vd_set")
          .map((s) => `+${(s.start - latchAt).toFixed(0)}→${(s.end - latchAt).toFixed(0)}`)
          .join(", ")} (flush window 120)`,
    );
    console.log(`fetch after the latch: ${duringFetch.map((s) => `${s.cmd}:${s.detail ?? "ok"}`).join(", ")}`);
    console.log(`dialogs: ${dialogs.length} — ${dialogs.join(" | ")}`);

    // PINNED. Without a link event the loss is detected by attrition, and the whole
    // cost of that is one write: the flush aborts on the first rejection and routes
    // straight into the same teardown a link drop takes. The drag that was in flight
    // therefore issues one doomed command, not the burst it could have.
    //
    // The count is only that claim if the teardown finished before the NEXT flush
    // window could open — otherwise a second write is the throttle doing its job, not
    // the abort failing to. Asserted first, so a slow renderer fails naming the slip
    // rather than as "the abort let a second write through". Measured latch → first
    // doomed write → session end: +79 → +105 ms at 1x and +138 → +163 at 12x CPU
    // throttling, i.e. the teardown itself costs ~25 ms and it is the drag's own
    // cadence that moves.
    const doomedSets = doomed.filter((s) => s.cmd === "vd_set");
    expect(endedAt - doomedSets[0].start).toBeLessThan(120);
    expect(doomedSets).toHaveLength(1);
    // (No assertion that every doomed command failed: after setDeviceLost the fake
    // stamps "device-lost" on every vd_ command by construction, so such a check would
    // be a property of the harness and could not fail.)
    expect(endedAt - latchAt).toBeLessThan(3000);
    // The edits made after the session ended reach nothing and raise nothing: no
    // second dialog stacks on the first, because the teardown is already done.
    expect(dialogs.filter((d) => d.includes("Live sync stopped"))).toHaveLength(1);
    // The meter stream was released with the session rather than left streaming into
    // a dead link (bars frozen at their last value would read as signal), and nothing
    // re-subscribed afterwards.
    expect(doomed.filter((s) => s.cmd === "vd_meters_unsubscribe")).toHaveLength(1);
    expect(doomed.filter((s) => s.cmd === "vd_meters_subscribe")).toHaveLength(0);
    // And the fetch fails at its pre-check: one connect, no reads, no half-applied plan.
    expect(duringFetch.filter((s) => s.cmd === "vd_get")).toHaveLength(0);
    expect(duringFetch.map((s) => s.cmd)).toEqual(["vd_connect"]);
  });

  // drop-write-reject-mid-send. Not a live session: the offline Write action, where a
  // failure has a retry offer behind it and the retry is supposed to be built from a
  // fresh diff rather than from the remains of the previous attempt.
  test("a write rejected mid-burst aborts there, and the retry re-diffs instead of resuming", async ({ page }) => {
    await setDialogAnswer(page, "Ok"); // agree to the write confirm and the retry offer
    await setLatency(page, { set: 5 });

    // Fetch first, so the plan equals the device and the diff is exactly what the
    // gesture below changes rather than the whole default plan.
    await page.click("#btn-device");
    await page.click("#btn-fetch");
    await waitQuiet(page, 600);
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    const armed = await armMultiEdit(page, 20);
    expect(armed).toBeGreaterThanOrEqual(10);

    // Reject the 7th command of the send burst with a transport error.
    await refuseAt(page, "vd_set", 7, "transport");
    await mark(page, "write");
    await page.click("#btn-device");
    await page.click("#btn-write");
    await waitQuiet(page, 1200);
    await mark(page, "retried");

    const trace = await traceOf(page);
    const all = spans(trace);
    const writeAt = markTime(trace, "write")!;
    // Split the two attempts at the rejected command's SEQUENCE number, not at a
    // wall-clock mark: the retry's whole re-diff (795 reads) resolves inside one task
    // at zero read latency, so the retry's first write lands ~4 ms after the failure —
    // sooner than any driver round trip could stamp a mark between them.
    const sets = all.filter((s) => s.cmd === "vd_set" && s.start > writeAt);
    const failedIdx = sets.findIndex((s) => s.detail === "transport");
    expect(failedIdx).toBeGreaterThanOrEqual(0);
    const attempt1 = sets.slice(0, failedIdx + 1);
    const attempt2 = sets.slice(failedIdx + 1);
    const landed = attempt1.filter((s) => s.detail === undefined).map((s) => s.addr!);
    const rediffReads = all.filter(
      (s) => s.cmd === "vd_get" && s.seq > sets[failedIdx].seq && s.seq < (attempt2[0]?.seq ?? Infinity),
    );
    const dialogs = await dialogsOf(page);

    console.log(timeline(trace, { from: writeAt - 50, limit: 60 }));
    console.log(
      `attempt 1: ${attempt1.length} sets, last one ${attempt1.at(-1)!.addr} rejected; ` +
        `re-diff reads before the retry's first write: ${rediffReads.length}; ` +
        `attempt 2: ${attempt2.length} sets, of which already landed: ` +
        `${attempt2.filter((s) => landed.includes(s.addr!)).length}; ` +
        `rejected address re-sent: ${attempt2.some((s) => s.addr === attempt1.at(-1)!.addr)}`,
    );
    console.log(`dialogs: ${dialogs.map((d) => d.slice(0, 48)).join(" | ")}`);

    // The standing device-link rule, confirmed: a failed command aborts the whole
    // operation. Six landed, the seventh was rejected, and the rest of the burst —
    // nearly two hundred commands — was never sent.
    expect(attempt1).toHaveLength(7);
    expect(landed).toHaveLength(6);
    expect(trace.some((e) => e.kind === "status" && (e.detail ?? "").includes("Write stopped after a failure"))).toBe(
      true,
    );
    // The retry was offered rather than reported as a breakdown…
    expect(dialogs.some((d) => d.includes("The write stopped after a failure"))).toBe(true);
    // …and it re-read the whole device and re-diffed rather than replaying the tail,
    // so not one of the six that already landed is written a second time.
    expect(rediffReads.length).toBeGreaterThan(500);
    expect(attempt2.filter((s) => landed.includes(s.addr!))).toHaveLength(0);
    expect(attempt2.length).toBeGreaterThan(100);
    // NOTE (harness, not app): the fake applies a vd_set at the queue point, before
    // the refusal check, so the value of the rejected 7th command is in its state map
    // even though the command failed. The retry therefore does not see that address as
    // differing and does not re-send it — printed above, deliberately not asserted,
    // because it is the fake's behaviour and not the app's.
  });

  // drop-unknown-address-notify-storm. Three arms over the same five-notify burst at
  // the same spacing: once on addresses that are registered but no longer RESOLVE
  // (arm 1), once on addresses that resolve (arm 2), once on addresses that were never
  // registered at all (arm 3).
  //
  // Arm 1 replaces what the case used to push. Its original stimulus was five
  // planExternal addresses, which the shipped bridge drops before the page sees them
  // (src-tauri/src/vd.rs Subs::absorb) — the measurement was of nothing. The reachable
  // version of "the app has no index entry for this address" is the DROPPED WINDOW: a
  // sideEffect edit's flush re-runs live.ts capture() (shrinking the index) but not
  // follow.ts subscribe() (which only runs at begin() and after a reconcile), so the
  // broker keeps delivering addresses live.lookup no longer resolves.
  test("five unresolvable notifies cost a whole-device read that five registered ones do not, and five unregistered ones cost nothing", async ({
    page,
  }) => {
    await goLive(page);
    await openEqScreen(page, "ch1");
    await setLatency(page, { get: 4, set: 8 });
    const registration = await paramAddrsOf(page);
    const regKeys = new Set(registration.map((a) => a.join(":")));

    // Arm 1 — open the dropped window. EQ 1-Knob ON is sideEffect "refetch": the flush
    // re-reads the owner node and re-captures, which drops the 18 band addresses from
    // the write set and so from live.ts's index. No reconcile runs, so the broker-side
    // registration still carries all 18.
    await mark(page, "oneknob-on");
    await oneKnobFace(page, 0).click();
    await settleAfter(page, "oneknob-on", 1200);
    const dropped = EQ_BAND_ADDRS.slice(0, 5);
    const snapshot = await snapshotOf(page);
    // The premise, both halves: still registered (so the notify is delivered), and out
    // of the write set (so nothing resolves it). The snapshot's keys ARE the write set —
    // capture() builds both from the same planToCommands pass.
    for (const a of dropped) expect(regKeys.has(a)).toBe(true);
    for (const a of dropped) expect(snapshot?.[a]).toBeUndefined();
    await page.keyboard.press("Escape");

    await mark(page, "storm-unresolvable");
    for (const a of dropped) {
      const [id, x, y] = a.split(":").map(Number);
      await pushNotifyDelivered(page, [[id, x, y, 300]]);
      await page.waitForTimeout(150);
    }
    await waitQuiet(page, 1500);
    await mark(page, "storm-done");

    const t1 = await traceOf(page);
    const stormAt = markTime(t1, "storm-unresolvable")!;
    const doneAt = markTime(t1, "storm-done")!;
    const unregReads = spans(t1).filter((s) => s.cmd === "vd_get" && s.start > stormAt);
    const unregFirst = firstReconcileReads(t1, stormAt);
    const unregWall = doneAt - stormAt;

    // Arm 2 — same burst, addresses that resolve. Three distinct node:name pairs, so
    // the MAX_CONCENTRATION escalation (measured on its own below) is not what is being
    // priced here: all five are direct params, which apply with no read at all.
    await mark(page, "storm-registered");
    const registered: Array<[number, number, number]> = [
      [CH_FADER, 0, 0],
      [CH_FADER, 0, 1],
      [CH_FADER, 0, 2],
      [CH_FADER, 0, 0],
      [CH_FADER, 0, 1],
    ];
    for (let i = 0; i < registered.length; i++) {
      expect(regKeys.has(registered[i].join(":"))).toBe(true);
      await pushNotifyDelivered(page, [[...registered[i], -1000 - i * 100]]);
      await page.waitForTimeout(150);
    }
    await mark(page, "registered-burst-end");
    // A direct-classified burst produces no IPC at all, so waitQuiet would return on
    // the previous phase's silence and end the run before the 900 ms idle net could
    // arm — sit out the idle deadline explicitly, then wait on the trace as usual.
    await page.waitForTimeout(1400);
    await waitQuiet(page, 1500);
    await mark(page, "registered-done");

    const t2 = await traceOf(page);
    const regAt = markTime(t2, "storm-registered")!;
    const burstEnd = markTime(t2, "registered-burst-end")!;
    const regDoneAt = markTime(t2, "registered-done")!;
    const regReads = spans(t2).filter((s) => s.cmd === "vd_get" && s.start > regAt);
    // The settle window's own cost: from the first notify's settle deadline to 50 ms
    // short of the idle net's (last notify + IDLE_FULL_MS), so the two are priced
    // apart rather than added into one number.
    const lastRegNotify = [...t2].reverse().find((e) => e.kind === "notify" && e.addr && e.t >= regAt)!.t;
    expect(lastRegNotify).toBeLessThan(burstEnd);
    const regSettleReads = readsIn(spans(t2), regAt + 300, lastRegNotify + 850);
    const regWall = regDoneAt - regAt;

    // Arm 3 — the five planExternal addresses, kept as a refusal probe. They are in no
    // write set, therefore in no registration, therefore the bridge never hands them to
    // the page. Not "expensive to follow": undeliverable.
    for (const a of UNREGISTERED) expect(regKeys.has(a.join(":"))).toBe(false);
    const dropsBefore = (await notifyDropsOf(page)).length;
    await mark(page, "storm-unregistered");
    const why: string[] = [];
    for (const addr of UNREGISTERED) {
      why.push(...(await pushNotify(page, [[...addr, 7]])));
      await page.waitForTimeout(150);
    }
    await settleAfter(page, "storm-unregistered", 1500);
    const t3 = await traceOf(page);
    const unregAt = markTime(t3, "storm-unregistered")!;
    const refusedReads = spans(t3).filter((s) => s.cmd === "vd_get" && s.start > unregAt);

    // No registrationWindow: that window exists to keep invariant 12 from pricing a
    // write against a registration snapshot taken at another instant, and this run
    // issues no write at all — only invariant 6 (which reads notifies, not writes) can
    // fire here.
    const findings = analyze(t3, { registration });
    console.log(timeline(t1, { from: stormAt - 100, limit: 60 }));
    console.log(report("notify storm", findings));
    console.log(
      `unresolvable: ${unregReads.length} reads over ${unregWall.toFixed(0)} ms ` +
        `(first reconcile alone: ${unregFirst.reads} reads)`,
    );
    console.log(
      `registered:   ${regReads.length} reads over ${regWall.toFixed(0)} ms ` +
        `(settle window alone: ${regSettleReads.length} reads)`,
    );
    console.log(`unregistered: refused as ${why.join("/")}, ${refusedReads.length} read(s)`);

    // Invariant 6's clause A: five stimuli the bridge refused. The count is unchanged
    // from when this case pushed the same five addresses expecting them to arrive, but
    // it now means the opposite — "the case measured nothing here" rather than
    // "registration lag observed".
    expect(findings.filter((f) => f.inv === 6)).toHaveLength(UNREGISTERED.length);
    expect(why).toEqual(UNREGISTERED.map(() => "unregistered"));
    expect((await notifyDropsOf(page)).length - dropsBefore).toBe(UNREGISTERED.length);
    expect(refusedReads).toEqual([]);

    // PINNED. Five notifies the app has no index entry for are classified unknown and
    // coalesce into ONE forced full reconcile — they do not multiply — but that one
    // costs a whole-device read, and the 900 ms idle net then charges a second.
    expect(unregFirst.reads).toBeGreaterThan(500);
    expect(unregReads.length).toBeGreaterThan(unregFirst.reads); // the idle net followed
    // The same burst on addresses that resolve is applied straight into the plan: its
    // settle window costs no read at all. What it does still cost is the idle net,
    // which is armed by every DELIVERED notify whatever its classification — so the
    // price of no longer resolving is exactly one extra whole-device sweep.
    expect(regSettleReads).toHaveLength(0);
    expect(regReads.length).toBeGreaterThan(500); // the idle net, and only the idle net
    expect(unregReads.length - regReads.length).toBeGreaterThan(400);
  });

  // drop-concentration-threshold. The only integer threshold in the follow layer,
  // straddled exactly, plus the run that proves it is per-window and not per-burst.
  for (const [label, count, spacing] of [
    ["A: 3 pairs in one window", 3, 60],
    ["B: 4 pairs in one window", 4, 60],
    ["C: 4 pairs, one window each", 4, 320],
  ] as const) {
    test(`concentration ${label}`, async ({ page }) => {
      await goLive(page);
      await setLatency(page, { get: 4, set: 8 });

      const registration = await paramAddrsOf(page);
      await mark(page, "burst");
      for (let i = 0; i < count; i++) {
        // HPF frequency on a different channel each time: a scoped param, so each
        // distinct node:name pair costs its own node read unless the window escalates.
        await pushNotify(page, [[HPF_FREQ, 0, i, 40]]);
        if (i < count - 1) await page.waitForTimeout(spacing);
      }
      await waitQuiet(page, 1500);
      await mark(page, "done");

      const trace = await traceOf(page);
      const burstAt = markTime(trace, "burst")!;
      const doneAt = markTime(trace, "done")!;
      const first = firstReconcileReads(trace, burstAt);
      const total = spans(trace).filter((s) => s.cmd === "vd_get" && s.start > burstAt);
      const findings = analyze(trace, { registration });
      // Every reconcile that landed, by the count it reported applying. A whole-device
      // sweep applies an order of magnitude more groups than a per-node one, so the
      // sequence says how many scoped passes ran before the idle net's full one.
      const landings = trace
        .filter((e) => e.kind === "status" && e.t > burstAt)
        .map((e) => Number(/← device \((\d+)\)/.exec(e.detail ?? "")?.[1] ?? NaN))
        .filter((n) => !Number.isNaN(n));
      const fullAt = landings.findIndex((n) => n >= 100);
      const scopedLandings = fullAt === -1 ? landings : landings.slice(0, fullAt);

      console.log(timeline(trace, { from: burstAt - 100, limit: 60 }));
      console.log(report(`concentration ${label}`, findings));
      console.log(
        `first reconcile: ${first.reads} reads (window ${first.from.toFixed(0)}–${first.to.toFixed(0)} ms); ` +
          `whole run: ${total.length} reads over ${(doneAt - burstAt).toFixed(0)} ms; ` +
          `reconciles landed (applied counts): ${landings.join(", ")}`,
      );

      // Every notify in the burst was DELIVERED: an address outside the registration
      // would have been refused by the bridge and traced as a drop, which is invariant
      // 6's clause A. Nothing was refused, so what follows is a statement about
      // concentration and not about a stimulus the app never received.
      expect(findings.filter((f) => f.inv === 6)).toHaveLength(0);
      // PINNED. MAX_CONCENTRATION is 3 distinct node:name pairs per settle window.
      // Three stay scoped and are read per node; a fourth in the SAME window tips the
      // whole window to a whole-device read — a cliff the operator cannot see and
      // cannot avoid, since the only difference is how fast the fourth knob was
      // turned. Run C is the same four pairs spaced past the settle: cheap scoped
      // passes, which is what makes the threshold per-window, not per-burst.
      // Every run then pays one whole-device read anyway, because armIdle is armed by
      // every notify and armSettle's reconcile does not disarm it.
      //
      // A scoped pass applies GROUPS_PER_NODE groups per mono channel node, so the
      // scoped landings SUM to one node read per distinct node — the stable figure.
      // How many passes that sum arrives in is not: a notify pushed while a reconcile
      // is in flight is carried into the next window, so run C lands its four nodes in
      // 2–4 passes from run to run (measured: 9,9,18 and 9,18,9).
      const scopedGroups = scopedLandings.reduce((a, b) => a + b, 0);
      if (label.startsWith("A")) {
        expect(first.reads).toBeLessThan(400);
        expect(scopedLandings).toHaveLength(1); // three nodes, one window, one scoped pass
        expect(scopedGroups).toBe(count * GROUPS_PER_NODE);
      } else if (label.startsWith("B")) {
        expect(first.reads).toBeGreaterThan(500);
        expect(scopedLandings).toHaveLength(0); // the very first reconcile is the full one
      } else {
        expect(first.reads).toBeLessThan(400);
        expect(scopedLandings.length).toBeGreaterThanOrEqual(2); // more than one window ran
        expect(scopedGroups).toBe(count * GROUPS_PER_NODE);
      }
      expect(landings.filter((n) => n >= 100).length).toBeGreaterThanOrEqual(1);
    });
  }

  // drop-missed-notify-idle-net. The device says nothing — the assumption every
  // other follow case inverts.
  test("a silent device change is not repaired by a scoped reconcile, only by the idle net", async ({ page }) => {
    await goLive(page);
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    await setLatency(page, { get: 4, set: 8 });

    const before = (await faderReadout(page, "CH 1").textContent())!;
    // The device now holds −12.00 dB on CH 1 and announces nothing.
    await mark(page, "silent-change");
    await divergeAt(page, CH1_FADER, -1200);
    // The verdict below is an ABSENCE, so the wait has to be one that would notice a
    // link waking up: settleAfter watches for an IPC issued after the mark and, if one
    // comes, waits for it to finish before the count is taken. A bare sleep would end
    // the window in the middle of a sweep it was supposed to be reporting.
    await settleAfter(page, "silent-change", 900, 1500);
    await mark(page, "silence-window-end");

    const quietTrace = await traceOf(page);
    const silentAt = markTime(quietTrace, "silent-change")!;
    const duringSilence = spans(quietTrace).filter((s) => s.cmd.startsWith("vd_") && s.start > silentAt);
    const stale = (await faderReadout(page, "CH 1").textContent())!;

    // One notify on an UNRELATED node — a registered, scoped param on CH 2, so its
    // settle reconciles that node only (an unregistered address would force a whole-
    // device read and repair CH 1 by accident, which is not what is being measured).
    await mark(page, "unrelated-notify");
    await pushNotify(page, [[HPF_FREQ, 0, 1, 40]]);
    await page.waitForSelector('#statusbar:text-matches("← device \\\\(\\\\d+\\\\)")', { timeout: 20_000 });
    await mark(page, "scoped-done");
    const afterScoped = (await faderReadout(page, "CH 1").textContent())!;

    await waitQuiet(page, 2000);
    await mark(page, "idle-done");
    const afterIdle = (await faderReadout(page, "CH 1").textContent())!;

    const trace = await traceOf(page);
    const all = spans(trace);
    const notifyAt = markTime(trace, "unrelated-notify")!;
    const scopedAt = markTime(trace, "scoped-done")!;
    const idleReads = all.filter((s) => s.cmd === "vd_get" && s.start > scopedAt);
    const scopedReads = all.filter((s) => s.cmd === "vd_get" && s.start > notifyAt && s.start <= scopedAt);
    const findings = analyze(trace, { registration: await paramAddrsOf(page) });

    console.log(timeline(trace, { from: silentAt - 100, limit: 80 }));
    console.log(report("missed notify / idle net", findings));
    console.log(
      `readout: before=${before} duringSilence=${stale} afterScoped=${afterScoped} afterIdle=${afterIdle}; ` +
        `commands during the 1.5 s silence=${duringSilence.length}, scoped reads=${scopedReads.length}, ` +
        `idle reads=${idleReads.length}`,
    );

    // PINNED. No notify means no timer at all: the safety net is armed BY the thing
    // it is meant to protect against, so 1.5 s of a diverged device costs nothing and
    // repairs nothing.
    expect(duringSilence).toHaveLength(0);
    expect(stale).toBe(before);
    // A scoped reconcile of another node does not look at CH 1 either…
    expect(afterScoped).toBe(before);
    expect(scopedReads.length).toBeLessThan(400);
    // …and only the 900 ms idle full sweep, which that unrelated notify happened to
    // arm, finally picks the divergence up. Nothing the operator did caused this: had
    // the device stayed quiet, the plan would still be claiming a value it does not hold.
    expect(afterIdle).not.toBe(before);
    expect(afterIdle).toContain("-12");
    // Exactly one whole-device sweep, not a re-arming loop: the idle net fires once
    // per quiet burst and does not schedule itself again with no further notify.
    expect(idleReads.length).toBeGreaterThan(500);
    expect(idleReads.length).toBeLessThan(1000);
    // NOTE. What the repaired value does on the NEXT flush is deliberately not claimed
    // here: this run makes no edit after goLive, so no flush ever runs and an absent
    // write says nothing about write-back. T8 is where that question is asked and
    // pinned, on a run that does provoke a flush.
  });
});
