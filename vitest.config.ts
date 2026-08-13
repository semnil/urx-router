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
      exclude: ["src/**/*.test.ts", "src/**/*.test-util.ts", "src/**/*.d.ts"],
    },
  },
});
