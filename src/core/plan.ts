// Editable routing plan: the user's choices on top of an immutable DeviceModel.
// Serializes to a versioned JSON document that future hardware reflection will
// reuse as the input.

import type { ConnectionKind, DeviceModel, ModelId } from "../models/types";
import { parseRef } from "../models/types";
import { DEFAULT_SAMPLE_RATE } from "./constraints";

// LEVEL fader / send range in dB (the device level_gain table, shared by every
// fader, send and the monitor — UG "Range: -∞ dB to +10.00 dB"). The slider's
// bottom notch (LEVEL_OFF_DB) is -∞ / off; one step up is the lowest real value
// LEVEL_MIN_DB (-96.0). Verified against the broker level_gain metadata.
export const LEVEL_MIN_DB = -96;
export const LEVEL_MAX_DB = 10;
export const LEVEL_OFF_DB = -96.5;

export interface ConnParams {
  level?: number;
  pan?: number;
  tap?: "pre" | "post";
  /** Oscillator → bus assign: which of the destination's L/R channels are on.
   *  Stereo buses use both; FX buses (mono) use oscL only. Absent = on. */
  oscL?: boolean;
  oscR?: boolean;
}

// Oscillator generator settings (the bus.osc node). level in dB (-96..0), mode
// enum (0 Sine / 1 Pink / 2 Burst), freq in Hz (Sine only), width/interval in
// seconds (Burst only). All optional.
export interface OscParams {
  on?: boolean;
  level?: number;
  mode?: number;
  freq?: number;
  width?: number;
  interval?: number;
}

// One band of an output bus 4-band PEQ. All fields optional (absent = device
// default). `type` is the filter-type enum (LOW / HIGH bands only); the two mid
// bands ignore it. freq in Hz, q 0.50..16.00, gain in dB (±18).
export interface EqBand {
  on?: boolean;
  type?: number;
  freq?: number;
  q?: number;
  gain?: number;
}

// Input GATE detail values (MONO IN channels). threshold/range in dB,
// attack/hold/decay in ms. All optional (absent = device default).
export interface GateParams {
  threshold?: number;
  range?: number;
  attack?: number;
  hold?: number;
  decay?: number;
}

// Ducker detail values (stereo-channel sidechain). threshold/range in dB,
// attack/decay in ms. The ducker source is a key-source connection, not stored here.
export interface DuckerParams {
  threshold?: number;
  range?: number;
  attack?: number;
  decay?: number;
}

// Input COMP detail values (MONO IN channels, COMP->EQ mode). threshold/gain in
// dB, ratio as N:1, knee enum (0 Soft / 1 Medium / 2 Hard), attack/release in ms.
// autoMakeup auto-drives gain; when oneKnob is on the device drives all of the
// above from oneKnobLevel (0-100), so the individual controls are not editable.
export interface CompParams {
  threshold?: number;
  ratio?: number;
  knee?: number;
  gain?: number;
  attack?: number;
  release?: number;
  autoMakeup?: boolean;
  oneKnob?: boolean;
  oneKnobLevel?: number;
}

// SSMCS (Sweet Spot Morphing Channel Strip) detail values (MONO IN channels,
// SSMCS mode — the alternative to COMP->EQ). Every continuous field holds the RAW
// broker integer, not a display unit: the device curves are non-linear (ratio is
// a table, attack/release/Q are logarithmic) and two comp values are internal,
// so storing raw keeps live write/readback a near-identity round-trip. The
// inspector formats raw → ms / N:1 / Hz / Q / dB via the curves in vd.ts.

// SSMCS 3-band EQ band (Low / High are shelving and carry no Q; Mid is peaking).
export interface SsmcsBand {
  on?: boolean;
  q?: number; // raw 0..60 (Mid band only)
  freq?: number; // raw 4..124
  gain?: number; // raw 0..360 (180 = 0 dB)
}

// SSMCS compressor detail. attack/release/ratio raw; knee enum (0/1/2). threshold
// and makeup are device-internal (driven by Comp Drive, not shown on the LCD) and
// kept as opaque raw so a captured plan round-trips exactly.
export interface SsmcsCompParams {
  attack?: number; // raw 57..283
  release?: number; // raw 24..300
  ratio?: number; // raw 0..120 (120 = ∞:1)
  knee?: number; // enum 0 Soft / 1 Medium / 2 Hard
  threshold?: number; // raw 0..200 (internal)
  makeup?: number; // raw 0..200 (internal)
}

// SSMCS compressor side-chain filter (Q / Freq / Gain raw).
export interface SsmcsScParams {
  on?: boolean;
  q?: number; // raw 0..60
  freq?: number; // raw 4..124
  gain?: number; // raw 0..360
}

export interface SsmcsParams {
  on?: boolean; // SSMCS section ON (the [SSMCS] button)
  // Preset index 1..34 (6 generic + 28 artist). UI/plan only — the device param
  // is a string ("0001".") the numeric IPC cannot carry, so it is not in the
  // write catalog and does not round-trip through readback.
  sweetSpotData?: number;
  compDrive?: number; // raw 0..200 (display = raw/20, 0.00..10.00)
  morphing?: number; // raw 0..120
  outGain?: number; // raw 0..360 (180 = 0 dB)
  comp?: SsmcsCompParams;
  sc?: SsmcsScParams;
  eq?: { low?: SsmcsBand; mid?: SsmcsBand; high?: SsmcsBand };
}

// SSMCS factory-initial values, captured from a real URX44V MONO IN channel with
// the default "01 Basic" Sweet Spot Data loaded (raw broker units). Shared by all
// models' seeds and used as the inspector's absent-value fallback, so a new SSMCS
// channel matches the device out of the box.
export const SSMCS_INITIAL = {
  on: true,
  sweetSpotData: 1,
  compDrive: 100,
  morphing: 0,
  outGain: 180,
  comp: { attack: 184, release: 159, ratio: 30, knee: 1, threshold: 100, makeup: 70 },
  sc: { on: true, q: 12, freq: 30, gain: 133 },
  eq: {
    low: { on: true, freq: 32, gain: 180 },
    mid: { on: true, q: 12, freq: 72, gain: 180 },
    high: { on: true, freq: 112, gain: 180 },
  },
} satisfies SsmcsParams;

// Per-node device parameters that are not tied to a single wire (a channel's own
// processing/state). Each field is optional; absence means the device default
// (channel on, HPF off). Stored keyed by node id, alongside positions / notes.
export interface NodeParams {
  /** CH_ON: channel on. Absent or true = on; false = muted. */
  on?: boolean;
  /** HPF_ON: high-pass filter engaged. Absent or false = off. */
  hpf?: boolean;
  /** HPF_FREQ: high-pass cutoff in Hz (40 … 120). Absent = device default (80). */
  hpfFreq?: number;
  /** INSERT_FX: insert-effect enum value (MONO IN channels). Absent or -1 = No Effect. */
  insertFx?: number;
  /** COMP_EQ_TYPE: 0 = COMP->EQ, 1 = SSMCS (MONO IN channels). Absent = COMP->EQ. */
  compEqType?: number;
  /** Rec Point: signal-path tap for the channel's recording / direct out
   *  (REC_POINT_OPTIONS value). Absent = PRE FADER (the device default). */
  recPoint?: number;
  /** Signal Type stereo link for a MONO IN pair, stored on the pair's primary
   *  (odd) channel: true = STEREO (linked), absent/false = MONO x 2. */
  stereoLink?: boolean;
  /** PAN / BAL mode for a STEREO-linked pair (primary channel): 0 = PAN
   *  (independent), 1 = BAL (balance). Absent = PAN. Meaningful only when linked. */
  panBal?: number;
  /** BUS Type for MIX 1 / MIX 2: 0 = VARI (variable send level), 1 = FIXED
   *  (fixed send level). Absent = VARI. */
  busType?: number;
  /** Pan Link (MIX 1 / MIX 2, VARI only): send pan follows the source channel
   *  PAN. Absent or false = off. */
  panLink?: boolean;
  /** Post Fader Send for FX (FX 1 / FX 2): the MIX bus (1 or 2) whose post-fader
   *  signal feeds this FX bus, per the DAW Integration menu. Absent or -1 = none. */
  fxPostSource?: number;
  /** EQ ON for an input channel or an output bus (STEREO / MIX). Absent or true = on. */
  eqOn?: boolean;
  /** Output bus 4-band PEQ band values, indexed 0..3 (LOW … HIGH). */
  eqBands?: EqBand[];
  /** Input GATE detail values (MONO IN channels). */
  gate?: GateParams;
  /** Input COMP detail values (MONO IN channels, COMP->EQ mode). */
  comp?: CompParams;
  /** SSMCS detail values (MONO IN channels, SSMCS mode). Replaces comp/eq when
   *  compEqType = SSMCS; absent = device defaults. */
  ssmcs?: SsmcsParams;
  /** DUCKER_ON: sidechain ducker engaged (ducker nodes). Absent or false = off. */
  duckerOn?: boolean;
  /** Ducker detail values (ducker nodes). */
  ducker?: DuckerParams;
  /** GATE_ON: noise-gate section on (MONO IN channels). Absent or false = off. */
  gateOn?: boolean;
  /** COMP_ON: compressor section on (MONO IN channels). Absent or false = off. */
  compOn?: boolean;
  /** PHANTOM: +48V phantom power (analog mic channels only). Absent or false = off. */
  phantom?: boolean;
  /** PHASE: polarity invert (Ø) on a mono mic channel. Absent or false = off. */
  phase?: boolean;
  /** PHASE_L / PHASE_R: independent polarity invert for a stereo channel's L/R sides. */
  phaseL?: boolean;
  phaseR?: boolean;
  /** CLIP_SAFE: head-amp clip protection (analog mic channels only). Absent or false = off. */
  clipSafe?: boolean;
  /** HI_Z: high-impedance instrument input (CH3/CH4 only). Absent or false = off. */
  hiZ?: boolean;
  /** HA_GAIN: head-amp input gain in dB (-8 … +70). Absent = device default. */
  gain?: number;
  /** A node-level fader in dB (e.g. monitor level). Absent = device default. */
  level?: number;
  /** Oscillator generator settings (the bus.osc node). */
  osc?: OscParams;
  /** Monitor CUE interrupt (monitor buses). Absent or true = on (device default). */
  cueInterrupt?: boolean;
  /** Monitor MONO downmix (monitor buses). Absent or false = off. */
  mono?: boolean;
}

export interface PlanConnection {
  from: string; // "nodeId:portId" (out)
  to: string; // "nodeId:portId" (in)
  kind: ConnectionKind;
  params?: ConnParams;
}

export interface NodePos {
  x: number;
  y: number;
}

export interface Plan {
  modelId: ModelId;
  /** Mixer sample rate in Hz; drives the FX-disable warnings. */
  sampleRate: number;
  positions: Record<string, NodePos>;
  connections: PlanConnection[];
  /** Per-node device parameters (channel on / HPF), keyed by node id. */
  nodeParams: Record<string, NodeParams>;
  /** User-chosen channel/bus name overrides, keyed by node id (mirrors the
   *  device CH SETTING name). Absent / empty = the model's default label. */
  nodeNames: Record<string, string>;
  /** User-chosen channel/bus color overrides (hex), keyed by node id (mirrors
   *  the device CH SETTING color). Drawn as a top accent cap; absent = none. */
  nodeColors: Record<string, string>;
  /** Node ids the user collapsed off the canvas (only ever unconnected nodes). */
  hidden: string[];
  /** Free-text annotation per node id, drawn inside the node frame. */
  notes: Record<string, string>;
  /** Node ids whose in-frame note panel is minimized to the header. */
  noteCollapsed: string[];
  /**
   * Ids of nodes whose body parameters a device readback tried but failed to
   * read on the last fetch, so they still show their plan default. Present only
   * after a device readback; absent on new / loaded / hand-edited plans.
   * Transient provenance, never serialized: nodes in this set are flagged in the
   * UI as not read from the device.
   */
  unreadNodes?: Set<string>;
}

export const PLAN_FORMAT = "urx-router-plan";
export const PLAN_VERSION = 1;

// Language-agnostic load failures. The UI maps the code to a localized message.
export type PlanErrorCode = "notPlanFile" | "missingModel";

export class PlanError extends Error {
  constructor(readonly code: PlanErrorCode) {
    super(code);
    this.name = "PlanError";
  }
}

export function emptyPlan(modelId: ModelId): Plan {
  return {
    modelId,
    sampleRate: DEFAULT_SAMPLE_RATE,
    positions: {},
    connections: [],
    nodeParams: {},
    nodeNames: {},
    nodeColors: {},
    hidden: [],
    notes: {},
    noteCollapsed: [],
  };
}

export function serialize(plan: Plan): string {
  return JSON.stringify(
    {
      format: PLAN_FORMAT,
      version: PLAN_VERSION,
      modelId: plan.modelId,
      sampleRate: plan.sampleRate,
      positions: plan.positions,
      connections: plan.connections,
      nodeParams: plan.nodeParams,
      nodeNames: plan.nodeNames,
      nodeColors: plan.nodeColors,
      hidden: plan.hidden,
      notes: plan.notes,
      noteCollapsed: plan.noteCollapsed,
    },
    null,
    2,
  );
}

export function deserialize(text: string): Plan {
  const data = JSON.parse(text) as Record<string, unknown>;
  if (data.format !== PLAN_FORMAT) {
    throw new PlanError("notPlanFile");
  }
  if (typeof data.modelId !== "string") {
    throw new PlanError("missingModel");
  }
  return {
    modelId: data.modelId as ModelId,
    sampleRate: typeof data.sampleRate === "number" ? data.sampleRate : DEFAULT_SAMPLE_RATE,
    positions: (data.positions as Record<string, NodePos>) ?? {},
    connections: Array.isArray(data.connections) ? (data.connections as PlanConnection[]) : [],
    nodeParams: isStringRecord(data.nodeParams)
      ? (data.nodeParams as unknown as Record<string, NodeParams>)
      : {},
    nodeNames: isStringRecord(data.nodeNames) ? (data.nodeNames as Record<string, string>) : {},
    nodeColors: isStringRecord(data.nodeColors) ? (data.nodeColors as Record<string, string>) : {},
    hidden: Array.isArray(data.hidden) ? (data.hidden as string[]) : [],
    notes: isStringRecord(data.notes) ? data.notes : {},
    noteCollapsed: Array.isArray(data.noteCollapsed) ? (data.noteCollapsed as string[]) : [],
  };
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function hasConnection(plan: Plan, from: string, to: string): boolean {
  return plan.connections.some((c) => c.from === from && c.to === to);
}

// Materialize the model's fixed (non-removable) wires into the plan when missing,
// so they show pre-connected and survive plans saved before they existed. Idempotent
// and leaves any existing entry (with its level/pan) untouched.
export function ensureFixedConnections(model: DeviceModel, plan: Plan): void {
  for (const rule of model.rules) {
    if (!rule.fixed || hasConnection(plan, rule.from, rule.to)) continue;
    const conn: PlanConnection = { from: rule.from, to: rule.to, kind: rule.kind };
    // FX returns into STEREO (the only bus-sourced fixed sends) default to -∞ so a
    // return is not summed into the main mix until raised; channel main paths stay at unity.
    const fromKind = model.nodes.find((n) => n.id === parseRef(rule.from).nodeId)?.kind;
    if (fromKind === "bus") conn.params = { level: LEVEL_OFF_DB };
    plan.connections.push(conn);
  }
}

export function removeConnection(plan: Plan, from: string, to: string): void {
  plan.connections = plan.connections.filter((c) => !(c.from === from && c.to === to));
}

// Exclusive routing selectors (source / patch / key) accept at most one incoming
// wire into a destination; these mutators express that single-input invariant.
export function incomingConnection(plan: Plan, to: string, kind: ConnectionKind): PlanConnection | undefined {
  return plan.connections.find((c) => c.to === to && c.kind === kind);
}

export function clearIncoming(plan: Plan, to: string, kind: ConnectionKind): void {
  plan.connections = plan.connections.filter((c) => !(c.to === to && c.kind === kind));
}

export function setExclusiveConnection(plan: Plan, from: string, to: string, kind: ConnectionKind): void {
  clearIncoming(plan, to, kind);
  plan.connections.push({ from, to, kind });
}
