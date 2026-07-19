import { test, expect, type Locator, type Page } from "@playwright/test";
import { drag, port, tapJack } from "./graph-helpers";

// A channel has two source jacks. The right-edge output feeds the mixer stage
// (bus sends, ducker keys); the Rec Point tap on the top edge feeds the direct
// outs and recordings, which the block diagram takes ahead of the fader and
// Ducker. The two are separate origins — each offers only the routes leaving it —
// so the board shows at a glance which routes skip the Ducker. The Rec Point
// *parameter* (which stage the tap sits at) is covered by recpoint.spec.ts.
const CH = "ch_5_6:out";
const USB_B_IN = "out.usbmain_b:in";
const SD_T1_IN = "out.sdrec.t1:in";
const DUCKER1_IN = "out.ducker1:in";

const tapPin = (page: Page, nodeId: string) => page.locator(`[data-tap-pin="${nodeId}"]`);
const outPin = (page: Page, ref: string) => page.locator(`[data-pin="${ref}"]`);
const wire = (page: Page, from: string, to: string) => page.locator(`.wire-hit[data-from="${from}"][data-to="${to}"]`);
// The painted jack of a node's right-edge output — the swatch beginConnect grows
// to r=8 while highlighting a candidate (the hit disc keeps its own radius).
const outJack = (page: Page, nodeId: string) =>
  page.locator(`#graph-host g.node[data-id="${nodeId}"] circle[data-dir="out"]`);

// Press and move without releasing, so the candidate highlights can be read while
// the rubber band is still live.
async function beginDrag(page: Page, from: Locator): Promise<void> {
  const a = await from.boundingBox();
  if (!a) throw new Error("jack not found");
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 - 70, a.y + a.height / 2 + 40, { steps: 6 });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-seed", "empty");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
});

test("every channel carries a Rec Point tap and no other node kind does", async ({ page }) => {
  // The tap is always drawn so it can be found before anything is wired.
  await expect(tapJack(page, "ch1:out")).toHaveCount(1);
  await expect(tapJack(page, CH)).toHaveCount(1);
  await expect(tapJack(page, "bus.stereo:out")).toHaveCount(0);
  // URX44V: 4 mono + 4 stereo channels, one tap each.
  await expect(page.locator("#graph-host [data-tap]")).toHaveCount(8);
});

test("wiring a recording lights the tap jack and leaves the mixer output dark", async ({ page }) => {
  // Every channel is permanently wired to the five mix buses, so its right-edge
  // output is lit from the start. Shelve those buses to darken it: only then can
  // the Rec Point wire's exclusion from that pin be seen.
  for (const bus of ["bus.stereo", "bus.mix1", "bus.mix2", "bus.fx1", "bus.fx2"]) {
    await page.locator(`#graph-host g.node[data-id="${bus}"]`).click();
    await page.locator("#inspector button.subtle").click();
  }
  await expect(outPin(page, CH)).not.toHaveAttribute("r", "3");
  await expect(tapPin(page, "ch_5_6")).not.toHaveAttribute("r", "3");

  await drag(page, tapJack(page, CH), port(page, SD_T1_IN));
  await expect(wire(page, CH, SD_T1_IN)).toHaveCount(1);

  // The recording leaves the top jack, so that pin lights…
  await expect(tapPin(page, "ch_5_6")).toHaveAttribute("r", "3");
  // …and the right-edge output stays dark: nothing runs through the mixer stage,
  // and a Rec Point tap must not imply that something does.
  await expect(outPin(page, CH)).not.toHaveAttribute("r", "3");
});

test("a tap wire rises off the top edge before sweeping across", async ({ page }) => {
  await drag(page, tapJack(page, CH), port(page, SD_T1_IN));

  // Straight riser, then the cubic — the geometry that reads as "taken ahead of
  // the strip's mixer stage" instead of joining the sends at the right edge.
  const d = (await wire(page, CH, SD_T1_IN).getAttribute("d"))!;
  const head = d.match(/^M ([\d.-]+) ([\d.-]+) L ([\d.-]+) ([\d.-]+) C /);
  expect(head).not.toBeNull();
  const [, sx, sy, lx, ly] = head!;
  expect(Number(lx)).toBe(Number(sx));
  expect(Number(ly)).toBeLessThan(Number(sy));
});

test("a USB direct out cannot be wired from the channel's mixer output", async ({ page }) => {
  await drag(page, port(page, CH), port(page, USB_B_IN));

  await expect(wire(page, CH, USB_B_IN)).toHaveCount(0);
  // The refusal names the jack to use instead rather than just failing.
  await expect(page.locator("#statusbar")).toContainText("Rec Point tap");
});

test("the Rec Point tap cannot be wired to a ducker key", async ({ page }) => {
  // A ducker key is not one of the tap's routes (it is a trigger, and it leaves
  // the mixer output), so dropping one on the tap is refused. The bus sends can't
  // stand in for this case — they are permanently wired already.
  await drag(page, tapJack(page, CH), port(page, DUCKER1_IN));

  await expect(wire(page, CH, DUCKER1_IN)).toHaveCount(0);
  await expect(page.locator("#statusbar")).toContainText("USB outputs and microSD Rec");
});

test("a target neither jack can reach reports no route, not the wrong jack", async ({ page }) => {
  // A channel input takes a source select, never a channel — so neither jack makes
  // this connection. Naming the other jack here would send the user to a second,
  // different failure, so the plain "no such route" wins.
  await drag(page, tapJack(page, "ch1:out"), port(page, "ch2:in"));

  await expect(page.locator("#statusbar")).toContainText("cannot be connected");
  await expect(page.locator("#statusbar")).not.toContainText("Rec Point");
});

test("dragging back from a USB input offers the channel's tap, not its output", async ({ page }) => {
  await beginDrag(page, port(page, USB_B_IN));

  // A channel reaches USB only through its Rec Point, so the board lights that
  // jack and leaves the channel's mixer output alone.
  await expect(tapJack(page, "ch1:out")).toHaveCount(1);
  await expect(outJack(page, "ch1")).toHaveAttribute("r", "6");
  // STEREO feeds USB through the mixer stage, so its own output does highlight.
  await expect(outJack(page, "bus.stereo")).toHaveAttribute("r", "8");

  await page.mouse.up();
});

test("a recording can be wired backwards, from the track slot to the tap", async ({ page }) => {
  await drag(page, port(page, SD_T1_IN), tapJack(page, CH));
  await expect(wire(page, CH, SD_T1_IN)).toHaveCount(1);
  await expect(tapPin(page, "ch_5_6")).toHaveAttribute("r", "3");
});

test("a ducker key still leaves the channel's mixer output", async ({ page }) => {
  // A channel key taps the same Rec Point stage on the device, but it is a
  // trigger rather than audio: it keeps the right-edge output, and the tap jack
  // stays dark so the top edge means "audio taken before the fader" alone.
  await drag(page, port(page, "ch1:out"), port(page, "out.ducker1:in"));
  await expect(wire(page, "ch1:out", "out.ducker1:in")).toHaveCount(1);
  await expect(tapPin(page, "ch1")).not.toHaveAttribute("r", "3");
  await expect(outPin(page, "ch1:out")).toHaveAttribute("r", "3");
});

test("the tap jack and its wires explain the stage on hover", async ({ page }) => {
  // Touch has no hover, so this is a supplement to the inspector note, not a
  // replacement — but the wording must match what the inspector says.
  await expect(tapJack(page, CH).locator("xpath=..").locator("title")).toContainText("Rec Point tap");

  await drag(page, tapJack(page, CH), port(page, SD_T1_IN));
  await expect(wire(page, CH, SD_T1_IN).locator("title")).toContainText("Rec Point");
});
