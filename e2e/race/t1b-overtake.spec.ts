import { test, expect, type Page } from "@playwright/test";
import {
  installFake,
  goLive,
  mark,
  pushNotifyDelivered,
  traceOf,
  setLatency,
  blockAt,
  releaseBarrier,
  memOf,
  settleAfter,
  settleThroughIdleNet,
  snapshotOf,
  type TraceEvent,
} from "./fake-device";
import { analyze, report, timeline, markTime, spans, setsOf, getsOf, type Span } from "./analyze";
import { stepLevel } from "../../src/core/levels";
import { CH1_FADER, CH1_PAN, CH1_PAN_ADDR, CH2_FADER, readoutOf } from "./ui";

// T1b overtake — the T1 cases the first pass did not reach
// (docs/{en,ja}/live-race-harness.md, "T1 overtake"). Four of the nine are here:
//
//   overtake-converge-latch-starvation             the only liveness case in the catalog
//   overtake-notify-echo-vs-genuine-during-flush   the discrimination the app cannot make
//   overtake-direct-notify-ahead-of-the-send-loop  the frozen command list vs a moving snapshot
//   overtake-edit-during-flush-send-loop           the send loop's own re-entrancy
//
// Each is a DIFFERENTIAL: one variable moves between two otherwise identical runs, so a
// firing verdict names its cause rather than a symptom. The bare form of each was
// already reachable; what makes them decidable is the paired control run.
//
// The gestures are dispatched from inside the page rather than through the driver. Two
// of the three need several edits inside ONE 120 ms flush window, and one needs a 90 ms
// cadence held for five seconds — a Playwright keypress is a CDP round trip with tens
// of milliseconds of unbounded jitter, so those windows would be a matter of luck. A
// synthetic keydown on the fader runs exactly the listener a real key runs (console.ts
// wireFader reads e.key and nothing else), and a burst dispatched in one synchronous
// loop is guaranteed to land in one window.

// Addressed by the main fader's aria-label rather than by any text the strip prints
// (the shared `strip` in ./ui), so a name the SENDS rack repeats stays unambiguous.
const strip = (page: Page, label: string) =>
  page.locator(".con-strip", { has: page.locator(`.con-fader[aria-label="${label}"]`) });
const faderReadout = (page: Page, label: string) => readoutOf(strip(page, label));
const insFxChip = (page: Page, label: string) => strip(page, label).getByText("INS FX", { exact: true });

/** Pre-load the device's memory before the session's readback. Used to put the insert-FX
 *  selectors at the broker's "no effect" sentinel: the fake answers an unwritten address
 *  with 0, which decodes to an effect that IS selected, and the console's INS FX chip
 *  then only toggles the bypass (a plain param) instead of writing the selector (a
 *  converge param). Seeding the sentinel is what makes the chip a converge trigger. */
const seedMem = (page: Page, entries: Record<string, number>): Promise<void> =>
  page.evaluate((e) => {
    Object.assign(window.__urxFake.mem, e);
  }, entries);

const INSERT_FX_VD_NONE = 0xffffffff;

/** src/core/control/live.ts. The trailing flush window the starvation stream has to
 *  keep re-arming — so a tick slower than this measures the driver, not the latch. */
const DEBOUNCE_MS = 120;
/** Ticks in the starvation stream. 55 of Up/Up/Down/Down net one detent up, which is
 *  what makes the trailing flush's value computable rather than merely non-zero. */
const STREAM_TICKS = 55;

/** One ArrowUp on every main fader except the named strips, all in one synchronous
 *  loop so the whole set lands inside a single flush window. Returns the labels it hit:
 *  "the diff carried N addresses" is an input to every verdict below and is read from
 *  the run rather than assumed. */
const burstFaderEdits = (page: Page, exclude: string[]): Promise<string[]> =>
  page.evaluate((skip) => {
    const hit: string[] = [];
    for (const el of [...document.querySelectorAll(".con-strip .con-fader")] as HTMLElement[]) {
      const label = el.getAttribute("aria-label") ?? "";
      if (skip.includes(label)) continue;
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      hit.push(label);
    }
    return hit;
  }, exclude);

/** One arrow key on a named strip's main fader, re-querying the element each time: a
 *  follow reflect or a BAL mirror rebuilds the rack, and an edit dispatched at a
 *  detached node would silently do nothing. */
const faderKey = (page: Page, label: string, key: "ArrowUp" | "ArrowDown"): Promise<boolean> =>
  page.evaluate(
    ([l, k]) => {
      const el = document.querySelector(`.con-strip .con-fader[aria-label="${l}"]`) as HTMLElement | null;
      if (!el) return false;
      el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
      return true;
    },
    [label, key] as [string, string],
  );

/** The "→ device (N)" lines the status bar printed, in order — one per flush that sent
 *  anything (main.ts onSent). The only machine-readable flush counter available without
 *  a probe, and the one number that separates "collapsed into one flush" from "ran
 *  twice". */
function flushesOf(trace: TraceEvent[], from = 0): number[] {
  const out: number[] = [];
  for (const e of trace) {
    if (e.kind !== "status" || e.t < from) continue;
    const m = /→ device \((\d+)\)/.exec(e.detail ?? "");
    if (m) out.push(Number(m[1]));
  }
  return out;
}

/** The vd_set the fake is currently holding at a barrier: the one ipc-start with no
 *  ipc-end. spans() already reports an unfinished command as ending at +∞. */
const heldSet = (trace: TraceEvent[]): Span | undefined =>
  spans(trace).find((s) => s.cmd === "vd_set" && s.end === Number.POSITIVE_INFINITY);

test.describe("T1b overtake", () => {
  test.beforeEach(async ({ page }) => {
    await installFake(page);
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  // ---------------------------------------------------------------------------
  // overtake-converge-latch-starvation
  //
  // The only case in the catalog whose failure is the ABSENCE of device traffic.
  // LiveSync.schedule() normally lets an already-armed window absorb a new edit (a
  // trailing throttle), but when the last flush converged AND the diff still carries a
  // converge param it clears the timer and re-arms — turning the throttle into a
  // re-arming debounce. An edit stream faster than DEBOUNCE_MS then never lets the
  // window close, and a live mixer hears nothing for as long as the operator keeps
  // moving. Every other case in this catalog looks for wrong traffic and reads this as
  // a clean run.
  //
  // Exactly one variable moves: whether a converge param still differs when the stream
  // starts. Both runs converge CH 1's insert FX first (so lastFlushConverged is set in
  // both) and both stream at the same cadence on the same fader; the latched run leaves
  // the STEREO master's insert FX pending, the control lets it converge first. The two
  // selectors are deliberately on different device slots (channel amp vs output
  // dynamics), so neither run is really testing a 1-of-N resource conflict.
  // ---------------------------------------------------------------------------
  for (const latched of [true, false]) {
    test(`a 90 ms edit stream ${latched ? "with a converge param still pending sends nothing" : "with the converge settled keeps flushing"}`, async ({
      page,
    }) => {
      await seedMem(page, { "135:0:0": INSERT_FX_VD_NONE, "578:0:0": INSERT_FX_VD_NONE });
      await goLive(page);
      await page.click("#btn-view-console");
      await expect(faderReadout(page, "CH 1")).toBeVisible();
      await setLatency(page, { get: 2, set: 2 });

      // First converge. The INS FX chip on a strip with nothing selected picks the
      // first legal effect, i.e. writes INSERT_FX (135) — a converge param. Its flush
      // leaves lastFlushConverged set, which is the precondition BOTH runs share.
      await mark(page, "converge-1");
      await insFxChip(page, "CH 1").click();
      await settleAfter(page, "converge-1", 900, 15_000);

      // The second converge param. In the control run it is allowed to converge here,
      // so the diff no longer carries one; in the latched run the same click is
      // dispatched in the same task as the first stream edit, so the 120 ms window it
      // arms is already being re-armed before it can fire.
      if (!latched) {
        await mark(page, "converge-2");
        await insFxChip(page, "STEREO").click();
        await settleAfter(page, "converge-2", 900, 15_000);
      } else {
        await insFxChip(page, "STEREO").evaluate((el) => el.setAttribute("data-race-chip", "1"));
      }

      const before = (await faderReadout(page, "CH 1").textContent())!;
      // Where the train starts from, read off the device rather than assumed, and where
      // it must end: the app steps the LEVEL_STEPS_DB grid one detent per key
      // (console.ts faderKeyStep → core/levels stepLevel), so the landing value follows
      // from the train alone. 55 ticks of Up/Up/Down/Down net one detent up.
      const startRaw = (await memOf(page))[CH1_FADER] ?? 0;
      const dirs = Array.from({ length: STREAM_TICKS }, (_, i) => (i % 4 < 2 ? 1 : -1));
      const settledRaw = Math.round(dirs.reduce((db, d) => stepLevel(db, d), startRaw / 100) * 100);
      await mark(page, "starve-start");
      // 55 edits at 90 ms = 4.95 s, below DEBOUNCE_MS throughout. The Up/Up/Down/Down
      // cycle keeps the value off its baseline for three ticks in four (so a flush that
      // did run would almost always find a diff) without walking off the top of the
      // level grid, and 55 ticks leave it one detent above where it started.
      //
      // The closing mark is stamped IN-PAGE, in the same task as the last tick. Stamped
      // from the driver it costs a round trip, which races the 120 ms trailing-flush
      // timer the last tick armed: a flush landing in that gap would be counted as
      // "during" and read as the latch releasing on its own. The achieved gaps come back
      // with it, because a tick that slipped past 120 ms lets the window close for a
      // reason that is the driver's, not the app's.
      const gaps = await page.evaluate(
        async ([armSecond, period, count]) => {
          if (armSecond) (document.querySelector("[data-race-chip]") as HTMLElement | null)?.click();
          const keys = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown"];
          const at: number[] = [];
          await new Promise<void>((resolve) => {
            let i = 0;
            const id = setInterval(() => {
              const el = document.querySelector('.con-strip .con-fader[aria-label="CH 1"]') as HTMLElement | null;
              at.push(performance.now());
              el?.dispatchEvent(new KeyboardEvent("keydown", { key: keys[i % 4], bubbles: true }));
              if (++i >= (count as number)) {
                clearInterval(id);
                window.__urxFake.mark("starve-end");
                resolve();
              }
            }, period as number);
          });
          return at.slice(1).map((t, i) => +(t - at[i]).toFixed(1));
        },
        [latched, 90, STREAM_TICKS] as [boolean, number, number],
      );
      const maxGap = Math.max(...gaps);
      const streamed = (await faderReadout(page, "CH 1").textContent())!;
      await settleAfter(page, "starve-end", 900, 15_000);

      const trace = await traceOf(page);
      const from = markTime(trace, "starve-start")!;
      const to = markTime(trace, "starve-end")!;
      const during = setsOf(trace).filter((s) => s.start >= from && s.start <= to);
      const after = setsOf(trace).filter((s) => s.start > to);
      const faderAfter = after.filter((s) => s.addr === CH1_FADER);
      const findings = analyze(trace, { edits: [{ label: "CH 1 fader stream", addr: CH1_FADER, at: from }] });

      console.log(timeline(trace, { from: from - 200 }));
      console.log(report(`converge latch — ${latched ? "latched" : "control"}`, findings));
      console.log(
        `stream ${(to - from).toFixed(0)} ms, max tick gap ${maxGap.toFixed(0)} ms (re-arm window 120):` +
          ` vd_set during = ${during.length}, after = ${after.length}` +
          ` (CH 1 fader ${faderAfter.length}); readout before=${before} streamed=${streamed}` +
          `; device now holds ${CH1_FADER} = ${(await memOf(page))[CH1_FADER]}, train settles at ${settledRaw}`,
      );

      if (latched) {
        // The cadence really was faster than the window it has to keep re-arming.
        // Asserted BEFORE the absence: a slipped tick lets the trailing window close for
        // a reason that belongs to the driver, and the write it produces would otherwise
        // read as "the latch does not starve after all". This way a slipped run fails
        // naming the slip.
        expect(maxGap).toBeLessThan(DEBOUNCE_MS);
        // PINNED DEFECT. Five seconds of continuous operator movement on a live mixer
        // and not one command left the app: the re-arm in schedule() never lets the
        // window close while a converge param is still in the diff. Nothing is lost —
        // the trailing flush after the stream carries the final value — but for the
        // whole gesture the unit is playing the old one.
        expect(during).toHaveLength(0);
        // …and it really is starvation rather than a session that died: the moment the
        // cadence stops, the same edits go out.
        expect(faderAfter.length).toBeGreaterThan(0);
        // …and it carries the value the operator ended on, not an intermediate one:
        // the trailing flush sends the settled plan. The train's landing value is
        // computed off the same grid the app steps on, so "an intermediate value" and
        // "the settled value" are separable here — `> 0` was satisfied by both.
        // (Asserting the fake's memory against the last write it accepted would only
        // restate the harness.)
        expect(faderAfter[faderAfter.length - 1].value).toBe(settledRaw);
        expect(await faderReadout(page, "CH 1").textContent()).toBe(streamed);
      } else {
        // The control. Same cadence, same fader, same lastFlushConverged — but with no
        // converge param left in the diff the throttle behaves as designed and the
        // stream reaches the device throughout. A 5 s stream against a 120 ms trailing
        // window can flush ~40 times; the Up/Up/Down/Down cycle makes some of those
        // windows a no-op, so the floor is set well under that and still separates the
        // two runs by an order of magnitude.
        expect(during.length).toBeGreaterThan(8);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // overtake-notify-echo-vs-genuine-during-flush
  //
  // isEcho is a value comparison against the live snapshot, and the flush writes the
  // snapshot entry AFTER its vd_set resolves. So the discriminating variable is not
  // whether the message is genuine — it is whether it arrived before or after our own
  // ack. Three runs hold the address fixed and move only that:
  //
  //   early-echo   the exact value being written, delivered while its vd_set is held
  //   genuine      a different value for the same address, at the same instant
  //   late-echo    the exact value written, 340 ms after its ack, still inside the loop
  //
  // early-echo and late-echo push a byte-identical message. A device whose operator
  // genuinely moved a fader back to the value we just wrote produces exactly the
  // late-echo message, so what that run pins is also the app's blind spot: such a change
  // is indistinguishable from an echo and is dropped.
  // ---------------------------------------------------------------------------
  for (const variant of ["early-echo", "genuine", "late-echo"] as const) {
    test(`a notify during the send loop: ${variant}`, async ({ page }) => {
      await goLive(page);
      await page.click("#btn-view-console");
      await expect(faderReadout(page, "CH 1")).toBeVisible();
      await setLatency(page, { get: 25, set: 60 });

      const held = variant !== "late-echo";
      // Hold the loop at its first command. CH 1 is the first node the translate walks,
      // so its fader is the first address of this diff — asserted rather than assumed,
      // since the whole case is about that one address.
      if (held) await blockAt(page, "vd_set", 1);
      await mark(page, "burst");
      const hit = await burstFaderEdits(page, []);
      expect(hit.length).toBeGreaterThan(6); // the loop must outlast a 340 ms offset

      let written: number;
      if (held) {
        await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 15_000 });
        const s = heldSet(await traceOf(page));
        expect(s?.addr).toBe(CH1_FADER);
        written = s!.value!;
      } else {
        // Wait for CH 1's own vd_set to be acked, then let 340 ms of the loop pass:
        // past ECHO_MS / RECENT_MS, and past the instant the snapshot caught up.
        await page.waitForFunction(
          (a) => {
            const log = window.__urxFake.log;
            const start = log.find((e) => e.kind === "ipc-start" && e.cmd === "vd_set" && e.addr === a);
            return start !== undefined && log.some((e) => e.kind === "ipc-end" && e.of === start.seq);
          },
          CH1_FADER,
          { timeout: 15_000 },
        );
        written = setsOf(await traceOf(page)).find((x) => x.addr === CH1_FADER)!.value!;
        await page.waitForTimeout(340);
      }

      // 120 raw = 1.2 dB, a real detent on the level grid two steps above where the
      // gesture left it — a value a device-side operator could land on, and never the
      // one the app just wrote.
      const value = variant === "genuine" ? (written === 120 ? 200 : 120) : written;

      const editedReadout = (await faderReadout(page, "CH 1").textContent())!;
      // A genuine device-side move changes the device too, or the later reconcile would
      // read back our own value and "revert" the move for a reason the fake invented.
      // An echo needs no such write: the device already holds exactly what we sent.
      if (variant === "genuine") await seedMem(page, { [CH1_FADER]: value });
      await mark(page, "notify");
      // Delivered, not merely pushed. The whole case is the app's RESPONSE to this one
      // message, and a notify the bridge refuses leaves the app in exactly the state
      // "nothing has happened yet" leaves it in — under which the late-echo arm's
      // absence verdict passes for free and the other two would fail for a reason that
      // is not the app's. This throws at the push, naming the address.
      await pushNotifyDelivered(page, [[139, 0, 0, value]]);
      if (held) {
        await mark(page, "release");
        await releaseBarrier(page);
      }
      await settleThroughIdleNet(page, "notify");

      const trace = await traceOf(page);
      const notifyAt = markTime(trace, "notify")!;
      const readsAfter = getsOf(trace).filter((g) => g.start > notifyAt);
      const snapshot = await snapshotOf(page);
      const finalReadout = (await faderReadout(page, "CH 1").textContent())!;
      const findings = analyze(trace, {
        edits: [{ label: `CH 1 fader (${variant})`, addr: CH1_FADER, at: markTime(trace, "burst")! }],
        snapshot,
      });

      console.log(timeline(trace, { from: markTime(trace, "burst")! - 100 }));
      console.log(report(`notify during flush — ${variant}`, findings));
      console.log(
        `diff carried ${hit.length} faders; wrote ${CH1_FADER} = ${written}, notified ${value};` +
          ` device reads after the notify = ${readsAfter.length};` +
          ` readout edited=${editedReadout} final=${finalReadout};` +
          ` snapshot holds ${snapshot?.[CH1_FADER]}, device holds ${(await memOf(page))[CH1_FADER]}`,
      );

      // In all three arms: nothing the analyzer classifies as "the case may have
      // measured nothing" fired. Clause A is the one that would — a stimulus the bridge
      // refused — and it is judged with no registration in hand, so this holds whichever
      // arm is running.
      expect(findings.filter((f) => f.class === "case")).toHaveLength(0);

      if (variant === "early-echo") {
        // PINNED DEFECT. The message is our own write coming back, but it overtook our
        // ack, so the snapshot still held the pre-edit value and isEcho said "no". The
        // app applied its own value as a device-side change and then paid for it: the
        // idle net escalated to a WHOLE-DEVICE readback. The price of a broker that
        // echoes faster than it acks is several hundred reads per echoed write.
        expect(readsAfter.length).toBeGreaterThan(100);
        // The value itself is unharmed — it is the same value either way — so nothing
        // but the read volume distinguishes this from a correct classification.
        // (The device holding `written` is the fake restating itself; the screen
        // keeping the operator's value is the property under test.)
        expect(finalReadout).toBe(editedReadout);
      } else if (variant === "genuine") {
        // The device really moved, on the same address and at the same instant as the
        // echo above. Here the classification is right: the direct apply takes the new
        // value into the plan, the screen follows, and the idle net re-reads afterwards
        // and confirms it. The app pays the same several-hundred-read escalation it paid
        // for its own echo — which is the point of holding delta-t and address fixed.
        expect(finalReadout).not.toBe(editedReadout);
        expect(readsAfter.length).toBeGreaterThan(100);
      } else {
        // The same bytes as early-echo, 340 ms later: the snapshot has caught up, isEcho
        // matches, and the message is dropped — no apply, no settle, no idle net, not
        // one read. Correct for an echo, and simultaneously the blind spot: a device-side
        // move BACK to the value we just wrote is this exact message.
        expect(readsAfter).toHaveLength(0);
        expect(finalReadout).toBe(editedReadout);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // overtake-direct-notify-ahead-of-the-send-loop
  //
  // The sibling of the case above, and the one it could not see. There the notify named
  // the address the loop was suspended ON, so by the time it arrived that command had
  // already been decided. Here it names an address the loop HAS NOT REACHED YET: CH 1's
  // pan, emitted one command behind its fader by the same translate.
  //
  // The flush's command array is frozen at flush start — planToCommands runs once, before
  // the first await — while the snapshot each command is diffed against is mutated under
  // it by the follow layer: a direct notify writes the device's new value into the plan
  // (applyDirect) and into the snapshot (noteDirect), both synchronously, inside one of
  // the loop's awaits. The loop then reaches a command still carrying the PRE-notify
  // value, finds the snapshot disagreeing with it, and sends it. Nothing in the app
  // authored that value and the device authored the newer one, so the write is the app
  // pushing a stale device-originated value back over the hand still on the knob.
  //
  // The differential is the notify's phase against one flush and nothing else: `ahead`
  // delivers it while the loop is held at its first command, `after` once it has drained.
  // Same address, same value, same gesture.
  // ---------------------------------------------------------------------------
  for (const phase of ["ahead", "after"] as const) {
    test(`a direct notify ${phase === "ahead" ? "the send loop has not reached yet" : "after the send loop drained"} is not written back`, async ({
      page,
    }) => {
      await goLive(page);
      await page.click("#btn-view-console");
      await expect(faderReadout(page, "CH 1")).toBeVisible();
      await setLatency(page, { get: 25, set: 60 });

      // Where the device's pan stands before anything happens, read off the fake rather
      // than assumed: it is the value a write-back would carry, so the run has to be able
      // to name it. 24 is a detent a device-side operator could land on and never one the
      // app produces here — no gesture in this case touches pan.
      const startPan = (await memOf(page))[CH1_PAN_ADDR] ?? 0;
      const movedPan = 24;
      expect(movedPan).not.toBe(startPan);

      if (phase === "ahead") await blockAt(page, "vd_set", 1);
      await mark(page, "edit");
      expect(await faderKey(page, "CH 1", "ArrowUp")).toBe(true);

      if (phase === "ahead") {
        await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 15_000 });
        // The loop is suspended on CH 1's fader — one command ahead of the pan the notify
        // is about to move. Asserted, not assumed: if the diff ever carried a different
        // first address the case would be measuring a loop that had already passed pan.
        expect(heldSet(await traceOf(page))?.addr).toBe(CH1_FADER);
      } else {
        // The control: the same flush, allowed to finish first. `settleAfter` rather than
        // waitQuiet — the edit's own flush is still inside its debounce window here, and
        // silence that has not started yet would answer for it.
        await settleAfter(page, "edit", 900, 15_000);
      }

      // A device-side move is a change to the device's own state as well as a message: a
      // later read that answered the old value would "revert" the move for a reason the
      // fake invented rather than the app.
      await seedMem(page, { [CH1_PAN_ADDR]: movedPan });
      await mark(page, "notify");
      await pushNotifyDelivered(page, [[...CH1_PAN, movedPan]]);

      if (phase === "ahead") {
        await mark(page, "release");
        await releaseBarrier(page);
      }
      // The window under test is closed once the loop drains; the idle safety net's
      // whole-device sweep that follows is ~800 reads, so it runs at a latency CI can
      // afford (the tail-latency drop every long case in this harness takes).
      await setLatency(page, { get: 0, set: 0 });
      await settleThroughIdleNet(page, "notify");

      const trace = await traceOf(page);
      const panSets = setsOf(trace).filter((s) => s.addr === CH1_PAN_ADDR);
      const mem = await memOf(page);
      const snapshot = await snapshotOf(page);
      const findings = analyze(trace, {
        edits: [{ label: "CH 1 fader", addr: CH1_FADER, at: markTime(trace, "edit")! }],
        snapshot,
      });

      console.log(timeline(trace, { from: markTime(trace, "edit")! - 100 }));
      console.log(report(`direct notify ${phase} the send loop`, findings));
      console.log(
        `pan moved ${startPan} → ${movedPan} on the device; writes to ${CH1_PAN_ADDR} = ` +
          `[${panSets.map((s) => `${s.value}@${s.start.toFixed(0)}ms`).join(", ")}]; ` +
          `device holds ${mem[CH1_PAN_ADDR]}, snapshot holds ${snapshot?.[CH1_PAN_ADDR]}`,
      );

      // Neither arm may lose the fader edit, or the flush under test never ran.
      expect(findings.filter((f) => f.class === "case")).toHaveLength(0);
      expect(findings.filter((f) => f.inv === 2)).toHaveLength(0);
      expect(mem[CH1_FADER]).toBeDefined();

      // The case's own verdict, identical in both arms because the phase of a notify
      // against our own send loop is not something the operator can be asked to control:
      // pan has exactly one author in this run — the device — so any write to it is the
      // app pushing back a value it did not author, and the device must be left holding
      // the value it last reported.
      expect(panSets).toHaveLength(0);
      expect(mem[CH1_PAN_ADDR]).toBe(movedPan);
      expect(snapshot?.[CH1_PAN_ADDR]).toBe(movedPan);
    });
  }

  // ---------------------------------------------------------------------------
  // overtake-edit-during-flush-send-loop
  //
  // The flush's own re-entrancy, with no reconcile, converge or refetch anywhere near
  // it. `pending` is a single boolean and the command array is frozen at flush start,
  // so edits made while the loop runs cannot join the current pass and cannot queue
  // separately either: however many arrive, one trailing flush carries them all.
  //
  // The variable is whether a flush is in flight. Both runs make the same two edits
  // 400 ms apart — more than three DEBOUNCE_MS windows, and clear of the previous
  // flush's own round trip, so on an idle link they are two flushes by construction.
  // Held inside a send loop they become one.
  // ---------------------------------------------------------------------------
  for (const busy of [true, false]) {
    test(`two edits 400 ms apart, ${busy ? "inside a held send loop, collapse into one flush" : "on an idle link, flush separately"}`, async ({
      page,
    }) => {
      await goLive(page);
      await page.click("#btn-view-console");
      await expect(faderReadout(page, "CH 1")).toBeVisible();
      await setLatency(page, { get: 25, set: 60 });

      let burst = 0;
      if (busy) {
        // A multi-address diff on strips the two edits below do not touch, held at its
        // second command so the loop is genuinely mid-flight rather than merely armed.
        await blockAt(page, "vd_set", 2);
        burst = (await burstFaderEdits(page, ["CH 1", "CH 2"])).length;
        expect(burst).toBeGreaterThan(3);
        await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 15_000 });
      }

      await mark(page, "edit-a");
      expect(await faderKey(page, "CH 1", "ArrowUp")).toBe(true);
      await page.waitForTimeout(400);
      await mark(page, "edit-b");
      expect(await faderKey(page, "CH 2", "ArrowUp")).toBe(true);

      if (busy) {
        await mark(page, "release");
        await releaseBarrier(page);
      }
      await settleAfter(page, "edit-b", 900, 15_000);

      const trace = await traceOf(page);
      const aAt = markTime(trace, "edit-a")!;
      const bAt = markTime(trace, "edit-b")!;
      const flushes = flushesOf(trace, aAt);
      const findings = analyze(trace, {
        edits: [
          { label: "CH 1 fader", addr: CH1_FADER, at: aAt },
          { label: "CH 2 fader", addr: CH2_FADER, at: bAt },
        ],
      });

      console.log(timeline(trace, { from: aAt - 300 }));
      console.log(report(`edit during send loop — ${busy ? "busy" : "idle"}`, findings));
      console.log(
        `burst carried ${burst} faders; flushes reported after the first edit: [${flushes.join(", ")}];` +
          ` device holds ${CH1_FADER}=${(await memOf(page))[CH1_FADER]} ${CH2_FADER}=${(await memOf(page))[CH2_FADER]}`,
      );

      // Neither run may lose an edit: this case isolates the send loop from every
      // device-side effect, so a lost write here would be the loop's own doing.
      expect(findings.filter((f) => f.inv === 2)).toHaveLength(0);
      expect((await memOf(page))[CH1_FADER]).toBeDefined();
      expect((await memOf(page))[CH2_FADER]).toBeDefined();

      if (busy) {
        // PINNED BEHAVIOUR. The held burst reports first (its onSent runs when the loop
        // finally drains), and then ONE more flush carries both edits — four windows'
        // worth of gesture on a single `pending` slot. Benign for two faders; the same
        // slot is what makes a whole drag arrive as its last value only.
        expect(flushes).toHaveLength(2);
        // The burst flush carries at least the faders it touched (a BAL-linked strip
        // mirrors its partner, so the count runs slightly over the gesture count).
        expect(flushes[0]).toBeGreaterThanOrEqual(burst);
        expect(flushes[1]).toBe(2);
      } else {
        // The control: on an idle link the identical gesture is two flushes of one.
        expect(flushes).toEqual([1, 1]);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Not reached in this file, and why (report items, not silent gaps):
  //
  //   overtake-full-reconcile-vs-edit-ladder     needs File > New and Ctrl+Z fired
  //     inside a ~6 s full sweep with their refusal recorded; the refusal signal is a
  //     status string plus a history depth, i.e. T3/T6 machinery rather than this file's.
  //   overtake-converge-and-refetch-one-flush    needs a converge param and a refetch
  //     param dirty in the SAME 120 ms window; the console reaches INSERT_FX but the EQ
  //     1-knob only through the tuning screen, so arming both needs a driver that can
  //     edit two surfaces inside one window.
  //   overtake-reconcile-during-reconcile        its verdict is about follow.ts's private
  //     replay queue (one `pending`, `pendingFull`, accumulated scopedNodes); read counts
  //     alone cannot separate "one replay was queued" from "the notifies coalesced", so
  //     it needs a probe the trace build does not expose today.
  //   overtake-direct-scoped-coalesce-boundary   the branch flip lives inside the 50 ms
  //     REFLECT_MIN_MS coalesce and is observable only as a repaint, which nothing in
  //     this harness can time.
  //   overtake-drag-flush-backpressure           measures end-of-gesture convergence
  //     latency under a synthetic pointer drag with the meter feed loaded; that is T7's
  //     contention, not this file's.
  // ---------------------------------------------------------------------------
});
