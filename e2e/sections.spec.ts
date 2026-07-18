import { test, expect, type Page } from "@playwright/test";

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);

// A collapsible inspector section located by its summary title.
const section = (page: Page, title: RegExp) =>
  page.locator("#inspector .insp-section", { has: page.locator("summary", { hasText: title }) });

// The section's own ON/OFF toggle is the first .param row of its body.
const sectionOnOff = (page: Page, title: RegExp) => section(page, title).locator(".sec-body > .param").first();

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.locator("#model-picker").waitFor();
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("a folded section survives a re-render and a reload", async ({ page }) => {
  await node(page, "ch1").click();

  const input = section(page, /^Input$/);
  await expect(input).toHaveJSProperty("open", true); // default open

  // Fold INPUT, then toggle EQ off — which re-renders the whole inspector.
  await input.locator("summary").click();
  await expect(input).toHaveJSProperty("open", false);
  await sectionOnOff(page, /^EQ$/).locator("button", { hasText: "OFF" }).click();

  // INPUT must stay folded across the re-render (the reported regression).
  await expect(section(page, /^Input$/)).toHaveJSProperty("open", false);

  // …and across a reload (localStorage persistence).
  await page.reload();
  await page.locator("#model-picker").waitFor();
  await node(page, "ch1").click();
  await expect(section(page, /^Input$/)).toHaveJSProperty("open", false);
});

test("EQ bands are tabs; the active band shows alone and survives a relayout", async ({ page }) => {
  await node(page, "ch1").click();

  // EQ is on (open) by default; four band tabs, one band's controls visible.
  const eq = section(page, /^EQ$/);
  await expect(eq.locator(".eq-tab")).toHaveCount(4);
  await expect(eq.locator(".eq-panel:not([hidden])")).toHaveCount(1);

  await eq.locator(".eq-tab", { hasText: "HIGH MID" }).click();
  await expect(eq.locator(".eq-tab.active")).toHaveText("HIGH MID");

  // Toggling the band off re-renders the inspector; the tab must stay on HIGH MID.
  await eq.locator(".eq-panel:not([hidden]) .param", { hasText: "Band" }).locator("button", { hasText: "OFF" }).click();
  await expect(section(page, /^EQ$/).locator(".eq-tab.active")).toHaveText("HIGH MID");
  await expect(section(page, /^EQ$/).locator(".eq-panel:not([hidden])")).toHaveCount(1);
});

test("OSC slider edits merge — a Frequency edit keeps a prior Level edit", async ({ page }) => {
  await node(page, "bus.osc").click();
  const param = (label: string) => page.locator("#inspector .param", { has: page.getByText(label, { exact: true }) });

  // Edit Level, then Frequency, without any re-render in between (sliders keep
  // focus, so only the plan is updated). The second edit must not revert the first.
  await param("Level").locator("input[type=range]").fill("-20");
  await expect(param("Level").locator(".param-val")).toHaveText("-20.0 dB");
  await param("Freq").locator("input[type=range]").fill("700");
  const freqText = await param("Freq").locator(".param-val").innerText();
  expect(freqText).not.toBe("1.00 kHz");

  // Re-select the node: both edits must have reached the plan.
  await node(page, "ch1").click();
  await node(page, "bus.osc").click();
  await expect(param("Level").locator(".param-val")).toHaveText("-20.0 dB");
  await expect(param("Freq").locator(".param-val")).toHaveText(freqText);
});

test("toggling a section value reverts its fold to follow the on-state", async ({ page }) => {
  await node(page, "ch1").click();

  // GATE defaults off → folded. Open it by hand; the fold persists.
  const gate = section(page, /^GATE$/);
  await expect(gate).toHaveJSProperty("open", false);
  await gate.locator("summary").click();
  await expect(gate).toHaveJSProperty("open", true);

  // Turning GATE on then off must drop the manual override, so an off GATE folds
  // again rather than staying open from the earlier hand-open.
  await sectionOnOff(page, /^GATE$/)
    .locator("button", { hasText: "ON" })
    .click();
  await expect(section(page, /^GATE$/)).toHaveJSProperty("open", true);
  await sectionOnOff(page, /^GATE$/)
    .locator("button", { hasText: "OFF" })
    .click();
  await expect(section(page, /^GATE$/)).toHaveJSProperty("open", false);
});
