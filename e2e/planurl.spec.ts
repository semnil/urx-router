import { test, expect, type Page } from "@playwright/test";

// URL-safe base64 of a plan's JSON — the encoding the ?plan= deep link uses
// (matches encodePlanParam in core/plan.ts).
function planParam(plan: unknown): string {
  return Buffer.from(JSON.stringify(plan), "utf8").toString("base64url");
}

const validPlan = {
  format: "urx-router-plan",
  version: 1,
  modelId: "URX44V",
  connections: [],
};

// A channel out wired into another channel in: no routing rule exists, so the
// loader must reject it with a copyable report rather than loading.
const illegalPlan = {
  format: "urx-router-plan",
  version: 1,
  modelId: "URX44V",
  connections: [{ from: "ch1:out", to: "ch2:in", kind: "source" }],
};

const report = (page: Page) => page.locator("#load-report");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-seed", "empty");
  });
});

test("a valid ?plan= link loads the plan into the viewer", async ({ page }) => {
  await page.goto(`/?plan=${planParam(validPlan)}`);
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await expect(page.locator("#statusbar")).toContainText("Plan loaded");
  await expect(report(page)).toBeHidden();
});

test("an illegal plan surfaces a copyable report and does not load", async ({ page }) => {
  await page.goto(`/?plan=${planParam(illegalPlan)}`);
  await expect(report(page)).toBeVisible();
  // The report names the violation reason and the exact connection refs, so it
  // can be pasted back to the tool that generated the plan.
  const body = page.locator("#load-report-body");
  await expect(body).toContainText("problems: 1");
  await expect(body).toContainText("[noRule] ch1:out -> ch2:in");
  // The status line did not report a successful load.
  await expect(page.locator("#statusbar")).not.toContainText("Plan loaded");
  // Closing dismisses the modal.
  await page.locator("#load-report-close").click();
  await expect(report(page)).toBeHidden();
});

test("a malformed ?plan= link reports a decode failure", async ({ page }) => {
  await page.goto("/?plan=!!!not-base64");
  await expect(report(page)).toBeVisible();
  await expect(page.locator("#load-report-body")).toContainText("malformed");
});
