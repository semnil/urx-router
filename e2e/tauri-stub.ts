import type { Page } from "@playwright/test";
import { SUPPORTED_SYSTEM_FIRMWARE } from "../src/core/control/firmware";

/**
 * Boot-time Tauri IPC stub for desktop-only UI: seeds the language / model /
 * consent gate and answers the constant boot-time queries. `commands` extends
 * or overrides the responses per spec — values must be serializable constants.
 * For a spec that needs a connected device (reads, writes, dialogs), use
 * stubTauriDevice below. Specs needing genuinely stateful handlers (midi.spec.ts
 * captures the input channel and records sent bytes) keep their own stub.
 */
export async function stubTauriBoot(page: Page, commands: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript((extra) => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-model", "URX44V");
    localStorage.setItem("urx-disclaimer-accepted", "1"); // skip the consent gate
    const responses: Record<string, unknown> = {
      experimental_enabled: false,
      self_test_requested: false,
      reset_storage_requested: false,
      "plugin:updater|check": null,
      ...extra,
    };
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      Channel: class {
        onmessage: (data: unknown) => void = () => {};
      },
      invoke: (cmd: string) =>
        cmd in responses
          ? Promise.resolve(responses[cmd])
          : Promise.reject(new Error(`stub: unhandled command ${cmd}`)),
    };
  }, commands);
}

/** A device-connected Tauri stub: the boot half above, plus a vd link whose reads
 *  the spec supplies and whose writes and dialogs it can inspect afterwards. */
export interface DeviceStubOptions {
  /** null = the firmware read did not land. Omitted = the verified version. */
  firmware?: string | null;
  /** Broker reads, by param id. Returning undefined falls through to `get`. */
  values?: Record<number, number>;
  /** Reject every vd_get not covered by `values` (a dead/failing link). */
  failReads?: boolean;
  /** Extra constant command responses, as stubTauriBoot's `commands`. */
  commands?: Record<string, unknown>;
}

/**
 * Stub a connected device. Answers `vd_connect` / `vd_get` / `vd_set` and the
 * subscription commands, records every write and every dialog message, and
 * declines every confirm — a spec that reaches one has usually already failed to
 * abort, so agreeing would mask the thing under test. Use `writesOf` / `dialogsOf`
 * to read the record back.
 *
 * This exists because four specs had grown near-identical hand-rolled copies of it,
 * and adding one pre-read to the write path meant editing all of them.
 */
export async function stubTauriDevice(page: Page, opts: DeviceStubOptions = {}): Promise<void> {
  // Resolve the "omitted = verified version" default on the Node side so the stub
  // tracks the firmware gate (SUPPORTED_SYSTEM_FIRMWARE) automatically on a bump,
  // instead of hardcoding a version that drifts and trips the mismatch dialog.
  const firmware = opts.firmware === undefined ? SUPPORTED_SYSTEM_FIRMWARE : opts.firmware;
  await page.addInitScript(
    (o: DeviceStubOptions) => {
      localStorage.setItem("urx-lang", "en");
      localStorage.setItem("urx-model", "URX44V");
      localStorage.setItem("urx-rate", "48000");
      localStorage.setItem("urx-disclaimer-accepted", "1"); // skip the consent gate
      const constants: Record<string, unknown> = {
        experimental_enabled: false,
        self_test_requested: false,
        reset_storage_requested: false,
        "plugin:updater|check": null,
        vd_disconnect: null,
        vd_set_str: null,
        vd_get_str: "",
        vd_params_subscribe: null,
        vd_params_unsubscribe: null,
        vd_watch_link: null,
        ...(o.commands ?? {}),
      };
      const dialogs: string[] = [];
      const writes: Array<[number, number]> = [];
      const w = window as unknown as { __urxDialogs: string[]; __urxWrites: Array<[number, number]> };
      w.__urxDialogs = dialogs;
      w.__urxWrites = writes;
      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        Channel: class {
          onmessage: (data: unknown) => void = () => {};
        },
        invoke: (cmd: string, args?: Record<string, unknown>) => {
          if (cmd === "plugin:dialog|message") {
            dialogs.push(String(args?.message ?? ""));
            return Promise.resolve("Cancel");
          }
          if (cmd === "vd_connect") {
            return Promise.resolve({
              model: "URX44V",
              label: "URX44V",
              firmware: o.firmware,
              epoch: 1,
            });
          }
          if (cmd === "vd_get") {
            const v = o.values?.[Number(args?.paramId)];
            if (v !== undefined) return Promise.resolve(v);
            return o.failReads ? Promise.reject(new Error("read timeout")) : Promise.resolve(0);
          }
          if (cmd === "vd_set") {
            writes.push([Number(args?.paramId), Number(args?.value)]);
            return Promise.resolve(null);
          }
          return cmd in constants
            ? Promise.resolve(constants[cmd])
            : Promise.reject(new Error(`stub: unhandled command ${cmd}`));
        },
      };
    },
    { ...opts, firmware },
  );
}

/** Dialog messages the stub was asked to show, in order. */
export const dialogsOf = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __urxDialogs: string[] }).__urxDialogs);

/** Every vd_set the stub received, as [paramId, value]. */
export const writesOf = (page: Page): Promise<Array<[number, number]>> =>
  page.evaluate(() => (window as unknown as { __urxWrites: Array<[number, number]> }).__urxWrites);
