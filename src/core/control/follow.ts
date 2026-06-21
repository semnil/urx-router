// Device follow (experimental): the reverse of live sync. While active, the app
// registers every writable parameter address for change notifies, so an edit made
// on the device itself (LCD / physical controls) is pulled back into the plan.
//
// Reconciliation reuses the proven device→plan inverse (applyDeviceState) rather
// than a second per-address decoder, mirroring how live.ts avoids a per-edit
// command builder: a settled device change triggers one debounced readback that
// pulls the whole plan into agreement and re-captures the live snapshot.
//
// Echoes are filtered by that snapshot: a notify whose value equals the device
// truth we last wrote/read is our own write coming back, not a fresh change.

import { vdParamsSubscribe, type ParamUpdate } from "../platform";

// A device-side change arrives as a burst (a knob sweep fires ~10 notifies/s);
// wait for it to settle before the (heavier) reconcile readback runs.
const RECONCILE_DEBOUNCE_MS = 250;

export interface DeviceFollowHooks {
  /** Writable parameter addresses to register for notifies ([paramId, x, y]). */
  addrs: () => Array<[number, number, number]>;
  /** Whether an incoming notify is the echo of a known/just-written value. */
  isEcho: (p: ParamUpdate) => boolean;
  /** A settled device-side change: pull the device into the plan, re-render, and
   *  re-capture the live snapshot. Reconcile readback failures reject. */
  reconcile: () => Promise<void>;
  /** A device-side change is being reflected — for an optional "← device" status. */
  onFollow: () => void;
  /** A reconcile failed; follow is already stopped — the caller drops the link. */
  onError: (message: string) => void;
}

export class DeviceFollow {
  private active = false;
  private unsub: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reconciling = false;
  private pending = false;
  // Identity of the currently registered address set, so a reconcile that did not
  // change the plan's structure skips re-registering all ~hundreds of addresses.
  private registeredKey = "";

  constructor(private readonly hooks: DeviceFollowHooks) {}

  isActive(): boolean {
    return this.active;
  }

  /** Start following. Call after the live snapshot is captured (begin/resync), so
   *  the writable address set is known. */
  begin(): void {
    this.active = true;
    this.subscribe();
  }

  /** Stop following and cancel any pending reconcile. Does not touch the connection. */
  end(): void {
    this.active = false;
    this.pending = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
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

  private onNotify(p: ParamUpdate): void {
    if (!this.active) return;
    // Our own write (or a value we already hold) coming back — not a change.
    if (this.hooks.isEcho(p)) return;
    // Signal "following" once at the start of a burst, not on every notify in it.
    if (this.timer !== null) clearTimeout(this.timer);
    else this.hooks.onFollow();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runReconcile();
    }, RECONCILE_DEBOUNCE_MS);
  }

  private async runReconcile(): Promise<void> {
    if (!this.active) return;
    if (this.reconciling) {
      this.pending = true;
      return;
    }
    this.reconciling = true;
    try {
      await this.hooks.reconcile();
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
      void this.runReconcile();
    }
  }
}
