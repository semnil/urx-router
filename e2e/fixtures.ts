import { expect, test as base, type BrowserContext, type Locator, type Page } from "@playwright/test";
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

/** A **colour** theme token, in the `rgb(...)` form a computed style reports, so a pin
 *  can name a token instead of a literal that has to be rewritten with the palette.
 *  Colour only, and the name says so: the value comes back through a probe painted
 *  with `background-color`, which a numeric token like `--row-lock-dim` cannot satisfy.
 *
 *  Both checks are the anchor's own anchor, and they are separate on purpose. A face
 *  pin that compares two controls to each other still passes when the recipe vanishes
 *  and both fall back to the UA's, so such a pin needs one anchored value — but a
 *  `var()` naming a token that no longer exists is invalid at computed-value time, so
 *  the probe falls back to the initial `rgba(0, 0, 0, 0)` and so does every declaration
 *  in the app reading the same token. Measured: rename `--ctl-bg` away and the probe,
 *  the model picker and the inspector's select all report `rgba(0, 0, 0, 0)` together,
 *  which satisfies an equality against controls painting nothing at all. Asking the
 *  root for the declaration separately is what keeps the two failures apart — a token
 *  that is gone and a token that is not a colour report different things. */
export async function colorToken(page: Page, name: string): Promise<string> {
  const { declared, resolved } = await page.evaluate((n) => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = `var(${n})`;
    document.body.append(probe);
    const resolved = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { declared: getComputedStyle(document.documentElement).getPropertyValue(n).trim(), resolved };
  }, name);
  expect(declared, `${name} is not declared on :root — a pin against it would be vacuous`).not.toBe("");
  expect(
    resolved,
    `${name} is declared as "${declared}", which does not paint — colorToken resolves colour tokens only`,
  ).not.toBe("rgba(0, 0, 0, 0)");
  return resolved;
}

/** Drive one native slider through the gesture `holdInertOnBlur` exists for: press, drag,
 *  lose the window, keep the button down through a focus return, release, and press again.
 *  The DRAG is real (only an engine can drive a native slider) and only the blur is
 *  dispatched — Playwright emulates focus, so no tier can take the OS foreground away. The
 *  measurements the shape rests on are in `ui/dom.ts`. Shared because three specs drive it
 *  on four different builders, and a per-spec copy is what let two of them assert the
 *  frozen value alone — which the treatment measured to RESUME on the unit also satisfies. */
export async function heldThroughBlur(page: Page, slider: Locator): Promise<void> {
  await expect(slider).toHaveCount(1);
  const b = (await slider.boundingBox())!;
  const y = b.y + b.height / 2;
  const at = (f: number): number => b.x + b.width * f;

  await page.mouse.move(at(0.25), y);
  await page.mouse.down();
  await page.mouse.move(at(0.4), y);
  const dragged = await slider.inputValue();

  await page.evaluate(() => window.dispatchEvent(new FocusEvent("blur")));
  await page.mouse.move(at(0.8), y);
  expect(await slider.inputValue()).toBe(dragged);
  await expect(slider).toBeDisabled();

  // Coming back releases the hold — measured safe on the shipping WKWebView: re-enabling
  // under a still-held button does not hand the drag back. (What DID resume there was the
  // other treatment, detaching the element and re-inserting it.) So the row is live again
  // and the value still does not move under the held pointer.
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  await expect(slider).toBeEnabled();
  await page.mouse.move(at(0.95), y);
  expect(await slider.inputValue()).toBe(dragged);

  await page.mouse.up();
  await expect(slider).toBeEnabled();
  await page.mouse.move(at(0.6), y);
  await page.mouse.down();
  await page.mouse.move(at(0.65), y);
  await page.mouse.up();
  expect(await slider.inputValue()).not.toBe(dragged);
}

export { expect };
export type { Locator, Page } from "@playwright/test";
