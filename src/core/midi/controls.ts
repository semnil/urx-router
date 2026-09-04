// The control catalog for external MIDI control: every fader, knob and toggle the
// CONSOLE view draws, plus every parameter the channel tuning screens edit,
// addressable by a fixed control id that does not depend on the visible tab or on
// any screen being open. Values cross this boundary normalized (0..1; toggles
// 0 | 1) and are snapped to the same grids those surfaces use, so a MIDI edit and
// an on-screen edit write identical plan values. Kept language-agnostic: labels are
// composed by the UI from the node label + the scope + the param token.

import type { DeviceModel } from "../../models/types";
import { isMonitorBus } from "../constraints";
import {
  LEVEL_OFF_DB,
  sendConnection,
  SSMCS_INITIAL,
  type EqBand,
  type FxEffectParams,
  type NodeParams,
  type Plan,
  type PlanConnection,
  type SsmcsParams,
} from "../plan";
import { LEVEL_POS_MAX, levelToPos, posToLevel } from "../levels";
import { FX_CHANNEL_NODE_INDEX, fxParams, fxRowOwners, resolveFxEffectType } from "../control/fx-effect";
import type { FxParamDesc } from "../control/fx-effect";
import {
  busBalance,
  channelControl,
  channelDynamics,
  dynFromPos,
  dynToPos,
  eqBandFields,
  eqBandHasType,
  hasEq,
  isSsmcsScKey,
  ssmcsEqBandFields,
  ssmcsEqBandHasQ,
  ssmcsPlanKey,
  EQ_BAND_NAMES,
  SSMCS_EQ_BAND_NAMES,
  ssmcsCompFields,
  ssmcsMainFields,
  effectiveInsertFx,
} from "../control/translate";
import type { DynField, SsmcsEqBandName } from "../control/translate";
import {
  COMP_EQ_COMP_FIRST,
  COMP_ONE_KNOB_DRIVEN,
  EQ_TYPE_PASS,
  EQ_TYPE_PEAKING,
  EQ_TYPE_SHELVING,
  insertFxEngaged,
} from "../control/params";
import { mixSendLocks } from "../routing";
import {
  insertFxFamilyOf,
  insertFxLockedSlots,
  insertFxParams,
  insertFxSlotVal,
  reKeyInsertFxParams,
} from "../control/insert-fx-effect";
import { channelEqUnavailable, insertFxMenu, insertFxRateLock, nodeRateDisabled } from "../constraints";
import { PAN_MAX, PAN_MIN, PHONES_LEVEL_DEFAULT, PHONES_LEVEL_MAX, PHONES_LEVEL_MIN } from "../control/vd";

/** The STEREO master — every channel's / FX channel's fixed main send target. */
export const MAIN_BUS = "bus.stereo";

/** Send targets a channel strip can follow (the console's SENDS rack columns). */
export const SEND_TARGETS = ["bus.fx1", "bus.fx2", "bus.mix1", "bus.mix2"] as const;
export type SendTarget = (typeof SEND_TARGETS)[number];

/**
 * Processor scopes. The id's third component names the stage a parameter belongs to,
 * exactly the way a send-scoped id names its destination bus — a node has one fader
 * but three thresholds, and "which threshold" is the same kind of question as "which
 * send's level". Bands are scopes of their own so a mapping stays bound to LOW rather
 * than following whichever band the screen happens to have selected: a mapping has to
 * work with the screen closed.
 */
export const GATE_SCOPE = "gate";
export const COMP_SCOPE = "comp";
export const EQ_SCOPE = "eq";
export const eqBandScope = (index: number): string => `${EQ_SCOPE}.${EQ_BAND_NAMES[index]}`;

/** The SSMCS strip's scopes, one per stage of the morphing bank. They mirror the plan's
 *  own nesting (`ssmcs`, `ssmcs.comp`, `ssmcs.sc`, `ssmcs.eq.<band>`), so a control id
 *  reads as the path to the value it edits. */
/** The insert effect's scope root. Its full scope carries the family and the slot after
 *  it, since the node can change what family it holds. */
export const INSFX_SCOPE = "insfx";
export const FX_SCOPE = "fx";
/** The two `fxEffect` fields that are not catalogue rows, as the scope suffix each is
 *  addressed by. Named here because three surfaces spell them — this catalog, the CONSOLE
 *  chip that arms the first, and the label an assignment prints. */
export const FX_ON_SCOPE = `${FX_SCOPE}.on`;
export const FX_LEVEL_SCOPE = `${FX_SCOPE}.level`;
export const SSMCS_SCOPE = "ssmcs";
export const SSMCS_COMP_SCOPE = `${SSMCS_SCOPE}.comp`;
export const SSMCS_SC_SCOPE = `${SSMCS_SCOPE}.sc`;
export const ssmcsEqBandScope = (band: SsmcsEqBandName): string => `${SSMCS_SCOPE}.eq.${band}`;

/** The catalog param one SSMCS field key is addressed by. Both this and the plan key a
 *  write lands on come from ONE translation (`ssmcsPlanKey`): they were two spellings of
 *  it, and the id took the translation while the write did not. */
export const ssmcsControlParam = (key: string): ControlParam => ssmcsPlanKey(key) as ControlParam;

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
  | "duckerOn"
  // The channel tuning screens' parameters. `gain` is shared with the console's
  // analog GAIN and told apart by its scope (COMP makeup / an EQ band's gain).
  | "threshold"
  | "range"
  | "attack"
  | "hold"
  | "decay"
  | "ratio"
  | "release"
  | "autoMakeup"
  | "oneKnob"
  | "oneKnobLevel"
  | "freq"
  | "q"
  | "bandOn"
  // The SSMCS strip. Attack / Release / Ratio / Q / Freq / Gain / Band ON are the
  // tokens above, under an `ssmcs.*` scope; these four have no counterpart there.
  | "ssmcsOn"
  | "compDrive"
  | "morphing"
  | "outGain"
  | "sideChain"
  // The insert effect's own values. ONE token rather than a name per row: an insert-FX
  // value is a raw engine SLOT under a family the node can change, so the family and the
  // slot go in the SCOPE (`insfx.compander.6`) and the union stays closed. A mapping made
  // under one family simply does not bind while the node holds another — the same answer
  // `bindControl` already gives a mapping for a node that lost the processor it named.
  | "insfx"
  // …and its BYPASS, which is not one of those values: it is a flag of the node's own, the
  // shape `gateOn` / `compOn` / `eqOn` take, and it is switched by a face rather than by a
  // row on the tuning screen. Offered only while the node HOLDS an effect — with none there
  // is no insert to switch, and the strip draws an opener in place of the face.
  | "insertFxOn"
  // The FX channel's effect values. ONE token, as `insfx` is, and for the same reason: an
  // FX value is a raw slot under a type the channel can change, so the plan key it is stored
  // under goes in the SCOPE (`fx.revxHpf`) and the union stays closed. The plan key rather
  // than a family and a slot — the two delay types share both of those and differ only in
  // range, so that spelling would let a mapping made on one drive the other.
  | "fx";

export type ControlKind = "continuous" | "toggle";

export interface ControlDesc {
  /** Fixed id: "node/param" or "node/param@scope". */
  id: string;
  /** The node whose strip / graph repaint covers this control. */
  node: string;
  param: ControlParam;
  /** What the param belongs to when the node alone does not say: a send-target bus
   *  id, or a processor / band scope (`gate`, `comp`, `eq.low`). */
  scope?: string;
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

export function controlId(node: string, param: ControlParam, scope?: string): string {
  return scope ? `${node}/${param}@${scope}` : `${node}/${param}`;
}

export function parseControlId(id: string): { node: string; param: string; scope?: string } | null {
  const m = /^([^/@]+)\/([^/@]+)(?:@([^/@]+))?$/.exec(id);
  return m ? { node: m[1], param: m[2], ...(m[3] ? { scope: m[3] } : {}) } : null;
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

/** Positions a 14-bit control carries, and the highest index of them. */
const WIRE_14_BIT_MAX = (1 << 14) - 1;

/**
 * A codec whose normalized domain IS the 14-bit grid.
 *
 * The engine leaves 14-bit feedback unguarded against its own echo, and that is only safe
 * while every 14-bit round trip is exact — the case in `controls.test.ts` pins it and says
 * why. A control with more settings than the wire has positions cannot satisfy that on a
 * plain linear codec: several of its values share a position, so the value read back after
 * an echo is not the value set, and under Live sync that difference reaches the unit.
 *
 * Snapping the READING to the same grid the writing lands on makes the trip exact again.
 * What it costs is resolution over MIDI and nothing else: the control keeps every setting
 * for a pointer, a wheel and an arrow key, and a controller reaches 16384 of them.
 */
function wireGridCodec(min: number, max: number, step: number): { get(x: number): number; set(v: number): number } {
  const span = max - min;
  return {
    get: (x) => clamp01(Math.round(((x - min) / span) * WIRE_14_BIT_MAX) / WIRE_14_BIT_MAX),
    set: (v) => {
      const i = Math.round(clamp01(v) * WIRE_14_BIT_MAX);
      const raw = min + Math.round((i * span) / WIRE_14_BIT_MAX / step) * step;
      return Math.min(max, Math.max(min, Number(raw.toFixed(4))));
    },
  };
}

/** The codec one FX descriptor is driven through. Linear wherever the wire can address every
 *  setting, and the wire's own grid where it cannot — the Mono Delay time is the one that
 *  cannot, at 27000 settings against 16384 positions. Its step is not free to coarsen (it is
 *  the only one putting both official ends and the factory default on the grid), so the
 *  resolution is given up on the wire rather than in the value. */
function fxCodec(d: FxParamDesc): { get(x: number): number; set(v: number): number } {
  const min = d.rawMin ?? 0;
  const max = d.rawMax ?? 1;
  const step = d.rawStep ?? 1;
  const fine = (max - min) / step > WIRE_14_BIT_MAX;
  return fine ? wireGridCodec(min, max, step) : linearCodec(min, max, step);
}

const panCodec = linearCodec(PAN_MIN, PAN_MAX, 1);
const phonesCodec = linearCodec(PHONES_LEVEL_MIN, PHONES_LEVEL_MAX, 0.1);
const oscLevelCodec = linearCodec(-96, 0, 1);
/** The 1-knob level both COMP and the EQ carry, in percent — the one slider on the
 *  tuning screens that is not a `DynField`. */
const oneKnobCodec = linearCodec(0, 100, 1);

/** A tuning-screen parameter's codec, derived from the same field table its slider
 *  is built from: both resolve a position first, so a MIDI value and a dragged
 *  slider cannot land on different values of the same grid. A logarithmic field
 *  (an EQ band frequency) carries positions rather than its value. */
function dynCodec(f: DynField): { get(x: number): number; set(v: number): number } {
  if (f.logSteps === undefined) return linearCodec(f.min, f.max, f.step);
  const steps = f.logSteps;
  return {
    get: (x) => clamp01(dynToPos(f, x) / steps),
    set: (v) => dynFromPos(f, Math.round(clamp01(v) * steps)),
  };
}

export function listControls(model: DeviceModel, plan: Plan): ControlDesc[] {
  return controlNodes(model).flatMap((id) => nodeControls(model, plan, id));
}

/** Bind one control id against the current plan; null for an unknown id (e.g. a
 *  mapping saved for another model, or a node this model does not have). */
export function bindControl(model: DeviceModel, plan: Plan, id: string): BoundControl | null {
  const parsed = parseControlId(id);
  if (!parsed) return null;
  // Only console-catalog nodes carry controls. Without this, nodeControls' generic
  // fader/chOn branch would mint working level/chOn controls on any model node —
  // an input, output patch or SD rec the console never draws.
  if (!controlNodes(model).includes(parsed.node)) return null;
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
      ...(send ? { scope: send } : {}),
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
  const connMute = (send: string | undefined, defaultOn: boolean, locked?: () => boolean): BoundControl => {
    const to = send ?? MAIN_BUS;
    return {
      id: controlId(id, "mute", send),
      node: id,
      param: "mute",
      ...(send ? { scope: send } : {}),
      kind: "toggle",
      get: () => ((conn(to)?.params?.on ?? defaultOn) ? 0 : 1),
      set: (v) => {
        const c = conn(to);
        if (!c || locked?.()) return false;
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

  // ---- the channel tuning screens' parameters ------------------------------
  // GATE and COMP keep their values in one nodeParams sub-object each; the EQ
  // spreads across `eqBands[i]` and `eqOneKnob`. Each write clones the group it
  // touches, so the history differ sees the same shape a screen edit produces.

  /** A continuous parameter inside a `gate` / `comp` sub-object, on the field
   *  table's own grid. */
  const subDyn = (sub: "gate" | "comp", scope: string, f: DynField, locked?: () => boolean): BoundControl => {
    const codec = dynCodec(f);
    const cur = (): Record<string, unknown> => (plan.nodeParams[id]?.[sub] ?? {}) as Record<string, unknown>;
    return {
      id: controlId(id, f.key as ControlParam, scope),
      node: id,
      param: f.key as ControlParam,
      scope,
      kind: "continuous",
      get: () => codec.get(typeof cur()[f.key] === "number" ? (cur()[f.key] as number) : f.def),
      set: (v) => {
        if (locked?.()) return false;
        const p = np();
        p[sub] = { ...cur(), [f.key]: codec.set(v) };
        return true;
      },
    };
  };

  /** A flag inside a `gate` / `comp` sub-object. */
  const subFlag = (
    sub: "gate" | "comp",
    scope: string,
    key: string,
    param: ControlParam,
    def: boolean,
    locked?: () => boolean,
  ): BoundControl => {
    const cur = (): Record<string, unknown> => (plan.nodeParams[id]?.[sub] ?? {}) as Record<string, unknown>;
    return {
      id: controlId(id, param, scope),
      node: id,
      param,
      scope,
      kind: "toggle",
      get: () => (((cur()[key] as boolean | undefined) ?? def) ? 1 : 0),
      set: (v) => {
        if (locked?.()) return false;
        const p = np();
        p[sub] = { ...cur(), [key]: v >= 0.5 };
        return true;
      },
    };
  };

  /** A 1-knob level, in percent. COMP keeps it in its sub-object, the EQ in
   *  `eqOneKnob` — the two differ only in where they live. */
  const oneKnobLevel = (
    scope: string,
    read: () => number,
    write: (v: number) => void,
    locked: () => boolean,
  ): BoundControl => ({
    id: controlId(id, "oneKnobLevel", scope),
    node: id,
    param: "oneKnobLevel",
    scope,
    kind: "continuous",
    get: () => oneKnobCodec.get(read()),
    set: (v) => {
      if (locked()) return false;
      write(oneKnobCodec.set(v));
      return true;
    },
  });

  // ---- the SSMCS strip ------------------------------------------------------
  // Its values nest (`ssmcs.comp.attack`, `ssmcs.eq.low.gain`), so a write rebuilds the
  // chain from the leaf up, cloning every level — the shape a screen edit produces, and
  // the one the history differ walks.

  /** The sub-object at a path under `ssmcs` ([] = the strip itself). */
  const ssmcsAt = (path: readonly string[]): Record<string, unknown> => {
    let cur = (plan.nodeParams[id]?.ssmcs ?? {}) as Record<string, unknown>;
    for (const k of path) cur = (cur[k] ?? {}) as Record<string, unknown>;
    return cur;
  };
  const writeSsmcs = (path: readonly string[], patch: Record<string, number | boolean>): void => {
    let node: Record<string, unknown> = { ...ssmcsAt(path), ...patch };
    for (let i = path.length - 1; i >= 0; i--) node = { ...ssmcsAt(path.slice(0, i)), [path[i]]: node };
    np().ssmcs = node as SsmcsParams;
  };

  /** A continuous SSMCS value, on the field table's own raw grid. */
  const ssmcsDyn = (path: readonly string[], scope: string, f: DynField): BoundControl => {
    const codec = dynCodec(f);
    const param = ssmcsControlParam(f.key);
    // The SAME translation the id took: the plan stores the side-chain filter's values
    // un-prefixed, and reading one spelling while writing the other is invisible from
    // inside the control (its own `get` reads back what its `set` wrote).
    const planKey = ssmcsPlanKey(f.key);
    return {
      id: controlId(id, param, scope),
      node: id,
      param,
      scope,
      kind: "continuous",
      get: () => codec.get(typeof ssmcsAt(path)[planKey] === "number" ? (ssmcsAt(path)[planKey] as number) : f.def),
      set: (v) => {
        writeSsmcs(path, { [planKey]: codec.set(v) });
        return true;
      },
    };
  };

  /** A flag inside the SSMCS strip. */
  const ssmcsFlag = (
    path: readonly string[],
    scope: string | undefined,
    key: string,
    param: ControlParam,
    def: boolean,
  ): BoundControl => ({
    id: controlId(id, param, scope),
    node: id,
    param,
    ...(scope ? { scope } : {}),
    kind: "toggle",
    get: () => (((ssmcsAt(path)[key] as boolean | undefined) ?? def) ? 1 : 0),
    set: (v) => {
      writeSsmcs(path, { [key]: v >= 0.5 });
      return true;
    },
  });

  const pushSsmcs = (): void => {
    // The section master, in the bare node scope every other section master on this
    // strip takes (GATE / COMP / EQ) — the chip beside them is the same kind of chip.
    out.push(ssmcsFlag([], undefined, "on", "ssmcsOn", SSMCS_INITIAL.on));
    for (const f of ssmcsMainFields()) out.push(ssmcsDyn([], SSMCS_SCOPE, f));
    for (const f of ssmcsCompFields()) {
      const sc = isSsmcsScKey(f.key);
      out.push(ssmcsDyn(sc ? ["sc"] : ["comp"], sc ? SSMCS_SC_SCOPE : SSMCS_COMP_SCOPE, f));
    }
    out.push(ssmcsFlag(["sc"], SSMCS_SC_SCOPE, "on", "sideChain", SSMCS_INITIAL.sc.on));
    for (const band of SSMCS_EQ_BAND_NAMES) {
      const scope = ssmcsEqBandScope(band);
      out.push(ssmcsFlag(["eq", band], scope, "on", "bandOn", SSMCS_INITIAL.eq[band].on));
      // The two shelves have no Q parameter at all — the screen shows that row locked,
      // and a mapping onto it would be a mapping onto nothing.
      for (const f of ssmcsEqBandFields(band)) {
        if (f.key === "q" && !ssmcsEqBandHasQ(band)) continue;
        out.push(ssmcsDyn(["eq", band], scope, f));
      }
    }
  };

  const pushDynamics = (): void => {
    const compEqType = plan.nodeParams[id]?.compEqType ?? COMP_EQ_COMP_FIRST;
    const dyn = channelDynamics(model, id, compEqType);
    if (dyn) {
      for (const f of dyn.gate) out.push(subDyn("gate", GATE_SCOPE, f));
      // COMP is absent in SSMCS mode (the morphing strip replaces it), which is
      // also how the tuning screen learns to refuse to open.
      if (dyn.comp) {
        // While 1-knob is on the device computes threshold / ratio / gain and
        // announces each recomputation, so a write would be overwritten within the
        // flush; Auto Makeup cannot be operated then either, and the level does
        // nothing while it is off. Same rules the screen's rows render under.
        const comp = (): Record<string, unknown> => (plan.nodeParams[id]?.comp ?? {}) as Record<string, unknown>;
        const oneOn = (): boolean => comp().oneKnob === true;
        for (const f of dyn.comp)
          out.push(subDyn("comp", COMP_SCOPE, f, COMP_ONE_KNOB_DRIVEN.has(f.key) ? oneOn : undefined));
        out.push(subFlag("comp", COMP_SCOPE, "autoMakeup", "autoMakeup", false, oneOn));
        out.push(subFlag("comp", COMP_SCOPE, "oneKnob", "oneKnob", false));
        out.push(
          oneKnobLevel(
            COMP_SCOPE,
            () => (typeof comp().oneKnobLevel === "number" ? (comp().oneKnobLevel as number) : 0),
            (v) => {
              const p = np();
              p.comp = { ...comp(), oneKnobLevel: v };
            },
            () => !oneOn(),
          ),
        );
      }
      // The morphing strip stands where COMP and the 4-band PEQ do, so it is offered on
      // exactly the channels that lose them: `channelDynamics` answering with no COMP is
      // the same question the tuning screen asks before it opens.
      else pushSsmcs();
    }

    if (!hasEq(model, id, compEqType)) return;
    // Above 96 kHz a stereo channel's EQ is acoustically bypassed (measured), so
    // every EQ control on it refuses — the whole processor, 1-knob included.
    const rateLocked = (): boolean => channelEqUnavailable(id, plan.sampleRate);
    const knob = (): Record<string, unknown> => (plan.nodeParams[id]?.eqOneKnob ?? {}) as Record<string, unknown>;
    const knobOn = (): boolean => knob().on === true;
    out.push({
      id: controlId(id, "oneKnob", EQ_SCOPE),
      node: id,
      param: "oneKnob",
      scope: EQ_SCOPE,
      kind: "toggle",
      get: () => (knobOn() ? 1 : 0),
      set: (v) => {
        if (rateLocked()) return false;
        const p = np();
        p.eqOneKnob = { ...knob(), on: v >= 0.5 };
        return true;
      },
    });
    out.push(
      oneKnobLevel(
        EQ_SCOPE,
        () => (typeof knob().level === "number" ? (knob().level as number) : 0),
        (v) => {
          const p = np();
          p.eqOneKnob = { ...knob(), level: v };
        },
        () => rateLocked() || !knobOn(),
      ),
    );

    for (const [index] of EQ_BAND_NAMES.entries()) {
      const scope = eqBandScope(index);
      const band = (): EqBand => plan.nodeParams[id]?.eqBands?.[index] ?? {};
      // The bands are an array: the other three have to survive an edit to this one.
      const writeBand = (patch: EqBand): void => {
        const p = np();
        const bands = (p.eqBands ?? []).slice();
        bands[index] = { ...bands[index], ...patch };
        p.eqBands = bands;
      };
      // 1-knob computes all four bands from one level, so the band values are the
      // device's while it is on.
      const bandLocked = (): boolean => rateLocked() || knobOn();
      const type = (): number => band().type ?? (eqBandHasType(index) ? EQ_TYPE_SHELVING : EQ_TYPE_PEAKING);
      out.push({
        id: controlId(id, "bandOn", scope),
        node: id,
        param: "bandOn",
        scope,
        kind: "toggle",
        get: () => (bandLocked() ? 0 : (band().on ?? true) ? 1 : 0),
        set: (v) => {
          if (bandLocked()) return false;
          writeBand({ on: v >= 0.5 });
          return true;
        },
      });
      for (const f of eqBandFields(index)) {
        // A pass filter reads neither Q nor gain (measured: Q 0.71 and Q 4.00 draw
        // an identical high-pass), and only a peaking band reads Q — the same rows
        // the screen locks and tags "Unused by this type".
        const unused =
          f.key === "q"
            ? (): boolean => type() !== EQ_TYPE_PEAKING
            : f.key === "gain"
              ? (): boolean => type() === EQ_TYPE_PASS
              : (): boolean => false;
        const codec = dynCodec(f);
        out.push({
          id: controlId(id, f.key as ControlParam, scope),
          node: id,
          param: f.key as ControlParam,
          scope,
          kind: "continuous",
          get: () => codec.get((band()[f.key as "freq" | "q" | "gain"] as number | undefined) ?? f.def),
          set: (v) => {
            if (bandLocked() || unused()) return false;
            writeBand({ [f.key]: codec.set(v) } as EqBand);
            return true;
          },
        });
      }
    }
  };

  if (node.kind === "ducker") {
    out.push(boolControl("duckerOn", false));
    return out;
  }

  const isChannel = node.kind === "channel";
  const isFx = id === "bus.fx1" || id === "bus.fx2";
  const isMix = id === "bus.mix1" || id === "bus.mix2";
  const isMon = isMonitorBus(id);

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

  // ---- the insert effect the node holds -----------------------------------
  // Scoped by FAMILY and SLOT, so a mapping names the value it was made on rather than
  // "whatever this node's insert effect calls its sixth slot". Enum rows answer nothing:
  // a select has no normalized domain, which is the treatment COMP's knee already gets.
  // Resolved from the CORE catalogue rather than from the screen that also asks this:
  // this module has to load without a DOM (the node smoke test), and `src/ui` reaches
  // the i18n module, which touches `document` at import time.
  const insFxSel = effectiveInsertFx(model, plan, id);
  const insFxFamily = insFxSel === undefined ? null : insertFxFamilyOf(insFxSel);
  if (insFxFamily) {
    // The face's own switch. It writes the bypass and nothing else — selection belongs to the
    // popover — so it takes a param of its own rather than a slot scope: `insfx` names a raw
    // engine slot under a family, and this is neither.
    // The rate lock the HELD effect carries, asked NOW rather than when the mapping was made
    // — the same shape the slot locks beside this take, for the same reason: a mapping
    // outlives the state that locked what it names. Above its ceiling the strip draws this
    // face OFF and refuses the press, so a write arriving here would be an edit the operator
    // is being told is impossible, and the feedback LED would report the stored value against
    // an OFF face. Resolved lazily: the menu is a per-node walk and listing runs on every
    // feedback pass, while a press is one gesture.
    const rateLocked = (): boolean =>
      insertFxRateLock(insertFxMenu(model, plan, id), effectiveInsertFx(model, plan, id)).locked;
    out.push({
      id: controlId(id, "insertFxOn"),
      node: id,
      param: "insertFxOn",
      kind: "toggle",
      get: () =>
        rateLocked() || !insertFxEngaged({ insertFx: insFxSel, insertFxOn: plan.nodeParams[id]?.insertFxOn }) ? 0 : 1,
      set: (v) => {
        if (rateLocked()) return false;
        np().insertFxOn = v >= 0.5;
        return true;
      },
    });
    // With the SELECTOR, not the family alone: the two companders are one family whose
    // defaults are all that separate them, so the family alone answers with Compander-H's
    // for both. A node holding Compander-S with nothing stored yet — offline, a demo, or
    // any plan before its first device read — would then have every pickup crossing point
    // and every feedback value taken from the other one.
    for (const d of insertFxParams(insFxFamily, insFxSel)) {
      if (d.control === "select") continue;
      const scope = `${INSFX_SCOPE}.${insFxFamily}.${d.slot}`;
      // Through the shared reader, or a plan filled from a device read answers with the
      // catalogue default: a readback stores the BARE slot number and only an edit re-keys it.
      const cur = (): number => insertFxSlotVal(plan.nodeParams[id]?.insertFxParams, insFxFamily, d.slot, d.def);
      // The same refusal the tuning screen draws, asked of the same predicate and asked
      // NOW rather than when the mapping was made: a mapping outlives the state that
      // locked its slot, and one made before the unit took the slot over would otherwise
      // write the plan while the writer is suppressing it.
      const lockedNow = (): boolean =>
        insertFxLockedSlots(insFxFamily, plan.nodeParams[id]?.insertFxParams).has(d.slot);
      const write = (raw: number): void => {
        // The mirrored slots Pitch Fix keeps: the device reads both, so a write that moved
        // one would be half applied. `reKeyInsertFxParams` also drops the bare slot the
        // value came from, so the two namespaces cannot both answer for one slot.
        const patch: Record<number, number> = { [d.slot]: raw };
        if (d.mirror !== undefined) patch[d.mirror] = raw;
        np().insertFxParams = reKeyInsertFxParams(np().insertFxParams ?? {}, insFxFamily, patch);
      };
      if (d.control === "toggle") {
        out.push({
          id: controlId(id, "insfx", scope),
          node: id,
          param: "insfx",
          scope,
          kind: "toggle",
          get: () => (cur() ? 1 : 0),
          set: (v) => {
            if (lockedNow()) return false;
            write(v >= 0.5 ? 1 : 0);
            return true;
          },
        });
        continue;
      }
      const lo = d.rawMin ?? 0;
      const hi = d.rawMax ?? 1;
      const step = d.rawStep ?? 1;
      const codec = linearCodec(lo, hi, step);
      out.push({
        id: controlId(id, "insfx", scope),
        node: id,
        param: "insfx",
        scope,
        kind: "continuous",
        get: () => codec.get(cur()),
        set: (v) => {
          if (lockedNow()) return false;
          write(codec.set(v));
          return true;
        },
      });
    }
  }

  // ---- the effect an FX channel holds -------------------------------------
  // Scoped by the PLAN KEY, so a mapping names the value it was made on. The two delay
  // types share a family AND a slot and differ only in the range they take, so a family +
  // slot scope would let a mapping made on Mono Delay drive Ping Pong's time; the catalogue
  // keys already separate exactly those and share the keys that really are one parameter.
  // Enum rows answer nothing — a select has no normalized domain.
  if (isFx) {
    const fxIndex = FX_CHANNEL_NODE_INDEX[id];
    const fxType = resolveFxEffectType(fxIndex, plan.nodeParams[id]?.fxEffect?.type);
    const fxParamsOf = (): Record<string, number> | undefined => plan.nodeParams[id]?.fxEffect?.params;
    const mergeFx = (patch: Partial<FxEffectParams>): void => {
      const p = np();
      p.fxEffect = { ...p.fxEffect, ...patch };
    };
    // EFFECT ON: the CONSOLE strip draws it as a face and the Inspector as a two-button
    // switch, so it is a toggle this catalog owes an id the same way it owes one to every
    // other chip in that row. It sits at the top of `fxEffect` beside Mix, not in the params
    // map, and it has no catalogue descriptor either.
    out.push({
      id: controlId(id, "fx", FX_ON_SCOPE),
      node: id,
      param: "fx",
      scope: FX_ON_SCOPE,
      kind: "toggle",
      get: () => ((plan.nodeParams[id]?.fxEffect?.on ?? true) ? 1 : 0),
      set: (v) => {
        mergeFx({ on: v >= 0.5 });
        return true;
      },
    });
    // Mix lives at the top of `fxEffect` rather than in the params map, so it is written
    // through its own path — the one row here with no catalogue descriptor.
    const mixCodec = linearCodec(0, 100, 1);
    out.push({
      id: controlId(id, "fx", FX_LEVEL_SCOPE),
      node: id,
      param: "fx",
      scope: FX_LEVEL_SCOPE,
      kind: "continuous",
      get: () => mixCodec.get(plan.nodeParams[id]?.fxEffect?.level ?? 100),
      set: (v) => {
        mergeFx({ level: mixCodec.set(v) });
        return true;
      },
    });
    for (const d of fxParams(fxType)) {
      if (d.control === "select") continue;
      const scope = `${FX_SCOPE}.${d.key}`;
      const cur = (): number => fxParamsOf()?.[d.key] ?? d.def;
      const write = (raw: number): void => mergeFx({ params: { ...fxParamsOf(), [d.key]: raw } });
      // The same refusal the tuning screen draws, asked of the same predicate and asked NOW
      // rather than when the mapping was made: while tempo Sync is on the unit is computing
      // the delay time and announcing it, so a mapping made before Sync went on would drive
      // a value the unit overwrites on its own.
      const drivenNow = (): boolean => fxRowOwners(fxType, fxParamsOf()).get(d.key) === "computed";
      if (d.control === "toggle") {
        out.push({
          id: controlId(id, "fx", scope),
          node: id,
          param: "fx",
          scope,
          kind: "toggle",
          get: () => (cur() ? 1 : 0),
          set: (v) => {
            if (drivenNow()) return false;
            write(v >= 0.5 ? 1 : 0);
            return true;
          },
        });
        continue;
      }
      const codec = fxCodec(d);
      out.push({
        id: controlId(id, "fx", scope),
        node: id,
        param: "fx",
        scope,
        kind: "continuous",
        get: () => codec.get(cur()),
        set: (v) => {
          if (drivenNow()) return false;
          write(codec.set(v));
          return true;
        },
      });
    }
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
      // …and a send into a bus the sample rate has removed sets three values on DSP the
      // unit is not running. The CONSOLE locks the whole column on this predicate, so a
      // mapping that reached past it would be the one surface still writing there.
      const rateGone = (): boolean => nodeRateDisabled(target, plan.sampleRate);
      out.push(connControl("level", target, levelCodec, LEVEL_OFF_DB, () => locks().busFixed || rateGone()));
      out.push(connMute(target, true, rateGone));
      if (target === "bus.mix1" || target === "bus.mix2") {
        out.push(connControl("pan", target, panCodec, 0, () => locks().panLinked));
        // Send tap (PRE/POST) as a toggle: MIX taps are freely writable (a CH → FX
        // tap is device-locked and gets no control — the rack shows it read-only).
        out.push({
          id: controlId(id, "tap", target),
          node: id,
          param: "tap",
          scope: target,
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
  // The tuning screens' parameters come last, so the console's own controls keep
  // their order in the assignment list and in `listControls`.
  pushDynamics();
  return out;
}
