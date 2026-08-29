import { test, expect } from "./fixtures";
import { chooseOption } from "./choose-option";

// The block diagram flags the stereo-channel (CH 5/6–11/12) EQ as disabled at
// 176.4 / 192 kHz. The app still shows that EQ as editable, so a top-of-panel
// sample-rate note is the only cue — it must appear at 176.4 / 192 kHz and not at
// 96 kHz. Sits alongside the existing INS FX / FX2 notes.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

const stereoEqNote = (page: import("@playwright/test").Page) =>
  page.locator("#inspector .warning-line", { hasText: "Stereo channel (CH 5/6–11/12) EQ" });

test("the stereo-channel EQ note appears at 176.4 / 192 kHz, not at 96 kHz", async ({ page }) => {
  await expect(stereoEqNote(page)).toHaveCount(0); // default 48 kHz

  await chooseOption(page.locator("#rate-picker"), "96000");
  await expect(stereoEqNote(page)).toHaveCount(0);

  await chooseOption(page.locator("#rate-picker"), "176400");
  await expect(stereoEqNote(page)).toHaveCount(1);

  await chooseOption(page.locator("#rate-picker"), "192000");
  await expect(stereoEqNote(page)).toHaveCount(1);
});

// The EQ section (stereo channel) locks to OFF with a disabled toggle at 176.4 /
// 192 kHz, and returns to an interactive toggle at 96 kHz and below.
const eqSection = (page: import("@playwright/test").Page) =>
  page.locator("#inspector details.insp-section").filter({ has: page.locator('summary:has-text("EQ")') });
// The section's own ON/OFF toggle is its first .param row (the 1-knob toggle, when
// present, is a later row labeled "1-knob").
const eqToggle = (page: import("@playwright/test").Page) => eqSection(page).locator(".sec-body > .param").first();

test("the stereo-channel EQ toggle is forced off and disabled at 192 kHz", async ({ page }) => {
  await page.locator('#graph-host g.node[data-id="ch_5_6"]').click();

  // At 48 kHz the ON/OFF buttons are live.
  await expect(eqToggle(page).locator("button", { hasText: "ON" })).toBeEnabled();

  await chooseOption(page.locator("#rate-picker"), "192000");
  await page.locator('#graph-host g.node[data-id="ch_5_6"]').click();
  const onBtn = eqToggle(page).locator("button", { hasText: "ON" });
  const offBtn = eqToggle(page).locator("button", { hasText: "OFF" });
  await expect(onBtn).toBeDisabled();
  await expect(offBtn).toBeDisabled();
  // Forced off: OFF is the highlighted state.
  await expect(offBtn).toHaveClass(/on/);
  await expect(onBtn).not.toHaveClass(/on/);

  // Lowering the rate restores the interactive toggle.
  await chooseOption(page.locator("#rate-picker"), "48000");
  await page.locator('#graph-host g.node[data-id="ch_5_6"]').click();
  await expect(eqToggle(page).locator("button", { hasText: "ON" })).toBeEnabled();
});

// What the CONSOLE says about the same ceilings, which for a long time was nothing: the
// three warnings at the top of the Inspector named a rate limit while every control the
// limit takes away stayed live on the strip. The Insert FX face said so in a tooltip and
// its disclosure opened a menu with nothing choosable in it; the FX2 sends were fully
// operable into a bus the graph was already dimming.
//
// The two treatments are different on purpose. A FACE carries the reason and stays — what
// a strip is set to, and why it is off, has to stay readable. A DISCLOSURE the rate has
// emptied is dropped instead: there is nothing behind it to disable.
//
// Read as a PAIR at both rates rather than as a list of disabled things at one: everything
// here is enabled at 48 kHz, so an assertion that only looked at 192 would pass against a
// console that disabled these controls at every rate.
const conChip = (page: import("@playwright/test").Page, strip: number, sel: string) =>
  page.locator(".con-strip").nth(strip).locator(sel);
/** How many rows of chips each strip's head lays out — distinct y positions, so it reads
 *  the flow rather than counting elements (a hidden placeholder is in the flow). */
const chipRowCounts = (page: import("@playwright/test").Page): Promise<number[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll(".con-strip")]
      .slice(0, 6)
      .map(
        (s) =>
          new Set([...s.querySelectorAll(".con-chips > *")].map((c) => Math.round(c.getBoundingClientRect().y))).size,
      ),
  );

test("the CONSOLE locks what the rate takes away, and only then", async ({ page }) => {
  await page.click("#btn-view-console");
  // ch1: the INS FX face and its disclosure. ch_5_6 (strip 4) is the stereo EQ pair.
  const insFace = conChip(page, 0, ".con-ifxface");
  const insOpen = conChip(page, 0, ".con-ifxopen");
  const eqOpen = conChip(page, 4, ".con-chip-open").first();
  // The FX2 send column on a mono strip: its switch, its tap and its level.
  const fx2 = conChip(page, 0, ".con-scol").nth(1);

  const eqChip = conChip(page, 4, ".con-chip").filter({ hasText: "EQ" });
  const faces = [insFace, eqChip, fx2.locator(".con-sl"), fx2.locator(".con-slp"), fx2.locator(".con-vfad")];
  for (const el of faces) await expect(el).not.toHaveClass(/\breadonly\b/);
  // Both disclosures are THERE at a rate that empties neither, which is what makes their
  // absence below a statement about the rate rather than about the strip.
  await expect(insOpen).toHaveCount(1);
  await expect(eqOpen).toHaveCount(1);
  // …and what each face measures while they are, which is what the assertion after the
  // rate change compares against. Read rather than written down: the widths are a
  // percentage of a strip and would be a second place to keep the layout.
  const rowsAt48 = await chipRowCounts(page);
  const insFaceWide = Math.round((await insFace.boundingBox())!.width);
  const eqChipWide = Math.round((await eqChip.boundingBox())!.width);
  // The positive control for that pair: a face in the wide slot is not the same width as
  // one of the two-per-row chips, so "unchanged" below is a claim with something to fail.
  const plain = Math.round((await conChip(page, 0, ".con-chip").filter({ hasText: "HPF" }).boundingBox())!.width);
  expect(insFaceWide).toBeGreaterThan(plain + 8);

  await chooseOption(page.locator("#rate-picker"), "192000");
  await page.click("#btn-view-console");
  for (const el of faces) {
    await expect(el).toHaveClass(/\breadonly\b/);
    await expect(el).toHaveAttribute("aria-disabled", "true");
    // …and DIMMED, not merely marked. The class and the aria-disabled reached the send's
    // enable chip while the stylesheet's read-only rule did not name `.con-sl`, so it read
    // as disabled to a screen reader and as live to everyone else.
    expect(Number(await el.evaluate((n) => getComputedStyle(n).opacity))).toBeLessThan(1);
  }
  // …and the face is the SAME WIDTH it was at 48 kHz. Its width used to be read off its
  // neighbour (`:has(+ .con-chip-open)`), so dropping the disclosure resized the button
  // beside it — 58px to 39px, INS FX changing shape as the rate moved. The slot the
  // disclosure left is kept, and the face carries its own width.
  const widthNow = async (el: ReturnType<typeof conChip>) => Math.round((await el.boundingBox())!.width);
  expect(await widthNow(insFace)).toBe(insFaceWide);
  expect(await widthNow(eqChip)).toBe(eqChipWide);
  // …and it is STATED rather than grown into whatever the row left over, which is the
  // property the laid-out number above cannot see: with the slot filled either way, a face
  // that grows lands on the same width as one that declares it. `flex-grow: 0` is what
  // makes the width the chip's own — the difference shows the day something else changes
  // in that row, which is how it went wrong the first time.
  for (const el of [insFace, eqChip]) {
    const flex = await el.evaluate((n) => {
      const cs = getComputedStyle(n);
      return { grow: cs.flexGrow, basis: cs.flexBasis };
    });
    expect(flex.grow).toBe("0");
    expect(flex.basis).not.toBe("auto");
  }

  // The disclosures are GONE rather than dimmed: nothing is behind either to open. The
  // stereo strip keeps the Ducker's, which is what says this is the rate and not the row.
  await expect(insOpen).toHaveCount(0);
  await expect(conChip(page, 4, ".con-chip-open:not(.spacer)")).toHaveCount(1);
  // What is left in its place is a hidden placeholder, which is what keeps the widths
  // above from moving. Asserted as HIDDEN, or a slot that started rendering something
  // would satisfy the count and put a second control on the row.
  await expect(conChip(page, 4, ".con-chip-open.spacer")).toHaveCount(1);
  await expect(conChip(page, 4, ".con-chip-open.spacer")).toBeHidden();
  // …and the ROW COUNT is what that placeholder is for. Without it the chips reflow: the
  // parity filler lands differently, every strip gains a row and the head — clamped to the
  // tallest — grows 292 to 304px, so the whole console changes shape at 192 kHz.
  expect(await chipRowCounts(page)).toEqual(rowsAt48);
  // …and each face says WHY where the operator would reach for it. The two ceilings are
  // different sentences and are not interchangeable.
  await expect(insFace).toHaveAttribute("title", /above 96 kHz/);
  await expect(eqChip).toHaveAttribute("title", /176\.4 \/ 192 kHz/);
  await expect(fx2.locator(".con-sl")).toHaveAttribute("title", /FX2 bus/);
  // The bus the sends point at is dimmed whole, the way the graph dims its node.
  await expect(page.locator(".con-strip[title*='FX2']")).toHaveClass(/\binactive\b/);
});
