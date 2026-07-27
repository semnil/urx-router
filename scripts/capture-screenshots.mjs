// Documentation screenshot capture. Serves an existing `pnpm build:demo` output
// (dist/) over a local HTTP server and drives Playwright Chromium to produce the
// four README shots (graph + console view x English/Japanese, dark theme, URX44V)
// and the two ducker-bypass warning shots the development article uses.
//
// Usage:
//   pnpm build:demo
//   node scripts/capture-screenshots.mjs [--out docs/assets]
//
// The console shot widens the viewport by the live-measured `.con-strips`
// horizontal overflow so every strip fits without scrolling.

import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { preview } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outFlag = process.argv.indexOf("--out");
const outDir = resolve(root, outFlag >= 0 ? process.argv[outFlag + 1] : "docs/assets");

const VIEWPORT = { width: 1600, height: 1000 };

// Pin the state the shots depend on before the app boots. Init scripts run in
// every frame, so guard the localStorage writes: a restricted / opaque-origin
// frame would throw (the licenses notice renders as app DOM now, no iframe).
const pinState = (l) => {
  try {
    localStorage.setItem("urx-lang", l);
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-model", "URX44V");
  } catch {
    /* restricted-origin frame */
  }
};

// Press one jack and release over another, committing a connection (the gesture
// e2e/graph-helpers.ts performs, repeated here so the script stays dependency-free).
async function drag(page, from, to) {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error("jack not found");
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}

if (!existsSync(join(root, "dist", "index.html"))) {
  console.error("dist/index.html not found — run `pnpm build:demo` first (the README shots come from the demo build).");
  process.exit(1);
}

// Serve dist/ with Vite's own preview server (correct MIME types, ephemeral port).
const server = await preview({ root, preview: { port: 0, host: "127.0.0.1" } });
const base = server.resolvedUrls.local[0];

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();

for (const lang of ["en", "ja"]) {
  const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: "dark" });
  await context.addInitScript(pinState, lang);
  const page = await context.newPage();

  // Graph view (the initial view; fitView settles via ResizeObserver).
  await page.goto(base);
  await page.locator("#graph-host g.node").first().waitFor();
  await page.waitForTimeout(800);
  const graphShot = join(outDir, `screenshot-${lang}.png`);
  await page.screenshot({ path: graphShot });
  console.log(graphShot);

  // Console view: widen the viewport until the strips stop overflowing.
  await page.evaluate(() => localStorage.setItem("urx-view", "console"));
  await page.reload();
  await page.locator(".con-strip").first().waitFor();
  await page.waitForTimeout(500);
  // The strip grid is a fixed-width row, so the horizontal overflow is the exact
  // deficit — one measure and one resize always clear it.
  const overflow = await page.evaluate(() => {
    const strips = document.querySelector(".con-strips");
    return strips ? strips.scrollWidth - strips.clientWidth : 0;
  });
  if (overflow > 0) {
    const size = page.viewportSize();
    await page.setViewportSize({ width: size.width + overflow, height: size.height });
    await page.waitForTimeout(400);
  }
  const consoleShot = join(outDir, `screenshot-console-${lang}.png`);
  await page.screenshot({ path: consoleShot });
  console.log(consoleShot);

  await context.close();

  // Ducker-bypass warning: CH 5/6 wired to a USB direct out from its Rec Point
  // tap while its Ducker is on, so the duck never reaches that output. A fresh
  // context keeps that wire out of the README shots above.
  const warnContext = await browser.newContext({ viewport: VIEWPORT, colorScheme: "dark" });
  await warnContext.addInitScript(pinState, lang);
  const warnPage = await warnContext.newPage();
  await warnPage.goto(base);
  await warnPage.locator("#graph-host g.node").first().waitFor();
  await warnPage.waitForTimeout(800);
  // USB MAIN OUT B takes a single source and the default plan already patches it,
  // so its existing wire goes first. `button.danger` is the inspector's delete
  // control whatever the language; dispatchEvent bypasses the wire-hit bands'
  // pointer interception, as in the e2e specs.
  await warnPage.locator('.wire-hit[data-to="out.usbmain_b:in"]').first().dispatchEvent("pointerdown");
  await warnPage.locator("#inspector button.danger").click();
  await drag(warnPage, warnPage.locator('[data-tap="ch_5_6:out"]'), warnPage.locator('[data-ref="out.usbmain_b:in"]'));
  // The Ducker node carries its own on/off switch. Its section label and the
  // ON/OFF buttons are untranslated, so one locator serves both languages.
  await warnPage.locator('#graph-host g.node[data-id="out.ducker1"]').click();
  const duckerSection = warnPage
    .locator("#inspector details.insp-section")
    .filter({ has: warnPage.locator('summary:has-text("Ducker")') });
  await duckerSection.locator("summary").click();
  await duckerSection.getByRole("button", { name: "ON", exact: true }).click();
  // Selecting the new wire puts the connection detail below the warning, which
  // stays visible whatever is selected.
  await warnPage.locator('.wire-hit[data-from="ch_5_6:out"][data-to="out.usbmain_b:in"]').dispatchEvent("pointerdown");
  await warnPage.waitForTimeout(400);
  const warningShot = join(outDir, `screenshot-ducker-warning-${lang}.png`);
  await warnPage.screenshot({ path: warningShot });
  console.log(warningShot);

  await warnContext.close();
}

await browser.close();
server.close();
