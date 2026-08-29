import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  installFake,
  goLive,
  mark,
  traceOf,
  memOf,
  waitQuiet,
  hasProbe,
  pushNotify,
  dialogsOf,
  divergeAt,
  openMidiWindow,
} from "./fake-device";
import { analyze, report, timeline, markTime, setsOf } from "./analyze";
import { drag, port, tapJack, faceplate } from "../graph-helpers";
import { pickBand, pickPlot } from "../dyn-helpers";
import {
  CH1_FADER,
  closeDynScreen,
  deviceLevelText,
  faderOf,
  faderReadout,
  graphNode,
  openEqScreen,
  strip,
} from "./ui";
import { chooseOption } from "../choose-option";

// T0b baseline sweeps — the reachability half of the T0 floor
// (docs/{en,ja}/live-race-harness.md). The latency ladder in t0-baseline.spec.ts pins
// what ONE known gesture costs; these pin that every operable control on a surface can
// be driven by the driver's vocabulary at all, and — the half that is otherwise
// unobservable — that a gesture the inventory says writes nothing really writes
// nothing.
//
// The negative verdict rests entirely on the probe's plan-key write ledger
// (src/ui/trace-probe.ts). Without it "this gesture wrote nothing" and "this gesture
// wrote something the harness cannot see" are the same observation, so every sweep
// asserts the probe is present first.
//
// Each gesture is classified three ways rather than two, because the probe can also
// answer a question the ledger alone cannot:
//
//   reported    — the plan changed and a writer named itself (markChanged → sample).
//   unreported  — the plan changed with no funnel reporting it. The sweep calls
//                 sample("unknown") itself after every gesture, so a mutation that
//                 skipped the funnel is attributed to the gesture that made it
//                 instead of leaking into whatever samples next.
//   silent      — the plan did not change at all.
//
// Five of the six sweeps run OFFLINE: no goLive, so no device command, no flush and
// no readback. That is what "No device" means in the catalog for these cases, and it
// is also what makes them fast. The exception is baseline-view-locale-churn, which
// needs a session because its subject is a full rebuild landing under a captured
// pointer while the device is talking.

const dynBox = (page: Page) => page.locator("#dyn-screen-box");

// ---------------------------------------------------------------------------
// sweep runner
// ---------------------------------------------------------------------------

interface Gesture {
  label: string;
  run: () => Promise<unknown>;
  /** Declared no-write: this gesture is expected to leave the plan untouched. */
  silent?: boolean;
}

interface Outcome {
  label: string;
  reported: number;
  unreported: number;
  fields: string[];
  error?: string;
}

/** Take the plan delta the app did NOT report, and hand back everything the ledger
 *  gained since `from`. One round trip per gesture: the sweeps run 30-120 of them. */
const settleLedger = (page: Page, from: number): Promise<Array<{ source: string; field: string }>> =>
  page.evaluate((i) => {
    const tr = (
      window as unknown as {
        __urxTrace?: { ledger: Array<{ source: string; field: string }>; sample: (s: string) => number };
      }
    ).__urxTrace;
    if (!tr) return [];
    tr.sample("unknown");
    return tr.ledger.slice(i).map((e) => ({ source: e.source, field: e.field }));
  }, from);

const ledgerLength = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __urxTrace?: { ledger: unknown[] } }).__urxTrace?.ledger.length ?? 0);

/**
 * Drive each gesture once, at `spacing`, and record what it did to the plan. Errors
 * are captured rather than thrown so one unreachable control does not hide the
 * remaining thirty; the caller asserts the error list is empty, which is the
 * reachability claim itself.
 */
async function sweep(page: Page, gestures: Gesture[], spacing: number): Promise<Outcome[]> {
  let cursor = await ledgerLength(page);
  await settleLedger(page, cursor); // zero the probe's baseline before the first slot
  cursor = await ledgerLength(page);
  const out: Outcome[] = [];
  for (const g of gestures) {
    await mark(page, `sweep:${g.label}`);
    let error: string | undefined;
    try {
      await g.run();
    } catch (e) {
      error = String(e instanceof Error ? e.message : e)
        .split("\n")[0]
        .slice(0, 140);
    }
    await page.waitForTimeout(spacing);
    const entries = await settleLedger(page, cursor);
    cursor += entries.length;
    out.push({
      label: g.label,
      reported: entries.filter((e) => e.source !== "unknown").length,
      unreported: entries.filter((e) => e.source === "unknown").length,
      fields: [...new Set(entries.map((e) => e.field))].sort(),
      error,
    });
  }
  return out;
}

function printSweep(title: string, outcomes: Outcome[]): void {
  const rows = outcomes.map((o) => {
    const verdict = o.error
      ? `ERROR ${o.error}`
      : o.reported + o.unreported === 0
        ? "— (no plan write)"
        : `${o.reported} reported${o.unreported ? ` + ${o.unreported} UNREPORTED` : ""} [${o.fields.join(",")}]`;
    return `  ${o.label.padEnd(46)} ${verdict}`;
  });
  console.log(`${title}: ${outcomes.length} gesture(s)\n${rows.join("\n")}`);
}

/** The two assertions every sweep makes — every gesture was reachable, and the set
 *  that wrote nothing is exactly the set declared to write nothing — kept together so
 *  a new sweep cannot quietly drop the second one, which is the whole point. */
function assertSweep(outcomes: Outcome[], gestures: Gesture[]): void {
  expect(outcomes.map((o) => (o.error ? `${o.label}: ${o.error}` : null)).filter(Boolean)).toEqual([]);
  expect(outcomes.filter((o) => o.reported + o.unreported === 0).map((o) => o.label)).toEqual(
    gestures.filter((g) => g.silent).map((g) => g.label),
  );
}

/** Findings + timeline, printed by every test so the run log carries the evidence. */
async function dumpTrace(page: Page, title: string): Promise<void> {
  const trace = await traceOf(page);
  console.log(timeline(trace, { limit: 60 }));
  // No report() here: analyze() with an empty spec can only emit invariant 4, and an
  // offline sweep has neither a read nor a write, so the line would print "clean" on
  // every run and read as a verdict it never checked.
}

/** A sweep drives dozens of controls and a control that cannot be reached is a
 *  RESULT, not a reason to spend the whole test budget waiting for it. Playwright's
 *  default action timeout is the test timeout, so one missing element would hang the
 *  run at 180 s with nothing printed; bounded, it lands in the error column with its
 *  own name beside it. */
const GESTURE_TIMEOUT_MS = 4000;

async function boot(page: Page, storage?: Record<string, string>): Promise<void> {
  await installFake(page, storage ? { storage } : {});
  page.setDefaultTimeout(GESTURE_TIMEOUT_MS);
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  // Without the probe the "wrote nothing" half of every assertion below has no input
  // and would pass by being empty — the exact failure mode the harness audit found
  // seventeen of.
  expect(await hasProbe(page)).toBe(true);
}

// ---------------------------------------------------------------------------
// gesture primitives
// ---------------------------------------------------------------------------

/** Press, move in steps, release — the shape every "drag N px" slot in the catalog
 *  takes. Relative to the target's centre. */
async function dragBy(page: Page, target: Locator, dx: number, dy: number, steps: number): Promise<void> {
  // The console's strip rack scrolls horizontally and a preceding slot may have left
  // this control off screen; a synthesized press at an off-viewport coordinate lands
  // nowhere and would be recorded as "the control wrote nothing".
  await target.scrollIntoViewIfNeeded();
  const b = (await target.boundingBox())!;
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(x + (dx * i) / steps, y + (dy * i) / steps);
  await page.mouse.up();
}

async function wheelOn(page: Page, target: Locator, dy: number): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const b = (await target.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.wheel(0, dy);
}

/** Focus a control and press a key — the most robust value gesture there is, and the
 *  one the harness document prefers when the value rather than the pointer is the
 *  subject. */
async function keyOn(target: Locator, key: string): Promise<void> {
  await target.focus();
  await target.press(key);
}

const menuItem = async (page: Page, menu: string, item: string): Promise<void> => {
  await page.click(menu);
  await page.click(item);
};

// ---------------------------------------------------------------------------
// baseline-graph-surface-sweep
// ---------------------------------------------------------------------------

test.describe("T0b baseline sweeps", () => {
  test("baseline-graph-surface-sweep: every GRAPH gesture is reachable, and the silent ones are silent", async ({
    page,
  }) => {
    await boot(page);

    const overlay = page.locator("#graph-host .note-edit-overlay");
    const wire = (from: string, to: string) => page.locator(`.wire-hit[data-from="${from}"][data-to="${to}"]`);
    const host = page.locator("#graph-host");

    // The catalog names ch1:out → bus.mix1:in; on the factory URX44V plan that send
    // already exists as a fixed wire, so the slot uses the nearest pair that is
    // genuinely unwired. Marquee selection is deliberately absent — it does not exist
    // in this revision.
    const gestures: Gesture[] = [
      { label: "select a node (click ch1)", run: () => graphNode(page, "ch1").click(), silent: true },
      {
        label: "Ctrl+click a second node",
        run: () => graphNode(page, "ch2").click({ modifiers: ["Control"] }),
        silent: true,
      },
      {
        label: "Ctrl+click a third node",
        run: () => graphNode(page, "ch3").click({ modifiers: ["Control"] }),
        silent: true,
      },
      { label: "clear the multi-selection (action bar)", run: () => page.click(".selbar-clear"), silent: true },
      { label: "drag a node 60 px in 8 steps", run: () => dragBy(page, faceplate(page, "ch1"), 60, 0, 8) },
      {
        label: "hold a node still 500 ms (path trace)",
        run: async () => {
          const b = (await faceplate(page, "ch1").boundingBox())!;
          await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
          await page.mouse.down();
          await page.waitForTimeout(500);
          await page.mouse.up();
        },
        silent: true,
      },
      {
        label: "press the pen on a note-less node",
        run: async () => {
          await graphNode(page, "ch2").locator(".note-add").click();
          await expect(overlay).toBeVisible();
        },
        silent: true,
      },
      { label: "type 6 chars into the note editor", run: () => overlay.pressSequentially("abcdef") },
      {
        label: "Escape (commit the note)",
        run: async () => {
          await page.keyboard.press("Escape");
          await expect(overlay).toHaveCount(0);
        },
        silent: true,
      },
      { label: "toggle note collapse", run: () => graphNode(page, "ch2").locator(".note-toggle").click() },
      {
        label: "double-press a node with a collapsed note",
        run: async () => {
          await graphNode(page, "ch2").dblclick();
          await expect(overlay).toBeVisible();
        },
      },
      {
        label: "Escape (leave the note editor)",
        run: async () => {
          await page.keyboard.press("Escape");
          await expect(overlay).toHaveCount(0);
        },
        silent: true,
      },
      {
        // Every channel input already carries a source on the factory plan, so this
        // drop is refused — and a refused connection is one of the few gestures whose
        // no-write can be asserted rather than assumed.
        label: "drag onto an occupied single-source input (refused)",
        run: () => drag(page, port(page, "in.micline_1_2:out"), port(page, "ch_5_6:in")),
        silent: true,
      },
      {
        label: "select a wire (matched pointerdown / pointerup)",
        run: async () => {
          await wire("in.micline_1_2:out", "ch1:in").dispatchEvent("pointerdown");
          await wire("in.micline_1_2:out", "ch1:in").dispatchEvent("pointerup");
          await expect(page.locator("#inspector button.danger")).toHaveCount(1);
        },
        silent: true,
      },
      { label: "delete that wire from the inspector", run: () => page.click("#inspector button.danger") },
      {
        label: "drag in.micline_1_2:out → ch1:in (recreate)",
        run: () => drag(page, port(page, "in.micline_1_2:out"), port(page, "ch1:in")),
      },
      {
        // The unmatched pointerdown every e2e spec uses to select a wire. Kept in the
        // vocabulary deliberately: it leaves the history's press state "down".
        label: "select a wire by dispatched pointerdown",
        run: async () => {
          await wire("in.micline_1_2:out", "ch1:in").dispatchEvent("pointerdown");
          await expect(page.locator("#inspector button.danger")).toHaveCount(1);
        },
        silent: true,
      },
      { label: "Delete the selected wire", run: () => page.keyboard.press("Delete") },
      {
        // microSD Rec track 7 is the one recorder input the factory plan leaves free,
        // so it is the only target a Rec Point tap can actually reach on a fresh plan.
        label: "drag the ch_5_6 Rec Point tap → out.sdrec.t7:in",
        run: () => drag(page, tapJack(page, "ch_5_6:out"), port(page, "out.sdrec.t7:in")),
      },
      {
        label: "pan the empty canvas",
        run: async () => {
          const b = (await host.boundingBox())!;
          await page.mouse.move(b.x + b.width - 40, b.y + b.height - 40);
          await page.mouse.down();
          await page.mouse.move(b.x + b.width - 120, b.y + b.height - 90, { steps: 6 });
          await page.mouse.up();
        },
        silent: true,
      },
      { label: "wheel-zoom two notches", run: () => wheelOn(page, host, -240), silent: true },
      { label: "Escape (clear the selection)", run: () => page.keyboard.press("Escape"), silent: true },
      {
        label: "multi-select two nodes and press Hide",
        run: async () => {
          await graphNode(page, "in.aux").click({ modifiers: ["Control"] });
          await graphNode(page, "in.sdplay").click({ modifiers: ["Control"] });
          await page.click(".selbar-hide");
        },
      },
      {
        label: "hide one node from the inspector",
        run: async () => {
          await graphNode(page, "in.usbsub").click();
          await page.click("#inspector button.subtle");
        },
      },
      { label: "View > Hide unused", run: () => menuItem(page, "#btn-view", "#btn-hide-unused") },
      { label: "restore one shelf chip", run: () => page.locator(".hidden-shelf .chip").first().click() },
      { label: "Show all", run: () => page.click(".shelf-showall") },
      { label: "View > Arrange", run: () => menuItem(page, "#btn-view", "#btn-auto") },
      { label: "View > label source", run: () => menuItem(page, "#btn-view", "#btn-labels"), silent: true },
      { label: "View > hide off sends", run: () => menuItem(page, "#btn-view", "#btn-hide-off"), silent: true },
    ];

    const outcomes = await sweep(page, gestures, 300);
    printSweep("GRAPH surface sweep", outcomes);
    await dumpTrace(page, "graph surface sweep");

    assertSweep(outcomes, gestures);

    // Pinned behaviour, and the one surprise on this surface: a double-press that the
    // operator reads as "open the note editor" is a plan edit — it expands the note,
    // rewriting `noteCollapsed` before a character is typed, which is an undo entry
    // and (under Live sync) a scheduled flush. It does go through the change funnel,
    // so the write is attributed; what it is not is a read-only gesture.
    const dbl = outcomes.find((o) => o.label === "double-press a node with a collapsed note")!;
    expect(dbl.fields).toEqual(["noteCollapsed"]);
    // Nothing on the graph mutates the plan behind the funnel's back.
    // `unreported > 0` alone, not `reported === 0 && unreported > 0`: a gesture that
    // reports SOME of its keys and writes others behind the funnel is exactly the shape
    // the inspector sweep found (6 reported + 1 unreported), and the narrower predicate
    // cannot see it.
    expect(outcomes.filter((o) => o.unreported > 0).map((o) => o.label)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // baseline-console-surface-sweep
  // -------------------------------------------------------------------------

  test("baseline-console-surface-sweep: every CONSOLE control is reachable, and the rack keeps its scroll", async ({
    page,
  }) => {
    await boot(page);
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();

    const ch1 = strip(page, "CH 1");
    const st = strip(page, "CH 5/6");
    const col = (name: string, send: string) =>
      strip(page, name).locator(".con-scol", { has: page.getByRole("button", { name: send, exact: true }) });
    const chip = (s: Locator, name: string) => s.getByRole("button", { name, exact: true });
    const knob = (s: Locator, label: string) => s.locator(`.con-knob[aria-label='${label}']`);
    const rack = page.locator(".con-strips");

    const gestures: Gesture[] = [
      {
        // Off the cap, and far enough off that the fraction survives a shorter fader:
        // the cap is ~14 % of the travel at the harness's viewport, centred on the
        // factory 0 dB at 25 %, so 0.3 was inside it and this gesture silently became
        // the grab below.
        label: "main fader jump-to-click",
        run: async () => {
          const b = (await faderOf(page, "CH 1").boundingBox())!;
          await page.mouse.click(b.x + b.width / 2, b.y + b.height * 0.6);
        },
      },
      {
        // The other half of the press: on the cap it is grabbed where it is, so the
        // press alone writes nothing — and nothing reaches the unit until the pointer
        // actually moves.
        label: "main fader cap grab",
        run: async () => {
          const c = (await faderOf(page, "CH 1").locator(".cap").boundingBox())!;
          await page.mouse.click(c.x + c.width / 2, c.y + c.height / 2);
        },
        silent: true,
      },
      { label: "main fader drag 40 px in 6 steps", run: () => dragBy(page, faderOf(page, "CH 1"), 0, 40, 6) },
      { label: "fader ArrowUp", run: () => keyOn(faderOf(page, "CH 1"), "ArrowUp") },
      { label: "fader PageDown", run: () => keyOn(faderOf(page, "CH 1"), "PageDown") },
      { label: "fader Home", run: () => keyOn(faderOf(page, "CH 1"), "Home") },
      { label: "fader End", run: () => keyOn(faderOf(page, "CH 1"), "End") },
      { label: "fader wheel one notch", run: () => wheelOn(page, faderOf(page, "CH 1"), -120) },
      { label: "fader double-click reset", run: () => faderOf(page, "CH 1").dblclick() },
      // Upward: the fixed sends ship at -∞, so a downward drag has nowhere to go and
      // its "no write" would be the grid's floor rather than the control's.
      { label: "send column drag 30 px", run: () => dragBy(page, col("CH 1", "M1").locator(".con-vfad"), 0, -30, 6) },
      { label: "send column ArrowUp", run: () => keyOn(col("CH 1", "M1").locator(".con-vfad"), "ArrowUp") },
      { label: "send column wheel", run: () => wheelOn(page, col("CH 1", "M1").locator(".con-vfad"), -120) },
      { label: "send column double-click reset", run: () => col("CH 1", "M1").locator(".con-vfad").dblclick() },
      { label: "hover a send column", run: () => col("CH 1", "M2").locator(".con-vfad").hover(), silent: true },
      { label: "send enable chip", run: () => chip(col("CH 1", "M1"), "M1").click() },
      { label: "PRE/POST chip", run: () => col("CH 1", "M1").locator(".con-slp").click() },
      { label: "collapse the SENDS rack", run: () => ch1.locator(".con-sh").click(), silent: true },
      { label: "expand the SENDS rack", run: () => ch1.locator(".con-sh").click(), silent: true },
      {
        label: "open the SEND PAN popover",
        run: async () => {
          await ch1.locator(".con-panbtn").click();
          await expect(page.locator(".con-spop")).toBeVisible();
        },
        silent: true,
      },
      {
        label: "drag the send pan knob 40 px",
        run: () => dragBy(page, page.locator(".con-spop .con-knob").first(), 0, -40, 6),
      },
      {
        label: "Escape (dismiss the SEND PAN popover)",
        run: async () => {
          await page.keyboard.press("Escape");
          await expect(page.locator(".con-spop")).toBeHidden();
        },
        silent: true,
      },
      {
        label: "open the meter-point badge",
        run: async () => {
          await ch1.locator(".con-tap").click();
          await expect(page.locator(".con-tappop")).toBeVisible();
        },
        silent: true,
      },
      {
        label: "choose a different tap",
        run: () => page.locator(".con-tappop .crow", { has: page.getByText("PRE EQ", { exact: true }) }).click(),
        silent: true,
      },
      {
        label: "press outside to dismiss the badge",
        run: async () => {
          await ch1.locator(".con-tap").click();
          await expect(page.locator(".con-tappop")).toBeVisible();
          await page.click("#statusbar", { position: { x: 4, y: 4 } });
          await expect(page.locator(".con-tappop")).toBeHidden();
        },
        silent: true,
      },
      { label: "scribble power LED", run: () => ch1.locator(".con-scribble").click() },
      { label: "MUTE chip", run: () => chip(ch1, "MUTE").click() },
      { label: "+48 chip", run: () => chip(ch1, "+48").click() },
      { label: "polarity chip", run: () => chip(ch1, "φ").click() },
      { label: "HPF chip", run: () => chip(ch1, "HPF").click() },
      // Hi-Z is a CH 3 / CH 4 input on this model, not CH 1.
      { label: "Hi-Z chip (CH 3)", run: () => chip(strip(page, "CH 3"), "Hi-Z").click() },
      { label: "GATE chip", run: () => chip(ch1, "GATE").click() },
      { label: "COMP chip", run: () => chip(ch1, "COMP").click() },
      { label: "EQ chip", run: () => chip(ch1, "EQ").click() },
      // The INS FX pair is three gestures, not one: the disclosure opens the type list
      // and writes nothing, picking an effect writes the pair, and only then is there an
      // insert for the face to switch out. Pressing the face first is deliberately silent
      // — a strip holding nothing has nothing to bypass, and it opens the list instead.
      {
        label: "open the INS FX type popover",
        run: async () => {
          await ch1.locator(".con-ifxopen").click();
          await expect(page.locator(".con-ifxpop")).toBeVisible();
        },
        silent: true,
      },
      {
        // …and choosing one opens its screen, which every step after this is behind.
        label: "choose an insert effect",
        run: async () => {
          await page.locator(".con-ifxpop .irow", { hasText: "Clean" }).first().click();
          await closeDynScreen(page);
        },
      },
      { label: "INS FX face (bypass)", run: () => ch1.locator(".con-ifxface").click() },
      { label: "DUCKER chip (stereo strip)", run: () => chip(st, "DUCKER").click() },
      { label: "C.INT chip (monitor)", run: () => chip(strip(page, "MONITOR 1"), "C.INT").click() },
      { label: "MONO chip (monitor)", run: () => chip(strip(page, "MONITOR 1"), "MONO").click() },
      { label: "A.GAIN knob drag", run: () => dragBy(page, knob(ch1, "A.GAIN"), 0, -20, 5) },
      { label: "D.GAIN knob drag (stereo strip)", run: () => dragBy(page, knob(st, "D.GAIN"), 0, -20, 5) },
      { label: "PAN knob", run: () => keyOn(knob(ch1, "PAN"), "ArrowRight") },
      { label: "bus master BAL knob", run: () => keyOn(knob(strip(page, "STEREO"), "BAL"), "ArrowRight") },
      { label: "PHONES knob", run: () => keyOn(knob(strip(page, "MONITOR 1"), "PHONES"), "ArrowUp") },
      { label: "OSC LEVEL knob", run: () => keyOn(knob(strip(page, "OSCILLATOR"), "LEVEL"), "ArrowUp") },
      { label: "STREAMING DELAY chip", run: () => chip(strip(page, "STREAMING"), "DELAY").click() },
      { label: "STREAMING TIME knob", run: () => keyOn(knob(strip(page, "STREAMING"), "TIME"), "ArrowUp") },
      {
        label: "STREAMING TIME knob with Shift",
        run: async () => {
          await knob(strip(page, "STREAMING"), "TIME").focus();
          await page.keyboard.down("Shift");
          await knob(strip(page, "STREAMING"), "TIME").press("ArrowUp");
          await page.keyboard.up("Shift");
        },
      },
      {
        label: "scroll the strip rack to the end",
        run: () => rack.evaluate((el) => void (el.scrollLeft = el.scrollWidth)),
        silent: true,
      },
    ];

    const outcomes = await sweep(page, gestures, 250);
    // The scroll offset the rack was left on, and what it is after a control that
    // forces a full re-render. The click is DISPATCHED rather than performed: a real
    // Playwright click scrolls its target into view first, which resets scrollLeft
    // before the render even starts and would report the driver's scroll as the app
    // losing the operator's. The E2E project is Chromium-only, so this pins the app's
    // own restore, not the engine's.
    const scrolled = await rack.evaluate((el) => el.scrollLeft);
    await ch1.locator(".con-scribble").dispatchEvent("click"); // unconditional full render
    await page.waitForTimeout(250);
    const afterRender = await rack.evaluate((el) => el.scrollLeft);

    printSweep("CONSOLE surface sweep", outcomes);
    console.log(`strip rack scrollLeft: ${scrolled} → ${afterRender} across a forced render`);
    await dumpTrace(page, "console surface sweep");

    assertSweep(outcomes, gestures);
    expect(scrolled).toBeGreaterThan(0); // the rack really does scroll, or the pin below is vacuous
    expect(afterRender).toBe(scrolled);
    // Every console edit reports itself: the console has no funnel that mutates the
    // plan behind markChanged's back.
    // `unreported > 0` alone, not `reported === 0 && unreported > 0`: a gesture that
    // reports SOME of its keys and writes others behind the funnel is exactly the shape
    // the inspector sweep found (6 reported + 1 unreported), and the narrower predicate
    // cannot see it.
    expect(outcomes.filter((o) => o.unreported > 0).map((o) => o.label)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // baseline-inspector-surface-sweep
  // -------------------------------------------------------------------------

  test("baseline-inspector-surface-sweep: every rendered control on every node kind writes or is declared silent", async ({
    page,
  }) => {
    await boot(page);

    // The inspector is the widest surface in the app and its control set is derived
    // per node kind, so the sweep is derived too: the rendered rows are enumerated
    // from the DOM and each is driven by its own kind. A hand-written list would go
    // stale silently — a row that stopped rendering would simply stop being tested.
    // A control is addressed by (section, position within that section), not by a
    // panel-wide index: several controls reshape the panel (BUS Type drops Pan Link,
    // insert FX select adds its effect's parameters, COMP/EQ Type swaps banks), so a
    // flat index would silently start describing a different row — a sweep that tests
    // the driver. A row with no label of its own (a section's bare ON/OFF pair) is
    // named after its section, which is where the app puts its name too.
    interface Ctl {
      section: string;
      idx: number;
      label: string;
      kind: "range" | "select" | "toggle" | "text" | "swatch";
    }

    const controlsOf = (): Promise<Ctl[]> =>
      page.evaluate(() => {
        const secs = [...document.querySelectorAll("#inspector details.insp-section")];
        const scopes: Array<[string, Element]> = [
          ["", document.getElementById("inspector") as Element],
          ...secs.map((s) => [s.querySelector("summary")?.textContent?.trim() ?? "?", s] as [string, Element]),
        ];
        const out: Array<{ section: string; idx: number; label: string; kind: string }> = [];
        for (const [section, scope] of scopes) {
          const rows = [...scope.querySelectorAll(".param")].filter(
            (r) => section !== "" || !r.closest("details.insp-section"),
          );
          rows.forEach((r, idx) => {
            const own = r.querySelector(".param-label span")?.textContent?.trim();
            const label = own || (section ? `${section} ON` : "(bare)");
            const kind = r.querySelector("input[type=range]")
              ? "range"
              : r.querySelector("select:not([disabled])")
                ? "select"
                : r.querySelector(".toggle button:not([disabled])")
                  ? "toggle"
                  : r.querySelector("input[type=text]")
                    ? "text"
                    : r.querySelector(".swatches button")
                      ? "swatch"
                      : "";
            if (kind) out.push({ section, idx, label, kind });
          });
        }
        return out as Ctl[];
      });

    /** Unfold every collapsed inspector section so its rows are operable. Done with
     *  clicks (the real gesture), and re-checked after each one because a section
     *  toggle re-renders the panel. */
    const unfoldAll = async (): Promise<void> => {
      for (let i = 0; i < 12; i++) {
        const closed = page.locator("#inspector details.insp-section:not([open]) summary");
        if ((await closed.count()) === 0) return;
        await closed.first().click();
      }
    };

    /** The row this control lives in NOW, as a panel-wide index resolved in the page
     *  (one round trip, and no waiting on a selector that may legitimately not exist).
     *  The label wins over the position — a row that moved is still the same control,
     *  while a row that merely sits at the same index after a reshape is a different
     *  one. A folded section is unfolded first: the disclosure, not the control. */
    const resolveRow = async (c: Ctl): Promise<Locator> => {
      const at = await page.evaluate((ctl) => {
        const secs = [...document.querySelectorAll("#inspector details.insp-section")];
        const scope =
          ctl.section === ""
            ? (document.getElementById("inspector") as Element | null)
            : (secs.find((s) => s.querySelector("summary")?.textContent?.trim() === ctl.section) ?? null);
        if (!scope) return -1;
        const rows = [...scope.querySelectorAll(".param")].filter(
          (r) => ctl.section !== "" || !r.closest("details.insp-section"),
        );
        const nameOf = (r: Element): string =>
          r.querySelector(".param-label span")?.textContent?.trim() || (ctl.section ? `${ctl.section} ON` : "(bare)");
        const target =
          rows.find((r) => nameOf(r) === ctl.label) ?? (ctl.label === "(bare)" ? rows[ctl.idx] : undefined);
        if (!target) return -1;
        if (scope instanceof HTMLDetailsElement && !scope.open) scope.open = true;
        return [...document.querySelectorAll("#inspector .param")].indexOf(target);
      }, c);
      if (at < 0) throw new Error(`row "${c.label}" is no longer rendered`);
      return page.locator("#inspector .param").nth(at);
    };

    /** Drive one control by its kind, in a way that is guaranteed to change the
     *  value if the control can change at all: a slider at its maximum answers
     *  ArrowRight with nothing, so both directions are tried before giving up. */
    const drive = async (c: Ctl): Promise<void> => {
      const row = await resolveRow(c);
      if (c.kind === "range") {
        const input = row.locator("input[type=range]").first();
        const before = await input.inputValue();
        await input.focus();
        await input.press("ArrowRight");
        if ((await input.inputValue()) === before) await input.press("ArrowLeft");
        return;
      }
      if (c.kind === "select") {
        const sel = row.locator("select").first();
        const next = await sel.evaluate((s: HTMLSelectElement) => {
          const alt = [...s.options].find((o) => !o.disabled && o.value !== s.value);
          return alt?.value ?? null;
        });
        if (next === null) throw new Error("select offers no alternative option");
        await chooseOption(sel, next);
        return;
      }
      if (c.kind === "toggle") {
        await row.locator(".toggle button:not(.on):not([disabled])").first().click();
        return;
      }
      if (c.kind === "text") {
        await row.locator("input[type=text]").first().pressSequentially("Z");
        return;
      }
      await row.locator(".swatches button").nth(3).click();
    };

    // Every node kind the model has, plus the two selections that are not a node: a
    // wire and (below) the rows a stereo channel adds. The ducker is reached by its
    // own node; SD Rec by the recorder node.
    const KINDS: Array<[string, string]> = [
      ["MONO IN", "ch1"],
      ["ST IN", "ch_5_6"],
      ["MIX bus", "bus.mix1"],
      ["STEREO master", "bus.stereo"],
      ["FX channel", "bus.fx1"],
      ["monitor", "bus.mon1"],
      ["oscillator", "bus.osc"],
      ["STREAMING", "bus.stream"],
      ["SD Rec", "out.sdrec"],
      ["ducker", "out.ducker1"],
    ];

    const WIRE_SEL = '.wire-hit[data-from="ch3:out"][data-to="bus.mix2:in"]';

    // Values first, structure last. The controls that reshape the panel are the
    // selects (BUS Type drops Pan Link, OSC Mode swaps the frequency row) and, on a
    // wire, the ON toggle (an off send loses its level row) — so driving them last
    // means the sweep measures every control the panel offered on entry rather than
    // the subset the sweep's own first gestures left behind.
    const ORDER: Record<Ctl["kind"], number> = { text: 0, swatch: 1, range: 2, toggle: 3, select: 4 };
    const inDriveOrder = (list: Ctl[]): Ctl[] => [...list].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);

    const gestures: Gesture[] = [];
    for (const [kindLabel, id] of KINDS) {
      await graphNode(page, id).click();
      await unfoldAll();
      const ctls = await controlsOf();
      expect(ctls.length).toBeGreaterThan(0); // a node kind that renders nothing is a regression, not a sweep result
      // Selecting is its own slot: the selection survives the panel's own re-renders,
      // so the control slots below cost one gesture each instead of three.
      gestures.push({
        label: `${kindLabel} · select the node`,
        run: async () => {
          await graphNode(page, id).click();
          await unfoldAll();
        },
        silent: true,
      });
      for (const c of inDriveOrder(ctls)) {
        gestures.push({ label: `${kindLabel} · ${c.label} (${c.kind})`, run: () => drive(c) });
      }
    }
    // A selected wire — the inspector's only non-node subject.
    await page.locator(WIRE_SEL).dispatchEvent("pointerdown");
    await page.locator(WIRE_SEL).dispatchEvent("pointerup");
    await expect(page.locator("#inspector .param")).not.toHaveCount(0);
    const wireCtls = await controlsOf();
    gestures.push({
      label: "wire ch3→MIX 2 · select the wire",
      run: async () => {
        await page.locator(WIRE_SEL).dispatchEvent("pointerdown");
        await page.locator(WIRE_SEL).dispatchEvent("pointerup");
      },
      silent: true,
    });
    for (const c of inDriveOrder(wireCtls)) {
      gestures.push({ label: `wire ch3→MIX 2 · ${c.label} (${c.kind})`, run: () => drive(c) });
    }

    const outcomes = await sweep(page, gestures, 120);
    printSweep("INSPECTOR surface sweep", outcomes);
    await dumpTrace(page, "inspector surface sweep");

    // Two outcomes that are neither a write nor a bug: the row is gone (a control
    // above it in the same panel removed it) and the dropdown has nothing else to
    // offer (an insert-FX slot another node already took). Both are reported as their
    // own list rather than folded into "error", because they are the app's answer.
    const UNAVAILABLE = /^row |^select offers no alternative/;
    const unavailable = outcomes
      .filter((o) => o.error && UNAVAILABLE.test(o.error))
      .map((o) => `${o.label} — ${o.error}`);
    const broke = outcomes.filter((o) => o.error && !UNAVAILABLE.test(o.error)).map((o) => `${o.label}: ${o.error}`);
    const unreported = outcomes.filter((o) => o.unreported > 0).map((o) => o.label);
    console.log(`unavailable when their slot ran:\n    ${unavailable.join("\n    ") || "none"}`);

    expect(outcomes.length).toBeGreaterThan(60); // the sweep really is the wide one
    expect(broke).toEqual([]);
    // Every control that was still on screen wrote. A row that stops writing lands in
    // the silent list and fails here by name.
    expect(outcomes.filter((o) => !o.error && o.reported + o.unreported === 0).map((o) => o.label)).toEqual(
      gestures.filter((g) => g.silent).map((g) => g.label),
    );

    // Pinned behaviour #1: with the value controls driven before the structural ones,
    // exactly one control is still unreachable when its slot runs — the STEREO
    // master's insert-FX dropdown, whose only alternative is a slot the MIX bus took
    // three gestures earlier. It is a constraint expressed as data (a disabled option)
    // rather than as a refusal, and it is contention between two plan owners over one
    // device resource, which is why it shows up in a sweep with no device attached.
    expect(unavailable).toEqual(["STEREO master · Effect Type (select) — select offers no alternative option"]);

    // Turned over from a pinned defect the ledger alone could see: two inspector
    // controls mutate the plan AFTER calling the change funnel — both selectors whose
    // write reshapes the plan around itself (Signal Type re-wires the pair, COMP/EQ
    // Type resets the destination bank) — so the part they wrote after the sample was
    // attributed to nobody, and under live follow the next device notify's sample swept
    // it up as device-authored. The funnel now re-samples once its last mutation has
    // run, so every key a gesture writes carries that gesture's own source and this
    // list is empty. It stays asserted rather than deleted: a control that grows a
    // trailing mutation without a trailing sample lands here by name.
    expect(unreported).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // baseline-tuning-surface-sweep
  // -------------------------------------------------------------------------

  test("baseline-tuning-surface-sweep: GATE / COMP / EQ render, write and close three ways", async ({ page }) => {
    await boot(page);

    const openScreen = async (kind: "gate" | "comp" | "eq", id = "ch1"): Promise<void> => {
      await page.click("#btn-view-graph");
      await graphNode(page, id).click();
      const title = kind === "gate" ? /^GATE$/ : kind === "comp" ? /^COMP$/ : /^EQ$/;
      const sec = page.locator("#inspector .insp-section", { has: page.locator("summary", { hasText: title }) });
      if (!(await sec.evaluate((el) => (el as HTMLDetailsElement).open))) await sec.locator("summary").click();
      await sec.locator(`#btn-${kind}-screen`).click();
      await expect(dynBox(page)).toBeVisible();
    };

    /** The screen's operable parameter rows, by index, skipping the locked ones —
     *  a locked row is a declared no-write by construction and driving it would
     *  assert the driver rather than the app. */
    const rowsOf = (): Promise<Array<{ row: number; label: string; kind: string }>> =>
      page.evaluate(() => {
        const out: Array<{ row: number; label: string; kind: string }> = [];
        [...document.querySelectorAll("#dyn-screen-box .prefs-row")].forEach((r, i) => {
          if (r.classList.contains("locked")) return;
          const label = r.querySelector(".lblc .lbl")?.textContent?.trim() || "(bare)";
          const kind = r.querySelector("input[type=range]:not([disabled])")
            ? "range"
            : r.querySelector("select:not([disabled])")
              ? "select"
              : r.querySelector(".prefs-toggle button:not([disabled])")
                ? "toggle"
                : "";
          if (kind) out.push({ row: i, label, kind });
        });
        return out;
      });

    const dynRow = (i: number) => dynBox(page).locator(".prefs-row").nth(i);
    const driveRow = async (c: { row: number; kind: string }): Promise<void> => {
      const row = dynRow(c.row);
      if (c.kind === "range") {
        const input = row.locator("input[type=range]").first();
        const before = await input.inputValue();
        await input.focus();
        await input.press("ArrowRight");
        if ((await input.inputValue()) === before) await input.press("ArrowLeft");
        return;
      }
      if (c.kind === "select") {
        const sel = row.locator("select").first();
        const next = await sel.evaluate((s: HTMLSelectElement) => {
          const alt = [...s.options].find((o) => !o.disabled && o.value !== s.value);
          return alt?.value ?? null;
        });
        if (next === null) throw new Error("select offers no alternative option");
        await chooseOption(sel, next);
        return;
      }
      await row.locator(".prefs-toggle button:not(.on):not([disabled])").first().click();
    };

    /** Open a screen, read its operable rows, close it again. The gesture list is
     *  built before the sweep runs, so the screen has to be left closed — the first
     *  slot of each processor is its own open. */
    const collect = async (
      kind: "gate" | "comp" | "eq",
    ): Promise<Array<{ row: number; label: string; kind: string }>> => {
      await openScreen(kind);
      const rows = await rowsOf();
      await page.keyboard.press("Escape");
      await expect(dynBox(page)).toBeHidden();
      return rows;
    };

    // Values first, then the enums, then the switches — and the two switches that
    // take the parameters away entirely (a processor's own ON, and 1-Knob, which
    // hands its band's values to a single macro) last of all, driven by name at the
    // end of their processor's block. Driven in DOM order instead, the first gesture
    // of each screen would lock every gesture after it and the sweep would measure
    // the lock rather than the control.
    const ROW_ORDER: Record<string, number> = { range: 0, select: 1, toggle: 2 };
    const LATE = new Set(["ON", "1-Knob"]);
    const SILENT_ROWS = new Set<string>();
    const rowGestures = (who: string, rows: Array<{ row: number; label: string; kind: string }>): Gesture[] =>
      [...rows]
        .filter((c) => !LATE.has(c.label))
        .sort((a, b) => ROW_ORDER[a.kind] - ROW_ORDER[b.kind])
        .map((c) => ({
          label: `${who} · ${c.label} (${c.kind})`,
          run: () => driveRow(c),
          silent: SILENT_ROWS.has(c.label),
        }));
    const lateGestures = (who: string, rows: Array<{ row: number; label: string; kind: string }>): Gesture[] =>
      rows
        .filter((c) => LATE.has(c.label))
        .map((c) => ({ label: `${who} · ${c.label} (${c.kind})`, run: () => driveRow(c) }));

    const gestures: Gesture[] = [];

    // ---- GATE -------------------------------------------------------------
    const gateRows = await collect("gate");
    expect(gateRows.length).toBeGreaterThan(0);
    gestures.push({ label: "GATE · open", run: () => openScreen("gate"), silent: true });
    gestures.push(...rowGestures("GATE", gateRows));
    gestures.push(
      {
        label: "GATE · drag the threshold cap 40 px",
        run: () => dragBy(page, page.locator("#dyn-threshold-cap"), 0, 40, 6),
      },
      {
        label: "GATE · press the meter track to jump the cap",
        run: async () => {
          // The slot the cap rides in is its own parent; a press anywhere on it that
          // is not the cap jumps the value, the way the console faders do.
          const b = (await page.locator("#dyn-threshold-cap").locator("..").boundingBox())!;
          await page.mouse.click(b.x + b.width / 2, b.y + b.height * 0.2);
        },
      },
      { label: "GATE · arrow the cap", run: () => keyOn(page.locator("#dyn-threshold-cap"), "ArrowUp") },
      { label: "GATE · drag the plot", run: () => dragBy(page, dynBox(page).locator("#dyn-curve"), 0, -30, 6) },
      {
        label: "GATE · close with the Close button",
        run: async () => {
          await dynBox(page).locator(".consent-btn-secondary").click();
          await expect(dynBox(page)).toBeHidden();
        },
        silent: true,
      },
    );

    // ---- COMP -------------------------------------------------------------
    const compRows = await collect("comp");
    expect(compRows.length).toBeGreaterThan(0);
    gestures.push({ label: "COMP · open", run: () => openScreen("comp"), silent: true });
    gestures.push(...rowGestures("COMP", compRows));
    gestures.push(
      {
        label: "COMP · drag the threshold cap 40 px",
        run: () => dragBy(page, page.locator("#dyn-threshold-cap"), 0, 40, 6),
      },
      // The COMP plot is inert by design — only the GATE's drags its cap — so this is
      // the same gesture that wrote on the GATE, asserted here to write nothing.
      {
        label: "COMP · drag the plot (inert)",
        run: () => dragBy(page, dynBox(page).locator("#dyn-curve"), 0, -30, 6),
        silent: true,
      },
      ...lateGestures("COMP", compRows),
      {
        label: "COMP · 1-Knob level (enabled by the toggle above)",
        run: () => keyOn(page.locator("#dyn-oneknob-level"), "ArrowRight"),
      },
      {
        label: "COMP · close with a scrim press",
        run: async () => {
          await page.click("#dyn-screen-modal", { position: { x: 6, y: 6 } });
          await expect(dynBox(page)).toBeHidden();
        },
        silent: true,
      },
    );

    // ---- EQ ---------------------------------------------------------------
    const eqRows = await collect("eq");
    expect(eqRows.length).toBeGreaterThan(0);
    gestures.push({ label: "EQ · open", run: () => openScreen("eq"), silent: true });
    gestures.push(...rowGestures("EQ", eqRows));
    gestures.push(
      { label: "EQ · focus the response", run: () => pickPlot(page).focus(), silent: true },
      { label: "EQ · marker → LOWMID", run: () => page.keyboard.press("ArrowRight"), silent: true },
      { label: "EQ · marker → HIGHMID", run: () => page.keyboard.press("ArrowRight"), silent: true },
      { label: "EQ · marker → HIGH", run: () => page.keyboard.press("End"), silent: true },
      { label: "EQ · marker → LOW", run: () => page.keyboard.press("Home"), silent: true },
      // The EQ's 1-Knob lives outside the parameter rows (its own section), so it is
      // named rather than enumerated.
      {
        label: "EQ · 1-Knob ON",
        run: () =>
          page
            .locator("#dyn-screen-box .prefs-section", { has: page.locator("#dyn-oneknob-level") })
            .locator(".prefs-toggle button")
            .first()
            .click(),
      },
      {
        label: "EQ · 1-Knob level (enabled by the toggle above)",
        run: () => keyOn(page.locator("#dyn-oneknob-level"), "ArrowRight"),
      },
      // …and with 1-Knob on the plot stops taking a press at all: the canvas is still
      // drawn but it is no longer a pick plot, so it carries neither the class nor the
      // key listener. Dispatched onto the canvas rather than performed, so the gesture
      // measures the handler rather than Playwright's actionability check — a canvas that
      // is not in the tab order would simply time out on `focus`.
      {
        label: "EQ · response under 1-Knob (inert)",
        run: () => dynBox(page).locator("#dyn-curve").dispatchEvent("keydown", { key: "ArrowRight", bubbles: true }),
        silent: true,
      },
      ...lateGestures("EQ", eqRows),
      {
        label: "EQ · close with Escape",
        run: async () => {
          await page.keyboard.press("Escape");
          await expect(dynBox(page)).toBeHidden();
        },
        silent: true,
      },
    );

    const outcomes = await sweep(page, gestures, 200);
    printSweep("TUNING surface sweep", outcomes);

    // The fine grid, measured rather than inferred: fine.ts swaps the `step` attribute
    // of every input[data-fine-step] while Shift is held, so "did the fine grid
    // engage" is answerable as an attribute rather than as a value delta that a
    // coarse step could also produce. Run on CH 2, which the sweep never touched: on
    // ch1 the sweep left 1-Knob on and the band rows locked, and a locked row is
    // deliberately not armed — the measurement would read the lock, not the grid.
    await openScreen("eq", "ch2");
    await pickBand(page, 1); // a mid band is always Peaking, so its Gain is live
    const fineInputs = dynBox(page).locator("input[data-fine-step]");
    const eqFineCount = await fineInputs.count();
    const coarseStep = await fineInputs.first().getAttribute("step");
    await page.keyboard.down("Shift");
    const fineStep = await fineInputs.first().getAttribute("step");
    await page.keyboard.up("Shift");
    const afterRelease = await fineInputs.first().getAttribute("step");
    await page.keyboard.press("Escape");
    await expect(dynBox(page)).toBeHidden();
    await openScreen("gate", "ch2");
    const gateFineCount = await dynBox(page).locator("input[data-fine-step]").count();
    await page.keyboard.press("Escape");
    await expect(dynBox(page)).toBeHidden();

    console.log(
      `fine grid: EQ has ${eqFineCount} opted-in slider(s), step ${coarseStep} → ${fineStep} → ${afterRelease}; GATE has ${gateFineCount}`,
    );
    await dumpTrace(page, "tuning surface sweep");

    assertSweep(outcomes, gestures);
    expect(outcomes.filter((o) => o.unreported > 0).map((o) => o.label)).toEqual([]);

    // The EQ's gain rows opt into the device's 0.1 dB push-and-turn grid and step back
    // out when Shift is released; the GATE's rows have no verified fine grid, so none
    // of them opts in at all.
    expect(eqFineCount).toBeGreaterThan(0);
    expect(Number(fineStep)).toBeLessThan(Number(coarseStep));
    expect(afterRelease).toBe(coarseStep);
    expect(gateFineCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // baseline-shell-flows-sweep
  // -------------------------------------------------------------------------

  test("baseline-shell-flows-sweep: menus, modals and the refusal matrix they produce", async ({ page }) => {
    // Consent NOT accepted, so the gate is the first thing on screen — the one
    // modal that is up before the app is reachable at all.
    // Latency 0: this case's subject is which surfaces refuse which keystroke, and
    // Fetch below is ~800 sequential reads that would otherwise dominate the run.
    await installFake(page, { storage: { "urx-disclaimer-accepted": "0" } });
    page.setDefaultTimeout(GESTURE_TIMEOUT_MS);
    await page.goto("/");
    await expect(page.locator("#consent")).toBeVisible();
    expect(await hasProbe(page)).toBe(true);

    const WIRE = ['.wire-hit[data-from="in.micline_1_2:out"]', '[data-to="ch1:in"]'].join("");
    const wires = () => page.locator("#graph-host .wire-hit").count();

    /** Both preconditions of the probe below, in the order they have to happen: one
     *  committed undo entry (with an empty stack Ctrl+Z answers "Nothing to undo"
     *  BEFORE the modal refusal is even consulted) and a deletable wire selected
     *  (with no wire selected Delete is a no-op whatever the modal says). Either
     *  missing would make the whole matrix say nothing. */
    const armProbe = async (): Promise<void> => {
      await graphNode(page, "ch1").click();
      await page.locator("#inspector input[type='text']").first().pressSequentially("Q");
      // Selecting the wire rebuilds the panel, so the rename's focusout commits the
      // entry — the boundary the app defines, not a sleep.
      await page.locator(WIRE).dispatchEvent("pointerdown");
      await page.locator(WIRE).dispatchEvent("pointerup");
      await expect(page.locator("#inspector button.danger")).toHaveCount(1);
      await page.waitForTimeout(400);
    };

    /** With `what` on screen: what does Ctrl+Z answer, and does Delete reach the
     *  graph behind it? */
    const probeRefusals = async (what: string): Promise<string> => {
      const before = await wires();
      await page.keyboard.press("Delete");
      await page.waitForTimeout(80);
      const after = await wires();
      await page.keyboard.press("ControlOrMeta+z");
      await page.waitForTimeout(80);
      const status = (await page.locator("#statusbar").textContent()) ?? "";
      return `${what}: Ctrl+Z → "${status}"; Delete ${after === before ? "refused" : `REMOVED ${before - after} wire(s)`}`;
    };

    const matrix: string[] = [];
    // The gate is up before the app exists, so nothing is selected and nothing is
    // undoable: recorded for the log, not asserted on.
    matrix.push(await probeRefusals("consent gate"));
    await page.click("#consent-agree");
    await expect(page.locator("#consent")).toBeHidden();
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");

    const narrowToggle = (which: "first" | "last") =>
      which === "first"
        ? page.locator("#prefs-modal .prefs-toggle.narrow").first()
        : page.locator("#prefs-modal .prefs-toggle.narrow").last();

    const gestures: Gesture[] = [
      {
        // On a clean plan New asks nothing and simply replaces the plan — the confirm
        // belongs to the dirty case, which is a separate slot below.
        label: "File > New (clean plan, no confirm)",
        run: () => menuItem(page, "#btn-file", "#btn-new"),
      },
      {
        label: "File > Open (dialog returns null)",
        run: () => menuItem(page, "#btn-file", "#btn-open"),
        silent: true,
      },
      { label: "File > Export PNG", run: () => menuItem(page, "#btn-file", "#btn-export"), silent: true },
      { label: "File > Export PDF", run: () => menuItem(page, "#btn-file", "#btn-export-pdf"), silent: true },
      {
        // The licenses modal cannot be raised against this fake: `third_party_licenses`
        // answers with an empty notice, the parser finds no families, and the flow ends
        // in an error dialog instead of a modal. Kept as a slot so the run log records
        // that, rather than the surface silently going untested.
        label: "File > Third-party licenses (empty notice → error dialog)",
        run: async () => {
          await menuItem(page, "#btn-file", "#btn-licenses");
          await expect(page.locator("#licenses-modal")).toBeHidden();
        },
        silent: true,
      },
      { label: "View > Arrange", run: () => menuItem(page, "#btn-view", "#btn-auto") },
      { label: "View > Hide unused", run: () => menuItem(page, "#btn-view", "#btn-hide-unused") },
      { label: "View > label source", run: () => menuItem(page, "#btn-view", "#btn-labels"), silent: true },
      { label: "View > hide off sends", run: () => menuItem(page, "#btn-view", "#btn-hide-off"), silent: true },
      { label: "View > Show all (restore the shelf)", run: () => page.click(".shelf-showall") },
      {
        // MIDI control is a window of its own, so it is not on this document and holds
        // nothing back — it is swept for the opposite reason to the modals around it:
        // to pin that opening it refuses nothing.
        label: "Device > MIDI control (open, probe, close)",
        run: async () => {
          await armProbe();
          const win = await openMidiWindow(page);
          matrix.push(await probeRefusals("MIDI control window"));
          await win.close();
          await expect.poll(() => page.evaluate(() => window.__urxFake.midi.windowOpen)).toBe(false);
        },
      },
      {
        label: "Device > Device setup (open, probe, close)",
        run: async () => {
          await armProbe();
          await menuItem(page, "#btn-device", "#btn-device-setup");
          await expect(page.locator("#device-setup-modal")).toBeVisible();
          matrix.push(await probeRefusals("Device setup modal"));
          await page.keyboard.press("Escape");
          await expect(page.locator("#device-setup-modal")).toBeHidden();
        },
      },
      {
        label: "Preferences: open (and probe)",
        run: async () => {
          await armProbe();
          await page.click("#btn-prefs");
          await expect(page.locator("#prefs-modal")).toBeVisible();
          matrix.push(await probeRefusals("Preferences modal"));
        },
      },
      { label: "Preferences: language", run: () => chooseOption(page.locator("#prefs-lang"), "ja"), silent: true },
      { label: "Preferences: language back", run: () => chooseOption(page.locator("#prefs-lang"), "en"), silent: true },
      { label: "Preferences: theme", run: () => chooseOption(page.locator("#prefs-theme"), "light"), silent: true },
      {
        label: "Preferences: device scope",
        run: () => page.click("#prefs-device-scope button:not(.on)"),
        silent: true,
      },
      {
        label: "Preferences: plan-file scope",
        run: () => page.click("#prefs-save-scope button:not(.on)"),
        silent: true,
      },
      {
        label: "Preferences: warning visibility",
        run: () => narrowToggle("first").locator("button:not(.on)").click(),
        silent: true,
      },
      {
        label: "Preferences: wheel step",
        run: () => chooseOption(page.locator("#prefs-wheel"), { index: 1 }),
        silent: true,
      },
      { label: "Preferences: fine style", run: () => page.click("#prefs-fine button:not(.on)"), silent: true },
      { label: "Preferences: sleep hold", run: () => page.click("#prefs-prevent-sleep button:not(.on)"), silent: true },
      {
        label: "Preferences: update check",
        run: () => narrowToggle("last").locator("button:not(.on)").click(),
        silent: true,
      },
      { label: "Preferences: check for updates now", run: () => page.click("#prefs-update-now"), silent: true },
      {
        label: "Preferences: close",
        run: async () => {
          await page.click("#prefs-modal .consent-btn-secondary");
          await expect(page.locator("#prefs-modal")).toBeHidden();
        },
        silent: true,
      },
      {
        // With unsaved changes (armProbe left some) New asks first, and the fake
        // declines every native confirm — so the plan survives, which is the refusal
        // half of the same menu item two dozen slots above.
        label: "File > New with unsaved changes (declined)",
        run: () => menuItem(page, "#btn-file", "#btn-new"),
        silent: true,
      },
      {
        // Fetch asks before it overwrites unsaved changes, and the declined answer
        // aborts it after the connect: the link is opened, nothing is read, and the
        // session is closed again. The plan is untouched, which is the point.
        label: "Device > Fetch from device (declined)",
        run: async () => {
          await menuItem(page, "#btn-device", "#btn-fetch");
          await waitQuiet(page, 400, 40_000);
        },
        silent: true,
      },
      {
        // The control arm: the same keystroke, with nothing on screen to refuse it.
        // Without it "Delete never got through" is unfalsifiable — a Delete that is
        // broken outright would produce the same matrix.
        label: "control arm: Delete with no modal",
        run: async () => {
          await armProbe();
          matrix.push(await probeRefusals("no modal"));
        },
      },
      { label: "the rate picker", run: () => chooseOption(page.locator("#rate-picker"), "96000") },
      {
        // Also gated by the discard confirm, and also declined: the model, and with it
        // the whole address vocabulary, stays put.
        label: "the model picker (declined)",
        run: () => chooseOption(page.locator("#model-picker"), "URX44"),
        silent: true,
      },
    ];

    const outcomes = await sweep(page, gestures, 250);
    printSweep("SHELL flows sweep", outcomes);
    console.log(`refusal matrix:\n  ${matrix.join("\n  ")}`);
    console.log(`native dialogs raised: ${(await dialogsOf(page)).length}`);
    await dumpTrace(page, "shell flows sweep");

    assertSweep(outcomes, gestures);

    // The refusal matrix. Every modal that is up refuses undo by name and keeps
    // Delete off the graph behind it; the control arm shows the same keystroke doing
    // both things when nothing is in the way.
    for (const who of ["Device setup modal", "Preferences modal"]) {
      const row = matrix.find((m) => m.startsWith(who))!;
      expect(row).toContain("Close the open dialog before undoing");
      expect(row).toContain("Delete refused");
    }
    // MIDI control is the one Device-menu surface that is NOT on this document: it is
    // a window of its own, so `modalOpen()` cannot see it and it holds nothing back.
    // It reads like the control arm rather than like the modals beside it.
    const midiWindow = matrix.find((m) => m.startsWith("MIDI control window"))!;
    expect(midiWindow).not.toContain("Close the open dialog before undoing");
    expect(midiWindow).toContain("Undone");
    const control = matrix.find((m) => m.startsWith("no modal"))!;
    expect(control).not.toContain("Close the open dialog before undoing");
    expect(control).toContain("Undone");
    expect(control).toContain("REMOVED");
  });

  // -------------------------------------------------------------------------
  // baseline-view-locale-churn
  // -------------------------------------------------------------------------

  test("baseline-view-locale-churn: a language/theme switch rebuilds every strip under a captured pointer @webkit", async ({
    page,
  }) => {
    await boot(page);
    // The only case in this file that goes live, and so the only one whose first
    // actionability check is a cold one. Printed rather than assumed: it is the figure
    // `goLive`'s own bound has to cover, and the flake it replaced said nothing about
    // how long the wait actually was.
    const upAt = Date.now();
    await goLive(page);
    console.log(`session up in ${Date.now() - upAt} ms`);
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    await page.evaluate(() => window.__urxFake.setLatency({ get: 25, set: 25 }));

    // A drag that is still down when the whole console is rebuilt under it. The two
    // switches are dispatched rather than clicked: the mouse is captured by the
    // fader, and moving it to a toolbar button would end the gesture being measured.
    const fader = faderOf(page, "CH 1");
    const box = (await fader.boundingBox())!;
    const x = box.x + box.width / 2;
    await mark(page, "drag-start");
    await page.mouse.move(x, box.y + box.height * 0.25);
    await page.mouse.down();
    for (let i = 0; i < 4; i++) {
      await page.mouse.move(x, box.y + box.height * (0.25 + 0.03 * i));
      await page.waitForTimeout(25);
    }

    await mark(page, "lang-switch");
    await page.locator("#btn-prefs").dispatchEvent("click");
    await chooseOption(page.locator("#prefs-lang"), "ja");
    await page.locator("#prefs-modal .consent-btn-secondary").dispatchEvent("click");

    await mark(page, "theme-switch");
    await page.locator("#btn-prefs").dispatchEvent("click");
    await chooseOption(page.locator("#prefs-theme"), "light");
    await page.locator("#prefs-modal .consent-btn-secondary").dispatchEvent("click");

    // Keep dragging after the rebuild — this is the window listener writing through a
    // StripRef whose element is no longer in the document.
    for (let i = 0; i < 6; i++) {
      await page.mouse.move(x, box.y + box.height * (0.4 + 0.04 * i));
      await page.waitForTimeout(25);
    }
    await mark(page, "drag-end");
    await page.mouse.up();
    await waitQuiet(page);

    const shown = (await faderReadout(page, "CH 1").textContent()) ?? "";
    const held = (await memOf(page))[CH1_FADER];
    console.log(`after the rebuild: screen shows ${shown} dB, device holds ${held}`);

    // The deferred refresh: leave the console, let the device change ch2 while the
    // console is off screen, come back. The ledger says whether the plan took the
    // change at all, which is what separates "the follow missed it" from "the follow
    // took it and the view never repainted".
    await page.click("#btn-view-graph");
    await expect(page.locator("#graph-host")).toBeVisible();
    // The unit really holds the new value, not just the notify: a notify whose address
    // still reads its old value on the wire would be corrected by the idle full
    // reconcile that follows, and the verdict would be a property of the fake's memory
    // rather than of the app's refresh.
    await divergeAt(page, "139:0:1", 40);
    const before2 = await ledgerLength(page);
    await mark(page, "notify-while-hidden");
    await pushNotify(page, [[139, 0, 1, 40]]);
    await page.waitForTimeout(900);
    const deviceWrites = (await settleLedger(page, before2)).filter((e) => e.source.startsWith("follow"));
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 2")).toBeVisible();
    await waitQuiet(page);
    const ch2Shown = (await faderReadout(page, "CH 2").textContent()) ?? "";

    // A theme flip in the middle of a tuning-screen slider drag: the same rebuild,
    // on the surface whose host re-reads its values through a deferred refresh.
    await page.click("#btn-view-graph");
    await openEqScreen(page, "ch1");
    // The UI is in Japanese from the language switch above, so the slider is addressed
    // by what it IS rather than by its label: a mid band is always Peaking, and its
    // gain row is the one opted into the device's fine grid.
    await pickBand(page, 1);
    const slider = dynBox(page).locator("input[data-fine-step]").first();
    const sBox = (await slider.boundingBox())!;
    await mark(page, "dyn-drag-start");
    await page.mouse.move(sBox.x + sBox.width * 0.5, sBox.y + sBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(sBox.x + sBox.width * 0.6, sBox.y + sBox.height / 2);
    await page.waitForTimeout(60);
    const midDrag = await slider.inputValue();
    await mark(page, "dyn-theme-switch");
    await page.locator("#btn-prefs").dispatchEvent("click");
    await chooseOption(page.locator("#prefs-theme"), "dark");
    await page.locator("#prefs-modal .consent-btn-secondary").dispatchEvent("click");
    await page.mouse.move(sBox.x + sBox.width * 0.72, sBox.y + sBox.height / 2);
    await page.waitForTimeout(60);
    const afterFlip = await slider.inputValue();
    await mark(page, "dyn-drag-end");
    await page.mouse.up();
    await waitQuiet(page);

    const trace = await traceOf(page);
    const themeAt = markTime(trace, "theme-switch")!;
    const endAt = markTime(trace, "drag-end")!;
    // The writes the drag made AFTER the console was rebuilt under it. Bounded at the
    // pointerup, so a later flush of the same value cannot stand in for one.
    const afterRebuild = setsOf(trace).filter(
      (s) => s.addr === CH1_FADER && s.start > themeAt && s.start < endAt + 400,
    );

    console.log(timeline(trace, { from: markTime(trace, "drag-start")! - 50, limit: 80 }));
    console.log(
      report(
        "view / locale churn",
        analyze(trace, {
          edits: [{ label: "CH 1 fader drag across a rebuild", addr: CH1_FADER, at: markTime(trace, "drag-start")! }],
        }),
      ),
    );
    console.log(
      `writes to ${CH1_FADER} after the rebuild: ${afterRebuild.map((s) => s.value).join(", ") || "none"}; ` +
        `notify while hidden → ${deviceWrites.length} device-authored plan write(s) [${deviceWrites
          .map((e) => `${e.source}:${e.field}`)
          .join(", ")}]; CH 2 shows ${ch2Shown}; dyn slider ${midDrag} → ${afterFlip} across a theme flip`,
    );

    // Pinned behaviour, in three parts, each able to fail on its own.
    //
    // 1. The rebuild ends the gesture (invariant 10). A Preferences switch replaces
    //    every strip, and the moves made after that reach nothing: the handler on
    //    `window` finds its element out of the document and stops there, so the plan,
    //    the device and the strip on screen are one value. The trigger here is purely
    //    local — no device, no MIDI — which is what makes this the case that says the
    //    rule belongs to Console.render() rather than to the link.
    expect(afterRebuild).toHaveLength(0);
    expect(shown).not.toBe("0.0"); // and the drag really did move it off the factory value
    expect(shown).toBe(deviceLevelText(held));
    // 2. A direct notify that arrives while the CONSOLE is off screen reaches the plan
    //    (the ledger names follow-direct as the writer) and the deferred refresh is
    //    paid when the view comes back: the strip shows level_gain 40 = "+0.4". And
    //    nothing was written back to the unit for it — a followed value that bounced
    //    straight out again would be the app arguing with the operator's hardware.
    //
    //    Measured the first time WITHOUT `divergeAt`, this read "0.0" and looked like
    //    a refresh that never happened. It was not: the notify claimed a value the
    //    fake's memory did not hold, so the idle full reconcile correctly read the old
    //    one back. The verdict was a property of the fake, which is why the device is
    //    made to hold the value before the notify is sent.
    expect(deviceWrites.length).toBeGreaterThan(0);
    expect(ch2Shown).toBe("+0.4");
    // 3. The tuning screen's slider keeps moving across the theme flip — the deferred
    //    refresh does not steal the drag.
    expect(afterFlip).not.toBe(midDrag);
  });
});
