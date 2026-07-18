import { test, expect, type Page } from "@playwright/test";

// The OFF visual language is uniform across every node and its wiring: the
// oscillator (off by default) dims its node like any muted node, a muted node's
// jacks stop glowing, and a multi-selection lights every selected node's wires.
const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const pin = (page: Page, ref: string) => page.locator(`#graph-host circle.port-pin[data-pin="${ref}"]`);
// A lit wire gains a halo path ahead of the painted line, so target the last
// non-hit path (the painted line carries the opacity / dash we assert on).
const wire = (page: Page, from: string, to: string) =>
  page.locator(`#graph-host g:has(> .wire-hit[data-from="${from}"][data-to="${to}"]) path:not(.wire-hit)`).last();
const PORT_PIN_OFF = "#241d12"; // PALETTES.dark.portPinOff

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("the oscillator node is dimmed and tagged OFF until it is turned on", async ({ page }) => {
  // Off by default: the OSC node reads as inactive like any muted node.
  await expect(node(page, "bus.osc")).toHaveAttribute("opacity", "0.4");
  await expect(node(page, "bus.osc").getByText("OFF")).toBeVisible();

  await node(page, "bus.osc").click();
  const oscOn = page
    .locator("#inspector .param")
    .filter({ has: page.locator(".toggle") })
    .filter({ hasText: "Oscillator" });
  await oscOn.getByRole("button", { name: "ON", exact: true }).click();

  // Generating now: the node clears its dimming at once, still selected.
  await expect(node(page, "bus.osc")).not.toHaveAttribute("opacity", "0.4");
});

test("muting a node darkens its jacks", async ({ page }) => {
  // ch1 carries a fixed send to STEREO, so its output jack glows (lit, not off).
  await expect(pin(page, "ch1:out")).not.toHaveAttribute("fill", PORT_PIN_OFF);

  await node(page, "ch1").click();
  await page
    .locator("#inspector .param")
    .filter({ has: page.locator(".toggle") })
    .filter({ hasText: "Channel" })
    .getByRole("button", { name: "OFF", exact: true })
    .click();

  // Every ch1 wire is now off, so its output jack stops reading as live.
  await expect(pin(page, "ch1:out")).toHaveAttribute("fill", PORT_PIN_OFF);
});

test("a multi-selection lights every selected node's wires, not just the anchor's", async ({ page }) => {
  await node(page, "ch1").click({ modifiers: ["ControlOrMeta"] });
  await node(page, "ch2").click({ modifiers: ["ControlOrMeta"] });

  // ch2 is the anchor; ch1's own send must still light (incident to a selected
  // node), not fade — the highlight follows the whole selection.
  await expect(wire(page, "ch1:out", "bus.stereo:in")).toHaveAttribute("opacity", "1");
  await expect(wire(page, "ch2:out", "bus.stereo:in")).toHaveAttribute("opacity", "1");
});
