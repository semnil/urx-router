import { test, expect, type Page } from "@playwright/test";
import {
  installFake,
  goLive,
  mark,
  pushNotify,
  notifyDropsOf,
  traceOf,
  paramAddrsOf,
  snapshotOf,
  setLatency,
  settleAfter,
  waitQuiet,
  divergeAt,
  depthOf,
  hasProbe,
  type TraceEvent,
} from "./fake-device";
import { analyze, report, timeline, markTime, setsOf, getsOf, spans } from "./analyze";
import { readoutOf } from "./ui";

// T2f shape-change — the two addresses that are in the plan's world without being in
// the plan (docs/{en,ja}/live-race-harness.md).
//
// Both cases here are about the SAME structural seam from opposite sides:
//   - `shape-sample-rate-and-follow-usb`: 766 is inside the plan and leads its write
//     set; 848 is deliberately outside it and reaches the follow layer only through
//     DeviceFollow's single `intercept` hook (src/main.ts). One is written, followed
//     and undoable-in-principle; the other is written by nothing and consumed before
//     the reconcile window ever sees it.
//   - `shape-device-setup-plan-external`: the thirteen SETUP > GENERAL addresses that
//     carry the same `planExternal` flag as 848 but have NO intercept hook, so a
//     device-side change to one of them takes the most expensive path the follow
//     layer has — and that path reads none of them.
//
// Observables, as in T2: the `addrs` argument of vd_params_subscribe IS the follow
// registration set AND (live.ts capture) it is built by walking the one planToCommands
// pass that also produces the write set, in that pass's order, so "the rate leads the
// write set" is readable from it with no extra IPC; and 766:0:0 is read by a FULL
// readback and by nothing else, so counting reads of that address counts whole-device
// reconciles exactly. A third one is used once here: each flush names the number of
// commands it sent on the status line ("→ device (n)"), which is how two writes are
// shown to belong to ONE flush without measuring an interval.
//
// Read latency is 1 ms throughout, for T2's reason: a whole-device readback is ~800
// sequential reads and both cases provoke two of them. Nothing below is a timing
// verdict — every assertion is about which IPC happened, in what order, and against
// which registered address set.

/** Read by a full device readback only — applyNodeState skips it by design, so a read
 *  of this address is one whole-device reconcile. It is also the plan scalar under
 *  test, which is why every count below is taken from `fullReadsAfter` rather than
 *  from "did anything read 766". */
const RATE_ADDR = "766:0:0";
/** SETUP > Follow USB. Catalogued (params.ts) but `planExternal`: no translate emit,
 *  no readback group. main.ts appends it to the follow registration by hand and
 *  consumes its notifies in the one `intercept` hook DeviceFollow has. */
const FOLLOW_USB_ADDR = "848:0:0";
const CH1_FADER_ID = 139;
/** The rate the unit is already running at when the app connects. Deliberately NOT
 *  the app's own stored rate (installFake seeds `urx-rate` = 48000), so "the device's
 *  rate reached the plan" is a value that MOVED rather than one that already agreed —
 *  the same assertion against a matching rate passes whether or not 766 was read. */
const DEVICE_RATE = 96000;
/** What phase B writes: a third rate, so the write is a real diff against both. */
const EDIT_RATE = 44100;

/** The SETUP > GENERAL catalog entries, all flagged `planExternal` in params.ts. 848
 *  carries the same flag and is listed separately below, because it is the one that
 *  has a hook. */
const SETUP_IDS = [758, 760, 761, 767, 768, 770, 771, 772, 787, 788, 795, 812, 831];
/** What readDeviceSetup asks a URX44V for, as numbers: the five globals, the two HDMI
 *  rows (hasHDMI) and the three Date/Time rows (hasSD). The knob strings ride
 *  vd_get_str and are counted separately. */
const SETUP_NUMERIC_IDS = [758, 760, 761, 767, 768, 787, 788, 795, 812, 831];
const UDK_FUNCTION_ID = 770;
const UDK_SLOTS = 16;

/** Whole-device reconciles that began after `at` (see RATE_ADDR). */
const fullReadsAfter = (trace: TraceEvent[], at: number): number =>
  getsOf(trace).filter((g) => g.addr === RATE_ADDR && g.start > at).length;

const setsAfter = (trace: TraceEvent[], at: number): ReturnType<typeof setsOf> =>
  setsOf(trace).filter((s) => s.start > at);

/** Every device command issued after `at`, including the string and subscription ones
 *  — the shape an ABSENCE verdict needs, since "no vd_set" would not notice a read. */
const deviceIpcAfter = (trace: TraceEvent[], at: number): ReturnType<typeof spans> =>
  spans(trace).filter((s) => s.start > at && s.cmd.startsWith("vd_"));

const paramIdOf = (addr: string | undefined): number => Number((addr ?? "").split(":")[0]);

/**
 * Put a value into the fake's state map. Unlike `divergeAt`, which answers the same
 * value for every read for ever, this is a device that HOLDS a value: a later write
 * overwrites it. Used to stand the unit up at DEVICE_RATE before the app connects, so
 * the rate the session starts from is a real one rather than the empty map's 0.
 */
const seedDevice = (page: Page, addr: string, value: number): Promise<void> =>
  page.evaluate(
    ([a, v]) => {
      window.__urxFake.mem[a as string] = v as number;
    },
    [addr, value] as [string, number],
  );

const firstStrip = (page: Page) => page.locator(".con-strip").first();
const firstStripReadout = (page: Page) => readoutOf(firstStrip(page));

test.describe("T2f shape-change", () => {
  test.beforeEach(async ({ page }) => {
    await installFake(page);
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  // shape-sample-rate-and-follow-usb. The two clock scalars, measured against each
  // other: same session, same notify shape, one variable — whether the address is in
  // the plan (766) or outside it with a hook (848).
  //
  // The premise this case must not assume is the ORDER claim in its own title. It is
  // asserted from the registration, which live.ts builds from the same single
  // planToCommands pass that produces the write set, in that pass's order — so
  // `paramAddrs[0]` is the first command a write would send. The flush in phase B then
  // measures the same thing on the wire, with a second edit beside it to order against.
  test("the rate leads the write set and is followed; Follow USB is written by nothing and costs nothing", async ({
    page,
  }) => {
    expect(await hasProbe(page)).toBe(true);
    // The app starts from its own stored rate; the unit has been running at a
    // DIFFERENT one since before the app connected. The gap is what makes the picker
    // assertion below a measurement of the readback rather than of the seed.
    await expect(page.locator("#rate-picker")).toHaveValue("48000");
    await seedDevice(page, RATE_ADDR, DEVICE_RATE);
    await goLive(page);
    await setLatency(page, { get: 1, set: 5 });

    const reg = await paramAddrsOf(page);
    console.log(
      `registration: ${reg.length} address(es), first=${reg[0].join(":")} last=${reg.at(-1)!.join(":")}` +
        `; 848 instances=${reg.filter((a) => a[0] === 848).length}`,
    );

    // The rate leads the write set. The registration is the writable address list
    // (live.ts capture builds both from one planToCommands pass, in its order), so
    // index 0 is the first command a full write sends.
    expect(reg[0]).toEqual([766, 0, 0]);
    // …and it is in the set exactly once: a global scalar emitted by one unconditional
    // push, not one per node like everything else in the list.
    expect(reg.filter((a) => a[0] === 766)).toHaveLength(1);
    // …and Follow USB is appended past the end of it by main.ts's addrs hook: it is in
    // the registration exactly once, at the tail, where nothing in the plan can put it.
    expect(reg.at(-1)).toEqual([848, 0, 0]);
    expect(reg.filter((a) => a[0] === 848)).toHaveLength(1);

    // The device's rate reached the plan — the picker read 48000 a moment ago and the
    // only thing that has touched it since is the starting readback's read of 766 —
    // and the picker locked with the session: while live the rate is the device's,
    // settled at the write boundary instead.
    await expect(page.locator("#rate-picker")).toHaveValue(String(DEVICE_RATE));
    await expect(page.locator("#rate-picker")).toBeDisabled();

    // Phase A — a device-side Follow USB change. The badge is the only Follow USB
    // control while live, so the notify has to reach it; the hook consumes the notify
    // BEFORE isEcho and before armSettle/armIdle, so it must cost no reconcile at all.
    // 848 has no owner node, and what an address with no owner node costs instead is
    // not assumed here — it is measured in phase D below (766: registered, no node,
    // two whole-device reconciles for one notify). The planExternal address in the
    // second case cannot serve as that measurement: it is never registered, so the
    // bridge drops its notify before the app can pay anything for it.
    await waitQuiet(page, 400);
    const badge = page.locator("#follow-usb");
    await expect(badge).toHaveAttribute("data-state", "off");
    await mark(page, "followusb-notify");
    await pushNotify(page, [[848, 0, 0, 1]]);
    // The verdict is an ABSENCE, so the link is given a chance to WAKE first (grace)
    // and only then to fall quiet. `waitQuiet` here would return immediately and report
    // "nothing was sent" before the settle window had even opened.
    await settleAfter(page, "followusb-notify", 900, 2500);

    let trace = await traceOf(page);
    const fuAt = markTime(trace, "followusb-notify")!;
    const afterFu = deviceIpcAfter(trace, fuAt);
    // Taken here rather than at the end of the run: after phase B these counters
    // include every later phase's traffic, and a differential printed from constants
    // is not a measurement.
    const fuFullReads = fullReadsAfter(trace, fuAt);
    const fuReads = getsOf(trace).filter((g) => g.start > fuAt).length;
    console.log(
      `one notify on 848 (intercepted): ${afterFu.length} device command(s), ${fuFullReads} full reconcile(s)`,
    );

    // The badge flipped, which is what makes the zero above a CONSUMPTION rather than a
    // notify that never arrived: the same delivery that produced no IPC did produce a
    // visible state change, so the hook ran.
    await expect(badge).toHaveAttribute("data-state", "on");
    await expect(badge).toHaveAttribute("aria-pressed", "true");
    expect(afterFu).toHaveLength(0);

    // Phase B — the rate on the wire, ordered against an ordinary edit.
    //
    // The picker is disabled while live, so this gesture is NOT one an operator can
    // make; it is dispatched straight at the change handler on purpose. main.ts says
    // why in as many words — "This is a guard rail, not an invariant: nothing below the
    // UI enforces it, so a future path that mutates plan.sampleRate while live would
    // bypass it" — and the second guard, the history's own rate refusal, is dead code
    // until something takes that path. Phase C is what measures that guard; this phase
    // gets the rate into one flush beside a fader step so the SEND ORDER is measurable
    // on the wire and not only in the registration.
    await page.click("#btn-view-console");
    await expect(firstStripReadout(page)).toBeVisible();
    await waitQuiet(page, 400);
    const readoutBefore = (await firstStripReadout(page).textContent())!;
    const depthBefore = await depthOf(page);

    await mark(page, "rate-and-fader");
    await page.evaluate((rate) => {
      const picker = document.getElementById("rate-picker") as HTMLSelectElement;
      picker.value = String(rate);
      picker.dispatchEvent(new Event("change", { bubbles: true }));
      // Same tick, so both land inside one 120 ms throttle window and leave in one
      // flush — which is the only way the order of the two is decided by translate
      // rather than by when they were typed.
      const fader = document.querySelector<HTMLElement>(".con-strip .con-fader")!;
      fader.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    }, EDIT_RATE);
    await settleAfter(page, "rate-and-fader", 1200);

    trace = await traceOf(page);
    const rateAt = markTime(trace, "rate-and-fader")!;
    const emitted = setsAfter(trace, rateAt);
    const rateSet = emitted.find((s) => s.addr === RATE_ADDR);
    const faderSet = emitted.find((s) => paramIdOf(s.addr) === CH1_FADER_ID);
    // What the flush itself said it sent. The app names the command count of each
    // flush on the status line, so "these two left together" is readable without
    // measuring an interval.
    const flushes = trace
      .filter((e) => e.kind === "status" && e.t > rateAt && (e.detail ?? "").startsWith("→ device"))
      .map((e) => e.detail);
    const depthAfter = await depthOf(page);
    const readoutAfter = (await firstStripReadout(page).textContent())!;

    console.log(timeline(trace, { from: fuAt - 50, limit: 40 }));
    console.log(
      `one flush: ${emitted.map((s) => `${s.addr}=${s.value}`).join(", ")} [${flushes.join(" | ")}]` +
        `; undo depth ${depthBefore.undo} → ${depthAfter.undo}; strip readout ${readoutBefore} → ${readoutAfter}`,
    );

    // Exactly the two edits, and the rate first. The snapshot was captured from the
    // starting readback's own copy, so nothing else in the plan differs — the pair IS
    // the flush.
    expect(emitted).toHaveLength(2);
    expect(rateSet).toBeDefined();
    expect(faderSet).toBeDefined();
    expect(rateSet!.value).toBe(EDIT_RATE);
    expect(rateSet!.seq).toBeLessThan(faderSet!.seq);
    // …and both went out in ONE flush — the app reported a single flush of two
    // commands. Without that, "the rate went first" would only say which edit the
    // driver typed first; with it, the order is translate's.
    expect(flushes).toEqual(["→ device (2)"]);
    // Follow USB is written by nothing here: it is not in the write set, so no flush
    // can carry it. The two paths that do send it — the badge's own click and the
    // write flow's rate settle (client.setFollowUsb) — are both outside the live
    // session's edit path, and this run takes neither.
    expect(setsOf(trace).filter((s) => s.addr === FOLLOW_USB_ADDR)).toHaveLength(0);
    // The picker reports the plan's new rate, and the two edits are ONE undo entry
    // (same tick, one 300 ms idle backstop).
    await expect(page.locator("#rate-picker")).toHaveValue(String(EDIT_RATE));
    expect(depthAfter.undo - depthBefore.undo).toBe(1);
    expect(readoutAfter).not.toBe(readoutBefore);

    // Phase C — the undo that touches sampleRate, while the session is up. The refusal
    // is decided on the ENTRY, not on the address: one entry that touches the rate is
    // refused whole, so the fader step inside it cannot be undone either.
    //
    // The wording follows from that: this entry is NOT nothing but the rate, so the
    // mixed message fires rather than the rate-only one. The earlier wording named only
    // the rate and said nothing of the fader step refused with it — which is the half
    // this phase is in a position to check, since it is the only route into the guard
    // at all. It also says the step is held back rather than lost; the assertions below
    // are what make that true.
    await mark(page, "undo-rate");
    await page.keyboard.press("Control+z");
    await expect(page.locator("#statusbar")).toContainText("the whole step is held back, not lost");
    await settleAfter(page, "undo-rate", 900, 2000);

    trace = await traceOf(page);
    const undoAt = markTime(trace, "undo-rate")!;
    const afterUndo = deviceIpcAfter(trace, undoAt);
    const depthRefused = await depthOf(page);
    console.log(
      `undo refused: depth ${depthAfter.undo} → ${depthRefused.undo}, ${afterUndo.length} device command(s)` +
        `, rate picker ${await page.locator("#rate-picker").inputValue()}` +
        `, strip readout ${await firstStripReadout(page).textContent()}`,
    );

    // The refusal consumes nothing (invariant 15: the same retry must be able to pass
    // once the condition clears), sends nothing, and rolls nothing back — including the
    // fader step that shared the entry.
    expect(depthRefused).toEqual(depthAfter);
    expect(afterUndo).toHaveLength(0);
    await expect(page.locator("#rate-picker")).toHaveValue(String(EDIT_RATE));
    await expect(firstStripReadout(page)).toHaveText(readoutAfter);

    // Windowed to the phase-B flush and its refused undo: the registration is a
    // snapshot of one instant while the writes span the run, so an unwindowed
    // invariant 12 would count the starting readback's world against this one.
    const regNow = await paramAddrsOf(page);
    // Beside it, for clause B: the write set is never gated by sample rate — the
    // rate-dependent limits in constraints.ts are UI-only, measured on hardware — so a
    // rate change reshapes nothing and the difference is empty. 848 is deliberately
    // outside the plan and is in no snapshot, which is the direction clause B ignores.
    const snapNow = await snapshotOf(page);
    console.log(
      report(
        "sample rate and follow usb",
        analyze(trace, {
          edits: [{ label: "rate + fader in one window", addr: RATE_ADDR, at: rateAt, value: EDIT_RATE }],
          registration: regNow,
          registrationWindow: { from: rateAt, to: undoAt },
          snapshot: snapNow,
        }),
      ),
    );

    // Phase D — the half no other plan scalar has: the device takes the value back on
    // its own. Follow USB is on (phase A), the host is at DEVICE_RATE, so the unit is
    // dragged back off the rate it was just given. `divergeAt` rather than a plain
    // write: the unit now answers that rate however often it is asked, which is what a
    // clock policy the app does not own looks like from here.
    await divergeAt(page, RATE_ADDR, DEVICE_RATE);
    await mark(page, "rate-notify");
    await pushNotify(page, [[766, 0, 0, DEVICE_RATE]]);
    await settleAfter(page, "rate-notify", 1800);

    trace = await traceOf(page);
    const rnAt = markTime(trace, "rate-notify")!;
    const rateCost = fullReadsAfter(trace, rnAt);
    const rateReads = getsOf(trace).filter((g) => g.start > rnAt).length;
    const depthEnd = await depthOf(page);

    console.log(timeline(trace, { from: rnAt - 50, limit: 30 }));
    console.log(
      `one notify on 766 (registered, global, no owner node): ${rateCost} full reconcile(s), ${rateReads} read(s)`,
    );
    console.log(
      `one notify on 848 (intercepted, outside the plan): ${fuFullReads} full reconcile(s), ${fuReads} read(s)`,
    );
    console.log(`undo depth after the reconcile: ${depthEnd.undo}`);

    // The differential. Both are global clock scalars announced the same way; 766 is in
    // the writable set but resolves to no owner NODE, so the settle window escalates to
    // a whole-device read and the idle net (armed by the same notify, and not cancelled
    // by the settle) runs a second one behind it. 848's zero is bought by the intercept
    // hook, which consumes the notify before either timer is armed; a planExternal
    // address with NO hook (758, the second case below) costs nothing for a different
    // reason — its notify never crosses the bridge.
    expect(rateCost).toBe(2);
    expect(rateReads).toBeGreaterThan(1000);
    // The device's rate is now the plan's, on a value the operator explicitly chose
    // against 1.5 s earlier…
    await expect(page.locator("#rate-picker")).toHaveValue(String(DEVICE_RATE));
    // …and the entry that would have said so is gone: a full reflect re-authored the
    // plan from the device, so no earlier entry describes a state it can return to.
    // The refusal in phase C was therefore not a deferral — there is nothing left to
    // retry once the session ends.
    expect(depthEnd).toEqual({ undo: 0, redo: 0 });
  });

  // shape-device-setup-plan-external. The thirteen SETUP > GENERAL addresses share the
  // `planExternal` flag with Follow USB and share none of its handling: no translate
  // emit, no readback group, no registration — and no intercept hook, which is the
  // whole point of measuring them beside 848 rather than on their own.
  //
  // The modal is the only surface they have, and it is locked while live, so the
  // catalog's question "do the modal's own reads disturb a live session" has a
  // structural answer rather than a timing one. What is left to measure is the cost
  // the app pays when the device changes one anyway.
  test("SETUP > GENERAL is never emitted, read back or registered, so its notify never reaches the app", async ({
    page,
  }) => {
    // Phase 1 — the modal, offline (the only state it opens in). Every read it makes
    // must be one of the planExternal addresses and nothing else: this screen IS their
    // whole surface, in the bare vdGet/vdSet shape Follow USB established.
    await page.click("#btn-device");
    await expect(page.locator("#btn-device-setup")).toBeEnabled();
    await mark(page, "setup-open");
    await page.click("#btn-device-setup");
    await expect(page.locator("#device-setup-modal")).toBeVisible();
    await settleAfter(page, "setup-open", 400, 5000);

    let trace = await traceOf(page);
    const openAt = markTime(trace, "setup-open")!;
    const opened = deviceIpcAfter(trace, openAt);
    const numReads = opened.filter((s) => s.cmd === "vd_get").map((s) => paramIdOf(s.addr));
    const strReads = opened.filter((s) => s.cmd === "vd_get_str").map((s) => paramIdOf(s.addr));
    const openWrites = opened.filter((s) => s.cmd === "vd_set" || s.cmd === "vd_set_str");

    console.log(timeline(trace, { from: openAt - 50, limit: 40 }));
    console.log(
      `device setup open: ${numReads.length} vd_get [${[...new Set(numReads)].sort((a, b) => a - b).join(", ")}]` +
        `, ${strReads.length} vd_get_str [${[...new Set(strReads)].join(", ")}], ${openWrites.length} write(s)`,
    );

    // Exactly the ten numeric rows a URX44V has (five globals + two HDMI + three
    // Date/Time), each asked once, and sixteen knob-function strings — and NOTHING
    // else, which is what says the screen cannot reach a plan address even by
    // accident. Both lists are exact, so an extra read anywhere fails them: the knob
    // Parameter 1 / Parameter 2 columns (771 / 772) are absent because this fake
    // answers "" for every string, which is not a catalogued function, so normalizeUdk
    // maps the slot to No Assign and neither column is worth a round trip.
    expect([...numReads].sort((a, b) => a - b)).toEqual([...SETUP_NUMERIC_IDS].sort((a, b) => a - b));
    expect(strReads).toEqual(Array.from({ length: UDK_SLOTS }, () => UDK_FUNCTION_ID));
    // Opening writes nothing: the screen is a batch, and the read is the whole open.
    expect(openWrites).toHaveLength(0);

    // Apply one row. The diff is what is sent, so one changed row is one bare vd_set —
    // no snapshot to re-base, no converge round, no read of any kind behind it.
    await page.locator("#device-setup-brightness").fill("7");
    await page.locator("#device-setup-brightness").dispatchEvent("change");
    await expect(page.locator(".dev-slider .param-val")).toHaveText("7");
    await expect(page.locator("#device-setup-apply")).toBeEnabled();
    await mark(page, "setup-apply");
    await page.click("#device-setup-apply");
    await expect(page.locator("#statusbar")).toContainText("Applied 1 setting to the device");
    await settleAfter(page, "setup-apply", 600, 5000);

    trace = await traceOf(page);
    const applyAt = markTime(trace, "setup-apply")!;
    const applied = deviceIpcAfter(trace, applyAt);
    const applyWrites = applied.filter((s) => s.cmd === "vd_set");
    const onScreen = Number(await page.locator("#device-setup-brightness").inputValue());
    console.log(
      `apply: ${applyWrites.map((s) => `${s.addr}=${s.value}`).join(", ")}` +
        `, ${applied.filter((s) => s.cmd === "vd_get").length} read(s); screen holds ${onScreen}`,
    );

    // One write, carrying what the screen shows — the two are compared to each other,
    // so neither side is restating the other.
    expect(applyWrites).toHaveLength(1);
    expect(applyWrites[0].addr).toBe("758:0:0");
    expect(applyWrites[0].value).toBe(onScreen);
    expect(applied.filter((s) => s.cmd === "vd_get")).toHaveLength(0);

    await page.keyboard.press("Escape");
    await expect(page.locator("#device-setup-modal")).toBeHidden();

    // Phase 2 — the session. None of those addresses may be in the write set, in the
    // registration, or in the starting readback.
    await mark(page, "live-start");
    await goLive(page);
    await setLatency(page, { get: 1, set: 5 });
    const reg = await paramAddrsOf(page);
    const registeredFlagged = [...SETUP_IDS, 848].filter((id) => reg.some((a) => a[0] === id));

    trace = await traceOf(page);
    const liveAt = markTime(trace, "live-start")!;
    const liveReads = getsOf(trace).filter((g) => g.start > liveAt);
    const setupReads = liveReads.filter((g) => SETUP_IDS.includes(paramIdOf(g.addr)));
    const followUsbReads = liveReads.filter((g) => g.addr === FOLLOW_USB_ADDR);

    console.log(
      `live start: ${liveReads.length} read(s); ${setupReads.length} of them on a SETUP address` +
        `, ${followUsbReads.length} on 848. Registered planExternal ids: [${registeredFlagged.join(", ")}]`,
    );

    // The one exception is the one with a hook. Thirteen addresses catalogued beside it
    // with the same flag, and not one of them is registered — so nothing routes their
    // notifies anywhere.
    expect(registeredFlagged).toEqual([848]);
    expect(reg.at(-1)).toEqual([848, 0, 0]);
    // …and no readback group covers them either: a whole-device read of ~800 addresses
    // asks for none of the thirteen. 848 is read once, by the badge refresh the session
    // start makes, which is the same asymmetry seen from the read side.
    expect(setupReads).toHaveLength(0);
    expect(followUsbReads).toHaveLength(1);
    expect(liveReads.length).toBeGreaterThan(500);

    // Phase 3 — the catalog's "do the modal's reads disturb a live session" question,
    // answered structurally: the menu entry rides the same setLiveUi list as Fetch /
    // Write / Compare, and main.ts keeps a second belt behind it. There is no timing to
    // measure because there is no opening.
    await page.click("#btn-device");
    await expect(page.locator("#btn-device-setup")).toBeDisabled();
    await page.click("#btn-device");

    // Phase 4 — the control. One notify, same shape as the probe below, on an address
    // that IS in the plan: CH 1's fader, registered (asserted here, since it is half
    // the differential's premise) and follow:"direct" in params.ts. The only variable
    // between the two is whether the address is in the plan at all.
    expect(reg.map((a) => a.join(":"))).toContain(`${CH1_FADER_ID}:0:0`);
    await waitQuiet(page, 400);
    await mark(page, "control-notify");
    await pushNotify(page, [[CH1_FADER_ID, 0, 0, 20]]);
    await settleAfter(page, "control-notify", 1800);

    trace = await traceOf(page);
    const ctlAt = markTime(trace, "control-notify")!;
    const ctlCost = fullReadsAfter(trace, ctlAt);
    const ctlOwnReads = getsOf(trace).filter((g) => g.addr === "139:0:0" && g.start > ctlAt).length;

    // Phase 5 — the probe. A device-side SETUP change: the operator turns the unit's
    // screen brightness down on its own panel. The verdict is an ABSENCE, so the link
    // is given a chance to WAKE first (settleAfter's grace) and only then to fall quiet.
    await mark(page, "setup-notify");
    const setupWhy = await pushNotify(page, [[758, 0, 0, 3]]);
    await settleAfter(page, "setup-notify", 1800);

    trace = await traceOf(page);
    const setupAt = markTime(trace, "setup-notify")!;
    const setupCost = fullReadsAfter(trace, setupAt);
    const setupSweepReads = getsOf(trace).filter((g) => g.start > setupAt);
    const readsOfTheChange = setupSweepReads.filter((g) => g.addr === "758:0:0");
    const writesOfFlagged = setsOf(trace).filter((s) => s.start > liveAt && SETUP_IDS.includes(paramIdOf(s.addr)));

    console.log(timeline(trace, { from: ctlAt - 50, limit: 30 }));
    console.log(
      `control — one notify on 139:0:0 (registered, direct): ${ctlCost} full reconcile(s), ${ctlOwnReads} read(s) of it`,
    );
    console.log(
      `probe — one notify on 758:0:0 (planExternal, unregistered): refused as "${setupWhy[0]}",` +
        ` ${setupCost} full reconcile(s), ${setupSweepReads.length} read(s)`,
    );
    // 758's refusal is the measurement, so it is declared: clause A reports the notify a
    // case pushed WITHOUT meaning it to be refused, and this one means it.
    console.log(
      report(
        "device setup plan-external",
        // A planExternal address is emitted by nothing, so it is in no snapshot and
        // clause B is correctly blind to it — the very asymmetry this case is about
        // lives on the registration side, which clause B does not judge.
        analyze(trace, {
          registration: [...(await paramAddrsOf(page))],
          registrationWindow: { from: ctlAt },
          expectedDrops: ["758:0:0"],
          snapshot: await snapshotOf(page),
        }),
      ),
    );

    // The control resolves to a node, so the settle window costs no whole-device read
    // and what is left is the idle net's single sweep — which does re-read the address
    // that changed, so the app ends the exchange knowing the device's own value.
    expect(ctlCost).toBe(1);
    expect(ctlOwnReads).toBeGreaterThan(0);
    // The probe never reaches the page at all: 758 is planExternal, so it is in no
    // write set, so it is in no registration, so the bridge drops the notify
    // (src-tauri/src/vd.rs Subs::absorb). Nothing escalates and nothing is read — the
    // app does not pay for the change, and it does not learn about it either. What the
    // same announcement costs on an address that IS delivered but resolves to no owner
    // node is phase D of the case above (766: two reconciles, >1000 reads).
    expect(setupWhy).toEqual(["unregistered"]);
    expect((await notifyDropsOf(page)).filter((d) => d.addr === "758:0:0")).toHaveLength(1);
    expect(setupCost).toBe(0);
    expect(setupSweepReads).toEqual([]);
    expect(readsOfTheChange).toHaveLength(0);
    // Nothing ever writes one of them from a session either: the flush translates the
    // plan, and they are not in it.
    expect(writesOfFlagged).toHaveLength(0);
  });
});
