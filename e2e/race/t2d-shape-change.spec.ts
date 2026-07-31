import { test, expect, type Page } from "@playwright/test";
import {
  installFake,
  goLive,
  mark,
  traceOf,
  paramAddrsOf,
  setLatency,
  settleAfter,
  divergeAt,
  snapshotOf,
  depthOf,
  ledgerOf,
  hasProbe,
  type TraceEvent,
} from "./fake-device";
import { analyze, report, timeline, markTime, setsOf, getsOf, type Span } from "./analyze";
import { graphNode } from "./ui";

// T2d shape-change — the two catalog cases whose shape change is a RE-TYPING rather
// than a growth: the address stays, its meaning does not
// (docs/{en,ja}/live-race-harness.md).
//
//   - `shape-fx-effect-type-slot-family`: the FX EFFECT TYPE selector types the array
//     after it. Changing it changes WHICH SLOTS of 681 exist, and the slots the two
//     families share carry different parameters at the same address.
//   - `shape-pan-bal-mode-switch`: switching a linked pair between PAN and BAL makes
//     the unit recompute the pan of every send the pair owns — values the plan mirrors
//     and does not own.
//
// Both are decided from the two observables T2 established, plus one this file leans
// on harder than its predecessors: a CONVERGE round runs `diffPlan`, which READS every
// address `planToCommands` produces. The set of `vd_get` addresses inside a converge is
// therefore the current writable address set, measured rather than inferred — which is
// what lets "the slot family changed" be a number instead of a claim. (`vd_params_subscribe`
// is not re-issued by a flush, so the registration is still the set `begin()` captured;
// that lag is what the orphan count below measures, not a substitute for the read set.)
//
// Read latency is 1 ms: both cases provoke several whole-scope converge passes, each
// ~800 sequential reads (measured: 793 in the first case, 795 in the second, and the
// second runs four of them). Nothing asserted is a timing verdict — every assertion is
// about which IPC happened, in what order, and against which address set.

/** FX1 EFFECT TYPE selector (679) and its parameter array (681, addressed by slot). */
const FX1_TYPE = "679:0:0";
const FX1_ARRAY = 681;
const arr = (slot: number): string => `${FX1_ARRAY}:0:${slot}`;

/** Rev-X (FX1 factory type 0) array slots: ON / Mix, then the ten REVX_PARAMS
 *  descriptors — reverbTime 7, revxInitialDelay 9, decay 15, roomSize 12, revxDiffusion 8,
 *  revxHpf 10, revxLpf 11, revxHiRatio 13, lowRatio 14, lowFreq 18 (core/control/fx-effect.ts). */
const REVX_SLOTS = [1, 2, 7, 9, 15, 12, 8, 10, 11, 13, 14, 18];
/** Mono Delay (type 1024) array slots: ON / Mix, then DELAY_PARAMS — delay 6,
 *  delayFeedback 7, delayHiRatio 8, delayHpf 9, delayLpf 10, sync 4, bpm 3, note 11. */
const DELAY_SLOTS = [1, 2, 6, 7, 8, 9, 10, 4, 3, 11];
/** Slots only one family has. Computed, not spelled out, so the two tables above are
 *  the single statement of the catalog and this cannot drift away from them. */
const REVX_ONLY = REVX_SLOTS.filter((s) => !DELAY_SLOTS.includes(s)).sort((a, b) => a - b);
const DELAY_ONLY = DELAY_SLOTS.filter((s) => !REVX_SLOTS.includes(s)).sort((a, b) => a - b);

/** PAN/BAL mode (891) on the pair's primary; Signal Type (23) at both indices. */
const PAN_BAL = "891:0:0";
const CH1_PAN = "141:0:0";
const CH2_PAN = "141:0:1";
/** A MONO IN channel's send pan into a MIX: base + 1 and base + 7, with the mono send
 *  base 146 and a 12-param stride per MIX (translate.ts sendControl). MIX 1 = 147/153,
 *  MIX 2 = 159/165; y is the channel index. The channel's own CH_PAN (141) is the pan
 *  of its fixed send into STEREO, so the pair owns ten pan addresses in all. */
const PAIR_PAN_ADDRS = [
  CH1_PAN,
  CH2_PAN,
  "147:0:0",
  "153:0:0",
  "159:0:0",
  "165:0:0",
  "147:0:1",
  "153:0:1",
  "159:0:1",
  "165:0:1",
];
/** The device's hard-pan positions for an unlinked / PAN-mode pair (STEREO_PAN_DEFAULT
 *  = 63, odd channel left, even right — core/routing.ts applyPairTransition). */
const PAN_LEFT = -63;
const PAN_RIGHT = 63;

const regKeys = (addrs: Array<[number, number, number]>): Set<string> => new Set(addrs.map((a) => a.join(":")));

const param = (page: Page, label: string) => page.locator("#inspector .param", { hasText: label });
/** The FX Effect section of the inspector, and one labelled row inside it. Scoped to
 *  the section because the effect labels ("Delay", "HPF", "Feedback Gain") are not
 *  unique across the whole panel once another section is unfolded. */
const fxSection = (page: Page) =>
  page.locator("#inspector .insp-section", { has: page.locator(".sec-title", { hasText: /^FX Effect$/ }) });
const fxRow = (page: Page, label: string) =>
  fxSection(page).locator(".param", { has: page.getByText(label, { exact: true }) });

/** Writes / reads on the FX1 array, as slot numbers, inside a trace window. */
const slotOf = (s: Span): number => Number(s.addr!.split(":")[2]);
const isArray = (s: Span): boolean => s.addr?.startsWith(`${FX1_ARRAY}:0:`) === true;
const inWindow = (s: Span, from: number, to?: number): boolean => s.start > from && (to === undefined || s.start < to);

const arraySets = (trace: TraceEvent[], from: number, to?: number): Span[] =>
  setsOf(trace).filter((s) => isArray(s) && inWindow(s, from, to));
const arrayReadSlots = (trace: TraceEvent[], from: number, to?: number): number[] =>
  [
    ...new Set(
      getsOf(trace)
        .filter((g) => isArray(g) && inWindow(g, from, to))
        .map(slotOf),
    ),
  ].sort((a, b) => a - b);

const asc = (list: number[]): number[] => [...list].sort((a, b) => a - b);

/**
 * The trace from `at` onward.
 *
 * Invariant 8 is decided on the FIRST write of each named address in the trace it is
 * handed (analyze.ts `spec.order`), so an ordering claim about ONE flush has to be
 * asked of that flush. The FX case still shows what the unwindowed question costs: the
 * FX array's slot 15 is written by an earlier gesture than the selector, so over the
 * whole run the analyzer reports an inversion between two gestures that never raced.
 * The PAN/BAL case answers clean for a duller reason — PAN_BAL's first write in the run
 * belongs to the STEREO link that sets the case up, so the unwindowed verdict pairs one
 * gesture's selector with another's pan and reads clean whatever the flush under test
 * did. Slicing is safe here because every window below opens on a settled link: no IPC
 * is in flight at `at`, so no span is cut in half.
 */
const from = (trace: TraceEvent[], at: number): TraceEvent[] => trace.filter((e) => e.t >= at);

/** Reset the probe's ledger so a phase's writers can be read without the initial
 *  readback's thousands of entries in front of them (the probe's clock and the fake's
 *  are different origins, so windowing the ledger by a trace mark is not available). */
const clearLedger = (page: Page): Promise<void> =>
  page.evaluate(() => (window as unknown as { __urxTrace?: { clear: () => void } }).__urxTrace?.clear());

/** Step a slider by `n` detents from a keyboard focus — the driving convention the
 *  harness prefers when the VALUE is the subject (one press, one plan write). */
async function stepSlider(page: Page, row: ReturnType<typeof fxRow>, n: number): Promise<void> {
  const slider = row.locator('input[type="range"]');
  await slider.focus();
  for (let i = 0; i < n; i++) await page.keyboard.press("ArrowUp");
}

test.describe("T2d shape-change", () => {
  test.beforeEach(async ({ page }) => {
    await installFake(page);
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  // shape-fx-effect-type-slot-family. The FX EFFECT TYPE selector is the only
  // parameter whose write changes which SLOTS of an array param exist rather than the
  // value at a fixed id. The two families share seven slots, of which two (1 = ON,
  // 2 = Mix) are the array's family-independent header and five (7, 8, 9, 10, 11)
  // carry a different parameter on either side of the switch. Three things are
  // measured in one run: the send ORDER (the selector must reach the device before the
  // array it types), the address SET on either side of the switch (read out of the
  // app's own two read passes — the opening readback before, the converge after), and
  // what one undo of the switch actually puts back.
  test("FX effect type re-types the slot family, and one undo cannot reach the slots it left behind", async ({
    page,
  }) => {
    expect(await hasProbe(page)).toBe(true);
    await goLive(page);
    await graphNode(page, "bus.fx1").click();
    await expect(fxSection(page)).toHaveCount(1);
    await setLatency(page, { get: 1, set: 5 });

    const typeSel = fxRow(page, "Effect Type").locator("select");
    await expect(typeSel).toHaveValue("0"); // Rev-X Hall, the FX1 factory type

    // Phase 1 — author three Rev-X values, so the state the undo must restore is on
    // the wire rather than only in the plan. Two of them (Decay 15, Room Size 12) sit
    // on slots Mono Delay does not have; the third (Reverb Time 7) sits on a slot the
    // delay family reuses for Feedback Gain.
    await mark(page, "author-revx");
    await stepSlider(page, fxRow(page, "Decay"), 3);
    await stepSlider(page, fxRow(page, "Room Size"), 3);
    await stepSlider(page, fxRow(page, "Reverb Time"), 3);
    await settleAfter(page, "author-revx", 1200);

    let trace = await traceOf(page);
    const authoredAt = markTime(trace, "author-revx")!;
    const authored = new Map(arraySets(trace, authoredAt).map((s) => [s.addr!, s.value]));
    console.log(`authored Rev-X: ${[...authored].map(([a, v]) => `${a}=${v}`).join(", ")}`);
    // Three presses from the device's 0 — the values the undo is later asked for.
    expect(authored.get(arr(15))).toBe(3); // Decay
    expect(authored.get(arr(12))).toBe(3); // Room Size
    expect(authored.get(arr(7))).toBe(3); // Reverb Time

    // Captured HERE, not at the end of the run: this is the registration the flush
    // under test was sent against, and it is what both the orphan assertion and the
    // invariant-12 report below are asked about. Reading it after the undo would ask
    // a window's question of whatever set happened to be live when the run stopped.
    const regBeforeAddrs = await paramAddrsOf(page);
    const regBefore = regKeys(regBeforeAddrs);
    const depthBefore = await depthOf(page);
    await clearLedger(page);

    // Phase 2 — the type change. FX_EFFECT_TYPE is sideEffect "converge", so the flush
    // is followed by a whole-scope read-and-resend; its read pass is what enumerates
    // the new slot family.
    await mark(page, "to-delay");
    await typeSel.selectOption("1024"); // Mono Delay
    await expect(fxRow(page, "Delay")).toHaveCount(1);
    await settleAfter(page, "to-delay", 1500);

    trace = await traceOf(page);
    const changeAt = markTime(trace, "to-delay")!;
    const changeSets = setsOf(trace).filter((s) => inWindow(s, changeAt));
    const typeWrite = changeSets.find((s) => s.addr === FX1_TYPE);
    const changeArray = arraySets(trace, changeAt);
    const changeSlots = new Set(changeArray.map(slotOf));
    const readSlotsAfter = arrayReadSlots(trace, changeAt);
    const depthAfterChange = await depthOf(page);
    const ledger = await ledgerOf(page);

    console.log(timeline(trace, { from: changeAt - 50, limit: 60 }));
    console.log(
      `type change emitted ${FX1_TYPE}=${typeWrite?.value} then array slots ` +
        `[${[...changeSlots].sort((a, b) => a - b).join(", ")}]`,
    );
    console.log(
      `the converge read array slots [${readSlotsAfter.join(", ")}] (Rev-X had [${asc(REVX_SLOTS).join(", ")}])`,
    );

    // ORDER. The selector types the array, so it must precede every slot write in the
    // same flush — the FX-channel twin of the insert-FX rule T2 pinned at 135 / 134.
    // Asked of this flush alone (see `from`): over the whole run the analyzer would
    // compare the selector against slot 15's phase-1 write and report an inversion
    // that belongs to two different gestures.
    expect(typeWrite).toBeDefined();
    expect(typeWrite!.value).toBe(1024);
    expect(changeArray.length).toBeGreaterThan(0);
    expect(Math.min(...changeArray.map((s) => s.seq))).toBeGreaterThan(typeWrite!.seq);
    expect(analyze(from(trace, changeAt), { order: [FX1_TYPE, arr(6)] })).toHaveLength(0);

    // THE PREMISE — the switch really did change which addresses exist, computed from
    // the app's own two read passes rather than assumed. The session's opening readback
    // walks the Rev-X family (readback.ts readFxEffect) and the converge's `diffPlan`
    // walks `planToCommands`, so each pass IS the writable slot set at its instant.
    // Measured: three slots arrive, five leave, on one array param at one param id.
    const readSlotsBefore = arrayReadSlots(trace, 0, changeAt);
    console.log(
      `slot family: [${readSlotsBefore.join(", ")}] → [${readSlotsAfter.join(", ")}]` +
        ` (arrived [${readSlotsAfter.filter((s) => !readSlotsBefore.includes(s)).join(", ")}],` +
        ` departed [${readSlotsBefore.filter((s) => !readSlotsAfter.includes(s)).join(", ")}])`,
    );
    // The two read passes are the premise, and they are the only assertions worth
    // making about it: "arrived" and "departed" are the same set difference that
    // defines DELAY_ONLY / REVX_ONLY, so once these two hold they cannot fail. They
    // are logged above, where a reader wants them, and not asserted.
    expect(readSlotsBefore).toEqual(asc(REVX_SLOTS));
    expect(readSlotsAfter).toEqual(asc(DELAY_SLOTS));
    // The three new slots were written…
    for (const s of DELAY_ONLY) expect(changeSlots.has(s)).toBe(true);
    // …to addresses the broker is not registered for. DeviceFollow re-registers at
    // begin() and after a reconcile only, so a flush that re-types the array leaves the
    // registration describing the family that is gone. Hand-computed over this flush
    // alone: the registration is a snapshot of one instant, and the same question asked
    // against the whole run's writes would answer with an artefact.
    const orphans = [...new Set(changeArray.map((s) => s.addr!))].filter((a) => !regBefore.has(a));
    console.log(`type change: ${orphans.length} array address(es) written but not registered: ${orphans.join(", ")}`);
    expect(orphans.sort()).toEqual(DELAY_ONLY.map(arr).sort());

    // The same fact as a STATE rather than as a set of writes — invariant 6's clause B.
    // Both halves are read HERE, between the change and the undo, because that is the
    // only instant the window is open: the undo takes the delay family back out, so the
    // pair read at the analyze() call below would describe a window that has shut. A
    // converge re-captures the live snapshot but never re-subscribes, which is exactly
    // why the two readings disagree.
    const regAfterChangeAddrs = await paramAddrsOf(page);
    const snapAfterChange = await snapshotOf(page);
    const grownAfterChange = analyze([], { registration: regAfterChangeAddrs, snapshot: snapAfterChange }).filter(
      (f) => f.inv === 6 && f.name === "grown window",
    );
    console.log(report("fx effect type slot family (grown window)", grownAfterChange));
    expect(grownAfterChange).toHaveLength(1);

    // The shared slots are where the re-typing bites, and what the trace shows is that
    // nothing carries across the families: each descriptor key names its own family
    // (fx-effect.ts), so the five shared slot numbers are re-authored from the delay
    // family alone. Slot 7 is reverbTime in Rev-X and Feedback Gain in the delay family:
    // the 3 authored above is written over with the delay default 20. Slots 8, 9 and 10
    // change owner just as completely — diffusion → hiRatio, initialDelay → hpf and
    // hpf → lpf — and carry their delay defaults too (7 / 40 / 110, fx-effect.ts
    // DELAY_PARAMS), because this channel's plan has never held a delay value: the
    // readback only ever fills the selected family's keys.
    //
    // The defaults are what the app has, not what the unit does. Nothing here measures
    // what a real unit puts in its array when the selector is typed, and no claim is
    // made about it.
    const changeVals = new Map(changeArray.map((s) => [slotOf(s), s.value]));
    const slot8 = changeVals.get(8);
    console.log(
      `shared slots: 7 ${authored.get(arr(7))} → ${changeVals.get(7)}, 8=${slot8}, ` +
        `9=${changeVals.get(9)}, 10=${changeVals.get(10)} (delay defaults 20 / 7 / 40 / 110)`,
    );
    expect(changeVals.get(7)).toBe(20);
    expect(slot8).toBe(7);
    expect(changeVals.get(9)).toBe(40);
    expect(changeVals.get(10)).toBe(110);

    // One gesture, one undo entry, and the ledger names the operator as its author.
    expect(depthAfterChange.undo - depthBefore.undo).toBe(1);
    expect(ledger.filter((l) => l.source === "ui" && l.subKeys?.includes("fxEffect")).length).toBeGreaterThan(0);

    // Phase 3 — one undo of the type change.
    await mark(page, "undo");
    await page.keyboard.press("Control+z");
    await expect(fxRow(page, "Effect Type").locator("select")).toHaveValue("0");
    await expect(fxRow(page, "Decay")).toHaveCount(1);
    await settleAfter(page, "undo", 1500);

    trace = await traceOf(page);
    const undoAt = markTime(trace, "undo")!;
    const undoSets = setsOf(trace).filter((s) => inWindow(s, undoAt));
    const undoType = undoSets.find((s) => s.addr === FX1_TYPE);
    const undoArray = arraySets(trace, undoAt);
    const undoSlots = new Set(undoArray.map(slotOf));
    const undoVals = new Map(undoArray.map((s) => [slotOf(s), s.value]));
    const readSlotsAfterUndo = arrayReadSlots(trace, undoAt);
    const snapshot = await snapshotOf(page);
    const depthAfterUndo = await depthOf(page);

    console.log(
      `undo emitted ${FX1_TYPE}=${undoType?.value} then array slots ` +
        `[${[...undoSlots].sort((a, b) => a - b).join(", ")}]; the converge read [${readSlotsAfterUndo.join(", ")}]`,
    );
    console.log(
      `snapshot entries after the undo: ` +
        `${DELAY_ONLY.map((s) => `${arr(s)}=${snapshot?.[arr(s)]}`).join(", ")} | ` +
        `${REVX_ONLY.map((s) => `${arr(s)}=${snapshot?.[arr(s)]}`).join(", ")}`,
    );
    // Two reports, because the two invariants want different windows and neither is
    // decidable in the other's. Invariant 12 is asked over the type change's flush,
    // against the registration that describes it (a registration is a snapshot of one
    // instant; over the whole trace it would count writes that were perfectly well
    // registered when they were sent). Invariant 8 is asked over the undo's flush, for
    // the reason `from` gives.
    console.log(
      report(
        "fx effect type slot family (type-change window)",
        // No `snapshot` here: clause B was answered above, at the one instant its two
        // halves both describe. Handing it a reading taken now — after the undo put the
        // Rev-X family back — would report an empty difference for a window this report
        // is precisely about.
        analyze(trace, {
          registration: regBeforeAddrs,
          registrationWindow: { from: changeAt, to: undoAt },
        }),
      ),
    );
    const undoOrder = analyze(from(trace, undoAt), { order: [FX1_TYPE, arr(15)] });
    console.log(report("fx effect type slot family (undo flush)", undoOrder));
    expect(undoOrder).toHaveLength(0);

    // The undo is a device write like any other, and it keeps the ordering rule.
    expect(undoType).toBeDefined();
    expect(undoType!.value).toBe(0);
    expect(Math.min(...undoArray.map((s) => s.seq))).toBeGreaterThan(undoType!.seq);
    expect(depthAfterUndo.undo).toBe(depthBefore.undo);
    expect(depthAfterUndo.redo).toBe(depthBefore.redo + 1);

    // WHAT COMES BACK: every Rev-X-only slot, carrying the values phase 1 authored.
    for (const s of REVX_ONLY) expect(undoSlots.has(s)).toBe(true);
    expect(undoVals.get(15)).toBe(3); // Decay
    expect(undoVals.get(12)).toBe(3); // Room Size
    expect(undoVals.get(7)).toBe(3); // Reverb Time, back over the delay Feedback Gain

    // WHAT DOES NOT, and why it is structural rather than a missed write. The three
    // delay-only slots the type change wrote leave the writable set with the family
    // that owns them: the undo does not write them, the converge behind it does not
    // read them, and the live snapshot holds no entry for them — so 681:0:3/4/6 can
    // never become a diff again, and the app has no way left to see or change what the
    // switch put there. The Rev-X-only slots are the control: same array, same undo,
    // and they are all three of written, read and snapshotted.
    for (const s of DELAY_ONLY) expect(undoSlots.has(s)).toBe(false);
    expect(readSlotsAfterUndo).toEqual(asc(REVX_SLOTS));
    for (const s of DELAY_ONLY) expect(snapshot?.[arr(s)]).toBeUndefined();
    for (const s of REVX_ONLY) expect(snapshot?.[arr(s)]).toBeDefined();
    // …and the two slots that changed owner without changing number are written in both
    // directions. The address does not move, but the value at it does: each family
    // authors its own key, so the switch wrote the delay HPF / LPF there and the undo
    // writes the Rev-X Initial Delay / HPF back over them — both 0, as read from this
    // zeroed fake. The control is the window before the switch: while Rev-X was selected
    // neither slot ever differed from what the device already held, so neither was sent.
    expect(undoVals.get(9)).toBe(0);
    expect(undoVals.get(10)).toBe(0);
    expect(setsOf(trace).filter((s) => (s.addr === arr(9) || s.addr === arr(10)) && s.start < changeAt)).toHaveLength(
      0,
    );
  });

  // shape-pan-bal-mode-switch. The PAN/BAL switch is the only plan edit whose device
  // side-effect lands on the CONNECTIONS: the unit recomputes the pan of every send
  // the pair owns, values the plan mirrors (core/routing.ts applyPairTransition) and
  // does not author. The app models the same recomputation and emits the SELECTOR
  // FIRST: translate.ts writes the pair-level CH SETTING block (SIGNAL_TYPE 23,
  // PAN_BAL 891) ahead of the two connection blocks that carry the pans, because
  // writing 891 makes the unit slam all ten of them (measured: BAL→PAN hard-pans to
  // ±63, PAN→BAL and unlinking centre), so a pan sent ahead of the selector is
  // discarded. The same selector-leads rule insert FX (135 before 134) and the FX
  // effect type (679 before its 681 array) keep. Measured on the switch and again on
  // its undo.
  test("PAN/BAL sends the selector before the pans it re-authors, and the undo does too", async ({ page }) => {
    expect(await hasProbe(page)).toBe(true);
    await goLive(page);
    await setLatency(page, { get: 1, set: 5 });
    await graphNode(page, "ch1").click();

    // The PAN/BAL control exists only on a STEREO-linked pair, and linking leaves the
    // pair in BAL with every pan centred (t2b pins the link itself; here it is setup).
    await mark(page, "stereo-link");
    await param(page, "Signal Type").locator("select").selectOption("1");
    await expect(param(page, "PAN / BAL")).toHaveCount(1);
    await settleAfter(page, "stereo-link", 1500);
    await expect(param(page, "PAN / BAL").locator("select")).toHaveValue("1"); // BAL

    // From here the unit holds its own positions for the pair's two CH_PAN addresses
    // whatever is written to them — the device-side recomputation this case is about,
    // in the one form the fake can express. The eight send pans are left alone, so the
    // run carries its own control for "the app only re-sends what differs".
    await divergeAt(page, CH1_PAN, 20);
    await divergeAt(page, CH2_PAN, -20);
    await clearLedger(page);
    const depthBefore = await depthOf(page);

    await mark(page, "to-pan");
    await param(page, "PAN / BAL").locator("select").selectOption("0"); // PAN
    await settleAfter(page, "to-pan", 1500);

    let trace = await traceOf(page);
    const switchAt = markTime(trace, "to-pan")!;
    const switchSets = setsOf(trace).filter((s) => inWindow(s, switchAt));
    const modeWrite = switchSets.find((s) => s.addr === PAN_BAL);
    const panWrites = switchSets.filter((s) => PAIR_PAN_ADDRS.includes(s.addr!));
    // The flush itself ends where the converge behind it starts reading. The converge
    // re-sends two of the ten pans on every round, so an ordering claim about ONE flush
    // has to stop where the flush does — the same windowing `from` does for the
    // analyzer, applied to the spans this case counts by hand.
    const convergeSeq = getsOf(trace).find((g) => inWindow(g, switchAt))!.seq;
    const flushPans = panWrites.filter((s) => s.seq < convergeSeq);
    const ledger = await ledgerOf(page);

    console.log(timeline(trace, { from: switchAt - 50, limit: 60 }));
    console.log(
      `PAN/BAL switch: ${PAN_BAL}=${modeWrite?.value} at seq ${modeWrite?.seq}; pan writes after it: ` +
        flushPans
          .filter((s) => s.seq > (modeWrite?.seq ?? 0))
          .map((s) => `${s.addr}=${s.value}`)
          .join(", "),
    );

    // ORDERING — the fix. Every one of the pair's ten pan addresses is written AFTER
    // the selector that, on the unit, recomputes all ten. translate.ts emits the
    // pair-level CH SETTING block before the connection loop (CH_PAN 141, SEND_PAN
    // 147/153/159/165), and the flush sends in translate order. So the values land on
    // top of the ones the selector slammed, instead of being superseded by a command
    // ten lines further down the same burst.
    expect(modeWrite).toBeDefined();
    expect(modeWrite!.value).toBe(0); // PAN
    const afterSelector = flushPans.filter((s) => s.seq > modeWrite!.seq);
    expect(afterSelector.map((s) => s.addr).sort()).toEqual([...PAIR_PAN_ADDRS].sort());
    // Asked of the whole window, not just the flush: no pan of the pair reaches the
    // device ahead of the selector at any point after the gesture.
    expect(panWrites.filter((s) => s.seq < modeWrite!.seq)).toHaveLength(0);
    // …and they carry the hard-pan positions the app computed for PAN mode: the odd
    // channel left, the even one right, on the channel fader's pan and on both MIX
    // sends of both channels.
    const val = (a: string): number | undefined => afterSelector.find((s) => s.addr === a)?.value;
    expect(val(CH1_PAN)).toBe(PAN_LEFT);
    expect(val(CH2_PAN)).toBe(PAN_RIGHT);
    expect(val("147:0:0")).toBe(PAN_LEFT);
    expect(val("165:0:1")).toBe(PAN_RIGHT);

    // …and the analyzer says the same in its own terms, over this flush alone (see
    // `from`): no invariant-8 finding between the selector and the pan it types.
    const switchOrder = analyze(from(trace, switchAt), { order: [PAN_BAL, CH1_PAN] });
    console.log(report("pan/bal mode switch (switch flush)", switchOrder));
    expect(switchOrder).toHaveLength(0);

    // The converge is now the NET rather than the repair — PAN_BAL is sideEffect
    // "converge", so the flush is followed by a read-and-resend of the whole write
    // scope. What that catches, and what it does NOT do: for the two addresses the unit
    // rewrote, the app reads them every round, finds them different, and sends its own
    // value again. It never adopts the device's. The plan is never told, so nothing
    // downstream can know.
    const ch1Writes = switchSets.filter((s) => s.addr === CH1_PAN);
    const ch1Reads = getsOf(trace).filter((g) => g.addr === CH1_PAN && inWindow(g, switchAt));
    const mixSendWrites = switchSets.filter((s) => s.addr === "147:0:0");
    const snapshot = await snapshotOf(page);
    console.log(
      `${CH1_PAN}: ${ch1Writes.length} write(s) carrying {${[...new Set(ch1Writes.map((s) => s.value))].join(", ")}}` +
        ` around ${ch1Reads.length} read(s); control 147:0:0: ${mixSendWrites.length} write(s);` +
        ` snapshot now holds ${CH1_PAN}=${snapshot?.[CH1_PAN]}`,
    );
    expect(ch1Writes.length).toBeGreaterThan(1);
    expect(ch1Reads.length).toBeGreaterThan(1);
    // The first of them is the flush's own, and it is already behind the selector: what
    // the repeats measure is the device holding a different value, not the converge
    // putting an order right that the flush got wrong.
    expect(ch1Writes[0].seq).toBeGreaterThan(modeWrite!.seq);
    // Re-asserted, never adopted: every one of those writes carries the same value.
    expect(new Set(ch1Writes.map((s) => s.value)).size).toBe(1);
    // The control: a pan address the device accepted is sent once and never revisited,
    // so the repeats above are the app's response to a difference, not to the switch.
    expect(mixSendWrites).toHaveLength(1);
    // And the snapshot comes out of the converge believing the device holds what it was
    // told, after reading the opposite on every round of it.
    expect(snapshot?.[CH1_PAN]).toBe(PAN_LEFT);

    // One gesture, one undo entry, spanning two plan fields — both written by the same
    // funnel BEFORE it commits: main.ts onUpdateNodeParams assigns nodeParams[ch1],
    // then calls applyPairTransition over the pair's sends, then mirrorBalPair, and
    // only then markChanged(). The entry covers both because the diff is taken at the
    // commit, which is after all three.
    //
    // PAIR_SEND_WIRES and PAIR_PAN_ADDRS are both ten and are NOT the same ten, which
    // is why the count is asserted against its own constant rather than against the
    // address list. applyPairTransition re-pans every `send` of both channels — the
    // fixed STEREO path plus MIX 1 / MIX 2 / FX 1 / FX 2, five each. A CH → FX send
    // has no pan on the device at all (sendControl returns `pan: []`), so four of the
    // ten plan writes can never become a command; the ten addresses come from the
    // other six, CH_PAN once per channel and each MIX send twice (the block's L and R
    // slots at base + 1 / base + 7).
    const PAIR_SEND_WIRES = 10;
    const uiNode = ledger.filter((l) => l.source === "ui" && l.field === "nodeParams" && l.key === "ch1");
    const uiConn = ledger.filter((l) => l.source === "ui" && l.field === "connParams");
    const depthAfterSwitch = await depthOf(page);
    console.log(
      `ledger for the switch: ${uiNode.length} nodeParams entr(y|ies) on ch1, ${uiConn.length} connParams entries` +
        ` (sub-keys ${[...new Set(uiConn.flatMap((l) => l.subKeys ?? []))].join(", ")})` +
        ` on wires [${uiConn.map((l) => l.key).join(" | ")}];` +
        ` undo depth ${depthBefore.undo} → ${depthAfterSwitch.undo}`,
    );
    expect(uiNode.length).toBeGreaterThan(0);
    expect(uiConn.length).toBe(PAIR_SEND_WIRES);
    expect([...new Set(uiConn.flatMap((l) => l.subKeys ?? []))]).toEqual(["pan"]);
    // The four unsendable ones, named rather than counted: a pan the plan re-authored
    // on a wire the device has no pan address for.
    const fxWires = uiConn.filter((l) => /bus\.fx[12]/.test(l.key ?? ""));
    expect(fxWires).toHaveLength(4);
    expect(depthAfterSwitch.undo - depthBefore.undo).toBe(1);

    // Phase 2 — the undo. It restores BAL and re-centres all ten pans, and it goes out
    // in exactly the same order the switch did: the selector first, the ten values it
    // re-authors behind it. The undo's pans are still stale about a value the app had
    // already been shown — the converge above read the pair's CH_PAN on every round and
    // carried none of it into the plan — but they are no longer discarded on arrival.
    await mark(page, "undo");
    await page.keyboard.press("Control+z");
    await expect(param(page, "PAN / BAL").locator("select")).toHaveValue("1");
    await settleAfter(page, "undo", 1500);

    trace = await traceOf(page);
    const undoAt = markTime(trace, "undo")!;
    const undoSets = setsOf(trace).filter((s) => inWindow(s, undoAt));
    const undoMode = undoSets.find((s) => s.addr === PAN_BAL);
    const undoPans = undoSets.filter((s) => PAIR_PAN_ADDRS.includes(s.addr!));
    const undoConvergeSeq = getsOf(trace).find((g) => inWindow(g, undoAt))!.seq;
    const undoFlushPans = undoPans.filter((s) => s.seq < undoConvergeSeq);
    const readsBetween = getsOf(trace).filter((g) => g.addr === CH1_PAN && g.start > switchAt && g.start < undoAt);

    console.log(
      `undo: ${PAN_BAL}=${undoMode?.value} at seq ${undoMode?.seq}; ` +
        `${undoFlushPans.filter((s) => s.seq > (undoMode?.seq ?? 0)).length} pan write(s) behind it; ` +
        `${readsBetween.length} read(s) of ${CH1_PAN} had already answered otherwise`,
    );
    // The order the device needs is the mode selector, then the pans it types, and that
    // is what goes out. Asked of the undo's own flush, because invariant 8 is decided on
    // the FIRST write of each named address in the trace it is handed: over the whole
    // run PAN_BAL's first write is the STEREO link's, tens of seconds ahead of the
    // gesture under test, so the unwindowed question pairs one gesture's selector with
    // another's pan. Both are run, so what the window buys is shown rather than asserted
    // from memory.
    const undoOrder = analyze(from(trace, undoAt), {
      order: [PAN_BAL, CH1_PAN],
      registration: [...(await paramAddrsOf(page))],
      registrationWindow: { from: undoAt },
      // PAN/BAL re-authors pan VALUES on addresses emitted in both modes, so no address
      // enters or leaves the emitted set and clause B is silent. Supplied all the same,
      // so the silence is measured rather than assumed — and the result is filtered to
      // invariant 8 below, so it could not move this case's verdict either way.
      snapshot: await snapshotOf(page),
    });
    const wholeRunOrder = analyze(trace, { order: [PAN_BAL, CH1_PAN] });
    const firstMode = setsOf(trace).find((s) => s.addr === PAN_BAL)!;
    const firstPan = setsOf(trace).find((s) => s.addr === CH1_PAN)!;
    console.log(report("pan/bal mode switch (undo flush)", undoOrder));
    console.log(
      `pan/bal mode switch (unwindowed, whole run): ` +
        `${wholeRunOrder.filter((f) => f.inv === 8).length} invariant-8 finding(s), decided on ` +
        `${PAN_BAL} at ${firstMode.start.toFixed(0)} ms / ${CH1_PAN} at ${firstPan.start.toFixed(0)} ms ` +
        `(the switch was at ${switchAt.toFixed(0)} ms, the undo at ${undoAt.toFixed(0)} ms)`,
    );
    // What the unwindowed question is actually about, measured rather than recalled:
    // its selector side is the STEREO link's own 891 write (the setup, before the
    // switch), and its pan side is the switch flush's first CH_PAN — the link centred
    // the pair, so its flush carried no pan at all and cannot answer for one. The
    // verdict is clean, and it would be clean whatever the two flushes under test did.
    const linkAt = markTime(trace, "stereo-link")!;
    expect(firstMode.start).toBeGreaterThan(linkAt);
    expect(firstMode.start).toBeLessThan(switchAt);
    expect(firstPan.seq).toBe(ch1Writes[0].seq);
    expect(wholeRunOrder.filter((f) => f.inv === 8)).toHaveLength(0);

    expect(undoMode).toBeDefined();
    expect(undoMode!.value).toBe(1); // BAL
    const undoAfterSelector = undoFlushPans.filter((s) => s.seq > undoMode!.seq);
    expect(undoAfterSelector.map((s) => s.addr).sort()).toEqual([...PAIR_PAN_ADDRS].sort());
    // The same address set as the switch sent, and — over the whole window, converge
    // rounds included — not one of them ahead of the selector.
    expect(undoPans.filter((s) => s.seq < undoMode!.seq)).toHaveLength(0);
    // Centred, which is what BAL means for the pair — and every one of them is issued
    // behind the selector that makes the unit compute its own.
    expect(undoAfterSelector.every((s) => s.value === 0)).toBe(true);
    // The app had read the unit's own value for this address repeatedly before writing
    // over it (the count is logged), so the undo's value is stale even though it now
    // arrives in the order the device needs: the device had already answered otherwise
    // before it left.
    expect(readsBetween.length).toBeGreaterThan(1);
    // …and the analyzer says the same about the undo's flush in its own terms: the
    // invariant-8 finding this case used to pin is gone.
    expect(undoOrder.filter((f) => f.inv === 8)).toHaveLength(0);
  });
});
