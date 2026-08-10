import { expect, test } from "./fixtures";
import { LIVE_COMMANDS, linkLogOf, stubTauriDevice } from "./tauri-stub";
import { LINK_BAR_KEYS, LINK_LEDGER_KEYS, type LinkBarKey, type LinkLedgerKey } from "../src/core/control/link-stats";

// The link ledger's readout (status bar, experimental builds).
//
// COVERAGE IS HELD BY THE TYPE SYSTEM, NOT BY DISCIPLINE. The two expectation tables
// below are `Record<LinkBarKey, …>` / `Record<LinkLedgerKey, …>` over the key unions
// the view itself iterates, so a cell or a row added without an expectation here is a
// `pnpm typecheck:e2e` failure rather than a value nobody ever looked at. Adding a key
// and adding its assertion are one edit.

// A ledger with a distinct value per field, so no assertion can pass by matching the
// wrong one — every displayed figure below is a different number.
const STATS = {
  sets: 40,
  gets: 5,
  param_subscribes: 2,
  meter_subscribes: 7,
  regist_frames: 300,
  unregist_frames: 20,
  deadlines: 6,
  stalled: 1,
};

const LOG_PATH = "/tmp/urx-router/link-ledger.jsonl";

// What each status-bar cell prints, given STATS — label and figure together, because
// the bar borrows the panel's row labels and a cell that printed the right number under
// the wrong word is the defect this table exists to catch. `up` is a clock the test
// cannot pin to a value, so its figure is matched by shape.
const BAR: Record<LinkBarKey, RegExp> = {
  up: /^Link up\s*\d+:[0-5]\d:[0-5]\d$/,
  noanswer: /^No answer\s*6$/,
};

// What each ledger row prints: its label, its figure, and its breakdown.
const ROWS: Record<LinkLedgerKey, RegExp> = {
  up: /Link up\s*\d+:[0-5]\d:[0-5]\d/,
  sent: /Sent\s*45\s*40 set · 5 get/,
  subscriptions: /Subscriptions\s*9\s*2 params · 7 meters/,
  frames: /Registration frames\s*320\s*300 regist · 20 unregist/,
  reads: /Full reads\s*1/,
  noanswer: /No answer\s*6\s*1\/3 to cutoff/,
  log: new RegExp(`Log\\s*${LOG_PATH}`),
};

async function liveWithLedger(page: import("@playwright/test").Page): Promise<void> {
  await stubTauriDevice(page, {
    commands: {
      experimental_enabled: true,
      ...LIVE_COMMANDS,
      vd_link_stats: STATS,
      append_link_log: LOG_PATH,
    },
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true");
}

test("every status-bar cell prints its own figure while live", async ({ page }) => {
  await liveWithLedger(page);
  await expect(page.locator("#link-stats")).toBeVisible();
  for (const key of LINK_BAR_KEYS) {
    const cell = page.locator(`[data-link-cell="${key}"]`);
    await expect(cell, `the ${key} cell`).toHaveText(BAR[key]);
  }
  // The bar is a SUBSET of the ledger and stays one: a row promoted to the bar without
  // a decision fails here rather than quietly widening the strip.
  await expect(page.locator("[data-link-cell]")).toHaveCount(LINK_BAR_KEYS.length);
});

test("the bar prints the panel's own words for the rows it carries", async ({ page }) => {
  await liveWithLedger(page);
  const barLabels = await page.locator("[data-link-label]").allTextContents();
  await page.click(".linkbar-open");
  await expect(page.locator(".linkbar-pop")).toBeVisible();
  // Each bar label is the label of the ledger row with the same key — one vocabulary
  // across the two surfaces, so no reader has to work out that two words are one number.
  for (const key of LINK_BAR_KEYS) {
    const rowLabel = await page.locator(`[data-ledger-row="${key}"] .k`).textContent();
    expect(barLabels, `the ${key} cell's label`).toContain(rowLabel);
  }
});

test("the status message and the readout share the bar without displacing each other", async ({ page }) => {
  await liveWithLedger(page);
  // The message the session put on the bar is still there with the readout beside it:
  // the readout is a sibling of the message span, not a replacement for the bar.
  await expect(page.locator("#statusbar")).toContainText("Live sync on");
  await expect(page.locator("#link-stats")).toBeVisible();
  const msg = await page.locator("#statusbar").boundingBox();
  const stats = await page.locator("#link-stats").boundingBox();
  expect(msg && stats).toBeTruthy();
  // Right of the message, and inside the window.
  expect(stats!.x).toBeGreaterThan(msg!.x);
  expect(stats!.x + stats!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  // Still one line: the bar did not grow a second row under the readout.
  const bar = await page.locator("#statusbar").boundingBox();
  expect(bar!.height).toBeLessThan(40);
});

test("the ledger panel prints every row, with its breakdown", async ({ page }) => {
  await liveWithLedger(page);
  await page.click(".linkbar-open");
  const pop = page.locator(".linkbar-pop");
  await expect(pop).toBeVisible();
  await expect(pop).toContainText("Device Center link");
  for (const key of LINK_LEDGER_KEYS) {
    const row = pop.locator(`[data-ledger-row="${key}"]`);
    await expect(row, `the ${key} row`).toHaveText(ROWS[key]);
  }
});

test("the panel closes on Escape and the readout says so", async ({ page }) => {
  await liveWithLedger(page);
  await page.click(".linkbar-open");
  await expect(page.locator(".linkbar-pop")).toBeVisible();
  await expect(page.locator(".linkbar-open")).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator(".linkbar-pop")).toHaveCount(0);
  await expect(page.locator(".linkbar-open")).toHaveAttribute("aria-expanded", "false");
});

test("copying the ledger reports on the status line", async ({ page }) => {
  await liveWithLedger(page);
  // The headless context has no clipboard permission by default; stub the write so
  // the test is about what the button reports, not about the OS.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    });
  });
  await page.click(".linkbar-open");
  await page.click("[data-ledger-copy]");
  await expect(page.locator("#statusbar")).toContainText("Link ledger copied");
});

test("the readout belongs to the session: gone when sync goes off", async ({ page }) => {
  await liveWithLedger(page);
  await expect(page.locator("#link-stats")).toBeVisible();
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#link-stats")).toBeHidden();
});

test("without --experimental the bar carries the message alone", async ({ page }) => {
  await stubTauriDevice(page, {
    commands: { ...LIVE_COMMANDS, vd_link_stats: STATS, append_link_log: LOG_PATH },
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#statusbar")).toContainText("Live sync on");
  await expect(page.locator("#link-stats")).toBeHidden();
});

test("the session is logged, and its last line says how it ended", async ({ page }) => {
  await liveWithLedger(page);
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "false");
  const lines = await expect
    .poll(async () => (await linkLogOf(page)).length)
    .toBeGreaterThan(0)
    .then(() => linkLogOf(page));
  const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
  // The counters this session ended with, and how it ended — the two halves the log
  // exists to pair. A line written after the disconnect would carry zeros instead.
  expect(last.end).toBe("off");
  expect(last.device).toBe("URX44V");
  // Which build wrote it. `tauri dev` and the installed app append to one file, so a
  // line without this leaves a diagnostic run and ordinary use indistinguishable.
  expect(last.build).toBe("dev");
  expect(typeof last.version).toBe("string");
  expect(last.sets).toBe(STATS.sets);
  expect(last.registFrames).toBe(STATS.regist_frames);
  expect(last.fullReads).toBe(1);
  expect(typeof last.at).toBe("string");
});
