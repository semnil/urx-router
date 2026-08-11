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
// all. `tauriShell()` installs the same two pieces `e2e/tauri-stub.ts` installs for
// the E2E tier (an `invoke` over a command table, and a `Channel` class), so the two
// tiers drive the same seam rather than two different inventions.

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
};

/**
 * A connected unit, on top of the boot table. Reads answer 0 and writes are accepted,
 * which is enough for the entry's own wiring — which flow runs, what it reports, what
 * it locks while it holds the link. Fidelity beyond that (a converge round's residual,
 * a write that has to be readable afterwards) belongs to `e2e/race/fake-device.ts`,
 * whose per-instance value store exists for exactly that and is not worth a second
 * implementation here.
 *
 * `firmware` defaults to the version the app accepts, read from the gate itself so a
 * bump does not silently start every case on the mismatch dialog.
 */
export function deviceCommands(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vd_connect: { model: "URX44V", label: "URX44V", firmware: SUPPORTED_SYSTEM_FIRMWARE, epoch: 1 },
    vd_disconnect: null,
    vd_get: 0,
    vd_get_str: "",
    vd_set: null,
    vd_set_str: null,
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

  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    Channel,
    transformCallback: (fn: (payload: unknown) => void) => {
      void fn;
      return 1;
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
      const v = table[cmd];
      return Promise.resolve(typeof v === "function" ? (v as (x: Record<string, unknown>) => unknown)(a ?? {}) : v);
    },
  };

  return {
    invokes,
    args,
    channels,
    answer: (cmd, value) => void (table[cmd] = value),
    failOnce: (cmd, err) => void once.set(cmd, err),
    count: (cmd) => invokes.filter((c) => c === cmd).length,
  };
}

export interface BootOptions {
  /** localStorage seeded before the module runs. */
  seed?: Record<string, string>;
  /** Install a stubbed Tauri shell (and return it from `bootApp`). */
  tauri?: Record<string, unknown> | false;
  /** The URL the app boots at, for the `?plan=` / `?reset` entries. */
  url?: string;
}

/** Install the markup and the globals, then run the module top to bottom. */
export async function bootApp(opts: BootOptions = {}): Promise<TauriShell | null> {
  document.body.innerHTML = APP_BODY; // innerHTML does not execute the <script type=module>
  localStorage.clear();
  localStorage.setItem("urx-lang", "en");
  localStorage.setItem("urx-model", "URX44V");
  // The consent gate is a desktop-only modal that blocks the device layer until it is
  // accepted. Pre-accepted here so a device case is not testing the gate by accident;
  // the gate has cases of its own that clear this.
  localStorage.setItem("urx-disclaimer-accepted", "1");
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
