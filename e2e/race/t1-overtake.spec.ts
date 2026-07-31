import { test, expect, type Page } from "@playwright/test";
import {
  installFake,
  goLive,
  mark,
  pushNotify,
  traceOf,
  paramAddrsOf,
  snapshotOf,
  setLatency,
  blockAt,
  releaseBarrier,
  memOf,
  waitQuiet,
} from "./fake-device";
import { analyze, report, timeline, markTime } from "./analyze";
import { CH1_FADER, CH1_HPF_FREQ, faderOf, faderReadout, graphNode, openEqScreen } from "./ui";

// T1 overtake — the core stale-read / lost-edit ladders of the race harness
// (docs/{en,ja}/live-race-harness.md). Each test drives one operator gesture into a
// precisely placed device window and reads the fake's IPC trace back.
//
// The windows are placed with the fake's BARRIER rather than with wall-clock offsets:
// a Playwright driver's every call is a CDP round trip with unbounded jitter, and
// three of the windows these cases straddle are under 50 ms wide. Blocking a named
// command and dispatching the gesture while it is held makes "the edit landed at read
// N" exact instead of statistical.

// HPF frequency (26) at the same input index: a scoped (non-direct) param on ch1, so a
// notify on it routes to a readback of the whole node rather than a direct apply.

/** The EQ tuning screen's 1-Knob ON button, located from the level slider's id (the
 *  only stable anchor in that section) rather than by its localized label. */
const oneKnobOn = (page: Page) =>
  page
    .locator("#dyn-screen-box .prefs-section", { has: page.locator("#dyn-oneknob-level") })
    .locator(".prefs-toggle button")
    .first();
test.describe("T1 overtake", () => {
  test.beforeEach(async ({ page }) => {
    await installFake(page);
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  // overtake-scoped-readback-vs-edit-ladder, barrier form.
  test("a scoped readback that began before an edit no longer overwrites it", async ({ page }) => {
    await goLive(page);
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    await setLatency(page, { get: 25, set: 25 });

    const before = (await faderReadout(page, "CH 1").textContent())!;

    // applyNodeState reads a channel's fader first, so holding the scoped pass at its
    // very first command samples CH_FADER before the gesture below exists.
    await blockAt(page, "vd_get", 1);
    await mark(page, "notify");
    await pushNotify(page, [[...CH1_HPF_FREQ, 40]]);
    await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 10_000 });

    await mark(page, "edit");
    await faderOf(page, "CH 1").focus();
    await page.keyboard.press("ArrowUp");
    const edited = (await faderReadout(page, "CH 1").textContent())!;
    expect(edited).not.toBe(before);

    // Give the 120 ms flush its window, so the edit genuinely reached the device
    // before the held readback is allowed to answer with the value it sampled earlier.
    await page.waitForTimeout(500);
    await mark(page, "release");
    await releaseBarrier(page);
    // Sample the screen the moment the scoped reconcile reports itself done — the app's
    // own signal, not a sleep. This is the value the operator is left looking at, and it
    // is not where the session eventually settles: the queued whole-device sweep that
    // follows takes seconds more before anything corrects it.
    await page.waitForSelector('#statusbar:text-matches("← device \\\\(\\\\d+\\\\)")', { timeout: 20_000 });
    await mark(page, "scoped-reconcile-done");
    const justAfter = (await faderReadout(page, "CH 1").textContent())!;
    await waitQuiet(page);

    const after = (await faderReadout(page, "CH 1").textContent())!;
    const trace = await traceOf(page);
    const registration = await paramAddrsOf(page);
    const editAt = markTime(trace, "edit")!;
    const findings = analyze(trace, {
      edits: [{ label: "CH 1 fader ArrowUp", addr: CH1_FADER, at: editAt }],
      registration,
      // Read beside the registration: the scoped reconcile re-captured and then
      // re-subscribed, so both halves moved together and clause B has nothing to say.
      snapshot: await snapshotOf(page),
    });

    console.log(timeline(trace, { from: markTime(trace, "notify")! - 50 }));
    console.log(report("scoped readback vs edit", findings));
    console.log(`readout: before=${before} edited=${edited} justAfter=${justAfter} after=${after}`);
    console.log(`device now holds ${CH1_FADER} = ${(await memOf(page))[CH1_FADER]}`);

    // Invariants 1 and 4 are GEOMETRY and still hold: a read of the edited address did
    // straddle the gesture, and a write did leave inside an in-flight read. Neither is
    // evidence of damage on its own — what they used to accompany was the plan reverting
    // to the value the read had sampled before the gesture existed.
    expect(findings.some((f) => f.inv === 1)).toBe(true);
    expect(findings.some((f) => f.inv === 4)).toBe(true);
    expect((await memOf(page))[CH1_FADER]).toBe(40); // the edit reached the device…
    // …and the readback no longer takes it back. The read runs against its own copy of
    // the plan (readback.readIntoPlan) and merges device truth first, the edits made
    // during it over the top, so the contested key resolves to the operator's value at
    // the moment the reconcile reports itself done — not seconds later by accident.
    expect(justAfter).toBe(edited);
    expect(after).toBe(edited);
  });

  // overtake-edit-during-refetch-await — the EQ 1-knob path this whole investigation
  // started from. The flush's own repair reads the node back; its epilogue used to
  // snapshot the LIVE plan, so an edit made during the await was recorded as device
  // truth and never diffed again — the worst outcome in the catalog. The read now runs
  // against its own copy and the re-base measures from that copy, so the edit stays a
  // diff and the trailing flush carries it.
  test("an edit made during a 1-knob refetch survives it and reaches the device", async ({ page }) => {
    await goLive(page);
    await openEqScreen(page, "ch1");
    await setLatency(page, { get: 25, set: 25 });

    // Hold the refetch's node read. Nothing else reads while idle, so the first
    // vd_get after this call belongs to the refetch the 1-knob write triggers.
    await blockAt(page, "vd_get", 1);
    await mark(page, "oneknob-on");
    await oneKnobOn(page).click();
    await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 10_000 });

    // Close the screen while the refetch is still awaiting — the read is already in
    // flight and is not cancelled by the close, which is what lets the operator reach
    // another control at all (the screen is modal).
    await page.keyboard.press("Escape");
    await expect(page.locator("#dyn-screen-box")).toBeHidden();

    // The operator moves an unrelated control on the same node while the refetch is
    // still awaiting.
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    const before = (await faderReadout(page, "CH 1").textContent())!;
    await mark(page, "edit");
    await faderOf(page, "CH 1").focus();
    await page.keyboard.press("ArrowUp");
    const edited = (await faderReadout(page, "CH 1").textContent())!;

    await mark(page, "release");
    await releaseBarrier(page);
    await waitQuiet(page);

    const after = (await faderReadout(page, "CH 1").textContent())!;
    const trace = await traceOf(page);
    const editAt = markTime(trace, "edit")!;
    const findings = analyze(trace, {
      edits: [{ label: "CH 1 fader during refetch", addr: CH1_FADER, at: editAt }],
      registration: await paramAddrsOf(page),
      // 1-Knob ON SHRINKS the emitted set (the 18 PEQ band addresses leave it), so the
      // registration is a superset here and clause B — which reports growth only —
      // stays silent. The shrink direction is clause C's and invariant 12's.
      snapshot: await snapshotOf(page),
    });

    console.log(timeline(trace, { from: markTime(trace, "oneknob-on")! - 50 }));
    console.log(report("edit during refetch await", findings));
    console.log(`readout: before=${before} edited=${edited} after=${after}`);
    console.log(`device now holds ${CH1_FADER} = ${(await memOf(page))[CH1_FADER]}`);

    // The gesture is still overtaken in the geometric sense — the read that straddles it
    // is what made this case worth writing — but nothing is lost any more: a write
    // carrying it does leave (no invariant 2), the unit holds it, and the screen keeps it.
    expect(findings.some((f) => f.inv === 2)).toBe(false);
    expect((await memOf(page))[CH1_FADER]).toBe(40);
    expect(after).toBe(edited);
  });

  // overtake-edit-during-converge-await — the deliberate counter-example. The converge
  // path re-bases from a structuredClone taken BEFORE its await, so the same gesture at
  // the same offset must survive here. Running both with one driver is what proves the
  // refetch path's loss is a missing clone rather than a consequence of a long await.
  test("an edit made during a converge await survives (the frozen-clone counter-example)", async ({ page }) => {
    await goLive(page);
    await graphNode(page, "ch1").click();
    await setLatency(page, { get: 5, set: 5 });

    // INSERT_FX (135) is a converge param: its write makes the device rebind the
    // engine, and the app answers with a converge round over the whole write scope —
    // a read sweep long enough to hold an edit inside, which is the point.
    const insertSel = page.locator("#inspector .param", { hasText: "Insert FX" }).locator("select");
    await expect(insertSel).toHaveCount(1);
    await mark(page, "converge-trigger");
    await blockAt(page, "vd_get", 20);
    await insertSel.selectOption({ label: "Compander-H" });
    await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 15_000 });

    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    const before = (await faderReadout(page, "CH 1").textContent())!;
    await mark(page, "edit");
    await faderOf(page, "CH 1").focus();
    await page.keyboard.press("ArrowUp");
    const edited = (await faderReadout(page, "CH 1").textContent())!;

    await mark(page, "release");
    await releaseBarrier(page);
    await waitQuiet(page);

    const after = (await faderReadout(page, "CH 1").textContent())!;
    const trace = await traceOf(page);
    const editAt = markTime(trace, "edit")!;
    const findings = analyze(trace, {
      edits: [{ label: "CH 1 fader during converge", addr: CH1_FADER, at: editAt }],
    });

    console.log(timeline(trace, { from: markTime(trace, "converge-trigger")! - 50 }));
    console.log(report("edit during converge await", findings));
    console.log(`readout: before=${before} edited=${edited} after=${after}`);
    console.log(`device now holds ${CH1_FADER} = ${(await memOf(page))[CH1_FADER]}`);

    // The counter-example, and the whole reason it is in the catalog: the same
    // gesture, at the same point of the same kind of await, survives here. The
    // converge re-bases from a clone frozen BEFORE its await, so the edit stays a
    // diff and goes out when the round finishes. A finding here would mean the clone
    // was lost — and it is what makes the refetch case above a missing clone rather
    // than an unavoidable consequence of a long await.
    expect(findings).toHaveLength(0);
    expect(after).toBe(edited);
    expect((await memOf(page))[CH1_FADER]).toBe(40);
    // Ordering, not just values: a selector must reach the device before the bypass
    // it types, or the unit's own auto-engage stands.
    expect(analyze(trace, { order: ["135:0:0", "134:0:0"] })).toHaveLength(0);
  });
});
