// Editable routing plan: the user's choices on top of an immutable DeviceModel.
// Serializes to a versioned JSON document that future hardware reflection will
// reuse as the input.

import type { ConnectionKind, DeviceModel, ModelId } from "../models/types";
import { parseRef, ref } from "../models/types";
import { DEFAULT_SAMPLE_RATE, SAMPLE_RATES } from "./constraints";
import { FX_CHANNEL_NODE_INDEX, migrateFxEffectParams } from "./control/fx-effect";
import { insertFxFamilyOf, qualifyInsertFxParams } from "./control/insert-fx-effect";
import { NODE_NAME_MAX_CHARS } from "./control/params";
import { stripSceneExternal } from "./scene-scope";

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
// preset enum (0 Intensity / 1 Vocal / 2 Loudness); every EQ instance offers all
// three (measured — the per-screen subset this once recorded was wrong).
// `level` is the effect depth 0..100 %. When
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
  /** INSERT_FX_ON: insert-effect ON/OFF (bypass), independent of the selector. The
   *  device auto-engages it whenever an effect is (re)selected. Absent = leave the
   *  device state alone; only written while an effect is selected. */
  insertFxOn?: boolean;
  /** Insert-FX effect parameters: RAW broker values keyed by effect FAMILY + engine
   *  array slot (`insertFxParamKey`, see control/insert-fx-effect.ts), mirroring the
   *  device so a captured plan round-trips. The selected `insertFx` value picks which
   *  family's entries are read; absent slots fall back to the family's factory
   *  defaults. A bare slot number is the device-shaped namespace a readback writes and
   *  reads as the currently selected family's. */
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
// 2: every place one stored value could be read under a law it was not written under
// now carries a qualified key. Three re-keyings, all under this one number — the
// FX-channel parameters several effect families shared under one bare name (hpf /
// lpf / hiRatio …), the Ping Pong delay time (its own key beside Mono Delay's, one
// slot under two laws), and the insert-FX engine slots (keyed by family, so a
// selector change cannot hand them to the next effect). A document this build writes
// carries only the qualified names, which an older build reads as absent — so it is
// tagged 2 and refused there rather than silently loading factory defaults for those
// parameters and writing them at the unit.
//
// The last two landed before any version-2 writer shipped, which is why they are not
// a version of their own: nothing ever wrote a document that needed telling apart.
export const PLAN_VERSION = 2;

// Language-agnostic load failures. The UI maps the code to a localized message.
export type PlanErrorCode = "notPlanFile" | "missingModel" | "planUrlUnsupported" | "planVersionUnsupported";

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

export interface SerializeOptions {
  /** Scene-scoped save: strip the URX's device-wide (scene-external) state, omit
   *  the sample rate, and mark the document, so a load keeps the current values
   *  of everything outside the scene (see scene-scope.ts). An unmarked document
   *  loads unchanged, and an older build reading a marked one simply falls back
   *  to defaults for the absent fields. */
  sceneOnly?: boolean;
}

export function serialize(plan: Plan, opts?: SerializeOptions): string {
  const scene = opts?.sceneOnly === true;
  const p = scene ? stripSceneExternal(plan) : plan;
  return JSON.stringify(
    {
      format: PLAN_FORMAT,
      version: PLAN_VERSION,
      ...(scene ? { scope: "scene" } : {}),
      modelId: p.modelId,
      ...(scene ? {} : { sampleRate: p.sampleRate }),
      positions: p.positions,
      connections: p.connections,
      nodeParams: p.nodeParams,
      nodeNames: p.nodeNames,
      nodeColors: p.nodeColors,
      hidden: p.hidden,
      notes: p.notes,
      noteCollapsed: p.noteCollapsed,
    },
    null,
    2,
  );
}

export interface PlanDocument {
  plan: Plan;
  /** True when the document was saved scene-scoped (serialize `sceneOnly`): the
   *  loader should keep the current plan's scene-external values instead of the
   *  defaults deserialize filled in for the absent fields. */
  sceneScoped: boolean;
}

export function deserialize(text: string): Plan {
  return deserializeDocument(text).plan;
}

export function deserializeDocument(text: string): PlanDocument {
  const data = JSON.parse(text) as Record<string, unknown>;
  if (data.format !== PLAN_FORMAT) {
    throw new PlanError("notPlanFile");
  }
  // Version gate. A document tagged NEWER than this build is refused rather than
  // half-read: its fields may carry semantics this build would misinterpret, and
  // a plan drives writes to real hardware. An absent / non-numeric version is
  // treated as current, so a hand-authored plan that omits it still loads. An older
  // version is migrated forward here — today that is the version-1 FX parameter
  // re-keying, run from sanitizeNodeParams.
  const version = Number.isFinite(data.version) ? (data.version as number) : PLAN_VERSION;
  if (version > PLAN_VERSION) {
    throw new PlanError("planVersionUnsupported");
  }
  if (typeof data.modelId !== "string") {
    throw new PlanError("missingModel");
  }
  const plan: Plan = {
    modelId: data.modelId as ModelId,
    sampleRate: SAMPLE_RATES.includes(data.sampleRate as number) ? (data.sampleRate as number) : DEFAULT_SAMPLE_RATE,
    positions: posRecord(data.positions),
    connections: Array.isArray(data.connections) ? data.connections.filter(isPlanConnection).map(rebuildConn) : [],
    nodeParams: sanitizeNodeParams(data.nodeParams, version),
    nodeNames: nameRecord(data.nodeNames),
    nodeColors: stringRecord(data.nodeColors),
    hidden: stringArray(data.hidden),
    notes: stringRecord(data.notes),
    noteCollapsed: stringArray(data.noteCollapsed),
  };
  return { plan, sceneScoped: data.scope === "scene" };
}

// Encode a plan for the `?plan=` deep link: "z" + URL-safe base64 of the
// raw-deflated UTF-8 JSON, so a generated plan becomes a shareable URL the
// viewer opens. Compression is what keeps real plans inside GitHub Pages'
// ~8 KB URL limit (a factory-seeded plan already encodes to ~36k chars
// uncompressed, ~2.6k compressed). Inverse of decodePlanParam.
export async function encodePlanParam(plan: Plan, opts?: SerializeOptions): Promise<string> {
  const json = new TextEncoder().encode(serialize(plan, opts));
  return "z" + toBase64Url(await pipeBytes(json, deflateRawStream()));
}

// Decode a `?plan=` parameter back to plan JSON text. "z…" is the compressed
// format above; anything else is the legacy uncompressed URL-safe base64 (its
// JSON always starts "{", so a legacy param always starts "e" — never "z").
// Rejects on malformed base64 / deflate; invalid UTF-8 decodes lossily (U+FFFD)
// and is caught by the JSON parse downstream, as it was pre-compression. The
// caller treats a rejection as a load failure, and deserialize then validates
// the JSON shape.
export async function decodePlanParam(encoded: string): Promise<string> {
  const bytes = encoded.startsWith("z")
    ? await pipeBytes(fromBase64Url(encoded.slice(1)), inflateRawStream())
    : fromBase64Url(encoded);
  return new TextDecoder().decode(bytes);
}

// Old webviews lack Compression/DecompressionStream (or their "deflate-raw"
// format). Surface that as the typed browser-floor error, so callers can tell
// "this browser can't run the codec" apart from a broken link — the legacy
// uncompressed path stays available regardless.
function deflateRawStream(): CompressionStream {
  try {
    return new CompressionStream("deflate-raw");
  } catch {
    throw new PlanError("planUrlUnsupported");
  }
}

function inflateRawStream(): DecompressionStream {
  try {
    return new DecompressionStream("deflate-raw");
  } catch {
    throw new PlanError("planUrlUnsupported");
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(encoded: string): Uint8Array<ArrayBuffer> {
  const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

/** Run bytes through a platform (de)compression stream and collect the output.
 *  A codec failure errors the piped readable, so the read rejects — no writer
 *  promise is left dangling. Also the byte pump for storage's PDF deflate. */
export async function pipeBytes(
  bytes: Uint8Array<ArrayBuffer>,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** Exported so `plan-validate.ts` asks the same question the sanitiser asked: what
 *  survives a load as an object is what this says is one, arrays and null included. */
export function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The one key that is not a data key. `JSON.parse` gives a document an own
 * `"__proto__"` property, but assigning it onto a fresh `{}` goes through the
 * INHERITED accessor and replaces that object's prototype instead of storing an
 * entry — and every collection deserialize rebuilds is built by assignment.
 *
 * What that buys a crafted plan is a set of parameters the app can see and the rest
 * of the stack cannot. `{"nodeParams":{"ch1":{"__proto__":{"on":false}}}}` makes
 * `plan.nodeParams.ch1.on` read `false` by inheritance: the graph and console draw
 * CH1 muted and a live sync writes CH_ON 0 to the unit, while `Object.keys(ch1)` is
 * empty — so `serialize` writes `"ch1": {}`, `diffPlans` and the write witness (both
 * own-key walks) see no change, and undo has nothing to revert. Saving and reopening
 * then produces an unmuted plan that no longer matches what the last sync wrote.
 *
 * Skipped rather than sanitized: no plan has ever had a legitimate `__proto__` node,
 * parameter or wire, so dropping the entry is the same "absence is the default state"
 * rule the other guards here take.
 */
const PROTO_KEY = "__proto__";

// The element-level guards for the collections whose values deserialize used to take
// on trust once the container was an object. The container check alone let a note
// written as `{}` through, and the graph reaches every note on every render
// (`(plan.notes?.[id] ?? "").trim()`), so the document loaded and the canvas then threw
// on the first paint. Same rule as connections and nodeParams: drop the element, keep
// the document — absence is already the "nothing set here" state for all four.
function stringRecord(v: unknown): Record<string, string> {
  if (!isPlainRecord(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === "string" && k !== PROTO_KEY) out[k] = val;
  return out;
}

/** Cut a node name to what the unit's own CH SETTING screen can produce
 *  (`NODE_NAME_MAX_CHARS` carries the limit and how it was established). Counted in
 *  code points via the string iterator, so a surrogate pair is one character and the
 *  result is never half of one. Names are the one plan string that leaves the app on
 *  the device link, and they left it uncut — the numeric leaves have `boundRaw`
 *  between them and the wire, and nothing played that part for strings. Notes and
 *  colors are the app's own and stay unbounded. */
export function clipNodeName(name: string): string {
  const chars = [...name];
  return chars.length <= NODE_NAME_MAX_CHARS ? name : chars.slice(0, NODE_NAME_MAX_CHARS).join("");
}

/** A node name as it is held in the plan and sent to the unit: cut to the field width,
 *  then stripped of trailing padding. That order, not the reverse — trimming first can
 *  hand the cut a string whose eighth character is a space, and the result ends in one
 *  again (`1234567` + two spaces + `9` has nothing to trim, and cuts onto the first).
 *
 *  Trailing padding is dropped because the device link already reads names that way
 *  (`readback.ts` says why it is trimEnd and not trim: the factory stereo labels really
 *  are ` 5/ 6`, so a LEADING space is part of the name). A plan that keeps one the read
 *  drops never converges: `diffNames` compares the trimmed device value against the
 *  emitted one, so they differ on every sync and the name is rewritten forever. The
 *  device does not end that loop — measured on a URX44V (2026-08-14), it stores and
 *  returns a trailing space unchanged.
 *
 *  Not what the name field clips with. That runs on every keystroke, and trimming there
 *  would eat the space in `A B` as it is typed. */
export function normalizeNodeName(name: string): string {
  return clipNodeName(name).trimEnd();
}

function nameRecord(v: unknown): Record<string, string> {
  const out = stringRecord(v);
  for (const [k, name] of Object.entries(out)) out[k] = normalizeNodeName(name);
  return out;
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((el): el is string => typeof el === "string") : [];
}

// A position is the one string-keyed collection whose values are not strings. Both
// coordinates must be finite: contentBounds falls back when the whole set produces no
// finite extent, but a single non-finite entry among good ones poisons the min/max it
// is folded into and frames the view on nothing.
function posRecord(v: unknown): Record<string, NodePos> {
  if (!isPlainRecord(v)) return {};
  const out: Record<string, NodePos> = {};
  for (const [k, p] of Object.entries(v)) {
    if (!isPlainRecord(p) || k === PROTO_KEY) continue;
    if (finiteNum(p.x) && finiteNum(p.y)) out[k] = { x: p.x, y: p.y };
  }
  return out;
}

/** `Number.isFinite` as a type guard — it narrows `unknown` to `number`, which the
 *  built-in does not, so the caller keeps the value without a cast. */
function finiteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
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
  if (!isPlainRecord(p)) return false;
  const q = p as Record<string, unknown>;
  if ("level" in q && !Number.isFinite(q.level)) return false;
  if ("pan" in q && !Number.isFinite(q.pan)) return false;
  if ("tap" in q && q.tap !== "pre" && q.tap !== "post") return false;
  for (const key of ["on", "oscL", "oscR"]) {
    if (key in q && typeof q[key] !== "boolean") return false;
  }
  return true;
}

// Deep-sanitize the per-node parameter collection, the counterpart of
// isValidConnParams for the node side. Every NodeParams leaf is a boolean or a
// number (nested groups — gate / comp / ssmcs / osc / eqBands … — bottom out in
// those two), so a leaf that is anything else (string, null, NaN, Infinity) is
// dropped rather than kept: absence is already the documented "use the device
// default" state, whereas a surviving string would reach a formatter that calls
// .toFixed on it. Unknown keys with well-formed values are preserved, so a
// document from a future minor version keeps its extras.
function sanitizeParamValue(v: unknown): unknown {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (Array.isArray(v)) {
    // Arrays hold records (eqBands); a malformed element would shift the band
    // indices, so one bad element drops the whole array.
    const items = v.map((el) => (isPlainRecord(el) ? sanitizeParamRecord(el) : undefined));
    return items.every((el) => el !== undefined) ? items : undefined;
  }
  if (isPlainRecord(v)) {
    // A nested group that sanitizes to empty carries nothing — including the case
    // where a scalar field was mistyped as an object ("gain": {}). Drop it so the
    // node falls back to the device default rather than holding an inert husk.
    const rec = sanitizeParamRecord(v);
    return Object.keys(rec).length > 0 ? rec : undefined;
  }
  return undefined;
}

function sanitizeParamRecord(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k === PROTO_KEY) continue;
    const clean = sanitizeParamValue(v);
    if (clean !== undefined) out[k] = clean;
  }
  return out;
}

function sanitizeNodeParams(v: unknown, version: number): Record<string, NodeParams> {
  if (!isPlainRecord(v)) return {};
  const out: Record<string, NodeParams> = {};
  for (const [nodeId, np] of Object.entries(v)) {
    // A non-record entry carries nothing recoverable — drop the node outright.
    if (!isPlainRecord(np) || nodeId === PROTO_KEY) continue;
    const clean = sanitizeParamRecord(np) as NodeParams;
    // Every load path (file open, recent files, ?plan= deep link, drop) reaches
    // deserialize, so this is where a plan written with keys an effect no longer
    // addresses is re-keyed onto the effect that saved them. Which steps run is
    // decided per document version inside migrateFxEffectParams.
    const fxIndex = FX_CHANNEL_NODE_INDEX[nodeId];
    if (clean.fxEffect && fxIndex !== undefined) migrateFxEffectParams(clean.fxEffect, fxIndex, version);
    // The insert-FX engine slots are re-keyed at EVERY version: a bare slot number
    // is the device-shaped namespace a readback writes, so it belongs to the family
    // the document's own selector names, whenever it was written. With no effect
    // selected they belong to nothing and are dropped — a document saved with the
    // selector on No Effect keeps a full map of whatever was chosen before it, and
    // the next selection (the CONSOLE's INS FX chip restores one) would read it.
    if (clean.insertFxParams) {
      const fam = clean.insertFx === undefined ? null : insertFxFamilyOf(clean.insertFx);
      const params = qualifyInsertFxParams(clean.insertFxParams, fam);
      if (Object.keys(params).length > 0) clean.insertFxParams = params;
      else delete clean.insertFxParams;
    }
    out[nodeId] = clean;
  }
  return out;
}

/**
 * A kept wire, rebuilt from its four known fields rather than passed through.
 *
 * The node side has always done this — `sanitizeParamRecord` builds a fresh record and
 * drops a leaf it does not recognise as a boolean or a number — while the wire side
 * filtered and kept the parsed object, so an unknown key of any type rode every clone,
 * diff and save forever. Nothing crashed on it (emit reads named keys, and the
 * `Number.isFinite` firewalls hold), which is why it survived: it is an asymmetry
 * between the two collection guards rather than a wrong value.
 *
 * `params` goes through the same rebuild, so the extras cannot hide one level down.
 */
function rebuildConn(c: PlanConnection): PlanConnection {
  const out: PlanConnection = { from: c.from, to: c.to, kind: c.kind };
  if (c.params) {
    const p: ConnParams = {};
    if (c.params.level !== undefined) p.level = c.params.level;
    if (c.params.pan !== undefined) p.pan = c.params.pan;
    if (c.params.tap !== undefined) p.tap = c.params.tap;
    if (c.params.on !== undefined) p.on = c.params.on;
    if (c.params.oscL !== undefined) p.oscL = c.params.oscL;
    if (c.params.oscR !== undefined) p.oscR = c.params.oscR;
    out.params = p;
  }
  return out;
}

function isPlanConnection(v: unknown): v is PlanConnection {
  if (!isPlainRecord(v)) return false;
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

/**
 * A wire's `kind` restated from the rule table, for every wire that has a rule.
 *
 * The kind is a function of (from, to) — the invariant plan-history states and nothing
 * enforced. A document can carry a real pair under the wrong kind, and the load funnel
 * passes it: a rule exists, the receiver is not over-subscribed, the pair is not
 * duplicated. What follows is silent and severe, because every consumer trusts a
 * different one of the two encodings. `isSceneExternalConnection` reads the STORED kind,
 * so an output patch written as `"send"` is no longer scene-external and a scene-scoped
 * save takes device-wide state with it; the emit looks the wire up by RULE kind
 * (`incomingConnection(..., "patch")`), finds nothing, and writes the selector out as
 * NONE — live sync tells the unit there is no patch while the graph draws one.
 *
 * Rewritten rather than refused: the field is redundant, so a disagreement is noise
 * with no operator intent behind it, and refusing a document over a value the app can
 * derive would lose a plan that is otherwise entirely legal. A wire with NO rule is
 * left exactly as it is — that one is `validatePlan`'s to refuse, and quietly restating
 * a kind there would hide it.
 */
function normalizeConnectionKinds(model: DeviceModel, plan: Plan): void {
  for (const c of plan.connections) {
    const kind = model.rules.find((r) => r.from === c.from && r.to === c.to)?.kind;
    if (kind !== undefined && c.kind !== kind) c.kind = kind;
  }
}

// Materialize the model's fixed (non-removable) wires into the plan when missing,
// so they show pre-connected and survive plans saved before they existed. Idempotent
// and leaves any existing entry (with its level/pan) untouched.
//
// It also restates every wire's kind from the rule table (above). That rides here
// rather than in a funnel of its own because this is the one call every path that
// installs a plan already makes — the boot, the loader, and a device readback — so the
// two cannot drift apart by someone adding a fourth path and forgetting one of them.
export function ensureFixedConnections(model: DeviceModel, plan: Plan): void {
  normalizeConnectionKinds(model, plan);
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
