import { test, expect, type Page } from "./fixtures";

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const recSelect = (page: Page) => page.locator("#inspector .param", { hasText: "Rec Point" }).locator("select");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await page.locator("#model-picker").waitFor();
});

test("mono channel offers five rec points; default PRE FADER", async ({ page }) => {
  await node(page, "ch1").click();
  await expect(recSelect(page).locator("option")).toHaveText([
    "PRE GATE",
    "PRE COMP",
    "PRE EQ",
    "PRE INS FX",
    "PRE FADER",
  ]);
  await expect(recSelect(page)).toHaveValue("4"); // PRE FADER
});

test("stereo channel offers only PRE EQ and PRE FADER", async ({ page }) => {
  await node(page, "ch_5_6").click();
  await expect(recSelect(page).locator("option")).toHaveText(["PRE EQ", "PRE FADER"]);
  await expect(recSelect(page)).toHaveValue("4");
});

test("SSMCS drops PRE EQ and moves a PRE EQ tap to PRE COMP", async ({ page }) => {
  // The device has no discrete EQ stage in SSMCS mode: the Rec Point list drops
  // PRE EQ, and switching to SSMCS with PRE EQ selected lands on PRE COMP.
  await node(page, "ch1").click();
  await recSelect(page).selectOption("2"); // PRE EQ
  const typeSelect = page.locator("#inspector .param", { hasText: "COMP/EQ Type" }).locator("select");
  await typeSelect.selectOption("1"); // SSMCS
  await expect(recSelect(page).locator("option")).toHaveText(["PRE GATE", "PRE COMP", "PRE INS FX", "PRE FADER"]);
  await expect(recSelect(page)).toHaveValue("1"); // PRE COMP
  // Back to COMP->EQ: PRE EQ reappears but the tap stays where the device left it.
  await typeSelect.selectOption("0");
  await expect(recSelect(page).locator("option")).toHaveCount(5);
  await expect(recSelect(page)).toHaveValue("1");
});

// The inspector's selects carried no stylesheet rule at all, so their whole face was
// the UA's own menulist — measured at 11px system-ui on the engine's own grey, hugging
// the chosen option's text well short of the column every other control in the row
// fills. Pinned relative rather than absolute, like the tuning-screen launcher's face
// in dyntuning.spec.ts: the claim is that this select is on the SAME recipe as the
// toolbar's model picker, which is what an absolute pin would restate in numbers that
// move with the tokens.
test("a parameter select wears the app's own select face and fills its row", async ({ page }) => {
  await node(page, "ch1").click();
  const face = (sel: string) =>
    page
      .locator(sel)
      .first()
      .evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          fontFamily: cs.fontFamily,
          fontSize: cs.fontSize,
          color: cs.color,
          backgroundColor: cs.backgroundColor,
          borderTopColor: cs.borderTopColor,
          borderRadius: cs.borderTopLeftRadius,
          padding: cs.padding,
          cursor: cs.cursor,
        };
      });
  expect(await face("#inspector select")).toEqual(await face("select#model-picker"));

  // Width is the panel's own, not the recipe's: the model picker hugs its content in
  // the toolbar, while a parameter row's control fills the row. Asked of the row
  // rather than of a sibling control, so the pin does not depend on which other
  // controls this particular node happens to show.
  const edges = await recSelect(page).evaluate((el) => {
    const s = el.getBoundingClientRect();
    const r = el.closest(".param")!.getBoundingClientRect();
    return { left: Math.round(s.left - r.left), right: Math.round(r.right - s.right) };
  });
  expect(edges).toEqual({ left: 0, right: 0 });
});

test("rec point round-trips through save and open", async ({ page }, testInfo) => {
  await node(page, "ch1").click();
  await recSelect(page).selectOption("2"); // PRE EQ
  await page.click("#btn-file");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btn-save")]);
  const saved = testInfo.outputPath("plan.json");
  await download.saveAs(saved);
  await page.click("#btn-file");
  await page.click("#btn-new");
  await node(page, "ch1").click();
  await expect(recSelect(page)).toHaveValue("4");
  await page.click("#btn-file");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#btn-open")]);
  await chooser.setFiles(saved);
  await node(page, "ch1").click();
  await expect(recSelect(page)).toHaveValue("2");
});
