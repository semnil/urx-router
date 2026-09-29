import { test, expect, type Page } from "./fixtures";
import { chooseOption } from "./choose-option";

// The console runs against the factory plan (sends present), so we do NOT seed
// "empty" here — the CH → MIX sends the FIXED / Pan-Link locks act on exist.
const strip = (page: Page, name: string) => page.locator(".con-strip", { has: page.getByText(name, { exact: true }) });
const param = (page: Page, label: string) => page.locator("#inspector .param", { hasText: label });
// The CH 1 → MIX 1 send column (chip → PRE → mini-fader) in the SENDS rack.
const mix1Col = (page: Page) =>
  strip(page, "CH 1").locator(".con-scol", { has: page.getByRole("button", { name: "M1", exact: true }) });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-model", "URX44V");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("FIXED BUS Type locks the MIX send column fader read-only", async ({ page }) => {
  // Set MIX 1 to FIXED in the graph inspector, then view the console.
  await page.locator('g.node[data-id="bus.mix1"]').click();
  await chooseOption(param(page, "BUS Type").locator("select"), "1"); // FIXED
  await page.click("#btn-view-console");

  const fader = mix1Col(page).locator(".con-vfad");
  await expect(fader).toHaveClass(/readonly/);
  await expect(fader).toHaveAttribute("aria-disabled", "true");
});

// A FIXED bus takes the send after the fader and places it by the source's own PAN / BAL, so the
// PRE button and the SEND PAN knob lock with the fader; only the enable chip stays live.
// The PRE button goes on showing the tap the plan holds, set to PRE here while VARI.
test("FIXED BUS Type locks the MIX send's PRE button and SEND PAN knob, not its enable chip", async ({ page }) => {
  await page.click("#btn-view-console");
  const pre = mix1Col(page).locator(".con-slp");
  await pre.click();
  await expect(pre).toHaveAttribute("aria-pressed", "true");

  await page.click("#btn-view-graph");
  await page.locator('g.node[data-id="bus.mix1"]').click();
  await chooseOption(param(page, "BUS Type").locator("select"), "1"); // FIXED
  await page.click("#btn-view-console");

  await expect(pre).toHaveClass(/readonly/);
  await expect(pre).toHaveAttribute("aria-disabled", "true");
  await expect(pre).toHaveAttribute("aria-pressed", "true");
  await expect(mix1Col(page).locator(".con-sl")).not.toHaveClass(/readonly/);

  await strip(page, "CH 1").locator(".con-panbtn").click();
  const knob = page.locator(".con-spop .pcol", { hasText: "MIX 1" }).locator(".con-knob");
  await expect(knob).toHaveClass(/readonly/);
  await expect(knob).toHaveAttribute("aria-disabled", "true");
  // Only the bus that is FIXED: the same strip's MIX 2 knob stays editable.
  await expect(page.locator(".con-spop .pcol", { hasText: "MIX 2" }).locator(".con-knob")).not.toHaveClass(/readonly/);
});

test("VARI (default) leaves the MIX send column fader editable", async ({ page }) => {
  await page.click("#btn-view-console");
  await expect(mix1Col(page).locator(".con-vfad")).not.toHaveClass(/readonly/);
});

test("Pan Link locks the SEND PAN knob read-only", async ({ page }) => {
  await page.locator('g.node[data-id="bus.mix1"]').click();
  await param(page, "Pan Link").locator("button", { hasText: "ON" }).click();
  await page.click("#btn-view-console");

  // Open CH 1's SEND PAN popover: its MIX 1 knob is read-only under Pan Link.
  await strip(page, "CH 1").locator(".con-panbtn").click();
  const knob = page.locator(".con-spop .pcol", { hasText: "MIX 1" }).locator(".con-knob");
  await expect(knob).toHaveClass(/readonly/);
  await expect(knob).toHaveAttribute("aria-disabled", "true");
});

// While Pan Link holds, the unit keeps each send pan into the MIX at its source's own
// position: it moves them there when the link goes on and carries them along when the source
// moves. The SEND PAN knob is read-only then and shows that value — set here to R40 first,
// unlinked, so the link has somewhere to move it from.
test("under Pan Link the SEND PAN knob shows the channel's own PAN, from the switch on and through a PAN move", async ({
  page,
}) => {
  await page.click("#btn-view-console");
  const sendPan = async () => {
    await strip(page, "CH 1").locator(".con-panbtn").click();
    return page.locator(".con-spop .pcol", { hasText: "MIX 1" });
  };
  let col = await sendPan();
  await col.locator(".con-knob").focus();
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowRight");
  await expect(col.locator(".rv")).toHaveText("R40");
  await page.keyboard.press("Escape");

  await page.click("#btn-view-graph");
  await page.locator('g.node[data-id="bus.mix1"]').click();
  await param(page, "Pan Link").locator("button", { hasText: "ON" }).click();
  await page.click("#btn-view-console");
  col = await sendPan();
  await expect(col.locator(".rv")).toHaveText("C");
  await page.keyboard.press("Escape");

  const channelPan = strip(page, "CH 1").locator(".con-head .con-knob[aria-label='PAN']");
  await channelPan.focus();
  for (let i = 0; i < 13; i++) await page.keyboard.press("ArrowLeft");
  col = await sendPan();
  await expect(col.locator(".rv")).toHaveText("L13");
});

test("a FIXED MIX bus leaves the head (STEREO main path) fader editable", async ({ page }) => {
  await page.locator('g.node[data-id="bus.mix1"]').click();
  await chooseOption(param(page, "BUS Type").locator("select"), "1"); // FIXED
  await page.click("#btn-view-console");
  // FIXED gates the MIX send level, not the channel's → STEREO main fader.
  await expect(strip(page, "CH 1").locator(".con-fader")).not.toHaveClass(/readonly/);
});
