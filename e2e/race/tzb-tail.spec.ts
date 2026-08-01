import { test, expect, type Page } from "@playwright/test";
import {
  installFake,
  goLive,
  mark,
  BULK_CHANGE,
  pushNotify,
  pushMidi,
  traceOf,
  paramAddrsOf,
  setLatency,
  blockAt,
  releaseBarrier,
  waitQuiet,
  settleAfter,
  memOf,
  countersOf,
  setDialogAnswer,
  refuseAt,
  divergeAt,
  depthOf,
  hasProbe,
  type InstallOptions,
} from "./fake-device";
import { analyze, report, timeline, markTime, spans, getsOf, type Span } from "./analyze";
import { MAX_ENTRIES } from "../../src/core/plan-history";
import { CH1_FADER, CH2_FADER, faderOf, faderReadout, strip } from "./ui";

// The tail of four tiers in one file (docs/{en,ja}/live-race-harness.md): the two
// drop cases nothing else in T5 reaches, the two teardown cases whose window is a
// held pointer rather than an await, the one meter case that measures cost, and the
// long-session leak sweep.
//
// What they have in common is that the app state under test is the SMALLEST one it
// has — a pointer that is down — while the event landing on it is the largest the
// link can deliver. The windows are placed with the fake's barrier or with an
// in-page timer, never with a driver-side sleep: every Playwright call is a CDP
// round trip whose jitter is wider than the 50 ms reflect coalesce these cases
// straddle.

const CH3_FADER = "139:0:2"; // URX44V only — a URX22 plan has no such address
const CH4_FADER = "139:0:3";
const P_CH_PAN = 141; // direct-follow: applied into the plan with no readback at all
const MIDI_CC_LEVEL = 7;

/** The fake's stored raw value rendered the way the console renders the plan's
 *  (src/ui/console.ts fmtDb over src/core/control/vd.ts vdToLevel), so "the screen
 *  shows what the device holds" is one string comparison. */
function deviceLevelText(raw: number | undefined): string {
  const v = raw ?? 0;
  if (v <= -32768) return "-∞";
  const db = v / 100;
  return (db > 0 ? "+" : "") + db.toFixed(1);
}

/** Click a File menu item (the menu opens on its trigger and closes on the item). */
async function fileMenu(page: Page, id: string): Promise<void> {
  await page.click("#btn-file");
  await page.click(`#${id}`);
}

/** Click the live toggle without opening the Device menu. The menu closes on the
 *  first click and the modal scrim swallows it entirely, so this is the only entry
 *  that works in every screen state. */
const clickLive = (page: Page): Promise<void> => clickHidden(page, "btn-live");

/** Click a Device-menu item without opening the menu. The menu closes on its first
 *  item click, so a second action inside the same flow (cancelling a fetch with the
 *  same button) has nowhere visible to land. */
const clickHidden = (page: Page, id: string): Promise<void> =>
  page.evaluate((btn) => (document.getElementById(btn) as HTMLButtonElement).click(), id);

/** How many reads the fake has been asked for so far. */
const getCount = (page: Page): Promise<number> =>
  page.evaluate(() => window.__urxFake.log.filter((e) => e.kind === "ipc-start" && e.cmd === "vd_get").length);

const waitForReads = (page: Page, n: number, timeout = 60_000): Promise<unknown> =>
  page.waitForFunction(
    (target) => window.__urxFake.log.filter((e) => e.kind === "ipc-start" && e.cmd === "vd_get").length >= target,
    n,
    { timeout },
  );

/**
 * Arm a multi-address diff in one flush window: dispatch a fader step onto the first
 * `n` console strips synchronously, so all of them land inside the same 120 ms
 * throttle and the flush that follows has a send loop long enough to interrupt.
 */
const armMultiEdit = (page: Page, n: number): Promise<number> =>
  page.evaluate((count) => {
    const faders = [...document.querySelectorAll<HTMLElement>(".con-fader")].slice(0, count);
    for (const f of faders) {
      f.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    }
    return faders.length;
  }, n);

/** Nodes the graph flags as "not confirmed by the device" (plan.unreadNodes, painted
 *  as the "?" badge). */
const unreadBadges = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll<SVGGElement>("#graph-host g.node")]
      .filter((g) => [...g.querySelectorAll("text")].some((tx) => tx.textContent === "?"))
      .map((g) => g.getAttribute("data-id") ?? ""),
  );

interface DragProbe {
  /** Trace ms at which the captured fader element left the document, or -1. */
  detachAt: number;
  connected: boolean;
  mutations: number;
  frames: number;
  maxGap: number;
  scroll: number;
}

/**
 * Capture one strip's fader element and start counting what happens to the rack around
 * it: DOM mutations under `.con-strips`, painted frames, and the instant the captured
 * element is taken out of the document. The detach instant is recorded in the FAKE's
 * clock so it can be compared against the write timestamps in the IPC trace — the
 * only way to say "the drag kept writing after its element was gone".
 */
const probeStart = (page: Page, name: string): Promise<void> =>
  page.evaluate((label) => {
    const w = window as unknown as { __probe: Record<string, unknown> };
    const f = window.__urxFake;
    const host = document.querySelector<HTMLElement>(".con-strips")!;
    // Substring match is safe for the channel labels these cases use: no strip name is
    // a prefix of another on either model (there is no CH 10).
    const st = [...document.querySelectorAll<HTMLElement>(".con-strip")].find((s) => s.textContent?.includes(label))!;
    const fader = st.querySelector<HTMLElement>(".con-fader")!;
    const state: Record<string, unknown> = { fader, host, detachAt: -1, mutations: 0, frames: 0, maxGap: 0 };
    w.__probe = state;
    const obs = new MutationObserver((records) => {
      state.mutations = (state.mutations as number) + records.length;
      if (state.detachAt === -1 && !fader.isConnected) state.detachAt = +(performance.now() - f.t0).toFixed(1);
    });
    obs.observe(host, { childList: true, subtree: true });
    state.obs = obs;
    let last = performance.now();
    const tick = (): void => {
      const now = performance.now();
      state.frames = (state.frames as number) + 1;
      state.maxGap = Math.max(state.maxGap as number, now - last);
      last = now;
      state.raf = requestAnimationFrame(tick);
    };
    state.raf = requestAnimationFrame(tick);
  }, name);

const probeStop = (page: Page): Promise<DragProbe> =>
  page.evaluate(() => {
    const state = (window as unknown as { __probe: Record<string, unknown> }).__probe;
    (state.obs as MutationObserver).disconnect();
    cancelAnimationFrame(state.raf as number);
    return {
      detachAt: state.detachAt as number,
      connected: (state.fader as HTMLElement).isConnected,
      mutations: state.mutations as number,
      frames: state.frames as number,
      maxGap: +(state.maxGap as number).toFixed(1),
      scroll: (state.host as HTMLElement).scrollLeft,
    };
  });

/**
 * Press and hold one strip's fader, moving it for `ms`, and run `during` with the
 * pointer still down. The element probe is armed AFTER the pointerdown, deliberately:
 * a rack that is already churning replaces strips between the capture and the press,
 * and a probe armed earlier would then be reporting the detachment of an element the
 * gesture never touched.
 */
async function dragFader(
  page: Page,
  name: string,
  ms: number,
  during: (elapsed: () => number) => Promise<void> = async () => {},
): Promise<{ held: string; probe: DragProbe }> {
  // A rack that is being rebuilt hands back a null box: the locator re-resolves, but
  // the element it found can be replaced again before it is measured. Retry rather
  // than assert — a press aimed at a stale box is the harness's own race, not the
  // app's, and it shows up as a drag that wrote nothing.
  let box: { x: number; y: number; width: number; height: number } | null = null;
  for (let i = 0; i < 20 && !box; i++) {
    box = await faderOf(page, name)
      .boundingBox()
      .catch(() => null);
    if (!box) await page.waitForTimeout(50);
  }
  expect(box, `${name} fader never held still long enough to be measured`).not.toBeNull();
  box = box!;
  const x = box.x + box.width / 2;
  const top = box.y + box.height * 0.75;
  await page.mouse.move(x, top);
  await page.mouse.down();
  await probeStart(page, name);
  const t0 = Date.now();
  const elapsed = (): number => Date.now() - t0;
  const runner = during(elapsed);
  let i = 0;
  while (elapsed() < ms) {
    // A shallow sawtooth: the value has to keep changing or the flush has no diff to
    // send, and it has to stay inside the groove or the app clamps and the writes stop.
    const frac = 0.75 - 0.1 * (i % 4);
    await page.mouse.move(x, box.y + box.height * frac);
    await page.waitForTimeout(40);
    i++;
  }
  await runner;
  const held = (await faderReadout(page, name).textContent())!;
  const probe = await probeStop(page);
  await page.mouse.up();
  return { held, probe };
}

/** MIDI panel state seeded so the second operator is present from boot: the saved
 *  ports reopen in MidiControl's constructor and its first feedback pass populates
 *  the bound-control cache, which is what these cases put under stress. */
function midiStorage(models: string[]): InstallOptions["storage"] {
  const one = [{ control: "ch1/level", addr: { type: "cc", channel: 0, controller: MIDI_CC_LEVEL }, mode: "absolute" }];
  return {
    "urx-midi": JSON.stringify({
      input: "Fake In",
      output: "Fake Out",
      models: Object.fromEntries(models.map((m) => [m, one])),
    }),
  };
}

const cc = (value: number): number[][] => [[0xb0, MIDI_CC_LEVEL, value]];

const setsOn = (all: Span[], addr: string, from = 0): Span[] =>
  all.filter((s) => s.cmd === "vd_set" && s.addr === addr && s.start >= from);

/** Undo/redo depth as the app itself pushes it to the macOS Edit menu. "false/false"
 *  can only be a reset (or an undo that emptied both stacks), and it carries a
 *  timestamp, which `depthOf` — a sample, not a stream — cannot. */
const menuResets = (trace: Awaited<ReturnType<typeof traceOf>>, from: number): number[] =>
  trace
    .filter((e) => e.kind === "ipc-end" && e.cmd === "set_edit_menu_state" && e.t >= from && e.detail === "false/false")
    .map((e) => e.t);

test.describe("Tzb tail", () => {
  // ---------------------------------------------------------------- T5 drop ----

  // drop-bulk-change-sentinel-mid-drag. An operator recalls a scene on the unit while
  // the app's operator is holding a fader. The sentinel carries no address, so it
  // cannot be scoped to anything: it escalates to a re-read of the whole device, and
  // the fake answers that read with a scene the plan has never seen.
  //
  // The ladder rung is where in the drag the recall lands. It is expressed in
  // milliseconds rather than on the barrier because the thing being placed is not a
  // command boundary — it is the phase of a continuous gesture, and the gesture is
  // seconds long, so driver jitter is two orders of magnitude below the window.
  for (const D of [100, 600, 1500]) {
    test(`a BULK_CHANGE sentinel ${D} ms into a fader drag replaces the plan under the pointer`, async ({ page }) => {
      test.setTimeout(180_000);
      await installFake(page);
      await page.goto("/");
      await expect(page.locator("#model-picker")).toHaveValue("URX44V");
      expect(await hasProbe(page)).toBe(true);

      await goLive(page);
      await page.click("#btn-view-console");
      await expect(faderReadout(page, "CH 1")).toBeVisible();
      // The recalled scene: whatever the drag writes, the device answers a read of
      // these with values the plan cannot have produced. CH 2 is untouched by the
      // operator throughout, so its readout moving is the whole-plan replacement
      // stated without reference to the contested address. -7.0 dB sits deliberately
      // above the whole travel the drag sweeps (it starts at three quarters of the
      // groove and only goes lower), so the recalled value cannot collide with one
      // the gesture itself produced.
      await divergeAt(page, CH1_FADER, -700);
      await divergeAt(page, CH2_FADER, -800);
      // Writes are given the catalog's latency; reads are left at zero. A whole-device
      // sweep is ~800 sequential reads, so at 8 ms it is 6.4 s and at 1 ms it is still
      // 3.5 s (setTimeout's own floor) — longer than any drag a person makes, and the
      // case would then only be measuring that the reflect lands after the release.
      // The reflect's position inside the gesture is the whole subject here.
      await setLatency(page, { set: 25 });

      const before = (await faderReadout(page, "CH 1").textContent())!;
      const beforeCh2 = (await faderReadout(page, "CH 2").textContent())!;
      // Three entries to lose. Each stepping key's keyup is a boundary committed at
      // once, so the depth is exact rather than a count of gestures.
      for (let i = 0; i < 3; i++) await faderOf(page, "CH 1").press("ArrowUp");
      const depthBefore = await depthOf(page);

      await mark(page, "drag-start");
      // The value the operator has under the pointer at the instant the unit is
      // recalled. Sampled here rather than at the release: for the early rungs the
      // readback has already landed by then, so a release-time sample reads the
      // recalled scene and the comparison would be against itself.
      let dragged = "";
      const { held, probe: duringDrag } = await dragFader(page, "CH 1", 3500, async (elapsed) => {
        while (elapsed() < D) await page.waitForTimeout(20);
        dragged = (await faderReadout(page, "CH 1").textContent())!;
        await mark(page, "sentinel");
        await pushNotify(page, [BULK_CHANGE]);
      });
      await mark(page, "release");

      await settleAfter(page, "release", 1200, 20_000);
      const depthAfter = await depthOf(page);

      const after = (await faderReadout(page, "CH 1").textContent())!;
      const afterCh2 = (await faderReadout(page, "CH 2").textContent())!;
      const trace = await traceOf(page);
      const all = spans(trace);
      const sentinelAt = markTime(trace, "sentinel")!;
      const dragAt = markTime(trace, "drag-start")!;
      const releaseAt = markTime(trace, "release")!;
      const reads = all.filter((s) => s.cmd === "vd_get" && s.start > sentinelAt);
      const dragWrites = setsOn(all, CH1_FADER, dragAt);
      const resets = menuResets(trace, dragAt);

      console.log(timeline(trace, { from: dragAt - 100, limit: 60 }));
      console.log(
        `D=${D} ms: reads after the sentinel=${reads.length}; drag writes=${dragWrites.length}; ` +
          `fader detached at ${duringDrag.detachAt} ms (release at ${releaseAt.toFixed(0)} ms), ` +
          `still connected=${duringDrag.connected}; rack mutations=${duringDrag.mutations}`,
      );
      console.log(
        `readout: before=${before} atRecall=${dragged} atRelease=${held} after=${after}; ` +
          `device holds ${deviceLevelText((await memOf(page))[CH1_FADER])}; ` +
          `CH 2 before=${beforeCh2} after=${afterCh2}; ` +
          `undo depth ${depthBefore.undo} → ${depthAfter.undo}; ` +
          `history emptied at [${resets.map((t) => t.toFixed(0)).join(", ")}] ms`,
      );

      // The escalation itself: no address means no node, so one notify costs a
      // whole-device read. A scoped reconcile of one channel is a few dozen reads.
      expect(reads.length).toBeGreaterThan(300);
      // The drag really did drive the link, or everything below is about a gesture
      // that never happened.
      expect(dragWrites.length).toBeGreaterThan(1);
      expect(dragged).not.toBe(before);

      // PINNED, and a defect. The readback lands while the pointer is still down: the
      // element the operator is holding is taken out of the document by the reflect's
      // full console render, and the drag's own handler — bound to `window`, closing
      // over the detached StripRef — keeps writing into the plan and out to the
      // device from a control that is no longer on screen (invariant 10).
      expect(duringDrag.connected).toBe(false);
      expect(duringDrag.detachAt).toBeGreaterThan(dragAt);
      expect(duringDrag.detachAt).toBeLessThan(releaseAt);
      expect(setsOn(all, CH1_FADER, duringDrag.detachAt).length).toBeGreaterThan(0);
      // The visible half of that: the strip on screen stops answering the pointer the
      // instant it is replaced, so the operator goes on moving a fader whose readout
      // is frozen on the recalled value while the writes keep leaving.
      expect(held).toBe(after);

      // The plan the operator was editing is gone — for every key they were NOT holding.
      // That half is unconditional: nothing else authored CH 2, so the recalled scene
      // lands there whatever the pointer was doing.
      expect(afterCh2).toBe(deviceLevelText(-800));
      expect(afterCh2).not.toBe(beforeCh2);

      // The key UNDER THE POINTER is NOT asserted, and the reason is a limit of this
      // trace rather than a softening. readIntoPlan applies the device's values first
      // and the edits made during the read over them, so the outcome turns on whether a
      // plan EDIT landed between the sweep being issued and it resolving — and an edit
      // is not in the IPC log at all. Only its write is, lagged by up to the 120 ms
      // flush window and continuing after the read has resolved, so no predicate over
      // the trace decides it. Measured both ways: `-7.0` (the scene) running alone,
      // `-14.0` (a value the drag passed through) under `--workers=4`.
      //
      // Placing the edit exactly, the way T1 does with `blockAt`, would decide it — but
      // this case's variable is already D, where the recall falls inside the gesture,
      // and holding the sweep would replace that variable rather than add to it. Logged
      // here and recorded under the harness's known gaps.
      //
      // Whether the plan and the unit end up APART on that key is the SAME interleaving
      // read from the other side, so it is logged with it rather than pinned beside it:
      // they diverge when the drag's last write outlives the merge, and they agree when
      // the merge happens to settle on the value that write carried. It was asserted
      // here until CI produced the second case (both `-7.2`, D=1500) — a red run stating
      // nothing the comment above does not already say is unresolvable.
      const sweepStart = reads.length ? reads[0].start : Number.POSITIVE_INFINITY;
      const unitHolds = deviceLevelText((await memOf(page))[CH1_FADER]);
      console.log(
        `sweep began at ${sweepStart.toFixed(0)} ms; the pointer's key settled at ${after}` +
          ` (the scene holds ${deviceLevelText(-700)}; the unit and the plan ` +
          `${unitHolds === after ? "agree" : "have come apart"}) — interleaving-dependent, not asserted`,
      );

      // …and the three entries that existed before the gesture are gone, dropped by a
      // reset that ran while the pointer was still down: a readback re-authors every
      // value, so nothing earlier describes a state the plan can return to. The
      // operator cannot step back to what they were holding either.
      expect(depthBefore.undo).toBe(3);
      expect(depthAfter.undo).toBeLessThan(3);
      expect(resets.length).toBeGreaterThan(0);
      expect(resets[0]).toBeLessThan(releaseAt);
    });
  }

  // drop-read-reject-mid-fetch, the scripted half: one read of the sweep is refused.
  //
  // The catalog expects the pre-read clone to be restored here. It is not: the
  // restore is on the AbortError branch alone, and a rejected read is collected into
  // the readback's per-group error list instead, so the fetch runs to its epilogue
  // and COMMITS the partial result. That is what is pinned below; the restore path
  // the catalog describes is reachable only by cancelling, and it is the test after
  // this one.
  test("a read refused mid-Fetch commits the partial plan instead of restoring the pre-read clone", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await installFake(page, { storage: midiStorage(["URX44V"]) });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await expect.poll(() => page.evaluate(() => window.__urxFake.midi.inPort)).toBe("Fake In");
    await setDialogAnswer(page, "Ok");

    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    // Three history entries: a stepping key's keyup is a boundary committed at once,
    // so each press is exactly one entry.
    for (let i = 0; i < 3; i++) await faderOf(page, "CH 1").press("ArrowUp");
    const edited = (await faderReadout(page, "CH 1").textContent())!;
    expect(await depthOf(page)).toEqual({ undo: 3, redo: 0 });

    await setLatency(page, { get: 2 });
    await refuseAt(page, "vd_get", 300, "transport");
    await mark(page, "fetch");
    await page.click("#btn-device");
    await page.click("#btn-fetch");
    await expect(page.locator("#statusbar")).toContainText(/Fetched|partial|Read/i, { timeout: 60_000 });
    await waitQuiet(page, 600);
    await mark(page, "fetch-done");

    const afterFetch = (await faderReadout(page, "CH 1").textContent())!;
    const depth = await depthOf(page);
    const status = await page.evaluate(() => document.getElementById("statusbar")?.textContent ?? "");

    // Which plan a live writer lands in. Nothing replaced the plan object on this
    // path (the readback mutates it in place), so the MIDI cache is still pointing at
    // the plan on screen and the CC moves what the operator can see.
    const beforeCc = (await faderReadout(page, "CH 1").textContent())!;
    await pushMidi(page, cc(100));
    await expect(faderReadout(page, "CH 1")).not.toHaveText(beforeCc);
    const afterCc = (await faderReadout(page, "CH 1").textContent())!;

    await page.click("#btn-view-graph");
    const unread = await unreadBadges(page);
    const nodeCount = await page.evaluate(() => document.querySelectorAll("#graph-host g.node").length);

    // deviceReadInFlight is cleared in the finally, so the flow it gates passes at
    // the first attempt afterwards.
    await fileMenu(page, "btn-new");
    await expect(page.locator("#statusbar")).toContainText("Created a new plan");

    const trace = await traceOf(page);
    // The one invariant with an input here: a failed read must end where it stopped.
    // Nothing may keep talking to the device once the flow has reported and released
    // the connection — a retry loop or a stray epilogue read would fire this.
    const findings = analyze(trace, { quiesceAfter: "fetch-done" });
    console.log(timeline(trace, { from: markTime(trace, "fetch")! - 100, limit: 40 }));
    console.log(report("read refused mid-Fetch", findings));
    console.log(
      `readout: edited=${edited} afterFetch=${afterFetch} (device ${deviceLevelText(undefined)}) afterCC=${afterCc}; ` +
        `undo depth after the fetch=${depth.undo}; status="${status}"`,
    );
    console.log(`unread nodes: ${unread.length} of ${nodeCount} — ${unread.slice(0, 8).join(", ")}`);
    expect(findings).toHaveLength(0);

    // PINNED. The plan is NOT restored: the three edits are replaced by the values
    // the sweep did manage to read, and the one group that failed is left at its plan
    // default and flagged. A refusal is not "nothing happened" on this path.
    expect(afterFetch).not.toBe(edited);
    expect(afterFetch).toBe(deviceLevelText(undefined));
    expect(unread.length).toBeGreaterThan(0);
    expect(unread.length).toBeLessThan(nodeCount);
    // rerenderPlan() re-authored every value, so no entry describes a state this plan
    // can return to and the stack is dropped — including the two entries that had
    // nothing to do with the failed group.
    expect(depth).toEqual({ undo: 0, redo: 0 });
    // The MIDI writer landed in the plan on screen, because this path never made a
    // second one. (The path that does is the next test.)
    expect(afterCc).not.toBe(beforeCc);
  });

  // drop-read-reject-mid-fetch, the restore half — the failure the catalog named.
  // Cancelling a fetch used to replace `plan` with a pre-read clone through
  // rerenderPlan, which (unlike loadPlan) does not call midi.onModelChanged, so every
  // BoundControl in the MIDI cache closed over the discarded object. Both halves of
  // that are gone: the read works on a private copy, so a cancel has nothing to restore
  // and never replaces the object; and `resolve` drops its memo when the plan it was
  // bound against is no longer the one main.ts holds, so no future replacement path has
  // to remember to notify midi either.
  //
  // Three phases, because "the readout moved" on its own cannot tell a live binding
  // from a coincidence: the same CC moves the plan before the cancel, still moves it
  // after, and moves it again once a plan replacement that goes through loadPlan has run.
  test("the pre-read restore re-points every MIDI binding at the plan on screen", async ({ page }) => {
    test.setTimeout(180_000);
    await installFake(page, { storage: midiStorage(["URX44V"]) });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await expect.poll(() => page.evaluate(() => window.__urxFake.midi.inPort)).toBe("Fake In");
    await setDialogAnswer(page, "Ok");

    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    const r0 = (await faderReadout(page, "CH 1").textContent())!;
    await pushMidi(page, cc(100));
    await expect(faderReadout(page, "CH 1")).not.toHaveText(r0);
    const r1 = (await faderReadout(page, "CH 1").textContent())!;

    await setLatency(page, { get: 8 });
    const base = await getCount(page);
    await mark(page, "fetch");
    await page.click("#btn-device");
    await page.click("#btn-fetch");
    await waitForReads(page, base + 100); // the read is genuinely under way
    // How far the sweep got before the cancel. It is the yardstick for what follows:
    // a whole-device read is several hundred sequential vd_gets, so a cancel that only
    // suppressed the COMMIT — and let the sweep run to completion — issues many times
    // this many more before the link falls quiet. Without the bound, `quiesceAfter`
    // stamped behind `waitQuiet` exonerates exactly that. (t6's teardown ladder bounds
    // the same way, against its boot sweep.)
    const readsBeforeCancel = (await getCount(page)) - base;
    expect(readsBeforeCancel).toBeGreaterThanOrEqual(100);
    await mark(page, "cancel");
    await clickHidden(page, "btn-fetch"); // the same button cancels an in-flight fetch
    await waitQuiet(page, 800);
    await mark(page, "cancel-done");

    const restored = (await faderReadout(page, "CH 1").textContent())!;
    // Full scale, not another mid-travel value: a control that did move would land at
    // the top of the grid, so "the readout is unchanged" cannot be a coincidence of
    // two controller positions encoding the same step.
    await pushMidi(page, cc(127));
    await page.waitForTimeout(400);
    const afterOrphanCc = (await faderReadout(page, "CH 1").textContent())!;

    // A plan replacement that goes through loadPlan clears the cache; the identical
    // CC then lands where it can be seen again.
    await fileMenu(page, "btn-new");
    await expect(page.locator("#statusbar")).toContainText("Created a new plan");
    const fresh = (await faderReadout(page, "CH 1").textContent())!;
    await pushMidi(page, cc(127));
    await page.waitForTimeout(400);
    const afterNewCc = (await faderReadout(page, "CH 1").textContent())!;

    const trace = await traceOf(page);
    // The cancel really cancelled: the sweep is not cancellable at the broker, so
    // "no further command after the abort was acknowledged" is the only way to say
    // the read stopped rather than merely stopped being reported.
    const findings = analyze(trace, { quiesceAfter: "cancel-done" });
    const readsAfterCancel = getsOf(trace).filter(
      (g) => g.start > markTime(trace, "cancel")! && g.start < markTime(trace, "cancel-done")!,
    ).length;
    console.log(timeline(trace, { from: markTime(trace, "fetch")! - 100, limit: 40 }));
    console.log(report("Fetch cancelled mid-read", findings));
    console.log(
      `readout: r0=${r0} afterCC=${r1} restored=${restored} afterOrphanCC=${afterOrphanCc} | ` +
        `fresh=${fresh} afterNewCC=${afterNewCc}`,
    );
    console.log(`reads: ${readsBeforeCancel} before the cancel, ${readsAfterCancel} between cancel and cancel-done`);
    expect(findings).toHaveLength(0);
    // The read STOPPED, rather than stopped being reported: fewer reads followed the
    // cancel than the sweep had already issued before it, where a sweep left running to
    // completion would have issued several times as many.
    expect(readsAfterCancel).toBeLessThan(readsBeforeCancel);

    // "A cancel means nothing happened", now because nothing was written rather than
    // because a clone was put back: the plan is the one that existed before the read.
    expect(restored).toBe(r1);
    // FIXED (invariant 14). The CC lands in the plan on screen — a full-scale message,
    // so it lands at the top of the grid rather than at some other mid-travel step.
    expect(afterOrphanCc).not.toBe(restored);
    expect(afterOrphanCc).toBe("+10.0");
    // The same rule through the other replacement path, which goes via loadPlan: one
    // check in resolve() now covers both, so neither depends on its call site
    // remembering to notify the MIDI layer.
    expect(afterNewCc).not.toBe(fresh);
    expect(afterNewCc).toBe("+10.0");
  });

  // ------------------------------------------------------------ T6 teardown ----

  // teardown-model-switch-during-flush. The address vocabulary itself changes under
  // an operation that is already on the wire: a model switch runs loadPlan, which
  // deactivates the session and replaces the plan, while the flush's send loop is
  // sitting in an await between two commands.
  //
  // The barrier holds the flush at its FIRST command, so everything after it is
  // issued once the switch has completed. That the remaining commands come after is
  // therefore the barrier's doing and is not the claim; the claim is that they are
  // issued AT ALL — a loop that re-checked the session (or the plan) per command
  // would emit nothing after the release — and that they carry addresses the model
  // now on screen does not have.
  test("a flush interrupted by a model switch finishes sending the old model's addresses", async ({ page }) => {
    test.setTimeout(180_000);
    await installFake(page, { storage: midiStorage(["URX44V", "URX22"]) });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await expect.poll(() => page.evaluate(() => window.__urxFake.midi.inPort)).toBe("Fake In");
    await setDialogAnswer(page, "Ok");

    await goLive(page);
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    await setLatency(page, { get: 25, set: 60 });

    await blockAt(page, "vd_set", 1);
    await mark(page, "arm");
    const armed = await armMultiEdit(page, 20);
    expect(armed).toBeGreaterThanOrEqual(10);
    await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 30_000 });

    await mark(page, "switch");
    await page.locator("#model-picker").selectOption("URX22");
    await expect(page.locator("#statusbar")).toContainText("Switched to URX22", { timeout: 30_000 });
    await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "false");
    // The switch's OWN teardown (param unsubscribe, meter release, disconnect) is issued
    // in the same task as the replacement, and only vd_disconnect is exempt from
    // invariant 16 — so anchored on the "switch" mark the invariant reports the teardown
    // itself and can never fail. Drained first and re-anchored here, it measures escape.
    // t5's link-loss ladder stamps its boundary the same way.
    await page.waitForTimeout(200);
    await mark(page, "switch-teardown");
    const depthAfterSwitch = await depthOf(page);

    await mark(page, "release");
    await releaseBarrier(page);
    await settleAfter(page, "release", 1200, 15_000);

    // The second operator resolves against the model now on screen: loadPlan calls
    // midi.onModelChanged, which drops the bound cache and reloads the per-model
    // mappings. Without that reload the URX22 mapping set would never be installed.
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    const freshCh1 = (await faderReadout(page, "CH 1").textContent())!;
    await pushMidi(page, cc(110));
    await page.waitForTimeout(400);
    const afterCc = (await faderReadout(page, "CH 1").textContent())!;

    const trace = await traceOf(page);
    const all = spans(trace);
    const releaseAt = markTime(trace, "release")!;
    const late = all.filter((s) => s.cmd === "vd_set" && s.start > releaseAt);
    const orphanAddrs = late.map((s) => s.addr!).filter((a) => a === CH3_FADER || a === CH4_FADER);
    const findings = analyze(trace, { quiesceAfter: "switch-teardown" });

    console.log(timeline(trace, { from: markTime(trace, "arm")! - 100, limit: 60 }));
    console.log(
      `sets after the release: ${late.length} — ${[...new Set(late.map((s) => s.addr))].slice(0, 8).join(", ")}; ` +
        `addresses the URX22 does not have: ${orphanAddrs.length}; ` +
        `undo depth after the switch=${depthAfterSwitch.undo}; picker=${await page.locator("#model-picker").inputValue()}`,
    );
    console.log(`MIDI after the switch: fresh=${freshCh1} afterCC=${afterCc}`);
    console.log(report("model switch mid-flush", findings));

    // The switch was not refused: nothing gates a wholesale plan replacement on a
    // live session (deactivateLive runs inside loadPlan instead), so the picker moved
    // and the session went down.
    expect(await page.locator("#model-picker").inputValue()).toBe("URX22");
    // PINNED, and the defect. The flush outlives both its session and its plan: the
    // remaining commands go out to a unit the app has already disconnected from, and
    // they carry channels the plan on screen does not have.
    expect(late.length).toBeGreaterThan(1);
    expect(orphanAddrs.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.inv === 16)).toBe(true);
    // The backstop that DOES cover the switch: the history is reset rather than
    // rebased, so no entry survives to be applied against the new model's node ids.
    expect(depthAfterSwitch).toEqual({ undo: 0, redo: 0 });
    // …and the MIDI cache was re-pointed, which the in-flight commands were not.
    expect(afterCc).not.toBe(freshCh1);
  });

  // teardown-dyn-screen-close-during-refresh. The deferral that protects a drag is
  // itself the hazard: a pointerdown anywhere on the screen sets `grabbed`, every
  // refresh arriving while it is set is banked, and the window `pointerup` that ends
  // the press flushes the bank — running a full render() between the pointerup and
  // the click the browser dispatches from the same input event.
  test("a Close press that straddles a deferred refresh is swallowed by the rebuild", async ({ page }) => {
    test.setTimeout(180_000);
    await installFake(page);
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");

    await goLive(page);
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    await setLatency(page, { get: 20, set: 25 });

    const openComp = async (): Promise<void> => {
      await strip(page, "CH 1").locator('[aria-label="Comp screen…"]').click();
      await expect(page.locator("#dyn-screen-box")).toBeVisible();
    };
    /** Press and release the Close action as a pointer gesture, holding for `holdMs`.
     *  `locator.click()` would not do: the deferral is armed by the pointerdown and
     *  flushed by the pointerup, so the press has to be long enough to contain a
     *  notify, and the two halves have to be separately timed. */
    const pressClose = async (holdMs: number): Promise<boolean> => {
      const b = (await page.locator("#dyn-screen-box .consent-btn-primary").boundingBox())!;
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(holdMs);
      await page.mouse.up();
      await page.waitForTimeout(200);
      return page.locator("#dyn-screen-modal").isHidden();
    };

    // The control: the identical gesture with nothing to defer. Without it a swallowed
    // press cannot be told from a press the driver never delivered.
    await openComp();
    await mark(page, "quiet-press");
    const closedQuiet = await pressClose(320);

    await openComp();
    // 10 Hz of genuine device movement on the node the screen is bound to. CH_PAN is
    // a direct param, so each notify is applied into the plan with no read at all and
    // the reflect calls dynScreen.refresh() — which is the deferral's only trigger.
    await mark(page, "churn");
    await page.evaluate((pan) => {
      const f = window.__urxFake;
      let n = 0;
      (window as unknown as { __churn: number }).__churn = window.setInterval(() => {
        const v = ((n++ * 13) % 61) - 30;
        f.mem[`${pan}:0:0`] = v;
        f.pushNotify([[pan, 0, 0, v]]);
      }, 100);
    }, P_CH_PAN);
    await page.waitForTimeout(400); // the stream is running before the press starts

    // Held long enough for two or three notifies to be banked. The press is the only
    // thing that makes `grabbed` true, so the deferral cannot be armed before it.
    await mark(page, "press-down");
    const closedOnFirst = await pressClose(320);
    await mark(page, "press-up");
    await page.evaluate(() => clearInterval((window as unknown as { __churn: number }).__churn));

    let closedOnSecond = closedOnFirst;
    if (!closedOnFirst) {
      await page.locator("#dyn-screen-box .consent-btn-primary").click();
      await page.waitForTimeout(200);
      closedOnSecond = await page.locator("#dyn-screen-modal").isHidden();
    }

    await settleAfter(page, "press-up", 1200, 30_000);
    const trace = await traceOf(page);
    const notifiesInPress =
      trace.filter((e) => e.kind === "notify" && e.t >= markTime(trace, "press-down")!).length -
      trace.filter((e) => e.kind === "notify" && e.t > markTime(trace, "press-up")!).length;

    console.log(timeline(trace, { from: markTime(trace, "quiet-press")! - 200, limit: 50 }));
    console.log(
      `notifies inside the press=${notifiesInPress}; quiet press closed=${closedQuiet}; ` +
        `straddled press closed on the first=${closedOnFirst}; closed on a second=${closedOnSecond}`,
    );
    // The registration is given a window rather than the whole run: it is a snapshot
    // of one instant, and what is being asked is only whether the churn's own notifies
    // were inside it — a clean line here means the deferral was driven by addresses
    // the app was registered for, not by an escalation.
    console.log(
      report(
        "close during a deferred refresh",
        analyze(trace, {
          registration: await paramAddrsOf(page),
          registrationWindow: { from: markTime(trace, "churn")!, to: markTime(trace, "press-up")! },
        }),
      ),
    );

    // The control, and the straddle: the same gesture closes the screen when there is
    // nothing banked, and refreshes really were banked during the second one.
    expect(closedQuiet).toBe(true);
    expect(notifiesInPress).toBeGreaterThan(1);
    // PINNED, and a defect. The pointerup flushes the banked refresh, render()
    // replaces the whole box — including the Close button — and the click Chromium
    // dispatches from the same input event finds no live listener: the press is
    // swallowed entirely. Nothing tells the operator; they press again, and while a
    // device-driven refresh is arriving every 100 ms the second press is a coin toss
    // on the same window.
    expect(closedOnFirst).toBe(false);
    expect(closedOnSecond).toBe(true);
  });

  // ---------------------------------------------------------------- T7 meter ----

  // meter-feed-paint-vs-follow-churn. The only case in the catalog that measures cost
  // rather than correctness — but the cost has one correctness consequence, and the
  // run is built so that consequence is attributable: the SAME drag is made twice,
  // once with the follow churn running and once without, and everything else is held
  // fixed.
  test("a follow strip rebuild replaces the dragged fader under the pointer; without it the drag is intact", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await installFake(page);
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");

    await goLive(page);
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    await setLatency(page, { get: 8, set: 25 });

    // 10 Hz of meter frames for whatever the console registered, for both phases.
    await page.evaluate(() => {
      const f = window.__urxFake;
      let n = 0;
      (window as unknown as { __meters: number }).__meters = window.setInterval(() => {
        const v = -100 - ((n++ * 17) % 200);
        f.pushMeters(f.meterAddrs.map(([m, x]) => [m, x, v] as [number, number, number]));
      }, 100);
    });
    // Put the rack off its left edge, so "the scroll offset survived" is a statement
    // about something rather than about zero. CH 2 rather than CH 1 is dragged below
    // for the same reason: at this offset the leftmost strip is partly under the edge,
    // and a press aimed at a clipped control lands on the container instead — which
    // reads as a drag that wrote nothing.
    const scrollSet = await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>(".con-strips")!;
      host.scrollLeft = 120;
      return host.scrollLeft;
    });
    expect(scrollSet).toBeGreaterThan(0);

    // Phase A — the control. Same gesture, same meter feed, no follow churn.
    const beforeQuiet = (await faderReadout(page, "CH 2").textContent())!;
    await mark(page, "drag-quiet");
    const { held: heldQuiet, probe: quiet } = await dragFader(page, "CH 2", 2000);
    await settleAfter(page, "drag-quiet", 900, 8000);

    // Phase B — the churn. Direct notifies rotating over three channels at 20 Hz:
    // each one is applied with no read and repaints its strip, so refreshStrip runs
    // continuously. Three distinct controls, deliberately: a fourth would cross
    // MAX_CONCENTRATION and turn the settle into a whole-device read, which is a
    // different case (drop-concentration-threshold) and would confound this one.
    await page.evaluate((pan) => {
      const f = window.__urxFake;
      let n = 0;
      (window as unknown as { __churn: number }).__churn = window.setInterval(() => {
        const ch = n % 3;
        const v = ((n * 7) % 61) - 30;
        n++;
        f.mem[`${pan}:0:${ch}`] = v;
        f.pushNotify([[pan, 0, ch, v]]);
      }, 50);
    }, P_CH_PAN);
    await page.waitForTimeout(400);

    const subsBefore = await countersOf(page);
    const beforeChurn = (await faderReadout(page, "CH 2").textContent())!;
    await mark(page, "drag-churn");
    const { held: heldChurn, probe: churn } = await dragFader(page, "CH 2", 2500);
    await mark(page, "churn-end");
    const subsAfter = await countersOf(page);
    await page.evaluate(() => {
      clearInterval((window as unknown as { __churn: number }).__churn);
      clearInterval((window as unknown as { __meters: number }).__meters);
    });
    await settleAfter(page, "churn-end", 1200, 30_000);

    const scrollAfter = await page.evaluate(() => document.querySelector<HTMLElement>(".con-strips")!.scrollLeft);
    const trace = await traceOf(page);
    const all = spans(trace);
    const quietDragAt = markTime(trace, "drag-quiet")!;
    const churnDragAt = markTime(trace, "drag-churn")!;
    const quietWrites = all.filter(
      (s) => s.cmd === "vd_set" && s.addr === CH2_FADER && s.start >= quietDragAt && s.start < churnDragAt,
    );
    const churnWrites = setsOn(all, CH2_FADER, churnDragAt);

    console.log(timeline(trace, { from: churnDragAt - 100, limit: 40 }));
    console.log(
      `quiet drag : frames=${quiet.frames} maxGap=${quiet.maxGap} ms mutations=${quiet.mutations} ` +
        `detachAt=${quiet.detachAt} connected=${quiet.connected} writes=${quietWrites.length} ` +
        `${beforeQuiet} → ${heldQuiet}`,
    );
    console.log(
      `churn drag : frames=${churn.frames} maxGap=${churn.maxGap} ms mutations=${churn.mutations} ` +
        `detachAt=${churn.detachAt} connected=${churn.connected} writes=${churnWrites.length} ` +
        `(${setsOn(all, CH2_FADER, churn.detachAt).length} after the detach) ${beforeChurn} → ${heldChurn}`,
    );
    console.log(
      `meter registrations across the churn: ${subsBefore.meterSubs}/${subsBefore.meterUnsubs} → ` +
        `${subsAfter.meterSubs}/${subsAfter.meterUnsubs}; rack scroll ${scrollSet} → ${scrollAfter}`,
    );
    // The cost does not become a lost value: the churned drag's own address is still
    // carried to the device, and nothing read it back underneath. A finding here would
    // mean the rebuild had cost the gesture rather than only its element.
    const findings = analyze(trace, {
      edits: [{ label: "CH 2 drag under follow churn", addr: CH2_FADER, at: churnDragAt }],
    });
    console.log(report("drag under a 20 Hz follow churn", findings));
    expect(findings).toHaveLength(0);

    // The control: with nothing but the meter feed running, a two-second drag keeps
    // the element it started on. Without this the phase below says nothing — a strip
    // that is rebuilt by every render would fail here too.
    expect(quiet.connected).toBe(true);
    expect(quiet.detachAt).toBe(-1);
    // Both gestures really drove the link. Without this a press that missed its
    // control (a clipped strip, a scrolled rack) would pass every element check below
    // by never having been a drag at all.
    expect(quietWrites.length).toBeGreaterThan(1);
    expect(heldQuiet).not.toBe(beforeQuiet);
    expect(churnWrites.length).toBeGreaterThan(1);

    // PINNED, and the defect (invariant 10). The device's own movement on OTHER
    // channels rebuilds the strip the operator is holding: refreshStrip replaces the
    // whole strip element, and the drag's handlers live on `window` closing over the
    // detached StripRef, so the gesture continues against a control that has left the
    // document.
    expect(churn.connected).toBe(false);
    expect(churn.detachAt).toBeGreaterThan(churnDragAt);
    expect(setsOn(all, CH2_FADER, churn.detachAt).length).toBeGreaterThan(0);
    // The rebuild is genuinely more expensive, not merely different — logged above in
    // full, asserted here only where the difference is structural.
    expect(churn.mutations).toBeGreaterThan(quiet.mutations);

    // Invariant 11: a strip rebuild keeps the same meter tap, so the process-wide
    // registration must not be touched by any of it. Hundreds of rebuilds, no
    // re-subscription.
    expect(subsAfter.meterSubs).toBe(subsBefore.meterSubs);
    expect(subsAfter.meterUnsubs).toBe(subsBefore.meterUnsubs);
    // …and the rack's implicit scroll preservation holds: refreshStrip replaces one
    // child rather than the rack's children, so nothing re-lays the container out.
    expect(scrollAfter).toBe(scrollSet);
  });

  // --------------------------------------------------------------- T8 stress ----

  // stress-long-session-quiescence, reduced from the catalog's thirty minutes to
  // about a minute. What it measures is not what an operation produces but what
  // survives one, so the reduction costs coverage of slow accumulation and keeps the
  // per-cycle balance, which is where a leak would first appear.
  test("repeated live sessions leave no subscription, no traffic and no unbounded history behind", async ({ page }) => {
    test.setTimeout(300_000);
    await installFake(page);
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    expect(await hasProbe(page)).toBe(true);
    // Every cycle after the first starts on a dirty plan, so the session's own
    // discard confirm has to be answered or the loop measures aborted starts.
    await setDialogAnswer(page, "Ok");

    const LOOPS = 10; // ~5.5 s per cycle, so the sweep is about a minute of driving
    const samples: Array<{ counters: Awaited<ReturnType<typeof countersOf>>; undo: number }> = [];

    for (let i = 0; i < LOOPS; i++) {
      await mark(page, `loop-${i}-on`);
      await goLive(page);
      await page.click("#btn-view-console");
      await expect(faderReadout(page, "CH 1")).toBeVisible();
      await setLatency(page, { get: 4, set: 4 });

      // More gestures than the history can hold, each its own entry: a stepping key's
      // keyup is a boundary committed at once, so 130 alternating presses are 130
      // entries offered to a stack whose cap is 100. Dispatched in the page because
      // 130 driver round trips per cycle is most of the budget for the whole case.
      await page.evaluate((n) => {
        const f = [...document.querySelectorAll<HTMLElement>(".con-fader")][0];
        for (let k = 0; k < n; k++) {
          const key = k % 2 ? "ArrowDown" : "ArrowUp";
          f.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
          f.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
        }
      }, MAX_ENTRIES + 30);

      // The other two consumers of session-scoped state: the modal that borrows the
      // meter slot, and the view switch that rebuilds both surfaces.
      await strip(page, "CH 1").locator('[aria-label="Gate screen…"]').click();
      await expect(page.locator("#dyn-screen-box")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator("#dyn-screen-box")).toBeHidden();
      await page.click("#btn-view-graph");
      await page.click("#btn-view-console");
      await waitQuiet(page, 600);

      await mark(page, `loop-${i}-off`);
      await clickLive(page);
      await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "false");
      await waitQuiet(page, 600);
      await mark(page, `loop-${i}-quiet`);
      // A fixed window, not a silence check: the verdict here is an absence, and the
      // link has already gone quiet above, so what is being watched for is a timer
      // that was armed inside the session and fires after it.
      await page.waitForTimeout(1200);
      samples.push({ counters: await countersOf(page), undo: (await depthOf(page)).undo });
    }

    const trace = await traceOf(page);
    const all = spans(trace);
    const idle: number[] = [];
    for (let i = 0; i < LOOPS; i++) {
      const from = markTime(trace, `loop-${i}-quiet`)!;
      const to = i + 1 < LOOPS ? markTime(trace, `loop-${i + 1}-on`)! : Number.POSITIVE_INFINITY;
      idle.push(all.filter((s) => s.cmd.startsWith("vd_") && s.start > from && s.start < to).length);
    }

    // The last cycle's idle phase, stated as the analyzer states it: nothing armed
    // inside a session may outlive it. The per-cycle counts below say the same thing
    // for every earlier cycle, which analyze() (one window per call) cannot.
    const findings = analyze(trace, { quiesceAfter: `loop-${LOOPS - 1}-quiet` });
    console.log(timeline(trace, { from: markTime(trace, `loop-${LOOPS - 1}-off`)! - 200, limit: 40 }));
    console.log(report("long session quiescence", findings));
    expect(findings).toHaveLength(0);
    for (const [i, s] of samples.entries()) {
      console.log(
        `loop ${i}: connects=${s.counters.connects} params=${s.counters.subscribes}/${s.counters.unsubscribes} ` +
          `meters=${s.counters.meterSubs}/${s.counters.meterUnsubs} undo=${s.undo} idle-phase commands=${idle[i]}`,
      );
    }

    for (const [i, s] of samples.entries()) {
      // One connection per cycle, and both registrations released with it: a session
      // that left either behind would show as a growing imbalance rather than as a
      // failure inside the cycle that leaked it.
      expect(s.counters.connects).toBe(i + 1);
      expect(s.counters.subscribes).toBe(i + 1);
      expect(s.counters.unsubscribes).toBe(s.counters.subscribes);
      expect(s.counters.meterUnsubs).toBe(s.counters.meterSubs);
      // The history is bounded: 130 entries were offered, 100 is the cap, and the
      // stack does not carry the surplus across a cycle either.
      expect(s.undo).toBe(MAX_ENTRIES);
      // Nothing armed inside the session fires after it.
      expect(idle[i]).toBe(0);
    }
    // The meter slot is taken and released once per cycle plus once per screen
    // handover, and never accumulates: the count grows with the loop, the imbalance
    // does not.
    expect(samples[LOOPS - 1].counters.meterSubs).toBeGreaterThan(samples[0].counters.meterSubs);
  });
});
