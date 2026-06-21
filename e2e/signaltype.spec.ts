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
