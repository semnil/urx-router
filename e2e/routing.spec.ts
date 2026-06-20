import { test, expect, type Page } from "@playwright/test";

// Each committed connection renders one transparent .wire-hit band (plus a
// sibling painted path); counting the band gives one element per connection and
// targets the element that carries the wire's pointerdown handler.
const wires = (page: Page) => page.locator("#graph-host .wire-hit");
const port = (page: Page, ref: string) => page.locator(`[data-ref="${ref}"]`);

// Fixed CH / FX-return -> STEREO main-path wires are seeded on every plan and
// shown pre-connected; the diagram never starts empty. User wires are appended
// after them, so the last .wire-hit is the most recent user connection.
const FIXED = 10; // URX44V (the startup model)
const FIXED_URX22 = 8;

// A connection is a pointer drag between an output port (.port-out) and an input
// port (.port-in), in either direction; Playwright's mouse generates the
// matching pointer events.
async function connect(page: Page, fromRef: string, toRef: string): Promise<void> {
  const a = await port(page, fromRef).boundingBox();
  const b = await port(page, toRef).boundingBox();
  if (!a || !b) throw new Error(`port not found: ${fromRef} -> ${toRef}`);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  // Pin language so status-bar assertions are stable regardless of locale.
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    // Pin an empty starting board so the factory-seed sends do not perturb counts.
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("renders the URX44V nodes on load", async ({ page }) => {
  await expect(page.locator("#graph-host g.node").first()).toBeVisible();
  expect(await page.locator("#graph-host g.node").count()).toBeGreaterThan(0);
  await expect(port(page, "in.micline_1_2:out")).toBeVisible();
  await expect(port(page, "ch_5_6:in")).toBeVisible();
});

test("shows the fixed CH / FX -> STEREO wires pre-connected", async ({ page }) => {
  await expect(wires(page)).toHaveCount(FIXED);
});

test("draws a legal wire (micline 1/2 -> ch 5/6)", async ({ page }) => {
  await expect(wires(page)).toHaveCount(FIXED);
  await connect(page, "in.micline_1_2:out", "ch_5_6:in");
  await expect(wires(page)).toHaveCount(FIXED + 1);
  await expect(page.locator("#statusbar")).toHaveText("Connected");
});

test("draws a legal wire dragged from the input side (ch 5/6 <- micline 1/2)", async ({ page }) => {
  await expect(wires(page)).toHaveCount(FIXED);
  // Drag starts on the input port and releases on a legal output port.
  await connect(page, "ch_5_6:in", "in.micline_1_2:out");
  await expect(wires(page)).toHaveCount(FIXED + 1);
  await expect(page.locator("#statusbar")).toHaveText("Connected");
});

test("selects the incoming wire when clicking an occupied input port", async ({ page }) => {
  await connect(page, "in.micline_1_2:out", "ch_5_6:in");
  await expect(wires(page)).toHaveCount(FIXED + 1);
  // A plain click (no drag) on the occupied input selects its wire, like
  // clicking the wire itself; Delete then removes it.
  const box = await port(page, "ch_5_6:in").boundingBox();
  if (!box) throw new Error("port not found");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press("Delete");
  await expect(wires(page)).toHaveCount(FIXED);
  await expect(page.locator("#statusbar")).toHaveText("Connection deleted");
});

test("refuses to delete a fixed CH -> STEREO wire", async ({ page }) => {
  // The first wire is the seeded fixed CH1 -> STEREO; selecting and pressing
  // Delete must leave it in place and report it as fixed.
  await wires(page).first().dispatchEvent("pointerdown");
  await page.keyboard.press("Delete");
  await expect(wires(page)).toHaveCount(FIXED);
  await expect(page.locator("#statusbar")).toHaveText("Fixed connection — cannot be removed");
});

test("rejects a second source into a single-input receiver", async ({ page }) => {
  await connect(page, "in.micline_1_2:out", "ch_5_6:in");
  await expect(wires(page)).toHaveCount(FIXED + 1);
  // ch_5_6:in already holds a source; a second one must be refused, not added.
  await connect(page, "in.aux:out", "ch_5_6:in");
  await expect(wires(page)).toHaveCount(FIXED + 1);
  await expect(page.locator("#statusbar")).toContainText("only one source");
});

test("round-trips a plan through save and open", async ({ page }, testInfo) => {
  await connect(page, "in.micline_1_2:out", "ch_5_6:in");
  await expect(wires(page)).toHaveCount(FIXED + 1);

  await page.click("#btn-file");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#btn-save"),
  ]);
  expect(download.suggestedFilename()).toBe("URX44V-plan.json");
  const saved = testInfo.outputPath("URX44V-plan.json");
  await download.saveAs(saved);

  // Saving clears the dirty flag, so New does not prompt; the board resets to
  // just the fixed wires.
  await page.click("#btn-file");
  await page.click("#btn-new");
  await expect(wires(page)).toHaveCount(FIXED);

  await page.click("#btn-file");
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.click("#btn-open"),
  ]);
  await chooser.setFiles(saved);
  await expect(wires(page)).toHaveCount(FIXED + 1);
  await expect(page.locator("#statusbar")).toHaveText("Plan loaded");
});

test("confirms before discarding unsaved changes on model switch", async ({ page }) => {
  await connect(page, "in.micline_1_2:out", "ch_5_6:in");
  await expect(wires(page)).toHaveCount(FIXED + 1);

  // Dismiss: stay on URX44V with the wire intact.
  page.once("dialog", (d) => {
    expect(d.message()).toContain("unsaved changes");
    void d.dismiss();
  });
  await page.locator("#model-picker").selectOption("URX22");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await expect(wires(page)).toHaveCount(FIXED + 1);

  // Accept: switch to URX22 and reset to that model's fixed wires.
  page.once("dialog", (d) => void d.accept());
  await page.locator("#model-picker").selectOption("URX22");
  await expect(page.locator("#model-picker")).toHaveValue("URX22");
  await expect(wires(page)).toHaveCount(FIXED_URX22);
});

test("deletes a selected connection with the Delete key", async ({ page }) => {
  await connect(page, "in.micline_1_2:out", "ch_5_6:in");
  await expect(wires(page)).toHaveCount(FIXED + 1);

  // The user wire is the last one drawn; selecting it goes through its
  // pointerdown handler.
  await wires(page).last().dispatchEvent("pointerdown");
  await page.keyboard.press("Delete");
  await expect(wires(page)).toHaveCount(FIXED);
  await expect(page.locator("#statusbar")).toHaveText("Connection deleted");
});

test("mirrors a paired channel's source onto its partner (CH1/CH2)", async ({ page }) => {
  // Assigning a source to CH1 also wires CH2: two wires for one user action.
  await connect(page, "in.micline_1_2:out", "ch1:in");
  await expect(wires(page)).toHaveCount(FIXED + 2);

  // Deleting either source wire clears the partner's mirrored source too.
  await wires(page).last().dispatchEvent("pointerdown");
  await page.keyboard.press("Delete");
  await expect(wires(page)).toHaveCount(FIXED);
});

test("drops PRE/POST from the fixed CH -> STEREO send", async ({ page }) => {
  // The first seeded wire is CH1 -> STEREO, the fixed main-fader path. It exposes
  // LEVEL and PAN but no PRE/POST toggle — it is itself the PRE/POST reference.
  await wires(page).first().dispatchEvent("pointerdown");
  await expect(page.locator("#inspector .param")).toHaveCount(2);
  await expect(page.locator("#inspector .toggle")).toHaveCount(0);
  await expect(page.locator("#inspector")).toContainText("Fixed connection");
});

test("marks a PRE MIX send on the canvas without opening the inspector", async ({ page }) => {
  await connect(page, "ch1:out", "bus.mix1:in");
  await expect(wires(page)).toHaveCount(FIXED + 1);

  // Select the new send by clicking its sole receiving port; the MIX send exposes
  // LEVEL / PAN / PRE-POST.
  const box = await port(page, "bus.mix1:in").boundingBox();
  if (!box) throw new Error("port not found");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator("#inspector .toggle")).toHaveCount(1);
  await expect(page.locator("#inspector .param")).toHaveCount(3);

  // POST (the default) leaves the wire unmarked; PRE adds the amber tap marker
  // live, without reselecting; flipping back to POST removes it.
  const preMarker = page.locator("#graph-host text").filter({ hasText: /^PRE$/ });
  await expect(preMarker).toHaveCount(0);
  await page.locator("#inspector .toggle button").filter({ hasText: /^PRE$/ }).click();
  await expect(preMarker).toHaveCount(1);
  await page.locator("#inspector .toggle button").filter({ hasText: /^POST$/ }).click();
  await expect(preMarker).toHaveCount(0);
});

test("a microSD Rec assign carries no level / pan / PRE-POST", async ({ page }) => {
  // SD Rec is a record-source assign (sendSwitch), not a summing send.
  await connect(page, "ch1:out", "out.sdrec:in");
  await expect(wires(page)).toHaveCount(FIXED + 1);
  const box = await port(page, "out.sdrec:in").boundingBox();
  if (!box) throw new Error("port not found");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator("#inspector .param")).toHaveCount(0);
  await expect(page.locator("#inspector .hint")).toContainText("Selection only");
});

test("the send pan slider uses the device L63 – C – R63 range", async ({ page }) => {
  await connect(page, "ch1:out", "bus.mix1:in");
  const box = await port(page, "bus.mix1:in").boundingBox();
  if (!box) throw new Error("port not found");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const pan = page.locator("#inspector .param", { hasText: "Pan" }).locator("input[type='range']");
  await expect(pan).toHaveAttribute("min", "-63");
  await expect(pan).toHaveAttribute("max", "63");
});

test("the send level slider bottoms out at -∞ (level_gain floor), not -60", async ({ page }) => {
  await connect(page, "ch1:out", "bus.mix1:in");
  const box = await port(page, "bus.mix1:in").boundingBox();
  if (!box) throw new Error("port not found");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const level = page.locator("#inspector .param", { hasText: "Level" }).locator("input[type='range']");
  await expect(level).toHaveAttribute("min", "-96.5"); // -∞ notch
  await expect(level).toHaveAttribute("max", "10");
  // Dragging to the bottom reads -∞ dB.
  await level.fill("-96.5");
  await expect(page.locator("#inspector .param", { hasText: "Level" }).locator(".param-val")).toHaveText("-∞ dB");
});

test("tears down the rubber-band wire when the pointer is cancelled mid-drag", async ({ page }) => {
  const a = await port(page, "in.micline_1_2:out").boundingBox();
  if (!a) throw new Error("port not found");
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 24, a.y + a.height / 2 + 24, { steps: 4 });
  // Dragging past the threshold starts a dashed rubber-band wire.
  await expect(page.locator("#graph-host .overlay-temp")).toHaveCount(1);
  // A cancelled pointer never delivers pointerup; the drag must still tear down.
  await page.locator("#graph-host svg").dispatchEvent("pointercancel");
  await expect(page.locator("#graph-host .overlay-temp")).toHaveCount(0);
  await page.mouse.up();
});
