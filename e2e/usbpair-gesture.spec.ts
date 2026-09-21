import { test, expect, type Page } from "./fixtures";
import { drag, port, selectWire, stereoTie, tapJack, wire } from "./graph-helpers";
import { chooseOption } from "./choose-option";
import { en } from "../src/i18n/en";

// A USB output takes one source, or the two channels of a MONO IN pair as two ordinary
// patch wires — CH 3 and CH 4 on USB MAIN OUT A is the unit's own `CH 3/4`. These pin the
// board's half of that: which gestures put the pair on the output, what refuses any other
// second wire, and that each of the two stays a wire of its own.
const USB_A_IN = "out.usbmain_a:in";
const CH1 = "ch1:out";
const CH3 = "ch3:out";
const CH4 = "ch4:out";
const STEREO = "bus.stereo:out";

const node = (page: Page, id: string) => page.locator(`#graph-host g.node[data-id="${id}"]`);
const sigSelect = (page: Page) => page.locator("#inspector .param", { hasText: "Signal Type" }).locator("select");
const status = (page: Page) => page.locator("#statusbar");
const typeValue = (page: Page) =>
  page
    .locator("#inspector .field")
    .filter({ has: page.locator(`.field-key:text-is("${en.inspector.type}")`) })
    .locator(".field-val");

/** Every wire drawn into USB MAIN OUT A, whatever it comes from. */
const wiresIntoUsbA = (page: Page) => page.locator(`#graph-host .wire-hit[data-to="${USB_A_IN}"]`);

/** A channel reaches a USB output from its Rec Point tap, so that is where every draw starts. */
const drawOntoUsbA = (page: Page, ch: string): Promise<void> => drag(page, tapJack(page, ch), port(page, USB_A_IN));

async function linkPair(page: Page, id: string): Promise<void> {
  await node(page, id).click();
  await chooseOption(sigSelect(page), "1"); // STEREO
  await expect(stereoTie(page)).toHaveCount(1);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  // The factory plan patches STEREO onto USB MAIN OUT A; every case starts from it empty.
  await selectWire(page, STEREO, USB_A_IN);
  await page.keyboard.press("Delete");
  await expect(wiresIntoUsbA(page)).toHaveCount(0);
});

test("a STEREO-linked pair drawn from CH 3's tap puts both channels on the output, in one change", async ({ page }) => {
  await linkPair(page, "ch3");
  await drawOntoUsbA(page, CH3);

  await expect(wire(page, CH3, USB_A_IN)).toHaveCount(1);
  await expect(wire(page, CH4, USB_A_IN)).toHaveCount(1);
  await expect(wiresIntoUsbA(page)).toHaveCount(2);
  await expect(status(page)).toHaveText(en.status.connected);

  // One gesture, one undo entry: a single undo takes both wires back, and leaves the link
  // that was made before them.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(wiresIntoUsbA(page)).toHaveCount(0);
  await expect(stereoTie(page)).toHaveCount(1);
});

test("a STEREO-linked pair drawn backwards from the output onto CH 4 puts both channels on it", async ({ page }) => {
  // The partner, and the other drag direction: the pair goes on whichever member is drawn
  // and whichever end the drag starts from.
  await linkPair(page, "ch3");
  await drag(page, port(page, USB_A_IN), tapJack(page, CH4));

  await expect(wire(page, CH3, USB_A_IN)).toHaveCount(1);
  await expect(wire(page, CH4, USB_A_IN)).toHaveCount(1);
  await expect(wiresIntoUsbA(page)).toHaveCount(2);
});

test("drawing a linked channel onto an output that holds it alone adds its partner", async ({ page }) => {
  // CH 3 went on while the pair was unlinked; linking moves nothing on the output, and
  // drawing CH 3 again is what brings CH 4 — not a duplicate refused.
  await drawOntoUsbA(page, CH3);
  await expect(wiresIntoUsbA(page)).toHaveCount(1);
  await linkPair(page, "ch3");
  await expect(wiresIntoUsbA(page)).toHaveCount(1);

  await drawOntoUsbA(page, CH3);
  await expect(wire(page, CH3, USB_A_IN)).toHaveCount(1);
  await expect(wire(page, CH4, USB_A_IN)).toHaveCount(1);
  await expect(wiresIntoUsbA(page)).toHaveCount(2);
  await expect(status(page)).toHaveText(en.status.connected);
});

test("an unlinked channel goes on alone, and its partner joins it by its own draw", async ({ page }) => {
  await drawOntoUsbA(page, CH3);
  await expect(wire(page, CH3, USB_A_IN)).toHaveCount(1);
  await expect(wiresIntoUsbA(page)).toHaveCount(1);

  await drawOntoUsbA(page, CH4);
  await expect(wire(page, CH3, USB_A_IN)).toHaveCount(1);
  await expect(wire(page, CH4, USB_A_IN)).toHaveCount(1);
  await expect(status(page)).toHaveText(en.status.connected);
});

// Each refusal follows a draw that said "Connected", so the status it reads is the
// refusal's own rather than one already on screen.
test("any second wire but the partner, and any third, is refused as not a mono pair", async ({ page }) => {
  // A second wire that is not the partner of the one held.
  await drawOntoUsbA(page, CH3);
  await expect(status(page)).toHaveText(en.status.connected);
  await drawOntoUsbA(page, CH1);
  await expect(status(page)).toHaveText(en.error.monoPairOnly);
  await expect(wire(page, CH1, USB_A_IN)).toHaveCount(0);
  await expect(wiresIntoUsbA(page)).toHaveCount(1);

  // A third, onto the pair.
  await drawOntoUsbA(page, CH4);
  await expect(status(page)).toHaveText(en.status.connected);
  await expect(wiresIntoUsbA(page)).toHaveCount(2);
  await drawOntoUsbA(page, CH1);
  await expect(status(page)).toHaveText(en.error.monoPairOnly);
  await expect(wire(page, CH1, USB_A_IN)).toHaveCount(0);
  await expect(wiresIntoUsbA(page)).toHaveCount(2);
});

test("a bus onto an output holding one channel is refused as not a mono pair", async ({ page }) => {
  await drawOntoUsbA(page, CH3);
  await expect(status(page)).toHaveText(en.status.connected);
  await drag(page, port(page, STEREO), port(page, USB_A_IN));
  await expect(status(page)).toHaveText(en.error.monoPairOnly);
  await expect(wire(page, STEREO, USB_A_IN)).toHaveCount(0);
  await expect(wiresIntoUsbA(page)).toHaveCount(1);
});

test("deleting one wire of a linked pair on the output leaves the other", async ({ page }) => {
  await linkPair(page, "ch3");
  await drawOntoUsbA(page, CH3);
  await expect(wiresIntoUsbA(page)).toHaveCount(2);

  // The two bands overlap at the output, so the wire is selected by name.
  await selectWire(page, CH4, USB_A_IN);
  await page.keyboard.press("Delete");
  await expect(status(page)).toHaveText(en.status.connectionDeleted);
  await expect(wire(page, CH4, USB_A_IN)).toHaveCount(0);
  await expect(wire(page, CH3, USB_A_IN)).toHaveCount(1);

  await drawOntoUsbA(page, CH4);
  await selectWire(page, CH3, USB_A_IN);
  await page.keyboard.press("Delete");
  await expect(wire(page, CH3, USB_A_IN)).toHaveCount(0);
  await expect(wire(page, CH4, USB_A_IN)).toHaveCount(1);
});

test("a click on the output's jack selects the primary's wire of the pair", async ({ page }) => {
  // Drawn partner first, so the primary's wire is not simply the first one into the output.
  // What the click selected is read off what Delete then removes.
  await drawOntoUsbA(page, CH4);
  await drawOntoUsbA(page, CH3);
  const box = await port(page, USB_A_IN).boundingBox();
  if (!box) throw new Error("port not found");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press("Delete");
  await expect(status(page)).toHaveText(en.status.connectionDeleted);
  await expect(wire(page, CH3, USB_A_IN)).toHaveCount(0);
  await expect(wire(page, CH4, USB_A_IN)).toHaveCount(1);
});

test("the Inspector names a USB output's patch as one source or a MONO IN pair", async ({ page }) => {
  await drawOntoUsbA(page, CH3);
  await drawOntoUsbA(page, CH4);
  await selectWire(page, CH3, USB_A_IN);
  await expect(typeValue(page)).toHaveText(en.inspector.connKindMonoPair);

  // Every USB output reads the same, a single source into it included…
  await selectWire(page, STEREO, "out.usbmain_b:in");
  await expect(typeValue(page)).toHaveText(en.inspector.connKindMonoPair);
  // …and an analog output keeps the single-source wording.
  await selectWire(page, STEREO, "out.main:in");
  await expect(typeValue(page)).toHaveText(en.inspector.connKind.patch);
});
