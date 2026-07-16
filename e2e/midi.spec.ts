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

const pickOutputPort = async (page: Page) => {
  await page.locator("#midi-panel .mp-out").selectOption("Stub Out");
  await expect.poll(() => page.evaluate(() => window.__midiTest.outputPort)).toBe("Stub Out");
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
          // Minimal vd surface for the fetch feedback test: a matching device with
          // no firmware gate, every parameter read answering 0 (CH levels = 0.0 dB).
          case "vd_connect":
            return Promise.resolve({ model: "URX44V", label: "Stub URX", firmware: "", epoch: 1 });
          case "vd_disconnect":
            return Promise.resolve();
          case "vd_get":
            return Promise.resolve(0);
          case "vd_get_str":
            return Promise.resolve("");
          case "plugin:dialog|message":
            return Promise.resolve("Ok"); // confirm dialogs (discard edits): proceed
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

test("one physical control can gang several console controls", async ({ page }) => {
  // Assigning the same MIDI control to a second console control links them: one
  // CC drives both at once, and the later row is tagged as linked to the first
  // (which owns the feedback). Saves learning every send source individually.
  await openPanel(page);
  await pickInputPort(page);
  await learnBinding(page, () => strip(page, "CH 1").locator(".con-fader").click(), [0xb0, 7, 100], [0xb0, 7, 101]);
  await learnBinding(page, () => strip(page, "CH 2").locator(".con-fader").click(), [0xb0, 7, 100], [0xb0, 7, 101]);
  await page.locator("#midi-panel .mp-learn-btn").click(); // learn off

  const head = page.locator('#midi-panel .mp-row[data-control="ch1/level"]');
  const member = page.locator('#midi-panel .mp-row[data-control="ch2/level"]');
  // The head shows the shared MIDI address ("CH 1 CC 7" = MIDI channel 1, CC 7);
  // the member drops the repeated address for a "Linked" marker and is grouped
  // under the head (the .linked row class rails + indents it).
  await expect(head).toContainText("CH 1 · Level");
  await expect(head).toContainText("CH 1 CC 7");
  await expect(head).not.toHaveClass(/\blinked\b/);
  await expect(member).toContainText("CH 2 · Level");
  await expect(member).toHaveClass(/\blinked\b/);
  await expect(member.locator(".mp-addr")).toHaveText("Linked");
  await expect(member).not.toContainText("CC 7"); // no repeated code address
  // The reported bug: the marker must not shift the mode/behavior select column.
  // Head and member selects stay left-aligned.
  const headSel = await head.locator(".mp-mode, .mp-btn").boundingBox();
  const memberSel = await member.locator(".mp-mode, .mp-btn").boundingBox();
  expect(memberSel!.x).toBeCloseTo(headSel!.x, 0);

  // One incoming CC moves both faders together.
  await sendMidi(page, [0xb0, 7, 127]);
  await expect(readLevel(page, "CH 1")).toHaveText("+10.0");
  await expect(readLevel(page, "CH 2")).toHaveText("+10.0");
  await sendMidi(page, [0xb0, 7, 0]);
  await expect(readLevel(page, "CH 1")).toHaveText("-∞");
  await expect(readLevel(page, "CH 2")).toHaveText("-∞");
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

test("an incoming DUCKER toggle repaints the parent strip's chip in place", async ({ page }) => {
  // Regression: the ducker is a node hung under its stereo channel, so it has no
  // strip of its own — its DUCKER chip lives on the parent strip. A MIDI edit
  // records the ducker node as dirty, and refreshStrip must retarget that to the
  // parent strip; otherwise the refs lookup misses and the chip stays stale until
  // a full re-render (switching GRAPH ↔ CONSOLE), which is exactly the reported bug.
  await openPanel(page);
  await pickInputPort(page);
  const duckChip = () => strip(page, "CH 5/6").getByRole("button", { name: "DUCKER" });
  await learnBinding(page, () => duckChip().click(), [0x90, 62, 127]); // a note binds on its first message
  const duckRow = page.locator('#midi-panel .mp-row[data-control="out.ducker1/duckerOn"]');
  await expect(duckRow).toContainText("CH 1 NOTE 62");
  // A hung ducker names its parent channel (not the bare "Ducker"), so the
  // assignment says which channel the ducker belongs to.
  await expect(duckRow.locator(".mp-ctl")).toHaveText("CH 5/6 · DUCKER");
  await page.locator("#midi-panel .mp-learn-btn").click(); // learn off

  // Still in CONSOLE view (no view switch): the chip must flip in place.
  await expect(duckChip()).not.toHaveClass(/\bon\b/);
  await sendMidi(page, [0x90, 62, 127]);
  await expect(duckChip()).toHaveClass(/\bon\b/);
  await sendMidi(page, [0x80, 62, 0], [0x90, 62, 127]); // release, press again
  await expect(duckChip()).not.toHaveClass(/\bon\b/);
});

test("the SENDS rack controls arm with send-scoped control ids", async ({ page }) => {
  await openPanel(page);
  await pickInputPort(page);
  const m1 = strip(page, "CH 1").locator(".con-scol", {
    has: page.getByRole("button", { name: "M1", exact: true }),
  });
  // The MIX 1 enable chip reuses the send-scoped mute id (old send-tab mappings work).
  await learnBinding(page, () => m1.getByRole("button", { name: "M1", exact: true }).click(), [0xb0, 30, 100], [0xb0, 30, 101]);
  await expect(page.locator('#midi-panel .mp-row[data-control="ch1/mute@bus.mix1"]')).toBeVisible();
  // The MIX 1 PRE button binds the send tap (a new toggle control).
  await learnBinding(page, () => m1.locator(".con-slp").click(), [0x90, 61, 127]);
  await expect(page.locator('#midi-panel .mp-row[data-control="ch1/tap@bus.mix1"]')).toBeVisible();
  // The MIX 1 column fader binds the send level.
  await learnBinding(page, () => m1.locator(".con-vfad").click(), [0xb0, 31, 100], [0xb0, 31, 101]);
  await expect(page.locator('#midi-panel .mp-row[data-control="ch1/level@bus.mix1"]')).toBeVisible();
  await page.locator("#midi-panel .mp-learn-btn").click(); // learn off

  // The bound note flips the PRE tap on.
  const pre = m1.locator(".con-slp");
  await expect(pre).toHaveAttribute("aria-pressed", "false");
  await sendMidi(page, [0x90, 61, 127]);
  await expect(pre).toHaveAttribute("aria-pressed", "true");
});

test("the scribble power LED arms the node master (chOn) and a note toggles it", async ({ page }) => {
  await openPanel(page);
  await pickInputPort(page);
  const power = () => strip(page, "CH 1").locator(".con-scribble.power");
  await learnBinding(page, () => power().click(), [0x90, 62, 127]);
  await expect(page.locator('#midi-panel .mp-row[data-control="ch1/chOn"]')).toBeVisible();
  await page.locator("#midi-panel .mp-learn-btn").click(); // learn off

  await expect(power()).toHaveAttribute("aria-pressed", "true"); // CH_ON ships on
  await sendMidi(page, [0x90, 62, 127]);
  await expect(power()).toHaveAttribute("aria-pressed", "false"); // toggled off
});

test("learn mode ignores a wheel over a fader so a stray scroll never edits it", async ({ page }) => {
  // The console fader/knob wheel handlers bail while learn is active, so scrolling
  // over an armable control neither edits its level nor consumes the arm gesture.
  await openPanel(page);
  await pickInputPort(page);
  await page.locator("#midi-panel .mp-learn-btn").click(); // learn on
  await expect(page.locator("#console-host")).toHaveClass(/midi-learn/);

  const fader = strip(page, "CH 1").locator(".con-fader");
  await expect(readLevel(page, "CH 1")).toHaveText("0.0");
  const box = await fader.boundingBox();
  if (!box) throw new Error("fader has no bounding box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -100); // a wheel notch up — would be +0.4 dB outside learn
  await expect(readLevel(page, "CH 1")).toHaveText("0.0"); // unchanged: learn swallowed it

  // The control is still armable by click, proving the wheel did not consume learn.
  await fader.click();
  await expect(fader).toHaveClass(/midi-armed/);
});

test("edge-mode MUTE flips on every CC press even with no release-to-0 between", async ({ page }) => {
  // Regression for a Stream Deck "Push" button set to send 127 only (no 0 on
  // release, confirmed by a bus trace): edge mode must flip on every press, not
  // just the first — a rising-edge test would stick after the first press.
  await openPanel(page);
  await pickInputPort(page);
  const muteChip = () => strip(page, "CH 1").locator(".con-chip", { hasText: "MUTE" });
  await learnBinding(page, () => muteChip().click(), [0xb0, 20, 127], [0xb0, 20, 127]);
  await page.locator("#midi-panel .mp-learn-btn").click(); // learn off
  // Default button behavior is Momentary (edge).
  await expect(page.locator('#midi-panel .mp-row[data-control="ch1/mute"] .mp-btn')).toHaveValue("edge");

  await expect(muteChip()).not.toHaveClass(/\bon\b/);
  await sendMidi(page, [0xb0, 20, 127]); // press 1
  await expect(muteChip()).toHaveClass(/\bon\b/);
  await sendMidi(page, [0xb0, 20, 127]); // press 2 — same value, no 0 between
  await expect(muteChip()).not.toHaveClass(/\bon\b/);
  await sendMidi(page, [0xb0, 20, 127]); // press 3
  await expect(muteChip()).toHaveClass(/\bon\b/);
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
  await expect(info.locator(".ln")).toHaveCount(2); // one note per take-in mode (absolute / pickup)
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
  // The labels name the SENDER's button type (what the user reads on the
  // Stream Deck side): edge = "Momentary", state = "Toggle".
  await expect(row.locator('.mp-btn option[value="edge"]')).toHaveText("Momentary");
  await expect(row.locator('.mp-btn option[value="state"]')).toHaveText("Toggle");
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
  await pickOutputPort(page);
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

test("a toggle ignores the echo of its own feedback", async ({ page }) => {
  // A controller that reflects feedback back (a shared virtual MIDI bus, or a
  // plugin that re-sends its state when feedback changes it) returns the value
  // just sent; the mute must stay put instead of flipping straight back.
  await openPanel(page);
  await pickInputPort(page);
  const muteChip = () => strip(page, "CH 1").locator(".con-chip", { hasText: "MUTE" });
  await learnBinding(page, () => muteChip().click(), [0xb0, 20, 127], [0xb0, 20, 127]);
  await page.locator("#midi-panel .mp-learn-btn").click(); // learn off
  await pickOutputPort(page);

  await muteChip().click(); // mute via the UI
  await expect(muteChip()).toHaveClass(/\bon\b/);
  await expect.poll(() => page.evaluate(() => window.__midiTest.sent.at(-1))).toEqual([0xb0, 20, 127]); // feedback out
  await sendMidi(page, [0xb0, 20, 127]); // the echo
  await page.waitForTimeout(150);
  await expect(muteChip()).toHaveClass(/\bon\b/); // still muted
  // The echo is consumed one-shot: an equal press right after it is a real
  // press and still unmutes (a blanket window would eat it).
  await sendMidi(page, [0xb0, 20, 127]);
  await expect(muteChip()).not.toHaveClass(/\bon\b/);
});

test("feedback follows a device fetch out of the output port", async ({ page }) => {
  // A fetch readback rewrites the plan without markChanged, so it must push the
  // fetched values to the controller itself — otherwise the next touch of the
  // physical control would send the stale value back and overwrite the plan.
  await openPanel(page);
  await pickInputPort(page);
  await learnBinding(page, () => strip(page, "CH 1").locator(".con-fader").click(), [0xb0, 7, 64], [0xb0, 7, 65]);
  await page.locator("#midi-panel .mp-learn-btn").click(); // learn off
  await pickOutputPort(page);

  // Park the fader at -∞ so the stubbed readback (every read = 0 → 0.0 dB) is a
  // real change, and drain the port-open resync + the edit's own feedback before
  // fetching (the resync already carried a CC 7 above zero).
  const fader = strip(page, "CH 1").locator(".con-fader");
  await fader.click();
  await fader.press("End");
  await expect.poll(() => page.evaluate(() => window.__midiTest.sent.at(-1))).toEqual([0xb0, 7, 0]);
  await page.evaluate(() => (window.__midiTest.sent.length = 0));

  await page.click("#btn-device");
  await page.click("#btn-fetch");
  await expect(readLevel(page, "CH 1")).toHaveText("0.0"); // the fetch landed
  // The fetched level goes out as feedback: CC 7 with the 0.0 dB position (> 0).
  await expect
    .poll(() => page.evaluate(() => window.__midiTest.sent.find((b) => b[0] === 0xb0 && b[1] === 7)?.[2] ?? -1))
    .toBeGreaterThan(0);
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
