import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  installFake,
  goLive,
  mark,
  pushNotify,
  traceOf,
  paramAddrsOf,
  setLatency,
  settleAfter,
  divergeAt,
  depthOf,
  hasProbe,
  snapshotOf,
  setDialogAnswer,
  dialogsOf,
  blockAt,
  releaseBarrier,
  type TraceEvent,
} from "./fake-device";
import { analyze, report, timeline, markTime, setsOf, getsOf } from "./analyze";
import { faderOf, graphNode, openEqScreen, openInsertFxScreen, closeDynScreen } from "./ui";
import { pickBand } from "../dyn-helpers";

// T2c shape-change — the two T2 cases whose subject is the ENGINE side of the write
// set rather than the selector side (docs/{en,ja}/live-race-harness.md):
//
//   - a dragged control whose param is flagged sideEffect "refetch", so the flush
//     window and the whole-node readback interleave for the length of one gesture and
//     the history is re-based inside it;
//   - the insert-FX engine arrays, which are addressed by SLOT WITH NO OWNER AXIS
//     (insert-fx-effect.ts: guitar 697 / pitch 701 / input compander 689 / output 693,
//     emitted by translate.ts as `engine:0:slot`), so two plan owners holding the same
//     effect family write the same device address.
//
// Same observables as T2 and T2b: the `addrs` argument of vd_params_subscribe IS the
// follow registration set, and 766:0:0 is read by a FULL readback and by nothing else,
// so counting reads of that one address counts whole-device reconciles exactly. Read
// latency is 1-2 ms for T2's reason — a whole-device readback is ~800 sequential reads.
//
// Both cases end on the link's own silence (`settleAfter`), never on a fixed sleep.

/** Read by a full device readback only — applyNodeState skips it by design, so a read
 *  of this address is one whole-device reconcile. */
const RATE_ADDR = "766:0:0";

/** ch1 EQ 1-Knob LEVEL. It and its ON/TYPE siblings (46 / 47) are the catalog's only
 *  sideEffect "refetch" parameters. */
const CH1_ONE_KNOB_LEVEL = "48:0:0";
/** ch1's LOW band gain — the band block starts 5 params after the EQ-ON anchor (44 →
 *  49) with a 5-param stride, gain last (49 on / 50 type / 51 q / 52 freq / 53 gain).
 *  It carries NO sideEffect, which is what makes it this case's control — and it is
 *  also what arm B counts refetch passes on (see REFETCH_ANCHOR there). */
const CH1_EQ_LOW_GAIN = "53:0:0";

/** Insert-FX selector on the two mono channels: one address per owner. */
const CH1_INSERT_FX = "135:0:0";
const CH2_INSERT_FX = "135:0:1";
/** The INPUT compander's engine array (ENGINE_COMPANDER_INPUT). Addressed
 *  `689:0:<slot>` — no channel axis anywhere in it. */
const ENGINE_COMPANDER = 689;
/** COMPANDER_PARAMS slots, in catalog order: threshold / ratio / attack / release /
 *  outGain / width. Every one of them is written per OWNER to the same address. */
const COMPANDER_SLOTS = [6, 7, 8, 9, 10, 11];
const COMPANDER_DEFAULTS: Record<number, number> = { 6: -1000, 7: 350, 8: 1000, 9: 2290, 10: 0, 11: 600 };
const ENGINE_THRESHOLD = `${ENGINE_COMPANDER}:0:6`;
const CH4_FADER = "139:0:3";

/** Whole-device reconciles that began after `at` (see RATE_ADDR). */
const fullReadsAfter = (trace: TraceEvent[], at: number): number =>
  getsOf(trace).filter((g) => g.addr === RATE_ADDR && g.start > at).length;

const setsBetween = (trace: TraceEvent[], addr: string, from: number, to = Number.POSITIVE_INFINITY): number[] =>
  setsOf(trace)
    .filter((s) => s.addr === addr && s.start > from && s.start < to)
    .map((s) => s.value ?? Number.NaN);

const startsBetween = (trace: TraceEvent[], addr: string, from: number, to = Number.POSITIVE_INFINITY): number[] =>
  setsOf(trace)
    .filter((s) => s.addr === addr && s.start > from && s.start < to)
    .map((s) => s.start);

const readsBetween = (trace: TraceEvent[], addr: string, from: number, to = Number.POSITIVE_INFINITY): number =>
  getsOf(trace).filter((g) => g.addr === addr && g.start > from && g.start < to).length;

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
/**
 * One continuous pointer drag across a range input's own track: press at `from`, walk
 * to `to` in `steps`, pause `hold` ms at each. The pauses are what make it a drag
 * rather than a jump — consecutive positions have to land in DIFFERENT 120 ms flush
 * windows or the case measures one flush and calls it a cadence. The mark is stamped
 * before the lift, so "issued during the drag" is decidable from the trace.
 *
 * The slider is FOCUSED first, and that is a property of the driver rather than of the
 * app: a mousedown that also moves focus fires `focusout` on the element that had it,
 * and focusout is a history boundary — measured, the press then commits its own first
 * edit on the spot and one drag costs two entries. An operator's hand reaches a slider
 * the same way, but a case counting entries has to state which of them the gesture
 * caused. Pre-focusing removes the transition and leaves the press as the only thing
 * under test.
 */
async function dragSlider(
  page: Page,
  slider: Locator,
  opts: { from: number; to: number; steps: number; hold: number; liftMark: string },
): Promise<{ ms: number; values: number[] }> {
  await slider.focus();
  const box = (await slider.boundingBox())!;
  const y = box.y + box.height / 2;
  const at = (f: number): number => box.x + box.width * f;
  const values: number[] = [];
  await page.mouse.move(at(opts.from), y);
  await page.mouse.down();
  const t0 = Date.now();
  values.push(Number(await slider.inputValue()));
  for (let i = 1; i <= opts.steps; i++) {
    await page.mouse.move(at(opts.from + ((opts.to - opts.from) * i) / opts.steps), y);
    await page.waitForTimeout(opts.hold);
    values.push(Number(await slider.inputValue()));
  }
  const ms = Date.now() - t0;
  await mark(page, opts.liftMark);
  await page.mouse.up();
  return { ms, values };
}

/** Gaps between consecutive write times, rounded — the flush cadence, as achieved. */
const gapsOf = (times: number[]): number[] => times.slice(1).map((t, i) => Math.round(t - times[i]));

test.describe("T2c shape-change", () => {
  test.beforeEach(async ({ page }) => {
    await installFake(page);
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  // shape-eq-oneknob-level-refetch-storm. The EQ 1-Knob LEVEL is the catalog's only
  // DRAGGED control whose parameter is flagged sideEffect "refetch" (params.ts 46/47/48),
  // so one gesture drives the flush window and a whole-NODE readback against each other
  // for its whole length: every window that carries the level triggers refetchNodes,
  // and every one of those settles the history against what the read authored (main.ts
  // refetchNodes) — where a whole-plan re-base used to drop the entry the drag has open,
  // which is the fix step 3 below asserts.
  //
  // Laddered against a control on the same screen: the LOW band's Gain is a dragged
  // slider of the same shape with NO sideEffect, so everything the two arms do not
  // share is attributable to the flag rather than to dragging.
  test("a 1-Knob level drag runs one readback per flush window and re-bases the history inside it", async ({
    page,
  }) => {
    expect(await hasProbe(page)).toBe(true);
    await goLive(page);
    await openEqScreen(page, "ch1");
    // Fast reads: one node readback is ~60 addresses and the drag has to fit several.
    await setLatency(page, { get: 1, set: 5 });

    // ---- arm A (control): a dragged slider with no sideEffect ------------------
    // The LOW band, explicitly. It is where the screen opens — the band is a cursor into
    // the parameters, not a way of reading the processor, so it resets per open — but
    // stating it keeps the case independent of that.
    await pickBand(page, 0);
    const gain = page.locator('#dyn-screen-box input[data-dyn="gain"]');
    await expect(gain).toBeEnabled();
    const gainBefore = Number(await gain.inputValue());
    const depthBeforeCtl = await depthOf(page);

    await mark(page, "ctl-drag");
    const ctl = await dragSlider(page, gain, { from: 0.3, to: 0.72, steps: 6, hold: 90, liftMark: "ctl-lift" });
    await settleAfter(page, "ctl-lift", 1200);

    let trace = await traceOf(page);
    const ctlAt = markTime(trace, "ctl-drag")!;
    const ctlLift = markTime(trace, "ctl-lift")!;
    const ctlWrites = setsBetween(trace, CH1_EQ_LOW_GAIN, ctlAt);
    const ctlMidDrag = setsBetween(trace, CH1_EQ_LOW_GAIN, ctlAt, ctlLift);
    const ctlRefetch = readsBetween(trace, CH1_EQ_LOW_GAIN, ctlAt);
    const ctlFull = fullReadsAfter(trace, ctlAt);
    // Every read of any kind, not only reads of the dragged address: "reads nothing
    // back" is the floor arm B is measured against, and counting one address would
    // still pass if the gesture provoked a readback that happened to skip it.
    const ctlAnyRead = getsOf(trace).filter((g) => g.start > ctlAt).length;
    const gainAfter = Number(await gain.inputValue());
    const depthAfterCtl = await depthOf(page);

    console.log(
      `[control] band-gain drag ${ctl.ms} ms over ${ctl.values.length} positions ${ctl.values.join("→")}: ` +
        `${ctlWrites.length} write(s) on ${CH1_EQ_LOW_GAIN} = ${ctlWrites.join(", ")}` +
        ` (${ctlMidDrag.length} before the lift), gaps ${gapsOf(startsBetween(trace, CH1_EQ_LOW_GAIN, ctlAt)).join("/")} ms;` +
        ` ${ctlRefetch} read(s) of it, ${ctlAnyRead} read(s) of anything, ${ctlFull} full reconcile(s); undo depth` +
        ` ${depthBeforeCtl.undo} → ${depthAfterCtl.undo}; slider ${gainBefore} → ${gainAfter}`,
    );

    // A drag on a non-sideEffect param flushes on cadence and reads NOTHING back — the
    // floor the refetch arm below is read against.
    expect(ctlMidDrag.length).toBeGreaterThan(1);
    expect(ctlRefetch).toBe(0);
    expect(ctlAnyRead).toBe(0);
    expect(ctlFull).toBe(0);
    expect(gainAfter).not.toBe(gainBefore);
    // One gesture, one entry, and one Ctrl+Z puts the slider back exactly where the
    // press found it. This is what "the drag is one undo entry" looks like when nothing
    // re-bases inside it.
    expect(depthAfterCtl.undo - depthBeforeCtl.undo).toBe(1);
    await mark(page, "ctl-undo");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(gain).toHaveValue(String(gainBefore));
    await settleAfter(page, "ctl-undo", 900, 2000);

    // ---- arm B: the same gesture on the refetch-flagged 1-Knob LEVEL -----------
    // 1-Knob ON first: the level row is locked while it is off (dyn-eq.ts), and the ON
    // write is itself a refetch, so it is settled out of the way before the drag.
    await mark(page, "oneknob-on");
    await oneKnobFace(page, 0).click();
    await settleAfter(page, "oneknob-on", 1200);
    const level = page.locator("#dyn-oneknob-level");
    await expect(level).toBeEnabled();
    const levelBefore = Number(await level.inputValue());
    const depthBefore = await depthOf(page);

    await mark(page, "level-drag");
    // Longer than arm A's, and that is a property of the refetch arm rather than a
    // preference: a flush carrying a sideEffect param now waits for the device to
    // announce the write before reading it back, so one cycle is write + announcement +
    // read where the control arm's is write alone. The gesture has to outlast several of
    // them for "issued mid-drag" to have anything to count.
    const drag = await dragSlider(page, level, { from: 0.12, to: 0.85, steps: 16, hold: 90, liftMark: "level-lift" });
    const levelAtLift = Number(await level.inputValue());
    await settleAfter(page, "level-lift", 1500);

    trace = await traceOf(page);
    const dragAt = markTime(trace, "level-drag")!;
    const liftAt = markTime(trace, "level-lift")!;
    const writes = setsBetween(trace, CH1_ONE_KNOB_LEVEL, dragAt);
    const midDrag = setsBetween(trace, CH1_ONE_KNOB_LEVEL, dragAt, liftAt);
    const gaps = gapsOf(startsBetween(trace, CH1_ONE_KNOB_LEVEL, dragAt, liftAt));
    // Every scoped readback of ch1 reads the whole input EQ block — the four bands and
    // then the 1-knob (readback.ts readEqBands / readEqOneKnob) — and with no notify
    // pushed nothing else reads at all, so a read of the LOW band's gain IS one refetch
    // pass, confirmed by the full-reconcile count being zero.
    //
    // The count is anchored on a BAND address rather than on 48:0:0, the address the
    // drag writes, and that is not interchangeable. Whether a pass reads the written
    // address at all is a property of what the UNIT said: the app answers an address the
    // unit has announced out of that announcement and never asks, so the count off
    // 48:0:0 reads 0 on a correct app AND on an app that never refetched at all. The
    // band gains are what the 1-knob makes the unit recompute (the collateral the
    // refetch exists to collect), nothing in this arm writes them, so they come off the
    // unit in every case.
    const REFETCH_ANCHOR = CH1_EQ_LOW_GAIN;
    const refetches = readsBetween(trace, REFETCH_ANCHOR, dragAt);
    // Logged beside it for exactly that reason: the two counts moving apart is what a
    // change in the overlay looks like from here.
    const writtenReads = readsBetween(trace, CH1_ONE_KNOB_LEVEL, dragAt);
    // …and how many of them were issued while the pointer was still down: a readback
    // straddling later moves of the same gesture is the shape this whole tier is about.
    const midRefetch = readsBetween(trace, REFETCH_ANCHOR, dragAt, liftAt);
    const fullReads = fullReadsAfter(trace, dragAt);
    const levelAfter = Number(await level.inputValue());
    const depthAfter = await depthOf(page);

    console.log(timeline(trace, { from: dragAt - 50, limit: 80 }));
    console.log(
      `[refetch] level drag ${drag.ms} ms over ${drag.values.length} positions ${drag.values.join("→")}: ` +
        `${writes.length} write(s) on ${CH1_ONE_KNOB_LEVEL} (${midDrag.length} before the lift), ` +
        `flush gaps ${gaps.join("/")} ms; ${refetches} node readback(s) counted on ${REFETCH_ANCHOR} ` +
        `(${midRefetch} issued mid-drag), ${fullReads} full reconcile(s); ` +
        `${writtenReads} read(s) of the written address ${CH1_ONE_KNOB_LEVEL}`,
    );
    console.log(
      `undo depth ${depthBefore.undo} → ${depthAfter.undo}; slider ${levelBefore} → ${levelAtLift} → ${levelAfter}`,
    );
    // Decides invariants 1-4 for this run and nothing else: the declared edit is the
    // instant the press landed, so invariant 1 asks whether a read of 48:0:0 was ALREADY
    // in flight then, invariant 2 whether anything carrying it left, invariant 3 whether
    // the snapshot holds a value never sent, and invariant 4 whether a write was issued
    // inside an in-flight read. The straddle that this case is actually about — a
    // readback issued mid-gesture and resolving over later moves — is `midRefetch`
    // above, counted directly.
    const storm = analyze(trace, {
      edits: [{ label: "1-Knob level drag", addr: CH1_ONE_KNOB_LEVEL, at: dragAt }],
      snapshot: await snapshotOf(page),
    });
    console.log(report("eq 1-knob level refetch storm", storm));
    // Invariant 1 is not left as a log line, because the counts below are read against
    // it: no read of 48:0:0 was in flight when the press landed, so every readback this
    // arm counts is the drag's own consequence rather than something already running.
    // The other three stay logged — 4 in particular is a property of the flush/refetch
    // interleave this case measures directly.
    expect(storm.filter((f) => f.inv === 1)).toHaveLength(0);

    // 1 — THE DESIGN. The cadence survives: the level is written repeatedly WHILE the
    // pointer is still down, and each of those writes costs a whole-node readback. The
    // refetch split exists for exactly this (live.test.ts "keeps flushing on cadence
    // through a 1-knob level drag"): a converge would have made the window back off and
    // the unit would have heard nothing until the pointer stopped.
    //
    // WHERE THE WINDOW ENDS, exactly. Each cycle is write → the unit's announcement of
    // it (fake-device.ts ANNOUNCE_MS) → the pass's reads, and the pin is that the first
    // read of each cycle lands AFTER that announcement and PROMPTLY after it. Both
    // directions of the regression are named by it: a pass that stopped waiting reads
    // before the notify, and one that fell back to the bounded window reads ~200 ms
    // after it. Nothing is queued between the two events, so the delta is not a measure
    // of machine load the way an absolute gap is.
    const announcements = trace.filter((e) => e.kind === "notify" && e.addr === CH1_ONE_KNOB_LEVEL && e.t > dragAt);
    const writeSpans = setsOf(trace).filter((g) => g.addr === CH1_ONE_KNOB_LEVEL && g.start > dragAt);
    const cycles = writeSpans.map((w) => {
      const ann = announcements.find((e) => e.t >= w.end);
      const firstRead = getsOf(trace).find((g) => g.start >= w.end);
      return { at: w.start, ann: ann?.t, read: firstRead?.start };
    });
    console.log(
      `[refetch] per cycle, write → announcement → first read: ` +
        cycles
          .map((c) =>
            c.ann === undefined || c.read === undefined
              ? `${c.at.toFixed(0)}: —`
              : `+${(c.ann - c.at).toFixed(0)}/+${(c.read - c.ann).toFixed(0)} ms`,
          )
          .join(", "),
    );
    for (const c of cycles) {
      expect(c.ann).toBeDefined();
      expect(c.read).toBeDefined();
      expect(c.read!).toBeGreaterThanOrEqual(c.ann!);
      expect(c.read! - c.ann!).toBeLessThan(80);
    }

    // …and the gap between flushes as a coarse net beside it. It CANNOT be tightened to
    // catch the same regression, and saying so is the point of this paragraph: the gap
    // is announcement (100 ms) plus the pass's ~70 sequential reads, and the reads are
    // the dominant and load-sensitive term. Measured 421/434/440 ms here; the bounded-
    // fallback regression would print ~640, which a ceiling low enough to catch would
    // sit under the read chunk's own headroom on a slower machine. So the ceiling only
    // says the cadence did not COLLAPSE — the several-windows-per-gesture property this
    // case is about — and the per-cycle pin above is what watches the wait.
    expect(midDrag.length).toBeGreaterThan(1);
    expect(Math.max(...gaps)).toBeLessThan(700);
    expect(refetches).toBeGreaterThan(1);
    // …most of them issued with the pointer still down, so they really are reads taken
    // across the gesture rather than one tidy read after it.
    expect(midRefetch).toBeGreaterThan(1);
    // …and each one is node-scoped. Nothing here escalates to the whole device.
    expect(fullReads).toBe(0);
    // One readback per flush that carried the level — the storm's exchange rate.
    expect(refetches).toBe(writes.length);
    // 2 — the drag's own value survives the storm, and the last position it reached is
    // one the device was given. Stated for exactly that much: this run diverges nothing,
    // so the level address carries the app's own last write whichever way the pass gets
    // it — off the unit, whose `mem` holds what was written, or out of the write itself
    // — and every readback here is issued AFTER the write of the position it goes on to
    // read. Its answer is therefore that position, and the end state is the same whether
    // the readback MERGES or assigns wholesale — this pair does not decide the merge.
    // (The value is read off the plan, not off the pointer: the 1-knob level row carries
    // no `data-dyn`, so the mid-drag `syncValues` never touches it and the row is rebuilt
    // from the plan once the pointer lifts.) The merge needs an edit placed INSIDE a read window with
    // nothing after it, which no position of a drag is — arm C below places one.
    expect(levelAfter).toBe(levelAtLift);
    expect(levelAfter).toBe(Math.max(...writes));
    expect(levelAfter).toBeGreaterThan(levelBefore);

    // 3 — THE FIX, and what it replaced. Every one of those readbacks used to call
    // planHistory.rebase() (main.ts refetchNodes, and the coalesced reflect behind it),
    // and rebase DROPS the entry the gesture has open — so the drag did not undo as a
    // gesture. It landed in one of two shapes depending on whether the last edit fell
    // before or after the last re-base, i.e. on a race between the pointer and a device
    // round trip: 0 entries (Ctrl+Z reached past the drag into the PREVIOUS gesture, the
    // 1-Knob ON, switching it off), or 1 entry describing only the tail after the last
    // re-base (Ctrl+Z left the slider at a value the drag merely passed through).
    //
    // The baseline now absorbs only the keys the READ authored — readIntoPlan's
    // devicePatch, applied where the baseline still holds the patch's `before` side —
    // so the dragged key is skipped every window (the app moved it after the read was
    // issued) and the eqBands the device recomputed are taken. The drag is therefore one
    // entry BY CONSTRUCTION rather than by timing, which is what lets this assert the
    // full shape instead of the effect.
    const entries = depthAfter.undo - depthBefore.undo;
    await mark(page, "gesture-undo");
    await page.keyboard.press("ControlOrMeta+z");
    const undone = Number(await page.locator("#dyn-oneknob-level").inputValue());
    const stillOn = (await oneKnobFace(page, 0).getAttribute("aria-pressed")) === "true";
    console.log(
      `the drag recorded ${entries} undo entr(ies); one Ctrl+Z: level ${levelAfter} → ${undone}` +
        ` (the press started at ${levelBefore}), 1-Knob still on = ${stillOn}`,
    );
    // An undo OF THIS GESTURE, in full: the level back where the press found it, and
    // 1-Knob still on because the drag never touched it. Both halves matter — the second
    // is what says the press did not reach past the gesture into the one before it.
    expect(entries).toBe(1);
    expect(undone).toBe(levelBefore);
    expect(stillOn).toBe(true);
    // The undo is itself a refetch write, so the link has to be let go quiet before the
    // barrier below can claim the next read as the one it armed for.
    await settleAfter(page, "gesture-undo", 1200);

    // ---- arm C: the merge, placed exactly ---------------------------------------
    // The one thing arm B cannot decide, done with a barrier because nothing else can
    // put an edit inside a read window and keep it there: hold the FIRST read of the
    // readback that the next flush provokes, step the level while it is held, release.
    // The held readback answers the value that flush just wrote — the PRE-edit one — so
    // the two hypotheses separate on the value and on the wire:
    //   - merge (readIntoPlan: the device patch first, then the edits made during the
    //     read on top): the plan keeps the stepped value, and the flush that was queued
    //     behind the readback sends it;
    //   - wholesale assignment: the step is replaced by the device's answer, the diff
    //     closes on that answer, and nothing carrying the step is ever sent.
    // The barrier only places the edit. It decides nothing: both verdicts are read after
    // the release, and the write that went out BEFORE the block is checked separately so
    // it cannot be mistaken for the one under test.
    const armStart = Number(await level.inputValue());
    await mark(page, "held-read");
    await blockAt(page, "vd_get", 1);
    await level.press("ArrowUp"); // flush → write → node readback, first read held
    await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 15_000 });
    const heldTrace = await traceOf(page);
    const heldAt = markTime(heldTrace, "held-read")!;
    const flushed = Number(await level.inputValue());
    const sentBeforeBlock = setsBetween(heldTrace, CH1_ONE_KNOB_LEVEL, heldAt);
    // The edit under test. The fake settles a read at the QUEUE point, so this readback's
    // answer was fixed before the step existed.
    await level.press("ArrowUp");
    const stepped = Number(await level.inputValue());
    await releaseBarrier(page);
    await settleAfter(page, "held-read", 1200);

    trace = await traceOf(page);
    const afterBlock = setsBetween(trace, CH1_ONE_KNOB_LEVEL, heldAt);
    const survived = Number(await level.inputValue());
    console.log(
      `held read: level ${armStart} → ${flushed} (flushed, readback held) → stepped to ${stepped} inside the read` +
        ` → ${survived} once it resolved; writes on ${CH1_ONE_KNOB_LEVEL}: [${sentBeforeBlock.join(", ")}]` +
        ` before the block, [${afterBlock.join(", ")}] over the whole arm`,
    );
    // The step is a value NOTHING had sent when the read was issued — without this the
    // assertion below could be satisfied by the write the flush already made.
    expect(flushed).toBe(armStart + 1);
    expect(sentBeforeBlock).toEqual([flushed]);
    expect(stepped).toBe(flushed + 1);
    // The plan kept the edit made while the readback was in flight…
    expect(survived).toBe(stepped);
    // …and the flush queued behind that readback sent it. Both fail under a wholesale
    // assignment: the plan would hold `flushed`, and the diff would already be closed on
    // it, so the step would leave neither a value on screen nor a command on the wire.
    expect(afterBlock).toContain(stepped);
  });

  // shape-insert-fx-engine-array-collision. Two plan owners, one device address.
  //
  // The addressing first, because it is the premise: an insert effect's parameters do
  // not live at a per-channel address. The device packs them into ONE engine array per
  // effect family and translate.ts emits it as `engine:0:slot` — no channel axis, no
  // instance, nothing naming the owner (insert-fx-effect.ts, which says so in its own
  // header: "The engine array is a shared WORKING AREA, not storage"). Two MONO IN
  // channels holding a compander therefore write the SAME six addresses.
  //
  // Three defences, in the order the state meets them. The option table gives each family
  // a device-wide 1-of slot (params.ts InsertFxSlot) and `constraints.insertFxMenu` locks
  // an option whose slot another node holds, so the inspector and the console cannot
  // author the collision; `plan-validate.planProblems` warns before opening a plan file
  // that already carries one; and `translate.collapseSharedAddrs` collapses the repeated address to
  // its last command, which is what keeps the losing owner's value off the wire when the
  // state arrives anyway. That table is 1:1 with the engines — "compander" ↔ 689,
  // "amp" ↔ 697, "pitch" ↔ 701, "out-dyn" ↔ 693.
  //
  // The third one exists because the first two do not cover the way in: a DEVICE READBACK
  // authors the plan without either (readback.ts and live.ts know nothing of the slot
  // rule), and that is the route measured below — a device reporting two owners, a state
  // insert-fx-effect.ts records as UNMEASURED on hardware ("whether the device even lets
  // two input channels hold companders at once is not measured").
  test("two owners of one insert-FX engine array collapse to one command, and the status line names the owner the unit is holding", async ({
    page,
  }) => {
    expect(await hasProbe(page)).toBe(true);

    // ---- the gate, offline: the collision is not reachable from the inspector ----
    await graphNode(page, "ch1").click();
    const sel = paramExact(page, "Insert FX").locator("select");
    await expect(sel).toHaveCount(1);
    await sel.selectOption({ label: "Compander-H" });

    await graphNode(page, "ch2").click();
    const sel2 = paramExact(page, "Insert FX").locator("select");
    // Both companders are disabled on the second channel — the "compander" slot is
    // taken — while the other families, which bind DIFFERENT engines, stay selectable.
    // That contrast is what makes this a statement about the slot rule rather than
    // about a disabled dropdown.
    await expect(sel2.locator('option[value="1793"]')).toBeDisabled();
    await expect(sel2.locator('option[value="1794"]')).toBeDisabled();
    await expect(sel2.locator('option[value="512"]')).toBeEnabled(); // Pitch Fix → 701
    await expect(sel2.locator('option[value="256"]')).toBeEnabled(); // Guitar Clean → 697

    // ---- the device reports two owners ------------------------------------------
    // 135:0:0 = Compander-H, 135:0:1 = Compander-S. Both are the "compander" family, so
    // insertFxEngine resolves both to 689 whatever the type. The engine slots answer the
    // catalog defaults, so the readback lands a coherent strip on both channels.
    await divergeAt(page, CH1_INSERT_FX, 1793);
    await divergeAt(page, CH2_INSERT_FX, 1794);
    for (const s of COMPANDER_SLOTS) await divergeAt(page, `${ENGINE_COMPANDER}:0:${s}`, COMPANDER_DEFAULTS[s]);
    // The gate check above dirtied the plan, and Live start asks to discard it before
    // reading the device over the top. Agreed to deliberately — the device state is this
    // case's subject — and the fake is put back to declining straight after, so any
    // LATER confirm still fails loudly instead of being waved through.
    await setDialogAnswer(page, "Ok");
    await goLive(page);
    await setDialogAnswer(page, "Cancel");
    await setLatency(page, { get: 2, set: 8 });
    expect(await dialogsOf(page)).toEqual(["You have unsaved changes. Discard them?"]);

    // THE PREMISE, computed rather than assumed. The registration is built from the
    // emitted command list (live.ts capture), and that list now carries ONE command per
    // device address (translate.ts collapseSharedAddrs), so every address in it —
    // selector or engine slot — has exactly one entry. An occurrence count therefore no
    // longer measures how many plan owners write an address; what it still measures is
    // that the address is registered at all, which is what makes the notify arm at the
    // end of this case reachable.
    const reg = await paramAddrsOf(page);
    const count = (addr: string): number => reg.filter((a) => a.join(":") === addr).length;
    const engineCounts = COMPANDER_SLOTS.map((s) => count(`${ENGINE_COMPANDER}:0:${s}`));
    console.log(
      `registration: ${CH1_INSERT_FX}=${count(CH1_INSERT_FX)} ${CH2_INSERT_FX}=${count(CH2_INSERT_FX)}` +
        ` entries; engine 689 slots ${COMPANDER_SLOTS.join("/")} = ${engineCounts.join("/")} entries each`,
    );
    expect(count(CH1_INSERT_FX)).toBe(1);
    expect(count(CH2_INSERT_FX)).toBe(1);
    expect(engineCounts).toEqual(COMPANDER_SLOTS.map(() => 1));

    // ---- one owner edits, and the OTHER owner is what the unit holds --------------
    // The Threshold is on the insert-FX tuning screen. The screen is family-keyed rather
    // than node-keyed, so ONE locator serves both channels and each read below opens it on
    // the node it is asking about.
    await openInsertFxScreen(page, "ch1");
    const threshold = page.locator('#dyn-screen-box input[data-dyn="ifx:compander:6"]');
    await expect(threshold).toHaveValue(String(COMPANDER_DEFAULTS[6]));
    await mark(page, "ch1-threshold");
    await threshold.focus();
    await page.keyboard.press("ArrowUp");
    const ch1Raw = Number(await threshold.inputValue());
    expect(ch1Raw).not.toBe(COMPANDER_DEFAULTS[6]);
    await settleAfter(page, "ch1-threshold", 1200);
    await closeDynScreen(page);

    let trace = await traceOf(page);
    const editAt = markTime(trace, "ch1-threshold")!;
    const firstFlush = setsBetween(trace, ENGINE_THRESHOLD, editAt);
    const snapshot = await snapshotOf(page);
    console.log(timeline(trace, { from: editAt - 50, limit: 40 }));
    console.log(
      `ch1 Threshold ${COMPANDER_DEFAULTS[6]} → ${ch1Raw}: the flush emitted ${firstFlush.length} write(s) to ` +
        `${ENGINE_THRESHOLD} = [${firstFlush.join(", ")}]; the live snapshot holds one entry = ${snapshot?.[ENGINE_THRESHOLD]}`,
    );

    // ONE edit on ONE channel, and NOTHING on the wire. The two owners resolve to one
    // address, the emitted set keeps the LAST — model node order, so ch2, the channel
    // nobody touched — and ch2's value is already what the snapshot holds. So the
    // operator's gesture changes nothing on the device and never reaches onSent. That
    // silence is exactly why the loss has to be said out loud: the status line names the
    // owner whose values do reach the unit.
    expect(firstFlush).toEqual([]);
    await expect(page.locator("#statusbar")).toHaveText(
      "CH 1 shares device settings with CH 2 — only CH 2's values reach the device",
    );

    // ---- and the diff stays closed ----------------------------------------------
    // The snapshot's single entry is the survivor's, and the survivor is the only
    // command emitted for the address, so it agrees with itself on every later window.
    // Two unrelated edits, two windows, zero writes each time — one window would only
    // show that the first flush was quiet, not that it stays quiet.
    expect(snapshot?.[ENGINE_THRESHOLD]).toBe(COMPANDER_DEFAULTS[6]);
    await page.click("#btn-view-console");
    await expect(faderOf(page, "CH 4")).toBeVisible();
    const phantom: number[][] = [];
    for (const round of [1, 2]) {
      await mark(page, `idle-edit-${round}`);
      await faderOf(page, "CH 4").focus();
      await page.keyboard.press("ArrowUp");
      await settleAfter(page, `idle-edit-${round}`, 1200);
      trace = await traceOf(page);
      const at = markTime(trace, `idle-edit-${round}`)!;
      phantom.push(setsBetween(trace, ENGINE_THRESHOLD, at));
      expect(setsBetween(trace, CH4_FADER, at).length).toBeGreaterThan(0); // the edit itself did land
    }
    console.log(
      `two unrelated CH 4 fader edits later: ${phantom.map((p) => `[${p.join(", ")}]`).join(" then ")}` +
        ` on ${ENGINE_THRESHOLD} — a diff that closed and stayed closed`,
    );
    // Nothing, twice more, on flushes that have nothing to do with either owner: one
    // command per address is re-derived every window and it agrees with the snapshot
    // entry it wrote itself.
    expect(phantom[0]).toEqual([]);
    expect(phantom[1]).toEqual([]);
    // …and the report does not repeat with them. It is latched on the owner SET, not on
    // the values, so a standing collision is one sentence, not one per window.
    await expect(page.locator("#statusbar")).toHaveText(/→ device \(\d+\)/);

    // ---- what the readback does about it ----------------------------------------
    // A device-side change announced on the shared address. It IS registered, so the
    // settle resolves it — to ONE owner, because live.ts's index is a Map and the last
    // command to claim the address wins it — and takes a scoped read rather than
    // escalating; the idle net's whole-device sweep follows 900 ms behind, and that
    // sweep is what reads 689:0:6 for BOTH channels.
    //
    // The value must differ from the snapshot's single entry or isEcho swallows it —
    // measured: announcing the value the snapshot happens to hold produced no read at
    // all. The device still ANSWERS the catalog default on every read (the diverge
    // hook), so what the reconcile carries back is that, not this.
    await mark(page, "engine-notify");
    await pushNotify(page, [[ENGINE_COMPANDER, 0, 6, -1500]]);
    await settleAfter(page, "engine-notify", 2500);
    trace = await traceOf(page);
    const notifyAt = markTime(trace, "engine-notify")!;
    const notifyCost = fullReadsAfter(trace, notifyAt);

    await page.click("#btn-view-graph");
    await openInsertFxScreen(page, "ch1");
    const ch1After = await threshold.inputValue();
    await closeDynScreen(page);
    await openInsertFxScreen(page, "ch2");
    const ch2After = await threshold.inputValue();
    await closeDynScreen(page);
    console.log(
      `notify on ${ENGINE_THRESHOLD}: ${notifyCost} full reconcile(s); ch1 Threshold ${ch1Raw} → ${ch1After},` +
        ` ch2 ${COMPANDER_DEFAULTS[6]} → ${ch2After}`,
    );
    // Titled for what it decides, not for the case: with a registration and a window it
    // answers invariant 6 (the notify just pushed IS in the registration, so the shared
    // address is followable), invariant 12 (nothing written in that window is outside
    // it) and invariant 4. It has no invariant for the collision itself — one device
    // address with two plan owners is not a statement about IPC ordering, and what the
    // trace shows of it is the silence and the report asserted above. A "clean" here
    // would otherwise read as "no collision".
    console.log(
      report(
        "insert-fx shared address — registration and overlap",
        // Clause B is answered from the pair as it stands now. The insert-FX selections
        // that grew the emitted set are earlier in the run, and the notify this window
        // is about costs one whole-device reconcile (asserted below) — a reconcile
        // re-captures AND re-subscribes, in that order, so it closes the window it
        // inherited. A clean line here therefore depends on that reconcile still being
        // forced; if the case ever stops forcing one, the window reopens.
        analyze(trace, {
          registration: [...(await paramAddrsOf(page))],
          registrationWindow: { from: notifyAt },
          snapshot: await snapshotOf(page),
        }),
      ),
    );

    // Resolved, not escalated: one full sweep (the idle net's), not the two an
    // unresolvable address costs.
    expect(notifyCost).toBe(1);
    // The readback's answer to the collision is to erase the disagreement: it reads one
    // address per node from the same place, so both channels come back holding the same
    // value. ch1's edit was never on the wire to begin with — the collapse dropped it —
    // so what this undoes is the divergence in the PLAN, not anything on the unit.
    expect(ch1After).toBe(ch2After);
    expect(Number(ch1After)).not.toBe(ch1Raw);

    // The operator's own next move: the value visibly snapped back, so they redo it.
    // NOTHING runs between the reconcile and this — deliberately, because an intervening
    // edit would flush, and a flush that finds no collision re-arms the report latch by
    // itself. Only with the gap empty does this measure what it claims: the RECONCILE
    // re-armed it. The reconcile runs `live.resync()` and no flush at all (device follow
    // funnels through planValuesChanged, which unlike markChanged does not schedule one),
    // so a latch cleared only inside flush() leaves this second loss silent.
    // Reaching the Threshold means opening its screen, which is a view action and not an
    // edit — and the paragraph above turns on that, so it is MEASURED rather than assumed:
    // the window between the open and the gesture must carry no write at all.
    await page.click("#btn-view-graph");
    await mark(page, "open-screen");
    await openInsertFxScreen(page, "ch1");
    await mark(page, "re-diverge");
    await threshold.focus();
    await page.keyboard.press("ArrowUp");
    await settleAfter(page, "re-diverge", 1200);
    trace = await traceOf(page);
    const openAt = markTime(trace, "open-screen")!;
    const reAt = markTime(trace, "re-diverge")!;
    const onOpen = setsOf(trace).filter((w) => w.start > openAt && w.start < reAt);
    console.log(`opening the screen emitted: ${onOpen.map((w) => `${w.addr}=${w.value}`).join(", ") || "(nothing)"}`);
    expect(onOpen).toHaveLength(0);
    const reWrites = setsBetween(trace, ENGINE_THRESHOLD, reAt);
    console.log(`re-diverged CH 1: ${reWrites.length} write(s) to ${ENGINE_THRESHOLD}, status line re-reported`);
    // Silence and the sentence together: the gesture put nothing on the wire (CH 2 is the
    // kept owner and did not move), and that is precisely why it has to be spoken.
    expect(reWrites).toHaveLength(0);
    await expect(page.locator("#statusbar")).toHaveText(
      "CH 1 shares device settings with CH 2 — only CH 2's values reach the device",
    );

    // And now it IS latched: an unrelated edit flushes with the same collision standing
    // and does not repeat the sentence — it reports its own write instead.
    await closeDynScreen(page);
    await page.click("#btn-view-console");
    await mark(page, "idle-edit-3");
    await faderOf(page, "CH 4").focus();
    await page.keyboard.press("ArrowUp");
    await settleAfter(page, "idle-edit-3", 1200);
    trace = await traceOf(page);
    const lastAt = markTime(trace, "idle-edit-3")!;
    const after = setsBetween(trace, ENGINE_THRESHOLD, lastAt);
    console.log(`one more CH 4 edit with the collision standing: ${after.length} write(s) to ${ENGINE_THRESHOLD}`);
    expect(setsBetween(trace, CH4_FADER, lastAt).length).toBeGreaterThan(0);
    expect(after).toHaveLength(0);
    await expect(page.locator("#statusbar")).toHaveText(/→ device \(\d+\)/);
  });
});
