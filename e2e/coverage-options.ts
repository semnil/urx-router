import type { CoverageReportOptions } from "monocart-coverage-reports";

function normalized(path: string): string {
  return path.replaceAll("\\", "/");
}

/** Vite source maps may name a source as an absolute path or as ../../src/....
 * Codecov must see the same repo-relative path as Vitest's LCOV or the two uploads
 * become two unrelated files instead of one merged reading. */
function repoSourcePath(path: string): string {
  const source = normalized(path);
  const index = source.lastIndexOf("src/");
  return index === -1 ? source : source.slice(index);
}

const coverageOptions: CoverageReportOptions = {
  name: "Frontend E2E coverage",
  outputDir: "coverage/e2e",
  baseDir: process.cwd(),
  reports: ["console-summary", ["lcovonly", { file: "lcov.info", projectRoot: process.cwd() }]],
  // The preview server also exposes Vite helpers and source maps. Only application
  // chunks carry source ranges worth merging with the frontend unit report.
  entryFilter: (entry) => entry.type !== "css" && /\/assets\/[^/]+\.js(?:$|\?)/.test(entry.url),
  sourceFilter: (sourcePath) => {
    const source = repoSourcePath(sourcePath);
    return source.startsWith("src/") && source.endsWith(".ts") && !source.endsWith(".d.ts");
  },
  sourcePath: repoSourcePath,
};

export default coverageOptions;
