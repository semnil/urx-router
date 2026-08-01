// Live sync: while active, every plan edit is mirrored to the connected device
// as it happens. Rather than build a per-edit command for each control, this
// keeps a snapshot of what the device last received (captured from a full
// readback when sync turns on) and, on each debounced flush, re-translates the
// whole plan and sends only the addresses whose value changed. The whole-plan
// translate is pure (no IO), so the diff is cheap; the IO is just the deltas.
// Connection lifecycle (connect/disconnect) is owned by the caller, which holds
// the connection open for the duration of the session.

import type { DeviceModel } from "../../models/types";
import type { Plan } from "../plan";
import { vdSet, vdSetStr } from "../platform";
import { PARAMS } from "./params";
import type { ParamName, ParamSpec } from "./params";
import {
  addrKey,
  cmdAddr,
  collisionKey,
  collisionOwners,
  formatAddrKey,
  planToCommands,
  planToNameWrites,
} from "./translate";
import type { SharedOwners, NameWrite, WriteScope } from "./translate";
import { reachedAndFailed, sendConverging } from "./client";

// Coalesce rapid edits (a slider drag fires per pixel) into one flush so the
// single-threaded device worker is not flooded; the snapshot diff means only the
// final value of each address is sent.
//
// This is a trailing THROTTLE, not a debounce that re-arms: a window absorbs
// whatever lands in it and then flushes. A re-arming debounce never fired at all
// while a drag was in motion — measured, a 500 ms drag at 25 ms intervals sent
// nothing until the pointer stopped, so the device only heard the end of every
// move. One flush costs a whole-plan translate + diff, measured at 0.20 ms for
// the URX44V default plan (782 commands) in both V8 and WebKit, so flushing per
// window rather than per gesture is 0.2% of a core.
const DEBOUNCE_MS = 120;

// Params whose write makes the device move other values (the catalog flags these with
// sideEffect), split by who owns what moved. CONVERGE = the device reset values the plan
// authors, so they are pushed back; REFETCH = the device wrote values the plan only
// mirrors (the EQ 1-knob's four bands), so the owner node is read instead — pushing
// would fight it. See ParamSpec.sideEffect.
const CONVERGE = new Set<string>();
const REFETCH = new Set<string>();
for (const [name, spec] of Object.entries(PARAMS as Record<string, ParamSpec>)) {
  if (spec.sideEffect === "converge") CONVERGE.add(name);
  else if (spec.sideEffect === "refetch") REFETCH.add(name);
}

// The address key comes from translate.ts, which uses the same one to decide which
// commands collapse: a second spelling here would let a collapsed command miss its
// snapshot entry.
const nameKey = (w: NameWrite): string => `${w.param}:${w.y}`;

/** What a writable address resolves to, for device-follow routing of a notify. */
export interface FollowAddr {
  /** Catalog parameter name (its follow strategy comes from PARAMS[name]). */
  name: ParamName;
  /** Owner node id the address belongs to (undefined for a global address). */
  node?: string;
  /** True when the param is flagged follow: "direct" — apply the notify value
   *  straight into the plan with no read-back; false → re-read the owner node. */
  direct: boolean;
}

export interface LiveSyncHooks {
  getModel: () => DeviceModel;
  getPlan: () => Plan;
  /** A write failed; sync is already stopped — the caller drops the connection. */
  onError: (message: string) => void;
  /** A flush sent `count` writes — for an optional, quiet "→ device" status. */
  onSent: (count: number) => void;
  /** Two or more plan owners resolved to one device address and the emitted set
   *  kept the last; the rest carried a different value and were dropped. Reported
   *  once per distinct owner set, not once per flush. */
  onCollapsed: (owners: SharedOwners[]) => void;
  /** Write scope for the session (see translate.ts WriteScope). Read at every
   *  snapshot / flush, so the one planToCommands filter also scopes the notify
   *  registration and echo detection. Absent = "all". */
  getScope?: () => WriteScope;
  /** Read these nodes back from the device and apply them to the plan — the repair a
   *  "refetch" sideEffect needs. Supplied by the caller rather than called here, so
   *  this module keeps its one direction of travel (plan → device) and the device→plan
   *  inverse stays in the one place that owns it. Absent = no refetch (the browser
   *  build, and the tests that do not exercise it). Resolves the private copy its read
   *  ran against (readback.readIntoPlan) — that copy is what the device holds as far as
   *  the read established it, and so what the snapshot re-base measures from. Null when
   *  the plan it read into has been replaced: there is then nothing to re-base. */
  refetchNodes?: (nodes: ReadonlySet<string>) => Promise<Plan | null>;
}

export class LiveSync {
  private active = false;
  private readonly snapshot = new Map<number, number>();
  private readonly nameSnapshot = new Map<string, string>();
  // The snapshot's writable addresses as numeric [paramId, x, y] triples, built
  // alongside the snapshot so device-follow registration needs no key re-parse.
  private writableAddrList: Array<[number, number, number]> = [];
  // Address → {name, owner node, direct?} for the writable parameter set, built
  // with the snapshot from the same planToCommands pass. Lets device-follow route
  // an incoming notify to a direct apply or a scoped readback with no key re-parse.
  private readonly index = new Map<number, FollowAddr>();
  // Every direct-follow notify the session has taken, as address → the last value the
  // device reported and the journal position it arrived at. A re-base rebuilds the whole
  // snapshot from the private clone a read ran against, and that clone was taken when the
  // read was ISSUED — so it cannot carry a notify that landed while the read was in
  // flight, and the rebuild would drop the entry noteDirect wrote for it. The device's
  // next notify for that address would then match the stale snapshot entry, be dropped as
  // our own echo, and the following flush would write the operator's own move on the
  // hardware back off the board. Keyed by address, so it holds one entry per writable
  // address however long the session runs.
  private readonly directJournal = new Map<number, { value: number; at: number }>();
  private directSeq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private pending = false;
  // The last flush had to converge (a sideEffect param went out), which re-reads
  // the whole write scope and settles between rounds — seconds, not milliseconds.
  // That alone does not decide anything: it only says the next schedule() should
  // ask the diff whether the same is about to happen again (convergePending).
  private lastFlushConverged = false;
  // Identity of the owner set the last collapse report named (collisionKey), so a
  // standing collision is said once rather than once per flush — it is a structural
  // condition ("these two nodes share one engine"), not a per-edit event, and a drag
  // anywhere in the plan re-derives it every window. It re-arms on a flush that finds
  // no collision at all AND on every capture(), because a capture re-bases from device
  // truth and the collision it named may no longer be the plan's. Deliberately NOT
  // re-armed by elapsed time: the emitted list carries a standing collision whatever
  // the operator is editing, so a timed re-arm would repeat it during unrelated work.
  private collapsedKey = "";

  constructor(private readonly hooks: LiveSyncHooks) {}

  isActive(): boolean {
    return this.active;
  }

  private scope(): WriteScope {
    return this.hooks.getScope?.() ?? "all";
  }

  /** Start syncing. Call right after a full readback, passing the private copy that
   *  read ran against — without it an edit made during the multi-second starting read
   *  is enshrined as a value the device was already given. Omit it only where the plan
   *  itself is device truth (no read spanned an await). */
  begin(deviceView?: Plan): void {
    this.directJournal.clear();
    this.directSeq = 0;
    this.capture(deviceView);
    this.active = true;
  }

  /** Re-capture the device-truth snapshot after a device-follow readback has pulled the
   *  plan into agreement with the device, so the next outgoing diff measures from the
   *  device truth (and so device-side notifies for the just-read values register as
   *  echoes). Pass the copy the readback ran against, or an edit made during that read
   *  is recorded as device truth and stops being a diff — and `since`, the mark taken
   *  when that read was issued, or the direct notifies it could not carry are dropped. */
  resync(deviceView?: Plan, since?: number): void {
    this.capture(deviceView, since);
  }

  /** The journal position to hand back to resync() with the view a read produces. Taken
   *  when the read is ISSUED: every direct notify after it is device truth the read's
   *  private clone predates, and is restored over the rebuild. */
  directMark(): number {
    return this.directSeq;
  }

  /** Patch one snapshot entry to a device-reported value (a direct follow notify),
   *  so the next outgoing diff measures from it without a full re-translate. The
   *  notify value is the same broker raw value the snapshot stores, and a direct
   *  change never alters the writable-address set or the name snapshot, so patching
   *  the single entry keeps the snapshot in agreement with the device. */
  noteDirect(paramId: number, x: number, y: number, value: number): void {
    const k = addrKey(paramId, x, y);
    this.snapshot.set(k, value);
    this.directJournal.set(k, { value, at: ++this.directSeq });
  }

  /** Every writable parameter address the current plan maps to, as [paramId, x, y]
   *  triples — the set to register for device-side change notifies. Captured with
   *  the snapshot, so it must be called after begin()/resync(). Read-only. */
  writableAddrs(): Array<[number, number, number]> {
    return this.writableAddrList;
  }

  /** What the snapshot currently holds, as "paramId:x:y" → value. A copy, and the
   *  packed keys are rendered back to the published string form: the caller is the
   *  trace probe, and a poisoned snapshot is only detectable by comparing what it
   *  records against what was actually sent (see src/ui/trace-probe.ts). */
  snapshotEntries(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.snapshot) out[formatAddrKey(k)] = v;
    return out;
  }

  /** Whether an incoming device notify equals the snapshotted device truth — i.e.
   *  it is the echo of a value we just wrote (or already knew), not a fresh
   *  device-side change. An address we do not track returns false (treat as a
   *  change worth reconciling). */
  isEcho(paramId: number, x: number, y: number, value: number): boolean {
    return this.snapshot.get(addrKey(paramId, x, y)) === value;
  }

  /** Stop syncing and cancel any pending flush. Does not touch the connection. */
  end(): void {
    this.active = false;
    this.pending = false;
    this.lastFlushConverged = false;
    this.collapsedKey = "";
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Note a plan change; a flush runs at the end of the current window. No-op when
   *  inactive. */
  schedule(): void {
    if (!this.active) return;
    if (this.timer !== null) {
      // A window is already armed and will pick this change up with the rest —
      // unless what is waiting in it would converge, in which case re-arm so a
      // continuous stream waits for quiet rather than starting a converge round
      // per window. Asking the diff, not "did the last flush converge": that
      // latch alone would silence the first drag after any converge, whatever it
      // touched, which is the behaviour the throttle exists to remove.
      if (!this.lastFlushConverged || !this.convergePending()) return;
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, DEBOUNCE_MS);
  }

  /** Would flushing now send a sideEffect param? Runs the same whole-plan translate
   *  the flush does (0.2 ms for a URX44V plan), so it is only consulted while the
   *  previous flush converged — the state where the answer changes what happens. */
  private convergePending(): boolean {
    const model = this.hooks.getModel();
    const plan = this.hooks.getPlan();
    for (const c of planToCommands(model, plan, this.scope())) {
      if (CONVERGE.has(c.name) && this.snapshot.get(cmdAddr(c)) !== c.vdValue) return true;
    }
    return false;
  }

  /**
   * Rebuild the device-truth snapshot. SHAPE comes from the live plan (which addresses
   * exist at all, and so what is registered for notifies); VALUES come from
   * `deviceView`, the private copy a readback ran against. Absent = the live plan is
   * itself device truth, which is only so when nothing was read across an await.
   *
   * The split is the whole point: an address the operator moved during the read holds
   * their value in the live plan and the device's in the view, so it stays a diff and
   * the next flush sends it. Snapshotting the live plan instead records their edit as a
   * value the device was given, and nothing ever retries it.
   *
   * The NAME snapshot takes both from `deviceView`, and needs no split: the flush
   * iterates the live plan's name writes and sends any whose key the snapshot does not
   * hold, so a name typed during the read is sent for exactly the reason an address the
   * view does not carry is — absence from the snapshot IS the diff. The extra entries a
   * name dropped during the read leaves behind are never consulted.
   *
   * `since` is the journal mark the read carried; the direct-follow notifies that landed
   * after it are re-applied over the rebuild. Those entries are DEVICE truth the view
   * predates, not the plan's — the rule that a re-base never takes a value from the live
   * plan is unchanged.
   */
  private capture(deviceView?: Plan, since?: number): void {
    // A re-base re-authors the plan from the device, so a collision reported against the
    // pre-read plan may already be gone — a reconcile reads the shared address once and
    // assigns it to both owners, which erases the divergence. Nothing schedules a flush
    // after a reconcile (planValuesChanged, unlike markChanged, does not), so the report
    // latch has to clear here or the next genuine loss of that same pair is swallowed.
    this.collapsedKey = "";
    const model = this.hooks.getModel();
    const scope = this.scope();
    const plan = this.hooks.getPlan();
    // Every caller passes a private copy (readback's clone, or the converge's own),
    // so a view is never the live plan itself.
    const device = deviceView
      ? new Map(planToCommands(model, deviceView, scope).map((c) => [cmdAddr(c), c.vdValue] as const))
      : null;
    this.snapshot.clear();
    this.nameSnapshot.clear();
    this.index.clear();
    const addrs: Array<[number, number, number]> = [];
    for (const c of planToCommands(model, plan, scope)) {
      const k = cmdAddr(c);
      // An address the view does not carry grew after the read was issued (a structural
      // edit made during it). It is a pending write, not device truth, so it is left out
      // of the snapshot entirely and the next diff sends it.
      const known = device ? device.get(k) : c.vdValue;
      if (known !== undefined) this.snapshot.set(k, known);
      addrs.push([c.paramId, c.x, c.y]);
      const direct = (PARAMS as Record<string, ParamSpec>)[c.name].follow === "direct";
      this.index.set(k, { name: c.name, node: c.node, direct });
    }
    this.writableAddrList = addrs;
    for (const w of planToNameWrites(model, deviceView ?? plan)) this.nameSnapshot.set(nameKey(w), w.value);
    if (since === undefined) return;
    // Restore what the view could not know: a notify the device sent after the read was
    // issued. Confined to the addresses this capture registered, so the shape still comes
    // from the live plan alone.
    for (const [k, entry] of this.directJournal) {
      if (entry.at > since && this.index.has(k)) this.snapshot.set(k, entry.value);
    }
  }

  /** Resolve an incoming device notify address to its catalog name, owner node,
   *  and follow strategy — or undefined when the address is not in the writable
   *  set (the caller treats that as an unknown change worth a full reconcile). */
  lookup(paramId: number, x: number, y: number): FollowAddr | undefined {
    return this.index.get(addrKey(paramId, x, y));
  }

  private async flush(): Promise<void> {
    if (!this.active) return;
    if (this.flushing) {
      this.pending = true;
      return;
    }
    this.flushing = true;
    try {
      const model = this.hooks.getModel();
      const plan = this.hooks.getPlan();
      let sent = 0;
      let sideEffect = false;
      const refetch = new Set<string>();
      const commands = planToCommands(model, plan, this.scope());
      for (const c of commands) {
        const k = cmdAddr(c);
        if (this.snapshot.get(k) === c.vdValue) continue;
        await vdSet(c.paramId, c.x, c.y, c.vdValue);
        this.snapshot.set(k, c.vdValue);
        sent++;
        if (CONVERGE.has(c.name)) sideEffect = true;
        else if (REFETCH.has(c.name) && c.node) refetch.add(c.node);
      }
      for (const w of planToNameWrites(model, plan)) {
        const k = nameKey(w);
        if (this.nameSnapshot.get(k) === w.value) continue;
        await vdSetStr(w.param, 0, w.y, w.value);
        this.nameSnapshot.set(k, w.value);
        sent++;
      }
      this.lastFlushConverged = sideEffect;
      if (sideEffect) {
        // The device reset dependents; converge against its post-reset state and
        // rebuild the snapshot so the next diff measures from the device truth.
        // Converge against a frozen copy, not the live plan: an edit that arrives
        // during the (awaited) converge must stay a diff for the trailing flush,
        // not get baked into the snapshot here as if already on the device (which
        // would silently drop it). The mark is taken beside the freeze, for the
        // other half of the same window: a direct notify arriving during the
        // converge is device truth this copy is too old to carry.
        const since = this.directSeq;
        const converged = structuredClone(plan);
        const r = await sendConverging(model, converged, { scope: this.scope() });
        // sendConverging reports per-command failures instead of rejecting, so a
        // failed write here would otherwise be swallowed — and captureSnapshot
        // would then record the plan as device truth, leaving those parameters
        // diverged for the rest of the session with no diff left to retry them.
        // Route it into the same teardown a direct write failure takes.
        const failed = r.outcomes.find(reachedAndFailed);
        if (failed || r.readErrors.length) {
          throw new Error(failed?.error ?? r.readErrors[0] ?? "converge failed");
        }
        this.capture(converged, since);
      }
      // A refetch after the converge, if both happened: converge rebuilds the snapshot
      // from the plan, and the read that follows is what makes the plan right.
      if (refetch.size && this.hooks.refetchNodes) {
        // Sampled before the call, which issues its read (and takes its private copy)
        // synchronously — so the mark and the copy describe the same instant.
        const since = this.directSeq;
        const deviceView = await this.hooks.refetchNodes(refetch);
        // The read ran against its own copy of the plan (readback.readIntoPlan), so the
        // copy is what the device holds: re-base from it and an edit made during the
        // await — on the read node or any other — stays a diff. Null = the plan it read
        // into is gone, and there is nothing a snapshot could describe.
        if (deviceView) this.capture(deviceView, since);
      }
      if (sent) this.hooks.onSent(sent);
      // After onSent because the status line is last-writer-wins, and never from
      // capture(), whose report the session's own "live sync on" would overwrite.
      const owners = collisionOwners(commands);
      const key = collisionKey(owners);
      if (key !== this.collapsedKey) {
        this.collapsedKey = key;
        if (owners.length) {
          console.warn("live: one device address, more than one plan owner", owners);
          this.hooks.onCollapsed(owners);
        }
      }
    } catch (e) {
      this.active = false;
      this.hooks.onError(e instanceof Error ? e.message : String(e));
      return;
    } finally {
      this.flushing = false;
    }
    if (this.pending) {
      this.pending = false;
      void this.flush();
    }
  }
}
