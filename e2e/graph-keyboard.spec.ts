import { test, expect, colorToken, type Page } from "./fixtures";

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
  await expect(page.locator("#inspector h2").first()).toHaveText((await node(page, first).getAttribute("aria-label"))!);
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
