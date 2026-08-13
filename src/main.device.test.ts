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
import { formatRate } from "./core/constraints";
import { SUPPORTED_SYSTEM_FIRMWARE } from "./core/control/firmware";
import { PARAMS } from "./core/control/params";
import { buildUrxf, sampleUrxf } from "./core/control/urxf.test-util";
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

/**
 * A `vd_get` that answers the two clock parameters and nothing else, so a case can
 * state the unit's clock policy and rate outright.
 *
 * It REPLACES the write-then-read store `deviceCommands` installs rather than layering
 * over it, which is a deliberate loss: in the cases that reach for it, the decision under
 * test is taken before any value goes out, so what the reads answer afterwards only
 * changes whether the write that follows converges. That is a property of THOSE cases and
 * not of the file — a case that reads back after a write has to compose the two stores
 * itself, and should say why. It also means a `vd_set` count taken under this store says
 * how much was sent, never that the write converged.
 */
function clockReads(followUsb: boolean, sampleRate: number): (a: Record<string, unknown>) => number {
  return (a) =>
    a.paramId === PARAMS.FOLLOW_USB.id ? (followUsb ? 1 : 0) : a.paramId === PARAMS.SAMPLE_RATE.id ? sampleRate : 0;
}

/**
 * Capture `console.warn` for the duration of a case, and silence it.
 *
 * Both halves matter. The self-test and the audit writer report through the log rather
 * than through a surface — that is deliberate, so a headless launch can be read from the
 * dev server — so the log IS the observable for those runs. And left unsilenced, one of
 * them floods the test output with its whole per-parameter report.
 */
function captureWarnings(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return { lines, restore: () => void spy.mockRestore() };
}

/**
 * Every dialog the shell was asked to raise, in order, with the arguments that say which
 * kind it was.
 *
 * `confirmDialog` and `errorDialog` share ONE command — `plugin:dialog|message` — and
 * differ only in their arguments (`buttons: "OkCancel"` against `kind: "error"`). So a
 * case that counts invocations cannot tell "asked the operator" from "reported a
 * failure", which is exactly the pair a refusal case exists to keep apart: a flow that
 * threw before reaching its confirm raises one dialog too, writes nothing, and satisfies
 * every count-and-outcome assertion identically.
 */
function dialogs(shell: TauriShell): Array<{ message?: string; kind?: string; buttons?: string }> {
  const raised = shell.invokes.flatMap((cmd, i) =>
    cmd === "plugin:dialog|message"
      ? [(shell.args[i] ?? {}) as { message?: string; kind?: string; buttons?: string }]
      : [],
  );
  // The two lists below have to partition this one. They are total today — `platform.ts`
  // has exactly the two producers — and this keeps it so: a dialog matching neither filter
  // falls out of BOTH, and `expect(errors(shell)).toEqual([])` would then read as "nothing
  // was raised" with the dialog sitting in the trace.
  for (const d of raised) {
    if (d.buttons !== "OkCancel" && d.kind !== "error") {
      throw new Error(`dialog is neither a confirm nor an error: ${JSON.stringify(d)}`);
    }
  }
  return raised;
}

/** The messages of the dialogs that ASKED (OK / Cancel), in order. */
const confirms = (shell: TauriShell): string[] =>
  dialogs(shell)
    .filter((d) => d.buttons === "OkCancel")
    .map((d) => d.message ?? "");

/** The messages of the dialogs that REPORTED a failure, in order. */
const errors = (shell: TauriShell): string[] =>
  dialogs(shell)
    .filter((d) => d.kind === "error")
    .map((d) => d.message ?? "");

/** Every value written to Follow USB, in order. Read off the ledger by ADDRESS: the
 *  policy is one write among hundreds a plan write sends, so counting `vd_set` cannot
 *  say whether this particular one went out, nor which way. */
function followUsbWrites(shell: TauriShell): number[] {
  return shell.invokes.flatMap((cmd, i) => {
    const a = shell.args[i];
    return cmd === "vd_set" && a?.paramId === PARAMS.FOLLOW_USB.id ? [a.value as number] : [];
  });
}

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
  // The store answers every unwritten address 0, the clock included, so the device reads
  // as being on a rate the plan is not — and the RATE confirm is what comes up. Named for
  // it, because the write-count confirm is a different dialog on a later line and the
  // case below is the one that reaches it.
  it("asks before writing at a rate the device is not on, and writes nothing when declined", SLOW, async () => {
    const shell = await bootDevice({}, false); // decline every confirm
    $("btn-write").click();
    await vi.waitFor(() => expect(confirms(shell).length).toBeGreaterThan(0), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(confirms(shell).at(-1)).toBe(t().confirm.reclock(formatRate(0), formatRate(48_000)));
    expect(shell.count("vd_set")).toBe(0);
  });

  // The confirm the case above never reaches: with the device already on the plan's rate
  // and its clock its own, the rate question does not arise and the change count is the
  // first thing asked. It is the last thing between one press and hundreds of parameters
  // landing on real hardware, and nothing in this repository drove it before — deleting
  // the confirm outright used to leave the whole suite green.
  it("asks how many changes it is about to write, and sends nothing when that is declined", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(false, 48_000) }, false);
    // A message that reconstructs to itself under `confirm.write` IS the write confirm.
    // Waiting on "some confirm appeared" is not enough: with the confirm gone the write
    // runs on, fails to converge and offers to save a failure report — which is an
    // OkCancel dialog too, so the wait would be satisfied by the very regression the case
    // exists to catch, and the failure would name a NaN instead of a missing dialog.
    const written = (): string | undefined =>
      confirms(shell).find((m) => {
        const n = Number(/\d+/.exec(m)?.[0]);
        return Number.isFinite(n) && m === t().confirm.write(n);
      });
    $("btn-write").click();
    await vi.waitFor(() => expect(written()).toBeDefined(), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 200));

    // The count is read out of the message and put back, so the whole frame is pinned
    // rather than a substring. What that cannot pin is the number itself — the expectation
    // is built from the same digits — so a `total` that dropped one of its two terms would
    // still render a well-formed frame.
    const n = Number(/\d+/.exec(written()!)?.[0]);
    expect(n).toBeGreaterThan(10);
    // And exactly one confirm: the decline has to end the flow rather than lead to another
    // question.
    expect(confirms(shell)).toHaveLength(1);
    expect(shell.count("vd_set")).toBe(0);
    expect(shell.count("vd_set_str")).toBe(0);
  });

  // The other half of the same pre-flight, one gate earlier. An unread firmware version is
  // a HARD stop, and not the same thing as a mismatched one: a mismatch is a confirm the
  // operator can wave through (and a preference can suppress), while an unread version
  // means the check deciding whether this build's parameter mappings apply at all could
  // not be made. Proceeding writes hundreds of values with that check switched off.
  it("refuses to write to a unit whose firmware version it could not read", SLOW, async () => {
    const shell = await bootDevice({
      vd_connect: { model: "URX44V", label: "URX44V", firmware: null, epoch: 1 },
    });
    $("btn-write").click();
    await vi.waitFor(() => expect(errors(shell).length).toBeGreaterThan(0), { timeout: 10_000 });
    expect(errors(shell)).toEqual([t().error.firmwareUnread]);
    // Refused outright rather than asked: the mismatch arm one line below DOES ask, and a
    // regression that routed the null through it would leave a case counting dialogs green.
    expect(confirms(shell)).toEqual([]);
    expect(shell.count("vd_set")).toBe(0);
    await invoked(shell, "vd_disconnect");
  });

  // A device of another model is REFUSED rather than offered a switch: write acts on the
  // plan as it stands, so its channels would map onto the wrong hardware. (Fetch and Live
  // sync offer the switch instead — they replace the plan.) This guard is shared by write,
  // compare and both device-setup actions, and nothing exercised it before.
  it("refuses to write onto a device of another model, naming both", SLOW, async () => {
    const shell = await bootDevice({
      vd_connect: { model: "URX22", label: "URX22", firmware: SUPPORTED_SYSTEM_FIRMWARE, epoch: 1 },
    });
    $("btn-write").click();
    await vi.waitFor(() => expect(errors(shell).length).toBeGreaterThan(0), { timeout: 10_000 });
    // The whole frame, not a substring of it: the guard is shared with compare and the two
    // device-setup actions, each wrapping the same mismatch text in its own message, so a
    // refusal that reported write's failure as compare's would pass a `toContain`.
    expect(errors(shell)).toEqual([t().status.writeError(t().error.modelMismatch("URX22", "URX44V"))]);
    // Refused before anything went out, and the link it opened is let go rather than held.
    expect(shell.count("vd_set")).toBe(0);
    expect(confirms(shell)).toEqual([]);
    await invoked(shell, "vd_disconnect");
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
  // through whatever that callback calls its LAST parameter, read out of the source rather
  // than hard-coded, so a rename is not a failure. What no text scan can see is whether the
  // list that arrives holds the right strings — the race tier is what answers that, and it
  // runs on the version-bump PR alone, which is how the defect below entered `main` and
  // survived three further merges.
  //
  // One family of the old fragility survives by design: the absence check reads code, so
  // comments are stripped before it — writing the identifier in a comment inside the
  // callback is not closing over it, and failing on that would be the third repeat of
  // "a docs edit broke the pin", with a message that is false besides.
  it("keeps the settings import behind the flag, and the race fake never sets it", SLOW, async () => {
    await bootDevice();
    expect($("btn-open-settings").hidden).toBe(true);
    expect(FAKE_LAUNCH_FLAGS_OFF).toContain("experimental_enabled");

    const fake = readFileSync(resolve(process.cwd(), "e2e/race/fake-device.ts"), "utf8");
    // Stripped ONCE, before any index is taken, so every read below is of code. Doing it
    // per-assertion is how the two halves came apart: the absence half read stripped text
    // while the presence half read the raw file, and a literal list with `// from
    // FAKE_LAUNCH_FLAGS_OFF` beside it satisfied the pin while the list stopped crossing.
    const code = fake.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code, "the race fake no longer answers from FAKE_LAUNCH_FLAGS_OFF").toContain("FAKE_LAUNCH_FLAGS_OFF");

    // The callback handed to addInitScript is serialised and evaluated in the PAGE, where
    // this module's bindings do not exist. Naming the import inside it compiles, type-checks
    // and collects, then throws on the fake's first command — "Can't find variable: X" in
    // JavaScriptCore, "X is not defined" in V8 — which presents as a live session that never
    // comes up rather than as an error. The argument tuple is the only channel that crosses,
    // and the only one the type checker covers: the callback's annotation and the `as` cast
    // are the same tuple type, so an arity mismatch is a compile error.
    const open = code.indexOf("addInitScript(");
    const args = code.indexOf("[cfg, opts.storage", open);
    expect(open, "installFake no longer installs through addInitScript").toBeGreaterThan(-1);
    expect(args, "the init script's argument tuple moved").toBeGreaterThan(open);
    const body = code.slice(open, args);
    expect(body, "the init script closes over FAKE_LAUNCH_FLAGS_OFF instead of being handed it").not.toContain(
      "FAKE_LAUNCH_FLAGS_OFF",
    );
    expect(code.slice(args, args + 200), "the init script is not handed the flag list").toContain(
      "FAKE_LAUNCH_FLAGS_OFF",
    );

    // …and it still answers those commands false, through the parameter it arrived on. The
    // name is escaped before it becomes a pattern: `$` is legal in an identifier and is an
    // anchor in a regular expression, so `$flags` would otherwise match nothing and report
    // the answer as missing.
    const param = /addInitScript\(\s*\(\[[^\]]*,\s*([A-Za-z_$][\w$]*)\s*\]/.exec(body)?.[1];
    expect(param, "the init script's last parameter is not a plain binding").toBeTruthy();
    const name = String(param).replace(/[$]/g, "\\$&");
    expect(body).toMatch(new RegExp(`(?<![\\w$])${name}\\.includes\\(cmd\\)[\\s\\S]{0,80}?return false;`));
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

  // An update on offer is a confirm, and declining it must download nothing. The updater's
  // own commands are the observable for the decline — a declined check leaves no trace on
  // screen, so asserting the status would be asserting on the boot line.
  //
  // But everything after the wait is a zero, and a case whose whole verdict is absences
  // passes on any flow that never got as far as asking: an offer that regressed into an
  // error report, a version the frame failed to name, `checkUpdate` throwing after its
  // dialog. So the ASKING is pinned first, by message and by version.
  it("downloads nothing when the offered update is declined", SLOW, async () => {
    const shell = await bootDevice({ "plugin:updater|check": { rid: 7, version: "9.9.9" } }, false);
    await vi.waitFor(() => expect(confirms(shell).length).toBeGreaterThan(0), { timeout: 25_000 });
    await new Promise((r) => setTimeout(r, 100));
    expect(confirms(shell)).toEqual([t().confirm.update("9.9.9")]);
    expect(errors(shell)).toEqual([]);
    expect(shell.count("plugin:updater|download_and_install")).toBe(0);
    expect(shell.count("plugin:process|restart")).toBe(0);
  });

  // Accepted: the status says what is happening and the app restarts into the new bundle.
  // The restart never resolves in the real shell — the process is gone — so the stub holds
  // too, which is also what keeps the status line readable at the end.
  //
  // The accept arm also closes the Preferences modal, and this case does NOT cover that:
  // it drives the LAUNCH check, where `prefs.close()` is a documented no-op because the
  // modal was never open. Closing it matters only for a check started from inside
  // Preferences, which nothing here reaches — so the title claims the two halves that are
  // asserted below and not the third.
  it("downloads and restarts when the update is accepted", SLOW, async () => {
    const shell = await bootDevice({
      "plugin:updater|check": { rid: 7, version: "9.9.9" },
      "plugin:updater|download_and_install": null,
      "plugin:process|restart": () => new Promise(() => {}),
    });
    await invoked(shell, "plugin:process|restart");
    expect(shell.count("plugin:updater|download_and_install")).toBe(1);
    expect(statusText()).toBe(t().status.updateDownloading);
  });

  // Once accepted, "Downloading update…" is on screen with the modal closed, so a
  // failure has to clear that and surface — otherwise it reads as a download that never
  // ends. This is the one updater failure that is NOT silent, which is why it is a case
  // of its own beside the silent launch check above.
  it("surfaces a download that failed after the update was accepted", SLOW, async () => {
    const shell = await bootDevice({
      "plugin:updater|check": { rid: 7, version: "9.9.9" },
      "plugin:updater|download_and_install": () => {
        throw new Error("half-written");
      },
    });
    await invoked(shell, "plugin:updater|download_and_install");
    // showError clears the status line before raising the dialog, so the stuck
    // "Downloading…" is gone rather than merely covered.
    await vi.waitFor(() => expect(statusText()).toBe(""), { timeout: 10_000 });
    expect(shell.count("plugin:process|restart")).toBe(0);
    // An error dialog, and the one that names this failure. A cleared status line on its
    // own is also what a silent swallow leaves behind.
    await vi.waitFor(() => expect(errors(shell).length).toBeGreaterThan(0), { timeout: 10_000 });
    expect(errors(shell).at(-1)).toBe(t().prefs.updateCheckFailed);
  });
});

describe("the Follow USB badge", () => {
  const badge = (): HTMLButtonElement => $<HTMLButtonElement>("follow-usb");

  // Unknown is not a direction, so the first press READS rather than toggling —
  // guessing a direction would answer a question the operator has not asked yet.
  //
  // The absence of a write is the observable. A case that only checked the badge would
  // pass against a toggle that happened to land on "off", which is the one state the
  // badge must never claim without having read it: "off" is the state in which the rate
  // picker is trusted to stick.
  it("reads the unit on the first press instead of guessing a direction", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(false, 48_000) });
    expect(badge().dataset.state).toBe("unknown");

    badge().click();
    await invoked(shell, "vd_disconnect");
    expect(badge().dataset.state).toBe("off");
    expect(badge().getAttribute("aria-pressed")).toBe("false");
    expect(shell.count("vd_set")).toBe(0);
  });

  // Turning it ON hands the clock back to the USB host, which re-clocks the hardware
  // then and there when the host runs another rate — so it confirms. Declining has to
  // leave the state as READ, not as asked for.
  it("asks before handing the clock to the host, and writes nothing when declined", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(false, 48_000) }, false);
    badge().click();
    await invoked(shell, "vd_disconnect");
    expect(badge().dataset.state).toBe("off");

    // Counted from here: the first press is a read and raises no dialog, so an absolute
    // count would be asserting about the wrong press.
    const asked = confirms(shell).length;
    badge().click();
    await vi.waitFor(() => expect(confirms(shell).length).toBe(asked + 1), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 100));
    // Both the wait above and the assertions below go through `confirms()`, which reads
    // the dialog's ARGUMENTS. A count-based version of this case could not separate
    // "asked" from "threw on the way to asking": the second raises a dialog too, writes
    // nothing, and leaves the badge where it was.
    expect(confirms(shell).at(-1)).toBe(t().confirm.followUsbOn);
    expect(errors(shell)).toEqual([]);
    expect(followUsbWrites(shell)).toEqual([]);
    expect(badge().dataset.state).toBe("off");
  });

  it("writes the policy when the confirm is accepted, and says which way it went", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(false, 48_000) });
    badge().click();
    await invoked(shell, "vd_disconnect");

    badge().click();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.followUsbOn), { timeout: 10_000 });
    expect(badge().dataset.state).toBe("on");
    expect(followUsbWrites(shell)).toEqual([1]);
  });

  // Why OFF is not worth a confirm is stated where the asymmetry is implemented (the
  // Follow USB toggle in main.ts); this pins that it holds. Driven from a unit that
  // answers ON, which is also the only way to reach that arm at all. Every confirm
  // DECLINES here, so a confirm that appeared would abort the write and fail the case
  // rather than let it pass.
  it("turns the policy off without asking", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(true, 48_000) }, false);
    badge().click();
    await invoked(shell, "vd_disconnect");
    expect(badge().dataset.state).toBe("on");

    badge().click();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.followUsbOff), { timeout: 10_000 });
    expect(shell.count("plugin:dialog|message")).toBe(0);
    expect(followUsbWrites(shell)).toEqual([0]);
    expect(badge().dataset.state).toBe("off");
  });

  // While a session is up the connection is already held for it, and opening a second
  // one would fight it — so this write goes out on the session's own link. The connect
  // COUNT is the whole observable: the write itself looks identical either way.
  it("writes over the live session's own link rather than opening a second one", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(true, 48_000) });
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-pressed")).toBe("true"), { timeout: 25_000 });
    // The session start read the badge on its way up, so the press below is a toggle
    // rather than the read an unknown state would have taken.
    expect(badge().dataset.state).toBe("on");
    const connects = shell.count("vd_connect");

    badge().click();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.followUsbOff), { timeout: 10_000 });
    expect(shell.count("vd_connect")).toBe(connects);
    expect(live().getAttribute("aria-pressed")).toBe("true");
  });

  // A write that fails on the session's link is a mirror that did not complete, so it
  // takes the session down with it; why the badge then goes back to unknown rather than
  // holding its last reading is stated where that reset is implemented.
  it("takes the session down when the write fails on its link", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(true, 48_000) });
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-pressed")).toBe("true"), { timeout: 25_000 });

    const armedAt = shell.invokes.length;
    shell.failOnce("vd_set", new Error("link-gone"));
    badge().click();
    await vi.waitFor(() => expect(live().getAttribute("aria-pressed")).toBe("false"), { timeout: 10_000 });
    expect(badge().dataset.state).toBe("unknown");
    // The failure that took the session down was THIS write. `failOnce` arms the next
    // `vd_set` from anyone and the session has writers of its own, so the count alone
    // would let the case pass on a session that fell over for an unrelated reason. The
    // ledger is ordered, so the first write after the arming point settles which one it
    // caught — no predicate on the latch needed.
    const refused = shell.invokes.indexOf("vd_set", armedAt);
    expect(refused).toBeGreaterThan(-1);
    expect(shell.args[refused]?.paramId).toBe(PARAMS.FOLLOW_USB.id);
    expect(followUsbWrites(shell)).toHaveLength(1);
  });
});

describe("the sample rate a write happens at", () => {
  const modal = (): HTMLElement => $("rate-choice");

  /** Click Write and wait for the three-way to come up. */
  async function askedToChoose(shell: TauriShell): Promise<void> {
    $("btn-write").click();
    await vi.waitFor(() => expect(modal().hidden).toBe(false), { timeout: 15_000 });
    expect(shell.count("vd_set")).toBe(0); // nothing goes out before the rate is settled
  }

  // The rate is the one plan value the device can accept and then undo on its own: with
  // Follow USB on it re-clocks and is then dragged back to the host's rate. The interval
  // that was measured on hardware is in architecture.md "Sample rate and Follow USB" and
  // is deliberately not restated here. So the disagreement is a three-way rather than a
  // yes/no, and none of the three answers may be inferred.
  it("cancels the whole write when the three-way is dismissed", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(true, 96_000) });
    await askedToChoose(shell);

    $("rate-choice-cancel").click();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.canceled), { timeout: 10_000 });
    expect(modal().hidden).toBe(true);
    expect(shell.count("vd_set")).toBe(0);
    expect(followUsbWrites(shell)).toEqual([]);
  });

  // Adopting is an edit like any other — the operator chose it — so it goes through the
  // same funnel as the picker and is remembered as the last known rate. Being REMEMBERED
  // is the half a plan-only assertion misses.
  it("adopts the device's rate into the plan, the picker and the stored rate", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(true, 96_000) });
    await askedToChoose(shell);

    $("rate-choice-adopt").click();
    await vi.waitFor(() => expect($<HTMLSelectElement>("rate-picker").value).toBe("96000"), { timeout: 10_000 });
    expect(localStorage.getItem("urx-rate")).toBe("96000");
    // …and the write went ahead at the adopted rate rather than stopping at the choice.
    await invoked(shell, "vd_disconnect");
    expect(shell.count("vd_set")).toBeGreaterThan(10);
    expect(followUsbWrites(shell)).toEqual([]); // adopting does not touch the policy
  });

  // Releasing turns Follow USB off so the plan's rate can stick, and the badge follows at
  // once: the operator is being told the picker is authoritative again.
  it("releases the clock so the plan's rate can stick", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(true, 96_000) });
    await askedToChoose(shell);

    $("rate-choice-release").click();
    await vi.waitFor(() => expect(followUsbWrites(shell)).toEqual([0]), { timeout: 10_000 });
    expect($("follow-usb").dataset.state).toBe("off");
    expect($<HTMLSelectElement>("rate-picker").value).toBe("48000"); // the plan's rate, unchanged
    await invoked(shell, "vd_disconnect");
  });

  // A policy write that fails leaves the premise of the whole write unestablished, so it
  // aborts rather than writing at a rate it just failed to secure.
  it("abandons the write when the clock cannot be released", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(true, 96_000) });
    await askedToChoose(shell);

    shell.failOnce("vd_set", new Error("refused"));
    $("rate-choice-release").click();
    await invoked(shell, "vd_disconnect");
    await new Promise((r) => setTimeout(r, 100));
    expect(shell.count("vd_set")).toBe(1); // the refused policy write, and nothing after it
    // The write that was refused was the POLICY one, and the failure reached the operator.
    // Aborting in silence is the other way this ends, and it looks the same from the
    // counts: nothing on screen, nothing on the wire.
    expect(followUsbWrites(shell)).toEqual([0]);
    expect(errors(shell).at(-1)).toBe(t().status.writeError(t().error.followUsbWrite("refused")));
  });

  // Above 96 kHz whole features drop out, so adopting names them before the choice is
  // made. Both arms are pinned: the note is the only thing that makes `adopt` not a
  // surprise, and an empty one has to be hidden rather than left as a gap.
  it("names what a rate above 96 kHz would leave unwritten", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(true, 192_000) });
    await askedToChoose(shell);

    expect($("rate-choice-note").hidden).toBe(false);
    expect($("rate-choice-note").textContent).not.toBe("");
    $("rate-choice-cancel").click();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.canceled), { timeout: 10_000 });
  });

  it("shows no note when nothing would be left unwritten", SLOW, async () => {
    const shell = await bootDevice({ vd_get: clockReads(true, 44_100) });
    await askedToChoose(shell);

    expect($("rate-choice-note").hidden).toBe(true);
    $("rate-choice-cancel").click();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.canceled), { timeout: 10_000 });
  });

  // Which rate the device will end up running at decides which parameters the write may
  // even contain, so a clock read that fails is fail-closed: proceeding would be writing
  // on a premise the link just failed to establish.
  it("writes nothing when the clock cannot be read", SLOW, async () => {
    const shell = await bootDevice({
      vd_get: (a: Record<string, unknown>) => {
        if (a.paramId === PARAMS.FOLLOW_USB.id) throw new Error("timeout");
        return 0;
      },
    });
    $("btn-write").click();
    await vi.waitFor(() => expect(errors(shell).length).toBeGreaterThan(0), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 100));
    expect(modal().hidden).toBe(true); // fail-closed, not "ask the operator instead"
    expect(shell.count("vd_set")).toBe(0);
    // Reported as the clock read failing, rather than as whatever the flow hit next: the
    // three-way staying down and no writes going out are equally true of a flow that fell
    // over somewhere else entirely.
    expect(errors(shell).at(-1)).toBe(t().status.writeError(t().error.clockUnread("timeout")));
  });
});

describe("the device self-test", () => {
  const bootExperimental = (over: Record<string, unknown> = {}, agree = true): Promise<TauriShell> =>
    bootDevice({ experimental_enabled: true, ...over }, agree);

  /** The menu entry, once the launch flag has revealed it (the gate resolves async). */
  const selfTestBtn = async (): Promise<HTMLButtonElement> => {
    const btn = $<HTMLButtonElement>("btn-selftest");
    await vi.waitFor(() => expect(btn.hidden).toBe(false), { timeout: 10_000 });
    return btn;
  };

  /**
   * Wait for a run to start and then finish, off the button's own label.
   *
   * Neither the status line nor the label alone can say this. The label already reads
   * "Self-test" before the click, so waiting for it is satisfied immediately; and the
   * status line before the run is the boot line, so "no longer running" is true then
   * too. Both edges, in order, is what makes the wait about a run that happened.
   */
  async function ranToCompletion(btn: HTMLButtonElement): Promise<void> {
    await vi.waitFor(() => expect(btn.textContent).toBe(t().toolbar.selfTestCancel), { timeout: 15_000 });
    await vi.waitFor(() => expect(btn.textContent).toBe(t().toolbar.selfTest), { timeout: 25_000 });
  }

  // The run perturbs every writable parameter and puts it back, so it confirms first.
  // Against a unit that answers reads with what was written to it the sweep converges and
  // the restore verifies, which is the PASS frame — and the count comes out of the frame
  // so the assertion pins the whole message rather than a substring.
  it("asks first, then sweeps the unit and puts it back", SLOW, async () => {
    const log = captureWarnings();
    try {
      const shell = await bootExperimental();
      const btn = await selfTestBtn();
      btn.click();
      await ranToCompletion(btn);

      const n = Number(/\d+/.exec(statusText())?.[0]);
      expect(n).toBeGreaterThan(10);
      expect(statusText()).toBe(t().status.selfTestPass(n));
      expect(log.lines.some((l) => l.startsWith("[self-test] PASS"))).toBe(true);
      // The count in the frame is what the run says it wrote; this is that the writes
      // reached the wire. A PASS reported over an empty sweep would satisfy the first.
      expect(shell.count("vd_set")).toBeGreaterThan(10);
      // The link is let go: a diagnostic that kept it would lock every other device
      // action for the rest of the launch.
      expect($<HTMLButtonElement>("btn-fetch").disabled).toBe(false);
    } finally {
      log.restore();
    }
  });

  it("writes nothing when the confirm is declined", SLOW, async () => {
    const shell = await bootExperimental({}, false);
    const btn = await selfTestBtn();
    btn.click();
    await vi.waitFor(() => expect(dialogs(shell).length).toBeGreaterThan(0), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 100));
    expect(shell.count("vd_set")).toBe(0);
    expect(btn.textContent).toBe(t().toolbar.selfTest); // the run never started
    // It ASKED. A run that threw on its way to the confirm would report an error dialog,
    // write nothing and leave the label alone — the two assertions above cannot separate
    // "declined" from "never got that far".
    expect(confirms(shell)).toHaveLength(1);
    expect(errors(shell)).toEqual([]);
  });

  // The menu entry doubles as its own cancel: the run is minutes of serial round-trips and
  // stalls entirely if the link drops, so a second click has to mean stop rather than
  // start another one. A cancel is reported as a cancel — never as a failed restore, which
  // would tell the operator their unit may be left perturbed.
  it("turns into its own cancel while it runs", SLOW, async () => {
    const log = captureWarnings();
    try {
      const shell = await bootExperimental();
      // One millisecond per write gives the run a middle. Without it the whole sweep
      // completes between two polls of waitFor and the second click lands on a run that
      // has already finished — which is how a cancel case passes while cancelling nothing.
      shell.answer("vd_set", () => new Promise((r) => setTimeout(() => r(undefined), 1)));
      const btn = await selfTestBtn();
      btn.click();
      await vi.waitFor(() => expect(btn.textContent).toBe(t().toolbar.selfTestCancel), { timeout: 15_000 });

      btn.click();
      await vi.waitFor(() => expect(statusText()).toBe(t().status.selfTestCancelled), { timeout: 25_000 });
      expect(btn.textContent).toBe(t().toolbar.selfTest);
      expect(log.lines.some((l) => l.startsWith("[self-test] CANCELLED"))).toBe(true);
    } finally {
      log.restore();
    }
  });

  // A run that cannot open its own link surfaces as a dialog and lets the latch go. The
  // dialog count starts at one because the confirm is itself a dialog, so the assertion is
  // "a second one arrived" rather than "one did".
  it("reports a run that cannot open its own link, and holds nothing afterwards", SLOW, async () => {
    const log = captureWarnings();
    try {
      const shell = await bootExperimental({
        vd_connect: () => {
          throw new Error("no-device");
        },
      });
      const btn = await selfTestBtn();
      btn.click();
      // The REPORT, not a second dialog: the confirm this run already raised is why a
      // count had to say "more than one" here, and counting says nothing about what the
      // second one told the operator. What it says is the DIAGNOSIS rather than a
      // self-test frame — `connectFailureStatus` recognises this failure and replaces the
      // wrapper with the message that tells the operator what to do about it.
      await vi.waitFor(() => expect(errors(shell).length).toBeGreaterThan(0), { timeout: 15_000 });
      expect(errors(shell).at(-1)).toBe(t().error.shell.noDevice);
      expect(log.lines.some((l) => l.startsWith("[self-test] ERROR"))).toBe(true);
      expect(btn.textContent).toBe(t().toolbar.selfTest);
      expect($<HTMLButtonElement>("btn-fetch").disabled).toBe(false);
    } finally {
      log.restore();
    }
  });

  // The --self-test launch has nobody to answer either dialog: it must not ask before
  // starting, and its report goes to the log rather than to a save dialog — in chunks,
  // since one console line carrying the whole thing risks the dev server's forwarding
  // limits.
  //
  // A report exists only when the run has something to say. URX44V carries no unconfirmed
  // mappings, so a clean run logs none; the unreadable string parameters below are what
  // gives it something, and they are read through a command of their own so the numeric
  // store — the thing that lets the sweep converge at all — is left intact.
  it("runs itself on the --self-test launch, asking nothing and logging the report", SLOW, async () => {
    const log = captureWarnings();
    try {
      const shell = await bootExperimental({
        self_test_requested: true,
        vd_get_str: () => {
          throw new Error("unreadable");
        },
      });
      await vi.waitFor(() => expect(log.lines.some((l) => l.startsWith("[self-test] report 1/"))).toBe(true), {
        timeout: 25_000,
      });
      expect(shell.count("plugin:dialog|message")).toBe(0);
    } finally {
      log.restore();
    }
  });

  // --prepare-modified spreads every writable scalar to a distinctive value and leaves it
  // there — deliberately no restore, so a scene SAVE/RECALL diff has something to show.
  // Its own status frame is untranslated on purpose (it is a diagnostic, not a surface),
  // which is why this asserts a shape rather than a catalog entry.
  it("runs the audit writer on the --prepare-modified launch and leaves the unit written", SLOW, async () => {
    const log = captureWarnings();
    try {
      const shell = await bootExperimental({ prepare_modified_requested: true });
      await vi.waitFor(() => expect(statusText()).toMatch(/^prepare-modified: wrote \d+, residual \d+$/), {
        timeout: 25_000,
      });
      expect(shell.count("vd_set")).toBeGreaterThan(10);
      expect(log.lines.some((l) => l.startsWith("[prepare-modified] DONE"))).toBe(true);
      expect($<HTMLButtonElement>("btn-fetch").disabled).toBe(false);
    } finally {
      log.restore();
    }
  });

  it("reports an audit run that cannot connect", SLOW, async () => {
    const log = captureWarnings();
    try {
      const shell = await bootExperimental({
        prepare_modified_requested: true,
        vd_connect: () => {
          throw new Error("no-device");
        },
      });
      // The log line says the run failed; this says the operator was told, and told what.
      // The two are separate surfaces on purpose — a headless launch reads the log — so a
      // regression that kept the log and dropped the dialog leaves nothing on screen.
      await vi.waitFor(() => expect(errors(shell).length).toBeGreaterThan(0), { timeout: 15_000 });
      expect(errors(shell).at(-1)).toBe(t().error.shell.noDevice);
      expect(log.lines.some((l) => l.startsWith("[prepare-modified] ERROR"))).toBe(true);
      expect($<HTMLButtonElement>("btn-fetch").disabled).toBe(false);
    } finally {
      log.restore();
    }
  });
});

// The experimental `.urxf` import: the unit's own microSD settings file read onto the plan
// already open, through the same device→plan inverse a fetch uses. Nothing is sent to
// hardware — the file is the source — so the whole flow is reachable with no device on the
// link, and the absence of writes is part of what each case says.
//
// Driven through the shell rather than through a module mock: the dialog and the file read
// are two Tauri commands, so answering them is the same seam every other case here uses.
describe("importing a settings file", () => {
  const PATH = "C:/urx/backup.urxf";

  /** Boot with the import armed and `read_binary_file` answering `bytes`. */
  const bootImport = async (bytes: Uint8Array, agree = true): Promise<TauriShell> => {
    const shell = await bootDevice(
      {
        experimental_enabled: true,
        "plugin:dialog|open": PATH,
        // The bytes come back as the raw IPC response body, which platform.ts wraps in a
        // Uint8Array — so what this hands over is the buffer, not a number array.
        read_binary_file: () => bytes.buffer,
        // A partial import offers to save its report, and every confirm here says Ok. A
        // dismissed save dialog keeps that offer from becoming the outcome under test: left
        // unanswered the save rejects, and `showError` then blanks the very status line
        // these cases are reading.
        "plugin:dialog|save": null,
      },
      agree,
    );
    await vi.waitFor(() => expect($("btn-open-settings").hidden).toBe(false), { timeout: 10_000 });
    return shell;
  };

  // The sample carries six parameters where a unit's own file carries hundreds, so this is
  // the PARTIAL path — which is the one worth pinning: what did not come through has to be
  // counted rather than swallowed, and the nodes still showing their plan default have to be
  // flagged as such on the board. Same provenance rule as a device fetch.
  //
  // The frame is rebuilt from the numbers in it rather than matched as a substring, so the
  // message that renders them is pinned by KEY. Rebuilding cannot pin the numbers
  // themselves — the expectation is built from the same digits — so the count of them is
  // asserted separately: `settingsPartial` renders its third figure as an optional tail,
  // and a regression that dropped that tail while nodes were genuinely unread would
  // reconstruct to the shorter string and pass.
  it("reads what the file carries, counts what it does not, and writes nothing", SLOW, async () => {
    const shell = await bootImport(sampleUrxf());
    $("btn-open-settings").click();
    await vi.waitFor(() => expect(statusText()).not.toContain("URX44V"), { timeout: 15_000 });

    const counts = [...statusText().matchAll(/\d+/g)].map((m) => Number(m[0]));
    expect(counts).toHaveLength(3); // applied, failed, and the unread tail that is optional
    expect(statusText()).toBe(t().status.settingsPartial(counts[0], counts[1], counts[2]));
    expect(counts[0]).toBeGreaterThan(0); // something landed
    expect(counts[1]).toBeGreaterThan(0); // and the rest is reported

    // The "?" badge: a node whose body did not come through keeps its plan default and the
    // board says so, rather than presenting a default as if the file had confirmed it.
    const flagged = [...$("graph-host").querySelectorAll("g.node[data-id]")].filter((g) =>
      [...g.querySelectorAll("text")].some((el) => el.textContent === "?"),
    );
    expect(flagged.length).toBeGreaterThan(0);

    // Nothing was sent anywhere: the file is the source, and no link is opened at all.
    expect(shell.count("vd_set")).toBe(0);
    expect(shell.count("vd_set_str")).toBe(0);
    expect(shell.count("vd_connect")).toBe(0);
  });

  // The file names no model — its header reads "URX" for every variant — so the operator
  // vouches for the one on screen. Declining that confirm must leave the plan alone, and
  // the status has to say the import did not happen.
  it("makes the operator vouch for the model, and abandons the import when declined", SLOW, async () => {
    const shell = await bootImport(sampleUrxf(), false);
    $("btn-open-settings").click();
    await vi.waitFor(() => expect(statusText()).toBe(t().status.canceled), { timeout: 15_000 });
    expect(shell.count("read_binary_file")).toBe(1); // read, then refused — not the reverse
  });

  // A dismissed file dialog is not a failure and not a cancel of anything: nothing was
  // asked and nothing happened, so the status line must not move at all.
  it("does nothing when the file dialog is dismissed", SLOW, async () => {
    const shell = await bootImport(sampleUrxf());
    shell.answer("plugin:dialog|open", null);
    const before = statusText();
    $("btn-open-settings").click();
    await invoked(shell, "plugin:dialog|open");
    await new Promise((r) => setTimeout(r, 100));
    expect(statusText()).toBe(before);
    expect(shell.count("read_binary_file")).toBe(0);
  });

  // Reading and parsing share one failure surface, which is why neither entry point
  // carries its own catch. A file that is not a settings file at all is the parser's own
  // typed refusal, and it has to arrive as a localized reason rather than as a raw code.
  it("reports a file that is not a settings file", SLOW, async () => {
    const shell = await bootImport(new Uint8Array(128));
    $("btn-open-settings").click();
    await vi.waitFor(() => expect(dialogs(shell).length).toBeGreaterThan(0), { timeout: 15_000 });
    // Exactly one dialog, and it REPORTED rather than asked: the six `error.urxf` reasons
    // share one surface, so naming the reason is what keeps this case distinct from the
    // one below rather than both passing on "some dialog appeared".
    expect(dialogs(shell)).toHaveLength(1);
    expect(errors(shell)).toEqual([t().status.settingsError(t().error.urxf.notUrxf)]);
  });

  // A well-formed file carrying only stored scenes. CURRENT is the unit's live settings and
  // the only chunk with a place in a plan — a scene's values have nowhere to go — so this
  // is a distinct refusal from "not a settings file", reached through the same surface.
  it("reports a settings file with no CURRENT chunk", SLOW, async () => {
    const shell = await bootImport(buildUrxf([{ chunk: "SCENE", block: "SCENE", label: "My Data 1", fields: [] }]));
    $("btn-open-settings").click();
    await vi.waitFor(() => expect(dialogs(shell).length).toBeGreaterThan(0), { timeout: 15_000 });
    expect(statusText()).toBe(""); // showError cleared the line rather than leaving progress on it
    expect(shell.count("vd_connect")).toBe(0);
    // The reason, not just a refusal: collapsing the six `error.urxf` messages into one,
    // or mapping this file onto `notUrxf`, would leave both cases green.
    expect(errors(shell)).toEqual([t().status.settingsError(t().error.urxf.noCurrent)]);
  });

  // Replacing every value at once is what Live sync cannot follow, so the import is closed
  // for a session's duration — the same rule fetch and write follow.
  //
  // The menu entry is closed by being DISABLED, which is what this case reads. That is not
  // the whole guard: a drop reaches the same flow without passing the button, so the flow
  // states the refusal a second time in code, and the case below drives that half.
  it("closes the import while a live session is up", SLOW, async () => {
    await bootImport(sampleUrxf());
    expect($<HTMLButtonElement>("btn-open-settings").disabled).toBe(false);

    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-pressed")).toBe("true"), { timeout: 25_000 });
    expect($<HTMLButtonElement>("btn-open-settings").disabled).toBe(true);
  });

  // The other half of that refusal, and the one a disabled button cannot cover: on desktop
  // a drop is intercepted by the shell and arrives as an event, so it reaches the import
  // flow without going near the menu entry. The registration itself is inside the
  // experimental gate, which is why this can only be driven with the import armed.
  it("refuses a settings file DROPPED onto the window while a live session is up", SLOW, async () => {
    const shell = await bootImport(sampleUrxf());
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-pressed")).toBe("true"), { timeout: 25_000 });
    const reads = shell.count("read_binary_file");

    // One handler, not zero: an event nobody listens for would make every assertion below
    // pass by describing an app that was never asked to do anything.
    expect(shell.emit("tauri://drag-drop", { paths: [PATH] })).toBe(1);

    await vi.waitFor(() => expect(errors(shell).length).toBeGreaterThan(0), { timeout: 10_000 });
    expect(errors(shell).at(-1)).toBe(t().error.notWhileLive);
    // Refused before the file was even read, and the session it would have disrupted is
    // still up.
    expect(shell.count("read_binary_file")).toBe(reads);
    expect(live().getAttribute("aria-pressed")).toBe("true");
  });
});

describe("the --reset-storage launch", () => {
  // The flag arrives async — after the synchronous init has already read localStorage —
  // so the only way to re-init clean is to clear and reload once. jsdom cannot navigate
  // and its `reload` is non-configurable (so it cannot be stubbed either): the call
  // prints "Not implemented: navigation to another Document" and returns. That line in
  // the output is this case working, not failing.
  //
  // sessionStorage is cleared by hand here. `restoreAppGlobals` does not touch it — only
  // this flow reads it — so without the clear the second case's state would leak into
  // whichever of the two ran later.
  it("clears storage and holds the rest of boot for the reload", SLOW, async () => {
    sessionStorage.clear();
    const shell = await bootDevice({ reset_storage_requested: true });
    await vi.waitFor(() => expect(sessionStorage.getItem("urx-reset-done")).toBe("1"), { timeout: 10_000 });

    // The seeds the fixture wrote are gone, which is the whole point: the model, the
    // language and the accepted consent all live in localStorage.
    expect(localStorage.getItem("urx-model")).toBeNull();
    expect(localStorage.getItem("urx-disclaimer-accepted")).toBeNull();
    // …and boot() never ran past the reset, so nothing downstream of it happened.
    await new Promise((r) => setTimeout(r, 100));
    expect(shell.count("plugin:updater|check")).toBe(0);
  });

  // The flag is still set on the launch that follows the reload, so without the guard the
  // app would clear and reload forever. Set BEFORE the boot, since the module reads it
  // during its own startup.
  it("clears once per launch rather than looping the reload", SLOW, async () => {
    sessionStorage.clear();
    sessionStorage.setItem("urx-reset-done", "1");
    const shell = await bootDevice({ reset_storage_requested: true });
    await invoked(shell, "plugin:updater|check"); // boot() ran on through

    expect(localStorage.getItem("urx-model")).toBe("URX44V"); // the second clear did not happen
    sessionStorage.clear();
  });
});
