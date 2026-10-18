// The setup and teardown every `main.device.*.test.ts` file shares, and the helpers their cases
// read the app and the shell through. Importing this module registers its hooks and its
// `urx-lcd-sim/embed` mock on the importing file.
//
// Those files are the app entry's DESKTOP half: the device link, the live session, and the guard
// rails that decide which of them may hold it. Unreachable from the other two boot suites —
// `isTauri()` is what gates all of it, and they run with no shell — so they install one
// (`main.test-util.ts`) and drive the flows through it.
//
// The stub keeps what is written to it and answers the next read with it, which is
// what lets a converging write actually converge. What it does NOT model is the
// device's own behaviour — a side-effect reset, a clamp, a refused value — and those
// belong to `e2e/race/fake-device.ts`; a second, thinner imitation of it here would be
// a fixture that agrees with nothing.

import { afterEach, beforeEach, expect, vi } from "vitest";
import {
  $,
  bootApp,
  currentShell,
  deviceCommands,
  installAppGlobals,
  restoreAppGlobals,
  unwrittenRead,
} from "./main.test-util";
import type { TauriShell } from "./main.test-util";
import { PARAMS } from "./core/control/params";
import { SUPPORTED_SYSTEM_FIRMWARE } from "./core/control/firmware";
import { faceplate } from "./ui/graph.test-util";
import { EDIT_MENU_EVENT, EDIT_UNDO_ID } from "./core/platform";
import { t } from "./i18n";

// The glass's refused-action hook, as the SIM view hands it to the simulator: no control on the
// glass reaches it while every unit operation is held shut, so a case calls it directly.
export const simRefused = { hook: null as ((op: { kind: string }) => void) | null };
// …and the unit the view mounts the glass over, so a case can drive the transport and read the
// levels the simulator asks for without reaching a control on the glass.
export const simMounted = {
  unit: null as import("urx-lcd-sim/embed").Unit | null,
  // Every glass a case mounted: its meter and clock timers run until it is disposed, and one
  // left running fires after the test environment is gone.
  glasses: [] as import("urx-lcd-sim/embed").EmbeddedSim[],
};
// Registered on every file that imports this module. The factory runs when the app first imports
// the simulator, after this module has evaluated, and fills the two objects above.
vi.mock("urx-lcd-sim/embed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("urx-lcd-sim/embed")>();
  return {
    ...actual,
    refusedActions: (hook: (op: { kind: string }) => void) => {
      simRefused.hook = hook;
      return actual.refusedActions(hook);
    },
    mountSim: async (host: HTMLElement, options: import("urx-lcd-sim/embed").EmbedOptions) => {
      simMounted.unit = options.unit ?? null;
      const glass = await actual.mountSim(host, options);
      simMounted.glasses.push(glass);
      return glass;
    },
  };
});

/** Long enough for a whole-device read (676 reads through the stub) plus a teardown. */
export const SLOW = { timeout: 30_000 };

/** Counts the cases started, so a teardown can tell when the page has passed to the next one. */
let casesStarted = 0;
/** The case whose teardown started and has not restored the page, or null. */
let untornDown: string | null = null;
// A case that starts on a page its predecessor's teardown never restored fails before it
// boots, naming that case: the predecessor's app is still running, and every command it
// sends from here lands in this case's device stub.
beforeEach(() => {
  casesStarted += 1;
  if (untornDown !== null) {
    throw new Error(
      `the teardown of "${untornDown}" did not finish, so its app is still running on this page and would ` +
        "send its commands to this case's device stub",
    );
  }
  installAppGlobals();
});
// The app a case leaves behind. A case returns as soon as its own assertion holds, but the
// flow it started runs on: a live session reads the whole unit before it comes up, and a
// release waits out a follow read that is hundreds of round trips long. Once the next
// `bootApp` installs a fresh table those calls land in it — where they read as that case's
// own traffic, and where a teardown's `vd_disconnect` satisfies a wait for the disconnect
// the case is actually about.
//
// A teardown that outlives its hook's timeout goes on running while the next case starts. From
// then on it acts on nothing: the shell, the controls and the globals all belong to the next
// case's app, so it stops at its next step instead of draining and restoring that app's page.
// Every glass a case mounted is disposed, which stops its meter and clock timers.
afterEach(() => {
  for (const glass of simMounted.glasses.splice(0)) glass.dispose();
});

// The page it leaves behind is then the next case's to refuse (the `beforeEach` above), and
// the next case's own teardown is what restores it.
afterEach(async () => {
  untornDown = expect.getState().currentTestName ?? "";
  const mine = casesStarted;
  const handedOver = (): boolean => casesStarted !== mine;
  const shell = currentShell();
  const rate = document.getElementById("rate-picker") as HTMLSelectElement | null;
  const btn = document.getElementById("btn-live");
  // The app's OWN signal, not a guess at how long things take: the rate picker is locked
  // for exactly as long as something holds the device link, whichever action holds it. A
  // session in the middle of starting holds it with the toggle still down, so the two are
  // waited on together — and the loop is what lets a start that completes here be ended.
  for (let i = 0; rate && i < 5 && !handedOver(); i++) {
    if (btn?.getAttribute("aria-checked") === "true") {
      btn.click();
      await vi.waitFor(() => handedOver() || expect(btn.getAttribute("aria-checked")).toBe("false"), {
        timeout: 25_000,
      });
    }
    if (!rate.disabled) break;
    await vi.waitFor(
      () => handedOver() || expect(!rate.disabled || btn?.getAttribute("aria-checked") === "true").toBe(true),
      { timeout: 25_000 },
    );
  }
  if (handedOver()) return;
  if (shell) await drainShell(shell, handedOver);
  if (handedOver()) return;
  restoreAppGlobals();
  untornDown = null;
});

/** How often the drain reads the invoke count. */
export const DRAIN_READING_MS = 10;
/** How many readings in a row with no new invoke end the drain. The run outlasts the MIDI
 *  feedback pass (`FEEDBACK_DEBOUNCE_MS` in `src/ui/midi.ts`), the last thing the app still
 *  does after a case, by readings to spare on a loaded machine; `main.device.table.test.ts`
 *  holds the two apart. */
export const DRAIN_QUIET_READINGS = 18;

/** Wait until the page stops invoking. Bounded, and it THROWS at the bound rather than
 *  returning: an app that never goes quiet is a case leaking into the next one, which is
 *  the thing this exists to stop, and swallowing it here would put that back silently. */
export async function drainShell(shell: TauriShell, handedOver: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  let seen = shell.invokes.length;
  // Several readings: one sample of "unchanged" is satisfied inside a pause between two
  // phases of the very flow being waited out. What the RUN of them has to cover is a note
  // the app produces late — a live start that fails emits one well after its own teardown
  // has handed the link back — rather than a flow's round trips, which resolve as
  // microtasks with no timer between them.
  for (let quiet = 0; quiet < DRAIN_QUIET_READINGS && !handedOver();) {
    if (Date.now() > deadline) throw new Error(`the page is still invoking (${shell.invokes.length})`);
    // The MIDI trace sink batches its writes, and that write is the last thing the app
    // does after a case — so a drain that only waited would be waiting out a timer rather
    // than a device flow, and the window would have to exceed the batch. Emptied by name
    // on every reading instead, which takes the sink out of what the window has to cover.
    // A no-op with nothing queued.
    (window as unknown as { __urxMidiProbe?: { flush(): void } }).__urxMidiProbe?.flush();
    await new Promise((r) => setTimeout(r, DRAIN_READING_MS));
    const now = shell.invokes.length;
    quiet = now === seen ? quiet + 1 : 0;
    seen = now;
  }
}

/** Boot with a connected unit. `agree` answers every confirm with Ok. */
export const bootDevice = async (
  over: Record<string, unknown> = {},
  agree = true,
  /** Addresses the unit already holds a value for. Needed for anything the app only READS:
   *  the table answers an unwritten address 0, and 0 is a legal value there. */
  seed: Record<string, number> = {},
  /** Addresses the unit accepts a write to and does not keep (main.test-util.ts). */
  ignoreWrite?: (a: Record<string, unknown>) => boolean,
): Promise<TauriShell> =>
  (await bootApp({
    tauri: deviceCommands({ ...(agree ? { "plugin:dialog|message": "Ok" } : {}), ...over }, seed, ignoreWrite),
  }))!;

/**
 * Wait until `cmd` has been invoked `n` times. The device flows here write the status
 * line several times on the way through ("Connecting to the device…" first), so
 * waiting for it to CHANGE returns in the middle of the flow — which is how a first
 * version of the device suite asserted "no writes happened" against a write that had not
 * started yet. The flow's own terminal command is the thing to wait on.
 */
export async function invoked(shell: TauriShell, cmd: string, n = 1, timeout = 25_000): Promise<void> {
  await vi.waitFor(
    () => {
      if (shell.count(cmd) < n) throw new Error(`${cmd} invoked ${shell.count(cmd)} times, want ${n}`);
    },
    { timeout, interval: 20 },
  );
}

export const live = (): HTMLButtonElement => document.getElementById("btn-live") as HTMLButtonElement;
/** A fetch's own finally has run: it puts the button's label back. */
export const fetchEnded = (): Promise<void> =>
  vi.waitFor(() => expect($("btn-fetch").textContent).toBe(t().toolbar.fetchDevice), { timeout: 10_000 });

/** The inspector row a label names (main.flows.test.ts). */
export const row = (label: string): HTMLElement => {
  const found = $("inspector").querySelector<HTMLElement>(`.param[data-param-label="${label}"]`);
  expect(found, `the inspector shows a "${label}" row`).not.toBeNull();
  return found!;
};

/**
 * Select a node the way a click does, so the inspector renders for it.
 *
 * The release is not decoration: a press the board never sees released arms the path-trace
 * long press (graph.ts `startLongPress`), which fires a few hundred ms later and writes a
 * status line of its own — so a status a case reads after selecting a node would be racing
 * that timer, and which one wins is a property of how loaded the machine is.
 */
export const selectNode = (id: string): void => {
  const face = faceplate($("graph-host"), id)!;
  face.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, bubbles: true }));
  face.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
};

/** The notify channel the live session registered, taken from the subscribe's own
 *  arguments rather than by position. */
export const notifyChannel = (shell: TauriShell): { onmessage: (d: unknown) => void } =>
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
 * not of the suite — a case that reads back after a write has to compose the two stores
 * itself, and should say why. It also means a `vd_set` count taken under this store says
 * how much was sent, never that the write converged.
 */
export function clockReads(followUsb: boolean, sampleRate: number): (a: Record<string, unknown>) => number {
  return (a) =>
    a.paramId === PARAMS.FOLLOW_USB.id
      ? followUsb
        ? 1
        : 0
      : a.paramId === PARAMS.SAMPLE_RATE.id
        ? sampleRate
        : unwrittenRead(a);
}

/** `read`, on a unit whose STREAMING source is MIX 1 — one a write of STEREO moves. */
export function streamingOnMix1(read: (a: Record<string, unknown>) => number): (a: Record<string, unknown>) => number {
  return (a) =>
    a.paramId === PARAMS.STREAM_SRC_L.id
      ? (0x80000000 | 288) >>> 0
      : a.paramId === PARAMS.STREAM_SRC_R.id
        ? (0x80000000 | 289) >>> 0
        : read(a);
}

/**
 * Capture `console.warn` for the duration of a case, and silence it.
 *
 * Both halves matter. The self-test and the audit writer report through the log rather
 * than through a surface — that is deliberate, so a headless launch can be read from the
 * dev server — so the log IS the observable for those runs. And left unsilenced, one of
 * them floods the test output with its whole per-parameter report.
 */
export function captureWarnings(): { lines: string[]; restore: () => void } {
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
export function dialogs(shell: TauriShell): Array<{ message?: string; kind?: string; buttons?: string }> {
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

/** The strips a write confirm's unauthored-write note names, as ITEMS.
 *
 *  Split rather than searched: the names are a comma-separated run and several of this
 *  model's labels are prefixes of others ("CH 1" of "CH 11/12", "FX 1" of nothing), so a
 *  `toContain` on a label answers yes for a note that never mentioned it. Empty when the
 *  message carries no note at all, which is the other thing these cases assert. */
export function stripsNamed(message: string): string[] {
  const [head, tail] = t().confirm.unauthoredWrite("\u0000").split("\u0000");
  const at = message.indexOf(head);
  if (at < 0) return [];
  // The note is one paragraph and the question is the next, so the run ends at the break —
  // the message puts nothing after the names, so a split on the placeholder's own tail would
  // take the question into the last item.
  const rest = message.slice(at + head.length).split("\n\n")[0];
  const end = tail ? rest.indexOf(tail) : -1;
  return (end < 0 ? rest : rest.slice(0, end))
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
}

/** The messages of the dialogs that ASKED (OK / Cancel), in order. */
export const confirms = (shell: TauriShell): string[] =>
  dialogs(shell)
    .filter((d) => d.buttons === "OkCancel")
    .map((d) => d.message ?? "");

/** Put the plan on `rate` through the picker, the way the operator does. */
export const chooseRate = (rate: number): void => {
  const picker = $<HTMLSelectElement>("rate-picker");
  picker.value = String(rate);
  picker.dispatchEvent(new Event("change"));
};

// param 839 counts stereo PAIRS, so 8 is 16 tracks — the full recorder. The seed table keys on
// the stub's own address form, "id/x/y"; the invoke arguments spell the same address with
// colons. Several files drive the recorder, so one seat rather than a literal in each.
export const TRACK_COUNT_SEED = "839/0/0";
export const TRACK_COUNT_ADDR = "839:0:0";
export const PLAYBACK_SEED = "836/0/0";
export const PLAYBACK_ADDR = "836:0:0";
export const FOLLOW_USB_SEED = "848/0/0";

/** The messages of the dialogs that REPORTED a failure, in order. */
export const errors = (shell: TauriShell): string[] =>
  dialogs(shell)
    .filter((d) => d.kind === "error")
    .map((d) => d.message ?? "");

/** Every value written to Follow USB, in order. Read off the ledger by ADDRESS: the
 *  policy is one write among hundreds a plan write sends, so counting `vd_set` cannot
 *  say whether this particular one went out, nor which way. */
export function followUsbWrites(shell: TauriShell): number[] {
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
export function byMessage(agree: (message: string) => boolean): (a: Record<string, unknown>) => string {
  return (a) => (agree(String(a.message ?? "")) ? "Ok" : "Cancel");
}

/** The part of a prompt after its question mark, which is the part that carries no
 *  count — so two attempts asking the same question with different numbers match one
 *  needle. Never empty for the two prompts below, so it cannot match everything. */
export const invariantOf = (prompt: string): string => prompt.replace(/^[\s\S]*?\?\s*/, "");
export const WRITE_ASK = invariantOf(t().confirm.write(1));
export const RETRY_ASK = invariantOf(t().confirm.writeRetry(1, 1));

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
export const countFor = (line: string, frame: (n: number) => string): number =>
  (line.match(/\d+/g)?.map(Number) ?? []).find((n) => frame(n) === line) ?? NaN;

/** The two commands a report save travels. Deliberately absent from `deviceCommands`: a
 *  device action that saves a file unasked is a defect, so a case that expects a save has
 *  to opt in, and one that does not gets the stub's refusal. */
export const SAVES: Record<string, unknown> = { "plugin:dialog|save": "/tmp/report.md", write_text_file: null };

/** A connected unit that is not the model on screen. */
export const connectAs = (model: string): Record<string, unknown> => ({
  vd_connect: { model, label: model, firmware: SUPPORTED_SYSTEM_FIRMWARE, epoch: 1 },
});

/** A store that answers the clock and refuses every other read, so a write reaches its
 *  DIFF and stops there. The clock has to answer: a failed clock read ends the write one
 *  gate earlier, which is main's own "writes nothing when the clock cannot be read". */
export const diffReadsFail = (a: Record<string, unknown>): number => {
  if (a.paramId === PARAMS.FOLLOW_USB.id || a.paramId === PARAMS.SAMPLE_RATE.id) {
    return clockReads(false, 48_000)(a);
  }
  throw new Error("read-refused");
};

/**
 * Press a node on the board by its own GROUP — the same completed press `selectNode` above
 * makes, aimed elsewhere. What separates the two is where it lands: `selectNode` presses the
 * faceplate, and the FX cases need the group, or the tuning screen they open draws
 * another node's values or nothing at all.
 *
 * The release carries the same weight it carries there, for the reason written there. On a
 * press that never moved it is all `onPointerUp` does that matters: the drag it drops reports
 * nothing, and the connect branch is not one a node press enters.
 */
export const pressNode = (nodeId: string): void => {
  const node = $("graph-host").querySelector<SVGGElement>(`g.node[data-id="${nodeId}"]`)!;
  node.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, bubbles: true }));
  node.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
};

/** The stable head of a status or confirm line that carries counts: the message built with
 *  its counts at 0, cut at the first digit. Refused when that leaves nothing, since every
 *  line starts with the empty string and a caller would then be asserting nothing. */
export const countedHead = (line: string): string => {
  const head = line.split(/\d/)[0]!;
  if (head === "") throw new Error(`no head in front of the counts, so matching it asserts nothing: ${line}`);
  return head;
};

/** An inspector row by the label it stamps on itself, so "Insert FX" cannot match
 *  "Insert FX ON" — two rows carrying two different addresses. */
export const paramRow = (label: string): HTMLElement =>
  $("inspector").querySelector<HTMLElement>(`.param[data-param-label="${label}"]`)!;

/** The Insert FX section. It is a collapsible on-state section like GATE / COMP / EQ, so
 *  its controls are reached THROUGH it rather than by a row label: the bypass row carries
 *  no label of its own, the header being its name, and the selector's row is the type. */
export const insertFxSection = (): HTMLDetailsElement | undefined =>
  [...$("inspector").querySelectorAll<HTMLDetailsElement>("details.insp-section")].find(
    (d) => d.querySelector(".sec-title")?.textContent === "Insert FX",
  );

/** Pick an insert effect the way the inspector's own select does. */
export const pickInsertFx = (value: number): void => {
  const sel = insertFxSection()!.querySelector("select")!;
  sel.value = String(value);
  sel.dispatchEvent(new Event("change", { bubbles: true }));
};

/** Signal Type, whose STEREO option links the pair the insert FX then mirrors across. */
export const pickSignalType = (value: number): void => {
  const sel = paramRow("Signal Type").querySelector("select")!;
  sel.value = String(value);
  sel.dispatchEvent(new Event("change", { bubbles: true }));
};

/** Clip Safe, one of the head-amp values a linked pair does NOT share. */
export const clipSafeButton = (face: string): HTMLButtonElement =>
  [...paramRow("Clip Safe").querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === face)!;
export const clipSafeOnFace = (): string | undefined =>
  paramRow("Clip Safe").querySelector<HTMLButtonElement>("button.on")?.textContent ?? undefined;

/** PAN / BAL, the mode that decides which of the two pair mirrors runs. */
export const pickPanBal = (value: number): void => {
  const sel = paramRow("PAN / BAL").querySelector("select")!;
  sel.value = String(value);
  sel.dispatchEvent(new Event("change", { bubbles: true }));
};

/** Which face of the oscillator's ON toggle the inspector shows lit, with `bus.osc` already
 *  selected. The default plan has it OFF, and every unwritten address a stub answers 0 reads
 *  OFF too. */
export const oscFace = (): string | null | undefined =>
  row(t().inspector.oscOn).querySelector("button.on")?.textContent;
/** The same, selecting the node first. Two presses on one node inside the board's
 *  double-press window open its note editor, whose field then owns the Edit menu's undo, so a
 *  case that selects the node and then undoes reads through `oscFace` in between. */
export const oscOn = (): string | null | undefined => {
  selectNode("bus.osc");
  return oscFace();
};
/** Press the oscillator's ON face, selecting the node through a completed press first. */
export const pressOscOn = (): void =>
  [...paramRow(t().inspector.oscOn).querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => b.textContent === "ON")!
    .click();
export const turnOscOn = (): void => {
  selectNode("bus.osc");
  pressOscOn();
};

/** Undo from the application menu, and wait until the oscillator, selected already, shows
 *  `face`. */
export const undoTo = async (shell: TauriShell, face: string): Promise<void> => {
  expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID)).toBe(1);
  await vi.waitFor(() => expect(oscFace()).toBe(face), { timeout: 10_000 });
};

/** Which half of the bypass toggle is lit. The section holds one toggle group; the
 *  launcher beside it is a plain button and carries no `on`. */
export const insertFxOnFace = (): string | undefined =>
  insertFxSection()?.querySelector<HTMLElement>(".toggle button.on")?.textContent ?? undefined;

/** An insert effect whose sample-rate ceiling (96 kHz) a 192 kHz clock is above,
 *  which is what makes the unit drop it. */
export const COMPANDER_H = 1793;

/** Every value written to the insert-FX selector, in order. Read off the ledger by
 *  ADDRESS: a flush sends hundreds of writes, so counting `vd_set` cannot say whether
 *  this one went out, nor what it carried. */
export const insertFxWrites = (shell: TauriShell): number[] =>
  shell.invokes.flatMap((cmd, i) =>
    cmd === "vd_set" && shell.args[i]?.paramId === PARAMS.INSERT_FX.id ? [shell.args[i]!.value as number] : [],
  );

/** A unit left on NONE at STREAMING's source (705 / 706), a state its own list does not offer,
 *  as the table's seed. */
export const STREAMING_ON_NONE = { "705/0/0": 0xffffffff, "706/0/0": 0xffffffff };
/** STREAMING's DELAY time at its floor (1.00 ms), a value a write sends back as read — the
 *  table's own 0 is below it, and the write that lifts it names STREAMING for its DELAY. */
export const STREAMING_DELAY_AT_FLOOR = { "708/0/0": 100 };
/** STEREO, as the unit holds it at STREAMING's source. */
export const STREAMING_STEREO = [(0x80000000 | 256) >>> 0, (0x80000000 | 257) >>> 0];

/** Every write to STREAMING's source, as "param=value" in order. */
export const streamingWrites = (shell: TauriShell): string[] =>
  shell.invokes.flatMap((cmd, i) => {
    const a = shell.args[i];
    return cmd === "vd_set" && (a?.paramId === PARAMS.STREAM_SRC_L.id || a?.paramId === PARAMS.STREAM_SRC_R.id)
      ? [`${a.paramId}=${a.value}`]
      : [];
  });

/** The sources the board draws into STREAMING. */
export const streamingDrawn = (): string[] =>
  [...$("graph-host").querySelectorAll('.wire-hit[data-to="bus.stream:in"]')].map(
    (w) => (w as SVGElement).dataset.from ?? "",
  );

/** An FX channel's EFFECT TYPE chosen in the Inspector, which puts the incoming type's factory
 *  values in the plan, as every surface that chooses a type does. */
export const pickFxType = (id: string, value: number): void => {
  pressNode(id);
  const sel = paramRow(t().inspector.fxEffect.effectType).querySelector("select")!;
  sel.focus();
  sel.value = String(value);
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  sel.blur();
};

/** Undo the last edit through the app's Edit menu. */
export const undoEdit = (shell: TauriShell): void => {
  (document.activeElement as HTMLElement | null)?.blur();
  expect(shell.emit(EDIT_MENU_EVENT, EDIT_UNDO_ID), "the undo was taken").toBe(1);
};

/** Wait until the shell stops being asked anything, so what happens next is the only
 *  thing in flight. A count that has merely grown says nothing about WHOSE reads they
 *  were. */
export const quiet = async (shell: TauriShell): Promise<void> => {
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
