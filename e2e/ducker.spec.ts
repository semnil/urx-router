import { test, expect, type Page } from "@playwright/test";

// A ducker is bypassed (duckerOn off) on a fresh board, so its key wire reads as
// an off send: dimmed and finely dotted. Turning the ducker on must update both
// the node faceplate and the key wire immediately, without a re-render trigger.
const DUCKER = "out.ducker1";
const KEY_FROM = "bus.mix1:out";
const KEY_TO = "out.ducker1:in";

const port = (page: Page, ref: string) => page.locator(`[data-ref="${ref}"]`);
const duckerNode = (page: Page) => page.locator(`#graph-host g.node[data-id="${DUCKER}"]`);
// The painted wire path lives beside the transparent .wire-hit band in the same g.
const keyWire = (page: Page) =>
  page.locator(`#graph-host g:has(> .wire-hit[data-from="${KEY_FROM}"][data-to="${KEY_TO}"]) path:not(.wire-hit)`);

async function connect(page: Page, fromRef: string, toRef: string): Promise<void> {
  const a = await port(page, fromRef).boundingBox();
  const b = await port(page, toRef).boundingBox();
  if (!a || !b) throw new Error(`port not found: ${fromRef} -> ${toRef}`);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}

// Select the ducker, expand its section and switch the on/off toggle.
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
    // Empty board: every ducker is bypassed and carries no key wire to start.
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("a bypassed ducker's key wire is dimmed and finely dotted", async ({ page }) => {
  await connect(page, KEY_FROM, KEY_TO);

  // Nothing is selected after a drag-connect, so the wire shows its resting style.
  await expect(keyWire(page)).toHaveAttribute("stroke-dasharray", "1.5 4");
  await expect(keyWire(page)).toHaveAttribute("opacity", "0.3");
});

test("turning a ducker on updates its node and key wire immediately", async ({ page }) => {
  await connect(page, KEY_FROM, KEY_TO);

  await duckerNode(page).click();
  // A bypassed ducker reads as inactive: the whole node is dimmed.
  await expect(duckerNode(page)).toHaveAttribute("opacity", "0.4");

  await setDuckerOn(page, true);

  // Still selected, no reload: the node faceplate clears its dimming at once.
  await expect(duckerNode(page)).not.toHaveAttribute("opacity", "0.4");

  // Deselect so the key wire shows its resting style, now solid (no longer off).
  await page.keyboard.press("Escape");
  await expect(keyWire(page)).toHaveAttribute("opacity", "0.85");
  expect(await keyWire(page).getAttribute("stroke-dasharray")).toBeNull();
});
