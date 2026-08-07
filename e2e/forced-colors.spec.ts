import { test, expect, type Page } from "@playwright/test";

// Windows high contrast (`forced-colors: active`). Chromium only, which the app
// tier already is — WebView2 is the engine that ships, and its own answer is not
// reachable from here (see the note at the end).
//
// What this pins is the class of defect the mode produces: the system palette
// replaces every background and every text colour, so a control whose ONLY tell
// is a colour stops being a control. Measured before the CSS block existed: the
// default board's 51 lit chips and 73 unlit ones all computed to `rgb(0, 0, 0)`
// — one black rectangle each, no way to tell an engaged control from an idle
// one. `box-shadow` is removed by the spec, so the inset bar that used to mark
// them was gone too.
//
// Only two things survive the mode: `border` / `outline`, and an island opted
// out with `forced-color-adjust: none`. The assertions below are those two, and
// they are written as DIFFERENCES rather than as absolute values — the system
// colours are the OS theme's, not ours (in the theme these numbers came from,
// `GrayText` is a bright green), so asserting a specific colour would pin the
// tester's Windows settings instead of the app's behaviour.

const strip = (page: Page, name: string) => page.locator(".con-strip", { has: page.getByText(name, { exact: true }) });

// One part, drawn as an outline rather than as a fill. The fill has to be GONE
// and not merely a different colour: a background the mode has forced to Canvas
// is exactly the invisible case this pins against, and it reports the Canvas RGB
// with a zero alpha once the rule removes it.
const expectOutlined = async (page: Page, { selector, pseudo }: { selector: string; pseudo?: string }) => {
  const shape = await page
    .locator(selector)
    .first()
    .evaluate((node, p) => {
      const s = getComputedStyle(node, p ?? null);
      return {
        border: s.borderTopStyle,
        width: parseFloat(s.borderTopWidth),
        background: s.backgroundColor,
        image: s.backgroundImage,
      };
    }, pseudo);
  expect(shape.border, selector).toBe("solid");
  // Non-zero rather than "at least 1": a 1px border is snapped to the device pixel
  // grid and reported as its USED width, so the same rule computes to 0.8px at a
  // device pixel ratio of 1.25 — measured in WebView2 on a 125% display. This
  // suite always runs at dpr 1, which is exactly why the stricter form would have
  // gone on passing while encoding an assumption it never states.
  expect(shape.width, selector).toBeGreaterThan(0);
  expect(shape.image, selector).toBe("none");
  expect(shape.background, selector).toMatch(/, 0\)$/);
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-model", "URX44V");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("an engaged control stays distinguishable from an idle one in forced colors", async ({ page }) => {
  await page.click("#btn-view-console");
  await expect(page.locator("#console-host")).toBeVisible();

  // CH 1's MUTE chip is idle on the factory plan and its EQ chip is engaged, so
  // one strip carries both states and the comparison needs no edit to set up.
  const engaged = strip(page, "CH 1").locator(".con-chip", { hasText: /^EQ$/ }).first();
  const idle = strip(page, "CH 1").locator(".con-chip", { hasText: "MUTE" }).first();
  await expect(engaged).toHaveClass(/\bon\b/);
  await expect(idle).not.toHaveClass(/\bon\b/);

  const rim = (el: typeof engaged) =>
    el.evaluate((node) => {
      const s = getComputedStyle(node);
      return { style: s.borderTopStyle, width: s.borderTopWidth, background: s.backgroundColor };
    });

  await page.emulateMedia({ forcedColors: "active" });

  const on = await rim(engaged);
  const off = await rim(idle);
  // The rim is the whole tell: a double border is the one weight the system
  // palette cannot flatten into its neighbours.
  expect(on.style).toBe("double");
  expect(parseFloat(on.width)).toBeGreaterThanOrEqual(3);
  expect(off.style).not.toBe("double");
  // And the reason it has to be the rim: the two backgrounds are the same colour
  // in this mode. If this ever stops being true the assertion above is still
  // correct, but the justification in the CSS comment has moved.
  expect(on.background).toBe(off.background);
});

test("a position indicator survives as a shape, not as a fill", async ({ page }) => {
  await page.click("#btn-view-console");
  await expect(page.locator("#console-host")).toBeVisible();

  // Every part of a fader whose whole job is to mark a position or a path: the
  // knob pointer, the cap's bar, the 0-dB line and the slot the cap rides in.
  // Painted, each is a fill on a fill and becomes the same colour as what it sits
  // on; as an outline of the same geometry each stays readable.
  //
  // The mini-fader (.con-vfad) is listed beside the fader deliberately. It shares
  // the fader's groove / cap / 0-dB grammar by convention and not by selector, so
  // the first version of the CSS block reached only .con-fader and the mini-fader
  // silently lost its 0-dB line and its cap bar — found on real Windows high
  // contrast, invisible to this suite until these rows existed.
  const parts: { selector: string; pseudo?: string }[] = [
    { selector: ".con-knob .ind" },
    { selector: ".con-fader .cap", pseudo: "::after" },
    { selector: ".con-vfad .cap", pseudo: "::after" },
    { selector: ".con-fader .zero" },
    { selector: ".con-vfad .zero" },
    { selector: ".con-fader .track" },
    { selector: ".con-vfad .track" },
  ];
  for (const { selector } of parts) await expect(page.locator(selector).first()).toBeAttached();

  await page.emulateMedia({ forcedColors: "active" });

  for (const part of parts) await expectOutlined(page, part);
});

test("the parts stay outlines in a send column that has been switched off", async ({ page }) => {
  await page.click("#btn-view-console");
  await expect(page.locator("#console-host")).toBeVisible();

  // An OFF send column repaints the mini-fader's bar with its own dim fill, under
  // a selector one class longer than the forced-colors rule — and a media query
  // adds no specificity, so the longer one wins. Every locator in the test above
  // lands on an ON column in the factory plan, which is why the state has to be
  // driven here rather than assumed: measured, the OFF column kept a filled bar
  // while every other column had an outline.
  const col = page.locator(".con-scol").first();
  await expect(col).not.toHaveClass(/\boff\b/);
  await col.locator(".con-sl").first().click();
  await expect(col).toHaveClass(/\boff\b/);

  await page.emulateMedia({ forcedColors: "active" });

  await expectOutlined(page, { selector: ".con-scol.off .con-vfad .cap", pseudo: "::after" });
  await expectOutlined(page, { selector: ".con-scol.off .con-vfad .track" });
  await expectOutlined(page, { selector: ".con-scol.off .con-vfad .zero" });
});

test("the surfaces where the colour IS the reading are opted out", async ({ page }) => {
  // The scribble's device colour, the meters' green/yellow/red zones and the
  // board's whole vocabulary of wires and rails carry information IN the colour.
  // Forcing them to two system colours would not raise contrast, it would delete
  // the reading — so each is an island, and the board additionally gets a rim so
  // it still has an edge against the forced background.
  await page.emulateMedia({ forcedColors: "active" });

  const board = await page.locator("#graph-host").evaluate((node) => getComputedStyle(node).forcedColorAdjust);
  expect(board).toBe("none");

  await page.click("#btn-view-console");
  await expect(page.locator("#console-host")).toBeVisible();
  for (const selector of [".con-scribble", ".con-meter", ".mtrcol"]) {
    const value = await page
      .locator(selector)
      .first()
      .evaluate((node) => getComputedStyle(node).forcedColorAdjust);
    expect(value, selector).toBe("none");
  }
});

// Not covered here, and not coverable here: this is Chromium's emulation of the
// mode, not WebView2's. The system colour VALUES, whether the opaque text
// backplate behaves the same way, and how `3px double` actually renders were all
// measured separately against real Windows high contrast (2026-08-07, WebView2
// under a contrast theme) and all three held — which is why the assertions above
// still avoid every one of those three. Pinning a value here would pin the
// tester's Windows settings instead of the app's behaviour. What they do pin is
// that the app asks for the rim, the outlines and the islands at all, which is
// the half that can regress here.
//
// What that measurement also showed is the shape of the defect this file cannot
// see by itself: a rule that reaches one of two elements sharing a visual
// grammar. Prefer adding a row to the tables above over adding a test.
