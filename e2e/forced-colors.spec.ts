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

  // The knob pointer is a 2x11 element rotated by --rot and painted with the
  // accent. Painted, it becomes the same black as the knob face it sits on; as
  // an outline of the same geometry it stays readable.
  const pointer = page.locator(".con-knob .ind").first();
  await expect(pointer).toBeVisible();

  await page.emulateMedia({ forcedColors: "active" });

  const shape = await pointer.evaluate((node) => {
    const s = getComputedStyle(node);
    return { border: s.borderTopStyle, image: s.backgroundImage };
  });
  expect(shape.border).toBe("solid");
  expect(shape.image).toBe("none");
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
// backplate behaves the same way, and how `3px double` actually renders are all
// unverified against real Windows high contrast — which is why the assertions
// above avoid every one of those three. What they do pin is that the app asks
// for the rim and the islands at all, which is the half that can regress here.
