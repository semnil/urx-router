import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  installFake,
  goLive,
  mark,
  pushNotify,
  pushBulkChange,
  pushMenu,
  traceOf,
  paramAddrsOf,
  snapshotOf,
  setLatency,
  blockAt,
  releaseBarrier,
  memOf,
  waitQuiet,
  settleAfter,
  setDialogAnswer,
  type TraceEvent,
} from "./fake-device";
import { analyze, report, timeline, markTime, spans, setsOf } from "./analyze";
import { CH1_FADER, CH1_HPF_FREQ, faderOf, faderReadout, graphNode, openEqScreen } from "./ui";

// T3 undo — the boundary, refusal, rebase and native-menu tier of the race harness
// (docs/{en,ja}/live-race-harness.md). e2e/undo.spec.ts already pins the simple
// boundary rules against the browser bundle; what is here is what that file cannot
// reach: the differential pairs (orphan press on/off, device sweep on/off), the idle
// backstop laddered across the constant that defines it, the undo fired *inside* a
// device activity that the refusal gate does not know about, and the macOS Edit menu,
// which only exists once a Tauri bridge is present — the fake supplies one.
//
// Entries are counted by their EFFECT, never by reaching into the app: pressing
// Ctrl+Z until the status line says "Nothing to undo" is the one observable that
// survives a production build and states the stack depth exactly.

// "{param_id}:{x}:{y}", where y is the instance index — the input channel, here.
const CH2_FADER: [number, number, number] = [139, 0, 1];
/** CH_FADER on the third mono channel, as the trace addresses it. */
const CH3_FADER = "139:0:2";
// HPF frequency (26) is a scoped (non-direct) param: a notify on it re-reads the whole
// owner node rather than being placed straight into the plan.
const NOTHING_TO_UNDO = "Nothing to undo";
/** The two shapes of a successful undo: bare, or naming the single node it touched.
 *  Both are accepted on purpose — which one appears depends on whether the patch
 *  touched a node or a wire, and this tier does not pin that distinction anywhere. */
const UNDO_APPLIED = /^(Undone|Undid the change to .+)$/;
const DRAG_REFUSAL = "Finish the current drag before undoing";
const MODAL_REFUSAL = "Close the open dialog before undoing";
const BUSY_REFUSAL = "Busy with the device — undo is unavailable until it finishes";

const statusOf = (page: Page) => page.locator("#statusbar");

/** The fixed CH 1 → MIX 1 send wire, and the Level slider its selection puts in the
 *  inspector — the one plan-editing range control reachable without a pointer press
 *  of its own, which is what the orphan-press pair needs. */
const sendWire = (page: Page) => page.locator('.wire-hit[data-from="ch1:out"][data-to="bus.mix1:in"]');
const levelSlider = (page: Page) =>
  page.locator("#inspector .param", { hasText: "Level" }).locator("input[type='range']");

/** The window the end-of-run registration snapshot actually describes. Invariant 12
 *  compares writes against a SNAPSHOT, and a reconcile re-registers mid-run, so a
 *  write issued before the last subscribe was perfectly well registered when it left. */
const sinceLastSubscribe = (trace: TraceEvent[]): { from: number } | undefined => {
  const last = trace.filter((e) => e.kind === "subscribe").at(-1);
  return last ? { from: last.t } : undefined;
};

const readStatus = (page: Page): Promise<string> =>
  statusOf(page)
    .textContent()
    .then((s) => s ?? "");

/** One Ctrl+Z, returning the status line it produced. The status is written
 *  synchronously by the same handler, so no settle is needed to read the verdict. */
async function undoOnce(page: Page): Promise<string> {
  await page.keyboard.press("ControlOrMeta+z");
  return readStatus(page);
}

/**
 * How many entries the stack holds, measured by draining it. Every other way of
 * counting would need a probe into the app's module scope, which a production bundle
 * does not have; the status line is the app's own statement of the same fact.
 * Returns -1 when a refusal interrupted the drain (the count is then meaningless).
 */
async function undoDepth(page: Page, max = 12): Promise<number> {
  for (let n = 0; n <= max; n++) {
    const s = await undoOnce(page);
    if (s === NOTHING_TO_UNDO) return n;
    if (s === DRAG_REFUSAL || s === MODAL_REFUSAL || s === BUSY_REFUSAL) return -1;
  }
  return max + 1;
}

/**
 * `n` synthetic wheel notches `gap` ms apart on one control, timed inside the page,
 * returning the ACHIEVED gaps.
 *
 * Two reasons it is not page.mouse.wheel. A Playwright round trip per notch carries
 * tens of ms of jitter, which is wider than the 300 ms boundary this tier straddles;
 * and mouse.wheel needs a preceding mouse.move, whose pointermove would promote a held
 * press to a drag — the exact state the orphan-press pair holds fixed. The achieved
 * gaps are returned because a ladder is only interpretable with its measured phases.
 */
function wheelBurst(target: Locator, n: number, gap: number, up = true): Promise<number[]> {
  return target.evaluate(
    async (el, [count, d, dir]) => {
      const at: number[] = [];
      for (let i = 0; i < (count as number); i++) {
        if (i) await new Promise((r) => setTimeout(r, d as number));
        at.push(performance.now());
        el.dispatchEvent(new WheelEvent("wheel", { deltaY: (dir as number) * 100, bubbles: true, cancelable: true }));
      }
      return at.slice(1).map((t, i) => +(t - at[i]).toFixed(1));
    },
    [n, gap, up ? -1 : 1] as [number, number, number],
  );
}
/**
 * The same burst, sampling the COMMITTED undo depth immediately before each notch.
 *
 * The ladder below used to derive its expectation from the achieved wall-clock gaps,
 * which cannot decide it. The idle backstop is armed inside the notch's own dispatch
 * and re-armed by the next one, and the two timers are due 300 ms and `gap` ms after
 * the same instant — so a rung whose achieved gap drifted past 300 under contention
 * makes a gap-derived formula demand a split the app never made, and the case fails as
 * if the app had regressed. `depth()` is the commit itself (the `race` project always
 * serves the trace build), so the splits are OBSERVED between the notches that produced
 * them instead of inferred from when they were dispatched.
 */
function wheelBurstSampled(target: Locator, n: number, gap: number): Promise<{ gaps: number[]; depths: number[] }> {
  return target.evaluate(
    async (el, [count, d]) => {
      const probe = (window as unknown as { __urxTrace?: { depth: () => { undo: number; redo: number } } }).__urxTrace;
      const at: number[] = [];
      const depths: number[] = [];
      for (let i = 0; i < (count as number); i++) {
        if (i) await new Promise((r) => setTimeout(r, d as number));
        // Sampled at the END of the gap, before the notch that closes it: what rose
        // since the previous sample is what the backstop committed during that gap.
        depths.push(probe?.depth().undo ?? -1);
        at.push(performance.now());
        el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
      }
      return { gaps: at.slice(1).map((t, i) => +(t - at[i]).toFixed(1)), depths };
    },
    [n, gap] as [number, number],
  );
}

/** The EQ screen's 1-Knob ON button, found from the level slider's id rather than a
 *  localized label. Its write is a refetch (sideEffect) param. */
const oneKnobOn = (page: Page) =>
  page
    .locator("#dyn-screen-box .prefs-section", { has: page.locator("#dyn-oneknob-level") })
    .locator(".prefs-toggle button")
    .first();

test.describe("T3 undo", () => {
  test.beforeEach(async ({ page }) => {
    await installFake(page);
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  // ---------------------------------------------------------------------------
  // undo-drag-latch-and-orphan-press
  // ---------------------------------------------------------------------------
  test("a script-dispatched pointerdown with no pointerup wedges the idle backstop", async ({ page }) => {
    // An entry on the stack FIRST. run() peeks the stack before it consults blocked()
    // or the press state, so against an empty stack every press state answers
    // "nothing to undo" alike and nothing about a press is observable. Selected with a
    // MATCHED pointerdown/pointerup so no press is left standing.
    await sendWire(page).dispatchEvent("pointerdown");
    await sendWire(page).dispatchEvent("pointerup");
    await expect(levelSlider(page)).toHaveCount(1);
    const seed = await levelSlider(page).inputValue();
    await wheelBurst(levelSlider(page), 1, 0);
    await page.waitForTimeout(600);
    expect(await levelSlider(page).inputValue()).not.toBe(seed);

    // Bare hover, no button: a pointermove without a press must not read as a drag.
    // With the entry above on the stack the drag refusal is reachable, so a permissive
    // answer here is a statement about the press state rather than about the stack.
    const box = (await page.locator("#graph-host").boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + 40);
    await page.mouse.move(box.x + 240, box.y + 160, { steps: 8 });
    expect(await undoOnce(page)).toMatch(UNDO_APPLIED);
    await expect(levelSlider(page)).toHaveValue(seed);

    // A second entry, because the check above spent the first one — and a node drag
    // opens no entry of its own until the pointer lifts (measured: without this the
    // refusal below reads "Nothing to undo"), so the stack would be empty exactly when
    // the drag refusal is supposed to be observable.
    await wheelBurst(levelSlider(page), 1, 0);
    await page.waitForTimeout(600);
    await expect(levelSlider(page)).not.toHaveValue(seed);

    // A real press that HAS moved refuses, and the same press works once it ends.
    const face = (await graphNode(page, "ch1").locator("rect").first().boundingBox())!;
    const before = (await graphNode(page, "ch1").getAttribute("transform"))!;
    await page.mouse.move(face.x + face.width / 2, face.y + face.height / 2);
    await page.mouse.down();
    await page.mouse.move(face.x + face.width / 2 + 60, face.y + face.height / 2 + 60, { steps: 4 });
    expect(await undoOnce(page)).toBe(DRAG_REFUSAL);
    await page.mouse.up();
    await undoOnce(page);
    await expect(graphNode(page, "ch1")).toHaveAttribute("transform", before);

    // Drain whatever is left (the redo stack is irrelevant here).
    await undoDepth(page);

    // --- control arm: the wire selected with a matched pointerdown/pointerup ------
    await sendWire(page).dispatchEvent("pointerdown");
    await sendWire(page).dispatchEvent("pointerup");
    await expect(levelSlider(page)).toHaveCount(1);
    const start = await levelSlider(page).inputValue();

    await mark(page, "control-burst-1");
    const gapsA1 = await wheelBurst(levelSlider(page), 3, 120);
    await page.waitForTimeout(1200);
    await mark(page, "control-burst-2");
    const gapsA2 = await wheelBurst(levelSlider(page), 3, 120);
    await page.waitForTimeout(1200);
    const movedControl = await levelSlider(page).inputValue();
    expect(movedControl).not.toBe(start);
    const depthControl = await undoDepth(page);
    const afterControl = await levelSlider(page).inputValue();

    // --- orphan arm: the identical bursts, with one unmatched pointerdown ---------
    // One entry again, so the refusal stays reachable while the press is down: the
    // drain above emptied the stack, and against an empty stack "nothing to undo" is
    // the answer for press "none", "down" and "drag" alike.
    await sendWire(page).dispatchEvent("pointerdown");
    await sendWire(page).dispatchEvent("pointerup");
    await expect(levelSlider(page)).toHaveCount(1);
    const probe = await levelSlider(page).inputValue();
    await wheelBurst(levelSlider(page), 1, 0);
    await page.waitForTimeout(600);
    expect(await levelSlider(page).inputValue()).not.toBe(probe);

    // Re-select the wire the way every e2e spec does — a dispatched pointerdown with
    // no pointerup. The press never lifts, so history's press state stays "down".
    await sendWire(page).dispatchEvent("pointerdown");
    await expect(levelSlider(page)).toHaveCount(1);
    // Still permitted, and now discriminating: only a press that has MOVED is a drag,
    // so the entry above is undone instead of refused.
    expect(await undoOnce(page)).toMatch(UNDO_APPLIED);
    await expect(levelSlider(page)).toHaveValue(probe);
    const start2 = await levelSlider(page).inputValue();

    await mark(page, "orphan-burst-1");
    const gapsB1 = await wheelBurst(levelSlider(page), 3, 120);
    await page.waitForTimeout(1200);
    await mark(page, "orphan-burst-2");
    const gapsB2 = await wheelBurst(levelSlider(page), 3, 120);
    await page.waitForTimeout(1200);
    const movedOrphan = await levelSlider(page).inputValue();
    expect(movedOrphan).not.toBe(start2);
    const depthOrphan = await undoDepth(page);
    const afterOrphan = await levelSlider(page).inputValue();

    const trace = await traceOf(page);
    console.log(timeline(trace));
    console.log(report("orphan press", []));
    console.log(
      `control arm: gaps ${gapsA1.concat(gapsA2).join("/")} ms → ${depthControl} entr(y|ies), ${start} → ${movedControl} → ${afterControl}`,
    );
    console.log(
      `orphan  arm: gaps ${gapsB1.concat(gapsB2).join("/")} ms → ${depthOrphan} entr(y|ies), ${start2} → ${movedOrphan} → ${afterOrphan}`,
    );

    // Both arms return the value, so nothing is lost — what differs is granularity.
    expect(afterControl).toBe(start);
    expect(afterOrphan).toBe(start2);
    // Two bursts 1.2 s apart are two separate actions, and with the press released
    // that is what the idle backstop makes of them. The expectation is derived from the
    // ACHIEVED intra-burst gaps, not the requested ones: a contended run whose notches
    // drifted past IDLE_COMMIT_MS split a burst legitimately, and pinning the literal 2
    // would make the arm flaky rather than informative. Either way the arm must produce
    // MORE than one entry, which is the half of the differential that carries the claim.
    const split = gapsA1.concat(gapsA2).some((g) => g >= 300);
    if (split) expect(depthControl).toBeGreaterThan(2);
    else expect(depthControl).toBe(2);
    // PINNED DEFECT. The unmatched pointerdown leaves press === "down" forever, and
    // note() refuses to arm the idle backstop while a press is down — so nothing ever
    // closes the entry and two bursts seconds apart collapse into one. The two bursts
    // are identical in both arms and the stack is empty when each pair starts; the
    // only variable is the missing pointerup, which is what attributes the collapse to
    // the orphan press rather than to the idle timer.
    expect(depthOrphan).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // undo-idle-backstop-wheel-ladder
  // ---------------------------------------------------------------------------
  // The only gesture with no DOM boundary of its own, laddered directly across
  // IDLE_COMMIT_MS. The expectation is OBSERVED rather than derived: the committed depth
  // is sampled between the notches (`wheelBurstSampled`), so a run whose timers drifted
  // is still a valid measurement of the constant and cannot demand a split the app never
  // made. The achieved gaps are printed beside it — a ladder is only interpretable with
  // its measured phases — but nothing is inferred from them.
  for (const d of [80, 250, 290, 320, 800]) {
    test(`five wheel notches ${d} ms apart: the 300 ms backstop decides the entry count`, async ({ page }) => {
      await page.click("#btn-view-console");
      await expect(faderReadout(page, "CH 1")).toBeVisible();
      const before = (await faderReadout(page, "CH 1").textContent())!;

      await mark(page, `burst-${d}`);
      const { gaps, depths } = await wheelBurstSampled(faderOf(page, "CH 1"), 5, d);
      await page.waitForTimeout(1200);
      const moved = (await faderReadout(page, "CH 1").textContent())!;
      expect(moved).not.toBe(before);

      const depth = await undoDepth(page);
      const after = (await faderReadout(page, "CH 1").textContent())!;

      // One entry for the burst's tail, plus one for every commit the backstop actually
      // made between two notches. `depths` is the committed depth before each notch, so
      // its rise across the burst IS that count.
      const splits = depths[depths.length - 1] - depths[0];
      const trace = await traceOf(page);
      console.log(timeline(trace));
      console.log(report(`idle backstop D=${d}`, []));
      console.log(
        `D=${d}: achieved gaps ${gaps.join("/")} ms, committed depth ${depths.join("→")} ` +
          `→ ${splits} split(s), expected ${1 + splits}, got ${depth}`,
      );
      console.log(`readout: before=${before} moved=${moved} after=${after}`);

      // The stack is empty when the burst starts (a fresh page, no gesture before it),
      // which is what makes `depth` the burst's own entries — and it is also the check
      // that the probe is present at all, since a plain build would read -1 here and
      // make every rung expect one entry whatever the app did.
      expect(depths[0]).toBe(0);
      expect(depth).toBe(1 + splits);
      // However it was split, undoing every entry restores the pre-burst value exactly.
      expect(after).toBe(before);
    });
  }

  // ---------------------------------------------------------------------------
  // undo-during-device-activity-ladder
  // ---------------------------------------------------------------------------
  // blocked() tests deviceReadInFlight / fileFlowBusy / a modal, and nothing else — it
  // has no idea a flush is sending or a reconcile is reading. Each cell holds one
  // device activity open on the barrier, fires Ctrl+Z inside it, and answers the four
  // questions the catalog asks: refused, plan returned, write carrying the old value,
  // entry survived.
  test("undo fired while the edit's own flush is still on the wire", async ({ page }) => {
    await goLive(page);
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    await setLatency(page, { get: 8, set: 60 });

    const before = (await faderReadout(page, "CH 1").textContent())!;
    // The RAW the unit holds before the gesture — the value the undo has to put back on
    // the wire. The readouts below state what the screen shows; only this states what
    // the device was left playing, which is the half the case's own comment claims.
    // An address the fake was never written to answers 0, which is what the boot
    // readback put in the plan.
    const beforeRaw = (await memOf(page))[CH1_FADER] ?? 0;
    // Hold the very first write of the session: the edit below is the only thing that
    // writes, so the barrier lands on its own flush.
    await blockAt(page, "vd_set", 1);
    await mark(page, "edit");
    await faderOf(page, "CH 1").focus();
    await page.keyboard.press("ArrowUp");
    const edited = (await faderReadout(page, "CH 1").textContent())!;
    expect(edited).not.toBe(before);
    await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 15_000 });

    await mark(page, "undo-in-flush");
    const status = await undoOnce(page);
    const justAfter = (await faderReadout(page, "CH 1").textContent())!;
    await mark(page, "release");
    await releaseBarrier(page);
    await waitQuiet(page);

    const after = (await faderReadout(page, "CH 1").textContent())!;
    const trace = await traceOf(page);
    const undoAt = markTime(trace, "undo-in-flush")!;
    const writes = setsOf(trace).filter((s) => s.addr === CH1_FADER);
    const findings = analyze(trace, {
      edits: [{ label: "CH 1 fader ArrowUp", addr: CH1_FADER, at: markTime(trace, "edit")! }],
      registration: await paramAddrsOf(page),
      registrationWindow: sinceLastSubscribe(trace),
      // A fader undo moves a VALUE back, so the emitted set never left the begin() set
      // and clause B has nothing to report.
      snapshot: await snapshotOf(page),
    });
    const undoWrites = writes.filter((w) => w.start > undoAt);
    const deviceHolds = (await memOf(page))[CH1_FADER];
    console.log(timeline(trace, { from: markTime(trace, "edit")! - 100 }));
    console.log(report("undo during flush", findings));
    console.log(`status="${status}" readout ${before} → ${edited} → ${justAfter} → ${after}`);
    console.log(`writes on ${CH1_FADER}: ${writes.map((w) => `${w.start.toFixed(0)}ms=${w.value}`).join(", ")}`);
    console.log(`device holds ${CH1_FADER} = ${deviceHolds} (pre-edit ${beforeRaw})`);

    // The gate does not know about a flush, so the undo goes through.
    expect(status).not.toBe(BUSY_REFUSAL);
    expect(status).not.toBe(DRAG_REFUSAL);
    // The undo landed on screen at once…
    expect(justAfter).toBe(before);
    // …and the write it produced followed the one already in flight, so the device
    // ends holding the undone value rather than the one the held write carried. Both
    // halves are asserted by VALUE: a write that followed the undo while carrying the
    // edited value satisfies a count and leaves the unit playing what the operator just
    // took back, which is the failure this case is named for.
    expect(undoWrites.length).toBeGreaterThan(0);
    expect(undoWrites.at(-1)!.value).toBe(beforeRaw);
    expect(deviceHolds).toBe(beforeRaw);
    expect(after).toBe(before);
    expect(await undoDepth(page)).toBe(0);
  });

  test("undo fired inside a 1-knob refetch await", async ({ page }) => {
    await goLive(page);
    await openEqScreen(page, "ch1");
    await setLatency(page, { get: 8, set: 25 });

    await blockAt(page, "vd_get", 1);
    await mark(page, "oneknob-on");
    await oneKnobOn(page).click();
    await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 15_000 });
    const armed = await oneKnobOn(page).getAttribute("aria-pressed");

    await mark(page, "undo-in-refetch");
    const status = await undoOnce(page);
    const justAfter = await oneKnobOn(page).getAttribute("aria-pressed");
    await mark(page, "release");
    await releaseBarrier(page);
    // The verdict below is an ABSENCE (no write carrying the undone value ever left),
    // so the link has to be seen waking up before its silence means anything —
    // waitQuiet here would return while the held read's own epilogue was still pending.
    await settleAfter(page, "release");
    const after = await oneKnobOn(page).getAttribute("aria-pressed");

    // The retry the refusal invites. The refetch's epilogue REBASES rather than resets,
    // so the entry is still there — this is the family where a refused press really does
    // cost nothing, and asserting it is what separates "refused" from "lost".
    await mark(page, "retry");
    const retryStatus = await undoOnce(page);
    await settleAfter(page, "retry");
    const afterRetry = await oneKnobOn(page).getAttribute("aria-pressed");

    const trace = await traceOf(page);
    const undoAt = markTime(trace, "undo-in-refetch")!;
    const retryAt = markTime(trace, "retry")!;
    const sets = setsOf(trace).filter((s) => s.addr === "46:0:0");
    console.log(timeline(trace, { from: markTime(trace, "oneknob-on")! - 50 }));
    console.log(`status="${status}" 1-knob armed=${armed} justAfter=${justAfter} after=${after}`);
    console.log(`retry: "${retryStatus}" → ${afterRetry}`);
    console.log(`writes on 46:0:0: ${sets.map((s) => `${s.start.toFixed(0)}ms=${s.value}`).join(", ")}`);
    console.log(`device holds 46:0:0 = ${(await memOf(page))["46:0:0"]}`);

    // Refused. The tuning screen is the one modal the gate allows, so the refusal that
    // fires is the device one: a refetch re-authors the plan across an await, and the
    // undo's own patch would be measured against a baseline that is still moving.
    expect(status).toBe(BUSY_REFUSAL);
    expect(armed).toBe("true");
    // The press did not run: the button never moved, and nothing carrying 0 left while
    // the read was held. `analyze` is deliberately not given a declared edit here — the
    // undo did not happen, so an absent write is the point rather than a lost one.
    expect(justAfter).toBe("true");
    expect(sets.filter((s) => s.start > undoAt && s.start < retryAt)).toHaveLength(0);
    expect(after).toBe("true");
    // And the refusal consumed nothing: the identical press, once the read is done,
    // applies and reaches the unit.
    expect(retryStatus).not.toBe(BUSY_REFUSAL);
    expect(retryStatus).not.toBe(NOTHING_TO_UNDO);
    expect(afterRetry).toBe("false");
    expect(sets.filter((s) => s.start > retryAt && s.value === 0).length).toBeGreaterThan(0);
    expect((await memOf(page))["46:0:0"]).toBe(0);
  });

  for (const nth of [1, 12]) {
    test(`undo fired at read #${nth} of a scoped reconcile`, async ({ page }) => {
      await goLive(page);
      await page.click("#btn-view-console");
      await expect(faderReadout(page, "CH 1")).toBeVisible();
      await setLatency(page, { get: 8, set: 25 });

      const before = (await faderReadout(page, "CH 1").textContent())!;
      await mark(page, "edit");
      await faderOf(page, "CH 1").focus();
      await page.keyboard.press("ArrowUp");
      const edited = (await faderReadout(page, "CH 1").textContent())!;
      expect(edited).not.toBe(before);
      await waitQuiet(page);

      // A scoped param's notify: the settle re-reads the whole owner node.
      await blockAt(page, "vd_get", nth);
      await mark(page, "notify");
      await pushNotify(page, [[...CH1_HPF_FREQ, 40]]);
      await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 15_000 });

      await mark(page, "undo-in-scoped");
      const status = await undoOnce(page);
      const justAfter = (await faderReadout(page, "CH 1").textContent())!;
      await mark(page, "release");
      await releaseBarrier(page);
      await waitQuiet(page, 1500);

      const after = (await faderReadout(page, "CH 1").textContent())!;
      // What the identical press answers once the reconcile is done — the other half of
      // "a refusal costs nothing", and the half that is NOT true for this family.
      const retryStatus = await undoOnce(page);
      const depth = await undoDepth(page);
      const trace = await traceOf(page);
      const undoAt = markTime(trace, "undo-in-scoped")!;
      const writes = setsOf(trace).filter((s) => s.addr === CH1_FADER);
      console.log(timeline(trace, { from: markTime(trace, "notify")! - 50 }));
      console.log(
        report(
          `undo at scoped read #${nth}`,
          analyze(trace, {
            registration: await paramAddrsOf(page),
            registrationWindow: sinceLastSubscribe(trace),
            // The reconcile re-captures the live snapshot and THEN re-subscribes, in
            // that order (follow.ts runReconcile), so both halves of clause B's pair
            // move together and a device-side structural change closes its own window.
            snapshot: await snapshotOf(page),
          }),
        ),
      );
      console.log(`status="${status}" readout ${before} → ${edited} → ${justAfter} → ${after}; depth after = ${depth}`);
      console.log(`retry after the reconcile: "${retryStatus}"`);
      console.log(`writes on ${CH1_FADER}: ${writes.map((w) => `${w.start.toFixed(0)}ms=${w.value}`).join(", ")}`);
      console.log(`device holds ${CH1_FADER} = ${(await memOf(page))[CH1_FADER]}`);

      // Refused: a scoped reconcile re-authors the plan across an await, so the patch
      // would be measured against a baseline that is still moving.
      expect(status).toBe(BUSY_REFUSAL);
      // The press did not run — the readout stays where the edit left it, and nothing
      // carrying the undone value leaves.
      expect(justAfter).toBe(edited);
      expect(writes.filter((w) => w.start > undoAt)).toHaveLength(0);
      expect(after).toBe(edited);
      expect((await memOf(page))[CH1_FADER]).toBe(40);
      // And here the refusal is NOT free: the reconcile's own reflect calls
      // planHistory.reset() a moment later, so the entry the press would have spent is
      // gone by the time it can be retried. That is the accepted cost of the gate for
      // this family — visible, rather than an edit that may or may not have reached the
      // unit depending on whether live.resync() beat the 120 ms flush timer.
      expect(depth).toBe(0);
      expect(retryStatus).toBe(NOTHING_TO_UNDO);
    });
  }

  for (const nth of [3, 200] as const) {
    test(`undo fired at read #${nth} of a full reconcile, which then wipes both stacks`, async ({ page }) => {
      await goLive(page);
      await page.click("#btn-view-console");
      await expect(faderReadout(page, "CH 1")).toBeVisible();
      await setLatency(page, { get: 8, set: 25 });

      const before = (await faderReadout(page, "CH 1").textContent())!;
      await mark(page, "edit");
      await faderOf(page, "CH 1").focus();
      await page.keyboard.press("ArrowUp");
      const edited = (await faderReadout(page, "CH 1").textContent())!;
      expect(edited).not.toBe(before);
      await waitQuiet(page);

      // The BULK_CHANGE sentinel resolves to no node, so the settle escalates to a
      // whole-device read — the longest activity in the catalog, and the only stimulus
      // that reaches follow.ts's unknown-address path through the bridge's filter
      // (pushBulkChange / fake-device.ts).
      await blockAt(page, "vd_get", nth);
      await mark(page, "notify");
      await pushBulkChange(page);
      await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 20_000 });

      await mark(page, "undo-in-full");
      const status = await undoOnce(page);
      const justAfter = (await faderReadout(page, "CH 1").textContent())!;
      await mark(page, "release");
      await releaseBarrier(page);
      await waitQuiet(page, 1500, 120_000);

      const after = (await faderReadout(page, "CH 1").textContent())!;
      // The undo put an entry on the redo side; whether it is still there is the
      // question this cell exists to answer.
      await page.keyboard.press("ControlOrMeta+Shift+z");
      const redoStatus = await readStatus(page);
      const afterRedo = (await faderReadout(page, "CH 1").textContent())!;
      const depth = await undoDepth(page);
      const trace = await traceOf(page);
      const undoAt = markTime(trace, "undo-in-full")!;
      const writes = setsOf(trace).filter((s) => s.addr === CH1_FADER);
      console.log(timeline(trace, { from: markTime(trace, "notify")! - 50, limit: 60 }));
      console.log(
        report(
          `undo at full read #${nth}`,
          analyze(trace, {
            registration: await paramAddrsOf(page),
            registrationWindow: sinceLastSubscribe(trace),
            // The reconcile re-captures the live snapshot and THEN re-subscribes, in
            // that order (follow.ts runReconcile), so both halves of clause B's pair
            // move together and a device-side structural change closes its own window.
            snapshot: await snapshotOf(page),
          }),
        ),
      );
      console.log(`status="${status}" readout ${before} → ${edited} → ${justAfter} → ${after}; depth after = ${depth}`);
      console.log(`redo after the sweep: "${redoStatus}" → ${afterRedo}`);
      console.log(`writes on ${CH1_FADER}: ${writes.map((w) => `${w.start.toFixed(0)}ms=${w.value}`).join(", ")}`);
      console.log(`device holds ${CH1_FADER} = ${(await memOf(page))[CH1_FADER]}`);

      // Refused, like the scoped cell: a whole-device sweep re-authors the plan across
      // an await that is several hundred round trips long.
      expect(status).toBe(BUSY_REFUSAL);
      expect(justAfter).toBe(edited);
      expect(writes.filter((w) => w.start > undoAt)).toHaveLength(0);
      // And the entry the press did not spend is destroyed anyway: a full reconcile's
      // reflect calls planHistory.reset(), so both stacks are gone the moment the sweep
      // lands. The press was doomed from the notify that started the sweep — refusing it
      // states that, instead of applying an edit whose provenance is about to be erased.
      expect(redoStatus).toBe("Nothing to redo");
      expect(afterRedo).toBe(after);
      expect(depth).toBe(0);
    });
  }

  // ---------------------------------------------------------------------------
  // undo-entry-survives-device-sweep
  // ---------------------------------------------------------------------------
  for (const delta of [5, 40, 95]) {
    test(`an entry opened ${delta} ms after a notify survives a 10 Hz device sweep`, async ({ page }) => {
      await goLive(page);
      await page.click("#btn-view-console");
      await expect(faderReadout(page, "CH 3")).toBeVisible();
      await setLatency(page, { get: 8, set: 25 });

      // --- sweep arm -------------------------------------------------------------
      // A COMMITTED entry from before the sweep. It was what separated the two baseline
      // calls while the direct path re-took the whole baseline (rebase keeps both
      // stacks, reset empties them); it stays because an absorb must leave it alone too,
      // and with only the open entry on the stack (goLive has just cleared it) that
      // could not be told apart. The keyup is its boundary, so it is closed.
      const sweptBase = (await faderReadout(page, "CH 3").textContent())!;
      // The raw the unit holds before either edit. Both presses below are undone, so
      // this is what the device must be left playing — the half no readout can state.
      const sweptBaseRaw = (await memOf(page))[CH3_FADER] ?? 0;
      await faderOf(page, "CH 3").focus();
      await page.keyboard.press("ArrowUp");
      const sweptBefore = (await faderReadout(page, "CH 3").textContent())!;
      expect(sweptBefore).not.toBe(sweptBase);
      await waitQuiet(page);

      // A direct-follow param on ch2 pushed at 10 Hz, while the operator's notch goes
      // to CH 3 — a different node, so nothing the sweep carries is what the entry
      // holds. The values alternate so none reads as an echo of the last. The sweep and
      // the notch are BOTH driven from inside the page, so the notch's offset from the
      // preceding notify is the scripted `delta` rather than whatever a CDP round trip
      // happened to cost.
      await mark(page, "sweep-start");
      await faderOf(page, "CH 3").evaluate(
        (el, [addr, d]) =>
          new Promise<void>((done) => {
            let i = 0;
            const w = window as unknown as { __sweep: ReturnType<typeof setInterval> };
            w.__sweep = setInterval(() => {
              const a = addr as [number, number, number];
              window.__urxFake.pushNotify([[a[0], a[1], a[2], -300 - (i++ % 2) * 50]]);
              if (i !== 7) return;
              setTimeout(() => {
                window.__urxFake.mark("edit-during-sweep");
                el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
                done();
              }, d as number);
            }, 100);
          }),
        [CH2_FADER, delta] as [[number, number, number], number],
      );
      const sweptEdited = (await faderReadout(page, "CH 3").textContent())!;
      expect(sweptEdited).not.toBe(sweptBefore);
      // Long enough for several more notifies (and so several more absorbs) to land,
      // and for the edit's own 300 ms idle backstop to close its entry.
      await page.waitForTimeout(600);
      await mark(page, "swept-undo");
      const sweptStatus = await undoOnce(page);
      const sweptAfter = (await faderReadout(page, "CH 3").textContent())!;
      // One press deeper: the entry committed BEFORE the sweep must still be there.
      const sweptStatus2 = await undoOnce(page);
      const sweptAfter2 = (await faderReadout(page, "CH 3").textContent())!;

      await page.evaluate(() => {
        clearInterval((window as unknown as { __sweep: ReturnType<typeof setInterval> }).__sweep);
      });
      await mark(page, "sweep-end");
      // The sweep's idle net runs one full re-read; let it finish before the control
      // arm, or its own planHistory.reset() would be credited to the sweep.
      await waitQuiet(page, 1500, 120_000);
      // Read here, not at the bottom: the control arm edits the same fader again, so
      // the unit's state after the two presses is only readable before it runs.
      const sweptDeviceHolds = (await memOf(page))[CH3_FADER];

      // --- control arm: the identical edit with the device silent -----------------
      const quietBefore = (await faderReadout(page, "CH 3").textContent())!;
      await mark(page, "edit-quiet");
      await wheelBurst(faderOf(page, "CH 3"), 1, 0);
      const quietEdited = (await faderReadout(page, "CH 3").textContent())!;
      expect(quietEdited).not.toBe(quietBefore);
      await page.waitForTimeout(600);
      const quietStatus = await undoOnce(page);
      const quietAfter = (await faderReadout(page, "CH 3").textContent())!;

      const trace = await traceOf(page);
      const registration = await paramAddrsOf(page);
      const sweepFrom = markTime(trace, "sweep-start")!;
      const sweepTo = markTime(trace, "sweep-end")!;
      const notifies = trace.filter((e) => e.kind === "notify" && e.t >= sweepFrom && e.t <= sweepTo);
      const editAt = markTime(trace, "edit-during-sweep")!;
      const achieved = notifies.filter((n) => n.t <= editAt).at(-1);
      const findings = analyze(trace, { registration, registrationWindow: sinceLastSubscribe(trace) });
      // The reachability check needs the SWEEP's own window. `sinceLastSubscribe` starts
      // at the post-sweep reconcile's re-subscribe, so every notify this arm pushed falls
      // outside it and invariant 6's clause A — "the bridge refused the stimulus", the one
      // finding that would make every verdict below hold for free — could not fire at all.
      const sweepFindings = analyze(trace, {
        registration,
        registrationWindow: { from: sweepFrom, to: sweepTo },
      });
      const undoWrites = setsOf(trace).filter(
        (s) =>
          s.addr === CH3_FADER && s.start > markTime(trace, "swept-undo")! && s.start < markTime(trace, "edit-quiet")!,
      );
      console.log(timeline(trace, { from: sweepFrom - 50, limit: 80 }));
      console.log(report(`entry vs sweep Δ=${delta}`, findings));
      console.log(report(`entry vs sweep Δ=${delta} (sweep window)`, sweepFindings));
      console.log(
        `undo writes on ${CH3_FADER}: ${undoWrites.map((w) => `${w.start.toFixed(0)}ms=${w.value}`).join(", ") || "(none)"}` +
          `; device holds ${sweptDeviceHolds} (pre-sweep ${sweptBaseRaw})`,
      );
      console.log(
        `sweep: ${notifies.length} notifies over ${((sweepTo - sweepFrom) / 1000).toFixed(2)} s = ` +
          `${(notifies.length / ((sweepTo - sweepFrom) / 1000)).toFixed(1)} notify/s; ` +
          `edit intended Δ=${delta} ms, achieved Δ=${achieved ? (editAt - achieved.t).toFixed(1) : "?"} ms`,
      );
      console.log(
        `sweep arm : "${sweptStatus}" / "${sweptStatus2}" ` +
          `${sweptBase} → ${sweptBefore} → ${sweptEdited} → ${sweptAfter} → ${sweptAfter2}`,
      );
      console.log(`quiet arm : "${quietStatus}" ${quietBefore} → ${quietEdited} → ${quietAfter}`);

      // The sweep must actually have REACHED the app: an address outside the
      // registration is refused by the bridge and traced as a drop, which invariant 6's
      // clause A reports — and a sweep of refusals is silence, not a direct follow, so
      // every verdict below would be about nothing.
      expect(sweepFindings.filter((f) => f.inv === 6)).toHaveLength(0);
      expect(notifies.length).toBeGreaterThan(8);
      // THE FIX, and what it replaced. The direct-follow path absorbs the keys the
      // notify itself authored instead of re-taking the whole baseline, so an edit made
      // while the unit is being touched records one entry and undoes to where the press
      // found it — the same as with the device silent, which is what the control arm
      // states. Before the fix these three cells measured the opposite: the edit was
      // silently un-undoable, and the Ctrl+Z that should have taken it back spent the
      // entry UNDER it, so the fader jumped past the value the operator was returning
      // to. The Δ ladder is three phases INSIDE one 100 ms notify interval, and every
      // cell has the next notify landing before the edit's 300 ms idle backstop could
      // commit — the timer a rebase used to cancel — so it says the outcome does not
      // depend on where in that interval the edit falls, and says nothing about a gap
      // wider than the backstop.
      expect(sweptStatus).toMatch(UNDO_APPLIED);
      expect(sweptAfter).not.toBe(sweptEdited);
      expect(sweptAfter).toBe(sweptBefore);
      // An absorb leaves both stacks standing, which is what separates it from a reset
      // (and from the rebase that used to eat this press): the pre-sweep entry is still
      // beneath, so the second press reaches it.
      expect(sweptStatus2).toMatch(UNDO_APPLIED);
      expect(sweptAfter2).toBe(sweptBase);
      // …and the UNIT was taken back with it. A plan that shows the pre-sweep value
      // while the device still plays the edited one is the shape this tier exists to
      // catch, and the readouts above cannot tell the two apart.
      expect(undoWrites.at(-1)?.value).toBe(sweptBaseRaw);
      expect(sweptDeviceHolds).toBe(sweptBaseRaw);
      expect(quietStatus).not.toBe(NOTHING_TO_UNDO);
      expect(quietAfter).toBe(quietBefore);
    });
  }

  // ---------------------------------------------------------------------------
  // undo-macos-edit-menu-path
  // ---------------------------------------------------------------------------
  test("the macOS Edit menu routes into the history and reports depth only on transitions", async ({ page }) => {
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    const before = (await faderReadout(page, "CH 1").textContent())!;

    // One entry, then the menu's own undo — it must mean the same thing the chord does.
    await faderOf(page, "CH 1").focus();
    await page.keyboard.press("ArrowUp");
    const edited = (await faderReadout(page, "CH 1").textContent())!;
    expect(edited).not.toBe(before);
    await mark(page, "menu-undo");
    await pushMenu(page, "edit-undo");
    await expect(faderReadout(page, "CH 1")).toHaveText(before);
    const menuUndoStatus = await readStatus(page);
    expect(menuUndoStatus).toMatch(UNDO_APPLIED);

    await mark(page, "menu-redo");
    await pushMenu(page, "edit-redo");
    await expect(faderReadout(page, "CH 1")).toHaveText(edited);

    // A 40-move drag: dozens of edits, and the menu state may only be pushed when what
    // it would render actually moved. Each push is an IPC round trip.
    await mark(page, "drag-start");
    const track = (await faderOf(page, "CH 1").boundingBox())!;
    await page.mouse.move(track.x + track.width / 2, track.y + track.height * 0.25);
    await page.mouse.down();
    for (let i = 1; i <= 40; i++) {
      await page.mouse.move(track.x + track.width / 2, track.y + track.height * (0.25 + i * 0.012));
    }
    await page.mouse.up();
    await mark(page, "drag-end");
    const dragged = (await faderReadout(page, "CH 1").textContent())!;
    expect(dragged).not.toBe(edited);

    // Language switch: the menu lives outside the document, so nothing re-renders it.
    await mark(page, "lang");
    await page.click("#btn-prefs");
    await page.selectOption("#prefs-lang", "ja");
    await page.click("#prefs-modal .consent-btn-primary");
    await expect(page.locator("#prefs-modal")).toBeHidden();
    await page.click("#btn-prefs");
    await page.selectOption("#prefs-lang", "en");
    await page.click("#prefs-modal .consent-btn-primary");
    await expect(page.locator("#prefs-modal")).toBeHidden();
    await mark(page, "lang-done");

    // The field path: with a text surface focused the menu must hand the command to
    // the field, exactly as the chord does, and leave the plan alone.
    await page.click("#btn-view-graph");
    await graphNode(page, "ch1").click();
    const name = page.locator("#inspector input[type='text']").first();
    await name.fill("VocalMic");
    await name.focus();
    await mark(page, "menu-undo-in-field");
    await pushMenu(page, "edit-undo");
    const fieldAfter = await name.inputValue();
    await page.click("#btn-view-console");
    const afterFieldUndo = (await faderReadout(page, "CH 1").textContent())!;

    const trace = await traceOf(page);
    const all = spans(trace);
    const stateCalls = all.filter((s) => s.cmd === "set_edit_menu_state");
    const labelCalls = all.filter((s) => s.cmd === "set_edit_menu_labels");
    const dragFrom = markTime(trace, "drag-start")!;
    const dragTo = markTime(trace, "drag-end")!;
    const duringDrag = stateCalls.filter((s) => s.start >= dragFrom && s.start <= dragTo);
    const langFrom = markTime(trace, "lang")!;
    const langTo = markTime(trace, "lang-done")!;
    const duringLang = labelCalls.filter((s) => s.start >= langFrom && s.start <= langTo);

    console.log(timeline(trace, { limit: 80 }));
    console.log(report("edit menu", []));
    console.log(`set_edit_menu_state: ${stateCalls.length} total (${stateCalls.map((s) => s.detail).join(" ")})`);
    console.log(`  during the 40-move drag: ${duringDrag.length}`);
    console.log(`set_edit_menu_labels: ${labelCalls.length} total, ${duringLang.length} across the language switch`);
    console.log(`readout ${before} → ${edited} → ${dragged} → ${afterFieldUndo}`);
    console.log(`menu undo status: "${menuUndoStatus}"; name field after the menu undo: "${fieldAfter}"`);

    // Forty pointermoves, each an edit through the funnel, and the menu state was
    // pushed at most once across them — the report is per real depth transition, not
    // per edit, which is what keeps a drag off the IPC boundary.
    expect(duringDrag.length).toBeLessThanOrEqual(1);
    // The same rule stated as a property rather than a count: no push ever repeats the
    // state the previous one already sent.
    for (let i = 1; i < stateCalls.length; i++) {
      expect(stateCalls[i].detail).not.toBe(stateCalls[i - 1].detail);
    }
    // The labels are pushed on every language change (twice here: ja, then back to en).
    expect(duringLang.length).toBe(2);
    // The menu delegated to the focused text field exactly as the chord does: the plan
    // behind it is untouched, and the field's OWN undo ran (the typed name is gone).
    // The field half is Chromium's execCommand here; WKWebView is verified by hand.
    expect(afterFieldUndo).toBe(dragged);
    expect(fieldAfter).not.toBe("VocalMic");
  });

  // ---------------------------------------------------------------------------
  // undo-refusal-ladder
  // ---------------------------------------------------------------------------
  test("every refusal in order, none of them spending the entry", async ({ page }) => {
    const verdicts: string[] = [];
    const lines: string[] = [];
    const record = (label: string, s: string): void => {
      verdicts.push(s);
      lines.push(`${label.padEnd(28)} ${s}`);
    };

    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();

    // (a) empty stack, with a modal open: "nothing to undo" is decided before the
    // refusal, so it wins.
    await page.click("#btn-prefs");
    await expect(page.locator("#prefs-modal")).toBeVisible();
    record("(a) empty + modal", await undoOnce(page));
    expect(verdicts.at(-1)).toBe(NOTHING_TO_UNDO);
    await page.click("#prefs-modal .consent-btn-primary");
    await expect(page.locator("#prefs-modal")).toBeHidden();

    // One entry every later condition is measured against.
    const before = (await faderReadout(page, "CH 1").textContent())!;
    await faderOf(page, "CH 1").focus();
    await page.keyboard.press("ArrowUp");
    const edited = (await faderReadout(page, "CH 1").textContent())!;
    expect(edited).not.toBe(before);

    // (b) Preferences modal.
    await page.click("#btn-prefs");
    await expect(page.locator("#prefs-modal")).toBeVisible();
    record("(b) prefs modal", await undoOnce(page));
    await page.click("#prefs-modal .consent-btn-primary");
    await expect(page.locator("#prefs-modal")).toBeHidden();
    expect(await faderReadout(page, "CH 1").textContent()).toBe(edited); // entry unspent

    // (c) MIDI panel — non-modal on screen, but modalOpen() counts it.
    await page.click("#btn-device");
    await page.click("#btn-midi");
    await expect(page.locator("#midi-panel")).toBeVisible();
    record("(c) MIDI panel", await undoOnce(page));
    await page.keyboard.press("Escape");
    await expect(page.locator("#midi-panel")).toBeHidden();
    expect(await faderReadout(page, "CH 1").textContent()).toBe(edited);

    // (d) the channel tuning screen — the one modal that edits the plan, so it is
    // deliberately permissive. Undo here consumes the entry, so it is put back.
    await page.click("#btn-view-graph");
    await openEqScreen(page, "ch1");
    record("(d) tuning screen", await undoOnce(page));
    await page.keyboard.press("Escape");
    await expect(page.locator("#dyn-screen-box")).toBeHidden();
    await page.click("#btn-view-console");
    expect(await faderReadout(page, "CH 1").textContent()).toBe(before);
    await page.keyboard.press("ControlOrMeta+Shift+z"); // put the entry back
    await expect(faderReadout(page, "CH 1")).toHaveText(edited);

    // (e) a fader drag in progress, and (f) a press that has not moved.
    const track = (await faderOf(page, "CH 1").boundingBox())!;
    await page.mouse.move(track.x + track.width / 2, track.y + track.height * 0.5);
    await page.mouse.down();
    record("(f) press, not moved", await undoOnce(page));
    // (f) was permissive, so it consumed the entry — redo it before testing (e).
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await page.mouse.move(track.x + track.width / 2, track.y + track.height * 0.62, { steps: 3 });
    record("(e) drag in progress", await undoOnce(page));
    await page.mouse.up();
    // The drag moved the fader, so re-establish a known single entry from here.
    await undoDepth(page);
    const base2 = (await faderReadout(page, "CH 1").textContent())!;
    await faderOf(page, "CH 1").focus();
    await page.keyboard.press("ArrowUp");
    const edited2 = (await faderReadout(page, "CH 1").textContent())!;
    expect(edited2).not.toBe(base2);

    // (h) a file flow holding the plan: the native Open dialog is held on the barrier,
    // which is what makes fileFlowBusy observable without a real file picker. The plan
    // is dirty by now, so the flow asks to discard first — agreeing is what lets it
    // reach the picker at all.
    await setDialogAnswer(page, "Ok");
    await blockAt(page, "plugin:dialog|open", 1);
    await page.click("#btn-file");
    await page.click("#btn-open");
    await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 15_000 });
    record("(h) file flow busy", await undoOnce(page));
    await releaseBarrier(page);
    await expect(faderReadout(page, "CH 1")).toHaveText(edited2); // entry unspent

    // (g) a device read in flight. Fetch sets deviceReadInFlight for the whole read
    // and its epilogue; the barrier holds it at the first parameter.
    await blockAt(page, "vd_get", 1);
    await page.click("#btn-device");
    await page.click("#btn-fetch");
    await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 20_000 });
    record("(g) device read in flight", await undoOnce(page));
    expect(await faderReadout(page, "CH 1").textContent()).toBe(edited2);
    await releaseBarrier(page);
    await waitQuiet(page, 1500, 120_000);

    // (i) a sampleRate-touching entry while live. Recorded offline first, because the
    // rate picker locks the moment a session is up.
    const rateBefore = await page.locator("#rate-picker").inputValue();
    await page.selectOption("#rate-picker", "96000");
    // The rate change really did record an entry — without this probe, (i) below
    // reading "nothing to undo" would have the same value if the picker's funnel had
    // recorded nothing at all, and the "unreachable refusal" reading would not follow.
    expect(await undoOnce(page)).toMatch(UNDO_APPLIED);
    await expect(page.locator("#rate-picker")).toHaveValue(rateBefore);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(page.locator("#rate-picker")).toHaveValue("96000");
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    await goLive(page);
    const rateLocked = await page.locator("#rate-picker").isDisabled();
    record("(i) rate entry, then live", await undoOnce(page));

    // (j) a nodeParams-only entry while live: permissive, and the one condition the
    // rate refusal is meant to be distinguished from.
    const liveBefore = (await faderReadout(page, "CH 1").textContent())!;
    await faderOf(page, "CH 1").focus();
    await page.keyboard.press("ArrowUp");
    expect(await faderReadout(page, "CH 1").textContent()).not.toBe(liveBefore);
    record("(j) nodeParams entry, live", await undoOnce(page));
    await expect(faderReadout(page, "CH 1")).toHaveText(liveBefore);

    console.log(lines.join("\n"));
    console.log(`rate picker disabled while live: ${rateLocked}`);
    const trace = await traceOf(page);
    console.log(timeline(trace, { limit: 60 }));
    console.log(report("refusal ladder", []));

    expect(verdicts[1]).toBe(MODAL_REFUSAL); // (b)
    expect(verdicts[2]).toBe(MODAL_REFUSAL); // (c) the MIDI panel counts as modal
    expect(verdicts[3]).toMatch(UNDO_APPLIED); // (d) the tuning screen is permissive
    expect(verdicts[4]).toMatch(UNDO_APPLIED); // (f) an un-moved press is permissive
    expect(verdicts[5]).toBe(DRAG_REFUSAL); // (e)
    expect(verdicts[6]).toBe(BUSY_REFUSAL); // (h)
    expect(verdicts[7]).toBe(BUSY_REFUSAL); // (g)
    // (i) — PINNED as an unreachable refusal. The rate change above IS undoable while
    // offline (probed), and activating a session runs the readback's rerenderPlan,
    // which resets BOTH stacks; the picker is disabled from then on. So no sampleRate
    // entry can exist while live, and the undoRateLive message has no path from the UI
    // at all. Recorded as what the app does, not as what it intends.
    expect(rateLocked).toBe(true);
    expect(verdicts[8]).toBe(NOTHING_TO_UNDO);
    expect(verdicts[9]).toMatch(UNDO_APPLIED); // (j) permissive
  });
});
