import type { Page } from "@playwright/test";

// Fake URX device for the live-sync race harness (docs/{en,ja}/live-race-harness.md).
//
// The existing e2e stubs resolve every command on the next microtask, so none of the
// windows the app's timing machinery opens (the 120 ms flush throttle, the 300 ms
// reconcile settle, the 900 ms idle net, a multi-second readback) exists under them —
// a race case run against those stubs is green for the wrong reason. This one has
// configurable per-command latency, a real state map, a scriptable notify stream,
// refusal injection and command barriers, and it timestamps every IPC in one ordered
// trace the analyzer reads.
//
// It is installed with addInitScript, so it is in place before the bundle resolves
// window.__TAURI_INTERNALS__ (src/core/platform.ts re-reads that global on every
// call, so nothing is captured early).
//
// It replaces __TAURI_INTERNALS__ wholesale, so the Rust bridge is not in its path:
// anything the bridge filters has to be reproduced here or a case measures a stimulus
// the shipped app cannot receive. `pushNotify` mirrors src-tauri/src/vd.rs
// `Subs::absorb` — a param notify reaches the frontend only while a subscription is
// installed and only for an address THIS session registered, plus the BULK_CHANGE
// sentinel, which belongs to no address and is the one update that bypasses the
// registered-set filter. Pinned on the Rust side by
// absorb_drops_notifies_for_addresses_this_session_did_not_register and
// absorb_forwards_the_bulk_change_notify_as_the_sentinel.
//
// `pushMeters` mirrors the other half of the same `absorb`: a meter reading reaches the
// frontend only while `meter_ch` is installed and only for a `(meter_id, x)` this
// session registered — there is no sentinel on the meter side. The same Rust test pins
// both halves: it asserts meter 115:1 is dropped and 115:0 delivered. The filter lives here
// rather than in each driver so an unreachable frame leaves a trace record instead of
// vanishing: a case that pushes an address nobody registered is measuring a feed the
// shipped app cannot receive, and the record is what says so.

export type TraceKind =
  "ipc-start" | "ipc-end" | "notify" | "notify-drop" | "meter-drop" | "status" | "mark" | "subscribe";

export interface TraceEvent {
  /** Monotonic. performance.now() ties are routine and order is the whole point. */
  seq: number;
  /** ms since the fake was installed. */
  t: number;
  kind: TraceKind;
  cmd?: string;
  /** "paramId:x:y" for the vd param commands. */
  addr?: string;
  value?: number;
  /** ipc-end only: the seq of its ipc-start. */
  of?: number;
  detail?: string;
}

export interface FakeLatency {
  connect: number;
  get: number;
  set: number;
  getStr: number;
  setStr: number;
  subscribe: number;
}

export interface FakeConfig {
  model: string;
  /** "" skips the firmware gate (src/core/control/firmware.ts). */
  firmware: string;
  latency: FakeLatency;
  /** ± ms of uniform jitter on every latency. Deterministic: seeded, not Math.random. */
  jitter: number;
  seed: number;
}

export const DEFAULT_LATENCY: FakeLatency = {
  connect: 0,
  get: 0,
  set: 0,
  getStr: 0,
  setStr: 0,
  subscribe: 0,
};

/** What the page-side fake exposes. Mirrored here so the specs are typed. */
export interface FakeHandle {
  cfg: FakeConfig;
  /** performance.now() at install; every trace `t` is relative to it. */
  t0: number;
  log: TraceEvent[];
  mem: Record<string, number>;
  /** The string half of the state map (vd_set_str / vd_get_str — channel names, Sweet
   *  Spot Data). Held apart from `mem` because the two are separate IPCs carrying
   *  separate value types, and a readback that answered "" whatever was written would
   *  make every full read erase a name the operator typed. */
  memStr: Record<string, string>;
  /** Addresses the app last registered for param notifies — the follow registration
   *  set, readable with no probe into the app's own module scope. */
  paramAddrs: Array<[number, number, number]>;
  meterAddrs: Array<[number, number]>;
  counters: { subscribes: number; unsubscribes: number; meterSubs: number; meterUnsubs: number; connects: number };
  /** Addresses whose read answers this value whatever was written ("the device holds X"). */
  diverge: Record<string, number>;
  /** The same hook on the string path: what `vd_get_str` answers whatever was written.
   *  A rename made on the unit's own LCD is exactly this — the device holds a name the
   *  app never wrote, and only a read can discover it. */
  divergeStr: Record<string, string>;
  /** Reject the nth (1-based) matching command. */
  refusals: Array<{ cmd: string; nth: number; kind: "transport" | "code400"; hit: number }>;
  /** Accept and discard: the write is acked but never stored. */
  ignoreWrites: number[];
  deviceLost: boolean;
  /** Native dialog messages the app asked to show, and the button the fake answers
   *  with. The default declines, so a flow that reaches a confirm has usually already
   *  failed to refuse — agreeing would mask what is under test. */
  dialogs: string[];
  dialogAnswer: string;
  /** The second operator. `sent` is the outgoing feedback byte log. */
  midi: {
    inputs: string[];
    outputs: string[];
    inPort: string | null;
    outPort: string | null;
    inChannel: { onmessage: (b: unknown[]) => void } | null;
    sent: number[][];
  };
  /** Deliver raw MIDI messages as one batched burst, the way the bridge does. */
  pushMidi: (msgs: number[][]) => void;
  /** Emit a menu://edit event ("edit-undo" / "edit-redo"), the macOS Edit menu's path. */
  pushMenu: (which: string) => void;
  setLatency: (patch: Partial<FakeLatency>) => void;
  mark: (detail: string) => void;
  /** Push device-side param notifies through the bridge's filter. Returns one verdict
   *  per entry, in order: "" for a delivered one, the refusal reason for a dropped one. */
  pushNotify: (list: Array<[number, number, number, number]>) => string[];
  /** The address-free bulk-change sentinel — the one notify that bypasses the filter,
   *  and so the sanctioned way to force one whole-device reconcile. */
  pushBulkChange: () => string[];
  /** Push level-meter readings through the bridge's registered-set filter. Returns one
   *  verdict per frame, in order: "" for a delivered one, the refusal reason for a
   *  dropped one. Only the dropped frames are traced — a real feed is continuous, and a
   *  record per reading would bury the trace the analyzer reads. */
  pushMeters: (list: Array<[number, number, number]>) => string[];
  /** Hold the nth matching command until release(); the barrier is what makes
   *  "the edit lands at read #17" exact rather than statistical. There is one slot:
   *  re-arming over a barrier that is already holding a command throws, because that
   *  command holds the worker queue and nothing could ever open its gate again. */
  blockAt: (cmd: string, nth: number) => void;
  release: () => void;
  blocked: () => boolean;
  linkDrop: (reason: string) => void;
}

declare global {
  interface Window {
    __urxFake: FakeHandle;
  }
}

export interface InstallOptions {
  model?: string;
  firmware?: string;
  latency?: Partial<FakeLatency>;
  jitter?: number;
  seed?: number;
  /** Extra localStorage seeding, applied after the defaults. */
  storage?: Record<string, string>;
}

export async function installFake(page: Page, opts: InstallOptions = {}): Promise<void> {
  const cfg: FakeConfig = {
    model: opts.model ?? "URX44V",
    firmware: opts.firmware ?? "",
    latency: { ...DEFAULT_LATENCY, ...(opts.latency ?? {}) },
    jitter: opts.jitter ?? 0,
    seed: opts.seed ?? 1,
  };
  await page.addInitScript(
    ([config, storage]: [FakeConfig, Record<string, string>]) => {
      localStorage.setItem("urx-lang", "en");
      localStorage.setItem("urx-theme", "dark");
      localStorage.setItem("urx-model", config.model);
      localStorage.setItem("urx-rate", "48000");
      localStorage.setItem("urx-disclaimer-accepted", "1");
      for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);

      const t0 = performance.now();
      let seq = 0;
      const log: TraceEvent[] = [];
      const put = (kind: TraceKind, extra: Partial<TraceEvent> = {}): number => {
        const s = ++seq;
        log.push({ seq: s, t: +(performance.now() - t0).toFixed(3), kind, ...extra });
        return s;
      };

      // Deterministic jitter: a workflow-safe LCG, so a ladder re-run lands on the
      // same offsets. Math.random would make a confirmed firing unreproducible.
      let rngState = config.seed >>> 0;
      const rnd = (): number => {
        rngState = (rngState * 1664525 + 1013904223) >>> 0;
        return rngState / 4294967296;
      };
      const wait = (ms: number): Promise<void> => {
        const j = config.jitter ? (rnd() * 2 - 1) * config.jitter : 0;
        const d = Math.max(0, ms + j);
        return d === 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, d));
      };

      let barrier: { cmd: string; nth: number; hit: number; gate: Promise<void>; open: () => void } | null = null;

      // vd.rs BULK_CHANGE. The comparison there is a derived PartialEq over all four
      // fields, so (0,-1,-1) carrying a non-zero value is NOT the sentinel.
      const BULK: [number, number, number, number] = [0, -1, -1, 0];
      // The registered set as vd.rs holds it: ParamsSubscribe replaces it wholesale.
      // Divergence kept, vd.rs:429/446-454: absorb batches notifies and flushes on the
      // PUMP_BUDGET cadence, so a push here reaches the app one batch earlier than it
      // would through the bridge. Nothing is ever pending in the fake, which is also
      // why `subs.params.clear()` (vd.rs:611) has no counterpart below.
      let registered = new Set<string>();
      const notifyRefusal = (id: number, x: number, y: number, v: number): string => {
        if (!paramChannel) return "no-subscription";
        if (id === BULK[0] && x === BULK[1] && y === BULK[2] && v === BULK[3]) return "";
        return registered.has(`${id}:${x}:${y}`) ? "" : "unregistered";
      };
      // The registered meter set, held the same way: MetersSubscribe replaces it
      // wholesale. No sentinel here — every meter frame carries an address.
      let registeredMeters = new Set<string>();
      const meterRefusal = (id: number, x: number): string => {
        if (!meterChannel) return "no-subscription";
        return registeredMeters.has(`${id}:${x}`) ? "" : "unregistered";
      };

      let callbackSeq = 0;
      const callbacks = new Map<number, (p: unknown) => void>();
      const listeners = new Map<string, (p: unknown) => void>();

      const fake: FakeHandle = {
        cfg: config,
        t0,
        log,
        mem: {},
        memStr: {},
        paramAddrs: [],
        meterAddrs: [],
        counters: { subscribes: 0, unsubscribes: 0, meterSubs: 0, meterUnsubs: 0, connects: 0 },
        diverge: {},
        divergeStr: {},
        refusals: [],
        ignoreWrites: [],
        deviceLost: false,
        dialogs: [],
        dialogAnswer: "Cancel",
        midi: { inputs: ["Fake In"], outputs: ["Fake Out"], inPort: null, outPort: null, inChannel: null, sent: [] },
        pushMidi: (msgs) => {
          for (const bytes of msgs) put("notify", { cmd: "midi", detail: bytes.join(" ") });
          fake.midi.inChannel?.onmessage(msgs.map((bytes) => ({ bytes })));
        },
        pushMenu: (which) => {
          put("mark", { detail: `menu:${which}` });
          listeners.get("menu://edit")?.({ event: "menu://edit", id: 0, payload: which });
        },
        setLatency: (patch) => Object.assign(config.latency, patch),
        mark: (detail) => void put("mark", { detail }),
        pushNotify: (list) => {
          // absorb() filters ENTRIES, not frames: a batch carrying one registered and
          // one unregistered address delivers the first and drops the second.
          const why: string[] = [];
          const passed: Array<{ param_id: number; x: number; y: number; value: number }> = [];
          for (const [param_id, x, y, value] of list) {
            const w = notifyRefusal(param_id, x, y, value);
            why.push(w);
            put(w ? "notify-drop" : "notify", {
              addr: `${param_id}:${x}:${y}`,
              value,
              detail: w || undefined,
            });
            if (!w) passed.push({ param_id, x, y, value });
          }
          if (passed.length) paramChannel?.onmessage(passed);
          return why;
        },
        pushBulkChange: () => fake.pushNotify([[BULK[0], BULK[1], BULK[2], BULK[3]]]),
        pushMeters: (list) => {
          // absorb() filters readings one by one, exactly as it does notifies: a batch
          // carrying one registered and one unregistered address delivers the first and
          // drops the second.
          const why: string[] = [];
          const passed: Array<{ meter_id: number; x: number; value: number }> = [];
          for (const [meter_id, x, value] of list) {
            const w = meterRefusal(meter_id, x);
            why.push(w);
            if (w) put("meter-drop", { addr: `${meter_id}:${x}`, value, detail: w });
            else passed.push({ meter_id, x, value });
          }
          if (passed.length) meterChannel?.onmessage(passed);
          return why;
        },
        blockAt: (cmd, nth) => {
          // One slot, and re-arming it drops the previous resolver. A command already
          // suspended on that gate would then wait for ever — it also holds the worker
          // queue, so the whole link stops — and release() could only open the new
          // barrier. Refusing at the call site turns a permanent hang far from its cause
          // into an error naming the barrier that was still holding something.
          if (barrier && barrier.hit >= barrier.nth) {
            throw new Error(
              `fake: blockAt(${cmd}, ${nth}) re-arms over a barrier still holding ${barrier.cmd} #${barrier.nth} — release() it first`,
            );
          }
          let open = (): void => {};
          const gate = new Promise<void>((r) => (open = r));
          barrier = { cmd, nth, hit: 0, gate, open };
        },
        release: () => {
          barrier?.open();
          barrier = null;
        },
        blocked: () => barrier !== null && barrier.hit >= barrier.nth,
        linkDrop: (reason) => linkCb?.({ reason }),
      };
      window.__urxFake = fake;

      let paramChannel: { onmessage: (b: unknown[]) => void } | null = null;
      let meterChannel: { onmessage: (b: unknown[]) => void } | null = null;
      let linkCb: ((e: { reason: string }) => void) | null = null;

      /** Replace a subscription — the assignments vd.rs makes at the tail of its
       *  ParamsSubscribe / MetersSubscribe handler. Called from the queue point. */
      const install = (cmd: string, args: Record<string, unknown>): void => {
        const channel = args.channel as { onmessage: (b: unknown[]) => void };
        if (cmd === "vd_params_subscribe") {
          fake.counters.subscribes++;
          fake.paramAddrs = args.addrs as Array<[number, number, number]>;
          registered = new Set(fake.paramAddrs.map((a) => a.join(":")));
          paramChannel = channel;
          put("subscribe", { cmd, detail: String(fake.paramAddrs.length) });
        } else {
          fake.counters.meterSubs++;
          fake.meterAddrs = args.addrs as Array<[number, number]>;
          registeredMeters = new Set(fake.meterAddrs.map((a) => a.join(":")));
          meterChannel = channel;
        }
      };

      /** Drop everything the worker owned. vd.rs:494 keeps the whole `Subs` — both
       *  channels and both registered sets — inside the worker, and vd.rs:498 the link
       *  watch, so a Shutdown (vd.rs:516) takes all four with it: nothing can be
       *  delivered on that generation again. The fake's gate would otherwise be "the app
       *  called unsubscribe" where the bridge's is "the worker is alive" — and the app's
       *  unsubscribe is fire-and-forget (src/core/platform.ts:343), so the two differ by
       *  a real window. The two address sets are kept for the reason
       *  vd_params_unsubscribe gives below: they are the harness's "last registered"
       *  observable, read by spec sites after a session ends. */
      const teardown = (): void => {
        paramChannel = null;
        meterChannel = null;
        registered.clear();
        registeredMeters.clear();
        linkCb = null;
      };

      // The status line is one of the four observables that survive a production
      // build, and it is where the app names a follow ("← device") and a flush.
      const watchStatus = (): void => {
        const sb = document.getElementById("statusbar");
        if (!sb) return void setTimeout(watchStatus, 20);
        new MutationObserver(() => put("status", { detail: sb.textContent ?? "" })).observe(sb, {
          childList: true,
          characterData: true,
          subtree: true,
        });
      };
      watchStatus();

      const key = (a: Record<string, unknown>): string => `${a.paramId}:${a.x}:${a.y}`;

      // `nth` counts EVERY call of that command, refused ones included, so two refusals
      // stacked on one command fire on the calls their numbers name. Returning at the
      // first match instead left the later entries un-incremented, which slid each of
      // them one call further out per refusal already spent: refuseAt(cmd, 1) +
      // refuseAt(cmd, 3) fired on calls 1 and 4.
      const refusalFor = (cmd: string): "transport" | "code400" | null => {
        let kind: "transport" | "code400" | null = null;
        for (const r of fake.refusals) {
          if (r.cmd !== cmd) continue;
          r.hit++;
          if (r.hit === r.nth && kind === null) kind = r.kind;
        }
        return kind;
      };

      // ONE worker, the way the bridge has one. vd.rs:504-556 is a single thread taking
      // Cmds off one channel and answering each with a blocking address-matched round
      // trip before it takes the next, so the shipped bridge cannot resolve a later cheap
      // command ahead of an earlier expensive one, and a slow command is backpressure on
      // every subsystem queued behind it. A per-command setTimeout produced exactly that
      // impossible ordering: at get 25 / set 60, a read issued 5 ms after a write resolved
      // 30 ms before it, and the read's continuation ran while the write's was still
      // pending — an interleaving no case could ever see on hardware.
      //
      // Only the RESOLUTION is serialized. Every queue-point effect stays at the issue
      // instant (a read is answered when issued, a write applies when issued): that is the
      // documented contract and the reason an overtake is reachable at all.
      //
      // vd_connect is deliberately outside the queue — it INSTALLS the worker
      // (vd.rs:193-200, where install() shuts the prior one down) rather than running on
      // one, so it cannot queue behind the work it replaces. So is everything the shell
      // routes elsewhere: the dialog plugin, the MIDI commands (midi.rs touches local OS
      // APIs on the caller's thread) and the menu pushes share no queue with the vd worker.
      const onWorker = (cmd: string): boolean => cmd.startsWith("vd_") && cmd !== "vd_connect";
      /** What `handle` settled at the queue point and `serve` answers with. */
      interface Served {
        done: (detail?: string) => void;
        sampled: number;
        sampledStr: string;
        held: Promise<void> | null;
      }
      let workQueue: Promise<void> = Promise.resolve();
      const enqueue = (run: () => Promise<unknown>): Promise<unknown> => {
        const next = workQueue.then(run);
        workQueue = next.then(
          () => {},
          () => {},
        );
        return next;
      };

      function handle(cmd: string, args: Record<string, unknown>): Promise<unknown> {
        const isAddr = cmd === "vd_get" || cmd === "vd_set" || cmd === "vd_get_str" || cmd === "vd_set_str";
        const start = put("ipc-start", {
          cmd,
          addr: isAddr ? key(args) : undefined,
          value: cmd === "vd_set" ? Number(args.value) : undefined,
        });
        const done = (detail?: string): void => void put("ipc-end", { cmd, of: start, detail });

        // Queue-point effects, taken before the barrier and before the latency: the
        // broker is an in-order queue, so a read issued before a write is answered
        // before that write is applied. Sampling at the resolve instead would make
        // every held read answer post-edit values and hide the race the barrier exists
        // to place exactly.
        let sampled = 0;
        let sampledStr = "";
        if (cmd === "vd_get") {
          const k = key(args);
          sampled = k in fake.diverge ? fake.diverge[k] : (fake.mem[k] ?? 0);
        } else if (cmd === "vd_get_str") {
          // The string path has a state map of its own, for the reason the numeric one
          // has: a fake that answered "" whatever was written would make every full
          // readback erase a non-empty name and every diffNames report one, so a case
          // could not tell the app clearing a name from the fake never holding it.
          const k = key(args);
          sampledStr = k in fake.divergeStr ? fake.divergeStr[k] : (fake.memStr[k] ?? "");
        } else if (cmd === "vd_set" && !fake.ignoreWrites.includes(Number(args.paramId))) {
          fake.mem[key(args)] = Number(args.value);
        } else if (cmd === "vd_set_str" && !fake.ignoreWrites.includes(Number(args.paramId))) {
          fake.memStr[key(args)] = String(args.value ?? "");
        } else if (cmd === "vd_params_unsubscribe" || cmd === "vd_meters_unsubscribe") {
          // A teardown is a queue-point effect for the same reason an install is, and it
          // matters more: vd.rs's `param_ch = None` / `meter_ch = None` (vd.rs:586/619)
          // run inside the worker whatever the LINK is doing, so a channel is dropped
          // even when the command that dropped it answers an error. Left at the resolve,
          // behind the device-lost latch, a session torn down over a dead link kept both
          // channels installed here and a later pushNotify / pushMeters was DELIVERED
          // into it — so every "nothing arrives after teardown" verdict was measuring the
          // fake. The command may still reject below; the effect has already happened.
          if (cmd === "vd_params_unsubscribe") {
            fake.counters.unsubscribes++;
            // vd.rs:619 also does param_addrs.clear(). Deliberately not mirrored:
            // fake.paramAddrs is the harness's "addresses the app LAST registered"
            // observable, read by ~80 spec sites after a session ends, and the
            // no-subscription refusal is decided from paramChannel alone.
            paramChannel = null;
          } else {
            fake.counters.meterUnsubs++;
            // vd.rs:586 also does meter_addrs.clear(). Not mirrored, same reason.
            meterChannel = null;
          }
        } else if (cmd === "vd_disconnect") {
          // vd.rs:339-346 — disconnect names one generation, and a delayed teardown of a
          // superseded session is a no-op, so it cannot close the connection a later
          // activation opened. At the queue point, like the unsubscribes above: Cmd::
          // Shutdown drops the whole Subs with the worker however the link is behaving.
          if (Number(args.epoch ?? 0) === fake.counters.connects) teardown();
        } else if (cmd === "vd_params_subscribe" || cmd === "vd_meters_subscribe") {
          // A subscription is installed at the queue point too, and for the same reason.
          // vd.rs:590-613 / 559-580: the handler only SENDS registrations (reg_param /
          // reg_meter are fire-and-forget — the reply is drained later by pump,
          // vd.rs:995-1038), so it performs no socket read and `absorb` cannot run
          // inside it. A notify arriving while a registration is in flight is therefore
          // evaluated afterwards, against the NEW set and through the NEW channel.
          // Installing at the resolve instead would judge it by the OLD set and deliver
          // it to the OLD channel — wrong in both directions, and reachable through a
          // barrier on the command or a scripted `subscribe` latency.
          //
          // Unconditional, ahead of the device-lost and refusal branches below: the two
          // assignments run after the registration loop whatever it returned, and the
          // failure travels back through `reply` alone (vd.rs:601-613), so a refused
          // subscribe still replaces the subscription rather than leaving the previous
          // one installed.
          install(cmd, args);
        }

        // Counted at the queue point, where the command joins the worker's queue, and
        // AWAITED in `serve` below. The count belongs here so `blocked()` reports the hit
        // at the instant the case's gesture produced it; the wait belongs there so a held
        // command holds the QUEUE, which is what the one worker thread does with a round
        // trip it is still inside.
        let held: Promise<void> | null = null;
        if (barrier && barrier.cmd === cmd) {
          barrier.hit++;
          if (barrier.hit >= barrier.nth) held = barrier.gate;
        }

        const ctx: Served = { done, sampled, sampledStr, held };
        return onWorker(cmd) ? enqueue(() => serve(cmd, args, ctx)) : serve(cmd, args, ctx);
      }

      /** Everything that happens once the worker has TAKEN the command: the barrier it
       *  may be held on, the two latches, and the reply. Split from `handle` so the
       *  queue-point effects stay at the issue instant while this half is what the one
       *  worker serializes. */
      async function serve(cmd: string, args: Record<string, unknown>, ctx: Served): Promise<unknown> {
        const { done, sampled, sampledStr } = ctx;
        if (ctx.held) await ctx.held;

        // Both latches are read where the worker reads them: as it takes the command off
        // the queue (vd.rs:518-556, `guard(&mut lost, …)` inside the loop), not as the
        // app issues it.
        if (fake.deviceLost && cmd.startsWith("vd_")) {
          await wait(config.latency.get);
          done("device-lost");
          throw new Error("device lost");
        }
        const refuse = refusalFor(cmd);
        if (refuse) {
          await wait(cmd === "vd_set" ? config.latency.set : config.latency.get);
          done(refuse);
          throw new Error(refuse === "code400" ? "broker response 400" : "transport error");
        }

        switch (cmd) {
          case "experimental_enabled":
          case "self_test_requested":
          case "reset_storage_requested":
            done();
            return false;
          case "plugin:updater|check":
            done();
            return null;
          case "plugin:dialog|message":
            fake.dialogs.push(String(args.message ?? ""));
            done(String(args.message ?? ""));
            return fake.dialogAnswer;
          case "plugin:dialog|open":
          case "plugin:dialog|save":
            done();
            return null;
          case "midi_list_inputs":
            done();
            return fake.midi.inputs;
          case "midi_list_outputs":
            done();
            return fake.midi.outputs;
          case "midi_open_input":
            fake.midi.inPort = String(args.port ?? "");
            fake.midi.inChannel = args.channel as { onmessage: (b: unknown[]) => void };
            done(fake.midi.inPort);
            return null;
          case "midi_close_input":
            // The channel goes with the port. midi.rs:105-107 drops the midir
            // connection, and delivery ends with it; leaving inChannel installed let
            // pushMidi reach a handler the app had already closed the input on.
            fake.midi.inPort = null;
            fake.midi.inChannel = null;
            done();
            return null;
          case "midi_open_output":
            fake.midi.outPort = String(args.port ?? "");
            done(fake.midi.outPort);
            return null;
          case "midi_close_output":
            fake.midi.outPort = null;
            done();
            return null;
          case "midi_send":
            fake.midi.sent.push([...((args.bytes as number[]) ?? [])]);
            done();
            return null;
          case "set_edit_menu_state":
          case "set_edit_menu_labels":
          case "set_keep_awake":
          case "third_party_licenses":
            done(cmd === "set_edit_menu_state" ? `${args.canUndo}/${args.canRedo}` : undefined);
            return cmd === "third_party_licenses" ? "" : null;
          case "vd_connect":
            await wait(config.latency.connect);
            // vd.rs:193-200 — install() shuts any prior worker down, so the new
            // generation starts from a fresh Subs rather than inheriting the old one's
            // channels and registrations.
            teardown();
            fake.counters.connects++;
            done();
            return { model: config.model, label: "Fake URX", firmware: config.firmware, epoch: fake.counters.connects };
          case "vd_disconnect":
            // The epoch-matched teardown ran at the queue point; only the reply is
            // outstanding here.
            //
            // Divergence kept, vd.rs:206-215: `sender()` errors with "not-connected"
            // once the connection is taken, so every vd command after this one fails at
            // the bridge. The fake keeps answering them, because what the teardown cases
            // measure is WHICH commands the app still issues after its own teardown
            // (t5's escaping-writes ladder); failing them would replace that measurement
            // with an error cascade.
            done(String(args.epoch ?? ""));
            return null;
          case "vd_get":
            await wait(config.latency.get);
            done();
            return sampled;
          case "vd_get_str":
            // Sampled at the queue point from the string state map, like vd_get.
            await wait(config.latency.getStr);
            done();
            return sampledStr;
          case "vd_set":
            await wait(config.latency.set);
            done();
            return null;
          case "vd_set_str":
            await wait(config.latency.setStr);
            done();
            return null;
          case "vd_params_subscribe":
            // Installed at the queue point; only the reply is outstanding here.
            await wait(config.latency.subscribe);
            done();
            return null;
          case "vd_params_unsubscribe":
            // The channel was dropped at the queue point; only the reply is outstanding.
            done();
            return null;
          case "vd_meters_subscribe":
            // Installed at the queue point; only the reply is outstanding here.
            await wait(config.latency.subscribe);
            done();
            return null;
          case "vd_meters_unsubscribe":
            // The channel was dropped at the queue point; only the reply is outstanding.
            done();
            return null;
          case "vd_watch_link":
            done();
            return null;
          default:
            done("unhandled");
            throw new Error(`fake: unhandled command ${cmd}`);
        }
      }

      class Channel {
        onmessage: (data: unknown) => void = () => {};
      }
      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        Channel,
        // The event plugin: without transformCallback, listenEvent returns early and
        // dropzone.ts registers no DOM handlers either, so a drop is unreachable from
        // both directions and menu://edit never fires.
        transformCallback: (cb: (p: unknown) => void) => {
          const id = ++callbackSeq;
          callbacks.set(id, cb);
          return id;
        },
        invoke: (cmd: string, args?: Record<string, unknown>) => {
          // listenEvent wraps the handler so it receives `{ payload }`; store the
          // resolved callback per event name so pushMenu / a drop can fire it.
          if (cmd === "plugin:event|listen") {
            const cb = callbacks.get(args?.handler as number);
            if (cb) listeners.set(String(args?.event), cb);
            return Promise.resolve(0);
          }
          if (cmd === "vd_watch_link") {
            const ch = args?.channel as { onmessage: (d: unknown) => void } | undefined;
            if (ch) linkCb = (e) => ch.onmessage(e);
          }
          return handle(cmd, args ?? {});
        },
      };
    },
    [cfg, opts.storage ?? {}] as [FakeConfig, Record<string, string>],
  );
}

/** Bring a live session up, then hand the fake its scripted latency. The initial
 *  readback is ~800 sequential reads: at a scripted latency it would take minutes,
 *  so the session is established at zero latency and the profile applied after. */
export async function goLive(page: Page, latency: Partial<FakeLatency> = {}): Promise<void> {
  await page.click("#btn-device");
  await page.click("#btn-live");
  // Attached, not visible: the click closes the Device menu, so the toggle that
  // carries the session state is hidden by the time it flips.
  await page.waitForSelector('#btn-live[aria-pressed="true"]', { state: "attached", timeout: 30_000 });
  if (Object.keys(latency).length) await setLatency(page, latency);
}

export const setLatency = (page: Page, patch: Partial<FakeLatency>): Promise<void> =>
  page.evaluate((p) => window.__urxFake.setLatency(p), patch);

/**
 * Wait until the device link has been silent for `quiet` ms. Every case ends by
 * asking whether something reached the device, and a fixed sleep answers "no" for a
 * sweep that simply had not finished — a false lost-edit finding. Waiting on the
 * trace's own silence makes the verdict a property of the app rather than of the
 * driver's patience.
 *
 * **Silence is also true before anything has started.** Called straight after a
 * gesture this returns immediately: the flush is still inside its 120 ms window and a
 * settle inside its 300 ms one, so nothing has been emitted *yet*. Any case whose
 * verdict is an ABSENCE ("no write ever left") must use `settleAfter` instead, which
 * waits for the link to wake up first.
 */
export async function waitQuiet(page: Page, quiet = 900, cap = 60_000): Promise<void> {
  const until = Date.now() + cap;
  for (;;) {
    const last = await page.evaluate(() => {
      const f = window.__urxFake;
      const now = performance.now() - f.t0;
      for (let i = f.log.length - 1; i >= 0; i--) {
        const e = f.log[i];
        if (e.kind === "ipc-start" || e.kind === "ipc-end") return now - e.t;
      }
      return Number.POSITIVE_INFINITY;
    });
    if (last >= quiet || Date.now() > until) return;
    await page.waitForTimeout(Math.min(quiet, 200));
  }
}

export const mark = (page: Page, detail: string): Promise<void> =>
  page.evaluate((d) => window.__urxFake.mark(d), detail);

/**
 * The BULK_CHANGE sentinel the unit emits on a scene recall: no address, no value, and
 * therefore no node — `follow.lookup` returns undefined and the settle escalates to a
 * re-read of the whole device. The largest event the link can deliver. src-tauri/src/vd.rs
 * forwards it whatever is registered, so it is also the only stimulus that forces a
 * whole-device reconcile without depending on the current registration.
 */
export const BULK_CHANGE: [number, number, number, number] = [0, -1, -1, 0];

/**
 * Push device-side notifies through the bridge's registered-set filter. Resolves to one
 * verdict per entry: "" delivered, "unregistered" / "no-subscription" refused. A refused
 * stimulus leaves the app in exactly the state it was in, which is indistinguishable
 * from "nothing has happened yet" — use `pushNotifyDelivered` whenever the case's
 * subject is the app's RESPONSE.
 */
export const pushNotify = (page: Page, list: Array<[number, number, number, number]>): Promise<string[]> =>
  page.evaluate((l) => window.__urxFake.pushNotify(l), list);

/** Push notifies and throw if the bridge refused any of them, naming the addresses.
 *  Thrown at the push rather than asserted downstream, so a case that measures nothing
 *  says so where the mistake is instead of failing as a count mismatch later. */
export async function pushNotifyDelivered(page: Page, list: Array<[number, number, number, number]>): Promise<void> {
  const why = await pushNotify(page, list);
  const refused = list.map((n, i) => [n, why[i]] as const).filter(([, w]) => w);
  if (refused.length) {
    throw new Error(
      `the fake bridge refused ${refused.length} notify/notifies the case needs delivered: ${refused
        .map(([n, w]) => `${n[0]}:${n[1]}:${n[2]} (${w})`)
        .join(", ")}`,
    );
  }
}

/** Force one whole-device reconcile the way a scene recall does. */
export const pushBulkChange = (page: Page): Promise<string[]> => page.evaluate(() => window.__urxFake.pushBulkChange());

/** The notifies the bridge refused, for a case whose subject IS the refusal. */
export const notifyDropsOf = (page: Page): Promise<TraceEvent[]> =>
  page.evaluate(() => window.__urxFake.log.filter((e) => e.kind === "notify-drop"));

/**
 * Push level-meter readings through the bridge's registered-set filter. Resolves to one
 * verdict per frame: "" delivered, "unregistered" / "no-subscription" refused. A refused
 * frame changes nothing, which is indistinguishable from a bar that was never updated —
 * use `pushMetersDelivered` whenever the case's subject is the READOUT.
 */
export const pushMeters = (page: Page, frames: Array<[number, number, number]>): Promise<string[]> =>
  page.evaluate((l) => window.__urxFake.pushMeters(l), frames);

/** Push meter readings and throw if the bridge refused any of them, naming the address.
 *  Thrown at the push rather than left to time out on a readout, so a case fed an
 *  address nobody registered says so where the mistake is. */
export async function pushMetersDelivered(page: Page, frames: Array<[number, number, number]>): Promise<void> {
  const why = await pushMeters(page, frames);
  const refused = frames.map((f, i) => [f, why[i]] as const).filter(([, w]) => w);
  if (refused.length) {
    throw new Error(
      `the fake bridge refused ${refused.length} meter frame(s) the case needs delivered: ${refused
        .map(([f, w]) => `${f[0]}:${f[1]} (${w})`)
        .join(", ")}`,
    );
  }
}

/** The meter frames the bridge refused, for a case whose subject IS the refusal.
 *  `analyze.ts` renders no row for this kind, so a case that wants one prints it. */
export const meterDropsOf = (page: Page): Promise<TraceEvent[]> =>
  page.evaluate(() => window.__urxFake.log.filter((e) => e.kind === "meter-drop"));

export const traceOf = (page: Page): Promise<TraceEvent[]> => page.evaluate(() => window.__urxFake.log);

/** The trace build's plan-key write ledger (src/ui/trace-probe.ts). Empty array when
 *  the served bundle carries no probe, so a case can say so rather than crash. */
export const ledgerOf = (page: Page): Promise<import("./analyze").LedgerEntry[]> =>
  page.evaluate(
    () => (window as unknown as { __urxTrace?: { ledger: unknown[] } }).__urxTrace?.ledger ?? [],
  ) as Promise<import("./analyze").LedgerEntry[]>;

/** What the live snapshot holds right now, or null with no session / no probe. */
export const snapshotOf = (page: Page): Promise<Record<string, number> | null> =>
  page.evaluate(
    () =>
      (
        window as unknown as { __urxTrace?: { snapshot: () => Record<string, number> | null } }
      ).__urxTrace?.snapshot() ?? null,
  );

/** Committed undo / redo depth from the probe — the only way to count entries without
 *  driving the UI and spending them. */
export const depthOf = (page: Page): Promise<{ undo: number; redo: number }> =>
  page.evaluate(
    () =>
      (window as unknown as { __urxTrace?: { depth: () => { undo: number; redo: number } } }).__urxTrace?.depth() ?? {
        undo: -1,
        redo: -1,
      },
  );

/** True when the served bundle is a trace build. */
export const hasProbe = (page: Page): Promise<boolean> =>
  page.evaluate(() => (window as unknown as { __urxTrace?: unknown }).__urxTrace !== undefined);

export const paramAddrsOf = (page: Page): Promise<Array<[number, number, number]>> =>
  page.evaluate(() => window.__urxFake.paramAddrs);

export const memOf = (page: Page): Promise<Record<string, number>> => page.evaluate(() => window.__urxFake.mem);

/** The string half of the state map — what the unit would answer a vd_get_str with. */
export const memStrOf = (page: Page): Promise<Record<string, string>> => page.evaluate(() => window.__urxFake.memStr);

export const blockAt = (page: Page, cmd: string, nth: number): Promise<void> =>
  page.evaluate(([c, n]) => window.__urxFake.blockAt(c as string, n as number), [cmd, nth] as [string, number]);

export const releaseBarrier = (page: Page): Promise<void> => page.evaluate(() => window.__urxFake.release());

/**
 * Settle the link *after* a named mark: first wait for the link to wake up (an IPC
 * issued after the mark), then for `quiet` ms of silence. `grace` bounds the wake-up
 * wait so a case whose whole point is that NOTHING was emitted still terminates —
 * which is exactly the case that `waitQuiet` alone answers wrongly, since a link that
 * has not started yet is indistinguishable from one that has finished.
 */
export async function settleAfter(page: Page, markDetail: string, quiet = 900, grace = 3000): Promise<void> {
  const woke = await page
    .waitForFunction(
      (d) => {
        const f = window.__urxFake;
        const m = f.log.find((e) => e.kind === "mark" && e.detail === d);
        return m !== undefined && f.log.some((e) => e.kind === "ipc-start" && e.t > m.t);
      },
      markDetail,
      { timeout: grace },
    )
    .then(() => true)
    .catch(() => false);
  if (woke) await waitQuiet(page, quiet);
}

/** Deliver a MIDI burst as one batched message, the way the bridge does. */
export const pushMidi = (page: Page, msgs: number[][]): Promise<void> =>
  page.evaluate((m) => window.__urxFake.pushMidi(m), msgs);

/** Outgoing MIDI feedback bytes, in order. */
export const midiSentOf = (page: Page): Promise<number[][]> => page.evaluate(() => window.__urxFake.midi.sent);

/** Fire the macOS Edit menu's click event ("edit-undo" / "edit-redo"). */
export const pushMenu = (page: Page, which: string): Promise<void> =>
  page.evaluate((w) => window.__urxFake.pushMenu(w), which);

/** Reject the nth (1-based) call of `cmd` from now on. */
export const refuseAt = (
  page: Page,
  cmd: string,
  nth: number,
  kind: "transport" | "code400" = "transport",
): Promise<void> =>
  page.evaluate(
    ([c, n, k]) => {
      window.__urxFake.refusals.push({ cmd: c as string, nth: n as number, kind: k as "transport", hit: 0 });
    },
    [cmd, nth, kind] as [string, number, string],
  );

/** Accept and discard every write to these param ids (the shape 839 has). */
export const ignoreWrites = (page: Page, ids: number[]): Promise<void> =>
  page.evaluate((list) => {
    window.__urxFake.ignoreWrites.push(...list);
  }, ids);

/** From here on every device command fails identically — the disconnection shape
 *  that never arrives as a link event. */
export const setDeviceLost = (page: Page, lost = true): Promise<void> =>
  page.evaluate((v) => {
    window.__urxFake.deviceLost = v;
  }, lost);

/** Fire the idle link-drop watch. */
export const linkDrop = (page: Page, reason = "device lost"): Promise<void> =>
  page.evaluate((r) => window.__urxFake.linkDrop(r), reason);

/** What the app answers a native confirm with ("Ok" agrees, the default declines). */
export const setDialogAnswer = (page: Page, answer: string): Promise<void> =>
  page.evaluate((a) => {
    window.__urxFake.dialogAnswer = a;
  }, answer);

export const dialogsOf = (page: Page): Promise<string[]> => page.evaluate(() => window.__urxFake.dialogs);

export const countersOf = (page: Page): Promise<FakeHandle["counters"]> =>
  page.evaluate(() => window.__urxFake.counters);

export const meterAddrsOf = (page: Page): Promise<Array<[number, number]>> =>
  page.evaluate(() => window.__urxFake.meterAddrs);

export const divergeAt = (page: Page, addr: string, value: number): Promise<void> =>
  page.evaluate(
    ([a, v]) => {
      window.__urxFake.diverge[a as string] = v as number;
    },
    [addr, value] as [string, number],
  );

/** Plant a device-side value on the STRING path: what a vd_get_str answers whatever the
 *  app wrote. A rename made on the unit's own LCD is exactly this shape, and it is the
 *  only way to reach one — the name addresses are in no registration, so no notify can
 *  carry it and only a read discovers it. */
export const divergeStrAt = (page: Page, addr: string, value: string): Promise<void> =>
  page.evaluate(
    ([a, v]) => {
      window.__urxFake.divergeStr[a] = v;
    },
    [addr, value] as [string, string],
  );
