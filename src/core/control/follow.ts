// Device follow: the reverse of live sync. While active, the app registers every
// writable parameter address for change notifies, so an edit made on the device
// itself (LCD / physical controls) is pulled back into the plan.
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
  /** Writable parameter addresses to register for notifies ([paramId, x, y]). */
  addrs: () => Array<[number, number, number]>;
  /** Whether an incoming notify is the echo of a known/just-written value. */
  isEcho: (p: ParamUpdate) => boolean;
  /** Resolve a notify address to its catalog name, owner node, and follow kind,
   *  or undefined when the address is not in the writable set. */
  lookup: (paramId: number, x: number, y: number) => FollowAddr | undefined;
  /** Apply one direct param change into the plan now (no read-back). Returns false
   *  when the param is not actually directly placeable (flagged direct but unhandled),
   *  so the caller falls back to a scoped read. */
  applyDirect: (node: string, name: ParamName, value: number) => boolean;
  /** A direct change was applied: request a re-render + live-snapshot re-base. The
   *  host coalesces these (one per animation frame), so calling it per notify during
   *  a sweep is cheap. */
  flushDirect: () => void;
  /** Scoped reconcile: re-read the given owner nodes, reflect them, re-render, and
   *  re-base the live snapshot. Read failures reject. */
  reconcileNodes: (nodeIds: ReadonlySet<string>) => Promise<void>;
  /** Full reconcile: re-read the whole device (escalation + idle safety net). */
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
  // The current settle window's accumulated state: nodes needing a scoped read,
  // distinct logical controls touched (node:name), and whether a full reconcile
  // is forced (an unknown address or too many controls at once).
  private scopedNodes = new Set<string>();
  private touched = new Set<string>();
  private forceFull = false;
  // Identity of the currently registered address set, so a reconcile that did not
  // change the plan's structure skips re-registering all ~hundreds of addresses.
  private registeredKey = "";

  constructor(private readonly hooks: DeviceFollowHooks) {}

  isActive(): boolean {
    return this.active;
  }

  /** Start following. Call after the live snapshot is captured (begin/resync), so
   *  the writable address set and its index are known. */
  begin(): void {
    this.active = true;
    this.subscribe();
  }

  /** Stop following and cancel any pending work. Does not touch the connection. */
  end(): void {
    this.active = false;
    this.pending = false;
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
  }

  // Register the current writable address set for notifies. The set rarely changes
  // (only a structural plan edit alters it), so when it matches what is already
  // registered this is a no-op rather than re-posting every address to the broker.
  private subscribe(): void {
    if (!this.active) return;
    const addrs = this.hooks.addrs();
    // The address order is deterministic (planToCommands order), so a plain join
    // is a stable identity for the set — no sort needed.
    const key = addrs.map((a) => a.join(":")).join(",");
    if (this.unsub && key === this.registeredKey) return;
    this.registeredKey = key;
    this.unsub?.();
    this.unsub = vdParamsSubscribe(addrs, (p) => this.onNotify(p));
  }

  private clearWindow(): void {
    this.scopedNodes.clear();
    this.touched.clear();
    this.forceFull = false;
  }

  private onNotify(p: ParamUpdate): void {
    if (!this.active) return;
    // Our own write (or a value we already hold) coming back — not a change.
    if (this.hooks.isEcho(p)) return;
    // Signal "following" once at the start of a burst, not on every notify in it.
    if (this.settleTimer === null) this.hooks.onFollow();

    const addr = this.hooks.lookup(p.paramId, p.x, p.y);
    // An address outside the writable set, or a global non-node address: a change
    // worth a full read once the burst settles.
    if (addr === undefined || addr.node === undefined) {
      this.forceFull = true;
    } else {
      this.touched.add(`${addr.node}:${addr.name}`);
      // Direct: decode the value straight into the plan (host coalesces the render).
      // A param flagged direct but not actually placeable falls back to a scoped read.
      if (addr.direct && this.hooks.applyDirect(addr.node, addr.name, p.value)) {
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
      this.subscribe();
    } catch (e) {
      this.active = false;
      this.hooks.onError(e instanceof Error ? e.message : String(e));
      return;
    } finally {
      this.reconciling = false;
    }
    if (this.pending) {
      this.pending = false;
      void this.runReconcile(false);
    }
  }
}
