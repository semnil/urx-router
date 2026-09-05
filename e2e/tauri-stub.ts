import type { Page } from "@playwright/test";
import { SUPPORTED_SYSTEM_FIRMWARE } from "../src/core/control/firmware";
import type { ModelId } from "../src/models/types";

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
    // Every command the app asked for, in order. A spec that has to wait for a flow to
    // REACH a decision (a confirm raised, a check answered) has nothing else to wait on
    // here: a blind sleep is satisfied before the flow starts, so an absence asserted
    // after it is an absence of anything at all.
    const invokes: string[] = [];
    (window as unknown as { __urxInvokes: string[] }).__urxInvokes = invokes;
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      Channel: class {
        onmessage: (data: unknown) => void = () => {};
      },
      invoke: (cmd: string) => {
        invokes.push(cmd);
        return cmd in responses
          ? Promise.resolve(responses[cmd])
          : Promise.reject(new Error(`stub: unhandled command ${cmd}`));
      },
    };
  }, commands);
}

/**
 * The registrations a Live sync session makes on top of the reads: the notify
 * stream, the link watch and the meter stream. Without them the activation aborts
 * before the session counts as up, so pass them as `commands` in any spec that
 * turns Live sync on.
 */
export const LIVE_COMMANDS = {
  vd_params_subscribe: null,
  vd_params_unsubscribe: null,
  vd_watch_link: null,
  vd_meters_subscribe: null,
  vd_meters_unsubscribe: null,
  // The link ledger: read on every session teardown, appended to on an interval and
  // at the end. A session runs without them (the tracker treats an unreadable ledger
  // as a link that has gone), so they are here to exercise the real path rather than
  // to make one work. A spec asserting on the ledger overrides these.
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
  // Stamped onto every ledger line: `tauri dev` and the installed app share one file.
  app_build_kind: "dev",
};

/** A device-connected Tauri stub: the boot half above, plus a vd link whose reads
 *  the spec supplies and whose writes and dialogs it can inspect afterwards. */
export interface DeviceStubOptions {
  /** The model both halves report: the stored UI selection and what vd_connect
   *  answers. One option for both — a mismatch is refused before any read, so a
   *  spec wanting one sets `urx-model` itself in its own init script. */
  model?: ModelId;
  /** null = the firmware read did not land. Omitted = the verified version. */
  firmware?: string | null;
  /** Broker reads, by param id. Returning undefined falls through to `get`. */
  values?: Record<number, number>;
  /** Reject every vd_get not covered by `values` (a dead/failing link). */
  failReads?: boolean;
  /** What every confirm answers. Default "Cancel" — a spec that reaches one has
   *  usually already failed to abort. "Ok" for the specs whose subject is what
   *  happens AFTER the operator agrees. */
  confirm?: "Ok" | "Cancel";
  /** Extra constant command responses, as stubTauriBoot's `commands`. */
  commands?: Record<string, unknown>;
}

/**
 * Stub a connected device. Answers `vd_connect` / `vd_get` / `vd_set` and the
 * constant boot-time queries, records every write and every dialog message, and
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
      localStorage.setItem("urx-model", o.model ?? "URX44V");
      localStorage.setItem("urx-rate", "48000");
      localStorage.setItem("urx-disclaimer-accepted", "1"); // skip the consent gate
      const constants: Record<string, unknown> = {
        experimental_enabled: false,
        self_test_requested: false,
        reset_storage_requested: false,
        "plugin:updater|check": null,
        vd_disconnect: null,
        vd_get_str: "",
        ...(o.commands ?? {}),
      };
      const dialogs: string[] = [];
      const writes: Array<[number, number]> = [];
      const strWrites: Array<[number, number, string]> = [];
      const linkLog: string[] = [];
      // The device's numeric state, seeded from `values` and UPDATED by every write,
      // so a re-read answers what was written. Without that a converge loop
      // (client.ts sendConverging: send the diff, re-read, re-send whatever still
      // differs) sees an identical residual every round and re-sends it maxRounds
      // times — which makes any "how many commands went out" assertion a sample of a
      // transient instead of a settled write. Keyed by paramId alone, exactly as the
      // read half already was: one axis for both halves, or a write would be
      // invisible to the read that follows it.
      const values: Record<number, number> = { ...(o.values ?? {}) };
      const w = window as unknown as {
        __urxDialogs: string[];
        __urxWrites: Array<[number, number]>;
        __urxStrWrites: Array<[number, number, string]>;
        __urxLinkLog: string[];
        __urxInstance: Record<string, number>;
        __urxNotify: { onmessage: (batch: unknown) => void } | null;
      };
      w.__urxDialogs = dialogs;
      w.__urxWrites = writes;
      w.__urxStrWrites = strWrites;
      w.__urxLinkLog = linkLog;
      w.__urxNotify = null;
      // Per-instance state, empty until something writes. x/y default to 0 so a
      // scalar param has exactly one key whichever way it is addressed.
      const instance: Record<string, number> = {};
      w.__urxInstance = instance;
      const slotKey = (a?: Record<string, unknown>): string =>
        `${Number(a?.paramId)}:${Number(a?.x ?? 0)}:${Number(a?.y ?? 0)}`;
      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        Channel: class {
          onmessage: (data: unknown) => void = () => {};
        },
        invoke: (cmd: string, args?: Record<string, unknown>) => {
          if (cmd === "plugin:dialog|message") {
            dialogs.push(String(args?.message ?? ""));
            return Promise.resolve(o.confirm ?? "Cancel");
          }
          if (cmd === "vd_connect") {
            const model = o.model ?? "URX44V";
            return Promise.resolve({
              model,
              label: model,
              firmware: o.firmware,
              epoch: 1,
            });
          }
          // Reads and writes are addressed by (paramId, x, y), not by paramId alone.
          // A scalar param has one instance and never notices; an array does — the
          // six compander engine slots share id 689 and differ only in y, so a store
          // keyed by id collapses them onto one value. Written that way, a round that
          // set all six read back as five still differing, and the converging write
          // spent a second round chasing an artifact of this fixture rather than
          // anything the app or a real unit does.
          //
          // `values` from the spec stays keyed by paramId and seeds EVERY instance:
          // that is what a spec means by `{ 689: -1000 }`, and per-instance state only
          // starts existing once something writes it.
          if (cmd === "vd_get") {
            const at = instance[slotKey(args)];
            if (at !== undefined) return Promise.resolve(at);
            const v = values[Number(args?.paramId)];
            if (v !== undefined) return Promise.resolve(v);
            return o.failReads ? Promise.reject(new Error("read timeout")) : Promise.resolve(0);
          }
          if (cmd === "vd_set") {
            instance[slotKey(args)] = Number(args?.value);
            writes.push([Number(args?.paramId), Number(args?.value)]);
            return Promise.resolve(null);
          }
          // Recorded with its y: the string params that need it (CH SETTING names,
          // the user-defined knob triples) are addressed per instance, so a spec
          // asserting on them needs to see which slot was written.
          if (cmd === "vd_set_str") {
            strWrites.push([Number(args?.paramId), Number(args?.y), String(args?.value ?? "")]);
            return Promise.resolve(null);
          }
          // Recorded rather than answered from `constants`, because the ledger log is
          // a sequence: what matters is which lines a session wrote and in what order,
          // not that the append was accepted. The path still comes from `constants`.
          if (cmd === "append_link_log") {
            linkLog.push(String(args?.line ?? ""));
            return Promise.resolve(constants.append_link_log ?? "");
          }
          // Keep the notify stream's own channel: a change made on the unit's own panel
          // arrives through it, and it is the only way a spec can deliver one. Captured
          // beside the constant answer rather than instead of it, so a spec that never
          // registered the live commands still meets the same refusal it always did.
          if (cmd === "vd_params_subscribe") w.__urxNotify = args?.channel as typeof w.__urxNotify;
          return cmd in constants
            ? Promise.resolve(constants[cmd])
            : Promise.reject(new Error(`stub: unhandled command ${cmd}`));
        },
      };
    },
    { ...opts, firmware },
  );
}

/** Every command the stub was invoked with, in order (`stubTauriBoot` only). */
export const invokesOf = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __urxInvokes: string[] }).__urxInvokes);

/** Dialog messages the stub was asked to show, in order. */
export const dialogsOf = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __urxDialogs: string[] }).__urxDialogs);

/** Every vd_set_str the stub received, as [paramId, y, value]. */
export const strWritesOf = (page: Page): Promise<Array<[number, number, string]>> =>
  page.evaluate(() => (window as unknown as { __urxStrWrites: Array<[number, number, string]> }).__urxStrWrites);

/** Every vd_set the stub received, as [paramId, value]. */
export const writesOf = (page: Page): Promise<Array<[number, number]>> =>
  page.evaluate(() => (window as unknown as { __urxWrites: Array<[number, number]> }).__urxWrites);

/** Move one ADDRESS on the stubbed device, the way a hand on the unit's panel does.
 *  `values` seeds every instance of a param id at once, which cannot say that one
 *  channel holds a value and its neighbour does not — the two members of a mono pair
 *  differ only in y. */
export const setDeviceValue = (page: Page, paramId: number, y: number, value: number, x = 0): Promise<void> =>
  page.evaluate(
    ([id, xx, yy, v]) => {
      (window as unknown as { __urxInstance: Record<string, number> }).__urxInstance[`${id}:${xx}:${yy}`] = v;
    },
    [paramId, x, y, value],
  );

/** Announce a device-side parameter change through the session's notify stream — what
 *  the unit sends when one of its own controls is moved. Seed the address with
 *  `setDeviceValue` first: a change the app cannot read back is one the reconcile the
 *  notify schedules will undo.
 *
 *  Throws when no session registered the stream. Delivered to nothing, the call succeeds
 *  and a case waiting for the change times out reading as the feature being gone — and a
 *  case asserting that nothing happens passes for free. */
export const notifyParam = (page: Page, paramId: number, y: number, value: number, x = 0): Promise<void> =>
  page.evaluate(
    ([id, xx, yy, v]) => {
      const w = window as unknown as { __urxNotify: { onmessage: (batch: unknown) => void } | null };
      if (!w.__urxNotify) throw new Error("notifyParam: nothing subscribed to the notify stream");
      w.__urxNotify.onmessage([{ param_id: id, x: xx, y: yy, value: v }]);
    },
    [paramId, x, y, value],
  );

/** Every link-ledger line the stub was asked to append, in order (raw JSONL). */
export const linkLogOf = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __urxLinkLog: string[] }).__urxLinkLog);
