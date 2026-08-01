import { test, expect } from "@playwright/test";
import {
  installFake,
  goLive,
  mark,
  traceOf,
  paramAddrsOf,
  snapshotOf,
  setLatency,
  waitQuiet,
  memOf,
} from "./fake-device";
import { analyze, report, timeline, markTime, spans, setsOf } from "./analyze";
import { CH1_FADER, faderOf, faderReadout } from "./ui";

// T0 baseline — the floor and the golden path. Every T1+ verdict is a difference
// against these two traces, so without them a firing invariant cannot be told from
// harness noise (docs/{en,ja}/live-race-harness.md).

test.describe("T0 baseline", () => {
  test.beforeEach(async ({ page }) => {
    await installFake(page);
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  // baseline-quiescent-floor. The only case whose expected output is empty.
  test("an idle live session writes nothing, reads nothing and fires no invariant", async ({ page }) => {
    await goLive(page);
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    await setLatency(page, { get: 25, set: 25 });

    await mark(page, "idle-start");
    await page.waitForTimeout(4000);
    await mark(page, "idle-end");

    const trace = await traceOf(page);
    const from = markTime(trace, "idle-start")!;
    const during = spans(trace).filter((s) => s.start > from && s.cmd.startsWith("vd_"));

    console.log(timeline(trace, { from: from - 100 }));
    console.log(
      `idle window: ${during.length} device command(s)` +
        `${during.length ? ` — ${[...new Set(during.map((s) => s.cmd))].join(", ")}` : ""}`,
    );

    // No notify means no settle and no idle net: the safety sweep is armed BY a
    // notify, so a quiet session must cost nothing at all. The WHOLE window, not the
    // two command kinds a case usually cares about: a session churning its own
    // registration (vd_params_subscribe / vd_meters_subscribe) or re-connecting on a
    // timer costs the device just as much and would have passed a read/write count
    // unseen, although `during` already collected it. The title says "reads nothing
    // and writes nothing" only because every kind is nothing.
    expect(during).toHaveLength(0);

    // The registration itself is the other half of the floor: a session that never
    // registered would also produce no traffic, and would pass the two counts above
    // while being blind to the device. (analyze() is deliberately not asserted here —
    // with no write and no notify in the window none of its invariants has an input,
    // so an empty result would say nothing about the app.)
    const registration = await paramAddrsOf(page);
    // The snapshot beside it gives invariant 6's clause B its floor: with nothing
    // edited, the emitted set is what was registered at begin() and the difference is
    // empty. Every grown-window verdict elsewhere is a difference against this.
    console.log(report("quiescent floor", analyze(trace, { registration, snapshot: await snapshotOf(page) })));
    expect(registration.length).toBeGreaterThan(100);
  });

  // baseline-single-edit-latency-ladder. One gesture, four latencies, nothing else
  // changed — the canonical timeline every phase offset in T1 is measured against.
  for (const lat of [0, 25, 100, 250]) {
    test(`one fader detent at ${lat} ms link latency: one write, no findings`, async ({ page }) => {
      await goLive(page);
      await page.click("#btn-view-console");
      await expect(faderReadout(page, "CH 1")).toBeVisible();
      await setLatency(page, { get: lat, set: lat });

      const before = (await faderReadout(page, "CH 1").textContent())!;
      await mark(page, "edit");
      await faderOf(page, "CH 1").focus();
      await page.keyboard.press("ArrowUp");
      const edited = (await faderReadout(page, "CH 1").textContent())!;
      expect(edited).not.toBe(before);

      await waitQuiet(page);
      const after = (await faderReadout(page, "CH 1").textContent())!;
      const trace = await traceOf(page);
      const editAt = markTime(trace, "edit")!;
      const findings = analyze(trace, {
        edits: [{ label: "CH 1 fader ArrowUp", addr: CH1_FADER, at: editAt }],
        registration: await paramAddrsOf(page),
        // A detent changes a VALUE, not the shape, so clause B stays silent: the pair
        // is read at one instant and the emitted set never left the begin() set.
        snapshot: await snapshotOf(page),
      });

      const writes = setsOf(trace).filter((s) => s.addr === CH1_FADER && s.start >= editAt);
      console.log(timeline(trace, { from: editAt - 100 }));
      console.log(report(`single edit @ ${lat} ms`, findings));
      console.log(`readout: before=${before} edited=${edited} after=${after}; writes=${writes.length}`);

      // The golden path: exactly one command carrying the detent, the plan keeping it,
      // and the device agreeing with the plan.
      expect(writes).toHaveLength(1);
      expect(after).toBe(edited);
      expect((await memOf(page))[CH1_FADER]).toBe(writes[0].value);
      expect(findings).toHaveLength(0);
      // The flush is a trailing throttle: the write lands about DEBOUNCE_MS after the
      // gesture, not immediately and not at the pointer's end.
      expect(writes[0].start - editAt).toBeGreaterThan(100);
      expect(writes[0].start - editAt).toBeLessThan(120 + lat + 400);
    });
  }
});
