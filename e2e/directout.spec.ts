import { test, expect, type Page } from "@playwright/test";

// A channel wired straight to a USB / SD direct out is tapped at its Rec Point,
// upstream of the fader and Ducker. The inspector explains that on the wire
// (candidate B), and a top-of-panel warning fires when the same channel's Ducker
// is on so the duck is silently dropped from the direct out (candidate A).
const CH_OUT = "ch_5_6:out";
const USB_B_IN = "out.usbmain_b:in";
const SD_T1_IN = "out.sdrec.t1:in";
const DUCKER = "out.ducker1"; // hung on CH 5/6

const port = (page: Page, ref: string) => page.locator(`[data-ref="${ref}"]`);
const duckerNode = (page: Page) => page.locator(`#graph-host g.node[data-id="${DUCKER}"]`);

async function connect(page: Page, fromRef: string, toRef: string): Promise<void> {
  const a = await port(page, fromRef).boundingBox();
  const b = await port(page, toRef).boundingBox();
  if (!a || !b) throw new Error(`port not found: ${fromRef} -> ${toRef}`);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}

// dispatchEvent bypasses the overlapping wire-hit bands' pointer interception.
async function selectWire(page: Page, from: string, to: string): Promise<void> {
  await page.locator(`.wire-hit[data-from="${from}"][data-to="${to}"]`).dispatchEvent("pointerdown");
}

async function setDuckerOn(page: Page, on: boolean): Promise<void> {
  await duckerNode(page).click();
  const section = page
    .locator("#inspector details.insp-section")
    .filter({ has: page.locator('summary:has-text("Ducker")') });
  await section.locator("summary").click();
  await section.getByRole("button", { name: on ? "ON" : "OFF", exact: true }).click();
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

test("a channel-sourced USB direct out explains it is a pre-Ducker tap", async ({ page }) => {
  await connect(page, CH_OUT, USB_B_IN);
  await selectWire(page, CH_OUT, USB_B_IN);

  await expect(page.locator("#inspector .hint", { hasText: "Direct out" })).toHaveCount(1);
  await expect(page.locator("#inspector .hint", { hasText: "Rec Point" })).toHaveCount(1);
  // The generic "no parameters" note is replaced by the direct-out explanation.
  await expect(page.locator("#inspector .hint", { hasText: "Selection only" })).toHaveCount(0);
});

test("turning the ducker on warns that the direct out drops the duck", async ({ page }) => {
  await connect(page, CH_OUT, USB_B_IN);

  // No conflict yet: the ducker is bypassed on a fresh board.
  await selectWire(page, CH_OUT, USB_B_IN);
  await expect(page.locator("#inspector .warning-title", { hasText: "Ducker not on direct out" })).toHaveCount(0);

  await setDuckerOn(page, true);

  // The warning names the affected channel and is visible whatever is selected.
  const warn = page.locator("#inspector .warning", { hasText: "Ducker not on direct out" });
  await expect(warn).toHaveCount(1);
  await expect(warn).toContainText("CH 5/6");
});

test("a microSD Rec tap gets a neutral note, not the bus-reroute advice", async ({ page }) => {
  await connect(page, CH_OUT, SD_T1_IN);
  await selectWire(page, CH_OUT, SD_T1_IN);

  // Recording the dry Rec Point tap is intentional: point at Rec Point, don't push
  // a STEREO / MIX bus reroute (that phrasing belongs to the USB direct out).
  const note = page.locator("#inspector .hint", { hasText: "Rec Point" });
  await expect(note).toHaveCount(1);
  await expect(page.locator("#inspector .hint", { hasText: "Route via" })).toHaveCount(0);
});

test("a ducked channel recording to microSD raises no warning", async ({ page }) => {
  await connect(page, CH_OUT, SD_T1_IN);
  await setDuckerOn(page, true);

  // microSD Rec is excluded from the ducker-bypass warning (dry record is a valid
  // workflow), so turning the ducker on must not raise it.
  await expect(page.locator("#inspector .warning-title", { hasText: "Ducker not on direct out" })).toHaveCount(0);
});

test("a channel-sourced ducker key explains it is a pre-fader tap", async ({ page }) => {
  // A channel key is the CH OUT (Rec Point) tap, so the source channel's fader /
  // mute do not move the trigger — the inspector says so on the wire.
  await connect(page, "ch1:out", "out.ducker1:in");
  await selectWire(page, "ch1:out", "out.ducker1:in");
  await expect(page.locator("#inspector .hint", { hasText: "Ducker key" })).toHaveCount(1);
  await expect(page.locator("#inspector .hint", { hasText: "Selection only" })).toHaveCount(0);
});

test("a bus-sourced ducker key gets no pre-fader note (it is post-fader)", async ({ page }) => {
  await connect(page, "bus.stereo:out", "out.ducker1:in");
  await selectWire(page, "bus.stereo:out", "out.ducker1:in");
  await expect(page.locator("#inspector .hint", { hasText: "Ducker key" })).toHaveCount(0);
  await expect(page.locator("#inspector .hint", { hasText: "Selection only" })).toHaveCount(1);
});

test("a PRE send from a ducked channel is flagged next to the fixed-connection note", async ({ page }) => {
  // ch_5_6 → MIX 1 is a fixed send with a Pre/Post tap; its ducker is out.ducker1.
  await setDuckerOn(page, true);
  await selectWire(page, "ch_5_6:out", "bus.mix1:in");

  // POST by default → post-fader → post-Ducker → ducked, so no note.
  const preSendNote = () => page.locator("#inspector .hint", { hasText: "not ducked" });
  await expect(preSendNote()).toHaveCount(0);

  // Switching to PRE taps ahead of the (post-fader) Ducker → not ducked.
  await page
    .locator("#inspector .param", { hasText: "Pre/Post" })
    .getByRole("button", { name: "PRE", exact: true })
    .click();
  await expect(preSendNote()).toHaveCount(1);
});
