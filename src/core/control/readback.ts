// Read the device's current settings back into the plan: the reverse of
// translate.ts. For each confirmed parameter we can both read and show in the
// UI, fetch the live value, decode it to plan units, and write it onto the plan.
// Today that is each channel's main fader / pan (CH_FADER / CH_PAN), reflected
// onto its fixed STEREO send so the inspector shows the on-device level and pan.

import type { DeviceModel } from "../../models/types";
import { ref } from "../../models/types";
import type { ConnParams, EqBand, NodeParams, Plan } from "../plan";
import { clearIncoming, ensureFixedConnections, removeConnection, setExclusiveConnection } from "../plan";
import { vdGet } from "../platform";
import { normalizeInsertFx, PARAMS } from "./params";
import type { DynField, EqControl } from "./translate";
import {
  busEqOn,
  busFader,
  channelControl,
  channelDynamics,
  channelSections,
  DUCKER_FIELDS,
  duckerControl,
  channelInputSlots,
  inputEq,
  inputNodeForPort,
  insertFxControl,
  nodeForPort,
  OSC_ASSIGN_BUSES,
  oscAssign,
  outputEq,
  ROUTING_SELECTORS,
  sendControl,
} from "./translate";
import type { ParamEncoding } from "./params";
import {
  vdToAttack,
  vdToBool,
  vdToCentiDb,
  vdToEqFreq,
  vdToEqGain,
  vdToFreq,
  vdToGain,
  vdToHold,
  vdToLevel,
  vdToMonitorLevel,
  vdToPan,
  vdToPortRef,
  vdToQ,
  vdToRatio,
  vdToRelease,
} from "./vd";

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
   * no body parameters (inputs, out.sdrec) are never attempted and so never
   * appear here. Transient: not serialized into the plan.
   */
  unreadNodes: Set<string>;
}

/**
 * Pull the connected device's channel levels and pans into the plan, mutating it
 * in place. The caller must have connected first (platform.vdConnect) and should
 * re-render afterwards. Read failures are collected, not thrown, so one bad
 * channel does not abort the rest.
 *
 * Provenance tracks body-parameter groups (a node's own settings): each marks a
 * node `attempted` before reading and, if any of its body groups throws, the node
 * lands in `unread`. Wire/connection groups (sends, OSC assign, source/routing
 * selectors) carry routing, not a node's own state, so they never touch
 * provenance — a successful send must not mask a channel whose body read failed.
 * The returned unreadNodes set is `attempted ∩ failed`, so the UI flags exactly
 * the nodes still showing a plan default rather than the live value.
 */
export async function applyDeviceState(model: DeviceModel, plan: Plan): Promise<ReadbackResult> {
  ensureFixedConnections(model, plan);
  const errors: string[] = [];
  // Body-parameter provenance: nodes whose own settings a group tried to read,
  // and the subset whose read failed. unreadNodes = attempted ∩ failed.
  const attempted = new Set<string>();
  const failed = new Set<string>();
  let applied = 0;

  for (const node of model.nodes) {
    if (node.kind !== "channel") continue;
    // Mono → 139/140/141 at input index; stereo → 266/267/268 at stereo index.
    const cc = channelControl(model, node.id);
    if (!cc) continue;
    const conn = plan.connections.find(
      (c) => c.from === ref(node.id, "out") && c.to === ref("bus.stereo", "in"),
    );
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
      // Polarity invert: one (mono) or two independent L/R (stereo).
      for (const ph of cc.phases) update[ph.key] = vdToBool(await vdGet(ph.param, 0, ph.y));
      // Channel-strip section ON (GATE/COMP/EQ). The active COMP/EQ bank follows
      // the type just read; each toggle decodes against its own onValue polarity.
      for (const sec of channelSections(model, node.id, update.compEqType ?? 0)) {
        update[sec.key] = (await vdGet(sec.param, 0, sec.y)) === sec.onValue;
      }
      // Input 4-band PEQ band values (mono COMP->EQ mode / stereo channels).
      const ieq = inputEq(model, node.id, update.compEqType ?? 0);
      if (ieq) update.eqBands = await readEqBands(ieq);
      // Input GATE / COMP detail values (MONO IN channels; COMP only in COMP->EQ).
      const dyn = channelDynamics(model, node.id, update.compEqType ?? 0);
      if (dyn) {
        update.gate = await readDyn(dyn.gate, dyn.y);
        if (dyn.comp) {
          update.comp = {
            ...(await readDyn(dyn.comp, dyn.y)),
            knee: await vdGet(PARAMS.COMP_KNEE.id, 0, dyn.y),
            autoMakeup: vdToBool(await vdGet(PARAMS.COMP_AUTO_MAKEUP.id, 0, dyn.y)),
            oneKnob: vdToBool(await vdGet(PARAMS.COMP_ONE_KNOB.id, 0, dyn.y)),
            oneKnobLevel: await vdGet(PARAMS.COMP_ONE_KNOB_LEVEL.id, 0, dyn.y),
          };
        }
      }
      conn.params = { ...conn.params, level, pan };
      plan.nodeParams[node.id] = { ...plan.nodeParams[node.id], ...update };
      applied++;
    } catch (e) {
      failed.add(node.id);
      errors.push(`${node.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // CH → MIX/FX sends: reflect each send's device state as a wire. An ON send
  // becomes (or updates) a connection carrying its level (+ pan / tap where the
  // bus has them); an OFF send removes any existing wire.
  for (const node of model.nodes) {
    if (node.kind !== "channel") continue;
    for (const bus of model.nodes) {
      if (bus.kind !== "bus") continue;
      const sc = sendControl(model, node.id, bus.id);
      if (!sc) continue;
      const from = ref(node.id, "out");
      const to = ref(bus.id, "in");
      try {
        const on = vdToBool(await vdGet(sc.on[0], 0, sc.y));
        const idx = plan.connections.findIndex((c) => c.from === from && c.to === to);
        if (on) {
          const params: ConnParams = { level: vdToLevel(await vdGet(sc.level[0], 0, sc.y)) };
          if (sc.pan.length) params.pan = vdToPan(await vdGet(sc.pan[0], 0, sc.y));
          params.tap = vdToBool(await vdGet(sc.tap, 0, sc.y)) ? "pre" : "post";
          if (idx >= 0) plan.connections[idx].params = { ...plan.connections[idx].params, ...params };
          else plan.connections.push({ from, to, kind: "send", params });
        } else if (idx >= 0) {
          plan.connections.splice(idx, 1);
        }
        applied++;
      } catch (e) {
        errors.push(`${node.label} → ${bus.label}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // Bus output faders: STEREO master (581) and MIX (674); read the first instance.
  for (const node of model.nodes) {
    if (node.kind !== "bus") continue;
    const bf = busFader(node.id);
    if (!bf) continue;
    attempted.add(node.id);
    try {
      const level = vdToLevel(await vdGet(bf.param, 0, bf.instances[0]));
      plan.nodeParams[node.id] = { ...plan.nodeParams[node.id], level };
      applied++;
    } catch (e) {
      failed.add(node.id);
      errors.push(`${node.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Insert FX (enum): mono input channels (135) and output buses (578 / 671).
  for (const node of model.nodes) {
    const ifx = insertFxControl(model, node.id);
    if (!ifx) continue;
    attempted.add(node.id);
    try {
      const insertFx = normalizeInsertFx(await vdGet(ifx.param, 0, ifx.instances[0]));
      plan.nodeParams[node.id] = { ...plan.nodeParams[node.id], insertFx };
      applied++;
    } catch (e) {
      failed.add(node.id);
      errors.push(`${node.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Output bus EQ ON: STEREO (498) and MIX (591); read the first instance.
  for (const node of model.nodes) {
    if (node.kind !== "bus") continue;
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
    if (node.kind !== "bus") continue;
    const oeq = outputEq(node.id);
    if (!oeq) continue;
    attempted.add(node.id);
    try {
      plan.nodeParams[node.id] = { ...plan.nodeParams[node.id], eqBands: await readEqBands(oeq) };
      applied++;
    } catch (e) {
      failed.add(node.id);
      errors.push(`${node.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Ducker on/off: one per stereo channel, read onto the ducker node.
  for (const node of model.nodes) {
    if (node.kind !== "ducker") continue;
    const dc = duckerControl(model, node.id);
    if (!dc) continue;
    attempted.add(node.id);
    try {
      const duckerOn = vdToBool(await vdGet(PARAMS.DUCKER_ON.id, 0, dc.y));
      const ducker = await readDyn(DUCKER_FIELDS, dc.y);
      plan.nodeParams[node.id] = { ...plan.nodeParams[node.id], duckerOn, ducker };
      applied++;
      // Ducker key source (259): decode the port to its channel/bus node. An
      // unknown port is left untouched (logged) so a value we cannot map does not
      // wrongly clear the existing wire; only the none sentinel clears it.
      const port = vdToPortRef(await vdGet(PARAMS.DUCKER_SRC.id, 0, dc.y));
      const src = port === null ? null : nodeForPort(model, port);
      if (src) setExclusiveConnection(plan, ref(src, "out"), ref(node.id, "in"), "key");
      else if (port === null) clearIncoming(plan, ref(node.id, "in"), "key");
      else errors.push(`${node.label} key: unknown source port ${port}`);
    } catch (e) {
      failed.add(node.id);
      errors.push(`${node.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // STEREO bus master ON/OFF — a single global parameter, read once.
  attempted.add("bus.stereo");
  try {
    const masterOn = vdToBool(await vdGet(PARAMS.STEREO_MASTER_ON.id, 0, 0));
    plan.nodeParams["bus.stereo"] = { ...plan.nodeParams["bus.stereo"], on: masterOn };
    applied++;
  } catch (e) {
    failed.add("bus.stereo");
    errors.push(`STEREO: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Monitor bus levels: bus.mon1 → y0, bus.mon2 → y1.
  for (const [id, y] of [["bus.mon1", 0], ["bus.mon2", 1]] as const) {
    attempted.add(id);
    try {
      const level = vdToMonitorLevel(await vdGet(PARAMS.MONITOR_LEVEL.id, 0, y));
      const cueInterrupt = vdToBool(await vdGet(PARAMS.MONITOR_CUE_INTERRUPT.id, 0, y));
      const mono = vdToBool(await vdGet(PARAMS.MONITOR_MONO.id, 0, y));
      plan.nodeParams[id] = { ...plan.nodeParams[id], level, cueInterrupt, mono };
      applied++;
    } catch (e) {
      failed.add(id);
      errors.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Oscillator generator (bus.osc): on / level / mode / frequency.
  attempted.add("bus.osc");
  try {
    const osc = {
      on: vdToBool(await vdGet(PARAMS.OSC_ON.id, 0, 0)),
      level: vdToCentiDb(await vdGet(PARAMS.OSC_LEVEL.id, 0, 0)),
      mode: await vdGet(PARAMS.OSC_MODE.id, 0, 0),
      freq: vdToEqFreq(await vdGet(PARAMS.OSC_FREQ.id, 0, 0)),
    };
    plan.nodeParams["bus.osc"] = { ...plan.nodeParams["bus.osc"], osc };
    applied++;
  } catch (e) {
    failed.add("bus.osc");
    errors.push(`OSC: ${e instanceof Error ? e.message : String(e)}`);
  }

  // OSC → bus assign: read each bus's L/R channel toggles and reflect the wire
  // (present with oscL/oscR when on, removed when both off).
  for (const busId of OSC_ASSIGN_BUSES) {
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

  // Input source select (param 22): per channel, decode the slot's port to its
  // input node and reflect inputNode → channel as a source wire (NONE clears it).
  for (const node of model.nodes) {
    if (node.kind !== "channel") continue;
    const slots = channelInputSlots(model, node.id);
    if (!slots) continue;
    try {
      const port = vdToPortRef(await vdGet(PARAMS.INPUT_SOURCE.id, 0, slots[0]));
      const src = port === null ? null : inputNodeForPort(port);
      if (src) {
        setExclusiveConnection(plan, ref(src, "out"), ref(node.id, "in"), "source");
        applied++;
      } else if (port === null) {
        clearIncoming(plan, ref(node.id, "in"), "source");
        applied++;
      } else {
        // Unknown port: leave the existing wire untouched rather than clearing it.
        errors.push(`${node.label}: unknown source port ${port}`);
      }
    } catch (e) {
      errors.push(`${node.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Streaming / USB-out / monitor / analog-patch selects (same ROUTING_SELECTORS
  // table that drives emit): decode the L param's port to its source node and
  // reflect the exclusive wire (NONE clears it). Skips selectors whose destination
  // node is absent on this model (e.g. out.line without a line output).
  for (const [to, kind, pl, , yl] of ROUTING_SELECTORS) {
    if (!model.nodes.some((n) => n.id === to)) continue;
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
        // Unknown port: leave the existing wire untouched rather than clearing it.
        errors.push(`${to}: unknown source port ${port}`);
      }
    } catch (e) {
      errors.push(`${to}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // A node is unread when a body group tried it but at least one failed; nodes
  // never attempted (inputs, out.sdrec) and fully-read nodes stay out of the set.
  const unreadNodes = new Set<string>();
  for (const id of attempted) if (failed.has(id)) unreadNodes.add(id);
  return { applied, errors, unreadNodes };
}

// Read a 4-band PEQ's band values from the device (first instance; linked L/R
// stay in sync). A fixed-peaking mid band (type null) has no filter type to read.
async function readEqBands(ctrl: EqControl): Promise<EqBand[]> {
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

// Decode a GATE/COMP detail value from the broker to plan units by its encoding.
function decodeDyn(encoding: ParamEncoding, raw: number): number {
  switch (encoding) {
    case "centiDb":
      return vdToCentiDb(raw);
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
async function readDyn(fields: DynField[], y: number): Promise<Record<string, number>> {
  const vals: Record<string, number> = {};
  for (const f of fields) {
    const spec = PARAMS[f.name];
    vals[f.key] = decodeDyn(spec.encoding, await vdGet(spec.id, 0, y));
  }
  return vals;
}
