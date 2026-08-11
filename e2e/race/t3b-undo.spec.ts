import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  installFake,
  goLive,
  mark,
  traceOf,
  setLatency,
  blockAt,
  releaseBarrier,
  memOf,
  waitQuiet,
  settleAfter,
  setDialogAnswer,
  pushMenu,
  ledgerOf,
  depthOf,
  hasProbe,
} from "./fake-device";
import { analyze, report, timeline, markTime, spans, setsOf } from "./analyze";
import { CH1_FADER, faderOf, faderReadout, graphNode, strip } from "./ui";

// T3b undo — the eleven T3 cells t3-undo.spec.ts did not reach
// (docs/{en,ja}/live-race-harness.md). Where t3-undo goes at the device-facing half
// of the tier (refusals under a device activity, what a sweep does to the baseline,
// the native menu), this file goes at the half that needs no device at all: the three
// interacting pointer rules, the two keyup rules, the text-surface suppression, the
// window blur, the funnel's own post-markChanged mutations, the stack's arithmetic,
// the chord × focus-target matrix, the apply ORDER, and the reset paths.
//
// e2e/undo.spec.ts already pins the simple boundary rules against the browser
// bundle; nothing here repeats one. What makes this file possible at all is the
// trace build's probe: `depthOf` reports the COMMITTED undo / redo depth without
// driving the UI and spending entries, so "this gesture produced exactly N entries"
// is a measurement rather than an inference drawn from draining the stack. Every
// case below states its expectation as a depth DELTA around a marked gesture.

const NOTHING_TO_UNDO = "Nothing to undo";
/** The two shapes of a successful undo (bare, or naming the single node it touched);
 *  which one appears depends on whether the patch touched a node or a wire. */
const UNDO_APPLIED = /^(Undone|Undid the change to .+)$/;
const DRAG_REFUSAL = "Finish the current drag before undoing";

const statusOf = (page: Page) => page.locator("#statusbar");
const nameInput = (page: Page) => page.locator("#inspector input[type='text']").first();
const noteOverlay = (page: Page) => page.locator("#graph-host .note-edit-overlay");
const wireHits = (page: Page) => page.locator("#graph-host .wire-hit");
/** The fixed CH 1 → MIX 1 send, and the Level slider its selection puts in the
 *  inspector — the one plan-editing range control reachable without a press. */
const sendWire = (page: Page) => page.locator('.wire-hit[data-from="ch1:out"][data-to="bus.mix1:in"]');
const levelSlider = (page: Page) =>
  page.locator("#inspector .param", { hasText: "Level" }).locator("input[type='range']");
const insp = (page: Page, label: string) => page.locator("#inspector .param", { hasText: label }).locator("select");

const readStatus = (page: Page): Promise<string> =>
  statusOf(page)
    .textContent()
    .then((s) => s ?? "");

async function undoOnce(page: Page): Promise<string> {
  await page.keyboard.press("ControlOrMeta+z");
  return readStatus(page);
}

/**
 * Long enough for every deferred boundary to have landed: the pointerup macrotask,
 * and IDLE_COMMIT_MS (300 ms) for a gesture with no boundary of its own. Every depth
 * delta in this file is read after one of these, so "N entries" never depends on
 * catching a timer.
 */
const settleHistory = (page: Page): Promise<void> => page.waitForTimeout(500);

/** Committed undo depth. The redo side is read separately where it is the subject. */
const undoDepth = async (page: Page): Promise<number> => (await depthOf(page)).undo;

/** Select the fixed send wire with a MATCHED pointerdown/pointerup. The unmatched
 *  form every other e2e spec uses leaves press === "down" forever and wedges the idle
 *  backstop — the defect t3-undo pins, and poison for every count in this file. */
async function selectSendWire(page: Page): Promise<void> {
  await sendWire(page).dispatchEvent("pointerdown");
  await sendWire(page).dispatchEvent("pointerup");
  await expect(levelSlider(page)).toHaveCount(1);
}

/** `n` wheel notches `gap` ms apart, timed inside the page (a CDP round trip per
 *  notch carries more jitter than the 300 ms boundary this tier straddles). */
function wheelBurst(target: Locator, n: number, gap: number): Promise<number[]> {
  return target.evaluate(
    async (el, [count, d]) => {
      const at: number[] = [];
      for (let i = 0; i < (count as number); i++) {
        if (i) await new Promise((r) => setTimeout(r, d as number));
        at.push(performance.now());
        el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
      }
      return at.slice(1).map((t, i) => +(t - at[i]).toFixed(1));
    },
    [n, gap] as [number, number],
  );
}

/** Press and drag a console fader from one fraction of its track to another. */
async function faderDrag(
  page: Page,
  name: string,
  from: number,
  to: number,
  moves: number,
  gap: number,
): Promise<void> {
  const track = (await faderOf(page, name).boundingBox())!;
  const x = track.x + track.width / 2;
  const y = (f: number): number => track.y + track.height * f;
  await page.mouse.move(x, y(from));
  await page.mouse.down();
  for (let i = 1; i <= moves; i++) {
    await page.mouse.move(x, y(from + ((to - from) * i) / moves));
    if (gap) await page.waitForTimeout(gap);
  }
  await page.mouse.up();
}

test.describe("T3b undo", () => {
  test.beforeEach(async ({ page }) => {
    await installFake(page);
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    // Without the probe every depth delta below reads {-1} and each assertion would
    // pass or fail for a reason that has nothing to do with the app.
    expect(await hasProbe(page)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // undo-pointer-boundary-ladder
  // ---------------------------------------------------------------------------
  // Two deliberate clicks Δ ms apart. The commit deferred by the first pointerup is a
  // macrotask, so at Δ = 0 and Δ = 3 the ONLY thing keeping the two clicks apart is
  // the next pointerdown landing that pending commit itself. Both clicks are
  // dispatched from inside the page, so Δ = 0 really is the same task rather than
  // whatever a CDP round trip happened to cost.
  for (const d of [0, 3, 20, 400]) {
    test(`two deliberate chip clicks ${d} ms apart are two entries`, async ({ page }) => {
      await page.click("#btn-view-console");
      await expect(faderReadout(page, "CH 1")).toBeVisible();
      const before = await depthOf(page);

      await mark(page, `clicks-${d}`);
      const achieved = await page.evaluate(async (delay) => {
        const chip = (txt: string): HTMLElement => {
          const s = document.querySelectorAll(".con-strip")[0];
          return [...s.querySelectorAll<HTMLElement>(".con-chip")].find((c) => c.textContent === txt)!;
        };
        const fire = (el: HTMLElement): void => {
          const opt = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true };
          el.dispatchEvent(new PointerEvent("pointerdown", opt));
          el.dispatchEvent(new PointerEvent("pointerup", opt));
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        };
        const t0 = performance.now();
        fire(chip("+48"));
        if (delay) await new Promise((r) => setTimeout(r, delay));
        const t1 = performance.now();
        fire(chip("HPF"));
        return +(t1 - t0).toFixed(1);
      }, d);

      // Both edits landed: each chip really flipped, so a missing entry below is a
      // boundary fault rather than a click that never reached its funnel.
      await expect(strip(page, "CH 1").locator(".con-chip", { hasText: "+48" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(strip(page, "CH 1").locator(".con-chip", { hasText: "HPF" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await settleHistory(page);
      const after = await depthOf(page);

      console.log(timeline(await traceOf(page), { limit: 40 }));
      console.log(report(`two clicks Δ=${d}`, []));
      console.log(`Δ intended ${d} ms, achieved ${achieved} ms → depth ${before.undo} → ${after.undo}`);

      // Two deliberate actions are two entries at every Δ — including the same task,
      // where the deferred commit has not run and the second pointerdown has to land
      // it. Each Ctrl+Z then takes back exactly one chip.
      expect(after.undo - before.undo).toBe(2);
      expect(await undoOnce(page)).toMatch(UNDO_APPLIED);
      await expect(strip(page, "CH 1").locator(".con-chip", { hasText: "HPF" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      await expect(strip(page, "CH 1").locator(".con-chip", { hasText: "+48" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(await undoOnce(page)).toMatch(UNDO_APPLIED);
      await expect(strip(page, "CH 1").locator(".con-chip", { hasText: "+48" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(await undoDepth(page)).toBe(before.undo);
    });
  }

  test("a click-handler edit lands inside its gesture, a drag collapses, and a double-click reset joins the press before it", async ({
    page,
  }) => {
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();

    // (1) A chip edit runs from the click handler, i.e. AFTER the pointerup that
    // produced it. One Ctrl+Z has to take it back, which is only true because the
    // commit is deferred a macrotask past the pointerup.
    const chip = strip(page, "CH 1").locator(".con-chip", { hasText: "+48" });
    await mark(page, "chip-click");
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await settleHistory(page);
    expect(await undoDepth(page)).toBe(1);
    expect(await undoOnce(page)).toMatch(UNDO_APPLIED);
    await expect(chip).toHaveAttribute("aria-pressed", "false");
    expect(await undoDepth(page)).toBe(0);

    // (2) A drag of 20 moves is one entry, however many times its funnel reported.
    const dragBase = (await faderReadout(page, "CH 1").textContent())!;
    await mark(page, "drag");
    await faderDrag(page, "CH 1", 0.7, 0.35, 20, 25);
    const dragged = (await faderReadout(page, "CH 1").textContent())!;
    expect(dragged).not.toBe(dragBase);
    await settleHistory(page);
    expect(await undoDepth(page)).toBe(1);
    expect(await undoOnce(page)).toMatch(UNDO_APPLIED);
    await expect(faderReadout(page, "CH 1")).toHaveText(dragBase);
    await settleHistory(page);
    const base = await depthOf(page);

    // (3) A double-click resets the fader to factory, and dblclick is dispatched
    // after the SECOND press's pointerup — so the reset belongs to that press's
    // entry, not to whatever comes next. The two presses are made with an explicit
    // clickCount so Chromium emits the dblclick, and the readout is sampled between
    // them, which is what gives the first Ctrl+Z a value to land on that is neither
    // the pre-gesture level nor the factory one.
    const track = (await faderOf(page, "CH 1").boundingBox())!;
    const x = track.x + track.width / 2;
    // Clear of the cap, which the press would otherwise grab where it is and move
    // nothing — the fader is back at the pre-drag level here, so the cap sits around
    // 25 % of the travel and is ~14 % of it tall.
    const qy = track.y + track.height * 0.6;
    await mark(page, "dblclick");
    await page.mouse.move(x, qy);
    await page.mouse.down({ clickCount: 1 });
    await page.mouse.up({ clickCount: 1 });
    const atPress = (await faderReadout(page, "CH 1").textContent())!;
    await page.mouse.down({ clickCount: 2 });
    await page.mouse.up({ clickCount: 2 });
    const reset = (await faderReadout(page, "CH 1").textContent())!;
    await settleHistory(page);
    const afterDbl = await depthOf(page);

    console.log(timeline(await traceOf(page), { limit: 40 }));
    console.log(`drag ${dragBase} → ${dragged} → back to ${await faderReadout(page, "CH 1").textContent()}`);
    console.log(`dblclick: press value ${atPress}, reset value ${reset}, depth ${base.undo} → ${afterDbl.undo}`);

    // The gesture must actually have moved the fader somewhere else first, or the
    // "which entry did the reset join" question below has no observable answer.
    expect(atPress).not.toBe(dragBase);
    expect(reset).not.toBe(atPress);
    // Two entries: the first press's move, then the second press plus its reset.
    expect(afterDbl.undo - base.undo).toBe(2);
    // The first Ctrl+Z lands on the press value — the reset was in the entry the
    // preceding press opened. Had it fallen into a later one, this would land on
    // the pre-gesture value instead.
    expect(await undoOnce(page)).toMatch(UNDO_APPLIED);
    await expect(faderReadout(page, "CH 1")).toHaveText(atPress);
    expect(await undoOnce(page)).toMatch(UNDO_APPLIED);
    await expect(faderReadout(page, "CH 1")).toHaveText(dragBase);
    // (4) Everything this run recorded, drained.
    expect(await undoDepth(page)).toBe(0);
    expect(await undoOnce(page)).toBe(NOTHING_TO_UNDO);
  });

  // ---------------------------------------------------------------------------
  // undo-keyup-autorepeat-boundary
  // ---------------------------------------------------------------------------
  // The two keyup rules in one run: a stepping key's keyup is a boundary and closes
  // its entry at once, while a character key's keyup is not and leaves the entry open
  // until focusout. Separating them is exactly what ownsNativeUndo decides, so a
  // regression there shows here rather than as a rename that splits per letter.
  test("stepping keys are boundaries and autorepeat is one entry, character keys are neither", async ({ page }) => {
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    await faderOf(page, "CH 1").focus();

    // (a) Three discrete press/release pairs, held 40 ms each.
    const base = (await faderReadout(page, "CH 1").textContent())!;
    const seen: string[] = [];
    await mark(page, "three-presses");
    for (let i = 0; i < 3; i++) {
      await page.keyboard.down("ArrowUp");
      await page.waitForTimeout(40);
      await page.keyboard.up("ArrowUp");
      seen.push((await faderReadout(page, "CH 1").textContent())!);
      await page.waitForTimeout(20);
    }
    expect(new Set(seen).size).toBe(3); // three real edits, so three entries are owed
    await settleHistory(page);
    const afterPresses = await undoDepth(page);
    for (const value of [seen[1], seen[0], base]) {
      expect(await undoOnce(page)).toMatch(UNDO_APPLIED);
      await expect(faderReadout(page, "CH 1")).toHaveText(value);
    }
    const afterThreeUndos = await undoDepth(page);

    // (b) One held key: 800 ms of autorepeat at 30 ms with a SINGLE keyup. Driven from
    // inside the page so the repeat interval is the scripted one — a deferred keyup
    // commit (the shape pointerup uses) would let this outrun the macrotask and split.
    // From the floor, so 26 detents cannot saturate the 40-step level grid.
    await page.keyboard.press("End");
    await settleHistory(page);
    const floorDepth = await undoDepth(page);
    const floor = (await faderReadout(page, "CH 1").textContent())!;
    await mark(page, "autorepeat");
    const repeats = await faderOf(page, "CH 1").evaluate(async (el) => {
      const opt = { key: "ArrowUp", bubbles: true, cancelable: true };
      let n = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < 800) {
        el.dispatchEvent(new KeyboardEvent("keydown", { ...opt, repeat: n > 0 }));
        n++;
        await new Promise((r) => setTimeout(r, 30));
      }
      el.dispatchEvent(new KeyboardEvent("keyup", opt));
      return n;
    });
    const held = (await faderReadout(page, "CH 1").textContent())!;
    expect(held).not.toBe(floor);
    await settleHistory(page);
    const afterHold = await undoDepth(page);
    expect(await undoOnce(page)).toMatch(UNDO_APPLIED);
    await expect(faderReadout(page, "CH 1")).toHaveText(floor);

    // (c) A rename: three character keyups, no boundary among them. The entry closes
    // only at focusout.
    await page.click("#btn-view-graph");
    await graphNode(page, "ch1").click();
    await settleHistory(page);
    const beforeType = await undoDepth(page);
    await nameInput(page).focus();
    await mark(page, "type-abc");
    await page.keyboard.type("abc", { delay: 60 });
    await page.waitForTimeout(400); // past IDLE_COMMIT_MS: the backstop must stay off
    const duringType = await undoDepth(page);
    await page.locator("#model-picker").focus(); // focusout — the rename's own boundary
    await settleHistory(page);
    const afterType = await undoDepth(page);

    // (d) Enter and Space on a focused chip: each keyup is a boundary of its own.
    await page.click("#btn-view-console");
    const eqChip = strip(page, "CH 1").locator(".con-chip", { hasText: /^EQ$/ });
    await eqChip.focus();
    const beforeKeys = await undoDepth(page);
    await mark(page, "enter-space");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(60);
    await eqChip.focus();
    await page.keyboard.press(" ");
    await settleHistory(page);
    const afterKeys = await undoDepth(page);

    const trace = await traceOf(page);
    console.log(timeline(trace, { limit: 60 }));
    console.log(
      `(a) three presses ${base} → ${seen.join(" → ")}: depth ${afterPresses}, after 3 undos ${afterThreeUndos}`,
    );
    console.log(`(b) ${repeats} synthetic repeats over 800 ms, ${floor} → ${held}: depth ${floorDepth} → ${afterHold}`);
    console.log(`(c) typing 'abc': depth ${beforeType} → during ${duringType} → after focusout ${afterType}`);
    console.log(`(d) Enter + Space on the EQ chip: depth ${beforeKeys} → ${afterKeys}`);

    expect(afterPresses).toBe(3); // one entry per press
    expect(afterThreeUndos).toBe(0);
    // A precondition, not a finding: it rules out the hold degenerating to a single
    // keydown, which would make "one entry" true for the wrong reason.
    expect(repeats).toBeGreaterThan(20);
    expect(afterHold - floorDepth).toBe(1); // the whole hold is one entry
    // No boundary fired while typing, and none was faked by the idle backstop either
    // — 400 ms of silence with a text field focused must still not commit.
    expect(duringType).toBe(beforeType);
    expect(afterType - beforeType).toBe(1);
    // Enter and Space each activate the chip and each close their own entry.
    expect(afterKeys - beforeKeys).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // undo-focusout-text-boundary
  // ---------------------------------------------------------------------------
  // The inverse of the idle-backstop ladder: the only gesture that deliberately
  // exceeds IDLE_COMMIT_MS and must still NOT commit. The range-slider tail is what
  // proves the suppression is an allowlist rather than a blanket.
  test("a text surface suppresses the idle backstop; a range slider does not", async ({ page }) => {
    // A note, collapsed, so re-opening its editor un-collapses first — a plan write
    // the editor makes before a single character is typed.
    await graphNode(page, "ch1").locator(".note-add").click();
    await expect(noteOverlay(page)).toBeVisible();
    await noteOverlay(page).fill("stage monitor mix");
    await page.keyboard.press("Escape");
    await expect(noteOverlay(page)).toHaveCount(0);
    await graphNode(page, "ch1").locator(".note-toggle").click();
    await expect(graphNode(page, "ch1").locator(".note-panel")).toHaveCount(0);
    await settleHistory(page);
    const beforeNote = await undoDepth(page);
    const ledgerBefore = (await ledgerOf(page)).length;

    // (a) Re-open the editor: the un-collapse alone reports a change.
    await mark(page, "reopen-note");
    await graphNode(page, "ch1").dblclick();
    await expect(noteOverlay(page)).toBeVisible();
    const uncollapse = (await ledgerOf(page)).slice(ledgerBefore);
    await settleHistory(page);
    const afterOpen = await undoDepth(page);

    // (b) Twelve characters at 90 ms. No entry may close while they arrive.
    await mark(page, "typing");
    await noteOverlay(page).evaluate(async (el) => {
      const ta = el as HTMLTextAreaElement;
      for (const c of "beta 91 gate") {
        await new Promise((r) => setTimeout(r, 90));
        ta.value += c;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    const duringTyping = await undoDepth(page);

    // (c) Escape closes and blurs the editor — the note's one end of edit.
    await page.keyboard.press("Escape");
    await expect(noteOverlay(page)).toHaveCount(0);
    await settleHistory(page);
    const afterNote = await undoDepth(page);
    // One Ctrl+Z takes back the twelve characters, a second the un-collapse.
    const noteUndo = await undoOnce(page);
    const textAfterUndo = ((await graphNode(page, "ch1").locator(".note-panel").textContent()) ?? "").trim();
    const panelAfterText = await graphNode(page, "ch1").locator(".note-panel").count();
    await undoOnce(page);
    const panelAfterUndo = await graphNode(page, "ch1").locator(".note-panel").count();
    await settleHistory(page);

    // (d) A rename typed far slower than the backstop: five characters 700 ms apart,
    // on the node the editor left selected. (Clicking a node here would mean clicking
    // through the one stacked over it — the canvas packs channels closer than a node
    // is tall.)
    await expect(nameInput(page)).toHaveCount(1);
    const beforeRename = await undoDepth(page);
    await nameInput(page).focus();
    await mark(page, "slow-rename");
    for (const c of "Vocal") {
      await page.keyboard.type(c);
      await page.waitForTimeout(700);
    }
    const duringRename = await undoDepth(page);
    await page.locator("#model-picker").focus();
    await settleHistory(page);
    const afterRename = await undoDepth(page);

    // (e) The same silence over a range slider, which owns no undo stack: here the
    // backstop MUST arm.
    await selectSendWire(page);
    await page.locator("#model-picker").blur();
    await settleHistory(page);
    const beforeWheel = await undoDepth(page);
    const wheelBase = await levelSlider(page).inputValue();
    await mark(page, "wheel-once");
    await wheelBurst(levelSlider(page), 1, 0);
    await expect(levelSlider(page)).not.toHaveValue(wheelBase);
    await page.waitForTimeout(400);
    const afterWheel = await undoDepth(page);

    const trace = await traceOf(page);
    console.log(timeline(trace, { limit: 40 }));
    console.log(`(a) un-collapse ledger: ${uncollapse.map((l) => `${l.source}:${l.field}`).join(", ") || "(none)"}`);
    console.log(
      `(b,c) note: depth ${beforeNote} → after the editor opened ${afterOpen} → during typing ${duringTyping}` +
        ` → after Escape ${afterNote}; "${noteUndo}" left ${panelAfterText} panel(s) reading "${textAfterUndo}",` +
        ` a second undo left ${panelAfterUndo}`,
    );
    console.log(`(d) slow rename: depth ${beforeRename} → during ${duringRename} → after focusout ${afterRename}`);
    console.log(`(e) one wheel notch + 400 ms idle: depth ${beforeWheel} → ${afterWheel}`);

    // Opening the editor un-collapsed the panel and reported that as an edit — the
    // ledger names the plan key, which is the only place this write is visible before
    // the entry that carries it closes.
    expect(uncollapse.some((l) => l.source === "ui" && l.field === "noteCollapsed")).toBe(true);
    // MEASURED, and not what the case sketch assumed: the un-collapse does NOT share
    // an entry with the text. Opening the editor is a dblclick, so its own pointerup
    // schedules the deferred commit that closes it — a boundary the typing that
    // follows never gets. Two entries, and by the boundary rules both are right: a
    // pointer gesture ended, then a text gesture began.
    expect(afterOpen - beforeNote).toBe(1);
    // Twelve keystrokes over ~1.1 s, every gap well past IDLE_COMMIT_MS, and not one
    // of them closed an entry; Escape closed all twelve as one.
    expect(duringTyping).toBe(afterOpen);
    expect(afterNote - afterOpen).toBe(1);
    expect(noteUndo).toMatch(UNDO_APPLIED);
    expect(panelAfterText).toBe(1);
    expect(textAfterUndo).toContain("stage monitor mix");
    expect(textAfterUndo).not.toContain("beta 91 gate");
    expect(panelAfterUndo).toBe(0); // the second undo re-collapses it

    // Five letters 700 ms apart is still one rename.
    expect(duringRename).toBe(beforeRename);
    expect(afterRename - beforeRename).toBe(1);
    // And the suppression is an allowlist: a range slider gets the backstop.
    expect(afterWheel - beforeWheel).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // undo-window-blur-mid-drag
  // ---------------------------------------------------------------------------
  // The only path where a gesture ends with no pointer event at all, and the only
  // place the window-vs-element blur distinction is observable: the press listener is
  // registered on window WITHOUT capture, so an element's own (non-bubbling) blur
  // cannot reach it.
  test("a window blur ends the press mid-drag; an element blur does not", async ({ page }) => {
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    const before = (await faderReadout(page, "CH 1").textContent())!;

    // A drag, left standing: pressed and moved, with no pointerup.
    const track = (await faderOf(page, "CH 1").boundingBox())!;
    const x = track.x + track.width / 2;
    await page.mouse.move(x, track.y + track.height * 0.7);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(x, track.y + track.height * (0.7 - i * 0.05));
      await page.waitForTimeout(25);
    }
    const dragged = (await faderReadout(page, "CH 1").textContent())!;
    expect(dragged).not.toBe(before);
    // The press really is a drag as far as the history is concerned.
    expect(await undoOnce(page)).toBe(DRAG_REFUSAL);

    // Alt-tab: the window loses focus with the button still down.
    await mark(page, "window-blur");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await settleHistory(page);
    const afterBlur = await depthOf(page);
    const status = await undoOnce(page);
    const undone = (await faderReadout(page, "CH 1").textContent())!;
    const afterUndo = await depthOf(page);

    // A late pointerup for the press that was already ended.
    await mark(page, "late-up");
    await page.mouse.up();
    await settleHistory(page);
    const afterLateUp = await depthOf(page);

    // Variant: an ELEMENT blur mid-drag. Focus moves off the fader, which fires a
    // non-bubbling blur on it — the window listener must not see it, so the press
    // stands and the refusal still holds.
    await settleHistory(page);
    await faderOf(page, "CH 1").focus();
    const varBase = (await faderReadout(page, "CH 1").textContent())!;
    await page.mouse.move(x, track.y + track.height * 0.7);
    await page.mouse.down();
    for (let i = 1; i <= 4; i++) {
      await page.mouse.move(x, track.y + track.height * (0.7 - i * 0.05));
      await page.waitForTimeout(20);
    }
    await mark(page, "element-blur");
    await page.locator("#btn-view-graph").focus(); // blur on the fader, focusout on window
    const varStatus = await undoOnce(page);
    await page.mouse.up();

    const trace = await traceOf(page);
    console.log(timeline(trace, { limit: 40 }));
    console.log(`window blur: depth ${JSON.stringify(afterBlur)} → status "${status}" → ${JSON.stringify(afterUndo)}`);
    console.log(`readout ${before} → ${dragged} → ${undone}; after the late pointerup ${JSON.stringify(afterLateUp)}`);
    console.log(`element blur mid-drag: "${varStatus}" (drag base ${varBase})`);

    // The blur ended the press, so the refusal is gone and the whole drag is one
    // entry that undoes to the pre-drag level.
    expect(afterBlur.undo).toBe(1);
    expect(status).not.toBe(DRAG_REFUSAL);
    expect(status).toMatch(UNDO_APPLIED);
    expect(undone).toBe(before);
    // The pointerup that finally arrives is for a gesture that already ended: it
    // must not open, close or record anything.
    expect(afterLateUp).toEqual(afterUndo);
    expect(afterLateUp.undo).toBe(0);
    // An element blur is not a window blur. If the listener were ever registered with
    // capture, every focus move would end a press and this would read as applied.
    expect(varStatus).toBe(DRAG_REFUSAL);
  });

  // ---------------------------------------------------------------------------
  // undo-diff-at-commit-post-mutations
  // ---------------------------------------------------------------------------
  // The funnels mutate the plan AFTER calling markChanged(); the diff is taken at the
  // boundary, so those mutations belong to the same entry. Each arm below is built so
  // that a diff taken at note() instead would produce a visibly half-reverted plan.
  //
  // The probe's ledger cannot decide this one: markChanged samples BEFORE the funnel's
  // own later mutation, and the undo's sample then cancels the mutation against its
  // inverse. The observable that survives is the plan's effect on screen.
  test("an undo carries the mutations the funnel made after markChanged", async ({ page }) => {
    await graphNode(page, "ch1").click();
    await expect(insp(page, "COMP/EQ Type")).toHaveCount(1);

    // --- (a) resetCompEqBank: switching COMP/EQ type rewrites recPoint afterwards ---
    // PRE EQ has no meaning in SSMCS (no discrete EQ stage), so entering SSMCS moves
    // the tap to PRE COMP — a write the funnel makes after its own change report.
    await insp(page, "Rec Point").selectOption({ label: "PRE EQ" });
    await settleHistory(page);
    const recBefore = await insp(page, "Rec Point").inputValue();
    const depthBefore = await undoDepth(page);

    await mark(page, "comp-eq-type");
    await insp(page, "COMP/EQ Type").selectOption({ label: "SSMCS" });
    await settleHistory(page);
    const recAfterSwitch = await insp(page, "Rec Point").inputValue();
    const depthAfterSwitch = await undoDepth(page);

    const typeUndo = await undoOnce(page);
    const recAfterUndo = await insp(page, "Rec Point").inputValue();
    const typeAfterUndo = await insp(page, "COMP/EQ Type").inputValue();

    // --- (b) alignStereoPair: linking a pair moves the partner's position after ----
    await settleHistory(page);
    const parked = (await graphNode(page, "ch2").boundingBox())!;
    await page.mouse.move(parked.x + parked.width / 2, parked.y + 12);
    await page.mouse.down();
    await page.mouse.move(parked.x + parked.width / 2 + 180, parked.y + 140, { steps: 6 });
    await page.mouse.up();
    await settleHistory(page);
    const posBefore = (await graphNode(page, "ch2").getAttribute("transform"))!;

    await graphNode(page, "ch1").click();
    await settleHistory(page);
    const depthBeforeLink = await undoDepth(page);
    await mark(page, "stereo-link");
    await insp(page, "Signal Type").selectOption({ label: "STEREO" });
    await settleHistory(page);
    const posAfterLink = (await graphNode(page, "ch2").getAttribute("transform"))!;
    const depthAfterLink = await undoDepth(page);

    const linkUndo = await undoOnce(page);
    const posAfterUndo = (await graphNode(page, "ch2").getAttribute("transform"))!;
    const linkAfterUndo = await insp(page, "Signal Type").inputValue();

    // --- (c) the paired source wire: one gesture, two wires, and their indices -----
    const wiresBefore = await wireHits(page).evaluateAll((els) =>
      els.map((w) => `${w.getAttribute("data-from")}->${w.getAttribute("data-to")}`),
    );
    await settleHistory(page);
    const depthBeforeDelete = await undoDepth(page);
    await mark(page, "delete-paired-wire");
    await page.locator('.wire-hit[data-from="in.micline_1_2:out"][data-to="ch1:in"]').dispatchEvent("pointerdown");
    await page.locator('.wire-hit[data-from="in.micline_1_2:out"][data-to="ch1:in"]').dispatchEvent("pointerup");
    await page.keyboard.press("Delete");
    const wiresAfterDelete = await wireHits(page).evaluateAll((els) =>
      els.map((w) => `${w.getAttribute("data-from")}->${w.getAttribute("data-to")}`),
    );
    await settleHistory(page);
    const depthAfterDelete = await undoDepth(page);
    const deleteUndo = await undoOnce(page);
    const wiresAfterUndo = await wireHits(page).evaluateAll((els) =>
      els.map((w) => `${w.getAttribute("data-from")}->${w.getAttribute("data-to")}`),
    );

    const trace = await traceOf(page);
    console.log(timeline(trace, { limit: 40 }));
    console.log(
      `(a) Rec Point ${recBefore} → after the type switch ${recAfterSwitch} → after "${typeUndo}" ${recAfterUndo}` +
        ` (COMP/EQ Type back to ${typeAfterUndo}); depth ${depthBefore} → ${depthAfterSwitch}`,
    );
    console.log(
      `(b) ch2 ${posBefore} → after STEREO ${posAfterLink} → after "${linkUndo}" ${posAfterUndo}` +
        ` (Signal Type back to ${linkAfterUndo}); depth ${depthBeforeLink} → ${depthAfterLink}`,
    );
    console.log(
      `(c) wires ${wiresBefore.length} → ${wiresAfterDelete.length} → ${wiresAfterUndo.length};` +
        ` depth ${depthBeforeDelete} → ${depthAfterDelete}, "${deleteUndo}"`,
    );

    // (a) The type switch really did rewrite the Rec Point afterwards…
    expect(recBefore).not.toBe(recAfterSwitch);
    expect(depthAfterSwitch - depthBefore).toBe(1);
    // …and ONE Ctrl+Z restored both halves. A diff taken at markChanged would carry
    // compEqType alone and leave the tap where the funnel moved it.
    expect(typeUndo).toMatch(UNDO_APPLIED);
    expect(recAfterUndo).toBe(recBefore);
    expect(typeAfterUndo).toBe("0"); // COMP_EQ_COMP_FIRST, the value the switch left

    // (b) Linking snapped the partner, and one Ctrl+Z put it back where it was.
    expect(posAfterLink).not.toBe(posBefore);
    expect(depthAfterLink - depthBeforeLink).toBe(1);
    expect(linkUndo).toMatch(UNDO_APPLIED);
    expect(posAfterUndo).toBe(posBefore);
    expect(linkAfterUndo).toBe("0");

    // (c) Deleting one paired source clears the partner's mirrored one, and the undo
    // returns BOTH — at their original array indices, which is the wires' draw order
    // and the order a saved plan serializes in.
    expect(wiresBefore.length - wiresAfterDelete.length).toBe(2);
    expect(depthAfterDelete - depthBeforeDelete).toBe(1);
    expect(deleteUndo).toMatch(UNDO_APPLIED);
    expect(wiresAfterUndo).toEqual(wiresBefore);
  });

  // ---------------------------------------------------------------------------
  // undo-empty-diff-and-redo-stack
  // ---------------------------------------------------------------------------
  // The stack's own arithmetic, none of which is visible from the plan: an empty diff,
  // redo invalidation, the 100-entry cap and its eviction, and the transition-only
  // depth report that keeps a drag off the IPC boundary.
  test("a no-op gesture keeps the redo stack, a new edit clears it, and the stack caps at 100", async ({ page }) => {
    // One real edit, undone: redo is now available.
    const posBefore = (await graphNode(page, "ch1").getAttribute("transform"))!;
    const face = (await graphNode(page, "ch1").locator("rect").first().boundingBox())!;
    await page.mouse.move(face.x + face.width / 2, face.y + face.height / 2);
    await page.mouse.down();
    await page.mouse.move(face.x + face.width / 2 + 90, face.y + face.height / 2 + 60, { steps: 5 });
    await page.mouse.up();
    const posMoved = (await graphNode(page, "ch1").getAttribute("transform"))!;
    expect(posMoved).not.toBe(posBefore);
    await settleHistory(page);
    await undoOnce(page);
    await expect(graphNode(page, "ch1")).toHaveAttribute("transform", posBefore);
    const withRedo = await depthOf(page);

    // A mis-grab: one pixel, which snaps back to the same grid position.
    const face2 = (await graphNode(page, "ch2").locator("rect").first().boundingBox())!;
    const pos2 = (await graphNode(page, "ch2").getAttribute("transform"))!;
    await mark(page, "misgrab");
    await page.mouse.move(face2.x + face2.width / 2, face2.y + face2.height / 2);
    await page.mouse.down();
    await page.mouse.move(face2.x + face2.width / 2 + 1, face2.y + face2.height / 2 + 1, { steps: 2 });
    await page.mouse.up();
    await expect(graphNode(page, "ch2")).toHaveAttribute("transform", pos2);
    await settleHistory(page);
    const afterMisgrab = await depthOf(page);

    // The redo the mis-grab must not have wiped.
    await page.keyboard.press("ControlOrMeta+y");
    await expect(graphNode(page, "ch1")).toHaveAttribute("transform", posMoved);
    const afterRedo = await depthOf(page);

    // A new edit clears the redo stack.
    await undoOnce(page);
    await expect(graphNode(page, "ch1")).toHaveAttribute("transform", posBefore);
    await settleHistory(page);
    await graphNode(page, "ch3").locator(".note-add").click();
    await expect(noteOverlay(page)).toBeVisible();
    await noteOverlay(page).fill("clears the redo");
    await page.keyboard.press("Escape");
    await settleHistory(page);
    const afterNewEdit = await depthOf(page);

    // 105 discrete keyup edits, alternating so every one is a real change.
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    const burstBase = (await faderReadout(page, "CH 1").textContent())!;
    await mark(page, "burst-start");
    const burstFrom = await depthOf(page);
    await faderOf(page, "CH 1").evaluate(async (el) => {
      for (let i = 0; i < 105; i++) {
        if (i) await new Promise((r) => setTimeout(r, 60));
        const key = i % 2 === 0 ? "ArrowUp" : "ArrowDown";
        const opt = { key, bubbles: true, cancelable: true };
        el.dispatchEvent(new KeyboardEvent("keydown", opt));
        el.dispatchEvent(new KeyboardEvent("keyup", opt));
      }
    });
    await mark(page, "burst-end");
    await settleHistory(page);
    const afterBurst = await depthOf(page);
    const burstTop = (await faderReadout(page, "CH 1").textContent())!;

    // Drain the whole stack and see where it stops.
    let drained = 0;
    for (; drained < 130; drained++) {
      if ((await undoOnce(page)) === NOTHING_TO_UNDO) break;
    }
    const afterDrain = (await faderReadout(page, "CH 1").textContent())!;

    const trace = await traceOf(page);
    const stateCalls = spans(trace).filter((s) => s.cmd === "set_edit_menu_state");
    const burstWindow = stateCalls.filter(
      (s) => s.start >= markTime(trace, "burst-start")! && s.start <= markTime(trace, "burst-end")!,
    );
    console.log(timeline(trace, { limit: 50 }));
    console.log(
      `after one edit + undo: ${JSON.stringify(withRedo)}; after the mis-grab: ${JSON.stringify(afterMisgrab)}`,
    );
    console.log(`after redo: ${JSON.stringify(afterRedo)}; after a new edit: ${JSON.stringify(afterNewEdit)}`);
    console.log(`burst: ${JSON.stringify(burstFrom)} → ${JSON.stringify(afterBurst)}; drained in ${drained} undos`);
    console.log(`readout ${burstBase} → ${burstTop} → after the drain ${afterDrain}`);
    console.log(`set_edit_menu_state: ${stateCalls.length} total (${stateCalls.map((s) => s.detail).join(" ")})`);
    console.log(`  during the 105-edit burst: ${burstWindow.length}`);

    // A gesture that moved no value records nothing AND leaves the redo alone.
    expect(withRedo.redo).toBe(1);
    expect(afterMisgrab).toEqual(withRedo);
    expect(afterRedo).toEqual({ undo: 1, redo: 0 });
    expect(afterNewEdit.redo).toBe(0);
    // 105 entries pushed onto a stack that already held some: the cap holds.
    expect(burstFrom.undo).toBeGreaterThan(0);
    expect(afterBurst.undo).toBe(100);
    expect(drained).toBe(100);
    // The oldest entries were evicted, so the drain cannot reach the pre-burst value:
    // the fader stops one detent above it (burst edits 1..5 are unrecoverable, and
    // an alternating run's net after five is +1).
    expect(afterDrain).not.toBe(burstBase);
    // The depth report is per real transition, not per edit: 105 entries and at most
    // one push across them.
    expect(burstWindow.length).toBeLessThanOrEqual(1);
    for (let i = 1; i < stateCalls.length; i++) {
      expect(stateCalls[i].detail).not.toBe(stateCalls[i - 1].detail);
    }
  });

  // ---------------------------------------------------------------------------
  // undo-chord-ownership-matrix
  // ---------------------------------------------------------------------------
  // Seven focus targets × eight chord shapes. A matrix rather than a ladder: it is the
  // only exhaustive statement of who owns a keystroke, and a new input type silently
  // claimed by the allowlist would make Ctrl+Z stop working for exactly one control.
  //
  // The stack is seeded to {undo: 1, redo: 1} before every cell, so "the app acted" is
  // a depth MOVE in either direction — no status parsing, and a cell cannot pass by
  // having nothing to act on. Restoring after an acting cell goes through the Edit
  // menu path (pushMenu) rather than a chord, so the driver never uses the mechanism
  // under test.
  test("every chord shape against every focus target @webkit", async ({ page }) => {
    // A window-level keydown probe registered AFTER the app's own (same phase, later
    // registration), which is what lets it report whether the app claimed the chord.
    await page.evaluate(() => {
      const w = window as unknown as { __chord: { seen: boolean; prevented: boolean; key: string } };
      w.__chord = { seen: false, prevented: false, key: "" };
      window.addEventListener("keydown", (e) => {
        w.__chord = { seen: true, prevented: e.defaultPrevented, key: e.key };
      });
    });
    // An injected contenteditable: the app ships no such surface today, so this cell
    // probes the third branch of the allowlist rather than a screen.
    await page.evaluate(() => {
      const d = document.createElement("div");
      d.id = "probe-ce";
      d.setAttribute("contenteditable", "true");
      d.textContent = "editable";
      d.style.cssText = "position:fixed;left:2px;bottom:2px;width:80px;height:20px;z-index:9999";
      document.body.append(d);
    });

    const blur = (): Promise<void> => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    /** Rebuild a stack holding exactly one undo and one redo entry. */
    const reseed = async (): Promise<void> => {
      await blur();
      await page.click("#btn-view-console");
      await expect(faderReadout(page, "CH 1")).toBeVisible();
      for (let i = 0; i < 200; i++) {
        if ((await undoOnce(page)) === NOTHING_TO_UNDO) break;
      }
      await faderOf(page, "CH 1").focus();
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("ArrowUp");
      await settleHistory(page);
      await undoOnce(page);
      await blur();
      expect(await depthOf(page)).toEqual({ undo: 1, redo: 1 });
    };

    type Target = { name: string; focus: () => Promise<void> };
    const targets: Target[] = [
      { name: "body", focus: blur },
      {
        name: "range slider",
        focus: async () => {
          await page.click("#btn-view-graph");
          await selectSendWire(page);
          await levelSlider(page).focus();
        },
      },
      { name: "select", focus: () => page.locator("#model-picker").focus() },
      {
        name: "chip button",
        focus: async () => {
          await page.click("#btn-view-console");
          await strip(page, "CH 1").locator(".con-chip", { hasText: "+48" }).focus();
        },
      },
      {
        name: "name input",
        focus: async () => {
          await page.click("#btn-view-graph");
          await graphNode(page, "ch1").click();
          await nameInput(page).focus();
        },
      },
      {
        name: "note textarea",
        focus: async () => {
          if (await page.locator("#graph-host").isHidden()) await page.click("#btn-view-graph");
          if ((await noteOverlay(page).count()) === 0) {
            // Whichever note-less node's pen is on top: the canvas packs channels
            // closer than a node is tall, so a named one may be under its neighbour.
            await page.locator("#graph-host .note-add").last().click();
            await expect(noteOverlay(page)).toBeVisible();
          }
          await noteOverlay(page).focus();
        },
      },
      { name: "contenteditable", focus: () => page.locator("#probe-ce").focus() },
    ];

    const chords = [
      "Meta+z",
      "Control+z",
      "Meta+Shift+z",
      "Control+y",
      "Meta+Shift+y",
      "Alt+Meta+z",
      "z",
      "composing", // synthetic: isComposing cannot be set through a real key press
    ];
    /** Targets whose own undo stack owns the command — the app must yield. */
    const textual = new Set(["name input", "note textarea", "contenteditable"]);
    /** Chord shapes the app deliberately ignores whatever has focus. */
    const inert = new Set(["Alt+Meta+z", "z", "composing"]);

    const rows: string[] = [];
    const results = new Map<string, { acted: boolean; prevented: boolean; seen: boolean }>();

    // One entry on each side before the first cell: against an empty stack every
    // chord answers "nothing to undo" alike, and the matrix would read as inert
    // everywhere for a reason that has nothing to do with ownership.
    await reseed();

    for (const target of targets) {
      for (const chord of chords) {
        await target.focus();
        await page.evaluate(() => {
          (window as unknown as { __chord: unknown }).__chord = { seen: false, prevented: false, key: "" };
        });
        const before = await depthOf(page);
        if (chord === "composing") {
          await page.evaluate(() => {
            const el = (document.activeElement as HTMLElement | null) ?? document.body;
            el.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "z",
                metaKey: true,
                isComposing: true,
                bubbles: true,
                cancelable: true,
              }),
            );
          });
        } else {
          await page.keyboard.press(chord);
        }
        const probe = await page.evaluate(
          () => (window as unknown as { __chord: { seen: boolean; prevented: boolean; key: string } }).__chord,
        );
        const after = await depthOf(page);
        const acted = after.undo !== before.undo || after.redo !== before.redo;
        results.set(`${target.name}|${chord}`, { acted, prevented: probe.prevented, seen: probe.seen });
        rows.push(
          `${target.name.padEnd(16)} ${chord.padEnd(13)} acted=${acted ? "Y" : "n"}` +
            ` prevented=${probe.prevented ? "Y" : "n"} reachedWindow=${probe.seen ? "Y" : "n"} (key=${probe.key})`,
        );
        // Put the entry back through the menu, so the restoration never uses a chord.
        if (acted) {
          await blur();
          await pushMenu(page, after.undo < before.undo ? "edit-redo" : "edit-undo");
        }
        await page.waitForTimeout(40);
      }
      // A text target may have typed a character into the plan; rebuild the seed
      // rather than carry that into the next target.
      if (textual.has(target.name)) {
        if ((await noteOverlay(page).count()) > 0) {
          await page.keyboard.press("Escape");
          await expect(noteOverlay(page)).toHaveCount(0);
        }
        await reseed();
      }
    }

    console.log(timeline(await traceOf(page), { limit: 40 }));
    console.log(rows.join("\n"));

    for (const target of targets) {
      for (const chord of chords) {
        const r = results.get(`${target.name}|${chord}`)!;
        const label = `${target.name} × ${chord}`;
        if (textual.has(target.name) || inert.has(chord)) {
          // The app must not act and must not preventDefault: not preventing is
          // precisely what leaves WebKit's own field undo — and ordinary typing —
          // working. (Whether the field's native undo then ran is a browser
          // behaviour; the menu path measures it in t3-undo.spec.ts.)
          expect(r.acted, label).toBe(false);
          expect(r.prevented, label).toBe(false);
        } else {
          expect(r.acted, label).toBe(true);
          // Where the app acts it MUST preventDefault, or the field/native undo fires
          // on top of the plan undo.
          expect(r.prevented, label).toBe(true);
        }
      }
    }
    // The note editor stops propagation on its own keydown, so the chord never even
    // reaches the window handler — a second, independent reason the plan is safe
    // there, and the only target for which that is true.
    for (const chord of chords) {
      expect(results.get(`note textarea|${chord}`)!.seen, `note textarea × ${chord} reached window`).toBe(false);
    }
    expect(results.get("body|Meta+z")!.seen).toBe(true);

    // The fine-mode half of this case ("Ctrl+Shift+Z does not flip fine-tuning mode")
    // is already pinned in e2e/undo.spec.ts against the browser bundle; repeating it
    // here would add a second owner for the same assertion.
  });

  // ---------------------------------------------------------------------------
  // undo-apply-sequence-hidden-and-viewport
  // ---------------------------------------------------------------------------
  // The ORDER inside reflectHistory rather than its outcome. The persisted mirror is
  // rewritten from a synchronous hook on Storage.setItem, which samples the canvas at
  // the instant of the write — a MutationObserver could not decide this, since its
  // callback is delivered after the whole synchronous reflect either way.
  test("an undo rewrites the persisted mirror before it repaints, keeps the viewport, and reaches the device", async ({
    page,
  }) => {
    await goLive(page);
    await setLatency(page, { get: 8, set: 25 });

    // A distinctive viewport, so a setModel/fitView anywhere in the reflect shows.
    const host = (await page.locator("#graph-host").boundingBox())!;
    await page.mouse.move(host.x + host.width * 0.6, host.y + host.height * 0.4);
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(120);
    const viewport = (): Promise<string> =>
      page.evaluate(() => document.querySelector("#graph-host svg > g")!.getAttribute("transform")!);
    const vpBefore = await viewport();

    await page.evaluate(() => {
      const w = window as unknown as { __hid: { value: string | null; nodes: number }[] };
      w.__hid = [];
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k: string, v: string) {
        // Sampled synchronously at the write: if the repaint had already run, the
        // canvas would be back at its full node count by now.
        if (k === "urx-hidden")
          w.__hid.push({ value: v, nodes: document.querySelectorAll("#graph-host g.node").length });
        return orig.call(this, k, v);
      };
    });

    await mark(page, "hide-unused");
    await page.click("#btn-view");
    await page.click("#btn-hide-unused");
    await expect(graphNode(page, "bus.osc")).toHaveCount(0);
    const shelvedCount = await page.locator("#graph-host g.node").count();
    await settleHistory(page);
    await page.evaluate(() => {
      (window as unknown as { __hid: unknown[] }).__hid.length = 0;
    });
    // Sampled after the hide, not before it: Hide unused refits the canvas itself
    // (fewer nodes, a different shelf), so the pre-hide framing is not the one the
    // undo is asked to preserve.
    const vpBeforeUndo = await viewport();

    await mark(page, "undo-hide");
    const hideUndo = await undoOnce(page);
    await expect(graphNode(page, "bus.osc")).toHaveCount(1);
    const vpAfter = await viewport();
    const writes = await page.evaluate(
      () => (window as unknown as { __hid: { value: string | null; nodes: number }[] }).__hid,
    );
    const fullCount = await page.locator("#graph-host g.node").count();

    // The device half: an undo's write must reach the unit, which means markChanged
    // ran last (on the settled plan) and live.resync() was not called.
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();
    await waitQuiet(page);
    const levelBefore = (await faderReadout(page, "CH 1").textContent())!;
    await faderOf(page, "CH 1").focus();
    await page.keyboard.press("ArrowUp");
    await settleHistory(page);
    await waitQuiet(page);
    const sentEdit = (await memOf(page))[CH1_FADER];
    await mark(page, "undo-level");
    const levelUndo = await undoOnce(page);
    await expect(faderReadout(page, "CH 1")).toHaveText(levelBefore);
    await settleAfter(page, "undo-level");
    const sentUndo = (await memOf(page))[CH1_FADER];

    const trace = await traceOf(page);
    const undoAt = markTime(trace, "undo-level")!;
    const after = setsOf(trace).filter((s) => s.addr === CH1_FADER && s.start > undoAt);
    console.log(timeline(trace, { from: markTime(trace, "hide-unused")! - 50, limit: 60 }));
    console.log(
      report(
        "apply sequence",
        // No expected value: the number the undo restores is the device's own
        // pre-edit reading, so invariant 2 is asked only whether ANY write for that
        // address left after the undo — the value is asserted against the trace below.
        analyze(trace, { edits: [{ label: "undo of the CH 1 detent", addr: CH1_FADER, at: undoAt }] }),
      ),
    );
    console.log(`hide undo: "${hideUndo}"; mirror writes at the undo: ${JSON.stringify(writes)}`);
    console.log(`nodes: shelved ${shelvedCount} → after the undo ${fullCount}`);
    console.log(`viewport at the hide ${vpBefore}; before the undo ${vpBeforeUndo} / after ${vpAfter}`);
    console.log(`device: after the edit ${sentEdit}, after "${levelUndo}" ${sentUndo}`);
    console.log(
      `writes on ${CH1_FADER} after the undo: ${after.map((s) => `${s.start.toFixed(0)}ms=${s.value}`).join(", ")}`,
    );

    expect(hideUndo).toMatch(UNDO_APPLIED);
    // Exactly one mirror write, and the canvas was still shelved when it happened —
    // the persisted set moved BEFORE the repaint, which is what stops the graph's own
    // write-back cache (commitHidden) from undoing the undo on its next commit.
    expect(writes).toHaveLength(1);
    expect(writes[0].value).toContain("URX44V");
    expect(writes[0].nodes).toBe(shelvedCount);
    expect(fullCount).toBeGreaterThan(shelvedCount);
    // No setModel / fitView anywhere in the reflect: the canvas did not reframe.
    // (Hide unused itself does refit, which is why the baseline is taken after it.)
    expect(vpAfter).toBe(vpBeforeUndo);
    // And the undone value really reached the unit: markChanged ran on the settled
    // plan, and nothing re-based the live snapshot to it first.
    expect(after.length).toBeGreaterThan(0);
    // sentUndo is read from the fake AFTER the undo's write landed and sentEdit
    // before it, so this pair discriminates; comparing the fake's memory to the last
    // write it accepted would not.
    expect(sentUndo).not.toBe(sentEdit);
  });

  test("an undo made while the graph is hidden defers its repaint to the next view switch", async ({ page }) => {
    // Device-independent: graphDirty is a view-state latch in main.ts, so this arm is
    // run offline. The device half of the case is in the test above.
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();

    // A CH_ON toggle: it dims the node on the canvas, so a repaint is really owed.
    const mute = strip(page, "CH 1").locator(".con-chip", { hasText: "MUTE" });
    await mute.click();
    await settleHistory(page);
    expect(await undoDepth(page)).toBe(1);

    await page.evaluate(() => {
      const w = window as unknown as { __gm: number };
      w.__gm = 0;
      new MutationObserver((recs) => {
        w.__gm += recs.length;
      }).observe(document.getElementById("graph-host")!, { childList: true, subtree: true, attributes: true });
    });
    await mark(page, "undo-hidden-graph");
    const status = await undoOnce(page);
    await expect(mute).toHaveAttribute("aria-pressed", "false");
    await page.waitForTimeout(200);
    const duringUndo = await page.evaluate(() => (window as unknown as { __gm: number }).__gm);
    await page.click("#btn-view-graph");
    await page.waitForTimeout(200);
    const afterSwitch = await page.evaluate(() => (window as unknown as { __gm: number }).__gm);

    console.log(timeline(await traceOf(page), { limit: 30 }));
    console.log(`undo "${status}": graph mutations during ${duringUndo}, after the view switch ${afterSwitch}`);

    expect(status).toMatch(UNDO_APPLIED);
    // Nothing touched the hidden canvas at the undo…
    expect(duringUndo).toBe(0);
    // …and the deferred work ran when it became visible again.
    expect(afterSwitch).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // undo-during-device-activity-ladder — the converge-await cell
  // ---------------------------------------------------------------------------
  // The counter-example to the refetch cell in t3-undo.spec.ts, built to the same
  // shape: the operator takes back the very parameter whose write opened the device
  // activity, from inside that activity. The converge path re-bases from a clone
  // frozen BEFORE its await, so the undone value should still be a diff when the round
  // ends; the refetch path snapshots the live plan and loses it.
  test("undo fired inside an insert-FX converge await", async ({ page }) => {
    await goLive(page);
    await graphNode(page, "ch1").click();
    const insertSel = insp(page, "Insert FX");
    await expect(insertSel).toHaveCount(1);
    const before = await insertSel.inputValue();
    await setLatency(page, { get: 8, set: 60 });

    await blockAt(page, "vd_get", 20);
    await mark(page, "converge-trigger");
    await insertSel.selectOption({ label: "Compander-H" });
    await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 20_000 });
    const armed = await insertSel.inputValue();
    // The select change has no boundary of its own, so its entry closes on the idle
    // backstop; without this the Ctrl+Z below would undo whatever came before it.
    await settleHistory(page);
    const depthArmed = await undoDepth(page);

    await mark(page, "undo-in-converge");
    const status = await undoOnce(page);
    const justAfter = await insp(page, "Insert FX").inputValue();
    await mark(page, "release");
    await releaseBarrier(page);
    // The verdict is partly an ABSENCE (did a write carrying the undone value leave),
    // so the link has to be seen waking up before its silence means anything.
    await settleAfter(page, "release", 1200);
    const after = await insp(page, "Insert FX").inputValue();

    const trace = await traceOf(page);
    const undoAt = markTime(trace, "undo-in-converge")!;
    const sets = setsOf(trace).filter((s) => s.addr === "135:0:0");
    // No expected value: the selector's "none" is a raw sentinel the plan does not
    // spell, so invariant 2 is asked only whether a write for that address left after
    // the undo; which value it carried is asserted against the trace below.
    const findings = analyze(trace, {
      edits: [{ label: "undo of the insert-FX selector", addr: "135:0:0", at: undoAt }],
    });
    const armedWrite = sets.find((s) => s.start < undoAt);
    const undoWrites = sets.filter((s) => s.start > undoAt);
    console.log(timeline(trace, { from: markTime(trace, "converge-trigger")! - 50, limit: 60 }));
    console.log(report("undo during converge", findings));
    console.log(
      `status="${status}" selector "${before}" → "${armed}" → "${justAfter}" → "${after}"; depth ${depthArmed}`,
    );
    console.log(`writes on 135:0:0: ${sets.map((s) => `${s.start.toFixed(0)}ms=${s.value}`).join(", ")}`);
    console.log(`device holds 135:0:0 = ${(await memOf(page))["135:0:0"]}`);

    // A converge await is invisible to the refusal gate, exactly as a refetch is.
    expect(status).toMatch(UNDO_APPLIED);
    expect(armed).not.toBe(before);
    expect(depthArmed).toBeGreaterThan(0);
    // The undo reached the screen…
    expect(justAfter).toBe(before);
    // …and, unlike the refetch cell, it survives the round: the frozen clone keeps it
    // a diff, so a write carrying the restored selector leaves after the undo, it is
    // NOT the value the gesture had armed, and the screen does not snap back.
    expect(armedWrite).toBeDefined();
    expect(undoWrites.length).toBeGreaterThan(0);
    expect(undoWrites[undoWrites.length - 1].value).not.toBe(armedWrite!.value);
    expect(findings.filter((f) => f.inv === 2)).toHaveLength(0);
    expect(after).toBe(before);
  });

  // ---------------------------------------------------------------------------
  // undo-reset-paths-and-pending-commit
  // ---------------------------------------------------------------------------
  test("File > New and a model switch empty both stacks; a cancelled Fetch leaves them", async ({ page }) => {
    await setDialogAnswer(page, "Ok"); // agree to discard, or no path reaches its reset

    /** Three committed entries, whatever the current document is. */
    const threeEdits = async (): Promise<void> => {
      await page.click("#btn-view-console");
      await expect(faderReadout(page, "CH 1")).toBeVisible();
      await faderOf(page, "CH 1").focus();
      for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowUp");
      await settleHistory(page);
      expect((await depthOf(page)).undo).toBe(3);
      await undoOnce(page); // one on the redo side too, so a reset has both to empty
      await settleHistory(page);
      expect(await depthOf(page)).toEqual({ undo: 2, redo: 1 });
    };

    const verdicts: string[] = [];

    // (d) File > New.
    await threeEdits();
    await mark(page, "file-new");
    await page.click("#btn-file");
    await page.click("#btn-new");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await settleHistory(page);
    const afterNew = await depthOf(page);
    verdicts.push(await undoOnce(page));

    // (e) A model switch.
    await threeEdits();
    await mark(page, "model-switch");
    await page.selectOption("#model-picker", "URX22");
    await expect(page.locator("#model-picker")).toHaveValue("URX22");
    await settleHistory(page);
    const afterSwitch = await depthOf(page);
    verdicts.push(await undoOnce(page));
    await page.selectOption("#model-picker", "URX44V");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");

    // (b)/(c) A Fetch, cancelled at its first read. It used to restore a pre-read clone
    // by replacing the plan object, and rerenderPlan then reset the history against a
    // document that was not even the one the entries were recorded on. The read now
    // works on a private copy (readback.readIntoPlan), so a cancel touches nothing —
    // and a history that describes an unchanged plan has no reason to be thrown away.
    await threeEdits();
    await blockAt(page, "vd_get", 1);
    await mark(page, "fetch-cancel");
    await page.click("#btn-device");
    await page.click("#btn-fetch");
    await page.waitForFunction(() => window.__urxFake.blocked(), null, { timeout: 20_000 });
    await page.click("#btn-device");
    await page.click("#btn-fetch"); // a second click cancels
    await releaseBarrier(page);
    await waitQuiet(page, 1200, 120_000);
    const afterCancel = await depthOf(page);
    verdicts.push(await undoOnce(page));

    console.log(timeline(await traceOf(page), { limit: 60 }));
    console.log(`File > New: ${JSON.stringify(afterNew)} "${verdicts[0]}"`);
    console.log(`model switch: ${JSON.stringify(afterSwitch)} "${verdicts[1]}"`);
    console.log(`cancelled Fetch: ${JSON.stringify(afterCancel)} "${verdicts[2]}"`);

    // The two that really do replace the document empty both stacks: the model can
    // differ, `plan` is a different object, and the operator confirmed the discard.
    for (const [i, d] of [afterNew, afterSwitch].entries()) {
      expect(d, `path ${i}`).toEqual({ undo: 0, redo: 0 });
      expect(verdicts[i], `path ${i}`).toBe(NOTHING_TO_UNDO);
    }
    // The cancelled Fetch is the one that changed: nothing was written, so both stacks
    // stand exactly as `threeEdits` left them and the press undoes the operator's own
    // third edit rather than answering "Nothing to undo".
    expect(afterCancel).toEqual({ undo: 2, redo: 1 });
    expect(verdicts[2]).not.toBe(NOTHING_TO_UNDO);
  });

  test("a commit deferred by a pointerup does not record against the document that replaced it", async ({ page }) => {
    await setDialogAnswer(page, "Ok");
    await page.click("#btn-view-console");
    await expect(faderReadout(page, "CH 1")).toBeVisible();

    // Control arm: the identical drag with nothing racing it records one entry.
    await faderDrag(page, "CH 1", 0.7, 0.4, 4, 20);
    await settleHistory(page);
    const control = await depthOf(page);
    for (let i = 0; i < 5; i++) {
      if ((await undoOnce(page)) === NOTHING_TO_UNDO) break;
    }

    // Race arm: release the drag and open a new document inside the macrotask the
    // pointerup just scheduled. Both the release and the File > New click are issued
    // from the page, so the reset really lands inside that window rather than after
    // whatever a CDP round trip costs.
    const track = (await faderOf(page, "CH 1").boundingBox())!;
    const x = track.x + track.width / 2;
    await page.mouse.move(x, track.y + track.height * 0.7);
    await page.mouse.down();
    for (let i = 1; i <= 4; i++) {
      await page.mouse.move(x, track.y + track.height * (0.7 - i * 0.06));
      await page.waitForTimeout(20);
    }
    await mark(page, "race");
    await page.evaluate(() => {
      const opt = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true };
      window.dispatchEvent(new PointerEvent("pointerup", opt));
      document.getElementById("btn-file")!.click();
      document.getElementById("btn-new")!.click();
    });
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await settleHistory(page);
    const raced = await depthOf(page);
    const status = await undoOnce(page);

    console.log(timeline(await traceOf(page), { limit: 40 }));
    console.log(`control arm: ${JSON.stringify(control)}; race arm: ${JSON.stringify(raced)} "${status}"`);

    // The control arm establishes that the gesture does record — without it, an empty
    // race arm would be consistent with the drag never having edited anything.
    expect(control.undo).toBe(1);
    // reset() cancels the pending commit, so the macrotask does not fire against the
    // new document.
    expect(raced).toEqual({ undo: 0, redo: 0 });
    expect(status).toBe(NOTHING_TO_UNDO);
  });

  // A sampleRate entry cannot coexist with a live session: activating one runs the
  // readback's rerenderPlan, which resets both stacks, and the rate picker is disabled
  // from then on. t3-undo.spec.ts's refusal ladder already probes both halves of that
  // (the offline rate change IS undoable; the picker IS locked while live) and pins
  // `undoRateLive` as an unreachable refusal. There is no second route into the state
  // — a ?plan= link and a file load both go through loadPlan, which resets too — so
  // there is nothing here that could fail.
  test.skip("a sampleRate-touching entry is refused while live", () => {});

  // Reset path (g), a .urxf settings import, is behind the --experimental launch flag,
  // which the fake answers `false` for (experimental_enabled). Driving it would mean
  // making the fake claim a launch mode the shipped app does not have, so the case
  // would measure the harness rather than the app.
  test.skip("a .urxf settings import empties both stacks", () => {});

  // Race variant 2 (a cancelled Fetch while a MIDI mapping is bound, so the BoundControl
  // cache keeps writing into the discarded plan) needs the learn flow t4-midi.spec.ts
  // drives. It belongs with that file's helpers rather than as a second, divergent copy
  // here; the reset half of the same path is covered by the cancelled-Fetch arm above.
  test.skip("a cancelled Fetch re-points the MIDI bound cache", () => {});
});
