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
  settleAfter,
  divergeAt,
  ignoreWrites,
  type TraceEvent,
} from "./fake-device";
import { analyze, report, timeline, markTime, setsOf, getsOf } from "./analyze";
import { graphNode, openEqScreen, strip } from "./ui";

// T2 shape-change — the parameters that reshape the WRITABLE ADDRESS SET rather
// than a value inside it (docs/{en,ja}/live-race-harness.md).
//
// The observable that makes this tier decidable with no probe into the app is the
// `addrs` argument of vd_params_subscribe: it IS the follow registration set, so
// "the four EQ bands left the set" is a measurement, not an inference. The second
// observable is the whole-device readback — 766:0:0 (sample rate) is read by a FULL
// readback and by nothing else (readback.ts guards it with `only === undefined`), so
// counting reads of that one address counts full reconciles exactly.
//
// Every case ends on the link's own silence (`settleAfter`), never on a fixed sleep: a
// sleep reports a false lost edit for a sweep that had simply not finished, and several
// of these cases deliberately provoke multi-second whole-device sweeps. `settleAfter`
// rather than `waitQuiet`, because silence is also true *before* anything has started —
// a flush is still inside its 120 ms window at the instant of the gesture.
//
// The catalog's read latencies (8-25 ms) are cut to 2 ms throughout. A whole-device
// readback is ~800 sequential reads and most cases here provoke two of them, so the
// catalog figure would put a single test over the harness timeout. Nothing asserted
// below is a timing verdict — every assertion is about which IPC happened, in what
// order, and against which registered address set.

/** Read by a full device readback only — applyNodeState skips it by design, so a
 *  read of this address is one whole-device reconcile. */
const RATE_ADDR = "766:0:0";

const CH1_EQ_ON = "44:0:0";
const CH1_COMP_ON = "34:0:0";
const CH1_SSMCS_COMP_ON = "94:0:0";
const CH1_SSMCS_EQ_ON = "106:0:0";
const CH1_COMP_EQ_TYPE = "21:0:0";
const CH1_INSERT_FX = "135:0:0";
const CH1_INSERT_FX_ON = "134:0:0";
const SD_TRACK_COUNT = "839:0:0";
/** ch1 → FX 1 send: tap 193 (read-only on the device), level 194, on 196. There is
 *  no pan — an FX send is mono (translate.ts sendControl). */
const CH1_FX1_TAP = "193:0:0";
const CH1_FX1_LEVEL = "194:0:0";
const CH1_FX1_ON = "196:0:0";

/** ch1's 4-band PEQ addresses in COMP->EQ mode: the band block starts 5 params after
 *  the EQ-ON anchor (44 → 49) with a 5-param stride, and only LOW/HIGH carry a filter
 *  type (translate.ts eqBandsFrom). These are exactly the addresses EQ 1-Knob ON
 *  removes from the write set. */
function ch1EqBandAddrs(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 4; i++) {
    const b = 49 + 5 * i;
    out.push(`${b}:0:0`); // on
    if (i === 0 || i === 3) out.push(`${b + 1}:0:0`); // type (LOW / HIGH only)
    out.push(`${b + 2}:0:0`, `${b + 3}:0:0`, `${b + 4}:0:0`); // q / freq / gain
  }
  return out;
}

const regKeys = (addrs: Array<[number, number, number]>): Set<string> => new Set(addrs.map((a) => a.join(":")));

/** Whole-device reconciles that began after `at` (see RATE_ADDR). */
const fullReadsAfter = (trace: TraceEvent[], at: number): number =>
  getsOf(trace).filter((g) => g.addr === RATE_ADDR && g.start > at).length;

const setsAfter = (trace: TraceEvent[], addr: string, at: number): number[] =>
  setsOf(trace)
    .filter((s) => s.addr === addr && s.start > at)
    .map((s) => s.value ?? Number.NaN);

const param = (page: Page, label: string) => page.locator("#inspector .param", { hasText: label });
/** A .param whose label is EXACTLY `label` — "Insert FX" must not match "Insert FX ON". */
const paramExact = (page: Page, label: string) =>
  page.locator("#inspector .param", { has: page.getByText(label, { exact: true }) });

/** The EQ tuning screen's 1-Knob ON/OFF pair, located from the level slider's id (the
 *  only stable anchor in that section) rather than by its localized label. */
const oneKnobFace = (page: Page, face: 0 | 1) =>
  page
    .locator("#dyn-screen-box .prefs-section", { has: page.locator("#dyn-oneknob-level") })
    .locator(".prefs-toggle button")
    .nth(face);
test.describe("T2 shape-change", () => {
  test.beforeEach(async ({ page }) => {
    await installFake(page);
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  // shape-eq-oneknob-registration-blindspot. The whole case in one run: the boolean
  // that makes the device recompute the four bands is the same boolean that removes
  // those bands' addresses from the app's write set — so the device's own answer is
  // announced to an address nobody is listening on.
  test("EQ 1-Knob blinds the app to the bands it just made the device recompute", async ({ page }) => {
    await goLive(page);
    await openEqScreen(page, "ch1");
    await setLatency(page, { get: 2, set: 25 });
    const bands = ch1EqBandAddrs();
    const BAND0_GAIN = "53:0:0";
    /** EQ 1-Knob level — 2 params past the ON anchor's pair (translate.ts eqOneKnobFrom),
     *  and the one EQ address that STAYS in the write set while 1-Knob is on. */
    const ONE_KNOB_LEVEL = "48:0:0";
    // "The device recomputed the LOW band to +3.0 dB": a read of that address answers
    // 300 whatever the app wrote, so a value reaching the plan proves a READ carried it.
    await divergeAt(page, BAND0_GAIN, 300);

    const regBefore = regKeys(await paramAddrsOf(page));
    expect(bands.every((a) => regBefore.has(a))).toBe(true);

    // Phase 1 — 1-Knob ON. The write is sideEffect "refetch", so the flush re-reads
    // the owner node; no reconcile is involved.
    await mark(page, "oneknob-on-1");
    await oneKnobFace(page, 0).click();
    await settleAfter(page, "oneknob-on-1", 1200);

    let trace = await traceOf(page);
    const on1 = markTime(trace, "oneknob-on-1")!;
    const regAfterOn = regKeys(await paramAddrsOf(page));

    // The repair was the scoped refetch, not a reconcile: the band addresses were
    // re-read, and 766 (full-read only) was not.
    expect(getsOf(trace).filter((g) => g.addr === BAND0_GAIN && g.start > on1).length).toBeGreaterThan(0);
    expect(fullReadsAfter(trace, on1)).toBe(0);
    // …and the registration did not move. DeviceFollow re-registers at begin() and
    // after a reconcile only, so a flush that reshapes the write set leaves the broker
    // registered for addresses the app no longer tracks. Pinned as current behaviour:
    // this is the design's "registration lag" (invariant 6), observed not verified.
    expect([...regAfterOn].sort()).toEqual([...regBefore].sort());

    // Phase 2 — 1-Knob OFF. The bands re-enter the write set and are all emitted,
    // because the snapshot taken while 1-Knob was on holds no entry for them. The
    // value that goes out for the LOW band gain is the device's own 300, which only
    // the refetch of phase 1 could have put into the plan.
    await mark(page, "oneknob-off");
    await oneKnobFace(page, 1).click();
    await settleAfter(page, "oneknob-off", 1200);
    trace = await traceOf(page);
    const offAt = markTime(trace, "oneknob-off")!;
    expect(setsAfter(trace, BAND0_GAIN, offAt)).toContain(300);

    // Phase 3 — 1-Knob ON again, then the differential that decides the blind spot.
    await mark(page, "oneknob-on-2");
    await oneKnobFace(page, 0).click();
    await settleAfter(page, "oneknob-on-2", 1200);

    // Phase 3a — ONE notify on a band address the ON flush just dropped from the write
    // set. A single notify touches one logical control, so MAX_CONCENTRATION (> 3
    // distinct node:name pairs in a settle window, follow.ts) is not in play: the only
    // thing that can escalate this to a whole-device read is live.lookup failing to
    // resolve the address. The broker still has it registered — phase 1 measured that —
    // so the notify does arrive; the app is deaf to it, not unaware of it.
    const regBeforeProbe = regKeys(await paramAddrsOf(page));
    expect(regBeforeProbe.has(BAND0_GAIN)).toBe(true);
    await mark(page, "probe-dropped");
    await pushNotify(page, [[53, 0, 0, 300]]);
    await settleAfter(page, "probe-dropped", 1800);
    trace = await traceOf(page);
    const droppedAt = markTime(trace, "probe-dropped")!;
    const droppedCost = fullReadsAfter(trace, droppedAt);
    const regAfterProbe = regKeys(await paramAddrsOf(page));
    const stillRegistered = bands.filter((a) => regAfterProbe.has(a));

    // Phase 3b — the control: ONE notify, same shape, same node, on an address that is
    // still in the write set while 1-Knob is ON (EQ_ONE_KNOB_LEVEL, 48). Both probes
    // touch exactly one logical control, so neither can hit the concentration cliff;
    // what differs is whether live.lookup resolves the address. (Probe A's reconcile
    // ran in between, so the registration is 18 addresses smaller here — that changes
    // which notifies the broker would deliver, not what the app does with this one.)
    expect(regAfterProbe.has(ONE_KNOB_LEVEL)).toBe(true);
    await mark(page, "probe-registered");
    await pushNotify(page, [[48, 0, 0, 60]]);
    await settleAfter(page, "probe-registered", 1800);
    trace = await traceOf(page);
    const keptAt = markTime(trace, "probe-registered")!;
    const keptCost = fullReadsAfter(trace, keptAt);

    console.log(timeline(trace, { from: on1 - 50 }));
    console.log(
      `registration: ${regBefore.size} before → ${regAfterOn.size} after the ON flush` +
        ` → ${regAfterProbe.size} after the first reconcile`,
    );
    console.log(`band addresses: ${bands.length} total, ${stillRegistered.length} still registered`);
    console.log(`one notify on a DROPPED band address (53): ${droppedCost} full reconcile(s)`);
    console.log(`one notify on a KEPT address (48, 1-Knob level): ${keptCost} full reconcile(s)`);

    // The differential. The dropped address resolves to nothing, so the settle window
    // escalates to a whole-device read and the idle net (armed by the same notify, and
    // not cancelled by the settle) runs a second one behind it. The kept address
    // resolves to ch1 and takes a scoped read, so only the idle net's sweep is left.
    expect(droppedCost).toBe(2);
    expect(keptCost).toBe(1);
    // Only once a reconcile has run does the registration follow the write set — and
    // then all 18 band addresses are gone from it.
    expect(stillRegistered).toEqual([]);
    expect(regBefore.size - regAfterProbe.size).toBe(bands.length);

    // Phase 3c — the same recomputation announced the way the device actually announces
    // it, as a four-address burst. The cost is measured, but it is OVER-DETERMINED and
    // therefore no evidence about the blind spot: four distinct controls on one node
    // exceed MAX_CONCENTRATION, so a full sweep would be forced even if every one of
    // those addresses still resolved. Phase 3a/3b is what decides that question.
    //
    // The dropped window has to be re-opened first. Phase 3a's own escalation ended in
    // a reconcile, and follow.ts re-registers after one, so the bands are out of the
    // registration by now — the bridge would refuse this burst outright (see
    // fake-device.ts). OFF puts the bands back into the write set, the sentinel forces a
    // reconcile that re-registers them, and ON drops them from live.ts's index only:
    // capture() runs on the refetch, follow.subscribe() does not. That is the genuine
    // shape of the window, and it costs one extra whole-device sweep to reach.
    await oneKnobFace(page, 1).click();
    await mark(page, "reopen-window");
    await pushBulkChange(page);
    await settleAfter(page, "reopen-window", 1800);
    await mark(page, "reopen-on");
    await oneKnobFace(page, 0).click();
    await settleAfter(page, "reopen-on", 1200);
    const regAtBurst = await paramAddrsOf(page);
    const regBeforeBurst = regKeys(regAtBurst);
    const burstAddrs = ["53:0:0", "52:0:0", "58:0:0", "57:0:0"];
    expect(burstAddrs.filter((a) => regBeforeBurst.has(a))).toEqual(burstAddrs);

    await mark(page, "band-burst");
    await pushNotifyDelivered(page, [
      [53, 0, 0, 310],
      [52, 0, 0, 240],
      [58, 0, 0, -150],
      [57, 0, 0, 900],
    ]);
    // Long quiet: the settle (300 ms) and the idle net (900 ms) both fire, and each
    // whole-device sweep runs for seconds.
    await settleAfter(page, "band-burst", 1800);

    trace = await traceOf(page);
    const burstAt = markTime(trace, "band-burst")!;
    const reconciles = fullReadsAfter(trace, burstAt);
    console.log(`full reconciles caused by the 4-notify burst: ${reconciles}`);
    expect(reconciles).toBe(2);

    // Invariants 6 and 12 over the burst window only. The registration is a snapshot of
    // one instant; run against the whole trace it counts writes that were perfectly well
    // registered when they were sent (every phase before this one wrote a different
    // address set), so the number would be an artefact of comparing a full-run write
    // set against a final-state registration. The snapshot handed over is the one taken
    // BEFORE the burst, for the same reason: the two reconciles the burst provoked have
    // re-registered since, without the 18 band addresses (1-Knob is on), so an
    // end-of-window snapshot describes a set none of these notifies was pushed against.
    // No `snapshot` for the same reason, and one of its own: clause B is a state
    // predicate and its two halves must be read at ONE instant, so pairing the
    // pre-burst registration with a live snapshot read now would answer for neither.
    // At burstAt 1-Knob is ON — the case asserts just above that the four band
    // addresses ARE still registered — so the emitted set is the reduced one and the
    // difference clause B reports would be empty anyway. Phase 4 is the direction that
    // has something to say.
    console.log(
      report(
        "eq 1-knob registration blindspot",
        analyze(trace, { registration: regAtBurst, registrationWindow: { from: burstAt } }),
      ),
    );

    // Phase 4 — the mirror image, and invariant 6 clause B's firing case. 1-Knob OFF
    // puts the bands back into the write set, and the app writes all 18 of them to
    // addresses it is no longer registered for: a device-side change to any of them is
    // unfollowable until something reconciles. Nothing reconciles here — a refetch
    // re-captures the live snapshot but never re-subscribes — so the window is open at
    // the instant the pair below is read, which is what makes this the one case that
    // can prove the clause is not an assertion that can only pass.
    await mark(page, "oneknob-off-2");
    await oneKnobFace(page, 1).click();
    await settleAfter(page, "oneknob-off-2", 1200);
    trace = await traceOf(page);
    const off2 = markTime(trace, "oneknob-off-2")!;
    // Both halves at one instant: the registration and the emitted set (the live
    // snapshot's key set) as they stand together.
    const regAddrsNow = await paramAddrsOf(page);
    const snapNow = await snapshotOf(page);
    const regNow = regKeys(regAddrsNow);
    const written = new Set(
      setsOf(trace)
        .filter((s) => s.start > off2)
        .map((s) => s.addr!),
    );
    const orphans = bands.filter((a) => written.has(a) && !regNow.has(a));
    console.log(`after 1-Knob OFF: ${orphans.length} band address(es) written but not registered`);
    expect(orphans.length).toBe(bands.length);

    // The same fact decided by the analyzer rather than by hand, so the pin and the
    // clause cannot disagree about it. Only clause B is asserted: clauses A and C are
    // scanned over the whole trace here, which spans three earlier phases pushed
    // against registrations this one does not describe.
    const grown = analyze(trace, { registration: regAddrsNow, snapshot: snapNow }).filter(
      (f) => f.inv === 6 && f.name === "grown window",
    );
    console.log(report("eq 1-knob grown window", grown));
    expect(grown).toHaveLength(1);
    // Exactly the bands, and nothing else: the refetch's re-capture rebuilt the emitted
    // set around them while the registration stayed where the last reconcile left it.
    expect(grown[0].detail).toContain(`${bands.length} address(es)`);
    const grownAddrs = new Set(Object.keys(snapNow ?? {}).filter((a) => !regNow.has(a)));
    expect([...grownAddrs].sort()).toEqual([...bands].sort());
  });

  // shape-comp-eq-type-bank-swap. The single widest shape change in the catalog: the
  // switch changes address IDENTITY (34/44 → 94/106) and value POLARITY (1 = on →
  // 0 = on) at the same time, so a misidentification writes the exact opposite state.
  test("COMP/EQ type swaps the channel-strip bank, its polarity and its address set", async ({ page }) => {
    await goLive(page);
    await graphNode(page, "ch1").click();
    await setLatency(page, { get: 2, set: 25 });

    const typeSel = param(page, "COMP/EQ Type").locator("select");
    await expect(typeSel).toHaveValue("0"); // COMP->EQ
    const regBefore = regKeys(await paramAddrsOf(page));
    expect(regBefore.has(CH1_COMP_ON)).toBe(true);
    expect(regBefore.has(CH1_EQ_ON)).toBe(true);
    expect(regBefore.has(CH1_SSMCS_COMP_ON)).toBe(false);

    await mark(page, "to-ssmcs");
    await typeSel.selectOption("1"); // SSMCS
    await expect(param(page, "Sweet Spot Data")).toHaveCount(1);
    await settleAfter(page, "to-ssmcs", 1800);

    let trace = await traceOf(page);
    const at = markTime(trace, "to-ssmcs")!;
    const emitted = setsOf(trace).filter((s) => s.start > at);
    const byAddr = new Map(emitted.map((s) => [s.addr!, s.value]));

    console.log(timeline(trace, { from: at - 50 }));
    console.log(
      `bank swap emitted: type=${byAddr.get(CH1_COMP_EQ_TYPE)} ssmcsComp(94)=${byAddr.get(
        CH1_SSMCS_COMP_ON,
      )} ssmcsEq(106)=${byAddr.get(CH1_SSMCS_EQ_ON)} oldComp(34)=${byAddr.get(CH1_COMP_ON)}`,
    );

    // The selector itself, then the new bank at INVERTED polarity: the UI shows both
    // sections ON and the wire carries 0, because 94/106 are 0 = on.
    expect(byAddr.get(CH1_COMP_EQ_TYPE)).toBe(1);
    expect(byAddr.get(CH1_SSMCS_COMP_ON)).toBe(0);
    expect(byAddr.get(CH1_SSMCS_EQ_ON)).toBe(0);
    // The COMP->EQ bank and the whole 4-band PEQ leave the write set entirely.
    expect(byAddr.has(CH1_COMP_ON)).toBe(false);
    for (const a of ch1EqBandAddrs()) expect(byAddr.has(a)).toBe(false);

    // The new bank was written to addresses the broker is not registered for. No
    // reconcile has run since the swap, and a flush does not re-register, so the two
    // writes above went to a bank the app cannot yet be told about. Hand-computed over
    // the swap flush alone — the registration is a snapshot, so the same question asked
    // against the whole run's writes would answer with an artefact.
    const regAfterSwapAddrs = await paramAddrsOf(page);
    // The emitted set at the same instant, for invariant 6's clause B below. Read here
    // rather than at the analyze() call: two later reconciles re-register the new bank
    // (this case asserts they do), so an end-of-run reading would describe a window
    // that has since closed.
    const snapAfterSwap = await snapshotOf(page);
    const regAfterSwap = regKeys(regAfterSwapAddrs);
    const swapOrphans = [CH1_SSMCS_COMP_ON, CH1_SSMCS_EQ_ON].filter((a) => byAddr.has(a) && !regAfterSwap.has(a));
    console.log(`swap flush: ${swapOrphans.length} new-bank address(es) written but not registered`);
    expect(swapOrphans).toEqual([CH1_SSMCS_COMP_ON, CH1_SSMCS_EQ_ON]);

    // One undo entry puts the whole bank back: the switch's own plan write plus the
    // bank reset the funnel performs AFTER markChanged (the diff is taken at the
    // commit, not at the edit). Taken here, before any device-side notify — a
    // device-follow reconcile resets the history outright, and what the direct path
    // does to an open entry is T3's `undo-entry-survives-device-sweep`, not this case.
    await mark(page, "undo");
    await page.keyboard.press("Control+z");
    await expect(param(page, "COMP/EQ Type").locator("select")).toHaveValue("0");
    await expect(param(page, "Sweet Spot Data")).toHaveCount(0);
    await settleAfter(page, "undo", 1800);

    trace = await traceOf(page);
    const undoAt = markTime(trace, "undo")!;
    const undoWrites = new Map(
      setsOf(trace)
        .filter((s) => s.start > undoAt)
        .map((s) => [s.addr!, s.value]),
    );
    console.log(`undo re-emitted type=${undoWrites.get(CH1_COMP_EQ_TYPE)} eqOn(44)=${undoWrites.get(CH1_EQ_ON)}`);
    // The undo is a device write like any other: the selector goes back out, and the
    // COMP->EQ bank's own EQ-ON returns with it.
    expect(undoWrites.get(CH1_COMP_EQ_TYPE)).toBe(0);
    expect(undoWrites.has(CH1_EQ_ON)).toBe(true);

    // Back to SSMCS for the notify half of the case.
    await mark(page, "to-ssmcs-again");
    await typeSel.selectOption("1");
    await expect(param(page, "Sweet Spot Data")).toHaveCount(1);
    await settleAfter(page, "to-ssmcs-again", 1800);

    // A notify on the ABANDONED bank address vs one on the new bank, same burst
    // shape, one variable changed. The old one has no node any more.
    await mark(page, "old-bank-notify");
    await pushNotify(page, [[34, 0, 0, 1]]);
    await settleAfter(page, "old-bank-notify", 1800);
    trace = await traceOf(page);
    const oldAt = markTime(trace, "old-bank-notify")!;
    const oldCost = fullReadsAfter(trace, oldAt);

    await mark(page, "new-bank-notify");
    await pushNotify(page, [[94, 0, 0, 1]]);
    await settleAfter(page, "new-bank-notify", 1800);
    trace = await traceOf(page);
    const newAt = markTime(trace, "new-bank-notify")!;
    const newCost = fullReadsAfter(trace, newAt);
    const regAfter = regKeys(await paramAddrsOf(page));

    console.log(`notify on the abandoned bank (34): ${oldCost} full reconcile(s)`);
    console.log(`notify on the live bank (94): ${newCost} full reconcile(s)`);
    console.log(`registration: ${regBefore.size} → ${regAfter.size}`);

    // The abandoned address resolves to nothing, so it escalates: settle + idle net.
    expect(oldCost).toBe(2);
    // The live bank address resolves to ch1 and is not follow:"direct", so it takes a
    // scoped read — the idle net still runs its one full sweep behind it.
    expect(newCost).toBe(1);
    expect(regAfter.has(CH1_SSMCS_COMP_ON)).toBe(true);
    expect(regAfter.has(CH1_COMP_ON)).toBe(false);
    // Invariant 12 scoped to the window `regAfterSwap` describes — the swap flush, up to
    // the undo. Unscoped it would diff every write in the run against the END-of-run
    // registration and count the pre-swap COMP->EQ writes, which were correctly
    // registered when they were sent.
    //
    // Invariant 6's clause B says the other half of it, from the pair taken at the swap:
    // the finding is TRUE and is the same fact `swapOrphans` proves by hand above, but
    // stated over the whole emitted set rather than the two addresses this case names —
    // every SSMCS address the plan now emits is one a device-side move could not be
    // delivered on until something reconciles. Reported, not asserted, because the
    // window is the case's subject and closing it is what the later phases measure.
    console.log(
      report(
        "comp/eq bank swap",
        analyze(trace, {
          registration: regAfterSwapAddrs,
          registrationWindow: { from: at, to: undoAt },
          snapshot: snapAfterSwap,
        }),
      ),
    );
  });

  // shape-insert-fx-select-ordering. The only case where correctness is decided by the
  // ORDER of two commands inside one flush rather than by their values: the device
  // auto-engages the bypass whenever a selector is accepted, so 135 must precede 134.
  test("insert-FX selection sends the selector before the bypass, and clears it by leaving the set", async ({
    page,
  }) => {
    await goLive(page);
    await graphNode(page, "ch1").click();
    await setLatency(page, { get: 2, set: 40 });

    const sel = paramExact(page, "Insert FX").locator("select");
    await expect(sel).toHaveCount(1);

    await mark(page, "select-compander");
    await sel.selectOption({ label: "Compander-H" });
    await settleAfter(page, "select-compander", 1800);

    let trace = await traceOf(page);
    const selAt = markTime(trace, "select-compander")!;
    const after = setsOf(trace).filter((s) => s.start > selAt);
    const selSet = after.find((s) => s.addr === CH1_INSERT_FX);
    const onSet = after.find((s) => s.addr === CH1_INSERT_FX_ON);

    console.log(timeline(trace, { from: selAt - 50 }));
    console.log(report("insert-fx ordering", analyze(trace, { order: [CH1_INSERT_FX, CH1_INSERT_FX_ON] })));

    // Selecting an effect co-writes the bypass ON, and the pair leaves in that order.
    expect(selSet).toBeDefined();
    expect(onSet).toBeDefined();
    expect(onSet!.value).toBe(1);
    expect(selSet!.seq).toBeLessThan(onSet!.seq);
    expect(analyze(trace, { order: [CH1_INSERT_FX, CH1_INSERT_FX_ON] })).toHaveLength(0);

    // Bypass OFF alone: the selector is unchanged, so the diff carries one command.
    await mark(page, "bypass-off");
    await paramExact(page, "Insert FX ON").locator("button", { hasText: /^OFF$/ }).click();
    await settleAfter(page, "bypass-off", 1200);
    trace = await traceOf(page);
    const offAt = markTime(trace, "bypass-off")!;
    const offWrites = setsOf(trace).filter((s) => s.start > offAt);
    console.log(`bypass OFF emitted: ${offWrites.map((s) => `${s.addr}=${s.value}`).join(", ") || "(nothing)"}`);
    expect(offWrites.map((s) => s.addr)).toEqual([CH1_INSERT_FX_ON]);
    expect(offWrites[0].value).toBe(0);

    // Author one engine-array slot. translate writes ONLY the slots the plan carries
    // (an absent slot is left to the device's per-type default), so without this the
    // engine array is not in the write set at all and the ordering below has nothing
    // to order — the compander's Threshold is what puts a 689 slot into it.
    await mark(page, "edit-engine-slot");
    const threshold = param(page, "Threshold").locator('input[type="range"]');
    await threshold.focus();
    await page.keyboard.press("ArrowUp");
    await settleAfter(page, "edit-engine-slot", 1200);
    trace = await traceOf(page);
    const slotAt = markTime(trace, "edit-engine-slot")!;
    const slotWrite = setsOf(trace).filter((s) => s.addr?.startsWith("689:") && s.start > slotAt);
    console.log(`engine slot edit emitted: ${slotWrite.map((s) => `${s.addr}=${s.value}`).join(", ")}`);
    expect(slotWrite.length).toBeGreaterThan(0);

    // No Effect: the bypass address deliberately LEAVES the write set (translate emits
    // INSERT_FX_ON only while an effect is selected), so nothing is written to it and
    // it drops out of the registration at the next reconcile.
    await mark(page, "select-none");
    await sel.selectOption({ label: "No Effect" });
    await settleAfter(page, "select-none", 1800);
    trace = await traceOf(page);
    const noneAt = markTime(trace, "select-none")!;
    const noneWrites = setsOf(trace).filter((s) => s.start > noneAt);
    console.log(`No Effect emitted: ${noneWrites.map((s) => `${s.addr}=${s.value}`).join(", ")}`);
    expect(noneWrites.some((s) => s.addr === CH1_INSERT_FX)).toBe(true);
    expect(noneWrites.some((s) => s.addr === CH1_INSERT_FX_ON)).toBe(false);

    // Re-selecting the same effect brings the pair back in the same order, in one
    // flush, with the engine slot writes behind them.
    await mark(page, "reselect");
    await sel.selectOption({ label: "Compander-H" });
    await settleAfter(page, "reselect", 1800);
    trace = await traceOf(page);
    const reAt = markTime(trace, "reselect")!;
    const reWrites = setsOf(trace).filter((s) => s.start > reAt);
    const reSel = reWrites.find((s) => s.addr === CH1_INSERT_FX);
    const reOn = reWrites.find((s) => s.addr === CH1_INSERT_FX_ON);
    const engine = reWrites.filter((s) => s.addr?.startsWith("689:"));
    console.log(`re-select: selector ${reSel?.seq}, bypass ${reOn?.seq}, ${engine.length} engine slot write(s)`);
    expect(reSel).toBeDefined();
    expect(reOn).toBeDefined();
    expect(reSel!.seq).toBeLessThan(reOn!.seq);
    // The compander engine array (689) is typed by the selector, so those writes must
    // follow it too.
    expect(engine.length).toBeGreaterThan(0);
    expect(Math.min(...engine.map((s) => s.seq))).toBeGreaterThan(reSel!.seq);
  });

  // shape-scene-write-scope. Differential by construction: one script, two scopes.
  // The scope is a non-plan user preference, and it reshapes the write diff, the live
  // snapshot AND the notify registration at the single planToCommands chokepoint.
  test("scene write scope removes the scene-external addresses and makes their notifies undeliverable", async ({
    page,
    context,
  }) => {
    // Run A: scene scope, seeded into `urx-settings` — the same one validated record
    // the Preferences modal writes (core/settings.ts), which the row below is locked
    // out of while live.
    await installFake(page, { storage: { "urx-settings": JSON.stringify({ deviceScope: "scene" }) } });
    await page.reload();
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await goLive(page);
    await setLatency(page, { get: 2, set: 25 });
    const sceneReg = regKeys(await paramAddrsOf(page));

    // Run B: the identical script at full scope. localStorage is per origin per
    // context, so the second page inherits run A's settings record unless it seeds
    // its own — the two runs would otherwise be the same run twice.
    const full = await context.newPage();
    await installFake(full, { storage: { "urx-settings": JSON.stringify({ deviceScope: "all" }) } });
    await full.goto("/");
    await expect(full.locator("#model-picker")).toHaveValue("URX44V");
    await goLive(full);
    await setLatency(full, { get: 2, set: 25 });
    const fullReg = regKeys(await paramAddrsOf(full));

    const dropped = [...fullReg].filter((a) => !sceneReg.has(a));
    const monitorLevels = dropped.filter((a) => a.startsWith("724:"));
    console.log(`registration: full=${fullReg.size} scene=${sceneReg.size}, ${dropped.length} address(es) dropped`);
    console.log(`dropped MONITOR_LEVEL instances: ${monitorLevels.join(", ")}`);

    // Scene scope is a strict subset, and MONITOR_LEVEL — a follow:"direct",
    // sceneExternal param — is one of the addresses it drops.
    expect(dropped.length).toBeGreaterThan(0);
    expect([...sceneReg].filter((a) => !fullReg.has(a))).toEqual([]);
    expect(monitorLevels.length).toBeGreaterThan(0);
    const probe = monitorLevels[0];
    const [pid, px, py] = probe.split(":").map(Number);

    // The same genuine device-side change, announced to both sessions. The scene
    // session dropped the address from its registration, so the bridge refuses the
    // notify there and delivers it at full scope — the differential is reachability,
    // not cost.
    await mark(page, "monitor-notify");
    await mark(full, "monitor-notify");
    const sceneWhy = await pushNotify(page, [[pid, px, py, 200]]);
    await pushNotifyDelivered(full, [[pid, px, py, 200]]);
    await settleAfter(page, "monitor-notify", 1800);
    await settleAfter(full, "monitor-notify", 1800);

    const sceneTrace = await traceOf(page);
    const fullTrace = await traceOf(full);
    const sceneAt = markTime(sceneTrace, "monitor-notify")!;
    const fullAt = markTime(fullTrace, "monitor-notify")!;
    const sceneCost = fullReadsAfter(sceneTrace, sceneAt);
    const fullCost = fullReadsAfter(fullTrace, fullAt);
    const sceneReads = getsOf(sceneTrace).filter((g) => g.start > sceneAt).length;
    const fullReads = getsOf(fullTrace).filter((g) => g.start > fullAt).length;

    console.log(timeline(sceneTrace, { from: sceneAt - 50, limit: 40 }));
    console.log(`scene scope: ${sceneWhy.join("/")}, ${sceneCost} full reconcile(s), ${sceneReads} read(s)`);
    console.log(`full scope:  ${fullCost} full reconcile(s), ${fullReads} read(s) for one notify`);
    // The refusal is this case's subject, so it is declared rather than reported: clause
    // A exists to catch a case that pushed a stimulus by accident.
    console.log(
      report(
        "scene scope",
        // The scope is chosen BEFORE the session (the row locks while live), so the
        // registration and the emitted set were built from one planToCommands filter at
        // begin() and clause B has nothing to report: a scope is a shrink, never a grow.
        analyze(sceneTrace, {
          registration: [...(await paramAddrsOf(page))],
          snapshot: await snapshotOf(page),
          expectedDrops: [probe],
        }),
      ),
    );

    // Full scope: the address resolves to a node and is follow:"direct", so the settle
    // window needs no read at all. What is left is the idle safety net — armSettle and
    // armIdle are both armed by every notify and neither cancels the other, so even a
    // free direct follow still costs one whole-device sweep 900 ms later. Pinned as
    // current behaviour: this is the floor the scene-scope figure is read against.
    expect(fullCost).toBe(1);
    // Scene scope: the address is not in this session's registration, so the bridge
    // never hands the notify to the page (src-tauri/src/vd.rs Subs::absorb). The
    // preference does not double the cost of a device-side knob move — it makes the
    // move undeliverable. Nothing is read, nothing is reconciled, and the plan keeps a
    // MONITOR_LEVEL the unit no longer has.
    expect(sceneWhy).toEqual(["unregistered"]);
    expect(sceneCost).toBe(0);
    expect(sceneReads).toBe(0);
    expect((await notifyDropsOf(page)).filter((d) => d.addr === probe && d.detail === "unregistered")).toHaveLength(1);

    // A second dropped address, of the other follow kind: OSC_MODE (712) is scene-
    // external like MONITOR_LEVEL but NOT follow:"direct", so its full-scope settle
    // takes a scoped read rather than none. Two params is still two params — the
    // measurement below says nothing about the other ~60 addresses the scope drops,
    // only that the refusal is not a property of the one param first measured.
    const probe2 = dropped.find((a) => a.startsWith("712:"));
    expect(probe2).toBeDefined();
    const [qid, qx, qy] = probe2!.split(":").map(Number);
    await mark(page, "osc-notify");
    await mark(full, "osc-notify");
    const sceneWhy2 = await pushNotify(page, [[qid, qx, qy, 2]]);
    await pushNotifyDelivered(full, [[qid, qx, qy, 2]]);
    await settleAfter(page, "osc-notify", 1800);
    await settleAfter(full, "osc-notify", 1800);

    const sceneTrace2 = await traceOf(page);
    const fullTrace2 = await traceOf(full);
    const sceneAt2 = markTime(sceneTrace2, "osc-notify")!;
    const sceneCost2 = fullReadsAfter(sceneTrace2, sceneAt2);
    const fullCost2 = fullReadsAfter(fullTrace2, markTime(fullTrace2, "osc-notify")!);
    console.log(`OSC_MODE (${probe2}) notify: scene ${sceneWhy2.join("/")} vs full ${fullCost2} full reconcile(s)`);
    expect(fullCost2).toBe(1);
    expect(sceneWhy2).toEqual(["unregistered"]);
    expect(sceneCost2).toBe(0);
    expect(getsOf(sceneTrace2).filter((g) => g.start > sceneAt2)).toEqual([]);

    // The scope row is locked while live — the snapshot, the diff and the registration
    // are all part of the held session.
    await page.click("#btn-prefs");
    const scopeRow = page.locator("#prefs-device-scope");
    await expect(scopeRow).toBeVisible();
    await expect(scopeRow.locator("button").first()).toBeDisabled();
    await full.close();
  });

  // shape-sdrec-track-count-readonly. The negative control for the abort-on-failure
  // rule: the one parameter the app reads on every full readback and emits nowhere.
  test("microSD Rec Track Count is read, never written, and its notify never arrives", async ({ page }) => {
    // The device holds 8 tracks (raw 4). Writes to 839 are swallowed rather than
    // refused on purpose: the real broker answers 400 above two tracks, and a refusal
    // would abort the session, so the regression this case is here to catch (the app
    // starting to emit 839) would be reported as a broken link instead of as a write.
    await divergeAt(page, SD_TRACK_COUNT, 4);
    await ignoreWrites(page, [839]);
    await goLive(page);
    await setLatency(page, { get: 2, set: 25 });

    const reg = regKeys(await paramAddrsOf(page));
    let trace = await traceOf(page);
    const reads = getsOf(trace).filter((g) => g.addr === SD_TRACK_COUNT);
    const writes = setsOf(trace).filter((s) => s.addr === SD_TRACK_COUNT);
    console.log(`839: ${reads.length} read(s), ${writes.length} write(s), registered=${reg.has(SD_TRACK_COUNT)}`);

    // Read back on every full readback, emitted by nothing, and therefore absent from
    // the registration the write set defines.
    expect(reads.length).toBeGreaterThan(0);
    expect(writes).toHaveLength(0);
    expect(reg.has(SD_TRACK_COUNT)).toBe(false);

    // The control is locked while live (front panel only), so no UI path can even try.
    await graphNode(page, "out.sdrec").click();
    const trackSel = param(page, "Track Count").locator("select");
    await expect(trackSel).toHaveValue("8");
    await expect(trackSel).toBeDisabled();

    // A device-side change: the operator turns the recorder to 12 tracks on the unit.
    await divergeAt(page, SD_TRACK_COUNT, 6);
    await mark(page, "track-count-notify");
    const why = await pushNotify(page, [[839, 0, 0, 6]]);
    const atNotify = await trackSel.inputValue();
    console.log(`Track Count at the instant of the notify: ${atNotify}`);
    expect(atNotify).toBe("8");
    // settleAfter, not waitQuiet: the verdict below is an ABSENCE, and a link that has
    // not started yet is silent for the same reason a finished one is.
    await settleAfter(page, "track-count-notify", 1800);

    trace = await traceOf(page);
    const at = markTime(trace, "track-count-notify")!;
    const cost = fullReadsAfter(trace, at);
    const lateReads = getsOf(trace).filter((g) => g.addr === SD_TRACK_COUNT && g.start > at);
    console.log(timeline(trace, { from: at - 50, limit: 40 }));
    console.log(`839 notify: refused as "${why[0]}", ${cost} full reconcile(s), ${lateReads.length} read(s) of 839`);
    // The refusal is asserted below, so it is declared here: clause A is for the case
    // that pushed a stimulus it did not mean to have refused.
    console.log(
      report(
        "sd rec track count",
        // 839 is read and never written, so it is in no snapshot: clause B can only ever
        // see a grown EMISSION, never a registration-side absence. This case's subject
        // is the drop, which is clause A's.
        analyze(trace, {
          registration: [...(await paramAddrsOf(page))],
          snapshot: await snapshotOf(page),
          expectedDrops: [SD_TRACK_COUNT],
        }),
      ),
    );

    // The address is absent from the registration, so the bridge drops the notify
    // (src-tauri/src/vd.rs Subs::absorb) and nothing escalates. The value the operator
    // set on the unit's front panel never reaches the plan for the rest of the session.
    // Worse than expensive: DeviceFollow.armIdle() is reachable only from inside
    // onNotify, so a session that receives no deliverable notify has no idle safety net
    // scheduled to discover the change later either.
    expect(why).toEqual(["unregistered"]);
    expect((await notifyDropsOf(page)).filter((d) => d.addr === SD_TRACK_COUNT)).toHaveLength(1);
    expect(cost).toBe(0);
    expect(lateReads).toEqual([]);
    await expect(param(page, "Track Count").locator("select")).toHaveValue("8");
    // Still never written, even though the plan and the device now disagree.
    expect(setsOf(trace).filter((s) => s.addr === SD_TRACK_COUNT)).toHaveLength(0);
  });

  // shape-send-emission-wire-presence, reachable portion. The catalog's script deletes
  // the ch1 → MIX 1 wire; that gesture does not exist — every CH → bus send is a FIXED
  // connection (models/build.ts rule 2) and the inspector offers no delete for one, so
  // the "no wire" branch of translate is unreachable from the UI. What IS reachable is
  // the other half of the same shape: the destination KIND decides how many addresses
  // a send occupies, and the FX destination's tap is read but never written.
  test("send address count varies with the destination kind, and the FX tap is read-only", async ({ page }) => {
    await goLive(page);
    await page.click("#btn-view-console");
    await expect(strip(page, "CH 1")).toBeVisible();
    await setLatency(page, { get: 2, set: 25 });

    const reg = regKeys(await paramAddrsOf(page));
    // ch1 → MIX 1 (VARI): level / pan / on on both linked L/R instances, plus one tap.
    const mix1 = ["146:0:0", "152:0:0", "147:0:0", "153:0:0", "148:0:0", "154:0:0", "151:0:0"];
    const missingMix = mix1.filter((a) => !reg.has(a));
    console.log(`MIX 1 send addresses missing from the registration: ${missingMix.join(", ") || "(none)"}`);
    expect(missingMix).toEqual([]);

    // ch1 → FX 1: one level, one on, NO pan (a mono send), and NO tap — the broker
    // reports max_value=0 for a CH → FX tap, so translate never emits it.
    expect(reg.has(CH1_FX1_LEVEL)).toBe(true);
    expect(reg.has(CH1_FX1_ON)).toBe(true);
    expect(reg.has("195:0:0")).toBe(false); // the slot a MIX send's pan would occupy
    expect(reg.has(CH1_FX1_TAP)).toBe(false);

    // Toggling the send's enable chip changes a VALUE, not the shape: only the two
    // SEND_ON instances move, and level / pan / tap stay in the set both times because
    // the WIRE is still there. Driven twice so the assertion is about the pair of
    // addresses and the flip, not about which state the seeded plan happened to start in.
    const chip = strip(page, "CH 1")
      .locator(".con-scol", { has: page.getByRole("button", { name: "M1", exact: true }) })
      .getByRole("button", { name: "M1", exact: true });
    await mark(page, "send-toggle-1");
    await chip.click();
    await settleAfter(page, "send-toggle-1", 1200);
    await mark(page, "send-toggle-2");
    await chip.click();
    await settleAfter(page, "send-toggle-2", 1200);

    let trace = await traceOf(page);
    const t1 = markTime(trace, "send-toggle-1")!;
    const t2 = markTime(trace, "send-toggle-2")!;
    const first = setsOf(trace).filter((s) => s.start > t1 && s.start < t2);
    const second = setsOf(trace).filter((s) => s.start > t2);
    console.log(`send toggle 1 emitted: ${first.map((s) => `${s.addr}=${s.value}`).join(", ")}`);
    console.log(`send toggle 2 emitted: ${second.map((s) => `${s.addr}=${s.value}`).join(", ")}`);
    expect(first.map((s) => s.addr).sort()).toEqual(["148:0:0", "154:0:0"]);
    expect(second.map((s) => s.addr).sort()).toEqual(["148:0:0", "154:0:0"]);
    // Both linked instances always carry the same value, and the second press is the
    // inverse of the first.
    expect(new Set(first.map((s) => s.value)).size).toBe(1);
    expect(first[0].value).not.toBe(second[0].value);
    const regAfterOff = regKeys(await paramAddrsOf(page));
    expect(mix1.every((a) => regAfterOff.has(a))).toBe(true);

    // The device's own change to the CH → FX tap — a control only its LCD can move —
    // lands on an address the app writes nothing to, and therefore never registered.
    // It is not expensive to follow, it is UNFOLLOWABLE: the bridge drops the notify
    // and no reconcile is scheduled to discover the change later.
    await mark(page, "fx-tap-notify");
    const why = await pushNotify(page, [[193, 0, 0, 1]]);
    await settleAfter(page, "fx-tap-notify", 1800);
    trace = await traceOf(page);
    const tapAt = markTime(trace, "fx-tap-notify")!;
    const cost = fullReadsAfter(trace, tapAt);
    console.log(timeline(trace, { from: t1 - 50, limit: 60 }));
    console.log(`CH → FX tap notify: refused as "${why[0]}", ${cost} full reconcile(s)`);
    // Declared, not reported: the tap's refusal is the finding this case exists to make.
    console.log(
      report(
        "send emission shape",
        // The enable chip moves conn.params.on, a VALUE — the case asserts just above
        // that the same two addresses are emitted both times — so the emitted set never
        // changes shape and clause B stays silent.
        analyze(trace, {
          registration: [...(await paramAddrsOf(page))],
          snapshot: await snapshotOf(page),
          expectedDrops: [CH1_FX1_TAP],
        }),
      ),
    );
    expect(why).toEqual(["unregistered"]);
    expect((await notifyDropsOf(page)).filter((d) => d.addr === CH1_FX1_TAP)).toHaveLength(1);
    expect(cost).toBe(0);
    expect(getsOf(trace).filter((g) => g.start > tapAt)).toEqual([]);
  });
});
