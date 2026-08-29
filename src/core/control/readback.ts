// Read the device's current settings back into the plan: the reverse of
// translate.ts. For each confirmed parameter we can both read and show in the
// UI, fetch the live value, decode it to plan units, and write it onto the plan.
// Today that is each channel's main fader / pan (CH_FADER / CH_PAN), reflected
// onto its fixed STEREO send so the inspector shows the on-device level and pan.

import type { DeviceModel } from "../../models/types";
import { ref } from "../../models/types";
import type {
  ConnParams,
  EqBand,
  EqOneKnobParams,
  FxEffectParams,
  NodeParams,
  Plan,
  PlanConnection,
  SsmcsBand,
  SsmcsParams,
} from "../plan";
import {
  clearIncoming,
  ensureFixedConnections,
  normalizeNodeName,
  removeConnection,
  setExclusiveConnection,
} from "../plan";
import {
  applyPatchInContext,
  clonePlanState,
  diffPlans,
  dropAuthored,
  nodeParamContestKey,
  readableContestKey,
} from "../plan-history";
import type { PlanPatch, PlanWriteWitness } from "../plan-history";
import { vdGet as vdGetLive, vdGetStr as vdGetStrLive } from "../platform";
import {
  colorIndexToHex,
  COMP_EQ_SSMCS,
  FX_STEREO_ASSIGN_ON,
  insertFxAvailable,
  insertFxSelected,
  normalizeInsertFx,
  PARAMS,
} from "./params";
import type { ParamName } from "./params";
import { writeSettle } from "./settle";
import type { PendingWrites } from "./settle";
import { FX_EFFECT_ARRAY_PARAM, FX_EFFECT_TYPE_PARAM, FX_SLOT_LEVEL, FX_SLOT_ON, fxParams } from "./fx-effect";
import { insertFxEngine, insertFxFamilyOf, insertFxReadableSlots, mergeReadInsertFxParams } from "./insert-fx-effect";
import { pairPrimary } from "../routing";
import type { EmittedDynField, EqControl, EqOneKnobControl } from "./translate";
import {
  addrKey,
  busBalance,
  busEqOn,
  busFader,
  busMasterOn,
  channelControl,
  channelDynamics,
  channelSections,
  colorControl,
  nameControl,
  DUCKER_FIELDS,
  duckerControl,
  channelInputSlots,
  eqOneKnob,
  fxChannelIndex,
  inputEq,
  inputNodeForPort,
  insertFxControl,
  isStereoChannel,
  MIX_FADER_INSTANCES,
  nodeForPort,
  OSC_ASSIGN_BUSES,
  oscAssign,
  outputEq,
  recordSlots,
  ROUTING_SELECTORS,
  sendControl,
  stereoIndexMap,
} from "./translate";
import type { ParamEncoding } from "./params";
import {
  strToSweetSpotData,
  vdToAttack,
  vdToBool,
  vdToBurstWidth,
  vdToCentiDb,
  vdToGateRange,
  vdToDelayTime,
  vdToPhonesLevel,
  vdToEqFreq,
  vdToEqGain,
  vdToFreq,
  vdToGain,
  vdToHold,
  vdToLevel,
  vdToPan,
  vdToPortRef,
  vdToQ,
  vdToRatio,
  vdToRelease,
} from "./vd";

/**
 * Where one readback pass reads parameters from. The live device is the default;
 * an offline source (a parsed .urxf settings file) serves the same broker address
 * space from memory, so the whole device→plan inverse below is reused verbatim
 * instead of growing a second, drifting copy of it.
 */
export interface ParamSource {
  get(paramId: number, x: number, y: number): Promise<number>;
  getStr(paramId: number, x: number, y: number): Promise<string>;
}

// Delegating rather than referencing the imports directly: the binding is resolved
// per call, so a group that never reads a string never touches vdGetStr — which is
// what lets a test stub only the accessor its path uses (several control tests mock
// ../platform with vdGet alone).
const LIVE_SOURCE: ParamSource = {
  get: (paramId, x, y) => vdGetLive(paramId, x, y),
  getStr: (paramId, x, y) => vdGetStrLive(paramId, x, y),
};

// The source travels as a parameter, not module state: each pass and each reading
// helper binds its own vdGet / vdGetStr from it, so overlapping passes (a device
// follow reconcile while a file import runs) cannot read each other's source and
// need no guard against doing so. The call sites below stay unchanged either way.
type Readers = {
  vdGet: (paramId: number, x: number, y: number) => Promise<number>;
  vdGetStr: (paramId: number, x: number, y: number) => Promise<string>;
};

function readers(source: ParamSource): Readers {
  return {
    vdGet: (paramId, x, y) => source.get(paramId, x, y),
    vdGetStr: (paramId, x, y) => source.getStr(paramId, x, y),
  };
}

/**
 * A source that answers an address out of what the DEVICE ANNOUNCED about it, and
 * reads everything else.
 *
 * The unit acks a write before the value is readable: measured on a URX44V, a GET of a
 * just-written address answers the PRE-write value until that write's own change notify
 * arrives, 9-204 ms after the write was issued (n = 87, value-paired). The caller
 * settles first (see settle.ts), so every entry here is a value the unit itself has
 * spoken. What that adds over reading the address is a statement of a different kind:
 * an announcement names what the unit took, where a read anywhere near the boundary can
 * still name the value it replaced.
 *
 * What is never here is the value the caller SENT. An acked write the unit silently
 * discarded is indistinguishable from one it took, and answering that address from the
 * send would put a value on the unit's behalf that the unit does not hold — with plan
 * and snapshot then agreeing, no diff left to retry, and the unit never speaking about
 * it again. An address the unit has said nothing about is simply absent, and comes off
 * the device like any other: that is the blind read this path has always taken, for that
 * address alone, and the one answer that cannot enshrine a divergence. It is also why a
 * quantised or clamped write needs no case of its own — its notify carries the unit's
 * value, and that value is the answer.
 *
 * It lands one step ahead of the merge, which is what makes it complete: the value
 * goes into the read's private clone before diffPlans measures it, so the patch
 * carries no entry for the address, nothing is absorbed into the history baseline,
 * and `deviceView` — the same clone — agrees with the plan when live.ts re-bases its
 * snapshot from it. readIntoPlan, dropAuthored and the write witness need no part in
 * it.
 *
 * Keyed by translate.addrKey, the key live.ts's snapshot and follow index already
 * use: a second spelling of a device address is how a collapsed command misses its
 * entry.
 */
function writeOverlay(source: ParamSource, announced?: ReadonlyMap<number, number>): ParamSource {
  if (!announced?.size) return source;
  return {
    get: (paramId, x, y) => {
      const said = announced.get(addrKey(paramId, x, y));
      return said === undefined ? source.get(paramId, x, y) : Promise.resolve(said);
    },
    // Numeric only: the flush's name writes go out through a separate string path
    // and are not in `written`.
    getStr: (paramId, x, y) => source.getStr(paramId, x, y),
  };
}

export interface ReadbackResult {
  /**
   * Count of node/parameter groups successfully read and applied to the plan
   * across every section (channels, sends, bus faders, insert FX, EQ, duckers,
   * STEREO master, monitor, OSC, routing selectors) — not just channels.
   */
  applied: number;
  /** Per-group read failures (e.g. timeout, unknown source port), if any. */
  errors: string[];
  /**
   * Ids of nodes a body-parameter group attempted to read but failed on, so the
   * UI can flag a node still showing its plan default as not read from the
   * device. Only body groups (a node's own settings) take part: nodes that hold
   * no body parameters (inputs, record-track slots) are never attempted and so
   * never appear here. Transient: not serialized into the plan.
   */
  unreadNodes: Set<string>;
  /**
   * The sample rate this read established at its source, when it read one at all: a
   * scoped read never asks (the address has no owner node), and a full read whose
   * `766` failed leaves it unset. Separate from the plan's own `sampleRate` because
   * the two are not the same number — under the "Scene only" device scope the read's
   * rate is discarded from the plan again (`main.ts` applyDeviceStateScoped), and a
   * merge deciding anything from the plan's copy would be reading its own input.
   *
   * "Its source" rather than "the unit" because `applySourceState` is a full pass too and
   * its source is a `.urxf` file. That path reaches no merge and passes no hold, so no
   * consumer reads a file's rate as the unit's — but the field is the wrong one to answer
   * a question about the hardware from without checking which read filled it.
   */
  deviceSampleRate?: number;
}

/** A node's fixed main path into STEREO — the send connection carrying its
 *  CH_FADER / CH_PAN (or FX channel fader / balance). The canonical lookup shared
 *  by the channel and FX readback groups and the direct-apply fader/pan placement. */
function mainSendConn(plan: Plan, nodeId: string): PlanConnection | undefined {
  return plan.connections.find((c) => c.from === ref(nodeId, "out") && c.to === ref("bus.stereo", "in"));
}

/**
 * Pull the connected device's channel levels and pans into the plan, mutating it
 * in place. The caller must have connected first (platform.vdConnect) and should
 * re-render afterwards. Read failures are collected, not thrown, so one bad
 * channel does not abort the rest.
 *
 * Provenance tracks body-parameter groups (a node's own settings): each marks a
 * node `attempted` before reading and, if any of its body groups throws, the node
 * lands in `unread`. A send or an OSC assign does not — those carry routing rather
 * than a node's own state, and a successful send must not mask a channel whose body
 * read failed.
 *
 * The EXCLUSIVE selectors are the deliberate exception, and every one of them takes
 * it: source, routing, record slot and ducker key. Each of those leaves the plan's
 * OWN wire in place when the read fails or names a port this build cannot decode —
 * clearing it would be worse — so the node is still showing a plan value rather than
 * the device's, which is exactly what the flag means. Without it the badge and the
 * report's "nodes left at plan default" section said the node had been read in full,
 * and a converge would be built on that.
 *
 * The returned unreadNodes set is `attempted ∩ failed`, so the UI flags exactly
 * the nodes still showing a plan default rather than the live value.
 */
export async function applyDeviceState(
  model: DeviceModel,
  plan: Plan,
  signal?: AbortSignal,
  only?: ReadonlySet<string>,
  /** Writes the caller made immediately before this read (see settle.PendingWrites).
   *  The pass holds until the unit has spoken for the addresses it is about to ask
   *  about, and answers each of those from WHAT THE UNIT ANNOUNCED — reading the rest as
   *  usual. Live sync's sideEffect refetch is the one caller; every other path (the
   *  Fetch button, the self-test, prepare, compare) reads nothing it just wrote and
   *  passes nothing.
   *
   *  Waited HERE rather than before the call, because readIntoPlan clones the plan at
   *  the call: a wait taken outside is a window in which an operator edit lands in
   *  neither the clone the read diffs from nor the witness that protects an edit made
   *  during the read, and the merge would revert it. Inside, both cover it — at the
   *  cost of holding the undo refusal (main.ts's followReads) open for the wait as well
   *  as the read. Kept that way deliberately: the refusal exists because a device read
   *  holds the plan, the clone and the witness are already open here, and committing an
   *  entry against them would freeze this read's own writes into it. It is a deferral,
   *  not a discard, and it is bounded by the settle's own window. */
  pending?: PendingWrites,
  /** Read every group EXCEPT the node names. The live-sync refetch sets it, for the
   *  reason the name section in readPass gives; nothing else does.
   *
   *  Explicit rather than inferred from `pending`, which is what it was until a follow
   *  reconcile started carrying pending writes of its own. `recentPending()` returns an
   *  object whether or not the session has written anything, so "pending was supplied"
   *  became true for both reconciles and the names stopped being read AT ALL — a rename
   *  made on the unit never reached the plan again, with no error and no diff, since the
   *  skip also removes the read that would have disagreed. Caught by the race harness's
   *  group count (T5 concentration: 8 groups per mono channel where the pin says 9),
   *  which is the only thing that counts them. */
  skipNames = false,
): Promise<ReadbackResult> {
  // Only `mustSettle` — the addresses inside this read's scope — may hold it open, and
  // it holds for all of them: a changed write ends its own wait at its notify, one that
  // may be a no-op can only end at the bound, and neither may be read before then. A
  // write to some node this read does not touch names no boundary it needs and would
  // cost the drag that produced it a window; the settle judges it anyway, and reports a
  // changed one the unit never announced so the follow side can repair it. See
  // settle.ts.
  const announced = pending
    ? await writeSettle.settle(pending.written, {
        mustSettle: pending.mustSettle,
        mustAnnounce: pending.mustAnnounce,
        boundaryMarks: pending.boundaryMarks,
        signal,
      })
    : undefined;
  return readPass(writeOverlay(LIVE_SOURCE, announced), model, plan, signal, only, skipNames);
}

/**
 * Apply a parsed settings file (.urxf) to the plan, through the same inverse the
 * device read uses. The file cannot supply the model (its header names no variant)
 * or the editing layer (positions / hidden / notes have no parameter), so the
 * caller picks the model and the values land on the plan already open.
 */
export async function applySourceState(model: DeviceModel, plan: Plan, from: ParamSource): Promise<ReadbackResult> {
  return readPass(from, model, plan);
}

async function readPass(
  source: ParamSource,
  model: DeviceModel,
  plan: Plan,
  signal?: AbortSignal,
  only?: ReadonlySet<string>,
  /** Skip the name pass. Only Live sync's `sideEffect` refetch sets it — see the
   *  name section below for why that read must not happen at all rather than
   *  being made to wait. */
  skipNames = false,
): Promise<ReadbackResult> {
  const { vdGet, vdGetStr } = readers(source);
  ensureFixedConnections(model, plan);
  // Scoped readback: when `only` is given, every per-node group whose owner id is
  // not in the set is skipped, so a settled device-side change re-reads just the
  // touched node(s) rather than the whole device. want() gates each group by the
  // same owner id that planToCommands stamps onto VdCommand.node (see follow.ts).
  // Global, non-node groups (sample rate, SD Rec track count) run on a full read
  // only. The decode logic is shared with the full read verbatim — no second
  // inverse — so a scoped read can never drift from applyDeviceState.
  const want = (id: string): boolean => only === undefined || only.has(id);
  const errors: string[] = [];
  // Body-parameter provenance: nodes whose own settings a group tried to read,
  // and the subset whose read failed. unreadNodes = attempted ∩ failed.
  const attempted = new Set<string>();
  const failed = new Set<string>();
  let applied = 0;
  let deviceSampleRate: number | undefined;

  for (const node of model.nodes) {
    signal?.throwIfAborted();
    if (node.kind !== "channel") continue;
    if (!want(node.id)) continue;
    // Mono → 139/140/141 at input index; stereo → 266/267/268 at stereo index.
    const cc = channelControl(model, node.id);
    if (!cc) continue;
    const conn = mainSendConn(plan, node.id);
    if (!conn) continue;
    attempted.add(node.id);
    try {
      const level = vdToLevel(await vdGet(cc.fader, 0, cc.y));
      const pan = vdToPan(await vdGet(cc.pan, 0, cc.y));
      const on = vdToBool(await vdGet(cc.on, 0, cc.y));
      const update: NodeParams = { on };
      // Gain: A.Gain (mono) / D.Gain (stereo, linked L/R — read the first instance).
      if (cc.gain) update.gain = vdToGain(await vdGet(cc.gain.param, 0, cc.gain.instances[0]));
      if (cc.hasHpf) {
        update.hpf = vdToBool(await vdGet(PARAMS.HPF_ON.id, 0, cc.y));
        update.hpfFreq = vdToFreq(await vdGet(PARAMS.HPF_FREQ.id, 0, cc.y));
      }
      if (cc.hasMicStrip) {
        update.phantom = vdToBool(await vdGet(PARAMS.PHANTOM.id, 0, cc.y));
        update.clipSafe = vdToBool(await vdGet(PARAMS.CLIP_SAFE.id, 0, cc.y));
      }
      if (cc.hasHiZ) update.hiZ = vdToBool(await vdGet(PARAMS.HI_Z.id, 0, cc.y));
      if (cc.hasMicStrip) update.compEqType = await vdGet(PARAMS.COMP_EQ_TYPE.id, 0, cc.y);
      // Rec Point: per-channel record / direct-out tap (cc.recPoint = mono 137 / stereo 264).
      update.recPoint = await vdGet(cc.recPoint, 0, cc.y);
      // Signal Type (stereo link, 23) + PAN/BAL (891): pair-level CH SETTING held on
      // the pair's primary (odd) channel. Read at the primary's input index only.
      if (model.channelPairs.some(([a]) => a === node.id)) {
        update.stereoLink = vdToBool(await vdGet(PARAMS.SIGNAL_TYPE.id, 0, cc.y));
        update.panBal = await vdGet(PARAMS.PAN_BAL.id, 0, cc.y);
      }
      // Polarity invert: one (mono) or two independent L/R (stereo).
      for (const ph of cc.phases) update[ph.key] = vdToBool(await vdGet(ph.param, 0, ph.y));
      // Channel-strip section ON (GATE/COMP/EQ). The active COMP/EQ bank follows
      // the type just read; each toggle decodes against its own onValue polarity.
      for (const sec of channelSections(model, node.id, update.compEqType ?? 0)) {
        update[sec.key] = (await vdGet(sec.param, 0, sec.y)) === sec.onValue;
      }
      // Input 4-band PEQ band values (mono COMP->EQ mode / stereo channels).
      const ieq = inputEq(model, node.id, update.compEqType ?? 0);
      if (ieq) update.eqBands = await readEqBands(source, ieq);
      // Input EQ 1-knob (ON / TYPE / LEVEL).
      const iok = eqOneKnob(model, node.id, update.compEqType ?? 0);
      if (iok) update.eqOneKnob = await readEqOneKnob(source, iok);
      // Input GATE / COMP detail values (MONO IN channels; COMP only in COMP->EQ).
      const dyn = channelDynamics(model, node.id, update.compEqType ?? 0);
      if (dyn) {
        update.gate = await readDyn(source, dyn.gate, dyn.y);
        if (dyn.comp) {
          update.comp = {
            ...(await readDyn(source, dyn.comp, dyn.y)),
            knee: await vdGet(PARAMS.COMP_KNEE.id, 0, dyn.y),
            autoMakeup: vdToBool(await vdGet(PARAMS.COMP_AUTO_MAKEUP.id, 0, dyn.y)),
            oneKnob: vdToBool(await vdGet(PARAMS.COMP_ONE_KNOB.id, 0, dyn.y)),
            oneKnobLevel: await vdGet(PARAMS.COMP_ONE_KNOB_LEVEL.id, 0, dyn.y),
          };
        } else if ((update.compEqType ?? 0) === COMP_EQ_SSMCS) {
          // SSMCS mode: read the morphing strip's raw values (mirrors emission).
          // Comp/EQ section ON were read above via channelSections (compOn/eqOn).
          // Sweet Spot Data is a string param (91), read via the string IPC.
          const sweetSpotData = strToSweetSpotData((await vdGetStr(PARAMS.SWEET_SPOT_DATA.id, 0, dyn.y)).trim());
          update.ssmcs = { ...(await readSsmcs(source, dyn.y)), sweetSpotData };
        }
      }
      // → STEREO bus assign ON (post-fader, V1.3) onto the main path connection's on.
      const stereoOn = vdToBool(await vdGet(cc.stereoOn, 0, cc.y));
      conn.params = { ...conn.params, level, pan, on: stereoOn };
      plan.nodeParams[node.id] = { ...plan.nodeParams[node.id], ...update };
      applied++;
    } catch (e) {
      failed.add(node.id);
      errors.push(`${node.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // CH / FX-channel → MIX/FX sends. Every send is fixed (always wired), so its wire
  // is kept and the device's ON/OFF is stored in params.on alongside level / pan /
  // tap; readback never adds or removes a send wire. ensureFixedConnections (above)
  // has already materialized any missing fixed wire, so an entry exists here.
  for (const node of model.nodes) {
    signal?.throwIfAborted();
    if (node.kind !== "channel" && fxChannelIndex(node.id) === null) continue;
    if (!want(node.id)) continue;
    for (const bus of model.nodes) {
      if (bus.kind !== "bus") continue;
      const sc = sendControl(model, node.id, bus.id);
      if (!sc) continue;
      const from = ref(node.id, "out");
      const to = ref(bus.id, "in");
      try {
        const on = vdToBool(await vdGet(sc.on[0], 0, sc.y));
        const idx = plan.connections.findIndex((c) => c.from === from && c.to === to);
        const params: ConnParams = { level: vdToLevel(await vdGet(sc.level[0], 0, sc.y)), on };
        if (sc.pan.length) params.pan = vdToPan(await vdGet(sc.pan[0], 0, sc.y));
        params.tap = vdToBool(await vdGet(sc.tap, 0, sc.y)) ? "pre" : "post";
        if (idx >= 0) plan.connections[idx].params = { ...plan.connections[idx].params, ...params };
        else plan.connections.push({ from, to, kind: "send", params });
        applied++;
      } catch (e) {
        errors.push(`${node.label} → ${bus.label}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // MIX 1/2 → STEREO "TO ST" switch (677, MIX L instance) onto the fixed MIX →
  // STEREO connection's params.on (mirror of the TO_ST emit in translate.ts).
  for (const node of model.nodes) {
    signal?.throwIfAborted();
    const mix = MIX_FADER_INSTANCES[node.id];
    if (!mix) continue;
    if (!want(node.id)) continue;
    const conn = mainSendConn(plan, node.id);
    if (!conn) continue;
    try {
      conn.params = { ...conn.params, on: vdToBool(await vdGet(PARAMS.TO_ST.id, 0, mix[0])) };
      applied++;
    } catch (e) {
      errors.push(`${node.label} → STEREO (TO ST): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // FX channel → STEREO main path: the FX channel master fader (337) / balance
  // (339) carry the fixed FX-channel → STEREO send's level / pan (mirrors the
  // channel main path above; the FX channel ON toggle is read via busMasterOn).
  for (const node of model.nodes) {
    signal?.throwIfAborted();
    const fxY = fxChannelIndex(node.id);
    if (fxY === null) continue;
    if (!want(node.id)) continue;
    // FX-channel effect (EFFECT TYPE + parameter array): a node-level attribute,
    // read whether or not the FX → STEREO main path is wired.
    attempted.add(node.id);
    try {
      const fxEffect = await readFxEffect(source, fxY);
      plan.nodeParams[node.id] = { ...plan.nodeParams[node.id], fxEffect };
      applied++;
    } catch (e) {
      failed.add(node.id);
      errors.push(`${node.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const conn = mainSendConn(plan, node.id);
    if (!conn) continue;
    try {
      const level = vdToLevel(await vdGet(PARAMS.FX_CHANNEL_FADER.id, 0, fxY));
      const pan = vdToPan(await vdGet(PARAMS.FX_CHANNEL_BAL.id, 0, fxY));
      const on = vdToBool(await vdGet(FX_STEREO_ASSIGN_ON, 0, fxY));
      conn.params = { ...conn.params, level, pan, on };
      applied++;
    } catch (e) {
      // Mirror the channel main path: a failed main-path read flags the FX node as
      // unread, so a partial fetch never shows it at plan defaults with no badge.
      failed.add(node.id);
      errors.push(`${node.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Bus output faders: STEREO master (581) and MIX (674); read the first instance.
  for (const node of model.nodes) {
    signal?.throwIfAborted();
    if (node.kind !== "bus") continue;
    if (!want(node.id)) continue;
    const bf = busFader(node.id);
    if (!bf) continue;
    attempted.add(node.id);
    try {
      const next: NodeParams = {
        ...plan.nodeParams[node.id],
        level: vdToLevel(await vdGet(bf.param, 0, bf.instances[0])),
      };
      // Master balance (STEREO 583 / MIX 676): same instance layout as the fader.
      const bb = busBalance(node.id);
      if (bb) next.pan = vdToPan(await vdGet(bb.param, 0, bb.instances[0]));
      plan.nodeParams[node.id] = next;
      applied++;
    } catch (e) {
      failed.add(node.id);
      errors.push(`${node.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // CH SETTING color (palette index → swatch hex): input channels (20) and the
  // MIX/STEREO buses (586 / 496). Off / an unknown index clears the override.
  // Kept out of the body-read provenance (attempted/failed) — a color is an
  // annotation, not a node's settings, so a color read failure must not flag the
  // node's body as unread.
  for (const node of model.nodes) {
    signal?.throwIfAborted();
    if (!want(node.id)) continue;
    const cc = colorControl(model, node.id);
    if (!cc) continue;
    try {
      const hex = colorIndexToHex(await vdGet(cc.param, 0, cc.instances[0]));
      if (hex) plan.nodeColors[node.id] = hex;
      else delete plan.nodeColors[node.id];
      applied++;
    } catch (e) {
      errors.push(`${node.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // CH SETTING name (string param via the string IPC): same node set as color.
  // A non-empty device name becomes the node-name override; an empty one clears
  // it so the canvas falls back to the model's default label. Like color, kept
  // out of the body-read provenance.
  //
  // Live sync's `sideEffect` refetch skips this entirely, and the reason is not
  // cost. **The name path has the same post-write staleness window as every
  // numeric one** — measured on a URX44V (System V1.3.1.0): a name written and
  // then polled every 4 ms answered the PREVIOUS name for 81 ms. But the numeric
  // repair does not reach here. `writeOverlay` answers an address out of what
  // the unit ANNOUNCED for it, and no name announcement can get into it: a name
  // is written on the string path (`vdSetStr`), and that loop in `live.ts`
  // records nothing in the flush's write ledger, so a name address is never in
  // the `PendingWrites` the overlay is built from. The unit's notify itself does
  // arrive — name addresses are registered, which is what carries a rename made
  // on the unit — but it arrives at the follow layer, not here. A settle would
  // therefore always spend its whole bound, and answering from the send is what
  // D1 forbids.
  //
  // Not reading is the right answer rather than the cheap one. The refetch exists
  // to collect what the unit RECOMPUTED because of a write, and no parameter
  // write makes the unit recompute a name. What the read could only do here is
  // harm: a rename flushed in the same window comes back as the name it
  // replaced, and `live.ts` puts that into the plan AND `nameSnapshot` together
  // — they agree, no diff remains, and the operator's rename is reverted with
  // nothing left to retry. Unlike a numeric revert it does not even oscillate,
  // so nothing draws attention to it.
  //
  // A rename made on the unit still arrives, because every other caller reads names:
  // device follow's two reconciles, Fetch, compare and the self-test. That used to be
  // stated as "they pass no `pending`", the flag being inferred from it — and then the
  // scoped reconcile started carrying the session's recent writes, both reconciles
  // began skipping names, and a rename made on the unit stopped arriving anywhere. The
  // flag is now the caller's own word, so a second caller acquiring pending writes
  // cannot silently take this branch with it.
  if (!skipNames) {
    for (const node of model.nodes) {
      signal?.throwIfAborted();
      if (!want(node.id)) continue;
      const nc = nameControl(model, node.id);
      if (!nc) continue;
      try {
        // Normalized on the way IN as well as on the way out. The unit's name screen
        // takes 8 characters but the wire does not enforce that (a 20-character name
        // is storable and reads back whole), and an unbounded one in the plan draws a
        // node label across its neighbours; normalizing here also lets the next
        // converge settle it on the device instead of diffing against a name emit
        // would cut. Trailing padding goes with it — trimEnd and not trim, because the
        // device right-aligns numbers in the stereo pair labels, so the factory name
        // really is " 5/ 6" and a leading-space strip would write the shortened form
        // back on the next sync. An all-blank name reads as empty and clears the key.
        const name = normalizeNodeName(await vdGetStr(nc.param, 0, nc.instances[0]));
        if (name) plan.nodeNames[node.id] = name;
        else delete plan.nodeNames[node.id];
        applied++;
      } catch (e) {
        errors.push(`${node.label}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // Insert FX (enum): mono input channels (135) and output buses (578 / 671),
  // plus the ON/OFF (bypass) switch (134 / 577 / 670) so a captured "selected
  // but bypassed" effect round-trips.
  for (const node of model.nodes) {
    signal?.throwIfAborted();
    if (!want(node.id)) continue;
    const ifx = insertFxControl(model, node.id);
    if (!ifx) continue;
    attempted.add(node.id);
    try {
      const insertFx = normalizeInsertFx(await vdGet(ifx.param, 0, ifx.instances[0]));
      const insertFxOn = vdToBool(await vdGet(ifx.onParam, 0, ifx.instances[0]));
      const fam = insertFxFamilyOf(insertFx);
      const read: Record<number, number> = {};
      if (fam) {
        const engine = insertFxEngine(fam, ifx.isOutput);
        // Every slot the app can write is one it has to be able to read, the slots the unit
        // is currently DRIVING included: the emit path skips those, and a refetch after a
        // write that set the unit computing is the only thing that brings its result back.
        for (const s of insertFxReadableSlots(fam)) {
          read[s.slot] = await vdGet(engine, 0, s.slot);
        }
      }
      const was = plan.nodeParams[node.id];
      // MERGED, not replaced: the map carries one namespace per family so a node that has
      // held several effects keeps each one's values, and a read answers for one of them.
      const insertFxParams = mergeReadInsertFxParams(
        was?.insertFxParams,
        was?.insertFx === undefined ? null : insertFxFamilyOf(was.insertFx),
        fam,
        read,
      );
      plan.nodeParams[node.id] = { ...was, insertFx, insertFxOn, insertFxParams };
      applied++;
    } catch (e) {
      failed.add(node.id);
      errors.push(`${node.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Output bus EQ ON: STEREO (498) and MIX (591); read the first instance.
  for (const node of model.nodes) {
    signal?.throwIfAborted();
    if (node.kind !== "bus") continue;
    if (!want(node.id)) continue;
    const eq = busEqOn(node.id);
    if (!eq) continue;
    attempted.add(node.id);
    try {
      plan.nodeParams[node.id] = {
        ...plan.nodeParams[node.id],
        eqOn: vdToBool(await vdGet(eq.param, 0, eq.instances[0])),
      };
      applied++;
    } catch (e) {
      failed.add(node.id);
      errors.push(`${node.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Output bus 4-band PEQ band values: STEREO (single) and MIX (L/R-linked).
  for (const node of model.nodes) {
    signal?.throwIfAborted();
    if (node.kind !== "bus") continue;
    if (!want(node.id)) continue;
    const oeq = outputEq(node.id);
    if (!oeq) continue;
    attempted.add(node.id);
    try {
      const np = { ...plan.nodeParams[node.id], eqBands: await readEqBands(source, oeq) };
      const ok = eqOneKnob(model, node.id, 0);
      if (ok) np.eqOneKnob = await readEqOneKnob(source, ok);
      plan.nodeParams[node.id] = np;
      applied++;
    } catch (e) {
      failed.add(node.id);
      errors.push(`${node.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Ducker on/off: one per stereo channel, read onto the ducker node.
  for (const node of model.nodes) {
    signal?.throwIfAborted();
    if (node.kind !== "ducker") continue;
    if (!want(node.id)) continue;
    const dc = duckerControl(model, node.id);
    if (!dc) continue;
    attempted.add(node.id);
    try {
      const duckerOn = vdToBool(await vdGet(PARAMS.DUCKER_ON.id, 0, dc.y));
      const ducker = await readDyn(source, DUCKER_FIELDS, dc.y);
      plan.nodeParams[node.id] = { ...plan.nodeParams[node.id], duckerOn, ducker };
      applied++;
      // Ducker key source (259): decode the port to its channel/bus node. An
      // unknown port is left untouched (logged) so a value we cannot map does not
      // wrongly clear the existing wire; only the none sentinel clears it.
      const port = vdToPortRef(await vdGet(PARAMS.DUCKER_SRC.id, 0, dc.y));
      const src = port === null ? null : nodeForPort(model, port);
      if (src) setExclusiveConnection(plan, ref(src, "out"), ref(node.id, "in"), "key");
      else if (port === null) clearIncoming(plan, ref(node.id, "in"), "key");
      else {
        // Same rule as the input-source loop: an unmappable port leaves the plan's own
        // wire in place, so the node has NOT been fully read and the provenance has to
        // carry that.
        failed.add(node.id);
        errors.push(`${node.label} key: unknown source port ${port}`);
      }
    } catch (e) {
      failed.add(node.id);
      errors.push(`${node.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Bus master ON/OFF: STEREO master (582), MIX buses (675, L/R-linked — the L
  // instance is read) and the FX channels (338, per FX).
  for (const node of model.nodes) {
    signal?.throwIfAborted();
    if (node.kind !== "bus") continue;
    if (!want(node.id)) continue;
    const bm = busMasterOn(node.id);
    if (!bm) continue;
    attempted.add(node.id);
    try {
      const on = vdToBool(await vdGet(bm.param, 0, bm.instances[0]));
      // BUS Type (VARI/FIXED) is a MIX-only attribute (587, L instance read).
      // MIX buses are identified by the same map the emit side uses, so the two
      // directions cannot drift (mirror of the BUS_TYPE loop in translate.ts).
      const mix = MIX_FADER_INSTANCES[node.id];
      const busType = mix ? await vdGet(PARAMS.BUS_TYPE.id, 0, mix[0]) : undefined;
      // Pan Link (589, MIX only, L instance) — sends' pan follows the source PAN.
      const panLink = mix ? vdToBool(await vdGet(PARAMS.PAN_LINK.id, 0, mix[0])) : undefined;
      plan.nodeParams[node.id] = {
        ...plan.nodeParams[node.id],
        on,
        ...(busType !== undefined ? { busType } : {}),
        ...(panLink !== undefined ? { panLink } : {}),
      };
      applied++;
    } catch (e) {
      failed.add(node.id);
      errors.push(`${node.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Monitor bus levels: bus.mon1 → y0, bus.mon2 → y1.
  for (const [id, y] of [
    ["bus.mon1", 0],
    ["bus.mon2", 1],
  ] as const) {
    if (!want(id)) continue;
    attempted.add(id);
    try {
      const on = vdToBool(await vdGet(PARAMS.MONITOR_ON.id, 0, y));
      const level = vdToLevel(await vdGet(PARAMS.MONITOR_LEVEL.id, 0, y));
      const cueInterrupt = vdToBool(await vdGet(PARAMS.MONITOR_CUE_INTERRUPT.id, 0, y));
      const mono = vdToBool(await vdGet(PARAMS.MONITOR_MONO.id, 0, y));
      const phonesLevel = vdToPhonesLevel(await vdGet(PARAMS.PHONES_LEVEL.id, 0, y));
      plan.nodeParams[id] = { ...plan.nodeParams[id], on, level, cueInterrupt, mono, phonesLevel };
      applied++;
    } catch (e) {
      failed.add(id);
      errors.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Oscillator generator (bus.osc): on / level / mode / frequency / burst width /
  // burst interval.
  if (want("bus.osc")) {
    attempted.add("bus.osc");
    try {
      const osc = {
        on: vdToBool(await vdGet(PARAMS.OSC_ON.id, 0, 0)),
        level: vdToCentiDb(await vdGet(PARAMS.OSC_LEVEL.id, 0, 0)),
        mode: await vdGet(PARAMS.OSC_MODE.id, 0, 0),
        freq: vdToEqFreq(await vdGet(PARAMS.OSC_FREQ.id, 0, 0)),
        width: vdToBurstWidth(await vdGet(PARAMS.OSC_BURST_WIDTH.id, 0, 0)),
        interval: await vdGet(PARAMS.OSC_BURST_INTERVAL.id, 0, 0),
      };
      plan.nodeParams["bus.osc"] = { ...plan.nodeParams["bus.osc"], osc };
      applied++;
    } catch (e) {
      failed.add("bus.osc");
      errors.push(`OSC: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // STREAMING DELAY (bus.stream): on / time / frame rate.
  if (want("bus.stream")) {
    attempted.add("bus.stream");
    try {
      const delay = {
        on: vdToBool(await vdGet(PARAMS.STREAM_DELAY_ON.id, 0, 0)),
        time: vdToDelayTime(await vdGet(PARAMS.STREAM_DELAY_TIME.id, 0, 0)),
        frameRate: await vdGet(PARAMS.STREAM_DELAY_FRAME_RATE.id, 0, 0),
      };
      plan.nodeParams["bus.stream"] = { ...plan.nodeParams["bus.stream"], delay };
      applied++;
    } catch (e) {
      failed.add("bus.stream");
      errors.push(`STREAMING DELAY: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Sample rate (global, raw Hz) onto the plan-level scalar. Not a node setting,
  // so it stays out of the body-read provenance (attempted/failed). 766 is the
  // control; 843 mirrors it. A read failure leaves the plan's rate untouched.
  // Global (no owner node), so it runs on a full read only — a scoped read never
  // touches it (a sample-rate change escalates to a full read in follow.ts).
  if (only === undefined) {
    try {
      plan.sampleRate = await vdGet(PARAMS.SAMPLE_RATE.id, 0, 0);
      deviceSampleRate = plan.sampleRate;
      applied++;
    } catch (e) {
      errors.push(`sample rate: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // OSC → bus assign: read each bus's L/R channel toggles and reflect the wire
  // (present with oscL/oscR when on, removed when both off).
  for (const busId of OSC_ASSIGN_BUSES) {
    if (!want(busId)) continue;
    const a = oscAssign(busId);
    if (!a) continue;
    try {
      const l = vdToBool(await vdGet(PARAMS[a.name].id, 0, a.l));
      const r = a.r !== null ? vdToBool(await vdGet(PARAMS[a.name].id, 0, a.r)) : l;
      const from = ref("bus.osc", "out");
      const to = ref(busId, "in");
      removeConnection(plan, from, to);
      if (l || r) plan.connections.push({ from, to, kind: "sendSwitch", params: { oscL: l, oscR: r } });
      applied++;
    } catch (e) {
      errors.push(`OSC→${busId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Input source select: decode the channel's source port to its input node and
  // reflect inputNode → channel as a source wire (NONE clears it). MONO CH1-4 read
  // param 22 at the physical slot; stereo channels read param 209 (L) at the stereo
  // pair index — param 22 only covers the mono slots (confirmed on URX44V).
  const srcStereoIdx = stereoIndexMap(model);
  for (const node of model.nodes) {
    signal?.throwIfAborted();
    if (node.kind !== "channel") continue;
    if (!want(node.id)) continue;
    let srcParam: number, srcY: number;
    if (isStereoChannel(node.id)) {
      const si = srcStereoIdx.get(node.id);
      if (si === undefined) continue;
      srcParam = PARAMS.STEREO_INPUT_SOURCE_L.id;
      srcY = si;
    } else {
      const slots = channelInputSlots(model, node.id);
      if (!slots) continue;
      srcParam = PARAMS.INPUT_SOURCE.id;
      srcY = slots[0];
    }
    try {
      const port = vdToPortRef(await vdGet(srcParam, 0, srcY));
      const src = port === null ? null : inputNodeForPort(port);
      if (src) {
        setExclusiveConnection(plan, ref(src, "out"), ref(node.id, "in"), "source");
        applied++;
      } else if (port === null) {
        clearIncoming(plan, ref(node.id, "in"), "source");
        applied++;
      } else {
        // Unknown port: leave the existing wire untouched rather than clearing it —
        // and say so in the provenance, not only in `errors`. The wire the operator
        // ends up looking at is the plan's own, unconfirmed, and the report's "nodes
        // left at plan default" section is where that is stated. The routing-selector
        // and record-slot loops below already flag theirs, with a comment saying the
        // flag exists so a converge is not built on it; this loop kept the older
        // errors-only shape and claimed the channel had been read in full.
        failed.add(node.id);
        errors.push(`${node.label}: unknown source port ${port}`);
      }
    } catch (e) {
      failed.add(node.id);
      errors.push(`${node.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Streaming / USB-out / monitor / analog-patch selects (same ROUTING_SELECTORS
  // table that drives emit): decode the L param's port to its source node and
  // reflect the exclusive wire (NONE clears it). Skips selectors whose destination
  // node is absent on this model (e.g. out.line without a line output).
  for (const [to, kind, pl, , yl] of ROUTING_SELECTORS) {
    if (!model.nodes.some((n) => n.id === to)) continue;
    if (!want(to)) continue;
    attempted.add(to);
    try {
      const port = vdToPortRef(await vdGet(PARAMS[pl].id, 0, yl));
      const src = port === null ? null : nodeForPort(model, port);
      if (src) {
        setExclusiveConnection(plan, ref(src, "out"), ref(to, "in"), kind);
        applied++;
      } else if (port === null) {
        clearIncoming(plan, ref(to, "in"), kind);
        applied++;
      } else {
        // The device named a source this build cannot decode, so its real routing
        // stays unknown. The plan's own wire is kept rather than cleared, which
        // makes it a value we did not read — flagged like any other failed read so
        // the node carries its unread badge and a converge is not built on it.
        errors.push(`${to}: unknown source port ${port}`);
        failed.add(to);
      }
    } catch (e) {
      errors.push(`${to}: ${e instanceof Error ? e.message : String(e)}`);
      failed.add(to);
    }
  }

  // microSD Rec per-track source assign: decode each track-pair slot's L track
  // (param 736) to its source node (channel pair / STEREO / MIX) and reflect the
  // exclusive record wire (NONE clears it). Empty on models without a recorder.
  for (const slot of recordSlots(model)) {
    signal?.throwIfAborted();
    if (!want(slot.id)) continue;
    attempted.add(slot.id);
    try {
      const port = vdToPortRef(await vdGet(PARAMS.SD_REC_SOURCE.id, 0, slot.trackL));
      const src = port === null ? null : nodeForPort(model, port);
      if (src) {
        setExclusiveConnection(plan, ref(src, "out"), ref(slot.id, "in"), "record");
        applied++;
      } else if (port === null) {
        clearIncoming(plan, ref(slot.id, "in"), "record");
        applied++;
      } else {
        // Undecodable source, same as the routing loop above: the plan's wire is
        // kept but it is not what was read, so the slot counts as unread.
        errors.push(`${slot.id}: unknown record source port ${port}`);
        failed.add(slot.id);
      }
    } catch (e) {
      errors.push(`${slot.id}: ${e instanceof Error ? e.message : String(e)}`);
      failed.add(slot.id);
    }
  }
  // microSD Rec Track Count (839, never emitted): tracks = raw × 2, onto the SD Rec
  // header. Kept out of body provenance like sample rate, but NOT full-read-only like
  // it: 839 lands on a node the model has (`out.sdrec`), so a scoped read can repair
  // it, and `want` keeps the full-read behaviour identical. Sample rate stays on
  // `only === undefined` because `plan.sampleRate` is a plan-level scalar owned by no
  // node — a resemblance between the two, not a shared reason.
  //
  // This gate is what makes the address followable at all. Nothing writes 839, so it is
  // registered for notifies by hand (live.ts) and indexed to `out.sdrec`; were it read
  // here on a full read only, that index entry would send every front-panel Track Count
  // change into a scoped read that never touches the address — the follow would run, the
  // read would succeed, and the value would not change.
  if (want("out.sdrec") && model.nodes.some((n) => n.id === "out.sdrec")) {
    try {
      const sdRecTrackCount = (await vdGet(PARAMS.SD_REC_TRACK_COUNT.id, 0, 0)) * 2;
      plan.nodeParams["out.sdrec"] = { ...plan.nodeParams["out.sdrec"], sdRecTrackCount };
      applied++;
    } catch (e) {
      errors.push(`SD Rec track count: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // A node is unread when a body group tried it but at least one failed; nodes
  // never attempted (inputs, record-track slots) and fully-read nodes stay out.
  const unreadNodes = new Set<string>();
  for (const id of attempted) if (failed.has(id)) unreadNodes.add(id);
  return { applied, errors, unreadNodes, deviceSampleRate };
}

/**
 * Scoped device readback: re-read only the groups owned by `nodeIds` and apply
 * them to the plan. The decode path is shared verbatim with applyDeviceState (it
 * is the same function, gated by the owner-id set), so a scoped read can never
 * drift from a full one. Used by device-follow to reconcile just the node(s) a
 * settled device-side change touched, instead of re-reading the whole device.
 * `nodeIds` are the VdCommand.node owners resolved from the changed addresses.
 */
export async function applyNodeState(
  model: DeviceModel,
  plan: Plan,
  nodeIds: ReadonlySet<string>,
  signal?: AbortSignal,
  /** See applyDeviceState — writes the caller made immediately before this read. Both
   *  of this function's callers have them: the live-sync refetch's own, and device
   *  follow's scoped reconcile carrying whatever the session wrote recently. */
  pending?: PendingWrites,
  /** See applyDeviceState. The refetch passes it; the reconcile does not. */
  skipNames = false,
): Promise<ReadbackResult> {
  return applyDeviceState(model, plan, signal, nodeIds, pending, skipNames);
}

/** What a merged device read produced. */
export interface MergedRead extends ReadbackResult {
  /** The private copy the read ran against: the plan as it stood when the read was
   *  issued, carrying the read's own values and nothing the operator did meanwhile.
   *  This is what the device holds as far as this read established it, so it — not the
   *  plan on screen — is the baseline a live-sync snapshot must measure from. */
  deviceView: Plan;
  /** The keys this read authored: `diffPlans(before, deviceView)`, the patch that went
   *  onto the plan before the operator's own edits went over it. The history baseline
   *  absorbs exactly this (`ui/history.ts` `absorb`), which is what lets a gesture that
   *  straddled the read still commit as one entry. Detached from both plans — diffPlans
   *  clones into its slots and applyPatch clones on the way out. */
  devicePatch: PlanPatch;
  /** The keys a `hold` kept the plan's own value for, in `dropAuthored`'s label
   *  spelling. Separate from `unplaced` because the two mean opposite things: an
   *  unplaced key had nowhere to land, while a held one landed nowhere ON PURPOSE and
   *  still differs from `deviceView` — which is what the next outgoing diff writes back.
   *  Empty for every read that passes no hold. */
  held: string[];
  /** Everything the device patch did not write: an entry with nowhere to land (a wire
   *  removed while the read was in flight), and every key the operator moved meanwhile,
   *  which the merge deliberately leaves standing. Skipped rather than forced.
   *
   *  WHICH callers report it, and which do not, is a decision rather than an oversight.
   *  The Fetch flow does, through `formatReadbackReport`'s own section — that read is a
   *  deliberate whole-device pull and a key it declined to write is worth a line. The
   *  four live-sync callers do NOT: during a follow read this list is non-empty exactly
   *  when the operator was editing while it ran, which is the merge working, and
   *  surfacing it per reconcile would be a notification per gesture. They keep the
   *  `console.warn`, which is a development aid and reaches nobody in a packaged build
   *  (no `devtools` feature) — so for those paths this really is silent, on purpose. */
  unplaced: string[];
}

/**
 * The insert-FX keys a device-follow read must keep the plan's own value for.
 *
 * Crossing a selected effect's sample-rate ceiling makes the unit clear the selector,
 * the pointer and the bypass, and coming back to a supported rate restores none of them.
 * The unit announces none of that — the rate is the only address it reports — so the
 * first thing that sees the cleared values is the full read the rate notify escalated to.
 * Adopting them ends the effect: the plan would agree with the unit, and nothing would be
 * left to put back.
 *
 * The rate decides which clearing this is. A No Effect the unit's CURRENT rate can run is
 * the operator's own, made on the unit, and is adopted like any other device-side edit.
 * That rate is the one the read established (`ReadbackResult.deviceSampleRate`) and never
 * the plan's own: under the "Scene only" device scope the plan keeps its rate across a
 * read, so the plan's copy can name a rate the unit left long ago.
 *
 * A node whose read failed keeps its plan value in `deviceView` and so reads as still
 * selected, which takes it out of scope here: there is nothing to hold against.
 *
 * The rate is not the only thing that clears an insert effect. A Signal Type transition
 * clears the selector and the ON on BOTH members of a pair, in either direction, and
 * `applyPairTransition` follows that rather than resisting it — a selection left standing
 * would make the next converge re-select an effect the unit has just dropped. So a pair
 * whose Signal Type moved in this same read is out of scope here whatever the rate says:
 * that clearing has an owner already.
 */
export function insertFxHoldKeys(model: DeviceModel, ctx: HoldContext): Set<string> {
  const held = new Set<string>();
  // Every rate this read has evidence of: the one it established, and the ones the unit
  // announced. A read that has NEITHER decides nothing — the plan's own rate is not
  // evidence, and deciding from it would let a stale number overwrite an operator who
  // cleared the effect on the unit by hand.
  //
  // A scoped read has no rate of its own (the address has no owner node) and is not
  // therefore blind: it reads a node's insert FX like any other body value, so one
  // already running when the unit clears an effect is the FIRST to see the cleared
  // selector — before the full read the rate notify escalates to. Measured: without the
  // announced rate to decide from, that scoped read adopted the clearing, and the full
  // read behind it then had nothing left to hold.
  const rates = [...(ctx.deviceSampleRate === undefined ? [] : [ctx.deviceSampleRate]), ...(ctx.ratesSeen ?? [])];
  if (!rates.length) return held;
  for (const node of model.nodes) {
    const ifx = insertFxControl(model, node.id);
    if (!ifx) continue;
    const was = ctx.before.nodeParams[node.id];
    if (!insertFxSelected(was) || insertFxSelected(ctx.deviceView.nodeParams[node.id])) continue;
    // The unit said so itself, on this route's own addresses. Ahead of the read-value
    // comparison below, which is the same question asked of two values that may have
    // been read on either side of the change.
    if (ctx.announced?.has(node.id)) continue;
    const primary = pairPrimary(model, node.id);
    if (
      primary !== null &&
      ctx.before.nodeParams[primary]?.stereoLink !== ctx.deviceView.nodeParams[primary]?.stereoLink
    )
      continue;
    // The operator re-selected this route's effect while the read was in flight: the
    // selector is already the merge's to leave standing, and holding the other two keys
    // beside it would put the OLD effect's bypass and engine values under the new
    // selection. The keys move together or not at all.
    if (ctx.authored.has(nodeParamContestKey(node.id, "insertFx"))) continue;
    const option = ifx.options.find((o) => o.value === was?.insertFx);
    // A selector this model's control does not offer — a plan carried across models.
    // Adopted rather than held: translate will not emit it either, so holding it would
    // keep a value in the plan that has no way of ever reaching the unit.
    if (!option) continue;
    // Unavailable at the read's rate, or at any the unit announced on the way here.
    if (rates.every((rate) => insertFxAvailable(option, rate))) continue;
    for (const key of INSERT_FX_KEYS) held.add(nodeParamContestKey(node.id, key));
  }
  return held;
}

/** What a hold is decided from: the plan as the read found it, what the read wrote into
 *  its private copy, the rate the read established on the unit (absent when it read none),
 *  and the keys an edit funnel authored while it was in flight — which the merge has
 *  already taken out of the patch, and which a hold must therefore not put back. */
export interface HoldContext {
  before: Plan;
  deviceView: Plan;
  deviceSampleRate?: number;
  authored: ReadonlySet<string>;
  /** Nodes whose insert FX the UNIT announced a change to while the read was running.
   *  A read is not a snapshot — its addresses are answered hundreds of milliseconds
   *  apart — so a change landing inside it can be caught on one address and missed on
   *  another, and two values compared across that gap say nothing about what happened
   *  between them. The notify stream is what carries the order, and it separates the two
   *  clearings by hand: a Signal Type transition announces the insert-FX addresses it
   *  clears on both members, while the sample-rate excursion announces only the rate
   *  (both measured on a URX44V). A route named here is therefore one whose clearing has
   *  a cause of its own, and the hold — which exists for the announced-nothing case —
   *  leaves it alone. */
  announced?: ReadonlySet<string>;
  /** Every sample rate the UNIT announced since the previous read finished, in notify
   *  order. The read's own rate is one moment out of a sweep that takes hundreds of
   *  milliseconds, and the excursion that clears an effect can be over before the rate
   *  address is even asked: 48 → 96 → 48 leaves the read holding 48, at which the effect
   *  runs, and the clearing then reads exactly like an operator's own No Effect. The
   *  notify that escalated to this read carries the rate that did it, which is why this
   *  is NOT sliced to the read's own window the way `announced` is — it reaches back to
   *  the coalescing window that produced the read. */
  ratesSeen?: readonly number[];
}

/** What one insert-FX route stores: the selector, the bypass intent and the engine
 *  values the selector applies to. Held together — a selector kept without its values
 *  would be re-applied against whatever defaults the device refilled the engine with. */
const INSERT_FX_KEYS = ["insertFx", "insertFxOn", "insertFxParams"] as const;

/**
 * Run a device read against a private copy of the plan and merge the result back, so
 * an edit made while the read was in flight is not overwritten by it.
 *
 * readPass assigns whole nodes, and a read spans hundreds of milliseconds (a node) to
 * tens of seconds (the whole device). Pointed at the live plan, every value the
 * operator moves inside that window is replaced by what the device held before the
 * gesture — silently, since the value is on screen and the plan then asserts a state
 * the unit does not hold. The copy turns the read's writes into a diff instead of an
 * assignment, and the diff is applied IN CONTEXT: a key the plan still holds the
 * pre-read value of takes device truth, and a key the operator moved meanwhile is left
 * standing. That settles the contest in one pass — measuring the operator's edits as a
 * second diff and re-applying them over the device patch reaches the same result the
 * long way round, and only after writing values it is about to overwrite.
 *
 * The value contest has one blind spot, and `witness` is what covers it: an edit that
 * goes A -> B -> A inside the read's window leaves the plan holding the read's own
 * `before` value, so it is indistinguishable from a key nobody touched — and a read that
 * sampled the device at B (both writes went out, the read caught the middle one) would
 * write B back in silence. The witness names the keys an edit funnel authored while the
 * read was in flight, and those are skipped whatever they now hold.
 *
 * `current` is re-read after the await, and must resolve the caller's live plan rather
 * than a captured object — a read whose plan has been replaced (File > New, a model
 * switch) has nothing to merge into, since its node ids may not exist in the document
 * that replaced it and diffPlans across two models is empty by contract. It returns
 * null and writes nothing.
 *
 * A read that throws propagates with the live plan untouched: the copy is discarded,
 * so an aborted or link-lost read really is "nothing happened".
 *
 * `hold` names keys the plan keeps whatever the device said, for a device-side change
 * the app is about to undo rather than adopt. It is deliberately NOT a change to
 * `deviceView`: the live snapshot re-bases from that, so the device's own value has to
 * stay in it — the difference between it and the plan is what the next outgoing diff
 * writes back, and a `deviceView` edited to agree with the plan would leave the app
 * holding an intent it had no way left to send.
 */
export async function readIntoPlan(
  current: () => Plan,
  read: (into: Plan) => Promise<ReadbackResult>,
  witness?: PlanWriteWitness,
  hold?: (ctx: HoldContext) => ReadonlySet<string>,
): Promise<MergedRead | null> {
  const plan = current();
  const before = clonePlanState(plan);
  const target = clonePlanState(plan);
  const watch = witness?.watch();
  try {
    const result = await read(target);
    if (current() !== plan) return null;
    // Taken before anything is written, so the merge's own writes are not read back as
    // the app's authorship by a read still in flight beside this one.
    const authored = watch?.authored();
    // The patch is filtered rather than the apply, so what this read is allowed to
    // author is one list: the history baseline absorbs the same devicePatch, and a key
    // absorbed but not applied would put a value the app never wrote into the next
    // undo entry.
    const { patch: contested, dropped } = dropAuthored(diffPlans(before, target), authored ?? new Set());
    // Held keys go through the same filter and stay a SEPARATE list. Folding them into
    // `dropped` would put a deliberate repair into the list whose whole meaning is
    // "this had nowhere to land", which one caller prints and another warns on.
    const holdKeys =
      hold?.({
        before,
        deviceView: target,
        deviceSampleRate: result.deviceSampleRate,
        authored: authored ?? new Set(),
      }) ?? new Set<string>();
    const { patch: devicePatch, dropped: held } = dropAuthored(contested, holdKeys);
    const unplaced = [...applyPatchInContext(plan, devicePatch), ...dropped];
    return { ...result, deviceView: target, devicePatch, unplaced, held };
  } finally {
    watch?.close();
  }
}

/**
 * Apply a single device-side parameter change straight into the plan, with no
 * read-back. Only the node-local scalar params flagged follow: "direct" in the
 * catalog are handled here (fixed placement, no mode coupling, no dependent
 * reset); their incoming raw value is decoded and written to the owner node's
 * plan slot. Returns true when applied; false for any param not in the direct
 * set, so the caller falls back to a scoped readback. `node` is the address's
 * owner (VdCommand.node), `name` its catalog ParamName.
 */
export function applyDirect(plan: Plan, node: string, name: ParamName, raw: number): boolean {
  const setNp = (patch: Partial<NodeParams>): void => {
    plan.nodeParams[node] = { ...plan.nodeParams[node], ...patch };
  };
  // Level / pan / on land on the node's fixed main path into STEREO (a send
  // connection): CH/FX channels carry level + pan, a MIX bus carries the TO ST on.
  const setMain = (patch: { level?: number; pan?: number; on?: boolean }): void => {
    const conn = mainSendConn(plan, node);
    if (conn) conn.params = { ...conn.params, ...patch };
  };
  switch (name) {
    case "CH_FADER":
    case "FX_CHANNEL_FADER":
      setMain({ level: vdToLevel(raw) });
      return true;
    case "CH_PAN":
    case "FX_CHANNEL_BAL":
      setMain({ pan: vdToPan(raw) });
      return true;
    case "CH_ON":
    case "OUT_MASTER_ON":
    case "STEREO_MASTER_ON":
    case "FX_CHANNEL_ON":
    case "MONITOR_ON":
      setNp({ on: vdToBool(raw) });
      return true;
    case "HA_GAIN":
      setNp({ gain: vdToGain(raw) });
      return true;
    case "OUT_FADER":
    case "STEREO_MASTER_FADER":
    case "MONITOR_LEVEL":
      setNp({ level: vdToLevel(raw) });
      return true;
    case "OUT_MASTER_BAL":
    case "STEREO_MASTER_BAL":
      setNp({ pan: vdToPan(raw) });
      return true;
    case "PAN_LINK":
      setNp({ panLink: vdToBool(raw) });
      return true;
    case "TO_ST": // MIX → STEREO "TO ST" switch → the MIX → STEREO connection's on
    case "STEREO_ASSIGN_ON": // CH/FX → STEREO assign ON → that node's main-path connection's on
      setMain({ on: vdToBool(raw) });
      return true;
    case "PHONES_LEVEL":
      setNp({ phonesLevel: vdToPhonesLevel(raw) });
      return true;
    case "OSC_ON":
      setNp({ osc: { ...plan.nodeParams[node]?.osc, on: vdToBool(raw) } });
      return true;
    case "OSC_LEVEL":
      setNp({ osc: { ...plan.nodeParams[node]?.osc, level: vdToCentiDb(raw) } });
      return true;
    default:
      return false;
  }
}

// Read a 4-band PEQ's band values from the device (first instance; linked L/R
// stay in sync). A fixed-peaking mid band (type null) has no filter type to read.
async function readEqBands(source: ParamSource, ctrl: EqControl): Promise<EqBand[]> {
  const { vdGet } = readers(source);
  const inst = ctrl.instances[0];
  const eqBands: EqBand[] = [];
  for (const band of ctrl.bands) {
    const v: EqBand = {
      on: vdToBool(await vdGet(band.on, 0, inst)),
      q: vdToQ(await vdGet(band.q, 0, inst)),
      freq: vdToEqFreq(await vdGet(band.freq, 0, inst)),
      gain: vdToEqGain(await vdGet(band.gain, 0, inst)),
    };
    if (band.type !== null) v.type = await vdGet(band.type, 0, inst);
    eqBands[band.index] = v;
  }
  return eqBands;
}

// Read an EQ 1-knob's ON / TYPE / LEVEL from the device (first instance; linked
// L/R stay in sync). Level is raw 0..100 %, type the shared preset enum.
async function readEqOneKnob(source: ParamSource, ctrl: EqOneKnobControl): Promise<EqOneKnobParams> {
  const { vdGet } = readers(source);
  const inst = ctrl.instances[0];
  return {
    on: vdToBool(await vdGet(ctrl.on, 0, inst)),
    type: await vdGet(ctrl.type, 0, inst),
    level: await vdGet(ctrl.level, 0, inst),
  };
}

// Decode a GATE/COMP detail value from the broker to plan units by its encoding.
function decodeDyn(encoding: ParamEncoding, raw: number): number {
  switch (encoding) {
    case "centiDb":
      return vdToCentiDb(raw);
    case "gateRange":
      return vdToGateRange(raw);
    case "attackTime":
      return vdToAttack(raw);
    case "holdTime":
      return vdToHold(raw);
    case "releaseTime":
      return vdToRelease(raw);
    case "ratio":
      return vdToRatio(raw);
    default:
      return raw;
  }
}

// Read a GATE/COMP detail section's slider values from the device (mono channel).
async function readDyn(source: ParamSource, fields: EmittedDynField[], y: number): Promise<Record<string, number>> {
  const { vdGet } = readers(source);
  const vals: Record<string, number> = {};
  for (const f of fields) {
    const spec = PARAMS[f.name];
    vals[f.key] = decodeDyn(spec.encoding, await vdGet(spec.id, 0, y));
  }
  return vals;
}

// Read one SSMCS EQ band's raw values (Low/High have no Q → q omitted).
async function readSsmcsBand(
  source: ParamSource,
  onId: number,
  qId: number | null,
  freqId: number,
  gainId: number,
  y: number,
): Promise<SsmcsBand> {
  const { vdGet } = readers(source);
  const b: SsmcsBand = {
    on: vdToBool(await vdGet(onId, 0, y)),
    freq: await vdGet(freqId, 0, y),
    gain: await vdGet(gainId, 0, y),
  };
  if (qId !== null) b.q = await vdGet(qId, 0, y);
  return b;
}

// Read an FX channel's EFFECT TYPE + parameter array (mirrors pushFxEffectCommands).
// The type picks the family, then each family slot is read raw. fxIndex 0 / 1.
async function readFxEffect(source: ParamSource, fxIndex: number): Promise<FxEffectParams> {
  const { vdGet } = readers(source);
  const arrId = FX_EFFECT_ARRAY_PARAM[fxIndex];
  const type = await vdGet(FX_EFFECT_TYPE_PARAM[fxIndex], 0, 0);
  const params: Record<string, number> = {};
  for (const desc of fxParams(type)) {
    params[desc.key] = await vdGet(arrId, 0, desc.slot);
  }
  return {
    type,
    on: vdToBool(await vdGet(arrId, 0, FX_SLOT_ON)),
    level: await vdGet(arrId, 0, FX_SLOT_LEVEL),
    params,
  };
}

// Read the SSMCS morphing-strip raw values for a MONO IN channel (mirrors
// pushSsmcsCommands). Sweet Spot Data (string param 91) is plan/UI-only.
async function readSsmcs(source: ParamSource, y: number): Promise<SsmcsParams> {
  const { vdGet } = readers(source);
  return {
    on: vdToBool(await vdGet(PARAMS.SSMCS_ON.id, 0, y)),
    compDrive: await vdGet(PARAMS.SSMCS_COMP_DRIVE.id, 0, y),
    morphing: await vdGet(PARAMS.SSMCS_MORPHING.id, 0, y),
    outGain: await vdGet(PARAMS.SSMCS_OUT_GAIN.id, 0, y),
    comp: {
      attack: await vdGet(PARAMS.SSMCS_COMP_ATTACK.id, 0, y),
      release: await vdGet(PARAMS.SSMCS_COMP_RELEASE.id, 0, y),
      ratio: await vdGet(PARAMS.SSMCS_COMP_RATIO.id, 0, y),
      knee: await vdGet(PARAMS.SSMCS_COMP_KNEE.id, 0, y),
      threshold: await vdGet(PARAMS.SSMCS_COMP_THRESHOLD.id, 0, y),
      makeup: await vdGet(PARAMS.SSMCS_COMP_MAKEUP.id, 0, y),
    },
    sc: {
      on: vdToBool(await vdGet(PARAMS.SSMCS_SC_ON.id, 0, y)),
      q: await vdGet(PARAMS.SSMCS_SC_Q.id, 0, y),
      freq: await vdGet(PARAMS.SSMCS_SC_FREQ.id, 0, y),
      gain: await vdGet(PARAMS.SSMCS_SC_GAIN.id, 0, y),
    },
    eq: {
      low: await readSsmcsBand(
        source,
        PARAMS.SSMCS_EQ_LOW_ON.id,
        null,
        PARAMS.SSMCS_EQ_LOW_FREQ.id,
        PARAMS.SSMCS_EQ_LOW_GAIN.id,
        y,
      ),
      mid: await readSsmcsBand(
        source,
        PARAMS.SSMCS_EQ_MID_ON.id,
        PARAMS.SSMCS_EQ_MID_Q.id,
        PARAMS.SSMCS_EQ_MID_FREQ.id,
        PARAMS.SSMCS_EQ_MID_GAIN.id,
        y,
      ),
      high: await readSsmcsBand(
        source,
        PARAMS.SSMCS_EQ_HIGH_ON.id,
        null,
        PARAMS.SSMCS_EQ_HIGH_FREQ.id,
        PARAMS.SSMCS_EQ_HIGH_GAIN.id,
        y,
      ),
    },
  };
}

/**
 * Render a fetch's read failures as human-readable Markdown the user can save,
 * so the per-group reasons (otherwise console-only) are visible off the status
 * bar. Lists each read failure, every node left at its plan default, and — for a
 * merged read — every key the merge did not apply. That last section is why the
 * parameter is widened: `unplaced` otherwise reaches nothing but a `console.warn`,
 * and a packaged build has no inspector to read it in (no `devtools` feature).
 *
 * Optional rather than required: `MergedRead extends ReadbackResult`, so a union
 * would collapse, and the `.urxf` import path passes a plain `ReadbackResult`. Pure.
 */
export function formatReadbackReport(
  model: string,
  result: ReadbackResult & Partial<Pick<MergedRead, "unplaced">>,
): string {
  const lines: string[] = [];
  lines.push(`# URX readback report — ${model}`);
  lines.push("");
  lines.push(
    `- Groups read: ${result.applied}; read failures: ${result.errors.length}; nodes unconfirmed: ${result.unreadNodes.size}`,
  );
  if (result.errors.length) {
    lines.push("");
    lines.push("## Read failures");
    for (const e of result.errors) lines.push(`- ${e}`);
  }
  if (result.unreadNodes.size) {
    lines.push("");
    lines.push("## Nodes left at plan default (not read)");
    for (const id of result.unreadNodes) lines.push(`- ${id}`);
  }
  if (result.unplaced?.length) {
    lines.push("");
    // Two different things share this list and the heading has to hold for both: a key
    // with nowhere to land (a wire removed while the read was in flight) and a key the
    // operator moved meanwhile, which the merge leaves standing on purpose. Calling
    // them all "no longer in the plan" would report the second — ordinary, correct
    // behaviour — as damage.
    lines.push("## Device values not applied");
    lines.push("");
    lines.push("Each was either edited here while the read was in flight (your edit stands), or had");
    lines.push("nowhere left to land.");
    lines.push("");
    // A wire key joins its two refs with a separator a document must not carry;
    // plan-history owns that encoding and undoes it.
    for (const key of result.unplaced) lines.push(`- ${readableContestKey(key)}`);
  }
  lines.push("");
  return lines.join("\n");
}
