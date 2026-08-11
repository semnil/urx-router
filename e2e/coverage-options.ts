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
 * and when that request fails it reports the served bundle instead of the sources the map
 * leads to, without saying so. Codecov then throws the whole upload away:
 * `localhost-4173/assets/main-*.js` names no file in the repository, so every record is
 * dropped and the report arrives empty — REPORT_EMPTY on every e2e upload between the
 * flag being added and this.
 *
 * That request failed in CI's Linux container, while the macOS environment it was
 * diagnosed on selected `::1` for the same call and succeeded — which is why no local run
 * ever showed it. Measured in mcr.microsoft.com/playwright:v1.62.1-noble, the image the e2e
 * job ran in at the time: no single part of it is wrong. `vite preview` binds the host it
 * is given, `localhost`, which resolved IPv6-first there, so the server listened on `::1`
 * ALONE — `::1:4173` in /proc/net/tcp6, /proc/net/tcp empty. Node's `http.get`, which is what
 * monocart issues, went to 127.0.0.1 and was refused with `autoSelectFamily` on, and
 * monocart's one fallback rewrites `localhost` to `127.0.0.1`, the same dead address.
 * `http://[::1]:4173/…` answered 200 throughout, and Chromium and Playwright's own server
 * poll reach `::1`, so the suite passed and the map fetch was the only thing that did not.
 *
 * Neither half of that is a property of the platform: which address `localhost` resolves
 * to follows the host's own configuration, and which one `vite preview` binds follows
 * Vite's `server.host` resolution. Windows and other Linux configurations were not
 * measured, so the reading above is two environments, not a rule.
 *
 * The maps are on disk beside the bundle the preview server is serving them from, so read
 * them there: a round trip that is not made cannot pick the wrong address, whichever way
 * the bind lands later. A miss answers with nothing, exactly as a failed fetch did, and is
 * caught by the reporter rather than uploaded. */
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
