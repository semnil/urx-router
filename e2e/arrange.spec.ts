import { test, expect, type Page } from "@playwright/test";

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
