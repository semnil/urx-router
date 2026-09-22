import { test, expect } from "./fixtures";
import type { Page } from "./fixtures";
import { faceplate } from "./graph-helpers";
import {
  dialogsOf,
  heldReadsOf,
  LIVE_COMMANDS,
  savedFilesOf,
  setDeviceValue,
  setHeldReads,
  setRefusedReads,
  stubTauriDevice,
  writesOf,
} from "./tauri-stub";

// The device paths abort rather than continue once a premise has failed: a write
// whose diff could not be read never writes, a fetch whose Follow USB read is
// refused leaves the board and its badge as they were, a fetch that switched models
// and then failed leaves the plan and its model as they were, an edit made while a
// fetch that switched models is reading is refused, a drag or a key held across that switch
// writes nothing into the switched plan, a unit whose firmware version
// could not be read is not touched at all, and a send that stops part-way offers a
// retry instead of a breakdown the user cannot act on.

interface StubOptions {
  /** null = the firmware read did not land (the Q-1 gate). */
  firmware?: string | null;
  /** Reject every vd_get, so the write's diff cannot establish device values. */
  failReads?: boolean;
}

// The write reads the device's clock state (sample rate 766 / Follow USB 848)
// before the diff, so those two are answered even under failReads: this file is
// about the DIFF read failing, and the clock read's own abort is samplerate.spec.
// 48 kHz matches the plan and Follow USB off means there is nothing to settle.
function stubDevice(page: Page, opts: StubOptions = {}): Promise<void> {
  return stubTauriDevice(page, { ...opts, values: { 766: 48000, 848: 0 } });
}

const setsOf = async (page: Page): Promise<number> => (await writesOf(page)).length;

test("a write whose diff cannot be read is canceled before anything is sent", async ({ page }) => {
  await stubDevice(page, { failReads: true });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");

  await page.click("#btn-device"); // the device actions live in a menu
  await page.click("#btn-write");

  await expect(page.locator("#statusbar")).toContainText("Write canceled");
  await expect(page.locator("#statusbar")).toContainText("could not be read");
  // The abort happens before the confirm, so nothing reached the device.
  expect(await setsOf(page)).toBe(0);
  expect(await dialogsOf(page)).not.toContainEqual(expect.stringContaining("Write "));
});

// Fetch reads Follow USB (848) on its own connection, and a refusal there aborts the fetch
// like any other read on the link: the board and the badge keep what they had. Every other
// read answers 0 here, so a plan read that ran would mute CH 1 — which the same fetch does
// once the refusal is lifted, the half that makes the unchanged board mean something.
test("a fetch whose Follow USB read is refused leaves the board as it was", async ({ page }) => {
  await stubTauriDevice(page, { values: { 766: 48000, 848: 1 } });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  const ch1Muted = page.locator('#graph-host g.node[data-id="ch1"] text:text-is("MUTE")');
  const badge = page.locator("#follow-usb");
  await expect(ch1Muted).toHaveCount(0);
  // A badge that already holds a reading, so "left as it was" is a state of its own rather
  // than the unknown a failed read could also land on.
  await page.click("#follow-usb");
  await expect(badge).toHaveAttribute("data-state", "on");

  await setRefusedReads(page, [848]);
  await page.click("#btn-device"); // the device actions live in a menu
  await page.click("#btn-fetch");
  await expect.poll(() => dialogsOf(page)).toContainEqual("Device fetch failed: read timeout");
  // Read once the dialog is up, which is after the fetch has stopped writing the line.
  await expect(page.locator("#statusbar")).not.toContainText("Fetched");
  // Repainted from the plan: a fetch that merged and then threw before its own repaint
  // leaves the board drawn from the plan it started with.
  await page.click("#btn-view-console");
  await page.click("#btn-view-graph");
  await expect(ch1Muted).toHaveCount(0);
  await expect(badge).toHaveAttribute("data-state", "on");

  await setRefusedReads(page, []);
  await setDeviceValue(page, 848, 0, 0);
  await page.click("#btn-device");
  await page.click("#btn-fetch");
  await expect(page.locator("#statusbar")).toContainText("Fetched", { timeout: 20_000 });
  await expect(ch1Muted).toHaveCount(1);
  await expect(badge).toHaveAttribute("data-state", "off");
});

// A switch to the unit's model replaces the plan only once the read into the new plan has
// landed, so a fetch whose Follow USB read is refused after the switch was taken leaves the
// plan and its model as they were. The same fetch with the refusal lifted does switch, which
// is what makes the unchanged board the refusal's doing rather than a switch never taken.
test("a fetch that switched models and then failed leaves the plan and its model as they were", async ({ page }) => {
  await stubTauriDevice(page, { model: "URX22", confirm: "Ok", values: { 766: 48000, 848: 0 } });
  // The unit is a URX22 and the plan on screen a URX44V (see DeviceStubOptions.model).
  await page.addInitScript(() => localStorage.setItem("urx-model", "URX44V"));
  await page.goto("/");
  const picker = page.locator("#model-picker");
  // CH 3 is a mono channel on a URX44V and half of the CH 3/4 pair on a URX22.
  const ch3 = page.locator('#graph-host g.node[data-id="ch3"]');
  await expect(picker).toHaveValue("URX44V");
  await expect(ch3).toHaveCount(1);
  const switchAsk = "The connected device is URX22, but URX44V is selected.";

  await setRefusedReads(page, [848]);
  await page.click("#btn-device"); // the device actions live in a menu
  await page.click("#btn-fetch");
  await expect.poll(() => dialogsOf(page)).toContainEqual("Device fetch failed: read timeout");
  expect(await dialogsOf(page)).toContainEqual(expect.stringContaining(switchAsk));
  await expect(picker).toHaveValue("URX44V");
  await expect(ch3).toHaveCount(1);

  await setRefusedReads(page, []);
  await page.click("#btn-device");
  await page.click("#btn-fetch");
  await expect(page.locator("#statusbar")).toContainText("Fetched", { timeout: 20_000 });
  await expect(picker).toHaveValue("URX22");
  await expect(ch3).toHaveCount(0);
});

// While a fetch that carries a model switch is reading, the plan on screen is the one the
// switch discards, so an edit to it is refused rather than kept and then lost: the control
// keeps the value the plan holds and the status line says why. The fetch is held at its Follow
// USB read and then refused there, so the plan that was edited stays on screen afterwards —
// and the same press then lands, which is what makes the unchanged control the refusal's doing.
test("an edit made while a fetch that switched models reads is refused", async ({ page }) => {
  await stubTauriDevice(page, { model: "URX22", confirm: "Ok", values: { 766: 48000, 848: 0 } });
  // The unit is a URX22 and the plan on screen a URX44V (see DeviceStubOptions.model).
  await page.addInitScript(() => localStorage.setItem("urx-model", "URX44V"));
  await page.goto("/");
  const picker = page.locator("#model-picker");
  await expect(picker).toHaveValue("URX44V");
  await page.click("#btn-view-console");
  const mute = page
    .locator(".con-strip", { has: page.getByText("CH 1", { exact: true }) })
    .getByRole("button", { name: "MUTE" });
  await expect(mute).toHaveAttribute("aria-pressed", "false");

  await setHeldReads(page, [848]);
  await page.click("#btn-device"); // the device actions live in a menu
  await page.click("#btn-fetch");
  await expect.poll(() => heldReadsOf(page)).toBe(1);
  await mute.click();
  await expect(page.locator("#statusbar")).toContainText(
    "This plan is being replaced by one for the device's model — try that again when the read finishes",
  );
  await expect(mute).toHaveAttribute("aria-pressed", "false");

  await setRefusedReads(page, [848]);
  await setHeldReads(page, []);
  await expect.poll(() => dialogsOf(page)).toContainEqual("Device fetch failed: read timeout");
  await expect(picker).toHaveValue("URX44V");
  await expect(mute).toHaveAttribute("aria-pressed", "false");

  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true");
});

// The board writes a node's place as the pointer moves and reports the move once the drag
// ends. A drag pressed while a fetch or a live start that switched models reads is refused,
// and a press still held when the switch applies ends there, so the moves after it write
// nothing into the plan that replaced the one it was pressed on and leave nothing to undo.
// CH 3 is a mono channel on a URX44V and half of the CH 3/4 pair on a URX22, so a place
// carried across is one for a node the switched plan does not have. Released before the
// switch is the control: the refusal alone keeps the plan the switch discards as it was.
for (const flow of ["fetch", "live start"] as const) {
  for (const released of ["before", "after"] as const) {
    test(`a drag held while a switched ${flow} reads, released ${released} the switch, leaves the switched plan alone`, async ({
      page,
    }) => {
      await stubTauriDevice(page, {
        model: "URX22",
        confirm: "Ok",
        values: { 766: 48000, 848: 0 },
        commands: { ...LIVE_COMMANDS, "plugin:dialog|save": "/tmp/urx-e2e-plan.urxr", write_text_file: null },
      });
      // The unit is a URX22 and the plan on screen a URX44V (see DeviceStubOptions.model).
      await page.addInitScript(() => localStorage.setItem("urx-model", "URX44V"));
      await page.goto("/");
      const picker = page.locator("#model-picker");
      await expect(picker).toHaveValue("URX44V");
      const ch3 = page.locator('#graph-host g.node[data-id="ch3"]');
      const place = await ch3.getAttribute("transform");

      await setHeldReads(page, [848]);
      await page.click("#btn-device"); // the device actions live in a menu
      await page.click(flow === "fetch" ? "#btn-fetch" : "#btn-live");
      await expect.poll(() => heldReadsOf(page)).toBe(1);
      const box = (await faceplate(page, "ch3").boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + 10;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 35, y + 20, { steps: 3 });
      // Refused before the node moves, not put back once it has.
      await expect(page.locator("#statusbar")).toContainText(
        "This plan is being replaced by one for the device's model — try that again when the read finishes",
      );
      await expect(ch3).toHaveAttribute("transform", place!);
      if (released === "before") await page.mouse.up();
      await setHeldReads(page, []);
      await expect(picker).toHaveValue("URX22");
      if (flow === "live start") await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true");
      else await expect(page.locator("#btn-fetch")).toHaveText("Fetch from device");
      await page.mouse.move(x + 55, y + 30, { steps: 3 });
      await page.mouse.up();

      await page.evaluate(() => (document.getElementById("btn-save") as HTMLButtonElement).click());
      await expect.poll(async () => (await savedFilesOf(page)).length).toBe(1);
      const saved = JSON.parse((await savedFilesOf(page))[0]!) as { modelId: string; positions: object };
      expect(saved.modelId).toBe("URX22");
      expect(saved.positions).not.toHaveProperty("ch3");
      await page.keyboard.press("ControlOrMeta+z");
      await expect(page.locator("#statusbar")).toContainText("Nothing to undo");
    });
  }
}

// A tuning screen holds its rebuild while a pointer is down on it and binds to its node again
// when the plan changes. A slider held on CH 1's GATE screen while a switched fetch reads is
// gone with the plan when the switch applies, and the press writes nothing until it ends:
// moving the pointer afterwards leaves the switched plan with nothing to undo.
test("a tuning-screen slider held while a switched fetch reads leaves the switched plan alone", async ({ page }) => {
  await stubTauriDevice(page, { model: "URX22", confirm: "Ok", values: { 766: 48000, 848: 0 } });
  // The unit is a URX22 and the plan on screen a URX44V (see DeviceStubOptions.model).
  await page.addInitScript(() => localStorage.setItem("urx-model", "URX44V"));
  await page.goto("/");
  const picker = page.locator("#model-picker");
  await expect(picker).toHaveValue("URX44V");
  await page.click("#btn-view-console");

  await setHeldReads(page, [848]);
  await page.click("#btn-device"); // the device actions live in a menu
  await page.click("#btn-fetch");
  await expect.poll(() => heldReadsOf(page)).toBe(1);
  await page.locator(".con-strip").first().locator(".con-chip-open").first().click(); // GATE
  const slider = page.locator('#dyn-screen-box input[data-dyn="threshold"]');
  const box = (await slider.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await setHeldReads(page, []);
  await expect(picker).toHaveValue("URX22");
  await expect(page.locator("#btn-fetch")).toHaveText("Fetch from device");
  await page.mouse.move(x - box.width / 3, y, { steps: 5 });
  await page.mouse.up();

  await page.keyboard.press("Escape");
  await expect(page.locator("#dyn-screen-modal")).toBeHidden();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator("#statusbar")).toContainText("Nothing to undo");
});

// The keyboard's counterpart. A key held down goes on repeating into whatever holds the focus,
// and the CONSOLE hands the focus on across a rebuild of its strips. A key held on CH 1's fader
// while a switched fetch or live start reads is refused, and once the switch applies its repeats
// reach no control of the switched plan, which is left with nothing to undo. A fresh press on the
// switched plan's own fader is the positive control: it moves the fader, as an edit an undo takes
// back.
for (const flow of ["fetch", "live start"] as const) {
  test(`a key held on a fader while a switched ${flow} reads leaves the switched plan alone`, async ({ page }) => {
    await stubTauriDevice(page, {
      model: "URX22",
      confirm: "Ok",
      values: { 766: 48000, 848: 0 },
      commands: LIVE_COMMANDS,
    });
    // The unit is a URX22 and the plan on screen a URX44V (see DeviceStubOptions.model).
    await page.addInitScript(() => localStorage.setItem("urx-model", "URX44V"));
    await page.goto("/");
    const picker = page.locator("#model-picker");
    await expect(picker).toHaveValue("URX44V");
    await page.click("#btn-view-console");
    const strip = page.locator("#console-host .con-strip").first();
    const fader = strip.locator(".con-fader");
    const level = strip.locator(".con-readout .rv").first();

    await setHeldReads(page, [848]);
    await page.click("#btn-device"); // the device actions live in a menu
    await page.click(flow === "fetch" ? "#btn-fetch" : "#btn-live");
    await expect.poll(() => heldReadsOf(page)).toBe(1);
    await fader.focus();
    await page.keyboard.down("ArrowUp");
    await expect(page.locator("#statusbar")).toContainText(
      "This plan is being replaced by one for the device's model — try that again when the read finishes",
    );
    await setHeldReads(page, []);
    await expect(picker).toHaveValue("URX22");
    if (flow === "live start") await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true");
    else await expect(page.locator("#btn-fetch")).toHaveText("Fetch from device");
    const shown = await level.textContent();
    await page.keyboard.down("ArrowUp"); // a repeat: the key has not been released
    await page.keyboard.down("ArrowUp");
    await page.keyboard.up("ArrowUp");

    await expect(level).toHaveText(shown!);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(page.locator("#statusbar")).toContainText("Nothing to undo");
    await fader.focus();
    await page.keyboard.press("ArrowUp");
    await expect(level).not.toHaveText(shown!);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(level).toHaveText(shown!);
  });
}

test("a unit whose firmware version could not be read is not touched", async ({ page }) => {
  await stubDevice(page, { firmware: null });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");

  await page.click("#btn-device"); // the device actions live in a menu
  await page.click("#btn-fetch");

  await expect
    .poll(() => dialogsOf(page))
    .toContainEqual(expect.stringContaining("firmware version could not be read"));
  expect(await setsOf(page)).toBe(0);
});

test("a device that reports no firmware version is still usable", async ({ page }) => {
  // Empty is not the same as unread: the unit answered, it just has no System
  // entry, which disables the mismatch warning by design rather than blocking.
  await stubDevice(page, { firmware: "" });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");

  await page.click("#btn-device"); // the device actions live in a menu
  await page.click("#btn-fetch");

  // The fetch has to REACH its end before the absence below means anything. A polled
  // negative is satisfied by its first sample, which is taken as soon as the click
  // returns and hundreds of milliseconds before the gate it is judging has run — so
  // without this line the case reported green whatever the gate did.
  await expect(page.locator("#statusbar")).toContainText("Fetched", { timeout: 20_000 });
  expect(await dialogsOf(page)).not.toContainEqual(expect.stringContaining("firmware version"));
});
