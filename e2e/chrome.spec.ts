import { test, expect, colorToken, contrastRatio, type Locator, type Page } from "./fixtures";
import { stubTauriBoot } from "./tauri-stub";
import { drag, port } from "./graph-helpers";
import { chooseOption } from "./choose-option";

// App-chrome behaviour: the theme and language rows in the Preferences modal
// (moved off the toolbar), the toolbar brand and Device-menu grouping, and the
// canvas hit-test after a zoom. These cut across the whole UI (toolbar + graph
// + console), which the per-feature specs do not exercise.

const wires = (page: Page) => page.locator("#graph-host .wire-hit");

// Pick one Preferences dropdown value and close the modal again (the tests
// that assert intermediate modal state keep the steps inline instead).
async function pickPref(page: Page, selector: string, value: string): Promise<void> {
  await page.click("#btn-prefs");
  await chooseOption(page.locator(selector), value);
  await page.click("#prefs-modal .consent-btn-secondary");
}

const connect = (page: Page, fromRef: string, toRef: string): Promise<void> =>
  drag(page, port(page, fromRef), port(page, toRef));

test.describe("theme", () => {
  test.beforeEach(async ({ page }) => {
    // Pin lang+model but NOT theme, so the toggle's localStorage write is what
    // drives the post-reload state (the beforeEach init script never re-pins it).
    await page.addInitScript(() => {
      localStorage.setItem("urx-lang", "en");
      localStorage.setItem("urx-model", "URX44V");
    });
  });

  test("the Preferences theme row applies each mode and persists the choice", async ({ page }) => {
    // Pin a dark OS so auto resolves predictably to dark.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");

    const html = page.locator("html");
    await page.click("#btn-prefs");
    const sel = page.locator("#prefs-theme");

    // No saved choice → auto, which under a dark OS resolves to dark.
    await expect(sel).toHaveValue("auto");
    await expect(html).toHaveAttribute("data-theme", "dark");

    // Each pick applies immediately behind the open modal.
    await chooseOption(sel, "light");
    await expect(html).toHaveAttribute("data-theme", "light");
    await expect(page.locator("#statusbar")).toHaveText("Switched to light mode");

    await chooseOption(sel, "dark");
    await expect(html).toHaveAttribute("data-theme", "dark");

    // Back to auto (follows the OS again = dark here).
    await chooseOption(sel, "auto");
    await expect(html).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("#statusbar")).toHaveText("Following the system theme");

    // The chosen mode survives a reload: pick light, reload, expect light again.
    await chooseOption(sel, "light");
    await page.reload();
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await expect(html).toHaveAttribute("data-theme", "light");
    await page.click("#btn-prefs");
    await expect(page.locator("#prefs-theme")).toHaveValue("light");
  });

  test("auto mode follows a live OS color-scheme change", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    const html = page.locator("html");
    // Default (no saved choice) is auto; a light OS resolves to light.
    await expect(html).toHaveAttribute("data-theme", "light");

    // Flipping the OS preference repaints without any interaction while in auto.
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(html).toHaveAttribute("data-theme", "dark");
  });

  test("changing the theme inside the console view keeps the console rendered", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await page.click("#btn-view-console");
    await expect(page.locator("#console-host")).toBeVisible();
    const strips = await page.locator(".con-strip").count();

    await pickPref(page, "#prefs-theme", "light");

    // The console is CSS-variable themed, so it must stay up with all strips intact
    // (no re-mount, no blank view) when the palette flips under it.
    await expect(page.locator("#console-host")).toBeVisible();
    await expect(page.locator(".con-strip")).toHaveCount(strips);
  });
});

test.describe("language", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("urx-lang", "en");
      localStorage.setItem("urx-theme", "dark");
      localStorage.setItem("urx-model", "URX44V");
    });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  test("switching to Japanese relocalizes the modal, the toolbar and the console live", async ({ page }) => {
    await expect(page.locator("#btn-view-graph")).toHaveText("Graph");
    await page.click("#btn-view-console");
    // The first strip-group label is INPUTS (the rack's SENDS label stays English).
    await expect(page.locator(".con-grouplabel").first()).toHaveText("INPUTS");
    // The console's own localized string is the power LED's accessible name — the
    // strip's visible text is device wording, which every language repeats verbatim.
    // The PRE tooltip used to stand in for this and can no longer: `Pre-fader send`
    // is one of the five product terms the Japanese UI keeps in English, so the two
    // sides of the switch became the same bytes and the assertion stopped proving
    // that the console re-rendered at all. It is kept as the terminology pin instead.
    await expect(page.locator(".con-scribble.power").first()).toHaveAttribute("aria-label", /on\/off$/);
    await expect(page.locator(".con-slp").first()).toHaveAttribute("title", "Pre-fader send");

    // The language dropdown lives in Preferences; picking 日本語 re-localizes the
    // open modal itself, the toolbar (static i18n), and the rendered console.
    await page.click("#btn-prefs");
    await expect(page.locator("#prefs-lang")).toHaveValue("en");
    await chooseOption(page.locator("#prefs-lang"), "ja");
    await expect(page.locator("#prefs-title")).toHaveText("環境設定");
    await expect(page.locator("#prefs-lang")).toHaveValue("ja");
    await page.click("#prefs-modal .consent-btn-secondary");

    await expect(page.locator("#btn-view-graph")).toHaveText("グラフ");
    await expect(page.locator("#btn-hide-unused")).toHaveText("未接続を隠す");
    // The console re-rendered: its own string followed the language …
    await expect(page.locator(".con-scribble.power").first()).toHaveAttribute("aria-label", /オン\/オフ$/);
    // … while the product term did not, in the same rack, at the same moment.
    await expect(page.locator(".con-slp").first()).toHaveAttribute("title", "Pre-fader send");
    // The separators do not follow the language: vertical writing mode makes a
    // full-width glyph move the rack's geometry, so they stay English everywhere.
    await expect(page.locator(".con-grouplabel").first()).toHaveText("INPUTS");
  });

  test("an open selection survives a language switch with the inspector intact", async ({ page }) => {
    await page.locator('g.node[data-id="ch1"]').click();
    const params = await page.locator("#inspector .param").count();
    expect(params).toBeGreaterThan(0);
    await expect(page.locator("body")).toHaveClass(/has-selection/);

    await pickPref(page, "#prefs-lang", "ja");

    // The inspector re-renders in the new language but keeps the same selection
    // (param rows preserved, mobile bottom-sheet flag still set).
    await expect(page.locator("#inspector .param")).toHaveCount(params);
    await expect(page.locator("body")).toHaveClass(/has-selection/);
  });
});

test.describe("canvas hit-test", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("urx-lang", "en");
      localStorage.setItem("urx-theme", "dark");
      localStorage.setItem("urx-seed", "empty");
    });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  test("a legal connection still lands after zooming the canvas in", async ({ page }) => {
    const base = await wires(page).count();
    const svg = page.locator("#graph-host svg");
    const bb = await svg.boundingBox();
    if (!bb) throw new Error("no svg box");

    // Wheel-zoom in at the canvas centre, then draw a known-legal wire. The port
    // boundingBox is read after the zoom, so a correct hit-test still commits it.
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.mouse.wheel(0, -300);
    await connect(page, "in.micline_1_2:out", "ch_5_6:in");

    await expect(wires(page)).toHaveCount(base + 1);
    await expect(page.locator("#statusbar")).toHaveText("Connected");
  });
});

// The three focus vocabularies, each where it is read: the amber ring on an ordinary
// ground, and on a lit amber face an inset ring in the face's own ink. A pin per surface
// that wears the third one, because the rule names each by selector and a surface the
// list misses keeps the amber ring on amber, which changes no pixel.
test.describe("focus ring", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("urx-lang", "en");
      localStorage.setItem("urx-theme", "dark");
      localStorage.setItem("urx-model", "URX44V");
    });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  });

  /** Focus a control the way a keyboard does, so `:focus-visible` is what matches. */
  const keyboardFocus = async (page: Page, target: Locator) => {
    await page.keyboard.press("Shift");
    await target.focus();
    expect(await target.evaluate((el) => el.matches(":focus-visible")), "the premise: a keyboard focus").toBe(true);
  };
  const ring = (target: Locator) =>
    target.evaluate((el) => {
      const s = getComputedStyle(el);
      return { style: s.outlineStyle, color: s.outlineColor, offset: s.outlineOffset, face: s.backgroundColor };
    });

  test("a lit chip's ring is drawn in the face's ink, not the accent the face is lit in", async ({ page }) => {
    await page.click("#btn-view-console");
    const chip = page
      .locator(".con-strip", { has: page.getByText("CH 1", { exact: true }) })
      .locator(".con-chip", { hasText: /^EQ$/ })
      .first();
    await expect(chip).toHaveClass(/\bon\b/);
    await keyboardFocus(page, chip);
    const r = await ring(chip);
    expect(r.style).toBe("solid");
    expect(r.face).toBe(await colorToken(page, "--led-face"));
    expect(r.color).toBe(await colorToken(page, "--on-accent-ink"));
  });

  test("the selected swatch's ring moves out and lights when it takes focus", async ({ page }) => {
    await page.locator('#graph-host g.node[data-id="ch1"]').click();
    const sel = page.locator("#inspector .swatch.sel");
    await expect(sel).toHaveCount(1);
    const idle = await ring(sel);
    await keyboardFocus(page, sel);
    const focused = await ring(sel);
    expect(focused.color).toBe(await colorToken(page, "--led"));
    expect(focused.color).not.toBe(idle.color);
    expect(parseFloat(focused.offset)).toBeGreaterThan(parseFloat(idle.offset));
  });

  test("a checked menu item takes an inset ring, since its rail is already lit", async ({ page }) => {
    await page.click("#btn-view");
    await page.click("#btn-hide-off");
    await page.locator("#btn-view").focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowUp");
    const item = page.locator("#btn-hide-off");
    await expect(item).toBeFocused();
    await expect(item).toHaveAttribute("aria-checked", "true");
    const r = await ring(item);
    expect(r.style).toBe("solid");
    expect(r.color).toBe(await colorToken(page, "--led"));
    expect(parseFloat(r.offset)).toBeLessThan(0);
  });
});

test.describe("toolbar", () => {
  test("the brand is the logo alone (no tagline, no meter decoration)", async ({ page }) => {
    // The brand block is static markup untouched by i18n / model state, so no
    // localStorage pinning is needed.
    await page.goto("/");
    await expect(page.locator(".brand .word")).toHaveText("URX·ROUTER");
    await expect(page.locator(".brand .meta")).toHaveCount(0);
    await expect(page.locator(".brand .seg")).toHaveCount(0);
  });

  // The rack's select recipe named the model picker by id, so the rate picker beside
  // it — same wrapper class, one control away — was never reached and wore the UA's
  // own menulist: measured at 11px system-ui in WebKit and 13.3px Arial with square
  // corners in Chromium, against the picker's 12px --mono. Pinned as an equality
  // between the two rather than as values, so it holds through a token change and
  // fails the moment one of them drops off the recipe again.
  test("both rack pickers wear one face", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#model-picker")).toBeVisible();
    const face = (id: string) =>
      page.locator(`select#${id}`).evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          fontFamily: cs.fontFamily,
          fontSize: cs.fontSize,
          color: cs.color,
          backgroundColor: cs.backgroundColor,
          border: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`,
          borderRadius: cs.borderTopLeftRadius,
          padding: cs.padding,
          cursor: cs.cursor,
        };
      });
    expect(await face("rate-picker")).toEqual(await face("model-picker"));
    // The equality alone would also hold if the recipe vanished and BOTH fell back to
    // the UA's menulist, so one value is anchored: the face is the theme's control
    // ground, resolved on the page rather than spelled out as a literal.
    expect((await face("model-picker")).backgroundColor).toBe(await colorToken(page, "--ctl-bg"));
  });

  // At phone width the breakpoint gives the rack and the inspector a 40px touch target,
  // and a select takes it only as a height: WebKit keeps a styled select at the
  // platform's own height whatever min-height says. The count is part of the check, so
  // a run that found no inspector select cannot pass on an empty loop.
  test("at phone width the rack and inspector selects take the 40px touch target @webkit", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem("urx-model", "URX44V"));
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await page.locator('#graph-host g.node[data-id="ch1"]').click();
    await expect(page.locator("#inspector select").first()).toBeVisible();
    const heights = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLSelectElement>(".model-select select, #inspector select")]
        .filter((el) => el.getClientRects().length > 0)
        .map((el) => ({
          id: el.id || (el.closest<HTMLElement>(".param")?.dataset.paramLabel ?? "an inspector select"),
          h: el.getBoundingClientRect().height,
        })),
    );
    expect(heights.filter((s) => s.id === "model-picker" || s.id === "rate-picker")).toHaveLength(2);
    expect(heights.length, "the inspector shows a select").toBeGreaterThan(2);
    for (const s of heights) expect(s.h, `${s.id} is a 40px target`).toBeGreaterThanOrEqual(40);
  });

  // The pressed view tab is white on a purple face. The dark theme's rail purple is a
  // mid-tone, so the tab takes a darker shade of the same hue there; the light theme's
  // rail colour already carries white.
  for (const theme of ["dark", "light"] as const) {
    test(`the pressed view tab's label clears AA in the ${theme} theme`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem("urx-theme", t), theme);
      await page.goto("/");
      const tab = page.locator("#btn-view-graph");
      await expect(tab).toHaveAttribute("aria-pressed", "true");
      const { ink, face } = await tab.evaluate((el) => {
        const s = getComputedStyle(el);
        return { ink: s.color, face: s.backgroundColor };
      });
      const rail = await colorToken(page, "--rail-channel");
      if (theme === "light") expect(face).toBe(rail);
      else expect(face).not.toBe(rail);
      expect(await contrastRatio(page, ink, face)).toBeGreaterThanOrEqual(4.5);
    });
  }

  // The View menu's two toggles are checkbox items with one label each: the state is
  // aria-checked, and the pressed look is keyed on it, so a checked toggle prints in the
  // accent ink while its label stays what it was.
  test("a checked View toggle keeps its label and wears the pressed look", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("urx-lang", "en"));
    await page.goto("/");
    const toggle = page.locator("#btn-hide-off");
    const ink = () => toggle.evaluate((el) => getComputedStyle(el).color);
    await page.click("#btn-view");
    await expect(toggle).toHaveAttribute("role", "menuitemcheckbox");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).toHaveText("Hide off sends");
    const accent = await colorToken(page, "--led-ink");
    expect(await ink()).not.toBe(accent);

    await toggle.click();
    await page.click("#btn-view");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(toggle).toHaveText("Hide off sends");
    expect(await ink()).toBe(accent);
  });

  // The Device menu only shows under the Tauri shell; stub the bridge so its
  // grouping is testable in the browser.
  async function gotoWithDeviceMenu(page: Page, experimental: boolean): Promise<void> {
    await stubTauriBoot(page, { experimental_enabled: experimental });
    await page.goto("/");
    await expect(page.locator("#model-picker")).toHaveValue("URX44V");
    await page.click("#btn-device");
    await expect(page.locator("#btn-fetch")).toBeVisible(); // the menu is open
  }

  test("the device menu groups live sync, transfers, MIDI, and the experimental self-test", async ({ page }) => {
    await gotoWithDeviceMenu(page, true);
    await expect(page.locator("#btn-midi")).toBeVisible();
    await expect(page.locator("#btn-selftest")).toBeVisible();
    await expect(page.locator("#device-menu .menu-sep[data-experimental-only]")).toBeVisible();
  });

  test("without --experimental MIDI stays but the self-test hides with its separator", async ({ page }) => {
    await gotoWithDeviceMenu(page, false);
    await expect(page.locator("#btn-midi")).toBeVisible();
    await expect(page.locator("#btn-selftest")).toBeHidden();
    await expect(page.locator("#device-menu .menu-sep[data-experimental-only]")).toBeHidden();
  });
});
