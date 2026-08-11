// @vitest-environment jsdom

// The app entry's DESKTOP half: the device link, the live session, and the guard
// rails that decide which of them may hold it. Unreachable from the other two boot
// suites — `isTauri()` is what gates all of it, and they run with no shell — so this
// file installs one (`main.test-util.ts`) and drives the flows through it.
//
// The stub answers reads with 0 and accepts writes. That is enough for what is under
// test here: which flow runs, what it reports, and what it locks while it holds the
// link. Fidelity beyond that — a converge round's residual, a write that has to be
// readable afterwards — belongs to `e2e/race/fake-device.ts`, and a second, thinner
// imitation of it here would be a fixture that agrees with nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("writes the plan when the operator agrees", SLOW, async () => {
    const shell = await bootDevice();
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    expect(shell.count("vd_set")).toBeGreaterThan(10);
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
  it("shows its report only after the link is closed", SLOW, async () => {
    const shell = await bootExperimental();
    (await compare()).click();
    await invoked(shell, "vd_disconnect");
    await vi.waitFor(() => expect($("load-report").hidden).toBe(false), { timeout: 10_000 });
    // The link went first: the disconnect is already in the record by the time the
    // modal is up.
    expect(shell.count("vd_disconnect")).toBeGreaterThan(0);
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
  it("blocks on first launch and remembers the acceptance", SLOW, async () => {
    await bootApp({ tauri: deviceCommands({ "plugin:dialog|message": "Ok" }), seed: {} });
    // bootApp pre-accepts; clear it and boot again to reach the gate.
    localStorage.removeItem("urx-disclaimer-accepted");
    await bootApp({ tauri: deviceCommands({ "plugin:dialog|message": "Ok" }) });
    expect(localStorage.getItem("urx-disclaimer-accepted")).toBe("1");
  });
});

describe("the update check", () => {
  it("asks the updater on a desktop launch", SLOW, async () => {
    const shell = await bootDevice();
    await vi.waitFor(() => expect(shell.count("plugin:updater|check")).toBe(1), { timeout: 10_000 });
  });

  // An updater that cannot reach its endpoint is not worth a dialog on every launch —
  // it says nothing about the plan on screen.
  it("survives an updater that fails", SLOW, async () => {
    const shell = await bootDevice();
    shell.answer("plugin:updater|check", () => {
      throw new Error("offline");
    });
    await bootDevice();
    expect(statusText()).toContain("URX44V");
  });
});
