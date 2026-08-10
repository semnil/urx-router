import { test, expect, type Page } from "./fixtures";

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

// A tuning screen can be open over a drop, so the plan the drop brings in has to reach it
// — and a report about that drop has to be readable in front of it.
const eqPlan = {
  format: "urx-router-plan",
  version: 1,
  modelId: "URX44V",
  connections: [],
  nodeParams: { ch1: { eqBands: [{ on: true, type: 0, freq: 250, q: 2, gain: -6 }] } },
};
// One connection the routing rules refuse, so the load stops at the report.
const illegalPlan = {
  format: "urx-router-plan",
  version: 1,
  modelId: "URX44V",
  connections: [{ from: "ch1:out", to: "ch2:in", kind: "source" }],
};

const openEqScreen = async (page: Page): Promise<void> => {
  await page.locator('#graph-host g.node[data-id="ch1"]').click();
  await page.locator("#inspector #btn-eq-screen").click();
  await expect(page.locator("#dyn-screen-box")).toBeVisible();
};
const bandRow = (page: Page, label: string) =>
  page
    .locator("#dyn-screen-box .prefs-section", { hasText: "Parameters" })
    .locator(".prefs-row")
    .filter({ has: page.getByText(label, { exact: true }) });

test("a dropped plan reaches a tuning screen that is open over it", async ({ page }) => {
  await openEqScreen(page);
  await expect(bandRow(page, "Freq").locator(".param-val")).toHaveText("125 Hz"); // the default
  await expect(bandRow(page, "Type").locator("select")).toHaveValue("1"); // Shelving

  await dropFiles(page, [{ name: "eq.json", body: JSON.stringify(eqPlan) }]);
  await expect(page.locator("#statusbar")).toContainText("Plan loaded");

  // The screen reads the plan through a closure, so its values were already the new ones;
  // what it needed was to be told to redraw.
  await expect(bandRow(page, "Freq").locator(".param-val")).toHaveText("250 Hz");
  await expect(bandRow(page, "Type").locator("select")).toHaveValue("0"); // Peaking
  await expect(bandRow(page, "Gain").locator(".param-val")).toHaveText("-6.0 dB");
  await expect(bandRow(page, "Q").locator(".param-val")).toHaveText("2.00");
});

test("the overlay itself sits in front of an open tuning screen", async ({ page }) => {
  await openEqScreen(page);
  await drag(page, ["dragenter", "dragover"], [{ name: "eq.json", body: JSON.stringify(eqPlan) }]);
  await expect(page.locator("#dropzone")).toBeVisible();

  // Not elementFromPoint here: the advert keeps `pointer-events: none` so it cannot
  // swallow the drop it advertises, which makes hit-testing look straight through it. The
  // cascade is what was wrong — its z-index was set before .consent-scrim's and lost to it
  // at equal specificity, leaving the advert tied with every modal and behind them all on
  // document order. So the assertion is on the number that decides.
  const order = await page.evaluate(() => ({
    advert: Number(getComputedStyle(document.getElementById("dropzone") as Element).zIndex),
    screen: Number(getComputedStyle(document.getElementById("dyn-screen-modal") as Element).zIndex),
  }));
  expect(order.advert).toBeGreaterThan(order.screen);
});

test("the load report sits in front of an open tuning screen", async ({ page }) => {
  await openEqScreen(page);
  await dropFiles(page, [{ name: "illegal.json", body: JSON.stringify(illegalPlan) }]);
  const report = page.locator("#load-report");
  await expect(report).toBeVisible();

  // Visible is not enough: both are full-window scrims, and the report used to lose the
  // z-order tiebreak to the screen simply by coming earlier in the document. Ask the
  // browser what is actually at the point the operator would press.
  const box = (await report.locator(".consent-box").boundingBox()) as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  const onTop = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest(".consent-scrim")?.id ?? null,
    [box.x + box.width / 2, box.y + box.height / 2],
  );
  expect(onTop).toBe("load-report");
  // The refused plan did not land, so the screen behind it still holds the old values.
  await page.locator("#load-report-close").click();
  await expect(bandRow(page, "Freq").locator(".param-val")).toHaveText("125 Hz");
});
