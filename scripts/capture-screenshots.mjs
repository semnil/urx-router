// README screenshot capture. Serves an existing `pnpm build:demo` output (dist/)
// over a local HTTP server and drives Playwright Chromium to produce the four
// README shots: graph + console view x English/Japanese, dark theme, URX44V.
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
  // Pin the state the shots depend on before the app boots. Init scripts run in
  // every frame, including the static sandboxed licenses-frame where
  // localStorage access throws — guard it.
  await context.addInitScript((l) => {
    try {
      localStorage.setItem("urx-lang", l);
      localStorage.setItem("urx-theme", "dark");
      localStorage.setItem("urx-model", "URX44V");
    } catch {
      /* sandboxed frame */
    }
  }, lang);
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
}

await browser.close();
server.close();
