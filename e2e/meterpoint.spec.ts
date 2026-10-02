import { test, expect, type Page } from "./fixtures";

// METER POINT selector: each strip's level meter can show one of the node's
// observable tap points (INPUT → … → POST). Runs against the factory plan.
const strip = (page: Page, name: string) => page.locator(".con-strip", { has: page.getByText(name, { exact: true }) });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-model", "URX44V");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-view-console");
  await expect(page.locator("#console-host")).toBeVisible();
});

test("a mono channel defaults to POST and lists its full chain in signal order", async ({ page }) => {
  const badge = strip(page, "CH 1").locator(".con-tap");
  await expect(badge).toContainText("POST");
  await badge.click();
  const pop = page.locator(".con-tappop");
  await expect(pop).toBeVisible();
  await expect(pop.locator(".crow .nm")).toHaveText([
    "INPUT",
    "PRE GATE",
    "PRE COMP",
    "PRE EQ",
    "PRE INS FX",
    "PRE FADER",
    "POST",
  ]);
  await expect(pop.locator(".crow.active .nm")).toHaveText("POST");
});

// The badge reports whether its popover is open, and the rows sit in a menu named for what
// they choose — the shape the INS FX list and the PAN button already have.
test("the badge reports its popover open, and the rows sit in a named menu", async ({ page }) => {
  const badge = strip(page, "CH 1").locator(".con-tap");
  await expect(badge).toHaveAttribute("aria-expanded", "false");
  await badge.click();
  await expect(badge).toHaveAttribute("aria-expanded", "true");
  const menu = page.getByRole("menu", { name: "METER POINT", exact: true });
  await expect(menu.getByRole("menuitemradio")).toHaveCount(7);
  await expect(menu.getByRole("menuitemradio", { name: "POST" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator(".con-tappop")).toBeHidden();
  await expect(badge).toHaveAttribute("aria-expanded", "false");
});

// From the keyboard the badge puts the focus on the checked row — the popover sits after the
// whole strip rack in the tab order — and the popover closes once the focus leaves it.
test("the badge opened from the keyboard puts the focus on the checked row", async ({ page }) => {
  const badge = strip(page, "CH 1").locator(".con-tap");
  await badge.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "METER POINT", exact: true });
  await expect(menu.getByRole("menuitemradio", { name: "POST" })).toBeFocused();
  await menu.getByRole("menuitemradio", { name: "INPUT" }).focus();
  await expect(page.locator(".con-tappop")).toBeVisible(); // a row to a row keeps it open
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator(".con-tappop")).toBeHidden();
  await expect(badge).toHaveAttribute("aria-expanded", "false");
});

test("selecting a tap updates the badge and persists across reload", async ({ page }) => {
  await strip(page, "CH 1").locator(".con-tap").click();
  await page.locator(".con-tappop .crow", { has: page.getByText("PRE EQ", { exact: true }) }).click();
  await expect(strip(page, "CH 1").locator(".con-tap")).toContainText("PRE EQ");
  // The popover closes after a pick.
  await expect(page.locator(".con-tappop")).toBeHidden();

  await page.reload();
  await page.click("#btn-view-console");
  await expect(strip(page, "CH 1").locator(".con-tap")).toContainText("PRE EQ");
});

test("a stereo channel offers INPUT / PRE FADER / PRE DUCKER / POST (default POST)", async ({ page }) => {
  const badge = strip(page, "CH 5/6").locator(".con-tap");
  await expect(badge).toContainText("POST");
  await badge.click();
  await expect(page.locator(".con-tappop .crow .nm")).toHaveText(["INPUT", "PRE FADER", "PRE DUCKER", "POST"]);
});

test("an FX channel offers INPUT / PRE FADER / POST", async ({ page }) => {
  const badge = strip(page, "FX 1").locator(".con-tap");
  await expect(badge).toContainText("POST");
  await badge.click();
  await expect(page.locator(".con-tappop .crow .nm")).toHaveText(["INPUT", "PRE FADER", "POST"]);
});

test("an output bus lists PRE EQ / PRE FADER / PRE INS FX / POST", async ({ page }) => {
  await strip(page, "MIX 1").locator(".con-tap").click();
  await expect(page.locator(".con-tappop .crow .nm")).toHaveText(["PRE EQ", "PRE FADER", "PRE INS FX", "POST"]);
});

test("a single-meter node (OSCILLATOR) has no meter-point selector", async ({ page }) => {
  await expect(strip(page, "OSCILLATOR").locator(".con-tap")).toHaveCount(0);
});

test("opening with ?reset clears persisted UI state and strips the flag", async ({ page }) => {
  // Seed a non-default meter-point override, confirm it persists, then ?reset wipes it.
  await strip(page, "CH 1").locator(".con-tap").click();
  await page.locator(".con-tappop .crow", { has: page.getByText("PRE EQ", { exact: true }) }).click();
  await expect(strip(page, "CH 1").locator(".con-tap")).toContainText("PRE EQ");

  await page.goto("/?reset");
  // The reset flag is stripped from the URL.
  await expect(page).toHaveURL((u) => !u.search.includes("reset"));
  await page.click("#btn-view-console");
  await expect(strip(page, "CH 1").locator(".con-tap")).toContainText("POST"); // back to default
});

test("STREAMING is a meter-only strip (no fader, no set-level readout)", async ({ page }) => {
  const s = strip(page, "STREAMING");
  await expect(s).toHaveClass(/meter-only/);
  await expect(s.locator(".con-fader")).toHaveCount(0); // no fader
  await expect(s.locator(".con-meter")).toBeVisible(); // but a live meter
  // Only the meter readout cell (amber), no fader set-level cell.
  await expect(s.locator(".con-readout .rd")).toHaveCount(1);
  await expect(s.locator(".con-readout .rd.mtr")).toHaveCount(1);
  await expect(s.locator(".con-tap")).toHaveCount(0); // single meter → no selector
});
