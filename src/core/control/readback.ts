// Read the device's current settings back into the plan: the reverse of
// translate.ts. For each confirmed parameter we can both read and show in the
// UI, fetch the live value, decode it to plan units, and write it onto the plan.
// Today that is each channel's main fader / pan (CH_FADER / CH_PAN), reflected
// onto its fixed STEREO send so the inspector shows the on-device level and pan.

import type { DeviceModel } from "../../models/types";
import { ref } from "../../models/types";
import type { ConnParams, EqBand, EqOneKnobParams, FxEffectParams, NodeParams, Plan, SsmcsBand, SsmcsParams } from "../plan";
import { clearIncoming, ensureFixedConnections, removeConnection, setExclusiveConnection } from "../plan";
import { vdGet, vdGetStr } from "../platform";
import { colorIndexToHex, COMP_EQ_SSMCS, normalizeInsertFx, PARAMS } from "./params";
import {
  FX_EFFECT_ARRAY_PARAM,
  FX_EFFECT_TYPE_PARAM,
  FX_SLOT_LEVEL,
  FX_SLOT_ON,
  fxFamilyOf,
  fxParams,
} from "./fx-effect";
import type { DynField, EqControl, EqOneKnobControl } from "./translate";
import {
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
  vdToAttack,
  vdToBool,
  vdToBurstWidth,
  vdToCentiDb,
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
export async function applyDeviceState(
  model: DeviceModel,
  plan: Plan,
  signal?: AbortSignal,
): Promise<ReadbackResult> {
  ensureFixedConnections(model, plan);
  const errors: string[] = [];
  // Body-parameter provenance: nodes whose own settings a group tried to read,
  // and the subset whose read failed. unreadNodes = attempted ∩ failed.
  const attempted = new Set<string>();
  const failed = new Set<string>();
  let applied = 0;

  for (const node of model.nodes) {
    signal?.throwIfAborted();
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
      // Rec Point: per-channel record / direct-out tap (MONO IN only, param 137).
      if (cc.hasMicStrip) update.recPoint = await vdGet(PARAMS.REC_POINT.id, 0, cc.y);
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
      // Input EQ 1-knob (ON / TYPE / LEVEL).
      const iok = eqOneKnob(model, node.id, update.compEqType ?? 0);
      if (iok) update.eqOneKnob = await readEqOneKnob(iok);
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
        } else if ((update.compEqType ?? 0) === COMP_EQ_SSMCS) {
          // SSMCS mode: read the morphing strip's raw values (mirrors emission).
          // Comp/EQ section ON were read above via channelSections (compOn/eqOn).
          // Sweet Spot Data is plan/UI-only (string param), so not read here.
          update.ssmcs = await readSsmcs(dyn.y);
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

  // CH / FX-channel → MIX/FX sends. Every send is fixed (always wired), so its wire
  // is kept and the device's ON/OFF is stored in params.on alongside level / pan /
  // tap; readback never adds or removes a send wire. ensureFixedConnections (above)
  // has already materialized any missing fixed wire, so an entry exists here.
  for (const node of model.nodes) {
    signal?.throwIfAborted();
    if (node.kind !== "channel" && fxChannelIndex(node.id) === null) continue;
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

  // FX channel → STEREO main path: the FX channel master fader (337) / balance
  // (339) carry the fixed FX-channel → STEREO send's level / pan (mirrors the
  // channel main path above; the FX channel ON toggle is read via busMasterOn).
  for (const node of model.nodes) {
    signal?.throwIfAborted();
    const fxY = fxChannelIndex(node.id);
    if (fxY === null) continue;
    // FX-channel effect (EFFECT TYPE + parameter array): a node-level attribute,
    // read whether or not the FX → STEREO main path is wired.
    attempted.add(node.id);
    try {
      const fxEffect = await readFxEffect(fxY);
      plan.nodeParams[node.id] = { ...plan.nodeParams[node.id], fxEffect };
      applied++;
    } catch (e) {
      failed.add(node.id);
      errors.push(`${node.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const conn = plan.connections.find(
      (c) => c.from === ref(node.id, "out") && c.to === ref("bus.stereo", "in"),
    );
    if (!conn) continue;
    try {
      const level = vdToLevel(await vdGet(PARAMS.FX_CHANNEL_FADER.id, 0, fxY));
      const pan = vdToPan(await vdGet(PARAMS.FX_CHANNEL_BAL.id, 0, fxY));
      conn.params = { ...conn.params, level, pan };
      applied++;
    } catch (e) {
      errors.push(`${node.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Bus output faders: STEREO master (581) and MIX (674); read the first instance.
  for (const node of model.nodes) {
    signal?.throwIfAborted();
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

  // CH SETTING color (palette index → swatch hex): input channels (20) and the
  // MIX/STEREO buses (586 / 496). Off / an unknown index clears the override.
  // Kept out of the body-read provenance (attempted/failed) — a color is an
  // annotation, not a node's settings, so a color read failure must not flag the
  // node's body as unread.
  for (const node of model.nodes) {
    signal?.throwIfAborted();
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
  for (const node of model.nodes) {
    signal?.throwIfAborted();
    const nc = nameControl(model, node.id);
    if (!nc) continue;
    try {
      const name = (await vdGetStr(nc.param, 0, nc.instances[0])).trim();
      if (name) plan.nodeNames[node.id] = name;
      else delete plan.nodeNames[node.id];
      applied++;
    } catch (e) {
      errors.push(`${node.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Insert FX (enum): mono input channels (135) and output buses (578 / 671).
  for (const node of model.nodes) {
    signal?.throwIfAborted();
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
    signal?.throwIfAborted();
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
    signal?.throwIfAborted();
    if (node.kind !== "bus") continue;
    const oeq = outputEq(node.id);
    if (!oeq) continue;
    attempted.add(node.id);
    try {
      const np = { ...plan.nodeParams[node.id], eqBands: await readEqBands(oeq) };
      const ok = eqOneKnob(model, node.id, 0);
      if (ok) np.eqOneKnob = await readEqOneKnob(ok);
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

  // Bus master ON/OFF: STEREO master (582), MIX buses (675, L/R-linked — the L
  // instance is read) and the FX channels (338, per FX).
  for (const node of model.nodes) {
    signal?.throwIfAborted();
    if (node.kind !== "bus") continue;
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
      plan.nodeParams[node.id] = {
        ...plan.nodeParams[node.id],
        on,
        ...(busType !== undefined ? { busType } : {}),
      };
      applied++;
    } catch (e) {
      failed.add(node.id);
      errors.push(`${node.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Monitor bus levels: bus.mon1 → y0, bus.mon2 → y1.
  for (const [id, y] of [["bus.mon1", 0], ["bus.mon2", 1]] as const) {
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

  // STREAMING DELAY (bus.stream): on / time / frame rate.
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

  // Sample rate (global, raw Hz) onto the plan-level scalar. Not a node setting,
  // so it stays out of the body-read provenance (attempted/failed). 766 is the
  // control; 843 mirrors it. A read failure leaves the plan's rate untouched.
  try {
    plan.sampleRate = await vdGet(PARAMS.SAMPLE_RATE.id, 0, 0);
    applied++;
  } catch (e) {
    errors.push(`sample rate: ${e instanceof Error ? e.message : String(e)}`);
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

  // Input source select: decode the channel's source port to its input node and
  // reflect inputNode → channel as a source wire (NONE clears it). MONO CH1-4 read
  // param 22 at the physical slot; stereo channels read param 209 (L) at the stereo
  // pair index — param 22 only covers the mono slots (confirmed on URX44V).
  const srcStereoIdx = stereoIndexMap(model);
  for (const node of model.nodes) {
    signal?.throwIfAborted();
    if (node.kind !== "channel") continue;
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

  // microSD Rec per-track source assign: decode each track-pair slot's L track
  // (param 736) to its source node (channel pair / STEREO / MIX) and reflect the
  // exclusive record wire (NONE clears it). Empty on models without a recorder.
  for (const slot of recordSlots(model)) {
    signal?.throwIfAborted();
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
        // Unknown port: leave the existing wire untouched rather than clearing it.
        errors.push(`${slot.id}: unknown record source port ${port}`);
      }
    } catch (e) {
      errors.push(`${slot.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // microSD Rec Track Count (839, read-only): tracks = raw × 2, onto the SD Rec
  // header. Like sample rate, a standalone read kept out of body provenance.
  if (model.nodes.some((n) => n.id === "out.sdrec")) {
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

// Read an EQ 1-knob's ON / TYPE / LEVEL from the device (first instance; linked
// L/R stay in sync). Level is raw 0..100 %, type the shared preset enum.
async function readEqOneKnob(ctrl: EqOneKnobControl): Promise<EqOneKnobParams> {
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

// Read one SSMCS EQ band's raw values (Low/High have no Q → q omitted).
async function readSsmcsBand(onId: number, qId: number | null, freqId: number, gainId: number, y: number): Promise<SsmcsBand> {
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
async function readFxEffect(fxIndex: number): Promise<FxEffectParams> {
  const arrId = FX_EFFECT_ARRAY_PARAM[fxIndex];
  const type = await vdGet(FX_EFFECT_TYPE_PARAM[fxIndex], 0, 0);
  const params: Record<string, number> = {};
  for (const desc of fxParams(fxFamilyOf(type))) {
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
async function readSsmcs(y: number): Promise<SsmcsParams> {
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
      low: await readSsmcsBand(PARAMS.SSMCS_EQ_LOW_ON.id, null, PARAMS.SSMCS_EQ_LOW_FREQ.id, PARAMS.SSMCS_EQ_LOW_GAIN.id, y),
      mid: await readSsmcsBand(PARAMS.SSMCS_EQ_MID_ON.id, PARAMS.SSMCS_EQ_MID_Q.id, PARAMS.SSMCS_EQ_MID_FREQ.id, PARAMS.SSMCS_EQ_MID_GAIN.id, y),
      high: await readSsmcsBand(PARAMS.SSMCS_EQ_HIGH_ON.id, null, PARAMS.SSMCS_EQ_HIGH_FREQ.id, PARAMS.SSMCS_EQ_HIGH_GAIN.id, y),
    },
  };
}

/**
 * Render a fetch's read failures as human-readable Markdown the user can save,
 * so the per-group reasons (otherwise console-only) are visible off the status
 * bar. Lists each read failure and every node left at its plan default. Pure.
 */
export function formatReadbackReport(model: string, result: ReadbackResult): string {
  const lines: string[] = [];
  lines.push(`# URX fetch report — ${model}`);
  lines.push("");
  lines.push(`- Groups read: ${result.applied}; read failures: ${result.errors.length}; nodes unconfirmed: ${result.unreadNodes.size}`);
  if (result.errors.length) {
    lines.push("");
    lines.push("## Read failures");
    for (const e of result.errors) lines.push(`- ${e}`);
  }
  if (result.unreadNodes.size) {
    lines.push("");
    lines.push("## Nodes left at plan default (not confirmed from the device)");
    for (const id of result.unreadNodes) lines.push(`- ${id}`);
  }
  lines.push("");
  return lines.join("\n");
}
