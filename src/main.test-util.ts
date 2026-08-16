// The app entry, booted whole against the real index.html markup — and, optionally,
// against a stubbed Tauri shell. Not a test file itself (vitest collects only
// *.test.ts), so the boot suites import it rather than re-declaring the setup.
//
// `main.ts` exports nothing and runs entirely as top-level side effects, so it can
// only be driven by importing it: one boot per test, with `vi.resetModules()` between
// them. Everything installed here is a global, which is why `restore()` exists and why
// every suite calls it in an afterEach.
//
// The Tauri half matters because `isTauri()` is what gates the whole device layer.
// Left undefined, `main.ts` runs its browser path and roughly half the module is
// unreachable — which is not "untested code", it is code no unit test could reach at
// all. `tauriShell()` installs the same two pieces `e2e/tauri-stub.ts` installs for the
// E2E tier (an `invoke` over a command table, and a `Channel` class), so the two tiers
// drive the same seam rather than two different inventions. It installs one more that the
// app tier's stub does not: a `transformCallback` that KEEPS what it is handed. That comes
// from `e2e/race/fake-device.ts`, which states the reason — without it `listenEvent`
// returns early — and the shell delivers drag & drop and the macOS Edit menu as events
// rather than as anything the DOM produces, so those flows are otherwise unreachable from
// a unit case. (In the ordinary E2E tier they are not even registered.)

import { vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SUPPORTED_SYSTEM_FIRMWARE } from "./core/control/firmware";

/** The app's real markup, so every getElementById in main.ts resolves the element it
 *  does in the browser rather than one a test invented. */
export const APP_BODY = readFileSync(resolve(process.cwd(), "index.html"), "utf8")
  .replace(/^[\s\S]*?<body[^>]*>/, "")
  .replace(/<\/body>[\s\S]*$/, "");

export const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
export const statusText = (): string => $("statusbar").textContent ?? "";

/**
 * The window a `vi.waitFor` over an app flow gets, in place of that helper's own 1000 ms
 * default. A gesture here runs the entry's real async chain — codec, storage, repaint —
 * and the wait measures the machine as much as the app: of the 106 waits the two entry
 * suites perform, the longest recorded across a warm, an oversubscribed and a cold-cache
 * run was 158 ms (2026-08-13), while the first run after a `pnpm install` starved one
 * past the default and reported it as the app not having acted.
 *
 * Kept well under `testTimeout` on purpose: a wait that gives up first fails with the
 * assertion that did not come true, which names the flow, where the test timeout that
 * would otherwise fire names only the case.
 */
export const APP_SETTLE = { timeout: 10_000 } as const;

export interface TauriShell {
  /** Every command the app invoked, in order — the only thing a flow that ends in an
   *  absence has to wait on. A blind sleep is satisfied before the flow starts. */
  invokes: string[];
  /** The arguments of each invoke, in the same order. */
  args: Array<Record<string, unknown> | undefined>;
  /** Answer `cmd` with `value` from now on (or a function of the arguments). */
  answer: (cmd: string, value: unknown | ((args: Record<string, unknown>) => unknown)) => void;
  /** Reject `cmd` once, then go back to whatever it answered before. */
  failOnce: (cmd: string, err: unknown) => void;
  /** Every Channel the app constructed, newest last — a command that streams (meters,
   *  notifies) takes one, and this is how a test pushes into it. */
  channels: Array<{ onmessage: (data: unknown) => void }>;
  /** How many times `cmd` was invoked. */
  count: (cmd: string) => number;
  /** Deliver a shell event to every handler the app registered for it, and answer how
   *  many handlers actually took it. The desktop shell intercepts drag & drop and the
   *  macOS Edit menu before the webview sees them, so those arrive as events rather than
   *  as anything the DOM can be made to produce — without this they are registered and
   *  unreachable, and a case can only assert the halves of those flows that a menu button
   *  also reaches.
   *
   *  The count answers ONE question: was anything listening. It cannot say the handler
   *  did anything, and it does not look at `payload` — a payload shaped wrong for the
   *  event still delivers and still counts, and the handler will read it as empty. A case
   *  whose outcome is an ABSENCE has to pin something else as well, or it passes on a
   *  delivery the app ignored. */
  emit: (event: string, payload?: unknown) => number;
}

/** The boot-time queries every launch answers, and the registrations a Live session
 *  makes. Kept as one table rather than two so a suite that turns Live on does not
 *  have to know which half a command belongs to. */
const BASE_COMMANDS: Record<string, unknown> = {
  experimental_enabled: false,
  self_test_requested: false,
  prepare_modified_requested: false,
  reset_storage_requested: false,
  casket_requested: false,
  "plugin:updater|check": null,
  app_build_kind: "dev",
  set_edit_menu_labels: null,
  set_edit_menu_state: null,
  "plugin:event|listen": 1,
  midi_ui_attach_main: null,
  midi_list_inputs: [],
  midi_list_outputs: [],
  midi_open_ports: [null, null],
  midi_window_open: false,
  keep_awake: null,
  // The MIDI trace's sink starts with the bridge, so a boot reaches it before any test
  // has done anything. Left untaught it would reject, and the sink's own give-up would
  // absorb the refusal this stub raises unknown commands to surface.
  append_midi_log: "",
};

/** One parameter instance's address, as the key of the store below. */
const addr = (a: Record<string, unknown>): string => `${a.paramId}/${a.x}/${a.y}`;

/**
 * A connected unit, on top of the boot table. **A write is readable afterwards**: the
 * unit keeps what was set to it and answers the next read with it, unwritten
 * addresses reading 0 (and "" for the string params). Without that a converging write
 * can never converge — it re-reads what it just sent, is answered 0, and spends every
 * round on a residual that is the stub's doing — so a case asserting "the write
 * succeeded" would in fact be running the non-convergence path and asserting that an
 * attempt was made.
 *
 * What the store deliberately does NOT model is the device's own behaviour: a
 * side-effect reset, a clamp, a value the unit refuses. Those belong to
 * `e2e/race/fake-device.ts`, and a second, thinner imitation of it here would be a
 * fixture that agrees with nothing.
 *
 * `firmware` defaults to the version the app accepts, read from the gate itself so a
 * bump does not silently start every case on the mismatch dialog.
 */
export function deviceCommands(over: Record<string, unknown> = {}): Record<string, unknown> {
  const values = new Map<string, number>();
  const strings = new Map<string, string>();
  return {
    vd_connect: { model: "URX44V", label: "URX44V", firmware: SUPPORTED_SYSTEM_FIRMWARE, epoch: 1 },
    vd_disconnect: null,
    vd_get: (a: Record<string, unknown>) => values.get(addr(a)) ?? 0,
    vd_get_str: (a: Record<string, unknown>) => strings.get(addr(a)) ?? "",
    vd_set: (a: Record<string, unknown>) => void values.set(addr(a), a.value as number),
    vd_set_str: (a: Record<string, unknown>) => void strings.set(addr(a), a.value as string),
    vd_params_subscribe: null,
    vd_params_unsubscribe: null,
    vd_meters_subscribe: null,
    vd_meters_unsubscribe: null,
    vd_watch_link: null,
    vd_link_stats: {
      sets: 0,
      gets: 0,
      param_subscribes: 0,
      meter_subscribes: 0,
      regist_frames: 0,
      unregist_frames: 0,
      deadlines: 0,
      stalled: 0,
    },
    append_link_log: "",
    // Every confirm declines by default. A case that reaches one has usually already
    // failed to abort, so agreeing would mask the thing under test.
    "plugin:dialog|message": "Cancel",
    ...over,
  };
}

/**
 * Install a stubbed Tauri shell on `window`. Unknown commands REJECT rather than
 * resolving undefined: a command nobody taught the stub about is a flow reaching
 * further than the test knows, and resolving it silently is how a case ends up
 * asserting on a half-run flow.
 */
export function tauriShell(commands: Record<string, unknown> = {}): TauriShell {
  const table: Record<string, unknown> = { ...BASE_COMMANDS, ...commands };
  const once = new Map<string, unknown>();
  const invokes: string[] = [];
  const args: Array<Record<string, unknown> | undefined> = [];
  const channels: TauriShell["channels"] = [];

  class Channel {
    onmessage: (data: unknown) => void = () => {};
    constructor() {
      channels.push(this);
    }
  }

  // The shell's event callbacks, kept rather than discarded. `listenEvent` hands the
  // function to `transformCallback` and then names the id it gets back when it registers,
  // so holding both halves is what makes an event deliverable at all.
  const callbacks = new Map<number, (message: unknown) => void>();
  const listeners = new Map<string, number[]>();
  let nextCallback = 1;

  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    Channel,
    transformCallback: (fn: (payload: unknown) => void) => {
      const id = nextCallback++;
      callbacks.set(id, fn as (message: unknown) => void);
      return id;
    },
    invoke: (cmd: string, a?: Record<string, unknown>) => {
      invokes.push(cmd);
      args.push(a);
      if (once.has(cmd)) {
        const err = once.get(cmd);
        once.delete(cmd);
        return Promise.reject(err);
      }
      if (!(cmd in table)) return Promise.reject(new Error(`stub: unhandled command ${cmd}`));
      // Below the two failure checks, not above them: a registration the shell refused
      // (`failOnce`, or a command nobody taught this stub about) leaves the app's own
      // `.catch` arm holding no handler, so recording it there and then delivering the
      // event would describe a state nothing produces. A table function that throws is
      // NOT covered by this — the recording is above the call — but nothing answers this
      // command with a function today.
      if (cmd === "plugin:event|listen" && typeof a?.event === "string" && typeof a.handler === "number") {
        listeners.set(a.event, [...(listeners.get(a.event) ?? []), a.handler]);
      }
      const v = table[cmd];
      if (typeof v !== "function") return Promise.resolve(v);
      // A table function that throws synchronously has to REJECT, not throw out of
      // `invoke`: the real IPC always returns a promise, so a caller that only attaches
      // `.catch` would survive the device and blow up here.
      try {
        return Promise.resolve((v as (x: Record<string, unknown>) => unknown)(a ?? {}));
      } catch (err) {
        return Promise.reject(err);
      }
    },
  };

  return {
    invokes,
    args,
    channels,
    answer: (cmd, value) => void (table[cmd] = value),
    failOnce: (cmd, err) => void once.set(cmd, err),
    count: (cmd) => invokes.filter((c) => c === cmd).length,
    emit: (event, payload) => {
      let delivered = 0;
      for (const id of listeners.get(event) ?? []) {
        const fn = callbacks.get(id);
        if (!fn) continue;
        // The shape `listenEvent` unwraps: it reads `.payload` off the message and hands
        // that to the app's handler.
        fn({ event, id, payload });
        delivered += 1;
      }
      // Deliveries, not registrations: the count exists so "nothing was listening" cannot
      // read as "the handler ran and did nothing", and a registration whose callback is
      // missing is the first of those wearing the shape of the second.
      return delivered;
    },
  };
}

export interface BootOptions {
  /** localStorage seeded before the module runs. */
  seed?: Record<string, string>;
  /** Install a stubbed Tauri shell (and return it from `bootApp`). */
  tauri?: Record<string, unknown> | false;
  /** The URL the app boots at, for the `?plan=` / `?reset` entries. */
  url?: string;
  /** Pre-accept the first-run consent gate (default). `false` boots UNACCEPTED, which
   *  is the only way to reach the gate: seeding cannot express it, because the
   *  pre-accept below writes the key after the seed. */
  consent?: boolean;
}

/** Install the markup and the globals, then run the module top to bottom. */
export async function bootApp(opts: BootOptions = {}): Promise<TauriShell | null> {
  document.body.innerHTML = APP_BODY; // innerHTML does not execute the <script type=module>
  localStorage.clear();
  localStorage.setItem("urx-lang", "en");
  localStorage.setItem("urx-model", "URX44V");
  // The consent gate is a desktop-only modal that blocks the device layer until it is
  // accepted. Pre-accepted here so a device case is not testing the gate by accident;
  // the gate's own cases pass `consent: false`.
  if (opts.consent !== false) localStorage.setItem("urx-disclaimer-accepted", "1");
  for (const [k, v] of Object.entries(opts.seed ?? {})) localStorage.setItem(k, v);
  if (opts.url) history.replaceState(null, "", opts.url);

  const shell = opts.tauri === false ? null : tauriShell(opts.tauri ?? {});

  vi.resetModules();
  await import("./main");
  // The board rather than the status line: a boot that lands on an error (a malformed
  // `?plan=`, say) never writes the "Loaded …" line, and waiting for it would time out
  // on exactly the case that wants testing.
  await vi.waitFor(() => {
    if (!$("graph-host").querySelector("svg")) throw new Error("board not painted");
  });
  return shell;
}

/** The globals jsdom does not provide and main.ts calls unguarded. */
export function installAppGlobals(): void {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }));
  // platform.confirmDialog / errorDialog fall back to these off Tauri, and jsdom's own
  // versions only log "not implemented".
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  vi.stubGlobal("alert", vi.fn());
  document.elementFromPoint = (() => null) as typeof document.elementFromPoint;
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
}

/** Undo everything `installAppGlobals` and `tauriShell` put on the page. */
export function restoreAppGlobals(): void {
  vi.unstubAllGlobals();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  document.body.replaceChildren();
  localStorage.clear();
  history.replaceState(null, "", "/");
}
