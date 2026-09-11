// Connection constraint engine. A wire is legal only when the DeviceModel
// declares a matching rule, and single-input receivers (selectors / patches)
// reject a second wire.

import { isSingleInput, parseRef, ref } from "../models/types";
import type { DeviceModel, NodeKind, RoutingRule } from "../models/types";
import type { NodeParams, Plan, PlanConnection } from "./plan";
import { hasConnection } from "./plan";
import { connParamContestKey, nodeParamContestKey } from "./plan-history";
import { BUS_TYPE_FIXED, BUS_TYPE_VARI, PAN_BAL_BAL, PAN_BAL_PAN, STEREO_PAN_DEFAULT } from "./control/params";

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

/** True when `id` belongs to a MONO IN pair whose Signal Type is STEREO, whatever its
 *  PAN/BAL mode (the flag lives on the primary, so it is read there). This is the gate for
 *  everything the pair holds in common — its tuning, its mixer state and the one insert
 *  effect its two members point at — and only a Signal Type transition clears it. The
 *  PAN/BAL mode decides one thing on top of it, the pan: see isBalLinkedPair. */
export function isStereoLinkedPair(model: DeviceModel, plan: Plan, id: string): boolean {
  const primary = pairPrimary(model, id);
  return primary !== null && plan.nodeParams[primary]?.stereoLink === true;
}

/** True when `id` belongs to a STEREO-linked MONO IN pair currently in BAL mode.
 *  A linked pair mirrors its mixer parameters in either mode; what BAL decides is the
 *  PAN — one shared balance for the pair, where PAN mode leaves each channel its own. */
export function isBalLinkedPair(model: DeviceModel, plan: Plan, id: string): boolean {
  const primary = pairPrimary(model, id);
  if (!primary || !isStereoLinkedPair(model, plan, id)) return false;
  return (plan.nodeParams[primary]?.panBal ?? PAN_BAL_PAN) === PAN_BAL_BAL;
}

/** Apply what the unit does to a MONO IN pair's pan positions and insert FX when its
 *  Signal Type or PAN/BAL changes (`primary` names the pair; `patch` is the edit that landed).
 *  Measured on the unit: linking leaves the pair in BAL and an unlinked pair reads
 *  PAN, and each of the three transitions slams CH_PAN and every bus send's pan
 *  together — PAN hard-pans the odd channel left and the even one right, BAL and
 *  unlinking centre both. A channel's CH_PAN is the pan of its fixed send into
 *  STEREO, so the send loop covers it; the SD Rec assign is a `sendSwitch` and has
 *  no pan. Call it before `mirrorLinkedPair` so the mirror copies settled values.
 *
 *  Returns the contest keys it wrote, for the caller's write witness. Every one of them
 *  can be written without MOVING — unlinking a BAL pair centres pans that are already
 *  centred, and clears an insert FX on a member that never had one — so the plan's own
 *  diff cannot tell them from a key nobody touched, and a device read in flight takes
 *  them all back. What the gesture asserts is the settled state, not the delta. */
export function applyPairTransition(model: DeviceModel, plan: Plan, primary: string, patch: NodeParams): string[] {
  const written: string[] = [];
  const pair = model.channelPairs.find(([a]) => a === primary);
  if (!pair) return written;
  if (patch.stereoLink !== undefined) {
    const np = plan.nodeParams[primary];
    plan.nodeParams[primary] = { ...np, panBal: patch.stereoLink ? PAN_BAL_BAL : PAN_BAL_PAN };
    written.push(nodeParamContestKey(primary, "panBal"));
    // Measured: a Signal Type transition clears the insert-FX selector and its ON on BOTH
    // members, in either direction and whichever member was holding the effect. Follow it —
    // a selection left in the plan would make the next live converge re-select an effect the
    // unit has just dropped. The stored engine values go with it: they are read through the
    // selected family, so a cleared selector leaves them nothing to bind to.
    for (const ch of pair) {
      // Named whether or not there was anything to delete: the assertion is that this
      // member carries no insert FX afterwards, which is as true of one that had none.
      for (const key of INSERT_FX_PAIR_KEYS) written.push(nodeParamContestKey(ch, key));
      const cp = plan.nodeParams[ch];
      if (!cp) continue;
      for (const key of INSERT_FX_PAIR_KEYS) delete cp[key];
    }
  }
  const centre = plan.nodeParams[primary]?.stereoLink !== true || isBalLinkedPair(model, plan, primary);
  pair.forEach((ch, idx) => {
    const pan = centre ? 0 : idx === 0 ? -STEREO_PAN_DEFAULT : STEREO_PAN_DEFAULT;
    for (const c of plan.connections)
      if (c.from === ref(ch, "out") && c.kind === "send") {
        c.params = { ...c.params, pan };
        written.push(connParamContestKey(c.from, c.to, "pan"));
      }
  });
  return written;
}

/** The node params a linked pair does NOT share: the pair-level flags, which live on the
 *  primary alone, and the head amp, which each member keeps its own of — the pair shares its
 *  processing and its mixer state, and not its input stage. */
const PAIR_OWN_NODE_KEYS = ["stereoLink", "panBal", "gain", "clipSafe", "phase"] as const;

/** Mirror `id`'s mixer state onto its linked partner, so an edit to either channel moves
 *  both. Copies the node params except `PAIR_OWN_NODE_KEYS`, and each send's mix params —
 *  level / PRE-POST / ON always, and the pan in BAL only.
 *
 *  **The gate is Signal Type, not PAN/BAL**: a linked pair holds one set of values in either
 *  mode. What the mode decides is the pan, each member's own outside BAL — which is why the
 *  send copy drops that one key there.
 *
 *  Returns false — a no-op — unless the pair is STEREO-linked. */
export function mirrorLinkedPair(model: DeviceModel, plan: Plan, id: string): boolean {
  if (!isStereoLinkedPair(model, plan, id)) return false;
  const partner = partnerChannel(model, id);
  if (!partner) return false;
  const sharedPan = isBalLinkedPair(model, plan, id);
  // Replace the partner's node params with the source's, but keep the keys the pair does not
  // share: the pair-level fields (only the primary carries stereoLink / panBal) and the head
  // amp (each member has its own input). The copy is deep: a shallow spread would alias the
  // nested groups (gate / comp / eqBands / ssmcs / osc / eqOneKnob) between the two channels,
  // so an in-place edit to one would bleed into the other — and the alias would outlive the
  // link, since it persists until a replace-style edit or a JSON round-trip breaks it.
  // The insert FX travels with them, as it does on the unit: while the pair is linked a
  // selector write from either member mirrors to the other and both point at one engine
  // instance, so a linked pair holds one insert effect between them. mirrorLinkedInsertFx
  // carries the same three keys from the transition seat, and the two agree.
  const src = structuredClone(plan.nodeParams[id] ?? {});
  const own = plan.nodeParams[partner] ?? {};
  // An absent key stays absent on the partner: one held as undefined would outlive the copy
  // through the history differ and the JSON round-trip.
  const kept = Object.fromEntries(
    PAIR_OWN_NODE_KEYS.filter((k) => own[k] !== undefined).map((k) => [k, own[k]]),
  ) as Partial<NodeParams>;
  for (const key of PAIR_OWN_NODE_KEYS) delete src[key];
  plan.nodeParams[partner] = { ...src, ...kept };
  // Copy each send's mix params to the partner's send into the same destination. ConnParams
  // are flat scalars, so the spread is a full copy. The PAN is dropped outside BAL: there it
  // is the pair's one shared balance and belongs to both, while in PAN mode each member
  // holds its own and the partner keeps what it has.
  for (const c of plan.connections) {
    if (c.kind !== "send" || c.from !== ref(id, "out")) continue;
    const pc = plan.connections.find((p) => p.kind === "send" && p.from === ref(partner, "out") && p.to === c.to);
    if (!pc) continue;
    const from = c.params ?? {};
    if (sharedPan) {
      pc.params = { ...pc.params, ...from };
    } else {
      const { pan: _pan, ...rest } = from;
      pc.params = { ...pc.params, ...rest };
    }
  }
  return true;
}

/** Mirror `id`'s insert FX onto its linked partner, so the pair's one effect reads the
 *  same on both members. Called beside mirrorLinkedPair from every edit funnel: the two
 *  share a gate and write the same values, and this pass is what names the pair's three
 *  insert-FX keys as the edit's own writes whatever the edit was — without it a device
 *  read in flight takes back an effect the plan holds on both members, and the next flush
 *  writes NONE over what the unit holds on the other one. The engine values are
 *  deep-copied for the aliasing reason mirrorLinkedPair documents.
 *  Returns false — a no-op — unless the pair is STEREO-linked. */
/** The pair state this mirror carries, and the whole of it — the caller that has to name
 *  what the mirror asserted reads the same list rather than keeping a second copy. */
export const INSERT_FX_PAIR_KEYS = ["insertFx", "insertFxOn", "insertFxParams"] as const;

export function mirrorLinkedInsertFx(model: DeviceModel, plan: Plan, id: string): boolean {
  if (!isStereoLinkedPair(model, plan, id)) return false;
  const partner = partnerChannel(model, id);
  if (!partner) return false;
  const { insertFx, insertFxOn, insertFxParams } = plan.nodeParams[id] ?? {};
  const dst = (plan.nodeParams[partner] ??= {});
  // An absent key stays absent on the partner: a key held as undefined would outlive
  // the copy through the history differ and the JSON round-trip.
  for (const key of INSERT_FX_PAIR_KEYS) delete dst[key];
  if (insertFx !== undefined) dst.insertFx = insertFx;
  if (insertFxOn !== undefined) dst.insertFxOn = insertFxOn;
  if (insertFxParams !== undefined) dst.insertFxParams = structuredClone(insertFxParams);
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
