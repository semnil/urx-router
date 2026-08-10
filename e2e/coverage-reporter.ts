import type { Reporter } from "@playwright/test/reporter";
import { CoverageReport } from "monocart-coverage-reports";
import coverageOptions from "./coverage-options";

/** The worker fixtures add raw readings concurrently. The reporter brackets their
 * lifetime so a stale local run cannot leak into this one, then generates one LCOV
 * only after every worker and retry has finished writing. */
export default class E2ECoverageReporter implements Reporter {
  onBegin(): void {
    new CoverageReport(coverageOptions).cleanCache();
  }

  async onEnd(): Promise<void> {
    await new CoverageReport(coverageOptions).generate();
  }
}
