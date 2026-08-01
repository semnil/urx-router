import { test, expect } from "@playwright/test";
import {
  installFake,
  goLive,
  mark,
  pushNotify,
  traceOf,
  setLatency,
  blockAt,
  releaseBarrier,
  memOf,
  waitQuiet,
  settleAfter,
  ledgerOf,
  snapshotOf,
  depthOf,
  hasProbe,
} from "./fake-device";
import { analyze, report, timeline, markTime } from "./analyze";
import { CH1_FADER, CH1_HPF_FREQ, CH2_FADER, faderOf, faderReadout, openEqScreen } from "./ui";

// The two invariants the fake device's IPC log cannot decide, and the probe that makes
// them decidable (src/ui/trace-probe.ts, served by the VITE_TRACE build):
//
//   13 authorship attribution — every plan key resolves to exactly one writer. The
//      losing side of an overtake leaves NO trace in the IPC log at all: it is a write
//      that never became a command. Only the ledger sees it.
//   3  snapshot poisoning — the live snapshot is supposed to hold what the device was
//      last told. An entry it holds for an address nothing ever sent is a value the app
//      believes is on the unit and never put there, so the next diff will not send it
//      either. The sends are in the trace; the snapshot is not.
//
// The file also pins the probe's own contract, so a bundle served without it fails
// loudly here rather than making every case above quietly vacuous.

test.describe("T9 probe", () => {
  test.beforeEach(async ({ page }) => {
    await installFake(page);
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  test("the served bundle carries the probe, and the probe answers its three questions", async ({ page }) => {
    // Without this the two invariants below are unreachable and every assertion that
    // rests on them would pass by having no input — the failure mode the audit found
    // seventeen of. Fail here instead.
    expect(await hasProbe(page)).toBe(true);

    await goLive(page);
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();

    // A session's snapshot is captured from the readback, so it is populated and it
    // carries the address the console is about to edit.
    const snap = await snapshotOf(page);
    expect(snap).not.toBeNull();
    expect(Object.keys(snap!).length).toBeGreaterThan(100);
    expect(snap![CH1_FADER]).toBeDefined();

    const before = await depthOf(page);
    await faderOf(page, "CH 1").focus();
    await page.keyboard.press("ArrowUp");
    await waitQuiet(page);

    // One gesture, one entry, and the ledger attributes its key to the operator.
    const after = await depthOf(page);
    expect(after.undo - before.undo).toBe(1);
    const ledger = await ledgerOf(page);
    const mine = ledger.filter((l) => l.source === "ui");
    expect(mine.length).toBeGreaterThan(0);
    // A console fader rides its connection's params, not the node's.
    expect(mine.some((l) => l.field === "connParams" && (l.subKeys ?? []).includes("level"))).toBe(true);

    // The rest of the contract — everything this tier leans on and nothing pinned:
    //
    //   - reading is SIDE-EFFECT-FREE. Cases here sample the probe in the middle of a
    //     gesture, so an accessor that grew the ledger or moved the depth would be
    //     changing the thing it was asked to measure.
    //   - snapshot() hands back a COPY. `snapshotOf` crosses the IPC boundary and
    //     copies on the way, so the driver cannot see this: only a write into the
    //     returned object from inside the page can, and if it reached the live map the
    //     next diff would measure against a value the harness invented.
    //   - sample(source) is a MUTATOR — the one t0b's surface sweeps call: it takes the
    //     plan delta since the last sample and attributes it, so with nothing changed
    //     since it adds nothing.
    //   - clear() empties the ledger and re-takes the baseline, which is what lets a
    //     later phase read its own writers without the boot readback's thousand entries
    //     in front of them (t2d / t2e call it between phases).
    const contract = await page.evaluate(() => {
      const p = (
        window as unknown as {
          __urxTrace: {
            ledger: unknown[];
            snapshot: () => Record<string, number> | null;
            depth: () => { undo: number; redo: number };
            sample: (s: string) => number;
            clear: () => void;
          };
        }
      ).__urxTrace;
      const n0 = p.ledger.length;
      const d0 = p.depth();
      const s0 = p.snapshot()!;
      s0["999:0:0"] = 1; // poke the object the accessor just handed back
      const s1 = p.snapshot()!;
      const d1 = p.depth();
      const readsGrewLedger = p.ledger.length - n0;
      const sampledDelta = p.sample("unknown");
      const grownBySample = p.ledger.length - n0;
      p.clear();
      return {
        readsGrewLedger,
        leaked: "999:0:0" in s1,
        keysStable: Object.keys(s1).length === Object.keys(s0).length - 1,
        depthStable: d1.undo === d0.undo && d1.redo === d0.redo,
        sampledDelta,
        grownBySample,
        afterClear: p.ledger.length,
        readableAfterClear: p.snapshot() !== null && p.depth().undo === d0.undo,
      };
    });
    console.log(`probe contract: ${JSON.stringify(contract)}`);
    expect(contract.readsGrewLedger).toBe(0);
    expect(contract.leaked).toBe(false);
    expect(contract.keysStable).toBe(true);
    expect(contract.depthStable).toBe(true);
    // Nothing has touched the plan since the edit's own funnel reported it, so the
    // delta is empty and the mutator writes no entry.
    expect(contract.sampledDelta).toBe(0);
    expect(contract.grownBySample).toBe(0);
    // …and clear() drops the ledger without taking the two accessors with it.
    expect(contract.afterClear).toBe(0);
    expect(contract.readableAfterClear).toBe(true);
  });

  // Invariant 13: the scoped readback and the operator contend for the same plan key
  // inside one window. The readback used to land last, and in the IPC log the operator's
  // write is present and looks successful — the ledger is what showed it was then
  // overwritten. It now merges instead of assigning, so the contested key never becomes
  // part of the readback's own delta and the operator stays its last writer.
  test("a scoped readback leaves the operator as the contested key's last writer", async ({ page }) => {
    await goLive(page);
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    await setLatency(page, { get: 25, set: 25 });

    const before = (await faderReadout(page, "CH 1").textContent())!;
    await blockAt(page, "vd_get", 1);
    await mark(page, "notify");
    await pushNotify(page, [[...CH1_HPF_FREQ, 40]]);
    await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 10_000 });

    await mark(page, "edit");
    await faderOf(page, "CH 1").focus();
    await page.keyboard.press("ArrowUp");
    const edited = (await faderReadout(page, "CH 1").textContent())!;
    expect(edited).not.toBe(before);

    await page.waitForTimeout(500);
    await mark(page, "release");
    await releaseBarrier(page);
    await page.waitForSelector('#statusbar:text-matches("← device \\\\(\\\\d+\\\\)")', { timeout: 20_000 });
    await mark(page, "scoped-done");

    const trace = await traceOf(page);
    const ledger = await ledgerOf(page);
    const editAt = markTime(trace, "edit")!;
    const findings = analyze(trace, {
      edits: [{ label: "CH 1 fader ArrowUp", addr: CH1_FADER, at: editAt }],
      ledger,
    });

    console.log(timeline(trace, { from: markTime(trace, "notify")! - 50 }));
    console.log(report("authorship under a scoped readback", findings));
    const level = ledger.filter((l) => l.field === "connParams" && (l.subKeys ?? []).includes("level"));
    console.log(`ledger on connParams.level: ${level.map((l) => `${l.t.toFixed(0)}ms ${l.source}`).join(" → ")}`);

    // Stated as a property of the plan rather than inferred from what reached the wire:
    // the key has exactly one author. The reconcile's ledger sample is taken after both
    // halves of the merge, so a key whose contest the operator won is not in its delta
    // at all — there is no device writer to be last.
    expect(level.map((l) => l.source)).toContain("ui");
    expect(level[level.length - 1].source).toBe("ui");
    expect(findings.some((f) => f.inv === 13)).toBe(false);
  });

  // Invariant 3 in its general form, as the REGRESSION for a fix this harness drove.
  //
  // The refetch epilogue used to re-base from the live plan, so an edit made during the
  // read was recorded as device truth: the screen kept the operator's value, the unit
  // was never given it, and no later diff could see the address again. Measured here
  // first (the snapshot held 40 while the device held nothing), then fixed in
  // live.ts by freezing a pre-await copy and splitting the re-base by owner node.
  //
  // The gesture below is on CH 2 while the refetch is scoped to ch1, deliberately: a
  // key the readback itself touches is lost by being OVERWRITTEN, which is a different
  // defect and is pinned separately in t1-overtake.spec.ts. This one isolates the
  // snapshot, and it is invisible without the probe — the losing write never became a
  // command, so the IPC log has nothing to show.
  test("an edit made during a refetch of another node still reaches the device", async ({ page }) => {
    await goLive(page);
    await openEqScreen(page, "ch1");
    await setLatency(page, { get: 25, set: 25 });

    await blockAt(page, "vd_get", 1);
    await mark(page, "oneknob-on");
    await page
      .locator("#dyn-screen-box .prefs-section", { has: page.locator("#dyn-oneknob-level") })
      .locator(".prefs-toggle button")
      .first()
      .click();
    await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 10_000 });

    await page.keyboard.press("Escape");
    await expect(page.locator("#dyn-screen-box")).toBeHidden();
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 2")).toBeVisible();
    // CH 2, deliberately: the refetch is SCOPED to ch1, so this edit is not overwritten
    // by the readback. That separates the two mechanisms — a key the readback touches
    // is lost by being overwritten (T1 measures that), while this one survives in the
    // plan and is lost only because the epilogue records it as device truth. The second
    // is snapshot poisoning proper, and it is invisible without the probe.
    const before = (await faderReadout(page, "CH 2").textContent())!;
    await mark(page, "edit");
    await faderOf(page, "CH 2").focus();
    await page.keyboard.press("ArrowUp");
    expect(await faderReadout(page, "CH 2").textContent()).not.toBe(before);

    await mark(page, "release");
    await releaseBarrier(page);
    await settleAfter(page, "release");

    const trace = await traceOf(page);
    const editAt = markTime(trace, "edit")!;
    const snapshot = await snapshotOf(page);
    const findings = analyze(trace, {
      edits: [{ label: "CH 2 fader during a ch1 refetch", addr: CH2_FADER, at: editAt }],
      snapshot,
      ledger: await ledgerOf(page),
    });

    console.log(timeline(trace, { from: markTime(trace, "oneknob-on")! - 50 }));
    console.log(report("snapshot poisoning after a refetch", findings));
    console.log(
      `snapshot holds ${CH2_FADER} = ${snapshot?.[CH2_FADER]}; device holds ${(await memOf(page))[CH2_FADER]}; screen shows ${await faderReadout(page, "CH 2").textContent()}`,
    );

    // The three agree: the screen shows the operator's value, the snapshot records it
    // as device truth, and the device really was given it. Lose the frozen copy again
    // and all three assertions fail — the snapshot would hold a value nothing sent.
    expect(findings.some((f) => f.inv === 3)).toBe(false);
    expect(findings.some((f) => f.inv === 2)).toBe(false);
    const sent = (await memOf(page))[CH2_FADER];
    expect(sent).toBeDefined();
    expect(snapshot?.[CH2_FADER]).toBe(sent);
    expect(await faderReadout(page, "CH 2").textContent()).not.toBe(before);
    // …and the node the refetch DID read is still re-based from the device, or every
    // value the unit computed would go straight back out as a pending edit.
    expect(snapshot?.["46:0:0"]).toBe(1);
  });
});
