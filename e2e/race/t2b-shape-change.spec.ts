import { test, expect, type Page } from "@playwright/test";
import { drag, port } from "../graph-helpers";
import {
  installFake,
  goLive,
  mark,
  pushNameNotify,
  memStrOf,
  pushBulkChange,
  traceOf,
  paramAddrsOf,
  setLatency,
  settleAfter,
  waitQuiet,
  divergeAt,
  ignoreWrites,
  refuseAt,
  dialogsOf,
  memOf,
  ledgerOf,
  snapshotOf,
  depthOf,
  hasProbe,
  type TraceEvent,
} from "./fake-device";
import { analyze, report, timeline, markTime, setsOf, getsOf } from "./analyze";
import { CH1_FADER, CH2_FADER, faderOf, faderReadout, graphNode } from "./ui";

// T2b shape-change — the twelve T2 cases t2-shape-change.spec.ts did not reach
// (docs/{en,ja}/live-race-harness.md). Same observables as T2: the `addrs` argument of
// vd_params_subscribe IS the follow registration set, and 766:0:0 is read by a FULL
// readback and by nothing else, so counting reads of that one address counts whole-
// device reconciles exactly.
//
// What this file adds over T2 is the three shapes T2 had no case for:
//   - a write on node A that re-authors node B (Signal Type STEREO),
//   - writes that leave the numeric diff engine entirely (Sweet Spot Data: no snapshot
//     entry, no registration, no side-effect classification. Names left it the same way
//     until they were registered and given a direct follow — see t1d-name-window),
//   - the deliberate NONE sentinel of a routing selector, and the write/read
//     asymmetry of the SD Rec pair that hides a half-applied write.
//
// Read latency is 2 ms throughout, for T2's reason: a whole-device readback is ~800
// sequential reads and several cases here provoke two or three of them. Nothing below
// is a timing verdict — every assertion is about which IPC happened, in what order,
// and against which registered address set.

/** SIGNAL_TYPE (23) is written to BOTH channels of the MONO IN pair. */
const CH1_SIGNAL_TYPE = "23:0:0";
const CH2_SIGNAL_TYPE = "23:0:1";
/** PAN_BAL (891) lives on the pair's PRIMARY channel alone. */
const CH1_PAN_BAL = "891:0:0";
/** CH SETTING name for a MONO IN channel: a STRING param (translate.ts NAME_PARAM),
 *  outside the numeric catalog entirely. */
const CH1_NAME = "18:0:0";
/** SSMCS Sweet Spot Data: has a PARAMS entry but rides planToNameWrites / vd_set_str. */
const CH1_SWEET_SPOT = "91:0:0";
/** SSMCS Morphing — a numeric SSMCS param the device recomputes from a preset pick. */
const CH1_SSMCS_MORPHING = "93:0:0";
const USB_A_L = "732:0:0";
const USB_A_R = "732:0:1";
/** bus.stereo's L/R port refs (translate.ts BUS_PORTS) and the "no source" sentinel. */
const STEREO_PORT_L = 256;
const STEREO_PORT_R = 257;
const PORT_REF_NONE = 0xffffffff;
const SD_REC_SOURCE = 736;
const SD_TRACK_COUNT = "839:0:0";
/** ch1 → FX 1 send tap: the broker reports max_value 0, so sendTapWritable is false. */
const CH1_FX1_TAP = "193:0:0";
/** The 4-band PEQ's filter-type slots. LOW (50) and HIGH (65) carry one; the two mid
 *  bands are fixed Peaking, so EqBandControl.type is null and 55 / 60 are never sent. */
const EQ_LOW_TYPE = "50:0:0";
const EQ_HIGH_TYPE = "65:0:0";
const EQ_MID_TYPES = ["55:0:0", "60:0:0"];

const regKeys = (addrs: Array<[number, number, number]>): Set<string> => new Set(addrs.map((a) => a.join(":")));

const setsAfter = (trace: TraceEvent[], at: number): ReturnType<typeof setsOf> =>
  setsOf(trace).filter((s) => s.start > at);

const param = (page: Page, label: string) => page.locator("#inspector .param", { hasText: label });
/** A .param whose label is EXACTLY `label` — "Name" must not match a longer label. */
const paramExact = (page: Page, label: string) =>
  page.locator("#inspector .param", { has: page.getByText(label, { exact: true }) });

/** Reset the probe's ledger so a phase's writers can be read without the initial
 *  readback's thousand entries in front of them. The probe's clock and the fake's are
 *  different origins, so windowing the ledger by a trace mark is not available. */
const clearLedger = (page: Page): Promise<void> =>
  page.evaluate(() => (window as unknown as { __urxTrace?: { clear: () => void } }).__urxTrace?.clear());

/**
 * Step the first `n` console faders synchronously, so every edit lands inside one
 * 120 ms throttle window and the flush that follows has a send loop long enough to
 * interrupt. Returns how many were actually stepped.
 */
const armMultiEdit = (page: Page, n: number): Promise<number> =>
  page.evaluate((count) => {
    const faders = [...document.querySelectorAll<HTMLElement>(".con-fader")].slice(0, count);
    for (const f of faders) {
      f.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    }
    return faders.length;
  }, n);

test.describe("T2b shape-change", () => {
  test.beforeEach(async ({ page }) => {
    await installFake(page);
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  // shape-signal-type-pair-link. The only parameter whose write resets an entire
  // OTHER node on the device — and, mirroring that, the only plan edit whose funnel
  // re-authors a second node's whole nodeParams record. Both halves are measured: the
  // wire (SIGNAL_TYPE at two indices, the partner's own addresses re-sent) and the
  // ledger (who wrote nodeParams[ch2]).
  test("Signal Type STEREO writes both pair indices and re-authors the partner node", async ({ page }) => {
    expect(await hasProbe(page)).toBe(true);
    await goLive(page);
    await setLatency(page, { get: 1, set: 5 });

    // Give the two channels distinct fader values first, so the partner's re-author is
    // visible on the wire rather than only in the plan: without this, ch2 already
    // equals ch1 and the mirror emits nothing.
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 2")).toBeVisible();
    await faderOf(page, "CH 2").focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowUp");
    await waitQuiet(page, 600);
    const ch1Before = (await faderReadout(page, "CH 1").textContent())!;
    const ch2Before = (await faderReadout(page, "CH 2").textContent())!;
    expect(ch2Before).not.toBe(ch1Before);
    // What the device was actually given for the partner, so the re-author below is a
    // change of value on the wire rather than a repeat of what it already held.
    const ch2OnDevice = (await memOf(page))[CH2_FADER];
    expect(ch2OnDevice).toBeDefined();

    // The device holds its own value for the partner's fader whatever is written to it:
    // the converge round can then be asked whether it REPAIRS the plan from the device
    // (it does not — it re-sends the app's value) rather than only whether it runs.
    await divergeAt(page, CH2_FADER, 20);

    await page.click("#btn-view-graph");
    await graphNode(page, "ch1").click();
    const signalSel = param(page, "Signal Type").locator("select");
    await expect(signalSel).toHaveValue("0"); // MONO x 2
    await clearLedger(page);
    const depthBefore = await depthOf(page);

    await mark(page, "stereo-link");
    await signalSel.selectOption("1"); // STEREO
    await expect(param(page, "PAN / BAL")).toHaveCount(1);
    await settleAfter(page, "stereo-link", 1500);

    let trace = await traceOf(page);
    const linkAt = markTime(trace, "stereo-link")!;
    const emitted = setsAfter(trace, linkAt);
    const byAddr = new Map(emitted.map((s) => [s.addr!, s.value]));
    const ledger = await ledgerOf(page);
    const uiPartner = ledger.filter((l) => l.source === "ui" && l.field === "nodeParams" && l.key === "ch2");
    const depthAfter = await depthOf(page);

    console.log(timeline(trace, { from: linkAt - 50, limit: 60 }));
    console.log(
      `link emitted: 23:0:0=${byAddr.get(CH1_SIGNAL_TYPE)} 23:0:1=${byAddr.get(CH2_SIGNAL_TYPE)}` +
        ` 891:0:0=${byAddr.get(CH1_PAN_BAL)} ch2 fader(139:0:1)=${byAddr.get(CH2_FADER)}`,
    );
    console.log(
      `ledger for this gesture: ${ledger
        .filter((l) => l.source === "ui")
        .map((l) => `${l.field}${l.key ? `[${l.key}]` : ""}`)
        .join(", ")}`,
    );
    console.log(`undo depth ${depthBefore.undo} → ${depthAfter.undo}`);

    // Both indices of the pair carry the link — the plan key lives on the primary,
    // the device address does not.
    expect(byAddr.get(CH1_SIGNAL_TYPE)).toBe(1);
    expect(byAddr.get(CH2_SIGNAL_TYPE)).toBe(1);
    // PAN / BAL is written at the PRIMARY index only: applyPairTransition set BAL as
    // part of the same funnel call, before markChanged.
    expect(byAddr.get(CH1_PAN_BAL)).toBe(1);
    expect(byAddr.has("891:0:1")).toBe(false);
    // The partner's own fader address is re-sent with the primary's value. One control
    // change on ch1, and a second channel's mixer state left for the device — while the
    // primary's own fader is not written at all, because it did not move.
    expect(byAddr.get(CH2_FADER)).toBeDefined();
    expect(byAddr.get(CH2_FADER)).not.toBe(ch2OnDevice);
    expect(byAddr.has(CH1_FADER)).toBe(false);
    // …and the ledger names the writer: the operator, not a readback. The plan write on
    // ch2 is part of the same gesture, which is why one undo entry can revert it.
    expect(uiPartner.length).toBeGreaterThan(0);
    expect(depthAfter.undo - depthBefore.undo).toBe(1);

    // The converge is a re-SEND, not a repair. The device reports its own value for the
    // partner's fader on every read, so the converge's diff sees it every round and
    // pushes the app's value back — the plan is never told what the unit holds.
    const partnerWrites = emitted.filter((s) => s.addr === CH2_FADER);
    const readsBetween = getsOf(trace).filter(
      (g) => g.addr === CH2_FADER && g.start > partnerWrites[0].start && g.start < (partnerWrites.at(-1)?.start ?? 0),
    );
    await page.click("#btn-view-console");
    const ch2Linked = (await faderReadout(page, "CH 2").textContent())!;
    const ch1Linked = (await faderReadout(page, "CH 1").textContent())!;
    await page.click("#btn-view-graph");
    console.log(
      `partner fader: ${partnerWrites.length} write(s) after the link, ${readsBetween.length} read(s) in between;` +
        ` CH 2 now reads ${ch2Linked} (CH 1 reads ${ch1Linked}, device answers 20 on every read)`,
    );
    // PINNED — this is the defect the case exists for: a converge round re-reads the
    // device and, finding the partner different, sends the app's value again instead of
    // adopting the device's. Nothing in the flush path carries a device value into the
    // plan, so a channel the unit reset stays wrong until an unrelated full reconcile.
    expect(partnerWrites.length).toBeGreaterThan(1);
    expect(readsBetween.length).toBeGreaterThan(0);
    // The plan took the primary's value, not the device's — the converge read every one
    // of those addresses and carried none of them back.
    expect(ch2Linked).toBe(ch1Linked);

    // One Ctrl+Z takes the link, the PAN/BAL transition and the partner's re-authored
    // params back together — the diff is taken at the commit, so everything the funnel
    // did after markChanged is inside the one entry.
    await mark(page, "undo");
    await page.keyboard.press("Control+z");
    await expect(param(page, "Signal Type").locator("select")).toHaveValue("0");
    await expect(param(page, "PAN / BAL")).toHaveCount(0);
    await settleAfter(page, "undo", 1500);

    await page.click("#btn-view-console");
    const ch2After = (await faderReadout(page, "CH 2").textContent())!;
    trace = await traceOf(page);
    const undoAt = markTime(trace, "undo")!;
    const undoWrites = new Map(setsAfter(trace, undoAt).map((s) => [s.addr!, s.value]));
    console.log(
      `undo emitted 23:0:0=${undoWrites.get(CH1_SIGNAL_TYPE)} 23:0:1=${undoWrites.get(CH2_SIGNAL_TYPE)};` +
        ` CH 2 readout ${ch2Before} → (linked) → ${ch2After}`,
    );
    // Windowed against the snapshot that describes it: the registration is one instant
    // and the writes span the run, so an unwindowed invariant 12 counts writes that were
    // perfectly well registered when they were sent (analyze.ts says so in its header).
    console.log(
      report(
        "signal type pair link",
        // Invariant 6's clause B is a state predicate and takes the pair as it stands
        // NOW, after the undo: the STEREO link put PAN/BAL into the emitted set and the
        // undo took it back out, so the window the link opened is already shut and the
        // difference is empty. The pair is deliberately not captured at linkAt — the
        // registration handed over is the end-of-run one, and clause B may only be given
        // two readings from one instant.
        analyze(trace, {
          registration: [...(await paramAddrsOf(page))],
          registrationWindow: { from: linkAt },
          snapshot: await snapshotOf(page),
        }),
      ),
    );

    // The whole bank of consequences reverts as one, and the revert is itself a device
    // write at both indices.
    expect(undoWrites.get(CH1_SIGNAL_TYPE)).toBe(0);
    expect(undoWrites.get(CH2_SIGNAL_TYPE)).toBe(0);
    expect(ch2After).toBe(ch2Before);
  });

  // shape-string-path-writes. Names and Sweet Spot Data leave through vd_set_str, which
  // has no numeric snapshot entry and no sideEffect classification.
  //
  // PINNED DEFECT, NOW RESOLVED ON BOTH HALVES — rewritten rather than deleted, twice,
  // which is the rule for a pin whose subject changed.
  //
  // It first asserted that NEITHER address was registered and concluded "a rename cannot
  // be followed". That was true of the app and not of the unit: the URX announces a
  // rename (measured on a URX44V), and the app had simply never registered the address,
  // so `Subs::absorb` dropped it. Names were registered and the name half flipped.
  //
  // Sweet Spot Data has now gone the same way, and for the same reason: the unit
  // announces a preset write on its own address FIRST, 0.319 ms ahead of the seventeen
  // strip values it recomputes (measured). What was missing was again the app — the
  // string path emitted no owner and consulted no sideEffect set, so the catalog could
  // not classify the write and nothing repaired the plan. It is a `refetch` head now, so
  // this case pins the repair rather than its absence. What is UNCHANGED, and still worth
  // a line, is that the string path has no numeric snapshot entry.
  test("Sweet Spot Data is registered and repaired, and still has no numeric snapshot entry", async ({ page }) => {
    expect(await hasProbe(page)).toBe(true);
    await goLive(page);
    await graphNode(page, "ch1").click();
    await setLatency(page, { get: 2, set: 25, setStr: 25, getStr: 25 });

    const regAtStart = regKeys(await paramAddrsOf(page));
    // The name IS registered now, which is what makes a rename made on the unit reach
    // the app at all. Asserted rather than dropped: if it ever stops being registered,
    // renames go silently unfollowed again and only this line would say so.
    expect(regAtStart.has(CH1_NAME)).toBe(true);
    // Sweet Spot Data is not registered YET — the plan has no preset until the channel is
    // in SSMCS mode, so this is the mode gate rather than the old blanket absence. Phase 3
    // switches the mode and asserts it appears.
    expect(regAtStart.has(CH1_SWEET_SPOT)).toBe(false);

    // Phase 1 — eight characters at 90 ms, then a blur. The idle backstop is suppressed
    // while a text field has focus, so the focusout is the gesture's only boundary.
    const nameInput = paramExact(page, "Name").locator('input[type="text"]');
    await expect(nameInput).toHaveCount(1);
    await nameInput.click();
    // The click's own commit is deferred one macrotask (a click handler may still edit
    // the plan on that gesture's behalf), so typing started immediately would put the
    // first character inside the CLICK's entry and produce two entries for one typing
    // gesture. Measured: with this settle the burst is one entry, without it two. That
    // is a property of the driver, not of the app — the operator's hand cannot type a
    // character inside the same macrotask as the click that focused the field.
    await page.waitForTimeout(400);
    const depthBefore = await depthOf(page);
    await mark(page, "rename");
    // The achieved keystroke intervals, taken in the page. The requested 90 ms is what
    // the driver asks for; what decides the write count is what the field received, and
    // a burst whose gaps have all grown past the 120 ms flush window is a different
    // experiment from this one (one write per character rather than per window).
    await nameInput.evaluate((el) => {
      const at: number[] = [];
      (window as unknown as { __keyAt: number[] }).__keyAt = at;
      el.addEventListener("keydown", () => at.push(performance.now()));
    });
    await nameInput.pressSequentially("VOX LEAD", { delay: 90 });
    const keyGaps = await page.evaluate(() => {
      const at = (window as unknown as { __keyAt: number[] }).__keyAt;
      return at.slice(1).map((t, i) => +(t - at[i]).toFixed(1));
    });
    const depthTyped = await depthOf(page);
    await nameInput.evaluate((el) => (el as HTMLInputElement).blur());
    const depthBlurred = await depthOf(page);
    await settleAfter(page, "rename", 1200);

    let trace = await traceOf(page);
    const renameAt = markTime(trace, "rename")!;
    const strWrites = trace.filter(
      (e) => e.kind === "ipc-start" && e.cmd === "vd_set_str" && e.t > renameAt && e.addr === CH1_NAME,
    );
    const numericOnName = setsAfter(trace, renameAt).filter((s) => s.addr === CH1_NAME);
    const snapshot = await snapshotOf(page);
    const depthAfter = await depthOf(page);

    console.log(timeline(trace, { from: renameAt - 50, limit: 40 }));
    console.log(
      `rename: ${strWrites.length} vd_set_str on ${CH1_NAME} for 8 keystrokes, ${numericOnName.length} vd_set;` +
        ` snapshot entry = ${snapshot?.[CH1_NAME]}; undo depth ${depthBefore.undo} → typed ${depthTyped.undo}` +
        ` → blurred ${depthBlurred.undo} → settled ${depthAfter.undo};` +
        ` achieved keystroke gaps max ${Math.max(...keyGaps).toFixed(0)} ms (requested 90, flush window 120)`,
    );

    // The achieved gaps are printed above rather than asserted, and the reason is worth
    // keeping: they are NOT what decides this case. At 12x CPU throttling the undo half
    // breaks (typed 4 → settled 0 instead of 1) with a max gap of 152 ms, while at 6x it
    // passes with a LARGER one, 188 ms. A guard on the gap would therefore have turned a
    // case that is correct at CI-equivalent load red, and named the wrong cause while
    // doing it. What actually happens at 12x is open — reference/work/e2e-flakes.md.
    //
    // The string path is throttled by the flush window like everything else, but it is
    // NOT coalesced by the gesture: eight keystrokes 90 ms apart leave as one write per
    // 120 ms window, so partial names ("VOX", "VOX L", …) reach the unit. Measured 4 —
    // pinned as a range, since the exact count is the window arithmetic, but a
    // per-keystroke path (8) and a per-gesture path (1) are both excluded.
    expect(strWrites.length).toBeGreaterThan(1);
    expect(strWrites.length).toBeLessThan(8);
    expect(numericOnName).toHaveLength(0);
    expect(snapshot?.[CH1_NAME]).toBeUndefined();
    // One typing gesture, one undo entry: the field's focusout is its only boundary
    // (the 300 ms idle backstop is suppressed while a text surface has focus, and the
    // Space in "VOX LEAD" is a BOUNDARY_KEY that ownsNativeUndo exempts inside a text
    // input — both are what keep eight keystrokes from costing eight entries).
    //
    // It also catches something further away, and did: the unit ANNOUNCES every name
    // write it takes, so these four writes echo back. Counting an echo as a followed
    // change armed the idle full reconcile, whose reflect ends in planHistory.reset()
    // — measured here as 0 entries and an ~800-read sweep 900 ms after the last
    // keystroke. The fake modelled no announcement at all until then, which is the only
    // reason a rename looked free. See follow.ts's string branch.
    expect(depthAfter.undo - depthBefore.undo).toBe(1);
    expect(regKeys(await paramAddrsOf(page)).has(CH1_NAME)).toBe(true);

    // Phase 2 — the device's own rename, which the app now FOLLOWS. This phase used to
    // pin the opposite and is rewritten rather than deleted: the name addresses were in
    // no registration, so the bridge dropped the one notify a rename broadcasts (the
    // unit does send it — measured on a URX44V), nothing escalated, and the value was
    // only ever discovered by an unrelated sweep. Registering the addresses turned that
    // into a direct follow. The behaviour itself is owned by `t1d-name-window`; what is
    // pinned HERE is that this case's own subject — the string path — is no longer
    // uniformly unfollowed, so a future reader does not take the Sweet Spot half as a
    // statement about names too.
    await mark(page, "name-notify");
    const nameWhy = await pushNameNotify(page, CH1_NAME, "DESK 3");
    // Short on purpose: under the 900 ms idle net, which arms after ANY followed
    // notify (numeric ones included) and is not something the name path introduces.
    // Measuring inside that window is what makes "direct" a strict claim — the value
    // is in the plan before anything could have re-read it.
    await settleAfter(page, "name-notify", 400);
    trace = await traceOf(page);
    const notifyAt = markTime(trace, "name-notify")!;
    // "Direct" is asserted as "no READ carried it", not as a reconcile count: this case
    // is long and other phases provoke sweeps of their own, so a count here would be a
    // property of the case rather than of the name path. The value can only have come
    // from the notify — the fake's stored name is still what phase 1 typed, so a read
    // would have produced THAT instead.
    const nameStrReads = trace.filter(
      (e) => e.kind === "ipc-start" && e.cmd === "vd_get_str" && e.addr === CH1_NAME && e.t > notifyAt,
    );
    const nameNow = await paramExact(page, "Name").locator('input[type="text"]').inputValue();
    console.log(
      `name notify: verdict "${nameWhy[0]}", ${nameStrReads.length} vd_get_str on the name; field "${nameNow}"`,
    );
    expect(nameWhy).toEqual([""]);
    expect(nameNow).toBe("DESK 3");
    // The unit holds what it announced (pushNameNotify stores it, as a real rename
    // does), so nothing here rests on a device state that cannot exist.
    expect((await memStrOf(page))[CH1_NAME]).toBe("DESK 3");

    // Phase 3 — Sweet Spot Data. SSMCS mode first (COMP_EQ_TYPE is a converge param and
    // is the control case here: it DOES classify), then the preset, which does not.
    await mark(page, "to-ssmcs");
    await param(page, "COMP/EQ Type").locator("select").selectOption("1");
    await expect(param(page, "Sweet Spot Data")).toHaveCount(1);
    await settleAfter(page, "to-ssmcs", 1800);

    // The device recomputes the strip from the preset, so the plan and the unit disagree on
    // a numeric SSMCS param until something reads. Only a READ can discover it, which is
    // what the assertions below price — the preset write now schedules one.
    await divergeAt(page, CH1_SSMCS_MORPHING, 77);
    const regBeforePreset = regKeys(await paramAddrsOf(page));
    await mark(page, "sweet-spot");
    await param(page, "Sweet Spot Data").locator("select").selectOption("9");
    await settleAfter(page, "sweet-spot", 1500);

    trace = await traceOf(page);
    const presetAt = markTime(trace, "sweet-spot")!;
    const presetStr = trace.filter(
      (e) => e.kind === "ipc-start" && e.cmd === "vd_set_str" && e.addr === CH1_SWEET_SPOT && e.t > presetAt,
    );
    const presetReads = getsOf(trace).filter((g) => g.start > presetAt);
    const snapAfter = await snapshotOf(page);

    console.log(timeline(trace, { from: presetAt - 50, limit: 40 }));
    console.log(
      `sweet spot: ${presetStr.length} vd_set_str on ${CH1_SWEET_SPOT}, ${presetReads.length} read(s) after it;` +
        ` snapshot entry = ${snapAfter?.[CH1_SWEET_SPOT]}; registered = ${regBeforePreset.has(CH1_SWEET_SPOT)}`,
    );
    console.log(
      report(
        "string path writes",
        analyze(trace, {
          registration: [...(await paramAddrsOf(page))],
          registrationWindow: { from: presetAt },
          snapshot: snapAfter,
        }),
      ),
    );

    // One write, and a read that follows it. The read is what the `refetch` declaration
    // buys: the device rewrote the strip, and the plan now finds out.
    expect(presetStr.length).toBe(1);
    expect(presetReads.length).toBeGreaterThan(0);
    // SCOPED, not a whole-device sweep — the repair is one node's worth. The bound is set
    // against the converge control below, which reads the write scope and is an order of
    // magnitude larger; a full reconcile arriving here instead would fail this.
    expect(presetReads.length).toBeLessThan(200);
    // STILL NOT REGISTERED, and the finding is wider than this param: the numeric SSMCS
    // addresses the same mode change added are not registered either. The registration set
    // is rebuilt on capture but only re-SUBSCRIBED after a reconcile, so an address the
    // plan grew from an app-side edit stays unheard until one runs. Two consequences, both
    // pinned here: the flush's settle for a preset write resolves at its bound rather than
    // on the unit's own announcement, and a preset changed ON the unit is not followed.
    // The repair above does not depend on either — it is scheduled by the declaration.
    expect(regBeforePreset.has(CH1_SWEET_SPOT)).toBe(false);
    expect(regBeforePreset.has(CH1_SSMCS_MORPHING)).toBe(false);
    // UNCHANGED and still the string path's own property: no numeric snapshot entry. The
    // snapshot is built from the numeric emit, which this write is not part of.
    expect(snapAfter?.[CH1_SWEET_SPOT]).toBeUndefined();
    // The control keeps its job, now as a scale rather than as a contrast: COMP/EQ Type is
    // a numeric CONVERGE param on the same node, and a converge reads the whole write
    // scope where a refetch reads one node.
    const ssmcsAt = markTime(trace, "to-ssmcs")!;
    const convergeReads = getsOf(trace).filter((g) => g.start > ssmcsAt && g.start < presetAt);
    console.log(`control — COMP/EQ Type (numeric, converge) read ${convergeReads.length} address(es)`);
    expect(convergeReads.length).toBeGreaterThan(100);
    expect(presetReads.length).toBeLessThan(convergeReads.length);
  });

  // shape-routing-wire-selectors, reachable portion. The catalog pairs the deliberate
  // NONE sentinel with the accidental "hole" (a wire whose source resolves to no port:
  // no write, no snapshot entry, no registration). The hole is UNREACHABLE on this
  // model — every source the routing rules allow into a selector is a bus in BUS_PORTS
  // or a channel with input slots, so `sourcePorts` never returns null for a wire the
  // UI can author. What is reachable is the sentinel itself and the second asymmetry
  // named in the case: the SD Rec pair is written twice and read once.
  test("deleting a routing wire writes the NONE sentinel, and the SD Rec pair is written twice but read once", async ({
    page,
  }) => {
    // The unit reports 16 record tracks (raw 8 × 2), so all eight track-pair slot nodes
    // are on the canvas with their seeded record wires. The fake's default 0 would make
    // the readback set the count to zero and the slots would not be rendered at all.
    await divergeAt(page, SD_TRACK_COUNT, 8);
    await goLive(page);
    await setLatency(page, { get: 2, set: 25 });

    const regBefore = regKeys(await paramAddrsOf(page));
    expect(regBefore.has(USB_A_L)).toBe(true);
    expect(regBefore.has(USB_A_R)).toBe(true);

    // Phase 1 — delete the seeded bus.stereo → USB MAIN OUT A patch wire. A selector
    // with no wire is not silence: it writes the sentinel, at BOTH slots, so the device
    // is actively cleared.
    await port(page, "out.usbmain_a:in").click();
    await mark(page, "delete-usb-a");
    await page.keyboard.press("Delete");
    await expect(page.locator("#statusbar")).toHaveText("Connection deleted");
    await settleAfter(page, "delete-usb-a", 1200);

    let trace = await traceOf(page);
    const delAt = markTime(trace, "delete-usb-a")!;
    const delWrites = new Map(setsAfter(trace, delAt).map((s) => [s.addr!, s.value]));
    const regAfterDelete = regKeys(await paramAddrsOf(page));
    console.log(timeline(trace, { from: delAt - 50, limit: 40 }));
    console.log(`delete emitted 732:0:0=${delWrites.get(USB_A_L)} 732:0:1=${delWrites.get(USB_A_R)}`);

    expect(delWrites.get(USB_A_L)).toBe(PORT_REF_NONE);
    expect(delWrites.get(USB_A_R)).toBe(PORT_REF_NONE);
    // The address stays in the write set with no wire, so it stays followable — which is
    // exactly what distinguishes the sentinel from a hole.
    expect(regAfterDelete.has(USB_A_L)).toBe(true);
    expect(regAfterDelete.has(USB_A_R)).toBe(true);

    // Phase 2 — recreate it by dragging. The port refs come back, both slots, one flush.
    await mark(page, "recreate-usb-a");
    await drag(page, port(page, "bus.stereo:out"), port(page, "out.usbmain_a:in"));
    await expect(page.locator("#statusbar")).toHaveText("Connected");
    await settleAfter(page, "recreate-usb-a", 1200);

    trace = await traceOf(page);
    const reAt = markTime(trace, "recreate-usb-a")!;
    const reWrites = new Map(setsAfter(trace, reAt).map((s) => [s.addr!, s.value]));
    console.log(`recreate emitted 732:0:0=${reWrites.get(USB_A_L)} 732:0:1=${reWrites.get(USB_A_R)}`);
    expect(reWrites.get(USB_A_L)).toBe(STEREO_PORT_L);
    expect(reWrites.get(USB_A_R)).toBe(STEREO_PORT_R);

    // Phase 3 — the SD Rec record wire, the one selector whose write and read disagree
    // in SHAPE rather than in value: translate emits both track indices of a pair,
    // readback.ts reads trackL only. A pair that half-applied on the device is therefore
    // invisible to every read the app makes. Driven by deleting the seeded ch1 → track
    // 1/2 record wire, which is also the sentinel again on a second wire KIND.
    // Selected through the wire band rather than the slot's port: the record wires run
    // over one another and the overlapping hit bands intercept a real click (the reason
    // every SD Rec spec in e2e/ does the same). The matching pointerup is dispatched
    // too — a pointerdown with no pointerup leaves the history's press latch "down" for
    // good, which silently disables the 300 ms idle commit for the rest of the run.
    const recWire = page.locator('.wire-hit[data-from="ch1:out"][data-to="out.sdrec.t1:in"]');
    await expect(recWire).toHaveCount(1);
    await recWire.dispatchEvent("pointerdown");
    await recWire.dispatchEvent("pointerup");
    await mark(page, "delete-record");
    await page.keyboard.press("Delete");
    await expect(page.locator("#statusbar")).toHaveText("Connection deleted");
    await settleAfter(page, "delete-record", 1200);

    trace = await traceOf(page);
    const recAt = markTime(trace, "delete-record")!;
    const recWrites = new Map(setsAfter(trace, recAt).map((s) => [s.addr!, s.value]));
    console.log(`record wire delete emitted: ${[...recWrites].map(([a, v]) => `${a}=${v}`).join(", ") || "(nothing)"}`);
    expect(recWrites.get(`${SD_REC_SOURCE}:0:0`)).toBe(PORT_REF_NONE);
    expect(recWrites.get(`${SD_REC_SOURCE}:0:1`)).toBe(PORT_REF_NONE);

    const sdWritten = new Set(
      setsOf(trace)
        .filter((s) => s.addr?.startsWith(`${SD_REC_SOURCE}:`))
        .map((s) => Number(s.addr!.split(":")[2])),
    );
    const sdRead = new Set(
      getsOf(trace)
        .filter((g) => g.addr?.startsWith(`${SD_REC_SOURCE}:`))
        .map((g) => Number(g.addr!.split(":")[2])),
    );
    const regNow = regKeys(await paramAddrsOf(page));
    const oddRegistered = [...sdWritten].filter((y) => y % 2 === 1 && regNow.has(`${SD_REC_SOURCE}:0:${y}`));
    console.log(
      `SD Rec source: track indices written = [${[...sdWritten].sort((a, b) => a - b).join(", ")}],` +
        ` read = [${[...sdRead].sort((a, b) => a - b).join(", ")}]`,
    );
    console.log(
      report(
        "routing wire selectors",
        // A deleted wire writes the NONE sentinel to an address that STAYS in the
        // emitted set (the case asserts the odd half is registered all the same), so a
        // selector shrinks nothing and grows nothing: clause B is silent.
        analyze(trace, {
          registration: [...(await paramAddrsOf(page))],
          registrationWindow: { from: delAt },
          snapshot: await snapshotOf(page),
        }),
      ),
    );

    // Both halves of every pair are written…
    expect([...sdWritten].some((y) => y % 2 === 1)).toBe(true);
    // …only the even half is ever read…
    expect(sdRead.size).toBeGreaterThan(0);
    expect([...sdRead].every((y) => y % 2 === 0)).toBe(true);
    // …and the odd half is registered all the same, so the app would hear a device-side
    // change to it and then reconcile with a read that cannot see it.
    expect(oddRegistered.length).toBeGreaterThan(0);
  });

  // shape-routing-wire-selectors, the unresolvable-source HOLE.
  //
  // NOT REACHABLE, and that is the result rather than a gap in the driver. `sourcePorts`
  // returns null only for a node that is neither in BUS_PORTS nor a channel with input
  // slots, and models/build.ts admits nothing else as the source of a routing selector:
  // USB out / analog patch take bus.stereo|stream|mix1|mix2 or a channel, monitor and
  // streaming take bus.stereo|mix1|mix2, ducker keys take channels or those buses, SD
  // Rec takes channels or those buses, and every channel input source is an in.* node
  // that INPUT_PORTS covers. Authoring the wire out of band (a hand-built `?plan=` or a
  // plan file) does not reach it either: validatePlan rejects a wire with no matching
  // routing rule before the plan is adopted, so the load report is what would be
  // measured, not the selector.
  test.skip("an unresolvable wire source produces a silent hole", () => {});

  // shape-refused-and-acked-writes. The three refusal shapes in one session: never
  // emitted at all, accepted-and-discarded, and response code 400. T5 measures a
  // TRANSPORT rejection in the offline Write flow, where a retry is offered; this one
  // measures the 400 inside a LIVE flush, where there is no retry and the session
  // itself is what ends.
  test("never-emitted, acked-and-ignored and 400-refused writes, and the flush loop that does not form", async ({
    page,
  }) => {
    // The device accepts every write to CH_FADER and stores none of them — the unit's
    // clock shape, applied to an address the UI can actually drive.
    await ignoreWrites(page, [139]);
    await goLive(page);
    await setLatency(page, { get: 2, set: 8 });
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();

    // Phase 1 — never emitted. Three different reasons: the CH → FX send tap is read-only
    // on the device (sendTapWritable), the two mid PEQ bands have no filter-type control
    // at all (EqBandControl.type is null), and the SD Rec track count is front-panel only.
    // None of the three is ever written — asserted over the whole run at the foot of this
    // case, which is the subject here.
    //
    // Registration is now a SEPARATE question, and this is where that split is pinned:
    // the write set used to define it, so "never emitted" implied "never followed". Two
    // of the three are registered anyway, because the unit announces them (measured on a
    // URX44V, 2026-08-11) and a value it announces to nobody is one the panel can change
    // with no effect on screen. The mid PEQ types are not: no control exists to change
    // them on either side.
    const reg = regKeys(await paramAddrsOf(page));
    const neverEmitted = [CH1_FX1_TAP, ...EQ_MID_TYPES, SD_TRACK_COUNT];
    console.log(`never-emitted addresses registered: ${neverEmitted.filter((a) => reg.has(a)).join(", ") || "(none)"}`);
    expect(reg.has(CH1_FX1_TAP)).toBe(true);
    expect(reg.has(SD_TRACK_COUNT)).toBe(true);
    for (const a of EQ_MID_TYPES) expect(reg.has(a)).toBe(false);
    // The differential that makes the line above a statement about the mid bands rather
    // than about PEQ addresses in general: the bands that DO carry a filter type are in
    // the set.
    expect(reg.has(EQ_LOW_TYPE)).toBe(true);
    expect(reg.has(EQ_HIGH_TYPE)).toBe(true);

    // Phase 2 — accepted and discarded, and the flush loop that could form around it.
    // The edit is sent once; the device acks and keeps nothing. Then the address-free
    // bulk-change sentinel (see the call below) forces a whole-device reconcile,
    // which reads the fader back as the device never-changed value and pulls the plan
    // to it. If the resync ordering were wrong, that would re-open the same diff every
    // time and the pair would ping-pong for the rest of the session.
    const before = (await faderReadout(page, "CH 1").textContent())!;
    await mark(page, "ignored-write");
    await faderOf(page, "CH 1").focus();
    await page.keyboard.press("ArrowUp");
    const edited = (await faderReadout(page, "CH 1").textContent())!;
    expect(edited).not.toBe(before);
    await settleAfter(page, "ignored-write", 1200);

    let trace = await traceOf(page);
    const ignoredAt = markTime(trace, "ignored-write")!;
    const firstSend = setsOf(trace).filter((s) => s.addr === CH1_FADER && s.start > ignoredAt);
    console.log(
      `accepted-and-ignored: ${firstSend.length} write(s), device holds ${(await memOf(page))[CH1_FADER]}` +
        `, screen shows ${await faderReadout(page, "CH 1").textContent()}`,
    );
    // One command left, and the app treated the ack as success: the screen keeps the
    // operator's value with nothing on the unit behind it. (That the fake stored
    // nothing is its own configuration, not a result, so it is logged and not asserted.)
    expect(firstSend).toHaveLength(1);
    expect(await faderReadout(page, "CH 1").textContent()).not.toBe("0.0");

    await mark(page, "forced-reconcile");
    // The sentinel is the address-free way to force one whole-device reconcile: it
    // belongs to no address, so it is the one notify the bridge forwards whatever the
    // session registered (src-tauri/src/vd.rs Subs::absorb).
    await pushBulkChange(page);
    await settleAfter(page, "forced-reconcile", 2500);
    await mark(page, "loop-window");
    await page.waitForTimeout(5000);

    trace = await traceOf(page);
    const reconcileAt = markTime(trace, "forced-reconcile")!;
    const loopAt = markTime(trace, "loop-window")!;
    const afterReconcile = setsOf(trace).filter((s) => s.addr === CH1_FADER && s.start > reconcileAt);
    const idleTraffic = setsOf(trace).filter((s) => s.start > loopAt);
    console.log(timeline(trace, { from: reconcileAt - 50, limit: 40 }));
    console.log(
      `after the forced reconcile: ${afterReconcile.length} further write(s) to ${CH1_FADER};` +
        ` ${idleTraffic.length} write(s) in a 5 s idle window; screen shows ` +
        `${await faderReadout(page, "CH 1").textContent()} (was ${edited})`,
    );

    // No loop forms: the reconcile pulls the plan back to the device's value and the
    // resync re-bases the snapshot from it, so the address stops differing. The cost is
    // that the operator's edit is silently gone — the device never had it and now the
    // plan does not either.
    expect(afterReconcile).toHaveLength(0);
    expect(idleTraffic).toHaveLength(0);
    expect(await faderReadout(page, "CH 1").textContent()).toBe(before);

    // Phase 3 — a response code 400 in the middle of a live flush's send loop. Arm the
    // refusal with the link quiet, so the nth count belongs to the burst below.
    await refuseAt(page, "vd_set", 7, "code400");
    await mark(page, "burst");
    const armed = await armMultiEdit(page, 20);
    expect(armed).toBeGreaterThanOrEqual(10);
    await settleAfter(page, "burst", 1500);

    trace = await traceOf(page);
    const burstAt = markTime(trace, "burst")!;
    const burst = setsOf(trace).filter((s) => s.start > burstAt);
    const failedIdx = burst.findIndex((s) => s.detail === "code400");
    const dialogs = await dialogsOf(page);
    const livePressed = await page.locator("#btn-live").getAttribute("aria-pressed");

    console.log(timeline(trace, { from: burstAt - 50, limit: 40 }));
    console.log(
      `burst: ${armed} faders armed, ${burst.length} vd_set issued, the 400 landed at index ${failedIdx};` +
        ` live=${livePressed}; dialogs: ${dialogs.map((d) => d.slice(0, 60)).join(" | ")}`,
    );

    // The standing device-link rule, in the live path: the failure aborts the whole
    // operation. The 7th command is the last one issued — the rest of the armed edits
    // are never sent — and unlike the offline Write there is no retry offer, because
    // the session itself is what ends.
    expect(failedIdx).toBe(6);
    expect(burst).toHaveLength(7);
    expect(livePressed).toBe("false");
    expect(dialogs.length).toBeGreaterThan(0);
    // And the three never-emitted addresses stayed never-emitted for the whole run,
    // including through the burst and the two whole-device reconciles.
    for (const a of neverEmitted) expect(setsOf(trace).filter((s) => s.addr === a)).toHaveLength(0);

    // Nothing leaks out behind the torn-down session. An ABSENCE, so it is measured
    // with settleAfter: the link is given a chance to wake up first and then to fall
    // silent, rather than being asked whether it is quiet at an instant when it has
    // simply not started again yet.
    await mark(page, "session-dead");
    await settleAfter(page, "session-dead", 900, 2000);
    const afterDeath = analyze(await traceOf(page), { quiesceAfter: "session-dead" });
    console.log(report("refused and acked writes", afterDeath));
    expect(afterDeath).toHaveLength(0);
  });
});
