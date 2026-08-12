// @vitest-environment jsdom

// The app entry's DESKTOP half: the device link, the live session, and the guard
// rails that decide which of them may hold it. Unreachable from the other two boot
// suites — `isTauri()` is what gates all of it, and they run with no shell — so this
// file installs one (`main.test-util.ts`) and drives the flows through it.
//
// The stub keeps what is written to it and answers the next read with it, which is
// what lets a converging write actually converge. What it does NOT model is the
// device's own behaviour — a side-effect reset, a clamp, a refused value — and those
// belong to `e2e/race/fake-device.ts`; a second, thinner imitation of it here would be
// a fixture that agrees with nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FAKE_LAUNCH_FLAGS_OFF } from "../e2e/race/fake-flags";
import { $, bootApp, deviceCommands, installAppGlobals, restoreAppGlobals, statusText } from "./main.test-util";
import type { TauriShell } from "./main.test-util";
import { SUPPORTED_SYSTEM_FIRMWARE } from "./core/control/firmware";
import { t } from "./i18n";

/** Long enough for a whole-device read (676 reads through the stub) plus a teardown. */
const SLOW = { timeout: 30_000 };

beforeEach(installAppGlobals);
afterEach(restoreAppGlobals);

/** Boot with a connected unit. `agree` answers every confirm with Ok. */
const bootDevice = async (over: Record<string, unknown> = {}, agree = true): Promise<TauriShell> =>
  (await bootApp({ tauri: deviceCommands({ ...(agree ? { "plugin:dialog|message": "Ok" } : {}), ...over }) }))!;

/**
 * Wait until `cmd` has been invoked `n` times. The device flows here write the status
 * line several times on the way through ("Connecting to the device…" first), so
 * waiting for it to CHANGE returns in the middle of the flow — which is how a first
 * version of this file asserted "no writes happened" against a write that had not
 * started yet. The flow's own terminal command is the thing to wait on.
 */
async function invoked(shell: TauriShell, cmd: string, n = 1, timeout = 25_000): Promise<void> {
  await vi.waitFor(
    () => {
      if (shell.count(cmd) < n) throw new Error(`${cmd} invoked ${shell.count(cmd)} times, want ${n}`);
    },
    { timeout, interval: 20 },
  );
}

const live = (): HTMLButtonElement => document.getElementById("btn-live") as HTMLButtonElement;

describe("Fetch from device", () => {
  it("connects, reads the whole unit, and drops the link when it is done", SLOW, async () => {
    const shell = await bootDevice();
    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");

    expect(statusText()).toContain("URX44V");
    expect(statusText()).not.toBe(t().status.fetchConnecting);
    expect(shell.count("vd_connect")).toBe(1);
    expect(shell.count("vd_get")).toBeGreaterThan(100);
    // The link is not kept: Fetch is a one-shot holder, and a session that never
    // let go would lock every other device action for the rest of the launch.
    expect(shell.count("vd_disconnect")).toBe(1);
  });

  // The read holds the plan by reference for seconds, so every file flow is refused
  // for its duration through one shared latch. Measured: a Fetch does NOT disable the
  // device buttons — that is the live session's doing, and only the live session's —
  // so the refusal is the observable here, and a case written against `disabled` would
  // be asserting the wrong guard entirely.
  //
  // A refusal must also consume nothing: the same attempt has to pass once the read
  // is done, which is the half that says the latch is a gate and not a discard.
  it("refuses a file flow while it holds the plan, and takes the same attempt afterwards", SLOW, async () => {
    const shell = await bootDevice();
    // The stub answers a read in a microtask, so the whole 676-read sweep completes
    // between two polls of `waitFor` and there is no mid-read window to test in — the
    // first version of this case clicked New against a read that had already
    // finished, and passed by asserting the wrong status. One millisecond per read
    // makes the window real. Remove this and the case stops testing the latch.
    shell.answer("vd_get", () => new Promise((r) => setTimeout(() => r(0), 1)));
    $("btn-fetch").click();
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(5), { timeout: 10_000, interval: 5 });

    $("btn-new").click();
    expect(statusText()).toBe(t().status.busyDeviceRead);

    await invoked(shell, "vd_disconnect");
    $("btn-new").click();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.newPlan), { timeout: 10_000 });
  });

  it("reports a link it cannot open, and holds nothing afterwards", SLOW, async () => {
    const shell = await bootDevice();
    shell.answer("vd_connect", () => {
      throw new Error("broker-unreachable");
    });
    $("btn-fetch").click();
    await vi.waitFor(() => expect(shell.count("plugin:dialog|message")).toBeGreaterThan(0), { timeout: 10_000 });
    expect(live().disabled).toBe(false); // the holder was released on the failure path
  });

  // A firmware the app has not been verified against is a confirm, not a refusal: the
  // operator may still want to read. Declining has to leave the unit untouched.
  it("asks before reading a unit on unverified firmware, and abandons when declined", SLOW, async () => {
    const shell = await bootDevice(
      { vd_connect: { model: "URX44V", label: "URX44V", firmware: "9.9.9.9", epoch: 1 } },
      false,
    );
    $("btn-fetch").click();
    await vi.waitFor(() => expect(shell.count("plugin:dialog|message")).toBeGreaterThan(0), { timeout: 10_000 });
    // Declined: no whole-device sweep followed the confirm.
    await new Promise((r) => setTimeout(r, 200));
    expect(shell.count("vd_get")).toBeLessThan(10);
  });

  it("reads a unit on the verified firmware without asking anything", SLOW, async () => {
    const shell = await bootDevice({}, false); // every confirm would DECLINE
    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");
    expect(shell.count("plugin:dialog|message")).toBe(0);
    expect(SUPPORTED_SYSTEM_FIRMWARE).toBeTruthy();
  });
});

describe("the live session", () => {
  // The undo history survives a reconcile that authored nothing.
  //
  // Pinned HERE rather than only in the race tier because that tier uploads no
  // coverage and runs on the version-bump pull request alone — so the branch this
  // asserts was reachable by nothing that reports on an ordinary PR. The tier still
  // owns the timing shapes (a press DURING the read, a teardown mid-flight); this owns
  // the plain case, which is also the common one.
  it("keeps the undo history through a reconcile that authored nothing", SLOW, async () => {
    const shell = await bootDevice();
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-pressed")).toBe("true"), { timeout: 25_000 });

    $("btn-view-console").click();
    const slider = (): HTMLElement => $("console-host").querySelector<HTMLElement>('.con-strip [role="slider"]')!;
    const before = slider().getAttribute("aria-valuenow");
    slider().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(slider().getAttribute("aria-valuenow")).not.toBe(before);
    await invoked(shell, "vd_set", 1); // the edit reached the unit

    // A scoped param's notify makes the settle re-read the owner node. The channel is
    // taken from the subscribe's own arguments rather than by position, so a second
    // channel opening beside it cannot silently redirect this.
    const at = shell.invokes.indexOf("vd_params_subscribe");
    const { channel } = shell.args[at] as { channel: { onmessage: (d: unknown) => void } };
    const readsBefore = shell.count("vd_get");
    channel.onmessage([{ param_id: 26, x: 0, y: 0, value: 40 }]); // CH1 HPF freq
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(readsBefore), { timeout: 20_000 });

    // Let the read and its coalesced reflect finish, or the chord below meets the
    // busy refusal and the case would be measuring the gate instead.
    let seen = -1;
    await vi.waitFor(
      () => {
        const now = shell.invokes.length;
        const quiet = now === seen;
        seen = now;
        if (!quiet) throw new Error("still working");
      },
      { timeout: 20_000, interval: 300 },
    );

    // The stub answers the re-read from what it holds, which the session start already
    // synced the plan to — so the read authored nothing and the entry must still be
    // there. Before the fix, the reflect reset both stacks and this chord did nothing.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(slider().getAttribute("aria-valuenow")).toBe(before), { timeout: 10_000 });
  });

  it("comes up, prints the tally, and goes down again", SLOW, async () => {
    const shell = await bootDevice();
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-pressed")).toBe("true"), { timeout: 25_000 });

    expect($("live-tally").hidden).toBe(false);
    expect($("live-tally").textContent).toBe(t().toolbar.liveTag);
    expect(shell.count("vd_params_subscribe")).toBe(1);
    expect(shell.count("vd_watch_link")).toBe(1);

    const disconnects = shell.count("vd_disconnect");
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-pressed")).toBe("false"), { timeout: 10_000 });
    expect($("live-tally").hidden).toBe(true);
    expect(shell.count("vd_params_unsubscribe")).toBe(1);
    // The disconnect is issued from an un-awaited teardown, so it lands after the
    // toggle has already flipped — asserted immediately it reads as never sent.
    await invoked(shell, "vd_disconnect", disconnects + 1, 10_000);
  });

  // The session is one holder among several, and the model picker is locked for its
  // whole duration — a switch replaces the plan wholesale, which a session cannot
  // survive. (The race harness pins the same rule from the other side.)
  it("locks the model picker and the other device actions for its duration", SLOW, async () => {
    await bootDevice();
    const picker = $<HTMLSelectElement>("model-picker");
    expect(picker.disabled).toBe(false);

    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-pressed")).toBe("true"), { timeout: 25_000 });
    expect(picker.disabled).toBe(true);
    expect(($("btn-fetch") as HTMLButtonElement).disabled).toBe(true);
    expect($<HTMLSelectElement>("rate-picker").disabled).toBe(true);

    $("btn-live").click();
    await vi.waitFor(() => expect(picker.disabled).toBe(false), { timeout: 10_000 });
    expect(($("btn-fetch") as HTMLButtonElement).disabled).toBe(false);
  });

  // Two clicks inside the activation must admit one session: the flow is long and
  // async, and during it the toggle is neither on nor off.
  it("admits one session for two clicks in the same tick", SLOW, async () => {
    const shell = await bootDevice();
    live().click();
    live().click();
    await vi.waitFor(() => expect(live().getAttribute("aria-pressed")).toBe("true"), { timeout: 25_000 });
    expect(shell.count("vd_connect")).toBe(1);
    expect(shell.count("vd_params_subscribe")).toBe(1);
  });

  it("reports a session that cannot start, and leaves the toggle off", SLOW, async () => {
    const shell = await bootDevice();
    shell.answer("vd_connect", () => {
      throw new Error("no-device");
    });
    $("btn-live").click();
    await vi.waitFor(() => expect(shell.count("plugin:dialog|message")).toBeGreaterThan(0), { timeout: 10_000 });
    expect(live().getAttribute("aria-pressed")).toBe("false");
    expect($("live-tally").hidden).toBe(true);
    expect($<HTMLSelectElement>("model-picker").disabled).toBe(false);
  });
});

describe("Write to device", () => {
  it("asks before writing, and writes nothing when declined", SLOW, async () => {
    const shell = await bootDevice({}, false); // decline every confirm
    $("btn-write").click();
    await vi.waitFor(() => expect(shell.count("plugin:dialog|message")).toBeGreaterThan(0), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(shell.count("vd_set")).toBe(0);
  });

  // "Wrote N" and "wrote, but N did not take" are both reached with writes on the
  // wire, so a case that counts `vd_set` cannot tell them apart — and against a stub
  // that answers every read 0 it is the SECOND one that runs, every time, since the
  // converge loop re-reads what it just sent and is told it did not land. The status
  // frame is what separates them, and the re-write below is what says the values are
  // on the unit rather than merely sent to it.
  it("writes the plan, converges, and leaves the unit matching it", SLOW, async () => {
    const shell = await bootDevice();
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    expect(shell.count("vd_set")).toBeGreaterThan(10);

    // The count comes out of the message so the assertion can pin the whole frame
    // rather than a substring. Measured on the non-converging path (reads answering a
    // flat 0): 1527 writes go out over three rounds, the flow lands on
    // `writeResidual`, and its error report's save — which this stub has no dialog
    // command for — fails, so `showError` clears the line and the status reads "".
    const n = Number(/\d+/.exec(statusText())?.[0]);
    expect(n).toBeGreaterThan(10);
    expect(statusText()).toBe(t().status.written(n));

    // Written and readable: the app's own diff now finds nothing left to send.
    $("btn-write").click();
    await invoked(shell, "vd_disconnect", 2);
    expect(statusText()).toContain(t().status.writeNoChanges);
  });
});

describe("the desktop-only surfaces", () => {
  it("opens the device setup modal", SLOW, async () => {
    const shell = await bootDevice({ vd_get: 0, vd_get_str: "" });
    $("btn-device-setup").click();
    await vi.waitFor(() => expect($("device-setup-modal").hidden).toBe(false), { timeout: 20_000 });
    expect(shell.count("vd_connect")).toBeGreaterThan(0);
  });

  it("opens the MIDI control window through the shell", SLOW, async () => {
    const shell = await bootDevice({ open_midi_window: null });
    $("btn-midi").click();
    await vi.waitFor(() => expect(shell.count("open_midi_window")).toBe(1), { timeout: 10_000 });
  });

  // The experimental actions are in the DOM but hidden until the launch flag says so
  // — they drive destructive round trips against a real unit.
  it("keeps the experimental actions hidden on an ordinary launch", SLOW, async () => {
    await bootDevice();
    expect($("btn-selftest").hidden).toBe(true);
    expect($("btn-compare").hidden).toBe(true);
  });

  it("reveals them when the launch flag is set", SLOW, async () => {
    await bootDevice({ experimental_enabled: true });
    await vi.waitFor(() => expect($("btn-selftest").hidden).toBe(false), { timeout: 10_000 });
    expect($("btn-compare").hidden).toBe(false);
  });

  // The settings-file import is one of them, and `e2e/race/t3b-undo.spec.ts` skips a
  // case on it being unreachable from that harness — which rests on two facts with
  // nothing between them: the app hides the entry without the flag, and the race fake
  // never answers the flag true.
  //
  // The second half is two statements, and BOTH are needed. The list the fake answers
  // from is imported (`fake-flags.ts` has no imports of its own, so this side can take it
  // without pulling Playwright's types into the src build) — but importing a list only
  // says what the list holds. That the FAKE reads it is the other half, and nothing in
  // the type system carries it: deleting the fake's `includes` block and its import
  // compiles silently, and a guard that only checked the constant would stay green while
  // the reason it exists for became false.
  //
  // So the fake's source is read for the usage. Two earlier versions read it by PROXIMITY
  // and both broke on a correct edit rather than on a wrong one: the first cut the switch
  // arm out by index (a comment containing "return" failed it on a docs edit; the group
  // becoming the last arm widened the cut past the end of the block), and the second asked
  // that `FAKE_LAUNCH_FLAGS_OFF` and a `return false;` sit within 200 characters of each
  // other — which the fix for the defect below necessarily broke, because that fix is
  // precisely to move the name away from the answer.
  //
  // The pin is therefore on the PROPERTY and not on a layout. The name must be absent from
  // the serialised callback and present in the tuple handed to it; the answer is looked up
  // through whatever that callback calls its third parameter, read out of the source rather
  // than hard-coded, so a rename is not a failure. What no text scan can see is whether the
  // list that arrives holds the right strings — the race tier is what answers that, and it
  // runs on the version-bump PR alone, which is how the defect below survived four merges.
  it("keeps the settings import behind the flag, and the race fake never sets it", SLOW, async () => {
    await bootDevice();
    expect($("btn-open-settings").hidden).toBe(true);
    expect(FAKE_LAUNCH_FLAGS_OFF).toContain("experimental_enabled");

    const fake = readFileSync(resolve(process.cwd(), "e2e/race/fake-device.ts"), "utf8");
    expect(fake, "the race fake no longer answers from FAKE_LAUNCH_FLAGS_OFF").toContain("FAKE_LAUNCH_FLAGS_OFF");

    // The callback handed to addInitScript is serialised and evaluated in the PAGE, where
    // this module's bindings do not exist. Naming the import inside it compiles, type-checks
    // and collects, then throws on the fake's first command — "Can't find variable: X" in
    // JavaScriptCore, "X is not defined" in V8 — which presents as a live session that never
    // comes up rather than as an error. The argument tuple is the only channel that crosses,
    // and the only one the type checker covers: the callback's annotation and the `as` cast
    // are the same tuple type, so an arity mismatch is a compile error.
    const open = fake.indexOf("addInitScript(");
    const args = fake.indexOf("[cfg, opts.storage", open);
    expect(open, "installFake no longer installs through addInitScript").toBeGreaterThan(-1);
    expect(args, "the init script's argument tuple moved").toBeGreaterThan(open);
    const body = fake.slice(open, args);
    expect(body, "the init script closes over FAKE_LAUNCH_FLAGS_OFF instead of being handed it").not.toContain(
      "FAKE_LAUNCH_FLAGS_OFF",
    );
    expect(fake.slice(args, args + 200), "the init script is not handed the flag list").toContain(
      "FAKE_LAUNCH_FLAGS_OFF",
    );

    // …and it still answers those commands false, through the parameter it arrived on.
    const param = /addInitScript\(\s*\(\[[^\]]*,\s*([A-Za-z_$][\w$]*)\s*\]/.exec(body)?.[1];
    expect(param, "the init script's last parameter is not a plain binding").toBeTruthy();
    expect(body).toMatch(new RegExp(`\\b${param}\\.includes\\(cmd\\)[\\s\\S]{0,80}?return false;`));
  });
});

describe("Compare with device", () => {
  const bootExperimental = (over: Record<string, unknown> = {}): Promise<TauriShell> =>
    bootDevice({ experimental_enabled: true, ...over });

  const compare = async (): Promise<HTMLButtonElement> => {
    const btn = $<HTMLButtonElement>("btn-compare");
    await vi.waitFor(() => expect(btn.hidden).toBe(false), { timeout: 10_000 });
    return btn;
  };

  // Compare writes nothing — that is the whole point of it, and the reason it can be
  // pointed at a unit whose state matters.
  it("reads the unit, reports, and writes nothing", SLOW, async () => {
    const shell = await bootExperimental();
    (await compare()).click();
    await invoked(shell, "vd_disconnect");

    expect(shell.count("vd_get")).toBeGreaterThan(100);
    expect(shell.count("vd_set")).toBe(0);
    expect(shell.count("vd_set_str")).toBe(0);
    expect(statusText()).not.toBe(t().status.compareConnecting);
  });

  // The report is built while connected and shown after the disconnect, so an
  // indefinite modal cannot hold the broker connection open.
  //
  // The disconnect is held unanswered to measure the order: waiting for it to be
  // INVOKED and then finding the modal proves nothing, because a regression that
  // opened the modal first would satisfy both in that same order.
  it("shows its report only after the link is closed", SLOW, async () => {
    let release = (): void => {};
    const closing = new Promise<void>((r) => (release = () => r()));
    const shell = await bootExperimental({ vd_disconnect: () => closing });
    (await compare()).click();
    await invoked(shell, "vd_disconnect");

    // The link is still open — the shell has not answered — so nothing may be up yet.
    await new Promise((r) => setTimeout(r, 100));
    expect($("load-report").hidden).toBe(true);

    release();
    await vi.waitFor(() => expect($("load-report").hidden).toBe(false), { timeout: 10_000 });
  });

  // The button doubles as its own cancel while a run is in flight, and the label says
  // which of the two it currently is.
  it("turns into its own cancel while it runs", SLOW, async () => {
    const shell = await bootExperimental();
    shell.answer("vd_get", () => new Promise((r) => setTimeout(() => r(0), 1)));
    const btn = await compare();
    expect(btn.textContent).toBe(t().toolbar.compare);

    btn.click();
    await vi.waitFor(() => expect(btn.textContent).toBe(t().toolbar.compareCancel), { timeout: 10_000 });
    btn.click(); // cancel
    await vi.waitFor(() => expect(btn.textContent).toBe(t().toolbar.compare), { timeout: 15_000 });
    expect(shell.count("vd_set")).toBe(0);
  });
});

describe("the first-run consent gate", () => {
  // Desktop only, and it stands between the launch and the device layer: the Windows
  // installer shows the same notice, but a macOS drag-install and every auto-update
  // bypass it.
  //
  // `consent: false` is the whole premise. A first version of this cleared the key
  // between two boots — and the second boot's own pre-accept simply wrote it back, so
  // the closing assertion was reading the fixture rather than the gate.
  const bootUngated = (over: Record<string, unknown> = {}): Promise<TauriShell> =>
    bootApp({
      tauri: deviceCommands({ "plugin:dialog|message": "Ok", ...over }),
      consent: false,
    }) as Promise<TauriShell>;

  it("blocks the launch until it is accepted, then remembers", SLOW, async () => {
    const shell = await bootUngated();
    await vi.waitFor(() => expect($("consent").hidden).toBe(false), { timeout: 10_000 });
    expect($("app").inert).toBe(true); // the app behind the scrim is off the tab order
    expect(localStorage.getItem("urx-disclaimer-accepted")).toBeNull();
    expect(shell.count("plugin:updater|check")).toBe(0); // boot() is held at the gate

    $("consent-agree").click();
    await vi.waitFor(() => expect($("consent").hidden).toBe(true), { timeout: 10_000 });
    expect($("app").inert).toBe(false);
    expect(localStorage.getItem("urx-disclaimer-accepted")).toBe("1");
    await invoked(shell, "plugin:updater|check"); // and the rest of boot() ran
  });

  // Declining quits: `exitApp` resolves never in the real shell (the process is gone),
  // so the stub holds too — answering it would let boot() run on past a gate that was
  // refused, which is the opposite of what the case is about.
  it("quits without storing anything when it is declined", SLOW, async () => {
    const shell = await bootUngated({ "plugin:process|exit": () => new Promise(() => {}) });
    await vi.waitFor(() => expect($("consent").hidden).toBe(false), { timeout: 10_000 });

    $("consent-quit").click();
    await invoked(shell, "plugin:process|exit");
    expect(localStorage.getItem("urx-disclaimer-accepted")).toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    expect(shell.count("plugin:updater|check")).toBe(0);
  });
});

describe("the update check", () => {
  it("asks the updater on a desktop launch", SLOW, async () => {
    const shell = await bootDevice();
    await vi.waitFor(() => expect(shell.count("plugin:updater|check")).toBe(1), { timeout: 10_000 });
  });

  // An updater that cannot reach its endpoint is not worth a dialog on every launch —
  // it says nothing about the plan on screen. The failure goes into the boot the case
  // measures: handed to a shell that is then replaced by another `bootDevice()`, it
  // would apply to nothing and the case would pass with the updater never failing.
  //
  // Nothing in the DOM separates a swallowed failure from a successful check, so the
  // rejection ledger is what carries the case: `boot()` is launched with `void`, so a
  // throw that escaped `checkForUpdates` would land nowhere at all. Measured with the
  // catch removed — the rejection arrives, and without this listener the case still
  // reports green (vitest attributes it to the FILE, as one "error" beside a passing
  // test).
  it("survives an updater that cannot reach its endpoint", SLOW, async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => void rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const shell = await bootDevice({
        "plugin:updater|check": () => {
          throw new Error("offline");
        },
      });
      await invoked(shell, "plugin:updater|check");
      expect(shell.count("plugin:dialog|message")).toBe(0); // silent at the launch check
      expect(statusText()).toContain("URX44V");
      await new Promise((r) => setTimeout(r, 100)); // a rejection lands a macrotask later
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
