import { test, expect, type Page } from "@playwright/test";

// A muted node (CH_ON off) reads as inactive: the faceplate dims and every fixed
// send bound to it recedes — the same off-send treatment a bypassed ducker's key
// wire gets, now uniform across every node kind. Channel ON also leads the
// inspector parameters (top of the group) like the bus / FX / MONITOR toggles.
const CH = "ch1";
const chNode = (page: Page) => page.locator(`#graph-host g.node[data-id="${CH}"]`);
// The painted wire path lives beside the transparent .wire-hit band in the same g.
const stereoSend = (page: Page) =>
  page.locator(`#graph-host g:has(> .wire-hit[data-from="ch1:out"][data-to="bus.stereo:in"]) path:not(.wire-hit)`);
const channelOn = (page: Page) =>
  page
    .locator("#inspector .param")
    .filter({ has: page.locator(".toggle") })
    .filter({ hasText: "Channel" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    // Empty board: factory-seed sends do not perturb the resting wire styles.
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("muting a channel dims the node and its outgoing send wire", async ({ page }) => {
  // An active channel's fixed CH -> STEREO send rests at the on-send style.
  await expect(stereoSend(page)).toHaveAttribute("opacity", "0.85");

  await chNode(page).click();
  // Channel ON is the first parameter in the inspector now.
  await channelOn(page).getByRole("button", { name: "OFF", exact: true }).click();

  // The faceplate dims immediately, without a re-render trigger.
  await expect(chNode(page)).toHaveAttribute("opacity", "0.4");

  // Deselect so the send drops its selection highlight and shows the off-send
  // style: dimmed and finely dotted, behind the live wires.
  await page.keyboard.press("Escape");
  await expect(stereoSend(page)).toHaveAttribute("opacity", "0.3");
  await expect(stereoSend(page)).toHaveAttribute("stroke-dasharray", "1.5 4");
});

test("Channel ON leads the channel inspector", async ({ page }) => {
  await chNode(page).click();
  // The first parameter row that carries an ON/OFF toggle is Channel ON.
  const firstToggle = page.locator("#inspector .param").filter({ has: page.locator(".toggle") }).first();
  await expect(firstToggle).toContainText("Channel");
});

test("re-enabling a muted channel restores the lit node and send style", async ({ page }) => {
  // ON -> OFF -> ON must round-trip back to the resting on-send style, not leave
  // a node stuck dim or a wire stuck dotted (state-transition completeness).
  await chNode(page).click();
  await channelOn(page).getByRole("button", { name: "OFF", exact: true }).click();
  await expect(chNode(page)).toHaveAttribute("opacity", "0.4");

  await channelOn(page).getByRole("button", { name: "ON", exact: true }).click();
  await expect(chNode(page)).not.toHaveAttribute("opacity", "0.4");

  await page.keyboard.press("Escape");
  // The send returns to the full on-send opacity with no leftover off-dash.
  await expect(stereoSend(page)).toHaveAttribute("opacity", "0.85");
  await expect(stereoSend(page)).not.toHaveAttribute("stroke-dasharray", "1.5 4");
});

test("two muted channels both dim while a third stays lit", async ({ page }) => {
  // Mixed on/off across nodes: muting ch1 and ch2 must dim each of their sends
  // independently and leave ch3's send untouched (no global recolor).
  const otherSend = (from: string) =>
    page.locator(`#graph-host g:has(> .wire-hit[data-from="${from}"][data-to="bus.stereo:in"]) path:not(.wire-hit)`);

  for (const id of ["ch1", "ch2"]) {
    await page.locator(`#graph-host g.node[data-id="${id}"]`).click();
    await channelOn(page).getByRole("button", { name: "OFF", exact: true }).click();
  }
  await page.keyboard.press("Escape");

  await expect(otherSend("ch1:out")).toHaveAttribute("opacity", "0.3");
  await expect(otherSend("ch2:out")).toHaveAttribute("opacity", "0.3");
  // ch3 was never muted: its send stays at the on-send opacity.
  await expect(otherSend("ch3:out")).toHaveAttribute("opacity", "0.85");
});
