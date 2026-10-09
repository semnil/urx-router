import { test, expect, type Page } from "./fixtures";

// A node is a g.node carrying its id; its on-canvas position is the g transform.
const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

// A fresh board's default positions must already equal the Arrange (auto-layout)
// result, so pressing Arrange on an untouched plan moves nothing. The channel
// column is the telling case: each stereo channel reserves a row for its hung
// ducker, and the snap-to-grid layout must reserve exactly the same row.
test("Arrange leaves a fresh plan's nodes exactly where they are", async ({ page }) => {
  const ids = [
    "in.aux",
    "ch1",
    "ch_5_6",
    "ch_11_12", // last channel, after every ducker-reserved row — the most drift-prone
    "out.ducker4", // a hung ducker
    "bus.stereo",
    "bus.mix2",
    "bus.stream", // derived-bus column
    "out.main",
  ];
  const before: Record<string, string | null> = {};
  for (const id of ids) before[id] = await node(page, id).getAttribute("transform");

  await page.click("#btn-view");
  await page.click("#btn-auto");

  for (const id of ids) {
    expect(await node(page, id).getAttribute("transform"), id).toBe(before[id]);
  }
});

// Arrange packs CH 3 into the row CH 2 had while CH 2 is on the shelf. Show all brings CH 2 to
// the foot of the channel column rather than back onto CH 3.
test("Show all after Arrange puts no node on top of another", async ({ page }) => {
  await node(page, "ch2").click();
  await page.locator("#inspector button.subtle").click();
  await expect(node(page, "ch2")).toHaveCount(0);
  await page.click("#btn-view");
  await page.click("#btn-auto");
  await page.locator(".hidden-shelf .shelf-showall").click();
  await expect(node(page, "ch2")).toHaveCount(1);
  expect(await node(page, "ch2").getAttribute("transform")).not.toBe(await node(page, "ch3").getAttribute("transform"));
  expect(await overlaps(page)).toEqual([]);
});

// DUCKER 1 hangs from CH 5/6 and takes its place from it, so with it on the shelf Arrange gives
// its row to CH 7/8, and Show all would bring it back onto CH 7/8. Its parent moves with it.
test("Show all after Arrange brings a hung ducker back clear of the node below its parent", async ({ page }) => {
  await node(page, "out.ducker1").click();
  await page.locator("#inspector button.subtle").click();
  await expect(node(page, "out.ducker1")).toHaveCount(0);
  await page.click("#btn-view");
  await page.click("#btn-auto");
  const parentBefore = await node(page, "ch_5_6").getAttribute("transform");
  await page.locator(".hidden-shelf .shelf-showall").click();
  await expect(node(page, "out.ducker1")).toHaveCount(1);
  expect(await overlaps(page)).toEqual([]);
  expect(await node(page, "ch_5_6").getAttribute("transform")).not.toBe(parentBefore);
});

/** Every pair of drawn node frames that overlap by more than half a pixel. */
async function overlaps(page: Page): Promise<string[]> {
  const boxes = await page.locator("#graph-host g.node").evaluateAll((gs) =>
    gs.map((g) => {
      const r = g.querySelector("rect")!.getBoundingClientRect();
      return { id: (g as SVGGElement).dataset.id, x: r.x, y: r.y, r: r.right, b: r.bottom };
    }),
  );
  return boxes.flatMap((a, i) =>
    boxes
      .slice(i + 1)
      .filter((b) => a.x < b.r - 0.5 && b.x < a.r - 0.5 && a.y < b.b - 0.5 && b.y < a.b - 0.5)
      .map((b) => `${a.id} x ${b.id}`),
  );
}
