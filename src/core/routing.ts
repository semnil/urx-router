// Connection constraint engine. A wire is legal only when the DeviceModel
// declares a matching rule, and single-input receivers (selectors / patches)
// reject a second wire.

import { isSingleInput, parseRef, ref } from "../models/types";
import type { DeviceModel, RoutingRule } from "../models/types";
import type { Plan, PlanConnection } from "./plan";
import { hasConnection } from "./plan";
import { PAN_BAL_BAL, PAN_BAL_PAN } from "./control/params";

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
// send, or the MIX -> STEREO "TO ST"). Every tapped send has one; so does the fixed
// MIX -> STEREO sendSwitch. The fixed CH/FX -> STEREO main-fader paths do not (they
// are the channel/return fader itself). Lets the UI ask the topology rather than
// re-deriving it from tap + kind proxies.
export function sendHasOn(model: DeviceModel, from: string, to: string): boolean {
  if (sendHasTap(model, from, to)) return true;
  return isFixedConnection(model, from, to) && ruleKind(model, from, to) === "sendSwitch";
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
  // own pair-level fields (only the primary carries stereoLink / panBal).
  const src = plan.nodeParams[id] ?? {};
  const { stereoLink, panBal } = plan.nodeParams[partner] ?? {};
  plan.nodeParams[partner] = { ...src, stereoLink, panBal };
  // Copy each send's mix params (level / PRE-POST / ON / pan) to the partner's send
  // into the same destination — the BAL pan is shared across the pair.
  for (const c of plan.connections) {
    if (c.kind !== "send" || c.from !== ref(id, "out")) continue;
    const pc = plan.connections.find(
      (p) => p.kind === "send" && p.from === ref(partner, "out") && p.to === c.to,
    );
    if (!pc) continue;
    pc.params = { ...pc.params, ...c.params };
  }
  return true;
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
export function upstreamNodes(
  plan: Plan,
  nodeId: string,
  live: (conn: PlanConnection) => boolean,
): Set<string> {
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
