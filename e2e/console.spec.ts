import { test, expect, type Page } from "@playwright/test";

// A strip located by its scribble's node name (exact, so "CH 1" never matches
// "CH 11/12"). The console runs against the factory plan, so we do NOT seed
// "empty" — channels, sends, monitors and the master are all present.
const strip = (page: Page, name: string) =>
  page.locator(".con-strip", { has: page.getByText(name, { exact: true }) });

// Mute a node's channel master (CH_ON) via the graph inspector. The console MUTE
// chip now drives the → STEREO assign send, so the channel master is set from the
// inspector's "Channel" ON toggle only. Leaves the view on the console MAIN tab.
const muteMasterViaInspector = async (page: Page, nodeId: string) => {
  await page.click("#btn-view-graph");
  await page.locator(`g.node[data-id="${nodeId}"]`).click();
  await page
    .locator("#inspector .param")
    .filter({ has: page.locator(".toggle") })
    .filter({ hasText: "Channel" })
    .getByRole("button", { name: "OFF", exact: true })
    .click();
  await page.click("#btn-view-console");
};

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

test("the stereo-channel EQ chip locks read-only and off at 192 kHz", async ({ page }) => {
  const eqChip = strip(page, "CH 5/6").locator(".con-chip", { hasText: "EQ" }).first();
  // EQ ships on at 48 kHz and is interactive (\bon\b avoids matching "con-chip").
  await expect(eqChip).toHaveClass(/\bon\b/);
  await expect(eqChip).not.toHaveClass(/readonly/);

  await page.locator("#rate-picker").selectOption("192000");
  const locked = strip(page, "CH 5/6").locator(".con-chip", { hasText: "EQ" }).first();
  await expect(locked).toHaveClass(/readonly/);
  await expect(locked).not.toHaveClass(/\bon\b/); // forced off
  await expect(locked).toHaveAttribute("aria-disabled", "true");
});

test("a fader edits its level via the keyboard", async ({ page }) => {
  const s = strip(page, "CH 1");
  const readout = s.locator(".con-readout .rd:not(.mtr) .rv");
  await expect(readout).toHaveText("0.0");
  await s.locator(".con-fader").focus();
  // ArrowUp walks one detent of the device's level_gain grid (0.0 -> +0.4 dB).
  await page.keyboard.press("ArrowUp");
  await expect(readout).toHaveText("+0.4");
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

test("STEREO master and MIX strips carry a master BAL knob", async ({ page }) => {
  const master = strip(page, "STEREO (MAIN)").locator(".con-knob[aria-label='BAL']");
  await expect(master).toBeVisible();
  await expect(strip(page, "MIX 1").locator(".con-knob[aria-label='BAL']")).toBeVisible();
  // The knob edits and double-click resets to the factory value (center = C).
  const val = strip(page, "STEREO (MAIN)")
    .locator(".con-gain", { has: page.locator(".con-knob[aria-label='BAL']") })
    .locator(".val");
  await expect(val).toHaveText("C");
  await master.focus();
  await page.keyboard.press("ArrowRight");
  await expect(val).toHaveText("R1");
  await master.dblclick();
  await expect(val).toHaveText("C");
});

test("the MIX master BAL knob stays labeled BAL under Pan Link", async ({ page }) => {
  await expect(strip(page, "MIX 1").locator(".con-knob[aria-label='BAL']")).toBeVisible();
  // The device keeps the BALANCE label even with Pan Link on (confirmed on URX44V).
  await page.click("#btn-view-graph");
  await page.locator('g.node[data-id="bus.mix1"]').click();
  await page
    .locator("#inspector .param")
    .filter({ hasText: "Pan Link" })
    .getByRole("button", { name: "ON", exact: true })
    .click();
  await page.click("#btn-view-console");
  await expect(strip(page, "MIX 1").locator(".con-knob[aria-label='BAL']")).toBeVisible();
  await expect(strip(page, "MIX 1").locator(".con-knob[aria-label='PAN']")).toHaveCount(0);
});

test("DUCKER and φL/φR appear on stereo channels only", async ({ page }) => {
  await expect(strip(page, "CH 5/6").getByRole("button", { name: "DUCKER" })).toBeVisible();
  await expect(strip(page, "CH 5/6").getByRole("button", { name: "φL" })).toBeVisible();
  await expect(strip(page, "CH 1").getByRole("button", { name: "DUCKER" })).toHaveCount(0);
});

test("a send mode shows only the sources of the selected bus", async ({ page }) => {
  await page.locator(".con-modepick").getByRole("button", { name: "MIX 1", exact: true }).click();
  await expect(strip(page, "CH 1")).toBeVisible(); // a MIX source
  await expect(strip(page, "STEREO (MAIN)")).toHaveCount(0); // master is not a MIX source
  await expect(strip(page, "MONITOR 1")).toHaveCount(0); // monitors are not sources
});

test("the readout shows the set level only, with no send-destination line", async ({ page }) => {
  const readout = strip(page, "CH 1").locator(".con-readout");
  await expect(readout.locator(".rd:not(.mtr) .rv")).toHaveText("0.0");
  await expect(readout.locator(".send")).toHaveCount(0);
});

test("hiding a MIX bus in the graph drops its send tab from the console", async ({ page }) => {
  const pick = page.locator(".con-modepick");
  await expect(pick.getByRole("button", { name: "MIX 2", exact: true })).toBeVisible();

  // Shelve MIX 2 from the graph via its inspector, then return to the console.
  await page.click("#btn-view-graph");
  await page.locator('g.node[data-id="bus.mix2"]').click();
  await page.click("#inspector button.subtle");
  await page.click("#btn-view-console");

  await expect(pick.getByRole("button", { name: "MIX 2", exact: true })).toHaveCount(0);
  await expect(pick.getByRole("button", { name: "MIX 1", exact: true })).toBeVisible();
});

test("an active send tab falls back to MAIN when its bus is hidden", async ({ page }) => {
  await page.locator(".con-modepick").getByRole("button", { name: "MIX 2", exact: true }).click();
  await expect(strip(page, "STEREO (MAIN)")).toHaveCount(0); // confirm we're in a send tab

  await page.click("#btn-view-graph");
  await page.locator('g.node[data-id="bus.mix2"]').click();
  await page.click("#inspector button.subtle");
  await page.click("#btn-view-console");

  // The gone tab falls back to MAIN, which shows the master again.
  await expect(page.locator(".con-modepick").getByRole("button", { name: "MAIN", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(strip(page, "STEREO (MAIN)")).toBeVisible();
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
  // Mute the FX 1 channel master via the inspector (console MUTE drives the send now).
  await muteMasterViaInspector(page, "bus.fx1");
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
  // Mute the CH 1 master via the inspector (console MUTE drives the send now).
  await muteMasterViaInspector(page, "ch1");
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

test("the MAIN tab MUTE drives the CH → STEREO assign, not the channel master", async ({ page }) => {
  const ch = strip(page, "CH 1");
  const mute = ch.getByRole("button", { name: "MUTE" });
  await expect(mute).toHaveAttribute("aria-pressed", "false"); // → STEREO assign ships on
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true"); // → STEREO assign off
  // The channel master is untouched: the strip is not master-muted (no CH MUTE badge).
  await expect(ch).not.toHaveClass(/master-muted/);
  await expect(ch.locator(".ch-mute")).toHaveCount(0);
  // A MIX send tab confirms the master is still on there too.
  await page.locator(".con-modepick").getByRole("button", { name: "MIX 1", exact: true }).click();
  await expect(strip(page, "CH 1")).not.toHaveClass(/master-muted/);
});

test("a master-muted channel shows the CH MUTE badge on the MAIN tab too", async ({ page }) => {
  await muteMasterViaInspector(page, "ch1"); // leaves the view on the MAIN tab
  const ch = strip(page, "CH 1");
  await expect(ch).toHaveClass(/master-muted/);
  await expect(ch.locator(".ch-mute")).toHaveText("CH MUTE");
  // The → STEREO assign MUTE chip stays operable under the channel-master mute.
  const mute = ch.getByRole("button", { name: "MUTE" });
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true");
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

test("a MONITOR strip has C.INT (on by default) and MONO (off) chips", async ({ page }) => {
  const mon = strip(page, "MONITOR 1");
  const cue = mon.getByRole("button", { name: "C.INT" });
  await expect(cue).toHaveAttribute("aria-pressed", "true"); // CUE Interrupt defaults on
  // The terse C.INT label carries a tooltip spelling out its full name.
  await expect(cue).toHaveAttribute("title", "Cue Interrupt");
  await cue.click();
  await expect(cue).toHaveAttribute("aria-pressed", "false");
  const mono = mon.getByRole("button", { name: "MONO" });
  await expect(mono).toHaveAttribute("aria-pressed", "false"); // MONO defaults off
  await mono.click();
  await expect(mono).toHaveAttribute("aria-pressed", "true");
});

test("the OSCILLATOR strip has an ON button (off by default), not a MUTE", async ({ page }) => {
  const osc = strip(page, "OSCILLATOR");
  await expect(osc.getByRole("button", { name: "MUTE" })).toHaveCount(0); // ON, not MUTE
  const on = osc.getByRole("button", { name: "ON", exact: true });
  await expect(on).toHaveAttribute("aria-pressed", "false"); // OSC off at the factory
  await on.click();
  await expect(on).toHaveAttribute("aria-pressed", "true"); // generating
});

test("the dB scale ticks sit on real level_gain detents", async ({ page }) => {
  const scale = strip(page, "CH 1").locator(".con-scale");
  await expect(scale).toContainText("20");
  await expect(scale).toContainText("40");
});

test("the -∞ tick sits at the fader's bottom of travel", async ({ page }) => {
  const s = strip(page, "CH 1");
  const fader = s.locator(".con-fader");
  await fader.focus();
  await page.keyboard.press("End"); // fader all the way down = off (-∞)
  await expect(s.locator(".con-readout .rd:not(.mtr) .rv")).toHaveText("-∞");
  // The cap centre and the -∞ tick centre share the same travel coordinate.
  const cap = await s.locator(".con-fader .cap").boundingBox();
  const tick = await s.locator(".con-scale .t").last().boundingBox();
  expect(cap).toBeTruthy();
  expect(tick).toBeTruthy();
  expect(Math.abs(cap!.y + cap!.height / 2 - (tick!.y + tick!.height / 2))).toBeLessThanOrEqual(1);
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

test("the mode bar splits into Output (MAIN) and Send to (MIX/FX) groups", async ({ page }) => {
  const groups = page.locator(".con-modegroup");
  await expect(groups).toHaveCount(2);
  const out = groups.filter({ hasText: "Output" });
  const send = groups.filter({ hasText: "Send to" });
  // MAIN lives under Output; the aux sends live under Send to.
  await expect(out.getByRole("button", { name: "MAIN", exact: true })).toBeVisible();
  await expect(out.getByRole("button", { name: "MIX 1", exact: true })).toHaveCount(0);
  for (const name of ["FX 1", "FX 2", "MIX 1", "MIX 2"]) {
    await expect(send.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await expect(send.getByRole("button", { name: "MAIN", exact: true })).toHaveCount(0);
});

test("the STREAMING strip has a DELAY on/off chip and a TIME knob", async ({ page }) => {
  const strm = strip(page, "STREAMING");
  const delay = strm.getByRole("button", { name: "DELAY", exact: true });
  await expect(delay).toHaveAttribute("aria-pressed", "false"); // delay off at the factory
  await delay.click();
  await expect(delay).toHaveAttribute("aria-pressed", "true");
  // The delay TIME knob starts at the 1 ms minimum and steps up (whole ms) on the arrows.
  const time = strm.locator(".con-knob[aria-label='TIME']");
  await expect(time).toBeVisible();
  await expect(time).toHaveAttribute("aria-valuenow", "1");
  await time.focus();
  await time.press("ArrowUp");
  await expect(time).toHaveAttribute("aria-valuenow", "2");
});

test("the longest meter-point badge fits within its strip", async ({ page }) => {
  // PRE DUCKER (stereo channels) / PRE INS FX (mono) are the widest tap labels; the
  // badge must not overflow the 94 px strip into its neighbour.
  const ch = strip(page, "CH 7/8");
  await ch.locator(".con-tap").click();
  await page.locator(".con-tappop .crow", { hasText: "PRE DUCKER" }).click();
  const fit = await ch.evaluate((s) => {
    const badge = s.querySelector(".con-tap")!.getBoundingClientRect();
    const strip = s.getBoundingClientRect();
    return { leftIn: badge.left >= strip.left, rightIn: badge.right <= strip.right };
  });
  expect(fit.leftIn).toBe(true);
  expect(fit.rightIn).toBe(true);
});

test("the readout cells carry FADER / METER captions", async ({ page }) => {
  const readout = strip(page, "CH 1").locator(".con-readout");
  await expect(readout.locator(".rd:not(.mtr) .cap2")).toHaveText("FADER");
  await expect(readout.locator(".rd.mtr .cap2")).toHaveText("METER");
  // The value is a sibling of the caption, so the level still reads on its own.
  await expect(readout.locator(".rd:not(.mtr) .rv")).toHaveText("0.0");
});

test("the meter-point badge shows a meter glyph, distinct from the send-tap chip", async ({ page }) => {
  // In a send tab a source strip carries both a PRE send-tap chip and the POST
  // meter-point badge; only the badge gets the meter-bars glyph.
  await page.locator(".con-modepick").getByRole("button", { name: "MIX 1", exact: true }).click();
  const ch = strip(page, "CH 1");
  await expect(ch.getByRole("button", { name: "PRE", exact: true })).toBeVisible();
  await expect(ch.locator(".con-tap .mtr-ico")).toHaveCount(1);
});
