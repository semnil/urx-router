import { defineConfig, devices } from "@playwright/test";

// The GUI is browser-only (no Rust), so E2E runs against a served build.
// Chromium alone is enough to exercise the SVG pointer interactions.
//
// It serves a PRODUCTION build (vite build + vite preview), not the dev server:
// the dev server transforms modules on demand and can force a full page reload
// when it discovers a new dependency to optimize. Under fullyParallel the workers
// all hit it cold at once, and a reload landing mid-test left the app half
// initialized — the flake where #model-picker was found empty. A built bundle has
// no on-demand transform and no optimizer reload, so startup is deterministic.
// Behaviour is identical: the only build-mode flag is VITE_DEMO (src/core/env.ts),
// which a plain build leaves unset exactly like the dev server.
// The port comes from package.json's `preview` script (--port 4173 --strictPort),
// which `e2e:serve` composes with the build.
const SERVER_URL = "http://localhost:4173";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: SERVER_URL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm e2e:serve",
    url: SERVER_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
