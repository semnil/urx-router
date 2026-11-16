import { test, expect } from "@playwright/test";
import {
  installFake,
  goLive,
  mark,
  setLatency,
  waitQuiet,
  countersOf,
  setDialogAnswer,
  depthOf,
  hasProbe,
  traceOf,
} from "./fake-device";
import { analyze, report, timeline, markTime, spans, type Span } from "./analyze";
import { MAX_ENTRIES } from "../../src/core/plan-history";
import { faderReadout, strip } from "./ui";

// Keep the repeated-session lifecycle in one case, early in collection order.
test.describe("Tzb tail", () => {
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
      await strip(page, "CH 1").locator('[aria-label="Gate screen"]').click();
      await expect(page.locator("#dyn-screen-box")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator("#dyn-screen-box")).toBeHidden();
      await page.click("#btn-view-graph");
      await page.click("#btn-view-console");
      await waitQuiet(page, 600);

      await mark(page, `loop-${i}-off`);
      await page.evaluate(() => (document.getElementById("btn-live") as HTMLButtonElement).click());
      await expect(page.locator("#btn-live")).toHaveAttribute("aria-checked", "false");
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
    // Each cycle's meter commands, in the order issued.
    const meterRuns: Span[][] = [];
    for (let i = 0; i < LOOPS; i++) {
      const from = markTime(trace, `loop-${i}-quiet`)!;
      const to = i + 1 < LOOPS ? markTime(trace, `loop-${i + 1}-on`)! : Number.POSITIVE_INFINITY;
      idle.push(all.filter((s) => s.cmd.startsWith("vd_") && s.start > from && s.start < to).length);
      const on = markTime(trace, `loop-${i}-on`)!;
      meterRuns.push(all.filter((s) => s.cmd.startsWith("vd_meters_") && s.start > on && s.start < from));
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
      // One connection per cycle, and both registrations released with it. The param one is
      // taken once and released once, so a session that left it behind would show as a
      // growing imbalance rather than as a failure inside the cycle that leaked it.
      expect(s.counters.connects).toBe(i + 1);
      expect(s.counters.subscribes).toBe(i + 1);
      expect(s.counters.unsubscribes).toBe(s.counters.subscribes);
      // The meter slot is handed between the console and the tuning screen inside the
      // session, and a screen closed before its own registration has been answered is
      // replaced by the console's with no unsubscribe of its own — a subscribe replaces the
      // registration wholesale — so the meter half is read from the order rather than from
      // the counts: the session never sits unregistered (every unsubscribe inside it is
      // followed by a subscribe), and the cycle's last meter command is the unsubscribe its
      // end issued.
      const offAt = markTime(trace, `loop-${i}-off`)!;
      const inSession = meterRuns[i].filter((m) => m.start < offAt);
      expect(inSession[0]?.cmd).toBe("vd_meters_subscribe");
      for (const [k, m] of inSession.entries())
        if (m.cmd === "vd_meters_unsubscribe") expect(inSession[k + 1]?.cmd).toBe("vd_meters_subscribe");
      expect(meterRuns[i].at(-1)?.cmd).toBe("vd_meters_unsubscribe");
      expect(meterRuns[i].at(-1)!.start).toBeGreaterThan(offAt);
      // The history is bounded: 130 entries were offered, 100 is the cap, and the
      // stack does not carry the surplus across a cycle either.
      expect(s.undo).toBe(MAX_ENTRIES);
      // Nothing armed inside the session fires after it.
      expect(idle[i]).toBe(0);
    }
    // The meter slot is taken in every cycle, so the count grows with the loop.
    expect(samples[LOOPS - 1].counters.meterSubs).toBeGreaterThan(samples[0].counters.meterSubs);
  });
});
