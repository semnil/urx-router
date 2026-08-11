import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CoverageReportOptions } from "monocart-coverage-reports";

const OUTPUT_DIR = "coverage/e2e";

/** The report the Codecov step uploads (ci.yml names the same path), so the guard in the
 * reporter reads the file that is actually sent rather than one derived a second time. */
export const LCOV_FILE = `${OUTPUT_DIR}/lcov.info`;

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

/** monocart's own resolver fetches each chunk's .map from the preview server over HTTP,
 * and when that request fails — or answers with something that does not parse as JSON —
 * it reports the served bundle instead of the sources the map leads to, without saying
 * so. Codecov then throws the whole upload away: `localhost-4173/assets/main-*.js` names
 * no file in the repository, so every record is dropped and the report arrives empty
 * (measured: REPORT_EMPTY on every e2e upload since the flag was added, while the same
 * run remapped correctly on macOS). The maps are on disk beside the bundle the preview
 * server is serving them from, so read them there and leave no round trip to fail. A miss
 * answers with nothing, exactly as a failed fetch did, and is caught by the reporter. */
async function sourceMapResolver(url: string): Promise<unknown> {
  // The coverage run is the chromium project alone, which is served from dist/.
  const path = resolve(process.cwd(), "dist", new URL(url).pathname.replace(/^\/+/, ""));
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

const coverageOptions: CoverageReportOptions = {
  name: "Frontend E2E coverage",
  outputDir: OUTPUT_DIR,
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
  sourceMapResolver,
};

export default coverageOptions;
