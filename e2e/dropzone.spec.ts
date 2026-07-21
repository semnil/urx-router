import { test, expect, type Page } from "@playwright/test";

// Drag & drop of a plan onto the window. This is the browser delivery path (DOM
// drag events carrying File objects); the desktop path goes through the shell's
// own drag events and real paths, which this suite cannot reach.

const markedPlan = {
  format: "urx-router-plan",
  version: 1,
  modelId: "URX44V",
  connections: [],
  nodeNames: { ch1: "DROPPED-MARK" },
};

/** Dispatch the drag sequence a real drop produces, with `files` attached. */
async function drag(page: Page, phases: string[], files: Array<{ name: string; body: string }>): Promise<void> {
  await page.evaluate(
    ({ phases, files }) => {
      const transfer = new DataTransfer();
      for (const file of files) transfer.items.add(new File([file.body], file.name, { type: "application/json" }));
      for (const phase of phases) {
        window.dispatchEvent(new DragEvent(phase, { dataTransfer: transfer, bubbles: true, cancelable: true }));
      }
    },
    { phases, files },
  );
}

const dropFiles = (page: Page, files: Array<{ name: string; body: string }>): Promise<void> =>
  drag(page, ["dragenter", "dragover", "drop"], files);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("dropping a plan file loads it", async ({ page }) => {
  await dropFiles(page, [{ name: "marked.json", body: JSON.stringify(markedPlan) }]);
  await expect(page.locator("#statusbar")).toContainText("Plan loaded");
  await page.locator('#graph-host g.node[data-id="ch1"]').click();
  await expect(page.locator("#inspector input[type='text']")).toHaveValue("DROPPED-MARK");
});

test("the overlay names what can be dropped, and clears once the drop lands", async ({ page }) => {
  const overlay = page.locator("#dropzone");
  await expect(overlay).toBeHidden();
  await drag(page, ["dragenter", "dragover"], [{ name: "marked.json", body: JSON.stringify(markedPlan) }]);
  await expect(overlay).toBeVisible();
  // Settings-file import is desktop + experimental only, so the browser offers
  // the plan-only caption.
  await expect(page.locator("#dropzone-label")).toHaveText("Drop a plan (.json) to open it");
  await drag(page, ["drop"], [{ name: "marked.json", body: JSON.stringify(markedPlan) }]);
  await expect(overlay).toBeHidden();
});

test("a leave without a drop clears the overlay", async ({ page }) => {
  await drag(page, ["dragenter", "dragover", "dragleave"], [{ name: "marked.json", body: "{}" }]);
  await expect(page.locator("#dropzone")).toBeHidden();
});

// A refused drop must say so rather than look like a load that did nothing: the
// plan on the board has to stay exactly as it was.
test("a file this build cannot open is refused by name", async ({ page }) => {
  await dropFiles(page, [{ name: "00-backup.urxf", body: "not a plan" }]);
  await expect(page.locator("#statusbar")).toContainText("00-backup.urxf cannot be opened here");
  await expect(page.locator("#statusbar")).toContainText("drop a plan (.json)");
});

test("dropping several files at once is refused rather than guessed at", async ({ page }) => {
  await dropFiles(page, [
    { name: "a.json", body: JSON.stringify(markedPlan) },
    { name: "b.json", body: JSON.stringify(markedPlan) },
  ]);
  await expect(page.locator("#statusbar")).toContainText("Drop one file at a time");
  // Neither plan may have been loaded.
  await page.locator('#graph-host g.node[data-id="ch1"]').click();
  await expect(page.locator("#inspector input[type='text']")).not.toHaveValue("DROPPED-MARK");
});

// A drop that fails to parse is a failed action, so it surfaces as the same modal
// File > Open uses — not as a silently unchanged board.
test("a dropped file that is not a plan reports the load failure", async ({ page }) => {
  const messages: string[] = [];
  page.on("dialog", (dialog) => {
    messages.push(dialog.message());
    void dialog.dismiss();
  });
  await dropFiles(page, [{ name: "notes.json", body: '{"hello":"world"}' }]);
  await expect.poll(() => messages).toEqual([expect.stringContaining("Load error")]);
});
