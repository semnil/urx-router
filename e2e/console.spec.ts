import { test, expect, type Page } from "@playwright/test";

// A strip located by its scribble's node name (exact, so "CH 1" never matches
// "CH 11/12"). The console runs against the factory plan, so we do NOT seed
// "empty" — channels, sends, monitors and the master are all present.
const strip = (page: Page, name: string) =>
  page.locator(".con-strip", { has: page.getByText(name, { exact: true }) });

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

test("GRAPH / CONSOLE tabs switch the visible view", async ({ page }) => {
  await expect(page.locator("#graph-host")).toBeHidden();
  await expect(page.locator("#btn-view-console")).toHaveAttribute("aria-pressed", "true");
  await page.click("#btn-view-graph");
  await expect(page.locator("#console-host")).toBeHidden();
  await expect(page.locator("#graph-host")).toBeVisible();
});

test("MAIN lays out the input channels and the master", async ({ page }) => {
  await expect(strip(page, "CH 1")).toBeVisible();
  await expect(strip(page, "CH 5/6")).toBeVisible();
  await expect(strip(page, "STEREO (MAIN)")).toBeVisible();
});

test("a fader edits its level via the keyboard", async ({ page }) => {
  const s = strip(page, "CH 1");
  const readout = s.locator(".con-readout .db");
  await expect(readout).toHaveText("0.0");
  await s.locator(".con-fader").focus();
  await page.keyboard.press("ArrowUp");
  await expect(readout).toHaveText("+1.0");
});

test("MUTE and EQ chips toggle their pressed state", async ({ page }) => {
  const s = strip(page, "CH 1");
  const mute = s.getByRole("button", { name: "MUTE" });
  await expect(mute).toHaveAttribute("aria-pressed", "false");
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  const eq = s.getByRole("button", { name: "EQ", exact: true });
  await expect(eq).toHaveAttribute("aria-pressed", "true"); // EQ defaults on
  await eq.click();
  await expect(eq).toHaveAttribute("aria-pressed", "false");
});

test("the gain knob edits, and double-click resets to the factory value", async ({ page }) => {
  const s = strip(page, "CH 1");
  const gain = s.locator(".con-gain", { has: page.locator(".con-knob[aria-label='A.GAIN']") });
  const val = gain.locator(".val");
  await expect(val).toHaveText("-8"); // factory A.Gain
  await gain.locator(".con-knob").focus();
  await page.keyboard.press("ArrowUp");
  await expect(val).toHaveText("-7");
  await gain.locator(".con-knob").dblclick();
  await expect(val).toHaveText("-8");
});

test("PAN/BAL is a knob on channels; PHONES on monitor buses", async ({ page }) => {
  await expect(strip(page, "CH 1").locator(".con-knob[aria-label='PAN']")).toBeVisible();
  await expect(strip(page, "CH 5/6").locator(".con-knob[aria-label='BAL']")).toBeVisible();
  await expect(strip(page, "MONITOR 1").locator(".con-knob[aria-label='PHONES']")).toBeVisible();
});

test("DUCKER and φL/φR appear on stereo channels only", async ({ page }) => {
  await expect(strip(page, "CH 5/6").getByRole("button", { name: "DUCKER" })).toBeVisible();
  await expect(strip(page, "CH 5/6").getByRole("button", { name: "φL" })).toBeVisible();
  await expect(strip(page, "CH 1").getByRole("button", { name: "DUCKER" })).toHaveCount(0);
});

test("a send mode shows only the sources of the selected bus", async ({ page }) => {
  await page.locator(".con-modepick").getByRole("button", { name: "MIX 1", exact: true }).click();
  await expect(strip(page, "CH 1")).toBeVisible(); // a MIX source
  await expect(strip(page, "CH 1").locator(".con-readout .send")).toHaveText("→ MIX 1 SEND");
  await expect(strip(page, "STEREO (MAIN)")).toHaveCount(0); // master is not a MIX source
  await expect(strip(page, "MONITOR 1")).toHaveCount(0); // monitors are not sources
});

test("an FX channel in a MIX mode has a PRE chip and a send-ON MUTE", async ({ page }) => {
  await page.locator(".con-modepick").getByRole("button", { name: "MIX 1", exact: true }).click();
  const fx = strip(page, "FX 1");
  await expect(fx).toBeVisible(); // FX 1 -> MIX 1 is a (fixed, factory-on) send
  // The BAL knob edits this FX -> MIX1 send's balance (per-tab, like the fader).
  await expect(fx.locator(".con-knob[aria-label='BAL']")).toBeVisible();
  // PRE toggles this FX -> MIX1 send's PRE/POST tap.
  const pre = fx.getByRole("button", { name: "PRE", exact: true });
  await expect(pre).toHaveAttribute("aria-pressed", "false"); // POST by default
  await pre.click();
  await expect(pre).toHaveAttribute("aria-pressed", "true");
  // MUTE toggles this send's ON/OFF (SEND_ON), not the FX channel master ON.
  const mute = fx.getByRole("button", { name: "MUTE" });
  await expect(mute).toHaveAttribute("aria-pressed", "false"); // send on at the factory
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true"); // send muted
});

test("the MAIN tab has no PRE chip on FX channels (STEREO main path has no tap)", async ({ page }) => {
  // MAIN shows the FX channel at its FX -> STEREO main level, which carries no
  // PRE/POST; the PRE chip is exclusive to the MIX send modes.
  const fx = strip(page, "FX 1");
  await expect(fx).toBeVisible();
  await expect(fx.getByRole("button", { name: "PRE", exact: true })).toHaveCount(0);
  // MAIN still shows a BAL knob, but for the FX -> STEREO main path (not a send).
  await expect(fx.locator(".con-knob[aria-label='BAL']")).toBeVisible();
});

test("a master-muted FX channel dims its MIX strip with a CH MUTE badge, keeping sends operable", async ({ page }) => {
  // Mute the FX 1 channel master from the MAIN tab (here MUTE = the channel ON).
  await strip(page, "FX 1").getByRole("button", { name: "MUTE" }).click();
  await page.locator(".con-modepick").getByRole("button", { name: "MIX 1", exact: true }).click();
  const fx = strip(page, "FX 1");
  // The strip dims and shows the CH MUTE badge (the whole channel is muted)...
  await expect(fx).toHaveClass(/master-muted/);
  await expect(fx.locator(".ch-mute")).toHaveText("CH MUTE");
  // ...but the per-send PRE chip stays operable (the send's own state is editable).
  const pre = fx.getByRole("button", { name: "PRE", exact: true });
  await pre.click();
  await expect(pre).toHaveAttribute("aria-pressed", "true");
});

test("an input channel in a MIX mode has a PRE chip, a PAN knob, and a send-ON MUTE", async ({ page }) => {
  await page.locator(".con-modepick").getByRole("button", { name: "MIX 1", exact: true }).click();
  const ch = strip(page, "CH 1");
  await expect(ch).toBeVisible(); // CH 1 -> MIX 1 is a (fixed, factory-on) send
  // The PAN knob edits this CH -> MIX1 send's pan (per-tab, like the fader).
  await expect(ch.locator(".con-knob[aria-label='PAN']")).toBeVisible();
  // PRE toggles this CH -> MIX1 send's PRE/POST tap.
  const pre = ch.getByRole("button", { name: "PRE", exact: true });
  await expect(pre).toHaveAttribute("aria-pressed", "false"); // POST by default
  await pre.click();
  await expect(pre).toHaveAttribute("aria-pressed", "true");
  // MUTE toggles this send's ON/OFF (SEND_ON), not the channel master ON.
  const mute = ch.getByRole("button", { name: "MUTE" });
  await expect(mute).toHaveAttribute("aria-pressed", "false"); // send on at the factory
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true"); // send muted
});

test("an input channel in an FX mode has a PRE chip and send-ON MUTE but no PAN knob", async ({ page }) => {
  await page.locator(".con-modepick").getByRole("button", { name: "FX 1", exact: true }).click();
  const ch = strip(page, "CH 1");
  await expect(ch).toBeVisible(); // CH 1 -> FX 1 is a (fixed, factory-on) send
  // FX-bus sends are mono and carry no pan, so the knob is dropped in an FX mode.
  await expect(ch.locator(".con-knob[aria-label='PAN']")).toHaveCount(0);
  await expect(ch.getByRole("button", { name: "PRE", exact: true })).toBeVisible();
  await expect(ch.getByRole("button", { name: "MUTE" })).toBeVisible();
});

test("a master-muted input channel dims its MIX strip with a CH MUTE badge", async ({ page }) => {
  // Mute the CH 1 master from the MAIN tab (here MUTE = the channel ON).
  await strip(page, "CH 1").getByRole("button", { name: "MUTE" }).click();
  await page.locator(".con-modepick").getByRole("button", { name: "MIX 1", exact: true }).click();
  const ch = strip(page, "CH 1");
  // The strip dims and shows the CH MUTE badge (the whole channel is muted)...
  await expect(ch).toHaveClass(/master-muted/);
  await expect(ch.locator(".ch-mute")).toHaveText("CH MUTE");
  // ...but the per-send PRE chip stays operable (the send's own state is editable).
  const pre = ch.getByRole("button", { name: "PRE", exact: true });
  await pre.click();
  await expect(pre).toHaveAttribute("aria-pressed", "true");
});

test("a MIX strip's MUTE drives the MIX → STEREO TO ST switch", async ({ page }) => {
  // MAIN tab. The MIX → STEREO "TO ST" ships off, so the MIX strip's MUTE starts
  // pressed (muted = not summed into the main mix). Clicking it turns TO ST on.
  const mute = strip(page, "MIX 1").getByRole("button", { name: "MUTE" });
  await expect(mute).toHaveAttribute("aria-pressed", "true"); // TO ST off = muted
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "false"); // TO ST on
});

test("a MONITOR strip has a MUTE (on by default, plan-only)", async ({ page }) => {
  // The monitor bus is on at the factory, so its MUTE starts unpressed; clicking mutes it.
  const mute = strip(page, "MONITOR 1").getByRole("button", { name: "MUTE" });
  await expect(mute).toHaveAttribute("aria-pressed", "false");
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true");
});

test("the OSCILLATOR strip has an ON button (off by default), not a MUTE", async ({ page }) => {
  const osc = strip(page, "OSCILLATOR");
  await expect(osc.getByRole("button", { name: "MUTE" })).toHaveCount(0); // ON, not MUTE
  const on = osc.getByRole("button", { name: "ON", exact: true });
  await expect(on).toHaveAttribute("aria-pressed", "false"); // OSC off at the factory
  await on.click();
  await expect(on).toHaveAttribute("aria-pressed", "true"); // generating
});

test("the dB scale includes the -60 and -80 ticks", async ({ page }) => {
  const scale = strip(page, "CH 1").locator(".con-scale");
  await expect(scale).toContainText("60");
  await expect(scale).toContainText("80");
});

test("a node hidden in the graph drops from the console", async ({ page }) => {
  await expect(strip(page, "CH 1")).toBeVisible();

  // Shelve CH 1 from the graph via its inspector, then return to the console.
  await page.click("#btn-view-graph");
  await page.locator('g.node[data-id="ch1"]').click();
  await page.click("#inspector button.subtle");
  await page.click("#btn-view-console");

  await expect(strip(page, "CH 1")).toHaveCount(0);
  await expect(strip(page, "CH 2")).toBeVisible();
});

test("scrolling stays inside the strip grid (no window scroll)", async ({ page }) => {
  const m = await page.evaluate(() => {
    const app = document.documentElement;
    const strips = document.querySelector(".con-strips") as HTMLElement;
    return {
      bodyVOver: app.scrollHeight - app.clientHeight,
      stripsHOver: strips.scrollWidth - strips.clientWidth,
    };
  });
  expect(m.bodyVOver).toBe(0); // the window never scrolls vertically
  expect(m.stripsHOver).toBeGreaterThan(0); // strips overflow horizontally inside .con-strips
});
