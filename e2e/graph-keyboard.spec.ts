import { test, expect, colorToken, type Page } from "./fixtures";
import { chooseOption } from "./choose-option";
import { wire } from "./graph-helpers";

// The node graph from the keyboard alone: one node of the board is in the tab order, Enter
// selects it as a press does, the arrow keys walk the board, and the focused node wears the
// amber ring drawn as an SVG stroke around its panel.
const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const focusedId = (page: Page): Promise<string | null> =>
  page.evaluate(() => (document.activeElement as SVGGElement | null)?.dataset?.id ?? null);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

/** Tab from the top of the page until focus lands on a board node; that node's id. */
async function tabToBoard(page: Page): Promise<string> {
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    const id = await focusedId(page);
    if (id) return id;
  }
  throw new Error("Tab never reached the board");
}

test("Tab reaches the board, and Enter selects the node it reached", async ({ page }) => {
  const first = await tabToBoard(page);
  await expect(page.locator("#graph-host svg")).toHaveAttribute("role", "group");
  await expect(node(page, first)).toHaveAttribute("role", "button");
  await expect(node(page, first)).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Enter");
  await expect(node(page, first)).toHaveAttribute("aria-pressed", "true");
  // The panel's title is announced as the node is: the same name, marks read the same way.
  await expect(page.locator("#inspector h2").first()).toHaveAccessibleName(
    (await node(page, first).getAttribute("aria-label"))!,
  );
  expect(await focusedId(page)).toBe(first);
});

test("the arrow keys walk the board, and the ring follows the focus", async ({ page }) => {
  const first = await tabToBoard(page);
  await page.keyboard.press("ArrowDown");
  const second = await focusedId(page);
  expect(second).not.toBeNull();
  expect(second).not.toBe(first);
  await expect(node(page, second!)).toHaveAttribute("tabindex", "0");
  await expect(node(page, first)).toHaveAttribute("tabindex", "-1");
  const ring = (id: string) => node(page, id).locator(":scope > .focus-ring");
  await expect(ring(second!)).toHaveCSS("stroke", await colorToken(page, "--led"));
  await expect(ring(first)).toHaveCSS("stroke", "none");
  await page.keyboard.press("ArrowUp");
  expect(await focusedId(page)).toBe(first);
});

// A press selects the node, and the next Tab into the board lands on it.
test("a node selected with the pointer is the board's tab stop", async ({ page }) => {
  await node(page, "bus.mix1").click();
  await expect(node(page, "bus.mix1")).toHaveAttribute("tabindex", "0");
  await expect(page.locator('#graph-host g.node[tabindex="0"]')).toHaveCount(1);
});

// Wiring without a drag: a node's Routing section offers each jack's targets, and choosing
// one draws the wire through the board's own commit — so STREAMING, which never goes without
// a source, takes the new one in place of the old. Focus stays on the picker.
test("the Inspector connects a wire from the keyboard, replacing STREAMING's source", async ({ page }) => {
  await node(page, "bus.mix2").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#inspector h2").first()).toHaveText("MIX 2");
  const routing = page.locator("#inspector details.insp-section", {
    has: page.locator("summary", { hasText: "Routing" }),
  });
  await routing.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(routing).toHaveJSProperty("open", true);
  const picker = routing.locator(".param", { hasText: "Connect the output to" }).locator("select");
  await picker.focus();
  // From the pick on, each focus change and each time the inspector's contents are replaced,
  // printed when the focus assertion fails: where focus went, and after how many rebuilds.
  await page.evaluate(() => {
    const log: string[] = [];
    const t0 = performance.now();
    const say = (s: string) => log.push(`${(performance.now() - t0).toFixed(0)} ms ${s}`);
    const name = (n: EventTarget | null) =>
      n instanceof Element
        ? `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ""}${n.getAttribute("data-focus-key") ? `[${n.getAttribute("data-focus-key")}]` : ""}`
        : String(n);
    (window as unknown as { __focusLog: { log: string[]; name: typeof name } }).__focusLog = { log, name };
    document.addEventListener("focusin", (e) => say(`focusin ${name(e.target)}`), true);
    document.addEventListener("focusout", (e) => say(`focusout ${name(e.target)} → ${name(e.relatedTarget)}`), true);
    new MutationObserver((records) => {
      const removed = records.reduce((n, r) => n + r.removedNodes.length, 0);
      if (removed) say(`inspector rebuilt (${removed} removed)`);
    }).observe(document.getElementById("inspector")!, { childList: true, subtree: true });
  });
  await chooseOption(picker, { value: "bus.stream:in" });
  await expect(wire(page, "bus.mix2:out", "bus.stream:in")).toHaveCount(1);
  await expect(wire(page, "bus.stereo:out", "bus.stream:in")).toHaveCount(0);
  try {
    await expect(
      page.locator("#inspector .param", { hasText: "Connect the output to" }).locator("select"),
    ).toBeFocused();
  } catch (e) {
    const record = await page.evaluate(() => {
      const { log, name } = (
        window as unknown as { __focusLog: { log: string[]; name: (n: EventTarget | null) => string } }
      ).__focusLog;
      return { active: name(document.activeElement), log };
    });
    console.log(`focus after the pick: ${record.active}\n  ${record.log.join("\n  ")}`);
    throw e;
  }
});

// Disconnecting: a drawn wire's Routing row selects it, focus moves into its panel, and the
// panel's delete removes it.
test("the Inspector selects and deletes a wire from the keyboard", async ({ page }) => {
  await node(page, "ch1").focus();
  await page.keyboard.press("Enter");
  const routing = page.locator("#inspector details.insp-section", {
    has: page.locator("summary", { hasText: "Routing" }),
  });
  await routing.locator("summary").focus();
  await page.keyboard.press("Enter");
  const row = routing.locator("button.conn-row", { hasText: "MIC/LINE 1/2" });
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#inspector h2").first()).toHaveText("Connection");
  await expect(page.locator("#inspector")).toContainText("MIC/LINE 1/2");
  await expect(page.locator("#inspector :focus")).toHaveCount(1);
  const del = page.getByRole("button", { name: "Delete this connection" });
  await del.focus();
  await page.keyboard.press("Enter");
  await expect(wire(page, "in.micline_1_2:out", "ch1:in")).toHaveCount(0);
});

// Restoring from a chip with Enter takes that chip away: focus goes to the chip that took its
// place, and from the last one to the node it brought back.
test("restoring shelved nodes from the keyboard keeps the focus on the shelf, then on the node", async ({ page }) => {
  for (const id of ["ch1", "ch3"]) {
    await node(page, id).click();
    await page.locator("#inspector button.subtle").click();
  }
  const chip = (id: string) => page.locator(`.hidden-shelf button.chip[data-node="${id}"]`);
  await chip("ch1").focus();
  await page.keyboard.press("Enter");
  await expect(chip("ch3")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(node(page, "ch3")).toBeFocused();
});
