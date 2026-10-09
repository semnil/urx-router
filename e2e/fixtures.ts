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

/** The WCAG 2.1 contrast ratio of an ink over its ground, both as a computed style reports
 *  them. The page paints the pair into a canvas and reads the pixel back, so every form a
 *  computed colour can take (`rgb()`, `color(srgb ...)`, a `color-mix` result) is resolved
 *  by the engine that produced it, and an ink carrying alpha is composited over the ground
 *  the way it is drawn, as is an `alpha` the ink is drawn at. The ground has to be opaque: a
 *  ratio against a translucent one is a ratio against whatever happens to be behind the probe. */
export async function contrastRatio(page: Page, ink: string, ground: string, alpha = 1): Promise<number> {
  return page.evaluate(
    ([fg, bg, a]) => {
      const c = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
      const paint = (...layers: string[]): number => {
        c.clearRect(0, 0, 1, 1);
        for (const [i, layer] of layers.entries()) {
          c.globalAlpha = i === 0 ? 1 : a;
          c.fillStyle = layer;
          c.fillRect(0, 0, 1, 1);
        }
        const [r, g, b, cover] = c.getImageData(0, 0, 1, 1).data;
        if (cover !== 255) throw new Error(`the ground ${bg} is not opaque`);
        const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      };
      const [hi, lo] = [paint(bg, fg), paint(bg)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    },
    [ink, ground, alpha] as const,
  );
}

/** The WCAG 2.1 ratio of a text element's ink over the ground it is read on: the nearest
 *  opaque background at or above it, with every translucent background between the two
 *  laid over it. The opacity of each element between the text and that ground is folded
 *  into what that element paints, the way it composites. Refuses a ground whose own layer
 *  is dimmed, since the ratio is then against whatever is behind that layer. Background
 *  IMAGES are not read: a gradient or a texture on the way is the caller's to account for. */
export async function textContrast(page: Page, target: Locator): Promise<number> {
  return target.evaluate((el) => {
    const c = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const cover = (css: string): number => {
      c.clearRect(0, 0, 1, 1);
      c.globalAlpha = 1;
      c.fillStyle = css;
      c.fillRect(0, 0, 1, 1);
      return c.getImageData(0, 0, 1, 1).data[3];
    };
    // From the text up to the ground: what each element paints, and at what strength.
    const chain: { bg: string; opacity: number }[] = [];
    let ground: Element | null = null;
    for (let n: Element | null = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (cover(s.backgroundColor) === 255) {
        ground = n;
        break;
      }
      chain.push({ bg: s.backgroundColor, opacity: Number(s.opacity) });
    }
    if (!ground) throw new Error("no opaque ground above the element");
    for (let up: Element | null = ground; up; up = up.parentElement)
      if (Number(getComputedStyle(up).opacity) < 1) throw new Error("the ground's own layer is dimmed");
    // Each layer's strength is its own opacity times every ancestor's below the ground.
    const strength = chain.map((_, i) => chain.slice(i).reduce((a, l) => a * l.opacity, 1));
    const paint = (withInk: boolean): number => {
      c.clearRect(0, 0, 1, 1);
      c.globalAlpha = 1;
      c.fillStyle = getComputedStyle(ground!).backgroundColor;
      c.fillRect(0, 0, 1, 1);
      for (let i = chain.length - 1; i >= 0; i--) {
        c.globalAlpha = strength[i];
        c.fillStyle = chain[i].bg;
        c.fillRect(0, 0, 1, 1);
      }
      if (withInk) {
        c.globalAlpha = strength[0] ?? 1;
        c.fillStyle = getComputedStyle(el).color;
        c.fillRect(0, 0, 1, 1);
      }
      const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
      const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const [hi, lo] = [paint(true), paint(false)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  });
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

/** Well past one platform notch in either engine, so a single wheel is enough to measure. */
const WHEEL_NOTCH = 400;

/** Put one wheel notch over a scroll container and wait for the offset to MOVE.
 *
 *  What it exists to separate: a container whose content exceeds it is not a container the
 *  operator can reach into. `scrollHeight > clientHeight` holds on an `overflow: hidden`
 *  box just as well, and so does writing `scrollTop` — the box is still a scroll container,
 *  it is only the operator who has lost the way in. Both spellings were measured green in
 *  both engines against `.prefs-grid { overflow-y: hidden }` and
 *  `.con-strips { overflow: hidden }`, which is precisely the regression the cases using
 *  this are placed against. A wheel is what the two answers differ on.
 *
 *  The wait is a poll for the offset rather than a fixed pause: a wheel is applied on the
 *  engine's own schedule, and a pause long enough to be safe is also long enough to be a
 *  sleep nobody can justify. */
export async function scrollsByWheel(page: Page, target: Locator, axis: "x" | "y"): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error("scroll target has no bounding box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(axis === "x" ? WHEEL_NOTCH : 0, axis === "x" ? 0 : WHEEL_NOTCH);
  const offset = axis === "x" ? "scrollLeft" : "scrollTop";
  await expect
    .poll(() => target.evaluate((el, k) => el[k as "scrollLeft" | "scrollTop"], offset), {
      message: `the wheel moved no ${offset}: the overflow is there, and nothing the operator does reaches it`,
    })
    .toBeGreaterThan(0);
}

export { expect };
export type { Locator, Page } from "@playwright/test";
