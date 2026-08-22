import { expect, type Locator, type Page } from "@playwright/test";

// The locators, addresses and DOM-reading waits every race case reaches the app through. They encode how
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
/** An inspector row whose label CONTAINS `label`. */
export const param = (page: Page, label: string): Locator => page.locator("#inspector .param", { hasText: label });

/** An inspector row whose label is EXACTLY `label` — "Insert FX" must not match
 *  "Insert FX ON", which is a different row with a different address. */
export const paramExact = (page: Page, label: string): Locator =>
  page.locator("#inspector .param", { has: page.getByText(label, { exact: true }) });

export const readoutOf = (stripLoc: Locator): Locator => stripLoc.locator(".con-readout .rd:not(.mtr) .rv");

export const faderReadout = (page: Page, name: string): Locator => readoutOf(strip(page, name));

export const faderOf = (page: Page, name: string): Locator => strip(page, name).locator(".con-fader");

/** Select a node and open one of its tuning screens from the inspector. `section` names
 *  the inspector section the launcher sits in and `button` the launcher's own id — the two
 *  differ for the morphing bank, whose COMP and EQ faces open from the same sections the
 *  COMP->EQ bank's screens open from. */
export async function openDynScreen(page: Page, id: string, section: RegExp, button: string): Promise<void> {
  await graphNode(page, id).click();
  const sec = page.locator("#inspector .insp-section", { has: page.locator("summary", { hasText: section }) });
  if (!(await sec.evaluate((el) => (el as HTMLDetailsElement).open))) await sec.locator("summary").click();
  await sec.locator(`#${button}`).click();
  await expect(page.locator("#dyn-screen-box")).toBeVisible();
}

/** Select a node and open its EQ tuning screen from the inspector. */
export const openEqScreen = (page: Page, id: string): Promise<void> => openDynScreen(page, id, /^EQ$/, "btn-eq-screen");

/** Select a node and open the morphing strip's MAIN face, where its preset and the three
 *  morphing sliders are. */
export const openSsmcsScreen = (page: Page, id: string): Promise<void> =>
  openDynScreen(page, id, /^SSMCS$/, "btn-ssmcs-screen");

/** A tuning screen's row, by the exact label it prints. */
export const screenRow = (page: Page, label: string): Locator =>
  page.locator("#dyn-screen-box .prefs-row").filter({ has: page.getByText(label, { exact: true }) });

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

/** What `settleValue` observed. Times are ms from the call, `-1` when it never happened. */
export interface SettledValue {
  /** `aria-valuenow` as it read once it stopped moving (null = the element has none). */
  value: string | null;
  /** When the value first differed from `from`. -1 if it never moved. */
  changedAt: number;
  /** When it had held one value for the whole stillness window. -1 if it never settled. */
  settledAt: number;
}

/**
 * Wait for an `aria-valuenow` to move off `from` and then STOP moving, and report when —
 * the measurement a fixed sleep cannot make.
 *
 * A fixed `waitForTimeout` states a guess about how long a repaint takes and then reads
 * whatever is there; under load it reads the wrong thing and the case fails naming the
 * app. Polling until the value equals what the case is about to assert is the opposite
 * error and worse, because it always passes: waiting for 5 and then asserting 5 is not a
 * check. Waiting for STILLNESS keeps the assertion honest — what settled is whatever the
 * app settled on, and the case still says what that must be.
 *
 * `from` is passed in rather than sampled here: a repaint that lands between the call and
 * the first sample would otherwise read as "never changed" and burn the whole cap.
 * `still × step` has to exceed the repaint's own coalescing period (`REFLECT_MIN_MS` = 50
 * ms in src/main.ts), or the settle succeeds inside the gap between two reflects and
 * reports a value that was still moving.
 *
 * Polls the LOCATOR, not an element handle: a follow repaint replaces the strip, so the
 * element the value arrives on is not the one it left.
 */
export async function settleValue(
  target: Locator,
  from: string | null,
  { step = 10, still = 6, cap = 1000 }: { step?: number; still?: number; cap?: number } = {},
): Promise<SettledValue> {
  const t0 = Date.now();
  let last = from;
  let stable = 0;
  let changedAt = -1;
  for (;;) {
    const now = await target.getAttribute("aria-valuenow");
    if (now !== last) {
      last = now;
      stable = 0;
      if (changedAt < 0 && now !== from) changedAt = Date.now() - t0;
    } else if (changedAt >= 0) {
      // Stillness only counts once it is standing on something other than the baseline:
      // a value that has not moved yet is not "settled", it is "not started". `last`
      // only ever leaves `from` through the branch above, which sets changedAt in the
      // same step — so this one test is the whole condition.
      stable++;
    }
    if (stable >= still) return { value: last, changedAt, settledAt: Date.now() - t0 };
    if (Date.now() - t0 >= cap) return { value: last, changedAt, settledAt: -1 };
    await target.page().waitForTimeout(step);
  }
}
