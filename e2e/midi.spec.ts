import { test, expect, type Page } from "@playwright/test";

// External MIDI control is desktop-only (isTauri gate), so these tests stub the
// Tauri IPC bridge before the app boots: invoke() answers the boot-time queries,
// captures the MIDI input channel (so the test can push messages into the app),
// and records outgoing midi_send bytes (so feedback is observable).

declare global {
  interface Window {
    __midiTest: {
      inChannel: { onmessage: (batch: Array<{ bytes: number[] }>) => void } | null;
      inputPort: string | null;
      outputPort: string | null;
      sent: number[][];
    };
  }
}

const strip = (page: Page, name: string) => page.locator(".con-strip", { has: page.getByText(name, { exact: true }) });

/** The strip's set-level readout cell (not the live-meter cell). */
const readLevel = (page: Page, name: string) => strip(page, name).locator(".con-readout .rd:not(.mtr) .rv");

/** Push raw MIDI messages into the app through the captured input channel. */
const sendMidi = (page: Page, ...msgs: number[][]) =>
  page.evaluate((list) => {
    window.__midiTest.inChannel!.onmessage(list.map((bytes) => ({ bytes })));
  }, msgs);

const openPanel = async (page: Page) => {
  await page.click("#btn-device");
  await page.click("#btn-midi");
  await expect(page.locator("#midi-panel")).toBeVisible();
};

const pickInputPort = async (page: Page) => {
  await expect(page.locator("#midi-panel .mp-in option")).toHaveCount(2); // None + Stub In
  await page.locator("#midi-panel .mp-in").selectOption("Stub In");
  await expect.poll(() => page.evaluate(() => window.__midiTest.inputPort)).toBe("Stub In");
};

/** Learn one binding: arm `control` (a locator inside the console), then move
 *  the given MIDI control (two messages settle a plain CC without the flush timer). */
const learnBinding = async (page: Page, arm: () => Promise<void>, ...msgs: number[][]) => {
  const learnBtn = page.locator("#midi-panel .mp-learn-btn");
  if ((await learnBtn.getAttribute("aria-pressed")) !== "true") await learnBtn.click();
  await expect(page.locator("#console-host")).toHaveClass(/midi-learn/);
  await arm();
  await sendMidi(page, ...msgs);
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-model", "URX44V");
    localStorage.setItem("urx-disclaimer-accepted", "1"); // skip the consent gate
    const state: Window["__midiTest"] = { inChannel: null, inputPort: null, outputPort: null, sent: [] };
    window.__midiTest = state;
    class Channel {
      onmessage: (data: unknown) => void = () => {};
    }
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      Channel,
      invoke: (cmd: string, args: Record<string, unknown>) => {
        switch (cmd) {
          case "experimental_enabled":
            return Promise.resolve(false); // MIDI control ships without the flag (only the self-test is gated)
          case "self_test_requested":
          case "reset_storage_requested":
            return Promise.resolve(false);
          case "plugin:updater|check":
            return Promise.resolve(null);
          case "midi_list_inputs":
            return Promise.resolve(["Stub In"]);
          case "midi_list_outputs":
            return Promise.resolve(["Stub Out"]);
          case "midi_open_input":
            state.inChannel = args.channel as Window["__midiTest"]["inChannel"];
            state.inputPort = args.port as string;
            return Promise.resolve();
          case "midi_close_input":
            state.inChannel = null;
            state.inputPort = null;
            return Promise.resolve();
          case "midi_open_output":
            state.outputPort = args.port as string;
            return Promise.resolve();
          case "midi_close_output":
            state.outputPort = null;
            return Promise.resolve();
          case "midi_send":
            state.sent.push(args.bytes as number[]);
            return Promise.resolve();
          default:
            return Promise.reject(new Error(`stub: unhandled command ${cmd}`));
        }
      },
    };
  });
  await page.goto("/");
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  await page.click("#btn-view-console");
  await expect(page.locator("#console-host")).toBeVisible();
});

test("MIDI control is available without --experimental; only the self-test is gated", async ({ page }) => {
  // The beforeEach stub already reports experimental_enabled = false, so opening
  // the Device menu surfaces MIDI as a first-class entry while the self-test
  // (still behind the flag) stays hidden.
  await page.click("#btn-device");
  await expect(page.locator("#btn-fetch")).toBeVisible(); // the menu itself is open
  await expect(page.locator("#btn-midi")).toBeVisible();
  await expect(page.locator("#btn-selftest")).toBeHidden();
});

test("the ✕ button closes the panel and drops learn mode", async ({ page }) => {
  await openPanel(page);
  await page.locator("#midi-panel .mp-learn-btn").click(); // learn on
  await expect(page.locator("#console-host")).toHaveClass(/midi-learn/);
  // The panel class sets its own display, so [hidden] must still win (the
  // global [hidden] rule): after ✕ the panel is gone, not just marked hidden.
  await page.locator("#midi-panel .mp-close").click();
  await expect(page.locator("#midi-panel")).toBeHidden();
  await expect(page.locator("#console-host")).not.toHaveClass(/midi-learn/);
  // Reopening works too.
  await openPanel(page);
  await expect(page.locator("#midi-panel")).toBeVisible();
});

test("a press outside the panel dismisses it, except while learn is on", async ({ page }) => {
  await openPanel(page);
  // Presses inside the panel keep it open.
  await page.locator("#midi-panel .mp-title").click();
  await expect(page.locator("#midi-panel")).toBeVisible();
  // While learn is on, outside presses arm console controls instead of closing.
  await page.locator("#midi-panel .mp-learn-btn").click(); // learn on
  await strip(page, "CH 1").locator(".con-fader").click();
  await expect(page.locator("#midi-panel")).toBeVisible();
  await page.locator("#midi-panel .mp-learn-btn").click(); // learn off
  // With learn off an outside press closes the panel, and it can reopen.
  await page.click("#btn-view-console");
  await expect(page.locator("#midi-panel")).toBeHidden();
  await openPanel(page);
});

test("learn binds a CC to a fader and incoming CC moves it", async ({ page }) => {
  await openPanel(page);
  await pickInputPort(page);
  await learnBinding(page, () => strip(page, "CH 1").locator(".con-fader").click(), [0xb0, 7, 100], [0xb0, 7, 101]);
  // The binding lands in the assignment list, keyed by the console wording.
  const row = page.locator('#midi-panel .mp-row[data-control="ch1/level"]');
  await expect(row).toBeVisible();
  await expect(row).toContainText("CH 1 · Level");
  await expect(row).toContainText("CH 1 CC 7");
  // The name cell ellipsizes long labels; the title carries the full wording.
  await expect(row.locator(".mp-ctl")).toHaveAttribute("title", "CH 1 · Level");
  // Learn stays on for the next binding; the mapped control shows its dot.
  await expect(strip(page, "CH 1").locator(".con-fader")).toHaveClass(/midi-mapped/);
  await page.locator("#midi-panel .mp-learn-btn").click(); // learn off

  await sendMidi(page, [0xb0, 7, 127]);
  await expect(readLevel(page, "CH 1")).toHaveText("+10.0");
  await sendMidi(page, [0xb0, 7, 0]);
  await expect(readLevel(page, "CH 1")).toHaveText("-∞");
});

test("learn binds a note to MUTE and note-on toggles it", async ({ page }) => {
  await openPanel(page);
  await pickInputPort(page);
  const muteChip = () => strip(page, "CH 1").locator(".con-chip", { hasText: "MUTE" });
  await learnBinding(page, () => muteChip().click(), [0x90, 60, 127]); // a note binds on its first message
  await expect(page.locator('#midi-panel .mp-row[data-control="ch1/mute"]')).toContainText("CH 1 NOTE 60");
  await page.locator("#midi-panel .mp-learn-btn").click(); // learn off

  await expect(muteChip()).not.toHaveClass(/\bon\b/);
  await sendMidi(page, [0x90, 60, 127]);
  await expect(muteChip()).toHaveClass(/\bon\b/); // highlighted = muted
  await sendMidi(page, [0x80, 60, 0], [0x90, 60, 127]); // release, press again
  await expect(muteChip()).not.toHaveClass(/\bon\b/);
});

test("assignment selects form an aligned column across rows", async ({ page }) => {
  // Mode and button-behavior selects share a fixed width, so their left edges
  // (and the address cells sitting against them) line up across rows.
  await openPanel(page);
  await pickInputPort(page);
  await learnBinding(page, () => strip(page, "CH 1").locator(".con-fader").click(), [0xb0, 7, 100], [0xb0, 7, 101]);
  await learnBinding(page, () => strip(page, "CH 1").locator(".con-chip", { hasText: "MUTE" }).click(), [0x90, 60, 127]);
  await page.locator("#midi-panel .mp-learn-btn").click(); // learn off

  const mode = await page.locator('#midi-panel .mp-row[data-control="ch1/level"] .mp-mode').boundingBox();
  const btn = await page.locator('#midi-panel .mp-row[data-control="ch1/mute"] .mp-btn').boundingBox();
  expect(mode!.width).toBeCloseTo(btn!.width, 0);
  expect(mode!.x).toBeCloseTo(btn!.x, 0);
});

test("the option legend explains every choice of a hovered select", async ({ page }) => {
  await openPanel(page);
  await pickInputPort(page);
  await learnBinding(page, () => strip(page, "CH 1").locator(".con-fader").click(), [0xb0, 7, 100], [0xb0, 7, 101]);
  await page.locator("#midi-panel .mp-learn-btn").click(); // learn off

  const info = page.locator("#midi-panel .mp-info");
  await expect(info).toBeHidden();
  const mode = page.locator('#midi-panel .mp-row[data-control="ch1/level"] .mp-mode');
  await mode.focus();
  await expect(info).toBeVisible();
  await expect(info.locator(".ln")).toHaveCount(3); // one note per take-in mode
  await expect(info.locator(".ln.cur .nm")).toHaveText("Absolute"); // current choice highlighted
  await mode.blur();
  await expect(info).toBeHidden();
  // Changing the mode rebuilds the row; the legend never lingers detached.
  await mode.selectOption("pickup");
  await expect(info).toBeHidden();
});

test("a follow-value toggle responds to every press of an alternating button", async ({ page }) => {
  // Stream Deck style: the MIDI plugin's toggle button sends one CC per press,
  // alternating 127 / 0. Default edge mode flips on the 127 presses only; the
  // per-mapping "Follow value" behavior must respond to every press.
  await openPanel(page);
  await pickInputPort(page);
  const muteChip = () => strip(page, "CH 1").locator(".con-chip", { hasText: "MUTE" });
  await learnBinding(page, () => muteChip().click(), [0xb0, 20, 127], [0xb0, 20, 127]);
  await page.locator("#midi-panel .mp-learn-btn").click(); // learn off

  const row = page.locator('#midi-panel .mp-row[data-control="ch1/mute"]');
  await row.locator(".mp-btn").selectOption("state");
  await sendMidi(page, [0xb0, 20, 127]);
  await expect(muteChip()).toHaveClass(/\bon\b/); // 127 = muted
  await sendMidi(page, [0xb0, 20, 0]);
  await expect(muteChip()).not.toHaveClass(/\bon\b/); // 0 = unmuted — the press edge mode misses
  await sendMidi(page, [0xb0, 20, 127]);
  await expect(muteChip()).toHaveClass(/\bon\b/);
});

test("feedback follows UI edits out of the output port", async ({ page }) => {
  await openPanel(page);
  await pickInputPort(page);
  await learnBinding(page, () => strip(page, "CH 1").locator(".con-fader").click(), [0xb0, 7, 64], [0xb0, 7, 65]);
  await page.locator("#midi-panel .mp-learn-btn").click(); // learn off

  // Opening the output resyncs every binding to the current plan value.
  await page.locator("#midi-panel .mp-out").selectOption("Stub Out");
  await expect.poll(() => page.evaluate(() => window.__midiTest.outputPort)).toBe("Stub Out");
  await expect.poll(() => page.evaluate(() => window.__midiTest.sent.length)).toBeGreaterThan(0);
  const synced = await page.evaluate(() => window.__midiTest.sent.at(-1));
  expect(synced?.[0]).toBe(0xb0);
  expect(synced?.[1]).toBe(7);

  // A console edit feeds back the new value (debounced off markChanged).
  await page.evaluate(() => (window.__midiTest.sent.length = 0));
  const fader = strip(page, "CH 1").locator(".con-fader");
  await fader.click();
  await fader.press("End"); // fader to -∞ → CC value 0
  await expect.poll(() => page.evaluate(() => window.__midiTest.sent.at(-1))).toEqual([0xb0, 7, 0]);
});

test("assignments and the port choice survive a reload", async ({ page }) => {
  await openPanel(page);
  await pickInputPort(page);
  await learnBinding(page, () => strip(page, "CH 1").locator(".con-fader").click(), [0xb0, 7, 100], [0xb0, 7, 101]);

  await page.reload();
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  // The saved input port reopens on boot, without touching the panel.
  await expect.poll(() => page.evaluate(() => window.__midiTest.inputPort)).toBe("Stub In");
  await page.click("#btn-view-console");
  await sendMidi(page, [0xb0, 7, 127]);
  await expect(readLevel(page, "CH 1")).toHaveText("+10.0");
  await openPanel(page);
  await expect(page.locator('#midi-panel .mp-row[data-control="ch1/level"]')).toBeVisible();
});

test("removing an assignment stops the control from responding", async ({ page }) => {
  await openPanel(page);
  await pickInputPort(page);
  await learnBinding(page, () => strip(page, "CH 1").locator(".con-fader").click(), [0xb0, 7, 100], [0xb0, 7, 101]);
  await page.locator("#midi-panel .mp-learn-btn").click(); // learn off

  const before = await readLevel(page, "CH 1").textContent();
  await page.locator('#midi-panel .mp-row[data-control="ch1/level"] .mp-del').click();
  await expect(page.locator("#midi-panel .mp-empty")).toBeVisible();
  await sendMidi(page, [0xb0, 7, 127]);
  await expect(readLevel(page, "CH 1")).toHaveText(before ?? "");
});
