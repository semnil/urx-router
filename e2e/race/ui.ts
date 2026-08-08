import { expect, type Locator, type Page } from "@playwright/test";

// The locators and addresses every race case reaches the app through. They encode how
// src/ui/graph.ts and src/ui/console.ts build their markup, and which broker address a
// named control sits at, so a change to either is answered here instead of in every
// spec that touches it. Each spec's Tauri stub setup deliberately stays in the spec
// (see fake-device.ts) — only the reading surface is shared.

/** A node's group on the canvas, addressed by its plan id. */
export const graphNode = (page: Page, id: string): Locator => page.locator(`#graph-host g.node[data-id="${id}"]`);

/** A CONSOLE strip, addressed by the scribble name it prints. */
export const strip = (page: Page, name: string): Locator =>
  page.locator(".con-strip", { has: page.getByText(name, { exact: true }) });

/** A strip's level readout — the numeric one, not the meter's. */
export const readoutOf = (stripLoc: Locator): Locator => stripLoc.locator(".con-readout .rd:not(.mtr) .rv");

export const faderReadout = (page: Page, name: string): Locator => readoutOf(strip(page, name));

export const faderOf = (page: Page, name: string): Locator => strip(page, name).locator(".con-fader");

/** Select a node and open its EQ tuning screen from the inspector. */
export async function openEqScreen(page: Page, id: string): Promise<void> {
  await graphNode(page, id).click();
  const sec = page.locator("#inspector .insp-section", { has: page.locator("summary", { hasText: /^EQ$/ }) });
  if (!(await sec.evaluate((el) => (el as HTMLDetailsElement).open))) await sec.locator("summary").click();
  await sec.locator("#btn-eq-screen").click();
  await expect(page.locator("#dyn-screen-box")).toBeVisible();
}

/** CH_FADER, mono channel block, y = input index. */
export const CH1_FADER = "139:0:0";
export const CH2_FADER = "139:0:1";

/** CH_PAN on the first mono channel, in both shapes a case needs: the address a write is
 *  matched by, and the tuple a notify is pushed as. translate.ts emits it directly behind
 *  CH_FADER on the same node, which is what puts it one command ahead of a send loop held
 *  at that fader. */
export const CH1_PAN: [number, number, number] = [141, 0, 0];
export const CH1_PAN_ADDR = CH1_PAN.join(":");

/** HPF_FREQ on the first mono channel, as a notify tuple. */
export const CH1_HPF_FREQ: [number, number, number] = [26, 0, 0];

/** The fake's stored raw value rendered the way the console renders the plan's
 *  (src/ui/console.ts fmtDb over src/core/control/vd.ts vdToLevel), so "the screen shows
 *  what the device holds" is one string comparison.
 *
 *  Restated rather than imported, and it is not a choice: `src/core/control/vd.ts` and
 *  `src/core/plan.ts` are both inside a module cycle (plan -> control/insert-fx-effect
 *  -> translate -> vd -> plan) that only resolves when the app's own entry point orders
 *  it. Importing either from here — and this module is the first thing every race spec
 *  loads — enters that cycle at the wrong end and the whole project fails to collect
 *  with `Cannot access 'GATE_RANGE_OFF_DB' before initialization`. The src imports the
 *  harness DOES have (`core/levels`, `core/plan-history`) are leaves. The cost is that
 *  the sentinel and the scale are stated twice; the clamp deliberately is not, since
 *  nothing here feeds the fake a level outside the plan's range. */
export function deviceLevelText(raw: number | undefined): string {
  const v = raw ?? 0;
  if (v <= -32768) return "-∞";
  const db = v / 100;
  return (db > 0 ? "+" : "") + db.toFixed(1);
}
