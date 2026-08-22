import { expect } from "@playwright/test";
import { FAKE_LAUNCH_FLAGS_OFF } from "./fake-flags";
import type { Locator, Page } from "@playwright/test";

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
  /** notify / notify-drop only: "device" = the unit spoke on its own (a write's
   *  announcement, see ANNOUNCE_MS), as against a stimulus a case pushed. The two read
   *  identically on the wire and mean opposite things to a verdict — a refused case push
   *  is a case measuring nothing, while a refused announcement is the bridge doing its
   *  job on an address the session never registered. */
  origin?: "device";
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
  /** How long after a write that moved the value the unit REPORTS it announces it
   *  (see ANNOUNCE_MS). */
  announceMs: number;
}

export const DEFAULT_LATENCY: FakeLatency = {
  connect: 0,
  get: 0,
  set: 0,
  getStr: 0,
  setStr: 0,
  subscribe: 0,
};

/**
 * How long after a write's ACK the fake announces it, when that write moved the value
 * the unit REPORTS. The announcement also ends any staleness window armed on the address
 * (see FakeHandle.stale). What "reports" excludes is spelled out at the `announce`
 * closure: a same-value write, an `ignoreWrites` address and a `diverge`d one all leave
 * it where it was, and all three are silent.
 *
 * Measured on a URX44V: 9-204 ms from the write's ISSUE, median ~101 (n = 87 strictly
 * value-paired samples on 6 addresses, 53 of them taken during a real drag), and
 * 58-151 ms from the ack — always after it, 30/30. It is armed from the ack here
 * because that is the ordering, and because `latency.set` is a knob a case can set
 * anywhere (see Served.announce).
 *
 * The number is bounded on both sides by something other than taste. Above: the DEFAULT
 * stays under live.ts's 120 ms flush window so the ordinary cases are not all measuring
 * the overtake — an announcement that arrives after the next write of a drag is matched
 * against a snapshot that has moved on. That is a real device behaviour, not a hazard of
 * the fake: the ack+58-151 ms measured three lines above crosses 120, so the unit DOES
 * present it. This comment used to say the opposite ("one the unit does not actually
 * present"), which is why no case set this above 120 for a year; `late echo of an
 * overtaken write` in t3-undo.spec.ts is the one that deliberately does. Below: it has
 * to outlast the read an
 * unfixed app issues straight after its write, or the staleness a case armed is already
 * over when that read arrives and the defect goes green; T1c's refetch reaches the
 * address ~26 ms after the write on the measured trace.
 */
export const ANNOUNCE_MS = 100;

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
  /** Reject the nth (1-based) matching command. */
  refusals: Array<{ cmd: string; nth: number; kind: "transport" | "code400"; hit: number }>;
  /** Accept and discard: the write is acked but never stored. */
  ignoreWrites: number[];
  /**
   * Post-write read staleness: address ("paramId:x:y") → how many reads of it, after
   * EACH write to it, answer the value it held BEFORE that write.
   *
   * The unit acks a write before the value is readable. Measured on a URX44V (System
   * V1.3.1.0) across six addresses and three parameter classes: a GET of a just-written
   * address answers the pre-write value until that write's own device notify arrives —
   * 9-204 ms from the write's issue, 87 value-paired samples with no counterexample.
   * `mem` stays truthful throughout: the unit ACCEPTED the write, which is what
   * separates this from `ignoreWrites` (acked, never stored) and from `diverge` (holds
   * for ever a value the app never wrote).
   *
   * WHICH reads are stale is COUNT-based, not time-based. A duration would make every
   * verdict a property of CI load; a count makes "the refetch's read is the stale one"
   * exact — the same reason the barriers exist rather than sleeps.
   *
   * WHEN the window ends is not this setting's business at all: EVERY value-changing
   * write is announced `cfg.announceMs` later (see ANNOUNCE_MS), and that announcement
   * closes any window open on the address whether the scripted reads were spent or not.
   * So a case never has to push the notify itself, and must not expect the window to
   * outlast it — after it, reads answer `mem` again.
   *
   * Standing, not one-shot: every write to the address arms `n` stale reads again.
   */
  staleAfterWrite: Record<string, number>;
  /** The armed entries, address → the pre-write value still being answered, how many
   *  stale reads are left, how many were actually answered, and whether the write's own
   *  notify has gone out. `spent > 0` proves a case's scripted staleness was REACHED by
   *  a read rather than merely configured; `notified` says the window has closed, after
   *  which reads answer `mem` again. */
  stale: Record<string, { value: number | string; left: number; spent: number; notified: boolean }>;
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
    /** The shell's own record of the MIDI control window, which is what
     *  `midi_window_open` answers from — and what survives a reload of the main
     *  page, exactly as the Rust side does. Backed by localStorage rather than a
     *  field, because the window is a second PAGE with its own fake: a boolean would
     *  be two booleans, and the page that closes is not the page that is asked. */
    readonly windowOpen: boolean;
    /** How many times the app asked for the window (a raise counts separately). */
    windowOpens: number;
    windowFocuses: number;
  };
  /** Deliver raw MIDI messages as one batched burst, the way the bridge does. */
  pushMidi: (msgs: number[][]) => void;
  /** Emit a menu://edit event ("edit-undo" / "edit-redo"), the macOS Edit menu's path. */
  pushMenu: (which: string) => void;
  setLatency: (patch: Partial<FakeLatency>) => void;
  mark: (detail: string) => void;
  /** Push device-side param notifies through the bridge's filter. Returns one verdict
   *  per entry, in order: "" for a delivered one, the refusal reason for a dropped one. */
  pushNotify: (list: Array<[number, number, number, number]>, origin?: "device") => string[];
  /** The address-free bulk-change sentinel — the one notify that bypasses the filter,
   *  and so the sanctioned way to force one whole-device reconcile. */
  /** A STRING notify — what a rename broadcasts. The bridge carries it in
   *  `valueStr` and leaves `value` at 0; the registered-set filter applies exactly
   *  as it does to a numeric one, which is the whole point: names were in no
   *  registration until the app started registering them. */
  pushNameNotify: (paramId: number, x: number, y: number, value: string) => string[];
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
  /** Override ANNOUNCE_MS for this session. */
  announceMs?: number;
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
    announceMs: opts.announceMs ?? ANNOUNCE_MS,
  };
  // On the CONTEXT, not the page: MIDI control is a second window, which is a second
  // page here, and it needs the same bridge before its bundle resolves.
  await page.context().addInitScript(
    ([config, storage, flagsOff]: [FakeConfig, Record<string, string>, string[]]) => {
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

      /** The string half of `pushNotify`, shared by the write's own announcement and by
       *  a case's scripted push so the two cannot describe different devices. A name
       *  notify carries its text in `value_str` and a numeric `value` of 0, and passes
       *  the same `Subs::absorb` filter as any other — an address this session did not
       *  register is dropped here, which is what still happens to Sweet Spot Data. */
      const emitNameNotify = (param_id: number, x: number, y: number, value: string): string[] => {
        const w = notifyRefusal(param_id, x, y, 0);
        put(w ? "notify-drop" : "notify", {
          addr: `${param_id}:${x}:${y}`,
          value: 0,
          detail: w || undefined,
          origin: "device",
        });
        // snake_case, like the real bridge: the frontend maps `param_id`/`value_str`
        // itself, so a camelCase payload here would test a wire that does not exist.
        if (!w) paramChannel?.onmessage([{ param_id, x, y, value: 0, value_str: value }]);
        return [w];
      };

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
        refusals: [],
        ignoreWrites: [],
        staleAfterWrite: {},
        stale: {},
        deviceLost: false,
        dialogs: [],
        dialogAnswer: "Cancel",
        midi: {
          inputs: ["Fake In"],
          outputs: ["Fake Out"],
          inPort: null,
          outPort: null,
          inChannel: null,
          sent: [],
          get windowOpen(): boolean {
            return localStorage.getItem("urx-fake-midiwin") !== null;
          },
          windowOpens: 0,
          windowFocuses: 0,
        },
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
        pushNotify: (list, origin) => {
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
              origin,
            });
            if (!w) passed.push({ param_id, x, y, value });
          }
          if (passed.length) paramChannel?.onmessage(passed);
          return why;
        },
        pushNameNotify: (param_id, x, y, value) => {
          // The unit STORES the new name and then announces it. Announcing without
          // storing would be a device that reports a value it does not hold, and the
          // next read would contradict its own notify — the same shape of harness
          // self-contradiction the ack-anchored announcement had to fix. A case that
          // needs the two to disagree needs a knob this fake no longer carries; the
          // design of the one that was removed is in the private reference notes.
          fake.memStr[`${param_id}:${x}:${y}`] = value;
          return emitNameNotify(param_id, x, y, value);
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

      // The MIDI-control UI relay (midiwin.rs). Each side registers a receiver and a
      // post reaches the OTHER page only — BroadcastChannel does not echo to its
      // sender, and neither does the Rust relay it stands in for.
      let midiUiToMain: { onmessage: (p: string) => void } | null = null;
      let midiUiToWindow: { onmessage: (p: string) => void } | null = null;
      const midiUiRelay = new BroadcastChannel("urx-midi-ui");
      midiUiRelay.onmessage = (e: MessageEvent<{ dir: string; payload: string }>) => {
        if (e.data.dir === "main") midiUiToMain?.onmessage(e.data.payload);
        else midiUiToWindow?.onmessage(e.data.payload);
      };

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

      // Post-write read staleness (see FakeHandle.staleAfterWrite) and the announcement
      // that ends it. Three pieces: what a read answers AND consumes, what a write arms,
      // and what the unit says about a write afterwards. The first two are queue-point
      // effects, like the store they sit beside — the worker stays a plain serial queue
      // with no await added to it.
      type Stale = { value: number | string; left: number; spent: number; notified: boolean };
      const openStale = (k: string): Stale | undefined => {
        const s = fake.stale[k];
        return s && s.left > 0 && !s.notified ? s : undefined;
      };
      const takeVisible = (k: string): number => {
        const s = openStale(k);
        if (!s) return fake.mem[k] ?? 0;
        s.left--;
        s.spent++;
        return s.value as number;
      };
      // The same window on the NAME path. Measured on a URX44V: a channel name written
      // and then polled every 4 ms answered the PREVIOUS name for 81 ms — the string
      // path is not exempt, and it was modelled as exempt here for the harness's whole
      // life. It matters more than the numeric case, not less: a stale numeric read
      // oscillates and is visible, while a stale NAME read goes into the plan and
      // `nameSnapshot` together, so they agree, no diff is left, and the operator's
      // rename is reverted with nothing to retry.
      const takeVisibleStr = (k: string): string => {
        const s = openStale(k);
        if (!s) return fake.memStr[k] ?? "";
        s.left--;
        s.spent++;
        return s.value as string;
      };
      // Armed from what is VISIBLE, not from what is stored: two writes inside one
      // staleness window leave the second one answering the value the first was still
      // hiding, which is what the measured session's second round did — its read
      // answered the value from before ITS write, not the settled one.
      const armStale = (k: string): Stale | undefined => {
        const n = fake.staleAfterWrite[k];
        if (!n) return undefined;
        const entry: Stale = { value: openStale(k)?.value ?? fake.mem[k] ?? 0, left: n, spent: 0, notified: false };
        fake.stale[k] = entry;
        return entry;
      };
      const armStaleStr = (k: string): Stale | undefined => {
        const n = fake.staleAfterWrite[k];
        if (!n) return undefined;
        const entry: Stale = { value: openStale(k)?.value ?? fake.memStr[k] ?? "", left: n, spent: 0, notified: false };
        fake.stale[k] = entry;
        return entry;
      };
      // What a read of the address would answer once any staleness window is over: the
      // value the unit REPORTS, which `diverge` overrides and `mem` otherwise holds.
      const reported = (k: string): number => (k in fake.diverge ? fake.diverge[k] : (fake.mem[k] ?? 0));
      /** The same question on the string path, answered from the string maps. */
      const reportedStr = (k: string): string => fake.memStr[k] ?? "";
      // The unit announces a write that CHANGED the value it reports, and that
      // announcement is what ends the staleness window — the boundary the staleness was
      // measured against rather than a separate stimulus. Nothing else closes it: a
      // device that accepts a value-changing write and never announces it is not a
      // device any URX measurement describes (30/30 value-paired), and an app that waits
      // for the announcement before re-reading would then be failed here for the fake's
      // own contradiction rather than for a defect.
      //
      // Armed from the ACK rather than from the queue point (see Served.announce), which
      // is also the interval the measurement brackets most tightly: 58-151 ms after the
      // ack, always after it, 30/30. `announceMs` has to stay BELOW live.ts's flush
      // window or the fake stops modelling the unit in a way that matters: an
      // announcement overtaken by the next write of a drag arrives against a snapshot
      // that has moved on, fails isEcho, and is applied as a device-side change — a
      // hazard of the announcement being late, not of anything the app does.
      //
      // Three silences, and the same rule produces all of them. A same-value write:
      // measured, 18 of them acked in 0-1 ms and produced none. A write the fake never
      // accepted (`ignoreWrites`), the acked-and-silently-discarded model: nothing it
      // reports moved. And a write to a `diverge`d address, which is the same shape from
      // the reporting side — the unit goes on asserting the value it already held, so
      // there is nothing new to announce, and its reads and its (absent) notify agree.
      // Announcing the asserted value instead would be a notify contradicting the fake's
      // own `mem` and carrying a value the app never sent, which is a DEVICE-SIDE CHANGE
      // to the app, not a coercion. A coerced write is a transform applied to the write
      // on the way in; `diverge` bends reads and leaves `mem` alone, so it is not one,
      // and modelling coercion needs a knob this fake does not have.
      //
      // Two things are captured when the write is APPLIED rather than read again when the
      // timer fires. The staleness entry, by identity, so a later write's window is not
      // closed by an earlier write's announcement. And the VALUE, because a notify reports
      // the change it belongs to — two writes inside one window produce two notifies
      // carrying their own values, in order. Read lazily, the first write's announcement
      // carries the SECOND write's value and arrives before that write's ack, so the app
      // sees a value its snapshot cannot hold yet, calls it a device-side change, and
      // applies it over whatever the operator has moved to since. (Measured against the
      // app: a 240-detent key train landed 5-14 dB off.)
      //
      // ONE function for both paths, dispatched on the value's own type — which is
      // already this file's model of a device value (`Stale.value` is `number |
      // string`). The string path lived without an announcement at all for the
      // harness's whole life, and what kept the omission alive was that its reasoning
      // sat in a comment beside a twin nobody diffed against the numeric one. Two
      // copies of the ack anchor and the window-closing rule would recreate exactly
      // that, and the numeric copy is the one people edit.
      const announce = (k: string, armed: Stale | undefined, value: number | string): void => {
        const [p, x, y] = k.split(":").map(Number);
        setTimeout(() => {
          if (armed && fake.stale[k] === armed) {
            armed.left = 0;
            armed.notified = true;
          }
          if (typeof value === "string") emitNameNotify(p, x, y, value);
          else fake.pushNotify([[p, x, y, value]], "device");
        }, config.announceMs);
      };
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
      //
      // vd_link_stats is the third: it reads the session's atomics under the state mutex
      // and sends no `Cmd` at all (lib.rs `vd_link_stats` → vd.rs `stats`), which is the
      // point of it — a reading taken while an ~800 command sweep is running has to
      // report now rather than the sweep's start. Queued here it would be a command the
      // shipped app never puts in that FIFO, and the ledger issues one at every session
      // open and every teardown, which is exactly where the registration-ordering cases
      // are looking. The `vd_` prefix is what made it queue; name it rather than widening
      // the prefix rule, so the next `vd_`-named command is queued until someone decides
      // otherwise.
      const onWorker = (cmd: string): boolean =>
        cmd.startsWith("vd_") && cmd !== "vd_connect" && cmd !== "vd_link_stats";
      /** What `handle` settled at the queue point and `serve` answers with. */
      interface Served {
        done: (detail?: string) => void;
        sampled: number;
        sampledStr: string;
        held: Promise<void> | null;
        /** Arms the write's own announcement, deliberately NOT armed at the queue point:
         *  the measured notify follows the ACK (30/30, ack+58-151 ms), and `latency.set`
         *  is a case's knob that can be set above the announcement window. Armed there,
         *  a case with a slow link would receive the unit's word about a write before the
         *  app was told the write landed — an ordering the unit never produces, which the
         *  app then reads as a device-side change to an address whose snapshot entry it
         *  has not written yet. */
        announce?: () => void;
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
        let pending: (() => void) | undefined;
        if (cmd === "vd_get") {
          const k = key(args);
          // `diverge` still outranks staleness: it says the unit HOLDS that value, so
          // there is no pre-write value for a read to lag behind and nothing to spend.
          sampled = k in fake.diverge ? fake.diverge[k] : takeVisible(k);
        } else if (cmd === "vd_get_str") {
          // The string path has a state map of its own, for the reason the numeric one
          // has: a fake that answered "" whatever was written would make every full
          // readback erase a non-empty name and every diffNames report one, so a case
          // could not tell the app clearing a name from the fake never holding it.
          sampledStr = takeVisibleStr(key(args));
        } else if (cmd === "vd_set" && !fake.ignoreWrites.includes(Number(args.paramId))) {
          const k = key(args);
          const value = Number(args.value);
          const said = reported(k);
          // Armed BEFORE the store, so the entry carries the pre-write value. Both are
          // queue-point effects for the reason the store already was: the broker applies
          // a write when it takes it, and what a LATER READ sees is the separate question
          // this models. A write the fake never accepted (ignoreWrites) arms nothing —
          // there is no accepted value for a read to be lagging behind.
          const armed = armStale(k);
          fake.mem[k] = value;
          const now = reported(k);
          if (now !== said) pending = () => announce(k, armed, now);
        } else if (cmd === "vd_set_str" && !fake.ignoreWrites.includes(Number(args.paramId))) {
          // The same five steps as the numeric arm above, deliberately spelled the same
          // way so the two can be diffed by eye: only the maps and the value type
          // differ. The string path lived without both the window and the announcement
          // for the harness's whole life, and it drifted unnoticed because nobody could
          // read the two arms side by side.
          //
          // BOTH HALVES OF THE RULE ARE MEASURED HERE, not carried over from the
          // numeric path. The ORDER: 32 name writes over two runs announced after their
          // own ack, 32/32 — ack 0-4 ms from the issue, notify ack+1-102 ms. The
          // SILENCE (`now !== said`): a same-value name write acked in 0 ms and
          // announced nothing in 2000 ms, bracketed by a value-changing write on each
          // side of one subscription so a dead stream could not pass for a silent
          // device. And the WINDOW: 81 ms on a URX44V, closed by the write's own notify
          // — a fake that armed it and never closed it would describe a device that
          // goes on answering a name it no longer holds.
          //
          // `announceMs` (the numeric median, 100) is reused for names even so, and one
          // number is why that is a choice rather than a fit: most name notifies land at
          // 66-102 ms, but 2 of the 32 arrived under 10 ms — a low tail the numeric
          // spread (ack+58-151 ms) does not have, cause unidentified. Erring LATE is the
          // hazardous direction, so modelling the late cluster is what keeps the
          // overtake case reachable; a fake at 5 ms would simply never produce it.
          //
          // An address the session did not register is still dropped at the bridge, so
          // Sweet Spot Data (param 91, in no registration) reaches nothing.
          const k = key(args);
          const said = reportedStr(k);
          const armed = armStaleStr(k);
          fake.memStr[k] = String(args.value ?? "");
          const now = reportedStr(k);
          if (now !== said) pending = () => announce(k, armed, now);
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

        const ctx: Served = { done, sampled, sampledStr, held, announce: pending };
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

        // The launch flags, from the list a unit guard also reads (see fake-flags.ts).
        // It arrives as an ARGUMENT, not as the import at the top of this file. Every
        // callback that crosses into the page — addInitScript here, and equally evaluate /
        // evaluateHandle / waitForFunction / locator.evaluate — is serialised and run
        // there, where a module-scope binding of the driver's does not exist. Naming the
        // import inside one compiles, type-checks and collects, then throws at the first
        // command the fake handles: "Can't find variable: X" in JavaScriptCore, "X is not
        // defined" in V8. What that presents as is a session that never comes up.
        if (flagsOff.includes(cmd)) {
          done();
          return false;
        }

        switch (cmd) {
          // The link ledger (core/control/link-stats.ts). Answered rather than left to
          // the `default` throw: the tracker swallows a failed reading as "the link has
          // gone", so a throw is not visible as a failure — it just puts every race
          // trace through the unhandled-command path at each session open and teardown.
          // The counts are zeros because no case asserts on them; what a case can be
          // disturbed by is the call happening at all, and that is now faithful.
          case "vd_link_stats":
            done();
            return {
              sets: 0,
              gets: 0,
              param_subscribes: 0,
              meter_subscribes: 0,
              regist_frames: 0,
              unregist_frames: 0,
              deadlines: 0,
              stalled: 0,
            };
          case "append_link_log":
            done();
            return "/dev/null/link-ledger.jsonl";
          case "app_build_kind":
            done();
            return "dev";
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
          // What the shell holds, which the app checks its own record against on
          // every port refresh (ui/midi.ts reconcileOpenPorts).
          case "midi_open_ports":
            done();
            return [fake.midi.inPort, fake.midi.outPort];
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
          // midiwin.rs — MIDI control is a second OS window, which is a second PAGE
          // here. The shell owns whether it exists (so the record outlives a reload of
          // this page, and `midi_window_open` answers from it), and relays between
          // the two webviews without ever echoing to the sender.
          case "open_midi_window":
            fake.midi.windowOpens++;
            if (fake.midi.windowOpen) fake.midi.windowFocuses++; // an open on a live window raises it
            localStorage.setItem("urx-fake-midiwin", "1");
            done();
            return null;
          case "close_midi_window":
            localStorage.removeItem("urx-fake-midiwin");
            done();
            return null;
          case "focus_midi_window":
            fake.midi.windowFocuses++;
            done();
            return null;
          case "midi_window_open":
            done();
            return !!localStorage.getItem("urx-fake-midiwin");
          case "midi_ui_attach_main":
            midiUiToMain = args.channel as { onmessage: (p: string) => void };
            done();
            return null;
          case "midi_ui_attach_window":
            midiUiToWindow = args.channel as { onmessage: (p: string) => void };
            done();
            return null;
          case "midi_ui_to_main":
            // The window going away is the shell's business too: once destroyed,
            // get_webview_window answers None.
            if (String(args.payload ?? "").includes('"closed"')) localStorage.removeItem("urx-fake-midiwin");
            midiUiRelay.postMessage({ dir: "main", payload: args.payload });
            done();
            return null;
          case "midi_ui_to_window":
            midiUiRelay.postMessage({ dir: "window", payload: args.payload });
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
            // Divergence kept, vd.rs `sender()`: it errors with "not-connected"
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
          case "vd_set_str":
            await wait(cmd === "vd_set" ? config.latency.set : config.latency.setStr);
            done();
            // After the ack, never before it — see Served.announce. One arm for both,
            // because that ordering rule is one rule: measured on the numeric path
            // (ack+58-151 ms, 30/30) and on the string path (ack+1-102 ms, 32/32).
            ctx.announce?.();
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
    [cfg, opts.storage ?? {}, [...FAKE_LAUNCH_FLAGS_OFF]] as [FakeConfig, Record<string, string>, string[]],
  );
}

/** Every step of `goLive` carries this rather than the caller's page default, because
 *  bringing the session up is a PRECONDITION and not one of the gestures a case
 *  measures. A caller that bounds its gestures fail-fast — t0b-sweeps sets a 4 s page
 *  default so an unreachable control lands in its error column by name — would
 *  otherwise apply that bound here, where the failure is not a result at all.
 *
 *  What made it matter: the first actionability-gated action after a cold page load
 *  waits on Playwright's stability gate, which is a requestAnimationFrame loop needing
 *  two consecutive frames. Headless WebKit delivers its first frames sparsely
 *  (measured on macOS WebKit: 2 frames in the first 187 ms of a document, against a
 *  ~16 ms cadence once the page is warm), so on a CI runner that first check is the
 *  one long wait in the run — and `goLive`'s opening click is where every case meets
 *  it. It is not the app: the button's own box is byte-identical across 92 consecutive
 *  frames. The `waitForSelector` below already carried its own bound for the readback;
 *  the clicks were left inheriting, which is what made this a WebKit-only flake. */
const SESSION_UP_TIMEOUT_MS = 30_000;

/** Bring a live session up, then hand the fake its scripted latency. The initial
 *  readback is ~800 sequential reads: at a scripted latency it would take minutes,
 *  so the session is established at zero latency and the profile applied after. */
export async function goLive(page: Page, latency: Partial<FakeLatency> = {}): Promise<void> {
  await page.click("#btn-device", { timeout: SESSION_UP_TIMEOUT_MS });
  await page.click("#btn-live", { timeout: SESSION_UP_TIMEOUT_MS });
  // Attached, not visible: the click closes the Device menu, so the toggle that
  // carries the session state is hidden by the time it flips.
  await page.waitForSelector('#btn-live[aria-pressed="true"]', {
    state: "attached",
    timeout: SESSION_UP_TIMEOUT_MS,
  });
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
/** Push a rename the way the unit announces one: a string notify on a name address.
 *  Returns one verdict, "" when it was delivered. */
export const pushNameNotify = (page: Page, addr: string, value: string): Promise<string[]> =>
  page.evaluate(
    ([a, v]) => {
      const [p, x, y] = (a as string).split(":").map(Number);
      return window.__urxFake.pushNameNotify(p, x, y, v as string);
    },
    [addr, value] as [string, string],
  );

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

/** The notifies the bridge refused, for a case whose subject IS the refusal. The unit's
 *  own write announcements are excluded — a refused one says the app never registered
 *  that address, which is invariant 6's "grown window" and not this. */
export const notifyDropsOf = (page: Page): Promise<TraceEvent[]> =>
  page.evaluate(() => window.__urxFake.log.filter((e) => e.kind === "notify-drop" && e.origin !== "device"));

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

/** What the live snapshot holds right now, or null with no probe / with Live sync not
 *  active — a session that has ended answers null, not its own last contents. */
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

/**
 * Settle past device-follow's IDLE SAFETY NET, not merely past the burst that armed it.
 * `settleAfter` returns as soon as the link falls quiet, which for a notify is ~300 ms in —
 * before the 900 ms idle timer (follow.ts IDLE_FULL_MS) has fired the whole-device sweep it
 * schedules. An absence verdict taken there passes for free, which is the harness's own
 * first trap ("silence is also true before anything has started") one level out.
 *
 * The extra wait is the idle arm plus enough slack for the sweep to start; it lives here
 * rather than as a literal in each case so the two numbers track the one constant they
 * encode.
 */
export async function settleThroughIdleNet(page: Page, markDetail: string, cap = 25_000): Promise<void> {
  await settleAfter(page, markDetail, 900, cap);
  await page.waitForTimeout(1500);
  await waitQuiet(page);
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

/** Accept and discard every write to these param ids — the shape the unit's clock
 *  has (an RTC write answers 200, reads back as itself, and moves nothing). */
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

/** Put values into the unit's own state with no write behind them — a device-side
 *  change the app never asked for and, for the addresses the unit does not announce,
 *  was never told about. Unlike `divergeAt`, the next write LANDS on the address: a
 *  case asserting that the app repaired something needs the repair able to stick. */
export const setMemAt = (page: Page, entries: Record<string, number>): Promise<void> =>
  page.evaluate((e) => void Object.assign(window.__urxFake.mem, e), entries);

export const divergeAt = (page: Page, addr: string, value: number): Promise<void> =>
  page.evaluate(
    ([a, v]) => {
      window.__urxFake.diverge[a as string] = v as number;
    },
    [addr, value] as [string, number],
  );

/**
 * Make the next `reads` reads of `addr` after EVERY write to it answer the value it held
 * before that write — the unit's own post-write read staleness (see
 * FakeHandle.staleAfterWrite).
 *
 * Unlike `divergeAt`, which answers one value for ever and models a device holding
 * something the app never wrote, this models a device that ACCEPTED the write and cannot
 * yet report it: `mem` carries the written value throughout, so `memOf` stays the one
 * answer to "what does the unit hold". The two are not interchangeable — a diverging
 * address never agrees with the app, a stale one agrees a moment later, and every repair
 * path in the app is built on reading again.
 *
 * Both paths: a name is not exempt. Measured on a URX44V — a written name answered the
 * one it replaced for 81 ms — and the fake modelled it as exempt for its whole life.
 *
 * Which read spends it is a matter of ORDER, not of time: at DEFAULT_LATENCY a run of
 * queued commands drains as one microtask burst, so a case that needs a SPECIFIC read to
 * be the stale one either scripts a non-zero `latency.get` or picks an address only that
 * read touches.
 *
 * The window is closed by the write's own announcement, which the fake makes for every
 * value-changing write with or without this (ANNOUNCE_MS). A case does not push it and
 * must not expect the staleness to outlast it.
 */
export const staleReadsAt = (page: Page, addr: string, reads: number): Promise<void> =>
  page.evaluate(
    ([a, n]) => {
      window.__urxFake.staleAfterWrite[a as string] = n as number;
    },
    [addr, reads] as [string, number],
  );

/** The stale entries as they stand. `spent` says how many reads the staleness a case
 *  scripted actually answered — 0 means it was configured and never reached — and
 *  `notified` that the window has closed on the write's own notify. */
export const staleStateOf = (page: Page): Promise<FakeHandle["stale"]> => page.evaluate(() => window.__urxFake.stale);

/**
 * Open the MIDI control window from the Device menu and attach to it.
 *
 * It is a second OS window in the app, so it is a second PAGE here; the shell command
 * is faked, which means the page is opened on this side. The bridge is installed on
 * the context, so the new page carries the same fake and the same relay — a state
 * push from the main window reaches it exactly as it would over the Rust relay.
 */
export async function openMidiWindow(page: Page): Promise<Page> {
  await page.click("#btn-device");
  await page.click("#btn-midi");
  await expect.poll(() => page.evaluate(() => window.__urxFake.midi.windowOpen)).toBe(true);
  const win = await page.context().newPage();
  await win.goto("/midi.html");
  await expect(win.locator("#midi-window")).toBeVisible();
  // Nothing it shows is its own: it asks for state on boot and renders what arrives.
  await expect(win.locator(".mw-title")).toHaveText("MIDI CONTROL");
  return win;
}

/** Turn the MIDI window's learn mode on or off, waiting for the arming surface to
 *  agree — the mode lives in the main window and reaches the console through a
 *  re-render, so a click here is not observable until that lands. */
export async function setMidiLearn(page: Page, win: Page, on: boolean): Promise<void> {
  const btn = win.locator(".mw-learnbtn");
  if ((await btn.getAttribute("aria-pressed")) !== String(on)) await btn.click();
  await expect(btn).toHaveAttribute("aria-pressed", String(on));
  if (on) await expect(page.locator("#console-host")).toHaveClass(/midi-learn/);
}

/** One assignment row in the MIDI window's table. */
export const midiRow = (win: Page, control: string): Locator => win.locator(`.mw-list tr[data-control="${control}"]`);
