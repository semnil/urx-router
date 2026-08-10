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
//
// The two ports come from the environment (E2E_PORT / E2E_TRACE_PORT, defaulting to
// 4173 / 4174), which is what lets a second checkout run the suite at the same time:
// `scripts/e2e-serve.mjs` reads the same variables, and the web server inherits this
// process's environment, so the URL polled here and the port bound there are resolved
// once from one place. Two runs sharing a port would not fail — `reuseExistingServer`
// would hand the second one the first one's bundle, and it would pass against code
// that is not the code under test. Isolate the checkout too (`pnpm e2e:worktree`):
// a port pair alone still leaves both runs building into the same dist/.
const PORT = Number(process.env.E2E_PORT ?? 4173);
const TRACE_PORT = Number(process.env.E2E_TRACE_PORT ?? 4174);
const SERVER_URL = `http://localhost:${PORT}`;

// The race-diagnosis harness (e2e/race, docs/{en,ja}/live-race-harness.md) runs as its
// own project against its own server. It needs a bundle that carries the plan-ledger
// probe (VITE_TRACE, .env.trace) — production-shaped, not a dev build, so the tier is
// still testing what ships — and it is slow by construction: several cases provoke
// whole-device readbacks of ~800 sequential commands. Splitting it out means
// `--project=chromium` is still the ordinary suite at its ordinary cost, and the
// harness can be run, sharded or skipped on its own.
//
// That split is also the CI tiering. Measured on a two-worker ubuntu runner: the
// ordinary suite is 3.5 minutes of machine time across 383 cases, none over 3 s, so it
// runs per-PR from ci.yml; the harness is 22.4 minutes across 156, so it runs from its
// own race.yml — sharded, on demand and alongside a release build. Nothing about the
// tiers lives in this file beyond the project boundary they are cut along.
const TRACE_URL = `http://localhost:${TRACE_PORT}`;
const COVERAGE = process.env.E2E_COVERAGE === "1";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // The coverage reporter only owns cache lifecycle and final report generation;
  // the automatic fixture imported by the ordinary specs collects each page. A
  // normal E2E run therefore pays neither the CDP collection nor the conversion.
  reporter: COVERAGE ? [["list"], ["./e2e/coverage-reporter.ts"]] : "list",
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
      // then waits for the link to fall quiet again. The longest measured 60 s on a
      // two-worker CI runner, so the default turns a passing case into a timeout that
      // reads like a defect. Twice that rather than three times it, because the handful
      // of cases needing more say so themselves (`test.setTimeout` in tzb-tail and
      // t8-stress) — a project figure wide enough to cover them would also let every
      // OTHER case burn three minutes before reporting, once per retry.
      timeout: 120_000,
      // One retry, not the suite's two. Every pin here is placed on a barrier rather
      // than on a delay, so a case that only passes on the third attempt is not a pin
      // holding — it is a flake, and at two retries it stays hidden long enough to reach
      // main. The cost argues the same way: a race retry is minutes, an ordinary one is
      // seconds.
      retries: process.env.CI ? 1 : 0,
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
      timeout: 120_000,
      retries: process.env.CI ? 1 : 0,
      use: { ...devices["Desktop Safari"], baseURL: TRACE_URL },
    },
  ],
  // Both servers start whatever `--project` selects — the list is a property of the
  // config, not of the run — so the ordinary tier builds the trace bundle it will not
  // visit. Left that way deliberately: measured at 6 s for the pair on a CI runner
  // (the app is 73 modules), which is less than the branch it would take to skip one.
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
