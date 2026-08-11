import { defineConfig } from "vitest/config";

// Core and models are DOM-free (see docs/*/architecture.md), so the node
// environment is enough; UI-layer tests would opt into jsdom per file.
export default defineConfig({
  test: {
    environment: "node",
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
