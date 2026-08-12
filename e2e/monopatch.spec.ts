import { test, expect, type Page } from "./fixtures";
import { drag, faceplate, port, selectWire, wire } from "./graph-helpers";

// MAIN / LINE OUT have no MONO control of their own — the device puts [MONO] on the
// MONITOR buses — so whether an analog output can be switched to mono is decided by
// what it is patched from. The panel states that as a standing row on the output and
// as a note on the patch wire. Nothing here is a warning: a STEREO patch on MAIN OUT
// is the factory arrangement, so there is no state to flag, only one to report.
const MAIN = "out.main";
const MAIN_IN = "out.main:in";
const STEREO_OUT = "bus.stereo:out";
const MON1_OUT = "bus.mon1:out";

const monoRow = (page: Page) =>
  page.locator("#inspector .field").filter({ has: page.locator('.field-key:text-is("MONO")') });

const monoValue = (page: Page) => monoRow(page).locator(".field-val");

const connect = (page: Page, fromRef: string, toRef: string): Promise<void> =>
  drag(page, port(page, fromRef), port(page, toRef));

async function deleteWire(page: Page, from: string, to: string): Promise<void> {
  await selectWire(page, from, to);
  await page.locator("#inspector button.danger").click();
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

test("an unpatched MAIN OUT already says where mono would come from", async ({ page }) => {
  // The case a note on a wire could never reach: there is no wire yet.
  await faceplate(page, MAIN).click();
  await expect(monoValue(page)).toHaveText("Unavailable — via MONITOR");
  await expect(page.locator("#inspector .hint", { hasText: "Only MONITOR 1 / 2 carry MONO" })).toHaveCount(1);
});

test("a STEREO patch reports no mono, on the output and on the wire", async ({ page }) => {
  await connect(page, STEREO_OUT, MAIN_IN);

  await faceplate(page, MAIN).click();
  await expect(monoValue(page)).toHaveText("Unavailable — via MONITOR");

  await selectWire(page, STEREO_OUT, MAIN_IN);
  await expect(page.locator("#inspector .hint", { hasText: "Only MONITOR 1 / 2 carry MONO" })).toHaveCount(1);
  // The mono note replaces the generic one rather than joining it.
  await expect(page.locator("#inspector .hint", { hasText: "Selection only" })).toHaveCount(0);
});

test("patching from a MONITOR names the bus that owns the switch", async ({ page }) => {
  await connect(page, MON1_OUT, MAIN_IN);

  await faceplate(page, MAIN).click();
  await expect(monoValue(page)).toHaveText("OFF, from MONITOR 1");
  // With the switch in reach, the way-out note has nothing left to say.
  await expect(page.locator("#inspector .hint", { hasText: "Only MONITOR 1 / 2 carry MONO" })).toHaveCount(0);

  await selectWire(page, MON1_OUT, MAIN_IN);
  // Full text, not the leading clause. The note grew a second sentence (CUE Interrupt
  // is on the same path) and a hasText match on the first one would not have noticed
  // it appearing — or disappearing again.
  await expect(page.locator("#inspector .hint").filter({ hasText: "MONITOR bus's MONO switch" })).toHaveText(
    "This output follows the MONITOR bus's MONO switch — set it on the MONITOR node. CUE Interrupt is on " +
      "the same path, so while it is on, engaging CUE replaces what this output carries.",
  );
});

test("the row follows the monitor's MONO switch", async ({ page }) => {
  await connect(page, MON1_OUT, MAIN_IN);

  await faceplate(page, "bus.mon1").click();
  await page.locator('#inspector .param[data-param-label="MONO"]').getByRole("button", { name: "ON" }).click();

  await faceplate(page, MAIN).click();
  await expect(monoValue(page)).toHaveText("ON, from MONITOR 1");
});

test("rewiring the output changes what the row reports", async ({ page }) => {
  await connect(page, STEREO_OUT, MAIN_IN);
  await faceplate(page, MAIN).click();
  await expect(monoValue(page)).toHaveText("Unavailable — via MONITOR");

  await deleteWire(page, STEREO_OUT, MAIN_IN);
  await connect(page, MON1_OUT, MAIN_IN);

  await faceplate(page, MAIN).click();
  await expect(monoValue(page)).toHaveText("OFF, from MONITOR 1");
});

test("the hover note on the patch wire matches the selected one", async ({ page }) => {
  // Touch has no hover, so the two carriers have to say the same sentence — one
  // classifier feeds both. Read the panel's hint and compare the title against
  // THAT, rather than against a literal: a literal on each side is two copies of
  // one string and passes even when the two carriers have drifted apart, which is
  // exactly what this case claims to catch.
  await connect(page, STEREO_OUT, MAIN_IN);
  await selectWire(page, STEREO_OUT, MAIN_IN);
  const hint = await page.locator("#inspector .hint", { hasText: "MONITOR" }).innerText();
  expect(hint).toContain("Only MONITOR 1 / 2 carry MONO"); // the panel says what this test is about
  await expect(wire(page, STEREO_OUT, MAIN_IN).locator("title")).toHaveText(hint);
});

test("a USB output gets no MONO row", async ({ page }) => {
  // Scope: the row belongs where a routing change can remove the lock. USB outputs
  // cannot take a MONITOR source at all, so a standing note there would be a lock
  // nothing can unlock.
  await faceplate(page, "out.usbmain_a").click();
  await expect(monoRow(page)).toHaveCount(0);
});
