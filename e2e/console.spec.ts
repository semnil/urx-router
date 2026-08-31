import { test, expect, type Page } from "./fixtures";
import { chooseOption } from "./choose-option";

// A strip located by its scribble's node name (exact, so "CH 1" never matches
// "CH 11/12"). The console runs against the factory plan, so we do NOT seed
// "empty" — channels, sends, monitors and the master are all present.
const strip = (page: Page, name: string) => page.locator(".con-strip", { has: page.getByText(name, { exact: true }) });

// A send column (chip → PRE → mini-fader) located by its enable-chip label.
const col = (page: Page, name: string, send: string) =>
  strip(page, name).locator(".con-scol", { has: page.getByRole("button", { name: send, exact: true }) });

// Mute a node's channel master (CH_ON) via the graph inspector. The console MUTE
// chip drives the → STEREO assign send, so the channel master is set from the
// inspector's "Channel" ON toggle only. Leaves the view on the console.
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

test("the console lays out the input channels and the master", async ({ page }) => {
  await expect(strip(page, "CH 1")).toBeVisible();
  await expect(strip(page, "CH 5/6")).toBeVisible();
  await expect(strip(page, "STEREO")).toBeVisible();
});

test("the longest channel name (CH 11/12) shrinks a step so it fits its scribble", async ({ page }) => {
  // "CH 11/12" (8 chars) overflows the 11px scribble name beside the power LED in
  // SF Mono, so the head drops it to 9px; assert the shrink and that the full label
  // is present un-clipped (no ellipsis).
  const txt = strip(page, "CH 11/12").locator(".con-scribble .txt");
  await expect(txt).toHaveText("CH 11/12");
  await expect(txt).toHaveCSS("font-size", "9px");
  const clipped = await txt.evaluate((n) => n.scrollWidth > n.clientWidth);
  expect(clipped).toBe(false);
});

test("the stereo-channel EQ chip locks read-only and off at 192 kHz", async ({ page }) => {
  const eqChip = strip(page, "CH 5/6").locator(".con-chip", { hasText: "EQ" }).first();
  // EQ ships on at 48 kHz and is interactive (\bon\b avoids matching "con-chip").
  await expect(eqChip).toHaveClass(/\bon\b/);
  await expect(eqChip).not.toHaveClass(/readonly/);

  await chooseOption(page.locator("#rate-picker"), "192000");
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

test("head MUTE and EQ chips toggle their pressed state", async ({ page }) => {
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

test("PAN/BAL is a head knob on channels; PHONES on monitor buses", async ({ page }) => {
  await expect(strip(page, "CH 1").locator(".con-head .con-knob[aria-label='PAN']")).toBeVisible();
  await expect(strip(page, "CH 5/6").locator(".con-head .con-knob[aria-label='BAL']")).toBeVisible();
  await expect(strip(page, "MONITOR 1").locator(".con-knob[aria-label='PHONES']")).toBeVisible();
});

test("STEREO master and MIX strips carry a master BAL knob", async ({ page }) => {
  const master = strip(page, "STEREO").locator(".con-knob[aria-label='BAL']");
  await expect(master).toBeVisible();
  await expect(strip(page, "MIX 1").locator(".con-knob[aria-label='BAL']")).toBeVisible();
  const val = strip(page, "STEREO")
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
  // `exact` because the tuning-screen opener beside it is labelled "Ducker screen",
  // which a substring match also picks up.
  await expect(strip(page, "CH 5/6").getByRole("button", { name: "DUCKER", exact: true })).toBeVisible();
  await expect(strip(page, "CH 5/6").getByRole("button", { name: "φL" })).toBeVisible();
  await expect(strip(page, "CH 1").getByRole("button", { name: "DUCKER", exact: true })).toHaveCount(0);
});

// ---- SENDS rack ----

test("an input channel's rack shows F1/F2/M1/M2 enable chips, on by default", async ({ page }) => {
  const s = strip(page, "CH 1");
  for (const name of ["F1", "F2", "M1", "M2"]) {
    const chip = s.getByRole("button", { name, exact: true });
    await expect(chip).toBeVisible();
    await expect(chip).toHaveClass(/\bon\b/); // the fixed sends ship on (at -∞)
  }
});

test("an FX channel's rack shows only the MIX columns, FX columns empty", async ({ page }) => {
  const fx = strip(page, "FX 1");
  await expect(fx.getByRole("button", { name: "M1", exact: true })).toBeVisible();
  await expect(fx.getByRole("button", { name: "M2", exact: true })).toBeVisible();
  // FX channels do not send to the FX buses, so those columns render empty (hidden).
  await expect(fx.getByRole("button", { name: "F1", exact: true })).toHaveCount(0);
  await expect(fx.locator(".con-scol.empty")).toHaveCount(2);
});

test("sendless strips show a dimmed SENDS header with no columns", async ({ page }) => {
  for (const name of ["MIX 1", "STEREO", "MONITOR 1"]) {
    const rack = strip(page, name).locator(".con-sends");
    await expect(rack.locator(".con-sh")).toHaveClass(/dim/);
    await expect(rack.locator(".con-scols")).toHaveCount(0);
    await expect(rack.locator(".con-panbtn")).toHaveCount(0);
  }
});

test("a send enable chip toggles the send on/off and dims its column", async ({ page }) => {
  const column = col(page, "CH 1", "M1");
  const chip = column.getByRole("button", { name: "M1", exact: true });
  await expect(chip).toHaveClass(/\bon\b/);
  await expect(column).not.toHaveClass(/\boff\b/);
  await chip.click();
  await expect(chip).not.toHaveClass(/\bon\b/); // send off
  await expect(column).toHaveClass(/\boff\b/); // the whole column dims
});

test("a PRE button toggles the send tap (POST by default)", async ({ page }) => {
  const pre = col(page, "CH 1", "M1").locator(".con-slp");
  await expect(pre).toHaveAttribute("aria-pressed", "false"); // POST by default
  await expect(pre).toHaveAttribute("title", "Pre-fader send");
  await pre.click();
  await expect(pre).toHaveAttribute("aria-pressed", "true"); // PRE
});

test("a send column fader edits the send level and drives the header readout", async ({ page }) => {
  const s = strip(page, "CH 1");
  const fader = col(page, "CH 1", "M1").locator(".con-vfad");
  const rdout = s.locator(".con-sh .rdout");
  await fader.focus();
  // Focusing the column swaps the SENDS label for a "MIX 1 …" value readout.
  await expect(s.locator(".con-sh")).toHaveClass(/readout/);
  await expect(rdout).toContainText("MIX 1");
  const before = await rdout.textContent();
  await page.keyboard.press("ArrowUp"); // one detent up
  await expect(rdout).not.toHaveText(before ?? "");
  await fader.blur();
  await expect(s.locator(".con-sh")).not.toHaveClass(/readout/); // reverts to SENDS
});

test("a send column's groove runs the cap's full travel, so the cap never leaves its slot", async ({ page }) => {
  const fader = col(page, "CH 1", "M1").locator(".con-vfad");
  const centre = async () => {
    const cap = await fader.locator(".cap").boundingBox();
    return cap!.y + cap!.height / 2;
  };
  await fader.focus();
  for (const [key, edge] of [
    ["Home", "y"],
    ["End", "bottom"],
  ] as const) {
    await page.keyboard.press(key); // top / bottom of travel
    const track = (await fader.locator(".track").boundingBox())!;
    const end = edge === "y" ? track.y : track.y + track.height;
    // The groove ends on the cap centre at each limit: any shortfall shows as a gap
    // between the cap and the slot it rides in.
    expect(Math.abs((await centre()) - end)).toBeLessThan(1);
  }
});

test("the global collapse folds every rack and shows active-send dots; it persists", async ({ page }) => {
  const host = page.locator("#console-host");
  await expect(host).not.toHaveClass(/sends-collapsed/);
  // Clicking any SENDS header collapses all racks at once.
  await strip(page, "CH 1").locator(".con-sh").click();
  await expect(host).toHaveClass(/sends-collapsed/);
  // Collapsed, CH 1 shows one amber dot per active send (all four ship on).
  await expect(strip(page, "CH 1").locator(".con-sh .dots i")).toHaveCount(4);
  await expect(strip(page, "FX 1").locator(".con-sh .dots i")).toHaveCount(2); // MIX 1 + MIX 2

  // The state is persisted (urx-sends-open) across a reload.
  await page.reload();
  await page.click("#btn-view-console");
  await expect(page.locator("#console-host")).toHaveClass(/sends-collapsed/);
});

test("the PAN ▾ button opens the SEND PAN popover below it with MIX knobs only", async ({ page }) => {
  await strip(page, "CH 1").locator(".con-panbtn").click();
  const pop = page.locator(".con-spop");
  await expect(pop).toBeVisible();
  // The header names the category and the owning strip, so the floating popover
  // stays identifiable away from its anchor.
  await expect(pop.locator(".ph .cat")).toHaveText("SEND PAN");
  await expect(pop.locator(".ph .who")).toHaveText("CH 1");
  // One rotary knob column per MIX send (FX sends are mono and carry no pan).
  await expect(pop.locator(".pcol")).toHaveCount(2);
  await expect(pop.locator(".pcol .cap").first()).toHaveText("MIX 1");
  await expect(pop).not.toContainText("FX");
  // The popover anchors below the button (upward caret).
  await expect(pop).toHaveClass(/below/);
  // The knob edits the send pan; a fresh send is centred (C).
  const val = pop.locator(".pcol", { hasText: "MIX 1" }).locator(".rv");
  await expect(val).toHaveText("C");
  await pop.locator(".pcol", { hasText: "MIX 1" }).locator(".con-knob").focus();
  await page.keyboard.press("ArrowRight");
  await expect(val).toHaveText("R1");
  // Escape closes it.
  await page.keyboard.press("Escape");
  await expect(pop).toBeHidden();
  // Another strip's popover names that strip (the header tracks its owner).
  await strip(page, "CH 2").locator(".con-panbtn").click();
  await expect(pop.locator(".ph .who")).toHaveText("CH 2");
});

test("the PAN ▾ button reads active while its SEND PAN popover is open", async ({ page }) => {
  const btn1 = strip(page, "CH 1").locator(".con-panbtn");
  await expect(btn1).not.toHaveClass(/\bopen\b/);
  await expect(btn1).toHaveAttribute("aria-expanded", "false");
  // Opening marks the trigger active.
  await btn1.click();
  await expect(page.locator(".con-spop")).toBeVisible();
  await expect(btn1).toHaveClass(/\bopen\b/);
  await expect(btn1).toHaveAttribute("aria-expanded", "true");
  // Switching straight to CH 2's button hands the active state over (CH 1 clears).
  const btn2 = strip(page, "CH 2").locator(".con-panbtn");
  await btn2.click();
  await expect(btn1).not.toHaveClass(/\bopen\b/);
  await expect(btn2).toHaveClass(/\bopen\b/);
  // Closing clears it.
  await page.keyboard.press("Escape");
  await expect(page.locator(".con-spop")).toBeHidden();
  await expect(btn2).not.toHaveClass(/\bopen\b/);
  await expect(btn2).toHaveAttribute("aria-expanded", "false");
});

test("the SEND PAN popover flips above its anchor near the viewport bottom", async ({ page }) => {
  // The static "below" class never changes, so only the geometry proves the flip.
  // Measure the popover at the default viewport (room below), then shrink the
  // viewport so that room is gone: popTop must place the popover above the button.
  const btn = strip(page, "CH 1").locator(".con-panbtn");
  const pop = page.locator(".con-spop");
  await btn.click();
  await expect(pop).toBeVisible();
  const popBox = (await pop.boundingBox())!;
  const b = (await btn.boundingBox())!;
  expect(popBox.y).toBeGreaterThanOrEqual(b.y + b.height); // baseline: it opened below
  await page.keyboard.press("Escape");
  await expect(pop).toBeHidden();

  // The head + SENDS rack heights are viewport-independent, so the button keeps
  // its y; only the room below it shrinks (re-measured to be safe).
  await page.setViewportSize({ width: 1280, height: Math.ceil(b.y + b.height + popBox.height) });
  await btn.click();
  await expect(pop).toBeVisible();
  const btnBox = (await btn.boundingBox())!;
  const above = (await pop.boundingBox())!;
  expect(above.y + above.height).toBeLessThanOrEqual(btnBox.y + 1);
});

test("hiding a MIX bus in the graph drops its rack column from every strip", async ({ page }) => {
  await expect(strip(page, "CH 1").getByRole("button", { name: "M2", exact: true })).toBeVisible();

  // Shelve MIX 2 from the graph via its inspector, then return to the console.
  await page.click("#btn-view-graph");
  await page.locator('g.node[data-id="bus.mix2"]').click();
  await page.click("#inspector button.subtle");
  await page.click("#btn-view-console");

  // The M2 column drops on every strip; M1 stays.
  await expect(page.getByRole("button", { name: "M2", exact: true })).toHaveCount(0);
  await expect(strip(page, "CH 1").getByRole("button", { name: "M1", exact: true })).toBeVisible();
});

test("the head MUTE drives the CH → STEREO assign, not the channel master", async ({ page }) => {
  const ch = strip(page, "CH 1");
  const mute = ch.getByRole("button", { name: "MUTE" });
  await expect(mute).toHaveAttribute("aria-pressed", "false"); // → STEREO assign ships on
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true"); // → STEREO assign off
  // The channel master is untouched: the strip is not dimmed, the power LED stays on.
  await expect(ch).not.toHaveClass(/inactive/);
  await expect(ch.locator(".con-scribble.power")).toHaveAttribute("aria-pressed", "true");
});

test("the scribble power LED toggles the node master and dims the strip", async ({ page }) => {
  const ch = strip(page, "CH 1");
  const power = ch.locator(".con-scribble.power");
  await expect(power).toHaveAttribute("aria-pressed", "true"); // CH_ON ships on
  await expect(ch).not.toHaveClass(/inactive/);
  await power.click();
  await expect(power).toHaveAttribute("aria-pressed", "false");
  await expect(ch).toHaveClass(/inactive/);
  // The head MUTE (→ STEREO send) and the rack sends stay operable under the dim.
  const pre = col(page, "CH 1", "M1").locator(".con-slp");
  await pre.click();
  await expect(pre).toHaveAttribute("aria-pressed", "true");
});

// Scroll the strip rack to its right end and return where it landed, asserting it
// actually overflows at this viewport — otherwise a "the offset survived" assertion
// would pass on a rack that never moved.
const scrollStripsToEnd = async (page: Page): Promise<number> => {
  const strips = page.locator(".con-strips");
  await strips.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  const scrolled = await strips.evaluate((el) => el.scrollLeft);
  expect(scrolled).toBeGreaterThan(0);
  return scrolled;
};
const stripsScroll = (page: Page): Promise<number> => page.locator(".con-strips").evaluate((el) => el.scrollLeft);

test("a re-render keeps the strip scroll offset and the focused control", async ({ page }) => {
  // The power LED re-renders every strip (the dim state is per strip), replacing the
  // DOM under the operator: the strip area used to snap back to the left edge and
  // focus fell to the body. Device follow takes the same re-render on every device-side
  // edit while Live sync is on, where it read as the console blinking on its own.
  const scrolled = await scrollStripsToEnd(page);
  // The rightmost strip carrying a power LED — on screen at this offset, so the click
  // itself never scrolls.
  const power = page.locator(".con-strip .con-scribble.power").last();
  await power.click();
  await expect(power).toHaveAttribute("aria-pressed", "false");
  await expect(power).toBeFocused();
  expect(await stripsScroll(page)).toBe(scrolled);
});

// The scroll offset survives a rebuild on its own: `render()` clears and refills the
// rack in one task, so the empty rack is never laid out and the offset is never
// clipped. Saving and rewriting it around the rebuild instead forces a synchronous
// layout of the whole rack — measured at ~25 ms per render on WKWebView, against ~6 ms
// without — on a path Live sync takes for every device read-back. These two pin the
// offset so that cost cannot come back as the fix for a regression they would catch.
test("a re-render with nothing focused keeps the strip scroll offset", async ({ page }) => {
  const scrolled = await scrollStripsToEnd(page);
  // A rate change re-renders every strip (applyRateConstraints), with focus on the
  // picker — outside the rack, so nothing is restored into it.
  await chooseOption(page.locator("#rate-picker"), "192000");
  await expect(strip(page, "CH 5/6").locator(".con-chip", { hasText: "EQ" }).first()).toHaveClass(/readonly/);
  expect(await stripsScroll(page)).toBe(scrolled);
});

test("a re-render keeps the offset when the focused control is scrolled out of view", async ({ page }) => {
  // Restoring focus is what could move the rack: the control is off screen, so the
  // browser would scroll it into view if the restore did not pass preventScroll. Pinned
  // here for Chromium; the same check runs against WKWebView on every bench run
  // (scrollCheck in scripts/meter-bench.mjs), since this is engine behaviour.
  // Driven from the keyboard: a pointer would move focus to whatever it pressed, and
  // the point here is a control that keeps focus while sitting off screen.
  const power = strip(page, "CH 1").locator(".con-scribble.power");
  await power.focus();
  const scrolled = await scrollStripsToEnd(page);
  await page.keyboard.press("Enter"); // the per-strip dim re-renders every strip
  await expect(strip(page, "CH 1")).toHaveClass(/inactive/);
  expect(await stripsScroll(page)).toBe(scrolled);
  await expect(strip(page, "CH 1").locator(".con-scribble.power")).toBeFocused();
});

test("muting the channel master in the inspector dims the console strip", async ({ page }) => {
  await muteMasterViaInspector(page, "ch1"); // leaves the view on the console
  const ch = strip(page, "CH 1");
  await expect(ch).toHaveClass(/inactive/);
  await expect(ch.locator(".con-scribble.power")).toHaveAttribute("aria-pressed", "false");
});

test("a MIX strip's head MUTE drives the MIX → STEREO TO ST switch", async ({ page }) => {
  // The MIX → STEREO "TO ST" ships off, so the MIX strip's MUTE starts pressed
  // (muted = not summed into the main mix). Clicking it turns TO ST on.
  const mute = strip(page, "MIX 1").getByRole("button", { name: "MUTE" });
  await expect(mute).toHaveAttribute("aria-pressed", "true"); // TO ST off = muted
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "false"); // TO ST on
});

test("a MONITOR strip has no MUTE chip; its on/off is the power LED (MONITOR_ON)", async ({ page }) => {
  const mon = strip(page, "MONITOR 1");
  await expect(mon.getByRole("button", { name: "MUTE" })).toHaveCount(0); // no → STEREO send
  const power = mon.locator(".con-scribble.power");
  await expect(power).toHaveAttribute("aria-pressed", "true"); // MONITOR_ON ships on
  await expect(mon).not.toHaveClass(/inactive/);
  await power.click();
  await expect(power).toHaveAttribute("aria-pressed", "false");
  await expect(mon).toHaveClass(/inactive/);
});

test("a MONITOR strip has C.INT (on by default) and MONO (off) chips", async ({ page }) => {
  const mon = strip(page, "MONITOR 1");
  const cue = mon.getByRole("button", { name: "C.INT" });
  await expect(cue).toHaveAttribute("aria-pressed", "true"); // CUE Interrupt defaults on
  await expect(cue).toHaveAttribute("title", "Cue Interrupt");
  await cue.click();
  await expect(cue).toHaveAttribute("aria-pressed", "false");
  const mono = mon.getByRole("button", { name: "MONO" });
  await expect(mono).toHaveAttribute("aria-pressed", "false"); // MONO defaults off
  await mono.click();
  await expect(mono).toHaveAttribute("aria-pressed", "true");
});

test("the OSCILLATOR strip has no MUTE / ON chip; its on/off is the power LED", async ({ page }) => {
  const osc = strip(page, "OSCILLATOR");
  await expect(osc.getByRole("button", { name: "MUTE" })).toHaveCount(0);
  await expect(osc.getByRole("button", { name: "ON", exact: true })).toHaveCount(0); // no ON chip
  const power = osc.locator(".con-scribble.power");
  await expect(power).toHaveAttribute("aria-pressed", "false"); // OSC off at the factory
  await power.click();
  await expect(power).toHaveAttribute("aria-pressed", "true"); // generating
});

test("the STREAMING strip has a DELAY on/off chip and a TIME knob", async ({ page }) => {
  const strm = strip(page, "STREAMING");
  const delay = strm.getByRole("button", { name: "DELAY", exact: true });
  await expect(delay).toHaveAttribute("aria-pressed", "false"); // delay off at the factory
  await delay.click();
  await expect(delay).toHaveAttribute("aria-pressed", "true");
  const time = strm.locator(".con-knob[aria-label='TIME']");
  await expect(time).toBeVisible();
  await expect(time).toHaveAttribute("aria-valuenow", "1");
  await time.focus();
  await time.press("ArrowUp");
  await expect(time).toHaveAttribute("aria-valuenow", "2");
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
  const cap = await s.locator(".con-fader .cap").boundingBox();
  const tick = await s.locator(".con-scale .t").last().boundingBox();
  expect(cap).toBeTruthy();
  expect(tick).toBeTruthy();
  expect(Math.abs(cap!.y + cap!.height / 2 - (tick!.y + tick!.height / 2))).toBeLessThanOrEqual(1);
});

// The travel is a few pixels per detent, so a press that jumped to the pointer moved
// the level — and, live, the unit — before the operator had moved at all. The cap is
// grabbed where it is instead, anywhere on it rather than at its centre alone.
test("a press anywhere on the fader cap grabs it without moving the level", async ({ page }) => {
  const s = strip(page, "CH 1");
  const readout = s.locator(".con-readout .rd:not(.mtr) .rv");
  // Step off the factory value first: a double-click resets the fader to it, so a
  // stray one would otherwise read as "the press changed nothing".
  await s.locator(".con-fader").focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  const before = (await readout.textContent())!;

  const cap = (await s.locator(".con-fader .cap").boundingBox())!;
  const x = cap.x + cap.width / 2;
  for (const y of [cap.y + 1, cap.y + cap.height / 2, cap.y + cap.height - 1]) {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.up();
    await expect(readout).toHaveText(before);
  }
});

// …and from that grab the cap tracks the pointer 1:1, which it did not while the drag
// was measured against the groove's inset rather than the cap's own travel.
test("a grabbed fader cap moves by the distance dragged", async ({ page }) => {
  const s = strip(page, "CH 1");
  const fader = (await s.locator(".con-fader").boundingBox())!;
  const detent = fader.height / 40; // the level grid's detents span the cap's travel
  const cap = (await s.locator(".con-fader .cap").boundingBox())!;
  const x = cap.x + cap.width / 2;
  const from = cap.y + cap.height / 2;

  await page.mouse.move(x, from);
  await page.mouse.down();
  await page.mouse.move(x, from + 3 * detent, { steps: 4 });
  await page.mouse.up();

  const after = (await s.locator(".con-fader .cap").boundingBox())!;
  // Half a detent for the grid snap, a pixel for the device scale factor.
  expect(Math.abs(after.y - cap.y - 3 * detent)).toBeLessThanOrEqual(detent / 2 + 1);
});

// A press on the bare track still jumps, as an <input type="range"> does when clicked
// away from its thumb — and it now lands the cap centre on the pointer rather than up
// to six pixels off it.
test("a press on the bare fader track puts the cap under the pointer", async ({ page }) => {
  const s = strip(page, "CH 1");
  const fader = (await s.locator(".con-fader").boundingBox())!;
  const detent = fader.height / 40;
  const target = fader.y + fader.height * 0.8; // well below the factory cap position

  await page.mouse.move(fader.x + fader.width / 2, target);
  await page.mouse.down();
  await page.mouse.up();

  const cap = (await s.locator(".con-fader .cap").boundingBox())!;
  expect(Math.abs(cap.y + cap.height / 2 - target)).toBeLessThanOrEqual(detent / 2 + 1);
});

test("a node hidden in the graph drops from the console", async ({ page }) => {
  await expect(strip(page, "CH 1")).toBeVisible();
  await page.click("#btn-view-graph");
  await page.locator('g.node[data-id="ch1"]').click();
  await page.click("#inspector button.subtle");
  await page.click("#btn-view-console");
  await expect(strip(page, "CH 1")).toHaveCount(0);
  await expect(strip(page, "CH 2")).toBeVisible();
});

test("scrolling stays inside the strip grid (no window scroll) @webkit", async ({ page }) => {
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

test("the longest meter-point badge fits within its strip", async ({ page }) => {
  const ch = strip(page, "CH 7/8");
  await ch.locator(".con-tap").click();
  await page.locator(".con-tappop .crow", { hasText: "PRE DUCKER" }).click();
  const fit = await ch.evaluate((s) => {
    const badge = s.querySelector(".con-tap")!.getBoundingClientRect();
    const box = s.getBoundingClientRect();
    return { leftIn: badge.left >= box.left, rightIn: badge.right <= box.right };
  });
  expect(fit.leftIn).toBe(true);
  expect(fit.rightIn).toBe(true);
});

test("the readout cells carry FADER / METER captions", async ({ page }) => {
  const readout = strip(page, "CH 1").locator(".con-readout");
  await expect(readout.locator(".rd:not(.mtr) .cap2")).toHaveText("FADER");
  await expect(readout.locator(".rd.mtr .cap2")).toHaveText("METER");
  await expect(readout.locator(".rd:not(.mtr) .rv")).toHaveText("0.0");
});

test("the meter-point badge shows a meter glyph, distinct from the send-tap PRE button", async ({ page }) => {
  const ch = strip(page, "CH 1");
  // The rack carries the PRE send-tap buttons; only the meter badge gets the glyph.
  await expect(ch.locator(".con-slp").first()).toBeVisible();
  await expect(ch.locator(".con-tap .mtr-ico")).toHaveCount(1);
});

test("switching the model rebuilds the console strip set in place", async ({ page }) => {
  // URX44V carries four mono channels (CH 1..CH 4); URX22 has only two, pairing the
  // rest, so CH 4 is a mono strip here but CH 3/4 (a stereo pair) is not. Switching
  // the model must re-render the console with the new device's strips (via refresh),
  // without leaving the view or dropping the master.
  await expect(strip(page, "CH 4")).toBeVisible();
  await expect(strip(page, "CH 3/4")).toHaveCount(0);

  await chooseOption(page.locator("#model-picker"), "URX22");
  await expect(page.locator("#model-picker")).toHaveValue("URX22");

  await expect(page.locator("#console-host")).toBeVisible(); // still on the console
  await expect(strip(page, "CH 4")).toHaveCount(0); // URX22 has no mono CH 4
  await expect(strip(page, "CH 3/4")).toBeVisible(); // now a stereo pair
  await expect(strip(page, "STEREO")).toBeVisible(); // master persists
});

test("a very short window keeps a usable fader instead of crushing it @webkit", async ({ page }) => {
  // The head and the SENDS rack are fixed heights, so a short window (devtools
  // docked to the bottom) used to squeeze the fader zone to nothing. It now holds
  // a floor and the overflow goes to the strip grid's vertical scroll.
  await page.setViewportSize({ width: 1280, height: 380 });
  const zone = strip(page, "CH 1").locator(".con-faderzone");
  await expect(zone).toBeVisible();
  const box = await zone.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(140);
  // The window itself still never scrolls — the strip grid owns the overflow.
  const m = await page.evaluate(() => {
    const app = document.documentElement;
    const strips = document.querySelector(".con-strips") as HTMLElement;
    return { bodyVOver: app.scrollHeight - app.clientHeight, stripsVOver: strips.scrollHeight - strips.clientHeight };
  });
  expect(m.bodyVOver).toBe(0);
  expect(m.stripsVOver).toBeGreaterThan(0);
});

test("every strip's head holds its own contents, so --head-h is not hand-measured", async ({ page }) => {
  // `--head-h` is one fixed height for every strip, so the tallest head sets it — and it has
  // been re-measured by hand each time a chip row was added. Nothing caught the previous
  // value having 0.9 px of slack; this does. Overflow is invisible on screen (the head does
  // not scroll), which is exactly why it needs asserting rather than looking at.
  const overflow = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".con-strip")].map((strip) => {
      const head = strip.querySelector(".con-head") as HTMLElement;
      const cs = getComputedStyle(head);
      const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const gap = parseFloat(cs.rowGap || cs.gap) || 0;
      const kids = [...head.children];
      const used =
        kids.reduce((sum, k) => sum + k.getBoundingClientRect().height, 0) + gap * Math.max(0, kids.length - 1);
      return {
        name: strip.querySelector(".con-scribble-name")?.textContent?.trim() ?? "?",
        over: +(used + pad - head.getBoundingClientRect().height).toFixed(1),
      };
    }),
  );
  expect(overflow.length).toBeGreaterThan(10);
  expect(overflow.filter((s) => s.over > 0)).toEqual([]);
});
