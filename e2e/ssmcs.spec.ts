import { test, expect, type Page } from "./fixtures";

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
});

test.describe("the tuning screen's three faces", () => {
  const face = (page: Page, name: "main" | "comp" | "eq") => box(page).locator(`#dyn-face-ssmcs-${name}`);

  test("moves between the faces from the title row, on one title and one channel", async ({ page }) => {
    await openFace(page, "ssmcs", /^SSMCS$/);
    const title = box(page).locator("#dyn-screen-title");
    await expect(title).toContainText("CH 1");
    await expect(title).toContainText("SSMCS");
    await expect(face(page, "main")).toHaveAttribute("aria-pressed", "true");

    await face(page, "comp").click();
    await expect(box(page)).toBeVisible(); // moved, not closed and reopened
    await expect(face(page, "comp")).toHaveAttribute("aria-pressed", "true");
    // Naming each face would print the shipped COMP screen's title, and nothing would
    // then say which of the channel's two banks is on screen.
    await expect(title).toContainText("SSMCS");
    await expect(title).toContainText("CH 1");

    await face(page, "eq").click();
    await expect(box(page).locator("#dyn-ssmcs-band-low")).toHaveAttribute("aria-pressed", "true");
  });

  // The face segment is a SIBLING of the heading rather than a child, so the dialog's
  // accessible name stays the channel and the bank. Wrapping the heading is free only if
  // the row occupies what the heading did — measured, it came up 12px until the heading's
  // own margin moved onto the row — so the space under the title is compared against a
  // screen that has no faces and therefore no wrapper.
  test("costs the panel no vertical space, and keeps the buttons out of the dialog's name", async ({ page }) => {
    const gapUnderTitle = () =>
      box(page).evaluate((el) => {
        const head = el.querySelector(".gt-head") ?? el.querySelector("h2")!;
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

  test("COMP reads its eight rows in the unit's own order", async ({ page }) => {
    await openFace(page, "ssmcsComp", /^COMP$/);
    const labels = await box(page).locator(".prefs-row .lbl").allInnerTexts();
    expect(labels).toEqual(["Attack", "Release", "Ratio", "Knee", "Side Chain", "Q", "Freq", "Gain"]);
    // The bank's corner is an internal value the unit never shows, so the lane rack
    // carries no fader cap — the one gesture the rack otherwise has.
    await expect(box(page).locator(".gt-cap")).toHaveCount(0);
  });

  test("the EQ face keeps four rows and one height on every band", async ({ page }) => {
    await openFace(page, "ssmcsEq", /^EQ$/);
    const height = () => box(page).evaluate((el) => el.getBoundingClientRect().height);
    const first = await height();
    for (const band of ["low", "mid", "high"] as const) {
      await box(page).locator(`#dyn-ssmcs-band-${band}`).click();
      const labels = await box(page).locator(".prefs-row .lbl").allInnerTexts();
      expect(labels, band).toEqual(["Band", "Q", "Freq", "Gain"]);
      // A shelf has no Q at all; the row stays and says so, so the panel does not move
      // under the pointer that just pressed the band beside it.
      const locked = band !== "mid";
      await expect(screenRow(page, "Q"), band).toHaveClass(locked ? /locked/ : /^((?!locked).)*$/);
      expect(await height(), band).toBe(first);
    }
  });
});

test("the CONSOLE strip offers the morphing strip's own chips", async ({ page }) => {
  await node(page, "ch1").click();
  await typeSelect(page).selectOption("1");
  await page.click("#btn-view-console");
  const strip = page.locator(".con-strip", { has: page.getByText("CH 1", { exact: true }) });
  // GATE, SSMCS, COMP and EQ each carry a toggle and an opener, in the unit's own
  // chain order.
  await expect(strip.locator(".con-chip", { hasText: /^SSMCS$/ })).toHaveCount(1);
  await expect(strip.locator('.con-chip-open[aria-label="SSMCS screen"]')).toHaveCount(1);
  await expect(strip.locator('.con-chip-open[aria-label="Comp screen"]')).toHaveCount(1);
  await expect(strip.locator('.con-chip-open[aria-label="EQ screen"]')).toHaveCount(1);
  // The two labels are deliberately the shipped screens' own, so which FACE each opener
  // opens is the only thing that tells the banks apart here.
  for (const [label, face] of [
    ["SSMCS screen", "main"],
    ["Comp screen", "comp"],
    ["EQ screen", "eq"],
  ] as const) {
    await strip.locator(`.con-chip-open[aria-label="${label}"]`).click();
    await expect(box(page).locator(`#dyn-face-ssmcs-${face}`)).toHaveAttribute("aria-pressed", "true");
    await box(page).locator(".consent-btn-secondary").click();
  }
});
