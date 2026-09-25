import { test, expect } from "./fixtures";

// The hidden-node shelf's chip row scrolls sideways, and its scrollbar is an overlay in some
// engines and takes layout space in others. WebKit can size the shelf before the row's scrollbar
// exists and count it only at the next relayout, so the shelf grew by the scrollbar's height the
// first time anything relaid it out after launch — a hover over a chip is one. The case sets the
// states itself: no scrollbar, and a classic 13px one (what WebKit gives a `scrollbar-width:
// thin` row) laid out in full and then hovered. The shelf is one height across all of them, and
// the chips stay whole above the scrollbar.
//
// Headless Chromium is launched with --hide-scrollbars by default, which lays out no scrollbar
// at all, so this file launches without it. A launch option forces a worker of its own, which
// is why the case is not in hide.spec.ts.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("the shelf keeps its height whether or not the chip row's scrollbar takes space @webkit", async ({ page }) => {
  await page.click("#btn-view");
  await page.click("#btn-hide-unused");
  await expect(page.locator(".shelf-chips")).toBeVisible();

  const measure = (rule: string, relayout: boolean) =>
    page.evaluate(
      ([css, full]) => {
        let style = document.getElementById("shelf-scrollbar-state");
        if (!style) {
          style = document.createElement("style");
          style.id = "shelf-scrollbar-state";
          document.head.append(style);
        }
        style.textContent = css;
        const row = document.querySelector<HTMLElement>(".shelf-chips")!;
        if (full) {
          row.style.display = "none";
          void row.offsetHeight;
          row.style.display = "";
        }
        const rowTop = row.getBoundingClientRect().top;
        return {
          shelf: document.querySelector<HTMLElement>(".hidden-shelf")!.getBoundingClientRect().height,
          gutter: row.offsetHeight - row.clientHeight,
          overflows: row.scrollWidth > row.clientWidth,
          chipBottom: row.querySelector(".chip")!.getBoundingClientRect().bottom - rowTop,
          clientBottom: row.clientHeight,
        };
      },
      [rule, relayout] as const,
    );
  const none = ".shelf-chips { scrollbar-width: none !important; }";
  const classic =
    ".shelf-chips { scrollbar-width: auto !important; } .shelf-chips::-webkit-scrollbar { height: 13px; }";

  const without = await measure(none, true);
  expect(without.overflows, "the row holds more chips than it shows").toBe(true);
  expect(without.gutter).toBe(0);
  const laidOut = await measure(classic, true);
  await page.locator(".hidden-shelf .chip").first().hover();
  const hovered = await measure(classic, false);
  for (const [name, state] of Object.entries({ laidOut, hovered })) {
    expect(state.gutter, `${name}: the scrollbar takes layout space`).toBe(13);
    expect(state.shelf, `${name}: shelf height`).toBe(without.shelf);
    expect(state.chipBottom, `${name}: the chips end above the scrollbar`).toBeLessThanOrEqual(state.clientBottom);
  }
});
