// Connection constraint engine. A wire is legal only when the DeviceModel
// declares a matching rule, and single-input receivers (selectors / patches)
// reject a second wire.

import { isSingleInput, parseRef, ref } from "../models/types";
import type { DeviceModel, NodeKind, RoutingRule } from "../models/types";
import type { Plan, PlanConnection } from "./plan";
import { hasConnection } from "./plan";
import { BUS_TYPE_FIXED, BUS_TYPE_VARI, PAN_BAL_BAL, PAN_BAL_PAN } from "./control/params";

// Language-agnostic failure codes. The UI maps these to localized messages so
// core stays free of any i18n dependency.
export type ConnectError = "noRule" | "duplicate" | "singleInput";

export interface ConnectResult {
  ok: boolean;
  reason?: ConnectError;
}

function findRule(model: DeviceModel, from: string, to: string): RoutingRule | undefined {
  return model.rules.find((rule) => rule.from === from && rule.to === to);
}

export function ruleKind(model: DeviceModel, from: string, to: string): RoutingRule["kind"] | undefined {
  return findRule(model, from, to)?.kind;
}

/** Whether this route is a structural wire that the user may not remove. */
export function isFixedConnection(model: DeviceModel, from: string, to: string): boolean {
  return findRule(model, from, to)?.fixed === true;
}

// Whether a send carries a PRE/POST tap: a send's PRE/POST is taken relative to
// the STEREO main-fader level, so only the STEREO main-fader paths (CH / FX
// channel → STEREO, which ARE that reference) carry no tap. Every other send
// (-> MIX / FX) does. This is independent of `fixed`: the FX channel → MIX sends
// are fixed (non-removable routing) yet still expose a PRE/POST tap.
export function sendHasTap(model: DeviceModel, from: string, to: string): boolean {
  return ruleKind(model, from, to) === "send" && parseRef(to).nodeId !== "bus.stereo";
}

// Whether a route carries a per-send ON switch (the SEND_ON of a CH/FX -> MIX/FX
// send, the MIX -> STEREO "TO ST", or the CH/FX -> STEREO assign ON). Every tapped
// send has one; so do the fixed routes into STEREO — the MIX -> STEREO sendSwitch
// and, since firmware V1.3, the CH/FX -> STEREO main paths (a post-fader STEREO
// assign ON, distinct from the channel master). Lets the UI ask the topology rather
// than re-deriving it from tap + kind proxies.
export function sendHasOn(model: DeviceModel, from: string, to: string): boolean {
  if (sendHasTap(model, from, to)) return true;
  return isFixedConnection(model, from, to) && parseRef(to).nodeId === "bus.stereo";
}

// The two MIX-bus "hidden mode" locks that gate a send's controls, resolved from
// the destination bus's node params: FIXED BUS Type makes the send level a fixed
// value (the LEVEL control is inert) and Pan Link (VARI only) ties each send pan to
// the source channel PAN (the PAN control is inert). Only MIX 1 / MIX 2 carry these;
// any other destination returns both false. Shared by the inspector (which drops the
// gated controls) and the console (which renders them read-only).
export function mixSendLocks(plan: Plan, destId: string): { busFixed: boolean; panLinked: boolean } {
  const np = plan.nodeParams[destId];
  const isMix = destId === "bus.mix1" || destId === "bus.mix2";
  const busFixed = isMix && (np?.busType ?? BUS_TYPE_VARI) === BUS_TYPE_FIXED;
  const panLinked = isMix && !busFixed && np?.panLink === true;
  return { busFixed, panLinked };
}

// Whether a send's PRE/POST tap can be written to the device from software — the
// single source of truth for that capability (translate suppresses the write,
// inspector turns the tap read-only while live; see callers). CH -> FX taps are
// not writable: the broker reports max_value=0 for them (193/197/320/324, every
// instance), so a software write of PRE (1) is rejected with response_code 400 —
// only the device's own LCD can set them. Reading them is fine (0/1 both come
// back), so readback still reflects the true device tap. CH -> MIX and
// FX-channel -> MIX taps (max_value=1) are writable. This concerns the *device*
// only: the plan's tap field stays freely editable in the planner regardless.
// Confirmed by a live broker probe (2026-06-22).
export function sendTapWritable(model: DeviceModel, from: string, to: string): boolean {
  return sendHasTap(model, from, to) && !parseRef(to).nodeId.startsWith("bus.fx");
}

// Classify a channel's "direct out" tap by destination, or null when `from → to`
// is not one. On the device this is the channel's CH OUT, taken at its Rec Point —
// which the block diagram places BEFORE the fader and the Ducker. So the fader, pan
// and Ducker never reach this route; only a bus source (STEREO / MIX) carries the
// post-Ducker signal to the same outputs. The routing kind already carries the
// destination split — a channel → USB MAIN / SUB is `patch`, a channel → microSD
// Rec is `record` — so callers read the concept here rather than re-deriving it
// from node-id spelling. (A bus → USB is `patch` too, hence the source-kind test;
// the DAW Rec 1:1 taps share this trait but are fixed, so they are not editable.)
export function directOutTarget(model: DeviceModel, from: string, to: string): "usb" | "sdRec" | null {
  const kind = ruleKind(model, from, to);
  if (kind !== "patch" && kind !== "record") return null;
  if (model.nodes.find((n) => n.id === parseRef(from).nodeId)?.kind !== "channel") return null;
  return kind === "patch" ? "usb" : "sdRec";
}

// A ducker's key (sidechain trigger) select, classified by source. A channel key is
// its CH OUT — the same Rec Point tap as a direct out (directOutTarget), upstream of
// that channel's fader and Ducker, so the source channel's fader / mute never change
// the trigger. A bus key (STEREO / MIX) is post-fader instead. Returns the source
// kind, or null when `from → to` is not a ducker key.
export function duckerKeySource(model: DeviceModel, from: string, to: string): "channel" | "bus" | null {
  if (ruleKind(model, from, to) !== "key") return null;
  return model.nodes.find((n) => n.id === parseRef(from).nodeId)?.kind === "channel" ? "channel" : "bus";
}

export function canConnect(model: DeviceModel, plan: Plan, from: string, to: string): ConnectResult {
  const rule = findRule(model, from, to);
  if (!rule) return { ok: false, reason: "noRule" };
  if (hasConnection(plan, from, to)) return { ok: false, reason: "duplicate" };
  // A single-input receiver rejects a second incoming wire, counting any existing
  // wire into the port regardless of its stored kind (a malformed/garbled plan
  // could carry a wrong-kind wire into the slot). Summing receivers have a
  // non-single-input rule.kind, so their fan-in stays unrestricted.
  if (isSingleInput(rule.kind) && plan.connections.some((c) => c.to === to)) {
    return { ok: false, reason: "singleInput" };
  }
  return { ok: true };
}

// One illegal wire found by validatePlan: its endpoints and why it is rejected.
export interface PlanProblem {
  from: string;
  to: string;
  reason: ConnectError;
}

// Validate a complete plan's connections against the model's routing rules,
// returning every illegal wire. Unlike canConnect (which vets one new wire
// against the live plan), this checks an already-built plan: a wire is a problem
// when no rule matches (noRule), a single-input receiver carries more than one
// incoming wire (singleInput — reported for each wire into that port so every
// offender is listed), or the same from->to pair appears twice (duplicate).
// deserialize already drops structurally malformed elements, so only
// routing-legality issues remain to report here.
export function validatePlan(model: DeviceModel, plan: Plan): PlanProblem[] {
  const incoming = new Map<string, number>();
  for (const c of plan.connections) incoming.set(c.to, (incoming.get(c.to) ?? 0) + 1);
  const problems: PlanProblem[] = [];
  const seen = new Set<string>();
  for (const c of plan.connections) {
    const kind = ruleKind(model, c.from, c.to);
    if (kind === undefined) {
      problems.push({ from: c.from, to: c.to, reason: "noRule" });
    } else if (isSingleInput(kind) && (incoming.get(c.to) ?? 0) > 1) {
      problems.push({ from: c.from, to: c.to, reason: "singleInput" });
    }
    const key = `${c.from} ${c.to}`;
    if (seen.has(key)) problems.push({ from: c.from, to: c.to, reason: "duplicate" });
    seen.add(key);
  }
  return problems;
}

/** The mono channel that shares its input source with `nodeId`, if any. */
export function partnerChannel(model: DeviceModel, nodeId: string): string | undefined {
  for (const [a, b] of model.channelPairs) {
    if (a === nodeId) return b;
    if (b === nodeId) return a;
  }
  return undefined;
}

/** The primary (odd, first-listed) channel of the pair containing `nodeId`, or
 *  null when it is not part of a pair. Pair-level state (Signal Type, PAN/BAL)
 *  lives on the primary. */
export function pairPrimary(model: DeviceModel, nodeId: string): string | null {
  for (const [a, b] of model.channelPairs) if (a === nodeId || b === nodeId) return a;
  return null;
}

/** True when `id` belongs to a STEREO-linked MONO IN pair currently in BAL mode.
 *  Such a pair acts as one stereo channel, so its mixer parameters mirror across
 *  both channels; PAN mode instead keeps the two channels independent. */
export function isBalLinkedPair(model: DeviceModel, plan: Plan, id: string): boolean {
  const primary = pairPrimary(model, id);
  if (!primary) return false;
  const np = plan.nodeParams[primary];
  return np?.stereoLink === true && (np.panBal ?? PAN_BAL_PAN) === PAN_BAL_BAL;
}

/** Mirror `id`'s mixer state onto its linked partner when the pair is in BAL mode,
 *  so an edit to either channel moves both. Copies the node params (except the
 *  pair-level Signal Type / PAN-BAL fields, which live on the primary alone) and
 *  each send's full mix params — level / PRE-POST / ON and the pan, which in BAL
 *  mode is the pair's one shared balance, so both channels read the same value.
 *  Returns false — a no-op — unless the pair is STEREO-linked in BAL mode. */
export function mirrorBalPair(model: DeviceModel, plan: Plan, id: string): boolean {
  if (!isBalLinkedPair(model, plan, id)) return false;
  const partner = partnerChannel(model, id);
  if (!partner) return false;
  // Replace the partner's node params with the source's, but keep the partner's
  // own pair-level fields (only the primary carries stereoLink / panBal). The copy
  // is deep: a shallow spread would alias the nested groups (gate / comp / eqBands
  // / ssmcs / osc / eqOneKnob) between the two channels, so an in-place edit to one
  // would bleed into the other — and the alias would outlive the link, since it
  // persists until a replace-style edit or a JSON round-trip breaks it.
  const src = plan.nodeParams[id] ?? {};
  const { stereoLink, panBal } = plan.nodeParams[partner] ?? {};
  plan.nodeParams[partner] = { ...structuredClone(src), stereoLink, panBal };
  // Copy each send's mix params (level / PRE-POST / ON / pan) to the partner's send
  // into the same destination — the BAL pan is shared across the pair. ConnParams
  // are flat scalars, so the spread is a full copy here.
  for (const c of plan.connections) {
    if (c.kind !== "send" || c.from !== ref(id, "out")) continue;
    const pc = plan.connections.find((p) => p.kind === "send" && p.from === ref(partner, "out") && p.to === c.to);
    if (!pc) continue;
    pc.params = { ...pc.params, ...c.params };
  }
  return true;
}

/** Whether a node reads as inactive (silenced) and should be dimmed alike in both
 *  views: a muted node (CH_ON / a bus / FX / MONITOR master ON — all on `params.on`),
 *  a bypassed ducker (`duckerOn`) or the oscillator when not generating (`osc.on`).
 *  Each off-state lives on a different param, so each kind needs its own check. */
export function isNodeInactive(plan: Plan, node: { id: string; kind: NodeKind }): boolean {
  const np = plan.nodeParams?.[node.id];
  if (node.kind === "ducker") return np?.duckerOn !== true;
  if (node.id === "bus.osc") return np?.osc?.on !== true;
  return np?.on === false;
}

/** Input-port refs that the given output port may currently connect to. */
export function legalTargets(model: DeviceModel, plan: Plan, from: string): Set<string> {
  const targets = new Set<string>();
  for (const rule of model.rules) {
    if (rule.from !== from) continue;
    if (canConnect(model, plan, from, rule.to).ok) targets.add(rule.to);
  }
  return targets;
}

/** Output-port refs that may currently connect into the given input port. */
export function legalSources(model: DeviceModel, plan: Plan, to: string): Set<string> {
  const sources = new Set<string>();
  for (const rule of model.rules) {
    if (rule.to !== to) continue;
    if (canConnect(model, plan, rule.from, to).ok) sources.add(rule.from);
  }
  return sources;
}

/** Input-port refs the given output has a routing rule to, occupied ones
 *  included. A superset of legalTargets: it ignores the current plan, so a
 *  single-input target that is already full still appears. Used to show where a
 *  port *could* route even when the destination is taken. */
export function possibleTargets(model: DeviceModel, from: string): Set<string> {
  const targets = new Set<string>();
  for (const rule of model.rules) if (rule.from === from) targets.add(rule.to);
  return targets;
}

/** Output-port refs that have a routing rule into the given input, occupied ones
 *  included. The input-side counterpart of possibleTargets. */
export function possibleSources(model: DeviceModel, to: string): Set<string> {
  const sources = new Set<string>();
  for (const rule of model.rules) if (rule.to === to) sources.add(rule.from);
  return sources;
}

/** Node ids in the upstream signal closure feeding `nodeId` (inclusive): every
 *  node that reaches it by walking connections backwards. `live` filters which
 *  connections to follow — pass a predicate that rejects silent (off / -∞) sends,
 *  otherwise the always-wired send mesh traces every node back to all inputs and
 *  the closure becomes the whole board. Cycle-safe via the visited closure. */
export function upstreamNodes(plan: Plan, nodeId: string, live: (conn: PlanConnection) => boolean): Set<string> {
  const closure = new Set<string>([nodeId]);
  const stack = [nodeId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const conn of plan.connections) {
      if (parseRef(conn.to).nodeId !== cur || !live(conn)) continue;
      const src = parseRef(conn.from).nodeId;
      if (!closure.has(src)) {
        closure.add(src);
        stack.push(src);
      }
    }
  }
  return closure;
}
