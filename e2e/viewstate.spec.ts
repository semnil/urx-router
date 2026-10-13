import { test, expect, type Page } from "./fixtures";
import { selectWire } from "./graph-helpers";

// GRAPH <-> CONSOLE are two views of one plan. These tests cover that an edit made
// in one view is read back in the other (both views funnel edits through
// markChanged, and switching back repaints the target view), for the head fader,
// the SENDS rack, and the MUTE chip.

// A console strip located by its scribble's exact node name (so "CH 1" never
// matches "CH 11/12"). Runs against the factory plan (no "empty" seed).
const strip = (page: Page, name: string) => page.locator(".con-strip", { has: page.getByText(name, { exact: true }) });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-model", "URX44V");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("a rack send-fader edit is read back on the graph's CH -> MIX wire", async ({ page }) => {
  await page.click("#btn-view-console");
  // Edit the CH 1 → MIX 1 send level in the SENDS rack column (Home = +10.0 dB max).
  const fader = strip(page, "CH 1")
    .locator(".con-scol", { has: page.getByRole("button", { name: "M1", exact: true }) })
    .locator(".con-vfad");
  await fader.focus();
  await page.keyboard.press("Home");
  // The header readout reflects the edited send.
  await expect(strip(page, "CH 1").locator(".con-sh .rdout")).toContainText("MIX 1 +10.0");

  // The same send level reads back on the graph's CH 1 -> MIX 1 wire.
  await page.click("#btn-view-graph");
  await selectWire(page, "ch1:out", "bus.mix1:in");
  await expect(page.locator("#inspector .param", { hasText: "Level" }).locator(".param-val")).toHaveText("+10.0 dB");
});

test("a console fader edit is read back on the graph's CH -> STEREO wire", async ({ page }) => {
  await page.click("#btn-view-console");
  const readout = strip(page, "CH 1").locator(".con-readout .rd:not(.mtr) .rv");
  await expect(readout).toHaveText("0.0");
  await strip(page, "CH 1").locator(".con-fader").focus();
  // Two detents up the level_gain grid: 0.0 -> +0.4 -> +1.2 dB.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(readout).toHaveText("+1.2");

  // The CH 1 main fader IS the CH1 -> STEREO send level; selecting that wire on
  // the graph must show the same +1.2 dB the console just set.
  await page.click("#btn-view-graph");
  await selectWire(page, "ch1:out", "bus.stereo:in");
  await expect(page.locator("#inspector .param", { hasText: "Level" }).locator(".param-val")).toHaveText("+1.2 dB");
});

test("a graph-side channel mute dims the console strip and unlights its power LED", async ({ page }) => {
  // Mute CH 1 from the graph inspector (the channel ON toggle), then open the
  // console: the console MUTE chip drives the → STEREO assign, so a channel-master
  // mute surfaces as the strip's dim + unlit scribble power LED, not the MUTE chip.
  await page.locator('g.node[data-id="ch1"]').click();
  const onToggle = page.locator("#inspector .param", { hasText: "Channel" }).first();
  // The channel ON/OFF toggle lives in the inspector; click its OFF button to mute.
  await onToggle.locator(".toggle button").filter({ hasText: /^OFF$/ }).click();

  await page.click("#btn-view-console");
  const ch = strip(page, "CH 1");
  await expect(ch).toHaveClass(/inactive/);
  await expect(ch.locator(".con-power")).toHaveAttribute("aria-pressed", "false");
});

test("a console MUTE persists across a GRAPH round-trip", async ({ page }) => {
  await page.click("#btn-view-console");
  const mute = strip(page, "CH 1").getByRole("button", { name: "MUTE" });
  await expect(mute).toHaveAttribute("aria-pressed", "false");
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true");

  await page.click("#btn-view-graph");
  await page.click("#btn-view-console");

  await expect(strip(page, "CH 1").getByRole("button", { name: "MUTE" })).toHaveAttribute("aria-pressed", "true");
});

test("the graph is back in its own framing on the first frame after the CONSOLE", async ({ page }) => {
  // A jack's rectangle read the moment the graph is shown is where a press lands. The
  // board must already stand where it stood, not where a fit to the hidden (sizeless)
  // host put it until the next resize callback re-fits it.
  const viewport = page.locator("#graph-host svg > g").first();
  const before = await viewport.getAttribute("transform");
  await page.click("#btn-view-console");
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const shown = await page.evaluate(() => {
    document.getElementById("btn-view-graph")!.click();
    return document.querySelector("#graph-host svg > g")!.getAttribute("transform");
  });
  expect(shown).toBe(before);
});

test("a model switched behind the CONSOLE is framed on the graph's first frame", async ({ page }) => {
  await page.click("#btn-view-console");
  await page.selectOption("#model-picker", "URX22");
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const shown = await page.evaluate(() => {
    document.getElementById("btn-view-graph")!.click();
    return document.querySelector("#graph-host svg > g")!.getAttribute("transform");
  });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  expect(shown).toBe(await page.locator("#graph-host svg > g").first().getAttribute("transform"));
});

test("an undo behind the CONSOLE is framed on the graph's first frame", async ({ page }) => {
  // The undo brings the shelved nodes back, so the board the graph is framed to on its
  // first frame has to be the restored one rather than the one it was hidden with.
  await page.click("#btn-view");
  await page.click("#btn-hide-unused");
  await expect(page.locator(".hidden-shelf")).toBeVisible();
  await page.click("#btn-view-console");
  await page.keyboard.press("ControlOrMeta+z");
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const shown = await page.evaluate(() => {
    document.getElementById("btn-view-graph")!.click();
    return document.querySelector("#graph-host svg > g")!.getAttribute("transform");
  });
  await expect(page.locator(".hidden-shelf")).toBeHidden();
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  expect(shown).toBe(await page.locator("#graph-host svg > g").first().getAttribute("transform"));
});

test("a board zoomed by hand keeps its framing across a CONSOLE visit with a resize", async ({ page }) => {
  const viewport = page.locator("#graph-host svg > g").first();
  const box = (await page.locator("#graph-host").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const fitted = await viewport.getAttribute("transform");
  await page.mouse.wheel(0, -100);
  await expect.poll(() => viewport.getAttribute("transform")).not.toBe(fitted);
  const zoomed = await viewport.getAttribute("transform");
  await page.click("#btn-view-console");
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: size.width - 200, height: size.height - 100 });
  await page.click("#btn-view-graph");
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  expect(await viewport.getAttribute("transform")).toBe(zoomed);
});
