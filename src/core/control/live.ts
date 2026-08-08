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
  nameControl,
  planToNameWrites,
} from "./translate";
import type { SharedOwners, NameWrite, WriteScope } from "./translate";
import { reachedAndFailed, sendConverging } from "./client";
import { writeSettle } from "./settle";
import type { PendingWrites } from "./settle";

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
   *  the plan it read into has been replaced: there is then nothing to re-base.
   *
   *  `pending` is what THIS flush put on the device and the device acked. The unit acks
   *  a write before the value is readable, and this read is issued in the same
   *  millisecond as the last ack, so the read holds until the unit has spoken for the
   *  addresses it is about to ask for, and answers each of them with WHAT THE UNIT
   *  ANNOUNCED (settle.ts, readback's writeOverlay). Never with what was sent: an acked
   *  write the unit silently discarded is indistinguishable from one it took, and
   *  answering it from the send would record our value as device truth with no diff left
   *  to retry. Both halves happen inside the read, where its own clone and witness cover
   *  an edit made meanwhile — hence a value handed over rather than a wait taken here.
   *  Without it the read put the value the edit had just replaced back into the plan, the
   *  capture below recorded it as device truth, and the unit's own notify for our write
   *  then failed isEcho and was reconciled as a device-side change. */
  refetchNodes?: (nodes: ReadonlySet<string>, pending: PendingWrites) => Promise<Plan | null>;
}

export class LiveSync {
  private active = false;
  // Which session a flush belongs to. Bumped by begin() and end(), and read after every
  // await in the send loops: `end()` is synchronous while a loop is not, so a flush that
  // checked only at its entry finishes sending against a link the app has already
  // disconnected — and after a model switch (loadPlan -> deactivateLive -> end) it sends
  // addresses the plan on screen does not have. A generation rather than the `active`
  // flag, because a session that ended and began again inside one await leaves the flag
  // at the value the flush entered on while every snapshot under it has been rebuilt.
  private sessionGen = 0;
  private readonly snapshot = new Map<number, number>();
  private readonly nameSnapshot = new Map<string, string>();
  // Name address -> owner node. Kept apart from `index` because a name is not a
  // VdCommand: it has no catalog entry, no follow strategy and no value in the
  // numeric snapshot. Registering the addresses without this map would make every
  // rename an UNKNOWN address, which follow.ts escalates to a whole-device read.
  private readonly nameIndex = new Map<number, string>();
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
  // Bumped by every write the FOLLOW side makes into a snapshot — noteDirect's single entry
  // and capture()'s two whole rebuilds. A flush translates the plan once and then awaits
  // per command, so the lists it walks can grow older than the snapshots it diffs each
  // command against: the loop reaches an address the device moved mid-flush, finds its
  // frozen command disagreeing with the fresh entry, and sends a value the plan has
  // stopped holding — the device's own previous one, back over the hand still on the knob.
  // This is what lets a running flush notice and re-take its translate.
  //
  // A COUNTER rather than a dirty flag, because the flush has two independent consumers
  // (the value loop and the name loop) and a flag one of them cleared would be invisible to
  // the other. Each holds its own last-seen value instead. Separate from `directSeq`, which
  // counts only `noteDirect` and whose marks the journal compares with `>`.
  //
  // It is a SNAPSHOT write standing in for a PLAN write, which works only because every
  // device-side plan write is synchronously followed by one (follow.ts applyDirect →
  // noteDirect; every reconcile → resync). A follow path that merged into the plan without
  // touching a snapshot would re-open the hole here in silence.
  private snapshotEpoch = 0;
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
    this.sessionGen++;
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
    this.snapshotEpoch++;
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
    this.sessionGen++;
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
  /** A plan's writable addresses and the values it would send, as the flush's diff and the
   *  snapshot's rebuild both need them. One spelling, because the two are required to
   *  agree: the flush diffs against a snapshot this same function built, and an address
   *  key or a value derived differently on one side would be a silent mismatch. */
  private commandValues(model: DeviceModel, plan: Plan, scope: WriteScope): Map<number, number> {
    return new Map(planToCommands(model, plan, scope).map((c) => [cmdAddr(c), c.vdValue] as const));
  }

  private capture(deviceView?: Plan, since?: number): void {
    // A re-base re-authors the plan from the device, so a collision reported against the
    // pre-read plan may already be gone — a reconcile reads the shared address once and
    // assigns it to both owners, which erases the divergence. Nothing schedules a flush
    // after a reconcile (planValuesChanged, unlike markChanged, does not), so the report
    // latch has to clear here or the next genuine loss of that same pair is swallowed.
    this.collapsedKey = "";
    this.snapshotEpoch++;
    const model = this.hooks.getModel();
    const scope = this.scope();
    const plan = this.hooks.getPlan();
    // Every caller passes a private copy (readback's clone, or the converge's own),
    // so a view is never the live plan itself.
    const device = deviceView ? this.commandValues(model, deviceView, scope) : null;
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
    // Name addresses join the registration set. They are not in `planToCommands`
    // (the app writes names through a separate string path), so for the life of the
    // follow layer they were in no registration and `Subs::absorb` dropped every
    // rename notify — the unit announces one, measured on a URX44V, and nothing was
    // listening. ~17 addresses against ~800, and a name notify only fires when
    // someone renames, so the steady-state cost is nil.
    this.nameIndex.clear();
    for (const node of model.nodes) {
      const nc = nameControl(model, node.id);
      if (!nc) continue;
      for (const y of nc.instances) {
        addrs.push([nc.param, 0, y]);
        this.nameIndex.set(addrKey(nc.param, 0, y), node.id);
      }
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

  /** The node a name address belongs to, or undefined when it is not one. */
  lookupName(paramId: number, x: number, y: number): string | undefined {
    return this.nameIndex.get(addrKey(paramId, x, y));
  }

  /** The string-path echo test. Separate from `isEcho` because names live in their
   *  own snapshot: the numeric one has no entry for them, so asking it would call
   *  the app's own rename a device-side change and bounce it back. */
  isEchoName(paramId: number, y: number, value: string): boolean {
    return this.nameSnapshot.get(`${paramId}:${y}`) === value;
  }

  /** Record a name the device reported, so the next flush does not re-send it and
   *  the next notify for it reads as an echo. The string half of `noteDirect`. */
  noteDirectName(paramId: number, y: number, value: string): void {
    this.nameSnapshot.set(`${paramId}:${y}`, value);
  }

  private async flush(): Promise<void> {
    if (!this.active) return;
    if (this.flushing) {
      this.pending = true;
      return;
    }
    this.flushing = true;
    try {
      // The session this flush is for. `model` and `plan` below are captured once and the
      // re-take at the head of the loop reads those captures, so once the generation moves
      // both describe a document that is no longer open — which is the same instant at
      // which nothing may be sent any more. One check answers both.
      const gen = this.sessionGen;
      const model = this.hooks.getModel();
      const plan = this.hooks.getPlan();
      let sent = 0;
      let sideEffect = false;
      const refetch = new Set<string>();
      // What this flush wrote and the device acked, keyed the way the snapshot is
      // (translate.addrKey). Handed to the refetch, whose read would otherwise be issued
      // inside the window in which the unit still answers these addresses with the
      // values these writes replaced. Bounded by the flush's own diff.
      //
      // `mark` is taken immediately before that address's own vdSet, because only a
      // notify after it can be the announcement of that write; one mark for the whole
      // flush would let a device-side notify for the fader confirm a write the loop had
      // not reached yet. `changed` says the snapshot held a DIFFERENT value, so the unit
      // must change and must announce it — as against an address the snapshot held NO
      // entry for, whose write may be a value the unit already holds, and a no-op write
      // emits no notify at all (measured). `node` decides which of the two subsets below
      // the address lands in, and cannot be resolved until the loop has finished: the
      // command that puts a node into `refetch` may come after the ones that wrote it.
      const writes = new Map<number, { mark: number; node?: string; changed: boolean }>();
      const scope = this.scope();
      const commands = planToCommands(model, plan, scope);
      // Both lists below are frozen at flush start; the snapshots they are diffed against
      // are not. Any await can let a device-side change land (noteDirect's one entry, or a
      // reconcile's whole capture), and what a frozen list carries is then older than what
      // the plan holds. `fresher` re-takes the values on the first command after that
      // happened, so what goes out is a value the plan holds NOW and a device-authored one
      // can never be sent back at the device as an app write.
      //
      // Only the VALUES are re-taken. The ORDER stays this flush's own, because order binds
      // meaning (a type selector types the array after it), and an address the plan only
      // just grew stays out — that is a pending app edit, and its own markChanged has
      // already scheduled the trailing flush that carries it.
      //
      // A re-take is the same ~0.13 ms translate the flush opened with, and it is paid only
      // in the windows where a notify or a reconcile actually landed inside the loop.
      let valuesAt = this.snapshotEpoch;
      let fresh: Map<number, number> | null = null;
      for (const c of commands) {
        const k = cmdAddr(c);
        if (this.snapshotEpoch !== valuesAt) {
          valuesAt = this.snapshotEpoch;
          fresh = this.commandValues(model, plan, scope);
        }
        // Absent from the re-take = the address left the plan while this flush ran, so
        // there is nothing left to send to it.
        const value = fresh ? fresh.get(k) : c.vdValue;
        if (value === undefined) continue;
        const had = this.snapshot.get(k);
        if (had === value) continue;
        // Taken before the send, not after it: a notify that lands while this very
        // vdSet is in flight cannot be placed on either side of it, and the safe
        // reading is that it is the answer to this write. A misattribution either way
        // is self-correcting — the real answer arrives later and overwrites it — so
        // what the mark buys is one fewer spurious reconcile, not the merge's
        // correctness (settle.ts).
        const mark = writeSettle.mark();
        await vdSet(c.paramId, c.x, c.y, value);
        // Nothing below this line belongs to a session that has gone: the remaining
        // commands would go out over a disconnected link, and the snapshot they would be
        // recorded in has already been rebuilt by whatever ended (or replaced) it.
        if (this.sessionGen !== gen) return;
        this.snapshot.set(k, value);
        writes.set(k, { mark, node: c.node, changed: had !== undefined });
        sent++;
        if (CONVERGE.has(c.name)) sideEffect = true;
        else if (REFETCH.has(c.name) && c.node) refetch.add(c.node);
      }
      // The name loop needs the same guard for the same reason: capture() rebuilds the NAME
      // snapshot too, so a reconcile resolving inside one of these awaits leaves the frozen
      // list carrying a string the plan has stopped holding. Rarer than a value — only a
      // readback can bring a device-side name in — and never yet caught in the harness, but
      // it is one structure, so it gets one rule.
      let namesAt = this.snapshotEpoch;
      let freshNames: Map<string, string> | null = null;
      for (const w of planToNameWrites(model, plan)) {
        const k = nameKey(w);
        if (this.snapshotEpoch !== namesAt) {
          namesAt = this.snapshotEpoch;
          freshNames = new Map(planToNameWrites(model, plan).map((n) => [nameKey(n), n.value]));
        }
        const value = freshNames ? freshNames.get(k) : w.value;
        if (value === undefined) continue;
        if (this.nameSnapshot.get(k) === value) continue;
        await vdSetStr(w.param, 0, w.y, value);
        if (this.sessionGen !== gen) return;
        this.nameSnapshot.set(k, value);
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
        // The loop seeds its own diff by reading the device, and this flush wrote
        // that device a millisecond ago — so the same handle the refetch gets goes
        // here too, and for the same reason. `mustSettle` is left to the loop:
        // its read covers the whole write scope, not one node's worth (see
        // client.ts). Only the marks and the addresses matter here; the loop
        // reads the unit rather than answering from an announcement, because
        // what it is after is the values the unit RESET, which are not these.
        const seedPending: PendingWrites = {
          written: new Map([...writes].map(([k, w]) => [k, w.mark])),
          mustSettle: new Set(writes.keys()),
          mustAnnounce: new Set(),
        };
        const r = await sendConverging(model, converged, { scope: this.scope(), pending: seedPending });
        // Same rule as the send loops, and before the failure check on purpose: once the
        // session is gone there is nobody left to report a failed converge to, and the
        // capture below would write a dead plan's values into a rebuilt snapshot.
        if (this.sessionGen !== gen) return;
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
        // Sampled before the call, which takes its private copy synchronously — so the
        // mark and the copy describe the same instant. The read's own settle happens
        // after that copy, so a direct notify landing in it is device truth the copy
        // predates, which is exactly what this mark restores.
        const since = this.directSeq;
        // Split by whether this read is going to ASK the unit about the address.
        //
        //   - inside its scope: the read re-reads that whole node, so this is an address
        //     it may ask the unit about and it may not start before the unit has spoken
        //     for it. By node rather than by which addresses the pass actually reads,
        //     because the two lists would then have to agree for ever and the cost of
        //     the conservative reading is one wait the pass shares with its neighbours
        //     anyway. A changed write ends that wait at its own notify
        //     (9-204 ms measured, and the collateral the read is FOR went fresh 1-2 ms
        //     behind it); one the snapshot held no entry for can only end at the bound,
        //     since it may be a no-op the unit never announces.
        //   - outside it: not read, so nothing here confirms or repairs it. A CHANGED
        //     one the unit never announces is a write that went nowhere, and the settle
        //     reports it to the follow side, which arms its idle full reconcile — the
        //     only repair available without widening this read, which is what the
        //     scoping is for. A no-op write legitimately says nothing and is left alone.
        //
        // Nothing is withdrawn from this handle, and nothing needs to be. The read is
        // answered from what the unit ANNOUNCED, and the last announcement wins — so an
        // address the operator moved on the board after our write comes back carrying
        // THEIR value, which is the answer the withdrawal used to reach by falling back
        // to a read. A capture() landing inside the flush needs no answer either: it
        // re-authors the snapshot from a device read, and a device read cannot contradict
        // a later word from the same device.
        const written = new Map<number, number>();
        const mustSettle = new Set<number>();
        const mustAnnounce = new Set<number>();
        for (const [k, w] of writes) {
          written.set(k, w.mark);
          if (w.node !== undefined && refetch.has(w.node)) mustSettle.add(k);
          else if (w.changed) mustAnnounce.add(k);
        }
        const deviceView = await this.hooks.refetchNodes(refetch, { written, mustSettle, mustAnnounce });
        if (this.sessionGen !== gen) return;
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
