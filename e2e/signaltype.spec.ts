import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const param = (page: Page, label: string) => page.locator("#inspector .param", { hasText: label });
const sigSelect = (page: Page) => param(page, "Signal Type").locator("select");
const panBalSelect = (page: Page) => param(page, "PAN / BAL").locator("select");
const link = (page: Page) => page.locator("#graph-host text", { hasText: "♥" });

// Save the plan and return the pan of a from->to connection.
async function panOf(
  page: Page,
  testInfo: { outputPath: (n: string) => string },
  from: string,
  to: string,
): Promise<number | undefined> {
  await page.click("#btn-file");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btn-save")]);
  const file = testInfo.outputPath("plan.json");
  await download.saveAs(file);
  const plan = JSON.parse(readFileSync(file, "utf8"));
  const c = plan.connections.find((x: { from: string; to: string }) => x.from === from && x.to === to);
  return c?.params?.pan;
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

test("mono pair gets a Signal Type select; STEREO reveals PAN/BAL and a heart link", async ({ page }) => {
  await node(page, "ch1").click();
  await expect(sigSelect(page).locator("option")).toHaveText(["MONO x 2", "STEREO"]);
  await expect(sigSelect(page)).toHaveValue("0"); // MONO x 2
  await expect(param(page, "PAN / BAL")).toHaveCount(0);
  await expect(link(page)).toHaveCount(0);

  await sigSelect(page).selectOption("1"); // STEREO
  await expect(param(page, "PAN / BAL")).toHaveCount(1);
  await expect(link(page)).toHaveCount(1); // heart tie on the canvas

  // The partner channel shows the same Signal Type (stored on the primary).
  await node(page, "ch2").click();
  await expect(sigSelect(page)).toHaveValue("1");
});

test("BAL mode labels a send from the linked channel as BALANCE", async ({ page }) => {
  await node(page, "ch1").click();
  await sigSelect(page).selectOption("1"); // STEREO
  await param(page, "PAN / BAL").locator("select").selectOption("1"); // BAL

  // The ch1 -> MIX 1 send is a fixed (always-wired) send; select it by endpoint.
  // dispatchEvent bypasses the overlapping wire-hit bands' pointer interception.
  await page.locator('.wire-hit[data-from="ch1:out"][data-to="bus.mix1:in"]').dispatchEvent("pointerdown");
  await expect(page.locator("#inspector .param", { hasText: "Balance" })).toHaveCount(1);
  await expect(page.locator("#inspector .param-label span", { hasText: /^Pan$/ })).toHaveCount(0);
});

test("signal type round-trips through save and open", async ({ page }, testInfo) => {
  await node(page, "ch3").click();
  await sigSelect(page).selectOption("1");
  await page.click("#btn-file");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btn-save")]);
  const saved = testInfo.outputPath("plan.json");
  await download.saveAs(saved);
  await page.click("#btn-file");
  await page.click("#btn-new");
  await page.click("#btn-file");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#btn-open")]);
  await chooser.setFiles(saved);
  await node(page, "ch4").click();
  await expect(sigSelect(page)).toHaveValue("1"); // partner reflects primary ch3
});

test("a STEREO pair drags as one unit; the heart tie follows", async ({ page }) => {
  await node(page, "ch1").click();
  await sigSelect(page).selectOption("1"); // STEREO

  const before1 = await node(page, "ch1").boundingBox();
  const before2 = await node(page, "ch2").boundingBox();
  if (!before1 || !before2) throw new Error("nodes not found");

  // Drag CH2 (the partner, not the just-clicked node, to avoid the double-press
  // note shortcut). The linked CH1 must follow by the same delta.
  const gx = before2.x + before2.width * 0.35;
  const gy = before2.y + 12;
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  await page.mouse.move(gx + 130, gy + 80, { steps: 10 });
  await page.mouse.up();

  const after1 = await node(page, "ch1").boundingBox();
  const after2 = await node(page, "ch2").boundingBox();
  if (!after1 || !after2) throw new Error("nodes gone");
  expect(Math.hypot(after2.x - before2.x, after2.y - before2.y)).toBeGreaterThan(20);
  expect(Math.abs(after1.x - before1.x - (after2.x - before2.x))).toBeLessThan(2);
  expect(Math.abs(after1.y - before1.y - (after2.y - before2.y))).toBeLessThan(2);
  await expect(link(page)).toHaveCount(1); // tie still drawn after the move
});

test("STEREO-linking snaps a partner moved away back beside the kept primary", async ({ page }) => {
  const c1 = await node(page, "ch1").boundingBox();
  const start2 = await node(page, "ch2").boundingBox();
  if (!c1 || !start2) throw new Error("nodes not found");

  // Drag CH2 far away while still MONO x 2 (it moves alone), opening a gap.
  const gx = start2.x + start2.width * 0.35;
  const gy = start2.y + 12;
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  await page.mouse.move(gx + 220, gy + 160, { steps: 10 });
  await page.mouse.up();
  const moved2 = await node(page, "ch2").boundingBox();
  if (!moved2) throw new Error("ch2 gone");

  // STEREO-link from CH1 (the kept node): CH2 snaps back into CH1's column,
  // directly below it, so the heart tie is short rather than stretched.
  await node(page, "ch1").click();
  await sigSelect(page).selectOption("1");
  const after1 = await node(page, "ch1").boundingBox();
  const after2 = await node(page, "ch2").boundingBox();
  if (!after1 || !after2) throw new Error("nodes gone");
  expect(Math.abs(after1.x - c1.x)).toBeLessThan(2); // kept node stays put
  expect(Math.abs(after2.x - after1.x)).toBeLessThan(2); // same column
  expect(after2.y).toBeGreaterThan(after1.y); // below it
  expect(Math.hypot(after2.x - moved2.x, after2.y - moved2.y)).toBeGreaterThan(20); // it really moved back
  await expect(link(page)).toHaveCount(1);
});

test("STEREO-linking from the partner keeps the partner and realigns the primary above it", async ({ page }) => {
  const c2 = await node(page, "ch2").boundingBox();
  const start1 = await node(page, "ch1").boundingBox();
  if (!c2 || !start1) throw new Error("nodes not found");

  // Drag CH1 (the primary) far away while still MONO x 2.
  const gx = start1.x + start1.width * 0.35;
  const gy = start1.y + 12;
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  await page.mouse.move(gx + 200, gy - 150, { steps: 10 });
  await page.mouse.up();
  const moved1 = await node(page, "ch1").boundingBox();
  if (!moved1) throw new Error("ch1 gone");

  // Link from CH2: CH2 is the kept node, so CH1 snaps back above it.
  await node(page, "ch2").click();
  await sigSelect(page).selectOption("1");
  const after1 = await node(page, "ch1").boundingBox();
  const after2 = await node(page, "ch2").boundingBox();
  if (!after1 || !after2) throw new Error("nodes gone");
  expect(Math.abs(after2.x - c2.x)).toBeLessThan(2); // kept node stays put
  expect(Math.abs(after1.x - after2.x)).toBeLessThan(2); // same column
  expect(after1.y).toBeLessThan(after2.y); // above it
  expect(Math.hypot(after1.x - moved1.x, after1.y - moved1.y)).toBeGreaterThan(20);
  await expect(link(page)).toHaveCount(1);
});

test("a MONO x 2 pair does not drag together", async ({ page }) => {
  const before2 = await node(page, "ch2").boundingBox();
  const box1 = await node(page, "ch1").boundingBox();
  if (!before2 || !box1) throw new Error("nodes not found");
  const gx = box1.x + box1.width * 0.35;
  const gy = box1.y + 12;
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  await page.mouse.move(gx + 120, gy + 70, { steps: 10 });
  await page.mouse.up();
  const after2 = await node(page, "ch2").boundingBox();
  if (!after2) throw new Error("ch2 gone");
  expect(Math.abs(after2.x - before2.x)).toBeLessThan(2);
  expect(Math.abs(after2.y - before2.y)).toBeLessThan(2);
});

test("PAN/BAL re-inits the pan of the STEREO and MIX sends for both pair members", async ({ page }, testInfo) => {
  // CH1/CH2 → MIX1 are fixed (always-wired) sends seeded on the board.
  // Enter STEREO -> PAN mode: odd hard-left (-63), even hard-right (+63), on the
  // fixed CH->STEREO send and the fixed MIX 1 sends alike.
  await node(page, "ch1").click();
  await sigSelect(page).selectOption("1");
  expect(await panOf(page, testInfo, "ch1:out", "bus.stereo:in")).toBe(-63);
  expect(await panOf(page, testInfo, "ch2:out", "bus.stereo:in")).toBe(63);
  expect(await panOf(page, testInfo, "ch1:out", "bus.mix1:in")).toBe(-63);
  expect(await panOf(page, testInfo, "ch2:out", "bus.mix1:in")).toBe(63);

  // BAL mode: both centre (0) everywhere (toggle from the partner member).
  await node(page, "ch2").click();
  await panBalSelect(page).selectOption("1");
  expect(await panOf(page, testInfo, "ch1:out", "bus.stereo:in")).toBe(0);
  expect(await panOf(page, testInfo, "ch1:out", "bus.mix1:in")).toBe(0);
  expect(await panOf(page, testInfo, "ch2:out", "bus.mix1:in")).toBe(0);

  // Back to PAN: re-inits to L/R again.
  await node(page, "ch1").click();
  await panBalSelect(page).selectOption("0");
  expect(await panOf(page, testInfo, "ch1:out", "bus.mix1:in")).toBe(-63);
  expect(await panOf(page, testInfo, "ch2:out", "bus.mix1:in")).toBe(63);
});

test("MONO x 2 (unlinked) leaves send pans untouched", async ({ page }, testInfo) => {
  // No Signal Type change: the seeded CH1 → MIX1 send keeps its default pan (unset),
  // never the STEREO hard-pan, confirming the re-init does not run while unlinked.
  expect(await panOf(page, testInfo, "ch1:out", "bus.mix1:in")).toBeUndefined();
});

// A console strip located by its scribble's node name (exact).
const cstrip = (page: Page, name: string) => page.locator(".con-strip", { has: page.getByText(name, { exact: true }) });

test("CONSOLE reads a BAL-linked mono channel's pan as BAL, matching the inspector", async ({ page }) => {
  await page.click("#btn-view-console");
  await expect(cstrip(page, "CH 1").locator(".con-knob[aria-label='PAN']")).toBeVisible();

  await page.click("#btn-view-graph");
  await node(page, "ch1").click();
  await sigSelect(page).selectOption("1"); // STEREO
  await panBalSelect(page).selectOption("1"); // BAL

  await page.click("#btn-view-console");
  await expect(cstrip(page, "CH 1").locator(".con-knob[aria-label='BAL']")).toBeVisible();
  await expect(cstrip(page, "CH 2").locator(".con-knob[aria-label='BAL']")).toBeVisible();
  await expect(cstrip(page, "CH 1").locator(".con-knob[aria-label='PAN']")).toHaveCount(0);
});

test("BAL mode links a fader edit across both channels in the CONSOLE", async ({ page }) => {
  await node(page, "ch1").click();
  await sigSelect(page).selectOption("1"); // STEREO
  await panBalSelect(page).selectOption("1"); // BAL

  await page.click("#btn-view-console");
  const ch1 = cstrip(page, "CH 1").locator(".con-readout .rd:not(.mtr) .rv");
  const ch2 = cstrip(page, "CH 2").locator(".con-readout .rd:not(.mtr) .rv");
  await expect(ch1).toHaveText("0.0");
  await expect(ch2).toHaveText("0.0");

  await cstrip(page, "CH 1").locator(".con-fader").focus();
  await page.keyboard.press("ArrowUp"); // one detent up the level_gain grid: +0.4 dB
  await expect(ch1).toHaveText("+0.4");
  await expect(ch2).toHaveText("+0.4"); // the partner follows in BAL
});

test("BAL mode links a MUTE toggle across both channels in the CONSOLE", async ({ page }) => {
  await node(page, "ch1").click();
  await sigSelect(page).selectOption("1"); // STEREO
  await panBalSelect(page).selectOption("1"); // BAL

  await page.click("#btn-view-console");
  const m1 = cstrip(page, "CH 1").getByRole("button", { name: "MUTE" });
  const m2 = cstrip(page, "CH 2").getByRole("button", { name: "MUTE" });
  await expect(m1).toHaveAttribute("aria-pressed", "false");
  await expect(m2).toHaveAttribute("aria-pressed", "false");
  await m1.click();
  await expect(m1).toHaveAttribute("aria-pressed", "true");
  await expect(m2).toHaveAttribute("aria-pressed", "true"); // partner follows in BAL
});

test("BAL mode links a gain edit across both channels in the CONSOLE", async ({ page }) => {
  await node(page, "ch1").click();
  await sigSelect(page).selectOption("1"); // STEREO
  await panBalSelect(page).selectOption("1"); // BAL

  await page.click("#btn-view-console");
  const g1 = cstrip(page, "CH 1")
    .locator(".con-gain", { has: page.locator(".con-knob[aria-label='A.GAIN']") })
    .locator(".val");
  const g2 = cstrip(page, "CH 2")
    .locator(".con-gain", { has: page.locator(".con-knob[aria-label='A.GAIN']") })
    .locator(".val");
  await expect(g1).toHaveText("-8");
  await expect(g2).toHaveText("-8");
  await cstrip(page, "CH 1").locator(".con-knob[aria-label='A.GAIN']").focus();
  await page.keyboard.press("ArrowUp");
  await expect(g1).toHaveText("-7");
  await expect(g2).toHaveText("-7"); // partner follows in BAL
});

test("BAL mode shares one balance across both channels in the CONSOLE", async ({ page }) => {
  await node(page, "ch1").click();
  await sigSelect(page).selectOption("1"); // STEREO
  await panBalSelect(page).selectOption("1"); // BAL — both centre (C)

  await page.click("#btn-view-console");
  const bal = (name: string) =>
    cstrip(page, name)
      .locator(".con-gain", { has: page.locator(".con-knob[aria-label='BAL']") })
      .locator(".val");
  await expect(bal("CH 1")).toHaveText("C");
  await expect(bal("CH 2")).toHaveText("C");

  // Nudge CH1's balance; CH2 reads the same shared value.
  await cstrip(page, "CH 1").locator(".con-knob[aria-label='BAL']").focus();
  await page.keyboard.press("ArrowUp");
  await expect(bal("CH 1")).toHaveText("R1");
  await expect(bal("CH 2")).toHaveText("R1");
});

test("BAL mode edits a MIX send pan without closing the SEND PAN popover", async ({ page }) => {
  // Regression: a BAL-linked pan edit re-rendered the console to sync the partner
  // strip, which tore down the open SEND PAN popover on every nudge. The popover knob
  // now skips that sync (the plan mirror via commit is enough; no partner send-pan
  // control is on screen), so the popover survives.
  await node(page, "ch1").click();
  await sigSelect(page).selectOption("1"); // STEREO
  await panBalSelect(page).selectOption("1"); // BAL

  await page.click("#btn-view-console");
  await cstrip(page, "CH 1").locator(".con-panbtn").click();
  const pop = page.locator(".con-spop");
  const val = pop.locator(".pcol", { hasText: "MIX 1" }).locator(".rv");
  await expect(val).toHaveText("C");
  await pop.locator(".pcol", { hasText: "MIX 1" }).locator(".con-knob").focus();
  await page.keyboard.press("ArrowRight");
  await expect(val).toHaveText("R1"); // the edit applied...
  await expect(pop).toBeVisible(); // ...and the popover stayed open
});

test("PAN mode keeps the two channels' faders independent in the CONSOLE", async ({ page }) => {
  await node(page, "ch1").click();
  await sigSelect(page).selectOption("1"); // STEREO, default PAN mode

  await page.click("#btn-view-console");
  const ch1 = cstrip(page, "CH 1").locator(".con-readout .rd:not(.mtr) .rv");
  const ch2 = cstrip(page, "CH 2").locator(".con-readout .rd:not(.mtr) .rv");
  await cstrip(page, "CH 1").locator(".con-fader").focus();
  await page.keyboard.press("ArrowUp"); // one detent up the level_gain grid: +0.4 dB
  await expect(ch1).toHaveText("+0.4");
  await expect(ch2).toHaveText("0.0"); // no mirroring in PAN mode
});
