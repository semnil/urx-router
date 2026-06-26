// Static device definition. A DeviceModel is immutable per hardware model and
// describes the fixed signal topology plus every legal routing decision point.
// The user's editable state lives separately in core/plan.ts.

export type ModelId = "URX22" | "URX44" | "URX44V";

// "ducker" is a sidechain key-source selector that lives ON a stereo channel,
// not a free output: it is drawn hanging under its parent channel (attachTo) and
// carries its own rail color rather than the generic output color.
export type NodeKind = "input" | "channel" | "bus" | "output" | "ducker";

export type PortDirection = "in" | "out";

export interface Port {
  id: string;
  label: string;
  direction: PortDirection;
}

export interface DeviceNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** Optional dim second-line legend on the node (e.g. a ducker's channel). */
  sublabel?: string;
  /** Layout column key (inputs | channels | buses | outputs). May differ from
   *  `kind`: the OSCILLATOR (kind "input") and MONITORs (kind "output") sit in
   *  the bus column but are kinded by their signal role for rail color. */
  column: NodeKind;
  ports: Port[];
  /** Default grid position; the plan may override and persist it. */
  pos: { col: number; row: number };
  /**
   * Parent node id this node hangs under (duckers → their stereo channel). When
   * set, the UI derives this node's position from the parent (always just below
   * it), drags the two as one unit, and hides/shows them together.
   */
  attachTo?: string;
  /**
   * A header that groups child slots (attachTo) and has no direct routing of its
   * own — the microSD Rec node owns the record-track slots this way. Its port is
   * not drawn and the inspector hides its (always empty) routing list, since the
   * real I/O lives on the child slots.
   */
  header?: boolean;
}

/** Full single-line name for lists/inspector: the node's two label tiers joined. */
export function fullLabel(node: DeviceNode): string {
  return node.sublabel ? `${node.label} ${node.sublabel}` : node.label;
}

// source / patch / key / record: single-input receiver (a selector). send: summing
// receiver (a bus) that accepts many incoming wires, each with LEVEL / PAN /
// PRE-POST. sendSwitch: an ON/OFF assign into a summing bus, with no LEVEL / PAN
// — e.g. the MIX 1/2 "TO ST" send, or the OSCILLATOR assign (which carries only
// per-channel L/R on/off in oscL / oscR). key is the ducker sidechain-trigger
// select: a selector like source but without the mono-pair source mirroring, so
// it stays its own kind. record is the microSD recorder's per-track-pair source
// select: a single source (a channel pair, STEREO or a MIX bus) feeds one stereo
// record-track slot — its own kind so the SD-Rec value encoding stays separate.
export type ConnectionKind = "source" | "patch" | "send" | "sendSwitch" | "key" | "record";

export interface RoutingRule {
  /** "nodeId:portId" of an output port. */
  from: string;
  /** "nodeId:portId" of an input port. */
  to: string;
  kind: ConnectionKind;
  /**
   * Structural wire that always exists and cannot be rerouted: the CH and FX-channel
   * main fader paths into the STEREO bus (block diagram: these sit outside the dashed
   * SEND blocks). Seeded into every plan so it shows pre-connected, and the UI blocks
   * its removal. Level/pan stay editable; only the routing is locked.
   */
  fixed?: boolean;
}

export interface DeviceModel {
  id: ModelId;
  name: string;
  nodes: DeviceNode[];
  rules: RoutingRule[];
  /** Mono-channel pairs (CH1/2, CH3/4) that share one input source selection. */
  channelPairs: [string, string][];
}

export function ref(nodeId: string, portId: string): string {
  return `${nodeId}:${portId}`;
}

export function parseRef(r: string): { nodeId: string; portId: string } {
  const i = r.indexOf(":");
  return { nodeId: r.slice(0, i), portId: r.slice(i + 1) };
}

/** Receivers of these kinds accept at most one incoming wire. */
export function isSingleInput(kind: ConnectionKind): boolean {
  return kind === "source" || kind === "patch" || kind === "key" || kind === "record";
}

/**
 * Whether `id` hangs (transitively via attachTo) under a header node — i.e. it is
 * a structural child slot (a microSD Rec track slot). Such a node is gated only by
 * its header's controls (Track Count), never individually shelved: it has no shelf
 * chip, so shelving it would leave it unrecoverable. A ducker (hung under a regular
 * channel, not a header) is not structural and stays freely shelvable.
 */
export function hangsUnderHeader(model: DeviceModel, id: string): boolean {
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  for (let cur = byId.get(id)?.attachTo; cur; cur = byId.get(cur)?.attachTo) {
    if (byId.get(cur)?.header) return true;
  }
  return false;
}
