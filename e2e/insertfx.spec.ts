import { test, expect, type Page } from "./fixtures";
import { planParamZ } from "./plan-param";
import { dialogsOf, stubTauriDevice, writesOf } from "./tauri-stub";
import { chooseOption } from "./choose-option";
import { insertFxSection, openInsertFxSection } from "./insert-fx-section";

// Insert-FX effect editing: selecting an insert effect (guitar amp / pitch fix /
// compander / multi-band comp) reveals its parameter editor, and the values
// round-trip through save/open. Slots/encodings: core/control/insert-fx-effect.ts.

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const insertSelect = (page: Page) => page.locator("#inspector .param", { hasText: "EFFECT TYPE" }).locator("select");
// Insert FX is a collapsible on-state section like GATE / COMP / EQ, so its bypass row is
// the section's own toggle and carries NO label — the header is its name. Reached through
// the section rather than by a row label, the way the panel's other sections are.
const insertFxBypass = (page: Page) => insertFxSection(page).locator(".sec-body .toggle");
const param = (page: Page, label: string) => page.locator("#inspector .param", { hasText: label });
// The families the tuning screen shows whole (the guitar amps and the companders) keep
// their sliders there rather than in the Inspector, so a case about one of those opens
// the screen and reads its rows. Pitch Fix and the multi-band compressor still edit in
// the Inspector, and their cases below still read `param`.
const screenBox = (page: Page) => page.locator("#dyn-screen-box");
// Both shapes a value can be shown in. A guitar amp lays its continuous values out as
// knob cards rather than as rows — its real control is a row of knobs — and a locator that
// named only the rows would report those faces as EMPTY, which reads here as the feature
// being absent rather than as the layout having moved.
const screenRow = (page: Page, label: string) =>
  screenBox(page)
    .locator(".prefs-row, .gt-knob")
    .filter({ has: page.getByText(label, { exact: true }) });
const openScreen = async (page: Page): Promise<void> => {
  // The launcher lives in the Insert FX section, which folds with its own ON state — so a
  // BYPASSED effect (and one a device readback landed with the switch off) has it behind a
  // closed disclosure. Opening first is what the operator does, and it is not the subject
  // of any case that calls this.
  await openInsertFxSection(page);
  await page.locator("#btn-insfx-screen").click();
  await expect(screenBox(page)).toBeVisible();
};
const closeScreen = (page: Page) => page.locator("#dyn-screen-modal .consent-btn-secondary").click();
const screenSelect = (page: Page, label: string) => screenRow(page, label).locator("select");
// COMPANDER_PARAMS writable slots: threshold / ratio / attack / release / outGain / width.
const COMPANDER_SLOT_COUNT = 6;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await page.locator("#model-picker").waitFor();
});

test("guitar amp (Clean) reveals common params + cabinet list", async ({ page }) => {
  await node(page, "ch1").click();
  await chooseOption(insertSelect(page), { label: "Clean" });
  await openScreen(page);
  // Common params appear. Slot 7 reads Volume here and Gain on the other three amps —
  // the unit's own labelling, and the one row whose name depends on the type.
  await expect(screenRow(page, "Volume")).toBeVisible();
  await expect(screenRow(page, "Gain")).toHaveCount(0);
  await expect(screenRow(page, "Treble")).toBeVisible();
  await expect(screenRow(page, "Output")).toBeVisible();
  await expect(screenRow(page, "Blend")).toBeVisible(); // Clean-only
  // The cabinet is on the SAME face, between the amp and Output — where the effect guide's
  // own common table puts it — so both halves are reachable without a switch.
  await expect(screenRow(page, "Gate Level")).toBeVisible();
  await expect(screenBox(page).locator(".gt-facebar button")).toHaveCount(0);
  // SP Type lists the eight cabinets in order.
  await expect(screenSelect(page, "SP Type").locator("option")).toHaveText([
    "BS 4x12",
    "AC 2x12",
    "AC 1x12",
    "AC 4x10",
    "BC 2x12",
    "AM 4x12",
    "YC 4x12",
    "JC 2x12",
  ]);
});

// The row break is GEOMETRY, and the DOM order it sits in cannot see whether it worked:
// an element in the right place that never spans the grid leaves the two groups running
// together, with every order assertion in this file still green. So this measures — the
// first row below the break has to start at the panel's own left edge and sit under the
// last row above it.
test("a guitar amp's modulation group starts a row of its own", async ({ page }) => {
  await node(page, "ch1").click();
  await chooseOption(insertSelect(page), { label: "Clean" });
  await openScreen(page);
  const grid = screenBox(page).locator(".gt-knobs");
  const box = async (row: string) => (await screenRow(page, row).boundingBox())!;
  const gridBox = (await grid.boundingBox())!;
  // The positive control: SOME card on this face is well right of the panel's left edge,
  // so "starts at the left edge" discriminates. Asked of the whole face rather than of one
  // named card, which would be a claim about where the rows happen to wrap.
  const lefts = await screenBox(page)
    .locator(".gt-knob")
    .evaluateAll((cards) => cards.map((c) => c.getBoundingClientRect().x));
  expect(Math.max(...lefts)).toBeGreaterThan(gridBox.x + 100);
  // Presence is the last card above the break whatever the column count is, and Modulation
  // the first below it.
  const [presence, mod] = [await box("Presence"), await box("Modulation")];
  expect(Math.abs(mod.x - gridBox.x)).toBeLessThan(4);
  expect(mod.y).toBeGreaterThan(presence.y + presence.height - 4);
  await closeScreen(page);
});

// The guitar amp's continuous values are KNOBS. It was specified and not built: every row
// rendered as a horizontal slider.
//
// Asserted on the shape rather than on a screenshot, because what went wrong was
// structural: the rows existed, carried the right labels and the right values, and every
// assertion in this file passed while the panel looked nothing like the design.
test("a guitar amp's values are knobs, on one face with no bar", async ({ page }) => {
  await node(page, "ch1").click();
  await chooseOption(insertSelect(page), { label: "Clean" });
  await openScreen(page);

  // Every continuous value is a knob. Counted rather than sampled: one knob among eleven
  // sliders would satisfy a locator that only asks whether any exist.
  // Clean's eleven: Volume, Blend, Distortion, Bass, Middle, Treble, Presence, Speed,
  // Depth, Gate Level, Output. The modulation selector and the cabinet's three are not
  // continuous and are not among them.
  const knobs = screenBox(page).locator(".gt-knob");
  await expect(knobs).toHaveCount(11);
  // …and none of them is a bare row with a horizontal slider in it. `.gt-knob` carries a
  // range input INSIDE the knob, which is the point: the value, the step and the keyboard
  // stay the range's own contract.
  await expect(screenBox(page).locator(".prefs-row input[type=range]")).toHaveCount(0);
  await expect(knobs.first().locator(".con-knob input[type=range]")).toHaveCount(1);

  // The indicator turns with the value, so the picture is of the value rather than beside
  // it. Read off the custom property the console's own knobs use.
  const rot = (name: string) =>
    screenBox(page)
      .locator(".gt-knob", { has: page.getByText(name, { exact: true }) })
      .locator(".con-knob .ind")
      .evaluate((e) => e.style.getPropertyValue("--rot"));
  // Distortion ships at its minimum and Blend at mid, so the two must not point the same way.
  expect(await rot("Distortion")).not.toBe(await rot("Blend"));

  // No bar at all: the cabinet joined the amp on one face, and a bar with one item is a
  // control that does nothing. The display column is still the lane rack.
  await expect(screenBox(page).locator(".gt-facebar button")).toHaveCount(0);
  await expect(screenBox(page).locator(".gt-splitdisplay, .gt-ladderbox").first()).toBeVisible();
  await closeScreen(page);
});

// What every other case in this file cannot see, and what shipped because of it: WHERE a
// control ended up. A guitar face is one panel of equal cards, and a selector rendered as
// an ordinary settings row satisfies every locator here — it is present, visible, carries
// its label and drives its value — while spanning every column and putting its control
// an amp's width from the label naming it, which cuts the panel into blocks. The cabinet's
// last two selectors were outside the panel altogether. 470 of 470 cases passed on it.
//
// So this measures rectangles, in the built bundle, which is the only place that answers:
// jsdom lays nothing out, and the unit guard beside it can only ask which container an
// element is IN.
test("every control on a guitar face is a card in the one panel", async ({ page }) => {
  const geometry = () =>
    screenBox(page).evaluate((box) => {
      const grid = box.querySelector(".gt-knobs");
      if (!grid) return null;
      const g = grid.getBoundingClientRect();
      // The section the panel is in, reached from the panel rather than named: a class
      // that does not exist matches nothing, and a count of nothing is zero, which is
      // the assertion passing for the reason it was written to catch. -1 where there is
      // no section, so a panel that lost its host fails rather than reads as clean.
      const sec = grid.closest(".prefs-section");
      return {
        cols: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
        gridWidth: g.width,
        outside: sec ? [...sec.querySelectorAll(".prefs-row")].filter((r) => !r.closest(".gt-knobs")).length : -1,
        // The row break is not a card and is measured separately below: it is the one
        // child that SPANS, so folding it in here would mean loosening the width ceiling
        // the whole assertion is.
        cards: [...grid.children]
          .filter((c) => !c.classList.contains("gt-break"))
          .map((c) => {
            const r = c.getBoundingClientRect();
            return { w: r.width, h: r.height, inside: r.left >= g.left - 1 && r.right <= g.right + 1 };
          }),
        breaks: [...grid.querySelectorAll(".gt-break")].map((c) => c.getBoundingClientRect().width),
        // The value under a card's name. Its class comes from a settings ROW's recipe,
        // where the value sits in a fixed-width cell at the end of a line — carried into a
        // card unchanged, a short value renders against that cell's left edge and reads as
        // hung off the card rather than centred under the label it belongs to.
        valueAlign: [
          ...new Set([...grid.querySelectorAll(".gt-knob .gt-val")].map((v) => getComputedStyle(v).textAlign)),
        ],
      };
    });

  // Clean, Crunch, Lead and Drive, rather than Clean alone: the type-specific control is a
  // different descriptor on each — Blend and Distortion, Character, Character, Amp Type —
  // so measuring one amp leaves the other three unmeasured. Lead's screen was opened by no
  // browser case at all before this.
  for (const type of ["Clean", "Crunch", "Lead", "Drive"]) {
    await node(page, "ch1").click();
    await chooseOption(insertSelect(page), { label: type });
    await openScreen(page);

    {
      const at = type;
      const g = (await geometry())!;
      expect(g, at).not.toBeNull();
      // The panel is the seven-column grid the design names. Read AND asserted: collected
      // and left unread, a fallback to two or twelve tracks passes everything below.
      expect(g.cols, `${at} columns`).toBe(7);
      // Nothing beside the panel. This is the cabinet's failure: two selectors were
      // appended to the column after the grid, so they rendered under it rather than in it.
      expect(g.outside, at).toBe(0);
      // Every card is ONE column wide. Against a sixth of the grid rather than a half: a
      // card two or three columns wide is still a control laid across its neighbours, and
      // a half-width ceiling admits both.
      for (const c of g.cards) {
        expect(c.w, `${at} card width`).toBeLessThan(g.gridWidth / 4);
        expect(c.inside, `${at} card inside the panel`).toBe(true);
      }
      // …and they are one row of cards rather than a mixture of heights: a card that keeps
      // a control's own shape is shorter than a knob's, which steps the row it sits in.
      const heights = new Set(g.cards.map((c) => Math.round(c.h)));
      expect([...heights], `${at} card heights`).toHaveLength(1);
      // Exactly one break, and it SPANS: filtered out of the cards above, a break that had
      // stopped spanning would leave every assertion here green while the two groups it
      // separates ran together.
      expect(g.breaks.length, `${at} breaks`).toBe(1);
      expect(g.breaks[0], `${at} break span`).toBeGreaterThan(g.gridWidth - 2);
      // …and every card's value is centred, like the name above it.
      expect(g.valueAlign, `${at} value alignment`).toEqual(["center"]);
    }
    await closeScreen(page);
  }
});

// …and the other families keep sliders, which is what says the knobs are a decision about
// the guitar amp rather than a change to every screen.
test("a compander keeps horizontal sliders and gains its transfer curve", async ({ page }) => {
  await node(page, "bus.stereo").click();
  await chooseOption(insertSelect(page), { label: "Compander-H" });
  await openScreen(page);
  await expect(screenBox(page).locator(".gt-knob")).toHaveCount(0);
  await expect(screenBox(page).locator(".prefs-row input[type=range]")).toHaveCount(6);
  // The curve, which the screen carried no canvas for at all: the display column was a
  // level rack in a plot-sized box with nothing drawn in it.
  const canvas = screenBox(page).locator("#dyn-curve");
  await expect(canvas).toHaveCount(1);
  // Stroked, not merely sized — an empty canvas of the right dimensions renders as the
  // same blank box the defect was.
  const inked = await canvas.evaluate((c: HTMLCanvasElement) => {
    const g = c.getContext("2d");
    if (!g || !c.width) return 0;
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
    return n;
  });
  expect(inked, "the transfer curve must actually be drawn").toBeGreaterThan(1000);
  await closeScreen(page);
});

test("switching guitar amp type swaps the type-specific control", async ({ page }) => {
  await node(page, "ch1").click();
  await chooseOption(insertSelect(page), { label: "Clean" });
  await openScreen(page);
  await expect(screenRow(page, "Blend")).toBeVisible();
  // The selector is outside the screen, so the type changes underneath an open one and
  // the same modal re-binds — which is the whole reason the screen carries no Type row.
  await closeScreen(page);
  await chooseOption(insertSelect(page), { label: "Drive" });
  await openScreen(page);
  await expect(screenRow(page, "Blend")).toHaveCount(0);
  await expect(screenRow(page, "Amp Type")).toBeVisible(); // Drive-only
  await expect(screenRow(page, "Master")).toBeVisible();
  // …and slot 7 changed its name with the type.
  await expect(screenRow(page, "Gain")).toBeVisible();
  await expect(screenRow(page, "Volume")).toHaveCount(0);
});

test("compander on the STEREO master reveals dynamics params", async ({ page }) => {
  await node(page, "bus.stereo").click();
  await chooseOption(insertSelect(page), { label: "Compander-H" });
  await openScreen(page);
  await expect(screenRow(page, "Threshold")).toBeVisible();
  await expect(screenRow(page, "Ratio")).toBeVisible();
  await expect(screenRow(page, "Width")).toBeVisible();
  // The taps either side of the insert point, which is what the screen adds over the
  // Inspector's list.
  await expect(screenBox(page).locator(".gt-ladders")).toBeVisible();
});

// Every family is edited on the SCREEN and nowhere else. Restoring the flat renderer
// beside the launcher would put the same values on two surfaces, and the one in the
// inspector reads the snapshot taken at render time and writes a stale value back on its
// next drag — which is the reason the renderer was removed. Nothing else in this file would
// go red for it, so the absence is asserted with the launcher as one control and the
// EFFECT TYPE row as the other: without the second, a `param` locator that had stopped
// matching anything at all would satisfy every line here.
test("no family has an editor left in the inspector", async ({ page }) => {
  for (const [id, effect, row] of [
    ["ch1", "Clean", "Treble"],
    ["ch3", "Pitch Fix", "Coarse"],
    // The last two share a node deliberately: the compander and the multi-band compressor
    // hold ONE device-wide slot between them, so a second bus cannot take it while the
    // first has it, and the second selection here replaces the first.
    ["bus.stereo", "Compander-H", "Width"],
    ["bus.stereo", "M.B.Comp", "L-M XOVER"],
  ] as const) {
    await node(page, id).click();
    await chooseOption(insertSelect(page), { label: effect });
    await expect(page.locator("#btn-insfx-screen"), effect).toBeVisible();
    await expect(param(page, row), effect).toHaveCount(0);
    // The row that is still there, on the same panel, read with the same locator.
    await expect(param(page, "EFFECT TYPE"), effect).toBeVisible();
  }
});

test("multi-band comp splits into what the bands share and what each band is", async ({ page }) => {
  await node(page, "bus.mix1").click();
  await chooseOption(insertSelect(page), { label: "M.B.Comp" });
  await openScreen(page);
  // MAIN: the two crossovers that decide what each band hears, then the levels the three
  // are mixed back at. Sixteen values on one panel fits and is still sixteen values with
  // nothing saying which four belong together.
  for (const label of ["L-M XOVER", "M-H XOVER", "LOW Gain", "MID Gain", "HIGH Gain", "Out Gain"]) {
    await expect(screenRow(page, label), label).toBeVisible();
  }
  await expect(screenRow(page, "Threshold")).toHaveCount(0);
  // MAIN's figure is on the crossovers' own axis, so it carries no reduction lane: the
  // three would say which band is working without saying anything about what is set here.
  // Read off the METER tiles rather than the bar captions — a merged reduction is drawn
  // into the level's own slot and has no caption, so a caption locator finds none of them
  // on any face and would pass here whatever the rack carried.
  await expect(screenBox(page).locator(".gt-ro.gr")).toHaveCount(0);

  // …and a band face is that band's dynamics, with the Release the three of them share.
  for (const id of ["low", "mid", "high"] as const) {
    await page.click(`#dyn-face-insfx-${id}`);
    for (const label of ["Threshold", "Ratio", "Attack", "Release"]) {
      await expect(screenRow(page, label), `${id} ${label}`).toBeVisible();
    }
    // The band is named by the FACE, so its cards are not named by it again.
    await expect(screenRow(page, "LOW Threshold"), id).toHaveCount(0);
    await expect(screenRow(page, "L-M XOVER"), id).toHaveCount(0);
    // One reduction, carrying the lane label every insert effect's does. WHICH band it
    // addresses is not visible here — that is `insert-fx-screen.test.ts`, which reads the
    // meter the face asks for rather than the caption over it.
    const grTile = screenBox(page).locator(".gt-ro.gr");
    await expect(grTile, id).toHaveCount(1);
  }
  await closeScreen(page);
});

// 1-Knob is the unit's, and the app neither writes it nor writes over what it computed.
// Both halves are here: the switch offers no gesture, and every value below it is locked
// while it reads on. Seeded through a plan because there is no control to press.
test("MBC 1-Knob is operable, and locks what its Level recomputes", async ({ page }) => {
  const params: Record<string, number> = { "9": 100, "14": 100, "19": 100 };
  const plan = (oneKnob: boolean) => ({
    format: "urx-router-plan",
    version: 1,
    modelId: "URX44V",
    connections: [],
    nodeParams: {
      "bus.mix1": {
        insertFx: 1792,
        insertFxOn: true,
        insertFxParams: oneKnob ? { ...params, "6": 1, "7": 24 } : params,
      },
    },
  });

  // Off: the switch is live and the Level beside it is not — it drives nothing there, and
  // the row stays rather than being dropped so the section keeps its height on a switch.
  await page.goto(`/?plan=${planParamZ(plan(false))}`);
  await node(page, "bus.mix1").click();
  await openScreen(page);
  const oneKnobRow = screenRow(page, "ON");
  await expect(oneKnobRow).not.toHaveClass(/\blocked\b/);
  await expect(oneKnobRow.locator("button").first()).toBeEnabled();
  await expect(screenRow(page, "1-Knob Level")).toHaveClass(/\blocked\b/);
  const outGain = screenRow(page, "Out Gain");
  await expect(outGain).not.toHaveClass(/\blocked\b/);
  await expect(outGain.locator("input")).toBeEnabled();
  await closeScreen(page);

  // On: the Level is live, and so is Out Gain — the one writable value a Level change
  // never reasserts. The crossovers beside it are not: the same change pins those back to
  // fixed values whatever was written over them.
  await page.goto(`/?plan=${planParamZ(plan(true))}`);
  await node(page, "bus.mix1").click();
  await openScreen(page);
  await expect(screenRow(page, "1-Knob Level")).not.toHaveClass(/\blocked\b/);
  await expect(screenRow(page, "Out Gain").locator("input")).toBeEnabled();
  await expect(screenRow(page, "L-M XOVER").locator("input")).toBeDisabled();
  await expect(screenBox(page).getByText("1-Knob is on", { exact: false })).toBeVisible();
  await page.click("#dyn-face-insfx-low");
  // …and the band face is the unit's entirely: the three the Level recomputes and the two
  // it pins back.
  await expect(screenRow(page, "Threshold").locator("input")).toBeDisabled();
  await expect(screenRow(page, "Ratio").locator("input")).toBeDisabled();
  await expect(screenRow(page, "Attack").locator("input")).toBeDisabled();
  await expect(screenRow(page, "Release").locator("input")).toBeDisabled();
  await closeScreen(page);
});

// A CONTINUOUS value has to survive the gesture that sets it. This one did not: its input
// event went through the rebuilding `set`, so the screen re-rendered on the first step and
// replaced the element under the pointer — the drag then ended and the slider could only be
// moved one detent per press. The recipe for this row is in `oneKnobLevelRow`'s own doc, and
// this row lost it by being written out longhand for a different scale rather than through
// that helper.
test("the MBC 1-Knob Level follows a drag rather than stepping once", async ({ page }) => {
  const plan = {
    format: "urx-router-plan",
    version: 1,
    modelId: "URX44V",
    connections: [],
    nodeParams: { "bus.mix1": { insertFx: 1792, insertFxOn: true, insertFxParams: { "6": 1, "7": 4 } } },
  };
  await page.goto(`/?plan=${planParamZ(plan)}`);
  await node(page, "bus.mix1").click();
  await openScreen(page);
  const level = screenRow(page, "1-Knob Level").locator("input[type=range]");
  await expect(level).toBeEnabled();
  await expect(level).toHaveValue("4");

  // Grab the thumb and travel a long way in several moves. A rebuild takes the element out
  // from under the pointer, so every move after the first lands on a detached node.
  const box = (await level.boundingBox())!;
  await page.mouse.move(box.x + (box.width * 4) / 48, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + (box.width * (4 + i * 4)) / 48, box.y + box.height / 2);
  await page.mouse.up();

  // Far more than the one step the defect allowed, and the ELEMENT is the one the drag
  // started on — which is the property the step count is a consequence of.
  expect(Number(await level.inputValue())).toBeGreaterThan(20);
  expect(await level.evaluate((n) => n.isConnected)).toBe(true);
});

// Two bits for three modes, so the write names both — and from Setting on, the notes the
// correction aims at come from a USB-MIDI port of the unit's own, which is why switching it
// there clears the mask and takes the Scale to Custom. The app does what the unit does.
test("pitch MIDI Control is written, and the mask it clears becomes the unit's", async ({ page }) => {
  await node(page, "ch1").click();
  await chooseOption(insertSelect(page), { label: "Pitch Fix" });
  await openScreen(page);
  const mode = screenSelect(page, "MIDI Control");
  await expect(mode).toBeEnabled();
  await expect(screenRow(page, "Scale")).not.toHaveClass(/\blocked\b/);
  await chooseOption(mode, { label: "Real Time" });
  await expect(mode).toHaveValue("2");
  // Both bits, or the mode is one nobody chose. Read back off the row rather than the plan:
  // the row is what the operator sees, and it decodes the pair.
  await expect(screenRow(page, "Scale")).toHaveClass(/\blocked\b/);
  await expect(screenRow(page, "Notes")).toHaveClass(/\blocked\b/);
  // …and back off releases them.
  await chooseOption(mode, { label: "Off" });
  await expect(screenRow(page, "Scale")).not.toHaveClass(/\blocked\b/);
  await closeScreen(page);
});

test("pitch fix reveals key + scale keyboard", async ({ page }) => {
  await node(page, "ch1").click();
  await chooseOption(insertSelect(page), { label: "Pitch Fix" });
  await openScreen(page);
  // One face: what the correction does to a note and what it is aimed at are both on it.
  await expect(screenRow(page, "Coarse")).toBeVisible();
  await expect(screenSelect(page, "Key").locator("option")).toHaveCount(12);
  await expect(screenRow(page, "MIDI Control")).toBeVisible();
  // Correction leads: it is the switch the whole effect hangs off, so it holds the first
  // card — the first thing read and the first thing reachable.
  const labels = await screenBox(page).locator(".gt-knob .lbl, .prefs-row .lbl").allTextContents();
  expect(labels[0]).toBe("Correction");
});

// One of the twelve semitone buttons on the scale face. They are absolute — named from C
// whatever the Key is — and are a plain row rather than a keyboard for that reason.
const noteToggle = (page: Page, note: string) =>
  page.locator("#dyn-screen-box .gt-notes button", { hasText: new RegExp(`^${note.replace("#", "\\#")}$`) });

test("pitch scale select seeds the note keyboard, and a note edit persists as Custom", async ({ page }, testInfo) => {
  await node(page, "ch1").click();
  await chooseOption(insertSelect(page), { label: "Pitch Fix" });
  await openScreen(page);
  // Defaults to Chromatic. Every preset is selectable: the unit derives the twelve notes
  // for each of them from the Key, and the app now authors the same pattern.
  await expect(screenSelect(page, "Scale")).toHaveValue("7");
  await expect(screenSelect(page, "Scale").locator("option:disabled")).toHaveCount(0);

  // Major seeds the major-scale note set (F# a non-major degree is cleared), then
  // toggling F# on rewrites Scale to Custom. Verified through save → open, which is also
  // what says the edit reached the plan rather than only the panel.
  await chooseOption(screenSelect(page, "Scale"), { label: "Major" });
  await expect(screenSelect(page, "Scale")).toHaveValue("2");
  await expect(noteToggle(page, "F#")).toHaveAttribute("aria-pressed", "false");
  await noteToggle(page, "F#").click();
  await closeScreen(page);
  await page.click("#btn-file");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btn-save")]);
  const saved = testInfo.outputPath("pitch.json");
  await download.saveAs(saved);

  await page.click("#btn-file");
  await page.click("#btn-new");
  await page.click("#btn-file");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#btn-open")]);
  await chooser.setFiles(saved);
  await node(page, "ch1").click();
  await openScreen(page);
  await expect(screenSelect(page, "Scale")).toHaveValue("0"); // Custom
  await expect(screenSelect(page, "Scale").locator("option", { hasText: "Custom" })).toBeEnabled();
  await expect(noteToggle(page, "F#")).toHaveAttribute("aria-pressed", "true");
});

// A plan can carry any Scale preset: it must display verbatim instead of collapsing to
// Custom. Enum values are LCD-confirmed (insert-fx-effect.ts).
test("a device-preset pitch scale (Pentatonic) loaded from a plan displays verbatim", async ({ page }) => {
  const plan = {
    format: "urx-router-plan",
    version: 1,
    modelId: "URX44V",
    connections: [],
    nodeParams: { ch1: { insertFx: 512, insertFxParams: { "16": 6 } } },
  };
  await page.goto(`/?plan=${planParamZ(plan)}`);
  await node(page, "ch1").click();
  await openScreen(page);
  const scale = screenSelect(page, "Scale");
  await expect(scale).toHaveValue("6");
  await expect(scale.locator("option", { hasText: "Pentatonic" })).toBeEnabled();
  await expect(scale.locator("option", { hasText: "Melodic Minor" })).toBeEnabled();
});

test("MBC crossover knobs expose the per-band valid ranges", async ({ page }) => {
  await node(page, "bus.stereo").click();
  await chooseOption(insertSelect(page), { label: "M.B.Comp" });
  await openScreen(page);
  // L-M 21.2 Hz..4 kHz (raw 6..97), M-H 42.5 Hz..8 kHz (raw 18..109): the device
  // splits the crossover ranges so the bands cannot cross.
  const lm = screenRow(page, "L-M XOVER").locator("input[type=range]");
  await expect(lm).toHaveAttribute("min", "6");
  await expect(lm).toHaveAttribute("max", "97");
  const mh = screenRow(page, "M-H XOVER").locator("input[type=range]");
  await expect(mh).toHaveAttribute("min", "18");
  await expect(mh).toHaveAttribute("max", "109");
  // The figure beside them says where those two put the three bands, which two numbers in
  // a column cannot — and it is on the CANVAS, so a knob move reaches it. Drawn as elements
  // it showed the crossover the panel was built with and went on showing it.
  await expect(screenBox(page).locator("#dyn-curve")).toBeVisible();
  await closeScreen(page);
});

test("insert FX option set depends on node kind (input vs output)", async ({ page }) => {
  // MONO IN channels carry the input effects (guitar amps / pitch / companders);
  // the STEREO / MIX outputs carry the output effects (MBC / companders). Neither
  // family leaks into the other's selector.
  await node(page, "ch1").click();
  await expect(insertSelect(page).locator("option")).toHaveText([
    "No Effect",
    "Clean",
    "Crunch",
    "Lead",
    "Drive",
    "Pitch Fix",
    "Compander-H",
    "Compander-S",
  ]);
  await node(page, "bus.stereo").click();
  await expect(insertSelect(page).locator("option")).toHaveText([
    "No Effect",
    "M.B.Comp",
    "Compander-H",
    "Compander-S",
  ]);
});

test("guitar-amp slot is 1-of-N: taken on one channel disables it on another", async ({ page }) => {
  await node(page, "ch1").click();
  await chooseOption(insertSelect(page), { label: "Clean" });
  await node(page, "ch2").click();
  // The four guitar-amp types share one device-wide slot, now held by CH1.
  for (const amp of ["Clean", "Crunch", "Lead", "Drive"]) {
    await expect(insertSelect(page).locator("option", { hasText: amp })).toBeDisabled();
  }
  // Pitch Fix and the companders sit in other slots, so they stay selectable.
  await expect(insertSelect(page).locator("option", { hasText: "Pitch Fix" })).toBeEnabled();
  await expect(insertSelect(page).locator("option", { hasText: "Compander-H" })).toBeEnabled();
});

test("output dynamics slot is 1-of-N across MIX and STEREO outputs", async ({ page }) => {
  await node(page, "bus.mix1").click();
  await chooseOption(insertSelect(page), { label: "M.B.Comp" });
  await node(page, "bus.stereo").click();
  // MBC and both companders share the single out-dyn slot, now held by MIX 1.
  for (const fx of ["M.B.Comp", "Compander-H", "Compander-S"]) {
    await expect(insertSelect(page).locator("option", { hasText: fx })).toBeDisabled();
  }
  await expect(insertSelect(page).locator("option", { hasText: "No Effect" })).toBeEnabled();
});

test("sample-rate ceilings gate the insert FX options", async ({ page }) => {
  await chooseOption(page.locator("#rate-picker"), "48000");
  await node(page, "ch1").click();
  await expect(insertSelect(page).locator("option", { hasText: "Pitch Fix" })).toBeEnabled();

  // Pitch Fix tops out at 48 kHz; the guitar amps run to 96 kHz.
  await chooseOption(page.locator("#rate-picker"), "96000");
  await expect(insertSelect(page).locator("option", { hasText: "Pitch Fix" })).toBeDisabled();
  await expect(insertSelect(page).locator("option", { hasText: "Clean" })).toBeEnabled();

  // Above 96 kHz every insert effect drops out.
  await chooseOption(page.locator("#rate-picker"), "192000");
  for (const fx of ["Clean", "Pitch Fix", "Compander-H"]) {
    await expect(insertSelect(page).locator("option", { hasText: fx })).toBeDisabled();
  }
});

test("selecting No Effect removes the effect parameter editor", async ({ page }) => {
  await node(page, "ch1").click();
  await chooseOption(insertSelect(page), { label: "Clean" });
  await openScreen(page);
  await expect(screenRow(page, "Treble")).toBeVisible();
  await closeScreen(page);
  await chooseOption(insertSelect(page), { label: "No Effect" });
  // Nothing to tune, so the way in goes with the effect rather than opening on an
  // empty panel.
  await expect(page.locator("#btn-insfx-screen")).toHaveCount(0);
  await expect(insertSelect(page)).toHaveValue("-1");
});

test("insert-fx param round-trips through save and open", async ({ page }, testInfo) => {
  await node(page, "ch1").click();
  await chooseOption(insertSelect(page), { label: "Clean" });
  await openScreen(page);
  await chooseOption(screenSelect(page, "SP Type"), { label: "JC 2x12" });
  await expect(screenSelect(page, "SP Type")).toHaveValue("8");
  await closeScreen(page);

  await page.click("#btn-file");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btn-save")]);
  const saved = testInfo.outputPath("plan.json");
  await download.saveAs(saved);

  await page.click("#btn-file");
  await page.click("#btn-new");
  await node(page, "ch1").click();
  await expect(insertSelect(page)).toHaveValue("-1"); // No Effect after reset

  await page.click("#btn-file");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#btn-open")]);
  await chooser.setFiles(saved);
  await node(page, "ch1").click();
  await expect(insertSelect(page)).toHaveValue("256"); // Clean
  await openScreen(page);
  // One face: the amp's rows and the cabinet's are both on it, so a reopened screen shows
  // the saved cabinet without a switch to find first.
  await expect(screenRow(page, "Volume")).toBeVisible();
  await expect(screenSelect(page, "SP Type")).toHaveValue("8"); // JC 2x12
});

test("selecting an effect reveals the ON/OFF (bypass) toggle; bypass keeps the selection", async ({ page }) => {
  await node(page, "ch1").click();
  await expect(insertFxBypass(page)).toHaveCount(0); // hidden under No Effect
  await chooseOption(insertSelect(page), { label: "Compander-S" });
  const onRow = insertFxBypass(page);
  await expect(onRow.locator("button.on")).toHaveText("ON"); // ships engaged
  await onRow.getByRole("button", { name: "OFF", exact: true }).click();
  await expect(onRow.locator("button.on")).toHaveText("OFF");
  await expect(insertSelect(page)).toHaveValue("1794"); // bypass never clears the selector
  // Re-selecting an effect mirrors the device's auto-engage.
  await chooseOption(insertSelect(page), { label: "Compander-H" });
  await expect(insertFxBypass(page).locator("button.on")).toHaveText("ON");
});

// Choosing a type has to reveal the way onward THERE AND THEN. The panel holds a rebuild
// while a select in it has focus — a rebuild closes an open picker — and a select keeps
// focus after a choice is made in it, so the release has to come from the change itself.
// Without that the plan is written, the row reads the new effect, and the bypass switch
// and the launcher stay absent until the operator clicks somewhere unrelated: from where
// they are sitting, choosing an effect did nothing.
//
// Driven by dispatching the events a dismissal produces rather than by `selectOption`,
// which BLURS. That is the whole difference between seeing this and not: with the blur in
// front of it the release happens for the wrong reason and the case passes on either
// version of the code.
test("choosing an insert effect reveals its ON switch and launcher without leaving the select", async ({ page }) => {
  await node(page, "ch1").click();
  const launcher = page.locator("#btn-insfx-screen");
  const onRow = insertFxBypass(page);
  await expect(launcher).toHaveCount(0);
  await openInsertFxSection(page);

  await chooseOption(insertSelect(page), { label: "Clean" });
  // Asked of the PANEL rather than of the element: the rebuild this case is about replaces
  // that select and restores focus to the fresh one, so comparing identity would report the
  // fix as a failure to keep focus.
  const focusKept = await page.evaluate(() => {
    const a = document.activeElement;
    return a instanceof HTMLSelectElement && document.querySelector("#inspector")!.contains(a);
  });
  expect(focusKept).toBe(true); // …focus never left the row, as a real dismissal leaves it

  await expect(onRow).toHaveCount(1);
  await expect(launcher).toBeVisible();
  await launcher.click();
  await expect(screenBox(page)).toBeVisible();
  await expect(page.locator("#dyn-screen-modal")).toContainText("Clean");
  await closeScreen(page);
});

// …and the panel follows the SELECTION on the very next press, not the one after. The
// panel holds a rebuild while a select inside it has focus, and choosing in one leaves
// focus there — so a press on another node selected that node on the board while the
// panel went on showing the one just left. Two presses looked like one lost press.
//
// Asserted on the heading rather than on a control, because that is the whole claim: the
// panel is describing the node the operator pressed.
test("selecting another node updates the panel on the first press, with a select still focused", async ({ page }) => {
  await node(page, "ch1").click();
  await openInsertFxSection(page);
  await chooseOption(insertSelect(page), { label: "Clean" });
  await expect(page.locator("#inspector h2")).toHaveText("CH 1");
  // The focus a real dropdown dismissal leaves behind is what the case turns on.
  expect(
    await page.evaluate(() => document.activeElement instanceof HTMLSelectElement),
    "a select must still hold focus, or this case proves nothing",
  ).toBe(true);

  await node(page, "ch2").click();
  await expect(page.locator("#inspector h2")).toHaveText("CH 2");
});

// The whole console route, end to end: a strip holding nothing, the disclosure beside
// its face, the type list, and the tuning screen two presses in. Before this existed the
// strip's INS FX chip was a lone half-width toggle with no disclosure at all — nothing on
// the CONSOLE named an effect, and the only way to a parameter was the Inspector.
test("the console INS FX pair chooses an effect and opens its screen", async ({ page }) => {
  await page.click("#btn-view-console");
  const strip = page.locator(".con-strip", { has: page.getByText("CH 1", { exact: true }) });
  const face = strip.locator(".con-ifxface");
  const opener = strip.locator(".con-ifxopen");
  const pop = page.locator(".con-ifxpop");

  // Holding nothing: a dashed face and a `+`, and the pair fills a row the way the three
  // processors above it do — the same face width and the same disclosure width.
  await expect(face).toHaveClass(/\bvacant\b/);
  await expect(opener).toHaveText("+");
  const gate = strip.locator(".con-chip", { hasText: "GATE" }).first();
  expect((await face.boundingBox())!.width).toBeCloseTo((await gate.boundingBox())!.width, 1);
  expect((await opener.boundingBox())!.width).toBeCloseTo(
    (await strip.locator(".con-chip-open").first().boundingBox())!.width,
    1,
  );

  await opener.click();
  await expect(pop).toBeVisible();
  await pop.locator(".irow", { hasText: "Crunch" }).first().click();

  // Choosing OPENS it. Picking a type is not the end of anything — what the operator came
  // for is the effect's own values — so the press that chose is the press that arrives.
  await expect(pop).toBeHidden();
  await expect(screenBox(page)).toBeVisible();
  await expect(page.locator("#dyn-screen-modal")).toContainText("Crunch");
  await closeScreen(page);

  // Chosen and engaged, and the pair says so: a solid lit face and a `▸`.
  await expect(face).not.toHaveClass(/\bvacant\b/);
  await expect(face).toHaveClass(/\bon\b/);
  await expect(opener).toHaveText("▸");

  // …and the launcher inside the list is still the way back to it.
  await opener.click();
  await pop.locator(".iopen").click();
  await expect(screenBox(page)).toBeVisible();
  await closeScreen(page);

  // Releasing is the same list, and it hands the slot back rather than bypassing. It opens
  // NOTHING: a screen over a strip that now holds nothing has nothing to show.
  await opener.click();
  await pop.locator(".irow", { hasText: "No Effect" }).first().click();
  await expect(screenBox(page)).toBeHidden();
  await expect(face).toHaveClass(/\bvacant\b/);
  await expect(opener).toHaveText("+");
  await page.click("#btn-view-graph");
  await node(page, "ch1").click();
  await expect(insertSelect(page)).toHaveValue("-1");
});

// The launcher asks whether the SCREEN would open, not whether the strip holds something.
// It used to ask the second, which the multi-band compressor satisfied while the screen
// refused it — so on that strip the row was live, said "open me" and did nothing when
// pressed. That family has a screen now, and the question left is the empty strip; the
// case keeps both answers, because a launcher live everywhere and one dead everywhere both
// pass a test that only ever looks at one.
test("the console launcher is inert on a strip holding nothing, and opens on one that does", async ({ page }) => {
  await page.click("#btn-view-console");
  const strip = page.locator(".con-strip", { has: page.getByText("STEREO", { exact: true }) }).first();
  await strip.locator(".con-ifxopen").click();
  const open = page.locator(".con-ifxpop .iopen");
  await expect(open).toHaveClass(/\boff\b/);
  await expect(open).toHaveAttribute("aria-disabled", "true");
  await open.click();
  await expect(screenBox(page)).toBeHidden();

  // …and the multi-band compressor, which is the family that used to be the dead one.
  await page.click("#btn-view-graph");
  await node(page, "bus.stereo").click();
  await chooseOption(insertSelect(page), { label: "M.B.Comp" });
  await page.click("#btn-view-console");
  await strip.locator(".con-ifxopen").click();
  await expect(open).not.toHaveClass(/\boff\b/);
  await open.click();
  await expect(screenBox(page)).toBeVisible();
  await expect(screenRow(page, "L-M XOVER")).toBeVisible();
  await closeScreen(page);
});

test("the console INS FX chip bypasses without clearing the selection", async ({ page }) => {
  await node(page, "ch1").click();
  await chooseOption(insertSelect(page), { label: "Compander-S" });
  await page.click("#btn-view-console");
  const chip = page
    .locator(".con-strip", { has: page.getByText("CH 1", { exact: true }) })
    .locator(".con-chip", { hasText: "INS FX" })
    .first();
  await expect(chip).toHaveClass(/\bon\b/);
  await chip.click();
  await expect(chip).not.toHaveClass(/\bon\b/);
  await chip.click();
  await expect(chip).toHaveClass(/\bon\b/);
  // The selection survived the bypass round-trip.
  await page.click("#btn-view-graph");
  await node(page, "ch1").click();
  await expect(insertSelect(page)).toHaveValue("1794");
});

// Two nodes holding the same insert-FX family write ONE engine array (addressed
// engine:0:slot, no channel axis), so the emitted set collapses the repeated
// address to its last command and the loser's values never reach the unit. The
// inspector cannot author that plan (insertFxMenu locks a slot another node holds)
// and a file carrying one only opens past the loader's warning, so a device readback
// is the shortest route in — which is why this case fetches instead of editing.
test("a write says which node's insert-FX values reach the device", async ({ page }) => {
  // vd_get answers by paramId with no y axis, so every MONO IN reports Compander-H
  // (135) and every engine slot the same raw (689) — exactly the coherent, agreeing
  // strip a real readback of a two-owner unit produces.
  await stubTauriDevice(page, {
    values: { 135: 1793, 689: -1000, 766: 48000, 848: 0 },
    confirm: "Ok",
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-device");
  await page.click("#btn-fetch");
  await expect(page.locator("#statusbar")).toContainText("Fetched", { timeout: 20000 });

  await node(page, "ch1").click();
  // CH 1 is the FIRST owner in model order, so its command is the one dropped. The
  // compander every MONO IN reports is edited on the tuning screen.
  await openScreen(page);
  const threshold = screenRow(page, "Threshold").locator('input[type="range"]');
  await threshold.focus();
  await page.keyboard.press("ArrowUp");
  await closeScreen(page);
  // A second, unshared edit so the write has something of its own to confirm — the
  // dropped owner's own change is on no address and would report "no changes".
  await param(page, "HPF").getByRole("button", { name: "ON", exact: true }).click();

  await page.click("#btn-device");
  await page.click("#btn-write");
  await expect
    .poll(() => dialogsOf(page))
    .toContainEqual(
      expect.stringContaining("CH 1 shares device settings with CH 4 — only CH 4's values reach the device"),
    );
  // Prefixed, not substituted: the question the operator answers is unchanged.
  await expect.poll(() => dialogsOf(page)).toContainEqual(expect.stringContaining("to the device?"));
  // The confirm is raised BEFORE the send, so the write log has to be read once the
  // send has STOPPED GROWING — otherwise the count below is a sample taken mid-round
  // and says nothing about how many commands the write emitted. Waited on the log
  // itself rather than on a status string: which string the flow ends on depends on
  // whether it converged, which is the thing under test.
  //
  // The interval has to clear sendConverging's own blind wait between rounds
  // (SETTLE_TIMEOUT_MS, 300 ms). Sampling faster than that — this polled at 200 ms —
  // sees the inter-round gap as "stopped" every time and reads the log mid-write, so
  // the count below became whatever had landed by then: measured 4 on 689 when only
  // the first round was in and 8 when the second had partly landed, from the same
  // build. That is what made this case flaky; it was never a timing accident.
  const POLL_MS = 500;
  let settled = -1;
  for (let i = 0; i < 40 && settled !== (await writesOf(page)).length; i++) {
    settled = (await writesOf(page)).length;
    await page.waitForTimeout(POLL_MS);
  }
  expect(settled).toBeGreaterThan(0);
  // And the write went out carrying the engine array ONCE per slot rather than once
  // per owner (four MONO IN channels hold the same compander here). The stub's writes
  // land in the state its reads answer from, so sendConverging's re-diff finds nothing
  // and the loop stops after one round: the ceiling is the slot count, not the slot
  // count times the round cap.
  const engine = (await writesOf(page)).filter(([id]) => id === 689);
  console.log(
    `write settled at ${settled} command(s), ${engine.length} on 689; dialogs: ${(await dialogsOf(page)).length}`,
  );
  expect(engine.length).toBeGreaterThan(0);
  expect(engine.length).toBeLessThanOrEqual(COMPANDER_SLOT_COUNT);
});

// The desktop minimum pointer target, from the project's UI defaults: 36x36 CSS px.
const MIN_TARGET = 36;

test("every semitone button meets the desktop minimum target, at the smallest window", async ({ page }) => {
  // The SMALLEST window the app admits (tauri.conf.json minWidth / minHeight), because the
  // note row's width does not grow with the viewport, so a reading taken on a wide window
  // would not be the worst case and one taken here covers both. Twelve targets do not reach
  // 36px on one line in this column; six per row do, which is what the stylesheet lays them
  // out as.
  await page.setViewportSize({ width: 960, height: 640 });
  await node(page, "ch1").click();
  await chooseOption(insertSelect(page), { label: "Pitch Fix" });
  await openScreen(page);
  const buttons = page.locator("#dyn-screen-box .gt-notes button");
  await expect(buttons).toHaveCount(12);

  const rects: { label: string; w: number; h: number }[] = [];
  for (let i = 0; i < 12; i++) {
    const b = buttons.nth(i);
    const box = await b.boundingBox();
    expect(box, `note ${i} has no box`).not.toBeNull();
    rects.push({ label: (await b.textContent()) ?? "", w: box!.width, h: box!.height });
  }
  console.log(`note targets: ${rects.map((r) => `${r.label} ${r.w.toFixed(2)}x${r.h.toFixed(2)}`).join("  ")}`);
  for (const r of rects) {
    expect(r.w, `${r.label} width`).toBeGreaterThanOrEqual(MIN_TARGET);
    expect(r.h, `${r.label} height`).toBeGreaterThanOrEqual(MIN_TARGET);
  }
  // Two rows of six, not one row of twelve and not some other wrap: distinct top edges,
  // and six buttons sharing each. Without this the size assertions above pass on any wrap
  // the layout happens to produce, an uneven one included.
  const tops = await buttons.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  const rows = [...new Set(tops)];
  expect(rows).toHaveLength(2);
  for (const top of rows) expect(tops.filter((t) => t === top)).toHaveLength(6);
});
