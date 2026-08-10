import { test, expect, type Page } from "./fixtures";

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const section = (page: Page, title: RegExp) =>
  page.locator("#inspector .insp-section", { has: page.locator("summary", { hasText: title }) });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.locator("#model-picker").waitFor();
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

// The GATE detail sliders live in the dynamics tuning screen now, so the notch is
// asserted where it is actually edited. The inspector's GATE section keeps only
// the ON toggle and the launcher.
test("GATE range has a -∞ notch one step below the -72 dB floor", async ({ page }) => {
  await node(page, "ch1").click();
  const gate = section(page, /^GATE$/);
  await gate.locator("summary").click(); // GATE folds off by default
  await gate.locator("#btn-gate-screen").click();

  const range = page.locator("#dyn-screen-box .prefs-row", { hasText: "Range" });
  const slider = range.locator("input[type=range]");
  await expect(slider).toHaveAttribute("min", "-73"); // -73 = the -∞ notch
  await slider.fill("-73");
  await expect(range.locator(".gt-val")).toHaveText("-∞ dB");
  await slider.fill("-72");
  await expect(range.locator(".gt-val")).toHaveText("-72.0 dB"); // deepest finite step
});

test("the inspector's GATE section keeps the toggle and the launcher only", async ({ page }) => {
  await node(page, "ch1").click();
  const gate = section(page, /^GATE$/);
  await gate.locator("summary").click();
  // One .param row: the ON/OFF toggle. The five detail sliders moved to the screen.
  await expect(gate.locator(".sec-body > .param")).toHaveCount(1);
  await expect(gate.locator("input[type=range]")).toHaveCount(0);
  await expect(gate.locator("#btn-gate-screen")).toHaveCount(1);
});

test("the inspector's COMP section is the ON toggle and the launcher", async ({ page }) => {
  // The detail editor moved to the dynamics screen for the same reason the gate's
  // did — a second copy here reads a render-time snapshot and would write stale
  // values back. What 1-Knob and Auto Makeup do to those controls is pinned there
  // (e2e/dyntuning.spec.ts), where they are.
  await node(page, "ch1").click();
  const comp = section(page, /^COMP$/);
  await comp.locator("summary").click(); // COMP folds off by default
  await expect(comp.locator(".sec-body > .param")).toHaveCount(1);
  await expect(comp.locator("input[type=range]")).toHaveCount(0);
  await expect(comp.locator("#btn-comp-screen")).toHaveCount(1);
});
