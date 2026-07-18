// The console-control catalog for external MIDI control: every fader, knob and
// toggle the CONSOLE view draws, addressable by a fixed control id that does not
// depend on the visible tab. Values cross this boundary normalized (0..1;
// toggles 0 | 1) and are snapped to the same grids the console uses, so a MIDI
// edit and a console edit write identical plan values. Kept language-agnostic:
// labels are composed by the UI from the node label + the param token.

import type { DeviceModel } from "../../models/types";
import { LEVEL_OFF_DB, sendConnection, type NodeParams, type Plan, type PlanConnection } from "../plan";
import { LEVEL_POS_MAX, levelToPos, posToLevel } from "../levels";
import { busBalance, channelControl } from "../control/translate";
import { mixSendLocks } from "../routing";
import { channelEqUnavailable } from "../constraints";
import { PAN_MAX, PAN_MIN, PHONES_LEVEL_DEFAULT, PHONES_LEVEL_MAX, PHONES_LEVEL_MIN } from "../control/vd";

/** The STEREO master — every channel's / FX channel's fixed main send target. */
export const MAIN_BUS = "bus.stereo";

/** Send targets a channel strip can follow (the console's SENDS rack columns). */
export const SEND_TARGETS = ["bus.fx1", "bus.fx2", "bus.mix1", "bus.mix2"] as const;
export type SendTarget = (typeof SEND_TARGETS)[number];

/** Param tokens; the UI localizes them (i18n midi.param). */
export type ControlParam =
  | "level"
  | "mute"
  | "chOn"
  | "pan"
  | "tap"
  | "gain"
  | "phonesLevel"
  | "oscOn"
  | "cueInterrupt"
  | "mono"
  | "gateOn"
  | "compOn"
  | "eqOn"
  | "phantom"
  | "phase"
  | "phaseL"
  | "phaseR"
  | "hpf"
  | "hiZ"
  | "duckerOn";

export type ControlKind = "continuous" | "toggle";

export interface ControlDesc {
  /** Fixed id: "node/param" or "node/param@sendTarget". */
  id: string;
  /** The node whose strip / graph repaint covers this control. */
  node: string;
  param: ControlParam;
  /** Send-target bus id for send-scoped controls (level/mute/pan of one send). */
  send?: string;
  kind: ControlKind;
}

/** A control bound to a concrete plan: normalized read/write access. */
export interface BoundControl extends ControlDesc {
  /** Current value, normalized 0..1 (toggle: 0 | 1). */
  get(): number;
  /** Snap + write a normalized value. False when the control is device-locked
   *  (FIXED-bus send level, Pan-Link send pan, rate-locked stereo EQ): no edit. */
  set(v: number): boolean;
}

export function controlId(node: string, param: ControlParam, send?: string): string {
  return send ? `${node}/${param}@${send}` : `${node}/${param}`;
}

export function parseControlId(id: string): { node: string; param: string; send?: string } | null {
  const m = /^([^/@]+)\/([^/@]+)(?:@([^/@]+))?$/.exec(id);
  return m ? { node: m[1], param: m[2], ...(m[3] ? { send: m[3] } : {}) } : null;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
}

// Normalized codecs for the continuous value domains the console uses.
const levelCodec = {
  get: (db: number): number => levelToPos(db) / LEVEL_POS_MAX,
  set: (v: number): number => posToLevel(Math.round(clamp01(v) * LEVEL_POS_MAX)),
};

function linearCodec(min: number, max: number, step: number): { get(x: number): number; set(v: number): number } {
  const span = max - min;
  return {
    get: (x) => clamp01((x - min) / span),
    // toFixed strips the float dust fractional steps accumulate (0.1-step
    // arithmetic yields 2.9000000000000004) — the same snap wireKnob applies.
    set: (v) => Number((min + Math.round((clamp01(v) * span) / step) * step).toFixed(4)),
  };
}

const panCodec = linearCodec(PAN_MIN, PAN_MAX, 1);
const phonesCodec = linearCodec(PHONES_LEVEL_MIN, PHONES_LEVEL_MAX, 0.1);
const oscLevelCodec = linearCodec(-96, 0, 1);

export function listControls(model: DeviceModel, plan: Plan): ControlDesc[] {
  return controlNodes(model).flatMap((id) => nodeControls(model, plan, id));
}

/** Bind one control id against the current plan; null for an unknown id (e.g. a
 *  mapping saved for another model, or a node this model does not have). */
export function bindControl(model: DeviceModel, plan: Plan, id: string): BoundControl | null {
  const parsed = parseControlId(id);
  if (!parsed) return null;
  return nodeControls(model, plan, parsed.node).find((c) => c.id === id) ?? null;
}

// The nodes that carry console controls, in console strip order: input channels,
// FX/MIX buses, monitors + OSC, the STEREO master — plus the duckers (their chip
// lives on the parent strip but the flag is the ducker node's own).
function controlNodes(model: DeviceModel): string[] {
  const ids = new Set(model.nodes.map((n) => n.id));
  const channels = model.nodes.filter((n) => n.kind === "channel").map((n) => n.id);
  const buses = ["bus.fx1", "bus.fx2", "bus.mix1", "bus.mix2", "bus.mon1", "bus.mon2", "bus.osc", MAIN_BUS].filter(
    (i) => ids.has(i),
  );
  const duckers = model.nodes.filter((n) => n.kind === "ducker").map((n) => n.id);
  return [...channels, ...buses, ...duckers];
}

function nodeControls(model: DeviceModel, plan: Plan, id: string): BoundControl[] {
  const node = model.nodes.find((n) => n.id === id);
  if (!node) return [];
  const out: BoundControl[] = [];
  const np = (): NodeParams => (plan.nodeParams[id] ??= {});
  const conn = (toId: string): PlanConnection | undefined => sendConnection(plan, id, toId);

  // A continuous control persisted on a send connection's params (level / pan);
  // no `send` = the fixed main path into STEREO.
  const connControl = (
    param: "level" | "pan",
    send: string | undefined,
    codec: { get(x: number): number; set(v: number): number },
    fallback: number,
    locked?: () => boolean,
  ): BoundControl => {
    const to = send ?? MAIN_BUS;
    return {
      id: controlId(id, param, send),
      node: id,
      param,
      ...(send ? { send } : {}),
      kind: "continuous",
      get: () => codec.get(conn(to)?.params?.[param] ?? fallback),
      set: (v) => {
        const c = conn(to);
        if (!c || locked?.()) return false;
        c.params = { ...c.params, [param]: codec.set(v) };
        return true;
      },
    };
  };

  // The MUTE semantics mirror the console chip: on a connection it drives the
  // send's ON (1 = muted = on false); channels'/FX sends ship ON, the MIX → STEREO
  // "TO ST" ships off. On a node it drives the master ON (STEREO / MONITOR).
  const connMute = (send: string | undefined, defaultOn: boolean): BoundControl => {
    const to = send ?? MAIN_BUS;
    return {
      id: controlId(id, "mute", send),
      node: id,
      param: "mute",
      ...(send ? { send } : {}),
      kind: "toggle",
      get: () => ((conn(to)?.params?.on ?? defaultOn) ? 0 : 1),
      set: (v) => {
        const c = conn(to);
        if (!c) return false;
        c.params = { ...c.params, on: v < 0.5 };
        return true;
      },
    };
  };

  // The scribble power LED, on every strip but OSC / STREAMING: the node master ON
  // (CH_ON / FX / MIX 675 / STEREO 582 / MONITOR 723) on np.on, with ON polarity
  // (1 = on). Named "chOn" apart from the send-scoped "mute" already bound to the
  // → STEREO send on CH / FX / MIX.
  const nodeOn = (): BoundControl => ({
    id: controlId(id, "chOn"),
    node: id,
    param: "chOn",
    kind: "toggle",
    get: () => (plan.nodeParams[id]?.on === false ? 0 : 1),
    set: (v) => {
      np().on = v >= 0.5;
      return true;
    },
  });

  type BoolKey =
    | "gateOn"
    | "compOn"
    | "eqOn"
    | "phantom"
    | "phase"
    | "phaseL"
    | "phaseR"
    | "hpf"
    | "hiZ"
    | "cueInterrupt"
    | "mono"
    | "duckerOn";
  const boolControl = (param: BoolKey, def: boolean, locked?: () => boolean): BoundControl => ({
    id: controlId(id, param),
    node: id,
    param,
    kind: "toggle",
    get: () => (locked?.() ? 0 : (plan.nodeParams[id]?.[param] ?? def) ? 1 : 0),
    set: (v) => {
      if (locked?.()) return false;
      np()[param] = v >= 0.5;
      return true;
    },
  });

  // A continuous control persisted on the node's own params.
  const nodeControl = (
    param: "level" | "pan" | "gain" | "phonesLevel",
    codec: { get(x: number): number; set(v: number): number },
    fallback: number,
  ): BoundControl => ({
    id: controlId(id, param),
    node: id,
    param,
    kind: "continuous",
    get: () => codec.get(plan.nodeParams[id]?.[param] ?? fallback),
    set: (v) => {
      np()[param] = codec.set(v);
      return true;
    },
  });

  if (node.kind === "ducker") {
    out.push(boolControl("duckerOn", false));
    return out;
  }

  const isChannel = node.kind === "channel";
  const isFx = id === "bus.fx1" || id === "bus.fx2";
  const isMix = id === "bus.mix1" || id === "bus.mix2";
  const isMon = id === "bus.mon1" || id === "bus.mon2";

  if (id === "bus.osc") {
    // OSC drives its level via a knob and an ON button; no mute / sends.
    out.push({
      id: controlId(id, "level"),
      node: id,
      param: "level",
      kind: "continuous",
      get: () => oscLevelCodec.get(plan.nodeParams[id]?.osc?.level ?? -14),
      set: (v) => {
        const p = np();
        p.osc = { ...p.osc, level: oscLevelCodec.set(v) };
        return true;
      },
    });
    out.push({
      id: controlId(id, "oscOn"),
      node: id,
      param: "oscOn",
      kind: "toggle",
      get: () => (plan.nodeParams[id]?.osc?.on ? 1 : 0),
      set: (v) => {
        const p = np();
        p.osc = { ...p.osc, on: v >= 0.5 };
        return true;
      },
    });
    return out;
  }

  if (id === "bus.stream") return out; // meter-only strip: nothing to control

  if (isChannel || isFx) {
    // Main path: the fixed send into STEREO carries the fader / MUTE / PAN-BAL.
    out.push(connControl("level", undefined, levelCodec, 0));
    out.push(connMute(undefined, true));
    out.push(connControl("pan", undefined, panCodec, 0));
    // Sends: level + mute per reachable bus; pan on MIX sends only (FX sends are
    // mono on the device). FIXED BUS Type locks the level, Pan Link the pan.
    for (const target of SEND_TARGETS) {
      if (target === id || !conn(target)) continue;
      const locks = (): { busFixed: boolean; panLinked: boolean } => mixSendLocks(plan, target);
      out.push(connControl("level", target, levelCodec, LEVEL_OFF_DB, () => locks().busFixed));
      out.push(connMute(target, true));
      if (target === "bus.mix1" || target === "bus.mix2") {
        out.push(connControl("pan", target, panCodec, 0, () => locks().panLinked));
        // Send tap (PRE/POST) as a toggle: MIX taps are freely writable (a CH → FX
        // tap is device-locked and gets no control — the rack shows it read-only).
        out.push({
          id: controlId(id, "tap", target),
          node: id,
          param: "tap",
          send: target,
          kind: "toggle",
          get: () => (conn(target)?.params?.tap === "pre" ? 1 : 0),
          set: (v) => {
            const c = conn(target);
            if (!c) return false;
            c.params = { ...c.params, tap: v >= 0.5 ? "pre" : "post" };
            return true;
          },
        });
      }
    }
  } else if (isMix) {
    // MIX strip: own fader; MUTE = the MIX → STEREO "TO ST" send (ships off).
    out.push(nodeControl("level", levelCodec, 0));
    out.push(connMute(undefined, false));
  } else {
    // STEREO master / MONITOR buses: own fader; no → STEREO send, so no MUTE chip.
    out.push(nodeControl("level", levelCodec, 0));
  }

  // The scribble power LED = the node master ON, uniform across every strip that has
  // one (all but OSC / STREAMING). On CH / FX / MIX the send-less "mute" is the →
  // STEREO send, so the LED is a separate "chOn"; STEREO / MONITOR have only this.
  out.push(nodeOn());

  if (busBalance(id)) out.push(nodeControl("pan", panCodec, 0));

  const cc = channelControl(model, id);
  if (isChannel && cc?.gain) {
    // Fallback = the factory value (A.GAIN -8 on mono mic strips, D.GAIN 0).
    out.push(nodeControl("gain", linearCodec(cc.gain.minDb, cc.gain.maxDb, 1), cc.gain.analog ? -8 : 0));
  }
  if (isChannel) {
    // The mic-strip channels (mono ch1..4) are the only GATE/COMP-bearing strips.
    if (cc?.hasMicStrip) out.push(boolControl("phantom", false));
    for (const ph of cc?.phases ?? []) out.push(boolControl(ph.key, false));
    if (cc?.hasHpf) out.push(boolControl("hpf", false));
    if (cc?.hasHiZ) out.push(boolControl("hiZ", false));
    if (cc?.hasMicStrip) out.push(boolControl("gateOn", false));
    if (cc?.hasMicStrip) out.push(boolControl("compOn", false));
  }
  // EQ ON: channels + MIX + STEREO. Stereo-channel EQ is inert (forced off) at
  // 176.4 / 192 kHz, exactly like the console chip.
  if (isChannel || isMix || id === MAIN_BUS) {
    out.push(boolControl("eqOn", true, () => channelEqUnavailable(id, plan.sampleRate)));
  }
  if (isMon) {
    out.push(boolControl("cueInterrupt", true));
    out.push(boolControl("mono", false));
    out.push(nodeControl("phonesLevel", phonesCodec, PHONES_LEVEL_DEFAULT));
  }
  return out;
}
