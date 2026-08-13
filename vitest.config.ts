import { defineConfig } from "vitest/config";

// Core and models are DOM-free (see docs/*/architecture.md), so the node
// environment is enough; UI-layer tests would opt into jsdom per file.
export default defineConfig({
  test: {
    environment: "node",
    // A hang detector, not a budget. The cases that boot the whole app under jsdom run
    // for seconds, and the 5000 ms default sits close enough to them to be crossed by a
    // cold run rather than by a defect. Measured 2026-08-13 on one machine (Windows, 24
    // cores), for main.flows' "the share link puts a decodable plan on the clipboard":
    // 2.1 s at 72 workers, 3.1 s at the default worker count, 3.3 s with the Vite cache
    // cleared, and 6.4 s on the first run after a `pnpm install` — the run that failed,
    // at 129% of the default, and taken while this suite was smaller than it is now.
    // 30 s is what main.device.test.ts already passes per test for the same kind of case,
    // and a stuck test still reports in half a minute.
    testTimeout: 30_000,
    // scripts/ is tooling rather than app code, so it is included here but deliberately
    // left out of the coverage set below: what those files need is the pins, not a
    // percentage. `check-merge-gates` is the one with a test today, and it is the guard
    // over the checks a merge waits for.
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
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
      // catalog is checked" but "how many formatters some test happened to call":
      // measured 2026-08-13 on 238389c, ja.ts 19 of 103 lines and en.ts 84 of 108, where
      // every other directory reads 95-100% of lines (core, control, midi, models, ui)
      // and src itself reads 85.4 (main.ts at 85.47, midi-window.ts at 0). All of those
      // are the line column, the one the two catalog figures are counted in.
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
