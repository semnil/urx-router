import { test, expect, type Page } from "@playwright/test";

// Each committed connection renders one transparent .wire-hit band (plus a
// sibling painted path); counting the band gives one element per connection and
// targets the element that carries the wire's pointerdown handler.
const wires = (page: Page) => page.locator("#graph-host .wire-hit");
const port = (page: Page, ref: string) => page.locator(`[data-ref="${ref}"]`);

// Fixed wires are seeded on every plan and shown pre-connected; the diagram never
// starts empty. Every CH / FX-channel send is fixed now (always wired, on/off in a
// param), so the STEREO main paths and every CH/FX → MIX/FX send count here. User
// wires (source / patch / etc.) are appended after them, so the last .wire-hit is
// the most recent user connection.
const FIXED = 48; // URX44V: 8 CH→STEREO + 2 FX→STEREO + 4 FX→MIX + 8 CH × (MIX1/2 + FX1/2) + 2 MIX→STEREO
const FIXED_URX22 = 38; // URX22: 6 CH→STEREO + 2 FX→STEREO + 4 FX→MIX + 6 CH × (MIX1/2 + FX1/2) + 2 MIX→STEREO

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
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btn-save")]);
  expect(download.suggestedFilename()).toBe("URX44V-plan.json");
  const saved = testInfo.outputPath("URX44V-plan.json");
  await download.saveAs(saved);

  // Saving clears the dirty flag, so New does not prompt; the board resets to
  // just the fixed wires.
  await page.click("#btn-file");
  await page.click("#btn-new");
  await expect(wires(page)).toHaveCount(FIXED);

  await page.click("#btn-file");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#btn-open")]);
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

test("drops PRE/POST from the fixed CH -> STEREO send but keeps its STEREO-assign ON", async ({ page }) => {
  // CH1 -> STEREO is the fixed main-fader path. Since firmware V1.3 it carries a
  // STEREO-assign ON (post-fader) plus LEVEL and PAN, but no PRE/POST toggle — it is
  // itself the PRE/POST reference. Select it by endpoint (off sends paint behind).
  await page.locator('.wire-hit[data-from="ch1:out"][data-to="bus.stereo:in"]').dispatchEvent("pointerdown");
  await expect(page.locator("#inspector .param")).toHaveCount(3); // Send ON + Pan + Level
  await expect(page.locator("#inspector .toggle")).toHaveCount(1); // the STEREO-assign ON only (no PRE/POST)
  await expect(page.locator("#inspector")).toContainText("Fixed connection");
});

test("marks a PRE MIX send on the canvas without opening the inspector", async ({ page }) => {
  // CH1 → MIX1 is a fixed (always-wired) send now; select it directly by endpoint.
  // The MIX send exposes a Send ON toggle plus LEVEL / PAN / PRE-POST.
  await page.locator('.wire-hit[data-from="ch1:out"][data-to="bus.mix1:in"]').dispatchEvent("pointerdown");
  await expect(page.locator("#inspector .toggle")).toHaveCount(2); // Send ON + PRE/POST
  await expect(page.locator("#inspector .param")).toHaveCount(4); // Send ON + PRE/POST + Pan + Level

  // POST (the default) leaves the wire unmarked; PRE adds the amber tap marker
  // live, without reselecting; flipping back to POST removes it.
  const preMarker = page.locator("#graph-host text").filter({ hasText: /^PRE$/ });
  await expect(preMarker).toHaveCount(0);
  await page.locator("#inspector .toggle button").filter({ hasText: /^PRE$/ }).click();
  await expect(preMarker).toHaveCount(1);
  await page
    .locator("#inspector .toggle button")
    .filter({ hasText: /^POST$/ })
    .click();
  await expect(preMarker).toHaveCount(0);
});

test("a fixed FX channel → MIX send exposes a Send ON toggle and no delete", async ({ page }) => {
  // FX 1 → MIX 1 is fixed (always wired); its inspector shows a Send ON toggle
  // (SEND_ON) plus PRE / Pan / Level, and offers no delete (it is structural).
  await page.locator('.wire-hit[data-from="bus.fx1:out"][data-to="bus.mix1:in"]').dispatchEvent("pointerdown");
  const sendRow = page.locator("#inspector .param", { hasText: "Send" });
  await expect(sendRow).toHaveCount(1);
  await expect(page.locator("#inspector .toggle")).toHaveCount(2); // Send ON + PRE/POST
  await expect(page.locator("#inspector button.danger")).toHaveCount(0); // structural — no delete

  // Turning the send OFF keeps the (fixed) wire — it is not removed like a CH send.
  await sendRow.locator(".toggle button").filter({ hasText: /^OFF$/ }).click();
  await expect(wires(page)).toHaveCount(FIXED);
});

test("a fixed MIX → STEREO (TO ST) switch exposes a TO ST toggle and no delete", async ({ page }) => {
  // MIX 1 → STEREO is fixed (block diagram); its inspector shows a TO ST ON/OFF
  // toggle (off at the factory) and no delete, and no level/pan (a sendSwitch).
  await page.locator('.wire-hit[data-from="bus.mix1:out"][data-to="bus.stereo:in"]').dispatchEvent("pointerdown");
  const toStRow = page.locator("#inspector .param", { hasText: "TO ST" });
  await expect(toStRow).toHaveCount(1);
  await expect(page.locator("#inspector .toggle")).toHaveCount(1); // only the TO ST switch
  await expect(page.locator("#inspector .param", { hasText: "Level" })).toHaveCount(0);
  await expect(page.locator("#inspector button.danger")).toHaveCount(0); // structural — no delete

  // Turning TO ST ON keeps the (fixed) wire — it is never added/removed.
  await toStRow.locator(".toggle button").filter({ hasText: /^ON$/ }).click();
  await expect(wires(page)).toHaveCount(FIXED);
});

test("a microSD Rec assign carries no level / pan / PRE-POST", async ({ page }) => {
  // SD Rec is a per-track-pair source select (record), not a summing send: a
  // channel pair / STEREO / MIX feeds one track-pair slot, with no mix params.
  await connect(page, "ch1:out", "out.sdrec.t1:in");
  await expect(wires(page)).toHaveCount(FIXED + 1);
  await page.locator('.wire-hit[data-from="ch1:out"][data-to="out.sdrec.t1:in"]').dispatchEvent("pointerdown");
  await expect(page.locator("#inspector .param")).toHaveCount(0);
  // A channel → SD Rec tap has no mix params; the hint explains it records at the
  // channel Rec Point (the direct-out advisory) rather than the generic note.
  await expect(page.locator("#inspector .hint")).toContainText("Rec Point");
});

test("the send pan slider uses the device L63 – C – R63 range", async ({ page }) => {
  await page.locator('.wire-hit[data-from="ch1:out"][data-to="bus.mix1:in"]').dispatchEvent("pointerdown");
  const pan = page.locator("#inspector .param", { hasText: "Pan" }).locator("input[type='range']");
  await expect(pan).toHaveAttribute("min", "-63");
  await expect(pan).toHaveAttribute("max", "63");
});

test("the send level slider bottoms out at -∞ (level_gain floor), not -60", async ({ page }) => {
  await page.locator('.wire-hit[data-from="ch1:out"][data-to="bus.mix1:in"]').dispatchEvent("pointerdown");
  const level = page.locator("#inspector .param", { hasText: "Level" }).locator("input[type='range']");
  // The slider walks the device's discrete level_gain grid by index: 0 = -∞ notch.
  await expect(level).toHaveAttribute("min", "0");
  await expect(level).toHaveAttribute("step", "1");
  // Dragging to the bottom reads -∞ dB; one step up is the lowest real value.
  await level.fill("0");
  await expect(page.locator("#inspector .param", { hasText: "Level" }).locator(".param-val")).toHaveText("-∞ dB");
});

test("the send level slider only offers detents the device can store", async ({ page }) => {
  await page.locator('.wire-hit[data-from="ch1:out"][data-to="bus.mix1:in"]').dispatchEvent("pointerdown");
  const level = page.locator("#inspector .param", { hasText: "Level" }).locator("input[type='range']");
  const readout = page.locator("#inspector .param", { hasText: "Level" }).locator(".param-val");
  // -15.0 dB does not exist on the grid; adjacent detents jump -16 -> -14.
  await level.fill("17");
  await expect(readout).toHaveText("-16.0 dB");
  await level.fill("18");
  await expect(readout).toHaveText("-14.0 dB");
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
