import { readFileSync } from "node:fs";
import { test, expect, type Page } from "./fixtures";
import { faceplate, selectWire, stereoTie } from "./graph-helpers";
import { chooseOption } from "./choose-option";
import { planParam } from "./plan-param";

// Positions below are compared with node(), pointer grabs measured with
// faceplate() — the two boxes differ by the tap jack's overhang, so never mix them
// within one before/after comparison.
const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const param = (page: Page, label: string) => page.locator("#inspector .param", { hasText: label });
const sigSelect = (page: Page) => param(page, "Signal Type").locator("select");
const panBalSelect = (page: Page) => param(page, "PAN / BAL").locator("select");

// Save the plan and parse it back. The pan readers below are pure selectors over
// the result, so one save covers every assertion about the same board state.
async function savedPlan(page: Page, testInfo: { outputPath: (n: string) => string }) {
  await page.click("#btn-file");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btn-save")]);
  const file = testInfo.outputPath("plan.json");
  await download.saveAs(file);
  return JSON.parse(readFileSync(file, "utf8"));
}

// The pan of a from->to connection in a saved plan. A channel's CH_PAN is the pan
// of its fixed send into STEREO.
const panOf = (
  plan: { connections: { from: string; to: string; params?: { pan?: number } }[] },
  from: string,
  to: string,
) => plan.connections.find((c) => c.from === from && c.to === to)?.params?.pan;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("mono pair gets a Signal Type select; STEREO reveals PAN/BAL and a heart link", async ({ page }) => {
  await node(page, "ch1").click();
  await expect(sigSelect(page).locator("option")).toHaveText(["MONO x 2", "STEREO"]);
  await expect(sigSelect(page)).toHaveValue("0"); // MONO x 2
  await expect(param(page, "PAN / BAL")).toHaveCount(0);
  await expect(stereoTie(page)).toHaveCount(0);

  await chooseOption(sigSelect(page), "1"); // STEREO
  await expect(param(page, "PAN / BAL")).toHaveCount(1);
  // Linking lands in BAL, as it does on the unit.
  await expect(panBalSelect(page)).toHaveValue("1");
  await expect(stereoTie(page)).toHaveCount(1); // heart tie on the canvas

  // The partner channel shows the same Signal Type (stored on the primary).
  await node(page, "ch2").click();
  await expect(sigSelect(page)).toHaveValue("1");
});

test("BAL mode labels a send from the linked channel as BALANCE", async ({ page }) => {
  await node(page, "ch1").click();
  await chooseOption(sigSelect(page), "1"); // STEREO
  await chooseOption(param(page, "PAN / BAL").locator("select"), "1"); // BAL

  // The ch1 -> MIX 1 send is a fixed (always-wired) send; select it by endpoint.
  await selectWire(page, "ch1:out", "bus.mix1:in");
  await expect(page.locator("#inspector .param", { hasText: "Balance" })).toHaveCount(1);
  await expect(page.locator("#inspector .param-label span", { hasText: /^Pan$/ })).toHaveCount(0);
});

test("signal type round-trips through save and open", async ({ page }, testInfo) => {
  await node(page, "ch3").click();
  await chooseOption(sigSelect(page), "1");
  await page.click("#btn-file");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btn-save")]);
  const saved = testInfo.outputPath("plan.json");
  await download.saveAs(saved);
  await page.click("#btn-file");
  await page.click("#btn-new");
  await page.click("#btn-file");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#btn-open")]);
  await chooser.setFiles(saved);
  await node(page, "ch4").click();
  await expect(sigSelect(page)).toHaveValue("1"); // partner reflects primary ch3
});

test("a STEREO pair drags as one unit; the heart tie follows", async ({ page }) => {
  await node(page, "ch1").click();
  await chooseOption(sigSelect(page), "1"); // STEREO

  const before1 = await faceplate(page, "ch1").boundingBox();
  const before2 = await faceplate(page, "ch2").boundingBox();
  if (!before1 || !before2) throw new Error("nodes not found");

  // Drag CH2 (the partner, not the just-clicked node, to avoid the double-press
  // note shortcut). The linked CH1 must follow by the same delta.
  const gx = before2.x + before2.width * 0.35;
  const gy = before2.y + 12;
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  await page.mouse.move(gx + 130, gy + 80, { steps: 10 });
  await page.mouse.up();

  const after1 = await faceplate(page, "ch1").boundingBox();
  const after2 = await faceplate(page, "ch2").boundingBox();
  if (!after1 || !after2) throw new Error("nodes gone");
  expect(Math.hypot(after2.x - before2.x, after2.y - before2.y)).toBeGreaterThan(20);
  expect(Math.abs(after1.x - before1.x - (after2.x - before2.x))).toBeLessThan(2);
  expect(Math.abs(after1.y - before1.y - (after2.y - before2.y))).toBeLessThan(2);
  await expect(stereoTie(page)).toHaveCount(1); // tie still drawn after the move
});

test("STEREO-linking snaps a partner moved away back beside the kept primary", async ({ page }) => {
  const c1 = await node(page, "ch1").boundingBox();
  const start2 = await faceplate(page, "ch2").boundingBox();
  if (!c1 || !start2) throw new Error("nodes not found");

  // Drag CH2 far away while still MONO x 2 (it moves alone), opening a gap.
  const gx = start2.x + start2.width * 0.35;
  const gy = start2.y + 12;
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  await page.mouse.move(gx + 220, gy + 160, { steps: 10 });
  await page.mouse.up();
  const moved2 = await node(page, "ch2").boundingBox();
  if (!moved2) throw new Error("ch2 gone");

  // STEREO-link from CH1 (the kept node): CH2 snaps back into CH1's column,
  // directly below it, so the heart tie is short rather than stretched.
  await node(page, "ch1").click();
  await chooseOption(sigSelect(page), "1");
  const after1 = await node(page, "ch1").boundingBox();
  const after2 = await node(page, "ch2").boundingBox();
  if (!after1 || !after2) throw new Error("nodes gone");
  expect(Math.abs(after1.x - c1.x)).toBeLessThan(2); // kept node stays put
  expect(Math.abs(after2.x - after1.x)).toBeLessThan(2); // same column
  expect(after2.y).toBeGreaterThan(after1.y); // below it
  expect(Math.hypot(after2.x - moved2.x, after2.y - moved2.y)).toBeGreaterThan(20); // it really moved back
  await expect(stereoTie(page)).toHaveCount(1);
});

test("STEREO-linking from the partner keeps the partner and realigns the primary above it", async ({ page }) => {
  const c2 = await node(page, "ch2").boundingBox();
  const start1 = await faceplate(page, "ch1").boundingBox();
  if (!c2 || !start1) throw new Error("nodes not found");

  // Drag CH1 (the primary) far away while still MONO x 2.
  const gx = start1.x + start1.width * 0.35;
  const gy = start1.y + 12;
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  await page.mouse.move(gx + 200, gy - 150, { steps: 10 });
  await page.mouse.up();
  const moved1 = await node(page, "ch1").boundingBox();
  if (!moved1) throw new Error("ch1 gone");

  // Link from CH2: CH2 is the kept node, so CH1 snaps back above it.
  await node(page, "ch2").click();
  await chooseOption(sigSelect(page), "1");
  const after1 = await node(page, "ch1").boundingBox();
  const after2 = await node(page, "ch2").boundingBox();
  if (!after1 || !after2) throw new Error("nodes gone");
  expect(Math.abs(after2.x - c2.x)).toBeLessThan(2); // kept node stays put
  expect(Math.abs(after1.x - after2.x)).toBeLessThan(2); // same column
  expect(after1.y).toBeLessThan(after2.y); // above it
  expect(Math.hypot(after1.x - moved1.x, after1.y - moved1.y)).toBeGreaterThan(20);
  await expect(stereoTie(page)).toHaveCount(1);
});

// A document that arrives already linked — a `?plan=` link, a saved file, a plan a
// generator wrote — went through no edit funnel, so nothing snapped its partner. The
// load has to, or the heart tie opens the plan stretched across the gap.
test("a loaded plan whose pair is already STEREO opens with the partner aligned", async ({ page }) => {
  const strayPair = {
    format: "urx-router-plan",
    version: 1,
    modelId: "URX44V",
    connections: [],
    nodeParams: { ch3: { stereoLink: true }, ch4: { stereoLink: true } },
    positions: { ch3: { x: 500, y: 300 }, ch4: { x: 900, y: 620 } },
  };
  await page.goto(`/?plan=${planParam(strayPair)}`);
  await expect(page.locator("#statusbar")).toContainText("Plan loaded");

  const ch3 = await node(page, "ch3").boundingBox();
  const ch4 = await node(page, "ch4").boundingBox();
  if (!ch3 || !ch4) throw new Error("nodes not found");
  expect(Math.abs(ch4.x - ch3.x)).toBeLessThan(2); // same column as the primary
  expect(ch4.y).toBeGreaterThan(ch3.y); // directly below it
  await expect(stereoTie(page)).toHaveCount(1);
});

// The shelf is the other way a linked pair can arrive apart: the shelved member kept
// whatever position it was carrying, and the tie is drawn the moment it comes back.
test("restoring a shelved member of a STEREO pair lands it beside its partner", async ({ page }) => {
  const shelvedPartner = {
    format: "urx-router-plan",
    version: 1,
    modelId: "URX44V",
    connections: [],
    nodeParams: { ch3: { stereoLink: true }, ch4: { stereoLink: true } },
    positions: { ch3: { x: 500, y: 300 }, ch4: { x: 900, y: 620 } },
    hidden: ["ch4"],
  };
  await page.goto(`/?plan=${planParam(shelvedPartner)}`);
  await expect(page.locator("#statusbar")).toContainText("Plan loaded");
  await expect(node(page, "ch4")).toHaveCount(0);
  const ch3 = (await node(page, "ch3").boundingBox())!;

  await page.locator(".hidden-shelf .chip").click();

  const back = (await node(page, "ch4").boundingBox())!;
  const after3 = (await node(page, "ch3").boundingBox())!;
  expect(Math.abs(after3.x - ch3.x)).toBeLessThan(2); // the one on the board stays
  expect(Math.abs(back.x - after3.x)).toBeLessThan(2); // the restored one lands in its column
  expect(back.y).toBeGreaterThan(after3.y);
  await expect(stereoTie(page)).toHaveCount(1);
});

// A member placed beside its partner goes wherever that partner is. The chip's own status
// line says the node is shown and the inspector selects it, so a restore that lands off
// screen disagrees with everything else the gesture says.
test("restoring a member whose partner is off screen brings the pair into view", async ({ page }) => {
  const shelvedPartner = {
    format: "urx-router-plan",
    version: 1,
    modelId: "URX44V",
    connections: [],
    nodeParams: { ch3: { stereoLink: true }, ch4: { stereoLink: true } },
    positions: { ch3: { x: 500, y: 300 } },
    hidden: ["ch4"],
  };
  await page.goto(`/?plan=${planParam(shelvedPartner)}`);
  await expect(page.locator("#statusbar")).toContainText("Plan loaded");

  // Drag the empty canvas until CH 3 is past the right edge — what the operator does by
  // panning away from it. Asserted rather than assumed: the pan below has nothing to do if
  // the node is still in frame.
  const host = (await page.locator("#graph-host").boundingBox())!;
  const outsideHost = async (id: string): Promise<boolean> => {
    const b = (await node(page, id).boundingBox())!;
    return b.x > host.x + host.width || b.x + b.width < host.x;
  };
  const empty = { x: host.x + host.width - 30, y: host.y + 30 };
  for (let i = 0; i < 8; i++) {
    await page.mouse.move(empty.x - 300, empty.y);
    await page.mouse.down();
    await page.mouse.move(empty.x, empty.y, { steps: 6 });
    await page.mouse.up();
  }
  expect(await outsideHost("ch3")).toBe(true);

  await page.locator(".hidden-shelf .chip").click();

  const back = (await node(page, "ch4").boundingBox())!;
  expect(back.x + back.width).toBeGreaterThan(host.x);
  expect(back.x).toBeLessThan(host.x + host.width);
  expect(back.y + back.height).toBeGreaterThan(host.y);
  expect(back.y).toBeLessThan(host.y + host.height);
  // The view moved, not the nodes: the pair still holds the offset it was placed at.
  const ch3 = (await node(page, "ch3").boundingBox())!;
  expect(Math.abs(back.x - ch3.x)).toBeLessThan(2);
  expect(back.y).toBeGreaterThan(ch3.y);
  await expect(stereoTie(page)).toHaveCount(1);
});

// The boundary the product allows: the shell's smallest window, the deepest zoom, and a note
// that makes the pair taller than what is left above an open shelf. Framing the pair from its
// top there shows the partner and leaves the node the chip named behind the shelf — and the
// shelf covers the bottom of the canvas, so a check against the whole host counts that as
// visible.
test.describe("restoring into the smallest window", () => {
  test.use({ viewport: { width: 960, height: 640 } });

  test("keeps the node the chip named above the shelf when the pair cannot fit", async ({ page }) => {
    const arrangedWithNote = {
      format: "urx-router-plan",
      version: 1,
      modelId: "URX44V",
      connections: [],
      nodeParams: { ch3: { stereoLink: true }, ch4: { stereoLink: true } },
      // Three wrapped lines at the note's 21-character budget, which is what makes CH 3 tall
      // enough for Arrange to reserve three rows under it.
      notes: { ch3: "a note long enough to wrap across three whole lines here" },
      // Where Arrange puts the pair with that note: three rows between them.
      positions: { ch3: { x: 500, y: 300 }, ch4: { x: 500, y: 504 } },
      hidden: ["ch4", "bus.mix2"],
    };
    await page.goto(`/?plan=${planParam(arrangedWithNote)}`);
    await expect(page.locator("#statusbar")).toContainText("Plan loaded");

    // Deepest zoom, which is where the pair stops fitting.
    const host = (await page.locator("#graph-host").boundingBox())!;
    await page.mouse.move(host.x + host.width / 2, host.y + host.height / 2);
    for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -120);

    await page.locator(".hidden-shelf .chip", { hasText: "CH 4" }).click();

    // A second node stays shelved, so the shelf is still covering the canvas — the whole
    // point of measuring against its top rather than the host's bottom.
    const shelf = (await page.locator(".hidden-shelf").boundingBox())!;
    expect(await page.locator(".hidden-shelf .chip").count()).toBeGreaterThan(0);
    const back = (await node(page, "ch4").boundingBox())!;
    expect(back.y).toBeGreaterThanOrEqual(host.y);
    expect(back.y + back.height).toBeLessThanOrEqual(shelf.y);
    // The pair really did not fit, so this measured the fallback and not the ordinary path:
    // CH 3 is the one that went, and it went off the top.
    const partner = (await node(page, "ch3").boundingBox())!;
    expect(partner.y + partner.height).toBeLessThan(host.y);
  });
});

test("a MONO x 2 pair does not drag together", async ({ page }) => {
  const before2 = await node(page, "ch2").boundingBox();
  const box1 = await node(page, "ch1").boundingBox();
  if (!before2 || !box1) throw new Error("nodes not found");
  const gx = box1.x + box1.width * 0.35;
  const gy = box1.y + 12;
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  await page.mouse.move(gx + 120, gy + 70, { steps: 10 });
  await page.mouse.up();
  const after2 = await node(page, "ch2").boundingBox();
  if (!after2) throw new Error("ch2 gone");
  expect(Math.abs(after2.x - before2.x)).toBeLessThan(2);
  expect(Math.abs(after2.y - before2.y)).toBeLessThan(2);
});

test("PAN/BAL re-inits the pan of the STEREO and MIX sends for both pair members", async ({ page }, testInfo) => {
  // CH1/CH2 → MIX1 are fixed (always-wired) sends seeded on the board.
  // Entering STEREO lands in BAL: both centre (0), on the fixed CH->STEREO send
  // and the fixed MIX 1 sends alike.
  await node(page, "ch1").click();
  await chooseOption(sigSelect(page), "1");
  let plan = await savedPlan(page, testInfo);
  expect(panOf(plan, "ch1:out", "bus.stereo:in")).toBe(0);
  expect(panOf(plan, "ch2:out", "bus.stereo:in")).toBe(0);
  expect(panOf(plan, "ch1:out", "bus.mix1:in")).toBe(0);
  expect(panOf(plan, "ch2:out", "bus.mix1:in")).toBe(0);

  // PAN mode: odd hard-left (-63), even hard-right (+63) (toggle from the partner
  // member — the flag lives on the primary).
  await node(page, "ch2").click();
  await chooseOption(panBalSelect(page), "0");
  plan = await savedPlan(page, testInfo);
  expect(panOf(plan, "ch1:out", "bus.stereo:in")).toBe(-63);
  expect(panOf(plan, "ch1:out", "bus.mix1:in")).toBe(-63);
  expect(panOf(plan, "ch2:out", "bus.mix1:in")).toBe(63);

  // Back to BAL: centres again.
  await node(page, "ch1").click();
  await chooseOption(panBalSelect(page), "1");
  plan = await savedPlan(page, testInfo);
  expect(panOf(plan, "ch1:out", "bus.mix1:in")).toBe(0);
  expect(panOf(plan, "ch2:out", "bus.mix1:in")).toBe(0);
});

test("leaving STEREO centres the pair's pans, as the unit does", async ({ page }, testInfo) => {
  // Link, hard-pan the pair through PAN mode, then unlink: the unit centres CH_PAN
  // (the STEREO send's pan) and every other bus send's pan, so the plan does too.
  await node(page, "ch1").click();
  await chooseOption(sigSelect(page), "1");
  await chooseOption(panBalSelect(page), "0"); // PAN: -63 / +63
  expect(panOf(await savedPlan(page, testInfo), "ch1:out", "bus.mix1:in")).toBe(-63);

  await chooseOption(sigSelect(page), "0"); // MONO x 2
  const plan = await savedPlan(page, testInfo);
  expect(panOf(plan, "ch1:out", "bus.stereo:in")).toBe(0);
  expect(panOf(plan, "ch2:out", "bus.stereo:in")).toBe(0);
  expect(panOf(plan, "ch1:out", "bus.mix1:in")).toBe(0);
  expect(panOf(plan, "ch2:out", "bus.mix1:in")).toBe(0);
});

test("MONO x 2 (unlinked) leaves send pans untouched", async ({ page }, testInfo) => {
  // No Signal Type change: the seeded CH1 → MIX1 send keeps its default pan (unset),
  // never the STEREO hard-pan, confirming the re-init does not run while unlinked.
  expect(panOf(await savedPlan(page, testInfo), "ch1:out", "bus.mix1:in")).toBeUndefined();
});

// A console strip located by its scribble's node name (exact).
const cstrip = (page: Page, name: string) => page.locator(".con-strip", { has: page.getByText(name, { exact: true }) });

test("CONSOLE reads a BAL-linked mono channel's pan as BAL, matching the inspector", async ({ page }) => {
  await page.click("#btn-view-console");
  await expect(cstrip(page, "CH 1").locator(".con-knob[aria-label='PAN']")).toBeVisible();

  await page.click("#btn-view-graph");
  await node(page, "ch1").click();
  await chooseOption(sigSelect(page), "1"); // STEREO
  await chooseOption(panBalSelect(page), "1"); // BAL

  await page.click("#btn-view-console");
  await expect(cstrip(page, "CH 1").locator(".con-knob[aria-label='BAL']")).toBeVisible();
  await expect(cstrip(page, "CH 2").locator(".con-knob[aria-label='BAL']")).toBeVisible();
  await expect(cstrip(page, "CH 1").locator(".con-knob[aria-label='PAN']")).toHaveCount(0);
});

test("BAL mode links a fader edit across both channels in the CONSOLE", async ({ page }) => {
  await node(page, "ch1").click();
  await chooseOption(sigSelect(page), "1"); // STEREO
  await chooseOption(panBalSelect(page), "1"); // BAL

  await page.click("#btn-view-console");
  const ch1 = cstrip(page, "CH 1").locator(".con-readout .rd:not(.mtr) .rv");
  const ch2 = cstrip(page, "CH 2").locator(".con-readout .rd:not(.mtr) .rv");
  await expect(ch1).toHaveText("0.0");
  await expect(ch2).toHaveText("0.0");

  await cstrip(page, "CH 1").locator(".con-fader").focus();
  await page.keyboard.press("ArrowUp"); // one detent up the level_gain grid: +0.4 dB
  await expect(ch1).toHaveText("+0.4");
  await expect(ch2).toHaveText("+0.4"); // the partner follows in BAL
});

test("BAL mode links a MUTE toggle across both channels in the CONSOLE", async ({ page }) => {
  await node(page, "ch1").click();
  await chooseOption(sigSelect(page), "1"); // STEREO
  await chooseOption(panBalSelect(page), "1"); // BAL

  await page.click("#btn-view-console");
  const m1 = cstrip(page, "CH 1").getByRole("button", { name: "MUTE" });
  const m2 = cstrip(page, "CH 2").getByRole("button", { name: "MUTE" });
  await expect(m1).toHaveAttribute("aria-pressed", "false");
  await expect(m2).toHaveAttribute("aria-pressed", "false");
  await m1.click();
  await expect(m1).toHaveAttribute("aria-pressed", "true");
  await expect(m2).toHaveAttribute("aria-pressed", "true"); // partner follows in BAL
});

test("BAL mode links a gain edit across both channels in the CONSOLE", async ({ page }) => {
  await node(page, "ch1").click();
  await chooseOption(sigSelect(page), "1"); // STEREO
  await chooseOption(panBalSelect(page), "1"); // BAL

  await page.click("#btn-view-console");
  const g1 = cstrip(page, "CH 1")
    .locator(".con-gain", { has: page.locator(".con-knob[aria-label='A.GAIN']") })
    .locator(".val");
  const g2 = cstrip(page, "CH 2")
    .locator(".con-gain", { has: page.locator(".con-knob[aria-label='A.GAIN']") })
    .locator(".val");
  await expect(g1).toHaveText("-8");
  await expect(g2).toHaveText("-8");
  await cstrip(page, "CH 1").locator(".con-knob[aria-label='A.GAIN']").focus();
  await page.keyboard.press("ArrowUp");
  await expect(g1).toHaveText("-7");
  await expect(g2).toHaveText("-7"); // partner follows in BAL
});

test("BAL mode shares one balance across both channels in the CONSOLE", async ({ page }) => {
  await node(page, "ch1").click();
  await chooseOption(sigSelect(page), "1"); // STEREO
  await chooseOption(panBalSelect(page), "1"); // BAL — both centre (C)

  await page.click("#btn-view-console");
  const bal = (name: string) =>
    cstrip(page, name)
      .locator(".con-gain", { has: page.locator(".con-knob[aria-label='BAL']") })
      .locator(".val");
  await expect(bal("CH 1")).toHaveText("C");
  await expect(bal("CH 2")).toHaveText("C");

  // Nudge CH1's balance; CH2 reads the same shared value.
  await cstrip(page, "CH 1").locator(".con-knob[aria-label='BAL']").focus();
  await page.keyboard.press("ArrowUp");
  await expect(bal("CH 1")).toHaveText("R1");
  await expect(bal("CH 2")).toHaveText("R1");
});

test("BAL mode edits a MIX send pan without closing the SEND PAN popover", async ({ page }) => {
  // Regression: a BAL-linked pan edit re-rendered the console to sync the partner
  // strip, which tore down the open SEND PAN popover on every nudge. The popover knob
  // now skips that sync (the plan mirror via commit is enough; no partner send-pan
  // control is on screen), so the popover survives.
  await node(page, "ch1").click();
  await chooseOption(sigSelect(page), "1"); // STEREO
  await chooseOption(panBalSelect(page), "1"); // BAL

  await page.click("#btn-view-console");
  await cstrip(page, "CH 1").locator(".con-panbtn").click();
  const pop = page.locator(".con-spop");
  const val = pop.locator(".pcol", { hasText: "MIX 1" }).locator(".rv");
  await expect(val).toHaveText("C");
  await pop.locator(".pcol", { hasText: "MIX 1" }).locator(".con-knob").focus();
  await page.keyboard.press("ArrowRight");
  await expect(val).toHaveText("R1"); // the edit applied...
  await expect(pop).toBeVisible(); // ...and the popover stayed open
});

test("PAN mode keeps the two channels' faders independent in the CONSOLE", async ({ page }) => {
  await node(page, "ch1").click();
  await chooseOption(sigSelect(page), "1"); // STEREO (lands in BAL)
  await chooseOption(panBalSelect(page), "0"); // PAN

  await page.click("#btn-view-console");
  const ch1 = cstrip(page, "CH 1").locator(".con-readout .rd:not(.mtr) .rv");
  const ch2 = cstrip(page, "CH 2").locator(".con-readout .rd:not(.mtr) .rv");
  await cstrip(page, "CH 1").locator(".con-fader").focus();
  await page.keyboard.press("ArrowUp"); // one detent up the level_gain grid: +0.4 dB
  await expect(ch1).toHaveText("+0.4");
  await expect(ch2).toHaveText("0.0"); // no mirroring in PAN mode
});
