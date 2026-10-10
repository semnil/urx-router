import { test, expect, type Page } from "./fixtures";
import { drag, faceplate, port, selectWire } from "./graph-helpers";
import { chooseOption } from "./choose-option";
import { en } from "../src/i18n/en";
import { ja } from "../src/i18n/ja";

// Undo / redo over the plan. What each test really pins is the number of entries a
// gesture produces: the boundary rules hang off real pointer, key and focus events,
// so a unit test cannot reach them.
//
// The observables are the plan's effect on screen plus the status line. macOS also
// routes its Edit ▸ Undo / Redo into the same operations, but that path needs the
// desktop shell and a native menu bar — it is verified by hand on the real build (see
// docs/{en,ja}/architecture.md) and by unit tests over `PlanHistory.menu`, not here:
// these specs run in Chromium against the browser bundle.

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const wires = (page: Page) => page.locator("#graph-host .wire-hit");
const status = (page: Page) => page.locator("#statusbar");
const nameInput = (page: Page) => page.locator("#inspector input[type='text']");
const overlay = (page: Page) => page.locator("#graph-host .note-edit-overlay");
const notePanel = (page: Page, id: string) => node(page, id).locator(".note-panel");

const undo = (page: Page) => page.keyboard.press("ControlOrMeta+z");
const redoShift = (page: Page) => page.keyboard.press("ControlOrMeta+Shift+z");
const redoY = (page: Page) => page.keyboard.press("ControlOrMeta+y");

/** A user-creatable wire: a stereo channel's source, which mirrors nothing. */
const connect = (page: Page) => drag(page, port(page, "in.micline_1_2:out"), port(page, "ch_5_6:in"));

/** Select the fixed CH 1 → MIX 1 send, whose inspector carries a Level slider. */
async function selectSend(page: Page): Promise<void> {
  await selectWire(page, "ch1:out", "bus.mix1:in");
}
const levelSlider = (page: Page) =>
  page.locator("#inspector .param", { hasText: "Level" }).locator("input[type='range']");

/** A console strip located by its scribble name, and that strip's fader readout. */
const strip = (page: Page, name: string) => page.locator(".con-strip", { has: page.getByText(name, { exact: true }) });
const faderReadout = (page: Page, name: string) => strip(page, name).locator(".con-readout .rd:not(.mtr) .rv");

/** Add a note through the pen and commit it with Escape (one gesture, one entry). */
async function addNote(page: Page, id: string, text: string): Promise<void> {
  await node(page, id).locator(".note-add").click();
  await expect(overlay(page)).toBeVisible();
  await overlay(page).fill(text);
  await page.keyboard.press("Escape");
  await expect(overlay(page)).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("says so when there is nothing to undo or redo", async ({ page }) => {
  await undo(page);
  await expect(status(page)).toHaveText("Nothing to undo");
  await redoShift(page);
  await expect(status(page)).toHaveText("Nothing to redo");
});

test("a node drag is one undo step, and redo puts it back", async ({ page }) => {
  const before = (await node(page, "ch1").getAttribute("transform"))!;
  const box = (await faceplate(page, "ch1").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // Several moves, so a per-edit history would record several entries.
  for (const dx of [30, 60, 90, 120]) {
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + 40, { steps: 4 });
  }
  await page.mouse.up();
  const moved = (await node(page, "ch1").getAttribute("transform"))!;
  expect(moved).not.toBe(before);

  await undo(page);
  await expect(node(page, "ch1")).toHaveAttribute("transform", before);
  await redoShift(page);
  await expect(node(page, "ch1")).toHaveAttribute("transform", moved);
});

// The two teardowns that are not a release. pointermove has already written the new
// place into the plan by the time either lands, so a teardown that did not report it
// would leave the move on screen with nothing able to take it back.
test("a drag cancelled mid-gesture still records the move it already made", async ({ page }) => {
  const before = (await node(page, "ch1").getAttribute("transform"))!;
  const box = (await faceplate(page, "ch1").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 40, { steps: 4 });
  const moved = (await node(page, "ch1").getAttribute("transform"))!;
  expect(moved).not.toBe(before);

  // Pointer capture revoked: no pointerup ever reaches the handler that reports.
  await page.locator("#graph-host svg").dispatchEvent("pointercancel");
  await page.mouse.up();

  await undo(page);
  await expect(node(page, "ch1")).toHaveAttribute("transform", before);
});

test("a second finger landing mid-drag still records the move", async ({ page }) => {
  const before = (await node(page, "ch1").getAttribute("transform"))!;
  const box = (await faceplate(page, "ch1").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2, { steps: 4 });
  const moved = (await node(page, "ch1").getAttribute("transform"))!;
  expect(moved).not.toBe(before);

  // A second pointer turns the drag into a pinch, which tears the drag down without
  // a release. The synthetic finger gets its own pointerup: an id left in the graph's
  // pointer map makes every later press read as a pinch.
  const svg = page.locator("#graph-host svg");
  await svg.dispatchEvent("pointerdown", { pointerId: 2, isPrimary: false, clientX: box.x, clientY: box.y });
  await page.mouse.up();
  await svg.dispatchEvent("pointerup", { pointerId: 2, isPrimary: false });

  await undo(page);
  await expect(node(page, "ch1")).toHaveAttribute("transform", before);
});

test("creating a wire is one step, and deleting it round-trips with Ctrl+Y", async ({ page }) => {
  const base = await wires(page).count();
  await connect(page);
  await expect(wires(page)).toHaveCount(base + 1);
  await undo(page);
  await expect(wires(page)).toHaveCount(base);
  await redoY(page);
  await expect(wires(page)).toHaveCount(base + 1);

  await wires(page).last().dispatchEvent("pointerdown");
  await wires(page).last().dispatchEvent("pointerup");
  await page.keyboard.press("Delete");
  await expect(wires(page)).toHaveCount(base);
  await undo(page);
  await expect(wires(page)).toHaveCount(base + 1);
});

test("a typed note is one step, however many keystrokes it took", async ({ page }) => {
  await addNote(page, "ch1", "beta 91, gate on");
  await expect(notePanel(page, "ch1")).toHaveCount(1);
  // Escape blurs the editor, which is the note's end of edit.
  await undo(page);
  await expect(notePanel(page, "ch1")).toHaveCount(0);
  await redoShift(page);
  await expect(notePanel(page, "ch1")).toHaveCount(1);
});

test("un-collapsing a note by opening its editor is undoable", async ({ page }) => {
  await addNote(page, "ch1", "stage monitor mix");
  await node(page, "ch1").locator(".note-toggle").click();
  await expect(notePanel(page, "ch1")).toHaveCount(0);
  await expect(status(page)).toHaveText("Note minimized");

  // Opening the editor un-collapses the panel — a plan write that used to reach no
  // change funnel at all, so it had no entry and no unsaved flag either.
  await node(page, "ch1").dblclick();
  await expect(overlay(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(overlay(page)).toHaveCount(0);
  await expect(notePanel(page, "ch1")).toHaveCount(1);

  await undo(page);
  await expect(notePanel(page, "ch1")).toHaveCount(0);
});

test("Hide unused round-trips, and the graph's own shelved set follows", async ({ page }) => {
  await page.click("#btn-view");
  await page.click("#btn-hide-unused");
  await expect(node(page, "bus.osc")).toHaveCount(0);
  const shelved = await page.locator("#graph-host g.node").count();

  await undo(page);
  await expect(node(page, "bus.osc")).toHaveCount(1);

  // Hiding again must still work: if the graph's shelved set had gone stale under
  // the undo, its next commit would write the undone state straight back.
  await page.click("#btn-view");
  await page.click("#btn-hide-unused");
  await expect(node(page, "bus.osc")).toHaveCount(0);
  expect(await page.locator("#graph-host g.node").count()).toBe(shelved);
  await undo(page);
  await expect(node(page, "bus.osc")).toHaveCount(1);
});

test("a new edit clears the redo stack", async ({ page }) => {
  await addNote(page, "ch1", "first");
  await undo(page);
  await expect(notePanel(page, "ch1")).toHaveCount(0);

  await addNote(page, "ch2", "second");
  await redoShift(page);
  await expect(status(page)).toHaveText("Nothing to redo");
  await expect(notePanel(page, "ch1")).toHaveCount(0);
});

test("Ctrl+Z acts with focus left on a range slider", async ({ page }) => {
  await selectSend(page);
  await expect(levelSlider(page)).toHaveCount(1);
  const start = await levelSlider(page).inputValue();
  // Focus stays on the range, which owns no undo stack of its own — the reason the
  // shortcut cannot reuse the Delete key's broader "typing" bail.
  await levelSlider(page).focus();
  await page.keyboard.press("ArrowUp");
  await expect(levelSlider(page)).not.toHaveValue(start);
  await undo(page);
  await expect(levelSlider(page)).toHaveValue(start);
});

test("arrow stepping is one step per press", async ({ page }) => {
  await selectSend(page);
  await levelSlider(page).focus();
  const start = await levelSlider(page).inputValue();
  const seen: string[] = [];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("ArrowUp");
    seen.push(await levelSlider(page).inputValue());
  }
  expect(new Set(seen).size).toBe(3); // three distinct values, so three edits
  // Each keyup closed its own entry, so each press costs exactly one Ctrl+Z.
  for (const value of [seen[1], seen[0], start]) {
    await undo(page);
    await expect(levelSlider(page)).toHaveValue(value);
  }
});

test("a console fader drag is one step back to the pre-drag level", async ({ page }) => {
  await page.click("#btn-view-console");
  await expect(page.locator("#console-host")).toBeVisible();
  const readout = faderReadout(page, "CH 1");
  const before = (await readout.textContent())!;

  const track = (await strip(page, "CH 1").locator(".con-fader").boundingBox())!;
  await page.mouse.move(track.x + track.width / 2, track.y + track.height * 0.3);
  await page.mouse.down();
  for (const f of [0.45, 0.55, 0.65, 0.75]) {
    await page.mouse.move(track.x + track.width / 2, track.y + track.height * f, { steps: 3 });
  }
  await page.mouse.up();
  expect(await readout.textContent()).not.toBe(before);

  // One press, straight back to the level before the press — not to one of the
  // intermediate values the drag passed through.
  await undo(page);
  await expect(readout).toHaveText(before);
});

test("a mis-grab that moves no value records no entry", async ({ page }) => {
  await addNote(page, "ch1", "only edit");
  await expect(notePanel(page, "ch1")).toHaveCount(1);

  // Grab a node and twitch a pixel: the snapped position does not change, so the
  // gesture diffs to nothing however many times its funnel reported a change.
  const before = (await node(page, "ch2").getAttribute("transform"))!;
  const box = (await faceplate(page, "ch2").boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 1, cy + 1, { steps: 2 });
  await page.mouse.up();
  await expect(node(page, "ch2")).toHaveAttribute("transform", before);

  // So the next Ctrl+Z reaches the note rather than spending itself on a no-op.
  await undo(page);
  await expect(notePanel(page, "ch1")).toHaveCount(0);
});

test("refuses while a fader drag is still in progress", async ({ page }) => {
  await page.click("#btn-view-console");
  const readout = faderReadout(page, "CH 1");
  const before = (await readout.textContent())!;
  const track = (await strip(page, "CH 1").locator(".con-fader").boundingBox())!;

  await page.mouse.move(track.x + track.width / 2, track.y + track.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(track.x + track.width / 2, track.y + track.height * 0.6, { steps: 3 });
  // The drag holds its start values and strip elements in its own closures, which
  // the reflect would rebuild from under it.
  await undo(page);
  await expect(status(page)).toHaveText("Finish the current drag before undoing");
  expect(await readout.textContent()).not.toBe(before);

  // Once it ends, the same press works and the whole drag is one step.
  await page.mouse.up();
  await undo(page);
  await expect(readout).toHaveText(before);
});

// A finger dragging a node while the mouse is used: a wheel event's buttons and a mouse move
// say nothing about the finger, and a mouse click is not the finger lifting, so the drag still
// stands and the undo stays refused until the finger lifts. The touches go through Chromium's own input pipeline over CDP, so the page
// hears trusted touch pointer events, and the mouse is the real one.
test.describe("a touch drag held while the mouse is used", () => {
  type Seen = { wheel: number[]; move: number[] };

  /** Seed one entry, park the mouse, and start dragging CH 1 with one finger. Returns the
   *  places the two nodes have to end up at, and the rest of the finger's gesture. */
  async function touchDrag(page: Page) {
    // A node drag opens no entry until it ends, so against an empty stack every press state
    // answers "Nothing to undo" alike. CH 2's drag is that entry; where it leaves CH 2 is
    // what a wrongly permitted undo would take back.
    const seed = (await faceplate(page, "ch2").boundingBox())!;
    await page.mouse.move(seed.x + seed.width / 2, seed.y + seed.height / 2);
    await page.mouse.down();
    await page.mouse.move(seed.x + seed.width / 2 + 60, seed.y + seed.height / 2 + 30, { steps: 4 });
    await page.mouse.up();
    const seeded = (await node(page, "ch2").getAttribute("transform"))!;
    // Parked over the status line, so the wheel below lands on no control of its own.
    const bar = (await status(page).boundingBox())!;
    await page.mouse.move(bar.x + 10, bar.y + bar.height / 2);

    const before = (await node(page, "ch1").getAttribute("transform"))!;
    const face = (await faceplate(page, "ch1").boundingBox())!;
    // Low and to the left, away from the Rec Point tap jack: from the face's centre the
    // touch hit test lands on that jack, and the press starts a wire instead of a drag.
    const x = face.x + face.width * 0.25;
    const y = face.y + face.height * 0.7;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", dx = 0, dy = 0) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x: x + dx, y: y + dy, radiusX: 1, radiusY: 1 }],
      });
    await touch("touchStart");
    await touch("touchMove", 40, 30);
    await expect(node(page, "ch1")).not.toHaveAttribute("transform", before);
    await undo(page);
    await expect(status(page)).toHaveText(en.status.undoBusyDrag);

    // What the history is handed from here on, recorded where it reads it.
    await page.evaluate(() => {
      const seen: Seen = { wheel: [], move: [] };
      (window as unknown as { __seen: Seen }).__seen = seen;
      window.addEventListener("wheel", (e) => seen.wheel.push(e.buttons), true);
      window.addEventListener("pointermove", (e) => e.pointerType === "mouse" && seen.move.push(e.buttons), true);
    });
    const seen = () => page.evaluate(() => (window as unknown as { __seen: Seen }).__seen);

    /** Undo under the held finger, keep dragging, lift, and undo again. */
    async function refusedThenLifted(): Promise<void> {
      await undo(page);
      await expect(status(page)).toHaveText(en.status.undoBusyDrag);
      // Still dragging: the node goes on following the finger.
      const during = (await node(page, "ch1").getAttribute("transform"))!;
      await touch("touchMove", 80, 60);
      await expect(node(page, "ch1")).not.toHaveAttribute("transform", during);
      await touch("touchEnd");
      // The whole drag is one entry, and it is the one taken back.
      await undo(page);
      await expect(node(page, "ch1")).toHaveAttribute("transform", before);
      // Asked only now, after an undo that has visibly landed: keys are handled in order, so
      // the refused undo above has been handled too, and had it been permitted it would
      // have taken CH 2's entry.
      await expect(node(page, "ch2")).toHaveAttribute("transform", seeded);
    }
    return { bar, seen, refusedThenLifted };
  }

  test("a wheel turned with the mouse does not end it", async ({ page }) => {
    const t = await touchDrag(page);
    await page.mouse.wheel(0, 100);
    await expect.poll(async () => (await t.seen()).wheel).toEqual([0]);
    await t.refusedThenLifted();
  });

  test("the mouse moving with no button held does not end it", async ({ page }) => {
    const t = await touchDrag(page);
    await page.mouse.move(t.bar.x + 60, t.bar.y + t.bar.height / 2, { steps: 2 });
    await expect.poll(async () => (await t.seen()).move).toEqual([0, 0]);
    await t.refusedThenLifted();
  });

  test("a mouse click elsewhere does not end it", async ({ page }) => {
    const t = await touchDrag(page);
    await page.mouse.click(t.bar.x + 60, t.bar.y + t.bar.height / 2);
    await t.refusedThenLifted();
  });
});

// The native context menu takes the release of the press that opened it, so the page hears a
// right press and then a mouse moving with no button held. Headless Chromium opens no menu,
// so that move is dispatched here; the press is real.
test.describe("a right press inside the Inspector whose release never arrived", () => {
  /** A channel's Channel ON row, by the label the active language gives it. */
  const channelRow = (page: Page, label: string) =>
    page
      .locator("#inspector .param")
      .filter({ has: page.locator(".toggle") })
      .filter({ hasText: label });

  /** Press the right button on the row's label and move off it with no button held. */
  async function lostRightPress(page: Page): Promise<void> {
    const row = (await channelRow(page, en.inspector.channelOn).boundingBox())!;
    const x = row.x + 6;
    const y = row.y + row.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down({ button: "right" });
    await page.locator("#inspector").dispatchEvent("pointermove", {
      pointerId: 1,
      pointerType: "mouse",
      buttons: 0,
      clientX: x + 40,
      clientY: y,
    });
  }

  test("does not refuse the undo", async ({ page }) => {
    await node(page, "ch1").click();
    const row = channelRow(page, en.inspector.channelOn);
    await row.getByRole("button", { name: "OFF", exact: true }).click();
    await expect(row.getByRole("button", { name: "OFF", exact: true })).toHaveAttribute("aria-pressed", "true");
    await lostRightPress(page);
    await undo(page);
    await expect(row.getByRole("button", { name: "ON", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(status(page)).not.toHaveText(en.status.undoBusyDrag);
    await page.mouse.up({ button: "right" });
  });

  // The press holds the panel's rebuild until it ends, so what shows the hold released is a
  // repaint that arrives without a pointer: a language switch made from the keyboard.
  test("does not hold the Inspector's repaint", async ({ page }) => {
    await node(page, "ch1").click();
    await expect(channelRow(page, en.inspector.channelOn)).toHaveCount(1);
    await lostRightPress(page);
    await page.locator("#btn-prefs").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#prefs-modal")).toBeVisible();
    await chooseOption(page.locator("#prefs-lang"), "ja");
    await page.keyboard.press("Escape");
    await expect(page.locator("#prefs-modal")).toBeHidden();
    await expect(channelRow(page, ja.inspector.channelOn)).toHaveCount(1);
    await page.mouse.up({ button: "right" });
  });
});

// A finger holding a control in the Inspector holds the panel's repaint until it lifts. The mouse
// used meanwhile — moved with no button held, or clicked outside the panel — is not that finger
// lifting, so a repaint arriving from the keyboard waits for the finger. The touch goes through
// Chromium's own input pipeline over CDP; the mouse is the real one.
test.describe("a finger holding the Inspector while the mouse is used", () => {
  const channelRow = (page: Page, label: string) =>
    page
      .locator("#inspector .param")
      .filter({ has: page.locator(".toggle") })
      .filter({ hasText: label });

  for (const meanwhile of ["a mouse move with no button held", "a mouse click outside the panel"] as const) {
    test(`holds the repaint across ${meanwhile} until the finger lifts`, async ({ page }) => {
      await node(page, "ch1").click();
      const row = (await channelRow(page, en.inspector.channelOn).boundingBox())!;
      const bar = (await status(page).boundingBox())!;
      await page.mouse.move(bar.x + 10, bar.y + bar.height / 2);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
      // On the row's label, off its buttons, so the lift toggles nothing.
      const finger = { x: row.x + 6, y: row.y + row.height / 2, radiusX: 1, radiusY: 1 };
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [finger] });

      // A repaint that arrives without a pointer: a language switch made from the keyboard.
      await page.locator("#btn-prefs").focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("#prefs-modal")).toBeVisible();
      await chooseOption(page.locator("#prefs-lang"), "ja");
      await page.keyboard.press("Escape");
      await expect(page.locator("#prefs-modal")).toBeHidden();
      // The premise: the finger is holding it.
      await expect(channelRow(page, en.inspector.channelOn)).toHaveCount(1);

      if (meanwhile === "a mouse move with no button held")
        await page.mouse.move(bar.x + 40, bar.y + bar.height / 2, { steps: 2 });
      else await page.mouse.click(bar.x + 40, bar.y + bar.height / 2);
      // A release this hold acted on would land its repaint in the next task; a frame past it.
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))));
      await expect(channelRow(page, en.inspector.channelOn)).toHaveCount(1);

      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect(channelRow(page, ja.inspector.channelOn)).toHaveCount(1);
    });
  }
});

// Selecting a wire dispatches its own release, as a click does, so it leaves no press standing:
// two wheel bursts a second apart are two entries, and one undo takes back the second alone.
test("selecting a wire leaves no press behind to merge two wheel bursts", async ({ page }) => {
  await selectSend(page);
  const level = levelSlider(page);
  const v0 = await level.inputValue();
  const box = (await level.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -100);
  await expect(level).not.toHaveValue(v0);
  const v1 = await level.inputValue();
  // Longer than the idle backstop, so the first burst's entry has closed.
  await page.waitForTimeout(1000);
  await page.mouse.wheel(0, -100);
  await expect(level).not.toHaveValue(v1);
  await undo(page);
  await expect(level).toHaveValue(v1);
  await expect(status(page)).not.toHaveText(en.status.undoBusyDrag);
});

test("Ctrl+Z inside the name field belongs to the field, not to the plan", async ({ page }) => {
  // An app edit first, so there is an entry the field's press must not consume.
  await addNote(page, "ch2", "keep me");
  await expect(notePanel(page, "ch2")).toHaveCount(1);

  await node(page, "ch1").click();
  await nameInput(page).fill("VocalMic");
  await nameInput(page).focus();
  await undo(page);
  // The app did not act: no undo status, and the note is untouched.
  await expect(status(page)).not.toContainText("Undid");
  await expect(status(page)).not.toHaveText("Undone");
  await expect(notePanel(page, "ch2")).toHaveCount(1);

  // Off the field the shortcut is the plan's again, and the note is still on the
  // stack behind the rename. How many entries the rename itself became is not
  // asserted: the field's own undo fires an input event of its own, so whether that
  // lands in the same entry depends on the pause between the two, which is a
  // property of how fast the keys arrive rather than of the history.
  await page.locator("#graph-host").click({ position: { x: 5, y: 5 } });
  for (let i = 0; i < 4; i++) await undo(page);
  await expect(notePanel(page, "ch2")).toHaveCount(0);
});

test("Ctrl+Shift+Z does not flip fine-tuning mode", async ({ page }) => {
  await page.click("#btn-prefs");
  await page.click('#prefs-fine button:has-text("Latch")');
  await page.click("#prefs-modal .consent-btn-secondary");
  await expect(page.locator("#prefs-modal")).toBeHidden();

  // The latch flips on every bare Shift press, so the redo chord must not read as
  // one — it would leave fine mode on for good.
  await redoShift(page);
  await expect(page.locator("html")).not.toHaveClass(/fine-mode/);
  await redoShift(page);
  await expect(page.locator("html")).not.toHaveClass(/fine-mode/);
  // A bare Shift still latches.
  await page.keyboard.down("Shift");
  await page.keyboard.up("Shift");
  await expect(page.locator("html")).toHaveClass(/fine-mode/);
});

test("an open dialog refuses the shortcut instead of reaching the board behind it", async ({ page }) => {
  await addNote(page, "ch1", "behind the scrim");
  await expect(notePanel(page, "ch1")).toHaveCount(1);

  await page.click("#btn-prefs");
  await expect(page.locator("#prefs-modal")).toBeVisible();
  await undo(page);
  await expect(status(page)).toHaveText("Close the open dialog before undoing");
  await expect(notePanel(page, "ch1")).toHaveCount(1);

  await page.click("#prefs-modal .consent-btn-secondary");
  await undo(page);
  await expect(notePanel(page, "ch1")).toHaveCount(0);
});

test("the status line names the node when an entry touched exactly one", async ({ page }) => {
  await addNote(page, "ch1", "named");
  await undo(page);
  await expect(status(page)).toHaveText("Undid the change to CH 1");
  await redoShift(page);
  await expect(status(page)).toHaveText("Redid the change to CH 1");
});

test("Delete and Escape still behave with the shortcut sharing the handler", async ({ page }) => {
  const base = await wires(page).count();
  await connect(page);
  await expect(wires(page)).toHaveCount(base + 1);
  await wires(page).last().dispatchEvent("pointerdown");
  await wires(page).last().dispatchEvent("pointerup");
  await page.keyboard.press("Delete");
  await expect(wires(page)).toHaveCount(base);
  await expect(status(page)).toHaveText("Connection deleted");

  await node(page, "ch1").click();
  await expect(nameInput(page)).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(nameInput(page)).toHaveCount(0);
});
