import { test, expect, type Page } from "@playwright/test";
import {
  installFake,
  goLive,
  mark,
  traceOf,
  paramAddrsOf,
  setLatency,
  memOf,
  settleAfter,
  type InstallOptions,
  type TraceEvent,
} from "./fake-device";
import { analyze, report, timeline, markTime, spans, type Finding, type Span } from "./analyze";
import { stepLevel } from "../../src/core/levels";
import { CH1_FADER, faderOf, faderReadout, strip } from "./ui";

// T8 stress — convergence, seeded fuzz and jitter (docs/{en,ja}/live-race-harness.md).
//
// Unlike T1's ladders, nothing here places a window: the point is what the system
// does when several writers drive one plan at once for a while. The catalog runs
// these for minutes (and one of them for half an hour); every case below is cut to
// ~5-12 s of driving so the file fits a CI budget. The shape of each run is the
// catalog's; only its duration is reduced, and each case says so where it matters.
//
// Two conventions this tier needs and the ladders do not:
//   - the drivers that are not "the operator" (MIDI bursts, device notifies, the
//     fuzz schedule) run INSIDE the page on timers. A Playwright round trip is
//     5-30 ms of unbounded jitter, which would make a 25 ms notify cadence a
//     fiction and a seeded schedule irreproducible.
//   - the whole-device sweep that follows the storm reads ~800 params. At the
//     scripted latency that alone is minutes, so the tail latency is dropped once
//     the race window under test has closed. It changes how fast the session
//     settles, not what it settles on.

// Mono channel params. The channel index is the address's y, not its x (x stays 0),
// so CH 2's fader is 139:0:1 — an address built the other way round is simply not in
// the registration set, and every notify to it escalates to a full re-read.
const P_CH_FADER = 139;
const P_CH_PAN = 141; // direct-follow: applied into the plan with no readback
const P_GATE_THRESHOLD = 29; // scoped: its notify turns the next settle into a node readback
const chAddr = (param: number, ch: number): [number, number, number] => [param, 0, ch];

const CH1_ON = "140:0:0"; // CH_ON — the scribble power LED

const MIDI_CC_LEVEL = 7;
const MIDI_NOTE_ON = 60;

const powerOf = (page: Page, name: string) => strip(page, name).locator(".con-scribble.power");

/** The fake's stored raw value rendered the way the console renders the plan's, so
 *  "the device and the screen agree" is one string comparison (src/ui/console.ts
 *  fmtDb over src/core/control/vd.ts vdToLevel). An address the device was never
 *  written to reads 0 = 0.0 dB, which is what the boot readback put in the plan. */
function deviceLevelText(raw: number | undefined): string {
  const v = raw ?? 0;
  if (v <= -32768) return "-∞";
  const db = v / 100;
  return (db > 0 ? "+" : "") + db.toFixed(1);
}

/** Seed the MIDI panel's persisted state so the second operator is present from
 *  boot: the saved ports reopen in MidiControl's constructor (restorePorts), with
 *  no panel interaction to serialize against the storm. */
function midiStorage(): InstallOptions["storage"] {
  return {
    "urx-midi": JSON.stringify({
      input: "Fake In",
      output: "Fake Out",
      models: {
        URX44V: [
          { control: "ch1/level", addr: { type: "cc", channel: 0, controller: MIDI_CC_LEVEL }, mode: "absolute" },
          { control: "ch1/chOn", addr: { type: "note", channel: 0, note: MIDI_NOTE_ON }, mode: "absolute" },
          { control: "ch1/level@bus.mix1", addr: { type: "cc", channel: 0, controller: 8 }, mode: "absolute" },
        ],
      },
    }),
  };
}

// The measure below takes a cutoff, and every caller passes one: the fake schedules a
// command's delay when the command is issued, so commands issued after the tail
// latency drop resolve on a different clock than the ones under test. Counting them
// would report an out-of-order storm produced by the driver, not by the link.

/** The kinds of interval intersection invariant 4 found, in the order it reports them.
 *  This file used to count overlapping pairs itself, because the invariant only saw
 *  "a write issued inside a read" and this case's subject includes the two same-kind
 *  intersections; the invariant now reports any intersecting pair, one per kind. */
const overlapKinds = (findings: Finding[]): string[] =>
  findings.filter((f) => f.inv === 4).map((f) => f.detail.split(":")[0]);

// WITHDRAWN — "a jittering link reorders responses" (`outOfOrderResponses`, a count of
// responses that resolved before one issued earlier). The bridge is ONE worker thread
// (src-tauri/src/vd.rs) that answers each command with a blocking round trip before it
// takes the next, and fake-device.ts now serializes the same way, so responses resolve
// strictly in issue order whatever the per-command delay is: the count is structurally 0
// under every profile, and hardware cannot produce a non-zero one either. It was
// therefore a property of the old per-command-setTimeout fake, which is exactly what
// docs/{en,ja}/live-race-harness.md forbids reporting as a run result. Redefined, not
// deleted: what the arm was really establishing is that the app had TWO CHAINS ON THE
// LINK AT ONCE (otherwise the convergence verdict below is about a single sequential
// chain and says nothing about contention), and on a serial worker that survives as
// queue depth. The jitter axis keeps its own observable in `latencySpread`.

/** The deepest the link's queue got: the most vd_get / vd_set commands outstanding at
 *  once. One worker serves them one at a time, so a depth above 1 is the app issuing a
 *  command while an earlier one is still in flight — a flush against a reconcile, the
 *  contention this case's convergence claim rests on. Decided in seq, like invariant 4:
 *  `t` ties are routine and the issue order is the whole question. */
function maxQueueDepth(all: Span[], from: number, before: number): number {
  const rw = all.filter((s) => (s.cmd === "vd_get" || s.cmd === "vd_set") && s.start > from && s.start < before);
  let depth = 0;
  let live: Span[] = [];
  for (const s of rw) {
    live = live.filter((o) => o.endSeq > s.seq);
    live.push(s);
    depth = Math.max(depth, live.length);
  }
  return depth;
}

/** p90 − p10 of the response latencies, ms: what jitter does to a link that cannot
 *  reorder. Logged rather than asserted — the spread a wait() draws is arithmetic over
 *  the fake's seeded LCG, so a threshold on it would measure fake-device.ts.
 *
 *  Windowed like the depth above, and for a sharper reason: the session's own boot
 *  readback is ~800 reads at zero latency, so a spread taken from t=0 is a percentile
 *  over those and reads 0 ms whatever the profile under test did. */
function latencySpread(all: Span[], from: number, before: number): number {
  const d = all
    .filter(
      (s) => (s.cmd === "vd_get" || s.cmd === "vd_set") && s.start > from && s.start < before && Number.isFinite(s.end),
    )
    .map((s) => s.end - s.start)
    .sort((a, b) => a - b);
  if (!d.length) return 0;
  return d[Math.floor(d.length * 0.9)] - d[Math.floor(d.length * 0.1)];
}

/** Jitter is applied to every wait, including the zero-latency ones, so installing it
 *  before goLive would spread ~800 sequential boot reads over half a minute. It is
 *  handed to the fake the same way the scripted latency is: after the session is up. */
const setJitter = (page: Page, jitter: number): Promise<void> =>
  page.evaluate((j) => {
    window.__urxFake.cfg.jitter = j;
  }, jitter);

const invSet = (findings: Finding[]): number[] => [...new Set(findings.map((f) => f.inv))].sort((a, b) => a - b);

/** Trace time of the last registration (`vd_params_subscribe`). `paramAddrsOf` is a
 *  SNAPSHOT of the address set as it stands at the end of the run, so the only writes
 *  invariant 12 can honestly judge against it are the ones issued after that set was
 *  installed — a write issued earlier may have been perfectly registered under an
 *  earlier set. Every analyze() call here passes this as the window's `from`. */
const lastRegistrationAt = (trace: TraceEvent[]): number =>
  [...trace].reverse().find((e) => e.kind === "subscribe")?.t ?? 0;

test.describe("T8 stress", () => {
  // stress-three-operators-one-node. The convergence case: operator, MIDI and the
  // device panel all drive CH 1 at once, and the question is only whether the
  // session settles somewhere all three descriptions of it agree.
  //
  // Duration reduced: the catalog drives this for 20 s, here ~10 s.
  test("operator, MIDI and device notifies driving one channel converge to one value", async ({ page }) => {
    test.setTimeout(180_000);
    await installFake(page, { storage: midiStorage() });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    // The seeded input port reopens on boot; without it the MIDI operator is absent
    // and the case degenerates into a T1 ladder.
    await expect.poll(() => page.evaluate(() => window.__urxFake.midi.inPort)).toBe("Fake In");

    await goLive(page);
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    await setLatency(page, { get: 25, set: 25 });

    // (b) MIDI and (c) the device panel, both on timers inside the page.
    await page.evaluate(
      ({ ms, cc, note, pan, gate }) => {
        const f = window.__urxFake;
        const timers: number[] = [];
        const sweep = [0, 40, 80, 110, 127, 96, 64, 24];
        let ccStep = 0;
        timers.push(
          window.setInterval(() => {
            f.pushMidi([[0xb0, cc, sweep[ccStep++ % sweep.length]]]);
          }, 2000),
        );
        timers.push(
          window.setInterval(() => {
            f.pushMidi([[0x90, note, 127]]);
          }, 3000),
        );
        // Genuine device-side movement: a burst of pan notifies every 500 ms (the
        // gaps matter — a continuous 10 Hz stream re-arms the 300 ms settle forever
        // and no reconcile would ever run), and a gate threshold every 4 s, which is
        // the scoped param that turns the next settle into a readback of ch1.
        let n = 0;
        timers.push(
          window.setInterval(() => {
            const v = ((n * 7) % 61) - 30;
            f.mem[`${pan[0]}:${pan[1]}:${pan[2]}`] = v;
            f.pushNotify([[pan[0], pan[1], pan[2], v]]);
            if (n % 8 === 7) {
              const th = -3000 + (n % 5) * 100;
              f.mem[`${gate[0]}:${gate[1]}:${gate[2]}`] = th;
              f.pushNotify([[gate[0], gate[1], gate[2], th]]);
            }
            n++;
          }, 500),
        );
        window.setTimeout(() => {
          for (const id of timers) clearInterval(id);
          f.mark("drivers-stopped");
        }, ms);
      },
      {
        ms: 10_000,
        cc: MIDI_CC_LEVEL,
        note: MIDI_NOTE_ON,
        pan: chAddr(P_CH_PAN, 0),
        gate: chAddr(P_GATE_THRESHOLD, 0),
      },
    );

    // (a) The operator: sweeps of key detents with pauses between them. Key steps
    // rather than a synthetic drag, per the harness's driver convention — the value
    // is the subject here, and each press is exactly one plan edit. Every press is
    // marked, because an edit the analyzer was not told about cannot be looked for.
    // The locator is re-resolved on every press because a MIDI or device apply
    // replaces the strip under it (invariant 10's ground), which a held element
    // handle would hide.
    const opDeadline = Date.now() + 10_000;
    let bursts = 0;
    const opEdits: string[] = [];
    while (Date.now() < opDeadline) {
      bursts++;
      const key = bursts % 2 ? "ArrowUp" : "ArrowDown";
      for (let i = 0; i < 10 && Date.now() < opDeadline; i++) {
        const label = `op-${bursts}-${i}`;
        await mark(page, label);
        opEdits.push(label);
        await faderOf(page, "CH 1").press(key);
      }
      await page.waitForTimeout(400);
    }
    await page.waitForFunction(() => window.__urxFake.log.some((e) => e.detail === "drivers-stopped"), null, {
      timeout: 30_000,
    });

    // The window under test is closed; let the queued whole-device sweep finish at a
    // latency CI can afford (see the file header).
    await mark(page, "settle");
    await setLatency(page, { get: 0, set: 0 });
    // settleAfter, not waitQuiet: the drivers stopped a moment ago and the flush that
    // carries the last press is still inside its debounce window, so a bare quiescence
    // check can be answered by silence that has not started yet.
    await settleAfter(page, "settle", 1500, 10_000);

    const screen = (await faderReadout(page, "CH 1").textContent())!;
    const screenOn = await powerOf(page, "CH 1").getAttribute("aria-pressed");
    // Rebuild the strips from the plan: the console paints from the plan, so a
    // difference here is a stale paint rather than a stale plan — the third of the
    // three descriptions that must agree.
    await page.click("#btn-view-graph");
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    const rebuilt = (await faderReadout(page, "CH 1").textContent())!;
    const rebuiltOn = await powerOf(page, "CH 1").getAttribute("aria-pressed");

    const mem = await memOf(page);
    const trace = await traceOf(page);
    const all = spans(trace);
    const findings = analyze(trace, {
      edits: opEdits.map((label) => ({ label, addr: CH1_FADER, at: markTime(trace, label)! })),
      registration: await paramAddrsOf(page),
      registrationWindow: { from: lastRegistrationAt(trace) },
    });

    console.log(timeline(trace, { from: markTime(trace, opEdits[0])! - 200, limit: 160 }));
    console.log(report("three operators, one node", findings));
    console.log(
      `operator bursts=${bursts} presses=${opEdits.length} ` +
        `writes(139:0:0)=${all.filter((s) => s.cmd === "vd_set" && s.addr === CH1_FADER).length} ` +
        `reads=${all.filter((s) => s.cmd === "vd_get").length} ` +
        `overlaps=${overlapKinds(findings).join("+") || "none"} ` +
        `reconciles=${trace.filter((e) => e.kind === "status" && /← device/.test(e.detail ?? "")).length} ` +
        `flushes=${trace.filter((e) => e.kind === "status" && /→ device/.test(e.detail ?? "")).length}`,
    );
    // Pan and the gate threshold are moved by the fake alone here — no operator
    // gesture, no MIDI mapping, no plan funnel touches either. A vd_set on one of
    // them is therefore the app pushing a device-originated value back at the device.
    const pushedBack = all.filter((s) => s.cmd === "vd_set" && (s.addr === "141:0:0" || s.addr === "29:0:0"));
    console.log(
      `converge: screen=${screen} rebuilt=${rebuilt} device=${deviceLevelText(mem[CH1_FADER])} | ` +
        `chOn screen=${screenOn} rebuilt=${rebuiltOn} device=${mem[CH1_ON] ?? 0} | ` +
        `device-originated values written back=${pushedBack.length} ` +
        `(${pushedBack
          .slice(0, 4)
          .map((s) => `${s.addr}=${s.value}@${s.start.toFixed(0)}ms`)
          .join(" ")})`,
    );

    // The convergence assertion, and the reason this case exists: after everything
    // stops, the plan (via the rebuilt strips), the screen and the device's own state
    // map must be one value. A divergence here is the failure the whole harness is
    // for — no single gesture is responsible for it.
    expect(screen).toBe(deviceLevelText(mem[CH1_FADER]));
    expect(rebuilt).toBe(screen);
    expect(rebuiltOn).toBe(screenOn);
    expect(screenOn).toBe(String((mem[CH1_ON] ?? 0) === 1));
    // All three writers really did drive the channel, or "it converged" is vacuous:
    // the operator's presses reached the device, MIDI was applied, and the device's own
    // movement was reflected back (the "← device" status is the app naming a follow).
    expect(bursts).toBeGreaterThan(1);
    expect(all.filter((s) => s.cmd === "vd_set" && s.addr === CH1_FADER).length).toBeGreaterThan(2);
    // Bytes the driver pushed in — the delivery precondition, not evidence that the
    // engine did anything with them.
    expect(trace.filter((e) => e.kind === "notify" && e.cmd === "midi").length).toBeGreaterThan(2);
    // The MIDI writer's own footprint: CH_ON has exactly one author in this run. The
    // operator only presses arrows on the fader and the fake only notifies pan and the
    // gate threshold, so a vd_set on 140:0:0 can only have come from the note mapping
    // — i.e. a MIDI-authored value reached the plan AND the device. Without this the
    // MIDI arm is only "bytes were pushed at the app".
    expect(all.filter((s) => s.cmd === "vd_set" && s.addr === CH1_ON).length).toBeGreaterThan(0);
    expect(trace.filter((e) => e.kind === "notify" && e.addr === "141:0:0").length).toBeGreaterThan(5);
    expect(trace.filter((e) => e.kind === "status" && /← device/.test(e.detail ?? "")).length).toBeGreaterThan(0);
    // Invariant 4, in the kind this case is about: with three writers on one link the
    // app does issue writes while a readback of the same session is in flight — it does
    // not serialize the two directions. Only the existence of the overlap is asserted;
    // which kinds occurred is logged above and varies. The reported pair is the FIRST of
    // its kind, so requiring it before the settle mark keeps the cutoff the private
    // counter carried: past that mark the link runs on the driver's latency, not the
    // profile under test.
    const readWrite = findings.find((f) => f.inv === 4 && f.detail.startsWith("read-write"));
    expect(readWrite).toBeDefined();
    expect(readWrite!.at!).toBeLessThan(markTime(trace, "settle")!);

    // PINNED, and a defect rather than a property (the *.audit.test.ts convention):
    // a device-side change the follow layer applied is written straight back out to
    // the device BY THE NEXT FLUSH, even though nothing in the app authored it. It is
    // harmless while the control is standing still — the value being written is the
    // one the device just reported — but it is exactly the wrong thing to do to a
    // knob a second pair of hands is still turning, and it is authorship (invariant
    // 13) that the trace cannot resolve: the write looks identical to an operator's.
    //
    // The scope matters, and it is what reconciles this with t5-drop's opposite-looking
    // "nothing was written back": there is no timer that pushes a followed value out on
    // its own. A flush has to be raised by an app-side edit first, and then it carries
    // the whole changed set — including keys only the device authored. t5 makes no edit
    // after goLive, so no flush ever runs there and no write-back is possible; this case
    // presses arrows for ten seconds, so flushes run throughout, and only this one has a
    // flush to observe.
    //
    // MEASURED INTERMITTENT (2026-08-01), which is why the count is not asserted in
    // either direction: the same tree produced 8 write-backs running this file alone and
    // 0 running the whole tier at --workers=4. The direct-follow journal (live.ts) closed
    // the interleaving where a reconcile's capture erased the snapshot entry noteDirect
    // had written; whatever produces the remaining ones is a different path and is not
    // yet localised. Asserting > 0 fails the loaded run and asserting 0 fails the light
    // one, so the run reports the count and the tier's ladders own the verdict until a
    // case can place the window deterministically.
    console.log(`pushed-back device-originated writes: ${pushedBack.length} (intermittent — not asserted)`);
    // What IS deterministic here: the flushes were real, so a zero above is never
    // "nothing was sent".
    expect(all.filter((s) => s.cmd === "vd_set" && s.addr === CH1_FADER).length).toBeGreaterThan(0);

    // The tier's own rule: an invariant that fires here must already be localised by
    // a named ladder. 1 and 4 are overtake-scoped-readback-vs-edit-ladder, 2 is
    // overtake-edit-during-refetch-await, 6 is the registration-lag observation. A
    // firing outside that set is a gap in the catalog, not a result of this case.
    expect(invSet(findings).filter((n) => ![1, 2, 4, 6].includes(n))).toEqual([]);
  });

  // stress-seeded-schedule-fuzz. A seeded schedule over a small gesture vocabulary,
  // run twice from the same seed in the same test: the determinism claim is what
  // makes a fuzz hit reducible to a ladder rather than folklore, so it is asserted
  // rather than assumed. The schedule runs inside the page (see the file header) and
  // the fake's jitter is seeded from the same number.
  //
  // Duration reduced: the catalog runs 5 minutes × 20 seeds, here 30 gestures (~5 s)
  // × 2 runs of one seed.
  test("the same seed produces the same finding set twice", async ({ browser }) => {
    test.setTimeout(180_000);
    const SEED = 8_0001;

    const runOnce = async (): Promise<{ findings: Finding[]; screen: string; device: string; schedule: string }> => {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await installFake(page, { seed: SEED, storage: midiStorage() });
        await page.goto("/");
        await expect(page.locator("#model-picker")).toHaveValue("URX44V");
        await goLive(page);
        await page.click("#btn-view-console");
        await expect(faderReadout(page, "CH 1")).toBeVisible();
        await setJitter(page, 20);

        await mark(page, "fuzz-start");
        await page.evaluate(
          ({ seed, gestures, cc, pan, gate }) => {
            const f = window.__urxFake;
            // The same LCG the fake uses for its jitter, so one number decides the
            // gesture order, the gaps and the link's behaviour together.
            let s = seed >>> 0;
            const rnd = (): number => {
              s = (s * 1664525 + 1013904223) >>> 0;
              return s / 4294967296;
            };
            const draws: string[] = [];
            const pick = <T>(list: readonly T[]): T => {
              const i = Math.floor(rnd() * list.length);
              draws.push(String(i));
              return list[i];
            };
            const gaps = [5, 40, 120, 180, 300, 450] as const;
            const lats = [8, 25, 100] as const;
            const stripOf = (name: string): Element | undefined =>
              [...document.querySelectorAll(".con-strip")].find((el) => el.textContent?.includes(name));
            const key = (which: string): void => {
              const fader = stripOf("CH 1")?.querySelector(".con-fader");
              fader?.dispatchEvent(new KeyboardEvent("keydown", { key: which, bubbles: true, cancelable: true }));
            };
            let ccVal = 0;
            let panVal = 0;
            const vocabulary = [
              () => key("ArrowUp"),
              () => key("ArrowDown"),
              () => f.pushMidi([[0xb0, cc, (ccVal = (ccVal + 37) % 128)]]),
              () => {
                panVal = ((panVal + 11) % 61) - 30;
                f.mem[`${pan[0]}:${pan[1]}:${pan[2]}`] = panVal;
                f.pushNotify([[pan[0], pan[1], pan[2], panVal]]);
              },
              () => {
                f.mem[`${gate[0]}:${gate[1]}:${gate[2]}`] = -2500;
                f.pushNotify([[gate[0], gate[1], gate[2], -2500]]);
              },
            ];
            // A fixed gesture count rather than a deadline: a wall-clock stop would
            // make the schedule's length depend on machine load, which is the one
            // thing a seeded schedule must not do.
            let left = gestures;
            const step = (): void => {
              if (left-- <= 0) {
                f.mark(`fuzz-done:${draws.join("")}`);
                return;
              }
              // Link behaviour is redrawn per gesture, so the three-way interleaving
              // (gesture × notify × latency) is part of what the seed decides.
              const lat = pick(lats);
              f.setLatency({ get: lat, set: lat });
              pick(vocabulary)();
              window.setTimeout(step, pick(gaps));
            };
            step();
          },
          { seed: SEED, gestures: 30, cc: MIDI_CC_LEVEL, pan: chAddr(P_CH_PAN, 0), gate: chAddr(P_GATE_THRESHOLD, 0) },
        );
        await page.waitForFunction(
          () => window.__urxFake.log.some((e) => (e.detail ?? "").startsWith("fuzz-done:")),
          null,
          { timeout: 60_000 },
        );

        await mark(page, "settle");
        await setJitter(page, 0);
        await setLatency(page, { get: 0, set: 0 });
        await settleAfter(page, "settle", 1500, 10_000);

        const screen = (await faderReadout(page, "CH 1").textContent())!;
        const mem = await memOf(page);
        const trace = await traceOf(page);
        const start = markTime(trace, "fuzz-start")!;
        const findings = analyze(trace, {
          edits: [{ label: "fuzz schedule (ch1 fader)", addr: CH1_FADER, at: start }],
          registration: await paramAddrsOf(page),
          registrationWindow: { from: lastRegistrationAt(trace) },
        });
        // Every draw the schedule made, in order (gesture / latency / gap indices).
        // Logged for reducibility — which gesture order produced a firing — and NOT
        // asserted: the draws come from a page-side LCG seeded with a literal over a
        // fixed iteration count, so their identity across runs is arithmetic and says
        // nothing about the app.
        const schedule = (trace.find((e) => (e.detail ?? "").startsWith("fuzz-done:"))?.detail ?? "").slice(
          "fuzz-done:".length,
        );
        console.log(timeline(trace, { from: start - 100, limit: 120 }));
        console.log(report(`seeded fuzz (seed ${SEED})`, findings));
        console.log(`schedule=${schedule} screen=${screen} device=${deviceLevelText(mem[CH1_FADER])}`);
        return { findings, screen, device: deviceLevelText(mem[CH1_FADER]), schedule };
      } finally {
        await context.close();
      }
    };

    const a = await runOnce();
    const b = await runOnce();
    console.log(`seed ${SEED}: run A invariants=[${invSet(a.findings)}] run B invariants=[${invSet(b.findings)}]`);

    // The determinism requirement itself: a firing that does not reproduce under its
    // own seed cannot be reduced to a ladder case, and is worthless as a finding.
    expect(invSet(b.findings)).toEqual(invSet(a.findings));
    // And the gap check: everything the fuzz found is already localised by a named
    // ladder (1 / 4 = overtake-scoped-readback-vs-edit-ladder, 2 =
    // overtake-edit-during-refetch-await, 6 = the registration-lag observation).
    expect(invSet(a.findings).filter((n) => ![1, 2, 4, 6].includes(n))).toEqual([]);
    // Both runs settle with the device holding what the screen shows, and — the
    // sharpest form of the determinism claim — on the same value.
    expect(a.screen).toBe(a.device);
    expect(b.screen).toBe(b.device);
    expect(b.screen).toBe(a.screen);
  });

  // stress-latency-jitter-storm. The same edit script at 250 ms fixed latency and at
  // 250 ± 150 ms, in one test: jitter is the one input that varies how long an answer
  // takes to come back, and the fixed-latency partner is what separates "the link is
  // slow" from "the link is slow by a different amount every time".
  //
  // It does NOT reorder anything — see the withdrawn arm at the head of this file.
  //
  // The operator drives DETENTS, not a pointer sweep. A sweep's landing value is
  // whatever the last synthetic clientY happened to map to, so the only thing the run
  // could assert about it was that the screen and the device agreed — which any
  // mutually consistent end state satisfies, including the one this case exists to
  // exclude (a stale read overwrote the plan mid-gesture and the app then wrote that
  // stale value back out). A fixed train of ±1 detents has a landing value the test
  // can compute for itself, off the same grid the app steps on, and that value is what
  // the device is required to hold.
  //
  // Duration reduced: the catalog drags for 20 s, here ~6 s per run.
  test("a jittering link spreads the answers, and the edit train still lands on the device", async ({ browser }) => {
    test.setTimeout(180_000);

    // 240 ticks of 25 ms = the 6 s the drivers run for. Up 9 / down 9 keeps the
    // trajectory inside the grid (start is 0.0 dB = detent 30 of 40, so it never
    // reaches an end stop where steps would be silently swallowed), and the count is
    // not a whole number of periods, so the train ends off its starting point: a run
    // that lost every edit and a run that landed correctly cannot both pass.
    const TRAIN: number[] = Array.from({ length: 240 }, (_, i) => (i % 18 < 9 ? 1 : -1));

    const runTrain = async (
      jitter: number,
    ): Promise<{
      screen: string;
      device: string;
      expected: string;
      landed: boolean;
      queueDepth: number;
      spread: number;
      overlaps: string;
      findings: Finding[];
    }> => {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await installFake(page, { seed: 4242 });
        await page.goto("/");
        await expect(page.locator("#model-picker")).toHaveValue("URX44V");
        await goLive(page);
        await page.click("#btn-view-console");
        await expect(faderReadout(page, "CH 1")).toBeVisible();
        await setLatency(page, { get: 250, set: 250 });
        await setJitter(page, jitter);

        // Where the train starts from, read off the device rather than assumed, and
        // where it must end: the app steps the same LEVEL_STEPS_DB grid one detent per
        // Arrow key (src/ui/console.ts faderKeyStep → core/levels stepLevel), so the
        // landing value follows from the train alone — unless something else wrote the
        // plan, which is the failure under test.
        const startRaw = (await memOf(page))[CH1_FADER] ?? 0;
        const expectedRaw = Math.round(TRAIN.reduce((db, d) => stepLevel(db, d), startRaw / 100) * 100);

        await mark(page, "train-start");
        await page.evaluate(
          ({ ms, tick, train, fader, gate }) => {
            const f = window.__urxFake;
            const timers: number[] = [];
            // The run ends when the train is exhausted AND the notify drivers' deadline
            // has passed — never on the deadline alone. A timer that drifts under load
            // would otherwise cut the train short, and a truncated train has a
            // different landing value than the one the test computed.
            let trainDone = false;
            let deadlineHit = false;
            const stopped = (): void => {
              if (trainDone && deadlineHit) f.mark("train-drivers-stopped");
            };
            let t = 0;
            const keys = window.setInterval(() => {
              if (t >= train.length) {
                window.clearInterval(keys);
                trainDone = true;
                stopped();
                return;
              }
              // The strip is re-resolved every tick: a follow apply replaces it, and a
              // held element handle would send keys to a detached node.
              const strip = [...document.querySelectorAll(".con-strip")].find((el) => el.textContent?.includes("CH 1"));
              strip?.querySelector(".con-fader")?.dispatchEvent(
                new KeyboardEvent("keydown", {
                  key: train[t] > 0 ? "ArrowUp" : "ArrowDown",
                  bubbles: true,
                  cancelable: true,
                }),
              );
              t++;
            }, tick);
            // Deliberately NOT in `timers`: the deadline below stops the notify
            // drivers, and the train must be allowed to run to its last detent — 240
            // ticks of 25 ms drift past 6000 ms on any real machine.

            // Genuine device movement on two other channels, direct-follow, in bursts
            // rather than a continuous stream: a continuous one would re-arm the
            // 300 ms settle forever and the follow layer would never read anything.
            let n = 0;
            timers.push(
              window.setInterval(() => {
                const v = -2000 + ((n * 137) % 3000);
                const list: Array<[number, number, number, number]> = [];
                for (const ch of [1, 2]) {
                  f.mem[`${fader}:0:${ch}`] = v;
                  list.push([fader, 0, ch, v]);
                }
                f.pushNotify(list);
                n++;
              }, 600),
            );
            // A scoped param on a third channel, three times across the train: its
            // settle turns into a readback of that node, which is the second chain on
            // the link (and the later two land while the first is still reading, so
            // the reconcile's pending replay is exercised too). Without it the whole
            // run is a single chain — a direct-only window re-bases and reads nothing
            // — and a single chain cannot be reordered by anything. Three distinct
            // controls per window is the concentration ceiling: a fourth would
            // escalate every settle to a full re-read of the device.
            for (const [at, v] of [
              [1500, -2500],
              [3000, -2400],
              [4500, -2300],
            ] as const) {
              window.setTimeout(() => {
                f.mem[`${gate[0]}:${gate[1]}:${gate[2]}`] = v;
                f.pushNotify([[gate[0], gate[1], gate[2], v]]);
              }, at);
            }
            window.setTimeout(() => {
              for (const id of timers) clearInterval(id);
              deadlineHit = true;
              stopped();
            }, ms);
          },
          {
            ms: 6000,
            tick: 25,
            train: TRAIN,
            fader: P_CH_FADER,
            gate: chAddr(P_GATE_THRESHOLD, 3), // CH 4's gate threshold
          },
        );
        await page.waitForFunction(() => window.__urxFake.log.some((e) => e.detail === "train-drivers-stopped"), null, {
          timeout: 60_000,
        });
        await mark(page, "train-done");

        await setJitter(page, 0);
        await setLatency(page, { get: 0, set: 0 });
        // settleAfter, not waitQuiet: the last detent's flush is still inside its
        // debounce window here, and the value the device is left holding is the whole
        // verdict.
        await settleAfter(page, "train-done", 1500, 10_000);

        const screen = (await faderReadout(page, "CH 1").textContent())!;
        const mem = await memOf(page);
        const trace = await traceOf(page);
        const all = spans(trace);
        const trainAt = markTime(trace, "train-start")!;
        const findings = analyze(trace, {
          // With the expected value declared, invariant 2 asks whether the write
          // carrying the TRAIN'S LANDING VALUE left — not whether some write to the
          // address left at some point, which a stale-value flush satisfies too.
          edits: [
            { label: `CH 1 detent train (lands on ${expectedRaw})`, addr: CH1_FADER, at: trainAt, value: expectedRaw },
          ],
          registration: await paramAddrsOf(page),
          registrationWindow: { from: lastRegistrationAt(trace) },
        });
        // Everything measured stops at the train's end: past it the link runs on the
        // driver's settle latency, not the profile under test.
        const doneAt = markTime(trace, "train-done")!;
        const sets = all.filter((s) => s.cmd === "vd_set" && s.addr === CH1_FADER && s.start < doneAt);
        const reflect = sets.map((s) => s.end - s.start).sort((x, y) => x - y);
        const queueDepth = maxQueueDepth(all, trainAt, doneAt);
        const spread = latencySpread(all, trainAt, doneAt);
        const overlaps = overlapKinds(findings).join("+") || "none";
        console.log(timeline(trace, { from: trainAt - 100, limit: 100 }));
        console.log(report(`jitter=${jitter} ms`, findings));
        console.log(
          `jitter=${jitter}: writes(139:0:0)=${sets.length} queueDepth=${queueDepth} ` +
            `spread(p90-p10)=${spread.toFixed(0)} ms overlaps=${overlaps} ` +
            `link p50=${(reflect[Math.floor(reflect.length / 2)] ?? 0).toFixed(0)} ms ` +
            `max=${(reflect[reflect.length - 1] ?? 0).toFixed(0)} ms | screen=${screen} ` +
            `device=${deviceLevelText(mem[CH1_FADER])} expected=${deviceLevelText(expectedRaw)} ` +
            `(start ${deviceLevelText(startRaw)}, ${TRAIN.length} detents)`,
        );
        return {
          screen,
          device: deviceLevelText(mem[CH1_FADER]),
          expected: deviceLevelText(expectedRaw),
          landed: (mem[CH1_FADER] ?? 0) === expectedRaw,
          queueDepth,
          spread,
          overlaps,
          findings,
        };
      } finally {
        await context.close();
      }
    };

    const jittered = await runTrain(150);
    const fixed = await runTrain(0);
    console.log(
      `jitter storm: queue depth ${jittered.queueDepth} vs ${fixed.queueDepth} at fixed latency; ` +
        `latency spread ${jittered.spread.toFixed(0)} ms vs ${fixed.spread.toFixed(0)} ms; ` +
        `overlaps ${jittered.overlaps} vs ${fixed.overlaps}`,
    );

    // Instrument precondition, not a result about the app — but not free either: a
    // depth above 1 is the app holding two chains on the link at once (a flush issued
    // while a reconcile's read is in flight), and a run that kept one chain would make
    // the convergence verdict below a statement about a sequential script rather than
    // about contention. Asserted for BOTH profiles: jitter changes how far apart the
    // answers arrive, not whether the app contends. The spread itself is logged and
    // never asserted — it is the fake's seeded draw, not an app behaviour.
    expect(jittered.queueDepth).toBeGreaterThan(1);
    expect(fixed.queueDepth).toBeGreaterThan(1);
    // The case's own assertion, in both runs: the device is left holding the value the
    // detent train adds up to — not merely a value the screen happens to agree with.
    // A varying answer latency is survivable here because a flush sends the plan's
    // current value rather than a queued stream of them, so a late answer costs a
    // redundant write rather than a wrong one.
    expect(jittered.device).toBe(jittered.expected);
    expect(fixed.device).toBe(fixed.expected);
    expect(jittered.landed).toBe(true);
    expect(fixed.landed).toBe(true);
    // And the screen shows what the device holds: the same value seen from the plan.
    expect(jittered.screen).toBe(jittered.device);
    expect(fixed.screen).toBe(fixed.device);
    // A write CARRYING THAT VALUE left in both runs (the declared edit names it, so
    // this is not satisfied by any write to the address).
    expect(jittered.findings.some((f) => f.inv === 2)).toBe(false);
    expect(fixed.findings.some((f) => f.inv === 2)).toBe(false);
  });

  // stress-long-session-quiescence is not reachable from here. Its assertions are
  // about state that SURVIVES an operation — armed timers, registered listeners, undo
  // stack depth, MIDI bound-cache size, the number of Plan objects still reachable
  // from a writer — and none of those is observable through the four surfaces this
  // harness has (DOM, status line, localStorage, the fake's IPC). Subscription
  // counters alone would pin one of the four assertions and silently pass the rest.
  // It needs the VITE_TRACE build's module-scope probe (docs/{en,ja}/live-race-harness.md,
  // "既知のギャップ"); the 30-minute duration is the smaller obstacle.
  test.skip("a thirty-minute session leaks no subscription, timer or plan", async () => {});
});
