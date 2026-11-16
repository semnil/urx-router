import { BaseSequencer, type TestSpecification } from "vitest/node";

/** Start Windows Git integration, screen walks and whole-app device cases before smaller suites. */
export class FrontendSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    const priority = (file: TestSpecification): number => {
      const path = file.moduleId.replaceAll("\\", "/");
      if (process.platform === "win32" && path.endsWith("/scripts/sync-merged.test.mjs")) return -1;
      if (/\/src\/ui\/sim-view\.paths(?:\.[^/]+)?\.contract\.test\.ts$/.test(path)) return 0;
      if (/\/src\/main\.device\.[^/]+\.test\.ts$/.test(path)) return 1;
      return 2;
    };
    // The stable sort keeps Vitest's failure/duration/size order within each group.
    return sorted.sort((a, b) => priority(a) - priority(b));
  }
}
