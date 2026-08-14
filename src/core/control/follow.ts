// Device follow: the reverse of live sync. While active, the app registers the
// follow address set for change notifies, so an edit made on the device itself
// (LCD / physical controls) is pulled back into the plan. That set is NOT the
// writable one — it is what the app writes plus the addresses it only reads
// (`live.followAddrs`), because an address the unit announces to nobody is one
// the panel can change with no effect on screen.
//
// A notify carries the changed address and its new value, so detection is free
// and exact — the cost is reflecting it. Each notify is classified via the live
// snapshot's address index (live.lookup):
//   - direct: a node-local scalar (fader / pan / on / level …) → the value is
//     decoded and written straight into the plan with no read-back (applyDirect).
//   - scoped: anything else (EQ / dynamics / structure / sideEffect) → the owner
//     node is re-read once the burst settles (applyNodeState), reusing the proven
//     device→plan inverse so a scoped read can never drift from a full one.
//   - unknown / too many controls at once → a full reconcile (a scene / preset
//     recall changes far more than two hands can, so re-read everything).
//
// Echoes (a notify whose value equals what we last wrote / read, per the live
// snapshot) are our own writes coming back, not fresh changes, and are dropped.

import { vdParamsSubscribe, type ParamUpdate } from "../platform";
import type { ParamName } from "./params";
import type { FollowAddr } from "./live";
import { writeSettle } from "./settle";

// A device-side change arrives as a burst (a knob sweep fires ~10 notifies/s);
// wait for it to settle before the reconcile readback runs. 300 ms — see the
// idle threshold below (3× this window).
const RECONCILE_DEBOUNCE_MS = 300;

// After the device has been quiet for this long, run one full reconcile as a
// safety net against any missed notify, then rely on the push stream again. 900 ms
// = 3 settle windows: a human rides a control in bursts shorter than this.
const IDLE_FULL_MS = 900;

// Two hands plus one stray interaction = at most three logical controls changing
// at once. More distinct controls inside a single settle window is not hand
// operation (a scene / preset recall), so re-read the whole device instead of
// scoping — it changes more than a scoped read would catch.
const MAX_CONCENTRATION = 3;

export interface DeviceFollowHooks {
  /** Every parameter address to register for notifies ([paramId, x, y]) — the writable
   *  set plus names, the read-only follows, and the host-owned ones the caller appends. */
  addrs: () => Array<[number, number, number]>;
  /** First refusal on an incoming notify, for addresses the host registers itself
   *  and owns outside the plan (SETUP > Follow USB is the one such address today).
   *  Returning true consumes the notify. Without this they would resolve to no node
   *  and escalate every change to a full re-read of the device. */
  intercept?: (p: ParamUpdate) => boolean;
  /** Whether an incoming notify is the echo of a known/just-written value. Answers
   *  for BOTH paths — the host dispatches on `valueStr`, because the numeric and the
   *  name snapshots are separate maps and neither can answer for the other. One gate
   *  rather than two: an echo policy that lived in two places would have to be found
   *  and changed twice, and the second site is what goes stale. */
  isEcho: (p: ParamUpdate) => boolean;
  /** Resolve a notify address to its catalog name, owner node, and follow kind,
   *  or undefined when the address is in no index (registered by the host, or announced
   *  by the unit on an address nothing here tracks — both take the full-read escalation). */
  lookup: (paramId: number, x: number, y: number) => FollowAddr | undefined;
  /** Apply one direct param change into the plan now (no read-back). Returns false
   *  when the param is not actually directly placeable (flagged direct but unhandled),
   *  so the caller falls back to a scoped read. */
  applyDirect: (node: string, name: ParamName, value: number) => boolean;
  /** A rename made on the unit. Returns the owning node when the address is a name
   *  one and the value was placed, so the caller can repaint just that node — or
   *  undefined when it is not a name address at all. The app's own rename echoed
   *  back never reaches here: `isEcho` covers both paths (see it, and `onNotify`).
   *  Kept off `applyDirect` because a name is not a catalog parameter: it has no
   *  `ParamName`, no numeric value and no entry in the live snapshot. */
  applyName?: (paramId: number, x: number, y: number, value: string) => string | undefined;
  /** Patch the live snapshot's single entry for a just-applied direct change to the
   *  device-reported value, so the host can skip the full re-translate on reflect
   *  (and the next outgoing diff still measures from the device truth). */
  noteDirect: (paramId: number, x: number, y: number, value: number) => void;
  /** A direct change was applied: request a re-render + live-snapshot re-base. The
   *  host coalesces these (one per animation frame), so calling it per notify during
   *  a sweep is cheap. */
  flushDirect: () => void;
  /** Scoped reconcile: re-read the given owner nodes, reflect them, re-render, and
   *  re-base the live snapshot. Read failures reject. */
  reconcileNodes: (nodeIds: ReadonlySet<string>) => Promise<void>;
  /** Full reconcile: re-read the whole device (escalation + idle safety net).
   *  Read failures reject, like reconcileNodes. */
  reconcileAll: () => Promise<void>;
  /** A device-side change is being reflected — for an optional "← device" status. */
  onFollow: () => void;
  /** A reconcile failed; follow is already stopped — the caller drops the link. */
  onError: (message: string) => void;
}

export class DeviceFollow {
  private active = false;
  private unsub: (() => void) | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private reconciling = false;
  private pending = false;
  // A full (idle safety net) reconcile arrived while one was in flight: the replay
  // must keep the full scope rather than downgrade to a scoped/no-op pass.
  private pendingFull = false;
  // The current settle window's accumulated state: nodes needing a scoped read,
  // distinct logical controls touched (node:name), and whether a full reconcile
  // is forced (an unknown address or too many controls at once).
  private scopedNodes = new Set<string>();
  private touched = new Set<string>();
  private forceFull = false;
  // Identity of the currently registered address set, so a reconcile that did not
  // change the plan's structure skips re-registering all ~hundreds of addresses.
  private registeredKey = "";
  // Release for the notify source this follow registers with the write settle. The
  // subscription below is the only notify stream in the app, so while it is up a
  // write can be waited out exactly, and while it is not the settle must fall back
  // to its bounded window (see settle.ts). Held strictly PAIRED with `unsub`, and
  // released everywhere that is: an armed source with no stream behind it would make
  // the settle report every write as unannounced for the rest of the session.
  private settleSource: (() => void) | null = null;
  /**
   * Which session a registration belongs to, bumped by `begin` and by `end`.
   *
   * `this.active` cannot stand in for it: it is a boolean, and it returns to `true`
   * for a DIFFERENT session. A registration stalled at the broker (the stall ledger
   * exists because this broker does stall) outlives the session that issued it, and
   * the post-await guard then saw the NEW session's `true` and installed its dead
   * handle over a live one — the real subscription orphaned with nobody left to
   * unsubscribe it (registration pile-up at the broker is the exact failure
   * `link-stats.ts` was built to investigate), notifies delivered twice while both
   * lived, and a leaked settle sink arming idle reconciles across later sessions.
   * live.ts names this defect as the reason its own `sessionGen` exists.
   */
  private gen = 0;

  /** The registration currently on the wire and the generation that issued it — see
   *  `subscribe`. */
  private subscribeInFlight: { gen: number; tail: Promise<void> } | null = null;

  constructor(private readonly hooks: DeviceFollowHooks) {}

  isActive(): boolean {
    return this.active;
  }

  /** Start following. Call after the live snapshot is captured (begin/resync), so
   *  the follow address set and its index are known. */
  async begin(): Promise<void> {
    this.active = true;
    this.gen++;
    await this.subscribe();
  }

  /**
   * Re-register against the CURRENT address set, if it has moved.
   *
   * Cheap to call and safe to call often: `subscribe` compares the set's identity and
   * returns without touching the broker when it is unchanged. What it must NOT be is
   * `begin()` — that bumps the generation, which is how an in-flight registration tells
   * "my session ended" from "it is still mine", so bumping it for a refresh would make a
   * registration still in flight drop its own handle with the session still active, and
   * leave the subscription it stood for orphaned at the broker.
   *
   * Errors go the same way a reconcile's do, rather than into a floating rejection: the
   * caller is a live flush that has already returned.
   */
  async refresh(): Promise<void> {
    try {
      await this.subscribe();
    } catch (e) {
      this.active = false;
      this.hooks.onError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Stop following and cancel any pending work. Does not touch the connection. */
  end(): void {
    this.active = false;
    this.gen++;
    this.pending = false;
    this.pendingFull = false;
    this.clearWindow();
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.unsub?.();
    this.unsub = null;
    this.settleSource?.();
    this.settleSource = null;
  }

  // Register the current follow address set for notifies. The set rarely changes
  // (only a structural plan edit alters it), so when it matches what is already
  // registered this is a no-op rather than re-posting every address to the broker.
  // Serialized, and that is what lets the identity check below mean anything: the check
  // reads `this.unsub`, which is nulled BEFORE the await, so a call entering while
  // another is on the wire cannot short-circuit however unchanged the set is. Two
  // registrations under one generation then both pass the post-await guard and both
  // install — the later handle and settle source overwriting the earlier without
  // releasing it, which leaks a sink into `writeSettle`'s module singleton that `end()`
  // cannot reach — and `registeredKey` ends up naming the call that STARTED last while
  // the broker holds the one that FINISHED last. Every later call then short-circuits on
  // a set the broker does not hold, which is this file's own defect class.
  //
  // `refresh()` is what made that reachable: `begin()` is awaited at session start and
  // `runReconcile`'s call is inside `reconciling`, but a flush ends whenever it ends.
  // Queued rather than dropped, so `begin()` still returns only once ITS registration has
  // landed, and a queued call reads the address set when its turn comes rather than when
  // it was asked. With nothing in flight the registration is issued in this same tick, as
  // it was before: the cases that end a session between `begin()` and its await depend on
  // that, and a `.then()` on an already-resolved promise would defer it past the `end()`
  // and register nothing at all.
  private subscribe(): Promise<void> {
    // Within ONE generation only. A new session must not wait behind a registration
    // stalled at the broker — overtaking it is what the generation guard is for, and
    // `begin()` has bumped past it by the time it gets here — so a queue that spanned
    // sessions would hand a stall the power to stop the next session registering at all.
    const prev = this.subscribeInFlight?.gen === this.gen ? this.subscribeInFlight.tail : null;
    const run = prev ? prev.then(() => this.subscribeOne()) : this.subscribeOne();
    const entry = { gen: this.gen, tail: run.catch(() => {}) };
    this.subscribeInFlight = entry;
    void entry.tail.then(() => {
      if (this.subscribeInFlight === entry) this.subscribeInFlight = null;
    });
    return run;
  }

  private async subscribeOne(): Promise<void> {
    if (!this.active) return;
    const gen = this.gen;
    const addrs = this.hooks.addrs();
    // The address order is deterministic (planToCommands order), so a plain join
    // is a stable identity for the set — no sort needed.
    const key = addrs.map((a) => a.join(":")).join(",");
    if (this.unsub && key === this.registeredKey) return;
    this.registeredKey = key;
    this.unsub?.();
    this.unsub = null;
    // Dropped with the stream it stands for, before the await rather than after it: a
    // registration that throws leaves this method by an exception, and an unpaired
    // source would outlive the subscription it was armed for.
    this.settleSource?.();
    this.settleSource = null;
    const unsub = await vdParamsSubscribe(addrs, (p) => this.onNotify(p));
    // The session may have ended — or ended AND been restarted — while the
    // registration was in flight. The generation is what tells those apart:
    // `this.active` is true again in the second case, and installing this handle
    // there would drop the new session's live subscription on the floor with nobody
    // left to unsubscribe it.
    if (this.gen !== gen) {
      // Dropped, and unsubscribed ONLY when nothing has taken over. The handle is not
      // per-subscription: `vd_params_unsubscribe` takes no argument and acts on the
      // CURRENT connection, so calling it while a newer session is registered tears
      // down THAT session's stream — Live stays on, device follow goes deaf, and the
      // next sync writes over what the operator did on the hardware.
      //
      // With a session running, the old registration needs no cleanup anyway: a new
      // session is a new `vd_connect`, and the worker that held this registration was
      // stopped with the connection it belonged to. With none running, the connection
      // may still be up (`end()` deliberately does not touch it), and this is the call
      // that releases the stream — which is what it always was.
      if (!this.active) unsub();
      return;
    }
    this.unsub = unsub;
    // A write the unit was obliged to announce and never did, on an address outside
    // the scoped read that would have repaired it (settle.ts). Nothing else can say so:
    // the settle knows a write went silent and nothing about how to re-read, and this
    // side owns the only full reconcile. The idle net is the right one — it already
    // exists, it is the missed-notify safety net by construction, and a burst of these
    // during a drag costs one sweep after the drag rather than one each.
    this.settleSource = writeSettle.arm(() => this.armIdle());
  }

  private clearWindow(): void {
    this.scopedNodes.clear();
    this.touched.clear();
    this.forceFull = false;
  }

  private onNotify(p: ParamUpdate): void {
    if (!this.active) return;
    // Fed before every filter below. The answer to a write of ours IS an echo and a
    // host-owned address IS intercepted, so a settle told only about what survives
    // this method would never see the notify it is waiting for.
    writeSettle.note(p);
    // Host-owned address: handled there, and never part of a reconcile window — it
    // has no node, so letting it through would force a full re-read every time.
    if (this.hooks.intercept?.(p)) return;
    // Our own write (or a value we already hold) coming back — not a change. Ahead of
    // the rename branch, and it covers that branch too: the unit announces every name
    // write it accepts, so the OPERATOR's own rename in the app echoes back, and
    // counting that echo as a followed change armed the idle net — a full reconcile
    // whose reflect ends in `planHistory.reset()`, so one rename during Live sync cost
    // ~800 reads 900 ms later and took its own undo entry with it. The host dispatches
    // this hook on `valueStr` because the two snapshots are separate maps.
    if (this.hooks.isEcho(p)) return;
    // A device-side rename, which the numeric filters below cannot judge: it has no
    // catalog entry and no numeric value. Handled here and answered with the node, so
    // it stays a direct follow: one repaint, no readback.
    //
    // A string notify on an address that is NOT a name falls through, and where it lands
    // depends on whether the catalog knows the address. The SSMCS preset is one it does —
    // `lookup` resolves it to its owner node, so it takes that node's scoped read like any
    // other non-direct value. Anything the catalog does not know still reaches the
    // unknown-address path below, which is where an unrecognised shape belongs.
    if (p.valueStr !== undefined) {
      const node = this.hooks.applyName?.(p.paramId, p.x, p.y, p.valueStr);
      if (node !== undefined) {
        // The same tail the numeric direct path takes, and it is not optional: the
        // host coalesces renders behind `flushDirect`, and the idle net is what
        // catches a notify this method mis-routed. Returning before them left the
        // plan updated and nothing repainted — which looked exactly like the notify
        // never arriving.
        this.hooks.flushDirect();
        this.armIdle();
        return;
      }
    }
    // Signal "following" once at the start of a burst, not on every notify in it.
    if (this.settleTimer === null) this.hooks.onFollow();

    const addr = this.hooks.lookup(p.paramId, p.x, p.y);
    // An address in no index, or one whose owner is the whole device rather than a
    // node: a change worth a full read once the burst settles.
    if (addr === undefined || addr.node === undefined) {
      this.forceFull = true;
    } else {
      this.touched.add(`${addr.node}:${addr.name}`);
      // Direct: decode the value straight into the plan (host coalesces the render).
      // A param flagged direct but not actually placeable falls back to a scoped read.
      if (addr.direct && this.hooks.applyDirect(addr.node, addr.name, p.value)) {
        this.hooks.noteDirect(p.paramId, p.x, p.y, p.value);
        this.hooks.flushDirect();
      } else {
        this.scopedNodes.add(addr.node);
      }
      // More distinct controls at once than two hands can move is a scene / preset
      // recall, not hand operation, so escalate the settle to a full read.
      if (this.touched.size > MAX_CONCENTRATION) this.forceFull = true;
    }
    this.armSettle();
    this.armIdle();
  }

  private armSettle(): void {
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      void this.runReconcile(false);
    }, RECONCILE_DEBOUNCE_MS);
  }

  // After a longer quiet, run one full reconcile as a missed-notify safety net.
  private armIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.runReconcile(true);
    }, IDLE_FULL_MS);
  }

  private async runReconcile(idle: boolean): Promise<void> {
    if (!this.active) return;
    if (this.reconciling) {
      this.pending = true;
      if (idle) this.pendingFull = true;
      return;
    }
    // Decide the scope before the await: idle is always a full sweep; otherwise a
    // forced-full window (unknown / too many controls) re-reads everything, and a
    // pure-direct window (no scoped nodes) only needs a snapshot re-base.
    const full = idle || this.forceFull;
    const nodes = new Set(this.scopedNodes);
    this.clearWindow();
    if (!full && nodes.size === 0) {
      // Direct-only window: the values are already in the plan; just re-base the
      // live snapshot (flushDirect does the render + resync).
      this.hooks.flushDirect();
      return;
    }
    this.reconciling = true;
    try {
      if (full) await this.hooks.reconcileAll();
      else await this.hooks.reconcileNodes(nodes);
      // The reconcile may have changed the plan's structure (and so its writable
      // address set), so re-register against the post-reconcile set.
      await this.subscribe();
    } catch (e) {
      this.active = false;
      this.hooks.onError(e instanceof Error ? e.message : String(e));
      return;
    } finally {
      this.reconciling = false;
    }
    if (this.pending) {
      this.pending = false;
      const replayFull = this.pendingFull;
      this.pendingFull = false;
      void this.runReconcile(replayFull);
    }
  }
}
