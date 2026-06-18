// Editable routing plan: the user's choices on top of an immutable DeviceModel.
// Serializes to a versioned JSON document that future hardware reflection will
// reuse as the input.

import type { ConnectionKind, DeviceModel, ModelId } from "../models/types";
import { parseRef } from "../models/types";
import { DEFAULT_SAMPLE_RATE } from "./constraints";

// LEVEL fader range in dB. The floor reads as -∞ (off) in the inspector.
export const LEVEL_MIN_DB = -60;
export const LEVEL_MAX_DB = 10;

export interface ConnParams {
  level?: number;
  pan?: number;
  tap?: "pre" | "post";
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
  /** EQ ON for an input channel or an output bus (STEREO / MIX). Absent or true = on. */
  eqOn?: boolean;
  /** Output bus 4-band PEQ band values, indexed 0..3 (LOW … HIGH). */
  eqBands?: EqBand[];
  /** Input GATE detail values (MONO IN channels). */
  gate?: GateParams;
  /** Input COMP detail values (MONO IN channels, COMP->EQ mode). */
  comp?: CompParams;
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
  /** HA_GAIN: head-amp input gain in dB (-16 … +70). Absent = device default. */
  gain?: number;
  /** A node-level fader in dB (e.g. monitor level). Absent = device default. */
  level?: number;
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
  /** Node ids the user collapsed off the canvas (only ever unconnected nodes). */
  hidden: string[];
  /** Free-text annotation per node id, drawn inside the node frame. */
  notes: Record<string, string>;
  /** Node ids whose in-frame note panel is minimized to the header. */
  noteCollapsed: string[];
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
    if (fromKind === "bus") conn.params = { level: LEVEL_MIN_DB };
    plan.connections.push(conn);
  }
}

export function removeConnection(plan: Plan, from: string, to: string): void {
  plan.connections = plan.connections.filter((c) => !(c.from === from && c.to === to));
}
