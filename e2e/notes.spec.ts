import { test, expect, type Page } from "@playwright/test";

// A node is a g.node carrying its id; the note controls live inside it.
const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const overlay = (page: Page) => page.locator("#graph-host .note-edit-overlay");

// Click the pen on a note-less node, type a note, and commit with Escape
// (which keeps the node selected).
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
    // Pin an empty starting board so the factory-seed sends do not perturb counts.
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("double-clicking a node opens its note editor", async ({ page }) => {
  // A quick double-press is the note-edit shortcut; a sustained long-press traces
  // the signal path instead, so the two stay distinct.
  await node(page, "ch1").dblclick();
  await expect(overlay(page)).toBeVisible();
  await overlay(page).fill("Quick note");
  await page.keyboard.press("Escape");
  await expect(node(page, "ch1").locator(".note-panel")).toHaveCount(1);
});

test("the pen adds a note shown inside the node frame", async ({ page }) => {
  // A note-less node offers the pen and no collapse toggle.
  await expect(node(page, "ch1").locator(".note-add")).toHaveCount(1);
  await expect(node(page, "ch1").locator(".note-toggle")).toHaveCount(0);

  await addNote(page, "ch1", "Lead vox\nComp + chorus +2 dB");

  // Now it carries an in-frame panel and swaps the pen for the collapse toggle.
  await expect(node(page, "ch1").locator(".note-panel")).toHaveCount(1);
  await expect(node(page, "ch1").locator(".note-toggle")).toHaveCount(1);
  await expect(node(page, "ch1").locator(".note-add")).toHaveCount(0);
});

test("the toggle minimizes and re-expands the note", async ({ page }) => {
  await addNote(page, "ch1", "stage monitor mix");

  await node(page, "ch1").locator(".note-toggle").click();
  await expect(node(page, "ch1").locator(".note-panel")).toHaveCount(0);
  await expect(page.locator("#statusbar")).toHaveText("Note minimized");

  await node(page, "ch1").locator(".note-toggle").click();
  await expect(node(page, "ch1").locator(".note-panel")).toHaveCount(1);
  await expect(page.locator("#statusbar")).toHaveText("Note expanded");
});

test("clicking the note area of a selected node edits it; the header does not", async ({ page }) => {
  await addNote(page, "ch1", "two\nlines"); // leaves ch1 selected
  const box = await node(page, "ch1").boundingBox();
  if (!box) throw new Error("ch1 not found");

  // Note area (lower part) opens the editor.
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height - 7);
  await expect(overlay(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(overlay(page)).toHaveCount(0);

  // Header (top part, outside the note) does not edit — it moves/selects.
  await page.mouse.click(box.x + box.width * 0.4, box.y + 6);
  await expect(overlay(page)).toHaveCount(0);
});

test("the inspector shows no note field for a selected node", async ({ page }) => {
  await addNote(page, "ch1", "note text");
  // ch1 is selected; the inspector heads it but carries no note editor.
  await expect(page.locator("#inspector h2")).toHaveText("CH 1");
  await expect(page.locator("#inspector textarea")).toHaveCount(0);
});

test("Arrange spaces a column by the expanded note's height (no overlap)", async ({ page }) => {
  // ch2 sits directly below ch1 in the channel column.
  await addNote(page, "ch1", "line one\nline two\nline three");
  await page.click("#btn-view");
  await page.click("#btn-auto");
  await page.waitForTimeout(150);
  const a = await node(page, "ch1").boundingBox();
  const b = await node(page, "ch2").boundingBox();
  if (!a || !b) throw new Error("ch1/ch2 not found");
  // ch2's top must clear ch1's bottom; a fixed row pitch would overlap them.
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height - 1);
});

test("notes and collapse state round-trip through save and open", async ({ page }, testInfo) => {
  await addNote(page, "ch1", "round-trip note");
  await node(page, "ch1").locator(".note-toggle").click(); // minimize
  await expect(node(page, "ch1").locator(".note-panel")).toHaveCount(0);

  await page.click("#btn-file");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btn-save")]);
  const saved = testInfo.outputPath("URX44V-plan.json");
  await download.saveAs(saved);

  // Saving clears the dirty flag, so New resets without prompting.
  await page.click("#btn-file");
  await page.click("#btn-new");
  await expect(node(page, "ch1").locator(".note-toggle")).toHaveCount(0);
  await expect(node(page, "ch1").locator(".note-add")).toHaveCount(1);

  await page.click("#btn-file");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#btn-open")]);
  await chooser.setFiles(saved);

  // The note returns minimized (toggle present, panel hidden until expanded).
  await expect(node(page, "ch1").locator(".note-toggle")).toHaveCount(1);
  await expect(node(page, "ch1").locator(".note-panel")).toHaveCount(0);
  await node(page, "ch1").locator(".note-toggle").click();
  await expect(node(page, "ch1").locator(".note-panel")).toHaveCount(1);
});
