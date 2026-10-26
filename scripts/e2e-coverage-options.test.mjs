// Which sources the E2E coverage report names as this repository's. Source maps name each source
// by a path relative to the bundle, and the report keeps the part from `src/` on — so a
// dependency's own src/ has to be told apart, or its files land on ours: urx-lcd-sim carries a
// src/ui/dom.ts, and so does this repository.
import { describe, expect, it } from "vitest";
import coverageOptions from "../e2e/coverage-options.ts";

const { sourceFilter, sourcePath } = coverageOptions;

describe("E2E coverage, the sources it names as this repository's", () => {
  it("names the repository's own sources by their repo-relative path", () => {
    expect(sourcePath("../../src/ui/dom.ts")).toBe("src/ui/dom.ts");
    expect(sourceFilter("../../src/ui/dom.ts")).toBe(true);
  });

  it("leaves out urx-lcd-sim's sources from the submodule", () => {
    const vendored = "../../vendor/urx-lcd-sim/src/ui/dom.ts";
    expect(sourcePath(vendored)).not.toBe("src/ui/dom.ts");
    expect(sourceFilter(vendored)).toBe(false);
  });

  it("leaves out a dependency's sources from the install", () => {
    const installed = "../../node_modules/.pnpm/urx-lcd-sim@x/node_modules/urx-lcd-sim/src/ui/dom.ts";
    expect(sourcePath(installed)).not.toBe("src/ui/dom.ts");
    expect(sourceFilter(installed)).toBe(false);
  });
});
