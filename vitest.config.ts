import { defineConfig } from "vitest/config";
import { LCD_SIM_DIR, lcdSimCommit } from "./vite.config.ts";

/** The setup file the worker log adds, while URX_VITEST_WORKER_LOG names a file. On Windows the variable is
 *  refused: there vitest's SIGTERM ends a worker without running the handler that writes its end line, so a
 *  file that finished could not be told from one whose worker died. */
function workerLogSetupFiles(): string[] {
  if (!process.env.URX_VITEST_WORKER_LOG) return [];
  if (process.platform === "win32") {
    throw new Error("URX_VITEST_WORKER_LOG is not supported on Windows: unset it to run the suite there");
  }
  return ["scripts/vitest-worker-log-setup.mjs"];
}

// Core and models are DOM-free (see docs/*/architecture.md), so the node
// environment is enough; UI-layer tests would opt into jsdom per file.
export default defineConfig({
  define: { __URX_LCD_SIM_COMMIT__: JSON.stringify(lcdSimCommit(LCD_SIM_DIR)) },
  test: {
    environment: "node",
    // A hang detector, not a budget. The cases that boot the whole app under jsdom run
    // for seconds, and the 5000 ms default sits close enough to them to be crossed by a
    // cold run rather than by a defect: the first run after a `pnpm install` can be slow
    // enough to take a whole-app case past it.
    // 30 s is what the main.device.*.test.ts files already pass per test for the same kind of case,
    // and a stuck test still reports in half a minute.
    testTimeout: 30_000,
    // scripts/ is tooling rather than app code, so it is included here but deliberately
    // left out of the coverage set below: what those files need is the pins, not a
    // percentage. `check-merge-gates` is the one with a test today, and it is the guard
    // over the checks a merge waits for.
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    // With URX_VITEST_WORKER_LOG set, each worker appends its pid and its test file to that file when the
    // file starts and when it ends, so a worker that exits mid-file is named by its file and its pid
    // (scripts/vitest-worker-log-setup.mjs). Unset, nothing is added.
    setupFiles: workerLogSetupFiles(),
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      // The message catalogs are excluded here, in .github/codecov.yml (the merged
      // reading) and in e2e/coverage-options.ts (the E2E half's LCOV). This is the one
      // place the reason is written; the other two point here.
      //
      // V8 counts no line for a string leaf — a catalog is one object literal, and the
      // only executable lines in the file are the formatter bodies (102 in each, plus
      // en.ts's three marker helpers). The percentage is therefore not "how much of the
      // catalog is checked" but "how many formatters some test happened to call", and
      // both catalogs read well below every other directory's line figure.
      // The suite runs in English, so ja.ts's figure is a statement about the language
      // the tests run in.
      //
      // What holds the catalogs instead, none of it a percentage: refs.contract.test.ts
      // (every leaf is reached from the app's own sources), e2e/inventory.spec.ts (every
      // message a surface claims is on screen), and en.ts's dev() / fixed() / tr() marks,
      // which make ja.ts fail to compile if it drops a key or translates a device row.
      // What none of them check is that a formatter substitutes its arguments — a ja
      // entry that loses its `${n}` is caught by nothing today, here or before this.
      exclude: ["src/**/*.test.ts", "src/**/*.test-util.ts", "src/**/*.d.ts", "src/i18n/en.ts", "src/i18n/ja.ts"],
    },
  },
});
