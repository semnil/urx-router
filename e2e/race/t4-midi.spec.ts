import { test, expect, type Page } from "@playwright/test";
import {
  installFake,
  goLive,
  mark,
  traceOf,
  paramAddrsOf,
  snapshotOf,
  setLatency,
  blockAt,
  releaseBarrier,
  memOf,
  settleAfter,
  pushMidi,
  midiSentOf,
  type InstallOptions,
} from "./fake-device";
import { analyze, report, timeline, markTime, setsOf } from "./analyze";
import { CH1_FADER, CH2_FADER, faderOf, faderReadout, openEqScreen } from "./ui";

// T4 midi — the second operator with no gate (docs/{en,ja}/live-race-harness.md).
//
// Every other writer in the app is gated by something: a UI edit cannot happen behind
// a modal, undo refuses while any device read holds the plan, a file flow takes the plan
// exclusively. An incoming MIDI message is bound by a strict subset — it is refused only
// while an operator-started device read (Fetch, Live-sync start) or a file flow holds
// the plan, and otherwise lands in MidiEngine.onMessage, writes the plan through the
// control catalog, and calls markChanged() plus a reflect, whatever else the app is in
// the middle of. A modal, a live flush's converge / refetch await and MIDI learn are all
// deliberately outside the gate; the cases below drive those windows.
//
// Bindings are seeded through the persisted `urx-midi` store rather than driven
// through the panel's learn flow: learn needs the panel open, the console visible and
// an arming click on the very control a case then wants to drag or hold a barrier
// against, and the resulting mapping is byte-identical to a seeded one (mapping.ts
// sanitizeMappings validates it on load). The port choice is seeded the same way —
// restorePorts() reopens it at boot, so the fake owns the input channel before the
// first gesture.

const CC7 = { type: "cc", channel: 0, controller: 7 } as const;

type Mapping = { control: string; addr: typeof CC7; mode: "absolute" | "pickup" };

/** Seed the persisted MIDI store: ports (reopened at boot) + this model's bindings. */
function midiStore(
  mappings: Mapping[],
  ports: { input?: string; output?: string } = { input: "Fake In" },
): InstallOptions["storage"] {
  return { "urx-midi": JSON.stringify({ ...ports, models: { URX44V: mappings } }) };
}

const statusLine = (page: Page) => page.locator("#statusbar");

/** The EQ tuning screen's 1-Knob ON button (located from the level slider's id, the
 *  only stable anchor in that section — the same handle t1-overtake uses). */
const oneKnobOn = (page: Page) =>
  page
    .locator("#dyn-screen-box .prefs-section", { has: page.locator("#dyn-oneknob-level") })
    .locator(".prefs-toggle button")
    .first();
/** A CC 7 message. The level codec is posToLevel(round(v/127 × 40)) over the
 *  LEVEL_STEPS_DB grid, so the dB each raw value lands on is stated per use. */
const cc7 = (value: number): number[] => [0xb0, 7, value];

/** Readout text → dB. "-∞" is the off notch, which no case below drives to. */
const dbOf = (text: string): number => (text.trim() === "-∞" ? Number.NEGATIVE_INFINITY : Number(text));

test.describe("T4 midi", () => {
  // ---------------------------------------------------------------------------
  // midi-write-during-refetch-snapshot — the priority case. MIDI is the only
  // funnel with no gate at all, so it is the only writer that can mutate the plan
  // while a device read holds it; the refetch epilogue then snapshots that plan as
  // device truth. Differential against the identical binding driven with no
  // readback in flight, which is what makes the loss the window's rather than the
  // message's.
  // ---------------------------------------------------------------------------
  test("a CC delivered during a held 1-knob refetch is applied ungated, and survives it", async ({ page }) => {
    await installFake(page, { storage: midiStore([{ control: "ch1/level", addr: CC7, mode: "absolute" }]) });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await goLive(page);

    // The pre-gesture value, read from the console the case later reads it from.
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    const before = (await faderReadout(page, "CH 1").textContent())!;
    await page.click("#btn-view-graph");

    await openEqScreen(page, "ch1");
    await setLatency(page, { get: 20, set: 25 });

    // Hold the refetch's node read. Nothing else reads while idle, so the first
    // vd_get after the 1-knob write belongs to that refetch.
    await blockAt(page, "vd_get", 1);
    await mark(page, "oneknob-on");
    await oneKnobOn(page).click();
    await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 15_000 });

    // The message arrives with the tuning screen still MODAL and a follow-side read
    // still in flight. Neither refuses MIDI: the tuning screen is the one modal that
    // edits the plan, and a refetch await is outside the gate on purpose.
    await expect(page.locator("#dyn-screen-box")).toBeVisible();
    await mark(page, "midi-during-refetch");
    await pushMidi(page, [cc7(114)]); // 114/127 × 40 → pos 36 → +5.0 dB

    // Read the plan back while the barrier still holds: this is the observation that
    // the write was not refused. Closing the screen and switching view only renders
    // the plan the message already changed.
    await page.keyboard.press("Escape");
    await expect(page.locator("#dyn-screen-box")).toBeHidden();
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    const duringHold = (await faderReadout(page, "CH 1").textContent())!;

    await mark(page, "release");
    await releaseBarrier(page);
    // The verdict below is an ABSENCE (the device never held +5.0 dB), and the held
    // read's own ipc-start is already minutes old by trace standards, so waitQuiet
    // would answer "silent" before the refetch even resumed. Wait for the link to
    // wake after the release, then for its silence.
    await settleAfter(page, "release");
    const afterRefetch = (await faderReadout(page, "CH 1").textContent())!;
    const memAfterRefetch = (await memOf(page))[CH1_FADER];

    // The control run: the identical binding, driven with nothing in flight. A
    // different raw value, because the plan has already been to +5.0 dB above and a
    // diff-based flush cannot carry a value the snapshot already holds — the window
    // is the variable, not the message.
    await mark(page, "midi-idle");
    await pushMidi(page, [cc7(64)]); // 64/127 × 40 → pos 20 → -10.0 dB
    // The link is already silent here, so waitQuiet would return before the 120 ms
    // flush window even opened and report a lost edit the app had not yet had a
    // chance to make. settleAfter waits for the flush to wake the link first.
    await settleAfter(page, "midi-idle");
    const afterIdle = (await faderReadout(page, "CH 1").textContent())!;

    const trace = await traceOf(page);
    const findings = analyze(trace, {
      edits: [
        {
          label: "CC 7 = 114 during refetch",
          addr: CH1_FADER,
          at: markTime(trace, "midi-during-refetch")!,
          value: 500,
        },
        { label: "CC 7 = 64 with nothing in flight", addr: CH1_FADER, at: markTime(trace, "midi-idle")!, value: -1000 },
      ],
      registration: await paramAddrsOf(page),
      // The registration is a snapshot taken now; the refetch re-registered in the
      // middle of the run, so only the writes after the last mark can be compared
      // against it without inventing orphans that were registered when they left.
      registrationWindow: { from: markTime(trace, "midi-idle")! },
      // MIDI moves a fader value; the 1-Knob ON earlier in the run is a SHRINK, which
      // leaves the registration a superset. Clause B reports growth only, so it is
      // silent here — measured rather than assumed, since the pair is supplied.
      snapshot: await snapshotOf(page),
    });

    console.log(timeline(trace, { from: markTime(trace, "oneknob-on")! - 50 }));
    console.log(report("MIDI write during refetch", findings));
    console.log(
      `readout: before=${before} duringHold=${duringHold} afterRefetch=${afterRefetch} afterIdle=${afterIdle}`,
    );
    console.log(`device ${CH1_FADER}: after refetch=${memAfterRefetch} final=${(await memOf(page))[CH1_FADER]}`);

    // Still applied, and deliberately so: the gate covers deviceReadInFlight and
    // fileFlowBusy (a Fetch, a Live-sync start, a file flow), not a live flush's refetch
    // await. That window recurs once per flush of a 1-knob drag, so refusing in it would
    // make the desk stutter — and it would refuse this writer while the mouse is allowed.
    expect(duringHold).not.toBe(before);
    expect(dbOf(duringHold)).toBeCloseTo(5, 1);

    // The read still straddles the message (1) — geometry, and what made this case worth
    // writing. What is gone is the loss: the refetch reads into its own copy and the
    // re-base measures from that copy, so the message stays a diff and the trailing flush
    // carries it. This is the pin that shows the fix covers the one writer that cannot be
    // gated out of the window.
    expect(findings.some((f) => f.inv === 1)).toBe(true);
    expect(findings.some((f) => f.inv === 2 && f.detail.includes("during refetch"))).toBe(false);
    expect(memAfterRefetch).toBe(500); // the device was given it
    expect(afterRefetch).toBe(duringHold); // …and the screen kept it

    // The control run, same binding and same message shape: it goes out at once.
    expect(findings.some((f) => f.inv === 2 && f.detail.includes("nothing in flight"))).toBe(false);
    expect((await memOf(page))[CH1_FADER]).toBe(-1000);
    expect(dbOf(afterIdle)).toBeCloseTo(-10, 1);
  });

  // ---------------------------------------------------------------------------
  // midi-rebase-eats-ui-entry-ladder — the same writer classified two contradictory
  // ways: markChanged() records it as an app edit (live sync mirrors it, the history
  // opens an entry), and its own reflect runs planReadFromDevice() →
  // planHistory.rebase(), which drops whatever entry is open. The operator's entry is
  // collateral.
  //
  // The gesture that opens an entry is a WHEEL notch, not the catalog's chip click: a
  // click's entry is closed by the macrotask commit that pointerup schedules, so it is
  // already committed before any driver-delivered message can reach it. A wheel has no
  // DOM boundary at all and is held open by the 300 ms idle backstop, which is the
  // window the ladder walks.
  // ---------------------------------------------------------------------------
  for (const d of [20, 60, 400, 2000]) {
    const inWindow = d < 300;
    test(`a MIDI message ${d} ms after a wheel edit ${inWindow ? "eats" : "spares"} the operator's undo entry`, async ({
      page,
    }) => {
      await installFake(page, { storage: midiStore([{ control: "ch1/level", addr: CC7, mode: "absolute" }]) });
      await page.goto("/");
      await expect(page.locator("#model-picker")).toHaveValue("URX44V");
      await goLive(page);
      await page.click("#btn-view-console");
      await expect(faderReadout(page, "CH 2")).toBeVisible();
      await setLatency(page, { get: 8, set: 25 });

      const ch2Before = (await faderReadout(page, "CH 2").textContent())!;
      const box = (await faderOf(page, "CH 2").boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await mark(page, "wheel");
      await page.mouse.wheel(0, -100); // one detent up on CH 2
      const ch2Edited = (await faderReadout(page, "CH 2").textContent())!;
      expect(ch2Edited).not.toBe(ch2Before);

      await page.waitForTimeout(d);
      await mark(page, "midi");
      await pushMidi(page, [cc7(114)]); // CH 1 → +5.0 dB, a node the wheel never touched
      await expect(faderReadout(page, "CH 1")).toHaveText("+5.0");

      await page.waitForTimeout(Math.max(0, 3000 - d));
      await mark(page, "undo");
      await page.keyboard.press("ControlOrMeta+z");
      await expect(statusLine(page)).not.toHaveText("");
      const undoStatus = (await statusLine(page).textContent())!;
      const ch2AfterUndo = (await faderReadout(page, "CH 2").textContent())!;
      const ch1AfterUndo = (await faderReadout(page, "CH 1").textContent())!;
      // The link has been idle for 3 s by now, so waitQuiet would return on the spot
      // and both branches below would be reading the device memory of an undo whose
      // flush had not been given a chance to run — the in-window branch's verdict is
      // an absence (nothing rewrote CH 2), which is exactly the shape waitQuiet
      // cannot answer. settleAfter waits for the undo to wake the link, or for its
      // grace to expire having seen nothing at all.
      await settleAfter(page, "undo");

      const trace = await traceOf(page);
      const findings = analyze(trace, {
        edits: [
          { label: "CH 2 wheel detent", addr: CH2_FADER, at: markTime(trace, "wheel")! },
          { label: "CH 1 CC 7", addr: CH1_FADER, at: markTime(trace, "midi")!, value: 500 },
        ],
        registration: await paramAddrsOf(page),
        registrationWindow: { from: markTime(trace, "wheel")! },
        // Two fader values (a wheel detent and a CC): no structural edit, so clause B
        // has nothing to report.
        snapshot: await snapshotOf(page),
      });
      const achieved = markTime(trace, "midi")! - markTime(trace, "wheel")!;

      console.log(timeline(trace, { from: markTime(trace, "wheel")! - 50 }));
      console.log(report(`rebase ladder D=${d}`, findings));
      console.log(
        `D intended=${d} achieved=${achieved.toFixed(0)} ms; CH 2 ${ch2Before} → ${ch2Edited} → ${ch2AfterUndo}; ` +
          `CH 1 after undo=${ch1AfterUndo}; status="${undoStatus}"`,
      );

      // Both edits reach the device either way — this is a history defect, not a
      // sync one, and saying so keeps the two apart.
      expect((await memOf(page))[CH1_FADER]).toBe(500);
      expect(setsOf(trace).filter((s) => s.addr === CH2_FADER)).not.toHaveLength(0);

      if (inWindow) {
        // Pinned behaviour: the wheel's entry was still open when MIDI's reflect
        // rebased, so the operator's own edit is silently un-undoable. Nothing about
        // the gesture failed — a controller twitched.
        expect(undoStatus).toBe("Nothing to undo");
        expect(ch2AfterUndo).toBe(ch2Edited);
        expect((await memOf(page))[CH2_FADER]).toBe(40); // the device keeps it too
      } else {
        // Outside the window the idle backstop had already committed the entry, and
        // rebase keeps committed entries — so the same script is recoverable. The
        // status is the un-named form: the wheel moved a send connection's level, and
        // a patch touching a wire rather than a node names nothing.
        expect(undoStatus).toBe("Undone");
        expect(ch2AfterUndo).toBe(ch2Before);
        expect((await memOf(page))[CH2_FADER]).toBe(0); // and the undo reached the device
      }
      // Either way the MIDI edit itself is NOT undoable: its own reflect rebased the
      // entry it had just opened. One writer, two classifications.
      expect(ch1AfterUndo).toBe("+5.0");
    });
  }

  // The control run for the ladder: identical script with the input port closed, so
  // the only variable removed is the second operator.
  test("with the MIDI port closed the same wheel edit at D=20 stays undoable", async ({ page }) => {
    await installFake(page, {
      storage: midiStore([{ control: "ch1/level", addr: CC7, mode: "absolute" }], {}),
    });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await goLive(page);
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 2")).toBeVisible();
    await setLatency(page, { get: 8, set: 25 });

    const ch2Before = (await faderReadout(page, "CH 2").textContent())!;
    const box = (await faderOf(page, "CH 2").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await mark(page, "wheel");
    await page.mouse.wheel(0, -100);
    const ch2Edited = (await faderReadout(page, "CH 2").textContent())!;
    expect(ch2Edited).not.toBe(ch2Before);

    await page.waitForTimeout(20);
    await mark(page, "midi");
    await pushMidi(page, [cc7(114)]); // no port is open: the bridge has no channel to deliver on
    await page.waitForTimeout(3000);
    await mark(page, "undo");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(statusLine(page)).not.toHaveText("");
    const undoStatus = (await statusLine(page).textContent())!;
    const ch2AfterUndo = (await faderReadout(page, "CH 2").textContent())!;
    await settleAfter(page, "undo"); // same reason as the ladder: the link is idle here

    const trace = await traceOf(page);
    console.log(timeline(trace, { from: markTime(trace, "wheel")! - 50 }));
    const findings = analyze(trace, {
      registration: await paramAddrsOf(page),
      registrationWindow: { from: markTime(trace, "wheel")! },
      // Same control with the port closed: still a fader value, still no growth.
      snapshot: await snapshotOf(page),
    });
    console.log(report("rebase ladder control (port closed)", findings));
    console.log(`CH 2 ${ch2Before} → ${ch2Edited} → ${ch2AfterUndo}; status="${undoStatus}"`);

    // No second writer: the CH 1 fader never moved, and the wheel entry survives the
    // same 20 ms phase that loses it above.
    expect((await memOf(page))[CH1_FADER]).toBeUndefined();
    expect(await faderReadout(page, "CH 1").textContent()).not.toBe("+5.0");
    expect(undoStatus).toBe("Undone");
    expect(ch2AfterUndo).toBe(ch2Before);
    expect((await memOf(page))[CH2_FADER]).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // midi-vs-main-fader-absolute — the MIDI edit's own reflect calls refreshStrip,
  // which does old.root.replaceWith(fresh) under an active pointer capture. The
  // drag's move listeners live on `window` and close over the OLD StripRef, so they
  // keep mutating the plan and painting a detached cap while the visible one freezes.
  //
  // The burst is delivered as one batched message (the fake's contract, and the shape
  // the Rust bridge actually hands over) rather than ten 15 ms deliveries: both
  // produce one coalesced reflect, and one batch keeps the phase exact.
  // ---------------------------------------------------------------------------
  for (const d of [50, 300, 900]) {
    test(`a CC burst ${d} ms into a CH 1 fader drag rebuilds the strip under the pointer @webkit`, async ({ page }) => {
      await installFake(page, { storage: midiStore([{ control: "ch1/level", addr: CC7, mode: "absolute" }]) });
      await page.goto("/");
      await expect(page.locator("#model-picker")).toHaveValue("URX44V");
      await goLive(page);
      await page.click("#btn-view-console");
      await expect(faderReadout(page, "CH 1")).toBeVisible();
      await setLatency(page, { get: 8, set: 25 });

      const result = await dragAgainstMidi(page, d);
      const trace = await traceOf(page);
      const findings = analyze(trace, {
        edits: [{ label: "CH 1 drag", addr: CH1_FADER, at: markTime(trace, "drag-start")! }],
        registration: await paramAddrsOf(page),
        registrationWindow: { from: markTime(trace, "drag-start")! },
        // A CC burst into a fader drag: the strip rebuild is a render, not a plan shape
        // change, so the emitted set is constant and clause B is silent.
        snapshot: await snapshotOf(page),
      });

      console.log(timeline(trace, { from: markTime(trace, "drag-start")! - 50 }));
      console.log(report(`MIDI vs main fader D=${d}`, findings));
      console.log(
        `D intended=${d} achieved=${result.achieved.toFixed(0)} ms; connected=${result.connected}; ` +
          `visible=${result.visible} (later ${result.visibleLater}) detached=${result.detached}; ` +
          `device=${result.mem}; flushes=${result.writes.map((w) => w.value).join(",")}`,
      );

      // The phase is only interpretable if the burst really landed mid-gesture.
      expect(result.firedInDrag).toBe(true);
      // Pinned behaviour (invariant 10). The strip the pointer captured was replaced
      // mid-gesture, so the element the drag holds is out of the document…
      expect(result.connected).toBe(false);
      // …and the drag went on writing into it: the detached readout carries the
      // gesture's final value, which is what actually reached the device, while the
      // strip the operator is looking at froze at the value the rebuild captured.
      expect(result.visible).not.toBe(result.detached);
      expect(result.mem).toBe(Math.round(dbOf(result.detached) * 100));
      // The MIDI value is gone: the last mover wins, and it is the invisible one.
      expect(result.writes.at(-1)!.value).toBe(result.mem);
      // The stale readout is not repaired by anything the app does on its own within
      // a further settle (a bounded window — the case observes ~3 s of quiet after the
      // gesture, it does not establish "forever").
      expect(result.visibleLater).toBe(result.visible);
    });
  }

  // Control: the same drag, the same burst at the same phase, bound to CH 2 instead —
  // so a strip is still rebuilt from a MIDI reflect, just not the one under the
  // pointer. Isolates the DOM-replacement half of the failure from everything else the
  // message does.
  test("the same burst bound to another strip leaves the dragged one intact", async ({ page }) => {
    await installFake(page, { storage: midiStore([{ control: "ch2/level", addr: CC7, mode: "absolute" }]) });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await goLive(page);
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    await setLatency(page, { get: 8, set: 25 });

    const result = await dragAgainstMidi(page, 300);
    const trace = await traceOf(page);
    console.log(timeline(trace, { from: markTime(trace, "drag-start")! - 50 }));
    console.log(
      `control: connected=${result.connected}; visible=${result.visible} detached=${result.detached}; ` +
        `device=${result.mem}; CH 2 device=${(await memOf(page))[CH2_FADER]}`,
    );

    // The reflect still ran (CH 2 moved), but the dragged strip was never rebuilt:
    // the element survives the gesture and the screen agrees with the device.
    expect(result.firedInDrag).toBe(true);
    expect((await memOf(page))[CH2_FADER]).toBe(500);
    expect(result.connected).toBe(true);
    expect(result.visible).toBe(result.detached); // same element — nothing was replaced
    expect(result.mem).toBe(Math.round(dbOf(result.visible) * 100));
  });

  // ---------------------------------------------------------------------------
  // midi-pickup-without-output-port — pickup engagement is cleared only inside
  // MidiEngine.feedback()'s emit branch, and runFeedback returns immediately when no
  // output port is open. With a controller that has no MIDI IN (or simply none
  // selected), the engagement outlives the UI edit that invalidated it: the fader is
  // yanked back to the physical control's position by the next twitch.
  //
  // Scope of the measurement: ONE binding (ch1/level, CC 7, pickup), two UI edit →
  // twitch cycles in one session. Two cycles is what makes "the engagement is never
  // cleared" more than a single reading — it is not a survey of the control catalog,
  // and nothing here observes a third.
  // ---------------------------------------------------------------------------
  test("pickup does not disengage on a UI edit while no output port is open, and the port open fixes it", async ({
    page,
  }) => {
    await installFake(page, {
      storage: midiStore([{ control: "ch1/level", addr: CC7, mode: "pickup" }], { input: "Fake In" }),
    });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await page.click("#btn-view-console");
    await mark(page, "boot");
    const readout = faderReadout(page, "CH 1");
    await expect(readout).toHaveText("0.0"); // factory CH 1 → STEREO level

    // Seed lastIn below the plan value, then cross above it. Two messages at the same
    // 40% (as the catalog words it) cannot cross — the product (lastIn − cur)(in − cur)
    // is positive — so the pair has to straddle for pickup to engage at all.
    await pushMidi(page, [cc7(40)]); // 0.315 vs plan 0.75: swallowed, lastIn seeded
    await page.waitForTimeout(120);
    expect(await readout.textContent()).toBe("0.0");
    await pushMidi(page, [cc7(120)]); // crosses → engaged → 0.945 → pos 38 → +7.2
    await expect(readout).toHaveText("+7.2");

    // The operator now moves the same fader in the UI, five detents down.
    await faderOf(page, "CH 1").focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowDown");
    await expect(readout).toHaveText("+2.0");

    await mark(page, "twitch-no-output");
    await pushMidi(page, [cc7(122)]); // 0.961: neither near nor crossing the plan's 0.825
    // Pinned defect: the plan is yanked back to the physical control's position. A
    // disengaged pickup would have swallowed this exactly as it swallowed CC 40.
    await expect(readout).toHaveText("+7.2");

    // Second cycle, same session and same binding: the engagement is still there. The
    // reflect above replaced the strip, so the fader has to be focused again.
    await faderOf(page, "CH 1").focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowDown");
    await expect(readout).toHaveText("+3.2"); // pos 34
    await mark(page, "twitch-no-output-2");
    await pushMidi(page, [cc7(118)]); // 0.929: again neither near nor crossing 0.85
    await expect(readout).toHaveText("+6.0"); // pos 37 — yanked back a second time

    // Open the output port: runFeedback(true) resyncs every binding and deletes the
    // pickup state with the emit.
    await page.click("#btn-device");
    await page.click("#btn-midi");
    await expect(page.locator("#midi-panel")).toBeVisible();
    await page.locator("#midi-panel .mp-out").selectOption("Fake Out");
    await expect.poll(() => page.evaluate(() => window.__urxFake.midi.outPort)).toBe("Fake Out");
    await page.keyboard.press("Escape");
    await expect(page.locator("#midi-panel")).toBeHidden();
    // Polled, not read once: the address received input moments ago, so the resync
    // pass defers behind RECENT_MS and lands on the 350 ms settle retry.
    await expect
      .poll(async () => (await midiSentOf(page)).filter((b) => b[0] === 0xb0 && b[1] === 7).length)
      .toBeGreaterThan(0);
    expect((await midiSentOf(page)).at(-1)).toEqual([0xb0, 7, 117]); // +6.0 dB = pos 37/40

    await mark(page, "twitch-with-output");
    await pushMidi(page, [cc7(60)]); // 0.472 vs plan 0.925: swallowed now
    await page.waitForTimeout(200);
    expect(await readout.textContent()).toBe("+6.0");
    await pushMidi(page, [cc7(100)]); // 0.787: same side as 0.472 — still swallowed
    await page.waitForTimeout(200);
    expect(await readout.textContent()).toBe("+6.0");
    await pushMidi(page, [cc7(127)]); // crosses 0.925 → re-engages → +10.0
    await expect(readout).toHaveText("+10.0");

    const trace = await traceOf(page);
    console.log(timeline(trace, { from: markTime(trace, "boot")! - 50 }));
    console.log(`outgoing feedback: ${(await midiSentOf(page)).map((b) => b.join(" ")).join(" | ")}`);
    // No quiescence assertion here: this run never goes live, and no code path issues
    // a vd_ command without a session, so "nothing reached the link" could not have
    // failed. The discriminating evidence in this case is the readouts above.
  });
});

interface DragResult {
  /** Whether the element the pointer captured is still in the document. */
  connected: boolean;
  /** The readout the operator can see when the gesture ends. */
  visible: string;
  /** The same readout one further settle later — a second, bounded observation, so
   *  "the screen stays stale" is measured over a window rather than assumed. */
  visibleLater: string;
  /** The readout of the strip the drag's closures kept writing into. */
  detached: string;
  /** The device's final CH 1 fader value, centi-dB. */
  mem: number;
  writes: Array<{ value: number | undefined }>;
  /** The measured phase of the burst inside the drag, ms. */
  achieved: number;
  /** The burst landed with drag moves still to come (the ladder is only meaningful
   *  when it did — a burst after the last move is just the later writer). */
  firedInDrag: boolean;
}

/**
 * One CH 1 main-fader drag from 30 % to 70 % travel, with a ten-message CC 7 burst
 * sweeping to 90 % delivered once the drag has run `d` ms. Returns what the gesture
 * left on screen, in the plan and on the wire.
 */
async function dragAgainstMidi(page: Page, d: number): Promise<DragResult> {
  const fader = faderOf(page, "CH 1");
  const handle = (await fader.elementHandle())!;
  const box = (await fader.boundingBox())!;
  // The main fader maps clientY to a fraction over the cap's own travel
  // (rect.height − 12, offset 6), so aim at the fraction rather than the box.
  const yAt = (frac: number): number => box.y + 6 + (1 - frac) * (box.height - 12);
  const x = box.x + box.width / 2;

  // 45 moves at 25 ms is ~1.5 s of gesture, so the widest phase in the ladder still
  // leaves a third of the drag to run after the burst.
  const STEPS = 45;
  const burst = Array.from({ length: 10 }, (_, k) => cc7(96 + 2 * k)); // 75 % → 90 %
  await page.mouse.move(x, yAt(0.3));
  await mark(page, "drag-start");
  await page.mouse.down();
  const started = Date.now();
  let firedAt = -1;
  for (let i = 1; i <= STEPS; i++) {
    await page.mouse.move(x, yAt(0.3 + (0.4 * i) / STEPS));
    if (firedAt < 0 && Date.now() - started >= d) {
      await mark(page, "midi-burst");
      await pushMidi(page, burst); // one batched message, the way the bridge delivers
      firedAt = i;
    }
    await page.waitForTimeout(25);
  }
  if (firedAt < 0) {
    await mark(page, "midi-burst");
    await pushMidi(page, burst);
  }
  await mark(page, "drag-end");
  await page.mouse.up();
  // The gesture's last flush is still inside its window here, so the settle waits for
  // it to wake the link rather than reading the memory of a write that has not left.
  await settleAfter(page, "drag-end");

  const connected = await handle.evaluate((el) => el.isConnected);
  const detached = await handle.evaluate(
    (el) => el.closest(".con-strip")?.querySelector(".con-readout .rd:not(.mtr) .rv")?.textContent ?? "",
  );
  const visible = (await faderReadout(page, "CH 1").textContent())!;
  // Second observation: nothing is driven after this mark, so settleAfter spends its
  // full grace waiting for a link that never wakes — a bounded quiet window in which
  // a repaint would have had every chance to happen.
  await mark(page, "post-drag");
  await settleAfter(page, "post-drag");
  const visibleLater = (await faderReadout(page, "CH 1").textContent())!;
  const trace = await traceOf(page);
  return {
    connected,
    visible,
    visibleLater,
    detached,
    mem: (await memOf(page))[CH1_FADER],
    writes: setsOf(trace)
      .filter((s) => s.addr === CH1_FADER)
      .map((s) => ({ value: s.value })),
    achieved: markTime(trace, "midi-burst")! - markTime(trace, "drag-start")!,
    firedInDrag: firedAt > 0 && firedAt < STEPS,
  };
}
