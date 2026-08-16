import { test, expect, type Page } from "./fixtures";
import { panelHeight, pickBand } from "./dyn-helpers";

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const param = (page: Page, label: string) => page.locator("#inspector .param", { hasText: label });
const typeSelect = (page: Page) => param(page, "COMP/EQ Type").locator("select");

const box = (page: Page) => page.locator("#dyn-screen-box");
/** A screen row by its EXACT label: "Q" substring-matches nothing else here, but
 *  "Gain" matches "Out Gain" and picking by DOM order would follow an inserted row. */
const screenRow = (page: Page, label: string) =>
  box(page)
    .locator(".prefs-row")
    .filter({ has: page.getByText(label, { exact: true }) });

/** Switch a mono channel into the morphing bank and open the face named. */
const openFace = async (page: Page, kind: "ssmcs" | "ssmcsComp" | "ssmcsEq", section: RegExp) => {
  await node(page, "ch1").click();
  if ((await typeSelect(page).inputValue()) !== "1") await typeSelect(page).selectOption("1");
  const sec = page.locator("#inspector .insp-section", { has: page.locator("summary", { hasText: section }) });
  if (!(await sec.evaluate((el) => (el as HTMLDetailsElement).open))) await sec.locator("summary").click();
  await sec.locator(`#btn-${kind}-screen`).click();
  await expect(box(page)).toBeVisible();
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("switching a mono channel to SSMCS swaps the inspector's sections and their launchers", async ({ page }) => {
  await node(page, "ch1").click();
  const sel = typeSelect(page);
  await expect(sel).toHaveValue("0"); // COMP->EQ

  // COMP->EQ mode: the shipped screens' launchers, and no SSMCS section at all.
  await expect(page.locator("#btn-comp-screen")).toHaveCount(1);
  await expect(page.locator("#btn-ssmcs-screen")).toHaveCount(0);

  await sel.selectOption("1"); // SSMCS
  // Each of the three sections offers its own face, and the two shipped screens' own
  // launchers are gone — a channel carries one bank, never both.
  await expect(page.locator("#btn-ssmcs-screen")).toHaveCount(1);
  await expect(page.locator("#btn-ssmcsComp-screen")).toHaveCount(1);
  await expect(page.locator("#btn-ssmcsEq-screen")).toHaveCount(1);
  await expect(page.locator("#btn-comp-screen")).toHaveCount(0);
  await expect(page.locator("#btn-eq-screen")).toHaveCount(0);
  // Entering the bank turns both sections ON, and a section follows its on-state, so both
  // unfold. Asserted in this direction as well as on the way back: the app mirrors the
  // unit's own reset here, and only one of the two directions was left covered.
  const compSec = page.locator("#inspector details").filter({ has: page.locator("summary", { hasText: "COMP" }) });
  const eqSec = page.locator("#inspector details").filter({ has: page.locator("summary", { hasText: "EQ" }) });
  await expect(compSec).toHaveAttribute("open", "");
  await expect(eqSec).toHaveAttribute("open", "");

  // The values themselves live on the screen now: a copy here would read a snapshot
  // taken at render time and write it back on the next drag.
  await expect(param(page, "Sweet Spot Data")).toHaveCount(0);
  await expect(param(page, "Comp Drive")).toHaveCount(0);

  // The SSMCS Main section sits between GATE and COMP.
  const titles = await page.locator("#inspector summary").allInnerTexts();
  const gate = titles.findIndex((t) => t.includes("GATE"));
  const ssmcs = titles.findIndex((t) => t.includes("SSMCS"));
  const comp = titles.findIndex((t) => t.includes("COMP"));
  expect(gate).toBeGreaterThanOrEqual(0);
  expect(gate).toBeLessThan(ssmcs);
  expect(ssmcs).toBeLessThan(comp);

  // Back to COMP->EQ takes the SSMCS section away and resets to COMP off / EQ on.
  await sel.selectOption("0");
  await expect(page.locator("#btn-ssmcs-screen")).toHaveCount(0);
  await expect(compSec).not.toHaveAttribute("open", ""); // COMP off → folded
  await expect(eqSec).toHaveAttribute("open", ""); // EQ on → open
});

test("re-entering an SSMCS/COMP->EQ mode resets that bank to factory", async ({ page }) => {
  // The device treats the two chains as exclusive and reloads the destination
  // chain's factory values on every switch; the planner mirrors that offline.
  await openFace(page, "ssmcs", /^SSMCS$/);
  const ssd = screenRow(page, "Sweet Spot Data").locator("select");
  await expect(ssd).toHaveValue("1"); // factory "01 Basic"
  await ssd.selectOption("14"); // 08 MR Vocal
  await expect(ssd).toHaveValue("14");
  await box(page).locator(".consent-btn-secondary").click();

  // Leave SSMCS and come back: the morphing strip reloads factory, not "08 MR Vocal".
  await typeSelect(page).selectOption("0"); // COMP->EQ
  await openFace(page, "ssmcs", /^SSMCS$/);
  await expect(screenRow(page, "Sweet Spot Data").locator("select")).toHaveValue("1");
});

test("toggling the SSMCS value reverts its fold to follow the on-state", async ({ page }) => {
  await node(page, "ch1").click();
  await typeSelect(page).selectOption("1"); // SSMCS
  const ssmcs = page.locator("#inspector details").filter({ has: page.locator("summary", { hasText: "SSMCS" }) });
  const onOff = ssmcs.locator(".sec-body > .param").first();
  await expect(ssmcs).toHaveJSProperty("open", true); // on by default → open

  // Turn SSMCS off: the section folds with the on-state.
  await onOff.locator("button", { hasText: "OFF" }).click();
  await expect(ssmcs).toHaveJSProperty("open", false);

  // Open it by hand while off; the manual fold persists.
  await ssmcs.locator("summary").click();
  await expect(ssmcs).toHaveJSProperty("open", true);

  // Toggling the value on then off must drop the manual override, so an off
  // SSMCS folds again rather than staying open from the earlier hand-open.
  await onOff.locator("button", { hasText: "ON" }).click();
  await expect(ssmcs).toHaveJSProperty("open", true);
  await onOff.locator("button", { hasText: "OFF" }).click();
  await expect(ssmcs).toHaveJSProperty("open", false);
});

test("SSMCS is a MONO IN feature — stereo channels have no COMP/EQ Type", async ({ page }) => {
  await node(page, "ch_5_6").click();
  await expect(typeSelect(page)).toHaveCount(0);
  await expect(page.locator("#btn-ssmcs-screen")).toHaveCount(0);
  // The positive control: this channel's inspector really did render, and it carries the
  // processors it does have. Without it the two counts above are satisfied by an
  // inspector that failed to build at all, or by a click that selected nothing.
  await expect(page.locator("#btn-eq-screen")).toHaveCount(1);
  await expect(param(page, "EQ")).not.toHaveCount(0);
});

test.describe("the tuning screen's three faces", () => {
  const face = (page: Page, name: "main" | "comp" | "eq") => box(page).locator(`#dyn-face-ssmcs-${name}`);

  test("moves between the faces from the title row, on one title and one channel", async ({ page }) => {
    await openFace(page, "ssmcs", /^SSMCS$/);
    const title = box(page).locator("#dyn-screen-title");
    await expect(title).toContainText("CH 1");
    await expect(title).toContainText("SSMCS");
    await expect(face(page, "main")).toHaveAttribute("aria-pressed", "true");

    // Moved, not closed and reopened — counted off the SCRIM's `hidden` flag over the
    // press. Neither the modal element nor its visibility can answer this: `#dyn-screen-box`
    // is a fixed element in the markup that outlives every open, and `close()` only hides
    // the scrim, so a marker put on the box survives a close and a reopen just as `hidden`
    // being false does on both sides of one. Only the transition itself distinguishes them.
    await page.evaluate(() => {
      const scrim = document.getElementById("dyn-screen-modal")!;
      const w = window as unknown as { __closes: number };
      w.__closes = 0;
      // The RECORDS, not the flag's value when the callback runs. A close followed
      // immediately by a reopen lands both writes in one batch, and by the time the
      // callback is called `hidden` is false again — so reading the flag there reports a
      // screen that never closed. Measured: an implementation that closed and reopened on
      // every face press passed against that reading.
      new MutationObserver((records) => {
        w.__closes += records.length;
      }).observe(scrim, { attributes: true, attributeFilter: ["hidden"] });
    });
    const closes = () => page.evaluate(() => (window as unknown as { __closes: number }).__closes);

    await face(page, "comp").click();
    await expect(face(page, "comp")).toHaveAttribute("aria-pressed", "true");
    expect(await closes()).toBe(0);
    // Naming each face would print the shipped COMP screen's title, and nothing would
    // then say which of the channel's two banks is on screen.
    await expect(title).toContainText("SSMCS");
    await expect(title).toContainText("CH 1");

    await face(page, "eq").click();
    await expect(face(page, "eq")).toHaveAttribute("aria-pressed", "true");
    expect(await closes()).toBe(0);

    // The positive control, and it is what makes the two counts above mean anything: an
    // observer that never attached, or a close that this page reports some other way,
    // reads exactly like a screen that stayed open.
    await box(page).locator(".consent-btn-secondary").click();
    expect(await closes()).toBeGreaterThan(0);
  });

  // The face segment is a SIBLING of the heading rather than a child, so the dialog's
  // accessible name stays the channel and the bank. Wrapping the heading is free only if
  // the row occupies what the heading did — measured, it came up 12px until the heading's
  // own margin moved onto the row — so the space under the title is compared against a
  // screen that has no faces and therefore no wrapper.
  test("costs the panel no vertical space, and keeps the buttons out of the dialog's name", async ({ page }) => {
    const gapUnderTitle = () =>
      box(page).evaluate((el) => {
        const head = el.querySelector("h2")!;
        const grid = el.querySelector(".prefs-grid")!;
        return Math.round(grid.getBoundingClientRect().top - head.getBoundingClientRect().bottom);
      });

    await node(page, "ch1").click();
    const gate = page.locator("#inspector .insp-section", { has: page.locator("summary", { hasText: /^GATE$/ }) });
    if (!(await gate.evaluate((el) => (el as HTMLDetailsElement).open))) await gate.locator("summary").click();
    await gate.locator("#btn-gate-screen").click();
    const plain = await gapUnderTitle();
    await box(page).locator(".consent-btn-secondary").click();

    await openFace(page, "ssmcs", /^SSMCS$/);
    expect(await gapUnderTitle()).toBe(plain);

    // The dialog names itself with the heading, so a button inside it joins that name.
    const name = await box(page).evaluate(() => {
      const id = document.querySelector("#dyn-screen-modal")!.getAttribute("aria-labelledby")!;
      const el = document.getElementById(id)!;
      return { text: el.textContent, buttons: el.querySelectorAll("button").length };
    });
    expect(name.buttons).toBe(0);
    expect(name.text).toBe("CH 1SSMCS");
  });

  test("each section's launcher opens its own face", async ({ page }) => {
    await openFace(page, "ssmcsComp", /^COMP$/);
    await expect(face(page, "comp")).toHaveAttribute("aria-pressed", "true");
    await box(page).locator(".consent-btn-secondary").click();

    await openFace(page, "ssmcsEq", /^EQ$/);
    await expect(face(page, "eq")).toHaveAttribute("aria-pressed", "true");
  });

  // Layout, so it is only answerable here: jsdom lays nothing out, and the reserve is two
  // CSS rules plus a hidden bar the host builds. Both halves are the same requirement —
  // the segment that moves between the faces is in the title row, so a modal that resizes
  // moves the control the operator just pressed, and a display panel that starts at a
  // different y makes the plot jump under the eye that is reading it.
  // Three runs, and each one is here because the other two cannot see what it sees.
  //
  // **Japanese** is where the reserve does its work. Measured with the floor removed: in
  // English the three faces coincide at 656.4px on their own, so an English run passes
  // against no reserve at all — while Japanese lands the COMP face at 660.4 and the other
  // two at 656.4, because a translated row label is wider and its column is the tallest
  // thing on that face. A guard for a floor has to run in the language whose content
  // reaches it.
  //
  // **960x640** is the smallest window the shell allows (`tauri.conf.json`: minWidth 960,
  // minHeight 640), and a floor is only safe if it yields there. `.consent-box` clamps
  // itself to the viewport, and the action row carrying Close is its last child, so a grid
  // that refuses to shrink pushes Close past the fold — measured before the floor learned
  // to yield: 68px past the box's own edge.
  const RUNS = [
    { lang: "en", size: null },
    { lang: "ja", size: null },
    { lang: "en", size: { width: 960, height: 640 } },
  ] as const;
  for (const run of RUNS) {
    const at = `${run.lang}, ${run.size ? `${run.size.width}x${run.size.height}` : "the default window"}`;
    test(`every face is one height with its display panel at one top edge (${at})`, async ({ page }) => {
      if (run.size) await page.setViewportSize(run.size);
      if (run.lang !== "en") {
        // A second init script rather than a write plus a reload: the suite's own init
        // script sets the language on EVERY navigation, so a value written into storage is
        // overwritten by it on the way back in and the run silently stays in English.
        // Init scripts run in the order they were added, so this one lands after it.
        await page.addInitScript((l) => localStorage.setItem("urx-lang", l), run.lang);
        await page.reload();
        await expect(page.locator("#model-picker")).toHaveValue("URX44V");
        await expect(page.locator("#btn-view-console")).toHaveText("コンソール");
      }
      await openFace(page, "ssmcs", /^SSMCS$/);
      const geom = () =>
        box(page).evaluate((el) => {
          const b = el.getBoundingClientRect();
          const panel = el.querySelector(".gt-curvebox, .gt-ladderbox")!.getBoundingClientRect();
          const close = el.querySelector(".consent-btn-secondary")!.getBoundingClientRect();
          return {
            height: Math.round(b.height),
            panelTop: Math.round(panel.top - b.top),
            closeOverflow: Math.round(close.bottom - b.bottom),
            hint: (el.querySelector(".gt-note")?.textContent ?? "").trim(),
          };
        });
      const main = await geom();
      const seen = [main.hint];
      const pressed = [(await box(page).locator('.gt-modes button[aria-pressed="true"]').innerText()).trim()];
      expect(main.closeOverflow).toBeLessThanOrEqual(0);
      // The Side Chain segment is walked as well as the three faces: it carries the WIDEST
      // rack (three columns, four readout tiles) and is the one that wrapped against the
      // measured floor this arrangement replaced, so leaving it out skips the case.
      for (const f of ["comp", "sidechain", "eq"] as const) {
        await box(page)
          .locator(f === "sidechain" ? "#dyn-mode-sidechain" : `#dyn-face-ssmcs-${f}`)
          .click();
        const g = await geom();
        expect(g.height, f).toBe(main.height);
        expect(g.panelTop, f).toBe(main.panelTop);
        expect(g.closeOverflow, f).toBeLessThanOrEqual(0);
        seen.push(g.hint);
        pressed.push((await box(page).locator('.gt-modes button[aria-pressed="true"]').innerText()).trim());
      }
      // The positive control: the faces really are different faces. Without it, a build
      // that rendered the same one three times would satisfy every line above. Read off the
      // HINT and the pressed segment rather than the row count or the panel kind — all
      // three faces carry four rows and all three draw a plot, so neither separates them.
      expect(new Set(seen).size).toBe(4);
      expect(new Set(pressed).size).toBe(4);
    });
  }

  test("the face is not carried to the next open", async ({ page }) => {
    await openFace(page, "ssmcs", /^SSMCS$/);
    await face(page, "eq").click();
    await box(page).locator(".consent-btn-secondary").click();
    await openFace(page, "ssmcs", /^SSMCS$/);
    await expect(face(page, "main")).toHaveAttribute("aria-pressed", "true");
  });

  test("MAIN shows both curves and four readouts, with no lane rack", async ({ page }) => {
    await openFace(page, "ssmcs", /^SSMCS$/);
    expect(await box(page).locator(".prefs-row .lbl").allInnerTexts()).toEqual([
      "Sweet Spot Data",
      "Comp Drive",
      "Morphing",
      "Out Gain",
    ]);
    await expect(screenRow(page, "Sweet Spot Data").locator("option")).toHaveCount(34);
    await expect(box(page).locator("#dyn-curve")).toBeVisible();
    await expect(box(page).locator(".gt-ladderbox")).toHaveCount(0);
    await expect(box(page).locator(".gt-ro")).toHaveCount(4);
    // Four tiles take two columns.
    await expect(box(page).locator(".gt-readouts")).toHaveClass(/two/);
  });

  test("COMP reads its eight rows in the unit's own order, four per segment", async ({ page }) => {
    await openFace(page, "ssmcsComp", /^COMP$/);
    // Each segment carries the sliders whose effect is on the plot beside it, and the two
    // sets are four rows each — which is what holds this face at the height its siblings
    // are held at.
    expect(await box(page).locator(".prefs-row .lbl").allInnerTexts()).toEqual(["Attack", "Release", "Ratio", "Knee"]);
    await box(page).locator("#dyn-mode-sidechain").click();
    expect(await box(page).locator(".prefs-row .lbl").allInnerTexts()).toEqual(["Side Chain", "Q", "Freq", "Gain"]);
    await box(page).locator("#dyn-face-ssmcs-comp").click();
    // The bank's corner is an internal value the unit never shows, so the lane rack
    // carries no fader cap — the one gesture the rack otherwise has.
    await expect(box(page).locator(".gt-cap")).toHaveCount(0);
    // The positive control, on the screen next door: the same selector finds one where a
    // rack DOES carry a cap, so the count above is a statement about this face rather
    // than about a class that was renamed out from under it.
    await box(page).locator(".consent-btn-secondary").click();
    await node(page, "ch2").click();
    const gate = page.locator("#inspector .insp-section", { has: page.locator("summary", { hasText: /^GATE$/ }) });
    if (!(await gate.evaluate((el) => (el as HTMLDetailsElement).open))) await gate.locator("summary").click();
    await gate.locator("#btn-gate-screen").click();
    await expect(box(page).locator(".gt-cap")).toHaveCount(1);
  });

  // One bar stands in front of the whole bank, and this face is two of its four segments —
  // because this compressor has an input the shipped one does not: a filter in front of its
  // detector, whose response the second segment draws. Driven end to end here because the
  // unit tests hold the model and the drawing; what only the built app answers is whether
  // the segments are on the bar, whether pressing one switches the panel, and whether the
  // sliders beside it still reach the plan.
  test("COMP offers a Side Chain segment, and the filter's sliders move its curve", async ({ page }) => {
    await openFace(page, "ssmcsComp", /^COMP$/);
    await expect(box(page).locator(".gt-modes button")).toHaveText(["MAIN", "COMP", "Side Chain", "EQ"]);

    // Each segment is one height, so pressing one does not move the button that was just
    // pressed. The curve's own height is the reference the other is measured against.
    const curveHeight = await panelHeight(page);
    const columns = () => box(page).locator(".gt-ladders .gt-slot").count();
    // The curve is the compressor's own pair, and the reduction merges into the PRE EQ
    // column it was taken off — so two, not three.
    await expect(box(page).locator("#dyn-curve")).toBeVisible();
    await expect(box(page).locator(".gt-ladderbox")).toHaveCount(1);
    expect(await columns()).toBe(2);

    await box(page).locator("#dyn-mode-sidechain").click();
    await expect(box(page).locator("#dyn-mode-sidechain")).toHaveAttribute("aria-pressed", "true");
    // The plot AND the rack, which is what this segment is for: set the filter, watch the
    // reduction it buys. It keeps the side-chain lane the curve drops, so three.
    await expect(box(page).locator("#dyn-curve")).toBeVisible();
    await expect(box(page).locator(".gt-ladderbox")).toHaveCount(1);
    expect(await columns()).toBe(3);
    await expect(box(page).locator(".gt-note")).toHaveText(/side-chain filter/);
    expect(await panelHeight(page)).toBe(curveHeight);

    // The curve is a canvas, so what an E2E run can hold is that the gesture reaches the
    // plan the curve is drawn from — the pixels are the unit suite's, against a recording
    // context that can name what was drawn.
    const gain = screenRow(page, "Gain").locator("input[type=range]");
    const readout = screenRow(page, "Gain").locator(".gt-val");
    const before = await readout.innerText();
    await gain.fill(String(Number(await gain.inputValue()) + 60)); // +6.0 dB
    await gain.dispatchEvent("input");
    await expect(readout).not.toHaveText(before);
    await expect(readout).toHaveText(/dB/);

    // The choice persists, which is what `persistSel` claims: it is a way of reading the
    // processor rather than a place in a flow.
    await box(page).locator(".consent-btn-secondary").click();
    await openFace(page, "ssmcsComp", /^COMP$/);
    await expect(box(page).locator("#dyn-mode-sidechain")).toHaveAttribute("aria-pressed", "true");
  });

  test("the EQ face keeps four rows and one height on every band", async ({ page }) => {
    await openFace(page, "ssmcsEq", /^EQ$/);
    const first = await panelHeight(page);
    for (const [i, band] of (["low", "mid", "high"] as const).entries()) {
      await pickBand(page, i);
      const labels = await box(page).locator(".prefs-row .lbl").allInnerTexts();
      expect(labels, band).toEqual(["Band", "Q", "Freq", "Gain"]);
      // A shelf has no Q at all; the row stays and says so, so the panel does not move
      // under the pointer that just pressed the band beside it.
      const locked = band !== "mid";
      await expect(screenRow(page, "Q"), band).toHaveClass(locked ? /locked/ : /^((?!locked).)*$/);
      expect(await panelHeight(page), band).toBe(first);
    }
  });
});

test("the CONSOLE strip offers one opener for the whole morphing bank", async ({ page }) => {
  const openers = (strip: ReturnType<Page["locator"]>) =>
    strip.locator(".con-chip-open").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));

  await page.click("#btn-view-console");
  const strip = page.locator(".con-strip", { has: page.getByText("CH 1", { exact: true }) });
  // In the other bank the strip carries three, one beside each processor it can tune.
  expect(await openers(strip)).toEqual(["Gate screen", "Comp screen", "EQ screen"]);

  await page.click("#btn-view-graph");
  await node(page, "ch1").click();
  await typeSelect(page).selectOption("1");
  await page.click("#btn-view-console");
  // In the morphing bank the SSMCS chip carries the only one: its COMP and EQ faces are
  // reached from the segment inside the screen, and the strip's own COMP and EQ chips read
  // as they do on a channel with no strip at all. By label rather than by count — every
  // opener is the same glyph, and the two banks carry the same NUMBER of chips either way,
  // since the parity spacer takes whatever slot an opener frees.
  await expect(strip.locator(".con-chip", { hasText: /^SSMCS$/ })).toHaveCount(1);
  expect(await openers(strip)).toEqual(["Gate screen", "SSMCS screen"]);

  await strip.locator('.con-chip-open[aria-label="SSMCS screen"]').click();
  await expect(box(page).locator("#dyn-face-ssmcs-main")).toHaveAttribute("aria-pressed", "true");
});
