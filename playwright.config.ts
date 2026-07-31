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

// The race-diagnosis harness (e2e/race, docs/{en,ja}/live-race-harness.md) runs as its
// own project against its own server. It needs a bundle that carries the plan-ledger
// probe (VITE_TRACE, .env.trace) — production-shaped, not a dev build, so the tier is
// still testing what ships — and it is slow by construction: several cases provoke
// whole-device readbacks of ~800 sequential commands. Splitting it out means
// `--project=chromium` is still the ordinary suite at its ordinary cost, and the
// harness can be run, sharded or skipped on its own.
const TRACE_URL = "http://localhost:4174";

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
  projects: [
    { name: "chromium", testIgnore: "race/**", use: { ...devices["Desktop Chrome"] } },
    {
      name: "race",
      testDir: "e2e/race",
      // Its own timeout, well above the 30 s default: a single case can hold a barrier
      // through a converge round that reads ~800 addresses sequentially, and the driver
      // then waits for the link to fall quiet again. Measured at 35 s for the longest,
      // so the default turns a passing case into a timeout that reads like a defect.
      timeout: 180_000,
      use: { ...devices["Desktop Chrome"], baseURL: TRACE_URL },
    },
    {
      // The same harness in the engine the macOS build actually renders in. Scoped to
      // the three cases whose verdict is about the ENGINE rather than about the app's
      // logic — a strip rack rebuilt under a live pointer capture, a whole-view rebuild
      // under one, and the chord/focus matrix, where WebKit owns a text field's own undo
      // and the app deliberately does not preventDefault. Everything else would only
      // re-measure logic Chromium already covers, at several minutes a run. Same
      // precedent as scripts/meter-bench-run.mjs, which benches in WebKit for the same
      // reason. Tagged rather than listed by path so a case cannot drift out of the set
      // by being moved between files.
      name: "race-webkit",
      testDir: "e2e/race",
      grep: /@webkit/,
      timeout: 180_000,
      use: { ...devices["Desktop Safari"], baseURL: TRACE_URL },
    },
  ],
  webServer: [
    {
      command: "pnpm e2e:serve",
      url: SERVER_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "pnpm e2e:serve:trace",
      url: TRACE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
