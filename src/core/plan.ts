// Editable routing plan: the user's choices on top of an immutable DeviceModel.
// Serializes to a versioned JSON document that future hardware reflection will
// reuse as the input.

import type { ConnectionKind, DeviceModel, ModelId } from "../models/types";
import { parseRef, ref } from "../models/types";
import { DEFAULT_SAMPLE_RATE, SAMPLE_RATES } from "./constraints";

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
  /** Send ON/OFF (SEND_ON) for a fixed send whose routing is always wired (the
   *  FX channel → MIX sends). Absent = on. Non-fixed sends represent on/off by
   *  wire existence instead, so this stays unset for them. */
  on?: boolean;
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

// STREAMING DELAY (the bus.stream node, UG "DELAY screen" — STREAMING channel
// only). A single delay applied to the streaming output: on/off, time in ms
// (1.00 … 1000.00, 0.01 ms resolution), and a frame-rate enum that affects only
// how the time is shown in frames on the device (the delay itself is in ms).
// All optional (absent = device default: off / 1.00 ms / 30 fps).
export interface DelayParams {
  on?: boolean;
  time?: number; // ms, 1.00 … 1000.00
  frameRate?: number; // enum 0..7 (see DELAY_FRAME_RATE_OPTIONS)
}

// EQ 1-knob (UG "1-knob EQ"): a simplified mode on every EQ (input channels and
// output buses) where one knob drives the whole 4-band PEQ. `type` is a shared
// preset enum (0 Intensity / 1 Vocal / 2 Loudness) whose dropdown shows only the
// subset that applies — Intensity/Vocal on mono input channels, Intensity/Loudness
// on stereo channels and output buses. `level` is the effect depth 0..100 %. When
// on, the device recomputes the 4-band PEQ, so the tool does not author the band
// values (they are device-driven). All optional (absent = device default: off).
export interface EqOneKnobParams {
  on?: boolean;
  type?: number; // 0 Intensity / 1 Vocal / 2 Loudness
  level?: number; // 0 … 100 %
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
  // Preset index 1..34 (6 generic + 28 artist). The device param (91) is a 4-digit
  // zero-padded string ("0001".."0034"), so it rides the string-write path
  // (planToNameWrites / vd_set_str), not the numeric catalog. Round-trips via readback.
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

// FX-channel effect (reverb / delay) settings. `type` is the EFFECT TYPE enum
// (the broker selector value) and picks the parameter layout; per-effect parameter
// RAW broker values are kept under `params`, keyed by the fx-effect descriptor key
// (see control/fx-effect.ts), mirroring the device array so a captured plan
// round-trips exactly. Absent fields fall back to the device defaults.
export interface FxEffectParams {
  type?: number; // EFFECT TYPE enum (679 / 683 value); absent = FX default
  on?: boolean; // effect ON (array slot 1); absent or true = on
  level?: number; // effect level / mix 0..100 (array slot 2); absent = 100
  params?: Record<string, number>; // raw per-parameter values keyed by descriptor key
}

// Per-node device parameters that are not tied to a single wire (a channel's own
// processing/state). Each field is optional; absence means the device default
// (channel on, HPF off). Stored keyed by node id, alongside positions / notes.
export interface NodeParams {
  /** ON / mute for a node with its own master switch: a channel (CH_ON), the STEREO
   *  master (STEREO_MASTER_ON), an FX channel (FX_CHANNEL_ON) or a MONITOR bus
   *  (MONITOR_ON) — all device-written. Absent or true = on; false = muted. */
  on?: boolean;
  /** HPF_ON: high-pass filter engaged. Absent or false = off. */
  hpf?: boolean;
  /** HPF_FREQ: high-pass cutoff in Hz (40 … 120). Absent = device default (80). */
  hpfFreq?: number;
  /** INSERT_FX: insert-effect enum value (MONO IN channels / output buses). Absent or -1 = No Effect. */
  insertFx?: number;
  /** Insert-FX effect parameters: RAW broker values keyed by the engine array SLOT
   *  (see control/insert-fx-effect.ts), mirroring the device so a captured plan
   *  round-trips. The selected `insertFx` value picks the slot layout. Absent slots
   *  fall back to the family's factory defaults. */
  insertFxParams?: Record<string, number>;
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
  /** EQ ON for an input channel or an output bus (STEREO / MIX). Absent or true = on. */
  eqOn?: boolean;
  /** EQ 1-knob mode (input channels + output buses). When on, the device drives
   *  the 4-band PEQ, so eqBands are not authored. */
  eqOneKnob?: EqOneKnobParams;
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
  /** Output bus master balance (STEREO 583 / MIX 676): the bus output's L/R
   *  balance, signed ±63 (L63 … C=0 … R63). Absent = center (0). */
  pan?: number;
  /** Oscillator generator settings (the bus.osc node). */
  osc?: OscParams;
  /** Monitor CUE interrupt (monitor buses). Absent or true = on (device default). */
  cueInterrupt?: boolean;
  /** Monitor MONO downmix (monitor buses). Absent or false = off. */
  mono?: boolean;
  /** PHONES output level (monitor buses): the device's unit-less 0.0..10.0 Phones
   *  scale, independent of the monitor fader. PHONES 1 ↔ mon1, PHONES 2 ↔ mon2. */
  phonesLevel?: number;
  /** STREAMING DELAY settings (the bus.stream node). */
  delay?: DelayParams;
  /** FX-channel effect (reverb / delay) type + parameters (the bus.fx1 / bus.fx2
   *  nodes). Absent = device default (FX1 Rev-X Hall, FX2 Mono Delay). */
  fxEffect?: FxEffectParams;
  /** microSD Rec Track Count (the SD Rec header node, out.sdrec): how many record
   *  tracks are active, an even 2..16. Read-only on the device (the front panel
   *  sets it; a software write is ignored), so live sync reads it back but never
   *  pushes it. Gates how many track-pair slots the UI shows. Absent = 8. */
  sdRecTrackCount?: number;
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
  /** Node ids the user collapsed off the canvas (shelved by hand or via "hide unused"). */
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
    sampleRate: SAMPLE_RATES.includes(data.sampleRate as number) ? (data.sampleRate as number) : DEFAULT_SAMPLE_RATE,
    positions: isStringRecord(data.positions) ? (data.positions as unknown as Record<string, NodePos>) : {},
    connections: Array.isArray(data.connections) ? data.connections.filter(isPlanConnection) : [],
    nodeParams: isStringRecord(data.nodeParams) ? (data.nodeParams as unknown as Record<string, NodeParams>) : {},
    nodeNames: isStringRecord(data.nodeNames) ? (data.nodeNames as Record<string, string>) : {},
    nodeColors: isStringRecord(data.nodeColors) ? (data.nodeColors as Record<string, string>) : {},
    hidden: Array.isArray(data.hidden) ? (data.hidden as string[]) : [],
    notes: isStringRecord(data.notes) ? data.notes : {},
    noteCollapsed: Array.isArray(data.noteCollapsed) ? (data.noteCollapsed as string[]) : [],
  };
}

// Encode a plan as a URL-safe base64 of its UTF-8 JSON, for the `?plan=` deep
// link: a generated plan becomes a shareable URL the viewer opens. Inverse of
// decodePlanParam.
export function encodePlanParam(plan: Plan): string {
  const bytes = new TextEncoder().encode(serialize(plan));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Decode a `?plan=` parameter (URL-safe base64 of UTF-8 JSON) back to plan JSON
// text. Throws on malformed base64 / UTF-8; the caller treats that as a load
// failure, and deserialize then validates the JSON shape.
export function decodePlanParam(encoded: string): string {
  const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const CONNECTION_KINDS: ReadonlySet<string> = new Set<ConnectionKind>([
  "source",
  "patch",
  "send",
  "sendSwitch",
  "key",
  "record",
]);

// A loaded connections element is trusted only when it carries string from/to, a
// known ConnectionKind, and (if present) a well-typed params: null / partial /
// mistyped elements are dropped on read so an undefined kind can never slip past
// routing's single-input guard, and a non-numeric level/pan can never reach the
// console's number formatting (where it would throw on .toFixed).
function isValidConnParams(p: unknown): boolean {
  if (p === undefined) return true;
  if (!isStringRecord(p)) return false;
  const q = p as Record<string, unknown>;
  if ("level" in q && !Number.isFinite(q.level)) return false;
  if ("pan" in q && !Number.isFinite(q.pan)) return false;
  if ("tap" in q && q.tap !== "pre" && q.tap !== "post") return false;
  for (const key of ["on", "oscL", "oscR"]) {
    if (key in q && typeof q[key] !== "boolean") return false;
  }
  return true;
}

function isPlanConnection(v: unknown): v is PlanConnection {
  if (!isStringRecord(v)) return false;
  return (
    typeof v.from === "string" &&
    typeof v.to === "string" &&
    CONNECTION_KINDS.has(v.kind as string) &&
    isValidConnParams((v as Record<string, unknown>).params)
  );
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
    if (rule.kind === "sendSwitch") {
      // MIX 1/2 → STEREO "TO ST": a fixed ON/OFF switch with no level/pan, off at the
      // factory (carried in params.on so the fixed wire can still be turned off).
      conn.params = { on: false };
    } else {
      // The channel's main fader path into STEREO seeds at unity; every other fixed
      // send (CH → MIX/FX sends, FX returns into STEREO/MIX) seeds at -∞ so it is not
      // summed in until raised. Each ships ON (params.on absent = on, SEND_ON = 1).
      const fromKind = model.nodes.find((n) => n.id === parseRef(rule.from).nodeId)?.kind;
      const toStereo = parseRef(rule.to).nodeId === "bus.stereo";
      if (!(fromKind === "channel" && toStereo)) conn.params = { level: LEVEL_OFF_DB };
    }
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

/** The wire from node `from`'s out port to node `to`'s in port, if any — the
 *  send / main-path lookup shared by the console and the MIDI control catalog. */
export function sendConnection(plan: Plan, from: string, to: string): PlanConnection | undefined {
  return plan.connections.find((c) => c.from === ref(from, "out") && c.to === ref(to, "in"));
}

export function clearIncoming(plan: Plan, to: string, kind: ConnectionKind): void {
  plan.connections = plan.connections.filter((c) => !(c.to === to && c.kind === kind));
}

export function setExclusiveConnection(plan: Plan, from: string, to: string, kind: ConnectionKind): void {
  clearIncoming(plan, to, kind);
  plan.connections.push({ from, to, kind });
}
