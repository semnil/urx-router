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
import {
  $,
  bootApp,
  currentShell,
  deviceCommands,
  installAppGlobals,
  restoreAppGlobals,
  statusText,
} from "./main.test-util";
import type { TauriShell } from "./main.test-util";
import { formatRate } from "./core/constraints";
import { attackToVd, eqFreqToVd } from "./core/control/vd";
import { formatHz } from "./core/control/fx-effect";
import { COMP_EQ_SSMCS, denormalizeInsertFx, INSERT_FX_NONE } from "./core/control/params";
import { SUPPORTED_SYSTEM_FIRMWARE } from "./core/control/firmware";
import { PARAMS } from "./core/control/params";
import { nameControl } from "./core/control/translate";
import { getModel } from "./models";
import { faceplate, press, wireHit } from "./ui/graph.test-util";
import { buildUrxf, sampleUrxf } from "./core/control/urxf.test-util";
import { EDIT_MENU_EVENT, EDIT_REDO_ID, EDIT_UNDO_ID } from "./core/platform";
import { t } from "./i18n";

/** Long enough for a whole-device read (676 reads through the stub) plus a teardown. */
const SLOW = { timeout: 30_000 };

beforeEach(installAppGlobals);
// The app a case leaves behind. A case returns as soon as its own assertion holds, but the
// flow it started runs on: a live session reads the whole unit before it comes up, and a
// release waits out a follow read that is hundreds of round trips long. Once the next
// `bootApp` installs a fresh table those calls land in it — where they read as that case's
// own traffic, and where a teardown's `vd_disconnect` satisfies a wait for the disconnect
// the case is actually about.
afterEach(async () => {
  const rate = document.getElementById("rate-picker") as HTMLSelectElement | null;
  const btn = document.getElementById("btn-live");
  // The app's OWN signal, not a guess at how long things take: the rate picker is locked
  // for exactly as long as something holds the device link, whichever action holds it. A
  // session in the middle of starting holds it with the toggle still down, so the two are
  // waited on together — and the loop is what lets a start that completes here be ended.
  for (let i = 0; rate && i < 5; i++) {
    if (btn?.getAttribute("aria-pressed") === "true") {
      btn.click();
      await vi.waitFor(() => expect(btn.getAttribute("aria-pressed")).toBe("false"), { timeout: 25_000 });
    }
    if (!rate.disabled) break;
    await vi.waitFor(() => expect(!rate.disabled || btn?.getAttribute("aria-pressed") === "true").toBe(true), {
      timeout: 25_000,
    });
  }
  const shell = currentShell();
  if (shell) await drainShell(shell);
  restoreAppGlobals();
});

/** Wait until the page stops invoking. Bounded, and it THROWS at the bound rather than
 *  returning: an app that never goes quiet is a case leaking into the next one, which is
 *  the thing this exists to stop, and swallowing it here would put that back silently. */
async function drainShell(shell: TauriShell): Promise<void> {
  const deadline = Date.now() + 20_000;
  let seen = shell.invokes.length;
  // Several readings: one sample of "unchanged" is satisfied inside a pause between two
  // phases of the very flow being waited out.
  for (let quiet = 0; quiet < 10;) {
    if (Date.now() > deadline) throw new Error(`the page is still invoking (${shell.invokes.length})`);
    await new Promise((r) => setTimeout(r, 10));
    const now = shell.invokes.length;
    quiet = now === seen ? quiet + 1 : 0;
    seen = now;
  }
}

/** Boot with a connected unit. `agree` answers every confirm with Ok. */
const bootDevice = async (
  over: Record<string, unknown> = {},
  agree = true,
  /** Addresses the unit already holds a value for. Needed for anything the app only READS:
   *  the table answers an unwritten address 0, and 0 is a legal value there. */
  seed: Record<string, number> = {},
): Promise<TauriShell> =>
  (await bootApp({ tauri: deviceCommands({ ...(agree ? { "plugin:dialog|message": "Ok" } : {}), ...over }, seed) }))!;

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

/** The inspector row a label names (main.flows.test.ts). */
const row = (label: string): HTMLElement => {
  const found = $("inspector").querySelector<HTMLElement>(`.param[data-param-label="${label}"]`);
  expect(found, `the inspector shows a "${label}" row`).not.toBeNull();
  return found!;
};

/** Select a node the way a click does, so the inspector renders for it. */
const selectNode = (id: string): void => {
  const face = faceplate($("graph-host"), id)!;
  face.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, bubbles: true }));
  face.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
};

/** The notify channel the live session registered, taken from the subscribe's own
 *  arguments rather than by position. */
const notifyChannel = (shell: TauriShell): { onmessage: (d: unknown) => void } =>
  (shell.args[shell.invokes.indexOf("vd_params_subscribe")] as { channel: { onmessage: (d: unknown) => void } })
    .channel;

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

/**
 * Answer each confirm by what it SAYS, so a case can decline exactly one of several.
 * Answering by call order breaks the moment a flow gains or loses a prompt — and it
 * breaks by answering the wrong question, not by failing to answer.
 */
function byMessage(agree: (message: string) => boolean): (a: Record<string, unknown>) => string {
  return (a) => (agree(String(a.message ?? "")) ? "Ok" : "Cancel");
}

/** The part of a prompt after its question mark, which is the part that carries no
 *  count — so two attempts asking the same question with different numbers match one
 *  needle. Never empty for the two prompts below, so it cannot match everything. */
const invariantOf = (prompt: string): string => prompt.replace(/^[\s\S]*?\?\s*/, "");
const WRITE_ASK = invariantOf(t().confirm.write(1));
const RETRY_ASK = invariantOf(t().confirm.writeRetry(1, 1));

/**
 * The count a status line was formatted with: the number in the line for which the
 * message function reproduces the line exactly. The assertion beside it then pins the
 * whole FRAME — a neighbouring message carrying the same count cannot satisfy it — while
 * the count itself stays derived rather than hard-coded.
 *
 * Reading a number out by position is wrong in both directions here, because model names
 * carry digits: `fetchedDevice` prints the count before the model (`Fetched 139 settings
 * from URX22`) and `liveOn` prints it after (`… · URX22 · 139 settings read`), so "the
 * first number" and "the last number" each pick up `22` in one of them.
 *
 * NaN when nothing reconstructs the line, which fails the magnitude check beside it.
 */
const countFor = (line: string, frame: (n: number) => string): number =>
  (line.match(/\d+/g)?.map(Number) ?? []).find((n) => frame(n) === line) ?? NaN;

/** The two commands a report save travels. Deliberately absent from `deviceCommands`: a
 *  device action that saves a file unasked is a defect, so a case that expects a save has
 *  to opt in, and one that does not gets the stub's refusal. */
const SAVES: Record<string, unknown> = { "plugin:dialog|save": "/tmp/report.md", write_text_file: null };

/** A connected unit that is not the model on screen. */
const connectAs = (model: string): Record<string, unknown> => ({
  vd_connect: { model, label: model, firmware: SUPPORTED_SYSTEM_FIRMWARE, epoch: 1 },
});

/** A store that answers the clock and refuses every other read, so a write reaches its
 *  DIFF and stops there. The clock has to answer: a failed clock read ends the write one
 *  gate earlier, which is main's own "writes nothing when the clock cannot be read". */
const diffReadsFail = (a: Record<string, unknown>): number => {
  if (a.paramId === PARAMS.FOLLOW_USB.id || a.paramId === PARAMS.SAMPLE_RATE.id) {
    return clockReads(false, 48_000)(a);
  }
  throw new Error("read-refused");
};

/** An inspector row by the label it stamps on itself, so "Insert FX" cannot match
 *  "Insert FX ON" — two rows carrying two different addresses. */
const paramRow = (label: string): HTMLElement =>
  $("inspector").querySelector<HTMLElement>(`.param[data-param-label="${label}"]`)!;

/** The Insert FX section. It is a collapsible on-state section like GATE / COMP / EQ, so
 *  its controls are reached THROUGH it rather than by a row label: the bypass row carries
 *  no label of its own, the header being its name, and the selector's row is the type. */
const insertFxSection = (): HTMLDetailsElement | undefined =>
  [...$("inspector").querySelectorAll<HTMLDetailsElement>("details.insp-section")].find(
    (d) => d.querySelector(".sec-title")?.textContent === "Insert FX",
  );

/** Pick an insert effect the way the inspector's own select does. */
const pickInsertFx = (value: number): void => {
  const sel = insertFxSection()!.querySelector("select")!;
  sel.value = String(value);
  sel.dispatchEvent(new Event("change", { bubbles: true }));
};

/** Signal Type, whose STEREO option links the pair the insert FX then mirrors across. */
const pickSignalType = (value: number): void => {
  const sel = paramRow("Signal Type").querySelector("select")!;
  sel.value = String(value);
  sel.dispatchEvent(new Event("change", { bubbles: true }));
};

/** PAN / BAL, the mode that decides which of the two pair mirrors runs. */
const pickPanBal = (value: number): void => {
  const sel = paramRow("PAN / BAL").querySelector("select")!;
  sel.value = String(value);
  sel.dispatchEvent(new Event("change", { bubbles: true }));
};

/** Which half of the bypass toggle is lit. The section holds one toggle group; the
 *  launcher beside it is a plain button and carries no `on`. */
const insertFxOnFace = (): string | undefined =>
  insertFxSection()?.querySelector<HTMLElement>(".toggle button.on")?.textContent ?? undefined;

/** An insert effect whose sample-rate ceiling (96 kHz) a 192 kHz clock is above,
 *  which is what makes the unit drop it. */
const COMPANDER_H = 1793;

/** Every value written to the insert-FX selector, in order. Read off the ledger by
 *  ADDRESS: a flush sends hundreds of writes, so counting `vd_set` cannot say whether
 *  this one went out, nor what it carried. */
const insertFxWrites = (shell: TauriShell): number[] =>
  shell.invokes.flatMap((cmd, i) =>
    cmd === "vd_set" && shell.args[i]?.paramId === PARAMS.INSERT_FX.id ? [shell.args[i]!.value as number] : [],
  );

/** Wait until the shell stops being asked anything, so what happens next is the only
 *  thing in flight. A count that has merely grown says nothing about WHOSE reads they
 *  were. */
const quiet = async (shell: TauriShell): Promise<void> => {
  let seen = -1;
  let stable = 0;
  await vi.waitFor(
    () => {
      const now = shell.invokes.length;
      stable = now === seen ? stable + 1 : 0;
      seen = now;
      // Several readings, not one: a flush pauses between its own phases, and a single
      // stable sample is satisfied inside one of those pauses.
      if (stable < 4) throw new Error(`still working (${now})`);
    },
    { timeout: 25_000, interval: 200 },
  );
};

// The device table's own contract, which no case below can state: it is the fixture all of
// them run on, so a loosening here is invisible from inside them and every one of them goes
// on passing. What it copies is the shell (`src-tauri/src/vd.rs`): every vd command but
// connect, disconnect and the link stats goes through `sender()`, which answers
// "not-connected" while no worker is installed, and `disconnect` closes only the generation
// whose epoch it is handed.
describe("the device table the desktop cases run on", () => {
  /** One command out of the table, called the way the shell calls it. */
  const call = (table: Record<string, unknown>, cmd: string, a: Record<string, unknown> = {}): unknown =>
    (table[cmd] as (x: Record<string, unknown>) => unknown)(a);
  const CH1 = { paramId: PARAMS.CH_FADER.id, x: 0, y: 0 };

  it("refuses device traffic until a connection is open, and again once it is released", () => {
    const table = deviceCommands();
    expect(() => call(table, "vd_get", CH1)).toThrow(/not-connected/);

    const { epoch } = call(table, "vd_connect") as { epoch: number };
    expect(call(table, "vd_get", CH1)).toBe(0);

    call(table, "vd_disconnect", { epoch });
    expect(() => call(table, "vd_get", CH1)).toThrow(/not-connected/);
  });

  // The subscriptions reach the shell through that same `sender()`. Answering them while
  // disconnected would let a session start over a link that is not there.
  it("refuses the subscriptions on the same rule as the reads", () => {
    const table = deviceCommands();
    const subs = ["vd_params_subscribe", "vd_meters_subscribe", "vd_watch_link"];
    for (const cmd of subs) expect(() => call(table, cmd)).toThrow(/not-connected/);
    call(table, "vd_connect");
    for (const cmd of subs) expect(call(table, cmd)).toBeNull();
  });

  // A stale epoch closes nothing: the app opens a connection inside a live session and
  // releases it again, and a teardown that ignored the epoch would end the session.
  it("closes only the generation the disconnect names", () => {
    const table = deviceCommands();
    const first = (call(table, "vd_connect") as { epoch: number }).epoch;
    const second = (call(table, "vd_connect") as { epoch: number }).epoch;
    expect(second).not.toBe(first);

    call(table, "vd_disconnect", { epoch: first });
    expect(call(table, "vd_get", CH1)).toBe(0);
    call(table, "vd_disconnect", { epoch: second });
    expect(() => call(table, "vd_get", CH1)).toThrow(/not-connected/);
  });

  // What a case overrides is what the unit REPORTS, and the bookkeeping is not part of
  // that. Written as a plain answer it used to replace the whole command: three cases then
  // drove a model switch whose every read was refused, by a table that was answering
  // correctly.
  it("keeps the connection when a case says what the unit reports", () => {
    const table = deviceCommands({ vd_connect: { model: "URX22", label: "URX22", firmware: "1.0.0.0", epoch: 0 } });
    const answer = call(table, "vd_connect") as { model: string; epoch: number };
    expect(answer.model).toBe("URX22");
    // The generation is the table's to assign, so the one written into the answer is
    // replaced rather than handed back. 0 is a value the counter never produces.
    expect(answer.epoch).not.toBe(0);
    expect(call(table, "vd_get", CH1)).toBe(0);
  });

  // Counted for the whole run rather than per table: a table restarting at 1 gives an app
  // a generation that a disconnect leaked from an EARLIER one matches, and that teardown
  // then closes a connection it never opened — every read after it refused, on a link the
  // case believes is up. The shell's own counter lives in the process (`vd.rs`), which a
  // page load does not restart either.
  it("does not restart the generation for a new table", () => {
    const first = (call(deviceCommands(), "vd_connect") as { epoch: number }).epoch;
    const second = (call(deviceCommands(), "vd_connect") as { epoch: number }).epoch;
    expect(second).toBeGreaterThan(first);
  });

  // …and a connect that FAILS installs nothing, which is what the cases stubbing a broken
  // link rest on.
  it("stays disconnected when the connect itself fails", () => {
    const table = deviceCommands({
      vd_connect: () => {
        throw new Error("no-device");
      },
    });
    expect(() => call(table, "vd_connect")).toThrow(/no-device/);
    expect(() => call(table, "vd_get", CH1)).toThrow(/not-connected/);
  });
});

describe("Fetch from device", () => {
  // The same rule for what a MIRROR wrote. While a pair is linked the insert FX travels
  // to the partner, bypass included — and if the partner's bypass already held the value
  // the mirror writes, that write moves nothing either. The partner then took the device's
  // OFF while the source kept ON, so one operator gesture left the pair disagreeing on a
  // key it had set once.
  it("keeps the partner's mirrored bypass while a read is in flight", SLOW, async () => {
    const shell = await bootDevice();
    selectNode("ch1");
    pickSignalType(1); // STEREO — the pair mirrors its insert FX in either PAN/BAL mode
    pickInsertFx(256);
    expect(insertFxOnFace()).toBe("ON");
    selectNode("ch2");
    expect(insertFxOnFace()).toBe("ON"); // the mirror carried it

    shell.answer("vd_get", () => new Promise((r) => setTimeout(() => r(0), 1)));
    $("btn-fetch").click();
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(5), { timeout: 10_000, interval: 5 });

    selectNode("ch1");
    pickInsertFx(COMPANDER_H);
    await invoked(shell, "vd_disconnect");

    selectNode("ch2");
    expect(insertFxSection()!.querySelector("select")!.value).toBe(String(COMPANDER_H));
    expect(insertFxOnFace()).toBe("ON");
  });

  // …and only what it wrote. In STEREO + PAN the BAL mirror does not run, so an insert-FX
  // selection carries three keys to the partner and asserts nothing else — registering the
  // partner's whole key set there would drop the device's answer for a key no mirror had
  // touched. The device holds this stub's default for CH 2's HPF (unwritten, so OFF) while
  // the plan says ON, which is the contest: the read's value has to win it.
  it("asserts only the keys the running mirror wrote", SLOW, async () => {
    const shell = await bootDevice();
    selectNode("ch1");
    pickSignalType(1); // STEREO — which lands the pair in BAL…
    pickPanBal(0); // …and PAN is where only the insert-FX mirror runs
    selectNode("ch2");
    paramRow("HPF").querySelector<HTMLButtonElement>("button.on")!.textContent === "ON" ||
      [...paramRow("HPF").querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "ON")!.click();
    expect(paramRow("HPF").querySelector("button.on")?.textContent).toBe("ON");

    selectNode("ch1");
    pickInsertFx(256);

    shell.answer("vd_get", () => new Promise((r) => setTimeout(() => r(0), 1)));
    $("btn-fetch").click();
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(5), { timeout: 10_000, interval: 5 });

    selectNode("ch1");
    pickInsertFx(COMPANDER_H);
    await invoked(shell, "vd_disconnect");

    selectNode("ch2");
    // The mirror's own three keys still stand…
    expect(insertFxOnFace()).toBe("ON");
    // …and the key it never touched took the device's value.
    expect(paramRow("HPF").querySelector("button.on")?.textContent).toBe("OFF");
  });

  // A pair transition is the case where NOTHING the gesture wrote has to move. Signal
  // Type clears the insert FX on both members — on a pair that carried none, that is
  // three deletions of keys already absent, so the plan reads identically before and
  // after and the read's own diff has nothing to tell it from a key nobody touched. The
  // device then re-selected an effect the operator had just told the unit to drop.
  it("keeps a Signal Type transition's insert-FX clear through a read in flight", SLOW, async () => {
    const shell = await bootDevice();
    selectNode("ch1");
    pickSignalType(1); // STEREO, with no effect selected on either member

    shell.answer(
      "vd_get",
      (a: Record<string, unknown>) =>
        new Promise((r) => setTimeout(() => r(a.paramId === PARAMS.INSERT_FX.id ? COMPANDER_H : 0), 1)),
    );
    $("btn-fetch").click();
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(5), { timeout: 10_000, interval: 5 });

    selectNode("ch1");
    pickSignalType(0); // MONO x2 — the transition clears the pair's insert FX
    await invoked(shell, "vd_disconnect");

    selectNode("ch1");
    expect(insertFxSection()!.querySelector("select")!.value).toBe("-1");
    selectNode("ch2");
    expect(insertFxSection()!.querySelector("select")!.value).toBe("-1");
  });

  // The same transition's other half, and the one that moves nothing by construction:
  // STEREO leaves the pair in BAL, whose pans are centred, and unlinking centres them —
  // so every send of both members is written the value it already holds, every time. The
  // plan is read through a save rather than the inspector because a channel's pan lives
  // on its send wire, and this asserts every send the pair carries rather than one row.
  it("keeps its pan centring too, on a transition that moved nothing", SLOW, async () => {
    const shell = await bootDevice(SAVES);
    selectNode("ch1");
    pickSignalType(1); // STEREO — lands in BAL, which centres both members' pans

    shell.answer(
      "vd_get",
      (a: Record<string, unknown>) =>
        new Promise((r) =>
          setTimeout(() => r(a.paramId === PARAMS.CH_PAN.id || a.paramId === PARAMS.SEND_PAN.id ? 63 : 0), 1),
        ),
    );
    $("btn-fetch").click();
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(5), { timeout: 10_000, interval: 5 });

    selectNode("ch1");
    pickSignalType(0); // MONO x2 — the transition centres the pair's pans (0 over 0)
    await invoked(shell, "vd_disconnect");

    const before = shell.count("write_text_file");
    $("btn-save").click();
    await vi.waitFor(() => expect(shell.count("write_text_file")).toBe(before + 1), { timeout: 10_000 });
    const saved = shell.args[shell.invokes.lastIndexOf("write_text_file")];
    const doc = JSON.parse(String((saved as { contents: string }).contents));
    const pans = (doc.connections as Array<Record<string, never>>)
      .filter((c) => String(c.from).startsWith("ch1:") && c.kind === "send")
      .map((c) => (c.params as { pan?: number } | undefined)?.pan ?? 0);
    expect(pans.length).toBeGreaterThan(0);
    expect(pans.every((p) => p === 0)).toBe(true);
  });

  // The write witness names what a funnel WROTE, not only what its write MOVED. Selecting
  // an insert effect over one that is already engaged writes `insertFxOn: true` again —
  // the value does not move, so the read's own diff cannot tell that key from one nobody
  // touched, and the device's value wins it. This stub answers every unwritten address 0,
  // so the unit's bypass reads OFF: the operator's new effect used to land selected and
  // muted, which is the failure the emit order elsewhere exists to prevent.
  it("keeps a bypass the operator's patch asserted while a read was in flight", SLOW, async () => {
    const shell = await bootDevice();
    selectNode("ch1");
    pickInsertFx(256); // Clean — an engaged effect to select over
    expect(insertFxOnFace()).toBe("ON");

    // One millisecond per read, so there is a mid-read window at all (see the latch case).
    shell.answer("vd_get", () => new Promise((r) => setTimeout(() => r(0), 1)));
    $("btn-fetch").click();
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(5), { timeout: 10_000, interval: 5 });

    // …and the operator picks a different effect while it runs.
    selectNode("ch1");
    pickInsertFx(COMPANDER_H);
    await invoked(shell, "vd_disconnect");

    selectNode("ch1");
    expect(insertFxSection()!.querySelector("select")!.value).toBe(String(COMPANDER_H));
    expect(insertFxOnFace()).toBe("ON");
  });

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

/**
 * What the app does when the unit on the link is not the model on screen.
 *
 * Write and compare REFUSE (pinned in "Write to device" below) — they act on the plan as
 * it stands. Fetch and Live sync instead OFFER to switch the UI to a fresh plan of the
 * device's model, and that offer has three answers, none of which was driven before.
 */
describe("the model the device turns out to be", () => {
  // A model this build carries no parameter map for is the arm that never raises the
  // dialog at all: there is nothing to switch to, so the read never starts.
  it("refuses to fetch from a model this build does not know, and reads nothing", SLOW, async () => {
    const shell = await bootDevice(connectAs("URX88"));
    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");

    // As a refusal, not as a question: the same words raised as a confirm would satisfy a
    // case that only looked at the text.
    expect(errors(shell)).toEqual([t().status.fetchError(t().error.unknownModel("URX88"))]);
    expect(confirms(shell)).toEqual([]);
    expect(shell.count("vd_get")).toBe(0);
    expect($<HTMLSelectElement>("model-picker").value).toBe("URX44V");
  });

  // Declining. The prompt has to be named: every stop in this flow lands on the same
  // "Canceled", and this case boots declining EVERY confirm, so without naming it the
  // case would stay green over a decline that landed somewhere else entirely.
  it("leaves the plan on screen alone when the offered switch is declined", SLOW, async () => {
    const shell = await bootDevice(connectAs("URX22"), false);
    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");

    expect(confirms(shell)).toEqual([t().confirm.switchModel("URX22", "URX44V")]);
    expect(statusText()).toBe(t().status.canceled);
    // What the decline left behind: the plan on screen unreplaced, and a sweep that never
    // started.
    expect(shell.count("vd_get")).toBe(0);
    expect($<HTMLSelectElement>("model-picker").value).toBe("URX44V");
  });

  // Taken, the offer has to actually switch — otherwise the read that follows maps the
  // device's channels onto the wrong ones, which is the whole reason the offer exists.
  // This is the arm that makes the declined case above mean something.
  it("switches to the device's model when the offer is taken, then reads it", SLOW, async () => {
    const shell = await bootDevice(connectAs("URX22"));
    $("btn-fetch").click();
    await invoked(shell, "vd_disconnect");

    // OFFERED, not assumed: this case boots agreeing to everything, so without naming the
    // prompt it stays green over a build that drops the confirm and switches outright.
    expect(confirms(shell)).toEqual([t().confirm.switchModel("URX22", "URX44V")]);
    expect($<HTMLSelectElement>("model-picker").value).toBe("URX22");
    expect(shell.count("vd_get")).toBeGreaterThan(50);
    // The whole frame: `fetchPartial` and `fetchedUnread` also name the model, so a read
    // that landed on either must not pass as a clean one.
    await vi.waitFor(
      () => expect(countFor(statusText(), (n) => t().status.fetchedDevice("URX22", n))).toBeGreaterThan(50),
      { timeout: 10_000 },
    );
  });

  // The same three answers on the Live-sync side, where they end differently: the unknown
  // model is a failure (a dialog) while the decline is user-neutral (the status line), and
  // both have to give the connection back.
  it("refuses a live session on a model this build does not know", SLOW, async () => {
    const shell = await bootDevice(connectAs("URX88"));
    $("btn-live").click();
    await invoked(shell, "vd_disconnect");

    expect(errors(shell)).toEqual([t().status.liveError(t().error.unknownModel("URX88"))]);
    expect(shell.count("vd_params_subscribe")).toBe(0);
    expect($("live-tally").hidden).toBe(true);
    // The link was handed back, not merely disconnected: the holder is what locks the
    // other device actions, and the disconnect above does not release it.
    expect($<HTMLButtonElement>("btn-fetch").disabled).toBe(false);
  });

  it("abandons a live session quietly when the offered switch is declined", SLOW, async () => {
    const shell = await bootDevice(connectAs("URX22"), false);
    $("btn-live").click();
    await invoked(shell, "vd_disconnect");

    expect(confirms(shell)).toEqual([t().confirm.switchModel("URX22", "URX44V")]);
    expect(errors(shell)).toEqual([]); // a decline is not a failure
    expect(statusText()).toBe(t().status.canceled);
    expect(shell.count("vd_params_subscribe")).toBe(0);
    // The link was handed back, not merely dropped: the next action can take it.
    expect($<HTMLButtonElement>("btn-fetch").disabled).toBe(false);
  });

  // Taken on the live path, which the fetch case is not a substitute for: here the
  // replacement plan is what `live.begin()` snapshots as device truth, so a switch that
  // half-happened would enshrine the wrong model for the session's whole duration.
  it("switches to the device's model when a live session offers it", SLOW, async () => {
    const shell = await bootDevice(connectAs("URX22"));
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-pressed")).toBe("true"), { timeout: 25_000 });

    expect(confirms(shell)).toEqual([t().confirm.switchModel("URX22", "URX44V")]);
    expect($<HTMLSelectElement>("model-picker").value).toBe("URX22");
    expect(countFor(statusText(), (n) => t().status.liveOn("URX22", n))).toBeGreaterThan(50);
    // Registered against the switched plan, so the session follows the model the unit
    // actually is rather than the one that was on screen.
    expect(shell.count("vd_params_subscribe")).toBe(1);
  });
});

describe("the live session", () => {
  // A re-registration that fails while the session is still STARTING.
  //
  // `live.begin()` runs before `follow.begin()`, so a structural edit can flush inside the
  // window where the first registration is still on the wire; that flush captures and asks
  // the follow layer to re-register, and the ask can be refused. `stopLiveOnError` returns
  // without doing anything while `liveSessionUp` is false, so the report is dropped — and
  // the lines that follow would go on to say "Live sync on" over a DeviceFollow that has
  // already stopped, with `onNotify` discarding every notify for the rest of the session.
  it("refuses to start a session whose follow stopped on the way up", SLOW, async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let calls = 0;
    const shell = await bootDevice({
      vd_params_subscribe: async () => {
        calls++;
        // The session's own registration is held open, not failed: what is under test is a
        // LATER refusal landing inside the start-up window.
        if (calls === 1) {
          await held;
          return null;
        }
        throw new Error("subscribe rejected");
      },
      // The last await before the session is declared up, stretched so the window this
      // case is about is wide enough to land in: the flush's ask runs as soon as the
      // registration it queued behind lands, and its refusal has to arrive while
      // `liveSessionUp` is still false for `stopLiveOnError` to be the one that drops it.
      vd_watch_link: async () => new Promise((r) => setTimeout(r, 2_000)),
    });

    $("btn-live").click();
    // Parked inside `follow.begin()`, which is after `live.begin()` — so the flush below
    // belongs to a live session that has not been declared up yet.
    await vi.waitFor(() => expect(calls).toBe(1), { timeout: 25_000 });

    // A converge param: its flush captures, and a flush that captured asks.
    selectNode("ch1");
    const type = row(t().inspector.compEqType).querySelector<HTMLSelectElement>("select")!;
    type.value = String(COMP_EQ_SSMCS);
    type.dispatchEvent(new Event("change", { bubbles: true }));
    // The ask is made at the END of the flush, and this flush carries a converge — some
    // 700 reads through the stub. Released before it gets there, the refusal lands after
    // the session is already up, which is a window the existing machinery already covers.
    // So: wait for the converge to stop reading, THEN release.
    await vi.waitFor(() => expect(shell.count("vd_set")).toBeGreaterThan(0), { timeout: 25_000 });
    let quiet = 0;
    let last = -1;
    await vi.waitFor(
      () => {
        const now = shell.count("vd_get");
        quiet = now === last ? quiet + 1 : 0;
        last = now;
        if (quiet < 5) throw new Error(`still reading (${now})`);
      },
      { timeout: 25_000, interval: 40 },
    );
    release();
    await vi.waitFor(() => expect(calls).toBeGreaterThan(1), { timeout: 25_000 });

    // The session is not up, and it said WHY — the follow's own refusal rather than any
    // failure the read path can raise, which is what separates this from a failed readback.
    await vi.waitFor(() => expect(errors(shell).length).toBeGreaterThan(0), { timeout: 25_000 });
    expect(errors(shell).some((e) => e.includes(t().error.liveFollowStopped))).toBe(true);
    expect(live().getAttribute("aria-pressed")).not.toBe("true");
  });

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

  // What a read that HELD values tells the operator, and what it does about them. The
  // race tier owns the re-send's addresses and their order; it uploads no coverage and
  // its trigger skips a documentation-only pull request, so both branches below were
  // reachable by nothing that reports on an ordinary one — and the status line is the
  // only place an installed build says any of this, the console not reaching it.
  //
  // Driven by putting the unit where the sample-rate excursion leaves it: a rate the
  // selected effect's ceiling forbids, and no effect selected, announced on the rate
  // address alone.
  const heldByExcursion = async (shell: TauriShell, link = false): Promise<void> => {
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-pressed")).toBe("true"), { timeout: 25_000 });
    // Selected through the session, so the unit holds it too: the hold is about a value
    // the app and the device agreed on until the rate moved. `link` puts the pair in
    // STEREO first, so the mirror carries the effect and BOTH members hold one — and it
    // has to happen after the session is up, since the session's own read would
    // otherwise take the link straight back off the unit.
    selectNode("ch1");
    if (link) pickSignalType(1);
    pickInsertFx(COMPANDER_H);
    await vi.waitFor(() => expect(insertFxWrites(shell)).toContain(COMPANDER_H), { timeout: 25_000 });
    // Settled before the excursion, so what the shell is asked afterwards belongs to the
    // reconcile alone: the session's own flush is still writing when that first selector
    // write lands, and a later write of the same address would otherwise read as the
    // send-back whether or not one was scheduled.
    await quiet(shell);
  };

  /** End the session before the case does. A follow read outlives one that merely ended,
   *  so a case that walks away from a live session leaves its teardown to fire after the
   *  shell is gone — which surfaces as an unhandled "not running under Tauri" rejection
   *  attributed to whichever file is running then. */
  const endLive = async (): Promise<void> => {
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-pressed")).toBe("false"), { timeout: 25_000 });
  };

  // `delayMs` stretches each read, for the case that has to end the session inside one.
  // `refuseY` refuses every read of one channel index, for the case that needs the read
  // to be partial as well as holding — CH 1 is y0, so a later index leaves the held
  // route's own addresses answering.
  // `linked` answers Signal Type STEREO throughout, which is what a read that was
  // answered on that address BEFORE a transition landed looks like — the stale half of
  // the race the announcement exists to settle.
  const notifyRate = (shell: TauriShell, { delayMs = 0, refuseY = -1, linked = false } = {}): void => {
    const answer = (a: Record<string, unknown>): number => {
      if (a.y === refuseY) throw new Error("read refused");
      if (linked && a.paramId === PARAMS.SIGNAL_TYPE.id) return 1;
      return a.paramId === PARAMS.SAMPLE_RATE.id
        ? 192_000
        : a.paramId === PARAMS.INSERT_FX.id
          ? denormalizeInsertFx(INSERT_FX_NONE)
          : 0;
    };
    shell.answer("vd_get", (a: Record<string, unknown>) =>
      delayMs ? new Promise((r) => setTimeout(() => r(answer(a)), delayMs)) : answer(a),
    );
    // Taken from the subscribe's own arguments rather than by position, so a second
    // channel opening beside it cannot silently redirect this.
    const at = shell.invokes.indexOf("vd_params_subscribe");
    const { channel } = shell.args[at] as { channel: { onmessage: (d: unknown) => void } };
    channel.onmessage([{ param_id: PARAMS.SAMPLE_RATE.id, x: 0, y: 0, value: 192_000 }]);
  };

  it("says how many values a reconcile kept, and sends them back", SLOW, async () => {
    const shell = await bootDevice();
    await heldByExcursion(shell);

    const written = insertFxWrites(shell).length;
    notifyRate(shell);

    // Two keys held on CH 1 — the selector and its bypass. The third the hold names,
    // the stored engine values, is not in the plan for an effect selected and not yet
    // tuned, and a key the read's patch never carried is not one it can keep.
    await vi.waitFor(() => expect(countFor(statusText(), (n) => t().status.liveHeld(n, 2))).not.toBeNaN(), {
      timeout: 25_000,
    });
    // …and the send-back really was scheduled, rather than only reported.
    await vi.waitFor(() => expect(insertFxWrites(shell).length).toBeGreaterThan(written), { timeout: 25_000 });
    expect(insertFxWrites(shell).at(-1)).toBe(COMPANDER_H);
    await endLive();
  });

  it("claims no send-back when the session ended under the read", SLOW, async () => {
    const shell = await bootDevice();
    await heldByExcursion(shell);

    // One millisecond per read, so the reconcile is long enough to end the session
    // inside it. A follow read outlives a session that merely ended, so it still
    // reaches the hold — with nothing left to flush through.
    const reads = shell.count("vd_get");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    notifyRate(shell, { delayMs: 1 });

    try {
      const written = insertFxWrites(shell).length;
      // Past the settle debounce and INTO the reconcile: the session start has already
      // read the whole unit, so a bare `count > 5` is satisfied before the notify's
      // read exists and the click below would cancel the settle instead of racing it.
      await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(reads + 5), {
        timeout: 25_000,
        interval: 5,
      });
      $("btn-live").click();
      await vi.waitFor(() => expect(live().getAttribute("aria-pressed")).toBe("false"), { timeout: 25_000 });

      await vi.waitFor(
        () =>
          expect(
            warn.mock.calls.some((c) => String(c[0]).includes("no session left to send the held values back through")),
          ).toBe(true),
        { timeout: 25_000 },
      );
      // The positive control is the case above, which takes this same path with the
      // session up and DOES write: an absence here is the session and not the setup.
      expect(insertFxWrites(shell).length).toBe(written);
      expect(countFor(statusText(), (n) => t().status.liveHeld(n, 2))).toBeNaN();
      // And the branch above is reachable at all because the LINK outlived the read: the
      // release waits for a follow read still doing round trips (releaseLive). Without the
      // wait the read dies at its next one, on a link taken out from under it — the same
      // half-filled document abandoning it would have left, reported nowhere, since the
      // session is already down and stopLiveOnError returns on that.
      expect(shell.invokes.lastIndexOf("vd_disconnect")).toBeGreaterThan(shell.invokes.lastIndexOf("vd_get"));
    } finally {
      warn.mockRestore();
    }
  });

  // The other cause of the same cleared values, told apart by the notify stream rather
  // than by the read's own values — which come from different moments and cannot answer
  // it. Here the unit announces the selector itself while the read runs, so the clearing
  // is the announcement's to explain and the plan adopts it.
  it("adopts a clearing the unit announced while the read was running", SLOW, async () => {
    const shell = await bootDevice();
    await heldByExcursion(shell);

    const written = insertFxWrites(shell).length;
    const reads = shell.count("vd_get");
    notifyRate(shell, { delayMs: 1 });
    const at = shell.invokes.indexOf("vd_params_subscribe");
    const { channel } = shell.args[at] as { channel: { onmessage: (d: unknown) => void } };
    // INSIDE the read the rate notify escalated to, on CH 1's own selector. Waited for
    // past the count the session start left behind: a bare `> 5` is satisfied before the
    // settle debounce has fired, and the announcement would then arrive ahead of the read
    // it has to fall inside.
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(reads + 5), {
      timeout: 25_000,
      interval: 5,
    });
    channel.onmessage([{ param_id: PARAMS.INSERT_FX.id, x: 0, y: 0, value: denormalizeInsertFx(INSERT_FX_NONE) }]);

    // The ordinary followed line, not the held one — and nothing sent back.
    await vi.waitFor(() => expect(countFor(statusText(), (n) => t().status.liveFollowed(n))).not.toBeNaN(), {
      timeout: 25_000,
    });
    expect(countFor(statusText(), (n) => t().status.liveHeld(n, 2))).toBeNaN();
    expect(insertFxWrites(shell).length).toBe(written);
    await endLive();
  });

  // The excursion can be over before the read asks for the rate: 48 → 96 → 48 leaves the
  // read holding a rate the effect runs at, and the cleared values then read exactly like
  // an operator's own No Effect. What says otherwise is the rate notify that escalated to
  // the read — which arrives BEFORE it starts, so the rate history is not sliced to the
  // read's own window the way the insert-FX announcements are.
  it("keeps an effect through a rate excursion that was over before the read asked", SLOW, async () => {
    const shell = await bootDevice();
    await heldByExcursion(shell);

    const written = insertFxWrites(shell).length;
    const at = shell.invokes.indexOf("vd_params_subscribe");
    const { channel } = shell.args[at] as { channel: { onmessage: (d: unknown) => void } };
    // The unit went up past the effect's ceiling and came straight back, so every address
    // the read asks for — the rate included — answers as if nothing had happened.
    shell.answer("vd_get", (a: Record<string, unknown>) =>
      a.paramId === PARAMS.SAMPLE_RATE.id
        ? 48_000
        : a.paramId === PARAMS.INSERT_FX.id
          ? denormalizeInsertFx(INSERT_FX_NONE)
          : 0,
    );
    channel.onmessage([
      { param_id: PARAMS.SAMPLE_RATE.id, x: 0, y: 0, value: 192_000 },
      { param_id: PARAMS.SAMPLE_RATE.id, x: 0, y: 0, value: 48_000 },
    ]);

    await vi.waitFor(() => expect(countFor(statusText(), (n) => t().status.liveHeld(n, 2))).not.toBeNaN(), {
      timeout: 25_000,
    });
    await vi.waitFor(() => expect(insertFxWrites(shell).length).toBeGreaterThan(written), { timeout: 25_000 });
    expect(insertFxWrites(shell).at(-1)).toBe(COMPANDER_H);
    await endLive();
  });

  // Reconciles run one at a time, so a scoped read for ANOTHER node can sit between the
  // rate notify and the full read it escalates to. Clearing the rate history on whichever
  // read finished first took the announcement out from under the read it was for, and the
  // full read then saw only the rate the unit had already come back to.
  it("keeps the rate history across a scoped read that established none", SLOW, async () => {
    const shell = await bootDevice();
    await heldByExcursion(shell);

    const written = insertFxWrites(shell).length;
    // Slow enough that the rate notify below lands INSIDE the scoped read.
    shell.answer("vd_get", (a: Record<string, unknown>) => {
      const v =
        a.paramId === PARAMS.SAMPLE_RATE.id
          ? 48_000
          : a.paramId === PARAMS.INSERT_FX.id
            ? denormalizeInsertFx(INSERT_FX_NONE)
            : 0;
      return new Promise((r) => setTimeout(() => r(v), 5));
    });
    const at = shell.invokes.indexOf("vd_params_subscribe");
    const { channel } = shell.args[at] as { channel: { onmessage: (d: unknown) => void } };

    // A CH 3 parameter the unit moved: no owner-less address, so this settles into a
    // SCOPED read, which never asks for the rate.
    const reads = shell.count("vd_get");
    channel.onmessage([{ param_id: PARAMS.HPF_ON.id, x: 0, y: 2, value: 1 }]);
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(reads + 3), {
      timeout: 25_000,
      interval: 2,
    });
    // …and the excursion, announced while that read is still running.
    channel.onmessage([
      { param_id: PARAMS.SAMPLE_RATE.id, x: 0, y: 0, value: 192_000 },
      { param_id: PARAMS.SAMPLE_RATE.id, x: 0, y: 0, value: 48_000 },
    ]);

    await vi.waitFor(() => expect(countFor(statusText(), (n) => t().status.liveHeld(n, 2))).not.toBeNaN(), {
      timeout: 25_000,
    });
    await vi.waitFor(() => expect(insertFxWrites(shell).length).toBeGreaterThan(written), { timeout: 25_000 });
    await endLive();
  });

  // The read that CONSUMES the rate history is not always the read that was running when
  // the announcement arrived. A full read already in flight reads the selector before the
  // unit clears it, so it holds nothing — and clearing the whole history on its way out
  // takes the announcement away from the replay it scheduled, which is the read that sees
  // the cleared selector.
  it("leaves the announcement for the replay a read in flight scheduled", SLOW, async () => {
    const shell = await bootDevice();
    await heldByExcursion(shell);

    const written = insertFxWrites(shell).length;
    // CH 1's selector answers as it stood for the FIRST read that asks, and cleared for
    // every one after — so the read already in flight sees it standing (and holds
    // nothing) while the replay behind it is the first to see it gone. Counted rather
    // than timed: which read of a 700-address sweep reaches CH 1 is not a clock.
    let asked = 0;
    shell.answer("vd_get", (a: Record<string, unknown>) => {
      const v =
        a.paramId === PARAMS.SAMPLE_RATE.id
          ? 48_000
          : a.paramId === PARAMS.INSERT_FX.id && a.y === 0
            ? asked++ === 0
              ? COMPANDER_H
              : denormalizeInsertFx(INSERT_FX_NONE)
            : 0;
      return new Promise((r) => setTimeout(() => r(v), 2));
    });
    const at = shell.invokes.indexOf("vd_params_subscribe");
    const { channel } = shell.args[at] as { channel: { onmessage: (d: unknown) => void } };

    // An address in no index forces a FULL read, without touching the rate history.
    channel.onmessage([{ param_id: 9_999, x: 0, y: 0, value: 1 }]);
    // Past CH 1's own selector, which this read has now taken as standing.
    await vi.waitFor(() => expect(asked).toBeGreaterThan(0), { timeout: 25_000, interval: 2 });
    // The excursion lands inside it and schedules the replay.
    channel.onmessage([
      { param_id: PARAMS.SAMPLE_RATE.id, x: 0, y: 0, value: 192_000 },
      { param_id: PARAMS.SAMPLE_RATE.id, x: 0, y: 0, value: 48_000 },
    ]);

    // …and the replay behind it, which is the first read to see the cleared selector.
    await vi.waitFor(() => expect(countFor(statusText(), (n) => t().status.liveHeld(n, 2))).not.toBeNaN(), {
      timeout: 25_000,
    });
    await vi.waitFor(() => expect(insertFxWrites(shell).length).toBeGreaterThan(written), { timeout: 25_000 });
    await endLive();
  });

  // …and the read it was for CONSUMES it. What the announcement must not do is outlive
  // that read: the next clearing is the operator's own, made by hand on the unit at a
  // rate that runs the effect, and holding it against a rate the unit left long before
  // overrides them. (Their clearing IS announced on the insert-FX addresses, but that
  // announcement arrives BEFORE the read it escalates to, so it falls outside the window
  // `announced` covers — the rate history is what decides it.)
  it("adopts the operator's own clearing once the announcement has been consumed", SLOW, async () => {
    const shell = await bootDevice();
    await heldByExcursion(shell);

    let cleared = false;
    shell.answer("vd_get", (a: Record<string, unknown>) => {
      const v =
        a.paramId === PARAMS.SAMPLE_RATE.id
          ? 48_000
          : a.paramId === PARAMS.INSERT_FX.id && a.y === 0 && cleared
            ? denormalizeInsertFx(INSERT_FX_NONE)
            : a.paramId === PARAMS.INSERT_FX.id && a.y === 0
              ? COMPANDER_H
              : 0;
      return new Promise((r) => setTimeout(() => r(v), 1));
    });
    const at = shell.invokes.indexOf("vd_params_subscribe");
    const { channel } = shell.args[at] as { channel: { onmessage: (d: unknown) => void } };

    // The excursion, held and re-sent by the full read it escalates to.
    cleared = true;
    channel.onmessage([
      { param_id: PARAMS.SAMPLE_RATE.id, x: 0, y: 0, value: 192_000 },
      { param_id: PARAMS.SAMPLE_RATE.id, x: 0, y: 0, value: 48_000 },
    ]);
    await vi.waitFor(() => expect(countFor(statusText(), (n) => t().status.liveHeld(n, 2))).not.toBeNaN(), {
      timeout: 25_000,
    });
    await quiet(shell);

    // Now the operator clears it by hand, at a rate that runs it. The unit announces the
    // selector, which settles into a scoped read of CH 1.
    channel.onmessage([{ param_id: PARAMS.INSERT_FX.id, x: 0, y: 0, value: denormalizeInsertFx(INSERT_FX_NONE) }]);
    await vi.waitFor(() => expect(countFor(statusText(), (n) => t().status.liveFollowed(n))).not.toBeNaN(), {
      timeout: 25_000,
    });
    expect(countFor(statusText(), (n) => t().status.liveHeld(n, 2))).toBeNaN();
    await endLive();
  });

  // …and it consumes it however much else is open. A side-effect refetch is a follow read
  // that establishes no rate of its own, so it never consumes one; gating the consumption
  // on an empty in-flight set therefore left the announcement standing after the read it
  // belonged to had finished with it, and the hand clearing above was then held against a
  // rate the unit had left long before. Ownership is the sequence an announcement arrived
  // at, not a count of what else is running — which is what this case measures and the one
  // above cannot, nothing else being open there.
  it("consumes the announcement with a side-effect refetch still open", SLOW, async () => {
    const shell = await bootDevice();
    await heldByExcursion(shell);

    // The EQ 1-Knob is a `sideEffect: "refetch"` write: its flush reads the owner node
    // back through the same follow-read path, which is the second read this case needs.
    selectNode("ch1");
    $("inspector").querySelector<HTMLButtonElement>("#btn-eq-screen")!.click();

    // What the unit answers for CH 1's selector, moved by hand: the stub's own
    // write-then-read store is replaced below, so the excursion and the re-send it
    // provokes are stated here instead of inferred from what was written.
    let unitInsertFx = COMPANDER_H;
    // Park every read from here, so the refetch opens and cannot finish. Parked rather
    // than merely slow: the full read below has to finish INSIDE it, and a delay long
    // enough to be sure of that is one every read of a whole-device sweep would spend.
    const parked: Array<(v: number) => void> = [];
    shell.answer("vd_get", () => new Promise<number>((r) => parked.push(r)));
    $("dyn-screen-box")
      .querySelector<HTMLElement>("#dyn-oneknob-level")!
      .closest(".prefs-section")!
      .querySelector<HTMLButtonElement>(".prefs-toggle button")!
      .click();
    await vi.waitFor(() => expect(parked.length).toBeGreaterThan(0), { timeout: 25_000 });

    // The excursion lands while it is parked, and answers at once — a NEW answer, so the
    // refetch's own parked read stays parked while the read below runs to the end.
    unitInsertFx = denormalizeInsertFx(INSERT_FX_NONE);
    shell.answer("vd_get", (a: Record<string, unknown>) => {
      const v =
        a.paramId === PARAMS.SAMPLE_RATE.id
          ? 48_000
          : a.paramId === PARAMS.INSERT_FX.id && a.y === 0
            ? unitInsertFx
            : 0;
      return new Promise((r) => setTimeout(() => r(v), 1));
    });
    notifyChannel(shell).onmessage([
      { param_id: PARAMS.SAMPLE_RATE.id, x: 0, y: 0, value: 192_000 },
      { param_id: PARAMS.SAMPLE_RATE.id, x: 0, y: 0, value: 48_000 },
    ]);
    await vi.waitFor(() => expect(countFor(statusText(), (n) => t().status.liveHeld(n, 2))).not.toBeNaN(), {
      timeout: 25_000,
    });
    // The arrangement itself, asserted rather than assumed: the read that decided from
    // the announcement has finished and the refetch has NOT. Without this the case would
    // pass on the two never overlapping at all.
    expect(parked.length).toBeGreaterThan(0);

    // The re-send put the effect back on the unit, so nothing that reads CH 1 from here
    // has a clearing of its own to decide about — including the replay the escalation
    // schedules behind the read above, which runs while the refetch is still parked.
    unitInsertFx = COMPANDER_H;
    await quiet(shell);

    // Now the operator clears it by hand, at a rate that runs it — adopted, because the
    // read that decided from the announcement consumed it on the way out. The refetch is
    // STILL parked, so no read has yet ended with nothing else open: an in-flight count
    // would have left every announcement standing and held this clearing.
    expect(parked.length).toBeGreaterThan(0);
    unitInsertFx = denormalizeInsertFx(INSERT_FX_NONE);
    notifyChannel(shell).onmessage([
      { param_id: PARAMS.INSERT_FX.id, x: 0, y: 0, value: denormalizeInsertFx(INSERT_FX_NONE) },
    ]);
    // Settled rather than waited for the followed line: a held clearing prints the other
    // line and re-sends, so waiting for this one would report the difference as a bare
    // timeout with the status it did print nowhere in the failure.
    await quiet(shell);
    expect(countFor(statusText(), (n) => t().status.liveHeld(n, 2))).toBeNaN();
    expect(countFor(statusText(), (n) => t().status.liveFollowed(n))).not.toBeNaN();

    for (const answer of parked.splice(0)) answer(0);
    await quiet(shell);
    await endLive();
  });

  // The Signal Type transition is announced on the PAIR's primary and clears the effect
  // on both members (measured), so recording the announcement without its partner leaves
  // the other half of the pair held and re-sent — half a clearing undone.
  it("carries a pair-level announcement to the partner as well", SLOW, async () => {
    const shell = await bootDevice();
    await heldByExcursion(shell, true); // STEREO: the mirror gives both members the effect

    const written = insertFxWrites(shell).length;
    const reads = shell.count("vd_get");
    // The read keeps answering STEREO, so it is the stale half of the race: the pair's
    // Signal Type is read before the selector, and a transition in that gap leaves the
    // predicate comparing two equal values. Only the announcement says what happened.
    notifyRate(shell, { delayMs: 1, linked: true });
    const at = shell.invokes.indexOf("vd_params_subscribe");
    const { channel } = shell.args[at] as { channel: { onmessage: (d: unknown) => void } };
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(reads + 5), {
      timeout: 25_000,
      interval: 5,
    });
    // The pair-level address, at the primary's index alone — which is the only index the
    // unit announces it on.
    channel.onmessage([{ param_id: PARAMS.SIGNAL_TYPE.id, x: 0, y: 0, value: 0 }]);

    await vi.waitFor(() => expect(countFor(statusText(), (n) => t().status.liveFollowed(n))).not.toBeNaN(), {
      timeout: 25_000,
    });
    // Neither member held: a partner left out would show as its own two kept keys.
    expect(countFor(statusText(), (n) => t().status.liveHeld(n, 2))).toBeNaN();
    expect(insertFxWrites(shell).length).toBe(written);
    await endLive();
  });

  // And when the read is partial as well, the count travels with the teardown's own
  // message rather than the status line: that line is about to be replaced by the one
  // stopLiveOnError writes, and the console does not reach an installed build.
  it("names the values it kept inside the failure a partial read raises", SLOW, async () => {
    const shell = await bootDevice();
    await heldByExcursion(shell);

    notifyRate(shell, { refuseY: 3 }); // CH 4's reads refused; CH 1, which holds, is y0

    await vi.waitFor(() => expect(errors(shell).length).toBeGreaterThan(0), { timeout: 25_000 });
    // The same two keys the case above counts, inside the cause rather than beside it.
    expect(
      countFor(errors(shell).at(-1) ?? "", (n) =>
        t().status.liveError(t().error.followReadHeld(t().error.followReadIncomplete(n), 2)),
      ),
    ).not.toBeNaN();
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

  // The failure that lands PAST the point of no return. `live.begin()` flips the sync on
  // before the two awaited registrations, so a throw from either leaves a session that is
  // half up: sync active, `liveSessionUp` still false. Tearing only the connection down
  // there leaves `live.isActive()` true, and every later click routes into
  // deactivateLive's early return — a toggle that does nothing for the rest of the launch.
  //
  // The second click is therefore the case, not a coda to it: the teardown is only
  // observable as the session that follows it. `failOnce` is what lets that second click
  // succeed, so a dead toggle fails here rather than timing out against a shell that
  // refuses everything.
  it("tears a half-started session down, and leaves the toggle live", SLOW, async () => {
    const shell = await bootDevice();
    shell.failOnce("vd_watch_link", new Error("watch-refused"));
    $("btn-live").click();

    // follow.begin() had already registered; failLive is what gives that back. That is the
    // FIRST of its four steps and the dialog is the last, so the disconnect between them
    // is what the assertions wait on rather than a dialog three steps past the wait.
    await vi.waitFor(() => expect(shell.count("vd_params_unsubscribe")).toBe(1), { timeout: 25_000 });
    await invoked(shell, "vd_disconnect");
    expect(errors(shell)).toEqual([t().status.liveError("watch-refused")]);
    expect(live().getAttribute("aria-pressed")).toBe("false");
    expect($("live-tally").hidden).toBe(true);

    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-pressed")).toBe("true"), { timeout: 25_000 });
    expect(shell.count("vd_params_subscribe")).toBe(2);
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

  // A rename made on the unit itself arrives on the string path, and this is the only
  // place the app's own `applyName` runs: follow.test.ts stubs the hook, and the race
  // harness reads the canvas label, which is trimmed on the way out and reads the same
  // whatever the plan holds.
  //
  // It is normalized like a name typed into the app — cut to the bound, and THEN
  // stripped of trailing padding. The order is the half this pins: a name whose eighth
  // character is a space has nothing to trim before the cut, so trimming first leaves
  // one in the plan, and a plan name carrying a trailing space is re-sent on every sync
  // (the unit stores it, every read trims it off, and the two never match).
  //
  // The wire is what makes such a name reachable at all: the unit's own name screen
  // takes 8 characters, but a 20-character name is storable and reads back whole
  // (measured on a URX44V), so a longer one gets here from another client.
  //
  // Read off the inspector, which shows the plan's own string.
  it("normalizes a rename arriving from the unit, its padding as well as its length", SLOW, async () => {
    const shell = await bootDevice();
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-pressed")).toBe("true"), { timeout: 25_000 });

    const nc = nameControl(getModel("URX44V"), "ch1")!;
    notifyChannel(shell).onmessage([{ param_id: nc.param, x: 0, y: 0, value: 0, value_str: "1234567  9" }]);

    // Asserted immediately, and deliberately not awaited: the notify is delivered and
    // applied synchronously, while the idle net a followed change arms fires a full
    // reconcile 900 ms later — and this stub never took the write, so that sweep reads
    // the name back as empty and clears it. A `waitFor` here would therefore report an
    // empty field for a name that had arrived correctly, and would let a wrong value be
    // polled away instead of failing.
    selectNode("ch1");
    expect($("inspector").querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe("1234567");
  });

  // The other route a rename made on the unit takes, and the one the app has to ASK
  // for: a device-side change reconciles the node it touched, and that read covers the
  // node's name. It is what carries a rename the app was never told about — a notify
  // that did not arrive, or a change made on the unit's own screen in a way that emits
  // none — and the whole-device idle sweep behind it carries the same thing.
  //
  // Pinned HERE, at the entry, because the skip that removed it is a decision about
  // WHICH CALLER is reading. readback.test.ts had a case for it and stayed green: it
  // stood in for the reconcile by calling with no pending writes, which is what the
  // reconcile used to do — and then the reconcile started carrying them, the skip was
  // inferred from exactly that, and names stopped being read by either reconcile with
  // nothing in this repository disagreeing. Only the race harness's group count saw it.
  //
  // The name has to appear AFTER the session's starting read, or the starting read
  // would be what put it in the plan and this would pass with the reconcile removed.
  // Eight characters, so what lands is the name rather than the clip — the bound is
  // the unit's own name screen, and a longer one comes back cut (pinned above).
  it("reads a name off the unit in the reconcile a device-side change triggers", SLOW, async () => {
    const nc = nameControl(getModel("URX44V"), "ch1")!;
    let renamedOnUnit = false;
    const shell = await bootDevice({
      vd_get_str: (a: Record<string, unknown>) =>
        renamedOnUnit && a.paramId === nc.param && a.y === 0 ? "UnitName" : "",
    });
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-pressed")).toBe("true"), { timeout: 25_000 });

    renamedOnUnit = true;
    // A scoped (non-direct) parameter: its notify is not applied on its own, it makes
    // the follow re-read the node — which is the read under test.
    notifyChannel(shell).onmessage([{ param_id: PARAMS.HPF_FREQ.id, x: 0, y: 0, value: 40 }]);

    selectNode("ch1");
    await vi.waitFor(
      () => {
        selectNode("ch1"); // the reconcile re-renders; re-select so the field is current
        expect($("inspector").querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe("UnitName");
      },
      { timeout: 25_000, interval: 50 },
    );
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

  // param 839 counts stereo PAIRS, so 8 is 16 tracks — the full recorder. The seed table
  // keys on the stub's own address form, "id/x/y".
  const TRACK_COUNT_SEED = "839/0/0";
  const TRACK_COUNT_ADDR = "839:0:0";

  /** Put the plan on `rate` through the picker, the way the operator does. */
  const chooseRate = (rate: number): void => {
    const picker = $<HTMLSelectElement>("rate-picker");
    picker.value = String(rate);
    picker.dispatchEvent(new Event("change"));
  };

  // The unit lowers its own Track Count to fit a rate it cannot carry and nothing the app
  // can write raises it again, so this is the one rate side effect that has to be in front
  // of the decision. 16 tracks at 96 kHz becomes 8.
  it("names what a rate change costs the recorder, before writing it", SLOW, async () => {
    const shell = await bootDevice({}, false, { [TRACK_COUNT_SEED]: 8 });
    chooseRate(96_000);
    $("btn-write").click();
    // The flow's own terminal command, not a sleep: a case that returns while the write is
    // still unwinding leaves an app running against a shell the next case replaces, and
    // its writes then land on that one's counter.
    await invoked(shell, "vd_disconnect");
    const asked = confirms(shell).at(-1) ?? "";
    // Both halves: the rate question it was already asking, and the cost it was not.
    expect(asked).toContain(t().confirm.reclock(formatRate(0), formatRate(96_000)));
    expect(asked).toContain(t().confirm.trackCountDrop(16, 8));
    expect(shell.count("vd_set")).toBe(0);
  });

  // The other half of the same rule, and the one that keeps the warning worth reading: a
  // count the new rate can already carry loses nothing, and saying so anyway puts an
  // irreversible-loss notice in front of someone losing nothing.
  it("says nothing about the recorder when the count already fits the new rate", SLOW, async () => {
    const shell = await bootDevice({}, false, { [TRACK_COUNT_SEED]: 4 }); // 8 tracks
    chooseRate(96_000);
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    const asked = confirms(shell).at(-1) ?? "";
    expect(asked).toContain(t().confirm.reclock(formatRate(0), formatRate(96_000)));
    expect(asked).not.toContain("Track Count");
    expect(shell.count("vd_set")).toBe(0);
  });

  // The read is worth nothing until something redraws. The plan taking the unit's value
  // is not the same as the operator seeing it: the follow queue this tail used to call
  // drains a dirty-node set the tail never fills, so it repainted nothing and the panel
  // went on showing the count from before the write until some other selection rebuilt it.
  it("shows the recorder's re-read count without any further interaction", SLOW, async () => {
    // The unit holds the full 16 tracks (839 counts stereo pairs), which 96 kHz cannot
    // carry — so the write earns a re-read. The plan is put on 4, so what the read brings
    // back differs from what the panel is showing and the difference is visible.
    const shell = await bootDevice({}, true, { [TRACK_COUNT_SEED]: 8 });
    selectNode("out.sdrec");
    const menu = row(t().inspector.sdRecTrackCount).querySelector<HTMLSelectElement>("select")!;
    // Driven the way the operator does — through the app's own change handler — rather
    // than by assigning the plan, so the case measures the surface it is about.
    menu.value = "4";
    menu.dispatchEvent(new Event("change", { bubbles: true }));
    expect(menu.value).toBe("4");

    const beforeSlots = $("graph-host").querySelectorAll('g.node[data-id^="out.sdrec.t"]').length;
    chooseRate(96_000);
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");

    // The SAME element, re-read from the document: no reselection, no other gesture.
    const after = row(t().inspector.sdRecTrackCount).querySelector<HTMLSelectElement>("select")!;
    expect(after.value).toBe("16");
    // And the board followed too, which is why this needs a render rather than a node
    // repaint: the count decides how many recorder slots are drawn as active, so the
    // graph carries the slot nodes the new count reaches.
    const slots = $("graph-host").querySelectorAll('g.node[data-id^="out.sdrec.t"]');
    // The exact counts, not "more than none": the board draws two recorder slot nodes for
    // the count the panel was showing and four for the one the read brought back, and a
    // lower bound of zero passes on either — so it says nothing about the render this
    // needs, and the Inspector's own assertion above would carry the case alone.
    expect(beforeSlots).toBe(2);
    expect(slots.length).toBe(4);
  });

  // Cancelling BETWEEN two sends is not the same as cancelling before the first. The rate
  // goes out first, and `sendCommands` detects the abort at the top of the NEXT iteration
  // and throws — taking every outcome collected so far with it. A flag armed from the
  // returned outcomes is therefore never set, and the recorder the unit has just lowered
  // is never re-read.
  it("re-reads the recorder when the write is cancelled right after the rate lands", SLOW, async () => {
    const shell = await bootDevice({}, true, { [TRACK_COUNT_SEED]: 8 });
    chooseRate(96_000);
    // Cancel the moment the rate is acked: clicking the write button again aborts it.
    shell.answer("vd_set", (a: Record<string, unknown>) => {
      if (Number(a.paramId) === 766) queueMicrotask(() => $("btn-write").click());
      return null;
    });
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");

    const lastSet = shell.invokes.lastIndexOf("vd_set");
    const readAfter = shell.invokes.some((cmd, i) => {
      if (i <= lastSet || cmd !== "vd_get") return false;
      const a = shell.args[i] ?? {};
      return `${a.paramId}:${a.x}:${a.y}` === TRACK_COUNT_ADDR;
    });
    expect(readAfter).toBe(true);
  });

  // The unit does the lowering itself, so the plan is stale the moment the write lands.
  // Whether the unit ANNOUNCES it is not something this project has measured, so the read
  // is unconditional rather than left to a notify that may never arrive.
  it("re-reads the recorder's Track Count after a rate change that lowers it", SLOW, async () => {
    const shell = await bootDevice({}, true, { [TRACK_COUNT_SEED]: 8 });
    chooseRate(96_000);
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    expect(shell.count("vd_set")).toBeGreaterThan(10);
    // AFTER the last write, which is the only reading that separates this from the write's
    // own diff: the diff reads 839 too, so counting reads of the address passes whether or
    // not the epilogue runs at all.
    const lastSet = shell.invokes.lastIndexOf("vd_set");
    expect(lastSet).toBeGreaterThan(-1);
    const readAfterWrite = shell.invokes.some((cmd, i) => {
      if (i <= lastSet || cmd !== "vd_get") return false;
      const a = shell.args[i] ?? {};
      return `${a.paramId}:${a.x}:${a.y}` === TRACK_COUNT_ADDR;
    });
    expect(readAfterWrite).toBe(true);
  });

  /** A device table whose recorder re-read the case drives itself. The write's own
   *  pre-flight and diff read 839 too, both before anything is written, and Track Count is
   *  never emitted (translate.ts) so no converge round re-reads it — which is what makes
   *  "a read of 839 once something has been written" the epilogue's read and no other. */
  const epilogueRead = (over: (a: Record<string, unknown>, base: () => number) => unknown): Record<string, unknown> => {
    const table = deviceCommands({ "plugin:dialog|message": "Ok" }, { [TRACK_COUNT_SEED]: 8 });
    const baseGet = table.vd_get as (a: Record<string, unknown>) => number;
    const baseSet = table.vd_set as (a: Record<string, unknown>) => void;
    let written = false;
    table.vd_set = (a: Record<string, unknown>) => {
      written = true;
      return baseSet(a);
    };
    table.vd_get = (a: Record<string, unknown>) =>
      written && Number(a.paramId) === 839 ? over(a, () => baseGet(a)) : baseGet(a);
    return table;
  };

  // A read that failed is not a write that succeeded. Reported rather than thrown on: the
  // throw would leave withDevice saying the WRITE failed, and it did not — it is on the
  // unit, and the operator would go looking for it.
  it("reports a recorder re-read that failed, without calling the write failed", SLOW, async () => {
    const shell = (await bootApp({
      tauri: epilogueRead(() => {
        throw new Error("device-lost");
      }),
    }))!;
    chooseRate(96_000);
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");

    // The write itself went out — without this the case would pass over a build that
    // failed before sending anything, which is the state the message denies.
    expect(shell.count("vd_set")).toBeGreaterThan(10);
    expect(errors(shell)).toContain(t().error.trackCountReread(t().error.shell.deviceLost));
  });

  // What the re-read does to the undo history. The tail spells it absorb(), not rebase():
  // rebase drops any entry still OPEN, so an edit the operator started while the read ran
  // would come back un-undoable. Held open by a press rather than by racing the idle
  // backstop — history.ts does not arm it while a pointer is down — so the entry is open
  // when the read lands however long the read takes.
  it("leaves an edit made while the recorder was being re-read undoable", SLOW, async () => {
    let issued = (): void => {};
    const reading = new Promise<void>((r) => (issued = r));
    let release = (): void => {};
    const held = new Promise<void>((r) => (release = r));
    const shell = (await bootApp({
      tauri: epilogueRead((_a, base) => {
        issued();
        return held.then(base);
      }),
    }))!;
    chooseRate(96_000);
    $("btn-write").click();
    await reading;

    // A node the epilogue read does not touch: it reads out.sdrec alone, so an edit
    // anywhere else is undone by the history or by nothing.
    window.dispatchEvent(new Event("pointerdown"));
    selectNode("bus.osc");
    const btns = [...paramRow(t().inspector.oscOn).querySelectorAll<HTMLButtonElement>("button")];
    (btns.find((b) => b.textContent === "ON") ?? btns[0]).click();
    expect(paramRow(t().inspector.oscOn).querySelector("button.on")?.textContent).toBe("ON");
    release();
    await invoked(shell, "vd_disconnect");

    // End the gesture, then undo it. The commit is deferred one macrotask (click is
    // dispatched after pointerup), so the undo has to come after that.
    window.dispatchEvent(new Event("pointerup"));
    await new Promise((r) => setTimeout(r, 0));
    expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID)).toBe(1);
    await vi.waitFor(() => expect(paramRow(t().inspector.oscOn).querySelector("button.on")?.textContent).toBe("OFF"), {
      timeout: 10_000,
    });
    // …and the count the device authored stayed: it went into the baseline rather than
    // into the entry, so the undo does not take it back with the edit.
    selectNode("out.sdrec");
    expect(row(t().inspector.sdRecTrackCount).querySelector<HTMLSelectElement>("select")!.value).toBe("16");
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

  // The plan format's silence, held at the only place it can actually be measured: the
  // commands that reach a unit. The skill instructs a plan author to omit `fxEffect` when the
  // user did not ask to change the effect, and promises the unit keeps its FX. Emitting
  // defaults for an undescribed channel instead resets it from a document that says nothing —
  // and the EFFECT TYPE write is not recoverable, since it refills the engine array with that
  // type's defaults. This was written that way, measured, and reverted; the case is what stops
  // the next attempt at "make the panel and the wire agree" from agreeing in this direction.
  it("writes no FX address for a plan that omits the effect, leaving the unit's own settings", SLOW, async () => {
    const { emptyPlan, serialize } = await import("./core/plan");
    // A plan with something to write and NOTHING about either FX channel.
    const plan = emptyPlan("URX44V");
    plan.nodeParams["ch1"] = { level: -10 };
    expect(plan.nodeParams["bus.fx1"]?.fxEffect, "the premise").toBeUndefined();
    expect(plan.nodeParams["bus.fx2"]?.fxEffect, "the premise").toBeUndefined();

    // The unit is holding FX settings of its own, on both channels' selector and array.
    const FX = new Set([679, 681, 683, 685]);
    const custom = (a: Record<string, unknown>): number =>
      FX.has(a.paramId as number) ? 4242 : clockReads(false, 48_000)(a);
    // The legacy UNCOMPRESSED link shape, which the codec still decodes: jsdom here has no
    // Blob.stream for the compressed one, and the plan is what this case is about.
    const link = Buffer.from(serialize(plan), "utf8").toString("base64url");
    const shell = (await bootApp({
      url: `/?plan=${encodeURIComponent(link)}`,
      tauri: deviceCommands({ "plugin:dialog|message": "Ok", vd_get: custom }),
    }))!;

    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    // The positive control: the write ran and sent something, so the absence below is an
    // absence of FX writes rather than of writes.
    expect(shell.count("vd_set")).toBeGreaterThan(0);

    const fxWrites = shell.invokes
      .map((cmd, i) => (cmd === "vd_set" ? shell.args[i] : undefined))
      .filter((a): a is Record<string, unknown> => !!a && FX.has(a.paramId as number));
    expect(fxWrites).toEqual([]);
  });

  // A parameter whose current value could not be read is one the write has no diff for,
  // so the sweep stops at the first rather than establishing values for a write that is
  // already canceled. `vd_set` at zero is the assertion: a read failure that let the write
  // proceed would send the plan over a device state nobody confirmed.
  it("cancels the write when the device's current values cannot be read", SLOW, async () => {
    const shell = await bootDevice({ ...SAVES, vd_get: diffReadsFail });
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");

    // Exactly one: the sweep is asked to stop at the first failure, so the count is the
    // pin on that rather than an incidental number.
    expect(statusText()).toBe(t().status.writeReadFailed(1));
    expect(shell.count("vd_set")).toBe(0);

    // …and the reason is offered as a file, since a packaged build has no console to read
    // the per-command failures in.
    await vi.waitFor(() => expect(shell.count("write_text_file")).toBe(1), { timeout: 10_000 });
    const saved = shell.args[shell.invokes.indexOf("write_text_file")];
    expect(String(saved?.contents ?? "")).toContain("read-refused");

    // The only thing it asked. Two regressions hide here otherwise: a read stop that
    // still asked for the change count, and — the one nothing else covers — a read stop
    // returning a sent/not-sent split instead of null, which would offer to run the write
    // again and go on offering it, since the retry re-runs the same failing read.
    expect(confirms(shell)).toEqual([t().confirm.deviceErrorExport]);
  });

  // The names are a second diff over a separate IPC, read AFTER the numeric sweep has
  // already succeeded — so this is the arm where everything the write needs is in hand but
  // the names, and it still must not send.
  //
  // Unlike the numeric sweep, `diffNames` takes no stop-on-first-error: it reads every
  // name and collects one failure per read. The status count is pinned against that read
  // count — an independent observable — and the floor is the other half, because the two
  // move together if the sweep ever gains a stop: 1 === 1 would stay green while the
  // operator's number fell from the whole name set to one. Measured here: 17 name reads.
  it("cancels the write when a channel name cannot be read", SLOW, async () => {
    const shell = await bootDevice({
      ...SAVES,
      vd_get: clockReads(false, 48_000),
      vd_get_str: () => {
        throw new Error("name-read-refused");
      },
    });
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");

    expect(shell.count("vd_get_str")).toBeGreaterThan(5); // the sweep did not stop at the first
    expect(statusText()).toBe(t().status.writeReadFailed(shell.count("vd_get_str")));
    expect(shell.count("vd_get")).toBeGreaterThan(100); // the numeric half did run
    expect(shell.count("vd_set")).toBe(0);
    expect(shell.count("vd_set_str")).toBe(0);
    // Same as the numeric stop above: the report, and nothing else — no change count, and
    // no offer to run again a write whose read would fail the same way.
    await vi.waitFor(() => expect(confirms(shell)).toEqual([t().confirm.deviceErrorExport]), { timeout: 10_000 });
  });

  // A stopped send leaves the unit holding part of what was confirmed, and the offer to
  // run it again is what turns that into something the operator can act on. The retry
  // re-diffs, so what already landed drops out by itself — which is exactly why it must
  // NOT ask for the change count a second time: that count would be a different number
  // about a different set, asked after the operator already agreed to the write.
  it("offers to run a stopped write again, and does not re-ask the change count", SLOW, async () => {
    const shell = await bootDevice(SAVES);
    shell.failOnce("vd_set", new Error("nak"));
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");

    expect(confirms(shell).filter((m) => m.includes(RETRY_ASK))).toHaveLength(1);
    expect(confirms(shell).filter((m) => m.includes(WRITE_ASK))).toHaveLength(1);
    expect(countFor(statusText(), (n) => t().status.written(n))).toBeGreaterThan(10);
    // The names went out on the successful attempt — they are held back while the numeric
    // phase is stopped, so this also says the retry reached the end.
    expect(shell.count("vd_set_str")).toBeGreaterThan(0);

    // And the report the FIRST attempt built is still offered, after a status line saying
    // the write succeeded: `report` is not cleared by the attempt that worked. Pinned as it
    // stands rather than left to be discovered — whether a retry that resolved the failure
    // should still report it is a product question, and this records the current answer.
    // Waited for, like its sibling below: the offer is raised after the disconnect this
    // returned on.
    await vi.waitFor(() => expect(confirms(shell)).toContain(t().confirm.deviceErrorExport), { timeout: 10_000 });
  });

  // Declining ends it where it stopped, and the status line is the whole report then, so
  // it has to carry both halves of the split. The offer itself is asserted too: every
  // other assertion here is set inside `attemptWrite` before it returns, so all of them
  // hold over a build with no retry loop at all.
  it("stops where it stopped when the retry is declined", SLOW, async () => {
    const shell = await bootDevice({ ...SAVES, "plugin:dialog|message": byMessage((m) => !m.includes(RETRY_ASK)) });
    shell.failOnce("vd_set", new Error("nak"));
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");

    const [sent, notSent] = (/: (\d+) sent, (\d+) not sent/.exec(statusText()) ?? []).slice(1).map(Number);
    expect(statusText()).toBe(t().status.writeStopped(sent, notSent));
    expect(sent).toBe(0);
    expect(notSent).toBeGreaterThan(0);
    // The whole prompt, not just its count-free tail: that tail is satisfied by a prompt
    // reporting the two counts the other way round. And exactly once — a decline has to
    // end the loop rather than lead to the same question again.
    expect(confirms(shell)).toContain(t().confirm.writeRetry(0, notSent));
    expect(confirms(shell).filter((m) => m.includes(RETRY_ASK))).toHaveLength(1);
    expect(shell.count("vd_set")).toBe(1); // stopped AT the failure, not after it
    expect(shell.count("vd_set_str")).toBe(0); // names are held back while it is stopped
  });
});

// Offered after the disconnect rather than during it (why, in `offerErrorReport`'s own
// comment in main.ts). The write's read-failure case above covers the arm where the offer
// is taken and a file appears; these are the two that leave nothing behind.
describe("the failure report a device action offers", () => {
  /** A write that cancels on its first diff read, which is the cheapest way to a report. */
  const failingWrite = async (over: Record<string, unknown>): Promise<TauriShell> => {
    const shell = await bootDevice({ ...over, vd_get: diffReadsFail });
    $("btn-write").click();
    await invoked(shell, "vd_disconnect");
    return shell;
  };

  it("writes no file when the offer is declined", SLOW, async () => {
    const shell = await failingWrite({
      ...SAVES,
      "plugin:dialog|message": byMessage((m) => m !== t().confirm.deviceErrorExport),
    });
    // Waited for rather than slept past: the offer is raised after the disconnect this
    // returned on, and once its confirm resolves the decline is decided synchronously.
    await vi.waitFor(() => expect(confirms(shell)).toContain(t().confirm.deviceErrorExport), { timeout: 10_000 });
    expect(shell.count("plugin:dialog|save")).toBe(0);
    expect(shell.count("write_text_file")).toBe(0);
    expect(statusText()).toBe(t().status.writeReadFailed(1)); // the write's own verdict stands
  });

  // A rejected save must surface like a failed plan save. Swallowed, it would read as a
  // saved report — the status line still shows the write's verdict and no file exists.
  it("surfaces a save that fails, rather than leaving it read as saved", SLOW, async () => {
    const shell = await failingWrite({
      "plugin:dialog|save": () => {
        throw new Error("disk-full");
      },
    });
    await vi.waitFor(() => expect(errors(shell)).toContain(t().status.saveError("disk-full")), { timeout: 10_000 });
    expect(shell.count("write_text_file")).toBe(0);
  });
});

// The macOS Edit menu lives outside the document, so a click on it arrives as a webview
// event rather than as a DOM one. `edit-menu.test.ts` pins the module against mocked
// hooks; what is only true HERE is that those hooks reach the plan's history at all —
// they are built before `planHistory` exists and read it lazily, so a wiring that resolved
// it eagerly would capture null and the menu would silently do nothing.
describe("the macOS Edit menu", () => {
  it("routes a menu click into the plan's history, both ways", SLOW, async () => {
    const shell = await bootDevice();
    $("btn-view-console").click();
    const slider = (): HTMLElement => $("console-host").querySelector<HTMLElement>('.con-strip [role="slider"]')!;
    /** Wait until the NEWEST push to the native menu says exactly this. */
    const menuState = async (state: { canUndo: boolean; canRedo: boolean }): Promise<void> => {
      await vi.waitFor(() => expect(shell.args[shell.invokes.lastIndexOf("set_edit_menu_state")]).toEqual(state), {
        timeout: 10_000,
      });
    };
    const before = slider().getAttribute("aria-valuenow");

    // UP, not down: the first control on the strip is the analog gain knob, and the default
    // plan has it at the bottom of its range, so a step down writes the value it already
    // holds and the case would fail on its own premise. Both values are asserted rather
    // than described, so the reason survives a factory default that moves or a strip head
    // that is reordered.
    expect(before, "the first strip control is no longer the gain knob at its floor").toBe("-8");
    // Keyup as well as keydown: an arrow key is an entry boundary, so this commits the edit
    // at once instead of leaving the case waiting on the idle backstop.
    for (const type of ["keydown", "keyup"]) {
      slider().dispatchEvent(new KeyboardEvent(type, { key: "ArrowUp", bubbles: true, cancelable: true }));
    }
    expect(slider().getAttribute("aria-valuenow")).toBe("-7");

    // The depth reached the native menu — the other half of the wiring, and the half that
    // decides whether the item is clickable at all.
    await menuState({ canUndo: true, canRedo: false });

    // One handler, not zero: an event nobody listens for would leave every assertion below
    // describing an app that was never asked to do anything.
    expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID)).toBe(1);
    await vi.waitFor(() => expect(slider().getAttribute("aria-valuenow")).toBe("-8"), { timeout: 10_000 });
    // The menu updates ITSELF, which is the whole reason this wiring exists: the menu is
    // outside the document, so nothing repaints it. Without this the Redo item stays
    // greyed out after an undo taken from the menu — usable once per launch — and only
    // the edit-driven push above would be covered.
    await menuState({ canUndo: false, canRedo: true });
    expect(shell.emit(EDIT_MENU_EVENT, EDIT_REDO_ID)).toBe(1);
    await vi.waitFor(() => expect(slider().getAttribute("aria-valuenow")).toBe("-7"), { timeout: 10_000 });
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
  // The pair that keeps the recorder sentence honest. It is asked of the model the UNIT
  // reports, and URX22 has no microSD recorder at all — warning it about an irreversible
  // Track Count loss describes hardware it does not have, and the documents say it is
  // silent throughout.
  it("says nothing about the recorder on a unit that has none", SLOW, async () => {
    const shell = await bootDevice(
      {
        vd_get: clockReads(false, 48_000),
        vd_connect: { model: "URX22", label: "URX22", firmware: SUPPORTED_SYSTEM_FIRMWARE, epoch: 1 },
      },
      false,
    );
    badge().click();
    await invoked(shell, "vd_disconnect");
    const asked = confirms(shell).length;
    badge().click();
    await vi.waitFor(() => expect(confirms(shell).length).toBe(asked + 1), { timeout: 10_000 });
    const askedText = confirms(shell).at(-1) ?? "";
    // The clock question is still asked — this is about the recorder clause alone.
    expect(askedText).toContain(t().confirm.followUsbOn);
    expect(askedText).not.toContain(t().confirm.trackCountMayDrop);
  });

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
    // Both sentences, not the composed literal: what the case is about is that the
    // operator is told BOTH what handing the clock over does and that it can cost the
    // recorder's Track Count irreversibly. Pinning the joined string would pass a rewrite
    // that dropped either one, as long as the other still read the same.
    const askedText = confirms(shell).at(-1) ?? "";
    expect(askedText).toContain(t().confirm.followUsbOn);
    expect(askedText).toContain(t().confirm.trackCountMayDrop);
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

  // A run that cannot open its own link surfaces as a dialog and lets the latch go.
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
      // Read as an ERROR rather than counted. This run raises a confirm of its own first,
      // so a count here could only say "more than one arrived" and nothing about what the
      // second one told the operator. What it tells them is the DIAGNOSIS rather than a
      // self-test frame — `connectFailureStatus` recognises this failure and replaces the
      // wrapper with the message that says what to do about it.
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

    // WHICH question was asked. This message is the app's only statement that a settings
    // file names no unit and that the model on screen is the operator's to check, and
    // nothing else in the repository pins it — the inventory spec puts the shell's native
    // confirms out of scope, so a version that dropped the model from that sentence would
    // ask the operator to vouch for nothing.
    expect(confirms(shell)).toEqual([t().confirm.importSettings("backup.urxf", "URX44V")]);

    // And that nothing landed. The status line cannot say so — the decline branch writes it
    // itself — and the apply mutates the plan in place without touching the shell, so no
    // command count can see it either. The "?" badge is the witness: it is drawn only from
    // the unread set an import or a readback leaves behind, and the accept case above pins
    // its non-zero side on the same surface.
    const flagged = [...$("graph-host").querySelectorAll("g.node[data-id]")].filter((g) =>
      [...g.querySelectorAll("text")].some((el) => el.textContent === "?"),
    );
    expect(flagged).toHaveLength(0);
    expect(errors(shell)).toEqual([]); // abandoned, not failed
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

// Drag & drop, the DESKTOP delivery: the shell intercepts the drop before the webview
// sees it, so it arrives as an event carrying a real path rather than as anything the DOM
// produces. Two suites already stand either side of what that reaches — `e2e/dropzone.spec.ts`
// drives the browser delivery end to end through DOM drag events, and `src/ui/dropzone.test.ts`
// drives the shell adapter against a mocked `listenEvent` — so what is left is the ENTRY's
// own wiring: which caption, which refusal, and what each of its two registrations does with
// a real path.
//
// The `.urxf` half of that wiring cannot be reached from a browser at all: it is registered
// behind `experimentalEnabled()`, which resolves false off Tauri, so a caption naming a
// settings file and a refusal naming one are unreachable there — which is why
// `e2e/inventory.spec.ts` records `dropzone.planOrSettings` under `neverShown`. The
// live-session refusal above pins that a dropped `.urxf` reaches the import flow at all; what
// the registration HANDS it is pinned by the last case here, because that flow refuses and
// returns before it calls the reader.
describe("dropping a file onto the window", () => {
  const PLAN_PATH = "C:/urx/dropped.json";

  /** What a dropped path reads back as. The sample rate is the witness because it is read
   *  straight off the file: an emptied `connections` moves the board too, but only by the
   *  difference `ensureFixedConnections` leaves after putting the model's fixed wires back
   *  (measured on URX44V: 77 wires on the default plan, 48 on this one), so reading it
   *  means predicting that restoration. */
  const droppedPlan = JSON.stringify({
    format: "urx-router-plan",
    version: 1,
    modelId: "URX44V",
    sampleRate: 96_000,
    connections: [],
  });

  const advert = (): HTMLElement => $("dropzone");
  const caption = (): string => $("dropzone-label").textContent ?? "";
  const rate = (): string => $<HTMLSelectElement>("rate-picker").value;

  /**
   * Let a drop that was going to act get as far as its first read.
   *
   * `take()` hands the file to its handler synchronously, but every read behind it sits past
   * an `await`, so in the emit's own tick an ACCEPTED drop has read nothing and moved
   * nothing either — measured: `read_text_file` is 0 and the rate picker still says 48000
   * immediately after the drop that goes on to load. Every "and nothing happened" assertion
   * here is taken after this, or it is satisfied by the very behaviour it exists to refuse.
   *
   * What the `await` buys is exact: a timer callback runs only once the microtask queue is
   * empty, and that path holds no timer of its own. What the 100 ms buys is a guess, against
   * a read that some day arrives on a timer — so the accepted case asserts the read HAS
   * landed by then. A refusal cannot make that assertion (an absence has no command to wait
   * on), which is why the window is pinned there rather than here.
   */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100));

  /** Wait for the experimental gate to arm the settings-file import — the registration that
   *  puts `.urxf` on the drop target. The reveal of the menu entry and that registration are
   *  two statements of one synchronous block (only the link-stats view sits between them),
   *  so the entry showing means the extension is taken. */
  const armed = (): Promise<void> =>
    vi.waitFor(() => expect($("btn-open-settings").hidden).toBe(false), { timeout: 10_000 });

  it("raises the advert on a drag, and takes it back down", SLOW, async () => {
    const shell = await bootDevice();
    expect(advert().hidden).toBe(true);

    // One handler, not zero: an event nobody listens for would leave every assertion
    // below describing an app that was never asked to do anything.
    expect(shell.emit("tauri://drag-enter")).toBe(1);
    expect(advert().hidden).toBe(false);

    expect(shell.emit("tauri://drag-leave")).toBe(1);
    expect(advert().hidden).toBe(true);
  });

  // The caption is re-read on every drag rather than composed once, which is what lets a
  // gate that settles after startup change it — so the gate is held open here and released
  // mid-case. Two boots could not say this: a build that composed the caption at its first
  // drag would print the right string in each of them, and be wrong only where the answer
  // changes under a page that is already up. `e2e/inventory.spec.ts` records
  // `dropzone.planOrSettings` as never shown on the DOM drag path, so this is also the one
  // place it is displayed.
  it("re-reads the caption, so arming the settings import changes what it offers", SLOW, async () => {
    let arm = (): void => {};
    const gate = new Promise<boolean>((resolve) => void (arm = () => resolve(true)));
    const shell = await bootDevice({ experimental_enabled: () => gate });

    expect(shell.emit("tauri://drag-enter")).toBe(1);
    expect(caption()).toBe(t().dropzone.plan);
    expect(shell.emit("tauri://drag-leave")).toBe(1);

    arm();
    await armed();
    expect(shell.emit("tauri://drag-enter")).toBe(1);
    expect(caption()).toBe(t().dropzone.planOrSettings);
  });

  // A refused drop is a routine "not that file": the status line says which file and what
  // this build would have taken, and nothing is read to find that out.
  it("refuses an extension nothing is registered for, by name and before reading", SLOW, async () => {
    const shell = await bootDevice();
    expect(shell.emit("tauri://drag-enter")).toBe(1);

    expect(shell.emit("tauri://drag-drop", { paths: ["C:/urx/notes.txt"] })).toBe(1);
    expect(statusText()).toBe(t().status.dropUnsupported("notes.txt"));
    // The advert comes down with the refusal — left up it would cover the app, and the
    // status line saying why would be behind it.
    expect(advert().hidden).toBe(true);

    // Matched to a handler before the file was opened, so an extension nothing takes cannot
    // arrive later as a parse error. Neither read command is in the stub's table, so a build
    // that read this file would be REFUSED by the shell and report it — which is what the
    // dialog assertion catches, and why these three are worth having together.
    await settle();
    expect(shell.count("read_text_file")).toBe(0);
    expect(shell.count("read_binary_file")).toBe(0);
    expect(dialogs(shell)).toEqual([]); // the status line, not a modal
  });

  // Same refusal with the settings import armed, and it has to name the second extension:
  // the message that does not is a build lying about what it accepts. It also says the
  // match is by extension rather than a fallback — `.txt` is refused with a handler present.
  it("names the settings file in that refusal too, once the import is armed", SLOW, async () => {
    const shell = await bootDevice({ experimental_enabled: true });
    await armed();

    expect(shell.emit("tauri://drag-drop", { paths: ["C:/urx/notes.txt"] })).toBe(1);
    expect(statusText()).toBe(t().status.dropUnsupportedSettings("notes.txt"));

    await settle();
    expect(shell.count("read_binary_file")).toBe(0);
    expect(dialogs(shell)).toEqual([]);
  });

  // The other refusal. Its message names no file — which one was meant to win is exactly
  // what the app will not guess — so what it can be held to is that neither was opened.
  it("refuses more than one file at a time, and reads none of them", SLOW, async () => {
    const shell = await bootDevice({ read_text_file: () => droppedPlan });

    expect(shell.emit("tauri://drag-drop", { paths: [PLAN_PATH, "C:/urx/second.json"] })).toBe(1);
    expect(statusText()).toBe(t().status.dropMultiple);

    await settle();
    expect(shell.count("read_text_file")).toBe(0);
    expect(rate()).toBe("48000"); // the plan on the board, untouched
  });

  // The accepted half, and the part a browser drop cannot have: the shell hands over a
  // real path, so the plan lands the way File > Open lands one — named on the status line
  // and remembered in the recent list. That last half is asserted nowhere else in the entry
  // suites — `main.boot.test.ts`'s Open case reaches `rememberRecent` and then reads only the
  // status line — and the path here is the only one that arrived from a read: the other file
  // flows mock `core/storage`, so the path they carry is the mock's own.
  it("opens a dropped plan and remembers where it came from", SLOW, async () => {
    const shell = await bootDevice({ read_text_file: () => droppedPlan });
    expect(rate()).toBe("48000"); // the plan the drop replaces

    expect(shell.emit("tauri://drag-drop", { paths: [PLAN_PATH] })).toBe(1);
    // The window the refusals above measure their absences in — asserted from the one side
    // that can: by the time a settle is over, the drop that WAS going to read has read.
    await settle();
    expect(shell.count("read_text_file")).toBe(1);

    await vi.waitFor(() => expect(statusText()).toBe(t().status.openedFrom("dropped.json")), { timeout: 10_000 });
    // The dropped document is what is on screen, not just what the status line names.
    expect(rate()).toBe("96000");

    const rows = [...$("inspector").querySelectorAll(".recent-row")].map((row) => row.textContent ?? "");
    expect(rows.some((text) => text.includes("dropped.json"))).toBe(true);
    expect(localStorage.getItem("urx-recent")).toContain(PLAN_PATH);
  });

  // The other side of that memory: the entry remembers a path only once the plan behind it
  // has actually loaded. A list that collected every path dropped at it would offer rows
  // that reproduce the same failure on every press.
  it("does not remember a dropped file that would not open", SLOW, async () => {
    const shell = await bootDevice({ read_text_file: () => "{" });

    expect(shell.emit("tauri://drag-drop", { paths: [PLAN_PATH] })).toBe(1);
    await vi.waitFor(() => expect(errors(shell).length).toBeGreaterThan(0), { timeout: 10_000 });

    expect(localStorage.getItem("urx-recent") ?? "").not.toContain(PLAN_PATH);
    expect($("inspector").querySelector(".recent-row")).toBeNull();
  });

  // The `.urxf` registration's payload, which the live-session refusal above cannot reach:
  // that flow returns before it calls the reader at all. Declined at the confirm, because
  // reaching the confirm is already the whole claim — the bytes were read and parsed by
  // then — and the file name in that question comes from the drop's own payload, while the
  // menu entry composes it from the dialog's path instead.
  it("reads a dropped settings file, and names it where the operator vouches for the model", SLOW, async () => {
    const bytes = sampleUrxf();
    const shell = await bootDevice({ experimental_enabled: true, read_binary_file: () => bytes.buffer }, false);
    await armed();

    expect(shell.emit("tauri://drag-drop", { paths: ["C:/urx/backup.urxf"] })).toBe(1);
    await vi.waitFor(() => expect(statusText()).toBe(t().status.canceled), { timeout: 15_000 });

    expect(shell.count("read_binary_file")).toBe(1);
    expect(confirms(shell)).toEqual([t().confirm.importSettings("backup.urxf", "URX44V")]);
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

// What the app may state to a MIDI controller, and when. The values it would send are
// the PLAN's, and until a Live-sync readback settles, the plan is whatever was loaded —
// a new document's defaults, a file, a half-applied read. On a loopback or a shared bus
// those go out as an operator's gesture to every other listener: a second instance of
// this app took one for input and wrote it to the unit, putting CH 1's gain from +66 dB
// to its minimum with the channel unmuted.
//
// The rule is wired here rather than only inside MidiControl, and this is the seam that
// sees the wiring: the class cannot tell whether the session it was told about actually
// came up.
describe("MIDI feedback and the live session", () => {
  const MIDI_PORT = { midi_list_outputs: ["Controller Out"], midi_open_output: null, midi_send: null };
  const MIDI_SEED = {
    "urx-midi": JSON.stringify({
      output: "Controller Out",
      // ch1/gain rather than a send level: the inspector edits it directly, which is how
      // the live-off half below moves a MAPPED value and so has something a pass would
      // carry — without that, a pass finding nothing to send looks like a closed output.
      models: {
        URX44V: [{ control: "ch1/gain", addr: { type: "cc", channel: 0, controller: 7 }, mode: "absolute" }],
        URX88: [{ control: "ch1/gain", addr: { type: "cc", channel: 0, controller: 7 }, mode: "absolute" }],
      },
    }),
  };

  const bootWithController = async (over: Record<string, unknown> = {}): Promise<TauriShell> =>
    (await bootApp({
      seed: MIDI_SEED,
      tauri: deviceCommands({ "plugin:dialog|message": "Ok", ...MIDI_PORT, ...over }),
    }))!;

  it("sends nothing to the controller until a live readback settles, then sends", SLOW, async () => {
    const shell = await bootWithController(connectAs("URX44V"));
    // The port is open and the mapping resolves — so the silence below is this rule and
    // not a controller the harness never connected.
    await invoked(shell, "midi_open_output");
    expect(shell.count("midi_send")).toBe(0);

    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-pressed")).toBe("true"), SLOW);
    await vi.waitFor(() => expect(shell.count("midi_send")).toBeGreaterThan(0));

    // And closes again when the session ends. The edit below MOVES a mapped value, so a
    // pass that ran would carry it: the count staying put is the output side being shut
    // rather than a pass finding nothing.
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-pressed")).toBe("false"));
    const sentWhileLive = shell.count("midi_send");

    selectNode("ch1");
    const gain = row(t().inspector.gainAnalog).querySelector<HTMLInputElement>("input")!;
    gain.value = String(Number(gain.value) === 20 ? 30 : 20);
    gain.dispatchEvent(new Event("input", { bubbles: true }));
    gain.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300)); // past the feedback debounce
    expect(shell.count("midi_send")).toBe(sentWhileLive);
  });

  // The shape the guard is actually placed against: device values ARE in the plan when
  // the flow reaches the same `finally` a settled read reaches, and the session is not
  // up. Only `liveSessionUp` separates the two, so this is the case that goes red if the
  // re-send is moved back beside planReadFromDevice — where it sits one line away.
  it("stays silent when a partial readback refuses the session", SLOW, async () => {
    let reads = 0;
    const shell = await bootWithController({
      ...connectAs("URX44V"),
      vd_get: (): number => {
        reads++;
        if (reads === 1) throw new Error("read refused"); // one bad read is a partial plan
        return 0;
      },
    });
    await invoked(shell, "midi_open_output");

    $("btn-live").click();
    await invoked(shell, "vd_disconnect");
    expect(live().getAttribute("aria-pressed")).not.toBe("true");
    expect(shell.count("vd_params_subscribe")).toBe(0); // the session never registered
    expect(errors(shell).length).toBeGreaterThan(0); // and said so
    expect(shell.count("midi_send")).toBe(0);
  });

  it("stays silent when the live session fails on the way up", SLOW, async () => {
    // Unknown model: the read never runs, and the flow lands in the same `finally` a
    // settled one does. What separates them is the session, which is why the re-send
    // hangs off that rather than off reaching the block.
    const shell = await bootWithController(connectAs("URX88"));
    await invoked(shell, "midi_open_output");

    $("btn-live").click();
    await invoked(shell, "vd_disconnect");
    expect(errors(shell)).toEqual([t().status.liveError(t().error.unknownModel("URX88"))]);
    expect(shell.count("midi_send")).toBe(0);
  });
});

// An incoming MIDI edit repaints through the direct-follow reflect, which repaints only
// the nodes `inspectorNodes` names — and a Ducker's on/off is the one thing MIDI can move
// on a node that the selection need not mention at all. That branch needs a shell, so the
// panel's own suite cannot reach it: inspector.test.ts pins the footprint, and this is the
// wiring that consumes it. A device-side Ducker change takes the other branch (no ducker
// param follows directly) and refreshes the panel wholesale.
describe("a Ducker moved over MIDI repaints the inspector", () => {
  const DUCKER = "out.ducker1"; // hangs off CH 5/6 (models/build.ts)
  const CC = 20;

  const bootWithPad = async (): Promise<TauriShell> =>
    (await bootApp({
      seed: {
        "urx-midi": JSON.stringify({
          input: "Controller In",
          models: {
            URX44V: [
              {
                control: `${DUCKER}/duckerOn`,
                addr: { type: "cc", channel: 0, controller: CC },
                mode: "absolute",
                button: "edge",
              },
            ],
          },
        }),
      },
      tauri: { midi_list_inputs: ["Controller In"], midi_open_input: null, midi_close_input: null },
    }))!;

  const panelText = (): string => $("inspector").textContent ?? "";

  /** The section a title names, by its header rather than by position: the panel puts
   *  several on a node and only one of them is the Ducker's. */
  const section = (title: string): HTMLDetailsElement => {
    const found = [...$("inspector").querySelectorAll<HTMLDetailsElement>("details.insp-section")].find(
      (d) => d.querySelector(".sec-title")?.textContent === title,
    );
    expect(found, `the inspector shows a "${title}" section`).not.toBeUndefined();
    return found!;
  };

  it("drops the PRE-send note when a pad turns the Ducker off under a selected send", SLOW, async () => {
    const shell = await bootWithPad();
    await invoked(shell, "midi_open_input");

    // Reached through the app's own controls rather than a seeded plan: the Ducker's ON,
    // then the send's PRE tap, which is what makes the note apply.
    selectNode(DUCKER);
    [...section(t().inspector.duckerOn).querySelectorAll<HTMLButtonElement>(".sec-body .toggle button")]
      .find((b) => b.textContent === t().inspector.on)!
      .click();
    press(wireHit($("graph-host"), "ch_5_6:out", "bus.mix1:in")!);
    const pre = [...$("inspector").querySelectorAll<HTMLButtonElement>(".param .toggle button")].find(
      (b) => b.textContent === "PRE",
    );
    expect(pre, "the send offers a PRE / POST tap").not.toBeUndefined();
    pre!.click();
    expect(panelText()).toContain(t().inspector.duckerPreSend);

    // The pad, and nothing else: an edge toggle flips on any CC >= 64. The wire is still
    // what is selected — only the ducker node moved.
    const opened = shell.args[shell.invokes.indexOf("midi_open_input")] as {
      channel: { onmessage: (d: unknown) => void };
    };
    opened.channel.onmessage([{ bytes: [0xb0, CC, 127] }]);
    await vi.waitFor(() => {
      expect(panelText()).not.toContain(t().inspector.duckerPreSend);
    });
    // …and the send is still the selection, so the note went with the Ducker rather than
    // with the panel changing subject.
    expect(panelText()).toContain(t().inspector.prePost);
  });
});

// The canvas half of the same route, and the reason onApplied needs no repaint of its
// own: the reflect it requests redraws the wires. graph.repaintDirtyNodes ends in
// redrawWires, so a toggle's dimming lands one reflect window later without a second
// call beside the apply — which used to be there, justified by a comment saying the
// reflect "repaints nodes only".
describe("a MIDI toggle dims its wire through the reflect alone", () => {
  const CC = 22;

  it("dashes the main send it muted, with no repaint beside the apply", SLOW, async () => {
    const shell = (await bootApp({
      seed: {
        "urx-midi": JSON.stringify({
          input: "Controller In",
          models: {
            URX44V: [
              {
                control: "ch1/mute",
                addr: { type: "cc", channel: 0, controller: CC },
                mode: "absolute",
                button: "edge",
              },
            ],
          },
        }),
      },
      tauri: { midi_list_inputs: ["Controller In"], midi_open_input: null, midi_close_input: null },
    }))!;
    await invoked(shell, "midi_open_input");

    // The painted path beside the transparent hit band, the way e2e/ducker.spec.ts
    // addresses one.
    const wire = (): SVGPathElement | null =>
      $("graph-host").querySelector<SVGPathElement>(
        'g:has(> .wire-hit[data-from="ch1:out"][data-to="bus.stereo:in"]) path:not(.wire-hit)',
      );
    // The STEREO main path, which ships at unity — the MIX sends ship at the level floor
    // and are already drawn off, so a dimming there would assert nothing.
    expect(wire(), "the CH 1 -> STEREO send is drawn").not.toBeNull();
    expect(wire()!.getAttribute("stroke-dasharray")).toBeNull();

    const opened = shell.args[shell.invokes.indexOf("midi_open_input")] as {
      channel: { onmessage: (d: unknown) => void };
    };
    opened.channel.onmessage([{ bytes: [0xb0, CC, 127] }]);
    await vi.waitFor(() => expect(wire()!.getAttribute("stroke-dasharray")).toBe("1.5 4"));
  });
});

// Two funnels write the plan, and both have to name what they asserted. These drive the
// CONSOLE half and the BAL mirror's half against a read in flight.
describe("the inspector while the CONSOLE hides it", () => {
  /** CH 1's A.GAIN knob on the CONSOLE, which IS on screen while the panel is not —
   *  so it says the follow reflect ran, and a stale panel cannot be read as a notify
   *  that never arrived. */
  const consoleGain = (): string | null =>
    $("console-host").querySelector<HTMLElement>('[aria-label="A.GAIN"]')?.getAttribute("aria-valuenow") ?? null;

  // The panel is display:none for as long as the CONSOLE view is up, and a device
  // follow that touches the selected node would otherwise rebuild it there at the
  // reflect's own rate — focus and caret capture included, on a subtree nothing can
  // focus. The rebuild is deferred, not dropped, so the value has to be on screen after
  // the view switch WITHOUT the operator re-selecting the node: every other case in
  // this file re-selects on the way back, which rebuilds a visible panel and would pass
  // with the drain deleted.
  it("holds the rebuild while the CONSOLE hides it, and pays it on the way back", SLOW, async () => {
    const shell = await bootDevice();
    $("btn-live").click();
    await vi.waitFor(() => expect(live().getAttribute("aria-pressed")).toBe("true"), { timeout: 25_000 });
    selectNode("ch1");
    const before = paramRow(t().inspector.gainAnalog);

    $("btn-view-console").click();
    // A direct follow on the selected node: applied into the plan with no read back.
    // Whole dB, since the gain decode rounds and a smaller step would leave the plan
    // where it was — the panel would then agree for the wrong reason.
    notifyChannel(shell).onmessage([{ param_id: PARAMS.HA_GAIN.id, x: 0, y: 0, value: 2000 }]);
    // The reflect is coalesced onto a timer, so wait for it where it IS visible.
    await vi.waitFor(() => expect(consoleGain()).toBe("20"), { timeout: 25_000 });

    // It ran, and it rebuilt no panel: the row is the same element.
    expect(paramRow(t().inspector.gainAnalog)).toBe(before);

    $("btn-view-graph").click();
    expect(paramRow(t().inspector.gainAnalog)).not.toBe(before);
    expect(paramRow(t().inspector.gainAnalog).textContent).toContain("20");

    // End the session rather than leaving it running: its idle net would fire into the
    // next case, which boots its own shell.
    $("btn-live").click();
    await invoked(shell, "vd_disconnect");
  });
});

describe("an edit funnel against a device read", () => {
  const face = (label: string): string | undefined =>
    paramRow(label)?.querySelector("button.on")?.textContent ?? undefined;

  // The CONSOLE's INS FX selection is the one console write that is not a flip: taking a
  // slot writes the bypass ON, which a No Effect route can already be holding (the
  // inspector leaves it engaged when the operator picks No Effect). The plan then reads
  // the same before and after, so the read's own diff cannot tell that key from one
  // nobody touched — and the operator's new effect landed selected and BYPASSED.
  //
  // The gesture is the strip's disclosure and then a row of the type popover it opens.
  // The face beside it cannot stand in: it is a bypass and writes one key, so driven
  // through it this case would assert nothing about the pair.
  it("keeps a bypass the CONSOLE asserted while a read was in flight", SLOW, async () => {
    const shell = await bootDevice();
    selectNode("ch1");
    pickInsertFx(COMPANDER_H);
    pickInsertFx(INSERT_FX_NONE); // selector alone: the bypass stays engaged

    shell.answer(
      "vd_get",
      (a: Record<string, unknown>) =>
        new Promise((r) =>
          setTimeout(() => r(a.paramId === PARAMS.INSERT_FX.id ? denormalizeInsertFx(INSERT_FX_NONE) : 0), 1),
        ),
    );
    $("btn-fetch").click();
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(5), { timeout: 10_000, interval: 5 });

    $("btn-view-console").click();
    const strip = $("console-host").querySelectorAll<HTMLElement>(".con-strip")[0];
    strip.querySelector<HTMLElement>(".con-ifxopen")!.click();
    [...$("console-host").querySelectorAll<HTMLElement>(".con-ifxpop .irow")]
      .find((r) => !r.classList.contains("off") && r.querySelector(".nm")!.textContent !== "No Effect")!
      .click();
    await invoked(shell, "vd_disconnect");

    $("btn-view-graph").click();
    selectNode("ch1");
    expect(insertFxSection()!.querySelector("select")!.value).not.toBe(String(INSERT_FX_NONE));
    expect(insertFxOnFace()).toBe("ON");
  });

  // A nested group is edited by REBUILDING it — one field set, the rest copied — so the
  // patch key names the whole group, and the merge drops a named group whole. Naming it
  // therefore takes the device's answer for every sibling the rebuild never touched:
  // measured, an OSC frequency the unit moved during an OSC ON toggle was thrown away
  // with the toggle's own key.
  it("keeps a device change to a sibling of the group field the operator edited", SLOW, async () => {
    const shell = await bootDevice();
    // The unit answers a different oscillator frequency than the plan's default.
    shell.answer(
      "vd_get",
      (a: Record<string, unknown>) =>
        new Promise((r) => setTimeout(() => r(a.paramId === PARAMS.OSC_FREQ.id ? eqFreqToVd(2000) : 0), 1)),
    );
    $("btn-fetch").click();
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(5), { timeout: 10_000, interval: 5 });

    // Mid-read, the operator toggles the oscillator ON — one field of the same group.
    selectNode("bus.osc");
    const btns = [...paramRow(t().inspector.oscOn).querySelectorAll<HTMLButtonElement>("button")];
    (btns.find((b) => b.textContent === "ON") ?? btns[0]).click();
    await invoked(shell, "vd_disconnect");

    selectNode("bus.osc");
    expect(paramRow(t().inspector.oscOn).querySelector("button.on")?.textContent).toBe("ON");
    // …and the sibling the operator never touched took the unit's value.
    expect(paramRow(t().inspector.frequency).querySelector(".param-val")?.textContent).toBe(formatHz(2000));
  });

  // The same rule, for a funnel that names nothing: a tuning screen rebuilds its whole
  // group through one shared writer (`subObjectIo`), so the patch key it produces is the
  // GROUP. Naming that is what the funnel must not do by default — the screens carry no
  // field that can be written without moving, so a group falls through to the plan's own
  // diff rather than being claimed whole.
  it("keeps a device change to a tuning screen's other field", SLOW, async () => {
    const shell = await bootDevice(SAVES);
    $("btn-view-console").click();
    const strip = $("console-host").querySelectorAll<HTMLElement>(".con-strip")[0];
    strip.querySelector<HTMLElement>(".con-chip-open")!.click(); // the GATE opener

    // The unit moved GATE ATTACK to 4 ms while the screen was open.
    shell.answer(
      "vd_get",
      (a: Record<string, unknown>) =>
        new Promise((r) => setTimeout(() => r(a.paramId === PARAMS.GATE_ATTACK.id ? attackToVd(4) : 0), 1)),
    );
    $("btn-fetch").click();
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(5), { timeout: 10_000, interval: 5 });

    // …and the operator drags THRESHOLD in the same group, mid-read.
    const thr = $("dyn-screen-box").querySelector<HTMLInputElement>('input[data-dyn="threshold"]')!;
    const moved = Number(thr.value) - 5;
    thr.value = String(moved);
    thr.dispatchEvent(new Event("input", { bubbles: true }));
    thr.dispatchEvent(new Event("change", { bubbles: true }));
    await invoked(shell, "vd_disconnect");

    // Read the plan back through a save: the open screen does not repaint on a read, so
    // its DOM would answer for the render rather than for the merge.
    const before = shell.count("write_text_file");
    $("btn-save").click();
    await vi.waitFor(() => expect(shell.count("write_text_file")).toBe(before + 1), { timeout: 10_000 });
    const saved = shell.args[shell.invokes.lastIndexOf("write_text_file")];
    const gate = JSON.parse(String((saved as { contents: string }).contents)).nodeParams.ch1.gate;

    expect(gate.threshold).toBe(moved); // the field the operator moved is theirs…
    expect(gate.attack).toBe(4); // …and the sibling they never touched took the unit's
  });

  // …and the BAL mirror names THIS EDIT's keys on the partner, not the whole record it
  // copies. The other keys were already equal on both sides, so copying them writes
  // nothing — while claiming them takes the device's answer away from the partner alone
  // and splits a pair that moves as one.
  it("lets both members of a BAL pair take a device change the edit never touched", SLOW, async () => {
    const shell = await bootDevice();
    selectNode("ch1");
    pickSignalType(1); // STEREO, which lands the pair in BAL

    // The unit holds HPF ON on every channel; the plan holds the default OFF.
    shell.answer(
      "vd_get",
      (a: Record<string, unknown>) =>
        new Promise((r) => setTimeout(() => r(a.paramId === PARAMS.HPF_ON.id ? 1 : 0), 1)),
    );
    $("btn-fetch").click();
    await vi.waitFor(() => expect(shell.count("vd_get")).toBeGreaterThan(5), { timeout: 10_000, interval: 5 });

    // An edit that carries Phase alone, mid-read.
    selectNode("ch1");
    const btns = [...paramRow(t().inspector.phase).querySelectorAll<HTMLButtonElement>("button")];
    (btns.find((b) => b.textContent === "ON") ?? btns[0]).click();
    await invoked(shell, "vd_disconnect");

    selectNode("ch1");
    expect(face(t().inspector.hpf)).toBe("ON");
    selectNode("ch2");
    expect(face(t().inspector.hpf)).toBe("ON");
  });
});
