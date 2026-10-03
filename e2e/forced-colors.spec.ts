import { test, expect, type Locator, type Page } from "./fixtures";
import { LIVE_COMMANDS, stubTauriDevice } from "./tauri-stub";

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

/** Open CH 1's GATE tuning screen — the shortest route to a `.gt-slot` meter lane and
 *  to a `.dev-slider` parameter row, the two surfaces the console does not carry. */
const openGate = async (page: Page) => {
  await page.locator('#graph-host g.node[data-id="ch1"]').click();
  const sec = page.locator("#inspector .insp-section", { has: page.locator("summary", { hasText: /^GATE$/ }) });
  if (!(await sec.evaluate((el) => (el as HTMLDetailsElement).open))) await sec.locator("summary").click();
  await sec.locator("#btn-gate-screen").click();
  await expect(page.locator("#dyn-screen-box")).toBeVisible();
};

/** The computed style of a range input's two shadow parts, read over the DevTools
 *  protocol. `getComputedStyle(input, "::-webkit-slider-runnable-track")` answers
 *  `0px none` for these pseudo elements; the input's user-agent shadow tree carries
 *  them as `#track` and `#thumb`, and those nodes hold the values that won. */
const sliderParts = async (page: Page, input: Locator) => {
  type DomNode = { nodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };
  const attr = (n: DomNode, name: string) => {
    const a = n.attributes ?? [];
    for (let i = 0; i < a.length; i += 2) if (a[i] === name) return a[i + 1];
    return undefined;
  };
  const find = (n: DomNode, hit: (n: DomNode) => boolean): DomNode | undefined => {
    if (hit(n)) return n;
    for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) {
      const found = find(c, hit);
      if (found) return found;
    }
    return undefined;
  };
  await input.evaluate((el) => el.setAttribute("data-slider-parts", ""));
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: DomNode };
    await cdp.send("CSS.enable");
    const host = find(root, (n) => attr(n, "data-slider-parts") !== undefined);
    if (!host) throw new Error("the range input is not in the document the protocol returned");
    const style = async (id: string) => {
      const part = find(host, (n) => attr(n, "id") === id);
      if (!part) throw new Error(`no #${id} in the range input's shadow tree`);
      const { computedStyle } = await cdp.send("CSS.getComputedStyleForNode", { nodeId: part.nodeId });
      return Object.fromEntries(computedStyle.map((p) => [p.name, p.value]));
    };
    return { track: await style("track"), thumb: await style("thumb") };
  } finally {
    await cdp.detach();
  }
};

/** An element's painted pixels, row-major, each as an "r,g,b" key.
 *
 *  What these answer is what no declaration states: which of two painted parts ends up
 *  on top. The slider case reads its declarations through `sliderParts` and its
 *  layering from here. */
const pixels = async (page: Page, shot: Buffer): Promise<string[][]> =>
  page.evaluate(
    async (uri) => {
      const im = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = uri;
      });
      const c = document.createElement("canvas");
      c.width = im.width;
      c.height = im.height;
      const g = c.getContext("2d", { willReadFrequently: true })!;
      g.drawImage(im, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const rows: string[][] = [];
      for (let y = 0; y < c.height; y++) {
        const row: string[] = [];
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          row.push(`${d[i]},${d[i + 1]},${d[i + 2]}`);
        }
        rows.push(row);
      }
      return rows;
    },
    "data:image/png;base64," + shot.toString("base64"),
  );

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

// The engaged states the shared list did not name. Each is compared with its idle twin
// on the same surface, since the mode forces both to the same background.
test("the view tab, the INS FX popover's held row and a section's ON LED keep their state", async ({ page }) => {
  const look = (el: Locator) =>
    el.evaluate((node) => {
      const s = getComputedStyle(node);
      const r = node.getBoundingClientRect();
      return {
        border: s.borderTopStyle,
        outline: s.outlineStyle,
        background: s.backgroundColor,
        height: r.height,
      };
    });

  await page.emulateMedia({ forcedColors: "active" });
  const pressedTab = await look(page.locator("#btn-view-graph"));
  const idleTab = await look(page.locator("#btn-view-console"));
  expect(pressedTab.border).toBe("double");
  expect(idleTab.border).not.toBe("double");

  // The factory plan's CH 1 holds no insert effect, so its popover's held row is No
  // Effect, and every other row is idle.
  await page.click("#btn-view-console");
  const ch1 = strip(page, "CH 1");
  await ch1.locator(".con-ifxopen").click();
  const pop = page.locator(".con-ifxpop");
  await expect(pop).toBeVisible();
  const held = await look(pop.locator(".irow.active"));
  const idleRow = await look(pop.locator(".irow:not(.active):not(.off)").first());
  expect(held.outline).toBe("double");
  expect(idleRow.outline).not.toBe("double");
  // Drawn inside the row, so the held row is the height every other row is.
  expect(held.height).toBe(idleRow.height);
  await page.keyboard.press("Escape");

  // A section's ON LED is a dot with nothing but its fill: CH 1's EQ is on in the factory
  // plan and its GATE is off, so one inspector carries both.
  await page.click("#btn-view-graph");
  await page.locator('#graph-host g.node[data-id="ch1"]').click();
  const led = (title: string) =>
    page.locator("#inspector .insp-section summary", { hasText: new RegExp(`^${title}$`) }).locator(".sec-led");
  const on = await look(led("EQ"));
  const off = await look(led("GATE"));
  expect(on.background).not.toBe(off.background);
  expect(off.border, "the unlit LED keeps a rim").toBe("solid");
});

// The held row's state and the keyboard focus share its one outline, and the mode flattens a
// colour change: focused, the held row's rim turns dashed. Left for another row, it is double
// again, and that row's own ring is neither.
test("the INS FX popover's held row shows the keyboard focus as a dashed rim", async ({ page }) => {
  const outline = (el: Locator) => el.evaluate((node) => getComputedStyle(node).outlineStyle);
  await page.emulateMedia({ forcedColors: "active" });
  await page.click("#btn-view-console");
  const opener = strip(page, "CH 1").locator(".con-ifxopen");
  await opener.focus();
  await page.keyboard.press("Enter");
  const pop = page.locator(".con-ifxpop");
  const held = pop.locator(".irow.active");
  await expect(held, "the premise: the keyboard open puts the focus on the held row").toBeFocused();
  expect(await outline(held)).toBe("dashed");

  await page.keyboard.press("ArrowDown");
  const next = pop.locator(".irow:focus");
  await expect(next).not.toHaveClass(/\bactive\b/);
  expect(await outline(held)).toBe("double");
  expect(await outline(next)).not.toBe("dashed");
  expect(await outline(next)).not.toBe("double");

  // The positive control for the mode: outside it, the focused held row keeps the solid ring.
  await page.keyboard.press("ArrowUp");
  await expect(held).toBeFocused();
  await page.emulateMedia({ forcedColors: "none" });
  expect(await outline(held)).toBe("solid");
});

// The badge sits in the toolbar beside the rate it governs, so its state must not move
// the controls around it: the rim's extra width comes out of its padding.
test("Follow USB on keeps the badge's size and shows its state", async ({ page }) => {
  await stubTauriDevice(page, { commands: LIVE_COMMANDS, values: { 766: 48000, 848: 1 } });
  await page.goto("/");
  const badge = page.locator("#follow-usb");
  await badge.click();
  await expect(badge).toHaveAttribute("data-state", "on");
  const box = async () => {
    const r = await badge.evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { w: b.width, h: b.height, border: getComputedStyle(el).borderTopStyle };
    });
    return r;
  };
  const normal = await box();
  await page.emulateMedia({ forcedColors: "active" });
  const forced = await box();
  expect(forced.border).toBe("double");
  expect(forced.w).toBe(normal.w);
  expect(forced.h).toBe(normal.h);
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

test("the tuning-screen launcher keeps its caret, at full strength", async ({ page }) => {
  await page.locator('#graph-host g.node[data-id="ch1"]').click();
  const sec = page.locator("#inspector .insp-section", { has: page.locator("summary", { hasText: /^GATE$/ }) });
  if (!(await sec.evaluate((el) => (el as HTMLDetailsElement).open))) await sec.locator("summary").click();

  const caret = () =>
    page.locator("#btn-gate-screen").evaluate((el) => {
      const a = getComputedStyle(el, "::after");
      return { opacity: a.opacity, border: a.borderRightWidth, buttonBorder: getComputedStyle(el).borderTopStyle };
    });

  // The mark is drawn from two borders rather than a glyph or a background, which is
  // the half of this that survives at all. What does NOT survive is the reason it is
  // dimmed: in the normal themes 0.65 sets it a step below the section chevron beside
  // it, and this mode paints both of them CanvasText, so the step has nothing left to
  // encode and only costs legibility. `opacity` is not one of the properties the mode
  // replaces, so it has to be given back by hand.
  const normal = await caret();
  expect(Number(normal.opacity)).toBeLessThan(1);
  await page.emulateMedia({ forcedColors: "active" });
  const forced = await caret();
  expect(forced.opacity).toBe("1");
  expect(forced.border).toBe(normal.border);
  expect(forced.buttonBorder).toBe("solid");
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

test("a parameter slider keeps its track, and the thumb still covers it", async ({ page }) => {
  // The track is a gradient with an inset shadow — the fader groove's construction in
  // another costume, and it loses both the same way. Measured on real Windows high
  // contrast (hcblack and hcwhite, WebView2): not one pixel of it survived, so every
  // slider in the app rendered as a label, a value and a thumb floating over nothing.
  //
  // The fix is the groove's pair of rules, and the SECOND one is what this test is
  // really for: an outlined track needs the thumb to keep occluding it, because the
  // thumb's own fill is a gradient this mode drops too. Without it the track reads
  // straight through the handle.
  await openGate(page);
  const input = page.locator("#dyn-screen-box .dev-slider input[type='range']").first();
  await expect(input).toBeVisible();

  await page.emulateMedia({ forcedColors: "active" });

  // The pair of rules itself, so a failure names the declaration that went missing:
  // the track outlined, the thumb filled opaque.
  const parts = await sliderParts(page, input);
  expect(parts.track["border-top-style"], "the track is outlined").toBe("solid");
  expect(parseFloat(parts.track["border-top-width"]), "the track is outlined").toBeGreaterThan(0);
  expect(parts.thumb["background-color"], "the thumb is filled opaque").toMatch(/^rgb\(/);

  const rows = await pixels(page, await input.screenshot());
  const [h, w] = [rows.length, rows[0].length];
  // The ground is the commonest colour, not the corner pixel: the thumb can sit at
  // either end, and at the left end the corner IS the thumb.
  const tally = new Map<string, number>();
  for (const row of rows) for (const px of row) tally.set(px, (tally.get(px) ?? 0) + 1);
  const ground = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const ink = (x: number, y: number) => rows[y][x] !== ground;

  // The thumb runs nearly the full height of the control and the track is a few pixels
  // at its middle, so the only ink a quarter of the way down is the thumb — and there
  // it is its two SIDES, because the fill that occludes the track is Canvas, which is
  // the ground. That the interior reads as ground is the whole point of the rule.
  const rim = [...Array(w).keys()].filter((x) => ink(x, Math.round(h * 0.25)));
  expect(rim.length, "the thumb is drawn").toBeGreaterThanOrEqual(2);
  const [left, right] = [rim[0], rim[rim.length - 1]];
  expect(right - left, "the thumb's own width").toBeGreaterThan(6);

  // Which rows the track is on, read well clear of the thumb.
  const probeX = (left + right) / 2 > w / 2 ? Math.round(w * 0.15) : Math.round(w * 0.85);
  const trackRows = [...Array(h).keys()].filter((y) => ink(probeX, y));
  expect(trackRows.length, "the track is drawn at all").toBeGreaterThan(0);

  // ...and none of it shows through the thumb. The rim columns are excluded on either
  // side: they are the thumb's own border, which is ink by design.
  for (const y of trackRows)
    for (let x = left + 2; x <= right - 2; x++)
      expect(ink(x, y), `the track shows through the thumb at ${x},${y}`).toBe(false);
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

  // The inspector's keys to the board's colours carry them outside the board's island:
  // the empty inspector's legend, a selected node's routing list and its colour picker.
  // Each keeps a CanvasText edge, and the picker's selection and focus rings are restated
  // in system colours, which still resolve to the contrast palette inside an island.
  const fca = (l: Locator) => l.evaluate((node) => getComputedStyle(node).forcedColorAdjust);
  const legendDot = page.locator("#inspector .conn-row .dot").first();
  await expect(legendDot).toBeAttached();
  expect(await fca(legendDot), "legend dot").toBe("none");
  expect(await legendDot.evaluate((n) => getComputedStyle(n).borderTopStyle), "legend dot edge").toBe("solid");
  await page.locator('#graph-host g.node[data-id="ch1"]').click();
  const routingDot = page.locator("#inspector .conn-row .dot[class*='dot-']").first();
  await expect(routingDot).toBeAttached();
  expect(await fca(routingDot), "routing dot").toBe("none");
  const swatch = page.locator("#inspector .swatch:not(.swatch-none)").first();
  expect(await fca(swatch), "colour swatch").toBe("none");
  const system = (name: string) =>
    page.evaluate((n) => {
      const probe = document.createElement("span");
      probe.style.color = n;
      document.body.append(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    }, name);
  const canvasText = await system("CanvasText");
  expect(await swatch.evaluate((n) => getComputedStyle(n).borderTopColor), "swatch edge").toBe(canvasText);
  const sel = page.locator("#inspector .swatch.sel");
  await page.locator("#inspector .swatch:not(.swatch-none):not(.sel)").first().click();
  await expect(sel).not.toHaveClass(/swatch-none/);
  expect(await sel.evaluate((n) => getComputedStyle(n).outlineColor), "selection ring").toBe(canvasText);
  await page.keyboard.press("Shift");
  await sel.focus();
  expect(await sel.evaluate((n) => n.matches(":focus-visible")), "the premise: a keyboard focus").toBe(true);
  expect(await sel.evaluate((n) => getComputedStyle(n).outlineColor), "focus ring").toBe(await system("Highlight"));

  await page.click("#btn-view-console");
  await expect(page.locator("#console-host")).toBeVisible();
  for (const selector of [".con-scribble", ".con-meter", ".mtrcol"]) {
    const value = await page
      .locator(selector)
      .first()
      .evaluate((node) => getComputedStyle(node).forcedColorAdjust);
    expect(value, selector).toBe("none");
  }

  // The tuning screens' meter lane is the same island for the same reason, and it was
  // missed when this block was written — the two share the grammar and not the
  // selector, which is the shape of defect this file's closing note names. Measured on
  // real Windows high contrast before the rule existed: all four DUCKER lanes rendered
  // as empty outlined boxes. The level gradient and the reduction's hatch are
  // background IMAGES and the mode drops them; the shade and the peak marker are
  // background COLOURS and the mode forces them to Canvas. Not "the reduction cannot be
  // told from the level" — neither was drawn.
  await page.click("#btn-view-graph");
  await openGate(page);
  const lane = await page
    .locator("#dyn-screen-box .gt-slot")
    .first()
    .evaluate((node) => getComputedStyle(node).forcedColorAdjust);
  expect(lane, ".gt-slot").toBe("none");
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
