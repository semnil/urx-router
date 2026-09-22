import { test, expect, type Page } from "./fixtures";
import { planParam, planParamZ } from "./plan-param";
import { wire } from "./graph-helpers";
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
// even while a decision holds the load. raw 20 is one step below the delay LPF's window. It
// names no STREAMING source, so the completion of that receiver is repaired under the same
// decision.
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

// A USB output holding the two channels of a MONO IN pair — two ordinary patch wires,
// which is how a plan carries the unit's `CH 3/4`.
const monoPairPlan = {
  format: "urx-router-plan",
  version: 1,
  modelId: "URX44V",
  connections: [
    { from: "ch3:out", to: "out.usbmain_b:in", kind: "patch" },
    { from: "ch4:out", to: "out.usbmain_b:in", kind: "patch" },
  ],
};

// Two channels on a USB output that are not one pair (CH 2 is CH 1's partner, CH 3 is
// CH 4's): a selection the unit's list does not offer, so the loader refuses it.
const notAPairPlan = {
  format: "urx-router-plan",
  version: 1,
  modelId: "URX44V",
  connections: [
    { from: "ch2:out", to: "out.usbmain_b:in", kind: "patch" },
    { from: "ch3:out", to: "out.usbmain_b:in", kind: "patch" },
  ],
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

// STREAMING's list on the unit has no None, so a document naming no STREAMING source opens with
// the STEREO a new plan carries — drawn, since the next write sends it — and the status line
// says so ahead of the load, since the document did not name it.
test("a plan naming no STREAMING source opens with STEREO on it, and says so", async ({ page }) => {
  await page.goto(`/?plan=${planParam(validPlan)}`);
  await expect(page.locator("#statusbar")).toHaveText(
    "The plan named no STREAMING source, so STREAMING takes STEREO — Plan loaded",
  );
  await expect(report(page)).toBeHidden();
  await expect(wire(page, "bus.stereo:out", "bus.stream:in")).toHaveCount(1);
});

test("a plan naming its STREAMING source opens with that one, and says nothing about it", async ({ page }) => {
  const plan = { ...validPlan, connections: [{ from: "bus.mix2:out", to: "bus.stream:in", kind: "source" }] };
  await page.goto(`/?plan=${planParam(plan)}`);
  await expect(page.locator("#statusbar")).toHaveText("Plan loaded");
  await expect(wire(page, "bus.mix2:out", "bus.stream:in")).toHaveCount(1);
  await expect(wire(page, "bus.stereo:out", "bus.stream:in")).toHaveCount(0);
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

test("a USB output holding a MONO IN pair's two channels loads with both wires drawn", async ({ page }) => {
  await page.goto(`/?plan=${planParam(monoPairPlan)}`);
  await expect(page.locator("#statusbar")).toContainText("Plan loaded");
  await expect(report(page)).toBeHidden();
  await expect(wire(page, "ch3:out", "out.usbmain_b:in")).toHaveCount(1);
  await expect(wire(page, "ch4:out", "out.usbmain_b:in")).toHaveCount(1);
});

test("a USB output holding two channels of different pairs is refused, naming both wires", async ({ page }) => {
  await page.goto(`/?plan=${planParam(notAPairPlan)}`);
  await expect(report(page)).toBeVisible();
  // Every wire into that output is named, since neither alone is the one at fault.
  const body = page.locator("#load-report-body");
  await expect(body).toContainText("URX Router plan validation failed");
  await expect(body).toContainText("problems: 2");
  await expect(body).toContainText("[monoPairOnly] ch2:out -> out.usbmain_b:in");
  await expect(body).toContainText("[monoPairOnly] ch3:out -> out.usbmain_b:in");
  await expect(page.locator("#statusbar")).not.toContainText("Plan loaded");
  await expect(page.locator("#load-report-proceed")).toHaveCount(0);
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
  // The document names no STREAMING source either, and that completion is a row of its own.
  await expect(page.locator("#load-report-body")).toContainText("[requiredSource] bus.stereo:out -> bus.stream:in");

  await page.locator("#load-report-proceed").click();
  await expect(report(page)).toBeHidden();
  await expect(page.locator("#statusbar")).toHaveText(
    "1 stored value was outside what this app can write, and now read as the nearest value it can send — " +
      "The plan named no STREAMING source, so STREAMING takes STEREO — Plan loaded",
  );
  // Both repairs survived the decision — the plan the operator agreed to open is the repaired
  // one, not the document as it arrived.
  await expect(wire(page, "bus.stereo:out", "bus.stream:in")).toHaveCount(1);
  await page.locator('#graph-host g.node[data-id="bus.fx2"]').click();
  // Read off the FX tuning screen, which is where the effect's parameters are drawn. The
  // section's open state is one the Inspector remembers, so it is opened before the launcher
  // inside it is pressed.
  const sec = page.locator("#inspector .insp-section", { has: page.locator("summary", { hasText: "FX Effect" }) });
  if (!(await sec.evaluate((el) => (el as HTMLDetailsElement).open))) await sec.locator("summary").click();
  await sec.locator("#btn-fx-screen").click();
  const value = page
    .locator("#dyn-screen-box .gt-knob")
    .filter({ has: page.getByText("LPF", { exact: true }) })
    .locator(".gt-val");
  // The BOUND raw's frequency, taken from the catalogue rather than written out: what this
  // asserts is that the row shows raw 21 and not the document's raw 20, and spelling the
  // label here would tie the case to how many digits the readout carries as well.
  const lpf = fxParams(1024).find((d) => d.key === "delayLpf")!;
  await expect(value).toHaveText(lpf.format!(lpf.rawMin!, {}));
  await expect(value).not.toHaveText(lpf.format!(lpf.rawMin! - 1, {}));
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
