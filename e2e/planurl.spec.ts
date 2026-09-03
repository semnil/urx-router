import { test, expect, type Page } from "./fixtures";
import { planParam, planParamZ } from "./plan-param";
import { fxParams } from "../src/core/control/fx-effect";

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

// Two MONO IN channels claiming the one device-wide guitar-amp slot (Clean 256 /
// Crunch 257). The inspector cannot author this — insertFxMenu locks a slot another
// node holds — but a device readback runs no such check, so a plan saved from the
// unit can carry it. Warned rather than refused, so Fetch -> Save -> reopen works.
const slotConflictPlan = {
  format: "urx-router-plan",
  version: 1,
  modelId: "URX44V",
  connections: [],
  nodeParams: { ch1: { insertFx: 256 }, ch2: { insertFx: 257 } },
};

// A plan carrying BOTH kinds the loader answers differently: a slot collision, which is the
// operator's to decide, and an FX value outside what the app can write, which is repaired
// before the document opens. Together they are the only shape that reaches the report row for
// the second kind, and the only one that exercises the loader's claim that the repair applies
// even while a decision holds the load. raw 20 is one step below the delay LPF's window.
const conflictAndBoundedPlan = {
  format: "urx-router-plan",
  version: 2,
  modelId: "URX44V",
  connections: [],
  nodeParams: {
    ch1: { insertFx: 256 },
    ch2: { insertFx: 257 },
    "bus.fx2": { fxEffect: { type: 1024, params: { delayLpf: 20 } } },
  },
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

test("a compressed z ?plan= link loads the plan into the viewer", async ({ page }) => {
  await page.goto(`/?plan=${planParamZ(validPlan)}`);
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await expect(page.locator("#statusbar")).toContainText("Plan loaded");
  await expect(report(page)).toBeHidden();
});

test("a malformed compressed link reports a decode failure", async ({ page }) => {
  await page.goto("/?plan=z!!!not-deflate");
  await expect(report(page)).toBeVisible();
  await expect(page.locator("#load-report-body")).toContainText("malformed");
});

test("a browser without the deflate-raw codec reports unsupported, not malformed", async ({ page }) => {
  // Simulate an old webview (Safari <16.4 etc.): no DecompressionStream at all.
  await page.addInitScript(() => {
    Object.defineProperty(window, "DecompressionStream", { value: undefined });
  });
  await page.goto(`/?plan=${planParamZ(validPlan)}`);
  await expect(report(page)).toBeVisible();
  await expect(page.locator("#load-report-body")).toContainText("doesn't support compressed plan links");
});

test("an illegal plan surfaces a copyable report and does not load", async ({ page }) => {
  await page.goto(`/?plan=${planParam(illegalPlan)}`);
  await expect(report(page)).toBeVisible();
  // The report names the violation reason and the exact connection refs, so it
  // can be pasted back to the tool that generated the plan.
  const body = page.locator("#load-report-body");
  await expect(body).toContainText("URX Router plan validation failed");
  await expect(body).toContainText("problems: 1");
  await expect(body).toContainText("[noRule] ch1:out -> ch2:in");
  // The status line did not report a successful load.
  await expect(page.locator("#statusbar")).not.toContainText("Plan loaded");
  // A refusal carries no affordance that would act on it.
  await expect(page.locator("#load-report-proceed")).toHaveCount(0);
  // Closing dismisses the modal.
  await page.locator("#load-report-close").click();
  await expect(report(page)).toBeHidden();
});

test("an insert-FX slot conflict warns and loads on the operator's word", async ({ page }) => {
  await page.goto(`/?plan=${planParam(slotConflictPlan)}`);
  await expect(report(page)).toBeVisible();
  // Framed as a conflict to decide on, not as a failed load.
  await expect(page.locator("#load-report-title")).toHaveText("Plan has an insert-FX slot conflict");
  // …including in the copyable body, which is read away from that title.
  await expect(page.locator("#load-report-body")).toContainText("URX Router plan validation warnings");
  await expect(page.locator("#load-report-body")).toContainText("[insertFxSlot] amp: ch1, ch2");
  // Nothing has loaded while the decision is on screen.
  await expect(page.locator("#statusbar")).not.toContainText("Plan loaded");

  await page.locator("#load-report-proceed").click();
  // Proceeding dismisses the report first, then loads — with both claimants intact,
  // so the operator can resolve the conflict here rather than where it came from.
  await expect(report(page)).toBeHidden();
  await expect(page.locator("#statusbar")).toContainText("Plan loaded");
  await page.locator('#graph-host g.node[data-id="ch1"]').click();
  await expect(page.locator("#inspector .param", { hasText: "EFFECT TYPE" }).locator("select")).toHaveValue("256");
  await page.locator('#graph-host g.node[data-id="ch2"]').click();
  await expect(page.locator("#inspector .param", { hasText: "EFFECT TYPE" }).locator("select")).toHaveValue("257");
});

test("a repaired value is reported beside the conflict, and is repaired once the load runs", async ({ page }) => {
  await page.goto(`/?plan=${planParam(conflictAndBoundedPlan)}`);
  await expect(report(page)).toBeVisible();
  // Both kinds in the one copyable body, each in its own row: the operator reads this away
  // from the modal, and a row that named only the conflict would hide the rewrite entirely.
  await expect(page.locator("#load-report-body")).toContainText("[insertFxSlot] amp: ch1, ch2");
  await expect(page.locator("#load-report-body")).toContainText("[paramRange] bus.fx2.delayLpf: 20 -> 21");

  await page.locator("#load-report-proceed").click();
  await expect(report(page)).toBeHidden();
  await expect(page.locator("#statusbar")).toContainText("Plan loaded");
  // The repair survived the decision — the plan the operator agreed to open is the repaired
  // one, not the document as it arrived.
  await page.locator('#graph-host g.node[data-id="bus.fx2"]').click();
  // The BOUND raw's frequency, taken from the catalogue rather than written out: what this
  // asserts is that the row shows raw 21 and not the document's raw 20, and spelling the
  // label here would tie the case to how many digits the readout carries as well.
  const lpf = fxParams(1024).find((d) => d.key === "delayLpf")!;
  await expect(page.locator("#inspector .param", { hasText: "LPF" }).locator(".param-val")).toHaveText(
    lpf.format!(lpf.rawMin!, {}),
  );
  await expect(page.locator("#inspector .param", { hasText: "LPF" }).locator(".param-val")).not.toHaveText(
    lpf.format!(lpf.rawMin! - 1, {}),
  );
});

test("closing an insert-FX slot conflict report loads nothing", async ({ page }) => {
  await page.goto(`/?plan=${planParam(slotConflictPlan)}`);
  await expect(report(page)).toBeVisible();
  await page.locator("#load-report-close").click();
  await expect(report(page)).toBeHidden();
  await expect(page.locator("#statusbar")).not.toContainText("Plan loaded");
});

test("a malformed ?plan= link reports a decode failure", async ({ page }) => {
  await page.goto("/?plan=!!!not-base64");
  await expect(report(page)).toBeVisible();
  await expect(page.locator("#load-report-body")).toContainText("malformed");
});
