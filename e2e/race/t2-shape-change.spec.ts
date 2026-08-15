import { test, expect, type Page } from "@playwright/test";
import {
  installFake,
  goLive,
  mark,
  pushNotify,
  pushNotifyDelivered,
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
import { analyze, report, timeline, markTime, setsOf, getsOf, deviceReflectsAfter } from "./analyze";
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
  //
  // The blindness is the same; what carries it moved. The flush that reshapes the write
  // set now re-registers against it (live.ts followSetStale → DeviceFollow.refresh), so
  // the bands leave the REGISTRATION with the write set instead of lingering in it until
  // some later reconcile. A band announcement is refused at the bridge rather than
  // delivered to an app that cannot place it — and what keeps the app in step is the
  // address the toggle does NOT drop: 1-Knob level (48) stays registered and carries
  // `sideEffect: "refetch"`, so the app follows the CAUSE of the recomputation.
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
    // …and the registration moved WITH the write set, in the same flush and by exactly
    // the bands. Stated as the two differences rather than as a size, so an address
    // that left and another that arrived cannot cancel out: nothing was added, and what
    // left is the band block and nothing else.
    const wentOut = [...regBefore].filter((a) => !regAfterOn.has(a)).sort();
    const cameIn = [...regAfterOn].filter((a) => !regBefore.has(a));
    console.log(`ON flush: registration ${regBefore.size} → ${regAfterOn.size}, ${wentOut.length} address(es) left`);
    expect(wentOut).toEqual([...bands].sort());
    expect(cameIn).toEqual([]);

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
    // The other direction of the same flush, and the one the re-registration exists
    // for: an address the edit ADDED is subscribed by that edit's own flush, so a band
    // moved on the unit from here is followed rather than waiting for a reconcile.
    const regAfterOff = regKeys(await paramAddrsOf(page));
    expect(bands.filter((a) => !regAfterOff.has(a))).toEqual([]);

    // Phase 3 — 1-Knob ON again, then the differential that decides the blind spot.
    await mark(page, "oneknob-on-2");
    await oneKnobFace(page, 0).click();
    await settleAfter(page, "oneknob-on-2", 1200);

    // Phase 3a — ONE notify on a band address the ON flush just dropped. It is out of
    // the write set AND out of the registration, together and in the same flush, so the
    // bridge refuses it: the announcement reaches the page at all only for an address
    // the session registered (fake-device.ts, mirroring vd.rs Subs::absorb). The
    // refusal is the assertion, which is why `pushNotify` is used for its verdict
    // rather than `pushNotifyDelivered` — the latter throws on exactly this.
    const regBeforeProbe = regKeys(await paramAddrsOf(page));
    expect(regBeforeProbe.has(BAND0_GAIN)).toBe(false);
    await mark(page, "probe-dropped");
    const droppedWhy = await pushNotify(page, [[53, 0, 0, 300]]);
    await settleAfter(page, "probe-dropped", 1800);
    trace = await traceOf(page);
    const droppedAt = markTime(trace, "probe-dropped")!;
    const droppedCost = fullReadsAfter(trace, droppedAt);
    const regAfterProbe = regKeys(await paramAddrsOf(page));
    const stillRegistered = bands.filter((a) => regAfterProbe.has(a));
    expect(droppedWhy).toEqual(["unregistered"]);

    // Phase 3b — the control: ONE notify, same shape, same node, on the address the
    // toggle did NOT drop (EQ_ONE_KNOB_LEVEL, 48). Both probes touch exactly one
    // logical control, so neither can hit MAX_CONCENTRATION (> 3 distinct node:name
    // pairs in a settle window, follow.ts); what differs is whether the session is
    // registered for the address at all. This one is the recomputation's CAUSE and is
    // a `sideEffect: "refetch"` param, so following it is what keeps the bands in step
    // while their own addresses are unsubscribed.
    expect(regAfterProbe.has(ONE_KNOB_LEVEL)).toBe(true);
    await mark(page, "probe-registered");
    // Delivery asserted, not assumed: this arm prices what the app DOES with a notify,
    // and a refused one leaves it in the state "nothing happened" leaves it in.
    await pushNotifyDelivered(page, [[48, 0, 0, 60]]);
    await settleAfter(page, "probe-registered", 1800);
    trace = await traceOf(page);
    const keptAt = markTime(trace, "probe-registered")!;
    const keptCost = fullReadsAfter(trace, keptAt);

    console.log(timeline(trace, { from: on1 - 50 }));
    console.log(`registration: ${regBefore.size} before → ${regAfterOn.size} after the ON flush`);
    console.log(`band addresses: ${bands.length} total, ${stillRegistered.length} still registered`);
    console.log(`one REFUSED notify on a dropped band address (53): ${droppedCost} full reconcile(s)`);
    console.log(`one notify on a KEPT address (48, 1-Knob level): ${keptCost} full reconcile(s)`);

    // The differential. The refused notify reaches nothing — no settle, no idle net.
    // `onNotify` is where a delivered notify arms both, and it never runs; the other way
    // in (the write settle's own sink, `follow.ts` arms `armIdle` from it) needs a write
    // the unit did not announce, and nothing is in flight here. The kept address is
    // delivered, resolves to ch1 and takes a scoped read, leaving the idle net's own
    // sweep behind it.
    expect(droppedCost).toBe(0);
    expect(keptCost).toBe(1);
    // The registration both probes were pushed against is the ON flush's own: no
    // reconcile ran between them, and the bands are out of it from the flush onward.
    expect(stillRegistered).toEqual([]);
    expect(regBefore.size - regAfterProbe.size).toBe(bands.length);

    // Phase 3c — the same recomputation announced the way the device actually announces
    // it, as a four-address burst, with the addresses registered so it is delivered.
    // Pushed with 1-Knob OFF: while it is ON these four addresses are in no
    // registration and the bridge refuses the burst, as 3a measured one address at a
    // time. There is no window to re-open any more — the flush that drops them from the
    // write set drops them from the registration in the same breath.
    //
    // MAX_CONCENTRATION is NOT reached, and this is the phase that measures it: follow.ts
    // counts `node:name` pairs, and the catalog names a band parameter rather than a band
    // (EQ_BAND_GAIN / EQ_BAND_FREQ, translate.ts), so four addresses across two bands are
    // two controls. The four cost one scoped read plus the idle net's sweep — not the two
    // whole-device sweeps the same burst cost while the addresses resolved to nothing.
    await mark(page, "burst-off");
    await oneKnobFace(page, 1).click();
    await settleAfter(page, "burst-off", 1200);
    const regAtBurst = await paramAddrsOf(page);
    const regBeforeBurst = regKeys(regAtBurst);
    const burst: Array<[number, number, number, number]> = [
      [53, 0, 0, 310],
      [52, 0, 0, 240],
      [58, 0, 0, -150],
      [57, 0, 0, 900],
    ];
    const burstAddrs = burst.map(([id, x, y]) => `${id}:${x}:${y}`);
    expect(burstAddrs.filter((a) => regBeforeBurst.has(a))).toEqual(burstAddrs);
    // …and each value is a genuine change. With the bands back in the write set the
    // snapshot holds an entry for every one of them, so a pushed value that happened to
    // equal it would be classified as our own echo and drop that address out of the
    // burst — the cost would then be measuring a shorter burst than the one written here.
    const snapAtBurst = await snapshotOf(page);
    expect(burst.filter(([id, x, y, v]) => snapAtBurst?.[`${id}:${x}:${y}`] === v)).toEqual([]);

    await mark(page, "band-burst");
    await pushNotifyDelivered(page, burst);
    // Long quiet: the settle (300 ms) and the idle net (900 ms) both fire.
    await settleAfter(page, "band-burst", 1800);

    trace = await traceOf(page);
    const burstAt = markTime(trace, "band-burst")!;
    const reconciles = fullReadsAfter(trace, burstAt);
    // The settle's own read, identified as the reads of a band address that precede the
    // first whole-device one. Without it "1 full read" is equally the reading of a settle
    // that did nothing and an idle net that swept afterwards.
    const firstFullAt = getsOf(trace).find((g) => g.addr === RATE_ADDR && g.start > burstAt)?.start ?? Infinity;
    const scopedReads = getsOf(trace).filter(
      (g) => g.addr === BAND0_GAIN && g.start > burstAt && g.start < firstFullAt,
    );
    console.log(`4-notify burst: ${scopedReads.length} scoped read(s), then ${reconciles} full reconcile(s)`);
    expect(scopedReads.length).toBeGreaterThan(0);
    expect(reconciles).toBe(1);

    // Invariants 6 and 12 over the burst window only. The registration is a snapshot of
    // one instant; run against the whole trace it counts writes that were perfectly well
    // registered when they were sent (every phase before this one wrote a different
    // address set), so the number would be an artefact of comparing a full-run write
    // set against a final-state registration. The snapshot handed over is the one taken
    // BEFORE the burst, for the same reason: the two reconciles the burst provoked have
    // re-registered since, without the 18 band addresses (1-Knob is on), so an
    // end-of-window snapshot describes a set none of these notifies was pushed against.
    // No `snapshot`, for a reason of its own: clause B is a state predicate and its two
    // halves must be read at ONE instant, so pairing the pre-burst registration with a
    // live snapshot read now would answer for neither. Phase 4 reads such a pair.
    // Clause A subtracts the refusal phase 3a's assertion is about; leaving it in would
    // report the case as one that measured nothing, in the one phase whose subject is
    // that it measures a refusal.
    console.log(
      report(
        "eq 1-knob registration blindspot",
        analyze(trace, {
          registration: regAtBurst,
          registrationWindow: { from: burstAt },
          expectedDrops: [BAND0_GAIN],
        }),
      ),
    );

    // Phase 4 — the mirror image: the flush that ADDS the bands back. The app writes all
    // 18 of them, and the same flush registers for them, so the pair read at one instant
    // below holds nothing clause B can report. That is the fix's own subject, and it is
    // an assertion that could only ever pass if the clause could fire — which the
    // control below establishes on the same run and the same data.
    await mark(page, "oneknob-on-3");
    await oneKnobFace(page, 0).click();
    await settleAfter(page, "oneknob-on-3", 1200);
    // The registration as it stands BEFORE the flush that grows the emitted set. This is
    // the stale half the code used to leave in place, kept for the control below.
    const regBeforeGrowth = await paramAddrsOf(page);
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
    // The premise: the flush really did write the bands, so "no orphans" is the
    // registration having caught up rather than nothing having been sent…
    expect(bands.filter((a) => written.has(a)).sort()).toEqual([...bands].sort());
    // …and the flush is what caught it up. A reconcile landing inside the settle wait
    // re-registers through follow.ts's own post-reconcile subscribe, which would satisfy
    // the pair below whatever the flush did.
    expect(deviceReflectsAfter(trace, off2)).toBe(0);
    const orphans = bands.filter((a) => written.has(a) && !regNow.has(a));
    console.log(`after 1-Knob OFF: ${orphans.length} band address(es) written but not registered`);
    expect(orphans).toEqual([]);

    // The same fact decided by the analyzer rather than by hand, so the pin and the
    // clause cannot disagree about it. Only clause B is read: clauses A and C are
    // scanned over the whole trace here, which spans three earlier phases pushed
    // against registrations this one does not describe.
    const grownOf = (registration: Array<[number, number, number]>) =>
      analyze(trace, { registration, snapshot: snapNow }).filter((f) => f.inv === 6 && f.name === "grown window");
    const grown = grownOf(regAddrsNow);
    console.log(report("eq 1-knob grown window", grown));
    expect(grown).toEqual([]);

    // The control, without which the assertion above passes for a clause that cannot
    // fire. The same snapshot against the registration as it stood one flush earlier —
    // which is exactly the pairing the app used to leave behind, since `subscribe()` ran
    // at begin() and after a reconcile only. It reports the 18 bands, so the clause is
    // live and what silenced it is the flush's own re-registration.
    const stale = grownOf(regBeforeGrowth);
    console.log(report("eq 1-knob grown window (pre-flush registration)", stale));
    expect(stale).toHaveLength(1);
    expect(stale[0].detail).toContain(`${bands.length} address(es)`);
    const regStale = regKeys(regBeforeGrowth);
    const grownAddrs = new Set(Object.keys(snapNow ?? {}).filter((a) => !regStale.has(a)));
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

    // The registration swapped banks with the write set, in the swap's own flush. Both
    // directions, since a bank swap is the one gesture that moves the set both ways at
    // once: the two addresses just written are registered, and the bank they replaced is
    // not. Hand-computed over the swap flush alone — the registration is a snapshot, so
    // the same question asked against the whole run's writes would answer with an
    // artefact.
    const regAfterSwapAddrs = await paramAddrsOf(page);
    // The emitted set at the same instant, for invariant 6's clause B below. Read here
    // rather than at the analyze() call, which is where a pair belonging to two
    // different instants stops answering for either.
    const snapAfterSwap = await snapshotOf(page);
    const regAfterSwap = regKeys(regAfterSwapAddrs);
    const swapOrphans = [CH1_SSMCS_COMP_ON, CH1_SSMCS_EQ_ON].filter((a) => byAddr.has(a) && !regAfterSwap.has(a));
    console.log(`swap flush: ${swapOrphans.length} new-bank address(es) written but not registered`);
    // Attributed to the swap's own flush: no reconcile landed inside the wait, and one
    // would have re-registered through follow.ts whatever the flush did.
    expect(deviceReflectsAfter(trace, at)).toBe(0);
    expect(swapOrphans).toEqual([]);
    expect(regAfterSwap.has(CH1_COMP_ON)).toBe(false);
    expect(ch1EqBandAddrs().filter((a) => regAfterSwap.has(a))).toEqual([]);

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
    // shape, one variable changed: the second swap left the old bank in no write set
    // and, from that same flush, in no registration.
    await mark(page, "old-bank-notify");
    const oldWhy = await pushNotify(page, [[34, 0, 0, 1]]);
    await settleAfter(page, "old-bank-notify", 1800);
    trace = await traceOf(page);
    const oldAt = markTime(trace, "old-bank-notify")!;
    const oldCost = fullReadsAfter(trace, oldAt);
    expect(oldWhy).toEqual(["unregistered"]);

    await mark(page, "new-bank-notify");
    await pushNotifyDelivered(page, [[94, 0, 0, 1]]);
    await settleAfter(page, "new-bank-notify", 1800);
    trace = await traceOf(page);
    const newAt = markTime(trace, "new-bank-notify")!;
    const newCost = fullReadsAfter(trace, newAt);
    const regAfter = regKeys(await paramAddrsOf(page));

    console.log(`notify on the abandoned bank (34): ${oldCost} full reconcile(s), refused as ${oldWhy.join("/")}`);
    console.log(`notify on the live bank (94): ${newCost} full reconcile(s)`);
    console.log(`registration: ${regBefore.size} → ${regAfter.size}`);

    // The abandoned address is refused at the bridge, so it costs nothing at all: the
    // settle and the idle net are both armed from inside onNotify, which never runs.
    expect(oldCost).toBe(0);
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
    // Invariant 6's clause B says the other half of it, from the pair taken at the swap,
    // and it is the whole-emitted-set form of what `swapOrphans` checks by hand for the
    // two addresses this case names. Reported rather than asserted: the case's own
    // assertions are what decide the swap, and this is the analyzer's reading of the
    // same instant.
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
  // Was "…and its notify never arrives", which is what the app did before 839 joined the
  // registration: the address was in no registration because nothing WROTE it, the bridge
  // dropped the unit's announcement, and the operator's front-panel change never reached
  // the plan for the rest of the session. The pin is rewritten rather than deleted so it
  // tracks the fix — everything about the WRITE side is unchanged and still asserted here.
  test("microSD Rec Track Count is read, never written, and its notify is repaired by a scoped read", async ({
    page,
  }) => {
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

    // Read back on every full readback, emitted by nothing — and registered anyway. The
    // registration is no longer the write set: an address the app only reads joins it so
    // the unit's announcement has somewhere to land.
    expect(reads.length).toBeGreaterThan(0);
    expect(writes).toHaveLength(0);
    expect(reg.has(SD_TRACK_COUNT)).toBe(true);

    // The control is locked while live (front panel only), so no UI path can even try.
    await graphNode(page, "out.sdrec").click();
    const trackSel = param(page, "Track Count").locator("select");
    await expect(trackSel).toHaveValue("8");
    await expect(trackSel).toBeDisabled();

    // A device-side change: the operator turns the recorder to 12 tracks on the unit.
    await divergeAt(page, SD_TRACK_COUNT, 6);
    await mark(page, "track-count-notify");
    // Delivered, and asserted so by the helper: the case's subject is now what the notify
    // CAUSES, and a refused push would make every clause below pass by never happening.
    await pushNotifyDelivered(page, [[839, 0, 0, 6]]);
    const atNotify = await trackSel.inputValue();
    console.log(`Track Count at the instant of the notify: ${atNotify}`);
    expect(atNotify).toBe("8");
    await settleAfter(page, "track-count-notify", 1800);

    trace = await traceOf(page);
    const at = markTime(trace, "track-count-notify")!;
    const rates = getsOf(trace).filter((g) => g.addr === RATE_ADDR && g.start > at);
    const lateReads = getsOf(trace).filter((g) => g.addr === SD_TRACK_COUNT && g.start > at);
    console.log(timeline(trace, { from: at - 50, limit: 40 }));
    console.log(
      `839 notify: first read at +${Math.round(lateReads[0].start - at)} ms, ` +
        `${rates.length} full reconcile(s), first at ${rates.length ? `+${Math.round(rates[0].start - at)} ms` : "(none)"}`,
    );
    console.log(
      report(
        "sd rec track count",
        // 839 is read and never written, so it is in no snapshot: clause B can only ever
        // see a grown EMISSION, never a registration-side absence.
        analyze(trace, {
          registration: [...(await paramAddrsOf(page))],
          snapshot: await snapshotOf(page),
        }),
      ),
    );

    // Delivered, and repaired by a SCOPED read of out.sdrec — the node 839 lands on.
    // Asserted by order rather than by counting whole-device reads: the settle fires at
    // 300 ms and the idle safety net at 900 ms, so this case's 1800 ms wait contains a
    // full read either way and a count would read the same with the routing removed.
    // What only the scoped route can produce is a read of 839 before any whole-device
    // pass begins. (readback gates 839 on `want("out.sdrec")` for exactly this; with the
    // older `only === undefined` gate the scoped read would touch nothing and the value
    // would sit stale until the idle net.)
    expect((await notifyDropsOf(page)).filter((d) => d.addr === SD_TRACK_COUNT)).toHaveLength(0);
    expect(lateReads.length).toBeGreaterThan(0);
    expect(rates.length === 0 || lateReads[0].start < rates[0].start).toBe(true);
    // The point of the whole exercise: the value the operator set on the unit is now on
    // screen. 12 tracks = raw 6.
    await expect(trackSel).toHaveValue("12");
    // Still never written — following it must not have made it writable, and the control
    // is still locked while live.
    expect(setsOf(trace).filter((s) => s.addr === SD_TRACK_COUNT)).toHaveLength(0);
    await expect(trackSel).toBeDisabled();
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

    // ch1 → FX 1: one level, one on, NO pan (a mono send). The tap is registered but
    // never emitted — the broker reports max_value=0 for a CH → FX tap, so translate
    // writes nothing to it while the follow still listens to it.
    expect(reg.has(CH1_FX1_LEVEL)).toBe(true);
    expect(reg.has(CH1_FX1_ON)).toBe(true);
    expect(reg.has("195:0:0")).toBe(false); // the slot a MIX send's pan would occupy
    expect(reg.has(CH1_FX1_TAP)).toBe(true);

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
    // lands on an address the app writes nothing to and registers anyway. It is followed
    // by the CHANNEL's scoped read, not by a whole-device one: the tap is indexed to ch1,
    // whose read re-reads params.tap for every bus it sends to.
    //
    // The device is moved to PRE before the push. Without that the scoped read would
    // answer with the value the plan already holds, and every clause below would pass on
    // a repair that repaired nothing.
    await divergeAt(page, CH1_FX1_TAP, 1);
    await mark(page, "fx-tap-notify");
    await pushNotifyDelivered(page, [[193, 0, 0, 1]]);
    await settleAfter(page, "fx-tap-notify", 1800);
    trace = await traceOf(page);
    const tapAt = markTime(trace, "fx-tap-notify")!;
    const tapRates = getsOf(trace).filter((g) => g.addr === RATE_ADDR && g.start > tapAt);
    const tapReads = getsOf(trace).filter((g) => g.addr === CH1_FX1_TAP && g.start > tapAt);
    console.log(timeline(trace, { from: t1 - 50, limit: 60 }));
    console.log(
      `CH → FX tap notify: first tap read at +${Math.round(tapReads[0].start - tapAt)} ms, ` +
        `${tapRates.length} full reconcile(s), first at ${tapRates.length ? `+${Math.round(tapRates[0].start - tapAt)} ms` : "(none)"}`,
    );
    console.log(
      report(
        "send emission shape",
        // The enable chip moves conn.params.on, a VALUE — the case asserts just above
        // that the same two addresses are emitted both times — so the emitted set never
        // changes shape and clause B stays silent.
        analyze(trace, {
          registration: [...(await paramAddrsOf(page))],
          snapshot: await snapshotOf(page),
        }),
      ),
    );
    expect((await notifyDropsOf(page)).filter((d) => d.addr === CH1_FX1_TAP)).toHaveLength(0);
    expect(tapReads.length).toBeGreaterThan(0);
    // Scoped, not full — asserted by ORDER rather than by counting whole-device reads.
    // A count cannot say it here: the settle fires at 300 ms and the idle safety net at
    // 900 ms, so this case's 1800 ms wait contains a full read either way, and the count
    // would read the same whether the tap was routed to its channel or not. What only
    // the scoped route can produce is a repair of the tap that lands BEFORE any
    // whole-device pass begins.
    expect(tapRates.length === 0 || tapReads[0].start < tapRates[0].start).toBe(true);
    // Still never written, and the operator's front-panel PRE is now on screen. The
    // inspector shows a send's Pre/Post when the WIRE is selected, not the node; the
    // dispatchEvent is how the other specs get past the overlapping wire-hit bands.
    expect(setsOf(trace).filter((s) => s.addr === CH1_FX1_TAP)).toHaveLength(0);
    await page.click("#btn-view-graph");
    await page.locator('.wire-hit[data-from="ch1:out"][data-to="bus.fx1:in"]').dispatchEvent("pointerdown");
    const preBtn = page
      .locator("#inspector .param", { hasText: "Pre/Post" })
      .getByRole("button", { name: "PRE", exact: true });
    // The selected state of this pair is the `on` class, not aria-pressed (ui/inspector.ts).
    await expect(preBtn).toHaveClass(/\bon\b/);
    // Read-only while live, which the follow must not have changed.
    await expect(preBtn).toBeDisabled();
  });
});
