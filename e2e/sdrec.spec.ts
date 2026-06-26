import { test, expect, type Page } from "@playwright/test";

// microSD Rec track-pair slots hang in a chain under the SD Rec header; Track Count
// (read-only on the device) gates how many are shown. Uses the default factory
// board so the seeded per-pair record wires are present.
const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const param = (page: Page, label: string) => page.locator("#inspector .param", { hasText: label });
const trackCount = (page: Page) => param(page, "Track Count").locator("select");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("Track Count gates how many SD Rec track-pair slots are shown", async ({ page }) => {
  // Factory Track Count 8 → 4 pairs (t1..t4) shown, t5..t8 hidden.
  await expect(node(page, "out.sdrec.t4")).toBeVisible();
  await expect(node(page, "out.sdrec.t5")).toHaveCount(0);

  await node(page, "out.sdrec").click();
  await expect(trackCount(page)).toHaveValue("8");
  await expect(trackCount(page).locator("option")).toHaveText(["2", "4", "6", "8", "10", "12", "14", "16"]);

  await trackCount(page).selectOption("16");
  await expect(node(page, "out.sdrec.t8")).toBeVisible();

  await trackCount(page).selectOption("4");
  await expect(node(page, "out.sdrec.t2")).toBeVisible();
  await expect(node(page, "out.sdrec.t3")).toHaveCount(0);
});

test("the SD Rec header shows no input connector and no routing list", async ({ page }) => {
  // The recorder header owns its track slots; it takes no direct wire, so its port
  // connector is not drawn and the inspector shows no routing list — only Track Count.
  await expect(node(page, "out.sdrec").locator(".port")).toHaveCount(0);
  await node(page, "out.sdrec").click();
  await expect(param(page, "Track Count")).toHaveCount(1);
  await expect(page.locator("#inspector").getByText("Routing", { exact: true })).toHaveCount(0);
});

test("a track slot can be shelved and restored via its chip, like a ducker", async ({ page }) => {
  // A Track-Count-inactive slot is hidden but gets NO chip (gated, not shelved), so
  // the shelf stays empty on a fresh board.
  await expect(page.locator(".hidden-shelf")).toBeHidden();
  // A slot the user shelves by hand DOES get a chip and is restorable — matching
  // the ducker nodes (it is not gated away, so it must be recoverable).
  await node(page, "out.sdrec.t4").click();
  await page.locator("#inspector button.subtle").click(); // Hide this node
  await expect(node(page, "out.sdrec.t4")).toHaveCount(0);
  const chip = page.locator(".hidden-shelf .chip", { hasText: "Track 7/8" });
  await expect(chip).toHaveCount(1);
  await chip.click();
  await expect(node(page, "out.sdrec.t4")).toBeVisible();
});

test("a track-pair slot records its factory source as a no-param record assign", async ({ page }) => {
  // Factory: track pair 1/2 records CH1/2 from the CH1 primary node — a record
  // source select (no level / pan / PRE-POST, unlike a bus send).
  await page.locator('.wire-hit[data-from="ch1:out"][data-to="out.sdrec.t1:in"]').dispatchEvent("pointerdown");
  await expect(page.locator("#inspector")).toContainText("SD Rec source select");
  await expect(page.locator("#inspector .param")).toHaveCount(0);
});
