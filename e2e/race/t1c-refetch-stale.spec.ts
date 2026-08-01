import { test, expect, type Page } from "@playwright/test";
import {
  installFake,
  goLive,
  mark,
  setLatency,
  staleReadsAt,
  staleStateOf,
  snapshotOf,
  memOf,
  traceOf,
  settleAfter,
  settleThroughIdleNet,
  pushNotifyDelivered,
  hasProbe,
  ledgerOf,
} from "./fake-device";
import { analyze, report, timeline, markTime, setsOf, getsOf } from "./analyze";
import { openEqScreen } from "./ui";

// T1c — refetch-reads-before-the-write-settles.
//
// The defect measured on hardware (URX44V, System V1.3.1.0): the operator toggles the
// STEREO bus EQ 1-knob and the plan's eqOneKnob.on moves SIX times — twice by the two
// clicks and four times unrequested. One round of it:
//
//   127502  the flush sends EQ_ONE_KNOB_ON (500:0:0) = 0, acked 127513 (11 ms)
//   127539  the refetch that flush's `sideEffect: "refetch"` triggers reads the same
//           address — ack+26 ms — and is answered the PRE-write value
//   127542  readIntoPlan merges that back into the live plan (the button the operator
//           just pressed goes back), and live.ts capture() records the stale value as
//           the snapshot entry, destroying the one the same flush wrote there
//   127577  the device's own notify for OUR write arrives. isEcho is bare snapshot
//           equality, so it is classified as a device-side change
//   127878  the 300 ms scoped reconcile re-reads (ack+425, fresh now) and puts the
//           operator's value back
//
// The end value is right, so a value-only case passes. What is wrong is everything
// between: the screen flips under the operator's hand, the snapshot holds a value nothing
// sent, and a whole node is re-read because the app could not recognise its own write.
// The floor assertion is kept at the bottom for the regression it would catch, but the
// verdicts are the five in the middle.
//
// Unreachable in this harness until `staleAfterWrite`: the fake settled a write at the
// queue point and answered a read from the same map, so there was no state between
// "acked" and "readable". A barrier cannot substitute — it holds the QUEUE, so it delays
// the read and the write together.
//
// What the case must NOT be built on is the mechanism of any one repair. The defect is
// "a value the unit had not yet begun reporting was merged into the plan as device
// truth", and that is decidable without knowing how the app avoids it: an app that waits
// for the unit to announce the write before reading, and an app that answers the address
// out of what the unit announced and never reads it at all, are both clean here and
// neither reads the address the way the broken one does. So the counts below are anchored
// on an address the pass reads in EVERY arm (EQ_ON_ANCHOR) and on whether a stale answer
// was ever consumed (`stale.spent`), never on "the refetch read it back" — which is a
// property of the defect. The fake owes the announcement itself, and makes it for every
// value-changing write (fake-device.ts ANNOUNCE_MS), so an app that waits for it is not
// failed here for a device that never speaks.

/** STEREO bus EQ 1-knob ON. `EQ_ONE_KNOB_ON` sits 2 params after the EQ-ON anchor
 *  (STEREO_EQ_ON = 498), and it carries `sideEffect: "refetch"`. */
const ONE_KNOB_ON = "500:0:0";

/** STEREO_EQ_ON, read by the same refetch pass and written by nothing here. It is the
 *  witness that the pass RAN: the 1-knob address itself cannot be, because a correct app
 *  may legitimately decline to read back an address it has just written. */
const EQ_ON_ANCHOR = "498:0:0";

/** The 1-Knob ON button, located from the level slider's id (the only stable anchor in
 *  that section) rather than by its localized label. `onOff` prints ON first. */
const oneKnobOn = (page: Page): ReturnType<Page["locator"]> =>
  page
    .locator("#dyn-screen-box .prefs-section", { has: page.locator("#dyn-oneknob-level") })
    .locator(".prefs-toggle button")
    .first();

test.describe("T1c refetch staleness", () => {
  test.beforeEach(async ({ page }) => {
    await installFake(page);
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  test("a refetch that reads before the write settles must not author the key the operator just moved", async ({
    page,
  }) => {
    expect(await hasProbe(page)).toBe(true);

    await goLive(page);
    await setLatency(page, { get: 2, set: 5 });
    await openEqScreen(page, "bus.stereo");
    await expect(oneKnobOn(page)).toHaveAttribute("aria-pressed", "false");

    // The unit accepts the write and its read path answers the pre-write value once —
    // which is exactly one read, the one the sideEffect refetch issues for this address
    // (readEqOneKnob reads it once per pass). Armed AFTER the live-sync readback, so that
    // sweep ran against a truthful device. What closes the window is the write's own
    // announcement, which the fake makes for every value-changing write whether or not
    // this is armed (fake-device.ts ANNOUNCE_MS).
    await staleReadsAt(page, ONE_KNOB_ON, 1);

    await mark(page, "oneknob-on");
    await oneKnobOn(page).click();
    // The 120 ms flush throttle, the write, and the refetch it triggers, then quiet.
    await settleAfter(page, "oneknob-on", 900);

    const trace = await traceOf(page);
    const editAt = markTime(trace, "oneknob-on")!;
    const writes = setsOf(trace).filter((s) => s.addr === ONE_KNOB_ON && s.start > editAt);
    const reads = getsOf(trace).filter((g) => g.addr === ONE_KNOB_ON && g.start > editAt);
    const passReads = writes.length
      ? getsOf(trace).filter((g) => g.addr === EQ_ON_ANCHOR && g.start > writes[0].end)
      : [];
    // Read HERE, not at the end: the snapshot is a live map, and on main the scoped
    // reconcile the notify provokes re-captures it from a fresh read — so an end-of-run
    // reading would show the repaired value and the poisoning would be invisible.
    const snap = await snapshotOf(page);
    const held = await memOf(page);
    const stale = await staleStateOf(page);
    const settled = analyze(trace, {
      edits: [{ label: "STEREO EQ 1-knob ON", addr: ONE_KNOB_ON, at: editAt, value: 1 }],
      snapshot: snap,
      // Invariant 3's VALUE clause is opt-in and this is the opt: what the unit holds is
      // what a legitimate re-base is exonerated by (the quantise case).
      deviceState: held,
    });

    console.log(timeline(trace, { from: editAt - 50, limit: 80 }));
    console.log(
      `sent ${ONE_KNOB_ON} = ${writes.map((w) => w.value).join(",")}; the refetch read it ` +
        `${reads.length}x (the pass itself read ${EQ_ON_ANCHOR} ${passReads.length}x); unit holds ` +
        `${held[ONE_KNOB_ON]}; snapshot = ${snap?.[ONE_KNOB_ON]}; ` +
        `stale = ${JSON.stringify(stale[ONE_KNOB_ON])} (spent > 0 = a read was answered the pre-write value)`,
    );
    console.log(report("1-knob ON, after the flush and its refetch", settled));

    // GEOMETRY. Asserted first and separately, and HARD, so a change that makes the case
    // measure nothing fails here instead of quietly turning the verdicts into free
    // passes. The five verdicts below are soft: they are five symptoms of one defect, and
    // a run that stops at the first of them reports the stale answer and says nothing
    // about the screen, the snapshot, the echo or the authorship — which is precisely the
    // reading that let this defect survive behind a correct end value.
    expect(writes).toHaveLength(1);
    expect(writes[0].value).toBe(1);
    expect(held[ONE_KNOB_ON]).toBe(1); // the unit HAS the write
    // The sideEffect refetch pass ran, witnessed by an address it reads and nothing
    // writes. Deliberately NOT "it read the 1-knob address back": answering that address
    // from the write instead of asking the unit is one of the legitimate repairs, and a
    // gate that demanded the read would fail on it while the defect was gone — measured,
    // not hypothetical.
    expect(passReads.length).toBeGreaterThan(0);
    // The hazard was ARMED on the address the flush actually wrote: `armStale` fired at
    // the write's queue point and parked the pre-write value. Without this the verdicts
    // below could be green because no staleness was ever in place.
    expect(stale[ONE_KNOB_ON]?.value).toBe(0);
    // …and it CLOSED, the way the unit closes it — on the write's own announcement. Not
    // a verdict about the app (the fake announces either way), but without it the run
    // below could be measuring a window that is still open, where "no stale answer was
    // consumed" means "not yet".
    expect(stale[ONE_KNOB_ON]?.notified).toBe(true);
    // Any read of it belongs to the window this case is about — after the ack, where the
    // unit still answers the value the write replaced.
    for (const r of reads) expect(r.start).toBeGreaterThan(writes[0].end);

    // ---- RED ON MAIN, 1 — the defect itself, in the fake's own terms: no read was ever
    // answered the pre-write value. Stated of the ANSWER rather than of the read, which
    // is what makes it a property of the system instead of of one repair — an app that
    // waits for the unit to announce the write and then reads it, and an app that never
    // reads it at all, both leave this at 0.
    expect.soft(stale[ONE_KNOB_ON]?.spent).toBe(0);

    // ---- RED ON MAIN, 2 — the screen. The refetch's stale answer went into the live
    // plan on top of the operator's click, and reflectFollow re-rendered the tuning
    // screen from it.
    expect.soft(await oneKnobOn(page).getAttribute("aria-pressed")).toBe("true");

    // ---- RED ON MAIN, 3 — the snapshot. It must hold what the flush SENT; on main it
    // holds what the read answered, because capture() takes its VALUES from the read's
    // private copy and that copy carries the pre-write value for this address.
    expect.soft(snap?.[ONE_KNOB_ON]).toBe(1);
    // The same statement as an invariant, so the report a reader sees names it too.
    expect.soft(settled.filter((f) => f.inv === 3)).toHaveLength(0);

    // The unit announces the change it accepted — again. The fake already sent one when
    // the window closed, and on main that one landed while the flush's own
    // snapshot entry still held the sent value, so it was correctly dropped as an echo
    // and provoked nothing; the poisoning happened after it, when the readback resolved.
    // This second announcement is therefore where the poisoned entry is asked what it
    // costs, and it is placed AFTER the verdicts above are sampled for the reason the
    // snapshot read is placed where it is: on main it provokes the repair.
    //
    // Pushed as DELIVERED: a refused notify is indistinguishable from silence, and the
    // absence verdict below would hold for free.
    await mark(page, "notify");
    await pushNotifyDelivered(page, [[500, 0, 0, 1]]);
    // 4 s rather than the default cap: the two responses this measures the absence of are
    // the 300 ms scoped reconcile and the 900 ms idle sweep, so the window covers both
    // several times over, and a clean run does not pay 25 s of grace to prove silence.
    await settleThroughIdleNet(page, "notify", 4000);

    const after = await traceOf(page);
    const notifyAt = markTime(after, "notify")!;
    const readsAfter = getsOf(after).filter((g) => g.start > notifyAt);
    const findings = analyze(after, { ledger: await ledgerOf(page) });
    const contested = findings.filter((f) => f.inv === 13 && f.detail.startsWith("nodeParams[bus.stereo].eqOneKnob"));

    console.log(report("1-knob ON, the unit's notify for our own write", findings));
    console.log(`after the notify: ${readsAfter.length} read(s)`);

    // ---- RED ON MAIN, 4 — the traffic. With the snapshot holding the sent value, the
    // unit's notify for OUR OWN write is an echo and follow.ts drops it before arming
    // anything (the isEcho return precedes armSettle and armIdle). On main the poisoned
    // entry makes it a foreign change: a scoped re-read of the whole node at +300 ms and
    // the idle safety net's whole-device sweep at +900 ms. Reads only — the follow path
    // writes nothing back, so a writes-after assertion would be 0 on both sides and
    // discriminate nothing.
    expect.soft(readsAfter).toHaveLength(0);

    // ---- RED ON MAIN, 5 — authorship (invariant 13). One key, one gesture, and on main
    // three writers: ui, refetch, follow-scoped.
    expect.soft(contested).toHaveLength(0);

    // FLOOR, green on both sides — kept as the fix's regression witness, not as a verdict.
    // On main the operator's value gets here by being written twice more.
    expect((await memOf(page))[ONE_KNOB_ON]).toBe(1);
  });
});
