import { expect, test as base, type BrowserContext, type Page } from "@playwright/test";
import coverageOptions from "./coverage-options";

interface CoverageHarness {
  start(page: Page): Promise<void>;
}

const requested = process.env.E2E_COVERAGE === "1";

/** The ordinary suite's shared test object. Coverage is an automatic fixture rather
 * than instrumentation in the app bundle: only the explicit coverage command starts
 * Chromium's native collector, while every normal and race run remains unchanged. */
export const test = base.extend<{ e2eCoverage: CoverageHarness }>({
  e2eCoverage: [
    async ({ browserName, context }, use) => {
      const enabled = requested && browserName === "chromium";
      const started = new Map<Page, Promise<void>>();
      const start = (page: Page): Promise<void> => {
        if (!enabled || page.isClosed()) return Promise.resolve();
        const existing = started.get(page);
        if (existing) return existing;
        const pending = page.coverage.startJSCoverage({ resetOnNavigation: false });
        started.set(page, pending);
        return pending;
      };
      const onPage = (page: Page): void => void start(page);

      if (enabled) context.on("page", onPage);
      try {
        await use({ start });
      } finally {
        if (enabled) {
          context.off("page", onPage);
          const readings = await collectOpenPages(context, started);
          if (readings.length) {
            // Keep the report converter out of ordinary workers entirely. This
            // import is reached only by the explicit coverage run.
            const { CoverageReport } = await import("monocart-coverage-reports");
            await new CoverageReport(coverageOptions).add(readings.flat());
          }
        }
      }
    },
    { auto: true },
  ],
  // Make the default page's start ordering strict: its first navigation cannot race
  // the asynchronous context "page" event. Extra windows are also caught by that
  // event and are included when they remain open at teardown.
  page: async ({ e2eCoverage, page }, use) => {
    await e2eCoverage.start(page);
    await use(page);
  },
});

async function collectOpenPages(
  context: BrowserContext,
  started: ReadonlyMap<Page, Promise<void>>,
): Promise<Awaited<ReturnType<Page["coverage"]["stopJSCoverage"]>>[]> {
  const readings = [];
  for (const page of context.pages()) {
    const pending = started.get(page);
    if (!pending || page.isClosed()) continue;
    await pending;
    readings.push(await page.coverage.stopJSCoverage());
  }
  return readings;
}

export { expect };
export type { Locator, Page } from "@playwright/test";
