import { readFile } from "node:fs/promises";
import type { FullResult, Reporter } from "@playwright/test/reporter";
import { CoverageReport } from "monocart-coverage-reports";
import coverageOptions, { LCOV_FILE } from "./coverage-options";

/** The worker fixtures add raw readings concurrently. The reporter brackets their
 * lifetime so a stale local run cannot leak into this one, then generates one LCOV
 * only after every worker and retry has finished writing. */
export default class E2ECoverageReporter implements Reporter {
  onBegin(): void {
    new CoverageReport(coverageOptions).cleanCache();
  }

  async onEnd(): Promise<{ status: FullResult["status"] } | void> {
    await new CoverageReport(coverageOptions).generate();

    // A report naming the served bundle rather than the sources its map leads to is
    // still a well-formed LCOV and still uploads without error; Codecov is where it
    // becomes nothing, after the run is over and with nothing failing. Assert the one
    // property that separates the two reports here, where it is still this run's answer.
    const sources = await lcovSources();
    const foreign = sources.filter((source) => !source.startsWith("src/"));
    if (sources.length === 0 || foreign.length > 0) {
      const detail = foreign.length ? `: ${foreign.slice(0, 3).join(", ")}` : " (no records)";
      console.error(`E2E coverage: ${LCOV_FILE} does not name repository sources${detail}`);
      console.error("The chunk source maps were not applied, and Codecov would discard this upload.");
      return { status: "failed" };
    }
  }
}

async function lcovSources(): Promise<string[]> {
  try {
    const report = await readFile(LCOV_FILE, "utf8");
    return [...report.matchAll(/^SF:(.*)$/gm)].map((match) => match[1]);
  } catch {
    return [];
  }
}
