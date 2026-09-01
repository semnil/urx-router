import { test, expect, type Page } from "@playwright/test";
import {
  installFake,
  goLive,
  mark,
  pushNotify,
  pushBulkChange,
  pushMidi,
  traceOf,
  paramAddrsOf,
  setLatency,
  settleAfter,
  ledgerOf,
  snapshotOf,
  hasProbe,
  blockAt,
  releaseBarrier,
  type InstallOptions,
  type TraceEvent,
} from "./fake-device";
import { analyze, report, timeline, markTime, setsOf, getsOf, deviceReflectsAfter } from "./analyze";
import { closeDynScreen, graphNode, insertFxBypass, insertFxSelect, param, paramExact, strip } from "./ui";
// The message catalog, for the one place this file asserts a sentence rather than a
// value. `en.ts` is a plain data module with no DOM and no `src/ui` behind it, so it
// costs the harness nothing (the note in t4-midi.spec.ts is about importing a VIEW).
import { en } from "../../src/i18n/en";
import { chooseOption } from "../choose-option";

// T2e shape-change — the two catalog cases whose subject is a constraint that lives in
// DATA rather than in the emit path (docs/{en,ja}/live-race-harness.md).
//
// Both of the device locks this tier names — the MIX bus's FIXED / Pan Link pair and the
// sample-rate ceilings in core/constraints.ts — are enforced nowhere near translate.ts.
// The write set is computed from the plan alone, so a lock changes what the SCREENS
// offer and what core/midi/controls.ts accepts, and changes nothing about which
// addresses exist or what leaves for the device. That makes the tier's usual observable
// (the `addrs` argument of vd_params_subscribe, which IS the follow registration set)
// the control rather than the result: the interesting number is that it does NOT move.
//
// Two properties of the observables had to be measured rather than reasoned about, and
// they are what the assertions below are shaped around:
//   - the live snapshot's KEY SET is rebuilt only at capture (begin / resync / a
//     converge or refetch epilogue), while a flush only ever `set`s keys it just sent.
//     So a write set that GREW is visible in the snapshot immediately and one that
//     shrank is not — which is why the address-set question in the first case is asked
//     of a registration taken after a forced reconcile, not of the snapshot. The growth
//     half is pinned in the second case (the insert-FX selection).
//   - a registration is a snapshot of one instant AND is not re-posted at all when the
//     derived set is unchanged (DeviceFollow.subscribe short-circuits). So every
//     invariant-12 / invariant-6 report here carries the window that registration
//     describes, and every "the set did not move" assertion is preceded by a measured
//     reconcile or by the flush the gesture itself produced — the re-post is what makes
//     an untouched registration mean the derived set did not move rather than that
//     nothing asked.
//
// Read latency is 2 ms throughout, for T2's reason: a whole-device readback is ~800
// sequential reads and each case here provokes two or three of them. Nothing below is a
// timing verdict — every assertion is about which IPC happened and against which
// registered address set.

/** Read by a full device readback only — applyNodeState skips it by design, so a read
 *  of this address is one whole-device reconcile. */
const RATE_ADDR = "766:0:0";

/** BUS_TYPE (587) is written to both linked out instances of MIX 1;
 *  PAN_LINK (589) to the L instance alone (translate.ts MIX_FADER_INSTANCES). */
const BUS_TYPE_L = "587:0:0";
const BUS_TYPE_R = "587:0:1";
const PAN_LINK = "589:0:0";
/** ch1 → MIX 1 send (translate.ts sendControl, mono base 146, y = channel index):
 *  level 146/152, pan 147/153, on 148/154, tap 151 — L and R linked instances. */
const CH1_M1_LEVEL = ["146:0:0", "152:0:0"];
const CH1_M1_PAN = ["147:0:0", "153:0:0"];
/** INSERT_FX (135) / INSERT_FX_ON (134) on the four MONO IN channels, y = channel index. */
const insertFxAddr = (ch: number): string => `135:0:${ch}`;
const insertFxOnAddr = (ch: number): string => `134:0:${ch}`;
/** The broker's "no effect" sentinel, normalized to -1 on read (params.ts). */
const INSERT_FX_VD_NONE = 0xffffffff;
/** Compander-H (slot "compander") and Clean (slot "amp") — two different device-wide
 *  1-of slots, so a case can tell "this slot is taken" from "everything is disabled". */
const COMPANDER_H = 1793;
/** Pitch Fix (slot "pitch"), the third input slot. Its own ceiling is 48 kHz, so it is
 *  selectable exactly on the low-rate page. */
const PITCH_FIX = 512;

type CcAddr = { type: "cc"; channel: number; controller: number };
const CC7: CcAddr = { type: "cc", channel: 0, controller: 7 };
const CC8: CcAddr = { type: "cc", channel: 0, controller: 8 };
type Mapping = { control: string; addr: CcAddr; mode: "absolute" | "pickup" };

/** Seed the persisted MIDI store: ports (reopened at boot) + this model's bindings.
 *  Learn would need the panel open and an arming click on the very control the case
 *  then wants to lock, and mapping.ts validates a seeded record identically. */
const midiStore = (mappings: Mapping[]): InstallOptions["storage"] => ({
  "urx-midi": JSON.stringify({ input: "Fake In", models: { URX44V: mappings } }),
});

const cc = (controller: number, value: number): number[] => [0xb0, controller, value];

const regKeys = (addrs: Array<[number, number, number]>): Set<string> => new Set(addrs.map((a) => a.join(":")));

/** Whole-device reconciles that began after `at` (see RATE_ADDR). */
const fullReadsAfter = (trace: TraceEvent[], at: number): number =>
  getsOf(trace).filter((g) => g.addr === RATE_ADDR && g.start > at).length;

const setsAfter = (trace: TraceEvent[], at: number): ReturnType<typeof setsOf> =>
  setsOf(trace).filter((s) => s.start > at);

/**
 * The writes of the FLUSH alone. A `sideEffect: "converge"` param (INSERT_FX is one)
 * makes the flush re-read the whole device and push the diff back, and against this fake
 * that diff is large — every address the readback does not cover still holds the fake's
 * zero while the plan holds a factory default, so the converge round writes it. That is a
 * property of the fake, not a result, so it is excluded rather than reported: the flush is
 * everything issued before the converge's first read.
 */
const flushWrites = (trace: TraceEvent[], at: number): ReturnType<typeof setsOf> => {
  const firstGet = getsOf(trace).find((g) => g.start > at);
  return setsAfter(trace, at).filter((s) => firstGet === undefined || s.start < firstGet.start);
};

/** Put the fake's device state map into a known shape. Unlike `divergeAt` this is a real
 *  state: a write to the address replaces it, which is what a converge round needs — a
 *  divergence would make every converge see the same mismatch and re-send forever. */
const seedMem = (page: Page, entries: Record<string, number>): Promise<void> =>
  page.evaluate((e) => {
    Object.assign(window.__urxFake.mem, e);
  }, entries);

/** Every strip's send mini-fader for one destination, addressed by the aria-label the
 *  rack gives it (console.ts SEND_LABEL) rather than by column position. */
const sendFaders = (page: Page, dest: string) => page.locator(`.con-strip .con-vfad[aria-label="${dest}"]`);
/** The same, narrowed to the ones the console rendered read-only (a FIXED-bus level). */
const lockedSendFaders = (page: Page, dest: string) =>
  page.locator(`.con-strip .con-vfad.readonly[aria-label="${dest}"]`);

/** The addresses the live snapshot currently holds. Its key set is the write set as of
 *  the last capture, plus anything a flush has sent since — see the file header. */
const writeSetOf = async (page: Page): Promise<Set<string>> => new Set(Object.keys((await snapshotOf(page)) ?? {}));

/** Reset the probe's ledger so a phase's writers can be read without the initial
 *  readback's thousand entries in front of them (t2b uses the same handle). */
const clearLedger = (page: Page): Promise<void> =>
  page.evaluate(() => (window as unknown as { __urxTrace?: { clear: () => void } }).__urxTrace?.clear());

/** The label of every option in the EFFECT TYPE select, with whether it is disabled. It
 *  goes through `insertFxSelect` so the section is opened first: folded, the select is not
 *  in the tree at all and an option sweep reports an empty menu rather than a closed one. */
const insertFxOptions = async (page: Page): Promise<Array<{ text: string; disabled: boolean }>> =>
  (await insertFxSelect(page)).evaluate((el) =>
    [...(el as HTMLSelectElement).options].map((o) => ({ text: o.textContent ?? "", disabled: o.disabled })),
  );

test.describe("T2e shape-change", () => {
  // ---------------------------------------------------------------------------
  // shape-bus-type-and-pan-link-locks — a write on node A changes the observable
  // state of controls on B and C without writing them.
  //
  // BUS Type FIXED and Pan Link are parameters of the MIX bus, and neither reaches
  // translate.ts: mixSendLocks (core/routing.ts) is consulted by the inspector (which
  // DROPS the gated control), by the console (which renders the send fader read-only)
  // and by core/midi/controls.ts (whose set() returns false and swallows the message).
  // So one write on bus.mix1 decides whether an incoming CC on ch1 reaches the device
  // at all, with nothing written to ch1 and no address entering or leaving the set.
  // ---------------------------------------------------------------------------
  test("a MIX bus's FIXED / Pan Link write locks the source channels' send controls with no write and no shape change", async ({
    page,
  }) => {
    await installFake(page, {
      storage: midiStore([
        { control: "ch1/level@bus.mix1", addr: CC7, mode: "absolute" },
        { control: "ch1/pan@bus.mix1", addr: CC8, mode: "absolute" },
      ]),
    });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    expect(await hasProbe(page)).toBe(true);
    await goLive(page);
    await setLatency(page, { get: 2, set: 8 });

    const reg0addrs = await paramAddrsOf(page);
    const reg0 = regKeys(reg0addrs);
    const write0 = await writeSetOf(page);
    // The premise the whole case rests on: both send controls exist as device
    // addresses right now, under a VARI bus with Pan Link off.
    for (const a of [...CH1_M1_LEVEL, ...CH1_M1_PAN]) expect(reg0.has(a)).toBe(true);

    // Phase 0 — the baseline. Both bindings reach the device, so a later silence is a
    // property of the lock and not of the MIDI path or of the seeded mapping.
    await mark(page, "midi-baseline");
    await pushMidi(page, [cc(7, 127), cc(8, 127)]);
    await settleAfter(page, "midi-baseline", 900);
    let trace = await traceOf(page);
    const baseAt = markTime(trace, "midi-baseline")!;
    const baseWrites = setsAfter(trace, baseAt);
    const baseAddrs = new Set(baseWrites.map((s) => s.addr!));
    console.log(`baseline MIDI burst emitted: ${baseWrites.map((s) => `${s.addr}=${s.value}`).join(", ")}`);
    for (const a of [...CH1_M1_LEVEL, ...CH1_M1_PAN]) expect(baseAddrs.has(a)).toBe(true);

    // Phase 1 — the write on node A. BUS Type VARI → FIXED on bus.mix1.
    await graphNode(page, "bus.mix1").click();
    const busTypeSel = param(page, "BUS Type").locator("select");
    await expect(busTypeSel).toHaveValue("0"); // VARI
    await clearLedger(page);
    await mark(page, "bus-fixed");
    await chooseOption(busTypeSel, "1"); // FIXED
    await expect(param(page, "Pan Link")).toHaveCount(0); // Pan Link is VARI-only
    await settleAfter(page, "bus-fixed", 1200);

    trace = await traceOf(page);
    const fixedAt = markTime(trace, "bus-fixed")!;
    // The FLUSH's writes, not the window's: BUS Type is a `sideEffect: "converge"` head now
    // (the unit resets the send bank behind it), so a converge round follows and against
    // this fake that round writes a lot for the reason flushWrites documents.
    const fixedWrites = flushWrites(trace, fixedAt);
    const ledger = await ledgerOf(page);
    const uiKeys = [...new Set(ledger.filter((l) => l.source === "ui").map((l) => `${l.field}[${l.key}]`))];
    const write1 = await writeSetOf(page);
    const grew = [...write1].filter((a) => !write0.has(a));

    console.log(timeline(trace, { from: fixedAt - 50, limit: 40 }));
    console.log(`BUS Type FIXED emitted: ${fixedWrites.map((s) => `${s.addr}=${s.value}`).join(", ")}`);
    console.log(`ledger for the gesture (ui): ${uiKeys.join(", ")}`);
    console.log(`write set: ${write0.size} → ${write1.size} address(es), ${grew.length} added`);

    // Exactly the bus's own two instances left, at the FIXED value. Nothing on ch1 —
    // and it is the ch1 controls whose observable state the write just changed. What the
    // converge round behind it then puts back is the bank the unit reset, which is the
    // repair rather than the gesture.
    expect(fixedWrites.map((s) => s.addr).sort()).toEqual([BUS_TYPE_L, BUS_TYPE_R]);
    expect(new Set(fixedWrites.map((s) => s.value))).toEqual(new Set([1]));
    // …and the plan agrees: the operator's gesture wrote one node's params, not four.
    // (A flush writes no plan key, so the ledger for this gesture is the funnel's own.)
    expect(uiKeys).toEqual(["nodeParams[bus.mix1]"]);
    // No address entered the write set. A flush `set`s every key it sends, so a write
    // set that grew would be visible here at once — this is the falsifiable half of
    // "the lock is not an emit gate" (the other half is the registration below).
    expect(grew).toEqual([]);
    // …and the address the lock makes inert did not leave the set either: the send
    // level is still one of the values the app would put on the wire under FIXED.
    for (const a of CH1_M1_LEVEL) expect(write1.has(a)).toBe(true);

    // Phase 2 — the address set, asked of a registration rather than of the snapshot.
    // The registration only moves at begin() and after a reconcile, so force one: the
    // BULK_CHANGE sentinel resolves to no node and escalates. (A notify on a
    // planExternal address would not: the bridge refuses it, since the session never
    // registered that address.)
    await mark(page, "reconcile-1");
    await pushBulkChange(page);
    await settleAfter(page, "reconcile-1", 2500);
    trace = await traceOf(page);
    const rec1At = markTime(trace, "reconcile-1")!;
    const rec1Full = fullReadsAfter(trace, rec1At);
    const busTypeReads = getsOf(trace).filter((g) => g.addr === BUS_TYPE_L && g.start > rec1At).length;
    const reg1addrs = await paramAddrsOf(page);
    const reg1 = regKeys(reg1addrs);
    const lost = [...reg0].filter((a) => !reg1.has(a));
    const gained = [...reg1].filter((a) => !reg0.has(a));
    console.log(
      `after ${rec1Full} forced reconcile(s), ${busTypeReads} read(s) of ${BUS_TYPE_L}:` +
        ` registration ${reg0.size} → ${reg1.size} (${lost.length} lost, ${gained.length} gained)`,
    );
    // The premise first, or the two equalities below decide nothing: DeviceFollow's
    // subscribe() short-circuits when the derived set matches what is registered, so an
    // untouched `paramAddrs` is also exactly what a reconcile that never ran looks like.
    expect(rec1Full).toBeGreaterThan(0);
    // The writable address set is identical under FIXED. The two send-level addresses
    // the lock makes inert are still written, still registered, still followable — the
    // constraint is expressed in the screens and in the MIDI catalog, nowhere else.
    expect(lost).toEqual([]);
    expect(gained).toEqual([]);
    for (const a of CH1_M1_LEVEL) expect(reg1.has(a)).toBe(true);
    // The reconcile re-read BUS Type itself — the value on screen is what came back off
    // the device, not what the screen was already showing.
    expect(busTypeReads).toBeGreaterThan(0);
    await expect(param(page, "BUS Type").locator("select")).toHaveValue("1");

    // Phase 3 — the cross-node consequence, as a one-variable differential. Both
    // messages are the same shape on the same node in the same burst; what differs is
    // that FIXED locks the send LEVEL and leaves the send PAN alone (mixSendLocks:
    // panLinked is false whenever busFixed is true). The refused one is an ABSENCE, so
    // the burst is settled with settleAfter — the accepted one is what wakes the link.
    await mark(page, "midi-under-fixed");
    await pushMidi(page, [cc(7, 32), cc(8, 20)]);
    await settleAfter(page, "midi-under-fixed", 1200);
    trace = await traceOf(page);
    const lockedAt = markTime(trace, "midi-under-fixed")!;
    const underFixed = setsAfter(trace, lockedAt);
    const underFixedAddrs = new Set(underFixed.map((s) => s.addr!));
    console.log(`MIDI under FIXED emitted: ${underFixed.map((s) => `${s.addr}=${s.value}`).join(", ") || "(nothing)"}`);
    for (const a of CH1_M1_LEVEL) expect(underFixedAddrs.has(a)).toBe(false);
    for (const a of CH1_M1_PAN) expect(underFixedAddrs.has(a)).toBe(true);
    // The pan this accepted message decodes to, kept for phase 6: the identical CC is
    // re-sent there under Pan Link, and a refusal is only separable from a write that
    // had nothing to change if the plan is known to hold something else by then.
    const fixedPan = underFixed.find((s) => s.addr === CH1_M1_PAN[0])!.value!;

    // Phase 4 — node C, and node D, and every other send source. The console renders
    // the lock on EVERY strip that sends to MIX 1, none of which was written; the MIX 2
    // column on those same strips is untouched, which is what makes it the bus's lock
    // rather than a global one.
    await page.click("#btn-view-console");
    await expect(strip(page, "CH 1")).toBeVisible();
    const m1 = await sendFaders(page, "MIX 1").count();
    const m1Locked = await lockedSendFaders(page, "MIX 1").count();
    const m1Disabled = await page.locator('.con-strip .con-vfad[aria-label="MIX 1"][aria-disabled="true"]').count();
    const m2 = await sendFaders(page, "MIX 2").count();
    const m2Locked = await lockedSendFaders(page, "MIX 2").count();
    console.log(`console: MIX 1 send faders ${m1Locked}/${m1} read-only; MIX 2 ${m2Locked}/${m2}`);
    expect(m1).toBeGreaterThan(1); // more than one node's controls changed state
    expect(m1Locked).toBe(m1);
    expect(m1Disabled).toBe(m1);
    expect(m2Locked).toBe(0);

    // Phase 5 — release the lock and re-send the message that was swallowed. Without
    // this the phase-3 silence would also be explained by "that CC value happened to
    // land on the value the plan already held".
    await page.click("#btn-view-graph");
    await graphNode(page, "bus.mix1").click();
    await mark(page, "bus-vari");
    await chooseOption(param(page, "BUS Type").locator("select"), "0"); // VARI
    await expect(param(page, "Pan Link")).toHaveCount(1);
    await settleAfter(page, "bus-vari", 1200);
    await mark(page, "midi-after-unlock");
    await pushMidi(page, [cc(7, 32)]);
    await settleAfter(page, "midi-after-unlock", 1200);
    trace = await traceOf(page);
    const unlockedAt = markTime(trace, "midi-after-unlock")!;
    const afterUnlock = setsAfter(trace, unlockedAt);
    console.log(`the same CC after VARI emitted: ${afterUnlock.map((s) => `${s.addr}=${s.value}`).join(", ")}`);
    for (const a of CH1_M1_LEVEL) expect(afterUnlock.some((s) => s.addr === a)).toBe(true);

    // Phase 6 — the other half of the case: does the screen actually re-render the
    // controls the lock just took away? PAN_LINK is follow: "direct" (params.ts), so a
    // device-side flip is decoded straight into the plan and reflected through
    // reflectFollow's direct path — which repaints the dirty NODE (bus.mix1) and its
    // console strip, and does not touch the inspector. The inspector is showing a
    // control on a different node.
    //
    // FIXED. The reconcile's first read is held on a barrier throughout, which is what
    // makes the verdict below attributable: the 900 ms idle net that used to be the only
    // repair cannot run, so a panel that has already dropped the control was repaired by
    // the direct reflect (~50 ms) and by nothing else.
    const wire = page.locator('.wire-hit[data-from="ch1:out"][data-to="bus.mix1:in"]');
    await expect(wire).toHaveCount(1);
    // pointerdown AND pointerup: a synthetic press with no release latches the history's
    // press state "down" for the rest of the run (t3's undo-drag-latch finding).
    await wire.dispatchEvent("pointerdown");
    await wire.dispatchEvent("pointerup");
    await expect(paramExact(page, "Pan")).toHaveCount(1);
    await expect(paramExact(page, "Level")).toHaveCount(1);
    // An ElementHandle, deliberately, not a locator: a locator re-queries on use and
    // resolves to nothing once the rebuild has removed the row. The handle keeps the
    // DETACHED element — which is exactly the control the operator's hand is still on
    // when the lock lands, closure and all, and what the write-path guard has to refuse.
    const stalePanSlider = (await paramExact(page, "Pan").locator('input[type="range"]').elementHandle())!;
    expect(stalePanSlider).not.toBeNull();

    await seedMem(page, { [PAN_LINK]: 1 }); // the unit's own Pan Link is now ON
    await blockAt(page, "vd_get", 1);
    await mark(page, "panlink-notify");
    await pushNotify(page, [[589, 0, 0, 1]]);
    await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 20_000 });

    // The panel is repainted by the direct reflect itself, scoped to the nodes the panel
    // reads (`inspectorNodes`): a wire's controls are derived from the
    // DESTINATION bus, so a lock taken on bus.mix1 removes a control the panel is
    // rendering for ch1. Read at the instant the barrier froze the app, so the repair
    // provably came from the ~50 ms reflect and not from the frozen 900 ms net.
    const staleParamCount = await paramExact(page, "Pan").count();
    const staleHint = await page.locator("#inspector .hint", { hasText: "Pan Link" }).count();
    console.log(`under Pan Link the inspector shows ${staleParamCount} Pan control(s), ${staleHint} Pan-Link hint(s)`);
    expect(staleParamCount).toBe(0);
    expect(staleHint).toBe(1);

    // The residual window made deterministic: a handle captured BEFORE the notify keeps
    // its closure, so dispatching on it reaches `onUpdateParams` exactly as a slider the
    // rebuild had not yet removed would. That path now asks the same lock the MIDI
    // catalog asks, so nothing is authored and nothing reaches the wire.
    await mark(page, "stale-pan-edit");
    await stalePanSlider.evaluate((el: HTMLInputElement) => {
      el.value = String(Number(el.value) + 1);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settleAfter(page, "stale-pan-edit", 1200);
    trace = await traceOf(page);
    const staleAt = markTime(trace, "stale-pan-edit")!;
    const staleWrites = setsAfter(trace, staleAt);
    console.log(
      `the detached PAN slider emitted: ${staleWrites.map((s) => `${s.addr}=${s.value}`).join(", ") || "(nothing)"}` +
        `; status="${await page.locator("#statusbar").textContent()}"`,
    );
    for (const a of CH1_M1_PAN) expect(staleWrites.some((s) => s.addr === a)).toBe(false);
    await expect(page.locator("#statusbar")).toContainText("Pan Link");

    // The plan HAS the lock, and core/midi/controls.ts is where that is enforced. One
    // variable, mirrored from phase 3: the SAME burst that landed in full there is sent
    // again, and now the PAN is swallowed while the LEVEL still goes through — the free
    // one being what wakes the link for settleAfter. Controller 8 carries the value that
    // wrote `fixedPan` in phase 3 against a plan the slider just moved to `stalePan`, so
    // "the write had nothing to change" is excluded by measurement rather than by
    // assuming the codec is injective.
    await mark(page, "midi-under-panlink");
    await pushMidi(page, [cc(7, 96), cc(8, 20)]);
    await settleAfter(page, "midi-under-panlink", 1200);
    trace = await traceOf(page);
    const panLinkAt = markTime(trace, "midi-under-panlink")!;
    const underLink = setsAfter(trace, panLinkAt);
    const underLinkAddrs = new Set(underLink.map((s) => s.addr!));
    console.log(
      `MIDI under Pan Link emitted: ${underLink.map((s) => `${s.addr}=${s.value}`).join(", ") || "(nothing)"}` +
        ` (the identical CC wrote ${fixedPan} in phase 3, against a plan the lock now refuses)`,
    );
    for (const a of CH1_M1_PAN) expect(underLinkAddrs.has(a)).toBe(false);
    // The LEVEL went through — as far as a held link lets it. The barrier armed in phase
    // 6 is still holding vd_get #1, and the bridge serves one command at a time
    // (src-tauri/src/vd.rs), so live.ts's send loop — which awaits each vdSet — gets its
    // FIRST command onto the queue and never issues the linked instance behind it.
    // Asserting both would be asserting a bridge that serves two commands at once; what
    // the phase is about is that the level was authored and emitted at all while the pan
    // was swallowed, and one instance leaving states that as sharply as two. The pair is
    // asserted whole in phase 5, where nothing is held.
    expect(CH1_M1_LEVEL.filter((a) => underLinkAddrs.has(a))).toEqual([CH1_M1_LEVEL[0]]);

    // Phase 7 — the reconcile is no longer the repair, but it must not undo it. Releasing
    // the barrier lets the 900 ms idle net's whole-device reconcile run; it re-derives
    // the plan from the device (which holds Pan Link ON) and re-renders the panel.
    await mark(page, "release");
    await releaseBarrier(page);
    await settleAfter(page, "release", 2500, 20_000);
    trace = await traceOf(page);
    const releaseAt = markTime(trace, "release")!;
    const releaseFull = fullReadsAfter(trace, releaseAt);
    const healedParam = await paramExact(page, "Pan").count();
    const healedHint = await page.locator("#inspector .hint", { hasText: "Pan Link" }).count();
    const reg2addrs = await paramAddrsOf(page);
    const reg2 = regKeys(reg2addrs);
    console.log(
      `after ${releaseFull} reconcile(s): ${healedParam} Pan control(s),` +
        ` ${healedHint} Pan-Link hint(s); registration ${reg1.size} → ${reg2.size}`,
    );
    console.log(
      report(
        "bus type and pan link locks",
        // Read beside `reg2addrs`, so clause B gets a same-instant pair. This case's own
        // title is the answer it expects: a FIXED bus / Pan Link write locks the source
        // channels' send controls with no write and no shape change, and the assertions
        // below prove the registration did not move either.
        analyze(trace, {
          registration: reg2addrs,
          registrationWindow: { from: releaseAt },
          snapshot: await snapshotOf(page),
        }),
      ),
    );
    expect(healedParam).toBe(0);
    expect(healedHint).toBe(1);
    // The barrier's release really did let a whole-device reconcile through — the same
    // premise phase 2 needs, and the only thing that makes the registration below a
    // recomputed set rather than the one that has simply never been re-posted.
    expect(releaseFull).toBeGreaterThan(0);
    // Pan Link changed nothing about the address set either: the send pan is still
    // written and still registered while the app refuses every path that could move it.
    expect([...reg1].filter((a) => !reg2.has(a))).toEqual([]);
    expect([...reg2].filter((a) => !reg1.has(a))).toEqual([]);
    for (const a of CH1_M1_PAN) expect(reg2.has(a)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // shape-insert-fx-rate-and-slot-availability — a constraint expressed as data
  // rather than as an emit gate, and cross-node contention.
  //
  // Two constraints share one control. The sample-rate ceiling (core/constraints.ts,
  // params.ts insertFxAvailable) is UI-only by design: the unit accepts and holds writes
  // to the "unavailable" params at 192 kHz — measured — so translate.ts never consults
  // plan.sampleRate for anything but SAMPLE_RATE itself. The device-wide 1-of slot
  // (user guide p.180) is cross-node: whichever channel holds "amp" removes the four
  // guitar amps from every other channel's menu, with nothing written to those channels.
  //
  // The rate half is a two-page differential (the picker locks while live, so the rate
  // has to be the device's own at session start), and the slot half runs on the 48 kHz
  // page where a selection is possible at all.
  //
  // The name says AGREE, because that is what the body proves (phase 3's two locked
  // surfaces, phase 5's chip taking the one effect ch3's own menu leaves open). The
  // DISAGREEMENT is the pre-fix behaviour and is described where it is pinned, in
  // phase 5 — the console's chip re-took a slot the inspector was greying out. A title
  // stating the defect the fix removed reads as a live claim about the app.
  // ---------------------------------------------------------------------------
  test("the insert-FX rate ceiling and the 1-of slot are data, not emit gates, and the two screens agree about both", async ({
    page,
    context,
  }) => {
    // Both sessions start from the same device state: ch1 holding Compander-H (so the
    // "compander" slot is taken and the engine array is in the write set), ch2..ch4 on
    // No Effect. The fake answers 0 for an unwritten address, and 0 is not an insert-FX
    // option — the sentinel has to be explicit or every channel reads as "some effect".
    const seed = (p: Page): Promise<void> =>
      seedMem(p, {
        [insertFxAddr(0)]: COMPANDER_H,
        [insertFxAddr(1)]: INSERT_FX_VD_NONE,
        [insertFxAddr(2)]: INSERT_FX_VD_NONE,
        [insertFxAddr(3)]: INSERT_FX_VD_NONE,
      });

    // Page A — the device is running at 192 kHz, above every insert effect's ceiling.
    await installFake(page);
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    expect(await hasProbe(page)).toBe(true);
    await seed(page);
    // The rate is the one address a full readback alone reads, and the picker locks
    // while live — so the session's rate has to be the device's own at start-up.
    await seedMem(page, { [RATE_ADDR]: 192000 });
    await goLive(page);
    await setLatency(page, { get: 2, set: 8 });

    // Page B — the identical script at 48 kHz. localStorage is per origin per context,
    // so the second page would otherwise inherit page A's remembered rate.
    const lo = await context.newPage();
    await installFake(lo);
    await lo.goto("/");
    await expect(lo.locator("#model-picker")).toHaveValue("URX44V");
    await seed(lo);
    await seedMem(lo, { [RATE_ADDR]: 48000 });
    await goLive(lo);
    await setLatency(lo, { get: 2, set: 8 });

    // Phase 1 — the two runs really are at different rates, and their write sets are
    // the same set. The rate check is not decoration: without it the equality below
    // would pass just as well if both pages were at 48 kHz.
    const hiSnap = await snapshotOf(page);
    const loSnap = await snapshotOf(lo);
    expect(hiSnap?.[RATE_ADDR]).toBe(192000);
    expect(loSnap?.[RATE_ADDR]).toBe(48000);

    const hiReg = regKeys(await paramAddrsOf(page));
    const loReg = regKeys(await paramAddrsOf(lo));
    const onlyHi = [...hiReg].filter((a) => !loReg.has(a));
    const onlyLo = [...loReg].filter((a) => !hiReg.has(a));
    console.log(
      `registration: 192 kHz = ${hiReg.size}, 48 kHz = ${loReg.size}; ${onlyHi.length}/${onlyLo.length} differ`,
    );
    // Identical, address for address. Every UI-visible rate limit in constraints.ts —
    // insert FX, the stereo channels' EQ, FX2 — leaves the write set untouched.
    expect(onlyHi).toEqual([]);
    expect(onlyLo).toEqual([]);
    // Named explicitly, so the equality above cannot be satisfied by both sets simply
    // lacking the addresses under test.
    for (const reg of [hiReg, loReg]) {
      expect(reg.has(insertFxAddr(0))).toBe(true);
      expect(reg.has(insertFxOnAddr(0))).toBe(true);
      expect(reg.has(insertFxAddr(1))).toBe(true);
    }
    // …and the effect the unit is running at 192 kHz is written out as itself, not
    // coerced to No Effect on the way.
    expect(hiSnap?.[insertFxAddr(0)]).toBe(COMPANDER_H);
    expect(loSnap?.[insertFxAddr(0)]).toBe(COMPANDER_H);

    // Phase 2 — what the two screens say. The inspector disables the options the rate
    // forbids; the console replaces the whole chip with a read-only one.
    await graphNode(page, "ch1").click();
    await graphNode(lo, "ch1").click();
    const hiOpts = await insertFxOptions(page);
    const loOpts = await insertFxOptions(lo);
    console.log(
      `192 kHz inspector options disabled: ${hiOpts
        .filter((o) => o.disabled)
        .map((o) => o.text)
        .join(", ")}`,
    );
    console.log(
      `48 kHz  inspector options disabled: ${
        loOpts
          .filter((o) => o.disabled)
          .map((o) => o.text)
          .join(", ") || "(none)"
      }`,
    );
    // Every effect is out at 192 kHz; only "No Effect" (no ceiling) survives. At 48 kHz
    // ch1's own menu is fully open — the 1-of slot it holds is not held against itself.
    expect(hiOpts.filter((o) => o.disabled)).toHaveLength(hiOpts.length - 1);
    expect(hiOpts.find((o) => !o.disabled)?.text).toBe("No Effect");
    expect(loOpts.filter((o) => o.disabled)).toHaveLength(0);

    await page.click("#btn-view-console");
    await lo.click("#btn-view-console");
    const hiChip = strip(page, "CH 1").getByRole("button", { name: "INS FX", exact: true });
    const loChip = strip(lo, "CH 1").getByRole("button", { name: "INS FX", exact: true });
    await expect(hiChip).toHaveAttribute("aria-disabled", "true");
    await expect(loChip).not.toHaveAttribute("aria-disabled", "true");
    await page.click("#btn-view-graph");
    await lo.click("#btn-view-graph");

    // Phase 3 — the two screens agree about the same lock. The console calls the insert
    // FX unavailable at 192 kHz and renders its chip inert; the inspector's bypass toggle
    // right below the disabled selector reads the same menu and renders locked and OFF —
    // the display/plan split the stereo CH EQ toggle has. What is NOT gated is the write:
    // phase 1 measured both addresses still in the set, still carrying the plan's values,
    // because the device does accept them at this rate.
    const bypass = await insertFxBypass(page);
    const onBtn = bypass.locator("button", { hasText: /^ON$/ });
    const offBtn = bypass.locator("button", { hasText: /^OFF$/ });
    await expect(onBtn).toBeDisabled();
    await expect(offBtn).toBeDisabled();
    await expect(offBtn).toHaveClass(/on/); // displayed OFF whatever the plan holds
    // Dispatched rather than clicked: a disabled button refuses a real click, and the
    // question is whether the row can author anything at all. An ABSENCE, so it is
    // settled rather than waited quiet (the harness's first trap).
    await mark(page, "bypass-at-192k");
    await onBtn.dispatchEvent("click");
    await settleAfter(page, "bypass-at-192k", 1200);
    let trace = await traceOf(page);
    const bypassAt = markTime(trace, "bypass-at-192k")!;
    const bypassWrites = setsAfter(trace, bypassAt);
    console.log(
      `inspector bypass at 192 kHz emitted: ${bypassWrites.map((s) => `${s.addr}=${s.value}`).join(", ") || "(nothing)"}`,
    );
    expect(bypassWrites.some((s) => s.addr === insertFxOnAddr(0))).toBe(false);
    // …and the locked display did not move the plan either: both addresses are still
    // written out as what the device holds, so the lock is a display rule, not an emit
    // gate — the bypass the screen prints OFF is the device's own OFF.
    const lockedSnap = await snapshotOf(page);
    expect(lockedSnap?.[insertFxAddr(0)]).toBe(COMPANDER_H);
    expect(lockedSnap?.[insertFxOnAddr(0)]).toBe(0);

    // Phase 4 — cross-node contention, on the 48 kHz page. ch1 holds the "compander"
    // slot, which is device-wide: ch2's menu loses both companders and keeps the four
    // guitar amps, so the disabling is the SLOT's and not a blanket one.
    await graphNode(lo, "ch2").click();
    const ch2Opts = await insertFxOptions(lo);
    const ch2Disabled = ch2Opts.filter((o) => o.disabled).map((o) => o.text);
    console.log(`ch2 options disabled while ch1 holds Compander-H: ${ch2Disabled.join(", ")}`);
    expect(ch2Disabled.sort()).toEqual(["Compander-H", "Compander-S"]);

    // The gesture: ch2 takes the "amp" slot. This is the tier's shape change — an
    // insert-FX selection GROWS the write set, because INSERT_FX_ON is emitted only
    // while an effect is selected (translate.ts). Computed here rather than assumed.
    const before = await writeSetOf(lo);
    await clearLedger(lo);
    await mark(lo, "ch2-takes-amp");
    await chooseOption(await insertFxSelect(lo), { label: "Clean" });
    await settleAfter(lo, "ch2-takes-amp", 1500);

    trace = await traceOf(lo);
    const ampAt = markTime(trace, "ch2-takes-amp")!;
    const ampWrites = flushWrites(trace, ampAt);
    const after = await writeSetOf(lo);
    const added = [...after].filter((a) => !before.has(a));
    const ledger = await ledgerOf(lo);
    const uiKeys = [...new Set(ledger.filter((l) => l.source === "ui").map((l) => `${l.field}[${l.key}]`))];
    const regAfterAmp = regKeys(await paramAddrsOf(lo));
    console.log(timeline(trace, { from: ampAt - 50, limit: 40 }));
    console.log(`ch2 selection flush emitted: ${ampWrites.map((s) => `${s.addr}=${s.value}`).join(", ")}`);
    console.log(`write set ${before.size} → ${after.size}; added ${added.join(", ") || "(nothing)"}`);
    console.log(
      `registered after the growth: ${added.filter((a) => regAfterAmp.has(a)).join(", ") || "(none of them)"}`,
    );
    console.log(`ledger for the gesture (ui): ${uiKeys.join(", ")}`);

    // The premise, asserted: exactly one address entered the set, and it is the bypass
    // the selector binds. (An engine-array slot enters only once the plan carries one —
    // ch2's params are unread, so this selection adds the ON and nothing else.)
    expect(added).toEqual([insertFxOnAddr(1)]);
    // …and it entered the REGISTRATION with the write set, in the selection's own flush
    // (live.ts followSetStale → DeviceFollow.refresh at the end of a flush that
    // captured). This pinned the opposite while the re-subscribe ran at begin() and after
    // a reconcile only, which left the app writing an address a device-side flip of which
    // it could not hear. It is the growth half of the file header's snapshot /
    // registration asymmetry, and what it now asserts is that the two sets agree.
    // Attributed to the flush: no reconcile landed inside the settle wait, and one would
    // have re-registered through follow.ts whatever the flush did.
    expect(deviceReflectsAfter(trace, ampAt)).toBe(0);
    expect(regAfterAmp.has(insertFxOnAddr(1))).toBe(true);
    expect(ampWrites.map((s) => s.addr)).toEqual([insertFxAddr(1), insertFxOnAddr(1)]);
    // …and the two nodes whose MENUS the gesture just changed got no insert-FX write of
    // their own. Stated of the flush, not of the run: INSERT_FX is a converge param, and
    // the round behind this flush re-sends a large slice of the plan against this fake
    // (see flushWrites) — which says nothing about the gesture.
    expect(ampWrites.some((s) => s.addr === insertFxAddr(0) || s.addr === insertFxAddr(2))).toBe(false);
    expect(uiKeys).toEqual(["nodeParams[ch2]"]);

    // ch3 now sees both slots gone — two different nodes' selections, expressed purely
    // as data on ch3's own menu, and neither of them a write ch3 was party to.
    await graphNode(lo, "ch3").click();
    const ch3Disabled = (await insertFxOptions(lo)).filter((o) => o.disabled).map((o) => o.text);
    console.log(`ch3 options disabled (ch1 = compander, ch2 = amp): ${ch3Disabled.join(", ")}`);
    expect(ch3Disabled.sort()).toEqual(["Clean", "Compander-H", "Compander-S", "Crunch", "Drive", "Lead"]);

    // Phase 5 — the same constraint asked of the other screen. The console's type list is
    // built from the SAME menu the inspector renders (core/constraints.ts insertFxMenu),
    // so what it offers ch3 can only be what the greying above left open. Two slots are
    // held by two other channels, so exactly one option is: Pitch Fix, whose own ceiling
    // this 48 kHz page is at.
    const ch3Free = (await insertFxOptions(lo)).filter((o) => !o.disabled && o.text !== "No Effect");
    expect(ch3Free.map((o) => o.text)).toEqual(["Pitch Fix"]);
    await lo.click("#btn-view-console");
    await expect(strip(lo, "CH 3")).toBeVisible();
    // The two screens are compared directly here rather than inferred from what the
    // gesture wrote: the popover's own live rows against the select's live options.
    await strip(lo, "CH 3").locator(".con-ifxopen").click();
    await expect(lo.locator(".con-ifxpop")).toBeVisible();
    const popFree = await lo
      .locator(".con-ifxpop .irow:not(.off) .nm")
      .evaluateAll((els) => els.map((e) => e.textContent));
    expect(popFree).toEqual(["No Effect", "Pitch Fix"]);
    await mark(lo, "console-ins-fx-ch3");
    await lo.locator(".con-ifxpop .irow", { hasText: "Pitch Fix" }).first().click();
    await settleAfter(lo, "console-ins-fx-ch3", 1500);
    // Choosing opens that effect's screen; the rest of this case is on the CONSOLE behind
    // it. Dismissed AFTER the settle, so the screen's own open is inside the window the
    // flush is measured over rather than racing it.
    await closeDynScreen(lo);

    trace = await traceOf(lo);
    const chipAt = markTime(trace, "console-ins-fx-ch3")!;
    const chipWrites = flushWrites(trace, chipAt);
    const byAddr = new Map(chipWrites.map((s) => [s.addr!, s.value]));
    console.log(`console INS FX on CH 3 flush emitted: ${chipWrites.map((s) => `${s.addr}=${s.value}`).join(", ")}`);
    // PINNED — the finding, rewritten to the fixed behaviour. The CONSOLE used to assign
    // ch3 the very effect ch2 had taken one gesture earlier and that ch3's own menu
    // listed as unavailable, putting two channels on one device-wide 1-of slot (whose
    // engine array is a single shared parameter block, 697) with both selections on the
    // wire. The strip no longer assigns anything by itself: what ch3 got is the row the
    // list offered, and the list is the menu that greyed ch2's effect out.
    const ch2Effect = ampWrites.find((s) => s.addr === insertFxAddr(1))!.value;
    expect(byAddr.get(insertFxAddr(2))).toBe(PITCH_FIX);
    expect(byAddr.get(insertFxAddr(2))).not.toBe(ch2Effect);
    expect(byAddr.get(insertFxOnAddr(2))).toBe(1);

    // …and the take reaches the strips it did not write: with all three input slots now
    // held, CH 4 has nothing left to take. Its face says so — the slot reason, not the
    // rate one — while staying operable, because releasing has to be reachable from
    // exactly this state; what is empty is the list behind it. On screen at all because
    // taking a slot re-renders the whole view.
    const ch4Face = strip(lo, "CH 4").locator(".con-ifxface");
    await expect(ch4Face).toHaveClass(/\bvacant\b/);
    await expect(ch4Face).toHaveAttribute("title", en.inspector.insFxSlotLocked);
    await strip(lo, "CH 4").locator(".con-ifxopen").click();
    await expect(lo.locator(".con-ifxpop")).toBeVisible();
    expect(
      await lo.locator(".con-ifxpop .irow:not(.off) .nm").evaluateAll((els) => els.map((e) => e.textContent)),
    ).toEqual(["No Effect"]);
    await lo.keyboard.press("Escape");
    // CH 3, which just took one, is the positive control: it holds an effect, so its face
    // is a live bypass rather than a vacancy.
    const ch3Face = strip(lo, "CH 3").locator(".con-ifxface");
    await expect(ch3Face).not.toHaveClass(/\bvacant\b/);
    await expect(ch3Face).toHaveAttribute("aria-pressed", "true");

    // Back in the inspector the two screens now say the same thing: ch3's selector shows
    // the effect the chip took as its current value, and lists it ENABLED — a node's own
    // selection is not held against itself — while the slots the other two channels hold
    // stay greyed out.
    await lo.click("#btn-view-graph");
    await graphNode(lo, "ch3").click();
    const ch3After = await insertFxOptions(lo);
    const ch3Value = await (await insertFxSelect(lo)).inputValue();
    const chosen = ch3After.find((o) => o.text === "Pitch Fix")!;
    const stillDisabled = ch3After.filter((o) => o.disabled).map((o) => o.text);
    console.log(`ch3 selector value ${ch3Value}; "Pitch Fix" disabled = ${chosen.disabled}`);
    console.log(`ch3 options still disabled: ${stillDisabled.join(", ")}`);
    expect(ch3Value).toBe(String(byAddr.get(insertFxAddr(2))));
    expect(chosen.disabled).toBe(false);
    expect(stillDisabled.sort()).toEqual(["Clean", "Compander-H", "Compander-S", "Crunch", "Drive", "Lead"]);

    console.log(
      report(
        "insert fx rate and slot availability",
        // Clean on clause B, and the reason is the subject of the assertion above rather
        // than an absence of gestures: each channel that took an effect put its
        // INSERT_FX_ON into the emitted set, and each selection's own flush registered
        // for it. Reported, not asserted: the case's subject is the selector's
        // availability, and the address sets are the backdrop.
        analyze(trace, {
          registration: [...(await paramAddrsOf(lo))],
          registrationWindow: { from: ampAt },
          snapshot: await snapshotOf(lo),
        }),
      ),
    );
    await lo.close();
  });
});
