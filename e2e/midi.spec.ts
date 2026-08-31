import { test, expect, type Page } from "./fixtures";
import { LIVE_COMMANDS } from "./tauri-stub";
import { pickBand } from "./dyn-helpers";
import { chooseOption } from "./choose-option";
import { selectWire } from "./graph-helpers";

// External MIDI control is desktop-only (isTauri gate), so these tests stub the
// Tauri IPC bridge before the app boots: invoke() answers the boot-time queries,
// captures the MIDI input channel (so the test can push messages into the app),
// and records outgoing midi_send bytes (so feedback is observable).
//
// MIDI control is a second OS window, which is a second PAGE here. The stub is
// installed on the context rather than the page so both get it, and the relay the
// Rust side provides between the two webviews is faked over a BroadcastChannel —
// which, like the real relay, never delivers a message back to its sender.

declare global {
  interface Window {
    __midiTest: {
      inChannel: { onmessage: (batch: Array<{ bytes: number[] }>) => void } | null;
      inputPort: string | null;
      outputPort: string | null;
      sent: number[][];
      /** Set once open_midi_window is invoked, so the menu entry is observable. */
      windowOpened: boolean;
      /** How long `midi_open_ports` holds its answer before delivering it. */
      openPortsDelayMs: number;
      /** How many held answers have actually been delivered. A test that opens a port
       *  "inside the round trip" has to show the trip had not ended yet; a clock cannot
       *  show it, and if the trip ended first the race is simply absent and every
       *  assertion after it passes for the wrong reason. */
      openPortsAnswered: number;
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

/** Wait page-side for the NEXT feedback message (the caller having cleared `sent`) and
 *  echo it straight back in, in the same task — no driver round trip, so it lands inside
 *  the engine's guard window the way a reflecting transport's does. Answers with the
 *  bytes it echoed, so a case can drive the same message again as a real press without
 *  assuming which value the surface was showing. */
const echoNextFeedback = (page: Page): Promise<number[]> =>
  page.evaluate(async () => {
    const deadline = performance.now() + 2000;
    while (performance.now() < deadline) {
      const last = window.__midiTest.sent.at(-1);
      if (last) {
        window.__midiTest.inChannel!.onmessage([{ bytes: last }]);
        return last;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("no feedback went out");
  });

/** Open the MIDI control window from the Device menu and attach to it. The shell
 *  command is stubbed, so the second page is opened here — the app's own state
 *  reaches it over the faked relay exactly as it would over the real one. */
const openMidiWindow = async (page: Page): Promise<Page> => {
  await page.click("#btn-device");
  await page.click("#btn-midi");
  await expect.poll(() => page.evaluate(() => window.__midiTest.windowOpened)).toBe(true);
  const win = await page.context().newPage();
  await win.goto("/midi.html");
  await expect(win.locator("#midi-window")).toBeVisible();
  // The window asks for state on boot; nothing it shows is its own.
  await expect(win.locator(".mw-title")).toHaveText("MIDI CONTROL");
  return win;
};

const pickInputPort = async (page: Page, win: Page) => {
  await expect(win.locator(".mw-in option")).toHaveCount(3); // None + Stub In + Broken In
  await chooseOption(win.locator(".mw-in"), "Stub In");
  await expect.poll(() => page.evaluate(() => window.__midiTest.inputPort)).toBe("Stub In");
};

const pickOutputPort = async (page: Page, win: Page) => {
  await chooseOption(win.locator(".mw-out"), "Stub Out");
  await expect.poll(() => page.evaluate(() => window.__midiTest.outputPort)).toBe("Stub Out");
};

const setLearn = async (page: Page, win: Page, on: boolean) => {
  const btn = win.locator(".mw-learnbtn");
  if ((await btn.getAttribute("aria-pressed")) !== String(on)) await btn.click();
  if (on) await expect(page.locator("#console-host")).toHaveClass(/midi-learn/);
  // The window holds none of this state: the click only sends an intent, and the
  // button flips when the answering push has been rendered. That render replaces
  // the whole body, so every node resolved before it is detached — and a later
  // measurement that lands on one reads as an element with no layout box. Waiting
  // for the flip is what orders the two.
  await expect(btn).toHaveAttribute("aria-pressed", String(on));
};

/** Learn one binding: arm a control (a locator inside the app window), then move
 *  the given MIDI control (two messages settle a plain CC without the flush timer). */
const learnBinding = async (page: Page, win: Page, arm: () => Promise<void>, ...msgs: number[][]) => {
  await setLearn(page, win, true);
  await arm();
  await sendMidi(page, ...msgs);
};

/** One assignment row in the MIDI window's table. */
const mapRow = (win: Page, control: string) => win.locator(`.mw-list tr[data-control="${control}"]`);

/** Every control that must be unusable while a destructive run holds the device link
 *  (the self-test entry is not here — it is that run's own cancel). */
const LOCKED_UNDER_A_RUN = [
  "#btn-live",
  "#btn-fetch",
  "#btn-write",
  "#btn-compare",
  "#btn-device-setup",
  "#btn-open-settings",
  "#follow-usb",
  "#rate-picker",
];

test.beforeEach(async ({ page }) => {
  // The Live-sync registrations are taken from the shared stub rather than copied,
  // so this stub cannot fall behind what a session actually asks the shell for.
  await page.context().addInitScript((extra: Record<string, unknown>) => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-model", "URX44V");
    localStorage.setItem("urx-disclaimer-accepted", "1"); // skip the consent gate
    const state: Window["__midiTest"] = {
      inChannel: null,
      inputPort: null,
      outputPort: null,
      sent: [],
      windowOpened: false,
      openPortsDelayMs: 0,
      openPortsAnswered: 0,
    };
    window.__midiTest = state;
    class Channel {
      onmessage: (data: unknown) => void = () => {};
    }
    // What the vd stub below has been written, by parameter instance.
    const written = new Map<string, number>();
    // The UI relay: each side registers a receiver, and a post reaches the other
    // page only (BroadcastChannel does not echo to its sender, and neither does
    // the Rust relay it stands in for).
    let toMain: Channel | null = null;
    let toWindow: Channel | null = null;
    const relay = new BroadcastChannel("urx-midi-ui");
    relay.onmessage = (e: MessageEvent<{ dir: string; payload: string }>) => {
      if (e.data.dir === "main") toMain?.onmessage(e.data.payload);
      else toWindow?.onmessage(e.data.payload);
    };
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      Channel,
      invoke: (cmd: string, args: Record<string, unknown>) => {
        switch (cmd) {
          // MIDI control ships without the flag (only the self-test is gated), so this
          // is off unless a test asks for it — through localStorage, which is the same
          // stand-in for launch/shell state `urx-test-midiwin` uses below, and the only
          // one that survives the reload the flag has to be read at boot on.
          case "experimental_enabled":
            return Promise.resolve(!!localStorage.getItem("urx-test-experimental"));
          case "self_test_requested":
          case "reset_storage_requested":
            return Promise.resolve(false);
          case "plugin:updater|check":
            return Promise.resolve(null);
          // The "Broken" ports refuse to open (a WinMM-style exclusive port
          // already held by another app), for the failed-open UI tests.
          case "midi_list_inputs":
            return Promise.resolve(["Stub In", "Broken In"]);
          case "midi_list_outputs":
            return Promise.resolve(["Stub Out", "Broken Out"]);
          // What the shell actually holds. The app checks its own idea of the
          // chosen ports against this on every refresh, so a test can close a
          // port "from the shell" the way the page-load teardown once did.
          case "midi_open_ports": {
            // The answer describes the moment it is taken, and the app receives it
            // later: `openPortsDelayMs` opens that gap on purpose, so a test can let a
            // port be opened inside the round trip and see whether the stale answer
            // wins. Zero by default, which is one task's delay — as it is in Tauri.
            const answer: [string | null, string | null] = [state.inputPort, state.outputPort];
            return new Promise((r) =>
              setTimeout(() => {
                state.openPortsAnswered++;
                r(answer);
              }, state.openPortsDelayMs),
            );
          }
          case "midi_open_input":
            if (args.port === "Broken In") return Promise.reject(new Error("port busy"));
            state.inChannel = args.channel as Window["__midiTest"]["inChannel"];
            state.inputPort = args.port as string;
            return Promise.resolve();
          case "midi_close_input":
            state.inChannel = null;
            state.inputPort = null;
            return Promise.resolve();
          case "midi_open_output":
            if (args.port === "Broken Out") return Promise.reject(new Error("port busy"));
            state.outputPort = args.port as string;
            return Promise.resolve();
          case "midi_close_output":
            state.outputPort = null;
            return Promise.resolve();
          case "midi_send":
            state.sent.push(args.bytes as number[]);
            return Promise.resolve();
          // The window itself is opened by the test (Playwright drives the second
          // page); the shell command only has to succeed and be observable.
          // The shell owns the window's existence, which is why it survives a
          // reload of THIS page: localStorage stands in for that, so
          // midi_window_open can still answer "there is a window".
          case "open_midi_window":
            state.windowOpened = true;
            localStorage.setItem("urx-test-midiwin", "1");
            return Promise.resolve();
          case "close_midi_window":
            localStorage.removeItem("urx-test-midiwin");
            return Promise.resolve();
          case "focus_midi_window":
            return Promise.resolve();
          case "midi_window_open":
            return Promise.resolve(!!localStorage.getItem("urx-test-midiwin"));
          case "midi_ui_attach_main":
            toMain = args.channel as Channel;
            return Promise.resolve();
          case "midi_ui_attach_window":
            toWindow = args.channel as Channel;
            return Promise.resolve();
          case "midi_ui_to_main":
            // The window going away is the shell's business too: once it is
            // destroyed, get_webview_window answers None. Modelling that is what
            // makes "reopen after a reload" and "still open across a reload" two
            // different situations here, as they are in the app.
            if (String(args.payload).includes('"closed"')) localStorage.removeItem("urx-test-midiwin");
            relay.postMessage({ dir: "main", payload: args.payload });
            return Promise.resolve();
          case "midi_ui_to_window":
            relay.postMessage({ dir: "window", payload: args.payload });
            return Promise.resolve();
          // Minimal vd surface for the fetch feedback test: a matching device with
          // no firmware gate, every parameter read answering 0 (CH levels = 0.0 dB).
          case "vd_connect":
            // Held open while the flag is set, and failed the moment it is cleared. A
            // self-test is minutes of round-trips against real hardware and cannot be
            // played out here; holding it at its first await is what makes the window
            // it keeps open observable, and releasing it is what shows the window ends.
            if (localStorage.getItem("urx-test-vd-hold")) {
              return new Promise((_resolve, reject) => {
                const tick = setInterval(() => {
                  if (localStorage.getItem("urx-test-vd-hold")) return;
                  clearInterval(tick);
                  reject(new Error("link lost"));
                }, 20);
              });
            }
            return Promise.resolve({ model: "URX44V", label: "Stub URX", firmware: "", epoch: 1 });
          case "vd_disconnect":
            return Promise.resolve();
          // A write is readable afterwards, the way main.test-util's device stub is:
          // feedback needs a live session to flow at all now, and inside one an edit
          // writes and the follow layer reads back. Answering 0 to that read would
          // undo every edit these cases make — the converge would report the value it
          // just wrote as refused and put the old one back.
          case "vd_get":
            return Promise.resolve(written.get(`${args.paramId}/${args.x}/${args.y}`) ?? 0);
          case "vd_set":
            written.set(`${args.paramId}/${args.x}/${args.y}`, args.value as number);
            return Promise.resolve();
          case "vd_set_str":
            return Promise.resolve();
          case "vd_get_str":
            return Promise.resolve("");
          case "plugin:dialog|message":
            return Promise.resolve("Ok"); // confirm dialogs (discard edits): proceed
          default:
            return cmd in extra
              ? Promise.resolve(extra[cmd])
              : Promise.reject(new Error(`stub: unhandled command ${cmd}`));
        }
      },
    };
  }, LIVE_COMMANDS);
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

test("closing the MIDI window drops learn mode", async ({ page }) => {
  const win = await openMidiWindow(page);
  await setLearn(page, win, true);
  await expect(page.locator("#console-host")).toHaveClass(/midi-learn/);
  // The window is an OS window: it goes away with its own chrome, and the app has
  // to hear about it — a learn left armed would swallow the next console click.
  await win.close();
  await expect(page.locator("#console-host")).not.toHaveClass(/midi-learn/);
});

test("a click on a console control arms instead of editing while learn is on", async ({ page }) => {
  const win = await openMidiWindow(page);
  const before = await readLevel(page, "CH 1").textContent();
  await setLearn(page, win, true);
  await strip(page, "CH 1").locator(".con-fader").click();
  // Armed, not moved: the window names what it is waiting for.
  await expect(win.locator(".mw-hint")).toContainText("CH 1 · Level");
  expect(await readLevel(page, "CH 1").textContent()).toBe(before);
});

test("learn binds a CC to a fader and incoming CC moves it", async ({ page }) => {
  const win = await openMidiWindow(page);
  await pickInputPort(page, win);
  await learnBinding(
    page,
    win,
    () => strip(page, "CH 1").locator(".con-fader").click(),
    [0xb0, 7, 100],
    [0xb0, 7, 101],
  );
  // The binding lands in the assignment list, keyed by the console wording.
  const row = mapRow(win, "ch1/level");
  await expect(row).toBeVisible();
  await expect(row).toContainText("CH 1 · Level");
  await expect(row).toContainText("CH 1 CC 7");
  // The name cell ellipsizes long labels; the title carries the full wording.
  await expect(row.locator(".mw-ctl")).toHaveAttribute("title", "CH 1 · Level");
  // Learn stays on for the next binding; the mapped control shows its dot.
  await expect(strip(page, "CH 1").locator(".con-fader")).toHaveClass(/midi-mapped/);
  await setLearn(page, win, false);

  await sendMidi(page, [0xb0, 7, 127]);
  await expect(readLevel(page, "CH 1")).toHaveText("+10.0");
  await sendMidi(page, [0xb0, 7, 0]);
  await expect(readLevel(page, "CH 1")).toHaveText("-∞");
});

test("a running self-test freezes incoming MIDI, and releases it when the run ends", async ({ page }) => {
  // The self-test perturbs the unit and then verifies address by address that it
  // holds what was written, so a controller move landing inside that window is
  // reported as a write the device refused. It owns its own connection, which is why
  // nothing about the app's own session state can stand in for this latch.
  await page.evaluate(() => localStorage.setItem("urx-test-experimental", "1"));
  await page.reload();
  await expect(page.locator("#console-host")).toBeVisible();

  const win = await openMidiWindow(page);
  await pickInputPort(page, win);
  await learnBinding(
    page,
    win,
    () => strip(page, "CH 1").locator(".con-fader").click(),
    [0xb0, 7, 100],
    [0xb0, 7, 101],
  );
  await setLearn(page, win, false);
  await sendMidi(page, [0xb0, 7, 127]);
  await expect(readLevel(page, "CH 1")).toHaveText("+10.0");

  // Start a run and hold it at its connect (see the vd_connect case in the stub).
  await page.evaluate(() => localStorage.setItem("urx-test-vd-hold", "1"));
  await page.click("#btn-device");
  await page.click("#btn-selftest"); // its confirm is answered Ok by the stub
  await expect(page.locator("#statusbar")).toContainText("Running device self-test");

  // The refusal is what orders this: asserting the level alone would be satisfied by
  // its first sample, taken before the message had been decoded at all.
  await sendMidi(page, [0xb0, 7, 0]);
  await expect(page.locator("#statusbar")).toContainText("incoming MIDI is ignored");
  await expect(readLevel(page, "CH 1")).toHaveText("+10.0");

  // Everything that would take the connection away is locked for the same window —
  // the shell has one slot, so a second connect does not run beside the run, it
  // replaces it. Follow USB is here too: a live SESSION lends it the session's link,
  // but a run does not, so its handler would open one. The self-test entry stays
  // live because it IS the cancel.
  for (const id of LOCKED_UNDER_A_RUN) await expect(page.locator(id)).toBeDisabled();
  await expect(page.locator("#btn-selftest")).toBeEnabled();

  // Release the connect: the run fails, and the window it held closes with it.
  await page.evaluate(() => localStorage.removeItem("urx-test-vd-hold"));
  await expect(page.locator("#btn-selftest")).toHaveText("Self-test (experimental)"); // over, not cancelling
  for (const id of LOCKED_UNDER_A_RUN) await expect(page.locator(id)).toBeEnabled();
  await sendMidi(page, [0xb0, 7, 0]);
  await expect(readLevel(page, "CH 1")).toHaveText("-∞");
});

test("an action already holding the link locks the self-test, not the other way round", async ({ page }) => {
  // The mirror of the case above, and the order that used to be open: the lock was
  // applied by whoever started LAST, so a self-test begun during a Fetch or a
  // Live-sync readback took the connection off it — and, when that live start then
  // completed, disabled both its own cancel and the toggle that would have stopped
  // the session.
  await page.evaluate(() => {
    localStorage.setItem("urx-test-experimental", "1");
    localStorage.setItem("urx-test-vd-hold", "1");
  });
  await page.reload();
  await expect(page.locator("#console-host")).toBeVisible();

  await page.click("#btn-device");
  await page.click("#btn-fetch"); // holds at its connect, exactly as a real read holds for seconds
  await expect(page.locator("#statusbar")).toContainText("Connecting");

  // Fetch keeps its own entry (it is its cancel) and every other holder is refused.
  await expect(page.locator("#btn-fetch")).toBeEnabled();
  for (const id of ["#btn-selftest", "#btn-live", "#btn-write", "#btn-compare", "#follow-usb"]) {
    await expect(page.locator(id)).toBeDisabled();
  }

  await page.evaluate(() => localStorage.removeItem("urx-test-vd-hold"));
  await expect(page.locator("#btn-selftest")).toBeEnabled();
  await expect(page.locator("#btn-live")).toBeEnabled();
});

test("one physical control can gang several console controls", async ({ page }) => {
  // Assigning the same MIDI control to a second console control links them: one
  // CC drives both at once, and the later row is tagged as linked to the first
  // (which owns the feedback). Saves learning every send source individually.
  const win = await openMidiWindow(page);
  await pickInputPort(page, win);
  await learnBinding(
    page,
    win,
    () => strip(page, "CH 1").locator(".con-fader").click(),
    [0xb0, 7, 100],
    [0xb0, 7, 101],
  );
  await learnBinding(
    page,
    win,
    () => strip(page, "CH 2").locator(".con-fader").click(),
    [0xb0, 7, 100],
    [0xb0, 7, 101],
  );
  await setLearn(page, win, false);

  const head = mapRow(win, "ch1/level");
  const member = mapRow(win, "ch2/level");
  // The head shows the shared MIDI address ("CH 1 CC 7" = MIDI channel 1, CC 7);
  // the member drops the repeated address for a "Linked" marker and is grouped
  // under the head (the .linked row class rails + indents it).
  await expect(head).toContainText("CH 1 · Level");
  await expect(head).toContainText("CH 1 CC 7");
  await expect(head).not.toHaveClass(/\blinked\b/);
  await expect(member).toContainText("CH 2 · Level");
  await expect(member).toHaveClass(/\blinked\b/);
  await expect(member.locator(".mw-addr, .mw-linked")).toHaveText("Linked");
  await expect(member).not.toContainText("CC 7"); // no repeated code address
  // The reported bug: the marker must not shift the mode/behavior select column.
  // Head and member selects stay left-aligned.
  const headSel = await head.locator(".mw-mode, .mw-btn").boundingBox();
  const memberSel = await member.locator(".mw-mode, .mw-btn").boundingBox();
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
  const win = await openMidiWindow(page);
  await pickInputPort(page, win);
  const muteChip = () => strip(page, "CH 1").locator(".con-chip", { hasText: "MUTE" });
  await learnBinding(page, win, () => muteChip().click(), [0x90, 60, 127]); // a note binds on its first message
  await expect(mapRow(win, "ch1/mute")).toContainText("CH 1 NOTE 60");
  await setLearn(page, win, false);

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
  const win = await openMidiWindow(page);
  await pickInputPort(page, win);
  const duckChip = () => strip(page, "CH 5/6").getByRole("button", { name: "DUCKER", exact: true });
  await learnBinding(page, win, () => duckChip().click(), [0x90, 62, 127]); // a note binds on its first message
  const duckRow = mapRow(win, "out.ducker1/duckerOn");
  await expect(duckRow).toContainText("CH 1 NOTE 62");
  // A hung ducker names its parent channel (not the bare "Ducker"), so the
  // assignment says which channel the ducker belongs to.
  await expect(duckRow.locator(".mw-ctl")).toHaveText("CH 5/6 · DUCKER");
  await setLearn(page, win, false);

  // Still in CONSOLE view (no view switch): the chip must flip in place.
  await expect(duckChip()).not.toHaveClass(/\bon\b/);
  await sendMidi(page, [0x90, 62, 127]);
  await expect(duckChip()).toHaveClass(/\bon\b/);
  await sendMidi(page, [0x80, 62, 0], [0x90, 62, 127]); // release, press again
  await expect(duckChip()).not.toHaveClass(/\bon\b/);
});

test("an incoming DUCKER toggle repaints the inspector's PRE-send note in place", async ({ page }) => {
  // The other half of the case above: the same MIDI edit, read by the panel rather than
  // by a strip. The panel's repaint is scoped to the nodes `inspectorNodes` names, and a
  // ducker is not one the SELECTION names — the wire's source is the host CHANNEL, and
  // the ducker hangs off it as a node of its own.
  const win = await openMidiWindow(page);
  await pickInputPort(page, win);
  const duckChip = () => strip(page, "CH 5/6").getByRole("button", { name: "DUCKER", exact: true });
  await learnBinding(page, win, () => duckChip().click(), [0x90, 62, 127]);
  await setLearn(page, win, false);

  // The send the note is about, put on its PRE tap. Selected for the rest of the case —
  // the panel must never change subject, or a note that went away went away with it.
  await page.click("#btn-view-graph");
  await selectWire(page, "ch_5_6:out", "bus.mix1:in");
  const panel = page.locator("#inspector");
  await panel.getByRole("button", { name: "PRE", exact: true }).click();
  const note = panel.getByText(/PRE \(pre-fader\) send taps ahead of it/);
  await expect(note).toHaveCount(0);

  // On, then off, with no click on anything the panel draws in between.
  await sendMidi(page, [0x90, 62, 127]);
  await expect(note).toHaveCount(1);
  await sendMidi(page, [0x80, 62, 0], [0x90, 62, 127]); // release, press again
  await expect(note).toHaveCount(0);
  // Still the same selection, so the note followed the Ducker rather than the panel
  // being rebuilt for something else.
  await expect(panel.getByRole("button", { name: "PRE", exact: true })).toHaveCount(1);
});

test("the SENDS rack controls arm with send-scoped control ids", async ({ page }) => {
  const win = await openMidiWindow(page);
  await pickInputPort(page, win);
  const m1 = strip(page, "CH 1").locator(".con-scol", {
    has: page.getByRole("button", { name: "M1", exact: true }),
  });
  // The MIX 1 enable chip reuses the send-scoped mute id (old send-tab mappings work).
  await learnBinding(
    page,
    win,
    () => m1.getByRole("button", { name: "M1", exact: true }).click(),
    [0xb0, 30, 100],
    [0xb0, 30, 101],
  );
  await expect(mapRow(win, "ch1/mute@bus.mix1")).toBeVisible();
  // The MIX 1 PRE button binds the send tap (a new toggle control).
  await learnBinding(page, win, () => m1.locator(".con-slp").click(), [0x90, 61, 127]);
  await expect(mapRow(win, "ch1/tap@bus.mix1")).toBeVisible();
  // The MIX 1 column fader binds the send level.
  await learnBinding(page, win, () => m1.locator(".con-vfad").click(), [0xb0, 31, 100], [0xb0, 31, 101]);
  await expect(mapRow(win, "ch1/level@bus.mix1")).toBeVisible();
  await setLearn(page, win, false);

  // The bound note flips the PRE tap on.
  const pre = m1.locator(".con-slp");
  await expect(pre).toHaveAttribute("aria-pressed", "false");
  await sendMidi(page, [0x90, 61, 127]);
  await expect(pre).toHaveAttribute("aria-pressed", "true");
});

test("the scribble power LED arms the node master (chOn) and a note toggles it", async ({ page }) => {
  const win = await openMidiWindow(page);
  await pickInputPort(page, win);
  const power = () => strip(page, "CH 1").locator(".con-scribble.power");
  await learnBinding(page, win, () => power().click(), [0x90, 62, 127]);
  await expect(mapRow(win, "ch1/chOn")).toBeVisible();
  await setLearn(page, win, false);

  await expect(power()).toHaveAttribute("aria-pressed", "true"); // CH_ON ships on
  await sendMidi(page, [0x90, 62, 127]);
  await expect(power()).toHaveAttribute("aria-pressed", "false"); // toggled off
});

test("learn mode ignores a wheel over a fader so a stray scroll never edits it", async ({ page }) => {
  // The console fader/knob wheel handlers bail while learn is active, so scrolling
  // over an armable control neither edits its level nor consumes the arm gesture.
  const win = await openMidiWindow(page);
  await pickInputPort(page, win);
  await setLearn(page, win, true);
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
  const win = await openMidiWindow(page);
  await pickInputPort(page, win);
  const muteChip = () => strip(page, "CH 1").locator(".con-chip", { hasText: "MUTE" });
  await learnBinding(page, win, () => muteChip().click(), [0xb0, 20, 127], [0xb0, 20, 127]);
  await setLearn(page, win, false);
  // Default button behavior is Momentary (edge).
  await expect(mapRow(win, "ch1/mute").locator(".mw-btn")).toHaveValue("edge");

  await expect(muteChip()).not.toHaveClass(/\bon\b/);
  await sendMidi(page, [0xb0, 20, 127]); // press 1
  await expect(muteChip()).toHaveClass(/\bon\b/);
  await sendMidi(page, [0xb0, 20, 127]); // press 2 — same value, no 0 between
  await expect(muteChip()).not.toHaveClass(/\bon\b/);
  await sendMidi(page, [0xb0, 20, 127]); // press 3
  await expect(muteChip()).toHaveClass(/\bon\b/);
});

test("assignment rows form aligned columns whatever each row's option is", async ({ page }) => {
  // A continuous row carries a take-in mode and a toggle row a button behavior —
  // two vocabularies of different widths in one column. The table is what keeps
  // them aligned, so the cells are pinned rather than the controls: a hand-built
  // row (the old flex layout) needed a fixed select width to hold this, and lost
  // it the moment a label grew.
  const win = await openMidiWindow(page);
  await pickInputPort(page, win);
  await learnBinding(
    page,
    win,
    () => strip(page, "CH 1").locator(".con-fader").click(),
    [0xb0, 7, 100],
    [0xb0, 7, 101],
  );
  await learnBinding(
    page,
    win,
    () => strip(page, "CH 1").locator(".con-chip", { hasText: "MUTE" }).click(),
    [0x90, 60, 127],
  );
  await setLearn(page, win, false);

  // Both rows first: the window renders from a relayed state push, and a column
  // measured while the table still holds one row is measuring a different table.
  await expect(win.locator(".mw-list tbody tr")).toHaveCount(2);
  // `boundingBox()` returning null here was this suite's open flake for five
  // occurrences, and it was the learn-off push arriving between a locator's resolve
  // and the measurement built on it: the node measured had been detached by the
  // rebuild, while a fresh query of the same selector kept answering the healthy
  // rect every dump showed. `setLearn` now waits for that push, which is the fix.
  // The dump stays because it is what settled it, and because a null that survives
  // the ordering is a different mechanism and has to say so. The reproduction and
  // the five occurrences are in reference/work/e2e-flakes.md; read it first.
  const boxOf = async (cell: ReturnType<typeof mapRow>, control: string, what: string) => {
    const box = await cell.boundingBox();
    if (box) return box;
    const dump = await win.evaluate((c) => {
      const tr = document.querySelector(`tr[data-control="${c}"]`);
      const td = tr?.querySelector("td.mw-opt") as HTMLElement | null;
      const host = document.querySelector("#midi-window");
      return {
        hidden: document.hidden,
        visibility: document.visibilityState,
        rows: document.querySelectorAll(".mw-list tbody tr").length,
        row: tr?.outerHTML ?? "(no row)",
        tdRect: td ? JSON.stringify(td.getBoundingClientRect()) : "(no td)",
        tdDisplay: td ? getComputedStyle(td).display : "(no td)",
        hostRect: host ? JSON.stringify(host.getBoundingClientRect()) : "(no host)",
        viewport: `${innerWidth}x${innerHeight}`,
      };
    }, control);
    // And the layer the DOM dump above cannot see. Asked directly, `DOM.getBoxModel`
    // answered a healthy box for the node this selector matches — which is how the
    // null was pinned on the handle rather than on the element: Playwright measures
    // what it resolved, and this resolves again. Keep both readings, since a
    // recurrence is only informative if it shows which of the two moved.
    let boxModel: string;
    try {
      const cdp = await win.context().newCDPSession(win);
      const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
      const { nodeId } = await cdp.send("DOM.querySelector", {
        nodeId: root.nodeId,
        selector: `tr[data-control="${control}"] ${what}`,
      });
      boxModel = nodeId
        ? JSON.stringify(await cdp.send("DOM.getBoxModel", { nodeId }))
        : "(DOM.querySelector matched nothing)";
      await cdp.detach();
    } catch (e) {
      // The throw IS the reading here — the protocol error names why the box is absent.
      boxModel = `threw: ${e instanceof Error ? e.message : String(e)}`;
    }
    throw new Error(`no bounding box for ${what} (${control}): ${JSON.stringify({ ...dump, boxModel })}`);
  };
  const optCell = (control: string) => boxOf(mapRow(win, control).locator("td.mw-opt"), control, "td.mw-opt");
  const delCell = (control: string) => boxOf(mapRow(win, control).locator(".mw-del"), control, ".mw-del");
  const level = await optCell("ch1/level");
  const mute = await optCell("ch1/mute");
  expect(level.x).toBeCloseTo(mute.x, 0);
  expect(level.width).toBeCloseTo(mute.width, 0);
  // And the delete button stays in its own column rather than being pushed by the
  // wider of the two option labels.
  expect((await delCell("ch1/level")).x).toBeCloseTo((await delCell("ch1/mute")).x, 0);
});

test("every assignment row prints its control, address and behavior", async ({ page }) => {
  const win = await openMidiWindow(page);
  await pickInputPort(page, win);
  await learnBinding(
    page,
    win,
    () => strip(page, "CH 1").locator(".con-fader").click(),
    [0xb0, 7, 100],
    [0xb0, 7, 101],
  );
  await learnBinding(
    page,
    win,
    () => strip(page, "CH 1").locator(".con-chip", { hasText: "MUTE" }).click(),
    [0x90, 60, 127],
  );
  await setLearn(page, win, false);

  // The name is not ellipsized away: the window is where the operator reads what
  // is bound to what, so the whole control name is in the cell.
  const level = mapRow(win, "ch1/level");
  await expect(level.locator(".mw-ctl")).toHaveText("CH 1 · Level");
  await expect(level.locator(".mw-addr")).toHaveText("CH 1 CC 7");
  await expect(level.locator(".mw-mode")).toBeVisible(); // continuous → take-in mode
  const mute = mapRow(win, "ch1/mute");
  await expect(mute.locator(".mw-addr")).toHaveText("CH 1 NOTE 60");
  await expect(mute.locator(".mw-btn")).toBeVisible(); // toggle → button behavior
  // The same select repeats down the column, so it announces its own row too.
  await expect(level.locator(".mw-mode")).toHaveAttribute("aria-label", "Take-in mode — CH 1 · Level");
  await expect(mute.locator(".mw-btn")).toHaveAttribute("aria-label", "Button behavior — CH 1 · MUTE");
});

test("the behavior column prints a key for the vocabularies the list uses", async ({ page }) => {
  // What a native dropdown cannot say about its own options. The regression ground
  // is the window move, which dropped the panel's hover-revealed card and left the
  // notes in the i18n table with nothing reading them: every select then offered
  // Momentary / Toggle with no way to find out what either does.
  const win = await openMidiWindow(page);
  await pickInputPort(page, win);
  const legend = win.locator(".mw-legend");
  await expect(legend).toHaveCount(0); // nothing bound: nothing to explain

  // A continuous control brings the take-in vocabulary, and only that one — the key
  // describes the selects on screen, not every select the window can build.
  await learnBinding(
    page,
    win,
    () => strip(page, "CH 1").locator(".con-fader").click(),
    [0xb0, 7, 100],
    [0xb0, 7, 101],
  );
  await expect(legend.locator("h4")).toHaveText(["Take-in mode"]);
  await expect(legend.locator("dt")).toHaveText(["Absolute", "Pickup"]);
  await expect(legend.locator("dd").first()).toContainText("Applies the received value as-is");

  // A toggle adds the second vocabulary beside it.
  await learnBinding(
    page,
    win,
    () => strip(page, "CH 1").locator(".con-chip", { hasText: "MUTE" }).click(),
    [0x90, 60, 127],
  );
  await expect(legend.locator("h4")).toHaveText(["Take-in mode", "Button behavior"]);
  await expect(legend.locator("dt")).toHaveText(["Absolute", "Pickup", "Momentary", "Toggle"]);
  await expect(legend.locator("dd").last()).toContainText("64 and above = on");

  // Removing the only continuous binding takes its half of the key with it.
  await setLearn(page, win, false);
  await mapRow(win, "ch1/level").locator(".mw-del").click();
  await expect(legend.locator("h4")).toHaveText(["Button behavior"]);
  await expect(legend.locator("dt")).toHaveText(["Momentary", "Toggle"]);
});

test("a follow-value toggle responds to every press of an alternating button", async ({ page }) => {
  // Stream Deck style: the MIDI plugin's toggle button sends one CC per press,
  // alternating 127 / 0. Default edge mode flips on the 127 presses only; the
  // per-mapping "Follow value" behavior must respond to every press.
  const win = await openMidiWindow(page);
  await pickInputPort(page, win);
  const muteChip = () => strip(page, "CH 1").locator(".con-chip", { hasText: "MUTE" });
  await learnBinding(page, win, () => muteChip().click(), [0xb0, 20, 127], [0xb0, 20, 127]);
  await setLearn(page, win, false);

  const row = mapRow(win, "ch1/mute");
  // The labels name the SENDER's button type (what the user reads on the
  // Stream Deck side): edge = "Momentary", state = "Toggle".
  await expect(row.locator('.mw-btn option[value="edge"]')).toHaveText("Momentary");
  await expect(row.locator('.mw-btn option[value="state"]')).toHaveText("Toggle");
  await chooseOption(row.locator(".mw-btn"), "state");
  await sendMidi(page, [0xb0, 20, 127]);
  await expect(muteChip()).toHaveClass(/\bon\b/); // 127 = muted
  await sendMidi(page, [0xb0, 20, 0]);
  await expect(muteChip()).not.toHaveClass(/\bon\b/); // 0 = unmuted — the press edge mode misses
  await sendMidi(page, [0xb0, 20, 127]);
  await expect(muteChip()).toHaveClass(/\bon\b/);
});

test("feedback follows UI edits out of the output port", async ({ page }) => {
  const win = await openMidiWindow(page);
  await pickInputPort(page, win);
  await learnBinding(page, win, () => strip(page, "CH 1").locator(".con-fader").click(), [0xb0, 7, 64], [0xb0, 7, 65]);
  await setLearn(page, win, false);

  // Opening the output port sends nothing on its own: what a pass would carry is the
  // PLAN's values, and until a Live-sync readback settles those are whatever was loaded
  // rather than what the unit holds. On a shared bus that push is another listener's
  // incoming gesture, which is how a second instance of this app rewrote CH 1's gain.
  await pickOutputPort(page, win);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__midiTest.sent.length)).toBe(0);

  // The session's readback is what opens it, and every binding is resynced there.
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true");
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
  const win = await openMidiWindow(page);
  await pickInputPort(page, win);
  const muteChip = () => strip(page, "CH 1").locator(".con-chip", { hasText: "MUTE" });
  await learnBinding(page, win, () => muteChip().click(), [0xb0, 20, 127], [0xb0, 20, 127]);
  await setLearn(page, win, false);
  await pickOutputPort(page, win);
  // Feedback reaches the wire only while a session holds the plan to the unit, and this
  // case is about what comes BACK off that wire.
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true");
  // Waited on the send itself rather than on the session: the port's own open and the
  // session's readback race here, and whichever runs second is the pass that carries
  // the state out. Moving on before one of them has is what leaves the guard unarmed.
  await expect.poll(() => page.evaluate(() => window.__midiTest.sent.length)).toBeGreaterThan(0);
  await page.evaluate(() => (window.__midiTest.sent.length = 0));

  // The readback leaves this chip muted (the stub answers 0 for every read, which is the
  // send switched off). Unmute first, so the edit under test feeds back the ON value:
  // an edge toggle ignores a repeat of a release, and the second half below presses the
  // fed message again as a real press.
  if (/\bon\b/.test((await muteChip().getAttribute("class")) ?? "")) {
    await muteChip().click();
    await expect.poll(() => page.evaluate(() => window.__midiTest.sent.length)).toBeGreaterThan(0);
    await page.evaluate(() => (window.__midiTest.sent.length = 0));
  }
  await expect(muteChip()).not.toHaveClass(/\bon\b/);
  await muteChip().click(); // mute via the UI
  await expect(muteChip()).toHaveClass(/\bon\b/);

  // Echoed page-side, in the task that sees the feedback go out. Bridging that over the
  // driver — poll for `sent`, then send — puts the echo ~250 ms after the feedback
  // (measured on this spec), well past the engine's 50 ms guard, so the case asserted the
  // guard against a message it is not meant to catch and failed wherever the poll was
  // slower than the window. A reflecting transport answers in 0.13-5 ms, which is what
  // the guard is sized from and what this reproduces.
  const echoed = await echoNextFeedback(page);
  await page.waitForTimeout(150);
  await expect(muteChip()).toHaveClass(/\bon\b/); // still muted
  // The echo is consumed one-shot: the same message right after it is a real press and
  // still unmutes (a blanket window would eat it).
  await sendMidi(page, echoed);
  await expect(muteChip()).not.toHaveClass(/\bon\b/);
});

test("a device fetch does not open the output port; the live session does", async ({ page }) => {
  // A fetch reads the whole unit, and the plan is the unit's state for that instant —
  // but nothing holds the two together afterwards, and on a shared bus a push is
  // another listener's incoming gesture. So the output side stays shut through a
  // fetch, and the values reach the controller when a session opens it.
  //
  // What that costs is real and accepted: between the fetch and the session the
  // controller shows what it was last told, and a motorised fader touched there sends
  // its stale position back into the plan. Pickup mode is the per-mapping answer.
  const win = await openMidiWindow(page);
  await pickInputPort(page, win);
  await learnBinding(page, win, () => strip(page, "CH 1").locator(".con-fader").click(), [0xb0, 7, 64], [0xb0, 7, 65]);
  await setLearn(page, win, false);
  await pickOutputPort(page, win);

  // Park the fader at -∞ so the stubbed readback (every read = 0 → 0.0 dB) is a real
  // change rather than a value that would go out as itself.
  const fader = strip(page, "CH 1").locator(".con-fader");
  await fader.click();
  await fader.press("End");

  await page.click("#btn-device");
  await page.click("#btn-fetch");
  await expect(readLevel(page, "CH 1")).toHaveText("0.0"); // the fetch landed
  await page.waitForTimeout(300); // past the feedback debounce
  expect(await page.evaluate(() => window.__midiTest.sent.length)).toBe(0);

  // The positive control: the same value goes out the moment a session establishes it,
  // so the silence above is the gate rather than a rig that never sends.
  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#btn-live")).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => page.evaluate(() => window.__midiTest.sent.find((b) => b[0] === 0xb0 && b[1] === 7)?.[2] ?? -1))
    .toBeGreaterThan(0);
});

test("Live sync start pushes every assignment to the controller, not just what changed", async ({ page }) => {
  // The session's starting readback makes the plan the unit's own state, and the
  // debounced pass carries only what CHANGED in the plan — here nothing does: the
  // stub answers 0 for every read, which is already CH 1's level. That is exactly
  // the value a controller replugged (or moved to another bank) since the sent
  // cache was filled would still be showing wrong, so the session start re-sends
  // every binding once. It is also the only moment that does: the port opening states
  // nothing, since before a readback the plan is not the unit's state to state.
  const win = await openMidiWindow(page);
  await pickInputPort(page, win);
  await learnBinding(page, win, () => strip(page, "CH 1").locator(".con-fader").click(), [0xb0, 7, 64], [0xb0, 7, 65]);
  await setLearn(page, win, false);
  await pickOutputPort(page, win);

  // Nothing at all until the session: the port opening states no values of its own.
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__midiTest.sent.length)).toBe(0);

  await page.click("#btn-device");
  await page.click("#btn-live");
  await expect(page.locator("#live-tally")).toBeVisible(); // the session is up
  // Nothing in the plan moved — the stub answers 0 for every read, which is already
  // CH 1's level — and the binding is sent anyway.
  await expect(readLevel(page, "CH 1")).toHaveText("0.0");
  await expect
    .poll(() => page.evaluate(() => window.__midiTest.sent.filter((b) => b[0] === 0xb0 && b[1] === 7).length))
    .toBeGreaterThan(0);
});

test("assignments and the port choice survive a reload", async ({ page }) => {
  const win = await openMidiWindow(page);
  await pickInputPort(page, win);
  await learnBinding(
    page,
    win,
    () => strip(page, "CH 1").locator(".con-fader").click(),
    [0xb0, 7, 100],
    [0xb0, 7, 101],
  );

  // Closed first, so this is about what localStorage carries across a restart. A
  // window left OPEN across the reload is a different situation — the app finds it
  // still there and speaks to it again (see the reattach test below).
  await setLearn(page, win, false);
  await win.close();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("urx-test-midiwin"))).toBeNull();

  await page.reload();
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  // The saved input port reopens on boot, without touching the MIDI window.
  await expect.poll(() => page.evaluate(() => window.__midiTest.inputPort)).toBe("Stub In");
  await page.click("#btn-view-console");
  await sendMidi(page, [0xb0, 7, 127]);
  await expect(readLevel(page, "CH 1")).toHaveText("+10.0");
  const reopened = await openMidiWindow(page);
  await expect(mapRow(reopened, "ch1/level")).toBeVisible();
});

test("an open SEND PAN popover follows an incoming mapped pan CC", async ({ page }) => {
  // Regression: an external edit repaints through refreshStrip, which used to
  // swap the strip without touching an open SEND PAN popover — the knob kept its
  // stale value and the fresh PAN ▾ button came up unmarked (no .open) while the
  // popover stayed on screen.
  const win = await openMidiWindow(page);
  await pickInputPort(page, win);
  const panBtn = () => strip(page, "CH 1").locator(".con-panbtn");
  const pop = page.locator(".con-spop");
  const mix1 = () => pop.locator(".pcol", { hasText: "MIX 1" });
  // The pan knob lives inside the popover, so open it under learn to arm it.
  await learnBinding(
    page,
    win,
    async () => {
      await panBtn().click();
      await mix1().locator(".con-knob").click();
    },
    [0xb0, 21, 60],
    [0xb0, 21, 61],
  );
  await expect(mapRow(win, "ch1/pan@bus.mix1")).toBeVisible();
  await setLearn(page, win, false);

  await panBtn().click(); // reopen the popover, then push an external pan edit
  await expect(pop).toBeVisible();
  await sendMidi(page, [0xb0, 21, 127]);
  // The popover follows: its knob shows the new value, and the rebuilt strip's
  // PAN ▾ button still owns it.
  await expect(mix1().locator(".rv")).toHaveText("R63");
  await expect(pop).toBeVisible();
  await expect(pop.locator(".ph .who")).toHaveText("CH 1");
  await expect(panBtn()).toHaveClass(/\bopen\b/);
  await expect(panBtn()).toHaveAttribute("aria-expanded", "true");
});

test("switching the model cancels an armed learn instead of persisting a dead mapping", async ({ page }) => {
  // While learn is on the panel ignores outside presses, so the toolbar model
  // picker stays reachable; committing the old model's armed id after the
  // switch would store a mapping under the new model's key that may never bind.
  const win = await openMidiWindow(page);
  await pickInputPort(page, win);
  await setLearn(page, win, true);
  const fader = strip(page, "CH 1").locator(".con-fader");
  await fader.click(); // armed
  await expect(fader).toHaveClass(/midi-armed/);

  await chooseOption(page.locator("#model-picker"), "URX22");
  await expect(page.locator("#model-picker")).toHaveValue("URX22");
  // The switch dropped learn mode and the armed control with it.
  await expect(page.locator("#console-host")).not.toHaveClass(/midi-learn/);
  await expect(win.locator(".mw-learnbtn")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".midi-armed")).toHaveCount(0);
  // The messages that would have completed the learn create no mapping.
  await sendMidi(page, [0xb0, 7, 100], [0xb0, 7, 101]);
  await expect(win.locator(".mw-empty")).toBeVisible();
  await expect(win.locator(".mw-list tbody tr")).toHaveCount(0);
});

test("a port that fails to open reverts its select to none and reports the error", async ({ page }) => {
  // The stub's "Broken" ports reject midi_open_* (an exclusive port held by
  // another app); the select must fall back to "none" instead of keeping a
  // choice that is not actually open.
  const win = await openMidiWindow(page);
  await chooseOption(win.locator(".mw-in"), "Broken In");
  await expect(page.locator("#statusbar")).toContainText("MIDI input error");
  await expect(win.locator(".mw-in")).toHaveValue("");
  expect(await page.evaluate(() => window.__midiTest.inputPort)).toBe(null);
  await chooseOption(win.locator(".mw-out"), "Broken Out");
  await expect(page.locator("#statusbar")).toContainText("MIDI output error");
  await expect(win.locator(".mw-out")).toHaveValue("");
  // A working port still opens normally afterwards.
  await pickInputPort(page, win);
});

test("a port closed from the shell stops being offered as the chosen one", async ({ page }) => {
  // The shell can close a port under a page that is still running: the page-load
  // teardown in lib.rs did exactly that for every webview, so opening the MIDI
  // window closed the input the main window had restored. Nothing was reported —
  // the app kept naming the port, the window kept showing it selected, and
  // re-picking the same entry fires no `change`, so there was no way back through
  // the UI. The app now reads what the shell actually holds on every port refresh.
  const win = await openMidiWindow(page);
  await pickInputPort(page, win);
  await expect(win.locator(".mw-in")).toHaveValue("Stub In");

  // Close it the way the shell would, without telling the page.
  await page.evaluate(() => {
    window.__midiTest.inputPort = null;
    window.__midiTest.inChannel = null;
  });

  // Reopening the window is a refresh (the app answers "ready" with one).
  await win.close();
  await expect.poll(() => page.evaluate(() => window.__midiTest.windowOpened)).toBe(true);
  const again = await openMidiWindow(page);
  await expect(again.locator(".mw-in")).toHaveValue("");

  // And the choice is live again: picking the port reopens it for real.
  await chooseOption(again.locator(".mw-in"), "Stub In");
  await expect.poll(() => page.evaluate(() => window.__midiTest.inputPort)).toBe("Stub In");
  await sendMidi(page, [0xb0, 7, 100]);
});

test("a port opened while the shell is being asked survives the answer", async ({ page }) => {
  // The reconcile adopts what the shell reports, and that report describes the moment
  // it was taken. Opening a port INSIDE that round trip leaves an answer that predates
  // it, and adopting it would close what the operator just opened — the same silence
  // this reconcile exists to remove, caused by the reconcile. Standing down while an
  // open is in flight is not enough on its own: an open that begins and ends inside the
  // round trip puts the in-flight count back to zero before the answer lands.
  const win = await openMidiWindow(page);
  await page.evaluate(() => {
    window.__midiTest.openPortsDelayMs = 600;
  });

  // Provoke a refresh with the answer held: the window announcing itself is what asks.
  await win.close();
  const answeredBefore = await page.evaluate(() => window.__midiTest.openPortsAnswered);
  const again = await openMidiWindow(page);

  // …and open a port while it is held. The pick completes long before the answer,
  // which still says "nothing is open".
  await chooseOption(again.locator(".mw-in"), "Stub In");
  await expect.poll(() => page.evaluate(() => window.__midiTest.inputPort)).toBe("Stub In");
  // The 600 ms hold really did still contain the pick. The window's whole boot plus
  // three or four round trips sit inside it, and on a slow enough machine the answer
  // lands first — at which point there is no race left and every line below passes
  // for the wrong reason.
  expect(await page.evaluate(() => window.__midiTest.openPortsAnswered)).toBe(answeredBefore);

  // Outlast the held answer — by watching for it to be delivered rather than by a
  // clock — then check the port is still the chosen one on both sides, since the
  // window renders what the app pushes.
  await expect.poll(() => page.evaluate(() => window.__midiTest.openPortsAnswered)).toBeGreaterThan(answeredBefore);
  expect(await page.evaluate(() => window.__midiTest.inputPort)).toBe("Stub In");
  await expect(again.locator(".mw-in")).toHaveValue("Stub In");
  await sendMidi(page, [0xb0, 7, 100]); // and it is still a port that delivers
});

test("removing an assignment stops the control from responding", async ({ page }) => {
  const win = await openMidiWindow(page);
  await pickInputPort(page, win);
  await learnBinding(
    page,
    win,
    () => strip(page, "CH 1").locator(".con-fader").click(),
    [0xb0, 7, 100],
    [0xb0, 7, 101],
  );
  await setLearn(page, win, false);

  const before = await readLevel(page, "CH 1").textContent();
  await mapRow(win, "ch1/level").locator(".mw-del").click();
  await expect(win.locator(".mw-empty")).toBeVisible();
  await sendMidi(page, [0xb0, 7, 127]);
  await expect(readLevel(page, "CH 1")).toHaveText(before ?? "");
});

test("a tuning screen's controls arm under processor and band scopes", async ({ page }) => {
  // The tuning screens are the second arming surface. Their ids carry a scope —
  // a node has one fader but three thresholds — and a band binds to THAT band,
  // not to whichever the screen's bar happens to have selected.
  const win = await openMidiWindow(page);
  await pickInputPort(page, win);
  await setLearn(page, win, true);

  // GATE, opened from the CONSOLE strip. The opener still opens while learn is on.
  await strip(page, "CH 1").locator(".con-chip-open").first().click();
  const box = page.locator("#dyn-screen-box");
  await expect(box).toBeVisible();
  const row = (label: string) => box.locator(".prefs-row").filter({ has: page.getByText(label, { exact: true }) });
  await row("Threshold").locator(".ctl").click();
  await expect(win.locator(".mw-hint")).toContainText("CH 1 · GATE · Threshold");
  await sendMidi(page, [0xb0, 40, 100], [0xb0, 40, 101]);
  await expect(mapRow(win, "ch1/threshold@gate")).toBeVisible();
  await expect(mapRow(win, "ch1/threshold@gate").locator(".mw-ctl")).toHaveText("CH 1 · GATE · Threshold");

  // An incoming value moves the screen's own slider, on the field table's grid.
  await setLearn(page, win, false);
  await sendMidi(page, [0xb0, 40, 0], [0xb0, 40, 0]);
  await expect(row("Threshold").locator(".gt-val")).toHaveText("-72.0 dB");
  await box.locator(".consent-btn-secondary").click();
});

test("an EQ band binds to that band, not to the selected one", async ({ page }) => {
  const win = await openMidiWindow(page);
  await pickInputPort(page, win);
  await setLearn(page, win, true);

  await page.click("#btn-view-graph");
  await page.locator('#graph-host g.node[data-id="ch1"]').click();
  const sec = page.locator("#inspector .insp-section", { has: page.locator("#btn-eq-screen") });
  if (!(await sec.evaluate((el) => (el as HTMLDetailsElement).open))) await sec.locator("summary").click();
  await sec.locator("#btn-eq-screen").click();
  const box = page.locator("#dyn-screen-box");
  const row = (label: string) => box.locator(".prefs-row").filter({ has: page.getByText(label, { exact: true }) });

  // LOW is selected on open and ships as a shelf. The enum row has no control at
  // all, and Q is locked because a shelf does not read it — neither is offered.
  await expect(row("Type").locator(".midi-target")).toHaveCount(0);
  await expect(row("Q").locator(".midi-target")).toHaveCount(0);
  await expect(row("Gain").locator(".midi-target")).toHaveCount(1);

  await row("Gain").locator(".ctl").click();
  await sendMidi(page, [0xb0, 41, 100], [0xb0, 41, 101]);
  await expect(mapRow(win, "ch1/gain@eq.low")).toBeVisible();
  await expect(mapRow(win, "ch1/gain@eq.low").locator(".mw-ctl")).toHaveText("CH 1 · EQ LOW · Gain");

  // HIGH MID is fixed peaking, which does read Q — the lock follows the type, not
  // the row. Its gain binds under its own scope, leaving LOW's binding alone.
  await pickBand(page, 2);
  await expect(row("Q").locator(".midi-target")).toHaveCount(1);
  await row("Gain").locator(".ctl").click();
  await sendMidi(page, [0xb0, 42, 100], [0xb0, 42, 101]);
  await expect(mapRow(win, "ch1/gain@eq.highMid")).toBeVisible();
  await expect(mapRow(win, "ch1/gain@eq.low")).toBeVisible();
});

test("a MIDI window that outlives a reload of the app is spoken to again", async ({ page }) => {
  // The window announces itself with "ready" on ITS boot, not on the app's. Reload
  // the app with the window still up and nothing would make it speak again, so the
  // app asks the shell whether a window is there and pushes its state at it —
  // otherwise the window sits holding the previous session's list.
  const win = await openMidiWindow(page);
  await pickInputPort(page, win);
  await learnBinding(
    page,
    win,
    () => strip(page, "CH 1").locator(".con-fader").click(),
    [0xb0, 7, 100],
    [0xb0, 7, 101],
  );
  await setLearn(page, win, false);
  await expect(mapRow(win, "ch1/level")).toBeVisible();

  await page.reload();
  await expect(page.locator("#model-picker")).toHaveValue("URX44V");
  // Same window object, never reloaded: what it shows now came from the new session.
  await expect(win.locator(".mw-in")).toHaveValue("Stub In");
  await expect(mapRow(win, "ch1/level")).toBeVisible();
  // And it still drives the app: learn from the surviving window binds a second one.
  await page.click("#btn-view-console");
  await learnBinding(
    page,
    win,
    () => strip(page, "CH 1").locator(".con-chip", { hasText: "MUTE" }).click(),
    [0x90, 60, 127],
  );
  await expect(mapRow(win, "ch1/mute")).toBeVisible();
});
