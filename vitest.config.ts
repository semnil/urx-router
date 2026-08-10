import { defineConfig } from "vitest/config";

// Core and models are DOM-free (see docs/*/architecture.md), so the node
// environment is enough; UI-layer tests would opt into jsdom per file.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.test-util.ts", "src/**/*.d.ts"],
    },
  },
});
